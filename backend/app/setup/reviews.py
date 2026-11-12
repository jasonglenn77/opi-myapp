"""
Re-review: a change to a project that's set up (or being set up) reopens only
the setup steps it affects, and the project goes back to Project Setup's To do
list showing why (owner decision 2026-11-12).

  Change                                         Steps reopened
  dates moved, a set of dates added or removed   dates (why / change order?), pm, crew, the 3 schedules
  change order (app CO, or a new QBO estimate)   qbo_estimate, invoice_schedule, crew_schedule,
                                                 expense_schedule, dates (does it add days?)
  crew changed                                   crew, crew_schedule
  contract value changed in QuickBooks           invoice_schedule
  PM changed                                     none (alert only)

Where changes come from (read once each, by watermark, from help/watch.run):
  project_schedule_item_history   dates, crews (Assignments page, Project Setup,
                                  the nightly Job Schedule import, holds)
  audit_log                       change_order.* actions
  qbo_transactions (Estimate)     count / total per live project vs project_setup_watch

Every date change is also written to schedule_date_changes (the line's date
history: why it moved, change order needed?). Its unanswered rows keep the
dates step open until someone answers them on Project Setup.
"""
import json
from collections import defaultdict
from datetime import date, datetime, timedelta

from sqlalchemy import bindparam, text

STEPS_FOR = {
    "dates": ["dates", "pm", "crew", "invoice_schedule", "crew_schedule", "expense_schedule"],
    "change_order": ["qbo_estimate", "invoice_schedule", "crew_schedule", "expense_schedule", "dates"],
    "crew": ["crew", "crew_schedule"],
    "contract": ["invoice_schedule"],
}
DATE_FIELDS = ("start_date", "end_date", "overage_days")
REASONS = [
    ("customer_delay", "Customer delay or request"),
    ("added_scope", "Added scope"),
    ("weather", "Weather"),
    ("material", "Material / equipment late"),
    ("crew", "Crew availability or performance"),
    ("schedule_fix", "Correcting the schedule (no real change)"),
    ("on_hold", "Put on hold"),
    ("other", "Other"),
]
CO_ANSWERS = ("yes", "no", "sent")
LIVE_DAYS = 21     # a project counts as live until this many days after its last day


def _in(sql, *names):
    t = text(sql)
    return t.bindparams(*[bindparam(n, expanding=True) for n in names])


def _d(v):
    if v in (None, "", "null"):
        return None
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _md(d):
    return f"{d.month}/{d.day}" if d else "none"


# ── reading ──────────────────────────────────────────────────────────────────
def open_reviews(conn, eids):
    """{eid: {step: {id, kind, reason, at, by}}} for open reviews."""
    eids = [str(e) for e in eids if e]
    if not eids:
        return {}
    out = defaultdict(dict)
    for r in conn.execute(_in("""SELECT id, entity_id, step_key, trigger_kind, reason, created_at, created_by
                                 FROM project_setup_reviews WHERE resolved_at IS NULL AND entity_id IN :e""", "e"),
                          {"e": eids}).mappings():
        out[str(r["entity_id"])][r["step_key"]] = {"id": r["id"], "kind": r["trigger_kind"], "reason": r["reason"],
                                                   "at": str(r["created_at"]), "by": r["created_by"]}
    return out


def date_changes(conn, eid, unanswered_only=False, limit=200):
    rows = conn.execute(text(f"""
        SELECT c.*, s.sort_order FROM schedule_date_changes c
        LEFT JOIN project_schedule_items s ON s.id = c.schedule_item_id
        WHERE c.entity_id = :e {"AND c.answered_at IS NULL" if unanswered_only else ""}
        ORDER BY c.changed_at DESC, c.id DESC LIMIT :n"""), {"e": str(eid), "n": limit}).mappings().all()
    out = []
    for r in rows:
        x = {k: (str(v) if isinstance(v, (date, datetime)) else v) for k, v in dict(r).items()}
        x["summary"] = describe(r)
        out.append(x)
    return out


