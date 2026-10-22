"""
Job Schedule → Assignments: keep the app's schedule lines (project_schedule_items
+ their crews / PMs) in step with OPI's "1 ON POINT Job Schedule" sheet, which is
where the office actually does all assignment work.

Reads the parsed sheet copy (gsync_schedule_days, refreshed by run.refresh_schedule)
and, for every job # worked from WINDOW_DAYS ago forward, rebuilds what the sheet
says about each visit and writes the differences through the normal assignment
save path (projects.service.save_schedule_item) as the "Job Schedule" system user,
so each change lands in the line's history like a hand edit.

How OPI encodes the sheet (verified on the May 2026 – Feb 2027 tabs):
  * a day cell = Crw | Job# | "Customer - City/State - Equipment - qualifier";
    the job # repeats on every day a crew slot works it;
  * Job# cell fill = the PM ("Color Code" tab: Kelly red, Leonardo pink, Tim
    blue, Amy light orange, Jack green);
  * description fill: yellow = first day, green = quoted last day, bright blue
    (instead of yellow) = start of a job WITH wire guidance;
  * description in ORANGE TEXT = overage days (work past the green quoted end);
  * "Travel" cells (usually no job #) sit in the crew's row next to the job;
    "NO Work" / "Weather" / "Pulled off" / "Not Available" are days off.

What the importer sets on each visit (a run of work days; a gap of more than
GAP_DAYS starts a new visit — a return trip / phase):
  start_date / end_date      first work day / last regular (non-orange) work day
  overage_days               calendar days from end_date to the last orange day
  status                     from the dates vs today (canceled is kept)
  crews                      company + slot from the crew codes (ABR→AB, GT→GT1);
                             an existing lead on the same company is kept
  primary PM                 from the Job# colour (other secondary PMs kept)
  wire_guidance              bright-blue start cell or "wire" in the description
  equipment_type             from the description (NO Equip / Electric / Equip)
  travel_days                travel cells next to the crews' first/last day
                             (only when the sheet shows travel)
  non_working.dates          days inside the visit nobody worked
Visits are matched to the job's existing lines by overlapping dates, then to the
job's current/future or undated lines; a visit with no line becomes a new extra
row. Other lines over the same visit ("siblings": the office's way of showing a
crew joining mid-job) keep their crews — those crews aren't repeated on the
matched line — and only get their status re-derived from their own dates.
Lines the sheet doesn't show are never deleted (Data Review lists them).
Jobs on the sheet with no app project are skipped and reported. A second run
with the same sheet changes nothing.

  python -m app.gsync.schedule_import            # dry run: print the diff
  python -m app.gsync.schedule_import --apply    # write it
"""
import collections
import json
import re
import secrets
import sys
import uuid
from datetime import date, timedelta
from types import SimpleNamespace

from sqlalchemy import text

from app.db import engine
from .review import PM_FILL, _kind, _norm_slot as _slot, _segments

WINDOW_DAYS = 60
GAP_DAYS = 7          # review._segments: a gap of more than 7 days starts a new visit
SYSTEM_EMAIL = "job-schedule@system.onpointinstallers.com"

WIRE_FILL = "FF00FFFF"
OVERAGE_FONTS = {"FFF6B26B", "FFFF9900"}


# ── sheet → visits ───────────────────────────────────────────────────────────

def _equipment(descs):
    """Most common app equipment value over the visit's descriptions."""
    votes = collections.Counter()
    for d in descs:
        parts = [p.strip() for p in re.split(r"\s+-\s*|-\s+", d or "") if p.strip()]
        tail = " ".join(parts[2:]).lower() if len(parts) >= 3 else ""
        if not tail:
            continue
        if re.search(r"\bno\s*equi?p", tail):
            votes["No Equip"] += 1
        elif "electric" in tail:
            votes["Electric"] += 1
        elif re.search(r"\b(fl|sl|th)\b|\b(fl|sl)'?s\b|equip", tail):
            votes["Equip"] += 1
    return votes.most_common(1)[0][0] if votes else None


