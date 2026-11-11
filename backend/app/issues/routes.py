"""
Issues: every problem the app already finds, from every page, in one list.

  GET /api/issues            {items, counts, categories, built}

Nothing new is detected here and nothing is decided here: each issue comes from
the page that owns it, with a link back to it, and the decisions staff make
there (Data Review Fixed/Ignored, Contractor Payments decisions, Progress
sign-offs) carry over. One place to see what's wrong; the fix stays where it was.

  Area        Source                                        Owner page
  invoices    Ashley's Tracker flags (overdue to send,       #/tracker
              late to be paid, unbilled balance, pending
              estimate) + Data Review billing items          #/review
  crew        Contractor Payments open issues                #/crew-payments
  expenses    Job cost over the estimate, by category        #/overview
              + unpaid bills past due (QuickBooks)
  progress    Progress Checks: money and work not moving     #/progress
              together, sign-offs due
  schedules   Data Review schedule items (dates vs status)   #/review
  data        Data Review: pipeline, sheets, documents,      #/review
              sources, app edits
"""
import time
from collections import Counter
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import text

from app.auth import require_capability
from app.db import engine

router = APIRouter(prefix="/api/issues", tags=["issues"])
CAP = "page.customers"
CACHE_SECONDS = 90
_cache = {"at": 0, "data": None}

AREAS = [("invoices", "Invoices"), ("change_orders", "Change orders"), ("crew", "Crew pay"), ("expenses", "Expenses"), ("progress", "Progress"),
         ("schedules", "Schedules"), ("data", "Data")]
# Job cost over its estimate: flag when a category is over by both this share and this many dollars.
OVER_PCT, OVER_ABS = 0.10, 500.0
CO_DAYS = 180   # change orders accepted this recently get follow-up checks
SEV = {"high": "bad", "medium": "warn", "low": "info", 1: "bad", 2: "warn", 3: "info"}
REVIEW_AREA = {"billing": "invoices", "payments": "crew", "schedule": "schedules"}


def _item(area, key, sev, title, *, entity_id=None, job=None, pm=None, detail=None, amount=None,
          link=None, source=None, category=None, decision=None, date_=None):
    return {"area": area, "key": f"{area}:{key}", "sev": sev, "title": title, "entity_id": entity_id, "job": job,
            "pm": pm, "detail": detail, "amount": round(float(amount), 2) if amount is not None else None,
            "link": link, "source": source, "category": category, "decision": decision, "date": date_}


def _proj(e, tab=None):
    return f"#/entity/project/{e}" + (f"?tab={tab}" if tab else "")


def _tracker(out, today):
    from app.tracker import routes as TR
    for r in TR._build():
        e, name = r["entity_id"], r["name"]
        pm = ", ".join((p.get("name") or "") if isinstance(p, dict) else str(p) for p in (r.get("pms") or [])) or None
        if not r.get("relevant"):
            continue
        for est in r["estimates"]:
            for m in est["milestones"]:
                if m["flag"] == "overdue_send":
                    out.append(_item("invoices", f"send:{m['id']}", "bad", f"Invoice overdue to send: {m['label']}",
                                     entity_id=e, job=name, pm=pm, amount=m.get("remaining") or m.get("amount"),
                                     detail=f"Estimate {est['doc']} · planned for {m['invoice_date']}", date_=m["invoice_date"],
                                     link=_proj(e, "billing"), source="Ashley's Tracker", category="To send"))
            for inv in est["invoices"]:
                if inv["late"]:
                    out.append(_item("invoices", f"late:{inv['qbo_id']}", "warn", f"Invoice {inv['doc']} past due",
                                     entity_id=e, job=name, pm=pm, amount=inv["balance"],
                                     detail=f"Due {inv['due']} · ${float(inv['balance'] or 0):,.0f} of ${float(inv['amount'] or 0):,.0f} unpaid",
                                     date_=inv["due"], link=_proj(e, "billing"), source="Ashley's Tracker", category="Past due"))
        if r.get("unbilled"):
            u = r["unbilled"]
            why = {"past": "the planned date has passed", "completed": "the job is complete", "no_date": "no invoice date is set",
                   "soon": "it's due soon"}.get(u["why"], u["why"])
            out.append(_item("invoices", f"unbilled:{e}", "bad" if u["why"] in ("past", "completed") else "warn",
                             "Contract not fully billed", entity_id=e, job=name, pm=pm, amount=u["amount"],
                             detail=f"${u['amount']:,.0f} still to bill and {why}", date_=u.get("date"),
                             link=_proj(e, "billing"), source="Ashley's Tracker", category="Unbilled"))
        if r.get("pending_estimates") and r.get("status") not in ("completed", "canceled"):
            n = len(r["pending_estimates"])
            out.append(_item("invoices", f"pending:{e}", "info", f"{n} pending estimate{'s' if n != 1 else ''} on the project",
                             entity_id=e, job=name, pm=pm, detail="A change order or quote that isn't accepted in QuickBooks yet",
                             link=_proj(e, "changeorders"), source="Ashley's Tracker", category="Pending estimate"))


