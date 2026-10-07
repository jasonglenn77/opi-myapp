"""Assignment-line history (Crew Model v2 CR1, plan 2026-09-24).

Every create/update/delete of a project_schedule_items row (an "assignment
line" on the Assignment page) gets a project_schedule_item_history row:
action, changed_by (users.id, NULL = before tracking / system), changed_at,
and a changes JSON shaped {field: [old, new]} — the same diff convention as
app/audit.py's diff_fields. Crews and PMs are recorded as readable labels
("MTY · Gustavo Ramirez (JR1)") so CR4's history UI needs no joins.

This is ADDITIVE to the existing project_events / audit_log writes — those
stay untouched. Writers pass their open transaction's `conn` so the history
row commits (or rolls back) atomically with the change it records.
"""
import json

from sqlalchemy import text

# The scalar schedule-item fields history tracks (plus 'crews' and
# 'project_managers' label lists handled by the callers). non_working (0062)
# is JSON {"weekends_off": bool, "dates": [...]} — _item_fields_dict parses
# the DB string into that dict so diffs compare by value and history rows
# store the readable object (the frontend humanizer renders
# "non-working days: 3 dates + weekends off" style fragments from it).
ITEM_FIELDS = ("status", "start_date", "end_date", "wire_guidance",
               "travel_days", "overage_days", "equipment_type", "notes",
               "non_working")


def record_item_history(conn, schedule_item_id, action, changed_by_user_id, changes):
    """One history row inside the caller's transaction. `changes` is
    {field: [old, new]} or None (skip empty update diffs at the call site —
    a no-op save records nothing)."""
    conn.execute(text("""
        INSERT INTO project_schedule_item_history
          (schedule_item_id, action, changed_by_user_id, changes)
        VALUES (:sid, :action, :uid, :changes)
    """), {
        "sid": int(schedule_item_id),
        "action": action,
        "uid": int(changed_by_user_id) if changed_by_user_id is not None else None,
        "changes": json.dumps(changes, default=str) if changes else None,
    })


def load_crews_map(conn):
    """work_crews id -> {name, code, parent_id} (parents AND children,
    active or not — labels must resolve for historical rows too)."""
    rows = conn.execute(text(
        "SELECT id, name, code, parent_id FROM work_crews"
    )).mappings().all()
    return {int(r["id"]): {"name": r["name"], "code": r["code"],
                           "parent_id": r["parent_id"]} for r in rows}


def derive_company_lead(crews_map, work_crew_id):
    """The backfill rule: child crew -> (parent, child); parent crew ->
    (itself, None). Unknown crew id -> (None, None)."""
    wc = crews_map.get(int(work_crew_id))
    if not wc:
        return None, None
    if wc["parent_id"] is not None:
        return int(wc["parent_id"]), int(work_crew_id)
    return int(work_crew_id), None


def crew_label(crews_map, work_crew_id, company_id=None, lead_crew_id=None, slot_code=None):
    """Readable assignment label, e.g. "MTY · Gustavo Ramirez (JR1)".
    Falls back to deriving company/lead from work_crew_id for rows that
    pre-date the v2 columns."""
    if company_id is None and lead_crew_id is None:
        company_id, lead_crew_id = derive_company_lead(crews_map, work_crew_id)
    company = crews_map.get(int(company_id)) if company_id else None
    lead = crews_map.get(int(lead_crew_id)) if lead_crew_id else None
    parts = company["name"] if company else (
        crews_map.get(int(work_crew_id), {}).get("name") or f"crew #{work_crew_id}")
    if lead:
        parts += f" · {lead['name']}"
    if slot_code:
        parts += f" ({slot_code})"
    return parts


def used_slot_codes(conn, project_id):
    """Slot codes currently occupied by ACTIVE assignment rows anywhere in
    this project (the ordinal namespace is the project, not the item)."""
    rows = conn.execute(text("""
        SELECT swc.slot_code
        FROM project_schedule_item_work_crews swc
        JOIN project_schedule_items psi ON psi.id = swc.schedule_item_id
        WHERE psi.project_id = :pid
          AND swc.unassigned_at IS NULL
          AND swc.slot_code IS NOT NULL
    """), {"pid": int(project_id)}).scalars().all()
    return {str(s) for s in rows}


def suggest_slot_code(crews_map, company_id, taken):
    """Company prefix code + next free ordinal within the project (JR1, JR2...).
    `taken` is the in-flight set of occupied codes — the suggested code is
    added to it by the caller. No prefix on the company row -> no slot."""
    company = crews_map.get(int(company_id)) if company_id else None
    prefix = (company or {}).get("code")
    if not prefix:
        return None
    n = 1
    while f"{prefix}{n}" in taken:
        n += 1
    return f"{prefix}{n}"
