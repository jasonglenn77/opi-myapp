"""
Project Closeout: every finished job until it's closed — the final invoice,
getting paid, paying the crew in full, expenses, change orders and the paperwork.
Same shape as Project Setup (setup/routes.py): a queue of jobs, each with steps;
steps the data can answer tick themselves, the rest are marked here.

  GET  /api/closeout/queue                       finished jobs still being closed out
  GET  /api/closeout/job/{entity_id}             one job: steps + the numbers behind them
  GET  /api/closeout/job/{entity_id}/detail      what's behind each step (for the step cards)
  POST /api/closeout/job/{entity_id}/step/{step} {status: done|not_needed|reviewed|null, note, close_all}
  POST /api/closeout/bulk-close                  {entity_ids: [...], note}: close out many jobs at once

Which jobs (owner decision 2026-11-12): every project whose status is Completed,
or whose last scheduled day has passed (not Canceled), at any age, until it is
CLOSED OUT: the Review step "Closed out: final margin reviewed" is marked done.
Every job needs the Review (the 100% sign-off and the margin), whatever its size.
Closing out with steps still open marks them "reviewed" (seen and accepted as
they are) with the closer's note. Each job carries a bucket for the views:
  recent      ended on or after CUTOVER (Oct 1 2026: some jobs take ~30 days to close)
  open        ended earlier, with real open items (money or a pending change order)
  paperwork   ended earlier, only paperwork gaps (no crew-pay schedule, no form...)
"""
import json
from collections import defaultdict
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import bindparam, text

from app.audit import record_audit
from app.auth import require_capability
from app.permissions import FINANCIAL_SIGNOFF, has_capability
from app.billing import retainage as RET
from app.db import engine
from app import snapshots

router = APIRouter(prefix="/api/closeout", tags=["closeout"])
CAP = "page.assignment"
from app.projects import books as BK
CUTOVER = BK.CUTOVER          # jobs ending from here on are the current closeout work (books open until closed out)
TOL = 1.0               # dollars

# (key, group, label, auto|manual)
STEPS = [
    ("marked_complete", "Job", "Job finished (past its last day)", "auto"),
    ("completion_form", "Job", "Completion form on file", "auto"),
    ("change_orders", "Job", "Change orders settled (none pending)", "auto"),
    ("final_invoice", "Money in", "Final invoice sent (nothing left to bill)", "auto"),
    ("paid", "Money in", "Paid in full (retainage aside)", "auto"),
    ("retainage", "Money in", "Retainage collected", "auto"),
    ("crew_paid", "Money out", "Contract labor: estimate vs paid", "auto"),
    ("expenses", "Money out", "Expenses: estimate vs spent", "auto"),
    ("signoff", "Review", "100% sign-off", "auto"),
    ("margin", "Review", "Closed out: final margin reviewed", "manual"),
]
STEP_KEYS = {s[0] for s in STEPS}
MARKS = {"done", "not_needed", "reviewed", "noted"}   # noted = reviewed, not ready yet (stays open)
MONEY_STEPS = ("final_invoice", "paid", "retainage", "crew_paid", "expenses", "change_orders")


def _q(sql, *expanding):
    t = text(sql)
    return t.bindparams(*[bindparam(e, expanding=True) for e in expanding]) if expanding else t


def _f(v):
    return float(v or 0)


