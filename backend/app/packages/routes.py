"""Work packages API (2026-11-18): assignments per estimate. See service.py.

  GET   /api/packages/{eid}                              packages, estimates, project timeline
  POST  /api/packages/{eid}/estimate/{q}/package         {package_id | "new"} move an estimate
  POST  /api/packages/{eid}/pm                           {pm_id, estimates: [..] | null = all}
  POST  /api/packages/{eid}/estimate/{q}/crew            {crew_id} (needs the package's dates)
  POST  /api/packages/{eid}/package/{pid}/line           a new date range (a break in the work)
  PATCH /api/packages/{eid}/package/{pid}                {name}
  POST  /api/packages/{eid}/overage                      {days} the project's overage days
"""
import functools
import time
from typing import List, Optional, Union

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

from app.audit import record_audit
from app.auth import get_current_user
from app.db import engine
from app.permissions import can_edit_assignment
from . import service as S

router = APIRouter(prefix="/api/packages", tags=["packages"])


def _retry(fn):
    """Run again on a MySQL deadlock / lock wait (two saves on one project at
    the same moment): every action here is safe to repeat."""
    @functools.wraps(fn)
    def run(*a, **kw):
        for i in range(4):
            try:
                return fn(*a, **kw)
            except OperationalError as e:
                code = getattr(getattr(e, "orig", None), "args", [None])[0]
                if code not in (1213, 1205) or i == 3:
                    raise
                time.sleep(0.2 * (i + 1))
    return run


def _cid(conn, eid):
    r = conn.execute(text("SELECT id, display_name FROM qbo_customers WHERE qbo_id = :e"), {"e": eid}).mappings().first()
    if not r:
        raise HTTPException(404, "Project not found")
    return r


def _guard(user, eid):
    with engine.connect() as conn:
        r = _cid(conn, eid)
    if not can_edit_assignment(user, r["id"]):
        raise HTTPException(403, "You can't edit this project's assignment")
    return r


def _out(eid):
    with engine.begin() as conn:
        return S.bundle(conn, eid)


@router.get("/{eid}")
@_retry
def get_packages(eid: str, user=Depends(get_current_user)):
    return _out(eid)


class MoveReq(BaseModel):
    package_id: Union[int, str]


@router.post("/{eid}/estimate/{q}/package")
@_retry
def move(eid: str, q: str, req: MoveReq, user=Depends(get_current_user)):
    proj = _guard(user, eid)
    with engine.begin() as conn:
        S.ensure_all(conn, [eid])
        old = conn.execute(text("SELECT phase_id FROM project_estimate_phase WHERE entity_id = :e AND estimate_qbo_id = :q"),
                           {"e": eid, "q": q}).scalar()
        try:
            pid = S.move_estimate(conn, eid, q, req.package_id if req.package_id == "new" else int(req.package_id))
        except ValueError as e:
            raise HTTPException(400, str(e))
    S.sync_lines(eid, int(user["id"]), package_ids={pid})
    record_audit(user, "packages.move", "project", eid, proj["display_name"], {"estimate": q, "from": old, "to": pid})
    return _out(eid)


class PmReq(BaseModel):
    pm_id: Optional[int] = None
    estimates: Optional[List[str]] = None      # None = every estimate on the project


@router.post("/{eid}/pm")
@_retry
def set_pm(eid: str, req: PmReq, user=Depends(get_current_user)):
    proj = _guard(user, eid)
    with engine.begin() as conn:
        S.ensure_all(conn, [eid])
        S.set_pm(conn, eid, req.estimates, req.pm_id)
    S.sync_lines(eid, int(user["id"]), crews=False)
    record_audit(user, "packages.pm", "project", eid, proj["display_name"], {"pm_id": req.pm_id, "estimates": req.estimates or "all"})
    return _out(eid)


class CrewReq(BaseModel):
    crew_id: Optional[int] = None


@router.post("/{eid}/crew")
@_retry
def set_crew_all(eid: str, req: CrewReq, user=Depends(get_current_user)):
    """2026-11-19 (owner): one crew company for every accepted estimate whose
    package has dates (a crew is picked for dates). Returns which were skipped."""
    proj = _guard(user, eid)
    with engine.begin() as conn:
        b = S.bundle(conn, eid)
        dated = {p["id"] for p in b["packages"] if p["has_dates"]}
        targets = [e for e in b["estimates"] if e["accepted"] and (e["package_id"] in dated or not req.crew_id)]
        skipped = [e["doc_number"] for e in b["estimates"] if e["accepted"] and e not in targets]
        for e in targets:
            _write_crew(conn, eid, e, req.crew_id)
    if targets:
        S.sync_lines(eid, int(user["id"]), package_ids={e["package_id"] for e in targets})
    record_audit(user, "packages.crew_all", "project", eid, proj["display_name"],
                 {"crew_id": req.crew_id, "estimates": [e["doc_number"] for e in targets], "skipped": skipped})
    out = _out(eid)
    out["skipped"] = skipped
    return out


