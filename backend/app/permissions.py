"""
Permissions: the single source of truth for what each role/user can do.

Two concepts:
  * Capabilities  - named permissions (page access + actions). The backend
                    enforces these; the frontend mirrors them only to hide
                    nav/buttons (never for security).
  * Data scoping  - which projects a user may see/act on. admin/office see all;
                    a PM sees projects they're assigned to; a crew lead sees
                    projects their crew (and sub-crews) are assigned to.

Effective capabilities = role defaults, then per-user allow/deny overrides
(user_permission_overrides table).

This module must NOT import from auth.py (auth imports from here). Helpers that
need the request user take the plain user dict produced by auth.get_current_user.
"""

from typing import Optional, Set, List, Dict

from sqlalchemy import text, bindparam

from .db import engine

# ---------------------------------------------------------------------------
# Capability names
# ---------------------------------------------------------------------------
# Page access (one per nav destination)
PAGE_DASHBOARD  = "page.dashboard"
PAGE_FINANCIALS = "page.financials"
PAGE_ESTIMATE   = "page.estimate"
PAGE_SCHEDULE   = "page.schedule"
PAGE_ASSIGNMENT = "page.assignment"
PAGE_TEAMS      = "page.teams"
PAGE_USERS      = "page.users"
PAGE_QUICKBOOKS = "page.quickbooks"
PAGE_CASHFLOW   = "page.cashflow"
PAGE_CREW_PORTAL = "page.crew_portal"   # crew hierarchy drill-down (parents → children → projects → foreman)
PAGE_CUSTOMERS  = "page.customers"      # customers → legacy jobs drill-down (revenue not tied to QBO Projects)
PAGE_SETTINGS   = "page.settings"       # manage roles & their default permissions (admin)

# Action capabilities
PROJECT_VIEW_ALL    = "project.view_all"      # see every project (vs. only assigned)
ASSIGNMENT_EDIT_ANY = "assignment.edit_any"   # edit any project's schedule items
ASSIGNMENT_EDIT_OWN = "assignment.edit_own"   # edit only your own assigned items
USERS_MANAGE        = "users.manage"          # create/edit users & permissions
TEAMS_MANAGE        = "teams.manage"          # create/edit PMs & work crews
QBO_SYNC            = "qbo.sync"              # run QuickBooks syncs
PROJECTS_ADMIN      = "projects.admin_tools"  # refresh financials, reset statuses, etc.

ALL_CAPABILITIES: List[str] = [
    PAGE_DASHBOARD, PAGE_FINANCIALS, PAGE_ESTIMATE, PAGE_SCHEDULE,
    PAGE_ASSIGNMENT, PAGE_TEAMS, PAGE_USERS, PAGE_QUICKBOOKS, PAGE_CASHFLOW,
    PAGE_CREW_PORTAL, PAGE_CUSTOMERS, PAGE_SETTINGS,
    PROJECT_VIEW_ALL, ASSIGNMENT_EDIT_ANY, ASSIGNMENT_EDIT_OWN,
    USERS_MANAGE, TEAMS_MANAGE, QBO_SYNC, PROJECTS_ADMIN,
]

# ---------------------------------------------------------------------------
# Role defaults.
#
# Roles + their default capabilities live in the DB (`roles`, `role_capabilities`)
# so an admin can create roles and manage defaults from the Settings page. This
# dict is the SEED (used to populate the tables on first run) and the FALLBACK
# (used if the tables don't exist yet, e.g. before migration 0003). After seeding,
# the DB is the source of truth. The admin role is always forced to ALL caps and
# can't be edited or deleted — you can't lock yourself out.
#
# Note: 'user' is the office-staff tier (kept as 'user' to avoid migrating rows).
# ---------------------------------------------------------------------------
FALLBACK_ROLE_DEFAULTS: Dict[str, Set[str]] = {
    "admin": set(ALL_CAPABILITIES),

    "user": {  # office staff
        PAGE_DASHBOARD, PAGE_FINANCIALS, PAGE_ESTIMATE, PAGE_SCHEDULE,
        PAGE_ASSIGNMENT, PAGE_TEAMS, PAGE_CASHFLOW, PAGE_CUSTOMERS,
        PROJECT_VIEW_ALL, ASSIGNMENT_EDIT_ANY, TEAMS_MANAGE, PROJECTS_ADMIN,
    },

    "pm": {  # project manager: scoped to own projects; Projects, Financials, Estimate
        PAGE_DASHBOARD, PAGE_FINANCIALS, PAGE_ESTIMATE,
    },

    "crew_lead": {  # parent crew (boss): enters the portal at their subtree (children → projects → foreman)
        PAGE_CREW_PORTAL,
    },

    "crew_foreman": {  # child crew foreman: enters straight at their project's foreman view
        PAGE_CREW_PORTAL,
    },
}

