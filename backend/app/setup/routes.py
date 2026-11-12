"""
Project Setup: everything the office does between a purchase order arriving and
the job being ready to start, for every won job, in one place.

  GET  /api/setup/queue?scope=todo|all     To do: new jobs still being set up + any project a change
                                           sent back (re-review); All active: every live project
  GET  /api/setup/job/{key}                one job: steps, opportunity, project, links
  GET  /api/setup/job/{key}/estimate-draft the project's first estimate, drafted (estimate.py)
  POST /api/setup/job/{key}/step/{step}    mark a step done / not needed / confirmed, or clear it
  POST /api/setup/job/{key}/review/{step}  {note}: re-checked after a change (resolves the re-review)
  POST /api/setup/job/{key}/note           {step, reason_code, note, expected_date}: why a step
                                           isn't done yet (no PO, estimate, first invoice); alerts the office
  GET  /api/setup/job/{key}/dates          every date change (the line's end-date history) + answers
  POST /api/setup/date-change/{id}         {reason_code, co_needed, note}: why it moved, change order?
  GET  /api/setup/job/{key}/first-invoice  the first invoice (sent: from QuickBooks) and its billing row
  GET  /api/setup/job/{key}/hints          wire / travel / equipment words found in the PO and estimate

`key` is the QuickBooks project id once the project exists, else "opp:<id>".

Most steps are read from the data (PM assigned, dates set, offer accepted,
invoice sent...). The rest need a person: checking the job details, and
reviewing each schedule the app built. Those marks live in project_setup_steps.
"""
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import bindparam, text

from app.audit import record_audit
from app.auth import require_capability
from app.db import engine
from . import estimate as EST
from . import reviews as RV

router = APIRouter(prefix="/api/setup", tags=["setup"])
CAP = "page.assignment"
# Jobs with a QuickBooks project show however long ago they were won (a job won in
# spring can start in January); _visible() drops them once finished or long under
# way. Won jobs with no project yet only count if won recently: older unlinked
# pipeline rows are history, not work.
WON_WINDOW_DAYS = 150
# Only "100% Won" pipeline rows: "80% Red Flag > Goes to Ops Tab" also counts as
# won in the pipeline, but the customer hasn't ordered (the estimate is still
# Pending in QuickBooks), so there's nothing to set up yet.

# (key, stage, label, how it completes)
STEPS = [
    ("po", "QuickBooks", "Purchase order on file", "auto"),
    ("qbo_project", "QuickBooks", "Project created in QuickBooks", "auto"),
    ("qbo_estimate", "QuickBooks", "Project estimate created", "auto"),
    ("first_invoice", "QuickBooks", "First invoice sent", "auto"),
    ("pm", "Assignment", "Project manager assigned", "auto"),
    ("crew", "Assignment", "Crew offer accepted", "auto"),
    ("dates", "Assignment", "Start and end dates set", "auto"),
    ("details", "Assignment", "Job details checked (wire guidance, travel, days off, equipment)", "manual"),
    ("invoice_schedule", "Schedules", "Invoice schedule reviewed", "manual"),
    ("crew_schedule", "Schedules", "Crew payment schedule reviewed", "manual"),
    ("expense_schedule", "Schedules", "Expense schedule reviewed", "manual"),
]
STEP_KEYS = {s[0] for s in STEPS}
MARKS = {"done", "not_needed", "confirmed"}


def _q(sql, *expanding):
    t = text(sql)
    return t.bindparams(*[bindparam(e, expanding=True) for e in expanding]) if expanding else t


def _project_rows(conn, eids):
    """Rows shaped like a pipeline opportunity for projects with no won pipeline
    row (older jobs, add-on projects), so All active can show every live project."""
    if not eids:
        return []
    out = []
    for r in conn.execute(_q("""
        SELECT qc.id AS project_internal_id, qc.qbo_id AS project_qbo_id, qc.display_name AS project_name,
               pc.display_name AS customer,
               (SELECT SUM(t.total_amt) FROM qbo_transactions t WHERE t.entity_type = 'Estimate'
                  AND t.customer_qbo_id = qc.qbo_id) AS order_value
        FROM qbo_customers qc LEFT JOIN qbo_customers pc ON pc.qbo_id = qc.parent_qbo_id
        WHERE qc.qbo_id IN :e""", "e"), {"e": list(eids)}).mappings():
        name = r["project_name"] or ""
        out.append({"id": None, "title": name, "quote_number": name.split(" ")[0] if name[:1].isdigit() else None,
                    "project_qbo_id": str(r["project_qbo_id"]), "pipeline_status": None, "order_date": None,
                    "decided_at": None, "order_value": r["order_value"], "contract_value": None, "labor_days": None,
                    "travel_days": None, "workbook_url": None, "city": None, "state": None, "target_start_date": None,
                    "target_end_date": None, "customer_name_raw": None, "quoted_by": None,
                    "project_internal_id": r["project_internal_id"], "project_name": name, "customer": r["customer"],
                    "dealer": r["customer"], "key": str(r["project_qbo_id"]), "other_opportunities": [], "no_pipeline": True})
    return out


