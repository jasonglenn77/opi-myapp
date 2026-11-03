"""
Contractor Payments: one home for crew pay across every job.

  the plan    Payment Schedules read from Drive (project_payment_schedules)
  the budget  the estimate's contract labor, plus Pending estimates, plus any
              lodging someone recorded as included in the crew's amounts
  the actual  QuickBooks bills and checks for contract labor tagged to the job

Crews are paid in lump runs that cover several jobs, so one bill rarely matches
one schedule row. Everything here compares paid-to-date per job and crew company
(never row by row), and a crew company is the parent crew, which carries the
QuickBooks vendor.

Every inconsistency found becomes an issue with its own set of decisions. The
decisions live in review_decisions and are applied at read time, so the issues
can be rebuilt without losing them. If the amount changes after a decision, the
issue comes back marked "changed".
"""
import json
import time
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import text

from app.db import engine
from app.jobcost import service as JC
from . import forms as FORMS, misfiled as MISFILED

LAB = "Crew labor"
WINDOW_DAYS = 365            # finished jobs reviewed: ended in the last year
TOL_ABS, TOL_PCT = 250.0, 0.05   # same tolerance as the cash flow crew match
RUN_WEEKS_AHEAD = 6
RUN_DAYS_BACK = 21
LODGING_MIN = 2500.0         # below this a missing lodging cost isn't worth a look
SNAP_KEY = "crewpay"

# type -> label, severity (1 worst), the decisions offered
DECIDE_STD = [["explained", "Explained"], ["update_schedule", "Update the schedule"], ["hold", "Hold payments"]]
ISSUE_TYPES = {
    "paid_over": ("Paid more than the schedule", 1,
                  [["overpaid", "Real overpayment"], ["update_schedule", "Schedule needs updating"], ["co_coming", "Change order coming"], ["explained", "Explained"]]),
    "labor_over": ("Labor over the estimate", 1,
                   [["co_coming", "Change order coming"], ["explained", "Explained"], ["real_overage", "Real overage"]]),
    "paid_under": ("Finished job, paid less than the schedule", 2,
                   [["still_owed", "Still owed"], ["update_schedule", "Schedule needs updating"], ["explained", "Explained"]]),
    "behind": ("Scheduled payments not paid yet", 2, DECIDE_STD),
    "no_schedule": ("No Payment Schedule", 2, [["create_schedule", "Create a schedule"], ["explained", "Not needed"]]),
    "sched_vs_est": ("Schedule doesn't match the estimate", 3,
                     [["update_schedule", "Schedule needs updating"], ["includes_lodging", "Includes lodging"], ["co_coming", "Change order coming"], ["explained", "Explained"]]),
    "lodging_none": ("Lodging estimated, none recorded", 2,
                     [["includes_lodging", "Crew pay includes it"], ["not_recorded", "Not recorded yet"], ["explained", "Explained"]]),
    "sheet_paid": ("Marked paid on the sheet, not in QuickBooks", 2,
                   [["record_in_qbo", "Record in QuickBooks"], ["fix_sheet", "Sheet is wrong"], ["explained", "Explained"]]),
    "duplicate": ("Possible duplicate schedule", 2, [["fix_sheet", "Remove the copy"], ["explained", "Both are real"]]),
    "dates": ("Payment dates outside the job", 3, [["update_schedule", "Schedule needs updating"], ["explained", "Explained"]]),
    "no_crew": ("Schedule has no crew", 3, [["fix_sheet", "Crew to be set"], ["explained", "Explained"]]),
    "no_vendor": ("Crew has no QuickBooks vendor", 3, [["fix_setup", "Link the vendor"], ["explained", "Explained"]]),
    "no_job_tag": ("Crew bill with no job", 3, [["tag_in_qbo", "Tag it in QuickBooks"], ["explained", "Not job labor"]]),
    "file": ("Payment file not matched to a project", 3, [["fix_sheet", "Rename or move the file"], ["explained", "Ignore this file"]]),
    "app_edit": ("Changed in the app, not in Drive", 3, [["fix_sheet", "Update the sheet"], ["explained", "Keep it in the app only"]]),
    "no_forms": ("Crew forms missing", 3, [["get_form", "Get it from the crew"], ["explained", "Not needed"]]),
    "misfiled_estimate": ("Pending estimate filed under the customer", 2,
                          [["move_in_qbo", "Belongs to this job: move it in QuickBooks"], ["explained", "Separate quote"]]),
}
OPEN_STATUSES = ("hold", "update_schedule", "still_owed", "create_schedule", "record_in_qbo", "fix_sheet", "fix_setup", "tag_in_qbo", "not_recorded", "get_form",
                 "move_in_qbo")
