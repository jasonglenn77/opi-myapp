"""
Data Review — category "payments": the crew "Payment Schedule" files in Drive
vs the app. Since 2026-11-12 the files are read for reference only (never
applied): this lists what couldn't be matched or mapped, where the sheet,
QuickBooks and the Job Schedule disagree, and (sheet_differs) where a sheet says
something different from the app's crew payment schedule. Reads only the database: gsync_payment_files (the import's cached
parse, with the per-file issues of the last run in parsed._issues),
qbo_customers, and gsync_schedule_days for the Job Schedule check.

Types
  unmatched_file        file not tied to a project (no project folder, no usable Project Number)
  ambiguous_project     Project Number cell points at another project than the folder
  unknown_crew          crew company couldn't be worked out (file name, comments, app, Assignment, QBO bills)
  total_mismatch        the rows don't add up to the sheet's Contract Value
  paid_over_sheet       QBO Contract-Labor bills on the project exceed every sheet's total
  labor_not_on_sheet    accepted change-order labor the sheet can't include, added by the app
  off_calendar          pay dates not on the company bi-weekly payroll Friday
  bad_date              typos fixed / TBD dates / send-invoice dates that didn't fit
  sheet_paid_no_qbo     row marked pd/paid on the sheet, no QBO crew bill found
  qbo_paid_not_marked   QBO bill matches a row the sheet (which uses pd marks) doesn't mark paid
  skipped_superseded / skipped_duplicate   an older version / a copy with upcoming rows was skipped
  no_payment_schedule   on the Job Schedule with a crew (now / next 45 days), no Payment Schedule file
"""
import collections
import json
import re
from datetime import date, timedelta

from sqlalchemy import text

from .review import _item, _money, _md, _kind

CAT = "payments"
GSHEET = "application/vnd.google-apps.spreadsheet"


def _url(fid, mime):
    return (f"https://docs.google.com/spreadsheets/d/{fid}/edit" if mime == GSHEET
            else f"https://drive.google.com/file/d/{fid}/view")


def _dates(ds, n=6):
    ds = [d for d in ds if d]
    s = ", ".join(_md(d) if re.match(r"\d{4}-\d\d-\d\d", str(d)) else str(d) for d in ds[:n])
    return s + (f" (+{len(ds) - n} more)" if len(ds) > n else "")


