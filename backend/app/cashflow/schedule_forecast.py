"""Schedule-driven cash forecast (Phase 3b).

Aggregates every project's per-estimate billing schedules — the SAME schedules
shown on each project's Billing & Schedule tab — into the company forecast, so
"forecast = sum of every project's tab."

Only the **scheduled** tier of each project is contributed here (cash not yet in
QuickBooks): the *committed* tier (open QBO invoices/bills) is already counted by
the QBO-driven committed layer in service.generate_forecast, so taking only the
scheduled tier avoids double-counting a bill/invoice that's already booked.

Placement rules:
  - a scheduled item dated within the horizon  -> its week
  - a scheduled item dated in the PAST but still unpaid (overdue) -> current week
  - a scheduled item dated past the horizon     -> `beyond`
  - a scheduled item with NO date (project awaiting a start date) -> the option-a
    "committed, not yet scheduled" backlog (kept OFF the weekly grid, per owner)
"""
from datetime import date, timedelta

from sqlalchemy import text

from app.db import engine

EPS = 0.5
WEEK_END_WEEKDAY = 4  # Friday


def _iso(d):
    """Normalize a date/datetime/str to a YYYY-MM-DD string (or None)."""
    if not d:
        return None
    if isinstance(d, str):
        return d[:10]
    return d.isoformat()[:10]


def _next_weekday(d: date, weekday: int) -> date:
    return d + timedelta(days=(weekday - d.weekday()) % 7)


def _candidate_project_ids(conn):
    """Projects that can contribute forward cash: is_project=1 with at least one
    assignment row not completed/canceled. Completed projects' remaining cash is
    caught by the committed QBO layers, so we skip them to keep the pass cheap."""
    rows = conn.execute(text("""
        SELECT DISTINCT c.qbo_id
        FROM qbo_customers c
        JOIN projects p ON p.qbo_customer_id = c.id
        JOIN project_schedule_items si ON si.project_id = p.id
        WHERE c.is_project = 1
          AND si.status NOT IN ('completed', 'canceled')
    """)).scalars().all()
    return [str(r) for r in rows]


