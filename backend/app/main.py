from fastapi import FastAPI, Depends, HTTPException
from pydantic import BaseModel

from passlib.context import CryptContext

from .db import db_check
from sqlalchemy import text

import re
import uuid
from typing import Optional

import os
import json
import secrets
import hashlib

from . import mailer
from .auth import create_access_token, get_current_user, require_admin, require_capability
from .permissions import (
    valid_roles, filter_visible, permission_snapshot, ALL_CAPABILITIES,
    get_role_defaults, bump_roles_cache, BUILTIN_ROLE_META, ADMIN_ROLE,
)

# Protected system accounts: hidden from the Users page and immune to edit/disable,
# so an always-on admin login can't be accidentally changed or locked out.
# Override via env (comma-separated) if needed.
PROTECTED_ADMIN_EMAILS = {
    e.strip().lower()
    for e in os.getenv("PROTECTED_ADMIN_EMAILS", "admin@onpointinstallers.com").split(",")
    if e.strip()
}


def _is_protected_email(email) -> bool:
    return (email or "").strip().lower() in PROTECTED_ADMIN_EMAILS
from app.qbo.routes import router as qbo_router
from app.projects.routes import router as projects_router
from app.quoting.routes import router as quoting_router
from app.estimates.routes import router as estimates_router
from app.cashflow.routes import router as cashflow_router
from app.crew.routes import router as crew_router
from app.customers.routes import router as customers_router
from app.documents.routes import router as documents_router
from app.kickoff.routes import router as kickoff_router
from app.daily.routes import router as daily_router
from app.payments.routes import router as payments_router
from app.invoices.routes import router as invoices_router
from app.expenses.routes import router as expenses_router
from app.offers.routes import router as offers_router
from app.contacts.routes import router as contacts_router
from app.opportunities.routes import router as opportunities_router
from app.change_orders.routes import router as change_orders_router
from app.billing.routes import router as billing_router
from app.phases.routes import router as phases_router

app = FastAPI()
app.include_router(qbo_router)
app.include_router(projects_router)
app.include_router(quoting_router)
app.include_router(estimates_router)
app.include_router(cashflow_router)
app.include_router(crew_router)
app.include_router(customers_router)
app.include_router(documents_router)
app.include_router(kickoff_router)
app.include_router(daily_router)
app.include_router(payments_router)
app.include_router(invoices_router)
app.include_router(expenses_router)
app.include_router(offers_router)
app.include_router(contacts_router)
app.include_router(opportunities_router)
app.include_router(change_orders_router)
app.include_router(billing_router)
app.include_router(phases_router)

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")