def _projects(conn, ids=None, finished_only=None):
    """Finished (or ids-given) projects with dates, status and PMs.
    finished_only: apply the finished/not-canceled filter even with ids."""
    today = date.today()
    where = "qc.qbo_id IN :ids" if ids else "1=1"
    sql = f"""
        SELECT qc.qbo_id AS e, qc.id AS cid, qc.display_name AS name, qc.parent_qbo_id,
               MIN(psi.start_date) AS start,
               MAX(CASE WHEN psi.status <> 'canceled' THEN DATE_ADD(psi.end_date, INTERVAL COALESCE(psi.overage_days, 0) DAY) END) AS end,
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
        if ids is None or finished_only:
            if st == "canceled":
                continue
            finished = st == "completed" or (r["end"] and r["end"] < today)
            if not finished:
                continue
        out[str(r["e"])] = dict(r)
    return out


def _gather(conn, ids=None, finished_only=None):
    P = _projects(conn, ids, finished_only)
    E = sorted(P)
    d = {"p": P, "est": {}, "pend_est": defaultdict(int), "inv": defaultdict(lambda: [0.0, 0.0]), "ret": defaultdict(float),
         "crew_sched": defaultdict(float), "crew_paid": defaultdict(float), "crew_left": defaultdict(float),
         "exp_open": defaultdict(lambda: [0, 0.0]), "cos": defaultdict(int), "signoff": {}, "forms": {},
         "pms": defaultdict(list), "marks": defaultdict(dict), "cost": {}, "dealer": {}, "included": {}}
    if not E:
        return d
    p = {"ids": E}
    try:   # older jobs someone included in the cash forecast (projects/books.py)
        d["included"] = {str(r[0]): {"note": r[1], "by": r[2], "at": str(r[3])} for r in conn.execute(_q(
            "SELECT entity_id, note, by_email, at FROM project_books_open WHERE include = 1 AND entity_id IN :ids", "ids"), p).all()}
    except Exception:
        pass

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

    # 2026-11-18 (owner): a finished job is judged against its ESTIMATES. Budget per
    # cost category from the accepted estimates, burned down by the bills and card
    # charges on the job (any vendor). Same figures as Financials / job cost.
    from app.jobcost import service as JCS
    d["budget"] = JCS.budget_by_category(conn, E)
    d["actual"] = JCS.actual_by_category(conn, E)

    # The crew's deal (Payment Schedule) is shown for reference only: the Contractor
    # Payments numbers where it has the job, else the job's schedules (a Drive
    # schedule already covered by an app one isn't counted twice).
    snap = None
    try:
        from app import snapshots
        got = snapshots.get("crewpay")
        snap = got[0] if got else None
    except Exception:
        snap = None
    in_snap = set()
    if snap:
        want = set(E)
        for r in snap.get("rows", []):
            e = str(r.get("entity_id"))
            if e in want:
                in_snap.add(e)
                d["crew_sched"][e] += _f(r.get("schedule"))
                d["crew_paid"][e] += _f(r.get("paid"))
                d["crew_left"][e] += max(0.0, _f(r.get("remaining")))
    rest = [e for e in E if e not in in_snap]
    if rest:
        for r in conn.execute(_q("""
            SELECT s.entity_id, SUM(i.amount) FROM project_payment_schedules s
            JOIN project_payment_installments i ON i.schedule_id = s.id
            WHERE s.entity_id IN :ids AND COALESCE(s.source, 'app') <> 'sheet_covered'
            GROUP BY s.entity_id""", "ids"), {"ids": rest}).all():
            e = str(r[0])
            d["crew_sched"][e] = _f(r[1])
            d["crew_paid"][e] = d["actual"][e].get("Crew labor", 0.0)
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
    try:    # 2026-11-22: crew paid vs the app's crew vs the Job Schedule
        from app import crewcheck
        d["crewcheck"] = crewcheck.check(conn, E)
    except Exception:
        d["crewcheck"] = {}
    return d


def _steps(e, d):
    P = d["p"][e]
    contract = d["est"].get(e, 0.0)
    invoiced, open_ar = d["inv"][e]
    ret = d["ret"][e]
    unbilled = round(contract - invoiced, 2)
    sched, owed = d["crew_sched"][e], d["crew_left"][e]          # the crew's deal (reference)
    bud, act = d["budget"].get(e, {}), d["actual"].get(e, {})
    lab_bud, lab_paid = bud.get("Crew labor", 0.0), act.get("Crew labor", 0.0)
    lab_left = round(lab_bud - lab_paid, 2)
    exp_cats = sorted((set(bud) | set(act)) - {"Crew labor"})
    exp_bud = sum(bud.get(c, 0.0) for c in exp_cats)
    exp_spent = sum(act.get(c, 0.0) for c in exp_cats)
    exp_left = max(0.0, exp_bud - exp_spent)
    tol_lab = max(TOL, lab_bud * 0.005)
    tol_bill = max(50.0, contract * 0.005)   # OPI rounds invoices; a few dollars off is not a final invoice
    n_exp, exp_amt = d["exp_open"][e]
    co_n = d["cos"][e] + d["pend_est"][e]
    so = d["signoff"].get(e)
    form = d["forms"].get(e)

    auto = {
        "marked_complete": (P["status"] == "completed",
                            "Past its last day" if P["status"] == "completed" else f"Status is {(P['status'] or 'not set').replace('_', ' ')}: if the work is done, move the end date on the Assignment"),
        "completion_form": (bool(form), f"From {form['source']}" if form else "No completion form in the Drive folder or the crew portal"),
        "change_orders": (co_n == 0, "None pending" if co_n == 0 else f"{co_n} change order{'s' if co_n != 1 else ''} or estimate{'s' if co_n != 1 else ''} still pending"),
        "final_invoice": (contract > 0 and unbilled <= tol_bill,
                          "No contract (accepted estimate) in QuickBooks" if contract <= 0 else
                          (f"Invoiced ${invoiced:,.0f} of ${contract:,.0f}" if unbilled <= tol_bill else f"${unbilled:,.0f} still to bill (invoiced ${invoiced:,.0f} of ${contract:,.0f})")),
        "paid": (invoiced > 0 and open_ar <= TOL, "Nothing invoiced yet" if invoiced <= 0 else ("All invoices paid" if open_ar <= TOL else f"${open_ar:,.0f} still owed by the customer")),
        "retainage": (ret <= TOL, "No retainage held" if ret <= TOL else f"${ret:,.0f} retainage held"),
        "crew_paid": _labor_check(lab_bud, lab_paid, lab_left, tol_lab, sched, owed),
        "expenses": _expense_check(exp_bud, exp_spent, exp_left, n_exp, exp_amt),
        "signoff": (bool(so and so["decision"] == "approved"),
                    f"Approved by {so['signed_by']}" if so and so["decision"] == "approved" else
                    ("On hold on Progress Checks" if so else "Not signed off yet: sign off here or on Progress Checks (every job, any size)")),
        "margin": (False, ""),
    }
    out = []
    for key, group, label, how in STEPS:
        ok, why = auto[key]
        mark = d["marks"][e].get(key)
        state = "done" if ok else "todo"
        if not ok and mark:
            state = "todo" if mark["status"] == "noted" else mark["status"]
        if key == "margin":
            c = d["cost"].get(e) or {}
            pct = c.get("actual_profit_pct")
            why = (f"Margin so far {float(pct) * 100:.1f}% (profit ${float(c.get('actual_profit') or 0):,.0f}); compare it with the quote on Financials"
                   if pct is not None else "No cost summary yet (Financials refresh)")
        out.append({"key": key, "group": group, "label": label, "how": how, "state": state, "why": why,
                    "mark": {k: (str(v) if k == "at" else v) for k, v in mark.items()} if mark else None})
    money = {"contract": round(contract, 2), "invoiced": round(invoiced, 2), "unbilled": max(0, unbilled) if unbilled > tol_bill else 0,
             "open_ar": round(open_ar, 2), "retainage": round(ret, 2),
             "labor_budget": round(lab_bud, 2), "labor_paid": round(lab_paid, 2), "labor_left": lab_left,
             "exp_budget": round(exp_bud, 2), "exp_spent": round(exp_spent, 2), "exp_left": round(exp_left, 2),
             "crew_deal": round(sched, 2), "crew_deal_owed": round(owed, 2), "bills_open": round(exp_amt, 2)}
    return out, money


def _labor_check(bud, paid, left, tol, deal, deal_owed):
    """Contract labor on the estimates, burned down by Contract Labor bills."""
    if bud <= TOL and paid <= TOL:
        return True, "No contract labor on the estimates or in QuickBooks"
    if bud <= TOL:
        return False, f"${paid:,.0f} paid to crews, but the accepted estimates have no contract labor line"
    ref = ""
    if deal > TOL:
        ref = f" Crew's Payment Schedule: ${deal:,.0f}" + (f", ${deal_owed:,.0f} of it unpaid." if deal_owed > TOL else ", paid in full.")
    if left <= tol:
        over = f" (${-left:,.0f} over the estimate)" if left < -tol else ""
        return True, f"Paid ${paid:,.0f} of ${bud:,.0f} on the estimates{over}.{ref}"
    return False, (f"${left:,.0f} of the estimates' ${bud:,.0f} contract labor not paid (paid ${paid:,.0f}).{ref}"
                   " Review it: close it if the crew is paid in full.")


def _expense_check(bud, spent, left, n_unpaid, unpaid_amt):
    """Expense items on the estimates (rentals, lodging, travel...) vs what was spent."""
    unpaid = f" {n_unpaid} unpaid bill{'s' if n_unpaid != 1 else ''} (${unpaid_amt:,.0f})." if n_unpaid else ""
    if bud <= TOL and spent <= TOL:
        return (n_unpaid == 0), "No expense items on the estimates or in QuickBooks." + unpaid
    if bud <= TOL:
        return (n_unpaid == 0), f"Spent ${spent:,.0f}; the estimates had no expense items." + (unpaid or " Every bill paid.")
    if left <= TOL and n_unpaid == 0:
        return True, f"Spent ${spent:,.0f} of ${bud:,.0f} on the estimates; every bill paid."
    head = (f"${left:,.0f} of the estimates' ${bud:,.0f} expense items not spent (spent ${spent:,.0f})." if left > TOL
            else f"Spent ${spent:,.0f} of ${bud:,.0f}.")
    return False, head + unpaid + " Review it: close it once nothing more is coming."


def _row(e, d, today):
    P = d["p"][e]
    steps, money = _steps(e, d)
    done = sum(1 for s in steps if s["state"] in ("done", "not_needed", "reviewed"))
    end = P["end"]
    flags = []
    if money["unbilled"] > TOL:
        flags.append({"text": f"${money['unbilled']:,.0f} to bill", "tone": "bad"})
    if money["open_ar"] > TOL:
        flags.append({"text": f"${money['open_ar']:,.0f} owed to us", "tone": "warn"})
    if money["labor_left"] > TOL and any(s["key"] == "crew_paid" and s["state"] == "todo" for s in steps):
        flags.append({"text": f"Labor ${money['labor_left']:,.0f} under estimate", "tone": "info"})
    if not d["forms"].get(e):
        flags.append({"text": "No completion form", "tone": "info"})
    cc = (d.get("crewcheck") or {}).get(e) or {}
    if cc.get("diffs"):
        flags.append({"text": "Crew paid differs", "tone": "warn", "title": " · ".join(x["text"] for x in cc["diffs"])})
    c = d["cost"].get(e) or {}
    st_of = {s["key"]: s["state"] for s in steps}
    closed = st_of.get("margin") == "done"
    # The cash forecast (projects/books.py): open until closed out for jobs that
    # ended on/after CUTOVER; older ones only when someone included them.
    inc = d["included"].get(e)
    forecast = "closed" if closed else "open" if (end and end >= CUTOVER) else "included" if inc else "off"
    if end and end >= CUTOVER:
        bucket = "recent"
    elif (money["unbilled"] > TOL or money["open_ar"] > TOL or money["retainage"] > TOL or money["crew_deal_owed"] > TOL
          or money["bills_open"] > TOL or st_of.get("change_orders") == "todo") and any(st_of.get(k) == "todo" for k in MONEY_STEPS):
        bucket = "open"
    else:
        bucket = "paperwork"
    return {
        "entity_id": e, "name": P["name"], "dealer": d["dealer"].get(e), "pms": d["pms"][e],
        "closed": closed, "bucket": bucket, "forecast": forecast, "included": inc,
        "start": str(P["start"]) if P["start"] else None, "end": str(end) if end else None,
        "days_since_end": (today - end).days if end else None,
        "status": P["status"], "steps": steps, "done": done, "total": len(steps), "money": money, "flags": flags,
        "crew_diffs": [x["text"] for x in cc.get("diffs") or []],
        "margin_pct": round(float(c["actual_profit_pct"]) * 100, 1) if c.get("actual_profit_pct") is not None else None,
        "profit": float(c["actual_profit"]) if c.get("actual_profit") is not None else None,
    }


def _visible(r, today):
    """Every finished job until it's closed out (2026-11-12: no age cut-off)."""
    return not r["closed"]