DECISION_LABELS = {k: v for t in ISSUE_TYPES.values() for k, v in t[2]}


def _tol(v):
    return max(TOL_ABS, TOL_PCT * abs(v))


def _money(v):
    return f"${float(v):,.0f}"


def _crews(conn):
    """crew id -> company {id, name, vendor}, and vendor -> company."""
    rows = conn.execute(text("""
        SELECT wc.id, wc.name, wc.parent_id, wc.vendor_qbo_id, pc.name AS pname, pc.vendor_qbo_id AS pv
        FROM work_crews wc LEFT JOIN work_crews pc ON pc.id = wc.parent_id
    """)).mappings().all()
    co, by_vendor = {}, {}
    for r in rows:
        cid = r["parent_id"] or r["id"]
        co[r["id"]] = {"id": cid, "name": r["pname"] or r["name"], "vendor": str(r["pv"] or r["vendor_qbo_id"] or "") or None}
    for r in rows:
        for v in (r["vendor_qbo_id"], r["pv"]):
            if v:
                by_vendor[str(v)] = co[r["id"]]
    return co, by_vendor


def _paid_lines(conn, entity_id=None):
    """Contract labor bills and checks. Owner pay sits on payroll accounts, so
    the item test keeps it out. One job's lines when entity_id is given."""
    return conn.execute(text("""
        SELECT l.id AS line_id, l.line_customer_qbo_id AS e, t.entity_type AS type, t.txn_date AS d, t.doc_number AS doc, t.qbo_id AS txn,
               COALESCE(t.vendor_qbo_id, JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.EntityRef.value'))) AS vendor,
               COALESCE(JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.VendorRef.name')),
                        JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.EntityRef.name'))) AS vendor_name,
               l.description AS descr, l.amount AS a
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE t.entity_type IN ('Bill', 'Purchase')""" + (" AND l.line_customer_qbo_id = :e" if entity_id is not None else "") + """
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')),
                       SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')), ':', 1))
              LIKE 'Contract Labor%'
    """), {"e": str(entity_id)} if entity_id is not None else {}).mappings().all()


def _schedules(conn):
    scheds = conn.execute(text("""
        SELECT s.id, s.entity_id, s.estimate_qbo_id, s.estimate_doc_number, s.crew_id, s.source, s.source_file_id, s.source_file_name,
               s.source_label, s.source_modified, s.lodging_included, s.lodging_note, s.sheet_paid_to_date,
               (SELECT d.id FROM documents d WHERE d.source_drive_id = s.source_file_id
                 ORDER BY d.entity_id = s.entity_id DESC, d.id DESC LIMIT 1) AS doc_id
        FROM project_payment_schedules s
    """)).mappings().all()
    insts = defaultdict(list)
    for r in conn.execute(text("""
        SELECT id, schedule_id, seq, pay_date, amount, send_invoice_date, status, note, sheet_paid, paid_source, qbo_txn_id, edited
        FROM project_payment_installments ORDER BY schedule_id, seq, id
    """)).mappings():
        insts[r["schedule_id"]].append(r)
    return scheds, insts


def data_sig():
    with engine.connect() as conn:
        return JC.data_sig() + "|" + "|".join(str(conn.execute(text(q)).scalar()) for q in (
            "SELECT CONCAT(COUNT(*), '/', SUM(amount), '/', COALESCE(MAX(updated_at), '')) FROM project_payment_installments",
            "SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(updated_at), ''), '/', COALESCE(SUM(lodging_included), 0)) FROM project_payment_schedules",
            "SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(updated_at), '')) FROM app_overrides WHERE resolved_at IS NULL",
            "SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(id), 0), '/', COUNT(drive_removed_at)) FROM documents",
            "SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(id), 0)) FROM form_submissions",
            "SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(read_at), '')) FROM completion_form_dates"))


