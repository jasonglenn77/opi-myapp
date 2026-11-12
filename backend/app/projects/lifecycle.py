"""
A project's status is earned, not picked (owner decision 2026-11-12):

  setup        a Project Setup step is still open (or a change reopened one) and
               the job hasn't started
  ready        set up, start date still ahead
  in_progress  today is between the first start and the last day (end + overage)
  closing      past its last day, Closeout not finished
  closed       Closeout Review signed off (the margin step closed out)
  on_hold      manual: an active hold (projects/holds.py)
  canceled     manual: every schedule line canceled

Plus needs_review: open re-review items (setup/reviews.py) on any status.

project_schedule_items.status keeps being read by older pages, so
sync_line_status() keeps it in step with the dates: not_started / in_progress /
completed (canceled and on_hold lines are left alone). It's cheap and only
writes lines whose status is wrong; help/watch.run calls it.
"""
from collections import defaultdict
from datetime import date

from sqlalchemy import bindparam, text

LABELS = {"setup": "Setup", "ready": "Ready", "in_progress": "In progress", "closing": "Closing",
          "closed": "Closed", "on_hold": "On hold", "canceled": "Canceled"}
TONE = {"setup": "warn", "ready": "info", "in_progress": "good", "closing": "warn", "closed": "quiet",
        "on_hold": "bad", "canceled": "quiet"}
MANUAL_STEPS = ("details", "invoice_schedule", "crew_schedule", "expense_schedule")


def _in(sql, *names):
    return text(sql).bindparams(*[bindparam(n, expanding=True) for n in names])


def statuses(conn, eids=None):
    """{qbo_id: {status, label, tone, needs_review, reviews, start, last_day, why}}"""
    today = date.today()
    where = "AND qc.qbo_id IN :e" if eids else ""
    params = {"e": [str(x) for x in eids]} if eids else {}
    sql = f"""
        SELECT qc.qbo_id AS e, MIN(s.start_date) AS start,
               MAX(DATE_ADD(s.end_date, INTERVAL COALESCE(s.overage_days, 0) DAY)) AS last_day,
               SUM(s.status <> 'canceled') AS live_lines, SUM(s.status = 'on_hold') AS held_lines,
               SUM(s.start_date IS NULL OR s.end_date IS NULL) AS undated
        FROM qbo_customers qc JOIN projects p ON p.qbo_customer_id = qc.id
        JOIN project_schedule_items s ON s.project_id = p.id
        WHERE qc.is_project = 1 {where} GROUP BY qc.qbo_id"""
    rows = conn.execute(_in(sql, "e") if eids else text(sql), params).mappings().all()
    ids = [str(r["e"]) for r in rows]
    if not ids:
        return {}
    closed = {str(r[0]) for r in conn.execute(_in(
        "SELECT entity_id FROM project_closeout_steps WHERE step_key = 'margin' AND status = 'done' AND entity_id IN :e", "e"),
        {"e": ids}).all()}
    held = set()
    try:
        held = {str(r[0]) for r in conn.execute(text("SELECT entity_id FROM project_holds WHERE released_at IS NULL")).all()}
    except Exception:
        conn.rollback()
    reviews = defaultdict(int)
    for e, n in conn.execute(_in("""SELECT entity_id, COUNT(*) FROM project_setup_reviews
                                    WHERE resolved_at IS NULL AND entity_id IN :e GROUP BY entity_id""", "e"), {"e": ids}).all():
        reviews[str(e)] = int(n)
    marks = defaultdict(set)
    for e, k in conn.execute(_in(f"""SELECT subject, step_key FROM project_setup_steps
                                     WHERE subject IN :e AND step_key IN ({",".join(f"'{m}'" for m in MANUAL_STEPS)})""", "e"),
                             {"e": ids}).all():
        marks[str(e)].add(k)
    staffed = defaultdict(lambda: [False, False])
    for e, has_pm, has_crew in conn.execute(_in("""
        SELECT qc.qbo_id,
               MAX(EXISTS(SELECT 1 FROM project_schedule_item_project_managers m WHERE m.schedule_item_id = s.id AND m.unassigned_at IS NULL)),
               MAX(EXISTS(SELECT 1 FROM project_schedule_item_work_crews w WHERE w.schedule_item_id = s.id AND w.unassigned_at IS NULL))
        FROM qbo_customers qc JOIN projects p ON p.qbo_customer_id = qc.id
        JOIN project_schedule_items s ON s.project_id = p.id
        WHERE qc.qbo_id IN :e GROUP BY qc.qbo_id""", "e"), {"e": ids}).all():
        staffed[str(e)] = [bool(has_pm), bool(has_crew)]

    out = {}
    for r in rows:
        e = str(r["e"])
        start, last = r["start"], r["last_day"]
        why = ""
        if not r["live_lines"]:
            st = "canceled"
        elif e in held or (r["held_lines"] and r["held_lines"] == r["live_lines"]):
            st = "on_hold"
        elif e in closed:
            st = "closed"
        elif last and last < today and not r["undated"]:
            st, why = "closing", f"Ended {last:%m/%d/%y}"
        elif start and start <= today:
            st = "in_progress"
        else:
            pm, crew = staffed[e]
            missing = [w for w, ok in (("PM", pm), ("crew", crew), ("dates", bool(start and last and not r["undated"])),
                                       ("setup checks", len(marks[e]) == len(MANUAL_STEPS))) if not ok]
            if missing or reviews[e]:
                st, why = "setup", ("Missing: " + ", ".join(missing)) if missing else "Re-review open"
            else:
                st = "ready"
        out[e] = {"status": st, "label": LABELS[st], "tone": TONE[st], "needs_review": reviews[e] > 0,
                  "reviews": reviews[e], "start": str(start) if start else None,
                  "last_day": str(last) if last else None, "why": why}
    return out


def sync_line_status(conn):
    """Keep project_schedule_items.status in step with the dates (dated lines,
    not canceled or on hold). Returns how many lines changed."""
    return conn.execute(text("""
        UPDATE project_schedule_items SET status = CASE
            WHEN DATE_ADD(end_date, INTERVAL COALESCE(overage_days, 0) DAY) < CURDATE() THEN 'completed'
            WHEN start_date <= CURDATE() THEN 'in_progress' ELSE 'not_started' END
        WHERE start_date IS NOT NULL AND end_date IS NOT NULL
          AND status NOT IN ('canceled', 'on_hold')
          AND status <> CASE
            WHEN DATE_ADD(end_date, INTERVAL COALESCE(overage_days, 0) DAY) < CURDATE() THEN 'completed'
            WHEN start_date <= CURDATE() THEN 'in_progress' ELSE 'not_started' END""")).rowcount
