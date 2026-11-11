"""
Change Orders register: every change order across all projects, one row each,
from sent -> answered -> in QuickBooks -> invoiced -> crew re-offered, with the
next thing it needs.

  GET /api/change-orders/register?days=365      {rows, summary, built}

Nothing new is decided here; it reads what the other pages already keep:

  QuickBooks estimates on a project after its original (the first estimate is
    the contract; later ones are change orders / added scope), latest version,
    TxnStatus, invoiced = an Invoice in its LinkedTxn (same rule as Closeout)
  project_estimate_billing.confirmed   the billing schedule built for it
                                       (Issues: "confirm its schedule")
  project_change_orders (kind change_order)   app drafts / sent / approved /
                                       rejected, linked by qbo_estimate_id
  change_order_responses               customer-portal approve / decline
  work_offers                          crew offer sent / accepted after the CO
                                       date when it adds contract labor (Issues
                                       rule: only on jobs that use offers, or
                                       COs under OFFER_RECENT_DAYS old)

A CO the app created and linked to its QuickBooks estimate is one row.
"""
import time
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import text

from app.auth import require_capability
from app.db import engine

router = APIRouter(prefix="/api/change-orders", tags=["change-orders-register"])
CAP = "page.customers"
CACHE_SECONDS = 90
OFFER_RECENT_DAYS = 45
_cache = {}


def _f(v):
    return float(v or 0)


def _d(v):
    return str(v)[:10] if v else None