def _project_events(conn, entity_id):
    """The scheduled-tier forward cash events for one project, reusing the exact
    per-project compose pipeline (so the numbers match the Billing tab)."""
    import app.billing.routes as B

    ctx = B._project_ctx(conn, entity_id)
    if not ctx:
        return None
    meta = B._project_meta(conn, entity_id) or {}

    # create-if-missing (same order as get_bundle) — generates schedules for
    # projects never opened in the Billing tab.
    B._ensure_estimate_billing(conn, entity_id, B._default_crew_for_project(conn, entity_id, meta))
    B._ensure_invoice_schedules(conn, entity_id, ctx)
    B._ensure_crew_schedules(conn, entity_id, ctx, meta)
    B._ensure_expense_items(conn, entity_id, ctx)
    B._ensure_expense_installments(conn, entity_id, ctx)

    op_status = B._canonical_status(conn, entity_id)
    books_closed = op_status == "completed"
    if books_closed:
        return None  # trust actuals; nothing scheduled remains
    has_dates = bool(ctx.get("start_date") and ctx.get("end_date"))

    cvi = B._all_crew_vendor_ids(conn, entity_id)
    inv = B._compose_invoices(conn, entity_id, books_closed)
    crew = B._compose_crew(conn, entity_id, meta, cvi, books_closed)
    exp = B._compose_expenses(conn, entity_id, books_closed,
                              B._pd(ctx.get("start_date")), B._pd(ctx.get("end_date")))

    events, backlog_in, backlog_out = [], 0.0, 0.0

    # Inflow: scheduled (not-yet-invoiced) milestones on their planned invoice date.
    for m in inv["milestones"]:
        if m.get("tier") != "scheduled":
            continue
        amt = float(m.get("amount") or 0)
        if amt <= EPS:
            continue
        d = _iso(m.get("invoice_date"))
        if d and has_dates:  # only on the grid if the project is fully dated
            events.append({"date": d, "dir": "in", "amt": amt, "src": "invoice"})
        else:                # undated (incl. partial start-only) -> all to backlog
            backlog_in += amt

    # Outflow crew: scheduled (unpaid) installments on their pay date.
    for i in crew["installments"]:
        if i.get("tier") != "scheduled":
            continue
        amt = float(i.get("amount") or 0)
        if amt <= EPS:
            continue
        d = _iso(i.get("pay_date"))
        if d and has_dates:
            events.append({"date": d, "dir": "out", "amt": amt, "src": "crew"})
        else:
            backlog_out += amt

    # Outflow expenses: scheduled weekly installments on their week_of date.
    for cat in exp["by_category"]:
        for w in cat.get("weekly", []):
            if w.get("tier") != "scheduled":
                continue
            amt = float(w.get("amount") or 0)
            if amt <= EPS:
                continue
            d = _iso(w.get("week_of"))
            if d and has_dates:
                events.append({"date": d, "dir": "out", "amt": amt, "src": "expense"})
            else:
                backlog_out += amt

    # Backlog detail (option a): for an undated project, the crew/expense SCHEDULE
    # can't be generated, but the ESTIMATE baseline still tells us the expected
    # cost. Surface the full picture per project so the chip can drill down:
    # already paid (in the bank), sent A/R (already on the grid), still-to-bill,
    # estimated crew+expense out (net of any actual spend), and the net swing.
    backlog_detail = None
    if not has_dates and backlog_in > EPS:
        ests = B._estimates_for_billing(conn, entity_id)
        crew_est = round(sum(float(e["labor"] or 0) for e in ests if e["status"] == "accepted"), 2)
        exp_est = round(sum(B._estimate_costs_by_category(conn, entity_id).values()), 2)
        crew_out = round(max(0.0, crew_est - float(crew.get("paid_qbo") or 0)), 2)
        exp_out = round(max(0.0, exp_est - float(exp.get("spent_qbo") or 0)), 2)
        paid = round(float(inv.get("paid_qbo") or 0), 2)
        ar = round(max(0.0, float(inv.get("invoiced_qbo") or 0) - paid), 2)
        to_bill = round(backlog_in, 2)
        est_out = round(crew_out + exp_out, 2)
        # Net = what this project would ADD to the forecast if it got scheduled:
        # new inflow (to-bill) minus new outflow (est). A/R + paid are NOT here —
        # A/R is already on the grid by its due date, paid is already in the bank.
        backlog_detail = {
            "entity_id": entity_id, "name": ctx["name"], "status": op_status,
            "paid": paid, "ar": ar, "to_bill": to_bill,
            "crew_out": crew_out, "exp_out": exp_out, "out": est_out,
            "net": round(to_bill - est_out, 2),
        }

    if not events and backlog_in <= EPS and backlog_out <= EPS:
        return None
    return {
        "entity_id": entity_id, "name": ctx["name"], "status": op_status,
        "has_dates": has_dates,
        "events": events,
        "backlog_in": round(backlog_in, 2), "backlog_out": round(backlog_out, 2),
        "backlog_detail": backlog_detail,
        "scheduled_in": round(sum(e["amt"] for e in events if e["dir"] == "in"), 2),
        "scheduled_out": round(sum(e["amt"] for e in events if e["dir"] == "out"), 2),
    }


