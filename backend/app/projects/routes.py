# projects/routes.py
# This file defines API routes related to projects and assignments, including listing projects, managing project assignments, uploading files, and fetching project events. It uses FastAPI for routing and SQLAlchemy for database interactions.
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from pydantic import BaseModel
from typing import Optional, List
from sqlalchemy import text
from app.db import engine
from datetime import date, datetime, timedelta

import json

from app.auth import get_current_user, require_admin
from app.permissions import filter_visible, can_edit_assignment, visible_project_qbo_ids
from .service import (
    list_assignable_projects,
    get_assignment_bundle,
    save_schedule_item,
    list_project_events,
    ensure_project_row_for_qbo_customer,
    provision_master_rows_for_all_projects,
    refresh_project_financial_summary,
    reset_untouched_master_statuses,
    consolidate_orphaned_master_rows,
)
from app.s3 import s3_client, AWS_BUCKET, build_project_file_key, signed_file_url

router = APIRouter(prefix="/api", tags=["projects"])

class CrewAssignmentEntry(BaseModel):
    """Crew Model v2 (CR3) assignment entry: COMPANY is required, the lead is
    optional ('lead TBD' until the boss/PM names one), slot_code is the
    per-project slot (JR1…) — auto-suggested server-side when blank."""
    company_id: int
    lead_crew_id: Optional[int] = None
    slot_code: Optional[str] = None
    is_primary: bool = False


class ScheduleItemSaveRequest(BaseModel):
    schedule_item_id: Optional[int] = None
    qbo_customer_id: int
    status: str
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    wire_guidance: int = 0
    travel_days: int = 0
    overage_days: int = 0
    equipment_type: Optional[str] = None
    project_manager_ids: List[int] = []
    primary_project_manager_id: Optional[int] = None
    work_crew_ids: List[int] = []
    primary_work_crew_id: Optional[int] = None
    # CR3: explicit company/lead/slot entries. When present (not None) they are
    # the source of truth and the legacy work_crew_ids fields are ignored;
    # legacy payloads (crew_assignments omitted) keep working unchanged.
    crew_assignments: Optional[List[CrewAssignmentEntry]] = None
    notes: Optional[str] = None
    # 0062 PROJECT NON-WORKING DAYS: {"weekends_off": bool,
    # "dates": ["YYYY-MM-DD", ...]} or None (= no non-working days).
    # Validated/normalized in save_schedule_item (ISO dates, cap 120;
    # dates outside the window are allowed — harmless).
    non_working: Optional[dict] = None

@router.get("/assignment/projects")
def assignment_projects(user=Depends(get_current_user)):
    # List QBO projects for the dropdown/search
    return list_assignable_projects()

@router.get("/assignment/bundle")
def assignment_bundle(qbo_customer_id: int, user=Depends(get_current_user)):
    return get_assignment_bundle(qbo_customer_id=qbo_customer_id)

@router.post("/assignment/save")
def assignment_save(req: ScheduleItemSaveRequest, user=Depends(get_current_user)):
    # Permission: edit_any, or edit_own when the project is in the user's scope.
    if not can_edit_assignment(user, req.qbo_customer_id):
        raise HTTPException(status_code=403, detail="You can't edit this project's schedule")
    try:
        return save_schedule_item(req=req, actor_user_id=int(user["id"]))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.delete("/assignment/schedule-item/{schedule_item_id}")
def delete_schedule_item(schedule_item_id: int, user=Depends(get_current_user)):
    from .service import delete_schedule_item as delete_schedule_item_service
    # Resolve the owning project so we can apply the same edit permission check.
    with engine.connect() as conn:
        owner = conn.execute(text("""
            SELECT p.qbo_customer_id
            FROM myapp.project_schedule_items psi
            JOIN myapp.projects p ON p.id = psi.project_id
            WHERE psi.id = :id
            LIMIT 1
        """), {"id": schedule_item_id}).mappings().first()
    if not owner:
        raise HTTPException(status_code=404, detail="Schedule item not found")
    if not can_edit_assignment(user, owner["qbo_customer_id"]):
        raise HTTPException(status_code=403, detail="You can't edit this project's schedule")
    try:
        return delete_schedule_item_service(schedule_item_id, int(user["id"]))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/projects/schedule-items/{schedule_item_id}/history")
