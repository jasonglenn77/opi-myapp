"""
Project Closeout: every finished job until it's closed — the final invoice,
getting paid, paying the crew in full, expenses, change orders and the paperwork.
Same shape as Project Setup (setup/routes.py): a queue of jobs, each with steps;
steps the data can answer tick themselves, the rest are marked here.

  GET  /api/closeout/queue                       finished jobs still being closed out
  GET  /api/closeout/job/{entity_id}             one job: steps + the numbers behind them
  GET  /api/closeout/job/{entity_id}/detail      what's behind each step (for the step cards)
  POST /api/closeout/job/{entity_id}/step/{step} {status: done|not_needed|null, note}

Which jobs: a project whose status is Completed, or whose last scheduled day has
passed (not Canceled). It stays until every step is done or marked not needed.
Jobs that finished more than OLD_DAYS ago only show while money is still open
(unbilled, unpaid, or crew owed): older paperwork gaps are history, not work.
"""
import json
from collections import defaultdict
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import bindparam, text

from app.audit import record_audit
from app.auth import require_capability
from app.billing import retainage as RET
from app.db import engine

router = APIRouter(prefix="/api/closeout", tags=["closeout"])
CAP = "page.assignment"
OLD_DAYS = 180          # finished longer ago than this: only while money is open
MONEY_DAYS = 730        # ... and not older than two years at all
TOL = 1.0               # dollars

# (key, group, label, auto|manual)
STEPS = [
    ("marked_complete", "Job", "Job marked complete in the app", "auto"),
    ("completion_form", "Job", "Completion form on file", "auto"),
    ("change_orders", "Job", "Change orders settled (none pending)", "auto"),
    ("final_invoice", "Money in", "Final invoice sent (nothing left to bill)", "auto"),
    ("paid", "Money in", "Paid in full (retainage aside)", "auto"),
    ("retainage", "Money in", "Retainage collected", "auto"),
    ("crew_paid", "Money out", "Crew paid in full", "auto"),
    ("expenses", "Money out", "Bills on the job paid", "auto"),
    ("signoff", "Review", "100% progress check signed off", "auto"),
    ("margin", "Review", "Closed out: final margin reviewed", "manual"),
]
STEP_KEYS = {s[0] for s in STEPS}
MARKS = {"done", "not_needed"}


def _q(sql, *expanding):
    t = text(sql)
    return t.bindparams(*[bindparam(e, expanding=True) for e in expanding]) if expanding else t


def _f(v):
    return float(v or 0)


def _projects(conn, ids=None):
    """Finished (or ids-given) projects with dates, status and PMs."""
    today = date.today()
    where = "qc.qbo_id IN :ids" if ids else "1=1"
    sql = f"""
        SELECT qc.qbo_id AS e, qc.id AS cid, qc.display_name AS name, qc.parent_qbo_id,
               MIN(psi.start_date) AS start, MAX(psi.end_date) AS end,
               (SELECT psi2.status FROM project_schedule_items psi2 WHERE psi2.project_id = p.id
                ORDER BY psi2.start_date IS NULL, psi2.start_date DESC, psi2.sort_order DESC, psi2.id DESC LIMIT 1) AS status
        FROM qbo_customers qc
        JOIN projects p ON p.qbo_customer_id = qc.id
        JOIN project_schedule_items psi ON psi.project_id = p.id
        WHERE qc.is_project = 1 AND {where}
        GROUP BY qc.qbo_id, qc.id, qc.display_name, qc.parent_qbo_id, p.id
    """
    rows = conn.execute(_q(sql, "ids") if ids else text(sql), {"ids": list(ids)} if ids else {}).mappings().all()
    out = {}
    for r in rows:
        st = r["status"]
        if ids is None:
            if st == "canceled":
                continue
            finished = st == "completed" or (r["end"] and r["end"] < today)
            if not finished or (r["end"] and r["end"] < today - timedelta(days=MONEY_DAYS)):
                continue
        out[str(r["e"])] = dict(r)
    return out