def validate_hex_color(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    value = value.strip()
    if value == "":
        return None
    if not HEX_COLOR.match(value):
        raise HTTPException(status_code=400, detail="Invalid color (must be #RRGGBB)")
    return value

class LoginRequest(BaseModel):
    email: str
    password: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

class ForgotPasswordRequest(BaseModel):
    email: str

class ResetPasswordRequest(BaseModel):
    token: str
    password: str

class UserCreateRequest(BaseModel):
    email: str
    password: Optional[str] = None
    send_invite: bool = False
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    role: str = "user"
    is_active: bool = True
    project_manager_id: Optional[int] = None
    work_crew_id: Optional[int] = None

class UserUpdateRequest(BaseModel):
    email: Optional[str] = None
    password: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None
    project_manager_id: Optional[int] = None
    work_crew_id: Optional[int] = None

class PermissionOverrideItem(BaseModel):
    capability: str
    effect: str  # "allow" | "deny"

class PermissionsUpdateRequest(BaseModel):
    overrides: list[PermissionOverrideItem] = []

class RoleCreateRequest(BaseModel):
    name: str
    label: Optional[str] = None
    description: Optional[str] = None
    capabilities: list[str] = []

class RoleUpdateRequest(BaseModel):
    label: Optional[str] = None
    description: Optional[str] = None
    capabilities: Optional[list[str]] = None

class ProjectManagerCreateRequest(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    color: Optional[str] = None
    is_active: bool = True

class ProjectManagerUpdateRequest(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    color: Optional[str] = None
    is_active: Optional[bool] = None

class WorkCrewCreateRequest(BaseModel):
    name: str
    code: Optional[str] = None
    parent_id: Optional[int] = None
    color: Optional[str] = None
    is_active: bool = True
    sort_order: int = 0

class WorkCrewUpdateRequest(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    parent_id: Optional[int] = None
    color: Optional[str] = None
    is_active: Optional[bool] = None
    sort_order: Optional[int] = None
    vendor_qbo_id: Optional[str] = None   # QBO vendor for crew-earnings (parent crews)


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


@app.post("/api/me/password")
def change_my_password(req: ChangePasswordRequest, user=Depends(get_current_user)):
    """Self-service password change: verify the caller's current password, set a new one."""
    new_pw = (req.new_password or "")
    if len(new_pw) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters.")
    if req.current_password == new_pw:
        raise HTTPException(status_code=400, detail="New password must be different from the current one.")

    from .db import engine
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT password_hash FROM users WHERE id = :id LIMIT 1"),
            {"id": user["id"]},
        ).mappings().first()
    if not row or not pwd_context.verify(req.current_password, row["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")

    with engine.begin() as conn:
        conn.execute(
            text("UPDATE users SET password_hash = :h WHERE id = :id"),
            {"h": pwd_context.hash(new_pw), "id": user["id"]},
        )
    return {"ok": True}


# --- Password policy + one-time tokens (invites / resets) --------------------
def validate_password(pw: str):
    """Enforce the password policy (env-configurable). Raises 400 if it fails."""
    pw = pw or ""
    min_len = int(os.getenv("PASSWORD_MIN_LENGTH", "8"))
    if len(pw) < min_len:
        raise HTTPException(status_code=400, detail=f"Password must be at least {min_len} characters.")
    if os.getenv("PASSWORD_REQUIRE_COMPLEXITY", "false").lower() == "true":
        if not (re.search(r"[A-Za-z]", pw) and re.search(r"\d", pw)):
            raise HTTPException(status_code=400, detail="Password must include at least one letter and one number.")


def _hash_token(raw: str) -> str:
    return hashlib.sha256((raw or "").encode("utf-8")).hexdigest()


def _issue_auth_token(user_id: int, purpose: str, hours: int) -> str:
    """Create a one-time token, store only its hash, return the raw token."""
    from .db import engine
    raw = secrets.token_urlsafe(32)
    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO user_auth_tokens (user_id, token_hash, purpose, expires_at)
            VALUES (:uid, :h, :p, DATE_ADD(NOW(), INTERVAL :hrs HOUR))
        """), {"uid": user_id, "h": _hash_token(raw), "p": purpose, "hrs": hours})
    return raw


def _token_link(raw: str) -> str:
    return f"{mailer.app_base_url()}/#/set-password?token={raw}"


def _lookup_token(raw: str):
    """Return the valid (unused, unexpired) token row + user email, or None."""
    if not raw:
        return None
    from .db import engine
    with engine.connect() as conn:
        return conn.execute(text("""
            SELECT t.id, t.user_id, t.purpose, u.email
            FROM user_auth_tokens t JOIN users u ON u.id = t.user_id
            WHERE t.token_hash = :h AND t.used_at IS NULL AND t.expires_at > NOW() AND u.is_active = 1
            LIMIT 1
        """), {"h": _hash_token(raw)}).mappings().first()


def record_audit(actor, action, target_type=None, target_id=None, target_label=None, detail=None):
    """Best-effort audit trail. Auditing must never break the action it records."""
    try:
        from .db import engine
        with engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO audit_log (actor_user_id, actor_email, action, target_type, target_id, target_label, detail)
                VALUES (:aid, :aem, :act, :tt, :tid, :tl, :det)
            """), {
                "aid": (actor or {}).get("id"),
                "aem": (actor or {}).get("email"),
                "act": action,
                "tt": target_type,
                "tid": None if target_id is None else str(target_id),
                "tl": target_label,
                "det": json.dumps(detail) if detail is not None else None,
            })
    except Exception:
        pass


@app.get("/api/audit-log")
def audit_log(limit: int = 200, _admin=Depends(require_admin)):
    """Recent user/role/permission administration events (admins only)."""
    from .db import engine
    limit = max(1, min(int(limit or 200), 1000))
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, actor_email, action, target_type, target_id, target_label, detail, created_at
            FROM audit_log ORDER BY id DESC LIMIT :lim
        """), {"lim": limit}).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        if d.get("detail"):
            try: d["detail"] = json.loads(d["detail"])
            except Exception: pass
        out.append(d)
    return out


@app.get("/api/crew-hub")
def crew_hub(_u=Depends(require_capability("page.assignment"))):
    """Office crew-operations hub: upcoming/overdue crew payments + a total, and the
    active projects that still have no crew assigned (with any offer's status)."""
    from .db import engine
    from datetime import date
    today = date.today()
    with engine.connect() as conn:
        # 1) Actual crew cash PAID per project = Contract-Labor bill lines tagged to it
        #    (the same signal the Billing tab burns down against — reliable even when
        #    the installment 'status' field was never marked paid).
        paid_by = {str(r[0]): float(r[1] or 0) for r in conn.execute(text("""
            SELECT l.line_customer_qbo_id, ROUND(SUM(l.amount), 2)
            FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
            WHERE t.entity_type = 'Bill' AND l.line_customer_qbo_id IS NOT NULL
              AND JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')) = 'Contract Labor'
            GROUP BY l.line_customer_qbo_id
        """)).all()}
        # All per-crew installments (non-rollup), ordered so we can burn down by date.
        inst = conn.execute(text("""
            SELECT s.entity_id, i.pay_date, i.amount,
                   wc.name AS crew_name, pc.name AS crew_company, qc.display_name AS project
            FROM project_payment_installments i
            JOIN project_payment_schedules s ON s.id = i.schedule_id
            LEFT JOIN work_crews wc ON wc.id = s.crew_id
            LEFT JOIN work_crews pc ON pc.id = wc.parent_id
            LEFT JOIN qbo_customers qc ON qc.qbo_id = s.entity_id
            WHERE s.is_rollup = 0
            ORDER BY s.entity_id, i.pay_date, i.id
        """)).mappings().all()
        # Assignment schedule window per project (earliest start .. latest end).
        win_by = {}
        for r in conn.execute(text("""
            SELECT qc.qbo_id, MIN(psi.start_date) AS s, MAX(psi.end_date) AS e
            FROM project_schedule_items psi JOIN projects p ON p.id = psi.project_id
            JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
            GROUP BY qc.qbo_id
        """)).mappings().all():
            win_by[str(r["qbo_id"])] = {"start": str(r["s"]) if r["s"] else None,
                                        "end": str(r["e"]) if r["e"] else None}

        # 2) Canonical latest status per project (final assignment row).
        status_by = {str(r["qbo_id"]): r["status"] for r in conn.execute(text("""
            SELECT qc.qbo_id, x.status FROM (
              SELECT p.qbo_customer_id, psi.status,
                     ROW_NUMBER() OVER (PARTITION BY p.qbo_customer_id
                       ORDER BY (psi.start_date IS NULL), psi.start_date DESC, psi.sort_order DESC, psi.id DESC) rn
              FROM project_schedule_items psi JOIN projects p ON p.id = psi.project_id
            ) x JOIN qbo_customers qc ON qc.id = x.qbo_customer_id WHERE x.rn = 1
        """)).mappings().all()}
        crewed = {str(r[0]) for r in conn.execute(text("""
            SELECT DISTINCT qc.qbo_id
            FROM project_schedule_item_work_crews swc
            JOIN project_schedule_items psi ON psi.id = swc.schedule_item_id
            JOIN projects p ON p.id = psi.project_id
            JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
            WHERE swc.unassigned_at IS NULL
        """)).all()}
        projects = conn.execute(text("""
            SELECT qc.qbo_id, qc.display_name
            FROM projects p JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
            WHERE qc.is_project = 1
        """)).mappings().all()
        offer_by = {str(r["entity_id"]): r for r in conn.execute(text("""
            SELECT o.entity_id, o.status, o.sent_at,
                   TRIM(CONCAT(COALESCE(wc.name,''), CASE WHEN pc.name IS NOT NULL THEN CONCAT(' (',pc.name,')') ELSE '' END)) AS crew_name
            FROM work_offers o
            LEFT JOIN work_crews wc ON wc.id = o.crew_id
            LEFT JOIN work_crews pc ON pc.id = wc.parent_id
            JOIN (SELECT entity_id, MAX(id) mid FROM work_offers GROUP BY entity_id) latest
              ON latest.entity_id = o.entity_id AND latest.mid = o.id
        """)).mappings().all()}

    # Burn each project's crew installments down against what was ACTUALLY paid to its
    # crews (earliest dates fill first); only the unpaid remainder is still "owed".
    from collections import defaultdict
    EPS = 0.5
    by_proj = defaultdict(list)
    for r in inst:
        by_proj[str(r["entity_id"])].append(r)
    upcoming, overdue = [], []
    for eid, rows in by_proj.items():
        cum = 0.0
        paid = paid_by.get(eid, 0.0)
        for r in rows:
            amt = float(r["amount"] or 0)
            covered = min(amt, max(0.0, paid - cum))
            cum += amt
            owed = round(amt - covered, 2)
            if owed <= EPS:
                continue  # fully covered by actual crew payments
            pd = r["pay_date"]
            item = {"pay_date": str(pd) if pd else None, "amount": owed, "entity_id": eid,
                    "project": r["project"] or "(unknown project)",
                    "crew": (r["crew_name"] or "").strip() or "(crew TBD)", "company": r["crew_company"],
                    "status": "partial" if covered > EPS else "scheduled",
                    "schedule": win_by.get(eid)}
            (overdue if (pd and pd < today) else upcoming).append(item)
    upcoming.sort(key=lambda x: x["pay_date"] or "9999")
    overdue.sort(key=lambda x: x["pay_date"] or "9999")

    ACTIVE = {"needs_attention", "pending", "not_started", "in_progress"}
    needs_crew = []
    for p in projects:
        qid = str(p["qbo_id"])
        if qid in crewed:
            continue
        st = status_by.get(qid, "needs_attention")
        if st not in ACTIVE:
            continue
        off = offer_by.get(qid)
        needs_crew.append({
            "entity_id": qid, "project": p["display_name"] or "(unnamed)", "status": st,
            "schedule": win_by.get(qid),
            "offer": None if not off else {
                "status": off["status"], "sent_at": str(off["sent_at"]) if off["sent_at"] else None,
                "crew": (off["crew_name"] or "").strip() or None},
        })
    needs_crew.sort(key=lambda x: (x["offer"] is not None, x["project"].lower()))

    return {
        "today": today.isoformat(),
        "upcoming": upcoming, "upcoming_total": round(sum(x["amount"] for x in upcoming), 2),
        "overdue": overdue, "overdue_total": round(sum(x["amount"] for x in overdue), 2),
        "needs_crew": needs_crew, "needs_crew_count": len(needs_crew),
    }


@app.get("/api/config")
def public_config():
    """Public: flags the frontend needs before login (e.g. whether email is enabled)."""
    return {"email_enabled": mailer.is_configured()}


@app.post("/api/auth/forgot-password")
def forgot_password(req: ForgotPasswordRequest):
    """Public: email a reset link if the account exists. Always returns ok (no user enumeration)."""
    email = (req.email or "").strip().lower()
    user = get_user_by_email(email) if email else None
    if user and int(user["is_active"]) == 1:
        raw = _issue_auth_token(user["id"], "reset", hours=1)
        mailer.send_reset_email(user["email"], _token_link(raw))
    return {"ok": True}


@app.get("/api/auth/token-info")
def token_info(token: str = ""):
    """Public: validate a set-password/reset token so the page can greet the user."""
    row = _lookup_token(token)
    if not row:
        return {"valid": False}
    return {"valid": True, "email": row["email"], "purpose": row["purpose"]}


@app.post("/api/auth/reset-password")
def reset_password(req: ResetPasswordRequest):
    """Public: set a new password using an invite or reset token, then consume it (and any siblings)."""
    row = _lookup_token(req.token)
    if not row:
        raise HTTPException(status_code=400, detail="This link is invalid or has expired. Please request a new one.")
    validate_password(req.password)
    from .db import engine
    with engine.begin() as conn:
        conn.execute(text("UPDATE users SET password_hash = :h WHERE id = :id"),
                     {"h": pwd_context.hash(req.password), "id": row["user_id"]})
        conn.execute(text("UPDATE user_auth_tokens SET used_at = NOW() WHERE user_id = :uid AND used_at IS NULL"),
                     {"uid": row["user_id"]})
    return {"ok": True}


@app.post("/api/users/{user_id}/resend-invite")
def resend_invite(user_id: int, _admin=Depends(require_admin)):
    """Admin: (re)send a set-password invite email to a user."""
    from .db import engine
    with engine.connect() as conn:
        u = conn.execute(text("SELECT id, email, first_name FROM users WHERE id = :id LIMIT 1"),
                         {"id": user_id}).mappings().first()
    if not u:
        raise HTTPException(status_code=404, detail="User not found")
    raw = _issue_auth_token(u["id"], "invite", hours=24 * 7)
    link = _token_link(raw)
    sent = mailer.send_invite_email(u["email"], link, u.get("first_name"))
    record_audit(_admin, "user.invite", "user", user_id, u["email"])
    return {"ok": True, "sent": bool(sent), "link": (None if sent else link), "email": u["email"]}


@app.get("/api/me")
def me(user=Depends(get_current_user)):
    # Expose role, links and capabilities so the frontend can hide nav/buttons.
    # (Security is still enforced server-side; this is UX only.)
    return {
        "user": {
            "id": user["id"],
            "email": user["email"],
            "role": user["role"],
            "project_manager_id": user.get("project_manager_id"),
            "work_crew_id": user.get("work_crew_id"),
            "capabilities": sorted(user.get("capabilities") or []),
        }
    }


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

        SUM(CASE
              WHEN t.entity_type='Purchase'
                   AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.Credit')) = 'true'
                THEN -COALESCE(lt.line_amt,0)
              WHEN t.entity_type='Purchase' THEN COALESCE(lt.line_amt,0)
              ELSE 0
            END) AS expense_amt,
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

    # Scope to the projects this user may see (admin/office see all).
    projects = filter_visible(projects, user, key="qbo_customer_id")

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
                   project_manager_id, work_crew_id,
                   created_at, updated_at, last_login_at
            FROM users
            ORDER BY id DESC
        """)).mappings().all()
    # Hide protected system accounts so they can't be accidentally edited/disabled.
    return [dict(r) for r in rows if not _is_protected_email(r["email"])]


@app.get("/api/users/{user_id}/permissions")
def get_user_permissions(user_id: int, _admin=Depends(require_admin)):
    """Role defaults, this user's overrides, and the resulting effective set."""
    from .db import engine
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT id, role FROM users WHERE id = :id LIMIT 1"),
            {"id": user_id},
        ).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="User not found")
    return permission_snapshot(row["id"], row["role"])


@app.put("/api/users/{user_id}/permissions")
def set_user_permissions(user_id: int, req: PermissionsUpdateRequest, _admin=Depends(require_admin)):
    """Replace this user's permission overrides with the supplied list."""
    valid_caps = set(ALL_CAPABILITIES)
    cleaned = []
    for item in req.overrides:
        cap = (item.capability or "").strip()
        effect = (item.effect or "").strip().lower()
        if cap not in valid_caps:
            raise HTTPException(status_code=400, detail=f"Unknown capability: {cap}")
        if effect not in ("allow", "deny"):
            raise HTTPException(status_code=400, detail="effect must be 'allow' or 'deny'")
        cleaned.append({"cap": cap, "effect": effect})

    from .db import engine
    with engine.begin() as conn:
        exists = conn.execute(
            text("SELECT id, email FROM users WHERE id = :id LIMIT 1"), {"id": user_id}
        ).mappings().first()
        if not exists:
            raise HTTPException(status_code=404, detail="User not found")
        if _is_protected_email(exists["email"]):
            raise HTTPException(status_code=403, detail="This account is protected and cannot be modified.")

        conn.execute(
            text("DELETE FROM user_permission_overrides WHERE user_id = :uid"),
            {"uid": user_id},
        )
        for c in cleaned:
            conn.execute(text("""
                INSERT INTO user_permission_overrides (user_id, capability, effect)
                VALUES (:uid, :cap, :effect)
            """), {"uid": user_id, "cap": c["cap"], "effect": c["effect"]})

    record_audit(_admin, "perms.update", "user", user_id, exists["email"], {"overrides": len(cleaned)})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Roles management (Settings page) — roles + their default capabilities live in
# the DB so an admin can create/edit them. Capabilities themselves stay code-
# defined (each maps to real enforcement). The admin role is locked.
# ---------------------------------------------------------------------------
def _validate_caps(caps):
    valid = set(ALL_CAPABILITIES)
    cleaned = []
    for c in caps or []:
        c = (c or "").strip()
        if c not in valid:
            raise HTTPException(status_code=400, detail=f"Unknown capability: {c}")
        if c not in cleaned:
            cleaned.append(c)
    return cleaned


@app.get("/api/roles")
def list_roles(_admin=Depends(require_admin)):
    from .db import engine
    defaults = get_role_defaults()  # ensures tables are seeded
    with engine.connect() as conn:
        roles = conn.execute(text(
            "SELECT id, name, label, description, is_system FROM roles ORDER BY is_system DESC, name"
        )).mappings().all()
        counts = conn.execute(text("SELECT role, COUNT(*) n FROM users GROUP BY role")).mappings().all()
    count_map = {c["role"]: int(c["n"]) for c in counts}
    out = [{
        "id": r["id"], "name": r["name"], "label": r["label"], "description": r["description"],
        "is_system": bool(r["is_system"]),
        "is_admin": r["name"] == ADMIN_ROLE,
        "user_count": count_map.get(r["name"], 0),
        "capabilities": sorted(defaults.get(r["name"], set())),
    } for r in roles]
    return {"roles": out, "all_capabilities": ALL_CAPABILITIES}


@app.post("/api/roles")
def create_role(req: RoleCreateRequest, _admin=Depends(require_admin)):
    from .db import engine
    import re as _re
    name = (req.name or "").strip().lower()
    if not _re.fullmatch(r"[a-z][a-z0-9_]{1,39}", name):
        raise HTTPException(status_code=400, detail="Name must be lowercase letters/digits/underscores and start with a letter.")
    if name == ADMIN_ROLE:
        raise HTTPException(status_code=400, detail="Reserved role name.")
    caps = _validate_caps(req.capabilities)
    try:
        with engine.begin() as conn:
            if conn.execute(text("SELECT 1 FROM roles WHERE name=:n"), {"n": name}).first():
                raise HTTPException(status_code=400, detail="A role with that name already exists.")
            conn.execute(text("INSERT INTO roles (name, label, description, is_system) VALUES (:n,:l,:d,0)"),
                         {"n": name, "l": req.label or None, "d": req.description or None})
            rid = conn.execute(text("SELECT id FROM roles WHERE name=:n"), {"n": name}).scalar()
            for c in caps:
                conn.execute(text("INSERT IGNORE INTO role_capabilities (role_id, capability) VALUES (:r,:c)"), {"r": rid, "c": c})
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="Could not create role.")
    record_audit(_admin, "role.create", "role", rid, name, {"capabilities": len(caps)})
    bump_roles_cache()
    return {"ok": True}