def _jobs(cells):
    """{job#: {"work": {day: [cells]}, "other": [cells]}} from the sheet cells."""
    jobs = collections.defaultdict(lambda: {"work": collections.defaultdict(list), "other": []})
    for c in cells:
        for j in set(re.findall(r"\b(\d{4})\b", c["job"] or "")):
            if _kind(c["descr"] or c["extra"]) == "work":
                jobs[j]["work"][c["day"]].append(c)
            else:
                jobs[j]["other"].append(c)
    return jobs


def _travel(cells):
    """Travel cells → {(job, crew, day_of_job, side)}: a travel day belongs to
    the job the same crew row starts within 3 days after it (arrival), else to
    the job it finished within 3 days before (departure)."""
    by_crew = collections.defaultdict(dict)
    for c in cells:
        js = re.findall(r"\b(\d{4})\b", c["job"] or "")
        if js and _kind(c["descr"] or c["extra"]) == "work":
            by_crew[c["crew"]][c["day"]] = js[0]
    out = []
    for c in cells:
        if _kind(c["descr"] or c["extra"]) != "travel":
            continue
        days = by_crew.get(c["crew"], {})
        d = c["day"]
        nxt = next(((x, days[x]) for x in (d + timedelta(days=k) for k in range(1, 4)) if x in days), None)
        prv = next(((x, days[x]) for x in (d - timedelta(days=k) for k in range(1, 4)) if x in days), None)
        if nxt and not any(days.get(nxt[0] - timedelta(days=k)) == nxt[1] for k in range(1, GAP_DAYS + 1)):
            out.append((nxt[1], c["crew"], nxt[0], d, "before"))
        elif prv and not any(days.get(prv[0] + timedelta(days=k)) == prv[1] for k in range(1, GAP_DAYS + 1)):
            out.append((prv[1], c["crew"], prv[0], d, "after"))
    return out


def _sheet_visit(J, seg, travel, data_first, data_last):
    """Everything the sheet says about one visit (a list of work days)."""
    first, last = seg[0], seg[-1]
    wcells = [c for d in seg for c in J["work"][d]]
    # an overage day = every crew's cell that day is in orange text (a crew
    # still on its quoted days, e.g. the green end cell, means it isn't)
    orange = {d for d in seg if all(c["desc_font"] in OVERAGE_FONTS for c in J["work"][d])}
    tail = []
    for d in reversed(seg):
        if d not in orange:
            break
        tail.append(d)
    if not tail:
        end, over = last, 0
    elif len(tail) == len(seg):        # the whole visit is overage (a return trip past the quote)
        end, over = first, (last - first).days
    else:
        end = seg[len(seg) - len(tail) - 1]
        over = (last - end).days
    pm = collections.Counter(PM_FILL[c["job_fill"]] for c in wcells if c["job_fill"] in PM_FILL)
    descs = [c["descr"] for c in wcells if c["descr"]]
    wire = any(c["desc_fill"] == WIRE_FILL for c in wcells) or any(re.search(r"\bwire\b", d, re.I) for d in descs)
    crews = sorted({c["crew"] for c in wcells})
    # travel: per side, the most days any one crew spent travelling
    side = {"before": collections.defaultdict(set), "after": collections.defaultdict(set)}
    for crew, day, tday, s in travel:
        if first <= day <= last:
            side[s][crew].add(tday)
    tdays = max((len(v) for v in side["before"].values()), default=0) + \
        max((len(v) for v in side["after"].values()), default=0)
    # days off inside the visit (incl. overage): nobody worked the job that day
    off = [first + timedelta(days=i) for i in range((last - first).days + 1)]
    off = [d for d in off if d not in J["work"]]
    return {
        "first": first, "last": last, "start": first, "end": end, "overage": over,
        "crews": crews, "pm": pm.most_common(1)[0][0] if pm else None, "wire": wire,
        "equipment": _equipment(descs), "travel": tdays, "off": off,
        "cut_start": first <= data_first + timedelta(days=6),
        "cut_end": last >= data_last - timedelta(days=6),
        "desc": collections.Counter(descs).most_common(1)[0][0] if descs else None,
    }


