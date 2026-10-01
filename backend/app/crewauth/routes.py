"""
Crew passcode auth (PM Portal Phase 2).

Field devices don't get user accounts (Leo's preference): each crew lead gets a
4-6 digit passcode, plus a per-COMPANY "boss" code pointing at the PARENT crew
row (Crew Model v2 CR2 — the old global crew_id-NULL master code is RETIRED:
migration 0057 deactivates any such row and login no longer accepts them).
Codes are set/rotated by the office on Teams -> Work Crews (page.teams) and
stored pbkdf2-hashed (same scheme as user passwords). A
successful login returns a 30-day JWT (same jose secret as user tokens but with
a distinct {"crew_session": true} claim, so neither token kind works on the
other's endpoints — crew tokens carry no "sub" email, user tokens carry no
crew_session flag).

get_crew_session / get_user_or_crew are the dependencies crew-facing endpoints
(app/forms) use.
"""
import re
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from jose import jwt, JWTError
from passlib.context import CryptContext
from pydantic import BaseModel
from sqlalchemy import text

from app.db import engine
from app.audit import record_audit
from app.auth import get_current_user, JWT_SECRET, JWT_ALG
from app.permissions import has_capability, PAGE_TEAMS, PAGE_PM_PORTAL

router = APIRouter(prefix="/api/crew-auth", tags=["crew-auth"])

# Same scheme as the user pwd_context in main.py (defined here to avoid a
# circular import — main.py imports this router).
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

CREW_TOKEN_DAYS = 30          # low-friction field devices: device remembers
CODE_RE = re.compile(r"^\d{4,6}$")


# ── session dependencies ────────────────────────────────────────────────────
def _decode(authorization: str):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid/expired token")


def _crew_actor(payload):
    """Build the crew actor dict from a crew_session token, re-checking that the
    passcode is still active (a rotated/deactivated code kills its sessions)."""
    pid = payload.get("pid")
    with engine.connect() as conn:
        row = conn.execute(text("""
            SELECT cp.id, cp.crew_id, cp.role, cp.label, cp.active, wc.name AS crew_name
            FROM crew_passcodes cp LEFT JOIN work_crews wc ON wc.id = cp.crew_id
            WHERE cp.id = :id
        """), {"id": pid}).mappings().first()
    # crew_id IS NULL = the retired global master code (CR2): always dead,
    # even if a row somehow stayed active.
    if not row or int(row["active"]) != 1 or row["crew_id"] is None:
        raise HTTPException(status_code=401, detail="Invalid/expired token")
    return {
        "kind": "crew",
        "passcode_id": row["id"],
        "crew_id": row["crew_id"],
        "crew_name": row["crew_name"],
        "role": row["role"],
        "label": row["label"],
    }


def get_crew_session(authorization: str = Header(default="")):
    """Crew-only endpoints: require a crew_session token."""
    payload = _decode(authorization)
    if not payload.get("crew_session"):
        raise HTTPException(status_code=401, detail="Crew session required")
    return _crew_actor(payload)


def get_user_or_crew(authorization: str = Header(default="")):
    """Crew-facing endpoints the office can also hit: accepts EITHER a normal
    logged-in user token OR a crew passcode session. Returns
    {"kind": "crew", ...} or {"kind": "user", "user": <get_current_user dict>}."""
    payload = _decode(authorization)
    if payload.get("crew_session"):
        return _crew_actor(payload)
    return {"kind": "user", "user": get_current_user(authorization)}


def actor_for_audit(actor):
    """Map a user-or-crew actor onto record_audit's {id, email} shape without
    ever logging a passcode."""
    if actor.get("kind") == "user":
        u = actor["user"]
        return {"id": u.get("id"), "email": u.get("email")}
    return {"id": None, "email": f"crew:{actor.get('label') or actor.get('crew_name') or 'unknown'}"}


# ── crew project scoping (Crew Portal design 2026-09-22, Crew Model v2 CR2) ─
# One passcode = all of that crew's ASSIGNED projects; a company BOSS code
# (crew_id = PARENT crew, role 'boss') = every project of that company,
# lead-less lines included. Enforced server-side on every crew-token path
# (forms templates/submit/upload + the crew-portal endpoints). Past projects
# (completed/canceled) are READ-ONLY.
CREW_PAST_STATUSES = ("completed", "canceled")