@app.put("/api/roles/{role_id}")
def update_role(role_id: int, req: RoleUpdateRequest, _admin=Depends(require_admin)):
    from .db import engine
    with engine.connect() as conn:
        role = conn.execute(text("SELECT id, name FROM roles WHERE id=:id"), {"id": role_id}).mappings().first()
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    if role["name"] == ADMIN_ROLE:
        raise HTTPException(status_code=400, detail="The admin role is locked and cannot be changed.")
    with engine.begin() as conn:
        sets, params = [], {"id": role_id}
        if "label" in req.__fields_set__:
            sets.append("label=:label"); params["label"] = req.label or None
        if "description" in req.__fields_set__:
            sets.append("description=:description"); params["description"] = req.description or None
        if sets:
            conn.execute(text(f"UPDATE roles SET {', '.join(sets)} WHERE id=:id"), params)
        if req.capabilities is not None:
            caps = _validate_caps(req.capabilities)
            conn.execute(text("DELETE FROM role_capabilities WHERE role_id=:id"), {"id": role_id})
            for c in caps:
                conn.execute(text("INSERT IGNORE INTO role_capabilities (role_id, capability) VALUES (:r,:c)"), {"r": role_id, "c": c})
    record_audit(_admin, "role.update", "role", role_id, role["name"])
    bump_roles_cache()
    return {"ok": True}