def _gather(conn, opp_ids=None, extra_eids=None):
    """Won opportunities (or the given ones) with everything the steps need, in bulk.
    extra_eids: live projects with no won pipeline row, added as their own rows."""
    since = date.today() - timedelta(days=WON_WINDOW_DAYS)
    where = "o.id IN :ids" if opp_ids else \
        ("o.status = 'won' AND o.pipeline_status LIKE '100%%' "
         "AND (o.project_qbo_id IS NOT NULL "
         "OR COALESCE(o.order_date, DATE(o.decided_at), DATE(o.updated_at)) >= :since)")
    opps = [dict(r) for r in conn.execute(_q(f"""
        SELECT o.id, o.title, o.quote_number, o.project_qbo_id, o.pipeline_status, o.order_date, o.decided_at,
               o.order_value, o.contract_value, o.labor_days, o.travel_days, o.workbook_url, o.city, o.state,
               o.target_start_date, o.target_end_date, o.customer_name_raw, o.quoted_by,
               qc.id AS project_internal_id, qc.display_name AS project_name, pc.display_name AS customer,
               dealer.display_name AS dealer
        FROM opportunities o
        LEFT JOIN qbo_customers qc ON qc.qbo_id = o.project_qbo_id
        LEFT JOIN qbo_customers pc ON pc.qbo_id = qc.parent_qbo_id
        LEFT JOIN qbo_customers dealer ON dealer.id = o.qbo_customer_id
        WHERE {where}
    """, *(["ids"] if opp_ids else [])), {"ids": opp_ids, "since": since}).mappings()] if opp_ids != [] else []
    if extra_eids:
        have = {str(o["project_qbo_id"]) for o in opps if o["project_qbo_id"]}
        extra = _project_rows(conn, [e for e in extra_eids if str(e) not in have])
    else:
        extra = []
    if not opps and not extra:
        return [], {}
    # several opportunities can point at one project (add-on scope): one row per project
    seen, rows = {}, []
    for o in sorted(opps, key=lambda o: (o["order_date"] or date.min), reverse=True):
        k = o["project_qbo_id"] or f"opp:{o['id']}"
        if k in seen:
            seen[k]["other_opportunities"].append(o["id"])
            continue
        o["key"] = k
        o["other_opportunities"] = []
        seen[k] = o
        rows.append(o)
    rows += extra
    eids = [o["project_qbo_id"] for o in rows if o["project_qbo_id"]] or ["-"]
    iids = [o["project_internal_id"] for o in rows if o["project_internal_id"]] or [-1]
    oids = [str(o["id"]) for o in opps]
    d = {}
    d["items"] = {r["cid"]: dict(r) for r in conn.execute(_q("""
        SELECT p.qbo_customer_id AS cid, MIN(psi.start_date) AS start_date, MAX(psi.end_date) AS end_date,
               MAX(DATE_ADD(psi.end_date, INTERVAL COALESCE(psi.overage_days, 0) DAY)) AS job_end,
               MAX(psi.wire_guidance) AS wire_guidance, MAX(psi.travel_days) AS travel_days,
               MAX(psi.overage_days) AS overage_days, MAX(psi.equipment_type) AS equipment_type,
               SUBSTRING_INDEX(GROUP_CONCAT(psi.status ORDER BY psi.id DESC), ',', 1) AS status
        FROM projects p JOIN project_schedule_items psi ON psi.project_id = p.id
        WHERE p.qbo_customer_id IN :iids GROUP BY p.qbo_customer_id""", "iids"), {"iids": iids}).mappings()}
    d["pms"] = {}
    for r in conn.execute(_q("""
        SELECT p.qbo_customer_id AS cid, m.first_name, m.last_name, MAX(spm.is_primary) AS prim
        FROM projects p JOIN project_schedule_items psi ON psi.project_id = p.id
        JOIN project_schedule_item_project_managers spm ON spm.schedule_item_id = psi.id AND spm.unassigned_at IS NULL
        JOIN project_managers m ON m.id = spm.project_manager_id
        WHERE p.qbo_customer_id IN :iids GROUP BY p.qbo_customer_id, m.id, m.first_name, m.last_name""", "iids"),
            {"iids": iids}).mappings():
        d["pms"].setdefault(r["cid"], []).append(f"{r['first_name'] or ''} {r['last_name'] or ''}".strip())
    d["offers"] = {}
    for r in conn.execute(_q("""
        SELECT w.entity_id, w.status, w.sent_at, w.responded_at, c.name AS crew FROM work_offers w
        LEFT JOIN work_crews c ON c.id = w.crew_id
        WHERE w.entity_id IN :eids AND w.status <> 'withdrawn' ORDER BY w.sent_at""", "eids"), {"eids": eids}).mappings():
        d["offers"].setdefault(r["entity_id"], []).append(dict(r))
    d["assigned_crews"] = {}
    for r in conn.execute(_q("""
        SELECT p.qbo_customer_id AS cid, c.name FROM projects p
        JOIN project_schedule_items psi ON psi.project_id = p.id
        JOIN project_schedule_item_work_crews wc ON wc.schedule_item_id = psi.id AND wc.unassigned_at IS NULL
        JOIN work_crews c ON c.id = COALESCE(wc.company_id, wc.work_crew_id)
        WHERE p.qbo_customer_id IN :iids""", "iids"), {"iids": iids}).mappings():
        d["assigned_crews"].setdefault(r["cid"], set()).add(r["name"])
    d["estimates"] = {r["e"]: dict(r) for r in conn.execute(_q("""
        SELECT customer_qbo_id AS e, COUNT(*) AS n, MIN(txn_date) AS first_date, SUM(total_amt) AS total
        FROM qbo_transactions WHERE entity_type = 'Estimate' AND customer_qbo_id IN :eids GROUP BY customer_qbo_id""", "eids"),
        {"eids": eids}).mappings()}
    d["invoices"] = {r["e"]: dict(r) for r in conn.execute(_q("""
        SELECT customer_qbo_id AS e, COUNT(*) AS n, MIN(txn_date) AS first_date,
               SUBSTRING_INDEX(GROUP_CONCAT(total_amt ORDER BY txn_date, id), ',', 1) AS first_amount
        FROM qbo_transactions WHERE entity_type = 'Invoice' AND customer_qbo_id IN :eids GROUP BY customer_qbo_id""", "eids"),
        {"eids": eids}).mappings()}
    d["po_docs"] = {}
    for r in conn.execute(_q("""
        SELECT entity_type, entity_id, COUNT(*) AS n FROM documents
        WHERE folder = '5_purchase_orders' AND drive_removed_at IS NULL
          AND ((entity_type = 'opportunity' AND entity_id IN :oids) OR (entity_type = 'project' AND entity_id IN :eids))
        GROUP BY entity_type, entity_id""", "oids", "eids"), {"oids": oids, "eids": eids}).mappings():
        d["po_docs"][(r["entity_type"], str(r["entity_id"]))] = r["n"]
    d["sched"] = {}
    for tbl, k in (("project_invoice_schedules", "invoice"), ("project_payment_schedules", "crew"),
                   ("project_expense_installments", "expense")):
        for r in conn.execute(_q(f"SELECT entity_id AS e, COUNT(*) AS n FROM {tbl} WHERE entity_id IN :eids GROUP BY entity_id",
                                 "eids"), {"eids": eids}).mappings():
            d["sched"][(r["e"], k)] = r["n"]
    # Not linked yet: is there already a project at the same site? Then this may be
    # added scope (a change order) rather than a new project. "4456.1" quotes and
    # "Maersk-Hopedale MA-Additional Scope" style titles both land here.
    unlinked = [o for o in rows if not o["project_qbo_id"]]
    if unlinked:
        projects = conn.execute(text("SELECT qbo_id, display_name FROM qbo_customers WHERE is_project = 1")).all()
        for o in unlinked:
            base = str(o["quote_number"] or "").split(".")[0]
            hit = next((p for p in projects if base and "." in str(o["quote_number"]) and p[1].startswith(base + " ")), None)
            bits = [b.strip() for b in (o["title"] or "").split("-")]
            if not hit and len(bits) >= 3:
                company, city = bits[0].lower(), " ".join(bits[1].split()[:-1]).lower()
                if company and city:
                    hit = next((p for p in projects if company in p[1].lower() and city in p[1].lower()), None)
            o["same_site"] = {"qbo_id": str(hit[0]), "name": hit[1]} if hit else None
        # Another quote with the same title already became the project (e.g. 6340 and
        # 6341 were both priced; 6341 was the one entered in QuickBooks).
        titles = list({(o["title"] or "").strip().lower() for o in unlinked if o["title"]})
        if titles:
            sib = {}
            for r in conn.execute(_q("""
                SELECT LOWER(TRIM(o.title)) AS t, o.id, o.quote_number, o.project_qbo_id, qc.display_name
                FROM opportunities o JOIN qbo_customers qc ON qc.qbo_id = o.project_qbo_id
                WHERE o.project_qbo_id IS NOT NULL AND LOWER(TRIM(o.title)) IN :t""", "t"), {"t": titles}).mappings():
                sib.setdefault(r["t"], r)
            for o in unlinked:
                r = sib.get((o["title"] or "").strip().lower())
                if r and r["id"] != o["id"]:
                    o["same_site"] = {"qbo_id": str(r["project_qbo_id"]), "name": r["display_name"],
                                      "sibling_quote": r["quote_number"]}
    subjects = [o["key"] for o in rows] + [f"opp:{o['id']}" for o in opps]
    d["marks"] = {}
    for r in conn.execute(_q("""SELECT subject, step_key, status, note, by_email, at FROM project_setup_steps
                                WHERE subject IN :s""", "s"), {"s": subjects}).mappings():
        d["marks"].setdefault(r["subject"], {})[r["step_key"]] = dict(r)
    # setup notes (no PO yet, estimate not done, first invoice not sent): newest per step
    d["notes"] = {}
    for r in conn.execute(_q("""SELECT subject, step_key, reason_code, note, expected_date, by_email, at
                                FROM project_setup_notes WHERE subject IN :s ORDER BY at""", "s"), {"s": subjects}).mappings():
        d["notes"].setdefault(r["subject"], {})[r["step_key"]] = {
            "reason_code": r["reason_code"], "note": r["note"], "by": r["by_email"], "at": str(r["at"]),
            "expected_date": str(r["expected_date"]) if r["expected_date"] else None}
    real = [e for e in eids if e != "-"]
    d["reviews"] = RV.open_reviews(conn, real)
    d["unanswered"] = {str(e): int(n) for e, n in conn.execute(_q("""SELECT entity_id, COUNT(*) FROM schedule_date_changes
        WHERE answered_at IS NULL AND entity_id IN :e GROUP BY entity_id""", "e"), {"e": real or ["-"]}).all()}
    from app.projects import lifecycle as LC
    d["life"] = LC.statuses(conn, real) if real else {}
    return rows, d


