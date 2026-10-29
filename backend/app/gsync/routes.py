"""Data Review API — Google sheets vs QuickBooks vs the app (read + review state)."""
import threading
import time
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from app.audit import record_audit
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS, PAGE_ESTIMATE, PAGE_ASSIGNMENT
from . import b250_cash, review, run

router = APIRouter(prefix="/api/review", tags=["review"])

# The checks take ~15s, so the result is saved (page_snapshots, 0089) and served
# at once; it is rebuilt in the background when the data it reads changes, and
# right after a refresh from Drive / an upload. Review states are applied live.
def _require(user):
    if not any(has_capability(user, c) for c in (PAGE_CUSTOMERS, PAGE_ESTIMATE, PAGE_ASSIGNMENT)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _invalidate():
    from app import snapshots
    snapshots.refresh_async(review.SNAP_KEY, review.build_raw, review.data_sig)


@router.get("")
def get_review(fresh: bool = False, user=Depends(get_current_user)):
    _require(user)
    d = review.cached(force=fresh)
    snap = d.get("snapshot") or {}
    return {**d, "runs": run.last_runs(), "built_at": time.time() - (snap.get("age") or 0),
            "refreshing": bool(snap.get("refreshing")), "b250": b250_cash.latest_meta()}


@router.get("/summary")
def get_summary(user=Depends(get_current_user)):
    """Counts only (the Overview tile) - no item list."""
    _require(user)
    d = review.cached()
    return {"counts": d["counts"], "refreshing": bool((d.get("snapshot") or {}).get("refreshing"))}


@router.post("/b250-upload")
async def b250_upload(file: UploadFile = File(...), user=Depends(get_current_user)):
    """Load a copy of OPI's B250 cash-flow workbook (.xlsx) for the "Cash flow
    sources" checks, until the Drive file is shared with the service account."""
    _require(user)
    if not (file.filename or "").lower().endswith((".xlsx", ".xlsm")):
        raise HTTPException(status_code=400, detail="Upload the B250 as an Excel file (.xlsx) — in Google Sheets: File → Download → Microsoft Excel.")
    content = await file.read()
    if len(content) > 40 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File is larger than 40 MB")
    try:
        out = b250_cash.store(content, "upload", user.get("email") or "user", file_name=file.filename)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Couldn't read the workbook: {str(e)[:200]}")
    _invalidate()
    return out


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
    review.set_state(body.key, body.status, body.note, user, body.fingerprint)   # applied live by overlay()
    return {"ok": True}


@router.post("/overrides/{override_id}/release")
def release_override(override_id: int, user=Depends(get_current_user)):
    """'Use Drive's value' on an App changes not in Drive item (0088)."""
    _require(user)
    from . import overrides
    res = overrides.release(override_id, user.get("email"))
    record_audit(user, "data_review.use_drive_value", "app_override", override_id, None, res)
    _invalidate()
    return res


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
            review.refresh_snapshot()
    threading.Thread(target=work, daemon=True).start()
    return {"started": True}