def payment_items(conn):
    today = date.today()
    rows = conn.execute(text("""
        SELECT f.file_id, f.name, f.mime_type, f.modified, f.path, f.entity_id, f.match_kind, f.match_note,
               f.scope_label, f.status, f.parsed, qc.display_name AS project
        FROM gsync_payment_files f LEFT JOIN qbo_customers qc ON qc.qbo_id = f.entity_id
        WHERE f.status IN ('ok', 'unmatched', 'superseded', 'duplicate')
    """)).mappings().all()
    names = {}
    out = []
    has_file = set()
    for r in rows:
        p = r["parsed"] if isinstance(r["parsed"], dict) else json.loads(r["parsed"] or "{}")
        if r["entity_id"]:
            has_file.add(str(r["entity_id"]))
        pays = [x.get("pay_date") for x in p.get("rows", []) if x.get("pay_date")]
        last = max(pays + [p.get("end") or "", (r["modified"] or "")[:10]])
        active = last >= (today - timedelta(days=90)).isoformat()
        sev = lambda hi: hi if active else "low"            # noqa: E731
        proj = r["project"] or "No project"
        where = (r["path"] or "").split("/")
        where = "/".join(where[-3:]) if where else ""
        title_file = f"{r['name']}" + (f" ({r['scope_label']})" if r["scope_label"] and r["scope_label"] not in r["name"] else "")
        link = f"#/entity/project/{r['entity_id']}" if r["entity_id"] else None
        ref = {"file_id": r["file_id"], "qbo_id": r["entity_id"], "sheet_url": _url(r["file_id"], r["mime_type"])}
        base = f"{proj}: {title_file}"
        for iss in p.get("_issues") or []:
            t = iss.get("type")
            k = f"{r['file_id']}"
            if not active and t in ("paid_over_sheet", "labor_not_on_sheet", "qbo_paid_not_marked", "off_calendar", "bad_date"):
                continue                                    # finished long ago: history, not a worklist
            if t == "unmatched_file":
                out.append(_item(CAT, t, k, sev("high"), f"{r['name']} in {where or 'Drive'}: not matched to a project",
                                 f"{iss.get('note') or 'No project folder and no usable Project Number'}. "
                                 f"Sheet: {p.get('name') or '—'}, # {p.get('number_raw') or '—'}, contract {_money(p.get('cv'))}, "
                                 f"{len(p.get('rows') or [])} payment row(s), modified {_md((r['modified'] or '')[:10])}.",
                                 fix="Type the QuickBooks project # in the sheet's Project Number cell (B3), or move the file "
                                     "into the project's Drive folder (7 Notes). Picked up on the next refresh.",
                                 ref=ref, sheet=[p.get("number_raw"), p.get("cv")]))
            elif t == "ambiguous_project":
                other = iss.get("other")
                oname = names.get(other) or conn.execute(text("SELECT display_name FROM qbo_customers WHERE qbo_id = :q"),
                                                          {"q": other}).scalar()
                names[other] = oname
                out.append(_item(CAT, t, k, "medium", f"{base}: Project Number points at another project",
                                 f"The file is in {proj}'s folder but its Project Number cell says "
                                 f"{p.get('number_raw')} ({oname or 'another project'}). Imported onto {proj}.",
                                 fix="Correct the Project Number on the sheet (or move the file to the right project's folder).",
                                 link=link, ref=ref, sheet=p.get("number_raw"), app=r["entity_id"]))
            elif t == "unknown_crew":
                out.append(_item(CAT, t, k, sev("medium"), f"{base}: crew company unknown",
                                 "The import couldn't tell which crew company this schedule pays"
                                 + (f" ({iss['why']})" if iss.get("why") else "")
                                 + " — no crew in the file name, the app, the Assignment or the QuickBooks bills.",
                                 fix="Assign the crew on the project's Assignment (or Billing & Schedule), or add the crew "
                                     "to the file name (e.g. \"Payment Schedule - Rosales\").", link=link, ref=ref))
            elif t == "total_mismatch":
                out.append(_item(CAT, t, k, sev("medium"),
                                 f"{base}: payments add up to {_money(iss['total'])}, Contract Value is {_money(iss['cv'])}",
                                 f"Difference {_money(iss['total'] - iss['cv'])}. The app uses the Contract Value as the "
                                 "crew contract and the rows as the payment plan.",
                                 fix="Fix the rows or the Contract Value (F2) on the sheet.", link=link, ref=ref,
                                 sheet=[iss["cv"], iss["total"]]))
            elif t == "paid_over_sheet":
                cov = iss.get("covered") or []
                out.append(_item(CAT, t, k, sev("medium"),
                                 f"{proj}: crews paid {_money(iss['paid'])} in QuickBooks, the Payment Schedule(s) total {_money(iss['sheet'])}",
                                 f"QuickBooks Contract-Labor bills on the project exceed the sheet(s) by {_money(iss['paid'] - iss['sheet'])}."
                                 + (f" Change orders folded into the sheet: {', '.join(f'#{d} ({_money(v)})' for d, v in cov)}." if cov else "")
                                 + " Likely a phase or change order that isn't on any sheet.",
                                 fix="Add the missing phase / change order to the Payment Schedule (or a separate "
                                     "\"Payment Schedule - <scope>\" file).", link=link, ref=ref, sheet=iss["sheet"], qbo=iss["paid"]))
            elif t == "labor_not_on_sheet":
                ests = iss.get("estimates") or []
                out.append(_item(CAT, t, k, sev("medium"),
                                 f"{proj}: {_money(iss['added'])} of crew labor isn't on the Payment Schedule",
                                 f"Accepted estimates carry {_money(iss['labor'])} of Contract Labor; the sheet totals "
                                 f"{_money(iss['sheet'])} (last edited {_md(iss['edited'])}). Added as one payment on "
                                 f"{_md(iss['pay_date']) if iss.get('pay_date') else 'no date (job not dated)'}: "
                                 + ", ".join(f"#{d} {_money(v)}" + (" (newer than the sheet)" if n else "") for d, v, n in ests) + ".",
                                 fix="Add the change order(s) to the Payment Schedule with their real pay dates — the app then "
                                     "uses the sheet's rows instead.", link=link, ref=ref, sheet=iss["sheet"], app=iss["labor"]))
            elif t == "off_calendar":
                out.append(_item(CAT, t, k, sev("medium") if active else "low",
                                 f"{base}: {len(iss['dates'])} pay date(s) off the payroll calendar",
                                 f"{_dates(iss['dates'])} — not a company payday (every other Friday: 10/23/26, 11/6/26 …).",
                                 fix="Move the pay date to the payroll Friday on the sheet.", link=link, ref=ref,
                                 sheet=iss["dates"]))
            elif t == "bad_date":
                notes = iss.get("notes") or []
                out.append(_item(CAT, t, k, "low", f"{base}: date problems on the sheet",
                                 "; ".join(notes[:4]) + (f" (+{len(notes) - 4} more)" if len(notes) > 4 else "")
                                 + (f"{'; ' if notes else ''}{iss['undated']} row(s) with no pay date (TBD)" if iss.get("undated") else ""),
                                 fix="Correct the dates on the sheet.", link=link, ref=ref, sheet=notes))
            elif t == "sheet_paid_no_qbo":
                out.append(_item(CAT, t, k, sev("high"), f"{base}: marked paid on the sheet, no QuickBooks payment",
                                 f"Rows {_dates(iss['dates'])} say pd/paid, but no Contract-Labor bill from the crew's vendor "
                                 "on this project matches them.",
                                 fix="Enter the crew bill in QuickBooks (tagged to the project, Contract Labor), or remove the "
                                     "paid mark on the sheet.", link=link, ref=ref, sheet=iss["dates"]))
            elif t == "qbo_paid_not_marked":
                out.append(_item(CAT, t, k, "low", f"{base}: paid in QuickBooks, not marked paid on the sheet",
                                 f"Rows {_dates(iss['dates'])} match a QuickBooks crew bill but the sheet (which marks "
                                 "payments pd/paid) doesn't mark them. The app shows them paid.",
                                 fix="Mark them pd on the sheet.", link=link, ref=ref, qbo=iss["dates"]))
            elif t in ("skipped_superseded", "skipped_duplicate"):
                what = "an older version of" if t == "skipped_superseded" else "a copy of rows already in"
                out.append(_item(CAT, t, k, "low", f"{base}: skipped as {what} another file",
                                 f"It still has upcoming pay dates ({_dates(iss.get('future') or [])}); the import used "
                                 f"the other file (newer / containing these rows).",
                                 fix="If this file is the current plan, delete or rename the other one (\"… old\"); if it's "
                                     "a separate scope, name it \"Payment Schedule - <scope>\".", link=link, ref=ref))
    out += _no_schedule_items(conn, has_file, today)
    out += _diff_items(conn, today)
    return out