def schedule_item_history(schedule_item_id: int, user=Depends(get_current_user)):
    """Assignment-line history (Crew Model v2 CR4). Rows newest-first:
    {action, changed_by (display name/email, NULL = before tracking),
    changed_at, changes {field: [old, new]}} — captured by CR1's
    record_item_history on every create/update/delete. Auth matches the
    other assignment reads (/assignment/bundle, /assignment/table): any
    authenticated user token, which includes page.pm_portal users."""
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT
              h.id, h.schedule_item_id, h.action, h.changed_by_user_id,
              h.changed_at, h.changes,
              TRIM(CONCAT(COALESCE(u.first_name,''), ' ', COALESCE(u.last_name,''))) AS changed_by_name,
              u.email AS changed_by_email
            FROM myapp.project_schedule_item_history h
            LEFT JOIN myapp.users u ON u.id = h.changed_by_user_id
            WHERE h.schedule_item_id = :sid
            ORDER BY h.changed_at DESC, h.id DESC
        """), {"sid": int(schedule_item_id)}).mappings().all()

    items = []
    for r in rows:
        changes = r["changes"]
        if isinstance(changes, (bytes, bytearray)):
            try:
                changes = json.loads(changes.decode("utf-8"))
            except Exception:
                changes = None
        elif isinstance(changes, str):
            try:
                changes = json.loads(changes)
            except Exception:
                changes = None
        changed_by = None
        if r["changed_by_user_id"] is not None:
            changed_by = (r["changed_by_name"] or "").strip() or r["changed_by_email"] or f"user #{r['changed_by_user_id']}"
        items.append({
            "id": int(r["id"]),
            "schedule_item_id": int(r["schedule_item_id"]),
            "action": r["action"],
            "changed_by": changed_by,           # None -> "(before tracking)" in the UI
            "changed_at": r["changed_at"].isoformat() if r["changed_at"] else None,
            "changes": changes or {},
        })
    return {"schedule_item_id": int(schedule_item_id), "history": items}

# Project status = the LATEST assignment row's status (owner decision): a project
# with several assignment rows inherits the final row's status (e.g. 3 completed +
# a final 'pending' row → the project is 'pending'). This is the single status
# shown on the Projects hub and the Billing tab — no separate derived status.
_STATUS_ORDER = ["needs_attention", "pending", "not_started", "in_progress", "completed", "canceled"]


def _latest_status(conn, qbo_id):
    """The status of the project's final assignment row (latest by date, then
    sort order). Falls back to 'needs_attention' when there are no rows."""
    r = conn.execute(text("""
        SELECT psi.status
        FROM myapp.project_schedule_items psi
        JOIN myapp.projects p ON p.id = psi.project_id
        JOIN myapp.qbo_customers qc ON qc.id = p.qbo_customer_id
        WHERE qc.qbo_id = :q
        ORDER BY psi.start_date IS NULL, psi.start_date DESC, psi.sort_order DESC, psi.id DESC
        LIMIT 1
    """), {"q": qbo_id}).scalar()
    return r or "needs_attention"


def _operational_status(p):
    """DEPRECATED for display — kept for any legacy callers. The hub + billing now
    use _latest_status (the final assignment row's status)."""
    if p.get("needs_assignment"):
        return "needs_assignment"
    statuses = {s.strip() for s in (p.get("all_statuses") or "").split(",") if s.strip()}
    if "in_progress" in statuses:
        return "in_progress"
    # Office explicitly marked it pending (attention given, but crew/dates still
    # unknown) — surfaces above the auto-derived assigned/needs_assignment states.
    if "pending" in statuses:
        return "pending"
    active = statuses - {"canceled"}
    if active and active <= {"completed"}:
        return "complete"
    if statuses and statuses <= {"canceled"}:
        return "canceled"
    if p.get("start_date"):
        return "scheduled"
    # No dates yet: "assigned" only if a PM or crew is on it; otherwise it still
    # needs attention.
    if str(p.get("primary_project_manager") or "").strip() or str(p.get("primary_work_crew") or "").strip():
        return "assigned"
    return "needs_assignment"


@router.get("/assignment/table")
def assignment_table(user=Depends(get_current_user)):
    provision_master_rows_for_all_projects()
    sql = text("""
    SELECT
      psi.id AS schedule_item_id,
      qc.id AS qbo_customer_id,
      qc.display_name AS project_name,
      DATE(qc.meta_create_time) AS project_create_date,

      psi.status AS project_status,
      psi.start_date AS start_date,
      psi.end_date AS end_date,
      psi.wire_guidance AS wire_guidance,
      psi.travel_days AS travel_days,
      psi.overage_days AS overage_days,
      psi.equipment_type AS equipment_type,
      psi.notes AS notes,
      psi.non_working AS non_working,
      psi.is_extra_row AS is_extra_row,

      -- CR4: history badge count on the Assignment page. CR5 A3: the single
      -- backfilled "(before tracking)" created row doesn't count as a change.
      (SELECT COUNT(*) FROM myapp.project_schedule_item_history h
        WHERE h.schedule_item_id = psi.id
          AND NOT (h.action = 'created' AND h.changed_by_user_id IS NULL)) AS history_count,

      pm.primary_pm_name AS primary_project_manager,
      wc.primary_crew_name AS primary_work_crew,

      COALESCE(pm.all_pm_names, '') AS all_project_managers,
      COALESCE(wc.all_crew_names, '') AS all_work_crews

    FROM myapp.qbo_customers qc

    LEFT JOIN myapp.projects p
      ON p.qbo_customer_id = qc.id

    LEFT JOIN myapp.project_schedule_items psi
      ON psi.project_id = p.id

    LEFT JOIN (
      SELECT
        spm.schedule_item_id,
        MAX(
          CASE
            WHEN spm.is_primary = 1
            THEN TRIM(CONCAT(COALESCE(pm.first_name,''), ' ', COALESCE(pm.last_name,'')))
            ELSE NULL
          END
        ) AS primary_pm_name,
        GROUP_CONCAT(
          DISTINCT TRIM(CONCAT(COALESCE(pm.first_name,''), ' ', COALESCE(pm.last_name,'')))
          ORDER BY spm.is_primary DESC, pm.last_name, pm.first_name, pm.id
          SEPARATOR ', '
        ) AS all_pm_names
      FROM myapp.project_schedule_item_project_managers spm
      JOIN myapp.project_managers pm
        ON pm.id = spm.project_manager_id
      WHERE spm.unassigned_at IS NULL
        AND pm.is_active = 1
      GROUP BY spm.schedule_item_id
    ) pm
      ON pm.schedule_item_id = psi.id

    LEFT JOIN (
      -- Crew Model v2 (CR3): label = "Company · Lead" ("… · lead TBD" when the
      -- assignment has no lead yet). company/lead come from the v2 columns,
      -- falling back to the legacy work_crew_id derivation for old rows.
      SELECT
        swc.schedule_item_id,
        MAX(
          CASE
            WHEN swc.is_primary = 1
            THEN CONCAT(COALESCE(co.name, pc.name, wc.name), ' · ',
                        COALESCE(ld.name,
                                 CASE WHEN wc.parent_id IS NOT NULL THEN wc.name END,
                                 'lead TBD'))
            ELSE NULL
          END
        ) AS primary_crew_name,
        GROUP_CONCAT(
          DISTINCT CONCAT(COALESCE(co.name, pc.name, wc.name), ' · ',
                          COALESCE(ld.name,
                                   CASE WHEN wc.parent_id IS NOT NULL THEN wc.name END,
                                   'lead TBD'))
          ORDER BY swc.is_primary DESC, wc.sort_order, wc.id
          SEPARATOR ', '
        ) AS all_crew_names
      FROM myapp.project_schedule_item_work_crews swc
      JOIN myapp.work_crews wc
        ON wc.id = swc.work_crew_id
      LEFT JOIN myapp.work_crews co ON co.id = swc.company_id
      LEFT JOIN myapp.work_crews ld ON ld.id = swc.lead_crew_id
      LEFT JOIN myapp.work_crews pc ON pc.id = wc.parent_id
      WHERE swc.unassigned_at IS NULL
      GROUP BY swc.schedule_item_id
    ) wc
      ON wc.schedule_item_id = psi.id

    WHERE qc.is_project = 1
    ORDER BY qc.display_name, psi.start_date, psi.id
    """)

    with engine.connect() as conn:
        rows = conn.execute(sql).mappings().all()

    from .service import _parse_non_working
    out = []
    for r in rows:
        d = dict(r)
        # 0062: JSON string -> dict (or None) for the Days-off cell
        d["non_working"] = _parse_non_working(d.get("non_working"))
        out.append(d)
    projects = filter_visible(out, user, key="qbo_customer_id")
    return {"projects": projects}


@router.get("/projects/schedule-list")
def projects_schedule_list(user=Depends(get_current_user)):
    """
    Read-only: one row per schedule item across every project, with
    project-level file_count appended. Mirrors /assignment/table but
    without the provisioning side effect (doesn't create master rows).
    Used by the Projects page table.
    """
    sql = text("""
    SELECT
      psi.id                                    AS schedule_item_id,
      qc.id                                     AS qbo_customer_id,
      qc.display_name                           AS project_name,

      psi.status                                AS project_status,
      psi.start_date                            AS start_date,
      psi.end_date                              AS end_date,
      psi.wire_guidance                         AS wire_guidance,
      psi.travel_days                           AS travel_days,
      psi.overage_days                          AS overage_days,
      psi.equipment_type                        AS equipment_type,
      psi.notes                                 AS notes,

      pm.primary_pm_name                        AS primary_project_manager,
      wc.primary_crew_name                      AS primary_work_crew,

      COALESCE(pm.all_pm_names,  '')            AS all_project_managers,
      COALESCE(wc.all_crew_names, '')           AS all_work_crews,

      COALESCE(pf.file_count, 0)                AS file_count

    FROM myapp.qbo_customers qc
    LEFT JOIN myapp.projects p
      ON p.qbo_customer_id = qc.id
    LEFT JOIN myapp.project_schedule_items psi
      ON psi.project_id = p.id

    LEFT JOIN (
      SELECT
        spm.schedule_item_id,
        MAX(CASE WHEN spm.is_primary = 1
                 THEN TRIM(CONCAT(COALESCE(pm.first_name,''), ' ', COALESCE(pm.last_name,'')))
                 ELSE NULL
            END) AS primary_pm_name,
        GROUP_CONCAT(
          DISTINCT TRIM(CONCAT(COALESCE(pm.first_name,''), ' ', COALESCE(pm.last_name,'')))
          ORDER BY spm.is_primary DESC, pm.last_name, pm.first_name, pm.id
          SEPARATOR ', '
        ) AS all_pm_names
      FROM myapp.project_schedule_item_project_managers spm
      JOIN myapp.project_managers pm ON pm.id = spm.project_manager_id
      WHERE spm.unassigned_at IS NULL AND pm.is_active = 1
      GROUP BY spm.schedule_item_id
    ) pm ON pm.schedule_item_id = psi.id

    LEFT JOIN (
      -- Crew Model v2 (CR3): "Company · Lead" labels ("… · lead TBD" lead-less)
      SELECT
        swc.schedule_item_id,
        MAX(CASE WHEN swc.is_primary = 1
                 THEN CONCAT(COALESCE(co.name, pc.name, wc.name), ' · ',
                             COALESCE(ld.name,
                                      CASE WHEN wc.parent_id IS NOT NULL THEN wc.name END,
                                      'lead TBD'))
                 ELSE NULL END) AS primary_crew_name,
        GROUP_CONCAT(
          DISTINCT CONCAT(COALESCE(co.name, pc.name, wc.name), ' · ',
                          COALESCE(ld.name,
                                   CASE WHEN wc.parent_id IS NOT NULL THEN wc.name END,
                                   'lead TBD'))
          ORDER BY swc.is_primary DESC, wc.sort_order, wc.id
          SEPARATOR ', '
        ) AS all_crew_names
      FROM myapp.project_schedule_item_work_crews swc
      JOIN myapp.work_crews wc ON wc.id = swc.work_crew_id
      LEFT JOIN myapp.work_crews co ON co.id = swc.company_id
      LEFT JOIN myapp.work_crews ld ON ld.id = swc.lead_crew_id
      LEFT JOIN myapp.work_crews pc ON pc.id = wc.parent_id
      WHERE swc.unassigned_at IS NULL
      GROUP BY swc.schedule_item_id
    ) wc ON wc.schedule_item_id = psi.id

    LEFT JOIN (
      SELECT qbo_customer_id, COUNT(*) AS file_count
      FROM myapp.project_files
      GROUP BY qbo_customer_id
    ) pf ON pf.qbo_customer_id = qc.id

    WHERE qc.is_project = 1
    ORDER BY qc.display_name, psi.start_date, psi.id
    """)

    with engine.connect() as conn:
        rows = conn.execute(sql).mappings().all()

    visible = filter_visible([dict(r) for r in rows], user, key="qbo_customer_id")
    return {"rows": visible}


@router.get("/projects/{qbo_customer_id}/events")
def project_events(qbo_customer_id: int, user=Depends(get_current_user)):
    return list_project_events(qbo_customer_id=qbo_customer_id)

@router.get("/projects")
def projects(user=Depends(get_current_user)):
    """
    Returns one row per project with:
      - Assignment info: all statuses, PMs, crews, start/end dates (concatenated across schedule items)
      - QBO financial aggregates from the dual sales/expense line query:
          estimate_cost_amt  : sum of qbo_sales_transaction_lines.cost_amount  (Estimate lines)
          estimate_line_amt  : sum of qbo_sales_transaction_lines.amount       (Estimate lines)
          invoice_line_amt   : sum of qbo_sales_transaction_lines.amount       (Invoice lines)
          expense_line_amt   : sum of qbo_transaction_lines.amount             (expense txn lines)
      - Derived metrics: balance, actual profit, actual profit %, projected profit, projected profit %
    """

    sql = text("""
    WITH

    -- ----------------------------------------------------------------
    -- Dedup sales transactions: scoped to project customers only, then
    -- per (customer, entity_type, doc_number) keeps only the newest row
    -- (highest auto-increment id = most recently synced version).
    -- Voided transactions (total_amt = 0) are excluded.
    -- Rows with no doc_number are treated as unique (no dedup).
    -- ----------------------------------------------------------------
    latest_sales_txns AS (
      SELECT *
      FROM (
        SELECT qt.*,
               ROW_NUMBER() OVER (
                 PARTITION BY qt.customer_qbo_id, qt.entity_type,
                              COALESCE(qt.doc_number, CONCAT('__nodoc__', qt.qbo_id))
                 ORDER BY qt.id DESC
               ) AS _rn
        FROM myapp.qbo_transactions qt
        INNER JOIN myapp.qbo_customers qc_proj
          ON qc_proj.qbo_id = qt.customer_qbo_id
          AND qc_proj.is_project = 1
        WHERE qt.entity_type IN ('Invoice', 'Estimate', 'SalesReceipt', 'CreditMemo')
          AND (qt.total_amt IS NULL OR qt.total_amt > 0)
          -- Estimates: only count Accepted/Converted/Closed in financials.
          AND (
            qt.entity_type <> 'Estimate'
            OR JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted', 'Closed')
          )
      ) _ranked
      WHERE _rn = 1
    ),

    -- ----------------------------------------------------------------
    -- SIDE A: Sales lines (Estimates + Invoices + other revenue types)
    -- One row per child sales line, tagged by entity_type
    -- ----------------------------------------------------------------
    sales_lines AS (
      SELECT
        qc.qbo_id                      AS project_qbo_id,
        qt.entity_type,
        qstl.amount                    AS line_amount,
        qstl.cost_amount               AS line_cost_amount
      FROM myapp.qbo_customers qc
      INNER JOIN latest_sales_txns qt
        ON qt.customer_qbo_id = qc.qbo_id
      LEFT JOIN myapp.qbo_sales_transaction_lines qstl
        ON qstl.transaction_id = qt.id
        AND qstl.line_level = 'child'
      WHERE qc.is_project = 1
    ),

    -- ----------------------------------------------------------------
    -- SIDE B: Expense / cost lines (Bills, Checks, CC charges, etc.)
    -- VendorCredits and Purchases flagged Credit=true (Credit Card Credits,
    -- cash/check refunds) are included as negative amounts (they reduce costs).
    -- Joined to customer via line_customer_qbo_id
    -- ----------------------------------------------------------------
    expense_lines AS (
      SELECT
        qc.qbo_id                      AS project_qbo_id,
        CASE
          WHEN qt.entity_type = 'VendorCredit' THEN -qtl.amount
          WHEN qt.entity_type = 'Purchase'
               AND JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.Credit')) = 'true'
            THEN -qtl.amount
          ELSE qtl.amount
        END                            AS line_amount
      FROM myapp.qbo_customers qc
      INNER JOIN myapp.qbo_transaction_lines qtl
        ON qtl.line_customer_qbo_id = qc.qbo_id
      INNER JOIN myapp.qbo_transactions qt
        ON qt.id = qtl.transaction_id
        AND qt.entity_type IN ('Bill', 'Check', 'CreditCardCharge', 'Purchase', 'PurchaseOrder', 'VendorCredit')
      WHERE qc.is_project = 1
    ),
               
    -- ----------------------------------------------------------------
    -- AR lines: one row per Invoice transaction per project
    -- Uses latest_sales_txns so duplicate/voided invoices are excluded
    -- ----------------------------------------------------------------
    ar_lines AS (
      SELECT
        qc.qbo_id                AS project_qbo_id,
        qt.id                    AS transaction_id,
        qt.balance_amt
      FROM myapp.qbo_customers qc
      INNER JOIN latest_sales_txns qt
        ON qt.customer_qbo_id = qc.qbo_id
        AND qt.entity_type = 'Invoice'
      WHERE qc.is_project = 1
    ),

    -- ----------------------------------------------------------------
    -- Roll up sales lines per project
    -- ----------------------------------------------------------------
    sales_rollup AS (
      SELECT
        project_qbo_id,
        SUM(CASE WHEN entity_type = 'Estimate' THEN COALESCE(line_cost_amount, 0) ELSE 0 END) AS estimate_cost_amt,
        SUM(CASE WHEN entity_type = 'Estimate' THEN COALESCE(line_amount,      0) ELSE 0 END) AS estimate_line_amt,
        SUM(CASE WHEN entity_type = 'Invoice'  THEN COALESCE(line_amount,      0) ELSE 0 END) AS invoice_line_amt
      FROM sales_lines
      GROUP BY project_qbo_id
    ),

    -- ----------------------------------------------------------------
    -- Roll up expense lines per project
    -- ----------------------------------------------------------------
    expense_rollup AS (
      SELECT
        project_qbo_id,
        SUM(COALESCE(line_amount, 0)) AS expense_line_amt
      FROM expense_lines
      GROUP BY project_qbo_id
    ),
                  
    -- ----------------------------------------------------------------
    -- Roll up AR lines per project
    -- ----------------------------------------------------------------
    ar_rollup AS (
      SELECT
        project_qbo_id,
        SUM(COALESCE(balance_amt, 0))                              AS invoice_balance_amt,
        SUM(CASE WHEN balance_amt > 0 THEN 1 ELSE 0 END)          AS open_invoice_count
      FROM ar_lines
      GROUP BY project_qbo_id
    ),
               
    -- ----------------------------------------------------------------
    -- Assignment meta: concatenate all schedule items per project
    -- Mirrors the pattern used in /assignment/table
    -- ----------------------------------------------------------------
    assignment_meta AS (
      SELECT
        p.qbo_customer_id,

        -- All statuses (deduplicated, comma-separated)
        GROUP_CONCAT(
          DISTINCT psi.status
          ORDER BY psi.start_date, psi.id
          SEPARATOR ', '
        ) AS all_statuses,

        -- Primary status = status of earliest schedule item
        MIN(psi.status) AS primary_status,

        -- All start dates
        GROUP_CONCAT(
          DISTINCT DATE_FORMAT(psi.start_date, '%Y-%m-%d')
          ORDER BY psi.start_date, psi.id
          SEPARATOR ', '
        ) AS all_start_dates,

        MIN(psi.start_date) AS earliest_start_date,

        -- All end dates
        GROUP_CONCAT(
          DISTINCT DATE_FORMAT(psi.end_date, '%Y-%m-%d')
          ORDER BY psi.end_date, psi.id
          SEPARATOR ', '
        ) AS all_end_dates,

        MAX(psi.end_date) AS latest_end_date

      FROM myapp.projects p
      INNER JOIN myapp.project_schedule_items psi
        ON psi.project_id = p.id
      GROUP BY p.qbo_customer_id
    ),

    pm_meta AS (
      SELECT
        p.qbo_customer_id,
        GROUP_CONCAT(
          DISTINCT TRIM(CONCAT(COALESCE(pm.first_name,''), ' ', COALESCE(pm.last_name,'')))
          ORDER BY spm.is_primary DESC, pm.last_name, pm.first_name, pm.id
          SEPARATOR ', '
        ) AS all_pm_names,
        MAX(CASE WHEN spm.is_primary = 1
            THEN TRIM(CONCAT(COALESCE(pm.first_name,''), ' ', COALESCE(pm.last_name,'')))
            ELSE NULL END
        ) AS primary_pm_name
      FROM myapp.projects p
      INNER JOIN myapp.project_schedule_items psi ON psi.project_id = p.id
      INNER JOIN myapp.project_schedule_item_project_managers spm ON spm.schedule_item_id = psi.id
      INNER JOIN myapp.project_managers pm ON pm.id = spm.project_manager_id
      WHERE spm.unassigned_at IS NULL
        AND pm.is_active = 1
      GROUP BY p.qbo_customer_id
    ),

    crew_meta AS (
      -- Crew Model v2 (CR3): "Company · Lead" labels ("… · lead TBD" lead-less)
      SELECT
        p.qbo_customer_id,
        GROUP_CONCAT(
          DISTINCT CONCAT(COALESCE(co.name, pc.name, wc.name), ' · ',
                          COALESCE(ld.name,
                                   CASE WHEN wc.parent_id IS NOT NULL THEN wc.name END,
                                   'lead TBD'))
          ORDER BY swc.is_primary DESC, wc.sort_order, wc.id
          SEPARATOR ', '
        ) AS all_crew_names,
        MAX(CASE WHEN swc.is_primary = 1
                 THEN CONCAT(COALESCE(co.name, pc.name, wc.name), ' · ',
                             COALESCE(ld.name,
                                      CASE WHEN wc.parent_id IS NOT NULL THEN wc.name END,
                                      'lead TBD'))
                 ELSE NULL END) AS primary_crew_name
      FROM myapp.projects p
      INNER JOIN myapp.project_schedule_items psi ON psi.project_id = p.id
      INNER JOIN myapp.project_schedule_item_work_crews swc ON swc.schedule_item_id = psi.id
      INNER JOIN myapp.work_crews wc ON wc.id = swc.work_crew_id
      LEFT JOIN myapp.work_crews co ON co.id = swc.company_id
      LEFT JOIN myapp.work_crews ld ON ld.id = swc.lead_crew_id
      LEFT JOIN myapp.work_crews pc ON pc.id = wc.parent_id
      WHERE swc.unassigned_at IS NULL
      GROUP BY p.qbo_customer_id
    )

    -- ----------------------------------------------------------------
    -- Final SELECT: one row per QBO project customer
    -- ----------------------------------------------------------------
    SELECT
      qc.id                                          AS qbo_customer_id,
      qc.qbo_id                                      AS project_qbo_id,
      qc.display_name                                AS project_name,
      qc.meta_create_time                            AS project_create_dttm,
      qc.meta_last_updated_time                      AS project_lastupdate_dttm,

      -- Assignment fields (concatenated across all schedule items)
      COALESCE(am.all_statuses,   '')                AS all_statuses,
      COALESCE(am.primary_status, 'needs_attention') AS project_status,
      am.all_start_dates,
      am.earliest_start_date                         AS start_date,
      am.all_end_dates,
      am.latest_end_date                             AS end_date,

      -- PM (concatenated across all schedule items)
      COALESCE(pm.all_pm_names,   '')                AS all_project_managers,
      COALESCE(pm.primary_pm_name,'')                AS primary_project_manager,

      -- Work Crew (concatenated across all schedule items)
      COALESCE(cr.all_crew_names, '')                AS all_work_crews,
      COALESCE(cr.primary_crew_name, '')             AS primary_work_crew,

      -- Needs attention flag — set when no schedule items exist OR the project's
      -- primary status is the auto-provisioned 'needs_attention' (untouched master row).
      CASE
        WHEN am.qbo_customer_id IS NULL THEN 1
        WHEN am.primary_status = 'needs_attention' THEN 1
        ELSE 0
      END                                            AS needs_assignment,

      -- File count
      COALESCE(pf.file_count, 0)                     AS file_count,

      -- ---- QBO Financial fields ----
      COALESCE(sr.estimate_cost_amt, 0)              AS estimate_cost_amt,
      COALESCE(sr.estimate_line_amt, 0)              AS estimate_line_amt,
      COALESCE(sr.invoice_line_amt,  0)              AS invoice_line_amt,
      COALESCE(er.expense_line_amt,  0)              AS expense_line_amt,
      COALESCE(ar.invoice_balance_amt, 0)            AS invoice_balance_amt,
      COALESCE(ar.open_invoice_count, 0)             AS open_invoice_count,

      -- Balance: Invoice - Expense
      (COALESCE(sr.invoice_line_amt, 0) - COALESCE(er.expense_line_amt, 0))
                                                     AS balance_amt,

      -- Actual profit: Invoice - Expense
      (COALESCE(sr.invoice_line_amt, 0) - COALESCE(er.expense_line_amt, 0))
                                                     AS actual_profit,

      -- Actual profit %: actual_profit / invoice (NULL if no invoice)
      CASE
        WHEN COALESCE(sr.invoice_line_amt, 0) = 0 THEN NULL
        ELSE (COALESCE(sr.invoice_line_amt, 0) - COALESCE(er.expense_line_amt, 0))
             / COALESCE(sr.invoice_line_amt, 0)
      END                                            AS actual_profit_pct,

      -- Projected profit: Invoice - Estimate cost
      (COALESCE(sr.estimate_line_amt, 0) - COALESCE(sr.estimate_cost_amt, 0))
                                                     AS projected_profit,

      -- Projected profit %: projected_profit / invoice (NULL if no invoice)
      CASE
        WHEN COALESCE(sr.estimate_line_amt, 0) = 0 THEN NULL
        ELSE (COALESCE(sr.estimate_line_amt, 0) - COALESCE(sr.estimate_cost_amt, 0))
             / COALESCE(sr.estimate_line_amt, 0)
      END                                            AS projected_profit_pct

    FROM myapp.qbo_customers qc

    LEFT JOIN assignment_meta am
      ON am.qbo_customer_id = qc.id

    LEFT JOIN pm_meta pm
      ON pm.qbo_customer_id = qc.id

    LEFT JOIN crew_meta cr
      ON cr.qbo_customer_id = qc.id

    LEFT JOIN sales_rollup sr
      ON sr.project_qbo_id = qc.qbo_id

    LEFT JOIN expense_rollup er
      ON er.project_qbo_id = qc.qbo_id

    LEFT JOIN ar_rollup ar
      ON ar.project_qbo_id = qc.qbo_id

    LEFT JOIN (
      SELECT qbo_customer_id, COUNT(*) AS file_count
      FROM myapp.project_files
      GROUP BY qbo_customer_id
    ) pf
      ON pf.qbo_customer_id = qc.id

    WHERE qc.is_project = 1

    ORDER BY qc.display_name
    """)

    with engine.connect() as conn:
        rows = conn.execute(sql).mappings().all()

    projects = [dict(r) for r in rows]

    # Scope to visible projects before aggregating, so KPI cards reconcile.
    projects = filter_visible(projects, user, key="qbo_customer_id")

    # Compute header-level aggregates for the KPI cards
    total_estimate_cost  = sum(float(p.get("estimate_cost_amt") or 0) for p in projects)
    total_estimate_line  = sum(float(p.get("estimate_line_amt") or 0) for p in projects)
    total_invoice        = sum(float(p.get("invoice_line_amt")  or 0) for p in projects)
    total_expense        = sum(float(p.get("expense_line_amt")  or 0) for p in projects)
    total_invoice_bal    = sum(float(p.get("invoice_balance_amt")  or 0) for p in projects)
    total_open_invoices  = sum(int(p.get("open_invoice_count") or 0) for p in projects)
    total_actual_profit  = total_invoice - total_expense
    total_proj_profit    = total_estimate_line - total_estimate_cost

    return {
        "summary": {
            "total_projects":        len(projects),
            "total_estimate_cost":   total_estimate_cost,
            "total_estimate_line":   total_estimate_line,
            "total_invoice":         total_invoice,
            "total_invoice_bal":     total_invoice_bal,
            "total_expense":         total_expense,
            "total_open_invoices":   total_open_invoices,
            "total_actual_profit":   total_actual_profit,
            "actual_profit_pct":     (total_actual_profit / total_invoice) if total_invoice else None,
            "total_proj_profit":     total_proj_profit,
            "projected_profit_pct":  (total_proj_profit  / total_estimate_line) if total_estimate_line else None,
        },
        "projects": projects[:1000],
    }


@router.get("/projects/basic")
def projects_basic(user=Depends(get_current_user)):
    """
    Fast endpoint — returns one row per project with assignment-level data
    only (name, statuses, PMs, crews, dates, file count). No financial joins.
    Pair with /projects/financials for progressive loading on the frontend.
    """
    sql = text("""
    WITH

    assignment_meta AS (
      SELECT
        p.qbo_customer_id,
        GROUP_CONCAT(
          DISTINCT psi.status
          ORDER BY psi.start_date, psi.id
          SEPARATOR ', '
        ) AS all_statuses,
        MIN(psi.status) AS primary_status,
        GROUP_CONCAT(
          DISTINCT DATE_FORMAT(psi.start_date, '%Y-%m-%d')
          ORDER BY psi.start_date, psi.id
          SEPARATOR ', '
        ) AS all_start_dates,
        MIN(psi.start_date) AS earliest_start_date,
        GROUP_CONCAT(
          DISTINCT DATE_FORMAT(psi.end_date, '%Y-%m-%d')
          ORDER BY psi.end_date, psi.id
          SEPARATOR ', '
        ) AS all_end_dates,
        MAX(psi.end_date) AS latest_end_date,
        -- CR3 "true end": scheduled end pushed by that item's overage days.
        MAX(DATE_ADD(psi.end_date, INTERVAL COALESCE(psi.overage_days, 0) DAY))
          AS true_end_date
      FROM myapp.projects p
      INNER JOIN myapp.project_schedule_items psi
        ON psi.project_id = p.id
      GROUP BY p.qbo_customer_id
    ),

    pm_meta AS (
      SELECT
        p.qbo_customer_id,
        GROUP_CONCAT(
          DISTINCT TRIM(CONCAT(COALESCE(pm.first_name,''), ' ', COALESCE(pm.last_name,'')))
          ORDER BY spm.is_primary DESC, pm.last_name, pm.first_name, pm.id
          SEPARATOR ', '
        ) AS all_pm_names,
        MAX(CASE WHEN spm.is_primary = 1
            THEN TRIM(CONCAT(COALESCE(pm.first_name,''), ' ', COALESCE(pm.last_name,'')))
            ELSE NULL END
        ) AS primary_pm_name
      FROM myapp.projects p
      INNER JOIN myapp.project_schedule_items psi ON psi.project_id = p.id
      INNER JOIN myapp.project_schedule_item_project_managers spm ON spm.schedule_item_id = psi.id
      INNER JOIN myapp.project_managers pm ON pm.id = spm.project_manager_id
      WHERE spm.unassigned_at IS NULL
        AND pm.is_active = 1
      GROUP BY p.qbo_customer_id
    ),

    crew_meta AS (
      -- Crew Model v2 (CR3): "Company · Lead" labels ("… · lead TBD" lead-less)
      SELECT
        p.qbo_customer_id,
        GROUP_CONCAT(
          DISTINCT CONCAT(COALESCE(co.name, pc.name, wc.name), ' · ',
                          COALESCE(ld.name,
                                   CASE WHEN wc.parent_id IS NOT NULL THEN wc.name END,
                                   'lead TBD'))
          ORDER BY swc.is_primary DESC, wc.sort_order, wc.id
          SEPARATOR ', '
        ) AS all_crew_names,
        MAX(CASE WHEN swc.is_primary = 1
                 THEN CONCAT(COALESCE(co.name, pc.name, wc.name), ' · ',
                             COALESCE(ld.name,
                                      CASE WHEN wc.parent_id IS NOT NULL THEN wc.name END,
                                      'lead TBD'))
                 ELSE NULL END) AS primary_crew_name
      FROM myapp.projects p
      INNER JOIN myapp.project_schedule_items psi ON psi.project_id = p.id
      INNER JOIN myapp.project_schedule_item_work_crews swc ON swc.schedule_item_id = psi.id
      INNER JOIN myapp.work_crews wc ON wc.id = swc.work_crew_id
      LEFT JOIN myapp.work_crews co ON co.id = swc.company_id
      LEFT JOIN myapp.work_crews ld ON ld.id = swc.lead_crew_id
      LEFT JOIN myapp.work_crews pc ON pc.id = wc.parent_id
      WHERE swc.unassigned_at IS NULL
      GROUP BY p.qbo_customer_id
    ),

    latest_status_meta AS (
      SELECT qbo_customer_id, status AS latest_status FROM (
        SELECT p.qbo_customer_id, psi.status,
               ROW_NUMBER() OVER (PARTITION BY p.qbo_customer_id
                 ORDER BY psi.start_date IS NULL, psi.start_date DESC, psi.sort_order DESC, psi.id DESC) AS rn
        FROM myapp.projects p
        JOIN myapp.project_schedule_items psi ON psi.project_id = p.id
      ) x WHERE rn = 1
    )

    SELECT
      qc.id                                          AS qbo_customer_id,
      qc.qbo_id                                      AS project_qbo_id,
      qc.display_name                                AS project_name,
      qc.meta_create_time                            AS project_create_dttm,
      qc.meta_last_updated_time                      AS project_lastupdate_dttm,

      COALESCE(am.all_statuses,   '')                AS all_statuses,
      COALESCE(am.primary_status, 'needs_attention') AS project_status,
      COALESCE(lsm.latest_status, 'needs_attention') AS operational_status,
      am.all_start_dates,
      am.earliest_start_date                         AS start_date,
      am.all_end_dates,
      am.latest_end_date                             AS end_date,
      am.true_end_date                               AS true_end_date,

      COALESCE(pm.all_pm_names,   '')                AS all_project_managers,
      COALESCE(pm.primary_pm_name,'')                AS primary_project_manager,

      COALESCE(cr.all_crew_names, '')                AS all_work_crews,
      COALESCE(cr.primary_crew_name, '')             AS primary_work_crew,

      CASE
        WHEN am.qbo_customer_id IS NULL THEN 1
        WHEN am.primary_status = 'needs_attention' THEN 1
        ELSE 0
      END                                            AS needs_assignment,

      COALESCE(pf.file_count, 0)                     AS file_count,

      -- The originating opportunity (the estimate this project was won from),
      -- for the Projects hub's link back to the Pipeline. Blank until linked.
      (SELECT o.quote_number FROM myapp.opportunities o
         WHERE o.project_qbo_id = qc.qbo_id ORDER BY o.id DESC LIMIT 1) AS linked_quote_number,
      (SELECT o.id FROM myapp.opportunities o
         WHERE o.project_qbo_id = qc.qbo_id ORDER BY o.id DESC LIMIT 1) AS linked_opportunity_id

    FROM myapp.qbo_customers qc
    LEFT JOIN assignment_meta am ON am.qbo_customer_id = qc.id
    LEFT JOIN pm_meta        pm ON pm.qbo_customer_id = qc.id
    LEFT JOIN crew_meta      cr ON cr.qbo_customer_id = qc.id
    LEFT JOIN latest_status_meta lsm ON lsm.qbo_customer_id = qc.id
    LEFT JOIN (
      SELECT qbo_customer_id, COUNT(*) AS file_count
      FROM myapp.project_files
      GROUP BY qbo_customer_id
    ) pf ON pf.qbo_customer_id = qc.id

    WHERE qc.is_project = 1
    ORDER BY qc.display_name
    """)

    with engine.connect() as conn:
        rows = conn.execute(sql).mappings().all()

    # operational_status now = the final assignment row's status (from the SQL).
    visible = filter_visible([dict(r) for r in rows], user, key="qbo_customer_id")
    return {"projects": visible[:1000]}


@router.get("/projects/financials")
def projects_financials(user=Depends(get_current_user)):
    """
    Fast endpoint — returns per-project financial aggregates keyed by
    qbo_customer_id. Reads from the pre-computed project_financial_summary
    table that is refreshed at QBO sync time (and on-demand via
    /projects/refresh-financials).

    If the summary table is empty (first deploy, fresh DB, or after a wipe)
    this endpoint lazily triggers a refresh so the page still works.
    """
    read_sql = text("""
        SELECT
          pfs.qbo_customer_id,
          pfs.project_qbo_id,
          pfs.estimate_cost_amt,
          pfs.estimate_line_amt,
          pfs.invoice_line_amt,
          pfs.expense_line_amt,
          pfs.invoice_balance_amt,
          pfs.open_invoice_count,
          pfs.open_invoice_total_amt,
          pfs.balance_amt,
          pfs.actual_profit,
          pfs.actual_profit_pct,
          pfs.projected_profit,
          pfs.projected_profit_pct,
          pfs.cost_diff_amt,
          pfs.cost_diff_pct
        FROM myapp.project_financial_summary pfs
        INNER JOIN myapp.qbo_customers qc
          ON qc.id = pfs.qbo_customer_id
         AND qc.is_project = 1
        ORDER BY qc.display_name
    """)

    try:
        with engine.connect() as conn:
            rows = conn.execute(read_sql).mappings().all()
    except Exception:
        # Table probably doesn't exist yet; create + populate then retry.
        refresh_project_financial_summary()
        with engine.connect() as conn:
            rows = conn.execute(read_sql).mappings().all()

    # Lazy populate if empty (e.g., fresh DB, never synced)
    if not rows:
        refresh_project_financial_summary()
        with engine.connect() as conn:
            rows = conn.execute(read_sql).mappings().all()

    visible = filter_visible([dict(r) for r in rows], user, key="qbo_customer_id")
    return {"financials": visible[:1000]}


@router.get("/projects/attention")
def projects_attention(user=Depends(get_current_user)):
    """Per-project 'what needs attention' aggregates for the Projects hub flags —
    keyed by project qbo_id. Cheap group-bys only (estimate status counts + the
    latest crew-offer state/age); merged client-side alongside /projects/basic
    and /projects/financials. Heavier detail is loaded lazily per row on expand
    via /projects/{qbo_id}/card."""
    est_sql = text("""
        SELECT customer_qbo_id AS pid,
               COUNT(*) AS total,
               SUM(st = 'Pending') AS pending,
               SUM(st IN ('Accepted','Converted')) AS accepted,
               SUM(st IN ('Rejected','Closed')) AS declined
        FROM (
          SELECT customer_qbo_id,
                 JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.TxnStatus')) AS st
          FROM myapp.qbo_transactions
          WHERE entity_type = 'Estimate' AND customer_qbo_id IS NOT NULL
        ) e
        GROUP BY customer_qbo_id
    """)
    offer_sql = text("""
        SELECT pid, status, crew_name,
               DATEDIFF(CURDATE(), COALESCE(sent_at, created_at)) AS age_days
        FROM (
          -- Crew Model v2 (CR3): offers target COMPANIES — label the company
          -- (child-crew offers resolve via parent lookup), plus the boss name.
          SELECT o.entity_id AS pid, o.status, o.sent_at, o.created_at,
                 TRIM(CONCAT(COALESCE(pc.name, wc.name, ''),
                   CASE WHEN COALESCE(pc.boss_name, wc.boss_name) IS NOT NULL
                        THEN CONCAT(' · ', COALESCE(pc.boss_name, wc.boss_name)) ELSE '' END)) AS crew_name,
                 ROW_NUMBER() OVER (PARTITION BY o.entity_id
                   ORDER BY o.created_at DESC, o.id DESC) AS rn
          FROM myapp.work_offers o
          LEFT JOIN myapp.work_crews wc ON wc.id = o.crew_id
          LEFT JOIN myapp.work_crews pc ON pc.id = wc.parent_id
        ) x
        WHERE rn = 1
    """)
    # kick-off milestone progress + today's daily-log activity (both cheap
    # group-bys). Totals come from the kickoff/daily modules so they stay in sync.
    from app.kickoff.routes import MILESTONES
    kickoff_total = len(MILESTONES)
    kickoff_sql = text("""
        SELECT entity_id AS pid, SUM(done) AS done, COUNT(*) AS touched
        FROM myapp.project_milestones GROUP BY entity_id
    """)
    daily_sql = text("""
        SELECT entity_id AS pid, SUM(done) AS done_today
        FROM myapp.project_daily_log WHERE log_date = CURDATE() GROUP BY entity_id
    """)
    # overdue A/R per project: any latest-version invoice with an open balance
    # past its due date.
    ar_sql = text("""
        SELECT customer_qbo_id AS pid, MAX(DATEDIFF(CURDATE(), due_date)) AS overdue_days,
               ROUND(SUM(balance_amt),2) AS ar_total
        FROM (
          SELECT qt.customer_qbo_id, qt.balance_amt, qt.due_date,
                 ROW_NUMBER() OVER (PARTITION BY COALESCE(qt.doc_number,qt.qbo_id) ORDER BY qt.id DESC) rn
          FROM myapp.qbo_transactions qt WHERE qt.entity_type='Invoice' AND qt.customer_qbo_id IS NOT NULL
        ) x
        WHERE rn=1 AND balance_amt > 0.01 AND due_date < CURDATE()
        GROUP BY customer_qbo_id
    """)
    # on-site setup from the ASSIGNMENT page (project_schedule_items): wire
    # guidance, travel/overage days, and equipment type — the office's own values.
    setup_sql = text("""
        SELECT qc.qbo_id AS pid,
               MAX(psi.wire_guidance) AS wire,
               COALESCE(SUM(psi.travel_days), 0) AS travel_days,
               COALESCE(SUM(psi.overage_days), 0) AS overage_days,
               GROUP_CONCAT(DISTINCT NULLIF(psi.equipment_type,'') ORDER BY psi.equipment_type SEPARATOR ', ') AS equipment
        FROM myapp.project_schedule_items psi
        JOIN myapp.projects p ON p.id = psi.project_id
        JOIN myapp.qbo_customers qc ON qc.id = p.qbo_customer_id
        GROUP BY qc.qbo_id
    """)
    with engine.connect() as conn:
        est_rows = conn.execute(est_sql).mappings().all()
        offer_rows = conn.execute(offer_sql).mappings().all()
        kickoff_rows = conn.execute(kickoff_sql).mappings().all()
        daily_rows = conn.execute(daily_sql).mappings().all()
        setup_rows = conn.execute(setup_sql).mappings().all()
        ar_rows = conn.execute(ar_sql).mappings().all()
        # crew labor + expenses estimated (from latest-version accepted estimates)
        est_out_rows = conn.execute(text("""
            WITH latest AS (
              SELECT t.id, t.customer_qbo_id,
                     ROW_NUMBER() OVER (PARTITION BY t.customer_qbo_id,
                       COALESCE(t.doc_number, CONCAT('__nd__', t.qbo_id)) ORDER BY t.id DESC) AS rn
              FROM myapp.qbo_transactions t
              WHERE t.entity_type='Estimate'
                AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json,'$.TxnStatus')) IN ('Accepted','Converted','Closed')
            )
            SELECT le.customer_qbo_id AS pid,
                   ROUND(SUM(CASE WHEN sl.item_name LIKE 'Contract Labor%' THEN COALESCE(sl.cost_amount,0) ELSE 0 END),2) AS crew_est,
                   ROUND(SUM(CASE WHEN sl.item_name NOT LIKE 'Contract Labor%' AND sl.item_name NOT LIKE 'OH&P%' AND sl.item_name NOT LIKE 'Buffer%'
                                  THEN COALESCE(sl.cost_amount,0) ELSE 0 END),2) AS exp_est
            FROM latest le
            JOIN myapp.qbo_sales_transaction_lines sl ON sl.transaction_id=le.id AND sl.line_level='child'
            WHERE le.rn=1 GROUP BY le.customer_qbo_id
        """)).mappings().all()
        # crew labor + expenses actually paid (QBO bills / purchases)
        act_out_rows = conn.execute(text("""
            SELECT l.line_customer_qbo_id AS pid,
                   ROUND(SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(l.raw_json,'$.ItemBasedExpenseLineDetail.ItemRef.name')) LIKE 'Contract Labor%'
                                  THEN l.amount ELSE 0 END),2) AS crew_paid,
                   ROUND(SUM(CASE WHEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json,'$.ItemBasedExpenseLineDetail.ItemRef.name')),'') NOT LIKE 'Contract Labor%'
                                  AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json,'$.ItemBasedExpenseLineDetail.ItemRef.name')),'') NOT LIKE 'OH&P%'
                                  AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json,'$.ItemBasedExpenseLineDetail.ItemRef.name')),'') NOT LIKE 'Buffer%'
                                  THEN l.amount ELSE 0 END),2) AS exp_act
            FROM myapp.qbo_transaction_lines l JOIN myapp.qbo_transactions t ON t.id=l.transaction_id
            WHERE t.entity_type IN ('Bill','Purchase') AND l.line_customer_qbo_id IS NOT NULL
            GROUP BY l.line_customer_qbo_id
        """)).mappings().all()

    out = {}
    for r in est_rows:
        out.setdefault(str(r["pid"]), {})["estimates"] = {
            "total": int(r["total"] or 0), "pending": int(r["pending"] or 0),
            "accepted": int(r["accepted"] or 0), "declined": int(r["declined"] or 0),
        }
    for r in offer_rows:
        st = r["status"]
        state = "accepted" if st == "accepted" else ("sent" if st == "sent" else st or "none")
        out.setdefault(str(r["pid"]), {})["offer"] = {
            "state": state, "age_days": int(r["age_days"]) if r["age_days"] is not None else None,
            "crew_name": (r["crew_name"] or "").strip() or None,
        }
    for r in kickoff_rows:
        out.setdefault(str(r["pid"]), {})["kickoff"] = {
            "done": int(r["done"] or 0), "total": kickoff_total,
        }
    for r in daily_rows:
        out.setdefault(str(r["pid"]), {})["daily"] = {"today_done": int(r["done_today"] or 0)}
    for r in setup_rows:
        out.setdefault(str(r["pid"]), {})["setup"] = {
            "wire": bool(r["wire"]),
            "travel_days": int(r["travel_days"] or 0),
            "overage_days": int(r["overage_days"] or 0),
            "equipment": (r["equipment"] or "").strip() or None,
        }
    for r in ar_rows:
        out.setdefault(str(r["pid"]), {})["ar_overdue"] = {
            "days": int(r["overdue_days"] or 0), "total": round(float(r["ar_total"] or 0), 2),
        }
    est_out = {str(r["pid"]): r for r in est_out_rows}
    act_out = {str(r["pid"]): r for r in act_out_rows}
    for pid in set(est_out) | set(act_out):
        e, a = est_out.get(pid), act_out.get(pid)
        crew_due = max(0.0, float((e or {}).get("crew_est") or 0) - float((a or {}).get("crew_paid") or 0))
        exp_left = max(0.0, float((e or {}).get("exp_est") or 0) - float((a or {}).get("exp_act") or 0))
        out.setdefault(pid, {})["outstanding"] = {
            "crew_due": round(crew_due, 2), "exp_to_spend": round(exp_left, 2),
        }

    # CR5 B3: crew-consistency flag per project (bulk — the same pure verdict
    # as /projects/{qbo_id}/crew-consistency, fed by three grouped queries, so
    # the All Projects hub gets its flag without an N+1 of per-project calls).
    # Only non-ok verdicts ship (payload stays small; no flag = consistent).
    with engine.connect() as conn:
        cc_a, cc_o, cc_b = _crew_consistency_bulk(conn)
    for pid in set(cc_a) | set(cc_o) | set(cc_b):
        st, _details = _crew_consistency_verdict(
            cc_a.get(pid, []), cc_o.get(pid, []), cc_b.get(pid, []))
        if st in ("mismatch", "unmapped_vendor"):
            out.setdefault(pid, {})["crew_consistency"] = {
                "status": st,
                "summary": _crew_consistency_summary(st, cc_a.get(pid, []),
                                                     cc_o.get(pid, []), cc_b.get(pid, [])),
            }
    return {"attention": out, "kickoff_total": kickoff_total}


# ---------------------------------------------------------------------------
# CR5 B3 — crew-consistency check: do the assigned company(ies), the accepted
# crew offer's company, and the QBO Contract-Labor bill vendors agree?
# Vendors map to companies via work_crews.vendor_qbo_id (parent rows); vendor
# display names come from the bill's raw_json VendorRef.name (same source as
# billing._crew_labor_bills — there is no separate vendors table).
# Computed on request only — no caching table.
# ---------------------------------------------------------------------------

# Same Contract-Labor matching predicate as billing._crew_labor_bills, but
# grouped by VENDOR (that helper groups per bill and doesn't select the
# vendor_qbo_id, so it can't be reused directly for company mapping).
_CC_BILLED_SQL = """
    SELECT {pid_col} AS pid, t.vendor_qbo_id,
           MAX(JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.VendorRef.name'))) AS vendor_name,
           w.id AS company_id, MAX(w.name) AS company_name,
           ROUND(SUM(l.amount), 2) AS total
    FROM myapp.qbo_transaction_lines l
    JOIN myapp.qbo_transactions t ON t.id = l.transaction_id
    LEFT JOIN myapp.work_crews w
      ON w.vendor_qbo_id = t.vendor_qbo_id AND w.parent_id IS NULL
    WHERE t.entity_type = 'Bill'
      AND JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')) LIKE 'Contract Labor%'
      AND l.line_customer_qbo_id {pid_filter}
    GROUP BY {pid_col}, t.vendor_qbo_id, w.id
"""

_CC_ASSIGNED_SQL = """
    SELECT DISTINCT qc.qbo_id AS pid,
           COALESCE(swc.company_id, wc.parent_id, wc.id) AS id,
           COALESCE(co.name, pc.name, wc.name) AS name
    FROM myapp.project_schedule_item_work_crews swc
    JOIN myapp.project_schedule_items psi ON psi.id = swc.schedule_item_id
    JOIN myapp.projects p ON p.id = psi.project_id
    JOIN myapp.qbo_customers qc ON qc.id = p.qbo_customer_id
    JOIN myapp.work_crews wc ON wc.id = swc.work_crew_id
    LEFT JOIN myapp.work_crews co ON co.id = swc.company_id
    LEFT JOIN myapp.work_crews pc ON pc.id = wc.parent_id
    WHERE swc.unassigned_at IS NULL
      AND COALESCE(psi.status, '') <> 'canceled'
      {pid_filter}
"""

# Offers: ACCEPTED only — a sent offer preceding assignment is the normal
# workflow order, and declined/withdrawn offers are settled history; neither
# should read as a mismatch. Legacy child-crew offers resolve to the parent.
_CC_OFFERS_SQL = """
    SELECT DISTINCT o.entity_id AS pid,
           COALESCE(pc.id, wc.id) AS id, COALESCE(pc.name, wc.name) AS name
    FROM myapp.work_offers o
    JOIN myapp.work_crews wc ON wc.id = o.crew_id
    LEFT JOIN myapp.work_crews pc ON pc.id = wc.parent_id
    WHERE o.status = 'accepted' {pid_filter}
"""

# Multi-crew split (item #3): companies allocated a share of an estimate's
# crew payments COUNT AS EXPECTED — they fold into the assignment set, so
# bills from any allocated company are consistent, and (per the existing
# strict rule's spirit) an allocated company with NO Contract-Labor bills
# while others are billed is flagged like an unbilled assigned company.
_CC_ALLOC_SQL = """
    SELECT DISTINCT a.entity_id AS pid, wc.id AS id, wc.name AS name
    FROM myapp.project_estimate_crew_allocations a
    JOIN myapp.work_crews wc ON wc.id = a.company_crew_id
    WHERE 1=1 {pid_filter}
"""


def _cc_billed_row(r):
    return {
        "vendor_qbo_id": str(r["vendor_qbo_id"]) if r["vendor_qbo_id"] is not None else None,
        "vendor_name": r["vendor_name"] or "Unknown vendor",
        "company": ({"id": int(r["company_id"]), "name": r["company_name"]}
                    if r["company_id"] is not None else None),
        "total": float(r["total"] or 0),
    }


def _crew_consistency_data(conn, entity_id):
    """One project's three comparison sets: assignment companies (active rows on
    non-canceled schedule items), accepted-offer companies, and Contract-Labor
    bill vendors (grouped by vendor, mapped to a company when possible)."""
    assigned = [{"id": int(r["id"]), "name": r["name"]} for r in conn.execute(
        text(_CC_ASSIGNED_SQL.format(pid_filter="AND qc.qbo_id = :e")),
        {"e": entity_id}).mappings().all()]
    # fold split-allocation companies into the expected set (item #3)
    seen = {c["id"] for c in assigned}
    for r in conn.execute(text(_CC_ALLOC_SQL.format(pid_filter="AND a.entity_id = :e")),
                          {"e": entity_id}).mappings().all():
        if int(r["id"]) not in seen:
            assigned.append({"id": int(r["id"]), "name": r["name"]})
            seen.add(int(r["id"]))
    offers = [{"id": int(r["id"]), "name": r["name"]} for r in conn.execute(
        text(_CC_OFFERS_SQL.format(pid_filter="AND o.entity_id = :e")),
        {"e": entity_id}).mappings().all()]
    billed = [_cc_billed_row(r) for r in conn.execute(
        text(_CC_BILLED_SQL.format(pid_col="l.line_customer_qbo_id",
                                   pid_filter="= :e")),
        {"e": entity_id}).mappings().all()]
    return assigned, offers, billed


def _crew_consistency_bulk(conn):
    """All projects at once (for /projects/attention): dicts pid -> list, same
    shapes as _crew_consistency_data."""
    a, o, b = {}, {}, {}
    for r in conn.execute(text(_CC_ASSIGNED_SQL.format(pid_filter=""))).mappings().all():
        a.setdefault(str(r["pid"]), []).append({"id": int(r["id"]), "name": r["name"]})
    # fold split-allocation companies into the expected set (item #3)
    for r in conn.execute(text(_CC_ALLOC_SQL.format(pid_filter=""))).mappings().all():
        lst = a.setdefault(str(r["pid"]), [])
        if int(r["id"]) not in {c["id"] for c in lst}:
            lst.append({"id": int(r["id"]), "name": r["name"]})
    for r in conn.execute(text(_CC_OFFERS_SQL.format(pid_filter=""))).mappings().all():
        o.setdefault(str(r["pid"]), []).append({"id": int(r["id"]), "name": r["name"]})
    for r in conn.execute(text(_CC_BILLED_SQL.format(
            pid_col="l.line_customer_qbo_id", pid_filter="IS NOT NULL"))).mappings().all():
        b.setdefault(str(r["pid"]), []).append(_cc_billed_row(r))
    return a, o, b


def _crew_consistency_verdict(assignment_companies, offer_companies, billed_vendors):
    """PURE comparison (no DB — unit-testable with mocked sets).
    Returns (status, details). Rules (CR5 B3 spec):
      * mismatch — the sets disagree: any billed company or accepted-offer
        company not among the assignment companies, or (where any bills exist)
        an assignment company with no Contract-Labor bills.
      * unmapped_vendor — a billed vendor has no work_crews company mapping
        (and nothing harder is wrong; an unmapped vendor can't prove a
        mismatch on its own).
      * no_data — nothing to compare yet.
      * ok — everything that exists agrees."""
    a_by_id = {int(c["id"]): c["name"] for c in (assignment_companies or [])}
    o_by_id = {int(c["id"]): c["name"] for c in (offer_companies or [])}
    billed_vendors = billed_vendors or []
    mapped = [x for x in billed_vendors if x.get("company")]
    unmapped = [x for x in billed_vendors if not x.get("company")]
    b_by_id = {int(x["company"]["id"]): x["company"]["name"] for x in mapped}

    if not a_by_id and not o_by_id and not billed_vendors:
        return "no_data", ["No crew assignment, accepted offer, or Contract-Labor bills yet."]

    details, mismatch = [], False
    billed_not_assigned = sorted(n for i, n in b_by_id.items() if i not in a_by_id)
    if billed_not_assigned:
        mismatch = True
        details.append("Billed but not assigned: " + ", ".join(billed_not_assigned))
    offered_not_assigned = sorted(n for i, n in o_by_id.items() if i not in a_by_id)
    if offered_not_assigned:
        mismatch = True
        details.append("Accepted offer but not assigned: " + ", ".join(offered_not_assigned))
    if billed_vendors:
        assigned_not_billed = sorted(n for i, n in a_by_id.items() if i not in b_by_id)
        if assigned_not_billed:
            mismatch = True
            details.append("Assigned but no Contract-Labor bills yet: " + ", ".join(assigned_not_billed))
    for x in unmapped:
        details.append("Vendor not linked to a crew company: "
                       f"{x.get('vendor_name') or 'Unknown vendor'}"
                       f" (${round(float(x.get('total') or 0)):,})")

    if mismatch:
        return "mismatch", details
    if unmapped:
        return "unmapped_vendor", details
    names = sorted(set(a_by_id.values()) | set(b_by_id.values()) | set(o_by_id.values()))
    return "ok", ["Assigned, offered, and billed crews agree: " + ", ".join(names)
                  if names else "Consistent."]


def _crew_consistency_summary(status, assignment_companies, offer_companies, billed_vendors):
    """One-line chip text, e.g. 'assigned MTY · billed GS Material Handling'."""
    if status == "ok":
        return "Crew consistent"
    if status == "no_data":
        return "No crew data"
    if status == "unmapped_vendor":
        un = sorted({(x.get("vendor_name") or "Unknown vendor")
                     for x in (billed_vendors or []) if not x.get("company")})
        return "vendor not linked to a crew company: " + ", ".join(un)
    parts = ["assigned " + (", ".join(sorted({c["name"] for c in assignment_companies}))
                            if assignment_companies else "none")]
    if billed_vendors:
        parts.append("billed " + ", ".join(sorted(
            {(x["company"]["name"] if x.get("company") else (x.get("vendor_name") or "Unknown vendor"))
             for x in billed_vendors})))
    if offer_companies:
        parts.append("offer accepted " + ", ".join(sorted({c["name"] for c in offer_companies})))
    return " · ".join(parts)


@router.get("/projects/{qbo_id}/crew-consistency")
def project_crew_consistency(qbo_id: str, user=Depends(get_current_user)):
    """CR5 B3 — per-project crew-consistency check. Auth matches the other
    project reads (/assignment/bundle, /projects/{id}/card, history): any
    authenticated user token, which includes page.pm_portal users. Computed on
    request; nothing cached."""
    with engine.connect() as conn:
        if conn.execute(text(
            "SELECT 1 FROM myapp.qbo_customers WHERE qbo_id = :q AND is_project = 1"),
                {"q": qbo_id}).scalar() is None:
            raise HTTPException(status_code=404, detail="Project not found")
        assigned, offers, billed = _crew_consistency_data(conn, qbo_id)
    status, details = _crew_consistency_verdict(assigned, offers, billed)
    return {
        "project_qbo_id": qbo_id,
        "assignment_companies": assigned,
        "offer_companies": offers,
        "billed_vendors": billed,
        "status": status,
        "summary": _crew_consistency_summary(status, assigned, offers, billed),
        "details": details,
    }


# Best-effort mapping of QBO estimate line items → the owner's shared-cost
# buckets. Structured phase-level shared costs come later (Slice 3); until then
# we group the actual estimate lines by keyword so the card shows real numbers.
_SHARED_BUCKETS = [
    ("wire",      r"wire"),
    ("travel",    r"travel|lodg|per diem|mobil|fuel|flight|airfare"),
    ("overage",   r"overage|remobil|buffer|extra day"),
    ("equipment", r"equip|lift|scrubber|floor saw|saw|dumpster|propane|rental|scissor|boom"),
]


@router.get("/projects/{qbo_id}/card")
def project_card(qbo_id: str, user=Depends(get_current_user)):
    """Lazy per-project detail for the Projects hub expandable row: all date
    ranges, PMs, crews, notes, shared costs, estimates, the crew offer, and a
    financial snapshot. Loaded on demand when the office opens a row."""
    import re
    with engine.connect() as conn:
        if not conn.execute(text(
            "SELECT 1 FROM myapp.qbo_customers WHERE qbo_id=:q AND is_project=1"),
            {"q": qbo_id}).scalar():
            raise HTTPException(status_code=404, detail="Project not found")

        # date ranges + notes (schedule items that carry a start date)
        items = conn.execute(text("""
            SELECT DATE_FORMAT(psi.start_date,'%Y-%m-%d') AS start_date,
                   DATE_FORMAT(psi.end_date,'%Y-%m-%d')   AS end_date, psi.notes
            FROM myapp.project_schedule_items psi
            JOIN myapp.projects p ON p.id = psi.project_id
            JOIN myapp.qbo_customers qc ON qc.id = p.qbo_customer_id
            WHERE qc.qbo_id = :q
            ORDER BY psi.start_date, psi.id
        """), {"q": qbo_id}).mappings().all()
        date_ranges = [{"start": r["start_date"], "end": r["end_date"]}
                       for r in items if r["start_date"]]
        notes = [r["notes"].strip() for r in items if (r["notes"] or "").strip()]

        pms = [r[0] for r in conn.execute(text("""
            SELECT DISTINCT TRIM(CONCAT(COALESCE(pm.first_name,''),' ',COALESCE(pm.last_name,'')))
            FROM myapp.project_schedule_items psi
            JOIN myapp.projects p ON p.id=psi.project_id
            JOIN myapp.qbo_customers qc ON qc.id=p.qbo_customer_id
            JOIN myapp.project_schedule_item_project_managers spm ON spm.schedule_item_id=psi.id AND spm.unassigned_at IS NULL
            JOIN myapp.project_managers pm ON pm.id=spm.project_manager_id AND pm.is_active=1
            WHERE qc.qbo_id=:q
        """), {"q": qbo_id}).all() if (r[0] or "").strip()]
        # Crew Model v2 (CR3): "Company · Lead" ("… · lead TBD" lead-less)
        crews = [r[0] for r in conn.execute(text("""
            SELECT DISTINCT CONCAT(COALESCE(co.name, pc.name, wc.name), ' · ',
                     COALESCE(ld.name,
                              CASE WHEN wc.parent_id IS NOT NULL THEN wc.name END,
                              'lead TBD'))
            FROM myapp.project_schedule_items psi
            JOIN myapp.projects p ON p.id=psi.project_id
            JOIN myapp.qbo_customers qc ON qc.id=p.qbo_customer_id
            JOIN myapp.project_schedule_item_work_crews swc ON swc.schedule_item_id=psi.id AND swc.unassigned_at IS NULL
            JOIN myapp.work_crews wc ON wc.id=swc.work_crew_id
            LEFT JOIN myapp.work_crews co ON co.id=swc.company_id
            LEFT JOIN myapp.work_crews ld ON ld.id=swc.lead_crew_id
            LEFT JOIN myapp.work_crews pc ON pc.id=wc.parent_id
            WHERE qc.qbo_id=:q
        """), {"q": qbo_id}).all() if (r[0] or "").strip()]

        # estimates (QBO) — doc, status, amount, sent date
        est_rows = conn.execute(text("""
            SELECT t.doc_number, t.total_amt, DATE_FORMAT(t.txn_date,'%Y-%m-%d') AS d,
                   JSON_UNQUOTE(JSON_EXTRACT(t.raw_json,'$.TxnStatus')) AS st
            FROM myapp.qbo_transactions t
            WHERE t.entity_type='Estimate' AND t.customer_qbo_id=:q
            ORDER BY t.txn_date DESC
        """), {"q": qbo_id}).mappings().all()
        est_state = {"Accepted": "accepted", "Converted": "accepted",
                     "Rejected": "declined", "Closed": "declined", "Pending": "pending"}
        estimates = [{"doc": r["doc_number"], "amount": float(r["total_amt"] or 0),
                      "date": r["d"], "status": est_state.get(r["st"], (r["st"] or "").lower())} for r in est_rows]

        # on-site setup from the ASSIGNMENT (project_schedule_items): wire guidance,
        # travel/overage days, equipment type, notes — the office's entered values.
        srow = conn.execute(text("""
            SELECT MAX(psi.wire_guidance) AS wire,
                   COALESCE(SUM(psi.travel_days),0) AS travel_days,
                   COALESCE(SUM(psi.overage_days),0) AS overage_days,
                   GROUP_CONCAT(DISTINCT NULLIF(psi.equipment_type,'') SEPARATOR ', ') AS equipment,
                   GROUP_CONCAT(DISTINCT NULLIF(TRIM(psi.notes),'') SEPARATOR ' · ') AS notes
            FROM myapp.project_schedule_items psi
            JOIN myapp.projects p ON p.id=psi.project_id
            JOIN myapp.qbo_customers qc ON qc.id=p.qbo_customer_id
            WHERE qc.qbo_id=:q
        """), {"q": qbo_id}).mappings().first()
        site_setup = {
            "wire": bool(srow and srow["wire"]),
            "travel_days": int(srow["travel_days"] or 0) if srow else 0,
            "overage_days": int(srow["overage_days"] or 0) if srow else 0,
            "equipment": (srow["equipment"] or "").strip() or None if srow else None,
            "notes": (srow["notes"] or "").strip() or None if srow else None,
        }

        # expenses by category — estimated (from estimate cost lines) vs actual
        # (QBO bills/purchases), with what's left to spend. Contract Labor / margin
        # items are excluded (they're crew / margin, not expenses).
        from app.expenses.routes import _estimate_costs_by_category, _expense_category
        est_by_cat = _estimate_costs_by_category(conn, qbo_id) or {}
        act_by_cat = {}
        for r in conn.execute(text("""
            SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json,'$.ItemBasedExpenseLineDetail.ItemRef.name')),
                     SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json,'$.AccountBasedExpenseLineDetail.AccountRef.name')),':',1)) AS item,
                   ROUND(SUM(l.amount),2) AS amt
            FROM myapp.qbo_transaction_lines l JOIN myapp.qbo_transactions t ON t.id=l.transaction_id
            WHERE l.line_customer_qbo_id=:q AND t.entity_type IN ('Bill','Purchase')
            GROUP BY item
        """), {"q": qbo_id}).mappings().all():
            cat = _expense_category(r["item"])
            if cat is None:
                continue
            act_by_cat[cat] = round(act_by_cat.get(cat, 0.0) + float(r["amt"] or 0), 2)
        expense_categories = [
            {"category": c, "estimated": round(est_by_cat.get(c, 0.0), 2),
             "actual": round(act_by_cat.get(c, 0.0), 2),
             "remaining": round(est_by_cat.get(c, 0.0) - act_by_cat.get(c, 0.0), 2)}
            for c in sorted(set(est_by_cat) | set(act_by_cat))
        ]

        # latest crew offer — labeled by COMPANY (parent lookup for legacy
        # child-crew offers), plus the boss name when set (CR3).
        o = conn.execute(text("""
            SELECT o.status, o.labor_amount,
                   DATEDIFF(CURDATE(), COALESCE(o.sent_at, o.created_at)) AS age_days,
                   TRIM(CONCAT(COALESCE(pc.name, wc.name, ''),
                     CASE WHEN COALESCE(pc.boss_name, wc.boss_name) IS NOT NULL
                          THEN CONCAT(' · ', COALESCE(pc.boss_name, wc.boss_name)) ELSE '' END)) AS crew_name
            FROM myapp.work_offers o
            LEFT JOIN myapp.work_crews wc ON wc.id=o.crew_id
            LEFT JOIN myapp.work_crews pc ON pc.id=wc.parent_id
            WHERE o.entity_id=:q ORDER BY o.created_at DESC, o.id DESC LIMIT 1
        """), {"q": qbo_id}).mappings().first()
        offer = ({"state": ("accepted" if o["status"]=="accepted" else ("sent" if o["status"]=="sent" else o["status"])),
                  "age_days": int(o["age_days"]) if o["age_days"] is not None else None,
                  "labor": float(o["labor_amount"] or 0), "crew_name": (o["crew_name"] or "").strip() or None}
                 if o else {"state": "none", "age_days": None, "labor": 0, "crew_name": None})

        # financial snapshot
        fin = conn.execute(text("""
            SELECT estimate_cost_amt, estimate_line_amt, invoice_line_amt, expense_line_amt,
                   balance_amt, open_invoice_total_amt, actual_profit, actual_profit_pct,
                   projected_profit, projected_profit_pct
            FROM myapp.project_financial_summary pfs
            JOIN myapp.qbo_customers qc ON qc.id=pfs.qbo_customer_id
            WHERE qc.qbo_id=:q LIMIT 1
        """), {"q": qbo_id}).mappings().first()
        financial = {k: (float(v) if v is not None else None) for k, v in (fin or {}).items()}

        # kick-off & process progress (from the existing milestone system) + the
        # next still-open milestone, and today's daily-log activity.
        from app.kickoff.routes import MILESTONES
        done_keys = {r[0] for r in conn.execute(text(
            "SELECT milestone_key FROM myapp.project_milestones WHERE entity_id=:q AND done=1"),
            {"q": qbo_id}).all()}
        next_open = next((m["label"] for m in MILESTONES if m["key"] not in done_keys), None)
        kickoff = {"done": len(done_keys & {m["key"] for m in MILESTONES}),
                   "total": len(MILESTONES), "next": next_open}
        drow = conn.execute(text("""
            SELECT SUM(done) AS done_today, COUNT(*) AS touched_today,
                   (SELECT MAX(log_date) FROM myapp.project_daily_log WHERE entity_id=:q) AS last_date
            FROM myapp.project_daily_log WHERE entity_id=:q AND log_date=CURDATE()
        """), {"q": qbo_id}).mappings().first()
        daily = {"today_done": int(drow["done_today"] or 0) if drow else 0,
                 "today_touched": int(drow["touched_today"] or 0) if drow else 0,
                 "last_date": str(drow["last_date"]) if drow and drow["last_date"] else None}

        # Whether the books are closed (all schedule items complete) — once closed,
        # only sent A/R stays relevant; upcoming invoices/crew/expenses are moot.
        stset = {s.strip() for s in ((conn.execute(text("""
            SELECT GROUP_CONCAT(DISTINCT psi.status) FROM myapp.project_schedule_items psi
            JOIN myapp.projects p ON p.id=psi.project_id JOIN myapp.qbo_customers qc ON qc.id=p.qbo_customer_id
            WHERE qc.qbo_id=:q
        """), {"q": qbo_id}).scalar()) or "").split(",") if s.strip()}
        complete = bool(stset) and stset <= {"completed", "canceled"} and "completed" in stset

        # Sent A/R — real QBO invoices with an open balance (amount + soonest due).
        ar = conn.execute(text("""
            WITH latest AS (
              SELECT qt.total_amt, qt.balance_amt, qt.due_date,
                     ROW_NUMBER() OVER (PARTITION BY COALESCE(qt.doc_number,qt.qbo_id) ORDER BY qt.id DESC) rn
              FROM myapp.qbo_transactions qt WHERE qt.entity_type='Invoice' AND qt.customer_qbo_id=:q
            )
            SELECT COALESCE(SUM(balance_amt),0) AS total, COUNT(*) AS cnt,
                   DATE_FORMAT(MIN(due_date),'%Y-%m-%d') AS next_due,
                   DATEDIFF(CURDATE(), MIN(due_date)) AS overdue_days
            FROM latest WHERE rn=1 AND balance_amt > 0.01
        """), {"q": qbo_id}).mappings().first()

        # Upcoming customer invoices still to be sent = contract not yet invoiced
        # (so an early-billed deposit drops out), with the next scheduled date.
        contract = float(financial.get("estimate_line_amt") or 0)
        invoiced = float(financial.get("invoice_line_amt") or 0)
        inv_to_send = round(max(0.0, contract - invoiced), 2)
        next_inv_date = conn.execute(text("""
            SELECT DATE_FORMAT(MIN(m.invoice_date),'%Y-%m-%d')
            FROM myapp.project_invoice_milestones m JOIN myapp.project_invoice_schedules s ON s.id=m.schedule_id
            WHERE s.entity_id=:q AND m.invoice_date >= CURDATE()
        """), {"q": qbo_id}).scalar()
        # Crew payments still owed = estimate contract labor minus what's been paid.
        crew_est = conn.execute(text("""
            SELECT COALESCE(ROUND(SUM(COALESCE(sl.cost_amount, sl.amount)),2),0)
            FROM myapp.qbo_sales_transaction_lines sl JOIN myapp.qbo_transactions t ON t.id=sl.transaction_id
            WHERE t.entity_type='Estimate' AND sl.item_name LIKE 'Contract Labor%' AND sl.project_customer_qbo_id=:q
              AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json,'$.TxnStatus')) IN ('Accepted','Converted')
        """), {"q": qbo_id}).scalar()
        crew_paid_rows = conn.execute(text("""
            SELECT JSON_UNQUOTE(JSON_EXTRACT(t.raw_json,'$.VendorRef.name')) AS vendor,
                   ROUND(SUM(l.amount),2) AS amt
            FROM myapp.qbo_transaction_lines l JOIN myapp.qbo_transactions t ON t.id=l.transaction_id
            WHERE l.line_customer_qbo_id=:q AND t.entity_type='Bill'
              AND JSON_UNQUOTE(JSON_EXTRACT(l.raw_json,'$.ItemBasedExpenseLineDetail.ItemRef.name')) LIKE 'Contract Labor%'
            GROUP BY vendor ORDER BY amt DESC
        """), {"q": qbo_id}).mappings().all()
        crew_paid_total = round(sum(float(r["amt"] or 0) for r in crew_paid_rows), 2)
        crew_vendor_count = len(crew_paid_rows)
        crew_paid_vendors = [{"name": (r["vendor"] or "—"), "amount": float(r["amt"] or 0)} for r in crew_paid_rows]
        exp_remaining = round(max(0.0, sum(est_by_cat.values()) - sum(act_by_cat.values())), 2)

        upcoming = {
            "complete": bool(complete),
            "ar": {"total": round(float(ar["total"] or 0), 2), "count": int(ar["cnt"] or 0),
                   "next_due": ar["next_due"], "overdue_days": int(ar["overdue_days"]) if ar["overdue_days"] is not None else None},
            "invoices": {"total": inv_to_send, "next_date": next_inv_date},
            "crew": {"total": round(max(0.0, float(crew_est or 0) - crew_paid_total), 2)},
            "expenses": {"total": exp_remaining},
        }
        crew_paid_info = {"total": crew_paid_total, "vendors": crew_vendor_count,
                          "crews": crew_paid_vendors}

    financial["expense_estimated"] = round(sum(est_by_cat.values()), 2)
    financial["expense_actual"] = round(sum(act_by_cat.values()), 2)
    return {
        "qbo_id": qbo_id,
        "date_ranges": date_ranges,
        "pms": pms, "crews": crews, "notes": notes,
        "site_setup": site_setup, "expense_categories": expense_categories,
        "estimates": estimates,
        "offer": offer, "financial": financial, "crew_paid": crew_paid_info,
        "kickoff": kickoff, "daily": daily, "upcoming": upcoming,
    }


class ProjectStatusUpdate(BaseModel):
    status: str


@router.post("/projects/{qbo_id}/status")
def set_project_status(qbo_id: str, body: ProjectStatusUpdate, user=Depends(get_current_user)):
    """Set the operational status for a project from the Projects hub. Applies to
    all of the project's schedule items so the derived project-grain status moves
    as a unit (the Assignment page still edits per-schedule-item)."""
    from app.projects.service import ALLOWED_STATUS
    from app.projects.history import record_item_history
    if body.status not in ALLOWED_STATUS:
        raise HTTPException(status_code=400, detail="Invalid status")
    with engine.begin() as conn:
        before = conn.execute(text("""
            SELECT psi.id, psi.status
            FROM myapp.project_schedule_items psi
            JOIN myapp.projects p ON p.id = psi.project_id
            JOIN myapp.qbo_customers qc ON qc.id = p.qbo_customer_id
            WHERE qc.qbo_id = :q
        """), {"q": qbo_id}).mappings().all()
        n = conn.execute(text("""
            UPDATE myapp.project_schedule_items psi
            JOIN myapp.projects p ON p.id = psi.project_id
            JOIN myapp.qbo_customers qc ON qc.id = p.qbo_customer_id
            SET psi.status = :s
            WHERE qc.qbo_id = :q
        """), {"s": body.status, "q": qbo_id}).rowcount
        # Assignment-line history (CR1): one 'updated' row per item whose
        # status actually changed.
        for it in before:
            if it["status"] != body.status:
                record_item_history(conn, int(it["id"]), "updated", int(user["id"]),
                                    {"status": [it["status"], body.status]})
    if not n:
        raise HTTPException(status_code=404, detail="Project has no schedule rows")
    return {"ok": True, "updated": n}


@router.post("/projects/refresh-financials")
def refresh_financials(_admin=Depends(require_admin)):
    """
    Admin-only: manually recompute project_financial_summary. Normally this
    runs automatically after each QBO sync; use this when you've edited data
    out-of-band or want to rebuild the summary without waiting for a sync.
    """
    return refresh_project_financial_summary()


@router.post("/projects/reset-untouched-statuses")
def reset_untouched_statuses_endpoint(_admin=Depends(require_admin)):
    """
    Admin-only: bulk-reset master schedule-item rows that look auto-provisioned
    and untouched (status='not_started', no dates, is_extra_row=0) to status=NULL,
    so they render as "Needs Attention" on the Assignments page. Idempotent.
    """
    return reset_untouched_master_statuses()


@router.post("/projects/consolidate-orphaned-masters")
def consolidate_orphaned_masters_endpoint(_admin=Depends(require_admin)):
    """
    Admin-only: one-time data repair. For projects whose master row is the
    untouched 'needs_attention' default but a child row holds the real schedule,
    promote the earliest-dated child into the master row (moving PM/Crew
    assignments along with it) and delete that child. Renumbers remaining
    children's sort_order. Idempotent.
    """
    return consolidate_orphaned_master_rows()


class ArBalanceRequest(BaseModel):
    project_qbo_ids: List[str] = []

@router.post("/projects/ar-balance")
def projects_ar_balance(req: ArBalanceRequest, user=Depends(get_current_user)):
    """
    Returns open Invoice transactions for the given projects.
    If project_qbo_ids is empty, returns all projects.
    """
    sql = text("""
        SELECT
            qc.qbo_id          AS project_qbo_id,
            qc.display_name    AS project_name,
            qt.total_amt,
            qt.balance_amt,
            qt.txn_date,
            qt.due_date,
            qt.sales_term_name
        FROM (
            SELECT *
            FROM (
                SELECT t.*,
                       ROW_NUMBER() OVER (
                         PARTITION BY t.customer_qbo_id, t.entity_type,
                                      COALESCE(t.doc_number, CONCAT('__nodoc__', t.qbo_id))
                         ORDER BY t.id DESC
                       ) AS _rn
                FROM myapp.qbo_transactions t
                INNER JOIN myapp.qbo_customers qc_proj
                  ON qc_proj.qbo_id = t.customer_qbo_id
                  AND qc_proj.is_project = 1
                  AND (:no_filter = 1 OR qc_proj.qbo_id IN :qbo_ids)
                WHERE t.entity_type = 'Invoice'
                  AND (t.total_amt IS NULL OR t.total_amt > 0)
            ) _ranked
            WHERE _rn = 1
        ) qt
        JOIN myapp.qbo_customers qc
            ON qt.customer_qbo_id = qc.qbo_id
        WHERE qc.is_project = 1
          AND qt.balance_amt > 0
          AND (
            :no_filter = 1
            OR qc.qbo_id IN :qbo_ids
          )
        ORDER BY qt.due_date, qt.balance_amt DESC, qc.display_name
    """)

    qbo_ids = req.project_qbo_ids
    with engine.connect() as conn:
        rows = conn.execute(sql, {
            "no_filter": 1 if not qbo_ids else 0,
            "qbo_ids":   tuple(qbo_ids) if qbo_ids else ("",),
        }).mappings().all()

    # Scope to the user's visible projects (admin/office unaffected).
    allowed = visible_project_qbo_ids(user)
    rows = [dict(r) for r in rows]
    if allowed is not None:
        rows = [r for r in rows if str(r.get("project_qbo_id")) in allowed]
    return {"invoices": rows}


class EstimatesByStatusRequest(BaseModel):
    project_qbo_ids: List[str] = []

@router.post("/projects/estimates-by-status")
def projects_estimates_by_status(req: EstimatesByStatusRequest, user=Depends(get_current_user)):
    """
    Returns one row per project with conditional sums of Estimate.total_amt
    bucketed by QBO TxnStatus (Pending, Accepted, Converted, Closed, Rejected).
    Includes ALL statuses — Pending and Rejected are surfaced here precisely
    because they're excluded from the main financial aggregations.

    Uses the same dedup-by-doc-number logic as the rest of the page so that
    revised/replaced estimates aren't double-counted.
    """
    # Sums child-line amounts (same source the KPI card / main page / item-pivot
    # modal uses) so the totals across status columns reconcile exactly with
    # what's shown elsewhere on the Financials page. Using qt.total_amt instead
    # would diverge slightly for estimates with discount/tax/markup lines where
    # QBO's header TotalAmt and the sum of line items don't match.
    sql = text("""
        WITH latest_sales_txns AS (
          SELECT *
          FROM (
            SELECT t.*,
                   ROW_NUMBER() OVER (
                     PARTITION BY t.customer_qbo_id, t.entity_type,
                                  COALESCE(t.doc_number, CONCAT('__nodoc__', t.qbo_id))
                     ORDER BY t.id DESC
                   ) AS _rn
            FROM myapp.qbo_transactions t
            INNER JOIN myapp.qbo_customers qc_proj
              ON qc_proj.qbo_id = t.customer_qbo_id
              AND qc_proj.is_project = 1
              AND (:no_filter = 1 OR qc_proj.qbo_id IN :qbo_ids)
            WHERE t.entity_type = 'Estimate'
              AND (t.total_amt IS NULL OR t.total_amt > 0)
          ) _ranked
          WHERE _rn = 1
        )
        SELECT
          qc.qbo_id        AS project_qbo_id,
          qc.display_name  AS project_name,
          SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.TxnStatus')) = 'Pending'   THEN COALESCE(qstl.amount, 0) ELSE 0 END) AS pending_amt,
          SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.TxnStatus')) = 'Accepted'  THEN COALESCE(qstl.amount, 0) ELSE 0 END) AS accepted_amt,
          SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.TxnStatus')) = 'Converted' THEN COALESCE(qstl.amount, 0) ELSE 0 END) AS converted_amt,
          SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.TxnStatus')) = 'Closed'    THEN COALESCE(qstl.amount, 0) ELSE 0 END) AS closed_amt,
          SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.TxnStatus')) = 'Rejected'  THEN COALESCE(qstl.amount, 0) ELSE 0 END) AS rejected_amt,
          SUM(COALESCE(qstl.amount, 0)) AS total_amt
        FROM latest_sales_txns qt
        JOIN myapp.qbo_customers qc
          ON qt.customer_qbo_id = qc.qbo_id
        LEFT JOIN myapp.qbo_sales_transaction_lines qstl
          ON qstl.transaction_id = qt.id
          AND qstl.line_level = 'child'
        WHERE qc.is_project = 1
          AND (
            :no_filter = 1
            OR qc.qbo_id IN :qbo_ids
          )
        GROUP BY qc.qbo_id, qc.display_name
        HAVING SUM(COALESCE(qstl.amount, 0)) > 0
        ORDER BY qc.display_name
    """)

    qbo_ids = req.project_qbo_ids
    with engine.connect() as conn:
        rows = conn.execute(sql, {
            "no_filter": 1 if not qbo_ids else 0,
            "qbo_ids":   tuple(qbo_ids) if qbo_ids else ("",),
        }).mappings().all()

    # Scope to the user's visible projects (admin/office unaffected).
    allowed = visible_project_qbo_ids(user)
    rows = [dict(r) for r in rows]
    if allowed is not None:
        rows = [r for r in rows if str(r.get("project_qbo_id")) in allowed]
    return {"estimates": rows}


class FinancialsByItemRequest(BaseModel):
    project_qbo_ids: List[str] = []   # empty = all projects


class FinancialsItemLinesRequest(BaseModel):
    project_qbo_ids: List[str] = []
    item_name: str
    kind: str = "expense"   # expense | invoice | estimate


@router.post("/projects/financials/by-item/lines")
def projects_financials_item_lines(req: FinancialsItemLinesRequest, user=Depends(get_current_user)):
    """Drill-down: the raw transaction lines behind one item-type cell (e.g. the
    expense lines that sum to 'Materials'). Mirrors the by-item pivot's grouping."""
    ids = [str(x).strip() for x in req.project_qbo_ids if x]
    allowed = visible_project_qbo_ids(user)
    if allowed is not None:
        ids = [i for i in ids if i in allowed] if ids else list(allowed)
    if not ids:
        return {"lines": []}

    ph = ", ".join(f":id{i}" for i in range(len(ids)))
    params = {f"id{i}": v for i, v in enumerate(ids)}
    params["item"] = req.item_name
    is_other = req.item_name == "Other"

    # Item match mirrors the pivot: an item_qbo_id maps to a name via the sales
    # lines; 'Other' = unmapped (NULL or not in the mapping).
    if is_other:
        item_clause = ("(qtl.item_qbo_id IS NULL OR qtl.item_qbo_id NOT IN "
                       "(SELECT item_qbo_id FROM myapp.qbo_sales_transaction_lines "
                       " WHERE line_level='child' AND item_qbo_id IS NOT NULL))")
    else:
        item_clause = ("qtl.item_qbo_id IN (SELECT item_qbo_id FROM myapp.qbo_sales_transaction_lines "
                       "WHERE line_level='child' AND item_qbo_id IS NOT NULL AND item_name = :item)")

    if req.kind == "expense":
        sql = text(f"""
            SELECT JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json,'$.VendorRef.name')) AS vendor,
                   qt.entity_type, qt.doc_number, qt.txn_date, qtl.description,
                   CASE WHEN qt.entity_type='VendorCredit'
                          OR (qt.entity_type='Purchase' AND JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json,'$.Credit'))='true')
                        THEN -COALESCE(qtl.amount,0) ELSE COALESCE(qtl.amount,0) END AS amount
            FROM myapp.qbo_customers qc
            JOIN myapp.qbo_transaction_lines qtl ON qtl.line_customer_qbo_id = qc.qbo_id
            JOIN myapp.qbo_transactions qt ON qt.id = qtl.transaction_id
                 AND qt.entity_type IN ('Bill','Check','CreditCardCharge','Purchase','PurchaseOrder','VendorCredit')
            WHERE qc.is_project = 1 AND qc.qbo_id IN ({ph}) AND {item_clause}
            ORDER BY qt.txn_date DESC, qt.id DESC
        """)
    else:
        # invoice / estimate lines (revenue side) from the sales lines
        etype = "Invoice" if req.kind == "invoice" else "Estimate"
        params["etype"] = etype
        sql_item = "qstl.item_name = :item" if not is_other else \
            "(qstl.item_name IS NULL OR qstl.item_qbo_id IS NULL)"
        sql = text(f"""
            SELECT qc.display_name AS vendor, qt.entity_type, qt.doc_number, qt.txn_date,
                   qstl.description, COALESCE(qstl.amount,0) AS amount
            FROM myapp.qbo_customers qc
            JOIN myapp.qbo_transactions qt ON qt.customer_qbo_id = qc.qbo_id AND qt.entity_type = :etype
            JOIN myapp.qbo_sales_transaction_lines qstl ON qstl.transaction_id = qt.id AND qstl.line_level='child'
            WHERE qc.is_project = 1 AND qc.qbo_id IN ({ph}) AND {sql_item}
            ORDER BY qt.txn_date DESC, qt.id DESC
        """)

    with engine.connect() as conn:
        rows = conn.execute(sql, params).mappings().all()
    return {"lines": [{
        "vendor": r["vendor"], "entity_type": r["entity_type"], "doc_number": r["doc_number"],
        "txn_date": str(r["txn_date"]) if r["txn_date"] else None,
        "description": r["description"], "amount": float(r["amount"] or 0),
    } for r in rows]}


@router.post("/projects/financials/by-item")
def projects_financials_by_item(req: FinancialsByItemRequest, user=Depends(get_current_user)):
    """
    Returns a pivot table of financial amounts broken down by item_name.
    Rows: estimate_line, estimate_cost, invoice, expense
    Columns: the item names found in the data (ordered by a fixed priority list)

    If project_qbo_ids is provided, restricts to those projects only.
    """
    ITEM_ORDER = [
        "Contract Labor",
        "Materials",
        "Mgmt Travel",
        "Lodging",
        "Buffer",
        "Rentals",
        "Propane",
    ]

    # Build an optional IN-filter clause
    ids = [str(x).strip() for x in req.project_qbo_ids if x]

    # Scope to the user's visible projects. For scoped users we must always
    # constrain by id (an empty request would otherwise mean "all projects").
    allowed = visible_project_qbo_ids(user)
    if allowed is not None:
        ids = [i for i in ids if i in allowed] if ids else list(allowed)
        if not ids:
            # Scoped user with nothing visible -> empty pivot.
            return {"items": [], "estimate_line": {}, "estimate_cost": {},
                    "invoice_line": {}, "expense_line": {}}

    if ids:
        # Parameterised safely
        placeholders = ", ".join(f":id{i}" for i in range(len(ids)))
        id_filter_sales       = f"AND qc.qbo_id IN ({placeholders})"
        id_filter_expense     = f"AND qc.qbo_id IN ({placeholders})"
        # Pushed-down variant: applies the same filter inside the dedup
        # subquery so the window function doesn't rank rows we won't use.
        id_filter_sales_inner = f"AND qc_proj.qbo_id IN ({placeholders})"
        id_params = {f"id{i}": v for i, v in enumerate(ids)}
    else:
        id_filter_sales       = ""
        id_filter_expense     = ""
        id_filter_sales_inner = ""
        id_params = {}

    sales_sql = text(f"""
        SELECT
            qt.entity_type,
            COALESCE(qstl.item_name, 'Other')       AS item_name,
            SUM(COALESCE(qstl.amount,      0))       AS line_amount,
            SUM(COALESCE(qstl.cost_amount, 0))       AS cost_amount
        FROM myapp.qbo_customers qc
        INNER JOIN (
            SELECT *
            FROM (
                SELECT t.*,
                       ROW_NUMBER() OVER (
                         PARTITION BY t.customer_qbo_id, t.entity_type,
                                      COALESCE(t.doc_number, CONCAT('__nodoc__', t.qbo_id))
                         ORDER BY t.id DESC
                       ) AS _rn
                FROM myapp.qbo_transactions t
                INNER JOIN myapp.qbo_customers qc_proj
                  ON qc_proj.qbo_id = t.customer_qbo_id
                  AND qc_proj.is_project = 1
                  {id_filter_sales_inner}
                WHERE t.entity_type IN ('Invoice', 'Estimate', 'SalesReceipt', 'CreditMemo')
                  AND (t.total_amt IS NULL OR t.total_amt > 0)
                  -- Estimates: only count Accepted/Converted/Closed in the by-item pivot.
                  AND (
                    t.entity_type <> 'Estimate'
                    OR JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted', 'Closed')
                  )
            ) _ranked
            WHERE _rn = 1
        ) qt ON qt.customer_qbo_id = qc.qbo_id
        LEFT JOIN myapp.qbo_sales_transaction_lines qstl
            ON qstl.transaction_id = qt.id
            AND qstl.line_level = 'child'
        WHERE qc.is_project = 1
          {id_filter_sales}
        GROUP BY qt.entity_type, COALESCE(qstl.item_name, 'Other')
    """)

    expense_sql = text(f"""
        SELECT
            COALESCE(item_names.item_name, 'Other') AS item_name,
            SUM(CASE
                WHEN qt.entity_type = 'VendorCredit' THEN -COALESCE(qtl.amount, 0)
                WHEN qt.entity_type = 'Purchase'
                     AND JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.Credit')) = 'true'
                  THEN -COALESCE(qtl.amount, 0)
                ELSE COALESCE(qtl.amount, 0)
            END)                                    AS line_amount
        FROM myapp.qbo_customers qc
        INNER JOIN myapp.qbo_transaction_lines qtl
            ON qtl.line_customer_qbo_id = qc.qbo_id
        INNER JOIN myapp.qbo_transactions qt
            ON qt.id = qtl.transaction_id
            AND qt.entity_type IN ('Bill', 'Check', 'CreditCardCharge', 'Purchase', 'PurchaseOrder', 'VendorCredit')
        LEFT JOIN (
            SELECT item_qbo_id, MAX(item_name) AS item_name
            FROM myapp.qbo_sales_transaction_lines
            WHERE line_level = 'child'
              AND item_qbo_id IS NOT NULL
            GROUP BY item_qbo_id
        ) item_names ON item_names.item_qbo_id = qtl.item_qbo_id
        WHERE qc.is_project = 1
          {id_filter_expense}
        GROUP BY COALESCE(item_names.item_name, 'Other')
    """)

    with engine.connect() as conn:
        sales_rows   = conn.execute(sales_sql,   id_params).mappings().all()
        expense_rows = conn.execute(expense_sql, id_params).mappings().all()

    # Collect all item names seen in the data, ordered by ITEM_ORDER then alphabetical
    item_names_seen = set()
    for r in sales_rows:
        item_names_seen.add(r["item_name"])
    for r in expense_rows:
        item_names_seen.add(r["item_name"])

    ordered_items = [i for i in ITEM_ORDER if i in item_names_seen]
    other_items   = sorted(i for i in item_names_seen if i not in ITEM_ORDER)
    all_items     = ordered_items + other_items

    # Build lookup dicts
    # estimate_line[item] = amount, estimate_cost[item] = cost_amount
    estimate_line = {}
    estimate_cost = {}
    invoice_line  = {}

    for r in sales_rows:
        item = r["item_name"]
        if r["entity_type"] == "Estimate":
            estimate_line[item] = estimate_line.get(item, 0) + float(r["line_amount"] or 0)
            estimate_cost[item] = estimate_cost.get(item, 0) + float(r["cost_amount"] or 0)
        elif r["entity_type"] == "Invoice":
            invoice_line[item]  = invoice_line.get(item, 0)  + float(r["line_amount"] or 0)

    expense_line = {}
    for r in expense_rows:
        item = r["item_name"]
        expense_line[item] = expense_line.get(item, 0) + float(r["line_amount"] or 0)

    # Build the pivot structure the frontend expects
    def row_data(lookup):
        return {item: round(lookup.get(item, 0), 2) for item in all_items}

    return {
        "items":         all_items,
        "estimate_line": row_data(estimate_line),
        "estimate_cost": row_data(estimate_cost),
        "invoice_line":  row_data(invoice_line),
        "expense_line":  row_data(expense_line),
    }


@router.get("/schedule")
def schedule(
    week_start: Optional[str] = Query(None, description="YYYY-MM-DD"),
    week_end: Optional[str] = Query(None, description="YYYY-MM-DD"),
    user=Depends(get_current_user),
):
    """
    Returns:
      - active work crews
      - project assignments that overlap the requested visible date range
    """

    def parse_ymd(s: str) -> date:
        return datetime.strptime(s, "%Y-%m-%d").date()

    def monday_of(d: date) -> date:
        return d - timedelta(days=d.weekday())

    today = date.today()
    visible_start = monday_of(today) if not week_start else parse_ymd(week_start)
    visible_end = (
        visible_start + timedelta(days=6)
        if not week_end
        else parse_ymd(week_end)
    )

    if visible_end < visible_start:
        visible_start, visible_end = visible_end, visible_start

    crews_sql = text("""
      SELECT id, name, code, parent_id, is_active, sort_order,
             boss_name, crew_capacity
      FROM myapp.work_crews
      WHERE is_active = 1
      ORDER BY
        COALESCE(parent_id, id),
        parent_id IS NOT NULL,
        sort_order,
        id
    """)

    assignments_sql = text("""
      SELECT
        psi.id AS schedule_item_id,
        p.id AS project_id,
        qc.id AS qbo_customer_id,
        psi.start_date,
        psi.end_date,
        psi.wire_guidance,
        psi.travel_days,
        psi.overage_days,
        psi.equipment_type,
        psi.notes,
        psi.non_working,
        psi.status AS project_status,
        qc.display_name AS project_name,

        COALESCE((
          SELECT CAST(CONCAT('[', GROUP_CONCAT(JSON_QUOTE(wc2.code) ORDER BY swc2.is_primary DESC, wc2.sort_order, wc2.id), ']') AS JSON)
          FROM myapp.project_schedule_item_work_crews swc2
          JOIN myapp.work_crews wc2 ON wc2.id = swc2.work_crew_id
          WHERE swc2.schedule_item_id = psi.id
            AND swc2.unassigned_at IS NULL
            AND wc2.is_active = 1
        ), JSON_ARRAY()) AS work_crew_codes,

        -- Crew Model v2 (CR3): one entry per assignment crew row — the page
        -- slots these under the COMPANY by slot_code (JR1…); lead NULL means
        -- "lead not assigned yet" (visible indicator + tooltip note).
        COALESCE((
          SELECT CAST(CONCAT('[', GROUP_CONCAT(JSON_OBJECT(
                   'slot', swc2.slot_code,
                   'company_id', COALESCE(swc2.company_id, wc2.parent_id, wc2.id),
                   'company_code', COALESCE(co2.code, pc2.code, CASE WHEN wc2.parent_id IS NULL THEN wc2.code END),
                   'company', COALESCE(co2.name, pc2.name, wc2.name),
                   'lead', COALESCE(ld2.name, CASE WHEN wc2.parent_id IS NOT NULL THEN wc2.name END)
                 ) ORDER BY swc2.is_primary DESC, swc2.slot_code, swc2.id), ']') AS JSON)
          FROM myapp.project_schedule_item_work_crews swc2
          JOIN myapp.work_crews wc2 ON wc2.id = swc2.work_crew_id
          LEFT JOIN myapp.work_crews co2 ON co2.id = swc2.company_id
          LEFT JOIN myapp.work_crews ld2 ON ld2.id = swc2.lead_crew_id
          LEFT JOIN myapp.work_crews pc2 ON pc2.id = wc2.parent_id
          WHERE swc2.schedule_item_id = psi.id
            AND swc2.unassigned_at IS NULL
        ), JSON_ARRAY()) AS crew_slots,

        COALESCE((
          SELECT CAST(CONCAT('[', GROUP_CONCAT(JSON_QUOTE(
            TRIM(CONCAT(
              COALESCE(LEFT(pm2.first_name, 1), ''),
              COALESCE(LEFT(pm2.last_name, 1), '')
            ))
          ) ORDER BY spm2.is_primary DESC, pm2.id), ']') AS JSON)
          FROM myapp.project_schedule_item_project_managers spm2
          JOIN myapp.project_managers pm2 ON pm2.id = spm2.project_manager_id
          WHERE spm2.schedule_item_id = psi.id
            AND spm2.unassigned_at IS NULL
            AND pm2.is_active = 1
        ), JSON_ARRAY()) AS pm_initials

      FROM myapp.project_schedule_items psi
      JOIN myapp.projects p
        ON p.id = psi.project_id
      JOIN myapp.qbo_customers qc
        ON qc.id = p.qbo_customer_id

      WHERE
        psi.start_date IS NOT NULL
        AND psi.end_date IS NOT NULL
        AND COALESCE(psi.status, '') <> 'canceled'
        AND psi.start_date <= :range_end_plus
        -- include rows whose OVERAGE/TRAVEL spill reaches into this window
        -- (e.g. DHL: end 8/xx + 86 overage days extends into November; the
        -- bare end_date filter clipped the row out of later months entirely)
        AND DATE_ADD(psi.end_date, INTERVAL COALESCE(psi.overage_days,0) + COALESCE(psi.travel_days,0) DAY) >= :range_start_minus

      ORDER BY psi.start_date, psi.id
    """)

    range_start_minus = (visible_start - timedelta(days=4)).isoformat()
    range_end_plus = (visible_end + timedelta(days=21)).isoformat()

    # 0063 CREW TIME-OFF: ranges overlapping the visible window, one entry per
    # row. company_id lets the page hang the grey "Unavailable" block row under
    # the right company whether the row points at the company (level
    # 'company' — whole company off) or at one lead (level 'lead').
    time_off_sql = text("""
      SELECT cto.id, cto.crew_id, cto.start_date, cto.end_date, cto.reason,
             wc.name AS crew_name, wc.parent_id,
             COALESCE(wc.parent_id, wc.id) AS company_id,
             COALESCE(pc.name, wc.name) AS company_name
      FROM myapp.crew_time_off cto
      JOIN myapp.work_crews wc ON wc.id = cto.crew_id
      LEFT JOIN myapp.work_crews pc ON pc.id = wc.parent_id
      WHERE cto.start_date <= :vend AND cto.end_date >= :vstart
      ORDER BY cto.start_date, cto.id
    """)

    with engine.connect() as conn:
        crews_rows = conn.execute(crews_sql).mappings().all()
        assignment_rows = conn.execute(
            assignments_sql,
            {
                "range_start_minus": range_start_minus,
                "range_end_plus": range_end_plus,
            },
        ).mappings().all()
        time_off_rows = conn.execute(time_off_sql, {
            "vstart": visible_start.isoformat(),
            "vend": visible_end.isoformat(),
        }).mappings().all()

    crews = [dict(r) for r in crews_rows]

    from .service import _parse_non_working

    assignments = []
    for r in assignment_rows:
        row = dict(r)
        # 0062: non-working config per assignment — the page greys/hatches
        # those cells inside the project bar (cellType "dayoff").
        row["non_working"] = _parse_non_working(row.get("non_working"))
        for k in ("work_crew_codes", "crew_slots", "pm_initials"):
            v = row.get(k)
            if v is None:
                row[k] = []
            elif isinstance(v, (list, tuple)):
                row[k] = list(v)
            elif isinstance(v, (bytes, bytearray)):
                try:
                    row[k] = json.loads(v.decode("utf-8"))
                except Exception:
                    row[k] = []
            elif isinstance(v, str):
                try:
                    row[k] = json.loads(v)
                except Exception:
                    row[k] = []
            else:
                row[k] = []
        assignments.append(row)

    # Scope assignments to the user's visible projects (crews list is not sensitive).
    assignments = filter_visible(assignments, user, key="qbo_customer_id")

    # 0063: crew time-off is crew-level data (like the crews list) — no
    # project scoping. label = the person/company shown on the grey block.
    time_off = [{
        "id": r["id"], "crew_id": r["crew_id"],
        "company_id": int(r["company_id"]),
        "level": "lead" if r["parent_id"] is not None else "company",
        "label": r["crew_name"], "company": r["company_name"],
        "start_date": str(r["start_date"]), "end_date": str(r["end_date"]),
        "reason": r["reason"],
    } for r in time_off_rows]

    return {
        "week_start": visible_start.isoformat(),
        "week_end": visible_end.isoformat(),
        "crews": crews,
        "assignments": assignments,
        "time_off": time_off,
    }


@router.post("/projects/{qbo_customer_id}/files")
async def upload_project_file(
    qbo_customer_id: int,
    file: UploadFile = File(...),
    user=Depends(get_current_user),
):
    allowed_types = {
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/pdf",
    }

    if not file.filename:
        raise HTTPException(status_code=400, detail="File name is required")

    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Unsupported file type")

    contents = await file.read()
    size_bytes = len(contents)

    max_size = 10 * 1024 * 1024  # 10 MB
    if size_bytes > max_size:
        raise HTTPException(status_code=400, detail="File too large (max 10 MB)")

    from app.db import engine
    with engine.begin() as conn:
        project_id = ensure_project_row_for_qbo_customer(conn, qbo_customer_id)

        s3_key = build_project_file_key(qbo_customer_id, file.filename)

        s3_client.put_object(
            Bucket=AWS_BUCKET,
            Key=s3_key,
            Body=contents,
            ContentType=file.content_type,
        )

        conn.execute(text("""
            INSERT INTO project_files (
                project_id,
                qbo_customer_id,
                s3_bucket,
                s3_key,
                original_filename,
                content_type,
                size_bytes,
                uploaded_by_user_id
            )
            VALUES (
                :project_id,
                :qbo_customer_id,
                :s3_bucket,
                :s3_key,
                :original_filename,
                :content_type,
                :size_bytes,
                :uploaded_by_user_id
            )
        """), {
            "project_id": project_id,
            "qbo_customer_id": qbo_customer_id,
            "s3_bucket": AWS_BUCKET,
            "s3_key": s3_key,
            "original_filename": file.filename,
            "content_type": file.content_type,
            "size_bytes": size_bytes,
            "uploaded_by_user_id": int(user["id"]),
        })

        file_id = conn.execute(text("SELECT LAST_INSERT_ID()")).scalar()

    return {
        "ok": True,
        "file": {
            "id": int(file_id),
            "project_id": project_id,
            "qbo_customer_id": qbo_customer_id,
            "filename": file.filename,
            "content_type": file.content_type,
            "size_bytes": size_bytes,
            "s3_key": s3_key,
            "url": signed_file_url(s3_key),
        }
    }


@router.get("/projects/{qbo_customer_id}/files")
def list_project_files(qbo_customer_id: int, user=Depends(get_current_user)):
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT
                id,
                project_id,
                qbo_customer_id,
                s3_bucket,
                s3_key,
                original_filename,
                content_type,
                size_bytes,
                uploaded_by_user_id,
                created_at
            FROM project_files
            WHERE qbo_customer_id = :qbo_customer_id
            ORDER BY created_at DESC, id DESC
        """), {"qbo_customer_id": qbo_customer_id}).mappings().all()

    files = []
    for r in rows:
        d = dict(r)
        d["url"] = signed_file_url(d["s3_key"])
        files.append(d)

    return {"files": files}