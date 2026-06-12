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
    PAGE_ASSIGNMENT, PAGE_TEAMS, PAGE_USERS, PAGE_QUICKBOOKS,
    PROJECT_VIEW_ALL, ASSIGNMENT_EDIT_ANY, ASSIGNMENT_EDIT_OWN,
    USERS_MANAGE, TEAMS_MANAGE, QBO_SYNC, PROJECTS_ADMIN,
]

# ---------------------------------------------------------------------------
# Role defaults  (tweak freely — this dict is the policy)
# Note: 'user' is the office-staff tier (kept as 'user' to avoid migrating
# existing rows). admin/office see everything; pm/crew_lead are scoped.
# ---------------------------------------------------------------------------
ROLE_DEFAULTS: Dict[str, Set[str]] = {
    "admin": set(ALL_CAPABILITIES),

    "user": {  # office staff
        PAGE_DASHBOARD, PAGE_FINANCIALS, PAGE_ESTIMATE, PAGE_SCHEDULE,
        PAGE_ASSIGNMENT, PAGE_TEAMS,
        PROJECT_VIEW_ALL, ASSIGNMENT_EDIT_ANY, TEAMS_MANAGE, PROJECTS_ADMIN,
    },

    "pm": {  # project manager: scoped to own projects; Projects, Financials, Estimate
        PAGE_DASHBOARD, PAGE_FINANCIALS, PAGE_ESTIMATE,
    },

    "crew_lead": {  # crew lead: scoped to own projects; Projects only
        PAGE_DASHBOARD,
    },
}

VALID_ROLES = set(ROLE_DEFAULTS.keys())


# ---------------------------------------------------------------------------
# Effective capabilities
# ---------------------------------------------------------------------------
def load_capabilities(user_id: int, role: str) -> Set[str]:
    """Role defaults, adjusted by this user's allow/deny overrides.

    Resilient to the overrides table not existing yet (pre-migration): falls
    back to role defaults.
    """
    caps = set(ROLE_DEFAULTS.get((role or "").lower(), set()))
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
    defaults = sorted(ROLE_DEFAULTS.get(role, set()))
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
