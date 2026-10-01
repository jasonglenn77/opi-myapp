# projects/service.py
# This file defines service functions for managing projects and assignments, including listing assignable projects, fetching project assignment bundles, saving project assignments, and listing project events. It uses SQLAlchemy for database interactions and includes validation and logging of changes.
from sqlalchemy import text
from app.db import engine
from datetime import datetime, date
from typing import Any, Dict

from app.projects.history import (
    ITEM_FIELDS, record_item_history, load_crews_map, derive_company_lead,
    crew_label, used_slot_codes, suggest_slot_code,
)

ALLOWED_STATUS = {"needs_attention", "pending", "not_started", "in_progress", "completed", "canceled"}
# 'pending' = the office has started on the project (e.g. a PM is assigned) but
# it isn't fully set up yet (crew and/or dates still unknown). It sits between
# 'needs_attention' (untouched) and a fully-scheduled state.
# 'needs_attention' is the initial system-set value for a freshly-created
# master row (see comment in ensure_project_row_for_qbo_customer), but it's
# ALSO a valid user-pickable status: a row can stay in Needs Attention as
# long as the user wants while they fill in partial data. Only the user's
# explicit status change moves it out of Needs Attention.

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

def provision_master_rows_for_all_projects():
    with engine.begin() as conn:
        customers = conn.execute(text("""
            SELECT id FROM qbo_customers WHERE is_project = 1
        """)).mappings().all()

        for c in customers:
            project_id = ensure_project_row_for_qbo_customer(conn, int(c["id"]))

            master = conn.execute(text("""
                SELECT id FROM project_schedule_items
                WHERE project_id = :pid AND (is_extra_row = 0 OR is_extra_row IS NULL)
                LIMIT 1
            """), {"pid": project_id}).mappings().first()

            if not master:
                # 'needs_attention' is the default initial status — the row
                # has been created but no scheduling data has been entered.
                # The user can keep it in Needs Attention while filling in
                # partial data (PM but no crew, dates but no PM, etc.) and
                # picks a different status from the dropdown when ready.
                conn.execute(text("""
                    INSERT INTO project_schedule_items (project_id, status, is_extra_row)
                    VALUES (:pid, 'needs_attention', 0)
                """), {"pid": project_id})

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
                    SELECT swc.work_crew_id, swc.is_primary,
                           COALESCE(swc.company_id, wc.parent_id, wc.id) AS company_id,
                           COALESCE(swc.lead_crew_id,
                                    CASE WHEN wc.parent_id IS NOT NULL THEN wc.id END) AS lead_crew_id,
                           swc.slot_code
                    FROM project_schedule_item_work_crews swc
                    LEFT JOIN work_crews wc ON wc.id = swc.work_crew_id
                    WHERE swc.schedule_item_id = :sid
                      AND swc.unassigned_at IS NULL
                    ORDER BY swc.is_primary DESC, swc.work_crew_id
                """), {"sid": sid}).mappings().all()

                item["active_project_managers"] = [dict(x) for x in pms_active]
                item["active_work_crews"] = [dict(x) for x in crews_active]
                # CR4: history badge count for the workspace panel + the
                # Schedules-page modal (both render from this bundle).
                # CR5 A3: the backfilled "(before tracking)" created row
                # doesn't count as a change.
                item["history_count"] = int(conn.execute(text("""
                    SELECT COUNT(*) FROM project_schedule_item_history
                    WHERE schedule_item_id = :sid
                      AND NOT (action = 'created' AND changed_by_user_id IS NULL)
                """), {"sid": sid}).scalar() or 0)
                schedule_items.append(item)

        pms = conn.execute(text("""
            SELECT id, first_name, last_name, email, phone, is_active
            FROM project_managers
            WHERE is_active = 1
            ORDER BY last_name, first_name, id
        """)).mappings().all()

        # All active rows (parents AND leads): the legacy work_crews list keeps
        # feeding the workspace assignment panel (children first behavior via
        # ordering), and now includes parents so a company-only assignment can
        # be displayed/retained there too.
        crews = conn.execute(text("""
            SELECT id, name, code, parent_id, is_active, sort_order,
                   boss_name, crew_capacity
            FROM work_crews
            WHERE is_active = 1
            ORDER BY COALESCE(parent_id, id), parent_id IS NULL DESC, sort_order, id
        """)).mappings().all()

    # CR3: company-first picker feed — one entry per company with its active
    # leads nested ("MTY · Jesse Rosales Jr." rendering is the frontend's job).
    companies = []
    by_id = {}
    for r in crews:
        if r["parent_id"] is None:
            c = {"id": r["id"], "name": r["name"], "code": r["code"],
                 "boss_name": r["boss_name"], "crew_capacity": r["crew_capacity"],
                 "sort_order": r["sort_order"], "leads": []}
            companies.append(c)
            by_id[int(r["id"])] = c
    for r in crews:
        if r["parent_id"] is not None and int(r["parent_id"]) in by_id:
            by_id[int(r["parent_id"])]["leads"].append(
                {"id": r["id"], "name": r["name"], "code": r["code"]})

    return {
        "qbo": dict(qbo),
        "project": dict(proj) if proj else {
            "id": None,
            "qbo_customer_id": qbo_customer_id,
        },
        "schedule_items": schedule_items,
        "project_managers": [dict(r) for r in pms],
        "work_crews": [dict(r) for r in crews if r["parent_id"] is not None] + [dict(r) for r in crews if r["parent_id"] is None],
        "companies": companies,
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

def _hist_norm(v):
    """JSON-friendly scalar for the history changes diff (dates -> ISO strings
    so a DB date and a request 'YYYY-MM-DD' string compare equal)."""
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    return v


def _pm_labels(conn, pm_ids):
    """Readable PM labels ('Kelly Smith') for a list of project_manager ids,
    keeping the caller's order (primary first)."""
    if not pm_ids:
        return []
    from sqlalchemy import bindparam
    stmt = text("""
        SELECT id, TRIM(CONCAT(COALESCE(first_name,''),' ',COALESCE(last_name,''))) AS nm
        FROM project_managers
        WHERE id IN :ids
    """).bindparams(bindparam("ids", expanding=True))
    rows = conn.execute(stmt, {"ids": [int(i) for i in pm_ids]}).mappings().all()
    names = {int(r["id"]): (r["nm"] or f"PM #{r['id']}") for r in rows}
    return [names.get(int(i), f"PM #{i}") for i in pm_ids]


