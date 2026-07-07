"""
Contractor (crew) payment schedule — C1 (per project).

A project's crew is paid in arrears every 2 weeks until completion. The default
schedule is an EVEN split of the contract labor across the bi-weekly periods
(project length / 2 weeks); each installment is then editable (amount / date /
send-invoice date / status / note) so office staff can reflect real draws.
Paid-to-date / remaining roll up from installment status. Feeds the cash-flow
outflow (eventually replacing the interim job-cost run-rate).

Gated by page.customers (same as the project detail page it lives on).
"""
from datetime import date, timedelta
from math import ceil
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS

router = APIRouter(prefix="/api/payments", tags=["payments"])


def _require(user):
    if not has_capability(user, PAGE_CUSTOMERS):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _project_meta(conn, entity_id):
    """Project name + root customer + schedule dates + the assigned crew (suggested)."""
    cust = conn.execute(text("SELECT display_name, parent_qbo_id, is_project FROM qbo_customers WHERE qbo_id=:id"),
                        {"id": entity_id}).mappings().first()
    if not cust:
        return None
    root, pq, guard = cust["display_name"], cust["parent_qbo_id"], 0
    while pq and guard < 10:
        p = conn.execute(text("SELECT display_name, parent_qbo_id FROM qbo_customers WHERE qbo_id=:id"),
                         {"id": pq}).mappings().first()
        if not p:
            break
        root, pq, guard = p["display_name"], p["parent_qbo_id"], guard + 1

    # projects.qbo_customer_id is the qbo_customers INTERNAL id, not the qbo_id.
    pr = conn.execute(text("""
        SELECT p.id,
               COALESCE(p.start_date, MIN(psi.start_date)) AS start_date,
               COALESCE(p.end_date,   MAX(psi.end_date))   AS end_date
        FROM projects p
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        LEFT JOIN project_schedule_items psi ON psi.project_id = p.id
        WHERE qc.qbo_id = :id GROUP BY p.id
    """), {"id": entity_id}).mappings().first()

    suggested_crew_id = None
    if pr:
        c = conn.execute(text("""
            SELECT wc.id
            FROM project_schedule_item_work_crews swc
            JOIN project_schedule_items psi ON psi.id = swc.schedule_item_id
            JOIN work_crews wc ON wc.id = swc.work_crew_id
            WHERE psi.project_id = :pid AND swc.unassigned_at IS NULL
            ORDER BY swc.is_primary DESC, swc.id LIMIT 1
        """), {"pid": pr["id"]}).scalar()
        suggested_crew_id = c
    return {
        "name": cust["display_name"], "customer_name": root,
        "start_date": str(pr["start_date"]) if pr and pr["start_date"] else None,
        "end_date": str(pr["end_date"]) if pr and pr["end_date"] else None,
        "suggested_crew_id": suggested_crew_id,
        "suggested_contract_labor": _estimate_contract_labor(conn, entity_id),
    }


def _crew_options(conn):
    rows = conn.execute(text("""
        SELECT wc.id, wc.name, pc.name AS parent_name
        FROM work_crews wc
        LEFT JOIN work_crews pc ON pc.id = wc.parent_id
        WHERE wc.parent_id IS NOT NULL AND (wc.is_active = 1 OR wc.is_active IS NULL)
        ORDER BY pc.name, wc.name
    """)).mappings().all()
    return [{"id": r["id"], "name": r["name"], "parent_name": r["parent_name"]} for r in rows]


def _estimate_contract_labor(conn, entity_id):
    """Suggested contract labor = the 'Contract Labor' lines on the project's
    WON estimate(s) — Accepted/Converted only, so pending/un-won estimates and
    change-orders don't inflate it. A project can have a main estimate plus
    accepted change-orders, so these are summed. This is a starting suggestion;
    the true crew offer comes from the job-offer (not yet built) and is editable.
    """
    r = conn.execute(text("""
        SELECT ROUND(COALESCE(SUM(COALESCE(sl.cost_amount, sl.amount)), 0), 2)
        FROM qbo_sales_transaction_lines sl
        JOIN qbo_transactions t ON t.id = sl.transaction_id
        WHERE t.entity_type = 'Estimate' AND sl.item_name = 'Contract Labor'
          AND sl.project_customer_qbo_id = :id
          AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted')
    """), {"id": entity_id}).scalar()
    return float(r or 0)