def _gather(conn, ids=None):
    P = _projects(conn, ids)
    E = sorted(P)
    d = {"p": P, "est": {}, "pend_est": defaultdict(int), "inv": defaultdict(lambda: [0.0, 0.0]), "ret": defaultdict(float),
         "crew_sched": defaultdict(float), "crew_paid": defaultdict(float), "crew_left": defaultdict(float),
         "exp_open": defaultdict(lambda: [0, 0.0]), "cos": defaultdict(int), "signoff": {}, "forms": {},
         "pms": defaultdict(list), "marks": defaultdict(dict), "cost": {}, "dealer": {}}
    if not E:
        return d
    p = {"ids": E}

    # Contract: latest version of each accepted estimate.
    for r in conn.execute(_q("""
        WITH latest AS (
          SELECT t.customer_qbo_id AS e, t.total_amt, JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) AS st,
                 ROW_NUMBER() OVER (PARTITION BY t.customer_qbo_id, COALESCE(t.doc_number, t.qbo_id) ORDER BY t.id DESC) AS rn
          FROM qbo_transactions t WHERE t.entity_type = 'Estimate' AND t.customer_qbo_id IN :ids)
        SELECT e, st, SUM(total_amt) AS v, COUNT(*) AS n FROM latest WHERE rn = 1 GROUP BY e, st""", "ids"), p).all():
        if r[1] in ("Accepted", "Converted", "Closed"):
            d["est"][str(r[0])] = d["est"].get(str(r[0]), 0.0) + _f(r[2])
        elif r[1] == "Pending":
            d["pend_est"][str(r[0])] += int(r[3])

    # Invoiced and open balance: latest version of each invoice.
    for r in conn.execute(_q("""
        WITH latest AS (
          SELECT t.customer_qbo_id AS e, t.total_amt, t.balance_amt, t.raw_json,
                 ROW_NUMBER() OVER (PARTITION BY t.customer_qbo_id, COALESCE(t.doc_number, t.qbo_id) ORDER BY t.id DESC) AS rn
          FROM qbo_transactions t WHERE t.entity_type = 'Invoice' AND t.customer_qbo_id IN :ids)
        SELECT e, total_amt, balance_amt, raw_json FROM latest WHERE rn = 1""", "ids"), p).all():
        e = str(r[0])
        d["inv"][e][0] += _f(r[1])
        if RET.is_retainage(r[1], r[2], r[3]):
            d["ret"][e] += _f(r[2])
        else:
            d["inv"][e][1] += _f(r[2])

    # Crew pay: the Contractor Payments page's own numbers (saved build: schedules
    # vs QuickBooks bills, with its matching rules), so both pages agree.
    snap = None
    try:
        from app import snapshots
        got = snapshots.get("crewpay")
        snap = got[0] if got else None
    except Exception:
        snap = None
    if snap:
        want = set(E)
        for r in snap.get("rows", []):
            e = str(r.get("entity_id"))
            if e in want:
                d["crew_sched"][e] += _f(r.get("schedule"))
                d["crew_paid"][e] += _f(r.get("paid"))
                d["crew_left"][e] += max(0.0, _f(r.get("remaining")))
    else:
        for r in conn.execute(_q("""
            SELECT s.entity_id, SUM(i.amount) FROM project_payment_schedules s
            JOIN project_payment_installments i ON i.schedule_id = s.id
            WHERE s.entity_id IN :ids GROUP BY s.entity_id""", "ids"), p).all():
            d["crew_sched"][str(r[0])] = _f(r[1])
        for r in conn.execute(_q("""
            SELECT l.line_customer_qbo_id, SUM(l.amount)
            FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
            WHERE t.entity_type IN ('Bill', 'Purchase') AND l.line_customer_qbo_id IN :ids
              AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')),
                           SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')), ':', 1))
                  LIKE 'Contract Labor%%'
            GROUP BY l.line_customer_qbo_id""", "ids"), p).all():
            d["crew_paid"][str(r[0])] = _f(r[1])
        for e in E:
            d["crew_left"][e] = max(0.0, d["crew_sched"][e] - d["crew_paid"][e])

    # Unpaid bills charged to the job (latest version of each bill).
    for r in conn.execute(_q("""
        WITH latest AS (
          SELECT t.id, t.qbo_id, t.balance_amt,
                 ROW_NUMBER() OVER (PARTITION BY t.qbo_id ORDER BY t.id DESC) AS rn
          FROM qbo_transactions t WHERE t.entity_type = 'Bill'
            AND t.id IN (SELECT l.transaction_id FROM qbo_transaction_lines l WHERE l.line_customer_qbo_id IN :ids))
        SELECT l.line_customer_qbo_id, COUNT(DISTINCT latest.qbo_id), SUM(l.amount)
        FROM latest JOIN qbo_transaction_lines l ON l.transaction_id = latest.id
        WHERE latest.rn = 1 AND latest.balance_amt > 0.01 AND l.line_customer_qbo_id IN :ids
        GROUP BY l.line_customer_qbo_id""", "ids"), p).all():
        d["exp_open"][str(r[0])] = [int(r[1]), _f(r[2])]

    # App change orders not settled.
    for r in conn.execute(_q("""SELECT project_qbo_id, COUNT(*) FROM project_change_orders
                                WHERE project_qbo_id IN :ids AND kind = 'change_order' AND status IN ('draft', 'sent')
                                GROUP BY project_qbo_id""", "ids"), p).all():
        d["cos"][str(r[0])] = int(r[1])

    for r in conn.execute(_q("""SELECT entity_id, decision, signed_by, signed_at FROM progress_signoffs
                                WHERE entity_id IN :ids AND milestone = 100""", "ids"), p).mappings():
        d["signoff"][str(r["entity_id"])] = dict(r)
    # Progress Checks only asks for a sign-off on big jobs (or ones switched on): same rule here.
    from app.progress import service as PROG
    d["signoff_min"] = float(PROG.rules(conn)["signoff_min"])
    d["signoff_switch"] = {str(r[0]): r[1] for r in conn.execute(_q(
        "SELECT entity_id, signoff FROM progress_settings WHERE entity_id IN :ids", "ids"), p).all()}

    # Completion form: a non-draft file in the completion folder, or a crew-portal submission.
    for r in conn.execute(_q("""SELECT entity_id, MAX(created_at) FROM documents
                                WHERE entity_type = 'project' AND entity_id IN :ids AND drive_removed_at IS NULL
                                  AND (folder LIKE '%%project_completion%%' OR LOWER(original_filename) LIKE '%%completion%%')
                                  AND LOWER(original_filename) NOT LIKE '%%.docx'
                                GROUP BY entity_id""", "ids"), p).all():
        d["forms"][str(r[0])] = {"source": "Drive", "at": r[1]}
    for r in conn.execute(_q("""SELECT project_qbo_id, MAX(submitted_at) FROM form_submissions
                                WHERE form_code = 'completion' AND project_qbo_id IN :ids GROUP BY project_qbo_id""", "ids"), p).all():
        d["forms"][str(r[0])] = {"source": "Crew portal", "at": r[1]}

    # Costs so far (bills + card charges on the job), for the margin step.
    for r in conn.execute(_q("""SELECT project_qbo_id, expense_line_amt, actual_profit, actual_profit_pct, projected_profit_pct
                                FROM project_financial_summary WHERE project_qbo_id IN :ids""", "ids"), p).mappings():
        d["cost"][str(r["project_qbo_id"])] = dict(r)

    cids = [P[e]["cid"] for e in E]
    for r in conn.execute(_q("""
        SELECT DISTINCT p.qbo_customer_id, TRIM(CONCAT(COALESCE(pm.first_name,''), ' ', COALESCE(pm.last_name,'')))
        FROM projects p JOIN project_schedule_items s ON s.project_id = p.id
        JOIN project_schedule_item_project_managers spm ON spm.schedule_item_id = s.id AND spm.unassigned_at IS NULL
        JOIN project_managers pm ON pm.id = spm.project_manager_id
        WHERE p.qbo_customer_id IN :c""", "c"), {"c": cids}).all():
        e = next((k for k in E if P[k]["cid"] == r[0]), None)
        if e and r[1] not in d["pms"][e]:
            d["pms"][e].append(r[1])

    parents = sorted({str(P[e]["parent_qbo_id"]) for e in E if P[e]["parent_qbo_id"]})
    if parents:
        names = dict(conn.execute(_q("SELECT qbo_id, display_name FROM qbo_customers WHERE qbo_id IN :p", "p"), {"p": parents}).all())
        for e in E:
            d["dealer"][e] = names.get(str(P[e]["parent_qbo_id"]))

    for r in conn.execute(_q("""SELECT entity_id, step_key, status, note, by_email, at FROM project_closeout_steps
                                WHERE entity_id IN :ids""", "ids"), p).mappings():
        d["marks"][str(r["entity_id"])][r["step_key"]] = dict(r)
    return d


