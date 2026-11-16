"""When a project's books are closed: one rule for the Billing tab, the PM
portal and the cash forecast (owner decision 2026-11-15).

  * Closed out on Project Closeout (the "final margin reviewed" step is done)
    -> books closed.
  * Finished (latest line Completed) and its last day is on or after CUTOVER
    (Oct 1 2026) -> books stay OPEN until it is closed out, so a final invoice
    still to send or crew pay still to make stays in the cash forecast.
  * Finished before CUTOVER -> books closed, unless someone turned on
    "Include in the cash forecast" for that project (project_books_open):
    the old plans on those jobs are mostly stale, so they come back one job at
    a time, by choice, until the job is closed out.
  * Not finished -> books open (as before).

Open QuickBooks invoices and bills count in the forecast whatever this says;
the rule only decides whether the project's PLANNED (not yet in QuickBooks)
invoices, crew pay and expenses still count.
"""
from datetime import date

from sqlalchemy import bindparam, text

CUTOVER = date(2026, 10, 1)

_LAST_DAY = """
    SELECT qc.qbo_id AS e,
           MAX(DATE_ADD(psi.end_date, INTERVAL COALESCE(psi.overage_days, 0) DAY)) AS last_day
    FROM qbo_customers qc
    JOIN projects p ON p.qbo_customer_id = qc.id
    JOIN project_schedule_items psi ON psi.project_id = p.id AND psi.status <> 'canceled'
    WHERE {where}
    GROUP BY qc.qbo_id
"""


def _one(conn, sql, eid):
    return conn.execute(text(sql), {"e": str(eid)}).first()


def closed_out(conn, entity_id) -> bool:
    return bool(_one(conn, "SELECT 1 FROM project_closeout_steps WHERE entity_id = :e AND step_key = 'margin' AND status = 'done'", entity_id))


def included(conn, entity_id) -> dict | None:
    """The "Include in the cash forecast" choice for an older job, if on."""
    try:
        r = conn.execute(text("""SELECT entity_id, note, by_email, at FROM project_books_open
                                 WHERE entity_id = :e AND include = 1"""), {"e": str(entity_id)}).mappings().first()
    except Exception:
        return None   # table not migrated yet
    return dict(r) if r else None


def last_day(conn, entity_id):
    r = conn.execute(text(_LAST_DAY.format(where="qc.qbo_id = :e")), {"e": str(entity_id)}).first()
    return r[1] if r else None


def state(conn, entity_id, status=None) -> dict:
    """{closed, why, finished, closed_out, included, last_day, older}."""
    if status is None:
        from app.projects.routes import _latest_status
        status = _latest_status(conn, str(entity_id))
    finished = status == "completed"
    out = {"finished": finished, "closed_out": closed_out(conn, entity_id), "included": None,
           "last_day": None, "older": False}
    if out["closed_out"]:
        return {**out, "closed": True, "why": "closed_out"}
    if not finished:
        return {**out, "closed": False, "why": "not_finished"}
    ld = last_day(conn, entity_id)
    out["last_day"] = ld.isoformat() if ld else None
    if ld is not None and ld >= CUTOVER:
        return {**out, "closed": False, "why": "open_until_closed_out"}
    out["older"] = True
    inc = included(conn, entity_id)
    if inc:
        out["included"] = {k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in inc.items()}
        return {**out, "closed": False, "why": "included"}
    return {**out, "closed": True, "why": "ended_before_cutover"}


def books_closed(conn, entity_id, status=None) -> bool:
    return state(conn, entity_id, status)["closed"]


def forecast_candidates(conn) -> list[str]:
    """Projects that can still add planned cash: any line not finished or
    canceled; or finished on/after CUTOVER; or an older job someone included.
    Closed-out projects are left out (their books are closed)."""
    rows = set(str(r) for r in conn.execute(text("""
        SELECT DISTINCT c.qbo_id FROM qbo_customers c
        JOIN projects p ON p.qbo_customer_id = c.id
        JOIN project_schedule_items si ON si.project_id = p.id
        WHERE c.is_project = 1 AND si.status NOT IN ('completed', 'canceled')""")).scalars().all())
    for e, ld in conn.execute(text(_LAST_DAY.format(where="qc.is_project = 1"))).all():
        if ld is not None and ld >= CUTOVER:
            rows.add(str(e))
    try:
        rows |= {str(r) for r in conn.execute(text("SELECT entity_id FROM project_books_open WHERE include = 1")).scalars().all()}
    except Exception:
        pass
    done = {str(r) for r in conn.execute(text(
        "SELECT entity_id FROM project_closeout_steps WHERE step_key = 'margin' AND status = 'done'")).scalars().all()}
    return sorted(rows - done)


def refresh_forecast_for(entity_id):
    """A project's books opened or closed without a schedule edit (closed out,
    undone, included): drop its stored forecast so the next pass recomputes it."""
    from app.db import engine
    from app.cashflow.schedule_forecast import touch_dirty
    try:
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM project_cash_cache WHERE entity_id = :e"), {"e": str(entity_id)})
    except Exception:
        pass
    touch_dirty()
