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
    # Loads:
    # - project meta (start/end/status)
    # - active PM assignments
    # - active crew assignments
    # - list of all PMs
    # - list of all crews
    return get_assignment_bundle(qbo_customer_id=qbo_customer_id)

@router.post("/assignment/save")
def assignment_save(req: ScheduleItemSaveRequest, user=Depends(get_current_user)):
    try:
        return save_schedule_item(req=req, actor_user_id=int(user["id"]))
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
      p.qbo_customer_id AS qbo_customer_id,
      ip.start_date AS start_date,
      ip.end_date AS end_date,
      pm.primary_pm_name AS primary_project_manager,
      wc.primary_crew_name AS primary_work_crew,
      p.qbo_id AS project_qbo_id,
      p.display_name AS project_name,
      p.balance_with_jobs AS project_balance,
      p.meta_create_time AS project_create_dttm,
      p.meta_last_updated_time AS project_lastupdate_dttm,
      COALESCE(pf.file_count, 0) AS file_count,
               
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
    LEFT JOIN (
      SELECT
        qbo_customer_id,
        COUNT(*) AS file_count
      FROM myapp.project_files
      GROUP BY qbo_customer_id
    ) pf
      ON pf.qbo_customer_id = p.qbo_customer_id
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
    week_start: Optional[str] = Query(None, description="YYYY-MM-DD"),
    week_end: Optional[str] = Query(None, description="YYYY-MM-DD"),
    user=Depends(get_current_user),
):
    """
    Returns:
      - active work crews
      - project assignments that overlap the requested visible date range

    Frontend expands each assignment across days between start_date/end_date.
    The client currently sends the full month grid range as week_start/week_end.
    """

    def parse_ymd(s: str) -> date:
        return datetime.strptime(s, "%Y-%m-%d").date()

    def monday_of(d: date) -> date:
        return d - timedelta(days=d.weekday())  # Monday=0

    # Default to current week if caller sends nothing
    today = date.today()
    visible_start = monday_of(today) if not week_start else parse_ymd(week_start)
    visible_end = (
        visible_start + timedelta(days=6)
        if not week_end
        else parse_ymd(week_end)
    )

    # Safety: normalize in case params are reversed
    if visible_end < visible_start:
        visible_start, visible_end = visible_end, visible_start

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

    # 2) Load assignments that overlap the visible range
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

    # Keep the same scheduling buffer behavior you already had
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
