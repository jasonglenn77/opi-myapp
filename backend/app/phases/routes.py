"""
Work phases (Batch B, Slice 1b).

A project groups its estimates into phases (work windows). Phases are
auto-suggested — every accepted estimate lands in Phase 1 by default with
`confirmed=0` ("auto-assigned, review me") — and the office confirms, moves an
estimate to another phase, or starts a new phase. Shared on-site costs attach to
the phase later (Slice 3).

`ensure_and_load_phases()` is the shared helper the Change Orders (and later
Billing) endpoints call; the routes here manage phases + assignments.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS

router = APIRouter(prefix="/api/phases", tags=["phases"])


def _require(user):
    if not has_capability(user, PAGE_CUSTOMERS):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def ensure_and_load_phases(conn, entity_id, accepted_ids):
    """Ensure a Phase 1 exists and every accepted estimate is assigned (auto to
    Phase 1, confirmed=0). Returns (phases, assignments-by-estimate)."""
    accepted_ids = [str(x) for x in (accepted_ids or [])]
    phases = [dict(p) for p in conn.execute(text(
        "SELECT id, seq, name FROM project_phases WHERE entity_id=:e ORDER BY seq, id"),
        {"e": entity_id}).mappings().all()]
    if accepted_ids and not phases:
        pid = conn.execute(text("INSERT INTO project_phases (entity_id, seq, name) VALUES (:e,1,NULL)"),
                           {"e": entity_id}).lastrowid
        phases = [{"id": pid, "seq": 1, "name": None}]
    default_pid = phases[0]["id"] if phases else None

    assigned = {str(r["estimate_qbo_id"]): dict(r) for r in conn.execute(text(
        "SELECT estimate_qbo_id, phase_id, confirmed FROM project_estimate_phase WHERE entity_id=:e"),
        {"e": entity_id}).mappings().all()}
    for eid in accepted_ids:
        if eid not in assigned and default_pid:
            conn.execute(text("""INSERT INTO project_estimate_phase
                                 (entity_id, estimate_qbo_id, phase_id, confirmed) VALUES (:e,:eid,:p,0)"""),
                         {"e": entity_id, "eid": eid, "p": default_pid})
            assigned[eid] = {"estimate_qbo_id": eid, "phase_id": default_pid, "confirmed": 0}
    return phases, assigned


def phases_payload(conn, entity_id, accepted_ids):
    phases, assigned = ensure_and_load_phases(conn, entity_id, accepted_ids)
    return {
        "phases": [{"id": p["id"], "seq": p["seq"], "name": p["name"]} for p in phases],
        "assignments": {k: {"phase_id": v["phase_id"], "confirmed": bool(v["confirmed"])}
                        for k, v in assigned.items()},
    }


def _project_exists(conn, entity_id):
    return conn.execute(text("SELECT 1 FROM qbo_customers WHERE qbo_id=:e AND is_project=1"),
                        {"e": entity_id}).scalar() is not None


@router.post("/project/{entity_id}")
def create_phase(entity_id: str, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        if not _project_exists(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        nxt = conn.execute(text("SELECT COALESCE(MAX(seq),0)+1 FROM project_phases WHERE entity_id=:e"),
                           {"e": entity_id}).scalar()
        pid = conn.execute(text("INSERT INTO project_phases (entity_id, seq, name) VALUES (:e,:s,NULL)"),
                           {"e": entity_id, "s": nxt}).lastrowid
    return {"ok": True, "id": pid, "seq": nxt}


class PhasePatch(BaseModel):
    name: Optional[str] = None


@router.patch("/{phase_id}")
def rename_phase(phase_id: int, body: PhasePatch, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        conn.execute(text("UPDATE project_phases SET name=:n WHERE id=:id"),
                     {"n": (body.name or None), "id": phase_id})
    return {"ok": True}


@router.delete("/{phase_id}")
def delete_phase(phase_id: int, user=Depends(get_current_user)):
    """Delete a phase; its estimates fall back to the project's lowest-seq phase.
    Won't delete the last remaining phase."""
    _require(user)
    with engine.begin() as conn:
        row = conn.execute(text("SELECT entity_id FROM project_phases WHERE id=:id"),
                           {"id": phase_id}).mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="Phase not found")
        entity_id = row["entity_id"]
        others = conn.execute(text(
            "SELECT id FROM project_phases WHERE entity_id=:e AND id<>:id ORDER BY seq, id LIMIT 1"),
            {"e": entity_id, "id": phase_id}).scalar()
        if not others:
            raise HTTPException(status_code=400, detail="Can't delete the only phase")
        conn.execute(text("UPDATE project_estimate_phase SET phase_id=:o, confirmed=0 WHERE phase_id=:id"),
                     {"o": others, "id": phase_id})
        conn.execute(text("DELETE FROM project_phases WHERE id=:id"), {"id": phase_id})
    return {"ok": True}


class AssignReq(BaseModel):
    estimate_qbo_id: str
    phase_id: int


@router.post("/project/{entity_id}/assign")
def assign_estimate(entity_id: str, body: AssignReq, user=Depends(get_current_user)):
    """Move an estimate to a phase and confirm it (clears the review flag)."""
    _require(user)
    with engine.begin() as conn:
        exists = conn.execute(text(
            "SELECT id FROM project_estimate_phase WHERE entity_id=:e AND estimate_qbo_id=:eid"),
            {"e": entity_id, "eid": body.estimate_qbo_id}).scalar()
        if exists:
            conn.execute(text("UPDATE project_estimate_phase SET phase_id=:p, confirmed=1 WHERE id=:id"),
                         {"p": body.phase_id, "id": exists})
        else:
            conn.execute(text("""INSERT INTO project_estimate_phase
                                 (entity_id, estimate_qbo_id, phase_id, confirmed) VALUES (:e,:eid,:p,1)"""),
                         {"e": entity_id, "eid": body.estimate_qbo_id, "p": body.phase_id})
    return {"ok": True}
