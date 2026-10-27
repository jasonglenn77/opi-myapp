"""Project holds (migration 0078) — owner decision 2026-10-26.

A project ON HOLD must NOT drop out of the cash forecast. The office marks it
on hold with an EXPECTED RESUME date; the project's REMAINING work then
forecasts from the resume date.

Design: MATERIALIZED shift with the original plan kept
-------------------------------------------------------
Putting a project on hold shifts the stored dates of its remaining work by the
hold length L = expected_resume - hold_start (days):

  kind                 table.column(s)                               shifted when
  schedule_item        project_schedule_items.start_date / end_date  status not completed/canceled and
                       / non_working dates                           the date >= hold_start
                       .status -> 'on_hold'                          (in-progress line: start stays, end moves)
  crew_schedule        project_payment_schedules.start_date/end_date date >= hold_start (keeps billing drift quiet)
  milestone            project_invoice_milestones.invoice_date /     still fully TO BILL (tier 'scheduled', no
                       due_date / expected_paid_date                 QBO invoice) and invoice date >= hold_start
  crew_installment     project_payment_installments.pay_date /       fully UNPAID in the paid-QBO burn-down and
                       send_invoice_date                             pay date >= hold_start
  expense_installment  project_expense_installments.week_of          fully unspent (tier 'scheduled'), week >= start
  expense_item         project_expense_items.expense_date            status 'planned', date >= hold_start

Weekly / bi-weekly rows (crew pay Fridays, expense weeks) move by L rounded to
whole weeks so they keep their weekday. Every shifted field is logged in
project_hold_shifts with its ORIGINAL value, so:
  * Edit hold (new resume date) re-sizes the shift from the originals;
  * Resume now (early) re-sizes it to (today - hold_start) — 0 = full undo;
  * a value someone changed since (user edit, sheet import) is "detached" and
    left alone.

Why materialized (not a read-time shift): Billing & Schedule, the Schedules
page, Ashley's Tracker, the PM portal, cashflow.schedule_forecast (which
reuses the billing compose pipeline) and cashflow.revenue_forecast (which
reads project_schedule_items dates) all read these stored dates — shifting
them once keeps every screen consistent with no engine changes, and the cash
caches invalidate on their own (they key on the tables' updated_at).

For forecast engines: shift_for_forecast()
------------------------------------------
Stored app dates are ALREADY shifted — engines must NOT shift them again.
Call shift_for_forecast(entity_id, d) only for a date that did not come from
the shifted tables (e.g. a date read from a Google sheet, a QBO-derived
projection, or a row created after the hold started). It is idempotent with
the materialized shift: it moves a date only if it falls INSIDE the active
hold window [hold_start, expected_resume) — every materialized date is already
>= expected_resume, past work is < hold_start, so neither moves twice.

    from app.projects import holds
    hs = holds.active_holds()                      # one query, reuse for many dates
    d2 = holds.shift_for_forecast(entity_id, d, hs)

Job Schedule importer interaction (sheet wins)
----------------------------------------------
The nightly importer writes through projects.service.save_schedule_item as the
Job Schedule system user; save_schedule_item calls guard_import() for that
user. While a hold is active:
  * a sheet date equal to the hold's recorded ORIGINAL date for that line is
    the not-yet-updated sheet -> the shifted date is kept (no double shift);
  * a sheet date inside the hold window -> shifted by L;
  * any other sheet date (OPI already moved it past the resume date, or it is
    past work) -> the sheet wins, unchanged;
  * a derived not_started/in_progress (or a 'completed' that only comes from
    stale pre-hold dates) becomes 'on_hold'; 'canceled' and a genuinely
    finished line (ends before hold_start) pass through.
"""
import json
from datetime import date, datetime, timedelta

from sqlalchemy import text

from app.db import engine

# The Job Schedule importer's system user (gsync/schedule_import.SYSTEM_EMAIL).
IMPORT_SYSTEM_EMAIL = "job-schedule@system.onpointinstallers.com"

DONE = ("completed", "canceled")
EPS = 0.5

# kind -> (table, {field: column}); the ONLY tables/columns this module writes.
KINDS = {
    "schedule_item": ("project_schedule_items", ("start_date", "end_date", "non_working", "status")),
    "crew_schedule": ("project_payment_schedules", ("start_date", "end_date")),
    "milestone": ("project_invoice_milestones", ("invoice_date", "due_date", "expected_paid_date")),
    "crew_installment": ("project_payment_installments", ("pay_date", "send_invoice_date")),
    "expense_installment": ("project_expense_installments", ("week_of",)),
    "expense_item": ("project_expense_items", ("expense_date",)),
}
WEEKLY_KINDS = {"crew_installment", "expense_installment"}


