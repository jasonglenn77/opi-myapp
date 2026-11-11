"""
Running Jobs: every job under way (and the ones about to start) in one place.

It takes over Progress Checks (same numbers, same sign-offs) and adds what the
person watching a job needs next to them:

  progress      time used vs invoiced vs cost spent vs crew labor paid, the
                checkpoints at 25/50/75/100% and their sign-offs (app.progress)
  money         contract, invoiced, open, projected margin if the rest of the
                costs go to plan
  problems      the job's open items from Issues (Tracker, Contractor Payments,
                job cost, change orders, Data Review, schedules)
  updates       the PM's customer and crew updates from Leo's Project Lifecycle
                list, as ready-to-send emails filled from the job (templates in
                docs/feedback/2026-11-10-leo-pm-portal.md). The app has no mail
                server yet, so "Open in email" hands them to the PM's own email
                app; "Mark sent" records them here.

  GET    /api/running                      every running / upcoming job (list)
  GET    /api/running/job/{entity_id}      one job: progress, problems, updates
  POST   /api/running/job/{entity_id}/comms {kind, status, to, subject, body, note}
  DELETE /api/running/comms/{id}           undo a recorded update

Viewing needs page.cashflow or page.customers (like Progress Checks).
"""
import re
from collections import defaultdict
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import bindparam, text

from app.audit import record_audit
from app.auth import get_current_user
from app.db import engine
from app.permissions import has_capability, FINANCIAL_SIGNOFF, PAGE_CASHFLOW, PAGE_CUSTOMERS
from app.progress import service as PS

router = APIRouter(prefix="/api/running", tags=["running"])

SOON_DAYS = 30
GRACE_DAYS = 7      # kickoff steps on a job that started longer ago than this are not chased

# Leo's Project Lifecycle list, in order. `when` decides when a step is due.
COMMS = [
    ("kickoff_schedule", "Kickoff call scheduled", "customer", "before"),
    ("customer_kickoff", "Customer kickoff call done, checklist sent", "customer", "before"),
    ("crew_kickoff", "Crew kickoff call done, checklist sent", "crew", "before"),
    ("client_thread", "Customer group text started", "text", "before"),
    ("crew_thread", "Crew group text started", "text", "before"),
    ("day1", "Day 1 kickoff email", "customer", "start"),
    ("daily", "Daily updates", "customer", "daily"),
    ("completion", "Project completion email", "customer", "end"),
]
COMM_KEYS = {k for k, *_ in COMMS}


