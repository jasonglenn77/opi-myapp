from fastapi import FastAPI, Depends, HTTPException
from pydantic import BaseModel

from passlib.context import CryptContext

from .db import db_check
from sqlalchemy import text

import uuid
from typing import Optional

from .auth import create_access_token, get_current_user, require_admin
from app.qbo.routes import router as qbo_router
from app.projects.routes import router as projects_router

app = FastAPI()
app.include_router(qbo_router)
app.include_router(projects_router)

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


class LoginRequest(BaseModel):
    email: str
    password: str

class UserCreateRequest(BaseModel):
    email: str
    password: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    role: str = "user"
    is_active: bool = True

class UserUpdateRequest(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None

class ProjectManagerCreateRequest(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    is_active: bool = True

class ProjectManagerUpdateRequest(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    is_active: Optional[bool] = None

class WorkCrewCreateRequest(BaseModel):
    name: str
    code: Optional[str] = None
    parent_id: Optional[int] = None
    is_active: bool = True
    sort_order: int = 0

class WorkCrewUpdateRequest(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    parent_id: Optional[int] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/db-check")
def database_check():
    return db_check()

def get_user_by_email(email: str):
    # Uses SQLAlchemy engine from db.py (most likely you already have it)
    from .db import engine
    with engine.connect() as conn:
        row = conn.execute(
            text("""
                SELECT id, email, password_hash, role, is_active
                FROM users
                WHERE email = :email
                LIMIT 1
            """),
            {"email": email.lower()},
        ).mappings().first()
        return row


@app.post("/api/login")
def login(req: LoginRequest):
    user = get_user_by_email(req.email)

    # Keep error generic so we don't leak whether email exists
    if not user or int(user["is_active"]) != 1:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not pwd_context.verify(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # (optional) update last_login_at
    from .db import engine
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE users SET last_login_at = NOW() WHERE id = :id"),
            {"id": user["id"]},
        )

    token = create_access_token(sub=user["email"])
    return {"access_token": token, "token_type": "bearer", "role": user["role"]}

@app.get("/api/me")
def me(user=Depends(get_current_user)):
    return {"user": user}


@app.get("/api/dashboard")
def dashboard(user=Depends(get_current_user)):
    """
    Dashboard KPI endpoint.
    Returns project rollups (same shape as /api/projects) so the frontend can total
    completed project income/cost/profit + margin.
    """
    from .db import engine

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

    # avg age (kept for future use; harmless if frontend ignores it)
    age_sum = 0
    age_ct = 0
    for p in projects:
        if p.get("age_days") is not None:
            age_sum += int(p["age_days"])
            age_ct += 1
    avg_age_days = (age_sum / age_ct) if age_ct else None

    return {
        "projects": projects[:1000],
        "summary": {
            "total_projects": len(projects),
            "avg_age_days": avg_age_days,
        },
    }

@app.get("/api/users")
def list_users(_admin=Depends(require_admin)):
    from .db import engine
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, uuid, email, first_name, last_name, role, is_active,
                   created_at, updated_at, last_login_at
            FROM users
            ORDER BY id DESC
        """)).mappings().all()
    return [dict(r) for r in rows]


@app.post("/api/users")
def create_user(req: UserCreateRequest, _admin=Depends(require_admin)):
    from .db import engine

    email = req.email.strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Email required")

    role = (req.role or "user").strip().lower()
    if role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="Invalid role")

    if not req.password or not req.password.strip():
        raise HTTPException(status_code=400, detail="Password required")

    user_uuid = str(uuid.uuid4())
    password_hash = pwd_context.hash(req.password)

    first_name = (req.first_name or "").strip() or None
    last_name = (req.last_name or "").strip() or None

    try:
        with engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO users (uuid, email, first_name, last_name, password_hash, role, is_active)
                VALUES (:uuid, :email, :first_name, :last_name, :password_hash, :role, :is_active)
            """), {
                "uuid": user_uuid,
                "email": email,
                "first_name": first_name,
                "last_name": last_name,
                "password_hash": password_hash,
                "role": role,
                "is_active": 1 if req.is_active else 0,
            })
    except Exception:
        raise HTTPException(status_code=400, detail="Could not create user (email may already exist)")

    return {"ok": True}


@app.put("/api/users/{user_id}")
def update_user(user_id: int, req: UserUpdateRequest, _admin=Depends(require_admin)):
    from .db import engine

    updates = []
    params = {"id": user_id}

    if req.email is not None:
        email = req.email.strip().lower()
        if not email:
            raise HTTPException(status_code=400, detail="Email cannot be empty")
        updates.append("email = :email")
        params["email"] = email

    # Allow clearing (client sends null) by checking fields_set
    if "first_name" in req.__fields_set__:
        updates.append("first_name = :first_name")
        params["first_name"] = (req.first_name or "").strip() or None

    if "last_name" in req.__fields_set__:
        updates.append("last_name = :last_name")
        params["last_name"] = (req.last_name or "").strip() or None

    if req.role is not None:
        role = req.role.strip().lower()
        if role not in ("admin", "user"):
            raise HTTPException(status_code=400, detail="Invalid role")
        updates.append("role = :role")
        params["role"] = role

    if req.is_active is not None:
        updates.append("is_active = :is_active")
        params["is_active"] = 1 if req.is_active else 0

    # Password: if included and non-empty, update it. If included as empty/null, ignore.
    if "password" in req.__fields_set__:
        if req.password is not None and str(req.password).strip() != "":
            updates.append("password_hash = :password_hash")
            params["password_hash"] = pwd_context.hash(req.password)

    if not updates:
        return {"ok": True, "updated": False}

    try:
        with engine.begin() as conn:
            result = conn.execute(text(f"""
                UPDATE users
                SET {", ".join(updates)}
                WHERE id = :id
            """), params)
            if result.rowcount == 0:
                raise HTTPException(status_code=404, detail="User not found")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Could not update user (email may already exist)")

    return {"ok": True, "updated": True}


@app.delete("/api/users/{user_id}")
def disable_user(user_id: int, _admin=Depends(require_admin)):
    """
    Safer than hard delete: disable the user
    """
    from .db import engine
    with engine.begin() as conn:
        result = conn.execute(text("""
            UPDATE users
            SET is_active = 0
            WHERE id = :id
        """), {"id": user_id})

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="User not found")

    return {"ok": True}

# -----------------------------
# Project Managers
# -----------------------------

@app.get("/api/project-managers")
def list_project_managers(_admin=Depends(require_admin)):
    from .db import engine
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, first_name, last_name, email, phone, is_active, created_at, updated_at
            FROM project_managers
            ORDER BY id DESC
        """)).mappings().all()
    return [dict(r) for r in rows]


@app.post("/api/project-managers")
def create_project_manager(req: ProjectManagerCreateRequest, _admin=Depends(require_admin)):
    from .db import engine

    first_name = (req.first_name or "").strip() or None
    last_name = (req.last_name or "").strip() or None
    email = (req.email or "").strip().lower() or None
    phone = (req.phone or "").strip() or None

    try:
        with engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO project_managers (first_name, last_name, email, phone, is_active)
                VALUES (:first_name, :last_name, :email, :phone, :is_active)
            """), {
                "first_name": first_name,
                "last_name": last_name,
                "email": email,
                "phone": phone,
                "is_active": 1 if req.is_active else 0,
            })
    except Exception:
        raise HTTPException(status_code=400, detail="Could not create project manager (email may already exist)")

    return {"ok": True}