def describe(r):
    """'End 12/4 → 12/18; overage 0 → 3 days' for one schedule_date_changes row."""
    if r["action"] == "created":
        return f"Dates added: {_md(_d(r['new_start']))} to {_md(_d(r['new_end']))}"
    if r["action"] == "deleted":
        return f"Dates removed: {_md(_d(r['old_start']))} to {_md(_d(r['old_end']))}"
    bits = []
    if r["old_start"] != r["new_start"]:
        bits.append(f"start {_md(_d(r['old_start']))} → {_md(_d(r['new_start']))}")
    if r["old_end"] != r["new_end"]:
        bits.append(f"end {_md(_d(r['old_end']))} → {_md(_d(r['new_end']))}")
    if (r["old_overage"] or 0) != (r["new_overage"] or 0):
        bits.append(f"overage {r['old_overage'] or 0} → {r['new_overage'] or 0} days")
    return "; ".join(bits).capitalize() or "Dates changed"


# ── writing ──────────────────────────────────────────────────────────────────
def add(conn, eid, kind, reason, by=None, steps=None):
    """Open (or extend) a review on each step `kind` affects. Returns the steps
    newly opened."""
    eid = str(eid)
    steps = steps or STEPS_FOR[kind]
    have = {r[0]: (r[1], r[2]) for r in conn.execute(text(
        "SELECT step_key, id, reason FROM project_setup_reviews WHERE entity_id = :e AND resolved_at IS NULL"),
        {"e": eid}).all()}
    opened = []
    for s in steps:
        if s in have:
            rid, old = have[s]
            if reason and reason not in (old or ""):
                conn.execute(text("UPDATE project_setup_reviews SET reason = :r WHERE id = :i"),
                             {"r": ((old + " · ") if old else "") + reason, "i": rid})
            continue
        conn.execute(text("""INSERT INTO project_setup_reviews (entity_id, step_key, trigger_kind, reason, created_by)
                             VALUES (:e, :s, :k, :r, :b)"""), {"e": eid, "s": s, "k": kind, "r": (reason or "")[:1000], "b": by})
        opened.append(s)
    return opened


def resolve(conn, eid, step, by=None, note=None):
    n = conn.execute(text("""UPDATE project_setup_reviews SET resolved_at = NOW(), resolved_by = :b, resolution_note = :n
                             WHERE entity_id = :e AND step_key = :s AND resolved_at IS NULL"""),
                     {"e": str(eid), "s": step, "b": by, "n": (note or None)}).rowcount
    return n


def answer_change(conn, change_id, reason_code, co_needed, note, by):
    """Why a date moved and whether a change order is needed. Answering the last
    open one resolves the dates review; 'yes' opens a change-order to-do."""
    r = conn.execute(text("SELECT * FROM schedule_date_changes WHERE id = :i"), {"i": change_id}).mappings().first()
    if not r:
        return None
    conn.execute(text("""UPDATE schedule_date_changes SET reason_code = :rc, co_needed = :co, note = :n,
                             answered_by = :b, answered_at = NOW() WHERE id = :i"""),
                 {"rc": reason_code, "co": co_needed, "n": (note or None), "b": by, "i": change_id})
    eid = r["entity_id"]
    if co_needed == "yes":
        add(conn, eid, "change_order", f"Change order needed: {describe(r)}", by=by, steps=["qbo_estimate"])
    left = conn.execute(text("SELECT COUNT(*) FROM schedule_date_changes WHERE entity_id = :e AND answered_at IS NULL"),
                        {"e": eid}).scalar()
    if not left:
        resolve(conn, eid, "dates", by, "Every date change answered")
    return eid


# ── detecting changes ────────────────────────────────────────────────────────
def _live(conn, cids=None, eids=None):
    """{internal customer id: qbo_id} of projects still live: not canceled, last
    day within LIVE_DAYS (or no dates yet), not closed out."""
    today = date.today()
    rows = conn.execute(text("""
        SELECT qc.id AS cid, qc.qbo_id AS e,
               MAX(DATE_ADD(s.end_date, INTERVAL COALESCE(s.overage_days, 0) DAY)) AS last_day,
               SUM(s.status <> 'canceled') AS live_lines
        FROM qbo_customers qc JOIN projects p ON p.qbo_customer_id = qc.id
        JOIN project_schedule_items s ON s.project_id = p.id
        WHERE qc.is_project = 1 GROUP BY qc.id, qc.qbo_id""")).mappings().all()
    closed = {str(r[0]) for r in conn.execute(text(
        "SELECT entity_id FROM project_closeout_steps WHERE step_key = 'margin' AND status = 'done'")).all()}
    out = {}
    for r in rows:
        e = str(r["e"])
        if not r["live_lines"] or e in closed:
            continue
        if r["last_day"] and r["last_day"] < today - timedelta(days=LIVE_DAYS):
            continue
        out[r["cid"]] = e
    return out