def crew_scope_clause(conn, actor, alias="swc"):
    """(sql_clause, params) restricting assignment rows to this crew actor —
    the ONE place crew-portal project scoping is defined (Crew Model v2 CR1).

      * passcode pointing at a PARENT crew (a company — the CR2 "boss code"):
        the company-wide set, INCLUDING lead-less assignments — company_id =
        parent, plus the legacy work_crew_id chain (the parent itself or any
        of its children) for rows that pre-date the v2 columns.
      * lead (child crew) code: rows where they are the lead —
        lead_crew_id = them OR legacy work_crew_id = them.
      * crew_id NULL (the retired global master): matches nothing. Login and
        _crew_actor already reject these; this is defense in depth.
    """
    if actor.get("crew_id") is None:
        return " AND 1 = 0", {}   # retired global master code (CR2)
    crew_id = int(actor.get("crew_id"))
    is_parent = conn.execute(text(
        "SELECT parent_id IS NULL FROM work_crews WHERE id = :c"
    ), {"c": crew_id}).scalar()
    if is_parent:
        return (f" AND ({alias}.company_id = :crew OR {alias}.work_crew_id = :crew"
                f" OR {alias}.work_crew_id IN"
                f" (SELECT id FROM work_crews WHERE parent_id = :crew))",
                {"crew": crew_id})
    return (f" AND ({alias}.lead_crew_id = :crew OR {alias}.work_crew_id = :crew)",
            {"crew": crew_id})


def crew_project_ids(conn, actor):
    """QBO project ids actively assigned to this crew actor via the assignment
    chain (project_schedule_item_work_crews, unassigned_at IS NULL — the same
    chain pm/routes.py joins). Scope rules: see crew_scope_clause."""
    crew_clause, params = crew_scope_clause(conn, actor)
    rows = conn.execute(text(f"""
        SELECT DISTINCT qc.qbo_id
        FROM projects p
        JOIN project_schedule_items psi ON psi.project_id = p.id
        JOIN project_schedule_item_work_crews swc ON swc.schedule_item_id = psi.id
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        WHERE swc.unassigned_at IS NULL{crew_clause}
    """), params).scalars().all()
    return {str(r) for r in rows}


def require_crew_project(conn, actor, project_qbo_id, write=False):
    """Server-side crew scoping. No-op for user actors (office/PM tokens keep
    their own gates). For crew actors: 403 unless the project is assigned to
    their crew; with write=True a past project (completed/canceled — the
    canonical final-assignment-row status) also 403s: past = read-only."""
    if actor.get("kind") != "crew":
        return
    if str(project_qbo_id) not in crew_project_ids(conn, actor):
        raise HTTPException(status_code=403, detail="Not assigned to this project")
    if write:
        from app.projects.routes import _latest_status  # local: avoid cycles
        if (_latest_status(conn, project_qbo_id) or "").lower() in CREW_PAST_STATUSES:
            raise HTTPException(
                status_code=403,
                detail="This project is completed — forms are view-only")


# ── crew login ──────────────────────────────────────────────────────────────
class CrewLoginRequest(BaseModel):
    code: str