# ── app side ─────────────────────────────────────────────────────────────────

def _projects(conn):
    """job# → [{qbo_customer_id, display_name, project_id}] (QBO projects)."""
    out = collections.defaultdict(list)
    for r in conn.execute(text("""
        SELECT qc.id AS qbo_customer_id, qc.display_name, qc.active, p.id AS project_id
        FROM qbo_customers qc LEFT JOIN projects p ON p.qbo_customer_id = qc.id
        WHERE qc.is_project = 1
    """)).mappings():
        m = re.match(r"\s*(\d{4})\b", r["display_name"] or "")
        if m:
            out[m.group(1)].append(dict(r))
    return out


def _items(conn, project_id):
    from app.projects.service import _parse_non_working
    items = []
    for r in conn.execute(text("""
        SELECT id, status, start_date, end_date, wire_guidance, travel_days, overage_days, equipment_type,
               notes, non_working, is_extra_row, sort_order
        FROM project_schedule_items WHERE project_id = :pid ORDER BY sort_order, start_date, id
    """), {"pid": project_id}).mappings():
        it = dict(r)
        it["non_working"] = _parse_non_working(it["non_working"])
        it["eend"] = it["end_date"] + timedelta(days=int(it["overage_days"] or 0)) if it["end_date"] else None
        it["crews"] = [dict(x) for x in conn.execute(text("""
            SELECT swc.work_crew_id, swc.is_primary, swc.slot_code,
                   COALESCE(swc.company_id, wc.parent_id, wc.id) AS company_id,
                   COALESCE(swc.lead_crew_id, CASE WHEN wc.parent_id IS NOT NULL THEN wc.id END) AS lead_crew_id
            FROM project_schedule_item_work_crews swc LEFT JOIN work_crews wc ON wc.id = swc.work_crew_id
            WHERE swc.schedule_item_id = :sid AND swc.unassigned_at IS NULL
            ORDER BY swc.is_primary DESC, swc.id
        """), {"sid": it["id"]}).mappings()]
        it["pms"] = [dict(x) for x in conn.execute(text("""
            SELECT project_manager_id, is_primary FROM project_schedule_item_project_managers
            WHERE schedule_item_id = :sid AND unassigned_at IS NULL ORDER BY is_primary DESC, project_manager_id
        """), {"sid": it["id"]}).mappings()]
        items.append(it)
    return items


def _match(visits, items, win):
    """Pair each visit with an existing line (or None → new row)."""
    def rng(it):
        return it["start_date"], it["eend"] or it["start_date"]
    pairs, used = {}, set()
    scored = []
    for vi, v in enumerate(visits):
        for it in items:
            if not it["start_date"]:
                continue
            s, e = rng(it)
            ov = (min(e, v["last"]) - max(s, v["first"])).days + 1
            if ov > 0:
                scored.append((it["status"] == "canceled", -ov, vi, it["id"]))
    for _, _, vi, iid in sorted(scored):
        if vi not in pairs and iid not in used:
            pairs[vi] = iid
            used.add(iid)
    # the rest, in date order: the job's current/future dated lines (moved
    # dates), then its undated lines (e.g. the master row nobody dated yet)
    spare = sorted((it for it in items if it["id"] not in used and it["status"] != "canceled" and it["start_date"]
                    and rng(it)[1] >= win - timedelta(days=21)), key=lambda it: it["start_date"])
    spare += [it for it in items if it["id"] not in used and it["status"] != "canceled" and not it["start_date"]]
    for vi, v in enumerate(visits):
        if vi not in pairs and spare and v["last"] >= win:
            pairs[vi] = spare.pop(0)["id"]
    return pairs


