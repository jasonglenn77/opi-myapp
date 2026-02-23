from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
from sqlalchemy import text
from app.db import engine
from datetime import date, datetime, timedelta

from app.auth import get_current_user
from .service import (
    list_assignable_projects,
    get_assignment_bundle,
    save_project_assignment,
    list_project_events,
)

router = APIRouter(prefix="/api", tags=["projects"])

class AssignmentSaveRequest(BaseModel):
    qbo_customer_id: int
    status: str
    start_date: Optional[str] = None   # "YYYY-MM-DD"
    end_date: Optional[str] = None     # "YYYY-MM-DD"
    project_manager_ids: List[int] = []
    primary_project_manager_id: Optional[int] = None
    work_crew_ids: List[int] = []
    primary_work_crew_id: Optional[int] = None

@router.get("/assignment/projects")
def assignment_projects(user=Depends(get_current_user)):
    # List QBO projects for the dropdown/search
    return list_assignable_projects()

@router.get("/assignment/bundle")
def assignment_bundle(qbo_customer_id: int, user=Depends(get_current_user)):
    # Loads:
    # - project meta (start/end/status)
    # - active PM assignments
    # - active crew assignments
    # - list of all PMs
    # - list of all crews
    return get_assignment_bundle(qbo_customer_id=qbo_customer_id)

@router.post("/assignment/save")
def assignment_save(req: AssignmentSaveRequest, user=Depends(get_current_user)):
    try:
        return save_project_assignment(req=req, actor_user_id=int(user["id"]))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/projects/{qbo_customer_id}/events")
def project_events(qbo_customer_id: int, user=Depends(get_current_user)):
    return list_project_events(qbo_customer_id=qbo_customer_id)