# 2026-11-19 (owner: "Closeout takes a long time to load"): the list of every
# finished job (~600) took 15-20s to build on prod. It's kept as a page snapshot
# (app/snapshots.py): served at once, rebuilt in the background when QuickBooks
# or Drive data changed. Jobs changed in the app since the snapshot (closeout
# steps, forecast choice, dates, crew pay, expense or invoice schedules) are
# recomputed live, so an edit shows straight away.
SNAP_KEY = "closeout_queue"


def _build_all():
    with engine.connect() as conn:
        built = str(conn.execute(text("SELECT NOW()")).scalar())
        d = _gather(conn)
    today = date.today()
    return {"built": built, "today": str(today), "rows": [_row(e, d, today) for e in d["p"]]}


def _data_sig():
    """Changes the app doesn't make itself (QuickBooks sync, Drive documents,
    crew forms, Contractor Payments snapshot) and the day."""
    with engine.connect() as conn:
        r = conn.execute(text("""SELECT CONCAT_WS('|', CURDATE(),
            (SELECT MAX(id) FROM qbo_sync_runs WHERE finished_at IS NOT NULL),
            (SELECT MAX(id) FROM documents), (SELECT COUNT(*) FROM documents WHERE drive_removed_at IS NOT NULL),
            (SELECT MAX(id) FROM form_submissions),
            (SELECT MAX(signed_at) FROM progress_signoffs),
            (SELECT MAX(updated_at) FROM project_change_orders),
            (SELECT MAX(computed_at) FROM page_snapshots WHERE skey IN ('crewpay', 'jobcost')))""")).scalar()
    return r or ""