def _steps(e, d):
    P = d["p"][e]
    contract = d["est"].get(e, 0.0)
    invoiced, open_ar = d["inv"][e]
    ret = d["ret"][e]
    unbilled = round(contract - invoiced, 2)
    sched, paid, owed = d["crew_sched"][e], d["crew_paid"][e], d["crew_left"][e]
    tol_bill = max(50.0, contract * 0.005)   # OPI rounds invoices; a few dollars off is not a final invoice
    n_exp, exp_amt = d["exp_open"][e]
    co_n = d["cos"][e] + d["pend_est"][e]
    so = d["signoff"].get(e)
    form = d["forms"].get(e)

    auto = {
        "marked_complete": (P["status"] == "completed",
                            "Status is Completed" if P["status"] == "completed" else f"Status is {(P['status'] or 'not set').replace('_', ' ')}"),
        "completion_form": (bool(form), f"From {form['source']}" if form else "No completion form in the Drive folder or the crew portal"),
        "change_orders": (co_n == 0, "None pending" if co_n == 0 else f"{co_n} change order{'s' if co_n != 1 else ''} or estimate{'s' if co_n != 1 else ''} still pending"),
        "final_invoice": (contract > 0 and unbilled <= tol_bill,
                          "No contract (accepted estimate) in QuickBooks" if contract <= 0 else
                          (f"Invoiced ${invoiced:,.0f} of ${contract:,.0f}" if unbilled <= tol_bill else f"${unbilled:,.0f} still to bill (invoiced ${invoiced:,.0f} of ${contract:,.0f})")),
        "paid": (invoiced > 0 and open_ar <= TOL, "Nothing invoiced yet" if invoiced <= 0 else ("All invoices paid" if open_ar <= TOL else f"${open_ar:,.0f} still owed by the customer")),
        "retainage": (ret <= TOL, "No retainage held" if ret <= TOL else f"${ret:,.0f} retainage held"),
        "crew_paid": (sched > 0 and owed <= TOL,
                      (f"No crew-pay schedule on this job (QuickBooks shows ${paid:,.0f} paid)" if paid > 0 else "No crew-pay schedule on this job") if sched <= 0 else
                      (f"Paid ${paid:,.0f} of ${sched:,.0f} scheduled" if owed <= TOL else f"${owed:,.0f} still owed (paid ${paid:,.0f} of ${sched:,.0f}, as on Contractor Payments)")),
        "expenses": (n_exp == 0, "No unpaid bills on this job in QuickBooks" if n_exp == 0 else f"{n_exp} unpaid bill{'s' if n_exp != 1 else ''} on this job (${exp_amt:,.0f} of job lines)"),
        "signoff": (bool(so and so["decision"] == "approved"),
                    f"Approved by {so['signed_by']}" if so and so["decision"] == "approved" else ("On hold" if so else "Not signed off on Progress Checks")),
        "margin": (False, ""),
    }
    sw = d.get("signoff_switch", {}).get(e)
    required = bool(sw) if sw is not None else contract >= d.get("signoff_min", 0)
    if not required and not so:
        auto["signoff"] = (True, f"Not required (jobs under ${d.get('signoff_min', 0):,.0f} skip sign-off)")
    out = []
    for key, group, label, how in STEPS:
        ok, why = auto[key]
        mark = d["marks"][e].get(key)
        state = "done" if ok else "todo"
        if not ok and mark:
            state = mark["status"]
        if key == "margin":
            c = d["cost"].get(e) or {}
            pct = c.get("actual_profit_pct")
            why = (f"Margin so far {float(pct) * 100:.1f}% (profit ${float(c.get('actual_profit') or 0):,.0f}); compare it with the quote on Financials"
                   if pct is not None else "No cost summary yet (Financials refresh)")
        out.append({"key": key, "group": group, "label": label, "how": how, "state": state, "why": why,
                    "mark": {k: (str(v) if k == "at" else v) for k, v in mark.items()} if mark else None})
    money = {"contract": round(contract, 2), "invoiced": round(invoiced, 2), "unbilled": max(0, unbilled) if unbilled > tol_bill else 0,
             "open_ar": round(open_ar, 2), "retainage": round(ret, 2), "crew_scheduled": round(sched, 2),
             "crew_paid": round(paid, 2), "crew_owed": round(owed, 2), "bills_open": round(exp_amt, 2)}
    return out, money


