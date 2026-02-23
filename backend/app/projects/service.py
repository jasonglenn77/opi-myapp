from sqlalchemy import text
from app.db import engine
from datetime import datetime
from typing import Any, Dict

ALLOWED_STATUS = {"not_started", "in_progress", "completed"}

def list_assignable_projects():
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, qbo_id, display_name, active, is_project
            FROM qbo_customers
            WHERE is_project = 1
            ORDER BY display_name
            LIMIT 5000
        """)).mappings().all()
    return [dict(r) for r in rows]

def _ensure_project_row(conn, qbo_customer_id: int) -> int:
    # Create projects row if missing; return projects.id
    row = conn.execute(text("""
        SELECT id FROM projects WHERE qbo_customer_id = :cid LIMIT 1
    """), {"cid": qbo_customer_id}).mappings().first()

    if row:
        return int(row["id"])

    conn.execute(text("""
        INSERT INTO projects (qbo_customer_id) VALUES (:cid)
    """), {"cid": qbo_customer_id})

    new_id = conn.execute(text("SELECT LAST_INSERT_ID()")).scalar()
    return int(new_id)

def get_assignment_bundle(qbo_customer_id: int):
    with engine.connect() as conn:
        # QBO project info
        qbo = conn.execute(text("""
            SELECT id, qbo_id, display_name
            FROM qbo_customers
            WHERE id = :cid
            LIMIT 1
        """), {"cid": qbo_customer_id}).mappings().first()
        if not qbo:
            raise ValueError("Unknown qbo_customer_id")

        # Project layer (may not exist yet)
        proj = conn.execute(text("""
            SELECT id, qbo_customer_id, start_date, end_date, status
            FROM projects
            WHERE qbo_customer_id = :cid
            LIMIT 1
        """), {"cid": qbo_customer_id}).mappings().first()

        project_id = int(proj["id"]) if proj else None

        # Active assignments
        pms_active = []
        crews_active = []
        if project_id:
            pms_active = conn.execute(text("""
                SELECT project_manager_id, is_primary
                FROM project_project_managers
                WHERE project_id = :pid AND unassigned_at IS NULL
                ORDER BY is_primary DESC, project_manager_id
            """), {"pid": project_id}).mappings().all()

            crews_active = conn.execute(text("""
                SELECT work_crew_id, is_primary
                FROM project_work_crews
                WHERE project_id = :pid AND unassigned_at IS NULL
                ORDER BY is_primary DESC, work_crew_id
            """), {"pid": project_id}).mappings().all()

        # Options lists
        pms = conn.execute(text("""
            SELECT id, first_name, last_name, email, phone, is_active
            FROM project_managers
            WHERE is_active = 1
            ORDER BY last_name, first_name, id
        """)).mappings().all()

        crews = conn.execute(text("""
            SELECT id, name, code, parent_id, is_active, sort_order
            FROM work_crews
            WHERE is_active = 1
            ORDER BY COALESCE(parent_id, id), parent_id IS NOT NULL, sort_order, id
        """)).mappings().all()

    return {
        "qbo": dict(qbo),
        "project": dict(proj) if proj else {
            "id": None,
            "qbo_customer_id": qbo_customer_id,
            "start_date": None,
            "end_date": None,
            "status": "not_started",
        },
        "active_project_managers": [dict(r) for r in pms_active],
        "active_work_crews": [dict(r) for r in crews_active],
        "project_managers": [dict(r) for r in pms],
        "work_crews": [dict(r) for r in crews],
    }

def _json(conn, v):
    # MySQL will accept Python dict via json string; simplest: pass as string
    import json
    return json.dumps(v) if v is not None else None

def save_project_assignment(req, actor_user_id: int) -> Dict[str, Any]:
    # Validate status
    status = (req.status or "").strip()
    if status not in ALLOWED_STATUS:
        raise ValueError("Invalid status")

    # Normalize ids and primaries
    pm_ids = [int(x) for x in (req.project_manager_ids or [])]
    crew_ids = [int(x) for x in (req.work_crew_ids or [])]
    primary_pm = int(req.primary_project_manager_id) if req.primary_project_manager_id else None
    primary_crew = int(req.primary_work_crew_id) if req.primary_work_crew_id else None

    if primary_pm is not None and primary_pm not in pm_ids:
        raise ValueError("primary_project_manager_id must be included in project_manager_ids")
    if primary_crew is not None and primary_crew not in crew_ids:
        raise ValueError("primary_work_crew_id must be included in work_crew_ids")

    # Dates (accept None/empty)
    start_date = (req.start_date or "").strip() or None
    end_date = (req.end_date or "").strip() or None

    with engine.begin() as conn:
        project_id = _ensure_project_row(conn, int(req.qbo_customer_id))

        # --- load previous project fields
        prev = conn.execute(text("""
            SELECT start_date, end_date, status
            FROM projects
            WHERE id = :pid
            LIMIT 1
        """), {"pid": project_id}).mappings().first()

        prev_start = prev["start_date"].isoformat() if prev["start_date"] else None
        prev_end = prev["end_date"].isoformat() if prev["end_date"] else None
        prev_status = prev["status"]

        # --- update project row
        conn.execute(text("""
            UPDATE projects
            SET start_date = :sd, end_date = :ed, status = :st
            WHERE id = :pid
        """), {"sd": start_date, "ed": end_date, "st": status, "pid": project_id})

        # Log field changes
        if prev_start != start_date or prev_end != end_date:
            conn.execute(text("""
                INSERT INTO project_events (project_id, event_type, actor_user_id, old_value, new_value)
                VALUES (:pid, 'dates_changed', :uid, :oldv, :newv)
            """), {
                "pid": project_id,
                "uid": actor_user_id,
                "oldv": _json(conn, {"start_date": prev_start, "end_date": prev_end}),
                "newv": _json(conn, {"start_date": start_date, "end_date": end_date}),
            })

        if prev_status != status:
            conn.execute(text("""
                INSERT INTO project_events (project_id, event_type, actor_user_id, old_value, new_value)
                VALUES (:pid, 'status_changed', :uid, :oldv, :newv)
            """), {
                "pid": project_id,
                "uid": actor_user_id,
                "oldv": _json(conn, {"status": prev_status}),
                "newv": _json(conn, {"status": status}),
            })

        # --- PM assignments (close removed, add new)
        existing_pms = conn.execute(text("""
            SELECT project_manager_id, is_primary
            FROM project_project_managers
            WHERE project_id = :pid AND unassigned_at IS NULL
        """), {"pid": project_id}).mappings().all()
        existing_pm_ids = {int(r["project_manager_id"]) for r in existing_pms}

        new_pm_ids = set(pm_ids)
        to_remove = existing_pm_ids - new_pm_ids
        to_add = new_pm_ids - existing_pm_ids

        if to_remove:
            conn.execute(text(f"""
                UPDATE project_project_managers
                SET unassigned_at = NOW(), unassigned_by_user_id = :uid, is_primary = 0
                WHERE project_id = :pid AND unassigned_at IS NULL
                  AND project_manager_id IN ({",".join([str(x) for x in to_remove])})
            """), {"pid": project_id, "uid": actor_user_id})

        for pm_id in to_add:
            conn.execute(text("""
                INSERT INTO project_project_managers
                  (project_id, project_manager_id, is_primary, assigned_by_user_id)
                VALUES
                  (:pid, :pmid, 0, :uid)
            """), {"pid": project_id, "pmid": int(pm_id), "uid": actor_user_id})

        # enforce single primary among active
        conn.execute(text("""
            UPDATE project_project_managers
            SET is_primary = 0
            WHERE project_id = :pid AND unassigned_at IS NULL
        """), {"pid": project_id})
        if primary_pm is not None:
            conn.execute(text("""
                UPDATE project_project_managers
                SET is_primary = 1
                WHERE project_id = :pid AND unassigned_at IS NULL AND project_manager_id = :pmid
            """), {"pid": project_id, "pmid": primary_pm})

        # --- Crew assignments
        existing_crews = conn.execute(text("""
            SELECT work_crew_id, is_primary
            FROM project_work_crews
            WHERE project_id = :pid AND unassigned_at IS NULL
        """), {"pid": project_id}).mappings().all()
        existing_crew_ids = {int(r["work_crew_id"]) for r in existing_crews}

        new_crew_ids = set(crew_ids)
        c_remove = existing_crew_ids - new_crew_ids
        c_add = new_crew_ids - existing_crew_ids

        if c_remove:
            conn.execute(text(f"""
                UPDATE project_work_crews
                SET unassigned_at = NOW(), unassigned_by_user_id = :uid, is_primary = 0
                WHERE project_id = :pid AND unassigned_at IS NULL
                  AND work_crew_id IN ({",".join([str(x) for x in c_remove])})
            """), {"pid": project_id, "uid": actor_user_id})

        for crew_id in c_add:
            conn.execute(text("""
                INSERT INTO project_work_crews
                  (project_id, work_crew_id, is_primary, assigned_by_user_id)
                VALUES
                  (:pid, :cid, 0, :uid)
            """), {"pid": project_id, "cid": int(crew_id), "uid": actor_user_id})

        conn.execute(text("""
            UPDATE project_work_crews
            SET is_primary = 0
            WHERE project_id = :pid AND unassigned_at IS NULL
        """), {"pid": project_id})
        if primary_crew is not None:
            conn.execute(text("""
                UPDATE project_work_crews
                SET is_primary = 1
                WHERE project_id = :pid AND unassigned_at IS NULL AND work_crew_id = :cid
            """), {"pid": project_id, "cid": primary_crew})

    return {"ok": True, "project_id": project_id}

def list_project_events(qbo_customer_id: int):
    with engine.connect() as conn:
        proj = conn.execute(text("""
            SELECT id FROM projects WHERE qbo_customer_id = :cid LIMIT 1
        """), {"cid": qbo_customer_id}).mappings().first()
        if not proj:
            return []

        rows = conn.execute(text("""
            SELECT id, event_type, actor_user_id, old_value, new_value, created_at
            FROM project_events
            WHERE project_id = :pid
            ORDER BY created_at DESC
            LIMIT 200
        """), {"pid": int(proj["id"])}).mappings().all()

    return [dict(r) for r in rows]