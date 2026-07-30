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
    notes: Optional[str] = None

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

def _operational_status(p):
    """Project-grain operational status for the Projects hub — distinct from the
    opportunity's estimating lifecycle. Stages: needs_assignment -> assigned ->
    scheduled -> in_progress -> complete (+ canceled). Derived from the project's
    schedule-item statuses (all_statuses) + whether a start date is set."""
    if p.get("needs_assignment"):
        return "needs_assignment"
    statuses = {s.strip() for s in (p.get("all_statuses") or "").split(",") if s.strip()}
    if "in_progress" in statuses:
        return "in_progress"
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
      psi.is_extra_row AS is_extra_row,

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
      SELECT
        swc.schedule_item_id,
        MAX(
          CASE
            WHEN swc.is_primary = 1
            THEN wc.name
            ELSE NULL
          END
        ) AS primary_crew_name,
        GROUP_CONCAT(
          DISTINCT wc.name
          ORDER BY swc.is_primary DESC, wc.sort_order, wc.id
          SEPARATOR ', '
        ) AS all_crew_names
      FROM myapp.project_schedule_item_work_crews swc
      JOIN myapp.work_crews wc
        ON wc.id = swc.work_crew_id
      WHERE swc.unassigned_at IS NULL
        AND wc.is_active = 1
        AND wc.parent_id IS NOT NULL
      GROUP BY swc.schedule_item_id
    ) wc
      ON wc.schedule_item_id = psi.id

    WHERE qc.is_project = 1
    ORDER BY qc.display_name, psi.start_date, psi.id
    """)

    with engine.connect() as conn:
        rows = conn.execute(sql).mappings().all()

    projects = filter_visible([dict(r) for r in rows], user, key="qbo_customer_id")
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
      SELECT
        swc.schedule_item_id,
        MAX(CASE WHEN swc.is_primary = 1 THEN wc.name ELSE NULL END) AS primary_crew_name,
        GROUP_CONCAT(
          DISTINCT wc.name
          ORDER BY swc.is_primary DESC, wc.sort_order, wc.id
          SEPARATOR ', '
        ) AS all_crew_names
      FROM myapp.project_schedule_item_work_crews swc
      JOIN myapp.work_crews wc ON wc.id = swc.work_crew_id
      WHERE swc.unassigned_at IS NULL AND wc.is_active = 1 AND wc.parent_id IS NOT NULL
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
      SELECT
        p.qbo_customer_id,
        GROUP_CONCAT(
          DISTINCT wc.name
          ORDER BY swc.is_primary DESC, wc.sort_order, wc.id
          SEPARATOR ', '
        ) AS all_crew_names,
        MAX(CASE WHEN swc.is_primary = 1 THEN wc.name ELSE NULL END) AS primary_crew_name
      FROM myapp.projects p
      INNER JOIN myapp.project_schedule_items psi ON psi.project_id = p.id
      INNER JOIN myapp.project_schedule_item_work_crews swc ON swc.schedule_item_id = psi.id
      INNER JOIN myapp.work_crews wc ON wc.id = swc.work_crew_id
      WHERE swc.unassigned_at IS NULL
        AND wc.is_active = 1
        AND wc.parent_id IS NOT NULL
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
      SELECT
        p.qbo_customer_id,
        GROUP_CONCAT(
          DISTINCT wc.name
          ORDER BY swc.is_primary DESC, wc.sort_order, wc.id
          SEPARATOR ', '
        ) AS all_crew_names,
        MAX(CASE WHEN swc.is_primary = 1 THEN wc.name ELSE NULL END) AS primary_crew_name
      FROM myapp.projects p
      INNER JOIN myapp.project_schedule_items psi ON psi.project_id = p.id
      INNER JOIN myapp.project_schedule_item_work_crews swc ON swc.schedule_item_id = psi.id
      INNER JOIN myapp.work_crews wc ON wc.id = swc.work_crew_id
      WHERE swc.unassigned_at IS NULL
        AND wc.is_active = 1
        AND wc.parent_id IS NOT NULL
      GROUP BY p.qbo_customer_id
    )

    SELECT
      qc.id                                          AS qbo_customer_id,
      qc.qbo_id                                      AS project_qbo_id,
      qc.display_name                                AS project_name,
      qc.meta_create_time                            AS project_create_dttm,
      qc.meta_last_updated_time                      AS project_lastupdate_dttm,

      COALESCE(am.all_statuses,   '')                AS all_statuses,
      COALESCE(am.primary_status, 'needs_attention') AS project_status,
      am.all_start_dates,
      am.earliest_start_date                         AS start_date,
      am.all_end_dates,
      am.latest_end_date                             AS end_date,

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

    visible = filter_visible([dict(r) for r in rows], user, key="qbo_customer_id")
    for p in visible:
        p["operational_status"] = _operational_status(p)
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
      SELECT id, name, code, parent_id, is_active, sort_order
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
        AND psi.end_date >= :range_start_minus

      ORDER BY psi.start_date, psi.id
    """)

    range_start_minus = (visible_start - timedelta(days=4)).isoformat()
    range_end_plus = (visible_end + timedelta(days=21)).isoformat()

    with engine.connect() as conn:
        crews_rows = conn.execute(crews_sql).mappings().all()
        assignment_rows = conn.execute(
            assignments_sql,
            {
                "range_start_minus": range_start_minus,
                "range_end_plus": range_end_plus,
            },
        ).mappings().all()

    crews = [dict(r) for r in crews_rows]

    assignments = []
    for r in assignment_rows:
        row = dict(r)
        for k in ("work_crew_codes", "pm_initials"):
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

    return {
        "week_start": visible_start.isoformat(),
        "week_end": visible_end.isoformat(),
        "crews": crews,
        "assignments": assignments,
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