def _review(out):
    from app.gsync import review as RV
    d = RV.cached()
    for i in d["items"]:
        if i.get("state") != "open":
            continue
        area = REVIEW_AREA.get(i["category"], "data")
        if area == "invoices" and i.get("type") == "unbilled_balance":
            continue   # the same check as the Tracker's, listed once
        ref = i.get("ref") or {}
        e = ref.get("entity_id") or ref.get("project_qbo_id")
        out.append(_item(area, f"rv:{i['key']}", SEV.get(i["severity"], "info"), i["title"], entity_id=str(e) if e else None,
                         detail=" ".join(x for x in (i.get("detail"), i.get("fix")) if x), link=i.get("link") or "#/review",
                         source="Data Review", category=i["category"].replace("_", " ").title()))


def _crew(out):
    from app.crewpay import service as S
    d = S.apply_review(S.dataset())
    for i in d["issues"]:
        dec = i.get("decision")
        if dec and not i.get("changed") and dec["status"] not in S.OPEN_STATUSES:
            continue
        out.append(_item("crew", i["key"], SEV.get(i["severity"], "info"), i["label"], entity_id=i["entity_id"], job=i["job"],
                         pm=i.get("pm"), detail=" · ".join(x for x in (i.get("crew"), i.get("detail")) if x), amount=i.get("amount"),
                         link="#/crew-payments", source="Contractor Payments", category=i["label"],
                         decision=dec["label"] if dec else None))


def _expenses(out, today):
    from app.jobcost import service as JC
    d = JC.dataset()
    since = (today - timedelta(days=365)).isoformat()
    for j in d["jobs"]:
        if j["state"] == "upcoming" or (j.get("end") or "") < since:
            continue
        for cat in JC.CATEGORIES:
            est = float((j.get("est") or {}).get(cat) or 0) + float((j.get("pend") or {}).get(cat) or 0)
            act = float((j.get("act") or {}).get(cat) or 0)
            over = act - est
            if over > OVER_ABS and (est <= 0 or over > est * OVER_PCT):
                out.append(_item("expenses", f"over:{j['id']}:{cat}", "bad" if est > 0 and over > est * 0.25 else "warn",
                                 f"{cat} over the estimate" if est > 0 else f"{cat} spent with nothing estimated",
                                 entity_id=j["id"], job=j["name"], pm=j.get("pm"), amount=over, category=cat,
                                 detail=f"Spent ${act:,.0f} against ${est:,.0f} estimated" + (" (job still running)" if j["state"] == "active" else ""),
                                 link=_proj(j["id"], "financials"), source="Job cost"))
    # Bills tagged to a job, unpaid past their due date.
    with engine.connect() as conn:
        rows = conn.execute(text("""
            WITH latest AS (
              SELECT t.id, t.qbo_id, t.doc_number, t.due_date, t.balance_amt, t.total_amt,
                     JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.VendorRef.name')) AS vendor,
                     ROW_NUMBER() OVER (PARTITION BY t.qbo_id ORDER BY t.id DESC) AS rn
              FROM qbo_transactions t WHERE t.entity_type = 'Bill')
            SELECT latest.qbo_id, latest.doc_number, latest.due_date, latest.balance_amt, latest.vendor,
                   MIN(l.line_customer_qbo_id) AS e, MIN(qc.display_name) AS job
            FROM latest JOIN qbo_transaction_lines l ON l.transaction_id = latest.id
            JOIN qbo_customers qc ON qc.qbo_id = l.line_customer_qbo_id AND qc.is_project = 1
            WHERE latest.rn = 1 AND latest.balance_amt > 0.01 AND latest.due_date < :t
            GROUP BY latest.qbo_id, latest.doc_number, latest.due_date, latest.balance_amt, latest.vendor
        """), {"t": today - timedelta(days=7)}).mappings().all()
    for r in rows:
        out.append(_item("expenses", f"bill:{r['qbo_id']}", "warn", f"Unpaid bill from {r['vendor'] or 'a vendor'}",
                         entity_id=str(r["e"]), job=r["job"], amount=r["balance_amt"], category="Unpaid bills",
                         detail=f"Bill {r['doc_number'] or ''} due {r['due_date']}, still open in QuickBooks", date_=str(r["due_date"]),
                         link=_proj(str(r["e"]), "financials"), source="QuickBooks"))