@app.put("/api/project-managers/{pm_id}")
def update_project_manager(pm_id: int, req: ProjectManagerUpdateRequest, _admin=Depends(require_admin)):
    from .db import engine

    updates = []
    params = {"id": pm_id}

    if "first_name" in req.__fields_set__:
        updates.append("first_name = :first_name")
        params["first_name"] = (req.first_name or "").strip() or None

    if "last_name" in req.__fields_set__:
        updates.append("last_name = :last_name")
        params["last_name"] = (req.last_name or "").strip() or None

    if "email" in req.__fields_set__:
        updates.append("email = :email")
        params["email"] = (req.email or "").strip().lower() or None

    if "phone" in req.__fields_set__:
        updates.append("phone = :phone")
        params["phone"] = (req.phone or "").strip() or None

    if req.is_active is not None:
        updates.append("is_active = :is_active")
        params["is_active"] = 1 if req.is_active else 0

    if not updates:
        return {"ok": True, "updated": False}

    try:
        with engine.begin() as conn:
            result = conn.execute(text(f"""
                UPDATE project_managers
                SET {", ".join(updates)}
                WHERE id = :id
            """), params)
            if result.rowcount == 0:
                raise HTTPException(status_code=404, detail="Project manager not found")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Could not update project manager (email may already exist)")

    return {"ok": True, "updated": True}


