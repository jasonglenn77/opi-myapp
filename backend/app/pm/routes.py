"""
PM Portal (Phase 1) — the project manager's own workspace.

One read endpoint: the logged-in user's PM projects, resolved through the real
link chain (the same one permissions.visible_project_ids uses):

    users.project_manager_id  →  project_managers.id
      →  project_schedule_item_project_managers.project_manager_id
           (unassigned_at IS NULL = active assignment)
      →  project_schedule_items  →  projects  →  qbo_customers

Split into "active" vs "upcoming" by the SAME status buckets the office pages
use (projects-hub / crew-hub): a project's operational status is its FINAL
assignment row's status; in_progress = active, needs_attention / pending /
not_started = upcoming, completed / canceled = done (excluded from the lists,
counted). `?all=1` returns every project (Jason's expand-to-all toggle).

Kickoff & Daily Log & Documents on the PM project detail page reuse the
existing /api/kickoff, /api/daily and /api/documents endpoints (their gates
were widened to accept page.pm_portal). No write endpoints here in Phase 1.
"""
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text

from app.db import engine
from app.auth import require_capability
from app.permissions import PAGE_PM_PORTAL

router = APIRouter(prefix="/api/pm", tags=["pm"])

# Same buckets as the office (projects-hub OP_STATUS / crew-hub ACTIVE set).
ACTIVE_STATUSES = {"in_progress"}
DONE_STATUSES = {"completed", "canceled"}
# everything else (needs_attention / pending / not_started / …) = upcoming