def _change_orders(out, today):
    """Follow-up after a change order: every QuickBooks estimate on a project after
    the original, accepted in the last CO_DAYS, should be confirmed on the billing
    schedule and, if it adds crew labor, offered to a crew. Plus customer approvals
    from the portal that QuickBooks still shows as Pending."""
    since = today - timedelta(days=CO_DAYS)
    with engine.connect() as conn:
        rows = conn.execute(text("""
            WITH est AS (
              SELECT t.qbo_id, t.doc_number, t.txn_date, MAX(t.total_amt) amt, sl.project_customer_qbo_id e,
                     MAX(JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus'))) st,
                     SUM(CASE WHEN sl.item_name LIKE 'Contract Labor%%' THEN COALESCE(sl.cost_amount, sl.amount) ELSE 0 END) labor
              FROM qbo_transactions t JOIN qbo_sales_transaction_lines sl ON sl.transaction_id = t.id
              JOIN qbo_customers qc ON qc.qbo_id = sl.project_customer_qbo_id AND qc.is_project = 1
              WHERE t.entity_type = 'Estimate'
              GROUP BY t.qbo_id, t.doc_number, t.txn_date, sl.project_customer_qbo_id),
            ranked AS (SELECT est.*, ROW_NUMBER() OVER (PARTITION BY e ORDER BY txn_date, doc_number) rn FROM est)
            SELECT r.*, qc.display_name job, b.confirmed,
                   (SELECT COUNT(*) FROM work_offers w WHERE w.entity_id = r.e AND w.status IN ('sent', 'accepted')
                      AND w.sent_at >= r.txn_date) offers_after,
                   (SELECT COUNT(*) FROM work_offers w2 WHERE w2.entity_id = r.e) offers_any
            FROM ranked r JOIN qbo_customers qc ON qc.qbo_id = r.e
            LEFT JOIN project_estimate_billing b ON b.entity_id = r.e AND b.estimate_qbo_id = r.qbo_id
            WHERE r.rn > 1 AND r.st IN ('Accepted', 'Converted', 'Closed') AND r.txn_date >= :since
        """), {"since": since}).mappings().all()
        portal = conn.execute(text("""
            SELECT co.project_qbo_id e, co.qbo_estimate_id q, co.title, co.amount, r.signer_name, r.at, qc.display_name job,
                   (SELECT JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) FROM qbo_transactions t
                     WHERE t.entity_type = 'Estimate' AND t.qbo_id = co.qbo_estimate_id ORDER BY t.id DESC LIMIT 1) st
            FROM change_order_responses r JOIN project_change_orders co ON co.id = r.co_id
            LEFT JOIN qbo_customers qc ON qc.qbo_id = co.project_qbo_id
            WHERE r.decision = 'approved' AND co.qbo_estimate_id IS NOT NULL""")).mappings().all()
    for r in rows:
        e, doc = str(r["e"]), r["doc_number"]
        if r["confirmed"] is not None and not r["confirmed"]:
            out.append(_item("change_orders", f"confirm:{r['qbo_id']}", "warn", f"Change order {doc}: confirm its invoice and crew-pay schedule",
                             entity_id=e, job=r["job"], amount=r["amt"], category="Schedules to confirm", date_=str(r["txn_date"]),
                             detail="Accepted in QuickBooks; the billing schedule the app built for it hasn't been confirmed.",
                             link=_proj(e, "billing"), source="Change orders"))
        # Offers are recorded in the app since fall 2026: only ask on jobs that use them, or recent change orders.
        recent = r["txn_date"] and r["txn_date"] >= today - timedelta(days=45)
        if float(r["labor"] or 0) > 0 and not r["offers_after"] and (r["offers_any"] or recent):
            out.append(_item("change_orders", f"offer:{r['qbo_id']}", "warn", f"Change order {doc} adds crew labor: offer it to a crew",
                             entity_id=e, job=r["job"], amount=r["labor"], category="Crew to re-offer", date_=str(r["txn_date"]),
                             detail=f"${float(r['labor']):,.0f} of contract labor and no crew offer sent since the change order.",
                             link=_proj(e, "assignment"), source="Change orders"))
    for r in portal:
        if r["st"] == "Pending":
            out.append(_item("change_orders", f"portal:{r['q']}", "bad", "Customer approved in the portal: mark it Accepted in QuickBooks",
                             entity_id=str(r["e"]), job=r["job"], amount=r["amount"], category="Approved by customer",
                             detail=f"{r['title']} approved by {r['signer_name']} on {str(r['at'])[:10]}", date_=str(r["at"])[:10],
                             link=_proj(str(r["e"]), "changeorders"), source="Customer portal"))