def _steps(o, d, today):
    eid, cid = o["project_qbo_id"], o["project_internal_id"]
    marks = {**d["marks"].get(f"opp:{o['id']}", {}), **d["marks"].get(o["key"], {})}
    item = d["items"].get(cid) or {}
    offers = d["offers"].get(eid, []) if eid else []
    accepted = [x for x in offers if x["status"] == "accepted"]
    has_dates = bool(item.get("start_date") and item.get("end_date"))
    out = []

    reviews = d.get("reviews", {}).get(str(eid), {}) if eid else {}
    notes = {**d.get("notes", {}).get(f"opp:{o['id']}", {}), **d.get("notes", {}).get(o["key"], {})}

    def add(key, state, detail="", **extra):
        m = marks.get(key)
        if m and state not in ("done",):
            state = "done" if m["status"] in ("done", "confirmed") else "not_needed"
            detail = (detail + " · " if detail else "") + f"marked by {m['by_email'] or 'someone'} {str(m['at'])[:10]}"
        rv = reviews.get(key)
        if rv and state in ("done", "not_needed", "waiting"):
            state = "review"        # a change reopened it: re-check, then "Reviewed"
            detail = f"Re-review: {rv['reason']}"
        stage, label, how = next((s[1], s[2], s[3]) for s in STEPS if s[0] == key)
        out.append({"key": key, "stage": stage, "label": label, "how": how, "state": state, "detail": detail,
                    "mark": ({"status": m["status"], "by": m["by_email"], "at": str(m["at"]), "note": m["note"]} if m else None),
                    "review": rv, "note": notes.get(key), **extra})

    po_n = d["po_docs"].get(("opportunity", str(o["id"])), 0) + (d["po_docs"].get(("project", eid), 0) if eid else 0)
    add("po", "done" if po_n else "todo", f"{po_n} file(s) in 5 Purchase Orders" if po_n else "No PO in the job's Drive folder yet")
    add("qbo_project", "done" if eid else "todo", o["project_name"] or "Not linked to a QuickBooks project yet")
    est = d["estimates"].get(eid) if eid else None
    add("qbo_estimate", "done" if est else ("todo" if eid else "locked"),
        f"{est['n']} estimate(s), first {est['first_date']}" if est else ("" if eid else "After the project exists"))
    inv = d["invoices"].get(eid) if eid else None
    add("first_invoice", "done" if inv else ("todo" if eid else "locked"),
        f"Invoiced {inv['first_date']} (${float(inv['first_amount'] or 0):,.0f})" if inv else "")
    pms = d["pms"].get(cid, []) if cid else []
    add("pm", "done" if pms else ("todo" if eid else "locked"), ", ".join(pms))
    crews = sorted(d["assigned_crews"].get(cid, set())) if cid else []
    if accepted:
        cs, cd = "done", f"{accepted[-1]['crew']} accepted {str(accepted[-1]['responded_at'] or '')[:10]}"
    elif offers and offers[-1]["status"] == "sent":
        cs, cd = "waiting", f"Sent to {offers[-1]['crew']} {str(offers[-1]['sent_at'])[:10]}, no answer yet"
    elif offers and offers[-1]["status"] == "declined":
        cs, cd = "todo", f"{offers[-1]['crew']} declined. Send to another crew"
    elif crews:
        cs, cd = "done", f"Assigned: {', '.join(crews)} (no offer on record)"
    else:
        cs, cd = ("todo" if eid else "locked"), ""
    add("crew", cs, cd)
    add("dates", "done" if has_dates else ("todo" if eid else "locked"),
        f"{item['start_date']} to {item['end_date']}" + (f" (+{item['overage_days']} overage)" if item.get("overage_days") else "")
        if has_dates else "")
    det = []
    if item:
        det = [("Wire guidance" if item.get("wire_guidance") else "No wire guidance"), f"{item.get('travel_days') or 0} travel days",
               item.get("equipment_type") or "equipment not set"]
    add("details", "todo" if eid else "locked", ", ".join(det))
    for key, k, what in (("invoice_schedule", "invoice", "invoice"), ("crew_schedule", "crew", "crew payment"),
                         ("expense_schedule", "expense", "expense")):
        n = d["sched"].get((eid, k), 0) if eid else 0
        if not has_dates:
            add(key, "locked", "Built once the start and end dates are set")
        else:
            warn = "No crew has accepted yet" if key == "crew_schedule" and not accepted and not crews else ""
            add(key, "todo", (f"Built by the app" if n else f"Opens the {what} schedule to build it") + (f" · {warn}" if warn else ""),
                warning=warn or None)
    return out, item, pms, crews