def _row(e, d, today):
    P = d["p"][e]
    steps, money = _steps(e, d)
    done = sum(1 for s in steps if s["state"] in ("done", "not_needed"))
    end = P["end"]
    flags = []
    if money["unbilled"] > TOL:
        flags.append({"text": f"${money['unbilled']:,.0f} to bill", "tone": "bad"})
    if money["open_ar"] > TOL:
        flags.append({"text": f"${money['open_ar']:,.0f} owed to us", "tone": "warn"})
    if money["crew_owed"] > TOL:
        flags.append({"text": f"Crew owed ${money['crew_owed']:,.0f}", "tone": "warn"})
    if not d["forms"].get(e):
        flags.append({"text": "No completion form", "tone": "info"})
    c = d["cost"].get(e) or {}
    return {
        "entity_id": e, "name": P["name"], "dealer": d["dealer"].get(e), "pms": d["pms"][e],
        "start": str(P["start"]) if P["start"] else None, "end": str(end) if end else None,
        "days_since_end": (today - end).days if end else None,
        "status": P["status"], "steps": steps, "done": done, "total": len(steps), "money": money, "flags": flags,
        "margin_pct": round(float(c["actual_profit_pct"]) * 100, 1) if c.get("actual_profit_pct") is not None else None,
        "profit": float(c["actual_profit"]) if c.get("actual_profit") is not None else None,
    }