@router.get("/projects")
def pm_projects(all: int = 0, user=Depends(require_capability(PAGE_PM_PORTAL))):
    """The caller's PM projects (default) or every project (?all=1), split
    active vs upcoming, with name / QBO id / status / schedule window /
    customer. Read-only; no profitability on purpose."""
    pm_id = user.get("project_manager_id") or -1
    show_all = bool(all)

    with engine.connect() as conn:
        pm_row = None
        if pm_id != -1:
            pm_row = conn.execute(text("""
                SELECT id, TRIM(CONCAT(COALESCE(first_name,''),' ',COALESCE(last_name,''))) AS name
                FROM project_managers WHERE id = :pm
            """), {"pm": pm_id}).mappings().first()

        rows = conn.execute(text("""
            WITH latest_status AS (
              SELECT qbo_customer_id, status FROM (
                SELECT p.qbo_customer_id, psi.status,
                       ROW_NUMBER() OVER (PARTITION BY p.qbo_customer_id
                         ORDER BY psi.start_date IS NULL, psi.start_date DESC,
                                  psi.sort_order DESC, psi.id DESC) AS rn
                FROM projects p
                JOIN project_schedule_items psi ON psi.project_id = p.id
              ) x WHERE rn = 1
            ),
            win AS (
              SELECT p.qbo_customer_id,
                     MIN(psi.start_date) AS start_date,
                     MAX(psi.end_date)   AS end_date
              FROM projects p
              JOIN project_schedule_items psi ON psi.project_id = p.id
              GROUP BY p.qbo_customer_id
            ),
            pms AS (
              SELECT p.qbo_customer_id,
                     GROUP_CONCAT(DISTINCT TRIM(CONCAT(COALESCE(m.first_name,''),' ',
                         COALESCE(m.last_name,'')))
                       ORDER BY spm.is_primary DESC, m.last_name, m.first_name
                       SEPARATOR ', ') AS pm_names,
                     MAX(spm.project_manager_id = :pm) AS is_mine
              FROM projects p
              JOIN project_schedule_items psi ON psi.project_id = p.id
              JOIN project_schedule_item_project_managers spm ON spm.schedule_item_id = psi.id
              LEFT JOIN project_managers m ON m.id = spm.project_manager_id
              WHERE spm.unassigned_at IS NULL
              GROUP BY p.qbo_customer_id
            )
            SELECT qc.qbo_id, qc.display_name, qc.parent_qbo_id,
                   COALESCE(ls.status, 'needs_attention') AS status,
                   w.start_date, w.end_date,
                   COALESCE(px.pm_names, '') AS pm_names,
                   COALESCE(px.is_mine, 0)   AS is_mine
            FROM qbo_customers qc
            JOIN projects p ON p.qbo_customer_id = qc.id
            LEFT JOIN latest_status ls ON ls.qbo_customer_id = qc.id
            LEFT JOIN win w  ON w.qbo_customer_id  = qc.id
            LEFT JOIN pms px ON px.qbo_customer_id = qc.id
            WHERE qc.is_project = 1
            ORDER BY w.start_date IS NULL, w.start_date, qc.display_name
        """), {"pm": pm_id}).mappings().all()

        # Root-customer names via one pass over the (small) customer tree.
        parents = {r["qbo_id"]: (r["display_name"], r["parent_qbo_id"]) for r in
                   conn.execute(text(
                       "SELECT qbo_id, display_name, parent_qbo_id FROM qbo_customers"
                   )).mappings().all()}

    def root_customer(qbo_id):
        name, pq, guard = None, qbo_id, 0
        while pq and pq in parents and guard < 10:
            name, pq, guard = parents[pq][0], parents[pq][1], guard + 1
        return name

    active, upcoming, done_count, mine_count = [], [], 0, 0
    for r in rows:
        mine = bool(r["is_mine"])
        if mine:
            mine_count += 1
        if not show_all and not mine:
            continue
        st = (r["status"] or "").lower()
        if st in DONE_STATUSES:
            done_count += 1
            continue
        item = {
            "qbo_id": str(r["qbo_id"]),
            "name": r["display_name"],
            "customer": root_customer(r["parent_qbo_id"]) or r["display_name"],
            "status": st,
            "start_date": str(r["start_date"]) if r["start_date"] else None,
            "end_date": str(r["end_date"]) if r["end_date"] else None,
            "pm_names": r["pm_names"] or None,
            "is_mine": mine,
        }
        (active if st in ACTIVE_STATUSES else upcoming).append(item)

    return {
        "pm": ({"id": pm_row["id"], "name": (pm_row["name"] or "").strip() or None}
               if pm_row else None),
        "scope": "all" if show_all else "mine",
        "active": active,
        "upcoming": upcoming,
        "counts": {"active": len(active), "upcoming": len(upcoming),
                   "done": done_count, "mine": mine_count},
    }


def _pfs_row(conn, qbo_id):
    """The project's row in project_financial_summary — the SAME pre-computed
    QBO rollup the All Projects hub reads (/projects + /projects/financials).
    estimate_line_amt = accepted-estimate contract incl. change orders;
    projected_profit(_pct) = estimate_line_amt − estimate_cost_amt (the hub's
    'estimated profit' column formula, computed in projects/routes.py SQL)."""
    return conn.execute(text("""
        SELECT pfs.estimate_line_amt, pfs.estimate_cost_amt, pfs.invoice_line_amt,
               pfs.projected_profit, pfs.projected_profit_pct
        FROM project_financial_summary pfs
        JOIN qbo_customers qc ON qc.id = pfs.qbo_customer_id
        WHERE qc.qbo_id = :e LIMIT 1
    """), {"e": qbo_id}).mappings().first()


