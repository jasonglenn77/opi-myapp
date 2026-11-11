"""
Margins by PM and completion month (the new Financials view OPI asked for:
"filter by PM and completion month for margins, and export").

  GET /api/margins?months=12

One row per finished job: its completion month (jobcost/completion.py: the
completion form's date, else the last scheduled day), PM, revenue (invoiced,
falling back to the contract), cost so far (bills and card charges by category,
from the job-cost build), profit and margin, and the margin the estimate
planned. The page groups them by PM x month; exporting a group uses the
existing Financials export (/api/reports/financials.xlsx) with those job ids.
"""
from datetime import date

from fastapi import APIRouter, Depends

from app.auth import require_capability
from app.db import engine
from app.jobcost import completion as COMP, service as JC

router = APIRouter(prefix="/api/margins", tags=["margins"])


@router.get("")
def margins(months: int = 12, user=Depends(require_capability("page.financials"))):
    months = max(1, min(int(months), 36))
    today = date.today()
    y, m = today.year, today.month - (months - 1)
    while m <= 0:
        m += 12
        y -= 1
    since = date(y, m, 1)
    with engine.connect() as conn:
        done = COMP.load(conn)
    rows = []
    for j in JC.dataset()["jobs"]:
        if j["state"] != "finished":
            continue
        dd = done.get(str(j["id"])) or {}
        best = dd.get("best")
        if not best or best < since:
            continue
        cost = sum(float(v or 0) for v in (j.get("act") or {}).values())
        est_cost = sum(float(v or 0) for v in (j.get("est") or {}).values())
        contract = float(j.get("contract") or 0)
        rev = float(j.get("invoiced") or 0) or contract
        profit = rev - cost
        rows.append({
            "id": str(j["id"]), "name": j["name"], "pm": j.get("pm") or "No PM", "month": best.isoformat()[:7],
            "completed": best.isoformat(), "completed_source": dd.get("best_source"),
            "contract": round(contract, 2), "revenue": round(rev, 2), "cost": round(cost, 2), "profit": round(profit, 2),
            "margin": round(profit / rev * 100, 1) if rev else None,
            "planned_margin": round((contract - est_cost) / contract * 100, 1) if contract else None,
            "open_ar": round(float(j.get("open_ar") or 0), 2),
        })
    rows.sort(key=lambda r: (r["month"], r["pm"], r["name"]), reverse=True)
    return {"since": since.isoformat(), "rows": rows}
