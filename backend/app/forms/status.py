"""
Per-form status engine (PM Portal Design v3, Milestone C2).

One PURE function — `form_status` — computes a crew form's tracking status
from its per-project settings (required + cadence + day exclusions, migrations
0053/0054), the project's schedule window + canonical operational status, and
that project's submission REPORT dates. No DB access here so the rules are
unit-testable in isolation.

Inputs use SERVER-LOCAL calendar dates — the same convention as the daily
log's log_date (daily/routes.py): Python `date.today()` on the API side, and
COALESCE(report_date, DATE(submitted_at)) on the MySQL side. report_date
(0054) is the day a submission is FOR — daily-type forms can be backfilled
for a missed day, and a backfill cures that day's overdue count.

C2 rule changes vs Milestone C:
  * Recurring expectations anchor at the PROJECT WINDOW START — the
    crew-assignment date no longer bounds anything (crews are usually
    assigned before start; late starts are handled by skips + backfill).
  * exclude_weekdays: ints 0=Mon .. 6=Sun — PYTHON date.weekday() numbering,
    NOT JavaScript's getDay() (which is Sun=0). Excluded weekdays are never
    expected days (e.g. [5, 6] = no Saturday/Sunday for a 5-day crew).
  * skipped_dates: ISO "YYYY-MM-DD" list — PM-excused specific days, never
    expected/overdue.
  * New cadence "as_needed": event-driven forms (truck loading/unloading,
    WG trailer, gear request). Never due or overdue — status is always
    "as_needed"; the UI shows the submission count instead of a verdict.
  * Every recurring verdict also carries {expected_so_far, filled} for the
    progress bar: expected_so_far = expected occurrence days from the window
    start through today (exclusions/skips removed); filled = how many of
    those are covered by a submission (distinct covered days <= today).
    Non-recurring cadences return None for both.

Statuses returned (always with `overdue_days` int, 0 unless overdue, plus
`expected_so_far` / `filled` — None outside recurring cadences):

  not_required   required=false — the PM marked the form off for this project.
  as_needed      cadence as_needed — never expected; count shown instead.
  upcoming       project isn't in_progress yet, or the window hasn't started.
  pending        one_time form whose trigger hasn't arrived (the completion
                 form before the last scheduled day).
  due            one_time form the crew should submit now (kickoff_update from
                 project start; completion from the last scheduled day onward).
  done           one_time form with >= 1 submission — or a recurring form
                 whose most recent expected day is covered and today isn't an
                 expected day (off days / between interval occurrences).
  done_today     recurring form with a submission dated today.
  due_today      recurring form expected today, nothing dated today, and the
                 previous expected day was covered (or there wasn't one yet).
  overdue        recurring form whose most recent expected day BEFORE today is
                 uncovered and today's isn't in yet. overdue_days = consecutive
                 uncovered expected days counting back from the most recent
                 one (occurrences, not calendar days, for interval cadences).

Cadence rules:

  one_time
    * done once >= 1 submission exists (any project status).
    * before the window starts, or while the project isn't in_progress
      -> upcoming.
    * during an in_progress project -> due — EXCEPT the completion form,
      which stays "pending" until the last scheduled day (due when
      today >= window end; with no known end date it stays pending).

  daily / every_other_day / weekly (in_progress projects only; else upcoming)
    * Expected days start at the WINDOW START and run through today (the form
      stays expected while the project runs past its scheduled end — overrun
      crews still report).
    * Excluded weekdays and skipped dates are never expected. Interval
      cadences (every_other_day / weekly) re-anchor on the first submission
      and STEP OVER excluded days: an occurrence that would land on an
      excluded day rolls forward to the next allowed day, and the next
      occurrence is counted from the rolled date.
    * A submission covers a daily expected day when dated exactly that day;
      an interval occurrence is covered by any submission dated in
      [occurrence, next occurrence).
    * submission dated today -> done_today (even on an off day).

  as_needed
    * always {"status": "as_needed"} (never due/overdue), any project status.
"""
from datetime import date, timedelta

CADENCES = ("one_time", "daily", "every_other_day", "weekly", "as_needed")
CADENCE_INTERVAL = {"daily": 1, "every_other_day": 2, "weekly": 7}

# Serve-time defaults when a form_code is absent from
# project_form_settings.forms (documented in migrations 0053 + 0054).
_DEFAULT_CADENCE = {
    "kickoff_update": "one_time",
    "daily_update": "daily",
    "completion": "one_time",
    "truck_unloading": "as_needed",
    "truck_loading": "as_needed",
    "wire_guidance_trailer": "as_needed",
    "gear_request": "as_needed",
}
# Event-driven forms default to not-required — the PM opts a project in.
_DEFAULT_NOT_REQUIRED = {
    "truck_unloading", "truck_loading", "wire_guidance_trailer", "gear_request",
}