def _contract_block(pfs, inv):
    """Canonical project value (Jason 2026-09-22): TIE TO ALL PROJECTS —
    project_financial_summary.estimate_line_amt. Fall back to the billing
    compose total ONLY when the pfs row is missing (flagged via source).
    est_profit/est_margin_pct mirror the hub's estimated-profit column:
    projected_profit = estimate_line_amt − estimate_cost_amt,
    pct = projected_profit / estimate_line_amt (×100 here, like the hub UI)."""
    billing_total = inv["summary"]["total"]
    if pfs is None:
        return {
            "project_value": billing_total, "value_source": "billing_schedule",
            "billing_schedule_total": billing_total,
            "est_profit": None, "est_margin_pct": None,
            "estimate_cost_amt": None, "invoiced_to_date": inv["invoiced_qbo"],
        }
    contract = round(float(pfs["estimate_line_amt"] or 0), 2)
    est_cost = round(float(pfs["estimate_cost_amt"] or 0), 2)
    est_profit = round(contract - est_cost, 2)
    est_margin = round(est_profit / contract * 100, 1) if contract else None
    return {
        "project_value": contract, "value_source": "qbo_estimate",
        "billing_schedule_total": billing_total,
        "est_profit": est_profit, "est_margin_pct": est_margin,
        "estimate_cost_amt": est_cost, "invoiced_to_date": inv["invoiced_qbo"],
    }