_FIELD = {"pay_date": "pay date", "amount": "amount", "send_invoice_date": "send-invoice date", "status": "status",
          "note": "note", "sheet_paid": "paid mark", "paid_source": "paid from", "qbo_txn_id": "QuickBooks payment"}


def _val(k, v):
    if v in (None, "", "None"):
        return "blank"
    if k == "amount":
        try:
            return _money(float(v))
        except (TypeError, ValueError):
            return str(v)
    if k in ("pay_date", "send_invoice_date") and re.match(r"\d{4}-\d\d-\d\d", str(v)):
        return _md(str(v)[:10])
    return str(v)


def _diff_items(conn, today):
    """Reference mode (2026-11-12): the Payment Schedule sheets are read, never
    applied. One item per project whose sheet says something different from the
    app's crew payment schedule (saved by payment_import.run(store=True))."""
    try:
        rows = conn.execute(text("SELECT entity_id, project, changes, files, checked_at FROM gsync_payment_diffs")).mappings().all()
    except Exception:
        conn.rollback()
        return []
    names = {str(q): n for q, n in conn.execute(text("SELECT qbo_id, display_name FROM qbo_customers WHERE is_project = 1")).all()}
    crew_of = {sid: " ".join(x for x in (nm, f"(estimate {est})" if est else None, lab) if x)
               for sid, nm, est, lab in conn.execute(text("""SELECT s.id, c.name, s.estimate_doc_number, s.source_label
                   FROM project_payment_schedules s LEFT JOIN work_crews c ON c.id = s.crew_id""")).all()}
    out = []
    recent = (today - timedelta(days=90)).isoformat()
    for r in rows:
        ch = r["changes"] if isinstance(r["changes"], list) else json.loads(r["changes"] or "[]")
        files = r["files"] if isinstance(r["files"], list) else json.loads(r["files"] or "[]")
        if not ch:
            continue
        lines, dates = [], []
        multi = len({c.get("schedule_id") for c in ch if c.get("schedule_id")}) > 1
        for c in ch:
            who = crew_of.get(c.get("schedule_id")) if multi else None
            pre = f"{who}, p" if who else "P"
            if "changed" in c:
                parts = [f"{_FIELD.get(k, k)} {_val(k, a)} in the app, {_val(k, b)} on the sheet"
                         for k, (a, b) in c["changed"].items()]
                dates += [v for k, ab in c["changed"].items() if k == "pay_date" for v in ab if v]
                lines.append(f"{pre}ayment #{c['row']}: " + "; ".join(parts))
            elif "new" in c:
                n = c["new"]
                dates.append(n.get("pay_date"))
                lines.append(f"{pre}ayment #{c['row']} only on the sheet: {_val('pay_date', n.get('pay_date'))} {_val('amount', n.get('amount'))}")
            elif "deleted" in c:
                n = c["deleted"]
                dates.append(n.get("pay_date"))
                lines.append(f"{pre}ayment #{c['row']} only in the app: {_val('pay_date', n.get('pay_date'))} {_val('amount', n.get('amount'))}")
            elif c.get("created"):
                lines.append(f"The sheet {c.get('file') or ''} has a crew schedule the app doesn't".replace("  ", " "))
            elif c.get("released"):
                lines.append("The app has a crew schedule from a sheet that's no longer in Drive")
            elif c.get("covered_by_sheet"):
                lines.append("The sheet covers a change order's crew labor the app schedules separately")
        active = any(str(d or "")[:10] >= recent for d in dates) or not dates
        name = names.get(str(r["entity_id"])) or r["project"] or "Project"
        f0 = files[0] if files else None
        ref = {"qbo_id": r["entity_id"]}
        if f0:
            ref.update(file_id=f0["id"], sheet_url=_url(f0["id"], f0.get("mime")))
        n = len(lines)
        out.append(_item(CAT, "sheet_differs", str(r["entity_id"]), "medium" if active else "low",
                         f"{name}: the crew Payment Schedule sheet differs from the app ({n} difference{'s' if n != 1 else ''})",
                         "; ".join(lines[:8]) + (f"; and {n - 8} more" if n > 8 else "") + "."
                         + (f" Sheet: {', '.join(f['name'] for f in files[:3])}." if files else ""),
                         fix="The sheet is read for reference only: nothing was changed. If the sheet is right, update the crew "
                             "payment schedule in the app (the project's Billing & Schedule tab); if the app is right, "
                             "Ignore this or update the sheet.",
                         link=f"#/entity/project/{r['entity_id']}", ref=ref))
    return out