def default_cadence(form_code: str) -> str:
    return _DEFAULT_CADENCE.get(form_code, "one_time")


def default_required(form_code: str) -> bool:
    return form_code not in _DEFAULT_NOT_REQUIRED


def _as_date(v):
    """Accept date / datetime / ISO string / None -> date or None."""
    if v is None:
        return None
    if isinstance(v, date):
        # datetime is a date subclass; strip the time part either way
        return date(v.year, v.month, v.day)
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def _result(status, overdue_days=0, expected_so_far=None, filled=None):
    return {"status": status, "overdue_days": overdue_days,
            "expected_so_far": expected_so_far, "filled": filled}


def form_status(*, form_code, required, cadence, project_status,
                window_start, window_end, submission_dates,
                exclude_weekdays=(), skipped_dates=(), today=None):
    """Compute one form's verdict:
    {"status", "overdue_days", "expected_so_far", "filled"}.

    submission_dates: iterable of dates (or ISO strings) — server-local
    COALESCE(report_date, DATE(submitted_at)) values for this project + form.
    exclude_weekdays: ints 0=Mon..6=Sun (Python date.weekday() numbering).
    skipped_dates: ISO date strings (or dates) the PM excused.
    """
    today = _as_date(today) or date.today()
    ws, we = _as_date(window_start), _as_date(window_end)
    subs = sorted({d for d in (_as_date(s) for s in submission_dates or []) if d})
    in_progress = (project_status or "").lower() == "in_progress"

    if not required:
        return _result("not_required")

    if cadence not in CADENCES:
        cadence = default_cadence(form_code)

    # ── as_needed ───────────────────────────────────────────────────────────
    if cadence == "as_needed":
        return _result("as_needed")

    # ── one_time ────────────────────────────────────────────────────────────
    if cadence == "one_time":
        if subs:
            return _result("done")
        if not in_progress:
            return _result("upcoming")
        if ws and today < ws:
            return _result("upcoming")
        if form_code == "completion":
            # Only due from the last scheduled day onward; before that it's
            # expected-but-not-yet. Unknown end date -> stays pending.
            if we and today >= we:
                return _result("due")
            return _result("pending")
        return _result("due")

    # ── recurring (daily / every_other_day / weekly) ────────────────────────
    if not in_progress:
        return _result("upcoming")

    excl_wd = {int(w) for w in (exclude_weekdays or ()) if 0 <= int(w) <= 6}
    skipped = {d for d in (_as_date(s) for s in (skipped_dates or ())) if d}

    def off(d):
        return d.weekday() in excl_wd or d in skipped

    interval = CADENCE_INTERVAL[cadence]
    submitted_today = today in subs

    # Anchor = window start; interval cadences re-anchor on the first
    # submission (the crew's own rhythm) — never earlier than the window.
    anchor = ws
    if interval > 1 and subs:
        anchor = max(anchor, subs[0]) if anchor else subs[0]
    if anchor is None:
        # No schedule window at all: nothing measurable.
        return _result("done_today" if submitted_today else "due_today")
    if anchor > today:
        return _result("upcoming", expected_so_far=0, filled=0)

    # Expected occurrence days from the anchor through today, stepping over
    # excluded weekdays / skipped dates (an occurrence landing on an off day
    # rolls forward; the next one counts from the rolled date).
    occs = []
    cur = anchor
    while cur <= today:
        while cur <= today and off(cur):
            cur += timedelta(days=1)
        if cur > today:
            break
        occs.append(cur)
        cur += timedelta(days=interval)

    # Coverage windows: an occurrence is covered by any submission dated in
    # [occurrence, next occurrence) — for daily that's exactly the day itself
    # unless off days follow (a Friday check-in covers the excluded weekend).
    ends = (occs[1:] + [occs[-1] + timedelta(days=interval)]) if occs else []

    def covered(i):
        lo, hi = occs[i], ends[i]
        return any(lo <= s < hi for s in subs)

    filled = sum(1 for i in range(len(occs)) if covered(i))
    expected = len(occs)

    if not occs:
        # Window started but every day so far is excluded/skipped.
        return _result("done_today" if submitted_today else "done",
                       expected_so_far=0, filled=0)

    if submitted_today:
        return _result("done_today", expected_so_far=expected, filled=filled)

    today_is_occ = occs[-1] == today
    # Most recent occurrence strictly before today.
    prev_i = len(occs) - 2 if today_is_occ else len(occs) - 1
    if prev_i >= 0 and not covered(prev_i):
        # Consecutive uncovered occurrences back from the most recent one —
        # bounded by the window start (occs never precede it).
        n, i = 0, prev_i
        while i >= 0 and not covered(i):
            n += 1
            i -= 1
        return _result("overdue", overdue_days=n,
                       expected_so_far=expected, filled=filled)

    if today_is_occ:
        return _result("due_today", expected_so_far=expected, filled=filled)
    return _result("done", expected_so_far=expected, filled=filled)