def _flags(o, steps, item, today):
    st = {s["key"]: s["state"] for s in steps}
    fl = []
    won = o["order_date"] or (o["decided_at"].date() if o["decided_at"] else None)
    start = item.get("start_date")
    sib = (o.get("same_site") or {}).get("sibling_quote")
    if st["qbo_project"] != "done" and sib:
        fl.append(("warn", f"Not in QuickBooks: quote {sib} with the same title is. Duplicate quote?"))
    elif st["qbo_project"] != "done" and won and (today - won).days >= 2:
        fl.append(("bad", f"Won {(today - won).days} days ago, not in QuickBooks"))
    elif st["qbo_project"] != "done" and not won:
        fl.append(("bad", "Not in QuickBooks (no won date on the pipeline)"))
    if st["first_invoice"] == "todo" and won and (today - won).days >= 7:
        fl.append(("warn", "First invoice not sent"))
    if start:
        days = (start - today).days
        missing = [w for k, w in (("pm", "no PM"), ("crew", "no crew"), ("dates", "no dates")) if st[k] in ("todo", "waiting")]
        if 0 <= days <= 14 and missing:
            fl.append(("bad", f"Starts in {days} day{'s' if days != 1 else ''}, {', '.join(missing)}"))
    if st["dates"] == "done" and any(st[k] == "todo" for k in ("invoice_schedule", "crew_schedule", "expense_schedule")):
        fl.append(("info", "Dates set: review the schedules"))
    if st["crew"] == "waiting":
        fl.append(("info", "Crew offer waiting"))
    n_rv = sum(1 for s in steps if s["state"] == "review")
    if n_rv:
        fl.insert(0, ("bad", f"Back for re-review: {n_rv} step{'s' if n_rv != 1 else ''}"))
    if any(s.get("warning") for s in steps):
        fl.append(("warn", "Crew pay scheduled, no crew yet"))
    if o.get("same_site") and not sib:
        fl.append(("info", f"Same site as {o['same_site']['name']}: may be added scope"))
    return [{"tone": t, "text": x} for t, x in fl]


