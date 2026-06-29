"""Cash Flow Forecast API routes."""
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.auth import require_capability
from . import service

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
