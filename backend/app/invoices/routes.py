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
from app.audit import diff_fields, record_audit
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
            "expected_paid_date": str(m["expected_paid_date"]) if m.get("expected_paid_date") else None,
            "amount": _num(m["amount"]), "status": m["status"], "note": m["note"]}


def _ms_entity(conn, mid=None, sid=None):
    """(entity_id, project name) for a milestone id or schedule id — stamped on
    audit entries so a project's billing history can be listed."""
    r = conn.execute(text(f"""
        SELECT s.entity_id, qc.display_name FROM project_invoice_schedules s
        {"JOIN project_invoice_milestones m ON m.schedule_id = s.id" if mid else ""}
        LEFT JOIN qbo_customers qc ON qc.qbo_id = s.entity_id
        WHERE {"m.id = :i" if mid else "s.id = :i"}
    """), {"i": mid or sid}).first()
    return (r[0], r[1]) if r else (None, None)


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


def req_via(req):
    return getattr(req, "via", None)


class MilestonePatch(BaseModel):
    label: Optional[str] = None
    invoice_date: Optional[str] = None
    due_date: Optional[str] = None
    # Realistic "cash lands" date; blank/NULL falls back to the due date (the
    # cash-flow forecast uses COALESCE(expected_paid_date, due_date, invoice_date)).
    expected_paid_date: Optional[str] = None
    pct: Optional[float] = None
    amount: Optional[float] = None
    status: Optional[str] = None
    note: Optional[str] = None
    via: Optional[str] = None   # which screen made the edit (audit only)
    # 0087: true = hand the dates back to the app (job dates + billing history)
    auto_dates: Optional[bool] = None


@router.patch("/milestone/{mid}")
def patch_milestone(mid: int, req: MilestonePatch, user=Depends(get_current_user)):
    _require(user)
    fields = req.model_dump(exclude_unset=True)
    fields.pop("via", None)
    if fields.pop("auto_dates", None):
        with engine.begin() as conn:
            old = conn.execute(text("SELECT * FROM project_invoice_milestones WHERE id = :id"), {"id": mid}).mappings().first()
            if not old:
                raise HTTPException(status_code=404, detail="Milestone not found")
            if old["qbo_invoice_id"]:
                raise HTTPException(status_code=400, detail="This row is a QuickBooks invoice; its dates follow the invoice")
            conn.execute(text("UPDATE project_invoice_milestones SET date_basis = 'auto_history' WHERE id = :id"), {"id": mid})
            ent, pname = _ms_entity(conn, mid=mid)
            from app.billing.invoice_dates import redate_project
            redate_project(conn, ent, audit=False)
            new = conn.execute(text("SELECT invoice_date, due_date, expected_paid_date FROM project_invoice_milestones WHERE id = :id"),
                               {"id": mid}).mappings().first()
        record_audit(user, "billing.milestone_auto_dates", "invoice_milestone", mid, old["label"],
                     {"entity_id": ent, "project": pname, "via": req_via(req),
                      "changes": {f: [str(old[f]) if old[f] else None, str(new[f]) if new[f] else None]
                                  for f in ("invoice_date", "due_date", "expected_paid_date")}})
        if not fields:
            return {"ok": True}
    if not fields:
        return {"ok": True}
    sets, params = ["edited = 1"], {"id": mid}
    if any(f in fields for f in ("invoice_date", "due_date", "expected_paid_date")):
        sets.append("date_basis = 'manual'")   # 0087: a person's date is never moved automatically
    # A hand-set amount / % is an override the schedule's automatic true-up
    # (billing/align.py) must respect; a date/label edit isn't (the row's amount
    # keeps following the estimate so the schedule still adds up).
    if "amount" in fields or "pct" in fields:
        sets.append("amount_edited = 1")
    for k, v in fields.items():
        sets.append(f"{k} = :{k}")
        params[k] = (v if v != "" else None)
    with engine.begin() as conn:
        old = conn.execute(text(
            "SELECT * FROM project_invoice_milestones WHERE id = :id"), {"id": mid}).mappings().first()
        # The UPDATE bumps updated_at (ON UPDATE CURRENT_TIMESTAMP), which is what
        # invalidates the cash-flow schedule caches on data edits.
        conn.execute(text(f"UPDATE project_invoice_milestones SET {', '.join(sets)} WHERE id = :id"), params)
        ent, pname = _ms_entity(conn, mid=mid)
    changes = diff_fields(dict(old) if old else {}, {k: params[k] for k in fields}, list(fields))
    if changes:
        record_audit(user, "billing.milestone_update", "invoice_milestone", mid,
                     (old or {}).get("label"),
                     {"changes": changes, "entity_id": ent, "project": pname, "via": req_via(req)})
    return {"ok": True}