def _changed_since(conn, built):
    """Projects edited in the app after the snapshot was built."""
    rows = conn.execute(text("""
        SELECT entity_id FROM project_closeout_steps WHERE at > :b
        UNION SELECT entity_id FROM project_books_open WHERE at > :b
        UNION SELECT qc.qbo_id FROM project_schedule_items psi JOIN projects p ON p.id = psi.project_id
              JOIN qbo_customers qc ON qc.id = p.qbo_customer_id WHERE psi.updated_at > :b
        UNION SELECT s.entity_id FROM project_payment_schedules s WHERE s.updated_at > :b
        UNION SELECT s.entity_id FROM project_payment_installments i JOIN project_payment_schedules s ON s.id = i.schedule_id
              WHERE i.updated_at > :b
        UNION SELECT entity_id FROM project_expense_installments WHERE updated_at > :b
        UNION SELECT s.entity_id FROM project_invoice_milestones m JOIN project_invoice_schedules s ON s.id = m.schedule_id
              WHERE m.updated_at > :b"""), {"b": built}).scalars().all()
    return sorted({str(r) for r in rows if r})


def _all_rows():
    snap, meta = snapshots.serve(SNAP_KEY, _build_all, _data_sig, max_age=3600)
    rows = {r["entity_id"]: r for r in snap.get("rows", [])}
    today = date.today()
    with engine.connect() as conn:
        dirty = _changed_since(conn, snap.get("built") or "1970-01-01")
        if dirty:
            d = _gather(conn, dirty, finished_only=True)
            for e in dirty:
                rows.pop(e, None)
            for e in d["p"]:
                rows[e] = _row(e, d, today)
    return list(rows.values()), meta


