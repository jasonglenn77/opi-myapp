"""
Exports.

  GET /api/reports/financials/options   what the filters can be set to
  GET /api/reports/financials/preview   how many projects the filters select
  GET /api/reports/financials.xlsx      the workbook (see financials.py)

Needs page.cashflow: this holds crew pay and margins across every job.
"""
from datetime import date, datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from app.audit import record_audit
from app.auth import get_current_user
from app.db import engine
from app.jobcost import service as JC
from app.crewpay import service as CP
from app.permissions import has_capability, PAGE_CASHFLOW
from . import financials as F

router = APIRouter(prefix="/api/reports", tags=["reports"])
DATE_FIELDS = F.DATE_FIELDS


def _require(user):
    if not has_capability(user, PAGE_CASHFLOW):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _day(v):
    if not v:
        return None
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise HTTPException(status_code=400, detail="Dates must be YYYY-MM-DD")


@router.get("/financials/options")
def options(user=Depends(get_current_user)):
    _require(user)
    jobs = JC.dataset()["jobs"]
    crews = sorted({r["crew"] for r in CP.dataset()["rows"]})
    return {"pms": sorted({j["pm"] for j in jobs if j["pm"]}), "crews": crews,
            "states": [["active", "In progress"], ["finished", "Finished"], ["upcoming", "Not started"]],
            "date_fields": [["best", "Completion (best date)"], ["last_scheduled", "Last scheduled day"], ["marked_complete", "Marked complete"],
                            ["final_invoice", "Last invoice"], ["last_cost", "Last cost"]]}


@router.get("/financials/preview")
def preview(status: Optional[List[str]] = Query(None), pm: Optional[str] = None, crew: Optional[str] = None, date_from: Optional[str] = None,
            date_to: Optional[str] = None, date_field: str = "best", q: Optional[str] = None, user=Depends(get_current_user)):
    _require(user)
    if date_field not in DATE_FIELDS:
        raise HTTPException(status_code=400, detail="Unknown date")
    with engine.connect() as conn:
        jobs = F.select_jobs(conn, status, pm, crew, _day(date_from), _day(date_to), date_field, q)
    return {"projects": len(jobs), "contract": round(sum(j.get("contract") or 0 for j in jobs), 2),
            "flagged_dates": sum(1 for j in jobs if j["done"].get("flag"))}


@router.get("/financials.xlsx")
def export(status: Optional[List[str]] = Query(None), pm: Optional[str] = None, crew: Optional[str] = None, date_from: Optional[str] = None,
           date_to: Optional[str] = None, date_field: str = "best", q: Optional[str] = None, user=Depends(get_current_user)):
    _require(user)
    if date_field not in DATE_FIELDS:
        raise HTTPException(status_code=400, detail="Unknown date")
    body, n = F.build(status, pm, crew, _day(date_from), _day(date_to), date_field, q, who=user.get("email"))
    record_audit(user, "report.financials_export", "report", None, "Financial audit export",
                 {"status": status, "pm": pm, "crew": crew, "from": date_from, "to": date_to, "date_field": date_field, "projects": n})
    name = f"OPI Financial Audit {datetime.now():%Y-%m-%d}.xlsx"
    return Response(body, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
