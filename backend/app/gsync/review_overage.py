"""
Data Review — category "schedule", phase by phase: every visit / phase on the
Job Schedule in the stored copy (the last year) against the app's schedule line
for it, with the overage days. Read-only, like the rest of Data Review.

How the Job Schedule marks overage (checked on the copy, 2026-11-12): every
calendar day has a column, weekends included; a day past the quoted end is a
cell with ORANGE text, on Saturdays and Sundays as often as weekdays (crews work
through weekends). So an overage day is a calendar day worked past the green
quoted-end cell. The app stores overage_days = calendar days from the last
regular day to the last orange day (schedule_import), which equals the orange
cells marked unless there are days off in between.

Types
  phase_dates         the app line's start / quoted end / last day / overage days
                      differ from the sheet's phase
  phase_missing       a phase on the sheet with no app line overlapping it
  overage_marking     the sheet's own marks are ambiguous, so the overage can't be
                      read for sure: orange days with no green quoted-end cell,
                      two green cells in one phase, crews going orange on
                      different days, days off inside the overage
"""
import collections
from datetime import date, timedelta

from sqlalchemy import text

from . import schedule_import as SI
from .review import _item, _md

GREEN = "FF00FF00"


def _visits(conn):
    cells = [dict(r) for r in conn.execute(text(
        "SELECT day, crew, job, descr, extra, job_fill, desc_fill, desc_font FROM gsync_schedule_days")).mappings()]
    if not cells:
        return [], None, None
    first, last = min(c["day"] for c in cells), max(c["day"] for c in cells)
    jobs = SI._jobs(cells)
    out = []
    for job in sorted(jobs):
        J = jobs[job]
        for seg in SI._phases(J["work"]):
            v = SI._sheet_visit(J, seg, [], first, last)
            if v["cut_start"]:
                continue            # began before the oldest stored tab: its start can't be judged
            days = sorted(seg)
            greens = [d for d in days if any(c.get("desc_fill") == GREEN for c in J["work"][d])]
            some = {d for d in days if any(c["desc_font"] in SI.OVERAGE_FONTS for c in J["work"][d])}
            every = {d for d in days if all(c["desc_font"] in SI.OVERAGE_FONTS for c in J["work"][d])}
            tail_from = v["end"] + timedelta(days=1) if v["overage"] else None
            v.update(job=job, greens=greens, marked=len(every),
                     early=sorted(d for d in every | some if tail_from is None or d < tail_from),
                     partial=sorted(some - every),
                     off_in_over=[d for d in v["off"] if tail_from and d >= tail_from])
            out.append(v)
    return out, first, last


def overage_items(conn):
    visits, first, last = _visits(conn)
    if not visits:
        return []
    projects, lines = {}, collections.defaultdict(list)
    for r in conn.execute(text("""
        SELECT qc.qbo_id, qc.display_name, p.id AS pid FROM qbo_customers qc
        JOIN projects p ON p.qbo_customer_id = qc.id WHERE qc.is_project = 1""")).mappings():
        j = (r["display_name"] or "")[:4]
        if j.isdigit():
            projects.setdefault(j, dict(r))
    for r in conn.execute(text("""
        SELECT id, project_id, status, start_date, end_date, COALESCE(overage_days, 0) od
        FROM project_schedule_items WHERE status <> 'canceled' AND start_date IS NOT NULL AND end_date IS NOT NULL""")).mappings():
        it = dict(r)
        it["eend"] = it["end_date"] + timedelta(days=int(it["od"]))
        lines[it["project_id"]].append(it)

    out = []
    for v in visits:
        p = projects.get(v["job"])
        if not p:
            continue                # "not_in_app" is already reported per job (review.schedule_items)
        name, link = p["display_name"], f"#/entity/project/{p['qbo_id']}"
        ref = {"job": v["job"], "qbo_id": p["qbo_id"]}
        span = f"{_md(v['start'])} – {_md(v['last'])}"
        sheet = {"start": str(v["start"]), "quoted_end": str(v["end"]), "last_day": str(v["last"]),
                 "overage_days": v["overage"], "orange_days_marked": v["marked"]}
        key = f"{v['job']}:{v['start']}"

        why = []
        if v["overage"] and not v["greens"]:
            why.append("orange overage days but no green quoted-end cell")
        if len(v["greens"]) > 1:
            why.append("two green quoted-end cells (" + ", ".join(_md(g) for g in v["greens"]) + ")")
        if v["early"]:
            why.append(f"some crews are orange from {_md(v['early'][0])}, before the phase's last regular day")
        if v["partial"] and not v["early"]:
            why.append(f"{len(v['partial'])} day(s) where only some crews are orange")
        if v["off_in_over"]:
            why.append(f"{len(v['off_in_over'])} day(s) off inside the overage (the app counts them; "
                       f"{v['marked']} orange days are marked vs {v['overage']} calendar days)")
        if why:
            out.append(_item("schedule", "overage_marking", key, "low",
                             f"{name}: overage on the Job Schedule is unclear ({span})",
                             "; ".join(why).capitalize() + ".",
                             fix="Check the colours with whoever keeps the Job Schedule: one green cell on the quoted "
                                 "last day, orange text on every day worked past it.",
                             link=link, sheet=sheet, ref=ref))

        best = None
        for it in lines.get(p["pid"], []):
            ov = (min(it["eend"], v["last"]) - max(it["start_date"], v["first"])).days + 1
            if ov > 0 and (best is None or ov > best[0]):
                best = (ov, it)
        if not best:
            out.append(_item("schedule", "phase_missing", key, "medium",
                             f"{name}: the Job Schedule has a phase the app doesn't ({span})",
                             f"Sheet: {span}" + (f", quoted end {_md(v['end'])}, {v['overage']} overage days" if v["overage"] else "") + ".",
                             fix="Add a set of dates for this phase on the Assignment (or the nightly import adds it "
                                 "if the phase is recent).", link=link, sheet=sheet, ref=ref))
            continue
        it = best[1]
        app = {"line": it["id"], "start": str(it["start_date"]), "quoted_end": str(it["end_date"]),
               "last_day": str(it["eend"]), "overage_days": int(it["od"]), "status": it["status"]}
        diffs = []
        if it["start_date"] != v["start"]:
            diffs.append(f"start {_md(it['start_date'])} vs {_md(v['start'])}")
        if it["end_date"] != v["end"]:
            diffs.append(f"quoted end {_md(it['end_date'])} vs {_md(v['end'])}")
        if int(it["od"]) != v["overage"]:
            diffs.append(f"overage {int(it['od'])} vs {v['overage']} days")
        if it["eend"] != v["last"] and it["end_date"] == v["end"]:
            diffs.append(f"last day {_md(it['eend'])} vs {_md(v['last'])}")
        if not diffs:
            continue
        worst = max(abs((it["start_date"] - v["start"]).days), abs((it["eend"] - v["last"]).days),
                    abs(int(it["od"]) - v["overage"]))
        sev = "low" if worst <= 2 else "medium" if worst <= 14 else "high"
        out.append(_item("schedule", "phase_dates", key, sev,
                         f"{name}: phase {span} differs from the app line",
                         "App vs Job Schedule: " + "; ".join(diffs) + ".",
                         fix=("Recent phases are corrected by the nightly import. For a finished phase, update the "
                              "Assignment line (or the sheet, if the app is right)."),
                         link=link, sheet=sheet, app=app, ref={**ref, "schedule_item_id": it["id"]}))
    return out


items = overage_items