@router.post("/schedule/{sid}/milestone")
def add_milestone(sid: int, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        nxt = conn.execute(text("SELECT COALESCE(MAX(seq),0)+1 FROM project_invoice_milestones WHERE schedule_id = :s"),
                           {"s": sid}).scalar()
        new_id = conn.execute(text("INSERT INTO project_invoice_milestones (schedule_id, seq, label, status) VALUES (:s,:seq,'New invoice','pending')"),
                              {"s": sid, "seq": nxt}).lastrowid
        ent, pname = _ms_entity(conn, sid=sid)
    record_audit(user, "billing.milestone_add", "invoice_milestone", new_id, "New invoice",
                 {"entity_id": ent, "project": pname, "schedule_id": sid})
    return {"ok": True, "id": new_id}


@router.post("/schedule/{sid}/auto-balance")
def auto_balance(sid: int, user=Depends(get_current_user)):
    """'Balance automatically': drop the hand-set amount flag on the schedule's
    not-yet-invoiced rows, then re-align — so they true up to the current
    estimate again (dates/labels kept). Invoice rows are untouched."""
    _require(user)
    from app.billing.align import align_project, record_alignment
    with engine.begin() as conn:
        ent, pname = _ms_entity(conn, sid=sid)
        if not ent:
            raise HTTPException(status_code=404, detail="Schedule not found")
        ids = [r[0] for r in conn.execute(text(
            "SELECT id FROM project_invoice_milestones WHERE schedule_id = :s AND amount_edited = 1 "
            "AND qbo_invoice_id IS NULL"), {"s": sid}).all()]
        if ids:
            conn.execute(text(
                "UPDATE project_invoice_milestones SET amount_edited = 0 WHERE schedule_id = :s "
                "AND amount_edited = 1 AND qbo_invoice_id IS NULL"), {"s": sid})
        audits = align_project(conn, ent)
    record_audit(user, "billing.schedule_auto_balance", "project", ent, pname,
                 {"entity_id": ent, "project": pname, "schedule_id": sid, "cleared_overrides": ids})
    record_alignment(audits)
    return {"ok": True, "cleared": len(ids)}


@router.delete("/milestone/{mid}")
def delete_milestone(mid: int, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        old = conn.execute(text("SELECT * FROM project_invoice_milestones WHERE id = :id"),
                           {"id": mid}).mappings().first()
        ent, pname = _ms_entity(conn, mid=mid)
        conn.execute(text("DELETE FROM project_invoice_milestones WHERE id = :id"), {"id": mid})
    if old:
        record_audit(user, "billing.milestone_delete", "invoice_milestone", mid, old["label"],
                     {"entity_id": ent, "project": pname, "deleted": {
                         k: (str(old[k]) if old[k] is not None else None)
                         for k in ("label", "pct", "amount", "invoice_date", "due_date", "expected_paid_date")}})
    return {"ok": True}


# ── Expected-paid date on an ACTUAL open QuickBooks invoice (0079) ───────────
# The cash-flow forecast places each open invoice on its expected-paid date:
# this override > the aligned milestone's expected_paid_date > the QBO due date.
# Never writes to QuickBooks — stored in the app only.
class QboInvoiceExpected(BaseModel):
    expected_paid_date: Optional[str] = None   # blank clears (back to due date)
    note: Optional[str] = None
    via: Optional[str] = None


@router.patch("/qbo-invoice/{qbo_id}/expected")
def patch_qbo_invoice_expected(qbo_id: str, req: QboInvoiceExpected, user=Depends(get_current_user)):
    _require(user)
    fields = req.model_dump(exclude_unset=True)
    d = fields.get("expected_paid_date")
    d = (str(d)[:10] if d else None)
    if d:
        try:
            date.fromisoformat(d)
        except ValueError:
            raise HTTPException(status_code=400, detail="expected_paid_date must be YYYY-MM-DD")
    actor = (user or {}).get("email") if isinstance(user, dict) else getattr(user, "email", None)
    with engine.begin() as conn:
        inv = conn.execute(text(
            "SELECT qbo_id, doc_number, customer_qbo_id, due_date FROM qbo_transactions "
            "WHERE entity_type = 'Invoice' AND qbo_id = :q"), {"q": qbo_id}).mappings().first()
        if not inv:
            raise HTTPException(status_code=404, detail="Invoice not found")
        old = conn.execute(text(
            "SELECT expected_paid_date FROM qbo_invoice_expected_paid WHERE invoice_qbo_id = :q"),
            {"q": qbo_id}).scalar()
        conn.execute(text("""
            INSERT INTO qbo_invoice_expected_paid (invoice_qbo_id, entity_id, expected_paid_date, note, updated_by)
            VALUES (:q, :e, :d, :n, :u)
            ON DUPLICATE KEY UPDATE entity_id = VALUES(entity_id), expected_paid_date = VALUES(expected_paid_date),
                                    note = COALESCE(VALUES(note), note), updated_by = VALUES(updated_by)
        """), {"q": qbo_id, "e": inv["customer_qbo_id"], "d": d, "n": fields.get("note"), "u": actor})
    record_audit(user, "billing.invoice_expected_paid", "qbo_invoice", qbo_id, f"Invoice #{inv['doc_number'] or qbo_id}",
                 {"entity_id": inv["customer_qbo_id"], "via": fields.get("via"),
                  "changes": {"expected_paid_date": [str(old) if old else None, d]}})
    return {"ok": True, "expected_paid_date": d, "due_date": str(inv["due_date"]) if inv["due_date"] else None}