# ── Overview tab (Design v3, Milestone B) ────────────────────────────────────
# One aggregate for the PM project detail's default tab: the Assignment-phase
# facts, the office Billing & Schedule tab's financial rollups (REUSED, not
# recomputed differently), and a PM-lane/Crew-lane tracking list.
@router.get("/project/{qbo_id}/overview")
def pm_project_overview(qbo_id: str, user=Depends(require_capability(PAGE_PM_PORTAL))):
    # Reuse the office Billing & Schedule computations verbatim so the PM sees
    # the SAME numbers the office sees (billing/routes.py get_bundle). The
    # create-if-missing schedule seeding is part of that contract — it's the
    # same idempotent auto-seed the office tab performs on first open.
    from app.billing.routes import (
        _canonical_status, _compose_invoices, _compose_crew, _compose_expenses,
        _ensure_estimate_billing, _ensure_invoice_schedules, _ensure_crew_schedules,
        _ensure_expense_items, _ensure_expense_installments,
        _default_crew_for_project, _all_crew_vendor_ids,
    )
    from app.invoices.routes import _project_ctx
    from app.payments.routes import _project_meta
    from app.kickoff.routes import MILESTONES
    from app.forms.routes import form_status_rows

    with engine.begin() as conn:
        ctx = _project_ctx(conn, qbo_id)
        if not ctx:
            raise HTTPException(status_code=404, detail="Project not found")
        meta = _project_meta(conn, qbo_id) or {}

        # ── assignment block (Assignment page's real tables) ─────────────────
        # Flags/notes come from the project's FINAL schedule item — the same
        # ROW_NUMBER order /api/pm/projects and the hub use for canonical status.
        item = conn.execute(text("""
            SELECT psi.status, psi.wire_guidance, psi.travel_days, psi.overage_days,
                   psi.equipment_type, psi.notes
            FROM projects p
            JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
            JOIN project_schedule_items psi ON psi.project_id = p.id
            WHERE qc.qbo_id = :e
            ORDER BY psi.start_date IS NULL, psi.start_date DESC,
                     psi.sort_order DESC, psi.id DESC
            LIMIT 1
        """), {"e": qbo_id}).mappings().first()

        pms = conn.execute(text("""
            SELECT TRIM(CONCAT(COALESCE(m.first_name,''),' ',COALESCE(m.last_name,''))) AS name,
                   MAX(spm.is_primary) AS is_primary, MIN(spm.created_at) AS assigned_at
            FROM projects p
            JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
            JOIN project_schedule_items psi ON psi.project_id = p.id
            JOIN project_schedule_item_project_managers spm ON spm.schedule_item_id = psi.id
            JOIN project_managers m ON m.id = spm.project_manager_id
            WHERE qc.qbo_id = :e AND spm.unassigned_at IS NULL
            GROUP BY m.id ORDER BY is_primary DESC, name
        """), {"e": qbo_id}).mappings().all()

        crews = conn.execute(text("""
            SELECT wc.id, wc.name, MAX(swc.is_primary) AS is_primary, MIN(swc.created_at) AS assigned_at
            FROM projects p
            JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
            JOIN project_schedule_items psi ON psi.project_id = p.id
            JOIN project_schedule_item_work_crews swc ON swc.schedule_item_id = psi.id
            JOIN work_crews wc ON wc.id = swc.work_crew_id
            WHERE qc.qbo_id = :e AND swc.unassigned_at IS NULL
            GROUP BY wc.id ORDER BY is_primary DESC, wc.name
        """), {"e": qbo_id}).mappings().all()

        # ── financials (mirror of billing get_bundle) ────────────────────────
        _ensure_estimate_billing(conn, qbo_id, _default_crew_for_project(conn, qbo_id, meta))
        _ensure_invoice_schedules(conn, qbo_id, ctx)
        _ensure_crew_schedules(conn, qbo_id, ctx, meta)
        _ensure_expense_items(conn, qbo_id, ctx)
        _ensure_expense_installments(conn, qbo_id, ctx)

        op_status = _canonical_status(conn, qbo_id)
        books_closed = op_status == "completed"
        crew_vendor_ids = _all_crew_vendor_ids(conn, qbo_id)
        inv = _compose_invoices(conn, qbo_id, books_closed)
        crew = _compose_crew(conn, qbo_id, meta, crew_vendor_ids, books_closed)
        exp = _compose_expenses(conn, qbo_id, books_closed)
        pfs = _pfs_row(conn, qbo_id)

        # ── tracking: PM lane ────────────────────────────────────────────────
        kick_done = conn.execute(text(
            "SELECT COUNT(*) FROM project_milestones WHERE entity_id = :e AND done = 1"),
            {"e": qbo_id}).scalar() or 0
        kick_total = len(MILESTONES)
        last_log = conn.execute(text(
            "SELECT MAX(log_date) FROM project_daily_log WHERE entity_id = :e"),
            {"e": qbo_id}).scalar()

        # ── tracking: Crew lane — the SAME rows GET /api/forms/status serves:
        # merged templates + submission stats + the cadence status engine
        # (required, cadence, day exclusions, status, overdue_days and the
        # {expected_so_far, filled} progress counts from app/forms/status.py).
        crew_forms, _st, _win = form_status_rows(conn, qbo_id, project_status=op_status)

    kick_status = ("complete" if kick_total and kick_done >= kick_total
                   else "in_progress" if kick_done else "not_started")
    last_log_s = str(last_log) if last_log else None

    return {
        "project": {"qbo_id": str(qbo_id), "name": ctx["name"], "status": op_status,
                    "customer": meta.get("customer_name"),
                    "start_date": ctx.get("start_date"), "end_date": ctx.get("end_date")},
        "assignment": {
            "pms": [{"name": (r["name"] or "").strip() or None,
                     "is_primary": bool(r["is_primary"]),
                     "assigned_at": str(r["assigned_at"]) if r["assigned_at"] else None}
                    for r in pms],
            "crews": [{"id": r["id"], "name": r["name"], "is_primary": bool(r["is_primary"]),
                       "assigned_at": str(r["assigned_at"]) if r["assigned_at"] else None}
                      for r in crews],
            "start_date": ctx.get("start_date"), "end_date": ctx.get("end_date"),
            "wire_guidance": bool(item["wire_guidance"]) if item else False,
            "travel_days": int(item["travel_days"] or 0) if item else 0,
            "overage_days": int(item["overage_days"] or 0) if item else 0,
            "equipment": (item["equipment_type"] if item else None) or None,
            "notes": (item["notes"] if item else None) or None,
        },
        "financials": {
            # CANONICAL project value (2026-09-22 tie-out): the same
            # estimate_line_amt the All Projects hub shows — NOT the billing
            # schedule total (which only covers milestones set up so far).
            # _contract_block also carries est profit/margin (hub formula),
            # value_source ('qbo_estimate' | 'billing_schedule' fallback) and
            # billing_schedule_total for the coverage note.
            **_contract_block(pfs, inv),
            "books_closed": books_closed,
            # over_under = actual − scheduled (signed): positive = over.
            "crew": {"scheduled_total": crew["summary"]["total"],
                     "paid_total": crew["paid_qbo"],
                     "over_under": round(crew["paid_qbo"] - crew["summary"]["total"], 2)},
            "expenses": [{"category": c["category"],
                          "scheduled_total": c["estimated"],
                          "actual_total": c["actual"],
                          "over_under": round(c["actual"] - c["estimated"], 2)}
                         for c in exp["by_category"]],
        },
        "tracking": {
            "kickoff": {"items_done": int(kick_done), "items_total": kick_total,
                        "status": kick_status},
            "daily_log": {"last_date": last_log_s,
                          "logged_today": last_log_s == date.today().isoformat()},
            "crew_forms": crew_forms,
        },
    }