def _crew_vendor(conn, crew_id):
    """The crew's QBO vendor id (crews carry the vendor at the parent level)."""
    if not crew_id:
        return None
    r = conn.execute(text("""SELECT wc.vendor_qbo_id AS v, pc.vendor_qbo_id AS pv
                             FROM work_crews wc LEFT JOIN work_crews pc ON pc.id = wc.parent_id
                             WHERE wc.id = :id"""), {"id": crew_id}).mappings().first()
    if not r:
        return None
    return r["v"] or r["pv"]


def _qbo_payments(conn, entity_id, vendor_qbo_id):
    """Actual crew payments per QuickBooks = Bill lines from the crew's vendor
    tagged to this project (bi-weekly payroll bills split across projects)."""
    if not vendor_qbo_id:
        return {"available": False, "total": 0.0, "payments": []}
    rows = conn.execute(text("""
        SELECT t.txn_date, t.doc_number, ROUND(SUM(l.amount), 2) AS amt
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE l.line_customer_qbo_id = :id AND t.entity_type = 'Bill' AND t.vendor_qbo_id = :v
        GROUP BY t.id, t.txn_date, t.doc_number ORDER BY t.txn_date
    """), {"id": entity_id, "v": vendor_qbo_id}).mappings().all()
    payments = [{"date": str(r["txn_date"]) if r["txn_date"] else None,
                 "doc": r["doc_number"], "amount": float(r["amt"] or 0)} for r in rows]
    return {"available": True, "total": round(sum(p["amount"] for p in payments), 2), "payments": payments}


def _converted_estimates_with_labor(conn, entity_id):
    """Each Accepted/Converted estimate tagged to the project that has Contract
    Labor > 0 — the main estimate plus each change-order. One schedule per row."""
    # crew "your rate" = cost_amount (falls back to amount when there's no
    # separate cost); amount is the customer rate used for revenue/financials.
    rows = conn.execute(text("""
        SELECT t.qbo_id, t.doc_number, t.txn_date,
               ROUND(SUM(COALESCE(sl.cost_amount, sl.amount)), 2) AS labor
        FROM qbo_sales_transaction_lines sl JOIN qbo_transactions t ON t.id = sl.transaction_id
        WHERE t.entity_type = 'Estimate' AND sl.item_name = 'Contract Labor'
          AND sl.project_customer_qbo_id = :id
          AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted')
        GROUP BY t.qbo_id, t.doc_number, t.txn_date HAVING labor > 0 ORDER BY t.txn_date, t.doc_number
    """), {"id": entity_id}).mappings().all()
    return [{"qbo_id": r["qbo_id"], "doc_number": r["doc_number"],
             "txn_date": str(r["txn_date"]) if r["txn_date"] else None,
             "contract_labor": float(r["labor"] or 0)} for r in rows]


def _load_schedules(conn, entity_id):
    """All schedules for the project, keyed by estimate_qbo_id -> (schedule, installments)."""
    scheds = conn.execute(text("""
        SELECT s.id, s.estimate_qbo_id, s.crew_id, s.contract_labor, s.start_date, s.end_date, s.invoice_lead_days,
               TRIM(CONCAT(COALESCE(wc.name,''), CASE WHEN pc.name IS NOT NULL THEN CONCAT(' (', pc.name, ')') ELSE '' END)) AS crew_name
        FROM project_payment_schedules s
        LEFT JOIN work_crews wc ON wc.id = s.crew_id LEFT JOIN work_crews pc ON pc.id = wc.parent_id
        WHERE s.entity_id = :id
    """), {"id": entity_id}).mappings().all()
    out = {}
    for sched in scheds:
        inst = conn.execute(text("""SELECT id, seq, pay_date, amount, send_invoice_date, status, note
             FROM project_payment_installments WHERE schedule_id=:sid ORDER BY seq, id"""),
            {"sid": sched["id"]}).mappings().all()
        schedule = {
            "id": sched["id"], "estimate_qbo_id": sched["estimate_qbo_id"],
            "crew_id": sched["crew_id"], "crew_name": (sched["crew_name"] or "").strip() or None,
            "contract_labor": float(sched["contract_labor"] or 0),
            "start_date": str(sched["start_date"]) if sched["start_date"] else None,
            "end_date": str(sched["end_date"]) if sched["end_date"] else None,
            "invoice_lead_days": sched["invoice_lead_days"],
        }
        installments = [{
            "id": r["id"], "seq": r["seq"],
            "pay_date": str(r["pay_date"]) if r["pay_date"] else None,
            "amount": float(r["amount"] or 0),
            "send_invoice_date": str(r["send_invoice_date"]) if r["send_invoice_date"] else None,
            "status": r["status"], "note": r["note"],
        } for r in inst]
        out[sched["estimate_qbo_id"]] = (schedule, installments)
    return out