def _who(conn, uid):
    if uid is None:
        return "the Job Schedule (nightly import)"
    r = conn.execute(text("SELECT email FROM users WHERE id = :u"), {"u": uid}).first()
    return r[0] if r else "the app"


def _from_history(conn, start, live):
    """schedule_date_changes rows + reviews from history rows after `start`."""
    rows = conn.execute(text("""
        SELECT h.id, h.schedule_item_id, h.action, h.changed_by_user_id AS uid, h.changed_at, h.changes,
               p.qbo_customer_id AS cid
        FROM project_schedule_item_history h
        JOIN project_schedule_items s ON s.id = h.schedule_item_id JOIN projects p ON p.id = s.project_id
        WHERE h.id > :w ORDER BY h.id LIMIT 3000"""), {"w": start}).mappings().all()
    if not rows:
        return start, {}
    # lines per project that already had dates (adding a phase is a change; the first dates are setup)
    dated_before = defaultdict(int)
    for cid, n in conn.execute(text("""SELECT p.qbo_customer_id, COUNT(*) FROM project_schedule_items s
            JOIN projects p ON p.id = s.project_id WHERE s.start_date IS NOT NULL GROUP BY p.qbo_customer_id""")).all():
        dated_before[cid] = n
    reasons = defaultdict(list)
    for r in rows:
        e = live.get(r["cid"])
        if not e:
            continue
        try:
            ch = json.loads(r["changes"]) if isinstance(r["changes"], str) else (r["changes"] or {})
        except ValueError:
            ch = {}
        pair = lambda f: ch.get(f) if isinstance(ch.get(f), list) and len(ch.get(f)) == 2 else [None, None]  # noqa: E731
        by = _who(conn, r["uid"])
        src = "job_schedule" if r["uid"] is None else "app"
        date_moved = False
        if r["action"] == "updated":
            date_moved = any((int(pair(f)[0] or 0) != int(pair(f)[1] or 0)) if f == "overage_days" else pair(f)[0] is not None
                             for f in DATE_FIELDS if f in ch)
        elif r["action"] in ("created", "deleted") and dated_before.get(r["cid"], 0) > (1 if r["action"] == "created" else 0):
            s_new, s_old = pair("start_date")[1], pair("start_date")[0]
            date_moved = bool(s_new if r["action"] == "created" else (s_old or True))
        if date_moved:
            row = {"e": e, "sid": r["schedule_item_id"], "hid": r["id"], "a": r["action"], "src": src,
                   "os": _d(pair("start_date")[0]), "ns": _d(pair("start_date")[1]),
                   "oe": _d(pair("end_date")[0]), "ne": _d(pair("end_date")[1]),
                   "oo": pair("overage_days")[0], "no": pair("overage_days")[1], "by": by, "at": r["changed_at"]}
            if r["action"] == "updated":     # unchanged fields: fill both sides with the line's current value
                cur = conn.execute(text("SELECT start_date, end_date, overage_days FROM project_schedule_items WHERE id = :i"),
                                   {"i": r["schedule_item_id"]}).mappings().first() or {}
                for f, o, n in (("start_date", "os", "ns"), ("end_date", "oe", "ne"), ("overage_days", "oo", "no")):
                    if f not in ch:
                        row[o] = row[n] = cur.get(f)
            on_hold = (pair("status")[1] == "on_hold") or (pair("status")[0] == "on_hold")
            conn.execute(text("""INSERT IGNORE INTO schedule_date_changes
                (entity_id, schedule_item_id, history_id, action, source, old_start, new_start, old_end, new_end,
                 old_overage, new_overage, changed_by, changed_at, reason_code, answered_by, answered_at)
                VALUES (:e, :sid, :hid, :a, :src, :os, :ns, :oe, :ne, :oo, :no, :by, :at, :rc, :ab, :aa)"""),
                {**row, "rc": "on_hold" if on_hold else None, "ab": "the hold" if on_hold else None,
                 "aa": r["changed_at"] if on_hold else None})
            desc = describe({"action": r["action"], "old_start": row["os"], "new_start": row["ns"], "old_end": row["oe"],
                             "new_end": row["ne"], "old_overage": row["oo"], "new_overage": row["no"]})
            why = f"{desc} ({by}, {r['changed_at']:%m/%d})"
            add(conn, e, "dates", why, by=by)
            reasons[e].append(why)
        if r["action"] == "updated" and "crews" in ch and pair("crews")[0]:
            old, new = pair("crews")
            why = f"Crew {', '.join(old or []) or 'none'} → {', '.join(new or []) or 'none'} ({by})"
            add(conn, e, "crew", why, by=by)
            reasons[e].append(why)
    return rows[-1]["id"], reasons


