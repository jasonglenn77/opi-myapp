"""Cash Plan API (the owners' cash view; logic in app/cashflow/plan.py).

  GET /api/cash-plan?weeks=13&biweekly=1&anchor=YYYY-MM-DD&min_prob=40
"""
from typing import Optional

from fastapi import APIRouter, Depends

from app.auth import require_capability
from app.cashflow import plan as PLAN

router = APIRouter(prefix="/api/cash-plan", tags=["cash-plan"])


@router.get("")
def cash_plan(weeks: int = 13, biweekly: int = 1, anchor: Optional[str] = None, min_prob: int = 40,
              user=Depends(require_capability("page.cashflow"))):
    weeks = max(4, min(int(weeks), 26))
    return PLAN.build(weeks=weeks, biweekly=bool(biweekly), anchor=anchor or None, min_prob=max(20, min(int(min_prob), 80)))