# ── small helpers ────────────────────────────────────────────────────────────
def _d(v):
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return date.fromisoformat(str(v)[:10])


def _iso(v):
    d = _d(v)
    return d.isoformat() if d else None


def _weeks(n):
    """Shift for weekly rows: n days rounded to whole weeks (keeps weekday)."""
    return int(round(n / 7.0)) * 7


def _hold_out(r):
    if not r:
        return None
    h = dict(r)
    for k in ("hold_start", "expected_resume"):
        h[k] = _iso(h.get(k))
    for k in ("created_at", "updated_at", "released_at"):
        if h.get(k) is not None:
            h[k] = str(h[k])
    h["entity_id"] = str(h["entity_id"])
    h["active"] = h.get("released_at") is None
    h["overdue"] = bool(h["active"] and h["expected_resume"] and _d(h["expected_resume"]) < date.today())
    return h


_HOLD_COLS = """h.id, h.project_id, h.qbo_customer_id, h.entity_id, h.hold_start, h.expected_resume,
    h.shift_days, h.reason, h.note, h.created_by_user_id, h.created_at, h.updated_by_user_id,
    h.updated_at, h.released_at, h.released_by_user_id,
    TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS created_by_name"""


def _project_keys(conn, qbo_customer_id=None, entity_id=None, project_id=None):
    """(project_id, qbo_customer_id, entity_id, name) for any one key; creates
    the projects row if missing (same as the assignment save path)."""
    if project_id is not None:
        r = conn.execute(text("""SELECT p.id pid, qc.id cid, qc.qbo_id, qc.display_name FROM projects p
            JOIN qbo_customers qc ON qc.id = p.qbo_customer_id WHERE p.id = :x"""), {"x": project_id}).mappings().first()
    elif qbo_customer_id is not None:
        r = conn.execute(text("""SELECT p.id pid, qc.id cid, qc.qbo_id, qc.display_name FROM qbo_customers qc
            LEFT JOIN projects p ON p.qbo_customer_id = qc.id WHERE qc.id = :x"""), {"x": qbo_customer_id}).mappings().first()
    else:
        r = conn.execute(text("""SELECT p.id pid, qc.id cid, qc.qbo_id, qc.display_name FROM qbo_customers qc
            LEFT JOIN projects p ON p.qbo_customer_id = qc.id WHERE qc.qbo_id = :x AND qc.is_project = 1"""),
            {"x": str(entity_id)}).mappings().first()
    if not r:
        raise ValueError("Unknown project")
    pid = r["pid"]
    if pid is None:
        from app.projects.service import ensure_project_row_for_qbo_customer
        pid = ensure_project_row_for_qbo_customer(conn, int(r["cid"]))
    return int(pid), int(r["cid"]), str(r["qbo_id"]), r["display_name"]


# ── reads ────────────────────────────────────────────────────────────────────
def get_active_hold(conn, project_id):
    r = conn.execute(text(f"""SELECT {_HOLD_COLS} FROM project_holds h
        LEFT JOIN users u ON u.id = h.created_by_user_id
        WHERE h.project_id = :p AND h.released_at IS NULL ORDER BY h.id DESC LIMIT 1"""),
        {"p": int(project_id)}).mappings().first()
    return _hold_out(r)


def hold_for(qbo_customer_id=None, entity_id=None):
    """{"hold": active hold or None, "history": past holds} for one project."""
    with engine.begin() as conn:
        pid, cid, eid, name = _project_keys(conn, qbo_customer_id, entity_id)
        rows = conn.execute(text(f"""SELECT {_HOLD_COLS} FROM project_holds h
            LEFT JOIN users u ON u.id = h.created_by_user_id
            WHERE h.project_id = :p ORDER BY h.id DESC LIMIT 20"""), {"p": pid}).mappings().all()
    hs = [_hold_out(r) for r in rows]
    return {"project_id": pid, "qbo_customer_id": cid, "entity_id": eid, "name": name,
            "hold": next((h for h in hs if h["active"]), None),
            "history": [h for h in hs if not h["active"]]}