def _patch_snapshot(entity_ids):
    """Put these jobs' fresh rows into the saved list straight away (a step undo
    deletes its row, which _changed_since can't see)."""
    got = snapshots.get(SNAP_KEY)
    if not got:
        return
    payload, sig, _age = got
    ids = {str(e) for e in entity_ids}
    today = date.today()
    with engine.connect() as conn:
        d = _gather(conn, sorted(ids), finished_only=True)
    rows = [r for r in payload.get("rows", []) if r["entity_id"] not in ids]
    rows += [_row(e, d, today) for e in d["p"]]
    payload["rows"] = rows
    snapshots.put(SNAP_KEY, payload, sig)


def refresh_snapshot():
    """Nightly warm-up (snapshots.warm) and after deploys."""
    return snapshots.rebuild(SNAP_KEY, _build_all, _data_sig)


@router.get("/queue")
def queue(closed: int = 0, user=Depends(require_capability(CAP))):
    """Jobs not closed out yet; closed=1: the ones that are (newest end first)."""
    today = date.today()
    rows, _meta = _all_rows()
    if closed:
        done = sorted((r for r in rows if r["closed"]), key=lambda r: r["end"] or "", reverse=True)
        return {"jobs": done, "cutover": str(CUTOVER), "can_sign": has_capability(user, FINANCIAL_SIGNOFF)}
    jobs = [r for r in rows if _visible(r, today)]
    jobs.sort(key=lambda r: (r["end"] or "9999"))
    closed_recent = sum(1 for r in rows if r["closed"] and (r["days_since_end"] or 0) <= 60)
    return {"jobs": jobs, "closed_recent": closed_recent, "cutover": str(CUTOVER),
            "can_sign": has_capability(user, FINANCIAL_SIGNOFF)}


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
    close_all: Optional[bool] = None    # closing out: mark every open step "reviewed" too