def _progress(out):
    from app.progress import service as P
    d = P.apply_review(P.dataset())
    for j in d["jobs"]:
        if j["signoffs_due"]:
            out.append(_item("progress", f"due:{j['id']}", "warn", "Progress check due for sign-off", entity_id=j["id"], job=j["name"],
                             pm=j.get("pm"), category="Sign-off due",
                             detail=f"{int(j['pct_time'] * 100)}% of the time, {int(j['pct_invoiced'] * 100)}% invoiced",
                             link="#/progress", source="Progress Checks"))
        if j["state"] == "active" and j["status"] in ("over", "behind"):
            what = "Costs running ahead of the work" if j["status"] == "over" else "Billing behind the work"
            out.append(_item("progress", f"{j['status']}:{j['id']}", "bad" if j["status"] == "over" else "warn", what,
                             entity_id=j["id"], job=j["name"], pm=j.get("pm"), category=what,
                             detail=f"{int(j['pct_time'] * 100)}% through the job · {int(j['pct_invoiced'] * 100)}% invoiced · {int(j['pct_cost'] * 100)}% of costs",
                             link="#/progress", source="Progress Checks"))


def build():
    today = date.today()
    out, errors = [], []
    for name, fn in (("Ashley's Tracker", lambda: _tracker(out, today)), ("Data Review", lambda: _review(out)),
                     ("Contractor Payments", lambda: _crew(out)), ("Job cost", lambda: _expenses(out, today)),
                     ("Progress Checks", lambda: _progress(out)), ("Change orders", lambda: _change_orders(out, today))):
        try:
            fn()
        except Exception as ex:   # one broken source never hides the others
            errors.append(f"{name}: {ex}")
    # Fill job names / PMs for items that only carry an entity id.
    need = sorted({i["entity_id"] for i in out if i["entity_id"] and not i["job"]})
    if need:
        from sqlalchemy import bindparam
        with engine.connect() as conn:
            names = dict(conn.execute(text("SELECT qbo_id, display_name FROM qbo_customers WHERE qbo_id IN :ids")
                                      .bindparams(bindparam("ids", expanding=True)), {"ids": need}).all())
        for i in out:
            if i["entity_id"] and not i["job"]:
                i["job"] = names.get(i["entity_id"])
    rank = {"bad": 0, "warn": 1, "info": 2}
    out.sort(key=lambda i: (rank[i["sev"]], -(abs(i["amount"] or 0))))
    counts = Counter(i["area"] for i in out)
    cats = {}
    for a, _ in AREAS:
        cats[a] = Counter(i["category"] or "Other" for i in out if i["area"] == a).most_common()
    return {"items": out, "areas": [{"key": k, "label": l, "count": counts.get(k, 0),
                                     "bad": sum(1 for i in out if i["area"] == k and i["sev"] == "bad")} for k, l in AREAS],
            "categories": cats, "errors": errors, "built": time.strftime("%Y-%m-%d %H:%M:%S")}


@router.get("")
def issues(fresh: bool = False, user=Depends(require_capability(CAP))):
    now = time.time()
    if fresh or not _cache["data"] or now - _cache["at"] > CACHE_SECONDS:
        _cache["data"], _cache["at"] = build(), now
    return _cache["data"]
