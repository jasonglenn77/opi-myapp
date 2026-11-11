"""
Invoice & Pay Dates: every invoice, crew payment and planned expense across all
projects, by date, so nothing slips.

  GET /api/pay-dates?start=YYYY-MM-DD&end=YYYY-MM-DD

Rows come straight from each project's schedules (the Billing tab):
  invoice   project_invoice_milestones: 'pending' = still to send (invoice_date),
            'sent' = in QuickBooks, waiting on payment (due_date, with the
            invoice's open balance), 'retainage' = held back
  crew      project_payment_installments not marked paid. A row counts as paid
            once the crew's QuickBooks bills on the job cover it, oldest first:
            the same burn-down Contractor Payments uses (its saved build).
  expense   project_expense_installments: planned spend by week and category

Dates are edited with the schedules' own endpoints (/api/invoices/milestone,
/api/payments/installment, /api/expenses/expense-installment), so the project's
Billing tab, the forecast and the change alerts all see the same change.
Anything overdue is listed whatever the window, so it never drops out of sight.
"""
from collections import defaultdict
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import text

from app.auth import require_capability
from app.db import engine

router = APIRouter(prefix="/api/pay-dates", tags=["pay-dates"])
CAP = "page.cashflow"
OVERDUE_BACK_DAYS = 400   # how far back an unsent invoice / unpaid crew row is still "overdue"


def _d(v):
    return v.isoformat() if v else None


def _projects(conn):
    rows = conn.execute(text("""
        SELECT qc.qbo_id, qc.display_name,
               (SELECT psi2.status FROM project_schedule_items psi2 WHERE psi2.project_id = p.id
                ORDER BY psi2.start_date IS NULL, psi2.start_date DESC, psi2.sort_order DESC, psi2.id DESC LIMIT 1) AS status,
               (SELECT GROUP_CONCAT(DISTINCT TRIM(CONCAT(COALESCE(pm.first_name,''),' ',COALESCE(pm.last_name,''))) SEPARATOR ', ')
                FROM project_schedule_items s3
                JOIN project_schedule_item_project_managers spm ON spm.schedule_item_id = s3.id AND spm.unassigned_at IS NULL
                JOIN project_managers pm ON pm.id = spm.project_manager_id WHERE s3.project_id = p.id) AS pms
        FROM qbo_customers qc JOIN projects p ON p.qbo_customer_id = qc.id WHERE qc.is_project = 1
    """)).mappings().all()
    return {str(r["qbo_id"]): dict(r) for r in rows}


def _crew_covered(conn):
    """Installment ids the crew's QuickBooks bills already cover (burn-down, oldest first)."""
    try:
        from app import snapshots
        got = snapshots.get("crewpay")
    except Exception:
        got = None
    if not got:
        return set(), {}
    rows = got[0].get("rows", [])
    paid_by_sched = {}
    for r in rows:
        ids = [s["id"] for s in r.get("schedules") or []]
        for sid in ids:
            paid_by_sched[sid] = (tuple(ids), float(r.get("paid") or 0))
    insts = defaultdict(list)
    for i in conn.execute(text("""SELECT id, schedule_id, pay_date, amount, status FROM project_payment_installments
                                  WHERE amount <> 0 ORDER BY pay_date, seq, id""")).mappings():
        insts[i["schedule_id"]].append(i)
    covered, done = set(), set()
    for sid, (group, paid) in paid_by_sched.items():
        if group in done:
            continue
        done.add(group)
        left = paid
        rows_ = sorted((i for g in group for i in insts.get(g, [])), key=lambda i: (i["pay_date"] or date.max, i["id"]))
        for i in rows_:
            amt = float(i["amount"] or 0)
            if i["status"] == "paid":
                left -= amt
                continue
            if left >= amt - 0.5:
                covered.add(i["id"])
                left -= amt
            else:
                break
    return covered, {}