@router.get("/projects")
def projects(user=Depends(get_current_user)):

    sql = text("""
    WITH
    projects AS (
      SELECT
        id AS qbo_customer_id,
        qbo_id,
        display_name,
        balance_with_jobs,
        meta_create_time,
        meta_last_updated_time
      FROM myapp.qbo_customers
      WHERE is_project = 1
    ),
    line_totals AS (
      SELECT
        transaction_id,
        line_customer_qbo_id AS project_qbo_id,
        SUM(amount) AS line_amt
      FROM myapp.qbo_transaction_lines
      WHERE line_customer_qbo_id IS NOT NULL
      GROUP BY transaction_id, line_customer_qbo_id
    ),
    txn_rollup AS (
      SELECT
        COALESCE(t.customer_qbo_id, lt.project_qbo_id) AS project_qbo_id,

        SUM(CASE WHEN t.entity_type='Estimate' THEN t.total_amt ELSE 0 END) AS estimate_amt,
        SUM(CASE WHEN t.entity_type='Estimate' THEN 1 ELSE 0 END) AS estimate_ct,

        SUM(CASE WHEN t.entity_type='Invoice' THEN t.total_amt ELSE 0 END) AS invoice_amt,
        SUM(CASE WHEN t.entity_type='Invoice' THEN t.balance_amt ELSE 0 END) AS invoice_bal,
        SUM(CASE WHEN t.entity_type='Invoice' THEN 1 ELSE 0 END) AS invoice_ct,

        SUM(CASE WHEN t.entity_type='Bill' THEN COALESCE(lt.line_amt,0) ELSE 0 END) AS bill_amt,
        SUM(CASE WHEN t.entity_type='Bill' THEN 1 ELSE 0 END) AS bill_ct,

        SUM(CASE WHEN t.entity_type='Purchase' THEN COALESCE(lt.line_amt,0) ELSE 0 END) AS expense_amt,
        SUM(CASE WHEN t.entity_type='Purchase' THEN 1 ELSE 0 END) AS expense_ct,

        SUM(CASE WHEN t.entity_type='VendorCredit' THEN COALESCE(lt.line_amt,0) ELSE 0 END) AS vendorcredit_amt,
        SUM(CASE WHEN t.entity_type='VendorCredit' THEN 1 ELSE 0 END) AS vendorcredit_ct,

        SUM(CASE WHEN t.entity_type='CreditMemo' THEN t.total_amt ELSE 0 END) AS creditmemo_amt,
        SUM(CASE WHEN t.entity_type='CreditMemo' THEN t.balance_amt ELSE 0 END) AS creditmemo_bal,
        SUM(CASE WHEN t.entity_type='CreditMemo' THEN 1 ELSE 0 END) AS creditmemo_ct,

        COUNT(DISTINCT t.id) AS total_transaction_ct
        
      FROM myapp.qbo_transactions t
      LEFT JOIN line_totals lt
        ON lt.transaction_id = t.id
        AND t.entity_type IN ('Bill','Purchase','VendorCredit')
      WHERE t.entity_type IN ('Estimate','Invoice','Bill','Purchase','VendorCredit','CreditMemo')
      GROUP BY COALESCE(t.customer_qbo_id, lt.project_qbo_id)
    )
    SELECT
      ip.start_date AS start_date,
      ip.end_date AS end_date,
      pm.primary_pm_name AS primary_project_manager,
      wc.primary_crew_name AS primary_work_crew,
      p.qbo_id AS project_qbo_id,
      p.display_name AS project_name,
      p.balance_with_jobs AS project_balance,
      p.meta_create_time AS project_create_dttm,
      p.meta_last_updated_time AS project_lastupdate_dttm,
               
      CASE WHEN ip.id IS NULL THEN 1 ELSE 0 END AS needs_assignment,
      COALESCE(ip.status, 'not_started') AS project_status,

      COALESCE(r.estimate_amt,0) AS estimate_amt,
      COALESCE(r.estimate_ct,0) AS estimate_ct,
      COALESCE(r.invoice_amt,0) AS invoice_amt,
      COALESCE(r.invoice_bal,0) AS invoice_bal,
      COALESCE(r.invoice_ct,0) AS invoice_ct,
      COALESCE(r.bill_amt,0) AS bill_amt,
      COALESCE(r.bill_ct,0) AS bill_ct,
      COALESCE(r.expense_amt,0) AS expense_amt,
      COALESCE(r.expense_ct,0) AS expense_ct,
      COALESCE(r.vendorcredit_amt,0) AS vendorcredit_amt,
      COALESCE(r.vendorcredit_ct,0) AS vendorcredit_ct,
      COALESCE(r.creditmemo_amt,0) AS creditmemo_amt,
      COALESCE(r.creditmemo_bal,0) AS creditmemo_bal,
      COALESCE(r.creditmemo_ct,0) AS creditmemo_ct,
      COALESCE(r.total_transaction_ct, 0) AS total_transaction_ct,

      (COALESCE(r.invoice_amt,0) - COALESCE(r.creditmemo_amt,0)) AS total_income,
      (COALESCE(r.bill_amt,0) + COALESCE(r.expense_amt,0) - COALESCE(r.vendorcredit_amt,0)) AS total_cost,

      (
        (COALESCE(r.invoice_amt,0) - COALESCE(r.creditmemo_amt,0))
        -
        (COALESCE(r.bill_amt,0) + COALESCE(r.expense_amt,0) - COALESCE(r.vendorcredit_amt,0))
      ) AS total_profit,

      CASE
        WHEN (COALESCE(r.invoice_amt,0) - COALESCE(r.creditmemo_amt,0)) = 0 THEN NULL
        ELSE (
          (
            (COALESCE(r.invoice_amt,0) - COALESCE(r.creditmemo_amt,0))
            -
            (COALESCE(r.bill_amt,0) + COALESCE(r.expense_amt,0) - COALESCE(r.vendorcredit_amt,0))
          ) / (COALESCE(r.invoice_amt,0) - COALESCE(r.creditmemo_amt,0))
        )
      END AS profit_margin,

      DATEDIFF(p.meta_last_updated_time, p.meta_create_time) AS age_days

    FROM projects p
    LEFT JOIN myapp.projects ip
      ON ip.qbo_customer_id = p.qbo_customer_id 
    LEFT JOIN (
      SELECT
        ppm.project_id,
        MAX(TRIM(CONCAT(COALESCE(pm.first_name,''), ' ', COALESCE(pm.last_name,'')))) AS primary_pm_name
      FROM myapp.project_project_managers ppm
      JOIN myapp.project_managers pm
        ON pm.id = ppm.project_manager_id
      WHERE ppm.unassigned_at IS NULL
        AND ppm.is_primary = 1
      GROUP BY ppm.project_id
    ) pm
      ON pm.project_id = ip.id

    LEFT JOIN (
      SELECT
        pwc.project_id,
        MAX(wc.name) AS primary_crew_name
      FROM myapp.project_work_crews pwc
      JOIN myapp.work_crews wc
        ON wc.id = pwc.work_crew_id
      WHERE pwc.unassigned_at IS NULL
        AND pwc.is_primary = 1
      GROUP BY pwc.project_id
    ) wc
      ON wc.project_id = ip.id
    LEFT JOIN txn_rollup r
      ON r.project_qbo_id = p.qbo_id
    ORDER BY p.meta_last_updated_time DESC
    """)

    with engine.connect() as conn:
        rows = conn.execute(sql).mappings().all()

    projects = [dict(r) for r in rows]

    # avg age
    age_sum = 0
    age_ct = 0

    for p in projects:
        if p.get("age_days") is not None:
            age_sum += int(p["age_days"])
            age_ct += 1

    avg_age_days = (age_sum / age_ct) if age_ct else None

    return {
        "summary": {
            "total_projects": len(projects),
            "avg_age_days": avg_age_days,
        },
        "projects": projects[:1000],  # keep UI snappy; raise later or paginate
    }

