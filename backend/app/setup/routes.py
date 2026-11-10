"""
Project Setup: everything the office does between a purchase order arriving and
the job being ready to start, for every won job, in one place.

  GET  /api/setup/queue                    every won job still being set up, with its steps
  GET  /api/setup/job/{key}                one job: steps, opportunity, project, links
  GET  /api/setup/job/{key}/estimate-draft the project's first estimate, drafted (estimate.py)
  POST /api/setup/job/{key}/step/{step}    mark a step done / not needed / confirmed, or clear it

`key` is the QuickBooks project id once the project exists, else "opp:<id>".

Most steps are read from the data (PM assigned, dates set, offer accepted,
invoice sent...). The rest need a person: checking the job details, and
reviewing each schedule the app built. Those marks live in project_setup_steps.
"""
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import bindparam, text

from app.audit import record_audit
from app.auth import require_capability
from app.db import engine
from . import estimate as EST

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


def _gather(conn, opp_ids=None):
    """Won opportunities (or the given ones) with everything the steps need, in bulk."""
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
    """, *(["ids"] if opp_ids else [])), {"ids": opp_ids, "since": since}).mappings()]
    if not opps:
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
    subjects = [o["key"] for o in rows] + [f"opp:{o['id']}" for o in opps]
    d["marks"] = {}
    for r in conn.execute(_q("""SELECT subject, step_key, status, note, by_email, at FROM project_setup_steps
                                WHERE subject IN :s""", "s"), {"s": subjects}).mappings():
        d["marks"].setdefault(r["subject"], {})[r["step_key"]] = dict(r)
    return rows, d


def _steps(o, d, today):
    eid, cid = o["project_qbo_id"], o["project_internal_id"]
    marks = {**d["marks"].get(f"opp:{o['id']}", {}), **d["marks"].get(o["key"], {})}
    item = d["items"].get(cid) or {}
    offers = d["offers"].get(eid, []) if eid else []
    accepted = [x for x in offers if x["status"] == "accepted"]
    has_dates = bool(item.get("start_date") and item.get("end_date"))
    out = []

    def add(key, state, detail="", **extra):
        m = marks.get(key)
        if m and state not in ("done",):
            state = "done" if m["status"] in ("done", "confirmed") else "not_needed"
            detail = (detail + " · " if detail else "") + f"marked by {m['by_email'] or 'someone'} {str(m['at'])[:10]}"
        stage, label, how = next((s[1], s[2], s[3]) for s in STEPS if s[0] == key)
        out.append({"key": key, "stage": stage, "label": label, "how": how, "state": state, "detail": detail,
                    "mark": ({"status": m["status"], "by": m["by_email"], "at": str(m["at"]), "note": m["note"]} if m else None),
                    **extra})

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
    if st["qbo_project"] != "done" and won and (today - won).days >= 2:
        fl.append(("bad", f"Won {(today - won).days} days ago, not in QuickBooks"))
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
    if any(s.get("warning") for s in steps):
        fl.append(("warn", "Crew pay scheduled, no crew yet"))
    if o.get("same_site"):
        fl.append(("info", f"Same site as {o['same_site']['name']}: may be added scope"))
    return [{"tone": t, "text": x} for t, x in fl]


def _row(o, d, today):
    steps, item, pms, crews = _steps(o, d, today)
    done = sum(1 for s in steps if s["state"] in ("done", "not_needed"))
    stage = next((s["stage"] for s in steps if s["state"] in ("todo", "waiting")), "Ready")
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
    }


def _visible(r, today):
    """New jobs that still need something done: a job leaves the list once every
    step is done (or not needed), or once it's finished or long under way."""
    if r["status"] in ("completed", "canceled"):
        return False
    if r["done"] == r["total"]:
        return False
    if r["start"] and date.fromisoformat(r["start"]) < today - timedelta(days=60):
        return False     # running well past its start: setup is history now, the job is the PM's
    return True


@router.get("/queue")
def queue(include_all: bool = False, user=Depends(require_capability(CAP))):
    today = date.today()
    with engine.connect() as conn:
        opps, d = _gather(conn)
    rows = [_row(o, d, today) for o in opps]
    if not include_all:
        rows = [r for r in rows if _visible(r, today)]
    order = {"bad": 0, "warn": 1, "info": 2}
    rows.sort(key=lambda r: (min([order[f["tone"]] for f in r["flags"]] or [3]), r["done"] == r["total"],
                             r["start"] or "9999", r["won"] or ""))
    return {"today": str(today), "jobs": rows, "steps": [{"key": k, "stage": s, "label": l} for k, s, l, _ in STEPS]}


def _one(conn, key):
    if key.startswith("opp:"):
        ids = [int(key[4:])]
    else:
        ids = [r[0] for r in conn.execute(text("SELECT id FROM opportunities WHERE project_qbo_id = :e"), {"e": key}).all()]
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
        o2, d2 = _one(conn, key)
        row = _row(o2, d2, date.today())
    record_audit(user, "setup.step", "project", o["project_qbo_id"] or f"opp:{o['id']}", o["project_name"] or o["title"],
                 {"step": step, "status": req.status, "note": req.note, "entity_id": o["project_qbo_id"]})
    return row
