"""Data Review API — Google sheets vs QuickBooks vs the app (read + review state)."""
import threading
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS, PAGE_ESTIMATE, PAGE_ASSIGNMENT
from . import review, run

router = APIRouter(prefix="/api/review", tags=["review"])

# The comparison reads a few thousand rows (~15s), so it's cached; a refresh
# from Drive or a nightly sync drops the cache. Review state is applied live.
_cache = {"at": 0, "data": None}
_TTL = 600


def _require(user):
    if not any(has_capability(user, c) for c in (PAGE_CUSTOMERS, PAGE_ESTIMATE, PAGE_ASSIGNMENT)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _items(force=False):
    if force or not _cache["data"] or time.time() - _cache["at"] > _TTL:
        _cache["data"], _cache["at"] = review.build(), time.time()
    return _cache["data"]


@router.get("")
def get_review(fresh: bool = False, user=Depends(get_current_user)):
    _require(user)
    d = _items(force=fresh)
    return {**d, "runs": run.last_runs(), "built_at": _cache["at"]}


class StateIn(BaseModel):
    key: str
    status: str             # open | fixed | ignored
    fingerprint: Optional[str] = None
    note: Optional[str] = None


@router.get("/runs")
def runs(user=Depends(get_current_user)):
    """Last refresh per source (B151, Job Schedule) — cheap, for status lines."""
    _require(user)
    return run.last_runs()


@router.post("/state")
def set_state(body: StateIn, user=Depends(get_current_user)):
    _require(user)
    if body.status not in ("open", "fixed", "ignored"):
        raise HTTPException(status_code=400, detail="status must be open, fixed or ignored")
    review.set_state(body.key, body.status, body.note, user, body.fingerprint)
    if _cache["data"]:
        for it in _cache["data"]["items"]:
            if it["key"] == body.key:
                it["state"], it["note"], it["state_by"] = body.status, body.note, user.get("email")
    return {"ok": True}


@router.post("/refresh")
def refresh(source: Optional[str] = None, user=Depends(get_current_user)):
    """Re-read the B151 + Job Schedule from Drive (and mirror the B151 into the
    Pipeline) in the background; the page polls /api/review for the result.
    source=b151 refreshes only the B151 (the Pipeline page's button)."""
    _require(user)
    who = user.get("email") or "user"

    def work():
        try:
            if source == "b151":
                run.refresh_b151(who, actor=user)
            else:
                run.refresh_all(who=who, actor=user)
        finally:
            _cache["data"] = None
    threading.Thread(target=work, daemon=True).start()
    return {"started": True}