@router.get("/schedule")
def schedule(
    week_start: Optional[str] = Query(None, description="YYYY-MM-DD (Monday preferred)"),
    user=Depends(get_current_user),
):
    """
    Returns:
      - active work crews
      - project assignments (primary crew + primary PM) that overlap the requested week
    Frontend expands each assignment across days between start_date/end_date.
    """

    def parse_ymd(s: str) -> date:
        return datetime.strptime(s, "%Y-%m-%d").date()

    def monday_of(d: date) -> date:
        return d - timedelta(days=d.weekday())  # Monday=0

    # Determine week start (Monday)
    today = date.today()
    ws = monday_of(today) if not week_start else monday_of(parse_ymd(week_start))
    we = ws + timedelta(days=6)

    # 1) Load crews (active) in a stable order
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

    # 2) Load assignments that overlap the week
    # - projects table has: start_date, end_date, status, qbo_customer_id
    # - primary crew from project_work_crews
    # - primary pm from project_project_managers
    # - project name from qbo_customers.display_name
    assignments_sql = text("""
      SELECT
        p.id AS project_id,
        p.start_date,
        p.end_date,
        p.status AS project_status,

        wc.id AS work_crew_id,
        wc.code AS work_crew_code,

        qc.display_name AS project_name,

        pm.id AS project_manager_id,
        TRIM(CONCAT(
          COALESCE(LEFT(pm.first_name, 1), ''),
          COALESCE(LEFT(pm.last_name, 1), '')
        )) AS pm_initials

      FROM myapp.projects p
      JOIN myapp.qbo_customers qc
        ON qc.id = p.qbo_customer_id

      LEFT JOIN myapp.project_work_crews pwc
        ON pwc.project_id = p.id
        AND pwc.unassigned_at IS NULL
        AND pwc.is_primary = 1
      LEFT JOIN myapp.work_crews wc
        ON wc.id = pwc.work_crew_id

      LEFT JOIN myapp.project_project_managers ppm
        ON ppm.project_id = p.id
        AND ppm.unassigned_at IS NULL
        AND ppm.is_primary = 1
      LEFT JOIN myapp.project_managers pm
        ON pm.id = ppm.project_manager_id

      WHERE
        p.start_date IS NOT NULL
        AND p.end_date IS NOT NULL
        AND p.start_date <= :week_end
        AND p.end_date >= :week_start

      ORDER BY wc.sort_order, wc.code, p.start_date, p.id
    """)

    with engine.connect() as conn:
        crews_rows = conn.execute(crews_sql).mappings().all()
        assignment_rows = conn.execute(
            assignments_sql,
            {"week_start": ws.isoformat(), "week_end": we.isoformat()},
        ).mappings().all()

    crews = [dict(r) for r in crews_rows]
    assignments = [dict(r) for r in assignment_rows]

    return {
        "week_start": ws.isoformat(),
        "week_end": we.isoformat(),
        "crews": crews,
        "assignments": assignments,
    }