def build():
    today = date.today()
    since = today - timedelta(days=WINDOW_DAYS)
    jobs = {j["id"]: j for j in JC.dataset()["jobs"]}
    with engine.connect() as conn:
        co, by_vendor = _crews(conn)
        lines = _paid_lines(conn)
        scheds, insts = _schedules(conn)
        names = {str(r[0]): r[1] for r in conn.execute(text("SELECT qbo_id, display_name FROM qbo_customers WHERE is_project = 1")).all()}
        files = conn.execute(text("""SELECT file_id, name, path, status, match_note, modified FROM gsync_payment_files
                                     WHERE status IN ('unmatched', 'duplicate')""")).mappings().all()
        from app.gsync import overrides as OV
        app_edits = [i for i in OV.items(conn) if (i.get("ref") or {}).get("file_id") or "crew" in (i.get("title") or "")]
        forms_on_file = FORMS.load(conn)

    rows = {}                    # (entity, company key) -> crew-and-job row

    def row(e, key, name, vendor=None):
        k = (e, key)
        if k not in rows:
            rows[k] = {"entity_id": e, "crew_key": key, "crew": name, "vendor": vendor, "schedule": 0.0, "to_date": 0.0,
                       "paid": 0.0, "lodging": 0.0, "last_paid": None, "next_date": None, "next_amount": 0.0,
                       "schedules": [], "sheet_marked": 0.0, "pending_past": 0}
        return rows[k]

    live = []                    # schedules with money on them
    for s in scheds:
        items = [i for i in insts.get(s["id"], []) if float(i["amount"] or 0) != 0]
        e = str(s["entity_id"])
        if not items:
            continue
        c = co.get(s["crew_id"]) if s["crew_id"] else None
        key, name = (f"c{c['id']}", c["name"]) if c else ("none", "No crew set")
        r = row(e, key, name, c["vendor"] if c else None)
        total = sum(float(i["amount"]) for i in items)
        r["schedule"] += total
        r["lodging"] += float(s["lodging_included"] or 0)
        r["schedules"].append({"id": s["id"], "file": s["source_file_name"], "label": s["source_label"], "doc_id": s["doc_id"],
                               "source": s["source"], "total": round(total, 2), "lodging": float(s["lodging_included"] or 0),
                               "lodging_note": s["lodging_note"], "estimate": s["estimate_doc_number"], "rows": len(items)})
        for i in items:
            amt, d = float(i["amount"]), i["pay_date"]
            if d and d <= today:
                r["to_date"] += amt
                if i["sheet_paid"] and not i["qbo_txn_id"]:
                    r["sheet_marked"] += amt
            elif d and i["status"] != "paid" and (r["next_date"] is None or d < r["next_date"]):
                r["next_date"], r["next_amount"] = d, amt
            elif d and d == r["next_date"] and i["status"] != "paid":
                r["next_amount"] += amt
        live.append((s, items, e, key))

    no_job = []
    for l in lines:
        v = str(l["vendor"] or "")
        c = by_vendor.get(v)
        amt = float(l["a"] or 0)
        if not l["e"]:
            if l["d"] and l["d"] >= since:
                no_job.append({**dict(l), "crew": c["name"] if c else l["vendor_name"]})
            continue
        e = str(l["e"])
        if c:
            key, name = f"c{c['id']}", c["name"]
        else:
            key, name = f"v{v or 'none'}", l["vendor_name"] or "Unknown vendor"
        if (e, key) not in rows and (e, "none") in rows:
            key, name = "none", rows[(e, "none")]["crew"]     # an unnamed schedule: its bills count against it
        r = row(e, key, name, c["vendor"] if c else v)
        r["paid"] += amt
        if l["d"] and (r["last_paid"] is None or l["d"] > r["last_paid"]):
            r["last_paid"] = l["d"]

    def in_scope(j):
        return j and (j["state"] in ("active", "upcoming") or j["end"] >= str(since))

    out_rows, job_totals = [], defaultdict(lambda: {"schedule": 0.0, "paid": 0.0, "to_date": 0.0, "lodging": 0.0, "crews": 0})
    for (e, _), r in rows.items():
        t = job_totals[e]
        for f in ("schedule", "paid", "to_date", "lodging"):
            t[f] += r[f]
        t["crews"] += 1
    for (e, _), r in rows.items():
        j = jobs.get(e)
        if not in_scope(j):
            continue
        out_rows.append({**r, "job": j["name"], "pm": j["pm"], "state": j["state"], "start": j["start"], "end": j["end"],
                         "schedule": round(r["schedule"], 2), "paid": round(r["paid"], 2), "to_date": round(r["to_date"], 2),
                         "remaining": round(r["schedule"] - r["paid"], 2), "lodging": round(r["lodging"], 2),
                         "last_paid": str(r["last_paid"]) if r["last_paid"] else None,
                         "next_date": str(r["next_date"]) if r["next_date"] else None,
                         "next_amount": round(r["next_amount"], 2),
                         "budget": round(j["est"].get(LAB, 0.0), 2), "pending": round(j["pend"].get(LAB, 0.0) if j.get("pend") else 0.0, 2)})
    out_rows.sort(key=lambda x: (x["job"], x["crew"]))

    issues = []

    def issue(kind, e, crew, amount, detail, sub=""):
        label, sev, _ = ISSUE_TYPES[kind]
        j = jobs.get(e) or {}
        issues.append({"key": f"{kind}:{e or '-'}:{sub}"[:158], "type": kind, "label": label, "severity": sev, "entity_id": e,
                       "job": j.get("name") or names.get(e or "") or None, "pm": j.get("pm"), "crew": crew, "state": j.get("state"),
                       "amount": round(amount, 2) if amount is not None else None, "detail": detail,
                       "fingerprint": str(round(amount)) if amount is not None else ""})

    for e, t in job_totals.items():
        j = jobs.get(e)
        if not in_scope(j) or j["state"] == "upcoming":
            continue
        crew = ", ".join(sorted(r["crew"] for r in out_rows if r["entity_id"] == e)) or None
        sched, paid, est = t["schedule"], t["paid"], j["est"].get(LAB, 0.0)
        pend = (j.get("pend") or {}).get(LAB, 0.0)
        lod_est = j["est"].get("Lodging", 0.0)
        finished = j["state"] == "finished"
        if sched > 0 and paid > sched + _tol(sched):
            co_note = f" {_money(pend)} of labor is on Pending estimates." if pend else ""
            issue("paid_over", e, crew, paid - sched, f"Schedule {_money(sched)}, paid {_money(paid)}.{co_note}")
        if finished and sched > 0 and paid < sched - _tol(sched):
            issue("paid_under", e, crew, sched - paid, f"Schedule {_money(sched)}, paid {_money(paid)}. The job ended {j['end']}.")
        if not finished and sched > 0 and paid < t["to_date"] - _tol(t["to_date"]):
            issue("behind", e, crew, t["to_date"] - paid, f"{_money(t['to_date'])} scheduled through today, {_money(paid)} paid.")
        if not sched and (paid > 0 or est > 0):
            issue("no_schedule", e, crew, paid or est,
                  f"Estimate labor {_money(est)}, paid {_money(paid)}, no Payment Schedule in Drive.")
        if est > 0 and paid > (est + t["lodging"]) * 1.10:
            over = paid - est - t["lodging"]
            still = paid - (est + pend + t["lodging"])
            why = f"Estimate {_money(est)}, paid {_money(paid)}."
            if t["lodging"]:
                why += f" {_money(t['lodging'])} of the crew's amounts is recorded as lodging."
            if pend:
                why += f" {_money(pend)} is on Pending estimates, leaving {_money(max(0.0, still))}."
            else:
                why += " No Pending estimate on this job, so a change order may not have been created."
            issue("labor_over", e, crew, over, why)
        # crews sometimes cover their own lodging inside their amounts, and nothing
        # labels it: a lodging estimate with no lodging cost is the visible trace
        lod_act = j["act"].get("Lodging", 0.0)
        half_done = date.fromisoformat(j["start"]) + (date.fromisoformat(j["end"]) - date.fromisoformat(j["start"])) / 2 <= today
        if lod_est >= LODGING_MIN and lod_act < 0.05 * lod_est and half_done and not t["lodging"]:
            issue("lodging_none", e, crew, lod_est,
                  f"Lodging estimate {_money(lod_est)}, {_money(lod_act)} recorded. Crew paid {_money(paid)} against {_money(est)} of labor. "
                  "The crew may be covering lodging in its amounts, or the hotel bills aren't on this job.")
        if sched > 0 and est > 0:
            gap = sched - t["lodging"] - (est + pend)
            if abs(gap) > _tol(est):
                hint = ""
                if gap > 0 and lod_est and abs(gap - lod_est) <= max(500.0, 0.15 * lod_est):
                    hint = f" The difference is close to the lodging estimate ({_money(lod_est)}), so the crew amounts may include lodging."
                issue("sched_vs_est", e, crew, gap, f"Schedule {_money(sched)} vs estimate {_money(est)}"
                      + (f" plus {_money(pend)} pending" if pend else "") + f".{hint}")

    for (e, key), r in rows.items():
        j = jobs.get(e)
        if not in_scope(j):
            continue
        if r["sheet_marked"] > r["paid"] + _tol(r["sheet_marked"]):
            issue("sheet_paid", e, r["crew"], r["sheet_marked"] - r["paid"],
                  f"The sheet marks {_money(r['sheet_marked'])} paid. QuickBooks shows {_money(r['paid'])} to this crew on this job.", key)
        if key == "none":
            issue("no_crew", e, None, r["schedule"], "A schedule on this job has no crew, so payments can't be checked against a vendor.")
        if len(r["schedules"]) > 1:
            seen = {}
            for s in r["schedules"]:
                twin = next((o for o in seen if abs(o - s["total"]) <= max(1.0, 0.01 * s["total"])), None)
                if twin is not None:
                    issue("duplicate", e, r["crew"], s["total"],
                          f"\"{seen[twin]['file'] or seen[twin]['estimate']}\" and \"{s['file'] or s['estimate']}\" both total {_money(s['total'])}. If one is a copy, this job's schedule is double counted.",
                          f"{key}:{s['id']}")
                seen[s["total"]] = s

    for s, items, e, key in live:
        j = jobs.get(e)
        if not in_scope(j) or j["state"] == "finished":
            continue
        start, end = date.fromisoformat(j["start"]), date.fromisoformat(j["end"])
        off = [i for i in items if i["status"] != "paid" and i["pay_date"]
               and (i["pay_date"] < start - timedelta(days=14) or i["pay_date"] > end + timedelta(days=45))]
        if off:
            issue("dates", e, rows[(e, key)]["crew"], sum(float(i["amount"]) for i in off),
                  f"{len(off)} unpaid payment(s) dated outside the job ({j['start']} to {j['end']}), in {s['source_file_name'] or 'the schedule'}. The sheet may predate a date change.",
                  str(s["id"]))

    for c_id, name in {c["id"]: c["name"] for c in co.values() if not c["vendor"]}.items():
        if any(r["crew"] == name for r in out_rows):
            issue("no_vendor", None, name, None, "This crew has schedules but no QuickBooks vendor, so its payments can't be matched.", str(c_id))

    no_job_by = defaultdict(list)
    for l in no_job:
        no_job_by[l["crew"] or "Unknown vendor"].append(l)
    for crew, ls in no_job_by.items():      # loans, legal and software bills land here too, so show what they say
        ls.sort(key=lambda x: -abs(float(x["a"] or 0)))
        said = "; ".join(dict.fromkeys(" ".join((x["descr"] or "no description").split())[:40] for x in ls[:4]))
        issue("no_job_tag", None, crew, sum(float(x["a"] or 0) for x in ls),
              f"{len(ls)} line(s) booked to Contract Labor with no job in the last year: {said}", crew[:60])

    from app.gsync.payment_import import drive_link
    for f in files:
        issues.append({"key": f"file::{f['file_id']}", "type": "file", "label": ISSUE_TYPES["file"][0], "severity": 3, "entity_id": None,
                       "job": None, "pm": None, "crew": None, "state": None, "amount": None, "fingerprint": "",
                       "detail": f"{f['name']}: {f['match_note'] or f['status']}", "drive_url": drive_link(f["file_id"], None)})
    for i in app_edits:
        ref = i.get("ref") or {}
        if not ref.get("override_id") or not ref.get("file_id"):
            continue
        issues.append({"key": f"app_edit::{ref['override_id']}", "type": "app_edit", "label": ISSUE_TYPES["app_edit"][0], "severity": 3,
                       "entity_id": str(ref.get("qbo_id") or "") or None, "job": None, "pm": None, "crew": None, "state": None,
                       "amount": None, "fingerprint": "", "detail": i.get("title") or "", "drive_url": ref.get("sheet_url")})

    job_crews, job_paid = defaultdict(set), defaultdict(float)
    for (e, _), r in rows.items():
        job_crews[e].add(r["crew"])
        job_paid[e] += r["paid"]
    form_rows = []
    for e, j in jobs.items():
        crew = ", ".join(sorted(job_crews.get(e, ()))) or None
        f = FORMS.row(j, forms_on_file.get(e, {}), crew, job_paid.get(e, 0.0))
        f["recent"] = bool(in_scope(j))
        form_rows.append(f)
        # kickoff and completion are the forms OPI has always kept; see forms.py on daily forms
        if in_scope(j) and ("completion" in f["missing"] or (f["none"] and f["missing"])):
            gone = [FORMS.GROUPS[g] for g in f["missing"] if g != "daily"]
            draft = " The Word copy on file isn't signed." if f["draft"] else ""
            issue("no_forms", e, crew, None, f"Missing: {', '.join(gone)}.{draft} Job {'ended ' + j['end'] if j['state'] == 'finished' else 'in progress'}, "
                  f"crew paid {_money(f['paid'])}. This clears once it's in the project's documents.")
    form_rows.sort(key=lambda f: (-len(f["missing"]), f["job"]))

    # Pending estimates under the customer that look like this job's change orders
    with engine.connect() as conn:
        misfiled = [m for m in MISFILED.find(conn, jobs) if in_scope(jobs.get(m["entity_id"]))]
    by_job = defaultdict(list)
    for m in misfiled:
        by_job[m["entity_id"]].append(m)
        looks = "Reads like a change order for this job." if m["why"] == "change order" else "Same company and site, dated during or soon after this job."
        issue("misfiled_estimate", m["entity_id"], None, m["amount"],
              f"Estimate {m['doc']} ({m['date']}) is Pending under {m['customer']}, not on the job: \"{m['memo']}\". {looks} "
              "Until it's moved to the job in QuickBooks it isn't counted as pending here. It could also be a separate quote.", m["qbo_id"])
    for i in issues:
        if i["type"] in ("paid_over", "labor_over") and by_job.get(i["entity_id"]):
            ms = by_job[i["entity_id"]]
            i["detail"] = i["detail"].replace(", so a change order may not have been created.", ".")
            i["detail"] +=f" {_money(sum(m['amount'] for m in ms))} more is on Pending estimate{'s' if len(ms) > 1 else ''} " \
                           f"{', '.join(m['doc'] for m in ms)} filed under the customer, which may belong to this job."

    issues.sort(key=lambda i: (i["severity"], -abs(i["amount"] or 0)))

    # upcoming pay runs (approve / hold)
    run_rows = []
    job_seen = {r["entity_id"]: r for r in out_rows}
    for s, items, e, key in live:
        j = jobs.get(e)
        if not j or j["state"] == "finished" and not in_scope(j):
            continue
        t = job_totals[e]
        budget = j["est"].get(LAB, 0.0) + (j.get("pend") or {}).get(LAB, 0.0) + t["lodging"]
        cr = rows[(e, key)]
        for i in items:
            d = i["pay_date"]
            if not d or i["status"] == "paid" or not (today - timedelta(days=RUN_DAYS_BACK) <= d <= today + timedelta(weeks=RUN_WEEKS_AHEAD)):
                continue
            if d <= today and cr["paid"] >= cr["to_date"] - _tol(cr["to_date"]):
                continue          # bills don't match rows one to one: the crew is paid up on this job
            run_rows.append({"id": i["id"], "date": str(d), "send_invoice": str(i["send_invoice_date"]) if i["send_invoice_date"] else None,
                             "entity_id": e, "job": j["name"], "pm": j["pm"], "crew": rows[(e, key)]["crew"], "amount": float(i["amount"]),
                             "note": i["note"], "file": s["source_file_name"], "doc_id": s["doc_id"],
                             "paid_on_job": round(t["paid"], 2), "budget": round(budget, 2)})
    run_rows.sort(key=lambda r: (r["date"], r["crew"], r["job"]))

    crews = defaultdict(lambda: {"schedule": 0.0, "paid": 0.0, "jobs": 0, "remaining": 0.0})
    for r in out_rows:
        c = crews[r["crew"]]
        c["schedule"] += r["schedule"]
        c["paid"] += r["paid"]
        c["jobs"] += 1
        c["remaining"] += max(0.0, r["remaining"]) if r["state"] != "finished" else 0.0
    crew_list = sorted(({"crew": k, **{f: round(v, 2) for f, v in c.items()}} for k, c in crews.items()), key=lambda c: -c["paid"])

    return {"built": time.time(), "rows": out_rows, "issues": issues, "runs": run_rows, "crews": crew_list, "forms": form_rows,
            "rules": {"tol_abs": TOL_ABS, "tol_pct": TOL_PCT, "window_days": WINDOW_DAYS, "over_pct": JC.OVER_PCT},
            "issue_types": {k: {"label": v[0], "decisions": v[2]} for k, v in ISSUE_TYPES.items()}}