def _no_schedule_items(conn, has_file, today):
    """On the Job Schedule with a crew (work days in the last 30 / next 45 days)
    but no Payment Schedule file for the project."""
    lo, hi = today - timedelta(days=30), today + timedelta(days=45)
    jobs = collections.defaultdict(lambda: {"days": set(), "crews": set()})
    for c in conn.execute(text("""SELECT day, crew, job, descr, extra FROM gsync_schedule_days
                                   WHERE day BETWEEN :lo AND :hi AND job IS NOT NULL"""), {"lo": lo, "hi": hi}).mappings():
        if _kind(c["descr"] or c["extra"]) != "work" or not c["crew"]:
            continue
        for j in re.findall(r"\b(\d{4})\b", c["job"] or ""):
            jobs[j]["days"].add(c["day"])
            jobs[j]["crews"].add(re.sub(r"\d+$", "", c["crew"]))
    if not jobs:
        return []
    projects = {}
    for r in conn.execute(text("SELECT qbo_id, display_name FROM qbo_customers WHERE is_project = 1")).mappings():
        m = re.match(r"\s*(\d{4})\b", r["display_name"] or "")
        if m:
            projects.setdefault(m.group(1), r)
    out = []
    for j, J in sorted(jobs.items()):
        p = projects.get(j)
        if not p or str(p["qbo_id"]) in has_file:
            continue
        first, last = min(J["days"]), max(J["days"])
        started = first <= today
        out.append(_item(CAT, "no_payment_schedule", p["qbo_id"], "high" if started else "medium",
                         f"{p['display_name']}: on the Job Schedule, no crew Payment Schedule",
                         f"Crew {', '.join(sorted(J['crews']))} scheduled {_md(first)} – {_md(last)}; no edited "
                         "\"Payment Schedule\" file in the project's Drive folder, so the app has no negotiated crew "
                         "payment plan (it shows the estimate's even split).",
                         fix="Add the crew payment schedule in the app (the project's Billing & Schedule tab). A Payment "
                             "Schedule sheet in the project's Drive folder is read for reference only.", link=f"#/entity/project/{p['qbo_id']}",
                         ref={"qbo_id": p["qbo_id"], "job": j}, sheet=[str(first), str(last)]))
    return out