# ---------------------------------------------------------------------------
# Expensive pass: collect every project's raw (horizon-independent) events once.
# This is the ~30s part; it is cached and re-bucketed for any horizon cheaply.
# ---------------------------------------------------------------------------
def compute_all_events() -> dict:
    """Walk every candidate project once and gather its scheduled cash EVENTS
    (dated, horizon-independent) plus the option-a backlog. Cache this; bucket it
    into any weekly horizon with `bucket_events` (cheap)."""
    all_events = []
    backlog_in = backlog_out = 0.0
    backlog_projects = []
    projects = []
    with engine.begin() as conn:  # begin(): the ensure-pass may write new schedules
        for eid in _candidate_project_ids(conn):
            ev = _project_events(conn, eid)
            if not ev:
                continue
            projects.append({k: ev[k] for k in
                             ("entity_id", "name", "status", "has_dates",
                              "backlog_in", "backlog_out", "scheduled_in", "scheduled_out")})
            backlog_in += ev["backlog_in"]
            backlog_out += ev["backlog_out"]
            if ev.get("backlog_detail"):
                backlog_projects.append(ev["backlog_detail"])
            for e in ev["events"]:
                all_events.append({**e, "entity_id": eid})
    projects.sort(key=lambda p: -(p["scheduled_in"] + p["scheduled_out"]))
    backlog_projects.sort(key=lambda p: -(p["to_bill"] + p["ar"] + p["out"]))
    # Totals derived from the per-project rows, so the chip/totals ALWAYS equal
    # the sum of the drill-down. `in` = still-to-bill, `out` = estimated crew+exp,
    # `ar`/`paid` = already-on-grid / already-in-bank context, `net` = in − out.
    return {
        "computed_at": _iso_now(),
        "events": all_events,
        "backlog": {
            "in": round(sum(p["to_bill"] for p in backlog_projects), 2),
            "out": round(sum(p["out"] for p in backlog_projects), 2),
            "paid": round(sum(p["paid"] for p in backlog_projects), 2),
            "ar": round(sum(p["ar"] for p in backlog_projects), 2),
            "net": round(sum(p["net"] for p in backlog_projects), 2),
            "projects": backlog_projects,
            "count": len(backlog_projects),
        },
        "projects": projects,
        "project_count": len(projects),
    }


def bucket_events(payload: dict, start_date: date | None = None, weeks: int = 26) -> dict:
    """Cheaply bucket a cached event payload into a weekly horizon. Overdue-unpaid
    events pull to the current week; past-horizon events roll into `beyond`."""
    today = date.today()
    if start_date is None:
        start_date = _next_weekday(today, WEEK_END_WEEKDAY)  # coming Friday
    week_ends = [start_date + timedelta(days=7 * i) for i in range(weeks)]
    win_start = week_ends[0] - timedelta(days=6)
    win_end = week_ends[-1]

    def week_index(iso_d):
        d = date.fromisoformat(iso_d)
        if d < win_start:
            return 0                       # overdue but unpaid -> pull to current week
        if d > win_end:
            return None                    # beyond the horizon
        for i, we in enumerate(week_ends):
            if (we - timedelta(days=6)) <= d <= we:
                return i
        return None

    inflow = [0.0] * weeks
    outflow = [0.0] * weeks
    beyond_in = beyond_out = 0.0
    for e in payload.get("events", []):
        wi = week_index(e["date"])
        if wi is None:
            if e["dir"] == "in":
                beyond_in += e["amt"]
            else:
                beyond_out += e["amt"]
        elif e["dir"] == "in":
            inflow[wi] += e["amt"]
        else:
            outflow[wi] += e["amt"]
    return {
        "week_ends": [d.isoformat() for d in week_ends],
        "weeks": weeks,
        "inflow": [round(x, 2) for x in inflow],
        "outflow": [round(x, 2) for x in outflow],
        "beyond_in": round(beyond_in, 2),
        "beyond_out": round(beyond_out, 2),
        "backlog": payload.get("backlog", {"in": 0.0, "out": 0.0}),
        "projects": payload.get("projects", []),
        "project_count": payload.get("project_count", 0),
        "computed_at": payload.get("computed_at"),
    }


def collect_scheduled(start_date: date | None = None, weeks: int = 26) -> dict:
    """Convenience: compute events live (uncached) + bucket. Prefer the cached
    path (get_events + bucket_events) for anything user-facing."""
    return bucket_events(compute_all_events(), start_date, weeks)


# ---------------------------------------------------------------------------
# DB-backed cache for the expensive event pass (singleton row). Re-bucketing for
# a horizon is cheap, so we cache the horizon-independent events and re-bucket
# live. Refresh recomputes; edits elsewhere mark it stale via touch_dirty().
# ---------------------------------------------------------------------------
import json as _json
from datetime import datetime as _dt


def _iso_now() -> str:
    return _dt.utcnow().replace(microsecond=0).isoformat()


# The schedule tables whose edits should invalidate the cache. All have an
# updated_at that bumps on any INSERT/UPDATE (project_schedule_items covers
# assignment date changes → dated/undated → backlog vs grid).
_SOURCE_TABLES = ("project_payment_installments", "project_expense_installments",
                  "project_invoice_milestones", "project_schedule_items")