def _status(item, start, eend, today):
    if item and item["status"] == "canceled":
        return "canceled"
    if eend < today:
        return "completed"
    return "not_started" if start > today else "in_progress"


def _non_working(off, first, last):
    """Canonical non_working from the off days; weekends_off when every
    weekend day in the visit is off (and there is at least one weekend)."""
    span = [first + timedelta(days=i) for i in range((last - first).days + 1)]
    wk = [d for d in span if d.weekday() >= 5]
    offs = set(off)
    weekends = bool(wk) and all(d in offs for d in wk) and len(wk) >= 2
    dates = sorted(d.isoformat() for d in offs if not (weekends and d.weekday() >= 5))
    if not weekends and not dates:
        return None
    return {"weekends_off": weekends, "dates": dates[:120]}


def _target(v, it, crews_map, company_by_code, pm_ids, today, notes, claimed=()):
    """Request payload (dict) for one visit on line `it` (None = new row)."""
    start, end, over = v["start"], v["end"], v["overage"]
    if it and v["cut_start"] and it["start_date"] and it["start_date"] < start:
        start = it["start_date"]                      # the sheet copy starts mid-visit
    if it and v["cut_end"] and it["eend"] and it["eend"] > v["last"]:
        end, over = it["end_date"], int(it["overage_days"] or 0)   # the sheet doesn't reach that far yet
    if end < start:
        end = start
    eend = end + timedelta(days=over)

    # crews: company + slot from the sheet; keep a lead already on that company
    prior = list(it["crews"]) if it else []
    wanted, unknown, on_sibling = [], [], []
    for code in v["crews"]:
        s = _slot(code)
        co = company_by_code.get(s[0]) if s else None
        if not co:
            unknown.append(code)
        else:
            (on_sibling if (co, s[1]) in claimed else wanted).append((co, s[1]))
    if not wanted:          # never strip a line bare because a sibling repeats its crew
        wanted = on_sibling
    # 1st pass: the same slot (ABR2 ≡ AB2); 2nd pass: a leftover row of the
    # same company, preferring one with a lead — so a lead follows its company
    hits = {}
    for i, (co, slot) in enumerate(wanted):
        hit = next((p for p in prior if p["company_id"] == co and (_slot(p["slot_code"] or "") or ("", ""))[1] == slot), None)
        if hit:
            hits[i] = hit
            prior.remove(hit)
    for i, (co, slot) in enumerate(wanted):
        if i not in hits:
            hit = next((p for p in prior if p["company_id"] == co and p["lead_crew_id"]), None) or                 next((p for p in prior if p["company_id"] == co), None)
            if hit:
                hits[i] = hit
                prior.remove(hit)
    entries = [{"company_id": co, "lead_crew_id": hits[i]["lead_crew_id"] if i in hits else None,
                "slot_code": slot, "is_primary": bool(i in hits and hits[i]["is_primary"])}
               for i, (co, slot) in enumerate(wanted)]
    if sum(e["is_primary"] for e in entries) > 1:
        for e in entries:
            e["is_primary"] = False
    if unknown:
        notes["unknown_crews"].update(unknown)
    if not entries and it and it["crews"] and unknown:
        entries = None                                # only unmapped codes (e.g. DS): leave the crews alone

    # PMs: the colour's PM becomes primary; other secondary PMs stay
    old_pms = [p["project_manager_id"] for p in (it["pms"] if it else [])]
    old_primary = next((p["project_manager_id"] for p in (it["pms"] if it else []) if p["is_primary"]), None)
    pm = pm_ids.get(v["pm"]) if v["pm"] else None
    if pm:
        pms = [pm] + [x for x in old_pms if x not in (pm, old_primary)]
        primary = pm
    else:
        pms, primary = old_pms, old_primary

    return {
        "status": _status(it, start, eend, today),
        "start_date": start.isoformat(), "end_date": end.isoformat(), "overage_days": over,
        "wire_guidance": 1 if v["wire"] else 0,
        # travel is only partly marked on the sheet (often just the arrival
        # day), so it can raise the line's travel days but never lower them
        "travel_days": max(v["travel"], int((it or {}).get("travel_days") or 0)),
        # "Electric" is a kind of equipment the sheet rarely spells out: keep it
        "equipment_type": (it or {}).get("equipment_type") if v["equipment"] == "Equip" and
        (it or {}).get("equipment_type") == "Electric" else (v["equipment"] or (it or {}).get("equipment_type")),
        "non_working": _non_working(v["off"], start, eend),
        "crew_entries": entries, "pm_ids": pms, "primary_pm": primary,
    }


