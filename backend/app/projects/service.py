# projects/service.py
# This file defines service functions for managing projects and assignments, including listing assignable projects, fetching project assignment bundles, saving project assignments, and listing project events. It uses SQLAlchemy for database interactions and includes validation and logging of changes.
from sqlalchemy import text
from app.db import engine
from datetime import datetime
from typing import Any, Dict

ALLOWED_STATUS = {"not_started", "in_progress", "completed", "canceled"}

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

def ensure_project_row_for_qbo_customer(conn, qbo_customer_id: int) -> int:
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
        qbo = conn.execute(text("""
            SELECT id, qbo_id, display_name
            FROM qbo_customers
            WHERE id = :cid
            LIMIT 1
        """), {"cid": qbo_customer_id}).mappings().first()
        if not qbo:
            raise ValueError("Unknown qbo_customer_id")

        proj = conn.execute(text("""
            SELECT id, qbo_customer_id
            FROM projects
            WHERE qbo_customer_id = :cid
            LIMIT 1
        """), {"cid": qbo_customer_id}).mappings().first()

        project_id = int(proj["id"]) if proj else None

        schedule_items = []
        if project_id:
            rows = conn.execute(text("""
                SELECT
                    id,
                    project_id,
                    status,
                    start_date,
                    end_date,
                    wire_guidance,
                    travel_days,
                    overage_days,
                    equipment_type,
                    notes,
                    is_extra_row,
                    sort_order
                FROM project_schedule_items
                WHERE project_id = :pid
                ORDER BY sort_order, start_date, id
            """), {"pid": project_id}).mappings().all()

            for r in rows:
                item = dict(r)
                sid = int(item["id"])

                pms_active = conn.execute(text("""
                    SELECT project_manager_id, is_primary
                    FROM project_schedule_item_project_managers
                    WHERE schedule_item_id = :sid
                      AND unassigned_at IS NULL
                    ORDER BY is_primary DESC, project_manager_id
                """), {"sid": sid}).mappings().all()

                crews_active = conn.execute(text("""
                    SELECT work_crew_id, is_primary
                    FROM project_schedule_item_work_crews
                    WHERE schedule_item_id = :sid
                      AND unassigned_at IS NULL
                    ORDER BY is_primary DESC, work_crew_id
                """), {"sid": sid}).mappings().all()

                item["active_project_managers"] = [dict(x) for x in pms_active]
                item["active_work_crews"] = [dict(x) for x in crews_active]
                schedule_items.append(item)

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
              AND parent_id IS NOT NULL
            ORDER BY COALESCE(parent_id, id), sort_order, id
        """)).mappings().all()

    return {
        "qbo": dict(qbo),
        "project": dict(proj) if proj else {
            "id": None,
            "qbo_customer_id": qbo_customer_id,
        },
        "schedule_items": schedule_items,
        "project_managers": [dict(r) for r in pms],
        "work_crews": [dict(r) for r in crews],
    }

def _json(conn, v):
    import json
    from datetime import date, datetime

    def _default(o):
        if isinstance(o, (date, datetime)):
            return o.isoformat()
        return str(o)

    return json.dumps(v, default=_default) if v is not None else None

def _log_project_event(conn, project_id: int, actor_user_id: int, event_type: str, old_value=None, new_value=None):
    conn.execute(text("""
        INSERT INTO project_events
          (project_id, event_type, actor_user_id, old_value, new_value)
        VALUES
          (:project_id, :event_type, :actor_user_id, :old_value, :new_value)
    """), {
        "project_id": int(project_id),
        "event_type": event_type,
        "actor_user_id": int(actor_user_id),
        "old_value": _json(conn, old_value),
        "new_value": _json(conn, new_value),
    })

def save_schedule_item(req, actor_user_id: int) -> Dict[str, Any]:
    status = (req.status or "").strip()
    if status not in ALLOWED_STATUS:
        raise ValueError("Invalid status")

    pm_ids = [int(x) for x in (req.project_manager_ids or [])]
    crew_ids = [int(x) for x in (req.work_crew_ids or [])]
    primary_pm = int(req.primary_project_manager_id) if req.primary_project_manager_id else None
    primary_crew = int(req.primary_work_crew_id) if req.primary_work_crew_id else None

    if primary_pm is not None and primary_pm not in pm_ids:
        raise ValueError("primary_project_manager_id must be included in project_manager_ids")
    if primary_crew is not None and primary_crew not in crew_ids:
        raise ValueError("primary_work_crew_id must be included in work_crew_ids")

    start_date = (req.start_date or "").strip() or None
    end_date = (req.end_date or "").strip() or None

    if start_date and end_date:
        sd = datetime.strptime(start_date, "%Y-%m-%d").date()
        ed = datetime.strptime(end_date, "%Y-%m-%d").date()
        if ed < sd:
            raise ValueError("end_date cannot be before start_date")

    with engine.begin() as conn:
        project_id = ensure_project_row_for_qbo_customer(conn, int(req.qbo_customer_id))

        schedule_item_id = getattr(req, "schedule_item_id", None)
        is_create = not bool(schedule_item_id)

        prior_item = None
        prior_pm_ids = []
        prior_primary_pm = None
        prior_crew_ids = []
        prior_primary_crew = None

        if schedule_item_id:
            prior_item = conn.execute(text("""
                SELECT id, project_id, status, start_date, end_date, wire_guidance, travel_days, overage_days, equipment_type, notes, is_extra_row, sort_order
                FROM project_schedule_items
                WHERE id = :sid AND project_id = :pid
                LIMIT 1
            """), {"sid": int(schedule_item_id), "pid": project_id}).mappings().first()

            if not prior_item:
                raise ValueError("Unknown schedule_item_id")

            pm_rows = conn.execute(text("""
                SELECT project_manager_id, is_primary
                FROM project_schedule_item_project_managers
                WHERE schedule_item_id = :sid
                  AND unassigned_at IS NULL
                ORDER BY is_primary DESC, project_manager_id
            """), {"sid": int(schedule_item_id)}).mappings().all()
            prior_pm_ids = [int(x["project_manager_id"]) for x in pm_rows]
            prior_primary_pm = next((int(x["project_manager_id"]) for x in pm_rows if x["is_primary"]), None)

            crew_rows = conn.execute(text("""
                SELECT work_crew_id, is_primary
                FROM project_schedule_item_work_crews
                WHERE schedule_item_id = :sid
                  AND unassigned_at IS NULL
                ORDER BY is_primary DESC, work_crew_id
            """), {"sid": int(schedule_item_id)}).mappings().all()
            prior_crew_ids = [int(x["work_crew_id"]) for x in crew_rows]
            prior_primary_crew = next((int(x["work_crew_id"]) for x in crew_rows if x["is_primary"]), None)

            conn.execute(text("""
                UPDATE project_schedule_items
                SET status = :st,
                    start_date = :sd,
                    end_date = :ed,
                    wire_guidance = :wg,
                    travel_days = :td,
                    overage_days = :od,
                    equipment_type = :eq,
                    notes = :notes
                WHERE id = :sid
            """), {
                "sid": int(schedule_item_id),
                "st": status,
                "sd": start_date,
                "ed": end_date,
                "wg": getattr(req, "wire_guidance", 0) or 0,
                "td": getattr(req, "travel_days", 0) or 0,
                "od": getattr(req, "overage_days", 0) or 0,
                "eq": getattr(req, "equipment_type", None) or None,
                "notes": getattr(req, "notes", None) or None,
            })
            sid = int(schedule_item_id)
        else:
            next_sort_order = conn.execute(text("""
                SELECT COALESCE(MAX(sort_order), 0) + 1
                FROM project_schedule_items
                WHERE project_id = :pid
            """), {"pid": project_id}).scalar()

            conn.execute(text("""
                INSERT INTO project_schedule_items
                    (project_id, status, start_date, end_date, wire_guidance, travel_days, overage_days, equipment_type, notes, is_extra_row,sort_order)
                VALUES
                    (:pid, :st, :sd, :ed, :wg, :td, :od, :eq, :notes, :is_extra_row, :so)
            """), {
                "pid": project_id,
                "st": status,
                "sd": start_date,
                "ed": end_date,
                "wg": getattr(req, "wire_guidance", 0) or 0,
                "td": getattr(req, "travel_days", 0) or 0,
                "od": getattr(req, "overage_days", 0) or 0,
                "eq": getattr(req, "equipment_type", None) or None,
                "notes": getattr(req, "notes", None) or None,
                "is_extra_row": 1,
                "so": int(next_sort_order or 1),
            })
            sid = int(conn.execute(text("SELECT LAST_INSERT_ID()")).scalar())

        conn.execute(text("""
            UPDATE project_schedule_item_project_managers
            SET unassigned_at = NOW(), unassigned_by_user_id = :uid, is_primary = 0
            WHERE schedule_item_id = :sid AND unassigned_at IS NULL
        """), {"sid": sid, "uid": actor_user_id})

        for pm_id in pm_ids:
            conn.execute(text("""
                INSERT INTO project_schedule_item_project_managers
                  (schedule_item_id, project_manager_id, is_primary, assigned_by_user_id)
                VALUES
                  (:sid, :pmid, :is_primary, :uid)
            """), {
                "sid": sid,
                "pmid": int(pm_id),
                "is_primary": 1 if primary_pm is not None and int(pm_id) == int(primary_pm) else 0,
                "uid": actor_user_id,
            })

        conn.execute(text("""
            UPDATE project_schedule_item_work_crews
            SET unassigned_at = NOW(), unassigned_by_user_id = :uid, is_primary = 0
            WHERE schedule_item_id = :sid AND unassigned_at IS NULL
        """), {"sid": sid, "uid": actor_user_id})

        for crew_id in crew_ids:
            conn.execute(text("""
                INSERT INTO project_schedule_item_work_crews
                  (schedule_item_id, work_crew_id, is_primary, assigned_by_user_id)
                VALUES
                  (:sid, :cid, :is_primary, :uid)
            """), {
                "sid": sid,
                "cid": int(crew_id),
                "is_primary": 1 if primary_crew is not None and int(crew_id) == int(primary_crew) else 0,
                "uid": actor_user_id,
            })

        new_item = conn.execute(text("""
            SELECT id, project_id, status, start_date, end_date, wire_guidance, travel_days, overage_days, equipment_type, notes, is_extra_row, sort_order
            FROM project_schedule_items
            WHERE id = :sid
            LIMIT 1
        """), {"sid": sid}).mappings().first()

        old_value = {
            "schedule_item": dict(prior_item) if prior_item else None,
            "project_manager_ids": prior_pm_ids,
            "primary_project_manager_id": prior_primary_pm,
            "work_crew_ids": prior_crew_ids,
            "primary_work_crew_id": prior_primary_crew,
        }
        new_value = {
            "schedule_item": dict(new_item) if new_item else None,
            "project_manager_ids": pm_ids,
            "primary_project_manager_id": primary_pm,
            "work_crew_ids": crew_ids,
            "primary_work_crew_id": primary_crew,
        }

        _log_project_event(
            conn,
            project_id=project_id,
            actor_user_id=actor_user_id,
            event_type="project_schedule_item_created" if is_create else "project_schedule_item_updated",
            old_value=old_value,
            new_value=new_value,
        )

    return {"ok": True, "project_id": project_id, "schedule_item_id": sid}

def delete_schedule_item(schedule_item_id: int, actor_user_id: int):
    with engine.begin() as conn:
        row = conn.execute(text("""
            SELECT id, project_id, is_extra_row
            FROM project_schedule_items
            WHERE id = :sid
            LIMIT 1
        """), {"sid": int(schedule_item_id)}).mappings().first()

        if not row:
            raise ValueError("Schedule item not found")

        if not row["is_extra_row"]:
            raise ValueError("Cannot delete main project row")

        conn.execute(text("""
            DELETE FROM project_schedule_items
            WHERE id = :sid
        """), {"sid": int(schedule_item_id)})

    return {"ok": True}

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