def _from_audit(conn, start, live_eids):
    rows = conn.execute(text("""SELECT id, actor_email, action, target_label, detail FROM audit_log
        WHERE id > :w AND action LIKE 'change_order.%' ORDER BY id LIMIT 2000"""), {"w": start}).mappings().all()
    last = conn.execute(text("SELECT COALESCE(MAX(id), :w) FROM audit_log"), {"w": start}).scalar()
    reasons = defaultdict(list)
    for r in rows:
        try:
            d = json.loads(r["detail"]) if isinstance(r["detail"], str) else (r["detail"] or {})
        except ValueError:
            d = {}
        e = str(d.get("entity_id") or d.get("project_qbo_id") or "")
        if e not in live_eids or not r["action"].startswith(("change_order.create", "change_order.update")):
            continue
        why = f"Change order {'added' if 'create' in r['action'] else 'updated'}: {r['target_label'] or ''} ({r['actor_email'] or 'the app'})".replace(":  (", " (")
        add(conn, e, "change_order", why, by=r["actor_email"])
        reasons[e].append(why)
    return last, reasons


def _from_estimates(conn, live_eids):
    """A new QuickBooks estimate on a live project = a change order; the same
    count with a different total = the contract value changed."""
    if not live_eids:
        return {}
    cur = {str(r[0]): (int(r[1]), float(r[2] or 0)) for r in conn.execute(_in("""
        WITH latest AS (
          SELECT customer_qbo_id AS e, total_amt,
                 ROW_NUMBER() OVER (PARTITION BY customer_qbo_id, COALESCE(doc_number, qbo_id) ORDER BY id DESC) AS rn
          FROM qbo_transactions WHERE entity_type = 'Estimate' AND customer_qbo_id IN :e)
        SELECT e, COUNT(*), SUM(total_amt) FROM latest WHERE rn = 1 GROUP BY e""", "e"), {"e": list(live_eids)}).all()}
    seen = {str(r[0]): (int(r[1]), float(r[2])) for r in conn.execute(_in(
        "SELECT entity_id, est_n, est_total FROM project_setup_watch WHERE entity_id IN :e", "e"), {"e": list(live_eids)}).all()}
    reasons = defaultdict(list)
    for e in live_eids:
        n, tot = cur.get(e, (0, 0.0))
        if e in seen:
            n0, t0 = seen[e]
            if n > n0 and n0 > 0:
                why = f"New estimate in QuickBooks ({n0} → {n} estimates, total ${t0:,.0f} → ${tot:,.0f})"
                add(conn, e, "change_order", why, by="QuickBooks")
                reasons[e].append(why)
            elif n == n0 and abs(tot - t0) > 1 and n0 > 0:
                why = f"Contract value changed in QuickBooks: ${t0:,.0f} → ${tot:,.0f}"
                add(conn, e, "contract", why, by="QuickBooks")
                reasons[e].append(why)
        conn.execute(text("""INSERT INTO project_setup_watch (entity_id, est_n, est_total, checked_at) VALUES (:e, :n, :t, NOW())
                             ON DUPLICATE KEY UPDATE est_n = VALUES(est_n), est_total = VALUES(est_total), checked_at = NOW()"""),
                     {"e": e, "n": n, "t": round(tot, 2)})
    return reasons


def process(conn):
    """One pass over everything new. Returns {eid: [why, ...]} for projects that
    went back to review (for the alert). Call inside a transaction."""
    marks = dict(conn.execute(text("SELECT name, last_id FROM notification_watermark WHERE name IN ('setup_history', 'setup_audit')")).all())
    if "setup_history" not in marks:
        return {}
    live = _live(conn)
    live_eids = set(live.values())
    h_last, r1 = _from_history(conn, int(marks["setup_history"]), live)
    a_last, r2 = _from_audit(conn, int(marks.get("setup_audit", 0)), live_eids)
    r3 = _from_estimates(conn, live_eids)
    conn.execute(text("UPDATE notification_watermark SET last_id = :v WHERE name = 'setup_history'"), {"v": h_last})
    conn.execute(text("UPDATE notification_watermark SET last_id = :v WHERE name = 'setup_audit'"), {"v": a_last})
    out = defaultdict(list)
    for part in (r1, r2, r3):
        for e, why in part.items():
            out[e] += why
    return out
