# projects/routes.py
# This file defines API routes related to projects and assignments, including listing projects, managing project assignments, uploading files, and fetching project events. It uses FastAPI for routing and SQLAlchemy for database interactions.
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from pydantic import BaseModel
from typing import Optional, List
from sqlalchemy import text
from app.db import engine
from datetime import date, datetime, timedelta

import json

from app.auth import get_current_user
from .service import (
    list_assignable_projects,
    get_assignment_bundle,
    save_schedule_item,
    list_project_events,
    ensure_project_row_for_qbo_customer,
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
    try:
        return save_schedule_item(req=req, actor_user_id=int(user["id"]))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.delete("/assignment/schedule-item/{schedule_item_id}")
def delete_schedule_item(schedule_item_id: int, user=Depends(get_current_user)):
    from .service import delete_schedule_item as delete_schedule_item_service
    try:
        return delete_schedule_item_service(schedule_item_id, int(user["id"]))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/assignment/table")
def assignment_table(user=Depends(get_current_user)):
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

    return {"projects": [dict(r) for r in rows]}

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
      INNER JOIN myapp.qbo_transactions qt
        ON qt.customer_qbo_id = qc.qbo_id
        AND qt.entity_type IN ('Invoice', 'Estimate', 'SalesReceipt', 'CreditMemo')
      LEFT JOIN myapp.qbo_sales_transaction_lines qstl
        ON qstl.transaction_id = qt.id
        AND qstl.line_level = 'child'
      WHERE qc.is_project = 1
    ),

    -- ----------------------------------------------------------------
    -- SIDE B: Expense / cost lines (Bills, Checks, CC charges, etc.)
    -- Joined to customer via line_customer_qbo_id
    -- ----------------------------------------------------------------
    expense_lines AS (
      SELECT
        qc.qbo_id                      AS project_qbo_id,
        qtl.amount                     AS line_amount
      FROM myapp.qbo_customers qc
      INNER JOIN myapp.qbo_transaction_lines qtl
        ON qtl.line_customer_qbo_id = qc.qbo_id
      INNER JOIN myapp.qbo_transactions qt
        ON qt.id = qtl.transaction_id
        AND qt.entity_type IN ('Bill', 'Check', 'CreditCardCharge', 'Purchase', 'PurchaseOrder')
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
      qc.balance_with_jobs                           AS project_balance,
      qc.meta_create_time                            AS project_create_dttm,
      qc.meta_last_updated_time                      AS project_lastupdate_dttm,

      -- Assignment fields (concatenated across all schedule items)
      COALESCE(am.all_statuses,   '')                AS all_statuses,
      COALESCE(am.primary_status, 'not_started')     AS project_status,
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

      -- Needs attention flag
      CASE WHEN am.qbo_customer_id IS NULL THEN 1 ELSE 0 END AS needs_assignment,

      -- File count
      COALESCE(pf.file_count, 0)                     AS file_count,

      -- ---- QBO Financial fields ----
      COALESCE(sr.estimate_cost_amt, 0)              AS estimate_cost_amt,
      COALESCE(sr.estimate_line_amt, 0)              AS estimate_line_amt,
      COALESCE(sr.invoice_line_amt,  0)              AS invoice_line_amt,
      COALESCE(er.expense_line_amt,  0)              AS expense_line_amt,

      -- AR balance outstanding (QBO-maintained, most accurate source)
      qc.balance_with_jobs                           AS invoice_balance_amt,

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
      (COALESCE(sr.invoice_line_amt, 0) - COALESCE(sr.estimate_cost_amt, 0))
                                                     AS projected_profit,

      -- Projected profit %: projected_profit / invoice (NULL if no invoice)
      CASE
        WHEN COALESCE(sr.invoice_line_amt, 0) = 0 THEN NULL
        ELSE (COALESCE(sr.invoice_line_amt, 0) - COALESCE(sr.estimate_cost_amt, 0))
             / COALESCE(sr.invoice_line_amt, 0)
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

    # Compute header-level aggregates for the KPI cards
    total_estimate_cost  = sum(float(p.get("estimate_cost_amt") or 0) for p in projects)
    total_estimate_line  = sum(float(p.get("estimate_line_amt") or 0) for p in projects)
    total_invoice        = sum(float(p.get("invoice_line_amt")  or 0) for p in projects)
    total_expense        = sum(float(p.get("expense_line_amt")  or 0) for p in projects)
    total_invoice_bal    = sum(float(p.get("invoice_balance_amt") or 0) for p in projects)
    total_actual_profit  = total_invoice - total_expense
    total_proj_profit    = total_invoice - total_estimate_cost

    return {
        "summary": {
            "total_projects":        len(projects),
            "total_estimate_cost":   total_estimate_cost,
            "total_estimate_line":   total_estimate_line,
            "total_invoice":         total_invoice,
            "total_invoice_bal":     total_invoice_bal,
            "total_expense":         total_expense,
            "total_actual_profit":   total_actual_profit,
            "actual_profit_pct":     (total_actual_profit / total_invoice) if total_invoice else None,
            "total_proj_profit":     total_proj_profit,
            "projected_profit_pct":  (total_proj_profit  / total_invoice) if total_invoice else None,
        },
        "projects": projects[:1000],
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