def ensure_cache_table():
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS cashflow_schedule_cache (
              id TINYINT NOT NULL PRIMARY KEY DEFAULT 1,
              payload LONGTEXT NULL,
              computed_at DATETIME NULL,
              source_max DATETIME NULL,
              computing TINYINT(1) NOT NULL DEFAULT 0,
              dirty TINYINT(1) NOT NULL DEFAULT 1,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB
        """))
        conn.execute(text(
            "INSERT IGNORE INTO cashflow_schedule_cache (id, dirty) VALUES (1, 1)"))


def _source_max(conn):
    """Latest updated_at across all schedule tables — the 'data version'. Any
    schedule edit bumps this, so cache.source_max < this ⇒ the cache is stale."""
    parts = " UNION ALL ".join(f"SELECT MAX(updated_at) m FROM {t}" for t in _SOURCE_TABLES)
    return conn.execute(text(f"SELECT MAX(m) FROM ({parts}) x")).scalar()


def _read_cache_row():
    ensure_cache_table()
    with engine.connect() as conn:
        row = conn.execute(text(
            "SELECT payload, computed_at, source_max, computing, dirty FROM cashflow_schedule_cache WHERE id=1"
        )).mappings().first()
        cur_max = _source_max(conn)
    return row, cur_max


def touch_dirty():
    """Explicitly mark the cached forecast stale. (The source_max check already
    catches schedule edits automatically; this is a belt-and-suspenders hook.)"""
    try:
        ensure_cache_table()
        with engine.begin() as conn:
            conn.execute(text("UPDATE cashflow_schedule_cache SET dirty=1 WHERE id=1"))
    except Exception:
        pass  # never let cache bookkeeping break a caller


def recompute_cache():
    """Run the expensive pass and store it (with the current data version).
    Guards against concurrent runs via the `computing` flag."""
    ensure_cache_table()
    with engine.begin() as conn:
        already = conn.execute(text(
            "SELECT computing FROM cashflow_schedule_cache WHERE id=1")).scalar()
        if already:
            return False
        conn.execute(text("UPDATE cashflow_schedule_cache SET computing=1 WHERE id=1"))
    try:
        payload = compute_all_events()
        with engine.begin() as conn:
            # capture source_max AFTER the ensure-pass so create-if-missing writes
            # don't make the fresh cache look immediately stale.
            src = _source_max(conn)
            conn.execute(text("""
                UPDATE cashflow_schedule_cache
                SET payload=:p, computed_at=:c, source_max=:s, computing=0, dirty=0 WHERE id=1
            """), {"p": _json.dumps(payload), "c": payload["computed_at"], "s": src})
        return True
    except Exception:
        with engine.begin() as conn:
            conn.execute(text("UPDATE cashflow_schedule_cache SET computing=0 WHERE id=1"))
        raise


def get_events(max_age_seconds: int = 1800):
    """Return (payload, meta). Serves the cached event payload; meta says whether
    it's fresh/stale/absent/computing so the route can kick a background recompute.
    Stale when: explicitly dirty, older than the TTL, OR a schedule table changed
    since the cache was built (source_max moved)."""
    row, cur_max = _read_cache_row()
    payload = None
    if row and row["payload"]:
        try:
            payload = _json.loads(row["payload"])
        except Exception:
            payload = None
    computed_at = row["computed_at"] if row else None
    source_max = row["source_max"] if row else None
    computing = bool(row["computing"]) if row else False
    dirty = bool(row["dirty"]) if row else True
    age = None
    if computed_at:
        age = (_dt.utcnow() - computed_at).total_seconds()
    edited_since = (cur_max is not None and (source_max is None or cur_max > source_max))
    stale = dirty or edited_since or age is None or age > max_age_seconds
    meta = {"computed_at": computed_at.isoformat() if computed_at else None,
            "age_seconds": int(age) if age is not None else None,
            "computing": computing, "stale": stale, "has_data": payload is not None,
            "edited_since": edited_since}
    return payload, meta