@app.delete("/api/project-managers/{pm_id}")
def disable_project_manager(pm_id: int, _admin=Depends(require_admin)):
    from .db import engine
    with engine.begin() as conn:
        result = conn.execute(text("""
            UPDATE project_managers
            SET is_active = 0
            WHERE id = :id
        """), {"id": pm_id})

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Project manager not found")

    return {"ok": True}


# -----------------------------
# Work Crews (supports sub-crews via parent_id)
# -----------------------------

@app.get("/api/work-crews")
def list_work_crews(_admin=Depends(require_admin)):
    from .db import engine
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, name, code, parent_id, is_active, sort_order, created_at, updated_at
            FROM work_crews
            ORDER BY COALESCE(parent_id, id), parent_id IS NOT NULL, sort_order, id
        """)).mappings().all()
    return [dict(r) for r in rows]


@app.post("/api/work-crews")
def create_work_crew(req: WorkCrewCreateRequest, _admin=Depends(require_admin)):
    from .db import engine

    name = (req.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")

    code = (req.code or "").strip() or None
    parent_id = req.parent_id

    if parent_id is not None:
        with engine.connect() as conn:
            parent = conn.execute(text("""
                SELECT id FROM work_crews WHERE id = :id LIMIT 1
            """), {"id": parent_id}).first()
        if not parent:
            raise HTTPException(status_code=400, detail="Parent crew not found")

    try:
        with engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO work_crews (name, code, parent_id, is_active, sort_order)
                VALUES (:name, :code, :parent_id, :is_active, :sort_order)
            """), {
                "name": name,
                "code": code,
                "parent_id": parent_id,
                "is_active": 1 if req.is_active else 0,
                "sort_order": int(req.sort_order or 0),
            })
    except Exception:
        raise HTTPException(status_code=400, detail="Could not create work crew (code may already exist)")

    return {"ok": True}


@app.put("/api/work-crews/{crew_id}")
def update_work_crew(crew_id: int, req: WorkCrewUpdateRequest, _admin=Depends(require_admin)):
    from .db import engine

    updates = []
    params = {"id": crew_id}

    if req.name is not None:
        name = req.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name cannot be empty")
        updates.append("name = :name")
        params["name"] = name

    if "code" in req.__fields_set__:
        updates.append("code = :code")
        params["code"] = (req.code or "").strip() or None

    if req.sort_order is not None:
        updates.append("sort_order = :sort_order")
        params["sort_order"] = int(req.sort_order)

    if req.is_active is not None:
        updates.append("is_active = :is_active")
        params["is_active"] = 1 if req.is_active else 0

    # parent_id: allow clearing when client sends null
    if "parent_id" in req.__fields_set__:
        if req.parent_id is None:
            updates.append("parent_id = NULL")
        else:
            if int(req.parent_id) == int(crew_id):
                raise HTTPException(status_code=400, detail="Crew cannot be its own parent")

            with engine.connect() as conn:
                parent = conn.execute(text("""
                    SELECT id FROM work_crews WHERE id = :id LIMIT 1
                """), {"id": req.parent_id}).first()
            if not parent:
                raise HTTPException(status_code=400, detail="Parent crew not found")

            updates.append("parent_id = :parent_id")
            params["parent_id"] = req.parent_id

    if not updates:
        return {"ok": True, "updated": False}

    try:
        with engine.begin() as conn:
            result = conn.execute(text(f"""
                UPDATE work_crews
                SET {", ".join(updates)}
                WHERE id = :id
            """), params)
            if result.rowcount == 0:
                raise HTTPException(status_code=404, detail="Work crew not found")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Could not update work crew (code may already exist)")

    return {"ok": True, "updated": True}


@app.delete("/api/work-crews/{crew_id}")
def disable_work_crew(crew_id: int, _admin=Depends(require_admin)):
    """
    Disable a crew. Safer: block if it has active sub crews.
    """
    from .db import engine

    with engine.connect() as conn:
        child = conn.execute(text("""
            SELECT id FROM work_crews
            WHERE parent_id = :id AND is_active = 1
            LIMIT 1
        """), {"id": crew_id}).first()

    if child:
        raise HTTPException(status_code=400, detail="Cannot disable: crew has active sub crews")

    with engine.begin() as conn:
        result = conn.execute(text("""
            UPDATE work_crews
            SET is_active = 0
            WHERE id = :id
        """), {"id": crew_id})

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Work crew not found")

    return {"ok": True}