def _require(user):
    if not any(has_capability(user, c) for c in (PAGE_CASHFLOW, PAGE_CUSTOMERS)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _q(sql, *names):
    return text(sql).bindparams(*[bindparam(n, expanding=True) for n in names])


def _issues():
    from app.issues import routes as IR
    import time
    now = time.time()
    if not IR._cache["data"] or now - IR._cache["at"] > IR.CACHE_SECONDS:
        IR._cache["data"], IR._cache["at"] = IR.build(), now
    return IR._cache["data"]


def _running(jobs, today):
    """Under way, or starting within SOON_DAYS."""
    out = []
    for j in jobs:
        s, e = date.fromisoformat(j["start"]), date.fromisoformat(j["end"])
        if s <= today <= e or j["state"] == "active":
            out.append(j)
        elif today < s <= today + timedelta(days=SOON_DAYS):
            out.append(j)
    return out


def _weekdays(a, b):
    if not a or not b or b < a:
        return 0
    n, d = 0, a
    while d <= b:
        n += d.weekday() < 5
        d += timedelta(days=1)
    return n


def _projected(j):
    """Margin if the rest of the job's costs land on plan: revenue = contract +
    pending estimates; cost = the larger of the cost budget and what's known."""
    budget = sum(b["budget"] + b["pending"] for b in j["buckets"])
    known = sum(b["known"] for b in j["buckets"])
    rev = (j.get("contract") or 0) + (j.get("pending_contract") or 0)
    cost = max(budget, known)
    if not rev or not cost:
        return None, round(budget, 2), round(known, 2)
    return round(100 * (rev - cost) / rev, 1), round(budget, 2), round(known, 2)


def _crews(conn, ids):
    out = defaultdict(list)
    if not ids:
        return out
    for r in conn.execute(_q("""
        SELECT DISTINCT qc.qbo_id AS e, c.id, c.name, c.boss_name FROM qbo_customers qc
        JOIN projects p ON p.qbo_customer_id = qc.id
        JOIN project_schedule_items psi ON psi.project_id = p.id
        JOIN project_schedule_item_work_crews wc ON wc.schedule_item_id = psi.id AND wc.unassigned_at IS NULL
        JOIN work_crews c ON c.id = COALESCE(wc.company_id, wc.work_crew_id)
        WHERE qc.qbo_id IN :ids""", "ids"), {"ids": ids}).mappings():
        if not any(x["id"] == r["id"] for x in out[r["e"]]):
            out[r["e"]].append({"id": r["id"], "name": r["name"], "boss": r["boss_name"]})
    return out


def _comms(conn, ids):
    out = defaultdict(list)
    if not ids:
        return out
    for r in conn.execute(_q("""SELECT id, entity_id, kind, status, to_addr, subject, body, note, by_email, at
                                FROM project_comms WHERE entity_id IN :ids ORDER BY at""", "ids"), {"ids": ids}).mappings():
        out[r["entity_id"]].append({**dict(r), "at": str(r["at"])})
    return out


def _comm_steps(j, sent, today):
    """Each update step's state: done / due (todo) / later (locked)."""
    s, e = date.fromisoformat(j["start"]), date.fromisoformat(j["end"])
    by = defaultdict(list)
    for c in sent:
        by[c["kind"]].append(c)
    steps = []
    for key, label, who, when in COMMS:
        rows = by.get(key, [])
        last = rows[-1] if rows else None
        if key == "daily":
            sent_dates = {c["at"][:10] for c in rows if c["status"] == "sent"}
            if today < s:
                state, why = "locked", "From the first day on site"
            elif today > e or j["state"] == "finished":
                state, why = ("done" if rows else "not_needed"), f"{len(sent_dates)} sent" if rows else "Job finished"
            elif today.weekday() >= 5:
                state, why = "done", "Weekend"
            elif str(today) in sent_dates:
                state, why = "done", "Today's update sent"
            else:
                state, why = "todo", (f"Last sent {last['at'][:10]}" if last else "None sent yet")
            steps.append({"key": key, "label": label, "who": who, "state": state, "detail": why,
                          "count": len(sent_dates), "last": last})
            continue
        if last:
            state = "done" if last["status"] == "sent" else "not_needed"
            why = f"{'Sent' if last['status'] == 'sent' else 'Not needed'} {last['at'][:10]} by {last['by_email'] or 'someone'}"
        elif when in ("before", "start") and (today - s).days > GRACE_DAYS:
            # the job started before the app tracked updates: don't call it overdue
            state, why = "not_needed", "Not recorded here (the job started before the app tracked updates)"
        elif when == "before":
            state, why = "todo", (f"Before the start on {s:%b %-d}" if today < s else "Should have happened before the start")
        elif when == "start":
            state, why = ("todo", "On the first day on site") if today >= s else ("locked", f"On the first day, {s:%b %-d}")
        else:   # end
            state, why = ("todo", "The job's end date has passed") if today >= e else ("locked", f"When the job finishes ({e:%b %-d})")
        steps.append({"key": key, "label": label, "who": who, "state": state, "detail": why, "last": last})
    return steps


@router.get("")
def running(fresh: bool = False, user=Depends(get_current_user)):
    _require(user)
    today = date.today()
    d = PS.dataset(force=fresh)
    jobs = _running(d["jobs"], today)
    ids = [j["id"] for j in jobs]
    iss = defaultdict(lambda: {"bad": 0, "warn": 0, "total": 0, "amount": 0.0})
    try:
        for i in _issues()["items"]:
            if i["entity_id"] in ids:
                x = iss[i["entity_id"]]
                x["total"] += 1
                x[i["sev"]] = x.get(i["sev"], 0) + 1
    except Exception:
        pass
    with engine.connect() as conn:
        crews = _crews(conn, ids)
        comms = _comms(conn, ids)
    rows = []
    for j in jobs:
        s, e = date.fromisoformat(j["start"]), date.fromisoformat(j["end"])
        total = _weekdays(s, e)
        n = _weekdays(s, min(today, e)) if today >= s else 0
        margin, budget, known = _projected(j)
        steps = _comm_steps(j, comms.get(j["id"], []), today)
        phase = "soon" if today < s else ("late" if today > e else "now")
        rows.append({
            "id": j["id"], "name": j["name"], "pm": j["pm"], "start": j["start"], "end": j["end"], "phase": phase,
            "days_total": total, "day_n": n, "days_to_start": (s - today).days if today < s else None,
            "pct_time": j["pct_time"], "pct_invoiced": j["pct_invoiced"], "pct_cost": j["pct_cost"], "pct_labor": j["pct_labor"],
            "contract": j["contract"], "pending_contract": j["pending_contract"], "invoiced": j["invoiced"], "open_ar": j["open_ar"],
            "status": j["status"], "signoff_required": j["signoff_required"], "signoffs_due": j["signoffs_due"],
            "projected_margin": margin, "cost_budget": budget, "cost_known": known,
            "problems": iss.get(j["id"]) or {"bad": 0, "warn": 0, "total": 0},
            "crews": crews.get(j["id"], []),
            "updates_due": [x["key"] for x in steps if x["state"] == "todo"],
            "updates_done": sum(1 for x in steps if x["state"] in ("done", "not_needed")), "updates_total": len(steps),
        })
    order = {"now": 0, "late": 1, "soon": 2}
    rows.sort(key=lambda r: (order[r["phase"]], -r["problems"]["bad"], -r["signoffs_due"], r["start"]))
    return {"today": str(today), "jobs": rows, "rules": d["rules"], "confidence": d["confidence"],
            "can_sign": has_capability(user, FINANCIAL_SIGNOFF), "snapshot": d.get("snapshot")}


# ── one job ────────────────────────────────────────────────────────────────
def _folders(conn, eid):
    root = conn.execute(text("""SELECT drive_id, path FROM drive_folders WHERE entity_type = 'project' AND entity_id = :e
                                ORDER BY is_root DESC LIMIT 1"""), {"e": eid}).mappings().first()
    if not root:
        return {}
    url = lambda fid: f"https://drive.google.com/drive/folders/{fid}"
    subs = conn.execute(text("SELECT drive_id, path FROM drive_folders WHERE path LIKE :p"),
                        {"p": root["path"].replace("%", r"\%").replace("_", r"\_") + "/%"}).mappings().all()
    def find(*pats):
        for pat in pats:
            hit = sorted((s for s in subs if re.search(pat, s["path"], re.I)), key=lambda s: len(s["path"]))
            if hit:
                return url(hit[0]["drive_id"])
        return None
    return {"root": url(root["drive_id"]),
            "progress": find(r"/\d*\s*Construction Progression Updates$", r"Progression Updates$", r"Progress"),
            "before": find(r"Before Pictures$"),
            "completion": find(r"/\d*\s*Project Completion$", r"Completion$"),
            "kickoff": find(r"/\d*\s*Kickoff$")}


def _people(conn, eid):
    opp = conn.execute(text("""
        SELECT o.id, o.title, o.city, o.state, o.quote_number, o.contact_id, o.contact_name_raw, o.qbo_customer_id,
               c.full_name, c.first_name, c.email, c.phone
        FROM opportunities o LEFT JOIN contacts c ON c.id = o.contact_id
        WHERE o.project_qbo_id = :e ORDER BY o.order_date IS NULL, o.order_date, o.id LIMIT 1"""), {"e": eid}).mappings().first()
    proj = conn.execute(text("""SELECT qc.display_name, pc.display_name AS customer FROM qbo_customers qc
                                LEFT JOIN qbo_customers pc ON pc.qbo_id = qc.parent_qbo_id WHERE qc.qbo_id = :e"""),
                        {"e": eid}).mappings().first()
    pm = conn.execute(text("""
        SELECT m.first_name, m.last_name, u.email FROM qbo_customers qc
        JOIN projects p ON p.qbo_customer_id = qc.id JOIN project_schedule_items psi ON psi.project_id = p.id
        JOIN project_schedule_item_project_managers spm ON spm.schedule_item_id = psi.id AND spm.unassigned_at IS NULL
        JOIN project_managers m ON m.id = spm.project_manager_id
        LEFT JOIN users u ON u.project_manager_id = m.id
        WHERE qc.qbo_id = :e ORDER BY spm.is_primary DESC LIMIT 1"""), {"e": eid}).mappings().first()
    signer = None
    try:
        r = conn.execute(text("""
            SELECT s.answers FROM form_submissions s
            WHERE s.project_qbo_id = :e AND s.form_code LIKE '%%completion%%' ORDER BY s.id DESC LIMIT 1"""), {"e": eid}).scalar()
        if r:
            import json
            a = json.loads(r) if isinstance(r, str) else r
            for v in (a or {}).values():
                if isinstance(v, dict) and (v.get("name") or v.get("signer")):
                    signer = v.get("name") or v.get("signer")
                    break
    except Exception:
        signer = None
    return opp and dict(opp), proj and dict(proj), pm and dict(pm), signer


def _parts(name, opp):
    """'6945 - USAF - Roselle & Skokie, IL' -> number, company, 'Roselle & Skokie, IL'."""
    bits = [b.strip() for b in (name or "").split(" - ")]
    num = bits[0] if bits and re.match(r"^\d", bits[0]) else (opp or {}).get("quote_number") or ""
    company = bits[1] if len(bits) >= 3 else (bits[1] if len(bits) == 2 else name)
    place = bits[-1] if len(bits) >= 3 else ""
    if opp and opp.get("city"):
        place = f"{opp['city']}, {opp['state']}" if opp.get("state") else opp["city"]
    return num, company, place


def _templates(j, opp, proj, pm, signer, crews, folders, comms):
    num, company, place = _parts(j["name"], opp)
    client = (opp or {}).get("first_name") or ((opp or {}).get("full_name") or (opp or {}).get("contact_name_raw") or "").split(" ")[0] or "[client name]"
    boss = ", ".join(c["boss"] for c in crews if c.get("boss")) or "[crew boss]"
    sig = f"\n\n{pm['first_name']} {pm['last_name']}\nOnPoint Installers" if pm else "\n\nOnPoint Installers"
    head = f"{company} - {place}" if place else company
    q = f" Quote #{num}" if num else ""
    prog = folders.get("progress") or "[link to the progress update folder]"
    before = folders.get("before") or prog
    done = folders.get("completion") or "[link to the completion folder]"
    last_daily = next((c for c in reversed(comms) if c["kind"] == "daily" and c["status"] == "sent" and c.get("body")), None)
    daily_body = last_daily["body"] if last_daily else (
        f"Hello, {client},\n\nPlease see the following link to view photo and drawing updates:\n{prog}\n\n"
        "1. Progress Summary\n   - Percentage Complete: 0%\n\n2. Current Work\n   - \n\n3. Upcoming Tasks\n   - \n   - \n\n"
        "4. Issues or Actionable Items\n   - All good.\n\nPlease let me know if you have any questions or concerns.\n\nThank you," + sig)
    customer_to = (opp or {}).get("email") or ""
    return {
        "kickoff_schedule": {"to": customer_to, "subject": f"Kickoff Call: {head}{q}", "body":
            f"Hello, {client},\n\nI'm looking forward to working on a {company} project! Let's schedule a kickoff call so we can be prepared for when the project starts.\n\n"
            "Which of the following dates and times works for you:\n   - [Day of the week, Month Date @ Time & time zone]\n   - [e.g. Tuesday, October 20th @ 12PM CST]\n\n"
            "If none of the dates above work for you, please let me know a date and time that works best.\n\nThank you," + sig},
        "customer_kickoff": {"to": customer_to, "subject": f"Kickoff Call Recap: {head}{q}", "attach": "Customer Kickoff checklist (PDF) + any other files", "body":
            f"Hello, {client},\n\nThank you for taking the time to go over the {head} project. Please see the attached kickoff checklist filled out on the call. We just need confirmation for the following:\n   - \n   - \n   - \n\n"
            "Feel free to call or text me with any questions or concerns.\n\nThank you," + sig},
        "crew_kickoff": {"to": "", "subject": f"Crew Kickoff Call: {head}", "attach": "Crew Kickoff checklist (PDF) + any other files", "body":
            f"Hello, {boss},\n\nThank you for taking the time to go over the {head} project. Please see the attached kickoff checklist. Make sure we pay attention to the following:\n   - \n   - \n   - \n\n"
            "Feel free to call or text me with any questions or concerns.\n\nThank you," + sig},
        "day1": {"to": customer_to, "subject": f"Project Kickoff: {head}{q}", "body":
            f"Hello, {client},\n\nPlease view the following link to see the facility before photos:\n{before}\n\n"
            f"We have arrived onsite to kick off the {head} project. The layout is being marked and trucks are being unloaded. Please let me know if you have any questions or concerns.\n\n"
            f"Thank you,{sig}\n\nProgress updates: {prog}"},
        "daily": {"to": (last_daily or {}).get("to_addr") or customer_to, "subject": f"Project Update: {head}{q}", "body": daily_body,
                  "from_last": bool(last_daily)},
        "completion": {"to": customer_to, "subject": f"Project Complete: {head}{q}", "body":
            f"Hello, {client},\n\nPlease view the following link to see the signed completion form and photos:\n{done}\n\n"
            f"We have successfully completed the {company} project in {place or '[City, State]'}. The final walkthrough has been completed and we received the completion form signed by {signer or '[name of who signed the completion form]'}. Looking forward to our next project together.\n\n"
            "Please let me know if you have any questions or concerns.\n\nThank you," + sig},
    }


@router.get("/job/{entity_id}")
def job(entity_id: str, user=Depends(get_current_user)):
    _require(user)
    today = date.today()
    d = PS.dataset()
    j = next((x for x in d["jobs"] if x["id"] == entity_id), None)
    if not j:
        raise HTTPException(status_code=404, detail="That job isn't in Progress Checks (no dates or no estimate yet)")
    with engine.connect() as conn:
        crews = _crews(conn, [entity_id]).get(entity_id, [])
        comms = _comms(conn, [entity_id]).get(entity_id, [])
        folders = _folders(conn, entity_id)
        opp, proj, pm, signer = _people(conn, entity_id)
    s, e = date.fromisoformat(j["start"]), date.fromisoformat(j["end"])
    margin, budget, known = _projected(j)
    try:
        problems = [i for i in _issues()["items"] if i["entity_id"] == entity_id]
    except Exception as ex:
        problems = [{"area": "data", "sev": "warn", "title": f"Couldn't load problems: {ex}", "key": "err"}]
    return {
        "job": {**j, "days_total": _weekdays(s, e), "day_n": _weekdays(s, min(today, e)) if today >= s else 0,
                "projected_margin": margin, "cost_budget": budget, "cost_known": known, "crews": crews,
                "customer": (proj or {}).get("customer"), "contact": opp and {k: opp.get(k) for k in ("full_name", "email", "phone")}},
        "problems": problems,
        "updates": _comm_steps(j, comms, today),
        "templates": _templates(j, opp, proj, pm, signer, crews, folders, comms),
        "history": list(reversed(comms))[:40],
        "folders": folders,
        "rules": d["rules"], "confidence": d["confidence"],
        "can_sign": has_capability(user, FINANCIAL_SIGNOFF),
    }


class CommIn(BaseModel):
    kind: str
    status: str = "sent"            # sent | not_needed
    to: Optional[str] = None
    subject: Optional[str] = None
    body: Optional[str] = None
    note: Optional[str] = None


@router.post("/job/{entity_id}/comms")
def record_comm(entity_id: str, req: CommIn, user=Depends(get_current_user)):
    _require(user)
    if req.kind not in COMM_KEYS:
        raise HTTPException(status_code=400, detail="Unknown update")
    if req.status not in ("sent", "not_needed"):
        raise HTTPException(status_code=400, detail="status must be sent or not_needed")
    with engine.begin() as conn:
        r = conn.execute(text("""INSERT INTO project_comms (entity_id, kind, status, to_addr, subject, body, note, by_user_id, by_email)
                                 VALUES (:e, :k, :s, :t, :sub, :b, :n, :u, :em)"""),
                         {"e": entity_id, "k": req.kind, "s": req.status, "t": (req.to or None), "sub": (req.subject or None),
                          "b": (req.body or None), "n": (req.note or None), "u": user.get("id"), "em": user.get("email")})
        new_id = r.lastrowid
    record_audit(user, "running.update", "project", entity_id, None, {"kind": req.kind, "status": req.status, "subject": req.subject})
    return {"ok": True, "id": new_id}


@router.delete("/comms/{comm_id}")
def undo_comm(comm_id: int, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        row = conn.execute(text("SELECT entity_id, kind FROM project_comms WHERE id = :i"), {"i": comm_id}).mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="Not found")
        conn.execute(text("DELETE FROM project_comms WHERE id = :i"), {"i": comm_id})
    record_audit(user, "running.update_undo", "project", row["entity_id"], None, {"kind": row["kind"], "id": comm_id})
    return {"ok": True}
