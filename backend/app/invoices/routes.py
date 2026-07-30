"""
Customer invoice schedule per project (Projects hub Phase 2, Billing & Schedule).

The office bills the customer on the estimate terms — default 35% at PO / 35% at
start / 30% at completion, net-30 — producing dated invoice milestones. These
feed the cashflow INflows (Phase 3). Keyed by project qbo_id (entity_id),
mirroring the crew payment schedule. Gated by page.customers.
"""
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS

router = APIRouter(prefix="/api/invoices", tags=["invoices"])

# (seq, label, pct, date-key). Date keys resolve to PO(award)/start/end below.
DEFAULT_TERMS = [
    (1, "Deposit (at PO)",        35.0, "po"),
    (2, "Mobilization (at start)", 35.0, "start"),
    (3, "Final (at completion)",   30.0, "end"),
]


def _require(user):
    if not has_capability(user, PAGE_CUSTOMERS):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _num(v):
    return float(v) if v is not None else None


def _pd(s):
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def _project_ctx(conn, entity_id):
    """entity_id = project qbo_id → internal id + suggested contract value + dates."""
    qc = conn.execute(text(
        "SELECT id, display_name FROM qbo_customers WHERE qbo_id = :e AND is_project = 1"),
        {"e": entity_id}).mappings().first()
    if not qc:
        return None
    qcid = qc["id"]
    dates = conn.execute(text("""
        SELECT MIN(psi.start_date) AS start_date, MAX(psi.end_date) AS end_date
        FROM projects p JOIN project_schedule_items psi ON psi.project_id = p.id
        WHERE p.qbo_customer_id = :qcid
    """), {"qcid": qcid}).mappings().first()
    contract = None
    try:
        fin = conn.execute(text(
            "SELECT estimate_line_amt, invoice_line_amt FROM project_financial_summary WHERE qbo_customer_id = :qcid"),
            {"qcid": qcid}).mappings().first()
        if fin:
            contract = _num(fin["estimate_line_amt"]) or _num(fin["invoice_line_amt"])
    except Exception:
        contract = None
    return {
        "name": qc["display_name"],
        "start_date": str(dates["start_date"]) if dates and dates["start_date"] else None,
        "end_date": str(dates["end_date"]) if dates and dates["end_date"] else None,
        "contract_value": contract,
    }


def _sched_out(s):
    if not s:
        return None
    return {"id": s["id"], "contract_value": _num(s["contract_value"]),
            "terms_note": s["terms_note"], "net_days": s["net_days"]}


def _ms_out(m):
    return {"id": m["id"], "seq": m["seq"], "label": m["label"], "pct": _num(m["pct"]),
            "invoice_date": str(m["invoice_date"]) if m["invoice_date"] else None,
            "due_date": str(m["due_date"]) if m["due_date"] else None,
            "amount": _num(m["amount"]), "status": m["status"], "note": m["note"]}


def _load(conn, entity_id):
    sched = conn.execute(text(
        "SELECT * FROM project_invoice_schedules WHERE entity_id = :e"), {"e": entity_id}).mappings().first()
    if not sched:
        return None, []
    ms = conn.execute(text(
        "SELECT * FROM project_invoice_milestones WHERE schedule_id = :s ORDER BY seq, id"),
        {"s": sched["id"]}).mappings().all()
    return dict(sched), [dict(m) for m in ms]


@router.get("/project/{entity_id}")
def get_invoice_schedule(entity_id: str, user=Depends(get_current_user)):
    _require(user)
    with engine.connect() as conn:
        ctx = _project_ctx(conn, entity_id)
        if not ctx:
            raise HTTPException(status_code=404, detail="Project not found")
        sched, ms = _load(conn, entity_id)
    scheduled = round(sum(float(m["amount"] or 0) for m in ms), 2)
    invoiced = round(sum(float(m["amount"] or 0) for m in ms if m["status"] in ("sent", "paid")), 2)
    return {
        "entity": {"type": "project", "id": entity_id, "name": ctx["name"]},
        "schedule": _sched_out(sched),
        "milestones": [_ms_out(m) for m in ms],
        "suggested": {"contract_value": ctx["contract_value"],
                      "start_date": ctx["start_date"], "end_date": ctx["end_date"]},
        "totals": {
            "contract_value": (_num(sched["contract_value"]) if sched else ctx["contract_value"]),
            "scheduled": scheduled,
            "invoiced": invoiced,
        },
    }


