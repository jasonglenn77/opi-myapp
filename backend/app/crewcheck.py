"""Crew check (2026-11-22, owner): who QuickBooks paid on a job vs the crew the
app has as the paid crew vs the crews on Ashley's Job Schedule sheet.

Three sources, all at crew-COMPANY level:
  paid    Bill lines tagged to the project from a crew company's vendor (the
          same money Crew payments burns down)
  app     each estimate's paid crew (project_estimate_billing.crew_id, plus the
          split allocations), and the on-site companies on the schedule lines
  sheet   companies whose crew codes work the job # on the synced Job Schedule
          (gsync_schedule_days); None when the job isn't on the synced tabs

Differences called out (amounts under $1 ignored):
  paid_differs    a company was paid that isn't the app's paid crew and/or isn't
                  on the job's Job Schedule (not_app / not_sheet say which)
  app_not_sheet   the app's paid crew isn't on the job's Job Schedule
Used by Project Setup and Closeout (flag), the Crew payments section (banner)
and a bell notice per job when its differences change.
"""
import hashlib
import re
from collections import defaultdict
from datetime import timedelta

from sqlalchemy import bindparam, text

from app.db import engine

EPS = 1.0
_cells_cache = {"sig": None, "jobs": {}}


def _q(sql, *expanding):
    t = text(sql)
    for n in expanding:
        t = t.bindparams(bindparam(n, expanding=True))
    return t


def _crews(conn):
    rows = conn.execute(text("SELECT id, parent_id, name, code, vendor_qbo_id FROM work_crews")).mappings().all()
    company_of = {int(r["id"]): int(r["parent_id"] or r["id"]) for r in rows}
    name = {int(r["id"]): (r["name"] or "").strip() for r in rows if r["parent_id"] is None}
    by_code = {(r["code"] or "").upper(): int(r["id"]) for r in rows if r["parent_id"] is None and r["code"]}
    by_vendor = {}
    for r in rows:
        if r["vendor_qbo_id"]:
            by_vendor.setdefault(str(r["vendor_qbo_id"]), company_of[int(r["id"])])
    return company_of, name, by_code, by_vendor


def _sheet_jobs(conn, by_code):
    """job # -> set of company ids working it on the synced Job Schedule (work days only)."""
    from app.gsync.review import _kind, _norm_slot
    sig = tuple(conn.execute(text("SELECT COUNT(*), MAX(id) FROM gsync_schedule_days")).one())
    if _cells_cache["sig"] == sig:
        return _cells_cache["jobs"]
    jobs = defaultdict(list)
    for c in conn.execute(text("SELECT day, crew, job, descr, extra FROM gsync_schedule_days WHERE job IS NOT NULL")).mappings():
        if _kind(c["descr"] or c["extra"]) != "work":
            continue
        s = _norm_slot(c["crew"])
        co = by_code.get(s[0]) if s else None
        for j in re.findall(r"\b(\d{4})\b", c["job"] or ""):
            jobs[j].append((c["day"], co))   # co None = a code the app doesn't know (still "on the sheet")
    _cells_cache.update(sig=sig, jobs=dict(jobs))
    return _cells_cache["jobs"]