@app.delete("/api/roles/{role_id}")
def delete_role(role_id: int, _admin=Depends(require_admin)):
    from .db import engine
    with engine.connect() as conn:
        role = conn.execute(text("SELECT id, name, is_system FROM roles WHERE id=:id"), {"id": role_id}).mappings().first()
        if not role:
            raise HTTPException(status_code=404, detail="Role not found")
        if role["is_system"] or role["name"] == ADMIN_ROLE:
            raise HTTPException(status_code=400, detail="Built-in roles cannot be deleted.")
        n = conn.execute(text("SELECT COUNT(*) FROM users WHERE role=:n"), {"n": role["name"]}).scalar()
        if n and int(n) > 0:
            raise HTTPException(status_code=400, detail=f"{int(n)} user(s) still have this role. Reassign them first.")
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM roles WHERE id=:id"), {"id": role_id})
    record_audit(_admin, "role.delete", "role", role_id, role["name"])
    bump_roles_cache()
    return {"ok": True}


@app.post("/api/users")
def create_user(req: UserCreateRequest, _admin=Depends(require_admin)):
    from .db import engine

    email = req.email.strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Email required")

    role = (req.role or "user").strip().lower()
    if role not in valid_roles():
        raise HTTPException(status_code=400, detail="Invalid role")

    has_pw = bool(req.password and req.password.strip())
    if has_pw:
        validate_password(req.password)
        password_hash = pwd_context.hash(req.password)
    else:
        # Unusable placeholder — the account can't be logged into until the user
        # sets a password via the invite link below.
        password_hash = pwd_context.hash(secrets.token_urlsafe(24))
    want_invite = bool(req.send_invite) or not has_pw

    user_uuid = str(uuid.uuid4())

    first_name = (req.first_name or "").strip() or None
    last_name = (req.last_name or "").strip() or None

    new_id = None
    try:
        with engine.begin() as conn:
            res = conn.execute(text("""
                INSERT INTO users (uuid, email, first_name, last_name, password_hash, role, is_active,
                                   project_manager_id, work_crew_id)
                VALUES (:uuid, :email, :first_name, :last_name, :password_hash, :role, :is_active,
                        :project_manager_id, :work_crew_id)
            """), {
                "uuid": user_uuid,
                "email": email,
                "first_name": first_name,
                "last_name": last_name,
                "password_hash": password_hash,
                "role": role,
                "is_active": 1 if req.is_active else 0,
                "project_manager_id": req.project_manager_id,
                "work_crew_id": req.work_crew_id,
            })
            new_id = res.lastrowid
    except Exception:
        raise HTTPException(status_code=400, detail="Could not create user (email may already exist)")

    invite_sent = None
    invite_link = None
    if want_invite and new_id:
        raw = _issue_auth_token(int(new_id), "invite", hours=24 * 7)
        link = _token_link(raw)
        invite_sent = mailer.send_invite_email(email, link, first_name)
        if not invite_sent:
            invite_link = link  # email off / failed — hand the link to the admin to share

    record_audit(_admin, "user.create", "user", new_id, email, {"role": role, "invited": bool(want_invite)})
    return {"ok": True, "invited": bool(want_invite), "invite_sent": bool(invite_sent), "invite_link": invite_link}