def _visible(r, today):
    if r["done"] >= r["total"]:
        return False
    m = r["money"]
    money_open = m["unbilled"] > TOL or m["open_ar"] > TOL or m["crew_owed"] > TOL or m["retainage"] > TOL
    old = r["days_since_end"] is not None and r["days_since_end"] > OLD_DAYS
    return money_open or not old


@router.get("/queue")
def queue(user=Depends(require_capability(CAP))):
    today = date.today()
    with engine.connect() as conn:
        d = _gather(conn)
    rows = [_row(e, d, today) for e in d["p"]]
    jobs = [r for r in rows if _visible(r, today)]
    jobs.sort(key=lambda r: (r["end"] or "9999"))
    closed_recent = sum(1 for r in rows if r["done"] >= r["total"] and (r["days_since_end"] or 0) <= 60)
    return {"jobs": jobs, "closed_recent": closed_recent, "old_days": OLD_DAYS}


@router.get("/job/{entity_id}")
def job(entity_id: str, user=Depends(require_capability(CAP))):
    with engine.connect() as conn:
        d = _gather(conn, [entity_id])
    if entity_id not in d["p"]:
        raise HTTPException(404, "Not a project with a schedule")
    return _row(entity_id, d, date.today())


class StepMark(BaseModel):
    status: Optional[str] = None
    note: Optional[str] = None


@router.post("/job/{entity_id}/step/{step}")
def mark_step(entity_id: str, step: str, req: StepMark, user=Depends(require_capability(CAP))):
    if step not in STEP_KEYS:
        raise HTTPException(400, "Unknown step")
    if req.status is not None and req.status not in MARKS:
        raise HTTPException(400, "status must be done or not_needed")
    with engine.begin() as conn:
        if req.status is None:
            conn.execute(text("DELETE FROM project_closeout_steps WHERE entity_id = :e AND step_key = :k"), {"e": entity_id, "k": step})
        else:
            conn.execute(text("""
                INSERT INTO project_closeout_steps (entity_id, step_key, status, note, by_user_id, by_email)
                VALUES (:e, :k, :s, :n, :u, :m)
                ON DUPLICATE KEY UPDATE status = VALUES(status), note = VALUES(note), by_user_id = VALUES(by_user_id),
                                        by_email = VALUES(by_email), at = CURRENT_TIMESTAMP"""),
                         {"e": entity_id, "k": step, "s": req.status, "n": req.note or None, "u": user.get("id"), "m": user.get("email")})
        d = _gather(conn, [entity_id])
    if entity_id not in d["p"]:
        raise HTTPException(404, "Not a project with a schedule")
    row = _row(entity_id, d, date.today())
    record_audit(user, "closeout.step", "project", entity_id, row["name"], {"step": step, "status": req.status, "note": req.note})
    return row


# ── Step detail: what's behind each step, for the expandable step cards ─────────
def _j(v):
    if isinstance(v, (dict, list)) or v is None:
        return v
    try:
        return json.loads(v)
    except Exception:
        return None


def _d(v):
    return str(v)[:10] if v else None


def _soft(fn):
    try:
        return fn()
    except Exception as ex:   # one section failing must not hide the others
        return {"error": f"{type(ex).__name__}: {ex}"[:300]}


def _det_job(conn, e, P, d):
    items = [{"id": r["id"], "start": _d(r["start_date"]), "end": _d(r["end_date"]), "status": r["status"],
              "overage_days": int(r["overage_days"] or 0)}
             for r in conn.execute(text("""
                SELECT psi.id, psi.start_date, psi.end_date, psi.status, psi.overage_days
                FROM projects p JOIN project_schedule_items psi ON psi.project_id = p.id
                WHERE p.qbo_customer_id = :c ORDER BY psi.start_date IS NULL, psi.start_date, psi.id"""),
                {"c": P["cid"]}).mappings()]
    return {"status": P["status"], "items": items, "pms": d["pms"][e]}