# Friendly metadata for the built-in roles (label, description, is_system).
# is_system roles can't be deleted; only the admin role's caps are locked.
BUILTIN_ROLE_META = {
    "admin":        ("Administrator", "Full access to everything (locked).", True),
    "user":         ("Office staff", "Office team: projects, financials, estimates, scheduling, cash flow.", True),
    "pm":           ("Project manager", "Scoped to their own assigned projects.", True),
    "crew_lead":    ("Crew lead", "Parent-crew boss: their crew subtree in the Crew Portal.", True),
    "crew_foreman": ("Crew foreman", "Child-crew foreman: their assigned project's foreman view.", True),
}

ADMIN_ROLE = "admin"

# Short-lived cache so we don't hit the DB for role defaults on every request.
_roles_cache: Dict[str, object] = {"exp": 0.0, "defaults": None, "valid": None}
_ROLES_TTL = 10.0  # seconds


def _seed_roles_if_empty(conn) -> None:
    """Populate roles/role_capabilities from the code defaults on first run."""
    n = conn.execute(text("SELECT COUNT(*) FROM roles")).scalar()
    if n and int(n) > 0:
        return
    for name, caps in FALLBACK_ROLE_DEFAULTS.items():
        label, desc, is_sys = BUILTIN_ROLE_META.get(name, (name, None, False))
        conn.execute(
            text("INSERT INTO roles (name, label, description, is_system) VALUES (:n, :l, :d, :s)"),
            {"n": name, "l": label, "d": desc, "s": 1 if is_sys else 0},
        )
        rid = conn.execute(text("SELECT id FROM roles WHERE name = :n"), {"n": name}).scalar()
        for cap in caps:
            conn.execute(
                text("INSERT IGNORE INTO role_capabilities (role_id, capability) VALUES (:r, :c)"),
                {"r": rid, "c": cap},
            )


def get_role_defaults() -> Dict[str, Set[str]]:
    """{role_name: set(capabilities)} from the DB (seeded + cached). admin = ALL."""
    import time
    now = time.time()
    if _roles_cache["defaults"] is not None and now < float(_roles_cache["exp"]):
        return _roles_cache["defaults"]  # type: ignore[return-value]
    try:
        with engine.begin() as conn:
            _seed_roles_if_empty(conn)
            roles = conn.execute(text("SELECT id, name FROM roles")).mappings().all()
            caps = conn.execute(text("SELECT role_id, capability FROM role_capabilities")).mappings().all()
    except Exception:
        # Tables not present yet (pre-migration) — use the code fallback.
        return {k: set(v) for k, v in FALLBACK_ROLE_DEFAULTS.items()}
    by_id = {r["id"]: r["name"] for r in roles}
    out: Dict[str, Set[str]] = {r["name"]: set() for r in roles}
    for c in caps:
        nm = by_id.get(c["role_id"])
        if nm:
            out[nm].add(c["capability"])
    out[ADMIN_ROLE] = set(ALL_CAPABILITIES)  # admin always has everything
    _roles_cache.update(exp=now + _ROLES_TTL, defaults=out, valid=set(out.keys()))
    return out


def valid_roles() -> Set[str]:
    get_role_defaults()
    return set(_roles_cache["valid"]) if _roles_cache["valid"] else set(FALLBACK_ROLE_DEFAULTS.keys())  # type: ignore[arg-type]


def bump_roles_cache() -> None:
    """Invalidate the role-defaults cache (call after any role mutation)."""
    _roles_cache.update(exp=0.0, defaults=None, valid=None)