class GenerateReq(BaseModel):
    contract_value: float
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    net_days: int = 30


@router.post("/project/{entity_id}/generate")
def generate(entity_id: str, req: GenerateReq, user=Depends(get_current_user)):
    _require(user)
    start, end, today = _pd(req.start_date), _pd(req.end_date), date.today()
    contract = float(req.contract_value or 0)
    terms = f"35% at PO / 35% at start / 30% at end, net-{req.net_days}"
    date_for = {"po": start or today, "start": start, "end": end}
    with engine.begin() as conn:
        if not _project_ctx(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        sid = conn.execute(text(
            "SELECT id FROM project_invoice_schedules WHERE entity_id = :e"), {"e": entity_id}).scalar()
        if sid:
            conn.execute(text("UPDATE project_invoice_schedules SET contract_value=:c, terms_note=:t, net_days=:n WHERE id=:id"),
                         {"c": contract, "t": terms, "n": req.net_days, "id": sid})
            conn.execute(text("DELETE FROM project_invoice_milestones WHERE schedule_id=:id"), {"id": sid})
        else:
            sid = conn.execute(text("INSERT INTO project_invoice_schedules (entity_id, contract_value, terms_note, net_days) VALUES (:e,:c,:t,:n)"),
                               {"e": entity_id, "c": contract, "t": terms, "n": req.net_days}).lastrowid
        n = len(DEFAULT_TERMS)
        acc = 0.0
        for idx, (seq, label, pct, key) in enumerate(DEFAULT_TERMS):
            amt = round(contract * pct / 100.0, 2) if idx < n - 1 else round(contract - acc, 2)
            if idx < n - 1:
                acc += amt
            inv_d = date_for.get(key)
            due_d = (inv_d + timedelta(days=req.net_days)) if inv_d else None
            conn.execute(text("""
                INSERT INTO project_invoice_milestones
                  (schedule_id, seq, label, pct, invoice_date, due_date, amount, status, note)
                VALUES (:s, :seq, :l, :p, :iv, :du, :a, 'pending', NULL)
            """), {"s": sid, "seq": seq, "l": label, "p": pct, "iv": inv_d, "du": due_d, "a": amt})
    return get_invoice_schedule(entity_id, user)


class MilestonePatch(BaseModel):
    label: Optional[str] = None
    invoice_date: Optional[str] = None
    due_date: Optional[str] = None
    amount: Optional[float] = None
    status: Optional[str] = None
    note: Optional[str] = None


@router.patch("/milestone/{mid}")
def patch_milestone(mid: int, req: MilestonePatch, user=Depends(get_current_user)):
    _require(user)
    fields = req.model_dump(exclude_unset=True)
    if not fields:
        return {"ok": True}
    sets, params = [], {"id": mid}
    for k, v in fields.items():
        sets.append(f"{k} = :{k}")
        params[k] = (v if v != "" else None)
    with engine.begin() as conn:
        conn.execute(text(f"UPDATE project_invoice_milestones SET {', '.join(sets)} WHERE id = :id"), params)
    return {"ok": True}


@router.post("/schedule/{sid}/milestone")
def add_milestone(sid: int, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        nxt = conn.execute(text("SELECT COALESCE(MAX(seq),0)+1 FROM project_invoice_milestones WHERE schedule_id = :s"),
                           {"s": sid}).scalar()
        conn.execute(text("INSERT INTO project_invoice_milestones (schedule_id, seq, label, status) VALUES (:s,:seq,'New invoice','pending')"),
                     {"s": sid, "seq": nxt})
    return {"ok": True}


@router.delete("/milestone/{mid}")
def delete_milestone(mid: int, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM project_invoice_milestones WHERE id = :id"), {"id": mid})
    return {"ok": True}