def _row(o, d, today):
    steps, item, pms, crews = _steps(o, d, today)
    done = sum(1 for s in steps if s["state"] in ("done", "not_needed"))
    stage = next((s["stage"] for s in steps if s["state"] in ("todo", "waiting", "review")), "Ready")
    life = d.get("life", {}).get(str(o["project_qbo_id"])) if o["project_qbo_id"] else None
    n_review = sum(1 for s in steps if s["state"] == "review")
    return {
        "key": o["key"], "opportunity_id": o["id"], "other_opportunities": o["other_opportunities"],
        "title": o["title"], "quote_number": o["quote_number"], "project_qbo_id": o["project_qbo_id"],
        "project_internal_id": o["project_internal_id"], "project_name": o["project_name"],
        "customer": o["customer"] or o["customer_name_raw"], "dealer": o["dealer"],
        "pipeline_status": o["pipeline_status"], "won": str(o["order_date"] or (o["decided_at"].date() if o["decided_at"] else "")) or None,
        "value": float(o["order_value"] or o["contract_value"] or 0), "labor_days": float(o["labor_days"] or 0) or None,
        "travel_days": float(o["travel_days"] or 0) or None, "workbook_url": o["workbook_url"],
        "target_start": str(o["target_start_date"]) if o["target_start_date"] else None,
        "target_end": str(o["target_end_date"]) if o["target_end_date"] else None,
        "start": str(item["start_date"]) if item.get("start_date") else None,
        "end": str(item["job_end"] or item["end_date"]) if item.get("end_date") else None,
        "status": item.get("status"), "pms": pms, "crews": crews, "same_site": o.get("same_site"),
        "steps": steps, "done": done, "total": len(steps), "stage": stage, "flags": _flags(o, steps, item, today),
        "life": life, "needs_review": n_review, "unanswered_dates": d.get("unanswered", {}).get(str(o["project_qbo_id"]), 0),
        "no_pipeline": bool(o.get("no_pipeline")),
    }


def _visible(r, today):
    """To do: new jobs that still need something done (a job leaves the list once
    every step is done or not needed, or once it's finished or long under way),
    plus any live project a change sent back for re-review."""
    if r["needs_review"] or r["unanswered_dates"]:
        return (r.get("life") or {}).get("status") not in ("closed", "canceled")
    if r["status"] in ("completed", "canceled"):
        return False
    if r["done"] == r["total"]:
        return False
    if r["start"] and date.fromisoformat(r["start"]) < today - timedelta(days=60):
        return False     # running well past its start: setup is history now, the job is the PM's
    return True


LIVE = ("setup", "ready", "in_progress")


@router.get("/queue")
def queue(include_all: bool = False, scope: str = "todo", user=Depends(require_capability(CAP))):
    """scope=todo: the To do list. scope=all: every live project (Setup, Ready, In
    progress, or anything with a re-review open), set up or not, to edit in place."""
    today = date.today()
    with engine.connect() as conn:
        extra = None
        if scope == "all":
            from app.projects import lifecycle as LC
            extra = [e for e, v in LC.statuses(conn).items() if v["status"] in LIVE or v["needs_review"]]
        reviewed = [str(r[0]) for r in conn.execute(text(
            "SELECT DISTINCT entity_id FROM project_setup_reviews WHERE resolved_at IS NULL")).all()]
        opps, d = _gather(conn, extra_eids=sorted(set((extra or []) + reviewed)))
    rows = [_row(o, d, today) for o in opps]
    if scope == "all":
        rows = [r for r in rows if (r.get("life") or {}).get("status") in LIVE or r["needs_review"]
                or (not r["project_qbo_id"] and _visible(r, today))]
    elif not include_all:
        rows = [r for r in rows if _visible(r, today)]
    order = {"bad": 0, "warn": 1, "info": 2}
    rows.sort(key=lambda r: (min([order[f["tone"]] for f in r["flags"]] or [3]), r["done"] == r["total"],
                             r["start"] or "9999", r["won"] or ""))
    return {"today": str(today), "scope": scope, "jobs": rows,
            "steps": [{"key": k, "stage": s, "label": l} for k, s, l, _ in STEPS],
            "reasons": RV.REASONS, "note_reasons": NOTE_REASONS}


