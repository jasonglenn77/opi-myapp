"""
Assumptions API (migration 0084) — the transparency page for every average and
rule the app uses to place dates and money.

  GET    /api/assumptions                measured values + evidence + fixed rules
  PATCH  /api/assumptions/{akey}         owner override (or clear it)
  POST   /api/assumptions/recalibrate    re-measure from the synced QBO data
  POST   /api/assumptions/apply          re-spread auto (never hand-edited)
                                         expense rows on active projects

Viewing: anyone who can see Cash Flow or the project money (page.cashflow /
page.customers). Changing: page.settings (owners/admins).
"""
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.audit import record_audit
from app.auth import get_current_user
from app.db import engine
from app.permissions import has_capability, PAGE_CASHFLOW, PAGE_CUSTOMERS, PAGE_SETTINGS
from . import calibrate as CAL, catalog

router = APIRouter(prefix="/api/assumptions", tags=["assumptions"])


def _require_view(user):
    if not any(has_capability(user, c) for c in (PAGE_CASHFLOW, PAGE_CUSTOMERS, PAGE_SETTINGS)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _require_edit(user):
    if not has_capability(user, PAGE_SETTINGS):
        raise HTTPException(status_code=403, detail="Only owners/admins can change assumptions")


def _j(v):
    if v is None or isinstance(v, (dict, list)):
        return v
    return json.loads(v)


@router.get("")
def get_assumptions(user=Depends(get_current_user)):
    _require_view(user)
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT akey, grp, label, calibrated, basis, override_val, override_note,
                   override_by, override_at, computed_at
            FROM forecast_assumptions ORDER BY grp, akey
        """)).mappings().all()
        usage = {r[0]: {"auto_profile": int(r[1] or 0) + int(r[5] or 0), "auto_even": int(r[2] or 0),
                        "edited": int(r[3] or 0), "projects": int(r[4] or 0), "auto_lodging": int(r[5] or 0)}
                 for r in conn.execute(text("""
            SELECT category, SUM(basis = 'auto_profile' AND edited = 0), SUM(basis = 'auto_even' AND edited = 0),
                   SUM(edited = 1), COUNT(DISTINCT entity_id), SUM(basis = 'auto_lodging' AND edited = 0)
            FROM project_expense_installments GROUP BY category
        """)).all()}
        rules = catalog.rules(conn)
    items = []
    for r in rows:
        cat = r["akey"].split(".", 1)[-1]
        items.append({
            "key": r["akey"], "group": r["grp"], "label": r["label"], "category": cat,
            "calibrated": _j(r["calibrated"]), "basis": _j(r["basis"]),
            "override": _j(r["override_val"]), "override_note": r["override_note"],
            "override_by": r["override_by"],
            "override_at": str(r["override_at"]) if r["override_at"] else None,
            "computed_at": str(r["computed_at"]) if r["computed_at"] else None,
            "usage": usage.get(cat) if r["grp"] == "expense_timing" else None,
        })
    return {"items": items, "rules": rules, "buckets": CAL.BUCKETS,
            "window_months": CAL.WINDOW_MONTHS, "min_projects": CAL.MIN_PROJECTS,
            "can_edit": has_capability(user, PAGE_SETTINGS)}


class OverrideBody(BaseModel):
    override: Optional[dict] = None    # None clears the override
    note: Optional[str] = None


@router.patch("/{akey}")
def set_override(akey: str, body: OverrideBody, user=Depends(get_current_user)):
    _require_edit(user)
    ov = body.override
    if ov is not None and akey.startswith("expense_timing."):
        prof = ov.get("profile")
        if prof is not None:
            if set(prof) - set(CAL.BUCKET_KEYS) or any(float(v) < 0 for v in prof.values()):
                raise HTTPException(status_code=400, detail="Unknown bucket or negative share")
            s = sum(float(v) for v in prof.values())
            if s <= 0:
                raise HTTPException(status_code=400, detail="Shares must add up to more than zero")
            ov["profile"] = {k: round(float(prof.get(k, 0)) / s, 4) for k in CAL.BUCKET_KEYS}
        if ov.get("paid_lag_days") is not None and not (0 <= float(ov["paid_lag_days"]) <= 180):
            raise HTTPException(status_code=400, detail="Payment lag must be 0-180 days")
    if ov is not None and akey == "invoice_timing":
        for k, v in (ov.get("kinds") or {}).items():
            if k not in CAL.INVOICE_KINDS:
                raise HTTPException(status_code=400, detail=f"Unknown invoice kind {k}")
            if v.get("paid_lag_days") is not None and not (0 <= float(v["paid_lag_days"]) <= 180):
                raise HTTPException(status_code=400, detail="Days to pay must be 0-180")
            if v.get("offset_days") is not None and not (-180 <= float(v["offset_days"]) <= 180):
                raise HTTPException(status_code=400, detail="Offset must be -180 to 180 days")
        if ov.get("single_below") is not None and float(ov["single_below"]) < 0:
            raise HTTPException(status_code=400, detail="Amount can't be negative")
    with engine.begin() as conn:
        n = conn.execute(text("""
            UPDATE forecast_assumptions
            SET override_val = :v, override_note = :n, override_by = :by,
                override_at = IF(:v IS NULL, NULL, NOW())
            WHERE akey = :k
        """), {"v": json.dumps(ov) if ov is not None else None, "n": body.note if ov is not None else None,
               "by": user.get("email") if ov is not None else None, "k": akey}).rowcount
    if not n:
        raise HTTPException(status_code=404, detail="Unknown assumption")
    CAL._cache.clear()
    record_audit(user, "assumption.override" if ov is not None else "assumption.reset",
                 "assumption", akey, akey, {"override": ov, "note": body.note})
    if akey == "invoice_timing":   # app-dated planned invoices pick up the change now
        from app.billing.invoice_dates import redate_all
        redate_all()
    return get_assumptions(user)


@router.post("/recalibrate")
def recalibrate(user=Depends(get_current_user)):
    _require_edit(user)
    res = CAL.recalibrate()
    record_audit(user, "assumption.recalibrate", "assumption", None, "all", res)
    return get_assumptions(user)


def apply_to_schedules():
    """Re-spread expense rows that were generated (never hand-edited) on
    projects that are not complete, using the current assumptions. A category
    with any hand-edited row is left alone, same as the project Refresh."""
    import app.billing.routes as B
    from app.invoices.routes import _project_ctx
    rebuilt = 0
    with engine.begin() as conn:
        ids = conn.execute(text("""
            SELECT DISTINCT entity_id FROM project_expense_installments
            GROUP BY entity_id, category HAVING MAX(edited) = 0
        """)).scalars().all()
        for e in ids:
            if B._canonical_status(conn, e) == "completed":
                continue
            ctx = _project_ctx(conn, e)
            if not ctx:
                continue
            cats = conn.execute(text("""
                SELECT category FROM project_expense_installments WHERE entity_id = :e
                GROUP BY category HAVING MAX(edited) = 0
            """), {"e": e}).scalars().all()
            for c in cats:
                conn.execute(text("DELETE FROM project_expense_installments WHERE entity_id = :e AND category = :c"),
                             {"e": e, "c": c})
            B._ensure_expense_installments(conn, e, ctx)
            rebuilt += 1
    from app.billing.invoice_dates import redate_all   # 0087: planned invoice dates too
    inv = redate_all()
    try:
        from app.cashflow.schedule_forecast import touch_dirty
        touch_dirty()
    except Exception:
        pass
    return {"projects_rebuilt": rebuilt, "invoices": inv}


@router.post("/apply")
def apply(user=Depends(get_current_user)):
    _require_edit(user)
    res = apply_to_schedules()
    record_audit(user, "assumption.apply", "assumption", None, "expense schedules", res)
    return res