def refresh_snapshot():
    from app import snapshots
    return snapshots.rebuild(SNAP_KEY, build, data_sig)


def _decisions(conn):
    return {r["ikey"]: dict(r) for r in conn.execute(text("""
        SELECT ikey, status, amount, note, fingerprint, decided_by, decided_at FROM review_decisions WHERE area = 'crew_pay'
    """)).mappings()}


def _approvals(conn):
    return {r["installment_id"]: dict(r) for r in conn.execute(text("SELECT * FROM crew_pay_approvals")).mappings()}


def apply_review(d):
    """Lay the saved decisions and approvals over the built data."""
    with engine.connect() as conn:
        dec, appr = _decisions(conn), _approvals(conn)
    issues = []
    for i in d["issues"]:
        x = dec.get(i["key"])
        n = {**i, "decision": None, "changed": False}
        if x:
            n["changed"] = (x["fingerprint"] or "") != i["fingerprint"]
            n["decision"] = {"status": x["status"], "label": DECISION_LABELS.get(x["status"], x["status"]),
                             "amount": float(x["amount"]) if x["amount"] is not None else None, "note": x["note"],
                             "by": x["decided_by"], "at": str(x["decided_at"])}
        issues.append(n)
    runs = []
    for r in d["runs"]:
        a = appr.get(r["id"])
        # an approval only stands for the date and amount it was given on
        live = a and str(a["pay_date"]) == r["date"] and abs(float(a["amount"] or 0) - r["amount"]) < 0.005
        runs.append({**r, "approval": ({"decision": a["decision"], "note": a["note"], "by": a["decided_by"],
                                        "at": str(a["decided_at"])} if live else None),
                     "approval_lapsed": bool(a) and not live})
    def is_open(i):
        return i["decision"] is None or i["changed"] or i["decision"]["status"] in OPEN_STATUSES
    open_items = [i for i in issues if is_open(i)]
    next_date = next((r["date"] for r in runs if r["date"] >= str(date.today())), None)
    return {**d, "issues": issues, "runs": runs, "summary": {
        "open": len(open_items), "open_amount": round(sum(abs(i["amount"] or 0) for i in open_items), 2),
        "paid_over": round(sum(i["amount"] or 0 for i in issues if i["type"] == "paid_over"), 2),
        "paid_over_jobs": sum(i["type"] == "paid_over" for i in issues),
        "labor_over": round(sum(i["amount"] or 0 for i in issues if i["type"] == "labor_over"), 2),
        "labor_over_jobs": sum(i["type"] == "labor_over" for i in issues),
        "next_date": next_date, "next_amount": round(sum(r["amount"] for r in runs if r["date"] == next_date), 2),
        "held": round(sum(r["amount"] for r in runs if (r["approval"] or {}).get("decision") == "hold"), 2)}}