def active_holds(conn=None):
    """{entity_id (qbo_id str): hold dict} for every active hold — one query.
    Each hold also carries project_id / qbo_customer_id for other lookups."""
    def _q(c):
        return [_hold_out(r) for r in c.execute(text(f"""SELECT {_HOLD_COLS} FROM project_holds h
            LEFT JOIN users u ON u.id = h.created_by_user_id WHERE h.released_at IS NULL""")).mappings()]
    if conn is None:
        with engine.connect() as c:
            rows = _q(c)
    else:
        rows = _q(conn)
    return {h["entity_id"]: h for h in rows}


def shift_date(hold, d):
    """Pure: d moved by the hold's shift if it lies inside the hold window
    [hold_start, expected_resume); otherwise d unchanged (None-safe)."""
    d = _d(d)
    if d is None or not hold or not hold.get("active", True):
        return d
    hs, hr = _d(hold["hold_start"]), _d(hold["expected_resume"])
    n = int(hold.get("shift_days") or 0)
    if n > 0 and hs <= d < hr:
        return d + timedelta(days=n)
    return d


def shift_for_forecast(entity_id, d, holds=None):
    """Forecast-time shift for ONE date of project `entity_id` (QBO project
    qbo_id). See the module docstring: stored app dates are already shifted;
    this only moves dates still inside an active hold window, so it is safe
    (idempotent) to call on any date. Pass `holds=active_holds()` when calling
    it in a loop."""
    hs = holds if holds is not None else active_holds()
    return shift_date(hs.get(str(entity_id)), d)


# ── eligibility: what the hold moves ─────────────────────────────────────────
def _eligible(conn, project_id, entity_id, hold_start):
    """[(kind, row_id, field, current_value_str)] the hold manages, at hold
    start. Uses the SAME burn-downs as Billing & Schedule / the cash forecast
    so only not-yet-invoiced / not-yet-paid / not-yet-spent rows move."""
    H = _d(hold_start)
    out = []

    # schedule lines (remaining work)
    for r in conn.execute(text("""SELECT id, status, start_date, end_date, non_working
            FROM project_schedule_items WHERE project_id = :p"""), {"p": project_id}).mappings():
        if r["status"] in DONE:
            continue
        out.append(("schedule_item", r["id"], "status", r["status"]))
        for f in ("start_date", "end_date"):
            if r[f] and r[f] >= H:
                out.append(("schedule_item", r["id"], f, _iso(r[f])))
        nw = r["non_working"]
        if nw:
            from app.projects.service import _parse_non_working
            p = _parse_non_working(nw)
            if p and any(x >= H.isoformat() for x in p["dates"]):
                out.append(("schedule_item", r["id"], "non_working", json.dumps(p)))

    for r in conn.execute(text("""SELECT id, start_date, end_date FROM project_payment_schedules
            WHERE entity_id = :e"""), {"e": entity_id}).mappings():
        for f in ("start_date", "end_date"):
            if r[f] and r[f] >= H:
                out.append(("crew_schedule", r["id"], f, _iso(r[f])))

    import app.billing.routes as B
    # invoice milestones still fully TO BILL
    try:
        est = B._compose_estimates(conn, entity_id)
    except Exception:
        est = {"accepted": []}
    for e in est.get("accepted", []):
        for m in e.get("milestones", []):
            if (m.get("tier") != "scheduled" or m.get("qbo_invoice_id")
                    or (m.get("status") or "pending").lower() in ("sent", "paid", "partial", "retainage")
                    or float(m.get("covered") or 0) > EPS):
                continue
            anchor = _d(m.get("invoice_date") or m.get("due_date"))
            if not anchor or anchor < H:
                continue
            for f in ("invoice_date", "due_date", "expected_paid_date"):
                if m.get(f):
                    out.append(("milestone", m["id"], f, _iso(m[f])))

    # crew installments fully UNPAID (same burn-down as cashflow.schedule_forecast)
    try:
        meta = B._project_meta(conn, entity_id) or {}
        crew = B._compose_crew(conn, entity_id, meta, B._all_crew_vendor_ids(conn, entity_id), False)
    except Exception:
        crew = {"installments": [], "paid_qbo": 0}
    paid = float(crew.get("paid_qbo") or 0)
    cum = 0.0
    send = {r["id"]: r["send_invoice_date"] for r in conn.execute(text("""
        SELECT i.id, i.send_invoice_date FROM project_payment_installments i
        JOIN project_payment_schedules s ON s.id = i.schedule_id WHERE s.entity_id = :e"""), {"e": entity_id}).mappings()}
    status = {r["id"]: r["status"] for r in conn.execute(text("""
        SELECT i.id, i.status FROM project_payment_installments i
        JOIN project_payment_schedules s ON s.id = i.schedule_id WHERE s.entity_id = :e"""), {"e": entity_id}).mappings()}
    for i in sorted(crew.get("installments", []),
                    key=lambda x: (str(x.get("pay_date")) if x.get("pay_date") else "9999", x.get("id") or 0)):
        amt = float(i.get("amount") or 0)
        covered = min(amt, max(0.0, paid - cum))
        cum += amt
        pd = _d(i.get("pay_date"))
        if covered > EPS or not pd or pd < H or (status.get(i["id"]) or "").lower() == "paid":
            continue
        out.append(("crew_installment", i["id"], "pay_date", pd.isoformat()))
        if send.get(i["id"]):
            out.append(("crew_installment", i["id"], "send_invoice_date", _iso(send[i["id"]])))

    # expenses still to spend
    try:
        exp = B._compose_expenses(conn, entity_id, False)
    except Exception:
        exp = {"by_category": []}
    for cat in exp.get("by_category", []):
        for w in cat.get("weekly", []):
            wd = _d(w.get("week_of"))
            if w.get("tier") == "scheduled" and wd and wd >= H:
                out.append(("expense_installment", w["id"], "week_of", wd.isoformat()))
    for r in conn.execute(text("""SELECT id, expense_date FROM project_expense_items
            WHERE entity_id = :e AND status = 'planned' AND expense_date >= :h"""),
            {"e": entity_id, "h": H}).mappings():
        out.append(("expense_item", r["id"], "expense_date", _iso(r["expense_date"])))
    return out