@router.get("/project/{entity_id}")
def get_schedule(entity_id: str, user=Depends(get_current_user)):
    _require(user)
    with engine.connect() as conn:
        meta = _project_meta(conn, entity_id)
        if not meta:
            raise HTTPException(status_code=404, detail="Project not found")
        estimates = _converted_estimates_with_labor(conn, entity_id)
        sched_map = _load_schedules(conn, entity_id)
        crews = _crew_options(conn)
        # actual crew payments (project-level) for the effective crew
        eff_crew = next((s["crew_id"] for (s, _) in sched_map.values() if s and s.get("crew_id")), None) or meta.get("suggested_crew_id")
        qbo = _qbo_payments(conn, entity_id, _crew_vendor(conn, eff_crew))

    packages = []
    for e in estimates:
        s, insts = sched_map.get(e["qbo_id"], (None, []))
        packages.append({**e, "schedule": s, "installments": insts,
                         "scheduled_total": round(sum(i["amount"] for i in insts), 2)})
    return {"entity": {"type": "project", "id": entity_id, **meta},
            "estimates": packages, "qbo": qbo, "crews": crews,
            "totals": {
                "contract_labor": round(sum(e["contract_labor"] for e in estimates), 2),
                "scheduled": round(sum(p["scheduled_total"] for p in packages), 2),
                "paid_qbo": qbo["total"],
            }}


def _parse_d(s):
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        raise HTTPException(status_code=400, detail="bad date")


def _even_split(contract, start, end, lead_days):
    """Bi-weekly installments in arrears; even split, last row carries the rounding."""
    days = (end - start).days if (start and end) else 0
    num = max(1, ceil(days / 14)) if days > 0 else 1
    base = round(contract / num, 2)
    out = []
    for i in range(1, num + 1):
        amt = base if i < num else round(contract - base * (num - 1), 2)
        pay = start + timedelta(days=14 * i)
        out.append({"seq": i, "pay_date": pay, "amount": amt,
                    "send_invoice_date": pay - timedelta(days=lead_days),
                    "status": "pending", "note": "Final" if i == num else f"PMT {i}"})
    return out


class GenerateReq(BaseModel):
    estimate_qbo_id: str
    estimate_doc_number: Optional[str] = None
    contract_labor: float
    start_date: str
    end_date: str
    invoice_lead_days: Optional[int] = 7
    crew_id: Optional[int] = None