def dataset(force=False):
    from app import snapshots
    data, meta = snapshots.serve(SNAP_KEY, build, data_sig, max_age=1800, force=force)
    return {**apply_review(data), "snapshot": meta}


def job_detail(entity_id):
    """Everything behind one job: schedules, every crew bill, pending estimates, change log."""
    jobs = {j["id"]: j for j in JC.dataset()["jobs"]}
    j = jobs.get(str(entity_id))
    with engine.connect() as conn:
        co, by_vendor = _crews(conn)
        scheds = conn.execute(text("""
            SELECT s.id, s.crew_id, s.estimate_doc_number, s.source, s.source_file_name, s.source_label, s.source_modified,
                   s.lodging_included, s.lodging_note,
                   (SELECT d.id FROM documents d WHERE d.source_drive_id = s.source_file_id
                     ORDER BY d.entity_id = s.entity_id DESC, d.id DESC LIMIT 1) AS doc_id
            FROM project_payment_schedules s WHERE s.entity_id = :e
        """), {"e": entity_id}).mappings().all()
        out = []
        for s in scheds:
            rows = conn.execute(text("""
                SELECT id, seq, pay_date, amount, send_invoice_date, status, note, sheet_paid, paid_source, edited
                FROM project_payment_installments WHERE schedule_id = :s AND amount <> 0 ORDER BY seq, id
            """), {"s": s["id"]}).mappings().all()
            if not rows:
                continue
            c = co.get(s["crew_id"]) or {}
            out.append({"id": s["id"], "crew": c.get("name"), "estimate": s["estimate_doc_number"], "source": s["source"],
                        "file": s["source_file_name"], "label": s["source_label"], "modified": str(s["source_modified"] or "")[:10] or None,
                        "lodging": float(s["lodging_included"] or 0), "lodging_note": s["lodging_note"], "doc_id": s["doc_id"],
                        "total": round(sum(float(r["amount"]) for r in rows), 2),
                        "rows": [{"id": r["id"], "date": str(r["pay_date"]) if r["pay_date"] else None, "amount": float(r["amount"]),
                                  "invoice": str(r["send_invoice_date"]) if r["send_invoice_date"] else None, "status": r["status"],
                                  "note": r["note"], "sheet_paid": bool(r["sheet_paid"]), "paid_source": r["paid_source"]} for r in rows]})
        bills = [{"date": str(l["d"]), "type": "Card/check" if l["type"] == "Purchase" else "Bill", "doc": l["doc"],
                  "crew": (by_vendor.get(str(l["vendor"] or "")) or {}).get("name") or l["vendor_name"],
                  "description": l["descr"], "amount": float(l["a"] or 0)}
                 for l in sorted(_paid_lines(conn, entity_id), key=lambda x: str(x["d"]))]
        log = [{"at": str(r["created_at"]), "who": r["actor_email"], "action": r["action"], "file": r["target_label"],
                "detail": json.loads(r["detail"]) if isinstance(r["detail"], str) else r["detail"]}
               for r in conn.execute(text("""
            SELECT created_at, actor_email, action, target_label, detail FROM audit_log
            WHERE action LIKE 'crew\\_%' AND JSON_UNQUOTE(JSON_EXTRACT(detail, '$.entity_id')) = :e
            ORDER BY id DESC LIMIT 100
        """), {"e": str(entity_id)}).mappings()]
        from app.change_orders.routes import pending_change_orders
        try:
            pending = pending_change_orders(conn, entity_id)
        except Exception:
            pending = []
    return {"job": j, "schedules": out, "bills": bills, "log": log, "pending": pending}
