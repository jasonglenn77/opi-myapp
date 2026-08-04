"""
Crew work offers (C3). The office sends a work offer to a crew for a project;
the labor amount + scope auto-fill from the accepted estimate (no negotiation).
The crew accepts/declines in the Crew Portal (office can also record it). A
decline is reassigned by withdrawing and sending a new offer to another crew.
An accepted offer feeds the payment schedule (C1).

Office endpoints gated page.customers; the crew accept/decline is gated
page.customers OR page.crew_portal.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS, PAGE_CREW_PORTAL

router = APIRouter(prefix="/api/offers", tags=["offers"])


def _require_office(user):
    if not has_capability(user, PAGE_CUSTOMERS):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _require_office_or_crew(user):
    if not (has_capability(user, PAGE_CUSTOMERS) or has_capability(user, PAGE_CREW_PORTAL)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _project_exists(conn, entity_id):
    return conn.execute(text("SELECT 1 FROM qbo_customers WHERE qbo_id=:id AND is_project=1"),
                        {"id": entity_id}).scalar() is not None


def _estimate_suggestions(conn, entity_id):
    """Labor = Accepted/Converted estimate 'Contract Labor' lines; scope = the
    estimate's customer memo (best-effort)."""
    # crew "your rate" = cost_amount (fallback to amount); amount is the
    # customer rate used for revenue. Crew-facing pages use the your rate.
    labor = conn.execute(text("""
        SELECT ROUND(COALESCE(SUM(COALESCE(sl.cost_amount, sl.amount)), 0), 2)
        FROM qbo_sales_transaction_lines sl JOIN qbo_transactions t ON t.id = sl.transaction_id
        WHERE t.entity_type = 'Estimate' AND sl.item_name = 'Contract Labor'
          AND sl.project_customer_qbo_id = :id
          AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted')
    """), {"id": entity_id}).scalar()
    scope = conn.execute(text("""
        SELECT JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.CustomerMemo.value'))
        FROM qbo_transactions t
        WHERE t.entity_type = 'Estimate' AND t.customer_qbo_id = :id
          AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted')
        ORDER BY t.txn_date DESC LIMIT 1
    """), {"id": entity_id}).scalar()
    return float(labor or 0), (scope or None)


def _crew_options(conn):
    rows = conn.execute(text("""
        SELECT wc.id, wc.name, pc.name AS parent_name
        FROM work_crews wc LEFT JOIN work_crews pc ON pc.id = wc.parent_id
        WHERE wc.parent_id IS NOT NULL AND (wc.is_active = 1 OR wc.is_active IS NULL)
        ORDER BY pc.name, wc.name
    """)).mappings().all()
    return [{"id": r["id"], "name": r["name"], "parent_name": r["parent_name"]} for r in rows]


def _offer_rows(conn, where, params):
    rows = conn.execute(text(f"""
        SELECT o.id, o.entity_id, o.crew_id, o.labor_amount, o.scope, o.status,
               o.sent_at, o.responded_at, o.response_note,
               TRIM(CONCAT(COALESCE(wc.name,''), CASE WHEN pc.name IS NOT NULL THEN CONCAT(' (', pc.name, ')') ELSE '' END)) AS crew_name
        FROM work_offers o
        LEFT JOIN work_crews wc ON wc.id = o.crew_id
        LEFT JOIN work_crews pc ON pc.id = wc.parent_id
        WHERE {where} ORDER BY o.created_at DESC, o.id DESC
    """), params).mappings().all()
    return [{
        "id": r["id"], "entity_id": r["entity_id"], "crew_id": r["crew_id"],
        "crew_name": (r["crew_name"] or "").strip() or None,
        "labor_amount": float(r["labor_amount"] or 0), "scope": r["scope"], "status": r["status"],
        "sent_at": str(r["sent_at"]) if r["sent_at"] else None,
        "responded_at": str(r["responded_at"]) if r["responded_at"] else None,
        "response_note": r["response_note"],
    } for r in rows]