def _det_form(conn, e):
    subs = []
    for r in conn.execute(text("""SELECT id, submitted_at, crew_context, answers, status FROM form_submissions
                                   WHERE form_code = 'completion' AND project_qbo_id = :e ORDER BY submitted_at DESC"""),
                          {"e": e}).mappings():
        ctx, ans = _j(r["crew_context"]) or {}, _j(r["answers"]) or {}
        sig = ans.get("customer_signoff")
        signer = (sig.get("name") or sig.get("signer") or sig.get("signed_by")) if isinstance(sig, dict) else None
        by = ctx.get("crew_name") or ctx.get("label") or ctx.get("user") or ctx.get("email")
        if ctx.get("on_behalf") and ctx.get("user"):
            by = f"{ctx['user']} (for the crew)"
        subs.append({"id": r["id"], "submitted_at": str(r["submitted_at"]) if r["submitted_at"] else None,
                     "by": by, "signer": signer, "status": r["status"]})
    docs = [{"id": r["id"], "filename": r["original_filename"], "folder": r["folder"],
             "date": _d(r["drive_modified"] or r["created_at"]),
             "draft": str(r["original_filename"] or "").lower().endswith(".docx")}
            for r in conn.execute(text("""
                SELECT id, original_filename, folder, drive_modified, created_at FROM documents
                WHERE entity_type = 'project' AND entity_id = :e AND drive_removed_at IS NULL
                  AND (folder LIKE '%project_completion%' OR LOWER(original_filename) LIKE '%completion%'
                       OR LOWER(original_filename) LIKE '%sign%off%')
                ORDER BY COALESCE(drive_modified, created_at) DESC LIMIT 30"""), {"e": e}).mappings()]
    return {"submissions": subs, "documents": docs}


def _det_cos(conn, e):
    ests = []
    for r in conn.execute(text("""
        WITH latest AS (
          SELECT t.qbo_id, t.doc_number, t.txn_date, t.total_amt, t.raw_json,
                 ROW_NUMBER() OVER (PARTITION BY COALESCE(t.doc_number, t.qbo_id) ORDER BY t.id DESC) AS rn
          FROM qbo_transactions t WHERE t.entity_type = 'Estimate' AND t.customer_qbo_id = :e)
        SELECT qbo_id, doc_number, txn_date, total_amt, raw_json FROM latest WHERE rn = 1 ORDER BY txn_date, qbo_id"""),
            {"e": e}).mappings():
        raw = _j(r["raw_json"]) or {}
        linked = [x for x in (raw.get("LinkedTxn") or []) if x.get("TxnType") == "Invoice"]
        ests.append({"source": "QuickBooks", "qbo_id": str(r["qbo_id"]), "number": r["doc_number"], "date": _d(r["txn_date"]),
                     "amount": round(_f(r["total_amt"]), 2), "status": raw.get("TxnStatus"), "invoiced": bool(linked),
                     "original": False})
    if ests:
        ests[0]["original"] = True   # the first estimate is the contract; later ones are change orders / added scope
    app = [{"source": "App", "id": r["id"], "number": r["co_number"], "title": r["title"], "date": _d(r["created_at"]),
            "amount": round(_f(r["amount"]), 2), "status": r["status"], "qbo_estimate_id": r["qbo_estimate_id"]}
           for r in conn.execute(text("""SELECT id, co_number, title, created_at, amount, status, qbo_estimate_id
                                          FROM project_change_orders WHERE project_qbo_id = :e AND kind = 'change_order'
                                          ORDER BY created_at"""), {"e": e}).mappings()]
    return {"estimates": ests, "app_change_orders": app,
            "pending": sum(1 for x in ests if x["status"] == "Pending") + sum(1 for x in app if x["status"] in ("draft", "sent"))}