def _current(it):
    return {
        "status": it["status"],
        "start_date": it["start_date"].isoformat() if it["start_date"] else None,
        "end_date": it["end_date"].isoformat() if it["end_date"] else None,
        "overage_days": int(it["overage_days"] or 0), "wire_guidance": 1 if it["wire_guidance"] else 0,
        "travel_days": int(it["travel_days"] or 0), "equipment_type": it["equipment_type"],
        "non_working": it["non_working"],
    }


def _crew_key(entries):
    return sorted(((e["company_id"], e["lead_crew_id"], e["slot_code"], bool(e["is_primary"])) for e in entries), key=str)


def _diff(it, tgt, slot_label):
    """{field: [old, new]} between a line and its target."""
    if it is None:
        ch = {k: [None, v] for k, v in tgt.items() if k not in ("crew_entries", "pm_ids", "primary_pm")}
        ch["crews"] = [[], sorted(slot_label(c) for c in tgt["crew_entries"] or [])]
        ch["pms"] = [[], tgt["pm_ids"]]
        return ch
    cur = _current(it)
    ch = {k: [cur[k], tgt[k]] for k in cur if cur[k] != tgt[k]}
    if tgt["crew_entries"] is not None and _crew_key(tgt["crew_entries"]) != _crew_key(
            [{"company_id": c["company_id"], "lead_crew_id": c["lead_crew_id"], "slot_code": c["slot_code"],
              "is_primary": c["is_primary"]} for c in it["crews"]]):
        ch["crews"] = [sorted(slot_label(c) for c in it["crews"]), sorted(slot_label(c) for c in tgt["crew_entries"])]
    old_pms = [p["project_manager_id"] for p in it["pms"]]
    old_primary = next((p["project_manager_id"] for p in it["pms"] if p["is_primary"]), None)
    if set(old_pms) != set(tgt["pm_ids"]) or old_primary != tgt["primary_pm"]:
        ch["pms"] = [old_pms, tgt["pm_ids"]]
    return ch


# ── plan / apply ─────────────────────────────────────────────────────────────

