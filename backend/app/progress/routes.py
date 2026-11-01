"""
Progress Checks API.

  GET  /api/progress                       every job, its buckets and checkpoints
  POST /api/progress/{entity_id}/settings  sign-offs on / off / by size for a project
  POST /api/progress/{entity_id}/signoff   sign off (or hold) a checkpoint

Viewing needs page.cashflow or page.customers, like Project Money. Signing off
and switching sign-offs need financial.signoff.
"""
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.audit import record_audit
from app.auth import get_current_user
from app.db import engine
from app.permissions import has_capability, FINANCIAL_SIGNOFF, PAGE_CASHFLOW, PAGE_CUSTOMERS
from . import service as S

router = APIRouter(prefix="/api/progress", tags=["progress"])


def _require(user):
    if not any(has_capability(user, c) for c in (PAGE_CASHFLOW, PAGE_CUSTOMERS)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _require_sign(user):
    if not has_capability(user, FINANCIAL_SIGNOFF):
        raise HTTPException(status_code=403, detail="This needs sign-off access")


@router.get("")
def get_all(fresh: bool = False, user=Depends(get_current_user)):
    _require(user)
    return {**S.dataset(force=fresh), "can_sign": has_capability(user, FINANCIAL_SIGNOFF)}


class SettingIn(BaseModel):
    signoff: Optional[bool] = None   # None = by contract size


@router.post("/{entity_id}/settings")
def settings(entity_id: str, body: SettingIn, user=Depends(get_current_user)):
    _require_sign(user)
    with engine.begin() as conn:
        if body.signoff is None:
            conn.execute(text("DELETE FROM progress_settings WHERE entity_id = :e"), {"e": entity_id})
        else:
            conn.execute(text("""
                INSERT INTO progress_settings (entity_id, signoff, set_by) VALUES (:e, :s, :by)
                ON DUPLICATE KEY UPDATE signoff = VALUES(signoff), set_by = VALUES(set_by), set_at = NOW()
            """), {"e": entity_id, "s": 1 if body.signoff else 0, "by": user.get("email")})
    record_audit(user, "progress.settings", "project", entity_id, None, {"signoff": body.signoff})
    return {"ok": True}


class SignoffIn(BaseModel):
    milestone: int
    decision: Optional[str] = None   # approved | hold | None to clear
    note: Optional[str] = None


@router.post("/{entity_id}/signoff")
def signoff(entity_id: str, body: SignoffIn, user=Depends(get_current_user)):
    _require_sign(user)
    if body.milestone not in S.MILESTONES:
        raise HTTPException(status_code=400, detail="Unknown checkpoint")
    if body.decision not in ("approved", "hold", None):
        raise HTTPException(status_code=400, detail="decision must be approved or hold")
    if body.decision == "hold" and not (body.note or "").strip():
        raise HTTPException(status_code=400, detail="Say why it is on hold")
    job = next((j for j in S.dataset()["jobs"] if j["id"] == entity_id), None)
    if not job:
        raise HTTPException(status_code=404, detail="Project not found")
    point = next(p for p in job["points"] if p["milestone"] == body.milestone)
    numbers = {"checks": point["checks"], "invoiced": point["invoiced"], "invoice_planned": point["invoice_planned"],
               "buckets": job["buckets"], "contract": job["contract"]}
    with engine.begin() as conn:
        if body.decision:
            conn.execute(text("""
                INSERT INTO progress_signoffs (entity_id, milestone, decision, note, numbers, signed_by)
                VALUES (:e, :m, :d, :n, :j, :by)
                ON DUPLICATE KEY UPDATE decision = VALUES(decision), note = VALUES(note), numbers = VALUES(numbers),
                  signed_by = VALUES(signed_by), signed_at = NOW()
            """), {"e": entity_id, "m": body.milestone, "d": body.decision, "n": (body.note or "").strip()[:500] or None,
                   "j": json.dumps(numbers, default=str), "by": user.get("email")})
        else:
            conn.execute(text("DELETE FROM progress_signoffs WHERE entity_id = :e AND milestone = :m"),
                         {"e": entity_id, "m": body.milestone})
    record_audit(user, f"progress.signoff_{body.decision or 'cleared'}", "project", entity_id, job["name"],
                 {"milestone": body.milestone, "note": body.note, "numbers": numbers})
    return {"ok": True}