def _det_money_in(conn, e, money):
    invs = []
    for r in conn.execute(text("""
        WITH latest AS (
          SELECT t.qbo_id, t.doc_number, t.txn_date, t.total_amt, t.balance_amt, t.raw_json,
                 ROW_NUMBER() OVER (PARTITION BY COALESCE(t.doc_number, t.qbo_id) ORDER BY t.id DESC) AS rn
          FROM qbo_transactions t WHERE t.entity_type = 'Invoice' AND t.customer_qbo_id = :e)
        SELECT qbo_id, doc_number, txn_date, total_amt, balance_amt, raw_json FROM latest WHERE rn = 1
        ORDER BY txn_date, qbo_id"""), {"e": e}).mappings():
        raw = _j(r["raw_json"]) or {}
        invs.append({"qbo_id": str(r["qbo_id"]), "doc_number": r["doc_number"], "date": _d(r["txn_date"]),
                     "due_date": raw.get("DueDate"), "total": round(_f(r["total_amt"]), 2), "balance": round(_f(r["balance_amt"]), 2),
                     "retainage": RET.is_retainage(r["total_amt"], r["balance_amt"], r["raw_json"])})
    sched = [{"id": r["id"], "label": r["label"], "pct": _f(r["pct"]) if r["pct"] is not None else None,
              "invoice_date": _d(r["invoice_date"]), "due_date": _d(r["due_date"]), "amount": round(_f(r["amount"]), 2),
              "estimate": r["estimate_doc_number"]}
             for r in conn.execute(text("""
                SELECT m.id, m.label, m.pct, m.invoice_date, m.due_date, m.amount, s.estimate_doc_number
                FROM project_invoice_milestones m JOIN project_invoice_schedules s ON s.id = m.schedule_id
                WHERE s.entity_id = :e AND m.qbo_invoice_id IS NULL AND m.status = 'pending' AND m.amount <> 0
                ORDER BY m.invoice_date IS NULL, m.invoice_date, m.seq"""), {"e": e}).mappings()]
    return {"contract": money["contract"], "invoiced": money["invoiced"], "unbilled": money["unbilled"],
            "open_ar": money["open_ar"], "retainage": money["retainage"], "invoices": invs, "schedule_to_bill": sched}


def _det_crew(conn, e, money):
    from app import snapshots
    from app.crewpay import service as CP
    got = snapshots.get("crewpay")
    crews = []
    for r in (got[0].get("rows", []) if got else []):
        if str(r.get("entity_id")) == e:
            crews.append({"crew": r.get("crew"), "scheduled": round(_f(r.get("schedule")), 2), "paid": round(_f(r.get("paid")), 2),
                          "owed": round(max(0.0, _f(r.get("remaining"))), 2), "last_paid": r.get("last_paid"),
                          "next_date": r.get("next_date"), "next_amount": round(_f(r.get("next_amount")), 2)})
    _, by_vendor = CP._crews(conn)
    pays = [{"date": _d(l["d"]), "type": "Card/check" if l["type"] == "Purchase" else "Bill", "doc": l["doc"],
             "crew": (by_vendor.get(str(l["vendor"] or "")) or {}).get("name") or l["vendor_name"],
             "description": l["descr"], "amount": round(_f(l["a"]), 2)}
            for l in sorted(CP._paid_lines(conn, e), key=lambda x: str(x["d"]))]
    return {"scheduled": money["crew_scheduled"], "paid": money["crew_paid"], "owed": money["crew_owed"],
            "snapshot_age_seconds": got[2] if got else None, "crews": crews, "payments": pays}


def _det_bills(conn, e):
    rows = conn.execute(text("""
        WITH latest AS (
          SELECT t.id, t.qbo_id, t.doc_number, t.txn_date, t.total_amt, t.balance_amt, t.raw_json,
                 ROW_NUMBER() OVER (PARTITION BY t.qbo_id ORDER BY t.id DESC) AS rn
          FROM qbo_transactions t WHERE t.entity_type = 'Bill'
            AND t.id IN (SELECT l.transaction_id FROM qbo_transaction_lines l WHERE l.line_customer_qbo_id = :e))
        SELECT latest.qbo_id, latest.doc_number, latest.txn_date, latest.total_amt, latest.balance_amt,
               JSON_UNQUOTE(JSON_EXTRACT(latest.raw_json, '$.VendorRef.name')) AS vendor,
               JSON_UNQUOTE(JSON_EXTRACT(latest.raw_json, '$.DueDate')) AS due,
               SUM(l.amount) AS job_amount
        FROM latest JOIN qbo_transaction_lines l ON l.transaction_id = latest.id AND l.line_customer_qbo_id = :e
        WHERE latest.rn = 1 AND latest.balance_amt > 0.01
        GROUP BY latest.qbo_id, latest.doc_number, latest.txn_date, latest.total_amt, latest.balance_amt, vendor, due
        ORDER BY due IS NULL, due, latest.txn_date"""), {"e": e}).mappings().all()
    today = str(date.today())
    bills = [{"qbo_id": str(r["qbo_id"]), "vendor": r["vendor"], "doc_number": r["doc_number"], "date": _d(r["txn_date"]),
              "due_date": r["due"], "total": round(_f(r["total_amt"]), 2), "balance": round(_f(r["balance_amt"]), 2),
              "job_amount": round(_f(r["job_amount"]), 2), "past_due": bool(r["due"] and r["due"] < today)} for r in rows]
    return {"bills": bills, "job_amount": round(sum(b["job_amount"] for b in bills), 2)}