def plan(conn, today=None):
    from app.projects.history import load_crews_map
    today = today or date.today()
    win = today - timedelta(days=WINDOW_DAYS)
    cells = [dict(r) for r in conn.execute(text("""
        SELECT day, crew, job, descr, extra, job_fill, desc_fill, desc_font FROM gsync_schedule_days
    """)).mappings()]
    if not cells:
        return {"error": "no Job Schedule cells — run the refresh first", "changes": [], "skipped": []}
    data_first, data_last = min(c["day"] for c in cells), max(c["day"] for c in cells)
    jobs = _jobs(cells)
    travel = collections.defaultdict(list)
    for job, crew, day, tday, side in _travel(cells):
        travel[job].append((crew, day, tday, side))
    projects = _projects(conn)
    crews_map = load_crews_map(conn)
    company_by_code = {(c["code"] or "").upper(): cid for cid, c in crews_map.items()
                       if c["parent_id"] is None and c["code"]}
    pm_ids = {r["first_name"]: int(r["id"]) for r in conn.execute(text(
        "SELECT id, first_name FROM project_managers WHERE is_active = 1")).mappings()}
    notes = {"unknown_crews": collections.Counter()}

    def slot_label(c):
        return c.get("slot_code") or (crews_map.get(c["company_id"]) or {}).get("code") or "?"

    changes, skipped, jobs_seen = [], [], 0
    for job in sorted(jobs):
        J = jobs[job]
        segs = _segments(J["work"])
        if not any(s[-1] >= win for s in segs):
            continue
        jobs_seen += 1
        # every visit on the sheet takes part in the matching (so a line that
        # spans an old visit + a return trip stays on the old visit), but only
        # recent visits — or old ones whose line reaches into the window — are written
        visits = [_sheet_visit(J, s, travel[job], data_first, data_last) for s in segs]
        job_pm = collections.Counter(PM_FILL[c["job_fill"]] for cs in J["work"].values() for c in cs
                                     if c["job_fill"] in PM_FILL).most_common(1)
        for v in visits:   # a visit typed without a colour takes the job's PM
            v["pm"] = v["pm"] or (job_pm[0][0] if job_pm else None)
        projs = projects.get(job) or []
        if not projs:
            skipped.append({"job": job, "why": "no app project", "desc": visits[-1]["desc"],
                            "dates": [[str(v["first"]), str(v["last"])] for v in visits if v["last"] >= win]})
            continue
        if len(projs) > 1:   # same job # on several QBO projects: the one with lines, else the active one
            projs.sort(key=lambda p: (p["project_id"] is None, not p["active"], p["qbo_customer_id"]))
        proj = projs[0]
        items = _items(conn, proj["project_id"]) if proj["project_id"] else []
        pairs = _match(visits, items, win)
        by_id = {it["id"]: it for it in items}
        matched = set(pairs.values())
        siblings_done = set()
        for vi, v in enumerate(visits):
            it = by_id.get(pairs.get(vi))
            if v["last"] < win and not (it and (it["eend"] or it["start_date"]) >= win):
                continue
            # Sibling lines: other lines over the same visit — the office's way
            # of showing a crew that joins / leaves mid-job. Their crews stay
            # on them (not also on the matched line); they only get their
            # status re-derived from their own dates.
            sibs = [x for x in items if x["id"] not in matched and x["status"] != "canceled" and x["start_date"]
                    and x["start_date"] <= v["last"] and (x["eend"] or x["start_date"]) >= v["first"]]
            claimed = {(c["company_id"], (_slot(c["slot_code"] or "") or ("", ""))[1]) for x in sibs for c in x["crews"]}
            tgt = _target(v, it, crews_map, company_by_code, pm_ids, today, notes, claimed)
            ch = _diff(it, tgt, slot_label)
            if ch:
                changes.append({"job": job, "project": proj["display_name"], "qbo_customer_id": proj["qbo_customer_id"],
                                "schedule_item_id": it["id"] if it else None, "visit": [str(v["first"]), str(v["last"])],
                                "changes": ch, "target": tgt, "item": it})
            for x in sibs:
                if x["id"] in siblings_done:
                    continue
                siblings_done.add(x["id"])
                st = _status(x, x["start_date"], x["eend"] or x["start_date"], today)
                if st != x["status"] and x["status"] not in ("pending", "needs_attention"):
                    t = {**_current(x), "status": st, "crew_entries": None,
                         "pm_ids": [p["project_manager_id"] for p in x["pms"]],
                         "primary_pm": next((p["project_manager_id"] for p in x["pms"] if p["is_primary"]), None)}
                    changes.append({"job": job, "project": proj["display_name"], "qbo_customer_id": proj["qbo_customer_id"],
                                    "schedule_item_id": x["id"], "visit": [str(v["first"]), str(v["last"])], "sibling": True,
                                    "changes": {"status": [x["status"], st]}, "target": t, "item": x})
    return {"jobs": jobs_seen, "changes": changes, "skipped": skipped,
            "unknown_crews": dict(notes["unknown_crews"]), "sheet": [str(data_first), str(data_last)]}