# ---------------------------------------------------------------------------
# Effective capabilities
# ---------------------------------------------------------------------------
def load_capabilities(user_id: int, role: str) -> Set[str]:
    """Role defaults (from DB), adjusted by this user's allow/deny overrides.

    Resilient to the overrides table not existing yet (pre-migration): falls
    back to role defaults.
    """
    caps = set(get_role_defaults().get((role or "").lower(), set()))
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT capability, effect
                FROM user_permission_overrides
                WHERE user_id = :uid
            """), {"uid": user_id}).mappings().all()
    except Exception:
        return caps  # table not migrated yet
    for r in rows:
        if r["effect"] == "allow":
            caps.add(r["capability"])
        elif r["effect"] == "deny":
            caps.discard(r["capability"])
    return caps


def has_capability(user: dict, cap: str) -> bool:
    return cap in (user.get("capabilities") or set())


def permission_snapshot(user_id: int, role: str) -> dict:
    """For the admin UI: role defaults, raw overrides, and resulting effective set."""
    role = (role or "").lower()
    defaults = sorted(get_role_defaults().get(role, set()))
    overrides = []
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT capability, effect
                FROM user_permission_overrides
                WHERE user_id = :uid
                ORDER BY capability
            """), {"uid": user_id}).mappings().all()
        overrides = [dict(r) for r in rows]
    except Exception:
        overrides = []
    return {
        "role": role,
        "all_capabilities": ALL_CAPABILITIES,
        "defaults": defaults,
        "overrides": overrides,
        "effective": sorted(load_capabilities(user_id, role)),
    }


# ---------------------------------------------------------------------------
# Data scoping
# ---------------------------------------------------------------------------
def visible_project_ids(user: dict) -> Optional[Set[int]]:
    """Set of qbo_customer_id the user may see, or None meaning "all projects".

    - PROJECT_VIEW_ALL  -> None (no filtering)
    - linked PM         -> projects assigned to that PM (active assignments)
    - linked crew lead  -> projects assigned to that crew or its sub-crews
    - otherwise         -> empty set (sees nothing)
    """
    if PROJECT_VIEW_ALL in (user.get("capabilities") or set()):
        return None

    ids: Set[int] = set()
    pm_id = user.get("project_manager_id")
    crew_id = user.get("work_crew_id")

    with engine.connect() as conn:
        if pm_id:
            rows = conn.execute(text("""
                SELECT DISTINCT p.qbo_customer_id
                FROM myapp.projects p
                JOIN myapp.project_schedule_items psi
                  ON psi.project_id = p.id
                JOIN myapp.project_schedule_item_project_managers spm
                  ON spm.schedule_item_id = psi.id
                WHERE spm.project_manager_id = :pm
                  AND spm.unassigned_at IS NULL
            """), {"pm": pm_id}).scalars().all()
            ids.update(int(x) for x in rows if x is not None)

        if crew_id:
            rows = conn.execute(text("""
                SELECT DISTINCT p.qbo_customer_id
                FROM myapp.projects p
                JOIN myapp.project_schedule_items psi
                  ON psi.project_id = p.id
                JOIN myapp.project_schedule_item_work_crews swc
                  ON swc.schedule_item_id = psi.id
                JOIN myapp.work_crews wc
                  ON wc.id = swc.work_crew_id
                WHERE swc.unassigned_at IS NULL
                  AND (wc.id = :crew OR wc.parent_id = :crew)
            """), {"crew": crew_id}).scalars().all()
            ids.update(int(x) for x in rows if x is not None)

    return ids


def visible_project_qbo_ids(user: dict) -> Optional[Set[str]]:
    """Like visible_project_ids but returns QBO id strings (qbo_customers.qbo_id).

    Used by endpoints that filter on the QBO id rather than the internal
    qbo_customer_id. Returns None meaning "all projects".
    """
    internal = visible_project_ids(user)
    if internal is None:
        return None
    if not internal:
        return set()
    stmt = text("SELECT qbo_id FROM myapp.qbo_customers WHERE id IN :ids").bindparams(
        bindparam("ids", expanding=True)
    )
    with engine.connect() as conn:
        rows = conn.execute(stmt, {"ids": list(internal)}).scalars().all()
    return {str(x) for x in rows if x is not None}


def filter_visible(rows: list, user: dict, key: str = "qbo_customer_id") -> list:
    """Drop rows the user isn't allowed to see. No-op for view-all users."""
    allowed = visible_project_ids(user)
    if allowed is None:
        return rows
    out = []
    for r in rows or []:
        v = r.get(key)
        if v is not None and int(v) in allowed:
            out.append(r)
    return out


def can_edit_assignment(user: dict, qbo_customer_id) -> bool:
    """True if the user may create/edit/delete schedule items for this project."""
    caps = user.get("capabilities") or set()
    if ASSIGNMENT_EDIT_ANY in caps:
        return True
    if ASSIGNMENT_EDIT_OWN in caps:
        allowed = visible_project_ids(user)
        return allowed is None or (qbo_customer_id is not None and int(qbo_customer_id) in allowed)
    return False
