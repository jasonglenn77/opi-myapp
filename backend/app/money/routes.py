"""
Project Money — crew payments and project expenses across ALL projects, by week
(the financials-level view of what each project's Billing tab shows).

  GET /api/money/schedule?weeks_back=4&weeks_ahead=13

  planned  = still-to-pay crew installments and expense rows, from the SAME
             per-project cash cache the Cash Flow page uses (schedule_forecast),
             so the two pages always agree. Dates before this week = overdue.
  actual   = QuickBooks bills and card purchases tagged to a project in the
             window: crew (Contract Labor lines) and expenses by category, with
             what's still open on each bill.

Gated like Cash Flow / the project money tabs (page.cashflow or page.customers).
"""
from datetime import date, timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import text, bindparam

from app.auth import get_current_user
from app.db import engine
from app.permissions import has_capability, PAGE_CASHFLOW, PAGE_CUSTOMERS

router = APIRouter(prefix="/api/money", tags=["money"])

WEEK_END_WEEKDAY = 4  # Friday, like the Cash Flow grid


def _require(user):
    if not any(has_capability(user, c) for c in (PAGE_CASHFLOW, PAGE_CUSTOMERS)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _week_end(d):
    return d + timedelta(days=(WEEK_END_WEEKDAY - d.weekday()) % 7)


def _project_meta(conn, ids):
    if not ids:
        return {}
    rows = conn.execute(text("""
        SELECT qc.qbo_id, qc.display_name,
               MIN(psi.start_date) AS start_date, MAX(psi.end_date) AS end_date,
               (SELECT TRIM(CONCAT(COALESCE(pm.first_name, ''), ' ', COALESCE(pm.last_name, '')))
                FROM project_schedule_items psi2
                JOIN project_schedule_item_project_managers spm
                     ON spm.schedule_item_id = psi2.id AND spm.unassigned_at IS NULL
                JOIN project_managers pm ON pm.id = spm.project_manager_id
                WHERE psi2.project_id = p.id
                ORDER BY spm.is_primary DESC, psi2.start_date DESC LIMIT 1) AS pm
        FROM qbo_customers qc
        LEFT JOIN projects p ON p.qbo_customer_id = qc.id
        LEFT JOIN project_schedule_items psi ON psi.project_id = p.id
        WHERE qc.qbo_id IN :ids
        GROUP BY qc.qbo_id, qc.display_name, p.id
    """).bindparams(bindparam("ids", expanding=True)), {"ids": list(ids)}).mappings().all()
    out = {}
    for r in rows:
        out[str(r["qbo_id"])] = {"name": r["display_name"], "pm": r["pm"] or None,
                                 "start": str(r["start_date"]) if r["start_date"] else None,
                                 "end": str(r["end_date"]) if r["end_date"] else None}
    return out


def _actuals(conn, since, until):
    from app.expenses.routes import _expense_category
    rows = conn.execute(text("""
        SELECT l.line_customer_qbo_id AS e, t.entity_type, t.qbo_id, t.doc_number, t.txn_date,
               t.due_date, t.balance_amt, t.total_amt,
               JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.VendorRef.name')) AS vendor,
               JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.EntityRef.name')) AS payee,
               COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')),
                 SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')), ':', 1)) AS item,
               ROUND(SUM(l.amount), 2) AS amt
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE l.line_customer_qbo_id IS NOT NULL AND t.entity_type IN ('Bill', 'Purchase')
          AND t.txn_date BETWEEN :s AND :u
        GROUP BY l.line_customer_qbo_id, t.id, t.entity_type, t.qbo_id, t.doc_number, t.txn_date,
                 t.due_date, t.balance_amt, t.total_amt, vendor, payee, item
    """), {"s": since, "u": until}).mappings().all()
    out = []
    for r in rows:
        item = r["item"] or ""
        if item.startswith("Contract Labor"):
            kind, cat = "crew", None
        else:
            cat = _expense_category(item)
            if not cat:
                continue  # OH&P / Buffer: margin, not money out
            kind = "expense"
        total, bal = float(r["total_amt"] or 0), float(r["balance_amt"] or 0)
        # open share of this line (a bill is paid as a whole; card purchases are never "open")
        open_amt = round(float(r["amt"] or 0) * (bal / total), 2) if r["entity_type"] == "Bill" and total > 0 else 0.0
        out.append({"entity_id": str(r["e"]), "kind": kind, "category": cat, "item": item,
                    "date": str(r["txn_date"]), "due": str(r["due_date"]) if r["due_date"] else None,
                    "type": "Card" if r["entity_type"] == "Purchase" else "Bill",
                    "doc": r["doc_number"], "vendor": r["vendor"] or r["payee"] or "Unknown",
                    "amount": float(r["amt"] or 0), "open": open_amt})
    return out


@router.get("/schedule")
def schedule(background: BackgroundTasks, weeks_back: int = Query(4, ge=0, le=26),
             weeks_ahead: int = Query(13, ge=1, le=52), user=Depends(get_current_user)):
    _require(user)
    from app.cashflow import schedule_forecast as SF
    payload, meta = SF.get_events()
    if meta.get("stale") and not meta.get("computing"):
        from app.cashflow.routes import _safe_recompute
        background.add_task(_safe_recompute)
    today = date.today()
    this_we = _week_end(today)
    first_we = this_we - timedelta(days=7 * weeks_back)
    last_we = this_we + timedelta(days=7 * (weeks_ahead - 1))
    win_start = first_we - timedelta(days=6)

    cur_start = str(this_we - timedelta(days=6))
    events = [e for e in (payload or {}).get("events", [])
              if e.get("dir") == "out" and e.get("src") in ("crew", "expense")
              and e.get("date") and e["date"] <= str(last_we)]
    # Same owner rule as the Cash Flow page: an overdue crew installment counts as
    # paid when QBO shows that crew vendor paid within its pay window.
    from app.cashflow.service import _match_overdue_crew
    late_crew = [e for e in events if e["src"] == "crew" and e["date"] < cur_start]
    _, still_owed = _match_overdue_crew(late_crew) if late_crew else ([], [])
    owed_ids = {id(e) for e in late_crew if any(e.get("iid") == u.get("iid") and e["date"] == u["date"] for u in still_owed)}
    planned = []
    for e in events:
        late = e["date"] < cur_start
        if e["src"] == "crew" and late and id(e) not in owed_ids:
            continue  # matched to a QBO crew payment: paid, shows under actuals
        planned.append({"entity_id": str(e.get("entity_id")), "kind": e["src"], "date": e["date"],
                        "amount": round(float(e.get("amt") or 0), 2),
                        "full": e.get("full"), "crew": e.get("crew"), "send": e.get("send"),
                        "category": e.get("cat"), "week_of": e.get("week_of"), "overdue": late})
    with engine.connect() as conn:
        actual = _actuals(conn, win_start, min(today, last_we))
        ids = {p["entity_id"] for p in planned} | {a["entity_id"] for a in actual}
        projects = _project_meta(conn, ids)
    from app.gsync.payment_import import PAYROLL_ANCHOR
    next_payday = today + timedelta(days=(-(today - PAYROLL_ANCHOR).days) % 14)
    return {
        "today": str(today), "this_week_end": str(this_we), "next_payday": str(next_payday),
        "week_ends": [str(first_we + timedelta(days=7 * i)) for i in range(weeks_back + weeks_ahead)],
        "planned": planned, "actual": actual, "projects": projects,
        "cache": meta,
    }
