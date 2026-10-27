"""
Job cost vs estimate API (the dashboard's cost panel and its drill-downs).

  GET /api/jobcost/summary?scope=finished&months=12     one row per cost category
  GET /api/jobcost/category/{cat}?scope=&months=          the jobs behind a row
  GET /api/jobcost/job/{entity_id}/{cat}                  estimate lines + bills behind a job's number

scope = finished | active; months = 12 | 24 | 0 (all) for finished jobs.
"""
from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CASHFLOW, PAGE_CUSTOMERS
from . import service as S

router = APIRouter(prefix="/api/jobcost", tags=["jobcost"])


def _require(user):
    if not any(has_capability(user, c) for c in (PAGE_CASHFLOW, PAGE_CUSTOMERS)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _check(scope, cat=None):
    if scope not in ("finished", "active"):
        raise HTTPException(status_code=400, detail="scope must be finished or active")
    if cat is not None and cat not in S.CATEGORIES:
        raise HTTPException(status_code=404, detail="Unknown cost category")


@router.get("/summary")
def summary(scope: str = "finished", months: int = Query(12, ge=0, le=120), fresh: bool = False,
            user=Depends(get_current_user)):
    _require(user)
    _check(scope)
    if fresh:
        S.dataset(force=True)
    return S.summary(scope, months or None)


@router.get("/category/{cat}")
def category(cat: str, scope: str = "finished", months: int = Query(12, ge=0, le=120),
             user=Depends(get_current_user)):
    _require(user)
    _check(scope, cat)
    return {"category": cat, "jobs": S.category_jobs(cat, scope, months or None)}


@router.get("/job/{entity_id}/{cat}")
def job(entity_id: str, cat: str, user=Depends(get_current_user)):
    _require(user)
    _check("finished", cat)
    return S.job_detail(entity_id, cat)
