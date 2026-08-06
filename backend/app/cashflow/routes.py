"""Cash Flow Forecast API routes."""
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth import require_capability
from . import service
from . import schedule_forecast as _sf

router = APIRouter(prefix="/api/cashflow", tags=["cashflow"])


class CategorySettingsRequest(BaseModel):
    excluded: list[str] = []


@router.get("/categories")
def categories(_user=Depends(require_capability("page.cashflow"))):
    """Expense categories with trailing-12-month totals and include/exclude flags."""
    return {"categories": service.list_expense_categories()}


@router.put("/categories")
def update_categories(req: CategorySettingsRequest, _user=Depends(require_capability("page.cashflow"))):
    """Replace the set of categories excluded from operating cash-out."""
    return service.set_excluded_categories(req.excluded)


@router.get("/opening-balance")
def opening_balance(_user=Depends(require_capability("page.cashflow"))):
    """Suggested opening cash balance = sum of QBO bank-account balances."""
    return service.get_bank_balance()


@router.get("/credit-cards")
def credit_cards(_user=Depends(require_capability("page.cashflow"))):
    """QBO Credit Card accounts + balances. Informational/parked — not folded
    into the forecast yet (pending how the owners schedule card payoffs)."""
    return service.get_credit_cards()


@router.get("/forecast")
def forecast(
    start_date: Optional[str] = Query(None, description="Week-1 ending date YYYY-MM-DD (defaults to the coming Friday)"),
    opening_balance: float = Query(0.0, description="Starting cash balance for week 1 (until bank sync lands)"),
    inc_active: bool = Query(True, description="Include projected in-progress un-invoiced balance"),
    inc_awarded: bool = Query(True, description="Include projected awarded/not-started estimates"),
    inc_jobcost: bool = Query(True, description="Include projected job-cost run-rate outflow"),
    _user=Depends(require_capability("page.cashflow")),
):
    sd = None
    if start_date:
        try:
            sd = datetime.strptime(start_date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="start_date must be YYYY-MM-DD")
    return service.generate_forecast(start_date=sd, opening_balance=opening_balance,
                                     inc_active=inc_active, inc_awarded=inc_awarded, inc_jobcost=inc_jobcost)


def _safe_recompute():
    try:
        _sf.recompute_cache()
    except Exception:
        pass  # background best-effort; the next request retries


@router.get("/forecast-v2")
def forecast_v2(
    background: BackgroundTasks,
    start_date: Optional[str] = Query(None, description="Week-1 ending date YYYY-MM-DD (defaults to the coming Friday)"),
    weeks: int = Query(26, ge=1, le=520, description="Horizon in weeks (unbounded — user extends as far as they want)"),
    opening_balance: Optional[float] = Query(None, description="Override the opening balance (defaults to the live QBO bank balance)"),
    _user=Depends(require_capability("page.cashflow")),
):
    """Phase-3b forecast: real bank anchor + committed QBO layers + recurring +
    the project-schedule scheduled layer (cached). Re-bucketable to any horizon.
    If the scheduled cache is stale/absent, a background recompute is kicked off
    and the current (stale/empty) snapshot is returned immediately."""
    sd = None
    if start_date:
        try:
            sd = datetime.strptime(start_date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="start_date must be YYYY-MM-DD")
    result = service.generate_forecast_v2(start_date=sd, weeks=weeks, opening_balance=opening_balance)
    c = result.get("cache") or {}
    if c.get("stale") and not c.get("computing"):
        background.add_task(_safe_recompute)
    return result


@router.post("/forecast-v2/refresh")
def forecast_v2_refresh(background: BackgroundTasks, _user=Depends(require_capability("page.cashflow"))):
    """Force a background recompute of the scheduled-cash cache (the ~30s pass)."""
    _, meta = _sf.get_events()
    if not meta.get("computing"):
        background.add_task(_safe_recompute)
    return {"ok": True, "queued": True, "cache": meta}


@router.get("/actuals")
def actuals(
    start_date: Optional[str] = Query(None, description="Week-1 ending date YYYY-MM-DD (defaults to trailing 13 weeks)"),
    opening_balance: float = Query(0.0, description="Cash balance at the start of week 1"),
    weeks: int = Query(13, ge=1, le=52, description="Number of weeks to show"),
    _user=Depends(require_capability("page.cashflow")),
):
    sd = None
    if start_date:
        try:
            sd = datetime.strptime(start_date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="start_date must be YYYY-MM-DD")
    return service.generate_actuals(start_date=sd, opening_balance=opening_balance, weeks=weeks)