def _shifted(kind, field, orig, n, hold_start_iso):
    """The value of `orig` under an n-day shift (status handled by callers).
    non_working: only the off-days on/after the hold start move."""
    if orig is None:
        return None
    if field == "non_working":
        p = json.loads(orig)
        return json.dumps({"weekends_off": p.get("weekends_off", False),
                           "dates": sorted((_d(x) + timedelta(days=n)).isoformat() if x >= hold_start_iso else x
                                           for x in p.get("dates", []))})
    step = _weeks(n) if kind in WEEKLY_KINDS else n
    return (_d(orig) + timedelta(days=step)).isoformat()



def _current(conn, kind, row_id, field):
    table, fields = KINDS[kind]
    assert field in fields
    v = conn.execute(text(f"SELECT {field} FROM {table} WHERE id = :id"), {"id": row_id}).scalar()
    if field == "non_working":
        from app.projects.service import _parse_non_working
        p = _parse_non_working(v)
        return json.dumps(p) if p else None
    if field == "status":
        return v
    return _iso(v)


def _write(conn, kind, row_id, field, value):
    table, fields = KINDS[kind]
    assert field in fields
    conn.execute(text(f"UPDATE {table} SET {field} = :v WHERE id = :id"), {"v": value, "id": row_id})


def _restored_status(orig, item):
    """Status for a line coming off hold."""
    if orig in ("needs_attention", "pending") or not item or not item["start_date"]:
        return orig or "not_started"
    today = date.today()
    return "not_started" if item["start_date"] > today else "in_progress"


def _reshift(conn, hold, n, actor_user_id, release=False, hist=None):
    """Apply an n-day shift to every managed (non-detached) field of `hold`,
    from the recorded originals. Returns per-kind counts. Item history rows
    are written so the Assignment history shows the move."""
    hs_iso = _iso(hold["hold_start"])
    rows = conn.execute(text("""SELECT id, kind, row_id, field, orig_value, shifted_value
        FROM project_hold_shifts WHERE hold_id = :h AND detached = 0 ORDER BY id"""),
        {"h": hold["id"]}).mappings().all()
    counts = {}
    item_changes = hist if hist is not None else {}
    for r in rows:
        kind, rid, field = r["kind"], r["row_id"], r["field"]
        cur = _current(conn, kind, rid, field)
        if cur != r["shifted_value"]:
            # someone (user / sheet) changed it since: stop managing it
            conn.execute(text("UPDATE project_hold_shifts SET detached = 1 WHERE id = :id"), {"id": r["id"]})
            continue
        if field == "status":
            if release:
                item = conn.execute(text("SELECT start_date FROM project_schedule_items WHERE id = :id"),
                                    {"id": rid}).mappings().first()
                new = _restored_status(r["orig_value"], item)
            else:
                new = "on_hold"
        else:
            new = _shifted(kind, field, r["orig_value"], n, hs_iso) if n > 0 else r["orig_value"]
        if new != cur:
            _write(conn, kind, rid, field, new)
            counts.setdefault(kind, set()).add(rid)
            if kind == "schedule_item":
                item_changes.setdefault(rid, {})[field] = [json.loads(cur) if field == "non_working" and cur else cur,
                                                          json.loads(new) if field == "non_working" and new else new]
        conn.execute(text("UPDATE project_hold_shifts SET shifted_value = :v WHERE id = :id"),
                     {"v": new, "id": r["id"]})
    if hist is None:   # caller batches history otherwise (resume: dates + status = one row)
        _write_history(conn, item_changes, actor_user_id)
    conn.execute(text("UPDATE project_holds SET shift_days = :n WHERE id = :id"), {"n": n, "id": hold["id"]})
    return {k: len(v) for k, v in counts.items()}   # rows changed per kind


