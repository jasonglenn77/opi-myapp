"""
Contractor Payments API.

  GET  /api/crew-payments                     issues, jobs, pay runs, crews
  GET  /api/crew-payments/job/{entity_id}     schedules, bills, change log for a job
  GET  /api/crew-payments/job/{entity_id}/forms   crew forms on file for a job
  POST /api/crew-payments/decision            record a decision on an issue
  POST /api/crew-payments/approval            approve / hold upcoming payments
  POST /api/crew-payments/schedule/{id}/lodging   lodging included in a schedule

Viewing needs page.cashflow (crew pay across jobs is office and owner data).
Decisions on issues are open to the same people; approving or holding a payment
needs financial.signoff. Holding a payment here is a flag for whoever runs
payroll: the app doesn't pay crews, so it can't stop a payment.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.audit import record_audit
from app.auth import get_current_user
from app.db import engine
from app.permissions import has_capability, FINANCIAL_SIGNOFF, PAGE_CASHFLOW, PAGE_CUSTOMERS
from . import forms as FORMS
from . import service as S

router = APIRouter(prefix="/api/crew-payments", tags=["crew-payments"])


def _require(user):
    if not has_capability(user, PAGE_CASHFLOW):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


@router.get("")
def get_all(fresh: bool = False, user=Depends(get_current_user)):
    _require(user)
    return {**S.dataset(force=fresh), "can_sign": has_capability(user, FINANCIAL_SIGNOFF)}


@router.get("/job/{entity_id}")
def job(entity_id: str, user=Depends(get_current_user)):
    _require(user)
    return S.job_detail(entity_id)


@router.get("/job/{entity_id}/forms")
def job_forms(entity_id: str, user=Depends(get_current_user)):
    _require(user)
    with engine.connect() as conn:
        groups = FORMS.for_job(conn, entity_id)
    return {"groups": groups, "can_browse": has_capability(user, PAGE_CUSTOMERS)}


class DecisionIn(BaseModel):
    key: str
    entity_id: Optional[str] = None
    status: Optional[str] = None     # None clears the decision
    amount: Optional[float] = None
    note: Optional[str] = None
    fingerprint: Optional[str] = None


@router.post("/decision")
def decide(body: DecisionIn, user=Depends(get_current_user)):
    _require(user)
    if body.status and body.status not in S.DECISION_LABELS:
        raise HTTPException(status_code=400, detail="Unknown decision")
    with engine.begin() as conn:
        old = conn.execute(text("SELECT status, amount, note FROM review_decisions WHERE ikey = :k"), {"k": body.key}).mappings().first()
        if body.status:
            conn.execute(text("""
                INSERT INTO review_decisions (ikey, area, entity_id, status, amount, note, fingerprint, decided_by)
                VALUES (:k, 'crew_pay', :e, :s, :a, :n, :f, :by)
                ON DUPLICATE KEY UPDATE status = VALUES(status), amount = VALUES(amount), note = VALUES(note),
                  fingerprint = VALUES(fingerprint), decided_by = VALUES(decided_by), decided_at = NOW()
            """), {"k": body.key, "e": body.entity_id, "s": body.status, "a": body.amount,
                   "n": (body.note or "").strip()[:500] or None, "f": body.fingerprint, "by": user.get("email")})
        else:
            conn.execute(text("DELETE FROM review_decisions WHERE ikey = :k"), {"k": body.key})
    record_audit(user, "crew_review.decision", "review_decision", body.key, None,
                 {"entity_id": body.entity_id, "from": dict(old) if old else None, "status": body.status,
                  "amount": body.amount, "note": body.note})
    return {"ok": True}


class ApprovalIn(BaseModel):
    ids: List[int]
    decision: Optional[str] = None   # approved | hold | None to clear
    note: Optional[str] = None


@router.post("/approval")
def approve(body: ApprovalIn, user=Depends(get_current_user)):
    _require(user)
    if not has_capability(user, FINANCIAL_SIGNOFF):
        raise HTTPException(status_code=403, detail="Approving or holding a crew payment needs sign-off access")
    if body.decision not in ("approved", "hold", None):
        raise HTTPException(status_code=400, detail="decision must be approved or hold")
    with engine.begin() as conn:
        for iid in body.ids:
            r = conn.execute(text("""SELECT i.pay_date, i.amount, s.entity_id, s.source_file_name
                                     FROM project_payment_installments i JOIN project_payment_schedules s ON s.id = i.schedule_id
                                     WHERE i.id = :i"""), {"i": iid}).mappings().first()
            if not r:
                continue
            if body.decision:
                conn.execute(text("""
                    INSERT INTO crew_pay_approvals (installment_id, decision, pay_date, amount, note, decided_by)
                    VALUES (:i, :d, :p, :a, :n, :by)
                    ON DUPLICATE KEY UPDATE decision = VALUES(decision), pay_date = VALUES(pay_date), amount = VALUES(amount),
                      note = VALUES(note), decided_by = VALUES(decided_by), decided_at = NOW()
                """), {"i": iid, "d": body.decision, "p": r["pay_date"], "a": r["amount"],
                       "n": (body.note or "").strip()[:500] or None, "by": user.get("email")})
            else:
                conn.execute(text("DELETE FROM crew_pay_approvals WHERE installment_id = :i"), {"i": iid})
            record_audit(user, f"crew_payment.{body.decision or 'approval_cleared'}", "crew_installment", iid, r["source_file_name"],
                         {"entity_id": r["entity_id"], "pay_date": r["pay_date"], "amount": r["amount"], "note": body.note})
    return {"ok": True}


class LodgingIn(BaseModel):
    amount: Optional[float] = None
    note: Optional[str] = None


@router.post("/schedule/{sid}/lodging")
def set_lodging(sid: int, body: LodgingIn, user=Depends(get_current_user)):
    """How much of a schedule's amounts is really lodging. The dates stay as they
    are; the budget check compares the schedule to labor plus this amount."""
    _require(user)
    if body.amount is not None and body.amount < 0:
        raise HTTPException(status_code=400, detail="Amount can't be negative")
    with engine.begin() as conn:
        old = conn.execute(text("SELECT entity_id, lodging_included, source_file_name FROM project_payment_schedules WHERE id = :s"),
                           {"s": sid}).mappings().first()
        if not old:
            raise HTTPException(status_code=404, detail="Schedule not found")
        conn.execute(text("UPDATE project_payment_schedules SET lodging_included = :a, lodging_note = :n WHERE id = :s"),
                     {"a": body.amount or None, "n": (body.note or "").strip()[:255] or None, "s": sid})
    record_audit(user, "crew_schedule.lodging", "crew_schedule", sid, old["source_file_name"],
                 {"entity_id": old["entity_id"], "changes": {"lodging_included": [old["lodging_included"], body.amount]}, "note": body.note})
    return {"ok": True}