def _item_fields_dict(row_or_none, override=None):
    """Normalized {field: value} over ITEM_FIELDS for the history diff.
    `row_or_none` is a DB mapping (or None); `override` a dict that wins."""
    out = {}
    src = dict(row_or_none) if row_or_none else {}
    if override:
        src.update(override)
    for f in ITEM_FIELDS:
        out[f] = _hist_norm(src.get(f))
    return out


def _hist_diff(old_fields, new_fields, old_crews, new_crews, old_pms, new_pms):
    """{field: [old, new]} across the scalar fields + 'crews'/'project_managers'
    label lists (reuses app.audit.diff_fields for the scalars)."""
    from app.audit import diff_fields
    changes = diff_fields(old_fields, new_fields, ITEM_FIELDS)
    if sorted(old_crews) != sorted(new_crews):
        changes["crews"] = [old_crews, new_crews]
    if sorted(old_pms) != sorted(new_pms):
        changes["project_managers"] = [old_pms, new_pms]
    return changes


def _normalize_crew_entries(req, crews_map):
    """CR3: turn the request's crew fields into a list of
    {company_id, lead_crew_id, slot_code, is_primary, work_crew_id} dicts.

    Preferred payload: req.crew_assignments (explicit company/lead/slot).
    Legacy payload: req.work_crew_ids — company/lead derived per crew id
    (child -> parent+child; parent -> itself, lead-less), slot auto-suggested.
    The legacy work_crew_id column is ALWAYS dual-written: lead id when a lead
    is set, else the company id."""
    entries = []
    if getattr(req, "crew_assignments", None) is not None:
        seen = set()
        for e in req.crew_assignments:
            company_id = int(e.company_id)
            company = crews_map.get(company_id)
            if not company:
                raise ValueError(f"Unknown company_id {company_id}")
            if company["parent_id"] is not None:
                raise ValueError(f"company_id {company_id} is a crew lead, not a company")
            lead_id = int(e.lead_crew_id) if e.lead_crew_id else None
            if lead_id is not None:
                lead = crews_map.get(lead_id)
                if not lead:
                    raise ValueError(f"Unknown lead_crew_id {lead_id}")
                if lead["parent_id"] is None or int(lead["parent_id"]) != company_id:
                    raise ValueError("lead_crew_id must be a lead of the selected company")
            key = (company_id, lead_id)
            if key in seen:
                continue  # dedupe identical company+lead pairs
            seen.add(key)
            slot = (e.slot_code or "").strip().upper()[:12] or None
            entries.append({
                "company_id": company_id, "lead_crew_id": lead_id,
                "slot_code": slot, "is_primary": bool(e.is_primary),
                "work_crew_id": lead_id if lead_id is not None else company_id,
            })
        if sum(1 for e in entries if e["is_primary"]) > 1:
            for e in entries:
                e["is_primary"] = False  # ambiguous → no primary
        return entries

    # legacy payload
    primary_crew = int(req.primary_work_crew_id) if req.primary_work_crew_id else None
    crew_ids = [int(x) for x in (req.work_crew_ids or [])]
    if primary_crew is not None and primary_crew not in crew_ids:
        raise ValueError("primary_work_crew_id must be included in work_crew_ids")
    for cid in crew_ids:
        company_id, lead_crew_id = derive_company_lead(crews_map, cid)
        entries.append({
            "company_id": company_id, "lead_crew_id": lead_crew_id,
            "slot_code": None, "is_primary": primary_crew is not None and cid == primary_crew,
            "work_crew_id": cid,
        })
    return entries