def _write_history(conn, item_changes, actor_user_id):
    from app.projects.history import record_item_history
    for rid, ch in item_changes.items():
        if ch:
            record_item_history(conn, rid, "updated", actor_user_id, ch)


def _summary_of(conn, eligible):
    s = {}
    for kind, _rid, field, _v in eligible:
        if field in ("status",):
            continue
        s.setdefault(kind, set()).add(_rid)
    return {k: len(v) for k, v in s.items()}


# ── writes ───────────────────────────────────────────────────────────────────
def preview(qbo_customer_id, hold_start, expected_resume):
    """What a hold would move (counts per kind + days), without writing."""
    H, R = _d(hold_start) or date.today(), _d(expected_resume)
    with engine.begin() as conn:
        pid, cid, eid, name = _project_keys(conn, qbo_customer_id)
        el = _eligible(conn, pid, eid, H)
        out = {"shift_days": max(0, (R - H).days) if R else 0, "counts": _summary_of(conn, el)}
    return out


def _validate(H, R):
    if not R:
        raise ValueError("Expected resume date is required")
    if R <= H:
        raise ValueError("Expected resume date must be after the hold start")
    if (R - H).days > 730:
        raise ValueError("A hold can't be longer than two years")


def put_on_hold(qbo_customer_id, expected_resume, actor, hold_start=None, reason=None, note=None):
    H = _d(hold_start) or date.today()
    R = _d(expected_resume)
    _validate(H, R)
    uid = int(actor["id"]) if actor and actor.get("id") else None
    with engine.begin() as conn:
        pid, cid, eid, name = _project_keys(conn, qbo_customer_id)
        if get_active_hold(conn, pid):
            raise ValueError("This project is already on hold — edit the hold instead")
        hid = conn.execute(text("""INSERT INTO project_holds
            (project_id, qbo_customer_id, entity_id, hold_start, expected_resume, shift_days, reason, note,
             created_by_user_id, updated_by_user_id)
            VALUES (:p, :c, :e, :h, :r, 0, :rs, :n, :u, :u)"""),
            {"p": pid, "c": cid, "e": eid, "h": H, "r": R, "rs": (reason or "").strip()[:160] or None,
             "n": (note or "").strip() or None, "u": uid}).lastrowid
        el = _eligible(conn, pid, eid, H)
        for kind, rid, field, val in el:
            conn.execute(text("""INSERT IGNORE INTO project_hold_shifts
                (hold_id, kind, row_id, field, orig_value, shifted_value) VALUES (:h, :k, :r, :f, :v, :v)"""),
                {"h": hid, "k": kind, "r": rid, "f": field, "v": val})
        hold = get_active_hold(conn, pid)
        counts = _reshift(conn, hold, (R - H).days, uid)
        hold = get_active_hold(conn, pid)
    _audit(actor, "project.hold_start", eid, name, {"hold": _brief(hold), "shifted": counts})
    _touch_cash()
    return {"hold": hold, "shifted": counts}