@router.get("")
def pay_dates(start: Optional[str] = None, end: Optional[str] = None, user=Depends(require_capability(CAP))):
    today = date.today()
    s = date.fromisoformat(start) if start else today - timedelta(days=30)
    e = date.fromisoformat(end) if end else today + timedelta(days=90)
    back = today - timedelta(days=OVERDUE_BACK_DAYS)
    items = []
    with engine.connect() as conn:
        P = _projects(conn)
        crews = {r[0]: r[1] for r in conn.execute(text("SELECT id, name FROM work_crews")).all()}

        # Invoices
        bal = {str(r[0]): (float(r[1] or 0), r[2]) for r in conn.execute(text("""
            SELECT qbo_id, balance_amt, due_date FROM (
              SELECT qbo_id, balance_amt, due_date, ROW_NUMBER() OVER (PARTITION BY qbo_id ORDER BY id DESC) rn
              FROM qbo_transactions WHERE entity_type = 'Invoice') x WHERE rn = 1""")).all()}
        # Only schedules of accepted estimates (as Ashley's Tracker): a pending
        # estimate's schedule is a plan, not something to send yet.
        accepted = {str(r[0]) for r in conn.execute(text("""
            SELECT qbo_id FROM (SELECT qbo_id, JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.TxnStatus')) st,
                   ROW_NUMBER() OVER (PARTITION BY qbo_id ORDER BY id DESC) rn
              FROM qbo_transactions WHERE entity_type = 'Estimate') x
            WHERE rn = 1 AND st IN ('Accepted', 'Converted', 'Closed')""")).all()}
        for r in conn.execute(text("""
            SELECT m.id, m.label, m.invoice_date, s.estimate_qbo_id, m.due_date, m.expected_paid_date, m.amount, m.status, m.qbo_invoice_id,
                   s.entity_id, s.estimate_doc_number
            FROM project_invoice_milestones m JOIN project_invoice_schedules s ON s.id = m.schedule_id
            WHERE m.status IN ('pending', 'sent', 'partial', 'retainage') AND m.amount > 0
        """)).mappings():
            p = P.get(str(r["entity_id"]))
            if not p or p["status"] == "canceled":
                continue
            if r["status"] == "pending" and str(r["estimate_qbo_id"] or "") not in accepted:
                continue
            if r["status"] == "pending":
                when = r["invoice_date"]
                state = "overdue" if when and when < today else "upcoming"
                what, amount = "Send invoice", float(r["amount"])
            else:
                b, qdue = bal.get(str(r["qbo_invoice_id"]), (float(r["amount"]), None))
                if b <= 0.01:
                    continue
                when = r["expected_paid_date"] or qdue or r["due_date"]
                due = qdue or r["due_date"]
                state = "retainage" if r["status"] == "retainage" else ("late" if due and due < today else "waiting")
                what, amount = ("Retainage held" if r["status"] == "retainage" else "Payment due"), b
            if not when:
                state, when = "no_date", None
            in_window = when and s <= when <= e
            if not (in_window or state in ("overdue", "late", "no_date") and (when is None or when >= back)):
                continue
            items.append({"type": "invoice", "id": r["id"], "date": _d(when), "due": _d(r["due_date"]), "state": state,
                          "what": what, "label": r["label"], "amount": round(amount, 2), "entity_id": str(r["entity_id"]),
                          "job": p["display_name"], "pm": p["pms"], "crew": None, "ref": r["estimate_doc_number"],
                          "editable": r["status"] == "pending", "field": "invoice_date"})

        # Crew pay
        covered, _ = _crew_covered(conn)
        for r in conn.execute(text("""
            SELECT i.id, i.pay_date, i.amount, i.note, i.send_invoice_date, s.entity_id, s.crew_id
            FROM project_payment_installments i JOIN project_payment_schedules s ON s.id = i.schedule_id
            WHERE i.status <> 'paid' AND i.amount > 0
        """)).mappings():
            if r["id"] in covered:
                continue
            p = P.get(str(r["entity_id"]))
            if not p or p["status"] == "canceled":
                continue
            when = r["pay_date"]
            state = "no_date" if not when else ("overdue" if when < today else "upcoming")
            if not ((when and s <= when <= e) or (state in ("overdue", "no_date") and (when is None or when >= back))):
                continue
            items.append({"type": "crew", "id": r["id"], "date": _d(when), "due": None, "state": state, "what": "Pay crew",
                          "label": r["note"] or "Crew payment", "amount": round(float(r["amount"]), 2),
                          "entity_id": str(r["entity_id"]), "job": p["display_name"], "pm": p["pms"],
                          "crew": crews.get(r["crew_id"]) or "No crew set", "ref": None, "editable": True, "field": "pay_date"})

        # Planned expenses (no overdue: these are forecasts, paid through bills)
        for r in conn.execute(text("""
            SELECT id, entity_id, category, week_of, expected_paid_date, amount FROM project_expense_installments
            WHERE amount > 0 AND COALESCE(expected_paid_date, week_of) BETWEEN :s AND :e
        """), {"s": max(s, today - timedelta(days=14)), "e": e}).mappings():
            p = P.get(str(r["entity_id"]))
            if not p or p["status"] == "canceled":
                continue
            when = r["expected_paid_date"] or r["week_of"]
            items.append({"type": "expense", "id": r["id"], "date": _d(when), "due": None,
                          "state": "upcoming" if when >= today else "past", "what": r["category"], "label": f"{r['category']} (planned)",
                          "amount": round(float(r["amount"]), 2), "entity_id": str(r["entity_id"]), "job": p["display_name"],
                          "pm": p["pms"], "crew": None, "ref": None, "editable": True, "field": "week_of"})

    items.sort(key=lambda i: (i["date"] or "0000", i["type"], i["job"] or ""))
    soon = today + timedelta(days=14)
    def tot(f):
        return round(sum(i["amount"] for i in items if f(i)), 2)
    summary = {
        "overdue_send": tot(lambda i: i["type"] == "invoice" and i["state"] == "overdue"),
        "overdue_send_n": sum(1 for i in items if i["type"] == "invoice" and i["state"] == "overdue"),
        "late_paid": tot(lambda i: i["type"] == "invoice" and i["state"] == "late"),
        "late_paid_n": sum(1 for i in items if i["type"] == "invoice" and i["state"] == "late"),
        "crew_overdue": tot(lambda i: i["type"] == "crew" and i["state"] == "overdue"),
        "crew_overdue_n": sum(1 for i in items if i["type"] == "crew" and i["state"] == "overdue"),
        "in_14": tot(lambda i: i["type"] == "invoice" and i["date"] and today.isoformat() <= i["date"] <= soon.isoformat()),
        "out_14": tot(lambda i: i["type"] in ("crew", "expense") and i["date"] and today.isoformat() <= i["date"] <= soon.isoformat()),
    }
    return {"today": today.isoformat(), "start": s.isoformat(), "end": e.isoformat(), "items": items, "summary": summary}