def save_schedule_item(req, actor_user_id: int) -> Dict[str, Any]:
    status = (req.status or "").strip()
    if status not in ALLOWED_STATUS:
        raise ValueError("Invalid status")

    pm_ids = [int(x) for x in (req.project_manager_ids or [])]
    primary_pm = int(req.primary_project_manager_id) if req.primary_project_manager_id else None

    if primary_pm is not None and primary_pm not in pm_ids:
        raise ValueError("primary_project_manager_id must be included in project_manager_ids")

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
        prior_crew_rows = []

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
                SELECT work_crew_id, is_primary, company_id, lead_crew_id, slot_code
                FROM project_schedule_item_work_crews
                WHERE schedule_item_id = :sid
                  AND unassigned_at IS NULL
                ORDER BY is_primary DESC, work_crew_id
            """), {"sid": int(schedule_item_id)}).mappings().all()
            prior_crew_ids = [int(x["work_crew_id"]) for x in crew_rows]
            prior_primary_crew = next((int(x["work_crew_id"]) for x in crew_rows if x["is_primary"]), None)
            prior_crew_rows = [dict(x) for x in crew_rows]

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

        # Crew Model v2 (CR3): entries are company(+lead)+slot — either explicit
        # (req.crew_assignments) or derived from a legacy work_crew_ids payload.
        # Slot retention: an explicit slot_code is kept as sent; a blank one
        # first tries the prior row for the same company (same lead, then any
        # row of that company — so setting/killing a lead keeps the slot), and
        # only then auto-suggests company prefix + next free ordinal per PROJECT.
        crews_map = load_crews_map(conn)
        crew_entries = _normalize_crew_entries(req, crews_map)
        crew_ids = [e["work_crew_id"] for e in crew_entries]
        primary_crew = next((e["work_crew_id"] for e in crew_entries if e["is_primary"]), None)

        prior_by_pair = {}
        prior_by_company = {}
        for r in prior_crew_rows:
            if not r.get("slot_code"):
                continue
            co = r.get("company_id")
            ld = r.get("lead_crew_id")
            if co is None:
                co, ld = derive_company_lead(crews_map, r["work_crew_id"])
            prior_by_pair.setdefault((co, ld), r["slot_code"])
            prior_by_company.setdefault(co, []).append(r["slot_code"])

        taken_slots = used_slot_codes(conn, project_id)
        # Reserve slots this save will re-use BEFORE suggesting codes for new
        # entries (this item's old rows were just unassigned, so
        # used_slot_codes no longer sees them).
        for e in crew_entries:
            pre = e["slot_code"] or prior_by_pair.get((e["company_id"], e["lead_crew_id"]))
            if pre:
                taken_slots.add(pre)

        new_crew_rows = []
        for e in crew_entries:
            slot_code = e["slot_code"]
            if not slot_code:
                slot_code = prior_by_pair.get((e["company_id"], e["lead_crew_id"]))
            if not slot_code:
                # same company, different/absent lead (e.g. lead set later on a
                # lead-less line): re-use a slot the company already held here.
                avail = [s for s in prior_by_company.get(e["company_id"], [])
                         if s not in {r["slot_code"] for r in new_crew_rows if r["slot_code"]}]
                slot_code = avail[0] if avail else None
            if not slot_code:
                slot_code = suggest_slot_code(crews_map, e["company_id"], taken_slots)
            if slot_code:
                taken_slots.add(slot_code)
            conn.execute(text("""
                INSERT INTO project_schedule_item_work_crews
                  (schedule_item_id, work_crew_id, company_id, lead_crew_id, slot_code,
                   is_primary, assigned_by_user_id)
                VALUES
                  (:sid, :cid, :company_id, :lead_crew_id, :slot_code, :is_primary, :uid)
            """), {
                "sid": sid,
                "cid": int(e["work_crew_id"]),
                "company_id": e["company_id"],
                "lead_crew_id": e["lead_crew_id"],
                "slot_code": slot_code,
                "is_primary": 1 if e["is_primary"] else 0,
                "uid": actor_user_id,
            })
            new_crew_rows.append({"work_crew_id": int(e["work_crew_id"]),
                                  "company_id": e["company_id"],
                                  "lead_crew_id": e["lead_crew_id"], "slot_code": slot_code})

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

        # Assignment-line history (Crew Model v2 CR1) — ADDITIVE to the
        # project_events row above. Readable crew/PM labels, {field:[old,new]}.
        old_crew_labels = [crew_label(crews_map, r["work_crew_id"], r.get("company_id"),
                                      r.get("lead_crew_id"), r.get("slot_code"))
                           for r in prior_crew_rows]
        new_crew_labels = [crew_label(crews_map, r["work_crew_id"], r["company_id"],
                                      r["lead_crew_id"], r["slot_code"])
                           for r in new_crew_rows]
        changes = _hist_diff(
            _item_fields_dict(prior_item), _item_fields_dict(new_item),
            old_crew_labels, new_crew_labels,
            _pm_labels(conn, prior_pm_ids), _pm_labels(conn, pm_ids))
        if is_create:
            record_item_history(conn, sid, "created", actor_user_id, changes or None)
        elif changes:  # a no-op save records nothing
            record_item_history(conn, sid, "updated", actor_user_id, changes)

    return {"ok": True, "project_id": project_id, "schedule_item_id": sid}

def delete_schedule_item(schedule_item_id: int, actor_user_id: int):
    with engine.begin() as conn:
        row = conn.execute(text("""
            SELECT id, project_id, status, start_date, end_date, wire_guidance,
                   travel_days, overage_days, equipment_type, notes, is_extra_row
            FROM project_schedule_items
            WHERE id = :sid
            LIMIT 1
        """), {"sid": int(schedule_item_id)}).mappings().first()

        if not row:
            raise ValueError("Schedule item not found")

        if not row["is_extra_row"]:
            raise ValueError("Cannot delete main project row")

        # Snapshot for history BEFORE the delete (the crew/PM join rows die
        # with the item via ON DELETE CASCADE; the history row survives —
        # project_schedule_item_history has no FK on purpose).
        crews_map = load_crews_map(conn)
        crew_rows = conn.execute(text("""
            SELECT work_crew_id, company_id, lead_crew_id, slot_code
            FROM project_schedule_item_work_crews
            WHERE schedule_item_id = :sid AND unassigned_at IS NULL
        """), {"sid": int(schedule_item_id)}).mappings().all()
        pm_ids = conn.execute(text("""
            SELECT project_manager_id FROM project_schedule_item_project_managers
            WHERE schedule_item_id = :sid AND unassigned_at IS NULL
        """), {"sid": int(schedule_item_id)}).scalars().all()

        old_fields = _item_fields_dict(row)
        changes = {f: [v, None] for f, v in old_fields.items() if v is not None}
        crew_labels_old = [crew_label(crews_map, r["work_crew_id"], r["company_id"],
                                      r["lead_crew_id"], r["slot_code"]) for r in crew_rows]
        if crew_labels_old:
            changes["crews"] = [crew_labels_old, []]
        pm_labels_old = _pm_labels(conn, list(pm_ids))
        if pm_labels_old:
            changes["project_managers"] = [pm_labels_old, []]

        conn.execute(text("""
            DELETE FROM project_schedule_items
            WHERE id = :sid
        """), {"sid": int(schedule_item_id)})

        record_item_history(conn, int(schedule_item_id), "deleted",
                            actor_user_id, changes or None)

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


def consolidate_orphaned_master_rows() -> dict:
    """
    Repairs a data-integrity issue from a past QBO sync timing bug: projects
    where the master/parent row (is_extra_row=0) was auto-provisioned but
    never received the actual scheduling data, while one or more child rows
    (is_extra_row=1) hold the real schedule.

    For each affected project, this:
      1. Picks the child row with the earliest start_date (tiebreak by id).
      2. Moves any active PM and Crew assignments from the child's schedule
         item ID to the master's schedule item ID.
      3. Copies the child's data fields (status, dates, wire_guidance,
         travel_days, overage_days, equipment_type, notes) into the master row.
      4. Deletes that child row.
      5. Renumbers sort_order on the remaining children: 1, 2, 3, ...
         ordered by start_date ASC (NULLs last), then id ASC.

    A project is only touched if its master row is genuinely "untouched"
    (status='needs_attention' AND start_date IS NULL AND end_date IS NULL).
    Idempotent — safe to run more than once. Returns counts of what happened.
    """
    promoted = 0
    deleted_children = 0
    skipped = 0

    with engine.begin() as conn:
        # Find projects with incomplete master + at least one child with a start_date
        candidates = conn.execute(text("""
            SELECT DISTINCT m.project_id
            FROM myapp.project_schedule_items m
            INNER JOIN myapp.project_schedule_items c
              ON c.project_id = m.project_id
              AND c.is_extra_row = 1
              AND c.start_date IS NOT NULL
            WHERE m.is_extra_row = 0
              AND m.status     = 'needs_attention'
              AND m.start_date IS NULL
              AND m.end_date   IS NULL
        """)).mappings().all()

        project_ids = [row["project_id"] for row in candidates]

        for project_id in project_ids:
            master = conn.execute(text("""
                SELECT id FROM myapp.project_schedule_items
                WHERE project_id = :pid AND is_extra_row = 0
                LIMIT 1
            """), {"pid": project_id}).mappings().first()
            if not master:
                skipped += 1
                continue
            master_id = int(master["id"])

            earliest_child = conn.execute(text("""
                SELECT id, status, start_date, end_date, wire_guidance,
                       travel_days, overage_days, equipment_type, notes
                FROM myapp.project_schedule_items
                WHERE project_id  = :pid
                  AND is_extra_row = 1
                  AND start_date  IS NOT NULL
                ORDER BY start_date ASC, id ASC
                LIMIT 1
            """), {"pid": project_id}).mappings().first()
            if not earliest_child:
                skipped += 1
                continue
            child_id = int(earliest_child["id"])

            # Move PM assignments from the child schedule item to the master.
            # Master had no schedule items prior (it was the untouched default),
            # so there shouldn't be any duplicate-key conflicts.
            conn.execute(text("""
                UPDATE myapp.project_schedule_item_project_managers
                SET schedule_item_id = :master_id
                WHERE schedule_item_id = :child_id
            """), {"master_id": master_id, "child_id": child_id})

            # Move Crew assignments similarly
            conn.execute(text("""
                UPDATE myapp.project_schedule_item_work_crews
                SET schedule_item_id = :master_id
                WHERE schedule_item_id = :child_id
            """), {"master_id": master_id, "child_id": child_id})

            # Copy the child's data fields into the master row
            conn.execute(text("""
                UPDATE myapp.project_schedule_items
                SET status         = :st,
                    start_date     = :sd,
                    end_date       = :ed,
                    wire_guidance  = :wg,
                    travel_days    = :td,
                    overage_days   = :od,
                    equipment_type = :eq,
                    notes          = :notes
                WHERE id = :master_id
            """), {
                "master_id": master_id,
                "st":    earliest_child["status"],
                "sd":    earliest_child["start_date"],
                "ed":    earliest_child["end_date"],
                "wg":    earliest_child["wire_guidance"],
                "td":    earliest_child["travel_days"],
                "od":    earliest_child["overage_days"],
                "eq":    earliest_child["equipment_type"],
                "notes": earliest_child["notes"],
            })
            promoted += 1

            # Delete the now-promoted child row (its assignments were already moved)
            conn.execute(text("""
                DELETE FROM myapp.project_schedule_items WHERE id = :cid
            """), {"cid": child_id})
            deleted_children += 1

            # Renumber sort_order on the remaining children of this project
            remaining = conn.execute(text("""
                SELECT id FROM myapp.project_schedule_items
                WHERE project_id  = :pid
                  AND is_extra_row = 1
                ORDER BY (start_date IS NULL) ASC, start_date ASC, id ASC
            """), {"pid": project_id}).mappings().all()

            for i, child in enumerate(remaining, start=1):
                conn.execute(text("""
                    UPDATE myapp.project_schedule_items
                    SET sort_order = :so
                    WHERE id = :cid
                """), {"so": i, "cid": int(child["id"])})

    return {
        "ok": True,
        "projects_examined": len(project_ids),
        "masters_promoted": promoted,
        "children_deleted": deleted_children,
        "skipped": skipped,
    }


def reset_untouched_master_statuses() -> dict:
    """
    Bulk-resets the status of master schedule-item rows that look auto-provisioned
    and untouched. Sets them to 'needs_attention' so the Assignments page renders
    them with the rose-colored Needs-Attention pill. A row matches if ALL of these
    are true:

      - is_extra_row = 0           (master row, not a user-added extra row)
      - status       = 'not_started'  (the old auto-provisioning default)
      - start_date   IS NULL       (no schedule date set)
      - end_date     IS NULL       (no schedule date set)

    This is intended as a one-time backfill after the auto-provisioning logic was
    changed from 'not_started' to 'needs_attention'. Safe to run more than once —
    idempotent: rows already at 'needs_attention' won't match, and rows the user
    has touched (set dates or moved status off 'not_started') won't match either.
    """
    with engine.begin() as conn:
        result = conn.execute(text("""
            UPDATE myapp.project_schedule_items
            SET status = 'needs_attention'
            WHERE is_extra_row = 0
              AND status       = 'not_started'
              AND start_date   IS NULL
              AND end_date     IS NULL
        """))
        return {"ok": True, "updated_rows": int(result.rowcount or 0)}


def refresh_project_financial_summary() -> dict:
    """
    Recomputes per-project financial aggregates and writes them to
    project_financial_summary. This is the heavy CTE work that used to run
    on every page load — now run once per QBO sync (or manually) so the
    /projects/financials endpoint can do a trivial SELECT.

    Safe to call repeatedly; uses INSERT ... ON DUPLICATE KEY UPDATE.
    Also deletes stale rows for customers that are no longer is_project=1.
    """
    with engine.begin() as conn:
        # Table is created by qbo_init_tables() but we self-heal here in case
        # a caller reached this function before any QBO operation ran.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS project_financial_summary (
              qbo_customer_id      INT NOT NULL PRIMARY KEY,
              project_qbo_id       VARCHAR(32) NULL,
              estimate_cost_amt    DECIMAL(18,2) NOT NULL DEFAULT 0,
              estimate_line_amt    DECIMAL(18,2) NOT NULL DEFAULT 0,
              invoice_line_amt     DECIMAL(18,2) NOT NULL DEFAULT 0,
              expense_line_amt    DECIMAL(18,2) NOT NULL DEFAULT 0,
              invoice_balance_amt  DECIMAL(18,2) NOT NULL DEFAULT 0,
              open_invoice_count   INT NOT NULL DEFAULT 0,
              open_invoice_total_amt DECIMAL(18,2) NOT NULL DEFAULT 0,
              balance_amt          DECIMAL(18,2) NOT NULL DEFAULT 0,
              actual_profit        DECIMAL(18,2) NOT NULL DEFAULT 0,
              actual_profit_pct    DECIMAL(12,8) NULL,
              projected_profit     DECIMAL(18,2) NOT NULL DEFAULT 0,
              projected_profit_pct DECIMAL(12,8) NULL,
              cost_diff_amt        DECIMAL(18,2) NOT NULL DEFAULT 0,
              cost_diff_pct        DECIMAL(12,8) NULL,
              updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              INDEX idx_pfs_qbo (project_qbo_id)
            ) ENGINE=InnoDB
        """))

        # Migration: add open_invoice_total_amt to existing tables that pre-date it.
        # Wrapped in try/except because the column may already exist on fresh installs.
        try:
            conn.execute(text("""
                ALTER TABLE myapp.project_financial_summary
                ADD COLUMN open_invoice_total_amt DECIMAL(18,2) NOT NULL DEFAULT 0
                  AFTER open_invoice_count
            """))
        except Exception:
            pass  # column already exists, no-op

        result = conn.execute(text("""
            INSERT INTO myapp.project_financial_summary (
              qbo_customer_id, project_qbo_id,
              estimate_cost_amt, estimate_line_amt, invoice_line_amt, expense_line_amt,
              invoice_balance_amt, open_invoice_count, open_invoice_total_amt, balance_amt,
              actual_profit, actual_profit_pct,
              projected_profit, projected_profit_pct,
              cost_diff_amt, cost_diff_pct
            )
            WITH
            latest_sales_txns AS (
              SELECT *
              FROM (
                SELECT qt.*,
                       ROW_NUMBER() OVER (
                         PARTITION BY qt.customer_qbo_id, qt.entity_type,
                                      COALESCE(qt.doc_number, CONCAT('__nodoc__', qt.qbo_id))
                         ORDER BY qt.id DESC
                       ) AS _rn
                FROM myapp.qbo_transactions qt
                INNER JOIN myapp.qbo_customers qc_proj
                  ON qc_proj.qbo_id = qt.customer_qbo_id
                  AND qc_proj.is_project = 1
                WHERE qt.entity_type IN ('Invoice', 'Estimate', 'SalesReceipt', 'CreditMemo')
                  AND (qt.total_amt IS NULL OR qt.total_amt > 0)
                  -- Estimates: only count Accepted/Converted/Closed in financials.
                  -- Pending and Rejected are surfaced separately in the Estimates-by-Status modal.
                  AND (
                    qt.entity_type <> 'Estimate'
                    OR JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted', 'Closed')
                  )
              ) _ranked
              WHERE _rn = 1
            ),

            sales_lines AS (
              SELECT
                qc.qbo_id                      AS project_qbo_id,
                qt.entity_type,
                qstl.amount                    AS line_amount,
                qstl.cost_amount               AS line_cost_amount
              FROM myapp.qbo_customers qc
              INNER JOIN latest_sales_txns qt
                ON qt.customer_qbo_id = qc.qbo_id
              LEFT JOIN myapp.qbo_sales_transaction_lines qstl
                ON qstl.transaction_id = qt.id
                AND qstl.line_level = 'child'
              WHERE qc.is_project = 1
            ),

            expense_lines AS (
              SELECT
                qc.qbo_id                      AS project_qbo_id,
                CASE
                  WHEN qt.entity_type = 'VendorCredit' THEN -qtl.amount
                  WHEN qt.entity_type = 'Purchase'
                       AND JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.Credit')) = 'true'
                    THEN -qtl.amount
                  ELSE qtl.amount
                END                            AS line_amount
              FROM myapp.qbo_customers qc
              INNER JOIN myapp.qbo_transaction_lines qtl
                ON qtl.line_customer_qbo_id = qc.qbo_id
              INNER JOIN myapp.qbo_transactions qt
                ON qt.id = qtl.transaction_id
                AND qt.entity_type IN ('Bill', 'Check', 'CreditCardCharge', 'Purchase', 'PurchaseOrder', 'VendorCredit')
              WHERE qc.is_project = 1
            ),

            ar_lines AS (
              SELECT
                qc.qbo_id                AS project_qbo_id,
                qt.id                    AS transaction_id,
                qt.balance_amt,
                qt.total_amt
              FROM myapp.qbo_customers qc
              INNER JOIN latest_sales_txns qt
                ON qt.customer_qbo_id = qc.qbo_id
                AND qt.entity_type = 'Invoice'
              WHERE qc.is_project = 1
            ),

            sales_rollup AS (
              SELECT
                project_qbo_id,
                SUM(CASE WHEN entity_type = 'Estimate' THEN COALESCE(line_cost_amount, 0) ELSE 0 END) AS estimate_cost_amt,
                SUM(CASE WHEN entity_type = 'Estimate' THEN COALESCE(line_amount,      0) ELSE 0 END) AS estimate_line_amt,
                SUM(CASE WHEN entity_type = 'Invoice'  THEN COALESCE(line_amount,      0) ELSE 0 END) AS invoice_line_amt
              FROM sales_lines
              GROUP BY project_qbo_id
            ),

            expense_rollup AS (
              SELECT
                project_qbo_id,
                SUM(COALESCE(line_amount, 0)) AS expense_line_amt
              FROM expense_lines
              GROUP BY project_qbo_id
            ),

            ar_rollup AS (
              SELECT
                project_qbo_id,
                SUM(COALESCE(balance_amt, 0))                    AS invoice_balance_amt,
                SUM(CASE WHEN balance_amt > 0 THEN 1 ELSE 0 END) AS open_invoice_count,
                SUM(CASE WHEN balance_amt > 0 THEN COALESCE(total_amt, 0) ELSE 0 END) AS open_invoice_total_amt
              FROM ar_lines
              GROUP BY project_qbo_id
            ),

            -- Contract value = the accepted estimates' HEADER totals (what the
            -- customer was quoted). The sum of child line items is unreliable:
            -- grouped/optional/quantity lines can sum above or below the header
            -- (e.g. #3635 lines $98,092 vs header $34,332). The header is truth.
            estimate_header AS (
              SELECT qc.qbo_id AS project_qbo_id,
                     SUM(COALESCE(qt.total_amt, 0)) AS estimate_header_amt
              FROM myapp.qbo_customers qc
              INNER JOIN latest_sales_txns qt
                ON qt.customer_qbo_id = qc.qbo_id AND qt.entity_type = 'Estimate'
              WHERE qc.is_project = 1
              GROUP BY qc.qbo_id
            )
            SELECT
              qc.id,
              qc.qbo_id,

              COALESCE(sr.estimate_cost_amt, 0),
              COALESCE(eh.estimate_header_amt, 0),
              COALESCE(sr.invoice_line_amt,  0),
              COALESCE(er.expense_line_amt,  0),
              COALESCE(ar.invoice_balance_amt, 0),
              COALESCE(ar.open_invoice_count, 0),
              COALESCE(ar.open_invoice_total_amt, 0),

              (COALESCE(sr.invoice_line_amt, 0) - COALESCE(er.expense_line_amt, 0)),
              (COALESCE(sr.invoice_line_amt, 0) - COALESCE(er.expense_line_amt, 0)),
              CASE
                WHEN COALESCE(sr.invoice_line_amt, 0) = 0 THEN NULL
                ELSE (COALESCE(sr.invoice_line_amt, 0) - COALESCE(er.expense_line_amt, 0))
                     / COALESCE(sr.invoice_line_amt, 0)
              END,
              (COALESCE(eh.estimate_header_amt, 0) - COALESCE(sr.estimate_cost_amt, 0)),
              CASE
                WHEN COALESCE(eh.estimate_header_amt, 0) = 0 THEN NULL
                ELSE (COALESCE(eh.estimate_header_amt, 0) - COALESCE(sr.estimate_cost_amt, 0))
                     / COALESCE(eh.estimate_header_amt, 0)
              END,
              (COALESCE(sr.estimate_cost_amt, 0) - COALESCE(er.expense_line_amt, 0)),
              CASE
                WHEN COALESCE(sr.estimate_cost_amt, 0) = 0 THEN NULL
                ELSE (COALESCE(sr.estimate_cost_amt, 0) - COALESCE(er.expense_line_amt, 0))
                     / COALESCE(sr.estimate_cost_amt, 0)
              END

            FROM myapp.qbo_customers qc
            LEFT JOIN sales_rollup     sr ON sr.project_qbo_id = qc.qbo_id
            LEFT JOIN estimate_header  eh ON eh.project_qbo_id = qc.qbo_id
            LEFT JOIN expense_rollup   er ON er.project_qbo_id = qc.qbo_id
            LEFT JOIN ar_rollup        ar ON ar.project_qbo_id = qc.qbo_id
            WHERE qc.is_project = 1

            ON DUPLICATE KEY UPDATE
              project_qbo_id       = VALUES(project_qbo_id),
              estimate_cost_amt    = VALUES(estimate_cost_amt),
              estimate_line_amt    = VALUES(estimate_line_amt),
              invoice_line_amt     = VALUES(invoice_line_amt),
              expense_line_amt     = VALUES(expense_line_amt),
              invoice_balance_amt    = VALUES(invoice_balance_amt),
              open_invoice_count     = VALUES(open_invoice_count),
              open_invoice_total_amt = VALUES(open_invoice_total_amt),
              balance_amt            = VALUES(balance_amt),
              actual_profit        = VALUES(actual_profit),
              actual_profit_pct    = VALUES(actual_profit_pct),
              projected_profit     = VALUES(projected_profit),
              projected_profit_pct = VALUES(projected_profit_pct),
              cost_diff_amt        = VALUES(cost_diff_amt),
              cost_diff_pct        = VALUES(cost_diff_pct)
        """))
        upserted = result.rowcount  # note: MySQL counts updated rows as 2

        # Clean up rows for customers that are no longer is_project=1 (or were deleted)
        deleted = conn.execute(text("""
            DELETE pfs FROM myapp.project_financial_summary pfs
            LEFT JOIN myapp.qbo_customers qc
              ON qc.id = pfs.qbo_customer_id
              AND qc.is_project = 1
            WHERE qc.id IS NULL
        """)).rowcount

    return {"ok": True, "upserted_rows": int(upserted or 0), "deleted_rows": int(deleted or 0)}