def check(conn, entity_ids):
    """{entity_id: {paid, app_paid, onsite, sheet, diffs, sig}} for the given projects."""
    eids = sorted({str(e) for e in entity_ids if e})
    if not eids:
        return {}
    company_of, cname, by_code, by_vendor = _crews(conn)
    nm = lambda c: cname.get(c) or f"crew {c}"
    out = {e: {"paid": {}, "app_paid": set(), "onsite": set(), "sheet": None, "number": None} for e in eids}

    for r in conn.execute(_q("SELECT qbo_id, display_name FROM qbo_customers WHERE qbo_id IN :e", "e"), {"e": eids}).all():
        m = re.match(r"\s*(\d{4})\b", r[1] or "")
        out[str(r[0])]["number"] = m.group(1) if m else None

    if by_vendor:
        for e, v, amt in conn.execute(_q("""
            SELECT l.line_customer_qbo_id, t.vendor_qbo_id, ROUND(SUM(l.amount), 2)
            FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
            WHERE t.entity_type = 'Bill' AND l.line_customer_qbo_id IN :e AND t.vendor_qbo_id IN :v
            GROUP BY l.line_customer_qbo_id, t.vendor_qbo_id""", "e", "v"), {"e": eids, "v": list(by_vendor)}).all():
            co = by_vendor.get(str(v))
            if co and float(amt or 0) > EPS:
                p = out[str(e)]["paid"]
                p[co] = round(p.get(co, 0) + float(amt), 2)

    for e, c in conn.execute(_q("""SELECT entity_id, crew_id FROM project_estimate_billing
                                   WHERE entity_id IN :e AND crew_id IS NOT NULL""", "e"), {"e": eids}).all():
        out[str(e)]["app_paid"].add(company_of.get(int(c), int(c)))
    for e, c in conn.execute(_q("""SELECT entity_id, company_crew_id FROM project_estimate_crew_allocations
                                   WHERE entity_id IN :e""", "e"), {"e": eids}).all():
        out[str(e)]["app_paid"].add(company_of.get(int(c), int(c)))
    for e, c in conn.execute(_q("""
        SELECT qc.qbo_id, COALESCE(w.company_id, wc.parent_id, wc.id)
        FROM project_schedule_item_work_crews w
        JOIN project_schedule_items psi ON psi.id = w.schedule_item_id
        JOIN projects p ON p.id = psi.project_id JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        LEFT JOIN work_crews wc ON wc.id = w.work_crew_id
        WHERE qc.qbo_id IN :e AND w.unassigned_at IS NULL AND COALESCE(psi.status, '') <> 'canceled'""", "e"),
            {"e": eids}).all():
        if c:
            out[str(e)]["onsite"].add(int(c))

    try:
        sheet = _sheet_jobs(conn, by_code)
    except Exception:
        sheet = {}
    # the job's own dates: only sheet days near them count (an old job's number
    # can turn up on this year's tabs as a different job)
    span = {str(r[0]): (r[1], r[2]) for r in conn.execute(_q("""
        SELECT qc.qbo_id, MIN(psi.start_date),
               MAX(DATE_ADD(COALESCE(psi.end_date, psi.start_date), INTERVAL COALESCE(psi.overage_days, 0) DAY))
        FROM project_schedule_items psi JOIN projects p ON p.id = psi.project_id
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        WHERE qc.qbo_id IN :e AND COALESCE(psi.status, '') <> 'canceled' GROUP BY qc.qbo_id""", "e"), {"e": eids}).all()}
    for e, d in out.items():
        cells = sheet.get(d["number"]) if d["number"] else None
        if not cells:
            continue
        a, b = span.get(e, (None, None))
        if a and b:
            cells = [(day, co) for day, co in cells if a - timedelta(days=60) <= day <= b + timedelta(days=60)]
        if cells:
            d["sheet"] = {co for _, co in cells}

    res = {}
    for e, d in out.items():
        diffs = []
        app, sh = d["app_paid"], d["sheet"]
        sheet_known = {c for c in (sh or set()) if c}
        sheet_txt = ", ".join(sorted(nm(c) for c in sheet_known)) or "no crew the app knows"
        app_txt = ", ".join(sorted(nm(c) for c in app)) or "none"
        for co, amt in sorted(d["paid"].items(), key=lambda kv: -kv[1]):
            not_app = bool(app) and co not in app
            not_sheet = sh is not None and co not in sh
            if not (not_app or not_sheet):
                continue
            parts = ([f"the app's paid crew is {app_txt}"] if not_app else []) +                     ([f"the Job Schedule shows {sheet_txt}"] if not_sheet else [])
            diffs.append({"kind": "paid_differs", "company": co, "not_app": not_app, "not_sheet": not_sheet,
                          "amount": amt, "text": f"QuickBooks paid {nm(co)} ${amt:,.0f}, but " + " and ".join(parts)})
        if sh is not None:
            for co in sorted(app - sh, key=nm):
                if co in d["paid"]:
                    continue        # already called out above as paid-but-not-on-the-sheet
                diffs.append({"kind": "app_not_sheet", "company": co,
                              "text": f"The app's paid crew is {nm(co)}, but the Job Schedule shows {sheet_txt} on this job"})
        sig = hashlib.sha1("|".join(sorted(f"{x['kind']}:{x['company']}:{x.get('not_app')}:{x.get('not_sheet')}" for x in diffs)).encode()).hexdigest()[:16] if diffs else None
        res[e] = {"paid": [{"company_id": c, "name": nm(c), "amount": a} for c, a in sorted(d["paid"].items(), key=lambda kv: -kv[1])],
                  "app_paid": sorted(nm(c) for c in app), "onsite": sorted(nm(c) for c in d["onsite"]),
                  "sheet": None if sh is None else sorted(nm(c) for c in sheet_known),
                  "on_sheet": sh is not None, "diffs": diffs, "sig": sig}
    return res


def check_one(entity_id):
    with engine.connect() as conn:
        return check(conn, [entity_id]).get(str(entity_id))


def notify_differences(entity_ids=None):
    """One bell notice per job when its crew differences change (the dedupe key
    carries their signature), to everyone who works Project Setup / Closeout.
    Default scope: jobs that are running or finished but not closed out."""
    from app.help import notify as N
    with engine.connect() as conn:
        if entity_ids is None:
            entity_ids = [r[0] for r in conn.execute(text("""
                SELECT DISTINCT qc.qbo_id FROM projects p JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
                JOIN project_schedule_items psi ON psi.project_id = p.id
                WHERE COALESCE(psi.status, '') <> 'canceled'
                  AND psi.start_date <= CURDATE() AND COALESCE(psi.end_date, psi.start_date) >= CURDATE() - INTERVAL 120 DAY
                  AND NOT EXISTS (SELECT 1 FROM project_closeout_steps s
                                  WHERE s.entity_id = qc.qbo_id AND s.step_key = 'margin' AND s.status = 'done')""")).all()]
        res = check(conn, entity_ids)
        names = {str(r[0]): r[1] for r in conn.execute(_q("SELECT qbo_id, display_name FROM qbo_customers WHERE qbo_id IN :e", "e"),
                                                     {"e": list(res) or ["-"]}).all()}
    users = N.users_with_capability("page.assignment")
    n = 0
    for e, r in res.items():
        if not r["diffs"]:
            continue
        n += 1
        N.notify(users, "crew.paid_differs", f"Crew paid differs: {names.get(e, e)}",
                 body="\n".join(x["text"] for x in r["diffs"][:4]) + "\nOpen Crew payments to check who the job's crew is.",
                 link=f"#/setup?job={e}", subject=str(e), dedupe_key=f"crew.paid_differs:{e}:{r['sig']}", email=False)
    return n