# ── Financials tab (Design v3 item 4 — UNPARKED 2026-09-22) ─────────────────
# Read-only deep dive mirroring the office Billing & Schedule tab for ONE
# project: the SAME composers (_compose_invoices/_compose_crew/_compose_expenses
# — math is NOT re-implemented here) plus the pfs contract numbers so the
# page can show "Billing schedule covers $X of the $Y contract". No write
# endpoints — the office edits schedules on Billing & Schedule.
@router.get("/project/{qbo_id}/financials")
def pm_project_financials(qbo_id: str, user=Depends(require_capability(PAGE_PM_PORTAL))):
    from app.billing.routes import (
        _canonical_status, _compose_invoices, _compose_crew, _compose_expenses,
        _ensure_estimate_billing, _ensure_invoice_schedules, _ensure_crew_schedules,
        _ensure_expense_items, _ensure_expense_installments,
        _default_crew_for_project, _all_crew_vendor_ids,
    )
    from app.invoices.routes import _project_ctx
    from app.payments.routes import _project_meta

    with engine.begin() as conn:
        ctx = _project_ctx(conn, qbo_id)
        if not ctx:
            raise HTTPException(status_code=404, detail="Project not found")
        meta = _project_meta(conn, qbo_id) or {}

        # Same idempotent create-if-missing seeding the office tab performs.
        _ensure_estimate_billing(conn, qbo_id, _default_crew_for_project(conn, qbo_id, meta))
        _ensure_invoice_schedules(conn, qbo_id, ctx)
        _ensure_crew_schedules(conn, qbo_id, ctx, meta)
        _ensure_expense_items(conn, qbo_id, ctx)
        _ensure_expense_installments(conn, qbo_id, ctx)

        op_status = _canonical_status(conn, qbo_id)
        books_closed = op_status == "completed"
        crew_vendor_ids = _all_crew_vendor_ids(conn, qbo_id)
        inv = _compose_invoices(conn, qbo_id, books_closed)
        crew = _compose_crew(conn, qbo_id, meta, crew_vendor_ids, books_closed)
        exp = _compose_expenses(conn, qbo_id, books_closed)
        pfs = _pfs_row(conn, qbo_id)

    return {
        "project": {"qbo_id": str(qbo_id), "name": ctx["name"],
                    "customer": meta.get("customer_name"), "status": op_status,
                    "start_date": ctx.get("start_date"), "end_date": ctx.get("end_date"),
                    "books_closed": books_closed},
        # Contract tie-out block: project_value = pfs.estimate_line_amt (All
        # Projects), billing_schedule_total = inv.summary.total, + est profit.
        "contract": _contract_block(pfs, inv),
        "invoices": inv,      # milestones + actual QBO invoices + summary bar
        "crew": crew,         # installment schedule + actual Contract-Labor bills
        "expenses": exp,      # per-category weekly schedule vs actual QBO spend
    }