def build(days):
    today = date.today()
    since = today - timedelta(days=days) if days else date(2000, 1, 1)
    with engine.connect() as conn:
        qrows = conn.execute(text("""
            WITH est AS (
              SELECT t.qbo_id, MAX(t.id) last_id, sl.project_customer_qbo_id e,
                     SUM(CASE WHEN sl.item_name LIKE 'Contract Labor%%' THEN COALESCE(sl.cost_amount, sl.amount) ELSE 0 END) labor
              FROM qbo_transactions t JOIN qbo_sales_transaction_lines sl ON sl.transaction_id = t.id
              JOIN qbo_customers qc ON qc.qbo_id = sl.project_customer_qbo_id AND qc.is_project = 1
              WHERE t.entity_type = 'Estimate'
              GROUP BY t.qbo_id, sl.project_customer_qbo_id),
            full_ AS (
              SELECT est.*, t.doc_number, t.txn_date, t.total_amt amt,
                     JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) st,
                     JSON_SEARCH(JSON_EXTRACT(t.raw_json, '$.LinkedTxn[*].TxnType'), 'one', 'Invoice') IS NOT NULL inv
              FROM est JOIN qbo_transactions t ON t.id = est.last_id),
            ranked AS (SELECT full_.*, ROW_NUMBER() OVER (PARTITION BY e ORDER BY txn_date, doc_number, qbo_id) rn FROM full_)
            SELECT r.*, b.confirmed,
                   (SELECT MAX(w.status = 'accepted') FROM work_offers w WHERE w.entity_id = r.e AND w.status IN ('sent', 'accepted')
                      AND w.sent_at >= r.txn_date) offer_after,
                   (SELECT COUNT(*) FROM work_offers w2 WHERE w2.entity_id = r.e) offers_any
            FROM ranked r
            LEFT JOIN project_estimate_billing b ON b.entity_id = r.e AND b.estimate_qbo_id = r.qbo_id
            WHERE r.rn > 1 AND r.txn_date >= :since
        """), {"since": since}).mappings().all()
        app = conn.execute(text("""
            SELECT co.id, co.project_qbo_id e, co.qbo_estimate_id, co.co_number, co.title, co.reason, co.amount,
                   co.contract_labor, co.status, co.created_at,
                   (SELECT MAX(w.status = 'accepted') FROM work_offers w WHERE w.entity_id = co.project_qbo_id
                      AND w.status IN ('sent', 'accepted') AND w.sent_at >= DATE(co.created_at)) offer_after,
                   (SELECT COUNT(*) FROM work_offers w2 WHERE w2.entity_id = co.project_qbo_id) offers_any
            FROM project_change_orders co WHERE co.kind = 'change_order'""")).mappings().all()
        resp = {}
        for r in conn.execute(text("""SELECT co_id, decision, signer_name, note, at FROM change_order_responses
                                      ORDER BY at, id""")).mappings():
            resp[r["co_id"]] = dict(r)      # the latest answer wins
        eids = list({str(r["e"]) for r in qrows} | {str(r["e"]) for r in app}) or ["-"]
        from sqlalchemy import bindparam
        q = lambda sql: text(sql).bindparams(bindparam("ids", expanding=True))
        proj = {str(r["qbo_id"]): dict(r) for r in conn.execute(q("""
            SELECT qc.qbo_id, qc.display_name name, par.display_name dealer FROM qbo_customers qc
            LEFT JOIN qbo_customers par ON par.qbo_id = qc.parent_qbo_id WHERE qc.qbo_id IN :ids"""), {"ids": eids}).mappings()}
        pms = {}
        for r in conn.execute(q("""
            SELECT qc.qbo_id e, m.first_name, m.last_name, MAX(spm.is_primary) prim
            FROM qbo_customers qc JOIN projects p ON p.qbo_customer_id = qc.id
            JOIN project_schedule_items psi ON psi.project_id = p.id
            JOIN project_schedule_item_project_managers spm ON spm.schedule_item_id = psi.id AND spm.unassigned_at IS NULL
            JOIN project_managers m ON m.id = spm.project_manager_id
            WHERE qc.qbo_id IN :ids GROUP BY qc.qbo_id, m.id, m.first_name, m.last_name"""), {"ids": eids}).mappings():
            pms.setdefault(str(r["e"]), []).append((-int(r["prim"] or 0), f"{r['first_name'] or ''} {r['last_name'] or ''}".strip()))

    app_by_q = {str(a["qbo_estimate_id"]): a for a in app if a["qbo_estimate_id"]}
    rows = []

    def crew_state(labor, offer_after, offers_any, d):
        if labor <= 0:
            return None
        if offer_after is not None:
            return "accepted" if int(offer_after) == 1 else "sent"
        recent = d and d >= today - timedelta(days=OFFER_RECENT_DAYS)
        return "to_offer" if (offers_any or recent) else "unknown"

    def finish(row):
        e = row["entity_id"]
        p = proj.get(e, {})
        row["project"] = p.get("name") or e
        row["dealer"] = p.get("dealer")
        row["pm"] = ", ".join(n for _, n in sorted(pms.get(e, [])))
        row["next_step"], row["tone"], row["stage"] = _next(row)
        rows.append(row)

    for r in qrows:
        a = app_by_q.get(str(r["qbo_id"]))
        rp = resp.get(a["id"]) if a else None
        d = r["txn_date"]
        labor = _f(r["labor"]) or (_f(a["contract_labor"]) if a else 0)
        finish({
            "key": f"q{r['qbo_id']}", "entity_id": str(r["e"]), "source": "QuickBooks", "qbo_id": str(r["qbo_id"]),
            "app_id": a["id"] if a else None, "number": r["doc_number"],
            "title": (a and a["title"]) or f"Estimate {r['doc_number'] or r['qbo_id']}",
            "date": _d(d), "amount": round(_f(r["amt"]), 2), "labor": round(labor, 2),
            "status": r["st"] or "Pending", "app_status": a["status"] if a else None,
            "portal_response": _resp(rp), "invoiced": bool(r["inv"]) or r["st"] == "Converted",
            "billing_confirmed": None if r["confirmed"] is None else bool(r["confirmed"]),
            "crew_reoffer": crew_state(labor, r["offer_after"], r["offers_any"], d),
        })
    for a in app:
        if a["qbo_estimate_id"] and str(a["qbo_estimate_id"]) in {x["qbo_id"] for x in rows if x.get("qbo_id")}:
            continue
        if a["created_at"] and a["created_at"].date() < since:
            continue
        d = a["created_at"].date() if a["created_at"] else None
        labor = _f(a["contract_labor"])
        finish({
            "key": f"a{a['id']}", "entity_id": str(a["e"]), "source": "App", "qbo_id": a["qbo_estimate_id"], "app_id": a["id"],
            "number": f"CO {a['co_number']}" if a["co_number"] else None, "title": a["title"] or "Change order",
            "date": _d(d), "amount": round(_f(a["amount"]), 2), "labor": round(labor, 2),
            "status": None, "app_status": a["status"], "portal_response": _resp(resp.get(a["id"])),
            "invoiced": False, "billing_confirmed": None,
            "crew_reoffer": crew_state(labor, a["offer_after"], a["offers_any"], d),
        })
    rows.sort(key=lambda r: (r["date"] or ""), reverse=True)
    cut90 = str(today - timedelta(days=90))
    summary = {
        "waiting_customer": sum(1 for r in rows if r["stage"] == "waiting"),
        "approved_not_in_qbo": sum(1 for r in rows if r["stage"] == "approved_not_qbo"),
        "not_invoiced": sum(1 for r in rows if r["stage"] == "action" and r["accepted"] and not r["invoiced"]),
        "crew_to_offer": sum(1 for r in rows if r["crew_reoffer"] == "to_offer" and r["accepted"]),
        "schedules_to_confirm": sum(1 for r in rows if r["accepted"] and r["billing_confirmed"] is False),
        "needs_action": sum(1 for r in rows if r["stage"] in ("action", "approved_not_qbo", "draft")),
        "value_90": round(sum(r["amount"] for r in rows if (r["date"] or "") >= cut90 and r["accepted"]), 2),
        "count_90": sum(1 for r in rows if (r["date"] or "") >= cut90 and r["accepted"]),
        "total": len(rows),
    }
    return {"rows": rows, "summary": summary, "days": days, "built": time.time()}