@router.get("/project/{entity_id}")
def list_for_project(entity_id: str, user=Depends(get_current_user)):
    _require_office(user)
    with engine.connect() as conn:
        if not _project_exists(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        offers = _offer_rows(conn, "o.entity_id = :e", {"e": entity_id})
        labor, scope = _estimate_suggestions(conn, entity_id)
        crews = _crew_options(conn)
    accepted = next((o for o in offers if o["status"] == "accepted"), None)
    current = accepted or next((o for o in offers if o["status"] == "sent"), None)
    return {"offers": offers, "current": current, "accepted": accepted,
            "suggested_labor": labor, "suggested_scope": scope, "crews": crews}


@router.get("/crew-roster")
def crew_roster(project_qbo_id: Optional[str] = None, start: Optional[str] = None,
                end: Optional[str] = None, user=Depends(get_current_user)):
    """All work crews with their recent track record + availability for a date
    range — so the office can pick a crew for an offer from an informed panel:
    jobs done in the last 365 days, $ paid to them (365d), and whether they're
    already scheduled during the project's window."""
    _require_office(user)
    from datetime import date, timedelta
    from collections import defaultdict
    cutoff = date.today() - timedelta(days=365)

    def _d(s):
        try:
            return date.fromisoformat(str(s)[:10]) if s else None
        except ValueError:
            return None
    ps, pe = _d(start), _d(end)

    with engine.connect() as conn:
        crews = conn.execute(text("""
            SELECT wc.id, wc.name, pc.name AS company,
                   COALESCE(wc.vendor_qbo_id, pc.vendor_qbo_id) AS vendor
            FROM work_crews wc LEFT JOIN work_crews pc ON pc.id = wc.parent_id
            WHERE wc.parent_id IS NOT NULL AND (wc.is_active = 1 OR wc.is_active IS NULL)
            ORDER BY pc.name, wc.name
        """)).mappings().all()
        earned = {str(r["v"]): float(r["amt"] or 0) for r in conn.execute(text("""
            SELECT vendor_qbo_id AS v, ROUND(SUM(total_amt), 2) AS amt FROM qbo_transactions
            WHERE entity_type = 'Bill' AND txn_date >= :c AND vendor_qbo_id IS NOT NULL
            GROUP BY vendor_qbo_id
        """), {"c": cutoff}).mappings().all()}
        scheds = conn.execute(text("""
            SELECT crew_id, entity_id, start_date, end_date
            FROM project_payment_schedules WHERE crew_id IS NOT NULL
        """)).mappings().all()

    by_crew = defaultdict(list)
    for s in scheds:
        by_crew[s["crew_id"]].append(s)
    out = []
    for c in crews:
        cs = by_crew.get(c["id"], [])
        jobs_365 = len({s["entity_id"] for s in cs if s["end_date"] and s["end_date"] >= cutoff})
        conflict = False
        if ps and pe:
            for s in cs:
                if project_qbo_id and str(s["entity_id"]) == str(project_qbo_id):
                    continue
                if s["start_date"] and s["end_date"] and s["start_date"] <= pe and s["end_date"] >= ps:
                    conflict = True
                    break
        out.append({
            "id": c["id"], "name": c["name"], "company": c["company"],
            "earned_365": round(earned.get(str(c["vendor"]), 0), 2),
            "jobs_365": jobs_365,
            "available": (not conflict) if (ps and pe) else None,
        })
    return {"crews": out, "has_dates": bool(ps and pe)}


class OfferCreate(BaseModel):
    crew_id: int
    labor_amount: float
    scope: Optional[str] = None


@router.post("/project/{entity_id}")
def send_offer(entity_id: str, body: OfferCreate, user=Depends(get_current_user)):
    _require_office(user)
    with engine.begin() as conn:
        if not _project_exists(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        res = conn.execute(text("""
            INSERT INTO work_offers (entity_id, crew_id, labor_amount, scope, status, sent_at, created_by_user_id)
            VALUES (:e,:c,:amt,:sc,'sent',NOW(),:u)
        """), {"e": entity_id, "c": body.crew_id, "amt": body.labor_amount,
               "sc": (body.scope or None), "u": user.get("id")})
    return {"ok": True, "id": res.lastrowid}


@router.post("/project/{entity_id}/backfill")
def backfill_accepted(entity_id: str, user=Depends(get_current_user)):
    """Record an accepted offer for a project that was already underway before the
    app existed (offer lived in Google Drive). Uses the crew already assigned on
    the payment schedule and the estimate's labor amount — so the app's offer
    tracker reflects the historical acceptance without re-sending anything."""
    _require_office(user)
    with engine.begin() as conn:
        if not _project_exists(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        existing = conn.execute(text("SELECT COUNT(*) FROM work_offers WHERE entity_id=:e"),
                                {"e": entity_id}).scalar()
        if existing:
            raise HTTPException(status_code=400, detail="This project already has offer records.")
        crew_id = conn.execute(text(
            """SELECT crew_id FROM project_payment_schedules
               WHERE entity_id=:e AND crew_id IS NOT NULL ORDER BY id LIMIT 1"""),
            {"e": entity_id}).scalar()
        if not crew_id:
            raise HTTPException(status_code=400,
                                detail="Assign a crew on the Assignment page first, then record.")
        labor, scope = _estimate_suggestions(conn, entity_id)
        res = conn.execute(text("""
            INSERT INTO work_offers
              (entity_id, crew_id, labor_amount, scope, status, sent_at, responded_at,
               response_note, created_by_user_id, responded_by_user_id)
            VALUES (:e,:c,:amt,:sc,'accepted',NOW(),NOW(),
               'Backfilled — offer accepted before the app (recorded from QuickBooks)',:u,:u)
        """), {"e": entity_id, "c": crew_id, "amt": labor, "sc": (scope or None), "u": user.get("id")})
    return {"ok": True, "id": res.lastrowid}


class OfferResponse(BaseModel):
    status: str          # accepted | declined
    note: Optional[str] = None


@router.post("/{offer_id}/respond")
def respond(offer_id: int, body: OfferResponse, user=Depends(get_current_user)):
    _require_office_or_crew(user)
    if body.status not in ("accepted", "declined"):
        raise HTTPException(status_code=400, detail="status must be accepted or declined")
    with engine.begin() as conn:
        o = conn.execute(text("SELECT entity_id, status FROM work_offers WHERE id=:id"),
                         {"id": offer_id}).mappings().first()
        if not o:
            raise HTTPException(status_code=404, detail="Offer not found")
        if o["status"] not in ("sent",):
            raise HTTPException(status_code=400, detail="Only a sent offer can be responded to")
        conn.execute(text("""UPDATE work_offers SET status=:s, responded_at=NOW(),
                             responded_by_user_id=:u, response_note=:n WHERE id=:id"""),
                     {"s": body.status, "u": user.get("id"), "n": (body.note or None), "id": offer_id})
        if body.status == "accepted":
            # only one accepted crew per project — withdraw other outstanding offers
            conn.execute(text("""UPDATE work_offers SET status='withdrawn'
                                 WHERE entity_id=:e AND id<>:id AND status='sent'"""),
                         {"e": o["entity_id"], "id": offer_id})
    return {"ok": True}


@router.post("/{offer_id}/withdraw")
def withdraw(offer_id: int, user=Depends(get_current_user)):
    _require_office(user)
    with engine.begin() as conn:
        n = conn.execute(text("""UPDATE work_offers SET status='withdrawn'
                                 WHERE id=:id AND status='sent'"""), {"id": offer_id}).rowcount
    if not n:
        raise HTTPException(status_code=404, detail="No sent offer to withdraw")
    return {"ok": True}


@router.get("/crew/{crew_id}")
def list_for_crew(crew_id: int, user=Depends(get_current_user)):
    """Offers for a crew (Crew Portal). Includes the project name for context."""
    _require_office_or_crew(user)
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT o.id, o.entity_id, o.labor_amount, o.scope, o.status, o.sent_at,
                   qc.display_name AS project_name
            FROM work_offers o LEFT JOIN qbo_customers qc ON qc.qbo_id = o.entity_id
            WHERE o.crew_id = :c ORDER BY o.created_at DESC, o.id DESC
        """), {"c": crew_id}).mappings().all()
    return {"offers": [{
        "id": r["id"], "entity_id": r["entity_id"], "project_name": r["project_name"],
        "labor_amount": float(r["labor_amount"] or 0), "scope": r["scope"],
        "status": r["status"], "sent_at": str(r["sent_at"]) if r["sent_at"] else None,
    } for r in rows]}