@app.put("/api/users/{user_id}")
def update_user(user_id: int, req: UserUpdateRequest, _admin=Depends(require_admin)):
    from .db import engine

    with engine.connect() as conn:
        target = conn.execute(text("SELECT email FROM users WHERE id = :id"), {"id": user_id}).first()
    if target and _is_protected_email(target[0]):
        raise HTTPException(status_code=403, detail="This account is protected and cannot be modified.")

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
        if role not in valid_roles():
            raise HTTPException(status_code=400, detail="Invalid role")
        updates.append("role = :role")
        params["role"] = role

    if req.is_active is not None:
        updates.append("is_active = :is_active")
        params["is_active"] = 1 if req.is_active else 0

    # Resource links (nullable): allow setting or clearing via explicit null.
    if "project_manager_id" in req.__fields_set__:
        updates.append("project_manager_id = :project_manager_id")
        params["project_manager_id"] = req.project_manager_id

    if "work_crew_id" in req.__fields_set__:
        updates.append("work_crew_id = :work_crew_id")
        params["work_crew_id"] = req.work_crew_id

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

    changed = [f for f in ("email", "first_name", "last_name", "role", "is_active",
                           "project_manager_id", "work_crew_id", "password")
               if f in req.__fields_set__ and (f != "password" or (req.password and str(req.password).strip()))]
    record_audit(_admin, "user.update", "user", user_id, (target[0] if target else None), {"fields": changed})
    return {"ok": True, "updated": True}