def edit_hold(qbo_customer_id, actor, expected_resume=None, reason=None, note=None, hold_start=None):
    uid = int(actor["id"]) if actor and actor.get("id") else None
    with engine.begin() as conn:
        pid, cid, eid, name = _project_keys(conn, qbo_customer_id)
        hold = get_active_hold(conn, pid)
        if not hold:
            raise ValueError("This project isn't on hold")
        old = _brief(hold)
        H = _d(hold_start) or _d(hold["hold_start"])
        R = _d(expected_resume) or _d(hold["expected_resume"])
        _validate(H, R)
        if H != _d(hold["hold_start"]):
            # the window moved: rows are re-picked from the originals at the
            # new start (undo the old shift first, then re-collect).
            _reshift(conn, hold, 0, uid)
            conn.execute(text("DELETE FROM project_hold_shifts WHERE hold_id = :h"), {"h": hold["id"]})
            conn.execute(text("UPDATE project_holds SET hold_start = :hs WHERE id = :id"), {"hs": H, "id": hold["id"]})
            for kind, rid, field, val in _eligible(conn, pid, eid, H):
                conn.execute(text("""INSERT IGNORE INTO project_hold_shifts
                    (hold_id, kind, row_id, field, orig_value, shifted_value) VALUES (:h, :k, :r, :f, :v, :v)"""),
                    {"h": hold["id"], "k": kind, "r": rid, "f": field, "v": val})
            hold = get_active_hold(conn, pid)
        conn.execute(text("""UPDATE project_holds SET expected_resume = :r, reason = :rs, note = :n,
            updated_by_user_id = :u WHERE id = :id"""),
            {"r": R, "rs": ((reason if reason is not None else hold.get("reason")) or "").strip()[:160] or None,
             "n": ((note if note is not None else hold.get("note")) or "").strip() or None,
             "u": uid, "id": hold["id"]})
        hold = get_active_hold(conn, pid)
        counts = _reshift(conn, hold, (R - H).days, uid)
        hold = get_active_hold(conn, pid)
    _audit(actor, "project.hold_edit", eid, name, {"changes": _diff(old, _brief(hold)), "shifted": counts})
    _touch_cash()
    return {"hold": hold, "shifted": counts}


def resume(qbo_customer_id, actor, resume_date=None):
    """Release the hold today. Early resume (before expected_resume) shrinks
    the shift to the days actually held (0 = back to the original plan);
    late/on-time resume keeps the dates as shifted. Lines leave 'on_hold'
    (back to their pre-hold status, re-derived from the dates)."""
    uid = int(actor["id"]) if actor and actor.get("id") else None
    today = _d(resume_date) or date.today()   # the office's local "today"
    with engine.begin() as conn:
        pid, cid, eid, name = _project_keys(conn, qbo_customer_id)
        hold = get_active_hold(conn, pid)
        if not hold:
            raise ValueError("This project isn't on hold")
        H, R = _d(hold["hold_start"]), _d(hold["expected_resume"])
        n = max(0, (min(today, R) - H).days) if today < R else int(hold["shift_days"] or 0)
        # dates first (so the restored status is derived from the final dates)
        hist = {}
        counts = _reshift(conn, hold, n, uid, hist=hist)
        counts_st = _reshift(conn, get_active_hold(conn, pid), n, uid, release=True, hist=hist)
        _write_history(conn, hist, uid)
        for k, v in counts_st.items():
            counts[k] = max(counts.get(k, 0), v)
        conn.execute(text("""UPDATE project_holds SET released_at = NOW(), released_by_user_id = :u,
            expected_resume = :r WHERE id = :id"""),
            {"u": uid, "r": (H + timedelta(days=n)) if today < R else R, "id": hold["id"]})
    _audit(actor, "project.hold_release", eid, name,
           {"hold": _brief(hold), "early": today < R, "final_shift_days": n, "shifted": counts})
    _touch_cash()
    return {"hold": None, "released": True, "shift_days": n, "shifted": counts}


# ── importer guard (called from projects.service.save_schedule_item) ─────────
def is_import_actor(conn, actor_user_id):
    if not actor_user_id:
        return False
    em = conn.execute(text("SELECT email FROM users WHERE id = :id"), {"id": int(actor_user_id)}).scalar()
    return (em or "").lower() == IMPORT_SYSTEM_EMAIL


