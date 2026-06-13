"""Cash Flow Forecast API routes."""
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import require_capability
from . import service

router = APIRouter(prefix="/api/cashflow", tags=["cashflow"])


@router.get("/forecast")
def forecast(
    start_date: Optional[str] = Query(None, description="Week-1 ending date YYYY-MM-DD (defaults to the coming Friday)"),
    opening_balance: float = Query(0.0, description="Starting cash balance for week 1 (until bank sync lands)"),
    _user=Depends(require_capability("page.cashflow")),
):
    sd = None
    if start_date:
        try:
            sd = datetime.strptime(start_date, "%Y-%m-%d").date()
        except ValueError:
            raise HTTPException(status_code=400, detail="start_date must be YYYY-MM-DD")
    return service.generate_forecast(start_date=sd, opening_balance=opening_balance)
