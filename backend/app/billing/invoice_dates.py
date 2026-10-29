"""
Planned invoice dates from the job dates + OPI's billing history (migration 0087).

Owner rules (2026-10-28):
  * Larger jobs bill 35% at PO / 35% at start / 30% at completion. Small jobs and
    change orders bill once, in full, at completion. "Small" is measured: the
    estimate size under which most of OPI's estimates were billed in one invoice
    (assumptions/calibrate.py measure_invoice_timing, shown on the Assumptions page).
  * Mobilization is invoiced on the project start date; the Final (and a single
    full invoice) on the end date. When the job dates move, these move with them.
  * Due date = invoice date + the schedule's net terms. Expected paid = invoice
    date + how long customers have actually taken to pay that kind of invoice.
    The deposit (no job-date rule) uses its measured timing before the start.

Only rows the app placed (date_basis 'auto_history') are moved. A date a person
set (date_basis 'manual') and a row that IS a QuickBooks invoice ('invoice') are
never touched. Completed projects are left alone (their leftover balance is a
Data Review item, not a forecast).
"""
from datetime import date, timedelta

from sqlalchemy import text

from app.db import engine
from app.audit import record_audit
from app.assumptions import calibrate as CAL

SYSTEM_ACTOR = {"id": None, "email": "system:invoice-dates"}
FULL_LABEL = CAL.INVOICE_KINDS["full"]["label"]


def _d(v):
    if not v:
        return None
    return v if isinstance(v, date) else date.fromisoformat(str(v)[:10])


def plan_dates(kind, start, end, net_days, it, est_date=None):
    """(invoice_date, due_date, expected_paid_date) for a milestone kind, or None
    when the job date it follows isn't set yet."""
    k = (it.get("kinds") or {}).get(kind)
    if not k:
        return None
    anchor = _d(start) if k.get("anchor") == "start" else _d(end)
    if not anchor:
        return None
    inv = anchor + timedelta(days=int(round(float(k.get("offset_days") or 0))))
    est_date = _d(est_date)
    if kind == "deposit" and est_date and inv < est_date:
        inv = est_date                       # can't bill the deposit before the estimate exists
    due = inv + timedelta(days=int(net_days if net_days is not None else 30))
    lag = k.get("paid_lag_days")
    exp = inv + timedelta(days=int(float(lag) + 0.5)) if lag is not None else due   # half-days round up (as shown)
    return inv, due, exp


def single_invoice(value, is_change_order, it):
    """Bill this estimate in one invoice (small job or change order)?"""
    if is_change_order and it.get("change_orders_single", True):
        return True
    return float(value or 0) < float(it.get("single_below") or 0)


def change_order_ids(conn, entity_id):
    """Estimate qbo_ids the Change Orders tab treats as change orders: every
    estimate after the project's first, unless the office set its kind."""
    from app.change_orders.routes import _project_estimates, _overlays
    kinds = {str(o["qbo_estimate_id"]): o["kind"] for o in _overlays(conn, entity_id) if o["qbo_estimate_id"]}
    return {str(e["qbo_id"]) for i, e in enumerate(_project_estimates(conn, entity_id))
            if kinds.get(str(e["qbo_id"]), "original" if i == 0 else "change_order") == "change_order"}


def _ctx(conn, entity_id):
    r = conn.execute(text("""
        SELECT MIN(psi.start_date), MAX(psi.end_date)
        FROM qbo_customers qc JOIN projects p ON p.qbo_customer_id = qc.id
        JOIN project_schedule_items psi ON psi.project_id = p.id
        WHERE qc.qbo_id = :e AND qc.is_project = 1
    """), {"e": entity_id}).first()
    return (r[0], r[1]) if r else (None, None)


def _completed(conn, entity_id):
    from app.billing.routes import _canonical_status
    return _canonical_status(conn, entity_id) == "completed"


def _has_custom_terms(conn, entity_id):
    return bool(conn.execute(text(
        "SELECT 1 FROM project_billing_terms WHERE entity_id = :e AND (terms_percents IS NOT NULL OR terms_net_days IS NOT NULL)"),
        {"e": entity_id}).first())


def resplit_untouched(conn, entity_id, it):
    """A 35/35/30 plan nobody has touched (nothing invoiced, no edits, no custom
    project terms) on a small job or change order becomes one full invoice at
    completion. Returns [(schedule_id, estimate doc)] converted."""
    if _has_custom_terms(conn, entity_id):
        return []
    scheds = conn.execute(text("""
        SELECT s.id, s.estimate_qbo_id, s.estimate_doc_number, s.contract_value, s.net_days,
               COUNT(m.id) AS n, SUM(m.qbo_invoice_id IS NOT NULL) AS inv, SUM(m.edited) AS ed, SUM(m.amount_edited) AS aed
        FROM project_invoice_schedules s JOIN project_invoice_milestones m ON m.schedule_id = s.id
        WHERE s.entity_id = :e AND s.estimate_qbo_id IS NOT NULL
        GROUP BY s.id, s.estimate_qbo_id, s.estimate_doc_number, s.contract_value, s.net_days
    """), {"e": entity_id}).mappings().all()
    if not scheds:
        return []
    cos = change_order_ids(conn, entity_id)
    out = []
    for s in scheds:
        if s["n"] < 2 or s["inv"] or s["ed"] or s["aed"]:
            continue
        is_co = str(s["estimate_qbo_id"]) in cos
        if not single_invoice(s["contract_value"], is_co, it):
            continue
        conn.execute(text("DELETE FROM project_invoice_milestones WHERE schedule_id = :s"), {"s": s["id"]})
        conn.execute(text("""
            INSERT INTO project_invoice_milestones (schedule_id, seq, label, pct, amount, status, date_basis)
            VALUES (:s, 1, :l, 100, :a, 'pending', 'auto_history')
        """), {"s": s["id"], "l": FULL_LABEL, "a": s["contract_value"]})
        conn.execute(text("UPDATE project_invoice_schedules SET terms_note = :t WHERE id = :s"),
                     {"t": f"100% at completion, net-{s['net_days'] or 30}", "s": s["id"]})
        out.append((s["id"], s["estimate_doc_number"], "change order" if is_co else "small job"))
    return out