def _mark(conn, entity_id, step, status, note, user):
    if status is None:
        conn.execute(text("DELETE FROM project_closeout_steps WHERE entity_id = :e AND step_key = :k"), {"e": entity_id, "k": step})
        return
    conn.execute(text("""
        INSERT INTO project_closeout_steps (entity_id, step_key, status, note, by_user_id, by_email)
        VALUES (:e, :k, :s, :n, :u, :m)
        ON DUPLICATE KEY UPDATE status = VALUES(status), note = VALUES(note), by_user_id = VALUES(by_user_id),
                                by_email = VALUES(by_email), at = CURRENT_TIMESTAMP"""),
                 {"e": entity_id, "k": step, "s": status, "n": note or None, "u": user.get("id"), "m": user.get("email")})


def _close_out(conn, entity_id, row, note, user):
    """Close one job out: every step still to do is marked reviewed (with the
    note), then the margin step done. The 100% sign-off needs sign-off access."""
    open_steps = [s["key"] for s in row["steps"] if s["state"] == "todo" and s["key"] != "margin"]
    if "signoff" in open_steps and not has_capability(user, FINANCIAL_SIGNOFF):
        raise HTTPException(403, "The 100% sign-off needs someone with sign-off access (owners). Ask them to close this job out.")
    for k in open_steps:
        _mark(conn, entity_id, k, "reviewed", note or "Reviewed at close-out", user)
    _mark(conn, entity_id, "margin", "done", note, user)
    return open_steps


@router.post("/job/{entity_id}/step/{step}")
def mark_step(entity_id: str, step: str, req: StepMark, user=Depends(require_capability(CAP))):
    if step not in STEP_KEYS:
        raise HTTPException(400, "Unknown step")
    if req.status is not None and req.status not in MARKS:
        raise HTTPException(400, "status must be done, not_needed, reviewed or noted")
    if step == "signoff" and req.status is not None and not has_capability(user, FINANCIAL_SIGNOFF):
        raise HTTPException(403, "The 100% sign-off needs someone with sign-off access (owners).")
    reviewed = []
    with engine.begin() as conn:
        if step == "margin" and req.status == "done" and req.close_all:
            d = _gather(conn, [entity_id])
            if entity_id not in d["p"]:
                raise HTTPException(404, "Not a project with a schedule")
            reviewed = _close_out(conn, entity_id, _row(entity_id, d, date.today()), req.note, user)
        else:
            _mark(conn, entity_id, step, req.status, req.note, user)
        d = _gather(conn, [entity_id])
    if entity_id not in d["p"]:
        raise HTTPException(404, "Not a project with a schedule")
    row = _row(entity_id, d, date.today())
    record_audit(user, "closeout.step", "project", entity_id, row["name"],
                 {"step": step, "status": req.status, "note": req.note, "reviewed": reviewed})
    if step == "margin":
        BK.refresh_forecast_for(entity_id)   # closing out (or undoing it) closes / reopens the books
    _patch_snapshot([entity_id])
    return row


class BulkClose(BaseModel):
    entity_ids: List[str]
    note: str


@router.post("/bulk-close")
def bulk_close(req: BulkClose, user=Depends(require_capability(CAP))):
    """Close out many finished jobs at once (e.g. the older paperwork-only ones):
    every open step is marked reviewed with the note, then the job is closed.
    Needs sign-off access, since it signs off each job's 100% review."""
    if not has_capability(user, FINANCIAL_SIGNOFF):
        raise HTTPException(403, "Closing out jobs in bulk needs sign-off access (owners).")
    note = (req.note or "").strip()
    if not note:
        raise HTTPException(400, "Add a note saying why these jobs are being closed (kept with each job).")
    ids = [str(x) for x in dict.fromkeys(req.entity_ids)][:1000]
    today = date.today()
    closed, skipped = [], []
    with engine.begin() as conn:
        d = _gather(conn, ids)
        for e in ids:
            if e not in d["p"]:
                skipped.append(e)
                continue
            row = _row(e, d, today)
            if row["closed"]:
                skipped.append(e)
                continue
            reviewed = _close_out(conn, e, row, f"Bulk close: {note}", user)
            closed.append((e, row["name"], reviewed))
    for e, name, reviewed in closed:
        record_audit(user, "closeout.bulk_close", "project", e, name, {"note": note, "reviewed": reviewed})
        BK.refresh_forecast_for(e)
    if closed:
        _patch_snapshot([e for e, _n, _r in closed])
    return {"ok": True, "closed": len(closed), "skipped": len(skipped)}