@router.post("/project/{entity_id}/generate")
def generate(entity_id: str, body: GenerateReq, user=Depends(get_current_user)):
    """Create/replace one estimate's schedule with an even-split set of installments."""
    _require(user)
    if not body.estimate_qbo_id:
        raise HTTPException(status_code=400, detail="estimate_qbo_id required")
    start, end = _parse_d(body.start_date), _parse_d(body.end_date)
    if not start or not end or end < start:
        raise HTTPException(status_code=400, detail="valid start/end dates required (end on/after start)")
    lead = max(0, int(body.invoice_lead_days or 0))
    rows = _even_split(float(body.contract_labor or 0), start, end, lead)
    with engine.begin() as conn:
        if not _project_meta(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        exists = conn.execute(text("SELECT id FROM project_payment_schedules WHERE entity_id=:e AND estimate_qbo_id=:eq"),
                              {"e": entity_id, "eq": body.estimate_qbo_id}).scalar()
        if exists:
            conn.execute(text("""UPDATE project_payment_schedules SET crew_id=:c, contract_labor=:cl,
                                 estimate_doc_number=:dn, start_date=:s, end_date=:en, invoice_lead_days=:l WHERE id=:id"""),
                         {"c": body.crew_id, "cl": body.contract_labor, "dn": body.estimate_doc_number,
                          "s": start, "en": end, "l": lead, "id": exists})
            sid = exists
            conn.execute(text("DELETE FROM project_payment_installments WHERE schedule_id=:sid"), {"sid": sid})
        else:
            res = conn.execute(text("""INSERT INTO project_payment_schedules
                                 (entity_id, estimate_qbo_id, estimate_doc_number, crew_id, contract_labor,
                                  start_date, end_date, invoice_lead_days, created_by_user_id)
                                 VALUES (:e,:eq,:dn,:c,:cl,:s,:en,:l,:u)"""),
                               {"e": entity_id, "eq": body.estimate_qbo_id, "dn": body.estimate_doc_number,
                                "c": body.crew_id, "cl": body.contract_labor, "s": start, "en": end, "l": lead, "u": user.get("id")})
            sid = res.lastrowid
        for r in rows:
            conn.execute(text("""INSERT INTO project_payment_installments
                                 (schedule_id, seq, pay_date, amount, send_invoice_date, status, note)
                                 VALUES (:sid,:seq,:pd,:amt,:inv,:st,:nt)"""),
                         {"sid": sid, "seq": r["seq"], "pd": r["pay_date"], "amt": r["amount"],
                          "inv": r["send_invoice_date"], "st": r["status"], "nt": r["note"]})
    return {"ok": True}


class SchedulePatch(BaseModel):
    crew_id: Optional[int] = None


@router.patch("/schedule/{sid}")
def patch_schedule(sid: int, body: SchedulePatch, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        n = conn.execute(text("UPDATE project_payment_schedules SET crew_id=:c WHERE id=:id"),
                         {"c": body.crew_id, "id": sid}).rowcount
    if not n:
        raise HTTPException(status_code=404, detail="No schedule to update")
    return {"ok": True}


@router.delete("/schedule/{sid}")
def delete_schedule(sid: int, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM project_payment_installments WHERE schedule_id=:sid"), {"sid": sid})
        conn.execute(text("DELETE FROM project_payment_schedules WHERE id=:id"), {"id": sid})
    return {"ok": True}


class InstallmentBody(BaseModel):
    pay_date: Optional[str] = None
    amount: Optional[float] = None
    send_invoice_date: Optional[str] = None
    status: Optional[str] = None
    note: Optional[str] = None


@router.patch("/installment/{inst_id}")
def patch_installment(inst_id: int, body: InstallmentBody, user=Depends(get_current_user)):
    _require(user)
    sets, params = [], {"id": inst_id}
    if body.pay_date is not None:
        sets.append("pay_date=:pd"); params["pd"] = _parse_d(body.pay_date)
    if body.send_invoice_date is not None:
        sets.append("send_invoice_date=:inv"); params["inv"] = _parse_d(body.send_invoice_date)
    if body.amount is not None:
        sets.append("amount=:amt"); params["amt"] = body.amount
    if body.status is not None:
        if body.status not in ("pending", "paid"):
            raise HTTPException(status_code=400, detail="bad status")
        sets.append("status=:st"); params["st"] = body.status
    if body.note is not None:
        sets.append("note=:nt"); params["nt"] = body.note
    if not sets:
        return {"ok": True}
    with engine.begin() as conn:
        n = conn.execute(text(f"UPDATE project_payment_installments SET {', '.join(sets)} WHERE id=:id"), params).rowcount
    if not n:
        raise HTTPException(status_code=404, detail="Installment not found")
    return {"ok": True}


@router.post("/schedule/{sid}/installment")
def add_installment(sid: int, body: InstallmentBody, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        if not conn.execute(text("SELECT id FROM project_payment_schedules WHERE id=:sid"), {"sid": sid}).scalar():
            raise HTTPException(status_code=404, detail="Schedule not found")
        nxt = conn.execute(text("SELECT COALESCE(MAX(seq),0)+1 FROM project_payment_installments WHERE schedule_id=:sid"),
                           {"sid": sid}).scalar()
        conn.execute(text("""INSERT INTO project_payment_installments
                             (schedule_id, seq, pay_date, amount, send_invoice_date, status, note)
                             VALUES (:sid,:seq,:pd,:amt,:inv,'pending',:nt)"""),
                     {"sid": sid, "seq": nxt, "pd": _parse_d(body.pay_date),
                      "amt": body.amount or 0, "inv": _parse_d(body.send_invoice_date), "nt": body.note})
    return {"ok": True}


@router.delete("/installment/{inst_id}")
def delete_installment(inst_id: int, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM project_payment_installments WHERE id=:id"), {"id": inst_id})
    return {"ok": True}