def _write_crew(conn, eid, est, crew_id):
    q = est["qbo_id"]
    has = conn.execute(text("SELECT 1 FROM project_estimate_billing WHERE entity_id = :e AND estimate_qbo_id = :q"),
                       {"e": eid, "q": q}).scalar()
    if not has:
        first = conn.execute(text("SELECT COUNT(*) FROM project_estimate_billing WHERE entity_id = :e"), {"e": eid}).scalar() == 0
        conn.execute(text("""INSERT INTO project_estimate_billing (entity_id, estimate_qbo_id, estimate_doc_number, crew_id, confirmed, confirmed_at)
                             VALUES (:e, :q, :d, :c, :cf, CASE WHEN :cf = 1 THEN NOW() ELSE NULL END)"""),
                     {"e": eid, "q": q, "d": est["doc_number"], "c": crew_id, "cf": 1 if first else 0})
    else:
        conn.execute(text("UPDATE project_estimate_billing SET crew_id = :c WHERE entity_id = :e AND estimate_qbo_id = :q"),
                     {"c": crew_id, "e": eid, "q": q})
    conn.execute(text("UPDATE project_payment_schedules SET crew_id = :c WHERE entity_id = :e AND estimate_qbo_id = :q"),
                 {"c": crew_id, "e": eid, "q": q})


@router.post("/{eid}/estimate/{q}/crew")
@_retry
def set_crew(eid: str, q: str, req: CrewReq, user=Depends(get_current_user)):
    """The estimate's crew (the same field Billing uses). A crew needs dates:
    the estimate's package must have them first."""
    proj = _guard(user, eid)
    with engine.begin() as conn:
        b = S.bundle(conn, eid)
        est = next((e for e in b["estimates"] if e["qbo_id"] == str(q)), None)
        if not est:
            raise HTTPException(404, "Estimate not on this project")
        pk = next((p for p in b["packages"] if p["id"] == est["package_id"]), None)
        if req.crew_id and not (pk and pk["has_dates"]):
            raise HTTPException(400, "Set the package's start and end dates first: a crew is picked for dates")
        _write_crew(conn, eid, est, req.crew_id)
    S.sync_lines(eid, int(user["id"]), package_ids={est["package_id"]})
    record_audit(user, "packages.crew", "project", eid, proj["display_name"], {"estimate": q, "crew_id": req.crew_id, "was": est["crew_id"]})
    return _out(eid)


@router.post("/{eid}/package/{pid}/line")
@_retry
def add_line(eid: str, pid: int, user=Depends(get_current_user)):
    proj = _guard(user, eid)
    with engine.begin() as conn:
        ok = conn.execute(text("SELECT 1 FROM project_phases WHERE id = :k AND entity_id = :e"), {"k": pid, "e": eid}).scalar()
        if not ok:
            raise HTTPException(404, "Package not on this project")
        sid = S.add_line(conn, eid, pid)
    S.sync_lines(eid, int(user["id"]), package_ids={pid})
    record_audit(user, "packages.add_line", "project", eid, proj["display_name"], {"package_id": pid, "line": sid})
    return {**_out(eid), "added_line": sid}


class NameReq(BaseModel):
    name: Optional[str] = None


@router.patch("/{eid}/package/{pid}")
@_retry
def rename(eid: str, pid: int, req: NameReq, user=Depends(get_current_user)):
    _guard(user, eid)
    with engine.begin() as conn:
        conn.execute(text("UPDATE project_phases SET name = :n WHERE id = :k AND entity_id = :e"),
                     {"n": (req.name or "").strip()[:120] or None, "k": pid, "e": eid})
    return _out(eid)


class OverageReq(BaseModel):
    days: int = 0


@router.post("/{eid}/overage")
@_retry
def overage(eid: str, req: OverageReq, user=Depends(get_current_user)):
    proj = _guard(user, eid)
    try:
        S.set_overage(eid, req.days, int(user["id"]))
    except ValueError as e:
        raise HTTPException(400, str(e))
    record_audit(user, "packages.overage", "project", eid, proj["display_name"], {"days": req.days})
    return _out(eid)


@router.post("/{eid}/job-schedule/{proposal_id}/apply")
@_retry
def use_job_schedule(eid: str, proposal_id: int, user=Depends(get_current_user)):
    """Use the Job Schedule's values for one line (the sheet is reference-only)."""
    from app.gsync import schedule_import as SI
    proj = _guard(user, eid)
    try:
        SI.apply_one(proposal_id, int(user["id"]))
    except ValueError as e:
        raise HTTPException(400, str(e))
    record_audit(user, "packages.use_job_schedule", "project", eid, proj["display_name"], {"proposal": proposal_id})
    return _out(eid)


@router.post("/{eid}/job-schedule/{proposal_id}/keep")
@_retry
def keep_app_values(eid: str, proposal_id: int, user=Depends(get_current_user)):
    """Keep the app's values where the Job Schedule differs (2026-11-19). The
    difference stays hidden until the sheet changes again."""
    from app.gsync import schedule_import as SI
    proj = _guard(user, eid)
    try:
        SI.dismiss_one(proposal_id, user.get("email"))
    except ValueError as e:
        raise HTTPException(400, str(e))
    record_audit(user, "packages.keep_app_dates", "project", eid, proj["display_name"], {"proposal": proposal_id})
    return _out(eid)