def _one(conn, key):
    if key.startswith("opp:"):
        ids = [int(key[4:])]
    else:
        ids = [r[0] for r in conn.execute(text("SELECT id FROM opportunities WHERE project_qbo_id = :e"), {"e": key}).all()]
    if not ids and not key.startswith("opp:"):
        opps, d = _gather(conn, [], extra_eids=[key])
        if opps:
            return opps[0], d
    if not ids:
        raise HTTPException(status_code=404, detail="No won job with that key")
    opps, d = _gather(conn, ids)
    if not opps:
        raise HTTPException(status_code=404, detail="No won job with that key")
    return opps[0], d


@router.get("/job/{key}")
def job(key: str, user=Depends(require_capability(CAP))):
    with engine.connect() as conn:
        o, d = _one(conn, key)
        return _row(o, d, date.today())


@router.get("/job/{key}/estimate-draft")
def estimate_draft(key: str, user=Depends(require_capability(CAP))):
    with engine.begin() as conn:     # begin: the PO read is cached on first use
        o, _ = _one(conn, key)
        out = EST.draft(conn, o["id"])
    if out is None:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    return out


class StepMark(BaseModel):
    status: Optional[str] = None      # done | not_needed | confirmed; None clears the mark
    note: Optional[str] = None


@router.post("/job/{key}/step/{step}")
def mark_step(key: str, step: str, req: StepMark, user=Depends(require_capability(CAP))):
    if step not in STEP_KEYS:
        raise HTTPException(status_code=400, detail="Unknown step")
    if req.status is not None and req.status not in MARKS:
        raise HTTPException(status_code=400, detail="status must be done, not_needed or confirmed")
    with engine.begin() as conn:
        o, d = _one(conn, key)
        subject = o["key"]
        if req.status is None:
            conn.execute(text("DELETE FROM project_setup_steps WHERE subject IN (:s, :o) AND step_key = :k"),
                         {"s": subject, "o": f"opp:{o['id']}", "k": step})
        else:
            conn.execute(text("""
                INSERT INTO project_setup_steps (subject, step_key, status, note, by_user_id, by_email)
                VALUES (:s, :k, :st, :n, :u, :e)
                ON DUPLICATE KEY UPDATE status = VALUES(status), note = VALUES(note), by_user_id = VALUES(by_user_id),
                                        by_email = VALUES(by_email), at = CURRENT_TIMESTAMP"""),
                         {"s": subject, "k": step, "st": req.status, "n": (req.note or None),
                          "u": user.get("id"), "e": user.get("email")})
        if req.status and o["project_qbo_id"]:
            RV.resolve(conn, o["project_qbo_id"], step, user.get("email"), req.note)
        o2, d2 = _one(conn, key)
        row = _row(o2, d2, date.today())
    record_audit(user, "setup.step", "project", o["project_qbo_id"] or f"opp:{o['id']}", o["project_name"] or o["title"],
                 {"step": step, "status": req.status, "note": req.note, "entity_id": o["project_qbo_id"]})
    return row


# ── Re-review, notes, date changes, first invoice, hints (2026-11-12) ────────
NOTE_REASONS = {
    "po": [("coming", "PO coming (expected date)"), ("no_po", "Customer doesn't issue POs (signed quote / email)"),
           ("verbal", "Verbal OK, PO to follow"), ("other", "Other")],
    "qbo_estimate": [("waiting_po", "Waiting on the PO"), ("waiting_numbers", "Waiting on final numbers / scope"),
                     ("in_progress", "Being entered now"), ("other", "Other")],
    "first_invoice": [("waiting_po", "Waiting on the PO"), ("terms", "Terms say invoice later (e.g. on start)"),
                      ("customer", "Customer asked to wait"), ("other", "Other")],
}


class ReviewIn(BaseModel):
    note: Optional[str] = None


@router.post("/job/{key}/review/{step}")
def review_done(key: str, step: str, req: ReviewIn, user=Depends(require_capability(CAP))):
    if step not in STEP_KEYS:
        raise HTTPException(status_code=400, detail="Unknown step")
    with engine.begin() as conn:
        o, _ = _one(conn, key)
        if not o["project_qbo_id"]:
            raise HTTPException(status_code=400, detail="Not a project yet")
        if step == "dates":
            left = conn.execute(text("SELECT COUNT(*) FROM schedule_date_changes WHERE entity_id = :e AND answered_at IS NULL"),
                                {"e": o["project_qbo_id"]}).scalar()
            if left:
                raise HTTPException(status_code=400, detail=f"Answer the {left} date change{'s' if left != 1 else ''} first (why it moved, change order?)")
        RV.resolve(conn, o["project_qbo_id"], step, user.get("email"), req.note)
        o2, d2 = _one(conn, key)
        row = _row(o2, d2, date.today())
    record_audit(user, "setup.review", "project", o["project_qbo_id"], o["project_name"] or o["title"],
                 {"step": step, "note": req.note, "entity_id": o["project_qbo_id"]})
    return row


class NoteIn(BaseModel):
    step: str
    reason_code: Optional[str] = None
    note: Optional[str] = None
    expected_date: Optional[str] = None