@router.post("/login")
def crew_login(req: CrewLoginRequest):
    """Verify a 4-6 digit passcode against all active rows; issue a 30-day
    crew_session JWT. Returns the crew (null for the boss master code) + role."""
    code = (req.code or "").strip()
    if not CODE_RE.fullmatch(code):
        raise HTTPException(status_code=401, detail="Invalid code")

    # crew_id IS NOT NULL: the global master code is retired (CR2) — a
    # NULL-crew row is dead even if still flagged active.
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT cp.id, cp.crew_id, cp.role, cp.label, cp.code_hash, wc.name AS crew_name
            FROM crew_passcodes cp JOIN work_crews wc ON wc.id = cp.crew_id
            WHERE cp.active = 1
            ORDER BY cp.id
        """)).mappings().all()

    match = None
    for r in rows:
        try:
            if pwd_context.verify(code, r["code_hash"]):
                match = r
                break
        except Exception:
            continue
    if not match:
        record_audit(None, "crew.login_failed", "crew_passcode", None, None,
                     {"why": "no active passcode matched"})
        raise HTTPException(status_code=401, detail="Invalid code")

    with engine.begin() as conn:
        conn.execute(text("UPDATE crew_passcodes SET last_used_at = NOW() WHERE id = :id"),
                     {"id": match["id"]})

    payload = {
        "crew_session": True,
        "pid": match["id"],
        "crew_id": match["crew_id"],
        "crew_role": match["role"],
        "label": match["label"],
        "exp": datetime.utcnow() + timedelta(days=CREW_TOKEN_DAYS),
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)
    record_audit({"id": None, "email": f"crew:{match['label']}"}, "crew.login",
                 "crew_passcode", match["id"], match["label"],
                 {"crew_id": match["crew_id"], "role": match["role"]})
    return {
        "token": token,
        "crew": ({"id": match["crew_id"], "name": match["crew_name"]}
                 if match["crew_id"] is not None else None),
        "role": match["role"],
        "label": match["label"],
    }


@router.get("/session")
def crew_session_info(sess=Depends(get_crew_session)):
    """Lets a remembered device confirm its token still works."""
    return {"crew": ({"id": sess["crew_id"], "name": sess["crew_name"]}
                     if sess["crew_id"] is not None else None),
            "role": sess["role"], "label": sess["label"]}


# ── office + PM passcode management ─────────────────────────────────────────
# Codes are managed from Teams -> Work Crews (page.teams, office) AND from the
# PM portal's per-project Crew tab (page.pm_portal, Crew Portal step 3). A
# non-admin pm_portal-only user may ONLY manage codes for crews assigned to one
# of THEIR projects (users.project_manager_id -> the same assignment chain
# pm/routes.py scopes by) — lead codes AND, since CR2, the per-company BOSS
# code of those crews' parent companies; admins and page.teams holders are
# unrestricted. Audited exactly as before — the code itself is never logged.
def get_passcode_manager(user=Depends(get_current_user)):
    if has_capability(user, PAGE_TEAMS) or has_capability(user, PAGE_PM_PORTAL):
        return user
    raise HTTPException(status_code=403, detail="Insufficient permissions")


def _manageable_crew_ids(conn, user):
    """None = unrestricted (admin role or page.teams). Otherwise the set of
    work_crew ids a pm_portal-scoped user may list/set/rotate/deactivate codes
    for: crews actively assigned to THEIR projects PLUS (Crew Model v2 CR2)
    those crews' PARENT companies — so a PM can set the per-company BOSS code
    for companies working their projects, whether the assignment points at a
    child lead (legacy or lead_crew_id) or directly at the parent
    (company_id, lead-less line)."""
    if (user.get("role") or "").lower() == "admin" or has_capability(user, PAGE_TEAMS):
        return None
    pm_id = user.get("project_manager_id") or -1
    # Project-level scope (same as the PM pages): PM on ANY item of a project
    # -> every crew actively assigned to ANY item of that project, plus each
    # crew's company (its parent, or itself when company_id points at it).
    rows = conn.execute(text("""
        SELECT DISTINCT swc.work_crew_id, swc.company_id, swc.lead_crew_id,
                        wc.parent_id
        FROM project_schedule_items psi
        JOIN project_schedule_item_project_managers spm ON spm.schedule_item_id = psi.id
        JOIN project_schedule_items psi2 ON psi2.project_id = psi.project_id
        JOIN project_schedule_item_work_crews swc ON swc.schedule_item_id = psi2.id
        LEFT JOIN work_crews wc ON wc.id = swc.work_crew_id
        WHERE spm.project_manager_id = :pm
          AND spm.unassigned_at IS NULL AND swc.unassigned_at IS NULL
    """), {"pm": pm_id}).mappings().all()
    allowed = set()
    for r in rows:
        for k in ("work_crew_id", "company_id", "lead_crew_id", "parent_id"):
            if r[k] is not None:
                allowed.add(int(r[k]))
    return allowed


class PasscodeSetRequest(BaseModel):
    crew_id: Optional[int] = None   # lead: the child crew; boss: the PARENT (company)
    role: str = "lead"              # 'lead' | 'boss'
    label: str
    code: str                       # plain 4-6 digits; stored hashed, never logged


@router.get("/passcodes")
def list_passcodes(user=Depends(get_passcode_manager)):
    """All passcodes (no hashes) with crew names, active first. A pm_portal-
    scoped user only sees lead codes for crews on THEIR projects."""
    with engine.connect() as conn:
        allowed = _manageable_crew_ids(conn, user)
        rows = conn.execute(text("""
            SELECT cp.id, cp.crew_id, wc.name AS crew_name, cp.role, cp.label,
                   cp.active, cp.created_at, cp.last_used_at
            FROM crew_passcodes cp LEFT JOIN work_crews wc ON wc.id = cp.crew_id
            ORDER BY cp.active DESC, wc.name IS NULL, wc.name, cp.id DESC
        """)).mappings().all()
    if allowed is not None:
        rows = [r for r in rows if r["crew_id"] is not None and int(r["crew_id"]) in allowed]
    return {"passcodes": [{
        "id": r["id"], "crew_id": r["crew_id"], "crew_name": r["crew_name"],
        "role": r["role"], "label": r["label"], "active": bool(r["active"]),
        "created_at": str(r["created_at"]) if r["created_at"] else None,
        "last_used_at": str(r["last_used_at"]) if r["last_used_at"] else None,
    } for r in rows]}


@router.post("/passcodes")
def set_passcode(req: PasscodeSetRequest, user=Depends(get_passcode_manager)):
    """Set (rotate) a crew lead's passcode, or a company BOSS code (crew_id =
    the PARENT crew, role 'boss' — Crew Model v2 CR2; the old crew_id-NULL
    global master is retired and can no longer be created). Deactivates any
    previous active code for the same crew/role, verifies the new code isn't
    already in use anywhere (verify against all active rows), stores only the
    hash. Audited without the code itself."""
    role = (req.role or "lead").strip().lower()
    if role not in ("lead", "boss"):
        raise HTTPException(status_code=400, detail="role must be 'lead' or 'boss'")
    code = (req.code or "").strip()
    if not CODE_RE.fullmatch(code):
        raise HTTPException(status_code=400, detail="Code must be 4-6 digits")
    label = (req.label or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="Label is required (e.g. the lead's name)")
    if req.crew_id is None:
        raise HTTPException(status_code=400,
                            detail="The global master code is retired — set a Boss code on the company instead")

    with engine.connect() as conn:
        allowed = _manageable_crew_ids(conn, user)
        if allowed is not None and int(req.crew_id) not in allowed:
            raise HTTPException(status_code=403,
                                detail="You can only manage codes for crews assigned to your projects")
        crew_row = conn.execute(text("SELECT name, parent_id FROM work_crews WHERE id = :id"),
                                {"id": req.crew_id}).mappings().first()
        if crew_row is None:
            raise HTTPException(status_code=404, detail="Crew not found")
        crew_name = crew_row["name"]
        if role == "boss" and crew_row["parent_id"] is not None:
            raise HTTPException(status_code=400,
                                detail="Boss codes go on the company (the parent crew row), not a crew lead")
        active_rows = conn.execute(text(
            "SELECT id, code_hash FROM crew_passcodes WHERE active = 1"
        )).mappings().all()

    # 4-6 digit codes can collide, so uniqueness is enforced here at set time.
    for r in active_rows:
        try:
            if pwd_context.verify(code, r["code_hash"]):
                raise HTTPException(status_code=400, detail="That code is already in use. Pick a different one.")
        except HTTPException:
            raise
        except Exception:
            continue

    with engine.begin() as conn:
        replaced = conn.execute(text("""
            UPDATE crew_passcodes SET active = 0
            WHERE active = 1 AND crew_id = :c AND role = :r
        """), {"c": req.crew_id, "r": role}).rowcount
        new_id = conn.execute(text("""
            INSERT INTO crew_passcodes (crew_id, role, label, code_hash, active)
            VALUES (:c, :r, :l, :h, 1)
        """), {"c": req.crew_id, "r": role, "l": label,
               "h": pwd_context.hash(code)}).lastrowid

    record_audit(user, "crew_passcode.set", "crew_passcode", new_id, label,
                 {"crew_id": req.crew_id, "crew_name": crew_name, "role": role,
                  "rotated_previous": int(replaced or 0)})
    return {"ok": True, "id": new_id, "rotated_previous": int(replaced or 0)}


@router.post("/passcodes/{passcode_id}/deactivate")
def deactivate_passcode(passcode_id: int, user=Depends(get_passcode_manager)):
    with engine.begin() as conn:
        row = conn.execute(text("""
            SELECT id, crew_id, role, label FROM crew_passcodes WHERE id = :id
        """), {"id": passcode_id}).mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="Passcode not found")
        allowed = _manageable_crew_ids(conn, user)
        if allowed is not None and (row["crew_id"] is None or int(row["crew_id"]) not in allowed):
            raise HTTPException(status_code=403,
                                detail="You can only manage codes for crews assigned to your projects")
        conn.execute(text("UPDATE crew_passcodes SET active = 0 WHERE id = :id"),
                     {"id": passcode_id})
    record_audit(user, "crew_passcode.deactivate", "crew_passcode", passcode_id, row["label"],
                 {"crew_id": row["crew_id"], "role": row["role"]})
    return {"ok": True}