def system_user_id(conn):
    """The 'Job Schedule (Google sheet)' user the import writes as (inactive,
    no usable password — it only labels history rows)."""
    uid = conn.execute(text("SELECT id FROM users WHERE email = :e"), {"e": SYSTEM_EMAIL}).scalar()
    if uid:
        return int(uid)
    conn.execute(text("""
        INSERT INTO users (uuid, email, first_name, last_name, password_hash, role, is_active)
        VALUES (:u, :e, 'Job Schedule', '(Google sheet)', :p, 'user', 0)
    """), {"u": str(uuid.uuid4()), "e": SYSTEM_EMAIL, "p": "!disabled-" + secrets.token_hex(16)})
    return int(conn.execute(text("SELECT LAST_INSERT_ID()")).scalar())


def _request(c):
    t, it = c["target"], c["item"]
    crews = t["crew_entries"]
    if crews is None:   # keep the line's crews as they are
        crews = [{"company_id": x["company_id"], "lead_crew_id": x["lead_crew_id"], "slot_code": x["slot_code"],
                  "is_primary": bool(x["is_primary"])} for x in it["crews"]]
    return SimpleNamespace(
        schedule_item_id=it["id"] if it else None, qbo_customer_id=c["qbo_customer_id"], status=t["status"],
        start_date=t["start_date"], end_date=t["end_date"], wire_guidance=t["wire_guidance"],
        travel_days=t["travel_days"], overage_days=t["overage_days"], equipment_type=t["equipment_type"],
        project_manager_ids=t["pm_ids"], primary_project_manager_id=t["primary_pm"],
        work_crew_ids=[], primary_work_crew_id=None,
        crew_assignments=[SimpleNamespace(**e) for e in crews],
        notes=(it or {}).get("notes"), non_working=t["non_working"])


def apply(p):
    from app.projects.service import save_schedule_item
    with engine.begin() as conn:
        actor = system_user_id(conn)
    done, errors = collections.Counter(), []
    for c in p["changes"]:
        try:
            save_schedule_item(_request(c), actor)
            done["created" if c["schedule_item_id"] is None else "updated"] += 1
        except Exception as e:   # one bad line mustn't stop the rest
            errors.append({"job": c["job"], "schedule_item_id": c["schedule_item_id"], "error": str(e)})
    return {"created": done["created"], "updated": done["updated"], "errors": errors}


def summarize(p):
    fields = collections.Counter(f for c in p["changes"] for f in c["changes"])
    return {"jobs": p.get("jobs", 0), "lines_changed": sum(1 for c in p["changes"] if c["schedule_item_id"]),
            "lines_new": sum(1 for c in p["changes"] if not c["schedule_item_id"]),
            "fields": dict(fields), "skipped_jobs": [s["job"] for s in p["skipped"]],
            "unknown_crews": p.get("unknown_crews", {})}


def run(do_apply=False):
    with engine.connect() as conn:
        p = plan(conn)
    if p.get("error"):
        return {"error": p["error"]}, p
    s = summarize(p)
    if do_apply and p["changes"]:
        s.update(apply(p))
    return s, p


def _fmt(v):
    if isinstance(v, dict):
        return ("weekends+" if v.get("weekends_off") else "") + f"{len(v.get('dates') or [])}d"
    return str(v)


if __name__ == "__main__":
    summary, p = run(do_apply="--apply" in sys.argv)
    for c in p.get("changes", []):
        head = f"{c['job']} {c['project'][:40]:40} {'line ' + str(c['schedule_item_id']) if c['schedule_item_id'] else 'NEW LINE':10} visit {c['visit'][0]}..{c['visit'][1]}"
        print(head)
        for f, (o, n) in c["changes"].items():
            print(f"      {f:15} {_fmt(o)}  ->  {_fmt(n)}")
    for s in p.get("skipped", []):
        print("SKIP", s["job"], s["why"], s["desc"], s["dates"])
    print(json.dumps(summary, indent=1, default=str))