def _det_signoff(conn, e, d, money):
    from app import snapshots
    sw = d.get("signoff_switch", {}).get(e)
    smin = d.get("signoff_min", 0)
    required = bool(sw) if sw is not None else money["contract"] >= smin
    signs = [{"milestone": r["milestone"], "decision": r["decision"], "note": r["note"], "by": r["signed_by"],
              "at": str(r["signed_at"]) if r["signed_at"] else None}
             for r in conn.execute(text("""SELECT milestone, decision, note, signed_by, signed_at FROM progress_signoffs
                                           WHERE entity_id = :e ORDER BY milestone"""), {"e": e}).mappings()]
    rule = ("switched on for this job" if sw else "switched off for this job") if sw is not None else f"jobs of ${smin:,.0f} or more"
    out = {"required": required, "rule": rule, "signoff_min": smin, "signoffs": signs, "progress": None}
    got = snapshots.get("progress")
    j = next((x for x in (got[0].get("jobs", []) if got else []) if str(x.get("id")) == e), None)
    if j:
        last = max((p for p in j.get("points", []) if p.get("reached")), key=lambda p: p["milestone"], default=None)
        out["progress"] = {"status": j.get("status"), "pct_time": j.get("pct_time"), "pct_invoiced": j.get("pct_invoiced"),
                           "pct_labor": j.get("pct_labor"), "pct_cost": j.get("pct_cost"),
                           "last_checkpoint": last["milestone"] if last else None,
                           "last_checkpoint_date": last["date"] if last else None}
    return out


def _det_margin(conn, e, d, money):
    from app import snapshots
    c = d["cost"].get(e) or {}
    out = {"contract": money["contract"], "revenue": round(money["invoiced"] or money["contract"], 2),
           "cost": round(_f(c.get("expense_line_amt")), 2) if c else None,
           "profit": round(_f(c["actual_profit"]), 2) if c.get("actual_profit") is not None else None,
           "margin_pct": round(_f(c["actual_profit_pct"]) * 100, 1) if c.get("actual_profit_pct") is not None else None,
           "planned_margin_pct": round(_f(c["projected_profit_pct"]) * 100, 1) if c.get("projected_profit_pct") is not None else None,
           "categories": []}
    got = snapshots.get("jobcost")
    j = next((x for x in (got[0].get("jobs", []) if got else []) if str(x.get("id")) == e), None)
    if j:
        est, pend, act = j.get("est") or {}, j.get("pend") or {}, j.get("act") or {}
        for cat in sorted(set(est) | set(pend) | set(act), key=lambda k: -max(_f(est.get(k)) + _f(pend.get(k)), _f(act.get(k)))):
            budget = _f(est.get(cat)) + _f(pend.get(cat))
            actual = _f(act.get(cat))
            out["categories"].append({"category": cat, "estimate": round(budget, 2), "actual": round(actual, 2),
                                      "over": round(actual - budget, 2)})
        est_cost = sum(_f(v) for v in est.values())
        if est_cost <= 0:
            out["planned_margin_pct"] = None   # no costed estimate: a "100%" plan means nothing
        elif out["planned_margin_pct"] is None and money["contract"]:
            out["planned_margin_pct"] = round((money["contract"] - est_cost) / money["contract"] * 100, 1)
    return out


@router.get("/job/{entity_id}/detail")
def job_detail(entity_id: str, user=Depends(require_capability(CAP))):
    e = entity_id
    with engine.connect() as conn:
        d = _gather(conn, [e])
        if e not in d["p"]:
            raise HTTPException(404, "Not a project with a schedule")
        P = d["p"][e]
        _, money = _steps(e, d)
        money_in = _soft(lambda: _det_money_in(conn, e, money))
        return {
            "entity_id": e, "money": money,
            "marked_complete": _soft(lambda: _det_job(conn, e, P, d)),
            "completion_form": _soft(lambda: _det_form(conn, e)),
            "change_orders": _soft(lambda: _det_cos(conn, e)),
            "final_invoice": money_in, "paid": money_in, "retainage": money_in,
            "crew_paid": _soft(lambda: _det_crew(conn, e, money)),
            "expenses": _soft(lambda: _det_bills(conn, e)),
            "signoff": _soft(lambda: _det_signoff(conn, e, d, money)),
            "margin": _soft(lambda: _det_margin(conn, e, d, money)),
        }