@router.post("/job/{key}/note")
def add_note(key: str, req: NoteIn, user=Depends(require_capability(CAP))):
    """Why a step isn't done yet. Kept as a history; the office hears about it
    (bell, kind setup.note)."""
    if req.step not in NOTE_REASONS:
        raise HTTPException(status_code=400, detail="Notes are for the PO, estimate and first invoice steps")
    if not (req.reason_code or (req.note or "").strip()):
        raise HTTPException(status_code=400, detail="Pick a reason or write a note")
    with engine.begin() as conn:
        o, _ = _one(conn, key)
        conn.execute(text("""INSERT INTO project_setup_notes (subject, step_key, reason_code, note, expected_date, by_user_id, by_email)
                             VALUES (:s, :k, :r, :n, :x, :u, :e)"""),
                     {"s": o["key"], "k": req.step, "r": req.reason_code, "n": (req.note or "").strip() or None,
                      "x": req.expected_date or None, "u": user.get("id"), "e": user.get("email")})
        o2, d2 = _one(conn, key)
        row = _row(o2, d2, date.today())
    label = dict(NOTE_REASONS[req.step]).get(req.reason_code, "")
    what = {"po": "No PO yet", "qbo_estimate": "Estimate not done", "first_invoice": "First invoice not sent"}[req.step]
    body = "\n".join(x for x in (label, (req.note or "").strip(), f"Expected {req.expected_date}" if req.expected_date else None,
                                  f"By {user.get('email')}") if x)
    try:
        from app.help.notify import notify
        from app.help.watch import office_users
        notify([u for u in office_users() if u != user.get("id")], "setup.note", f"{what}: {o['project_name'] or o['title']}",
               body=body, link=f"#/setup?job={o['key']}", subject=o["project_qbo_id"] or o["key"],
               dedupe_key=f"setup.note:{o['key']}:{req.step}:{datetime.utcnow():%Y%m%d%H%M%S}")
    except Exception:
        pass
    record_audit(user, "setup.note", "project", o["project_qbo_id"] or o["key"], o["project_name"] or o["title"],
                 {"step": req.step, "reason": req.reason_code, "note": req.note, "expected": req.expected_date,
                  "entity_id": o["project_qbo_id"]})
    return row


@router.get("/job/{key}/dates")
def job_dates(key: str, user=Depends(require_capability(CAP))):
    with engine.connect() as conn:
        o, _ = _one(conn, key)
        if not o["project_qbo_id"]:
            return {"changes": [], "lines": [], "reasons": RV.REASONS}
        lines = [{k: (str(v) if isinstance(v, (date, datetime)) else v) for k, v in dict(r).items()} for r in conn.execute(text("""
            SELECT s.id, s.sort_order, s.status, s.start_date, s.end_date, COALESCE(s.overage_days, 0) AS overage_days,
                   DATE_ADD(s.end_date, INTERVAL COALESCE(s.overage_days, 0) DAY) AS last_day, s.non_working
            FROM project_schedule_items s JOIN projects p ON p.id = s.project_id
            JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
            WHERE qc.qbo_id = :e AND s.status <> 'canceled' ORDER BY s.start_date IS NULL, s.start_date, s.id"""),
            {"e": o["project_qbo_id"]}).mappings()]
        return {"changes": RV.date_changes(conn, o["project_qbo_id"]), "lines": lines, "reasons": RV.REASONS,
                "target_start": str(o["target_start_date"]) if o["target_start_date"] else None,
                "target_end": str(o["target_end_date"]) if o["target_end_date"] else None,
                "labor_days": float(o["labor_days"] or 0) or None, "travel_days": float(o["travel_days"] or 0) or None}


class AnswerIn(BaseModel):
    reason_code: str
    co_needed: Optional[str] = None
    note: Optional[str] = None


@router.post("/date-change/{cid}")
def answer_date_change(cid: int, req: AnswerIn, user=Depends(require_capability(CAP))):
    if req.reason_code not in dict(RV.REASONS):
        raise HTTPException(status_code=400, detail="Pick why the dates moved")
    if req.co_needed is not None and req.co_needed not in RV.CO_ANSWERS:
        raise HTTPException(status_code=400, detail="Change order: yes, no or sent")
    if req.reason_code == "other" and not (req.note or "").strip():
        raise HTTPException(status_code=400, detail="Say what happened (Other)")
    with engine.begin() as conn:
        e = RV.answer_change(conn, cid, req.reason_code, req.co_needed, req.note, user.get("email"))
    if not e:
        raise HTTPException(status_code=404, detail="Date change not found")
    record_audit(user, "setup.date_answer", "project", e, None,
                 {"change": cid, "reason": req.reason_code, "co_needed": req.co_needed, "note": req.note, "entity_id": e})
    return {"ok": True, "entity_id": e}