def redate_project(conn, entity_id, it=None, audit=True):
    """Place / re-place the app-dated invoice milestones on one project from its
    current job dates. Writes inside `conn`'s transaction. Returns the changes."""
    it = it or CAL.invoice_timing(conn)
    if _completed(conn, entity_id):
        return []
    converted = resplit_untouched(conn, entity_id, it)
    start, end = _ctx(conn, entity_id)
    rows = conn.execute(text("""
        SELECT m.id, m.label, m.invoice_date, m.due_date, m.expected_paid_date, s.net_days,
               (SELECT e.txn_date FROM qbo_transactions e WHERE e.entity_type = 'Estimate' AND e.qbo_id = s.estimate_qbo_id LIMIT 1) AS est_date
        FROM project_invoice_milestones m JOIN project_invoice_schedules s ON s.id = m.schedule_id
        WHERE s.entity_id = :e AND m.qbo_invoice_id IS NULL AND COALESCE(m.date_basis, 'auto_history') = 'auto_history'
    """), {"e": entity_id}).mappings().all()
    changes = []
    for r in rows:
        kind = CAL.invoice_kind(r["label"])
        p = plan_dates(kind, start, end, r["net_days"], it, r["est_date"]) if kind else None
        if not p:
            continue
        old = (_d(r["invoice_date"]), _d(r["due_date"]), _d(r["expected_paid_date"]))
        if old == p:
            continue
        conn.execute(text("""
            UPDATE project_invoice_milestones
            SET invoice_date = :i, due_date = :du, expected_paid_date = :x, date_basis = 'auto_history'
            WHERE id = :id
        """), {"i": p[0], "du": p[1], "x": p[2], "id": r["id"]})
        changes.append({"id": r["id"], "label": r["label"],
                        "invoice_date": [str(old[0]) if old[0] else None, str(p[0])],
                        "due_date": [str(old[1]) if old[1] else None, str(p[1])],
                        "expected_paid_date": [str(old[2]) if old[2] else None, str(p[2])]})
    if audit and (changes or converted):
        name = conn.execute(text("SELECT display_name FROM qbo_customers WHERE qbo_id = :e"), {"e": entity_id}).scalar()
        record_audit(SYSTEM_ACTOR, "billing.invoice_redate", "project", entity_id, name,
                     {"entity_id": entity_id, "project": name, "start": str(start) if start else None,
                      "end": str(end) if end else None, "changes": changes,
                      "single_invoice": [{"schedule_id": s, "estimate": d, "why": w} for s, d, w in converted]})
    return changes


def redate_entity(entity_id):
    """Best-effort, own transaction: after a job's dates change."""
    try:
        with engine.begin() as conn:
            n = redate_project(conn, str(entity_id))
        if n:
            from app.cashflow.schedule_forecast import touch_dirty
            touch_dirty()
    except Exception:
        pass


def redate_for_customer_row(qbo_customer_row_id):
    """Same, keyed by qbo_customers.id (what the Assignment save knows)."""
    try:
        with engine.connect() as conn:
            q = conn.execute(text("SELECT qbo_id FROM qbo_customers WHERE id = :i AND is_project = 1"),
                             {"i": qbo_customer_row_id}).scalar()
        if q:
            redate_entity(q)
    except Exception:
        pass


def redate_all():
    """Nightly / Assumptions 'apply': every project with app-dated planned invoices."""
    with engine.connect() as conn:
        ids = conn.execute(text("""
            SELECT DISTINCT s.entity_id FROM project_invoice_schedules s
            JOIN project_invoice_milestones m ON m.schedule_id = s.id
            WHERE m.qbo_invoice_id IS NULL AND COALESCE(m.date_basis, 'auto_history') = 'auto_history'
        """)).scalars().all()
    projects = rows = 0
    with engine.begin() as conn:
        it = CAL.invoice_timing(conn)
        for e in ids:
            ch = redate_project(conn, str(e), it)
            if ch:
                projects += 1
                rows += len(ch)
    try:
        from app.cashflow.schedule_forecast import touch_dirty
        touch_dirty()
    except Exception:
        pass
    return {"projects_redated": projects, "rows_redated": rows, "checked": len(ids)}