@app.delete("/api/users/{user_id}")
def disable_user(user_id: int, _admin=Depends(require_admin)):
    """
    Safer than hard delete: disable the user
    """
    from .db import engine

    with engine.connect() as conn:
        target = conn.execute(text("SELECT email FROM users WHERE id = :id"), {"id": user_id}).first()
    if target and _is_protected_email(target[0]):
        raise HTTPException(status_code=403, detail="This account is protected and cannot be disabled.")

    with engine.begin() as conn:
        result = conn.execute(text("""
            UPDATE users
            SET is_active = 0
            WHERE id = :id
        """), {"id": user_id})

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="User not found")

    record_audit(_admin, "user.disable", "user", user_id, (target[0] if target else None))
    return {"ok": True}

# -----------------------------
# Project Managers
# -----------------------------

@app.get("/api/project-managers")
def list_project_managers(_admin=Depends(require_admin)):
    from .db import engine
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, first_name, last_name, email, phone, color, is_active, created_at, updated_at
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
    color = validate_hex_color(req.color)
    
    try:
        with engine.begin() as conn:
            conn.execute(text("""
                INSERT INTO project_managers (first_name, last_name, email, phone, color, is_active)
                VALUES (:first_name, :last_name, :email, :phone, :color, :is_active)
            """), {
                "first_name": first_name,
                "last_name": last_name,
                "email": email,
                "phone": phone,
                "color": color,
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
    
    if "color" in req.__fields_set__:
        updates.append("color = :color")
        params["color"] = validate_hex_color(req.color)

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
            SELECT id, name, code, parent_id, color, is_active, sort_order,
                   vendor_qbo_id, created_at, updated_at
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
    color = validate_hex_color(req.color)

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
                INSERT INTO work_crews (name, code, parent_id, color, is_active, sort_order)
                VALUES (:name, :code, :parent_id, :color, :is_active, :sort_order)
            """), {
                "name": name,
                "code": code,
                "parent_id": parent_id,
                "color": color,
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
    
    if "color" in req.__fields_set__:
        updates.append("color = :color")
        params["color"] = validate_hex_color(req.color)

    if req.sort_order is not None:
        updates.append("sort_order = :sort_order")
        params["sort_order"] = int(req.sort_order)

    if req.is_active is not None:
        updates.append("is_active = :is_active")
        params["is_active"] = 1 if req.is_active else 0

    # vendor_qbo_id: link/clear the QBO vendor used for crew earnings
    if "vendor_qbo_id" in req.__fields_set__:
        updates.append("vendor_qbo_id = :vendor_qbo_id")
        params["vendor_qbo_id"] = (req.vendor_qbo_id or "").strip() or None

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