def guard_import(conn, project_id, schedule_item_id, status, start_date, end_date, overage_days=0):
    """Sheet-wins guard for the Job Schedule importer while a hold is active.
    Returns (status, start_iso, end_iso) — unchanged when no hold."""
    hold = get_active_hold(conn, project_id)
    if not hold or status == "canceled":
        return status, start_date, end_date
    H, R = _d(hold["hold_start"]), _d(hold["expected_resume"])
    n = int(hold["shift_days"] or 0)
    orig = {}
    if schedule_item_id:
        for r in conn.execute(text("""SELECT field, orig_value, shifted_value FROM project_hold_shifts
                WHERE hold_id = :h AND kind = 'schedule_item' AND row_id = :r"""),
                {"h": hold["id"], "r": int(schedule_item_id)}).mappings():
            orig[r["field"]] = r
    out = {}
    for f, v in (("start_date", start_date), ("end_date", end_date)):
        d = _d(v)
        if d is None:
            out[f] = None
            continue
        o = orig.get(f)
        if o and o["orig_value"] == d.isoformat() and o["shifted_value"]:
            d = _d(o["shifted_value"])          # stale sheet: keep the shifted date
        elif n > 0 and H <= d < R:
            d = d + timedelta(days=n)           # inside the hold window: shift
        out[f] = d                              # else: the sheet wins
    s, e = out["start_date"], out["end_date"]
    if s and e and e < s:
        e = s
    if status != "canceled":
        eend = (e + timedelta(days=int(overage_days or 0))) if e else None
        if not (eend and eend < H):            # not genuinely finished before the hold
            status = "on_hold"
    return status, (s.isoformat() if s else None), (e.isoformat() if e else None)


# ── audit / cache ────────────────────────────────────────────────────────────
def _brief(h):
    if not h:
        return None
    return {k: h.get(k) for k in ("hold_start", "expected_resume", "shift_days", "reason", "note")}


def _diff(a, b):
    a, b = a or {}, b or {}
    return {k: [a.get(k), b.get(k)] for k in set(a) | set(b) if a.get(k) != b.get(k)}


def _audit(actor, action, eid, name, detail):
    try:
        from app.audit import record_audit
        record_audit(actor, action, "project", eid, name, detail)
    except Exception:
        pass


def _touch_cash():
    """The cash caches key on the source tables' updated_at, which our UPDATEs
    bump — nothing to do. Kept as the one place to add an explicit poke."""
    return None


# ── HTTP routes (/api/projects/hold…) ───────────────────────────────────────
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_user

router = APIRouter(prefix="/api/projects", tags=["project-holds"])


class HoldBody(BaseModel):
    qbo_customer_id: int
    expected_resume: Optional[str] = None
    hold_start: Optional[str] = None
    reason: Optional[str] = None
    note: Optional[str] = None


class ResumeBody(BaseModel):
    qbo_customer_id: int
    resume_date: Optional[str] = None   # the office's local today (defaults to server today)


def _can_edit(user, qbo_customer_id):
    from app.permissions import can_edit_assignment
    if not can_edit_assignment(user, qbo_customer_id):
        raise HTTPException(status_code=403, detail="You can't edit this project's schedule")


def _run(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/holds/active")
def holds_active(user=Depends(get_current_user)):
    """Every active hold (small list) — pages overlay the 'On hold until …' pill."""
    return {"holds": list(active_holds().values())}


@router.get("/hold")
def hold_get(qbo_customer_id: Optional[int] = None, entity_id: Optional[str] = None,
             user=Depends(get_current_user)):
    if qbo_customer_id is None and not entity_id:
        raise HTTPException(status_code=400, detail="qbo_customer_id or entity_id is required")
    return _run(hold_for, qbo_customer_id, entity_id)


@router.get("/hold/preview")
def hold_preview(qbo_customer_id: int, expected_resume: str, hold_start: Optional[str] = None,
                 user=Depends(get_current_user)):
    return _run(preview, qbo_customer_id, hold_start, expected_resume)


@router.post("/hold")
def hold_put(body: HoldBody, user=Depends(get_current_user)):
    _can_edit(user, body.qbo_customer_id)
    return _run(put_on_hold, body.qbo_customer_id, body.expected_resume, user,
                hold_start=body.hold_start, reason=body.reason, note=body.note)


@router.put("/hold")
def hold_edit(body: HoldBody, user=Depends(get_current_user)):
    _can_edit(user, body.qbo_customer_id)
    return _run(edit_hold, body.qbo_customer_id, user, expected_resume=body.expected_resume,
                reason=body.reason, note=body.note, hold_start=body.hold_start)


@router.post("/hold/resume")
def hold_resume(body: ResumeBody, user=Depends(get_current_user)):
    _can_edit(user, body.qbo_customer_id)
    return _run(resume, body.qbo_customer_id, user, body.resume_date)
