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
                # 'needs_attention' is a system-set status (NOT in ALLOWED_STATUS,
                # so users can't pick it from the edit dropdown). It signals "the
                # master row exists but the user hasn't picked a real status yet."
                # As soon as the user chooses one of the four user-pickable statuses
                # via save_schedule_item(), the value is overwritten and the row
                # leaves the Needs-Attention state.
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
            )
            SELECT
              qc.id,
              qc.qbo_id,

              COALESCE(sr.estimate_cost_amt, 0),
              COALESCE(sr.estimate_line_amt, 0),
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
              (COALESCE(sr.estimate_line_amt, 0) - COALESCE(sr.estimate_cost_amt, 0)),
              CASE
                WHEN COALESCE(sr.estimate_line_amt, 0) = 0 THEN NULL
                ELSE (COALESCE(sr.estimate_line_amt, 0) - COALESCE(sr.estimate_cost_amt, 0))
                     / COALESCE(sr.estimate_line_amt, 0)
              END,
              (COALESCE(sr.estimate_cost_amt, 0) - COALESCE(er.expense_line_amt, 0)),
              CASE
                WHEN COALESCE(sr.estimate_cost_amt, 0) = 0 THEN NULL
                ELSE (COALESCE(sr.estimate_cost_amt, 0) - COALESCE(er.expense_line_amt, 0))
                     / COALESCE(sr.estimate_cost_amt, 0)
              END

            FROM myapp.qbo_customers qc
            LEFT JOIN sales_rollup   sr ON sr.project_qbo_id = qc.qbo_id
            LEFT JOIN expense_rollup er ON er.project_qbo_id = qc.qbo_id
            LEFT JOIN ar_rollup      ar ON ar.project_qbo_id = qc.qbo_id
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