# ── Cash forecast: older jobs come in only by choice (projects/books.py) ────────
@router.get("/job/{entity_id}/forecast")
def job_forecast(entity_id: str, user=Depends(require_capability(CAP))):
    """Whether the job's plans count in the cash forecast, and what they add
    (or would add, for an older job not included)."""
    from app.cashflow.schedule_forecast import preview_books_open
    with engine.connect() as conn:
        st = BK.state(conn, entity_id)
    return {"state": st, "cutover": str(CUTOVER), "plans": preview_books_open(entity_id)}


@router.get("/job/{entity_id}/planned")
def job_planned(entity_id: str, user=Depends(require_capability(CAP))):
    """2026-11-22 "Still planned": what the job's invoice, crew and expense
    schedules still plan to bill or pay (the forecast's own per-job events,
    computed as if the books were open, read-only), so staff can fix or clear
    stale plans before closing out. Closing out drops all of it from Cash Flow."""
    from app.cashflow.schedule_forecast import _project_events
    today = date.today()
    with engine.connect() as conn:
        t = conn.begin()
        try:
            ev = _project_events(conn, entity_id, force_open=True)
        finally:
            t.rollback()
        st = BK.state(conn, entity_id)
    kinds = {k: {"total": 0.0, "past": 0.0, "n": 0, "n_past": 0, "items": []} for k in ("invoice", "crew", "expense")}
    for e in (ev or {}).get("events", []):
        k = kinds.get(e.get("src"))
        if k is None:
            continue
        past = e["date"][:10] < today.isoformat()
        what = (e.get("label") or "Invoice") + (f" · #{e['est']}" if e.get("est") else "") if e["src"] == "invoice" \
            else (e.get("crew") or "Crew payment") if e["src"] == "crew" else (e.get("cat") or "Expense")
        k["items"].append({"date": e["date"][:10], "amount": round(e["amt"], 2), "what": what, "past": past})
        k["total"] += e["amt"]
        k["n"] += 1
        if past:
            k["past"] += e["amt"]
            k["n_past"] += 1
    for k in kinds.values():
        k["items"].sort(key=lambda x: x["date"])
        k["total"], k["past"] = round(k["total"], 2), round(k["past"], 2)
    return {"state": st, "kinds": kinds,
            "undated_in": round(float((ev or {}).get("backlog_in") or 0), 2),
            "undated_out": round(float((ev or {}).get("backlog_out") or 0), 2)}


class ForecastChoice(BaseModel):
    include: bool
    note: Optional[str] = None