@router.get("/job/{key}/first-invoice")
def first_invoice(key: str, user=Depends(require_capability(CAP))):
    """The first invoice: from QuickBooks once sent (number, dates, terms,
    amount, % of contract, status), and the first row of the invoice schedule,
    whose dates (sent / due / expected paid) feed Billing and Cash Flow."""
    with engine.connect() as conn:
        o, _ = _one(conn, key)
        e = o["project_qbo_id"]
        if not e:
            return {"invoice": None, "milestone": None}
        inv = conn.execute(text("""
            SELECT t.qbo_id, t.doc_number, t.txn_date, t.due_date, t.total_amt, t.balance_amt,
                   JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.SalesTermRef.name')) AS terms,
                   JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.EmailStatus')) AS email_status,
                   (SELECT JSON_UNQUOTE(JSON_EXTRACT(lt.value, '$.TxnId')) FROM JSON_TABLE(t.raw_json, '$.LinkedTxn[*]'
                      COLUMNS (value JSON PATH '$')) lt WHERE JSON_UNQUOTE(JSON_EXTRACT(lt.value, '$.TxnType')) = 'Estimate' LIMIT 1) AS est_id
            FROM qbo_transactions t WHERE t.entity_type = 'Invoice' AND t.customer_qbo_id = :e
            ORDER BY t.txn_date, t.id LIMIT 1"""), {"e": e}).mappings().first()
        contract = float(conn.execute(text("""SELECT COALESCE(SUM(total_amt), 0) FROM qbo_transactions
            WHERE entity_type = 'Estimate' AND customer_qbo_id = :e"""), {"e": e}).scalar() or 0)
        est_no = None
        if inv and inv["est_id"]:
            est_no = conn.execute(text("SELECT doc_number FROM qbo_transactions WHERE entity_type = 'Estimate' AND qbo_id = :q LIMIT 1"),
                                  {"q": inv["est_id"]}).scalar()
        ms = conn.execute(text("""
            SELECT m.id, m.label, m.pct, m.amount, m.invoice_date, m.due_date, m.expected_paid_date, m.status,
                   m.qbo_invoice_id, s.terms_note, s.net_days, s.estimate_doc_number
            FROM project_invoice_milestones m JOIN project_invoice_schedules s ON s.id = m.schedule_id
            WHERE s.entity_id = :e ORDER BY (m.qbo_invoice_id = :q) DESC, m.invoice_date IS NULL, m.invoice_date, m.seq LIMIT 1"""),
            {"e": e, "q": inv["qbo_id"] if inv else "-"}).mappings().first()
    iso = lambda v: str(v) if v else None  # noqa: E731
    out = {"contract": round(contract, 2), "invoice": None, "milestone": None}
    if inv:
        amt, bal = float(inv["total_amt"] or 0), float(inv["balance_amt"] or 0)
        out["invoice"] = {"qbo_id": inv["qbo_id"], "doc_number": inv["doc_number"], "date": iso(inv["txn_date"]),
                          "due": iso(inv["due_date"]), "amount": amt, "balance": bal, "terms": inv["terms"],
                          "pct": round(100 * amt / contract, 1) if contract else None, "estimate": est_no,
                          "status": "Paid" if bal <= 0.01 else ("Partly paid" if bal < amt - 0.01 else "Open (sent)"),
                          "emailed": inv["email_status"] == "EmailSent"}
    if ms:
        out["milestone"] = {"id": ms["id"], "label": ms["label"], "pct": float(ms["pct"]) if ms["pct"] is not None else None,
                            "amount": float(ms["amount"] or 0), "invoice_date": iso(ms["invoice_date"]), "due_date": iso(ms["due_date"]),
                            "expected_paid_date": iso(ms["expected_paid_date"]), "status": ms["status"],
                            "is_invoice": bool(ms["qbo_invoice_id"]), "terms": ms["terms_note"], "net_days": ms["net_days"],
                            "estimate": ms["estimate_doc_number"]}
    return out


HINT_WORDS = {
    "wire": ["wire", "wiring", "cable", "electrical", "electric"],
    "travel": ["travel", "per diem", "perdiem", "lodging", "hotel", "mileage", "airfare", "flight"],
    "equipment": ["lift", "forklift", "fork lift", "scissor", "boom", "telehandler", "rental", "equipment", "pallet jack", "manlift"],
}


@router.get("/job/{key}/hints")
def detail_hints(key: str, user=Depends(require_capability(CAP))):
    """Wire / travel / equipment words in the PO (as read) and the project's
    estimate lines, with the sentence around each, to help fill the details."""
    import re
    with engine.begin() as conn:
        o, _ = _one(conn, key)
        texts = []
        if o["id"]:
            try:
                dr = EST.draft(conn, o["id"]) or {}
                if (dr.get("po") or {}).get("snippet"):
                    texts.append(("PO", dr["po"]["snippet"]))
            except Exception:
                pass
        if o["project_qbo_id"]:
            for (raw,) in conn.execute(text("""SELECT raw_json FROM qbo_transactions WHERE entity_type = 'Estimate'
                                               AND customer_qbo_id = :e"""), {"e": o["project_qbo_id"]}).all():
                import json as _j
                d = raw if isinstance(raw, dict) else _j.loads(raw or "{}")
                for ln in d.get("Line") or []:
                    desc = ln.get("Description") or (ln.get("SalesItemLineDetail") or {}).get("ItemRef", {}).get("name")
                    if desc:
                        texts.append((f"Estimate #{d.get('DocNumber') or ''}".strip(), desc))
    out = {k: [] for k in HINT_WORDS}
    seen = set()
    for src, t in texts:
        for kind, words in HINT_WORDS.items():
            for w in words:
                for m in re.finditer(r"\b" + re.escape(w) + r"\b", t, re.I):
                    a, b = max(0, m.start() - 60), min(len(t), m.end() + 60)
                    ctx = " ".join(t[a:b].split())
                    sig = (kind, ctx[:80])
                    if sig in seen:
                        continue
                    seen.add(sig)
                    out[kind].append({"word": w, "source": src, "text": ("…" if a else "") + ctx + ("…" if b < len(t) else "")})
    return {k: v[:6] for k, v in out.items()}