def _resp(rp):
    if not rp:
        return None
    return {"decision": rp["decision"], "by": rp["signer_name"], "at": _d(rp["at"]), "note": rp["note"]}


ACCEPTED = ("Accepted", "Converted", "Closed")


def _next(r):
    """(next step text, tone, stage). Stages: draft, waiting, approved_not_qbo,
    action, declined, done."""
    pr = r["portal_response"]
    st, app_st = r["status"], r["app_status"]
    r["accepted"] = st in ACCEPTED
    if st == "Rejected" or app_st == "rejected" or (pr and pr["decision"] == "declined" and not r["accepted"]):
        return ("Declined by the customer" if pr and pr["decision"] == "declined" else "Declined"), "quiet", "declined"
    if r["source"] == "App" and not r["qbo_id"]:
        if app_st == "draft":
            return "Draft: send it to the customer", "info", "draft"
        if app_st == "approved" or (pr and pr["decision"] == "approved"):
            return "Approved: enter it in QuickBooks", "bad", "approved_not_qbo"
        return "Waiting on the customer", "info", "waiting"
    if not r["accepted"]:
        if pr and pr["decision"] == "approved":
            return f"Approved by {pr['by']} in the portal: mark it Accepted in QuickBooks", "bad", "approved_not_qbo"
        if app_st == "approved":
            return "Approved in the app: mark it Accepted in QuickBooks", "bad", "approved_not_qbo"
        return "Waiting on the customer (Pending in QuickBooks)", "info", "waiting"
    todo = []
    if r["billing_confirmed"] is False:
        todo.append("confirm its invoice and crew-pay schedule")
    if r["crew_reoffer"] == "to_offer":
        todo.append(f"offer the ${r['labor']:,.0f} of added labor to a crew")
    if not r["invoiced"]:
        todo.append("invoice it")
    if todo:
        t = "; ".join(todo)
        return t[0].upper() + t[1:], "warn", "action"
    return "Done", "good", "done"


@router.get("/register")
def register(days: int = 365, fresh: bool = False, user=Depends(require_capability(CAP))):
    days = max(0, min(days, 3650))
    c = _cache.get(days)
    if not fresh and c and time.time() - c["built"] < CACHE_SECONDS:
        return c
    data = build(days)
    _cache[days] = data
    return data