@router.post("/job/{entity_id}/forecast")
def set_job_forecast(entity_id: str, req: ForecastChoice, user=Depends(require_capability(CAP))):
    """Include an older finished job (ended before CUTOVER) in the cash
    forecast until it's closed out, or take it back out."""
    note = (req.note or "").strip()
    if req.include and not note:
        raise HTTPException(400, "Say why its plans still count (for example: final invoice still to send).")
    with engine.begin() as conn:
        d = _gather(conn, [entity_id])
        if entity_id not in d["p"]:
            raise HTTPException(404, "Not a finished project")
        name = d["p"][entity_id]["name"]
        conn.execute(text("""
            INSERT INTO project_books_open (entity_id, include, note, by_user_id, by_email)
            VALUES (:e, :i, :n, :u, :m)
            ON DUPLICATE KEY UPDATE include = VALUES(include), note = VALUES(note), by_user_id = VALUES(by_user_id),
                                    by_email = VALUES(by_email), at = CURRENT_TIMESTAMP"""),
                     {"e": entity_id, "i": 1 if req.include else 0, "n": note or None, "u": user.get("id"), "m": user.get("email")})
    record_audit(user, "closeout.forecast_include" if req.include else "closeout.forecast_exclude", "project", entity_id, name,
                 {"note": note, "entity_id": entity_id})
    BK.refresh_forecast_for(entity_id)
    _patch_snapshot([entity_id])
    return job_forecast(entity_id, user)


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
    """Contract labor: the estimates' budget, what was paid (per crew, from the
    QuickBooks bills), and the crew's Payment Schedule for reference."""
    from app import snapshots
    from app.crewpay import service as CP
    co, by_vendor = CP._crews(conn)
    lines = sorted(CP._paid_lines(conn, e), key=lambda x: str(x["d"]))
    pays, paid_by = [], defaultdict(float)
    for l in lines:
        crew = (by_vendor.get(str(l["vendor"] or "")) or {}).get("name") or l["vendor_name"] or "Unknown payee"
        paid_by[crew] += _f(l["a"])
        pays.append({"date": _d(l["d"]), "type": "Card/check" if l["type"] == "Purchase" else "Bill", "doc": l["doc"],
                     "crew": crew, "description": l["descr"], "amount": round(_f(l["a"]), 2)})
    deal = defaultdict(lambda: {"scheduled": 0.0, "owed": 0.0})
    got = snapshots.get("crewpay")
    rows = [r for r in (got[0].get("rows", []) if got else []) if str(r.get("entity_id")) == e]
    if rows:
        for r in rows:
            deal[r.get("crew") or "Crew"]["scheduled"] += _f(r.get("schedule"))
            deal[r.get("crew") or "Crew"]["owed"] += max(0.0, _f(r.get("remaining")))
    else:
        for r in conn.execute(text("""
            SELECT s.crew_id, SUM(i.amount) FROM project_payment_schedules s
            JOIN project_payment_installments i ON i.schedule_id = s.id
            WHERE s.entity_id = :e AND COALESCE(s.source, 'app') <> 'sheet_covered'
            GROUP BY s.crew_id"""), {"e": e}).all():
            name = (co.get(r[0]) or {}).get("name") or "Crew (not set)"
            deal[name]["scheduled"] += _f(r[1])
    crews = []
    for name in sorted(set(paid_by) | set(deal)):
        crews.append({"crew": name, "paid": round(paid_by.get(name, 0.0), 2),
                      "deal": round(deal[name]["scheduled"], 2) if name in deal else None,
                      "deal_owed": round(deal[name]["owed"], 2) if name in deal and rows else None})
    return {"budget": money["labor_budget"], "paid": money["labor_paid"], "left": money["labor_left"],
            "deal": money["crew_deal"], "crews": crews, "payments": pays}


def _det_bills(conn, e):
    """Expenses: each cost category on the estimates next to what was spent, then
    the bills on the job that are still unpaid."""
    from app.jobcost import service as JCS
    bud = JCS.budget_by_category(conn, [e]).get(e, {})
    act = JCS.actual_by_category(conn, [e]).get(e, {})
    order = [c for c in JCS.CATEGORIES if c != "Crew labor"]
    cats = [{"category": c, "estimate": round(bud.get(c, 0.0), 2), "spent": round(act.get(c, 0.0), 2),
             "left": round(bud.get(c, 0.0) - act.get(c, 0.0), 2)}
            for c in order if abs(bud.get(c, 0.0)) > 0.005 or abs(act.get(c, 0.0)) > 0.005]
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
    return {"categories": cats, "bills": bills, "job_amount": round(sum(b["job_amount"] for b in bills), 2)}


def _det_signoff(conn, e, d, money):
    from app import snapshots
    required = True       # 2026-11-12: every job gets the 100% review at close-out
    rule = "every job at close-out"
    signs = [{"milestone": r["milestone"], "decision": r["decision"], "note": r["note"], "by": r["signed_by"],
              "at": str(r["signed_at"]) if r["signed_at"] else None}
             for r in conn.execute(text("""SELECT milestone, decision, note, signed_by, signed_at FROM progress_signoffs
                                           WHERE entity_id = :e ORDER BY milestone"""), {"e": e}).mappings()]
    out = {"required": required, "rule": rule, "signoffs": signs, "progress": None}
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
