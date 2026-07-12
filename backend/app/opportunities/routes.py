"""
Opportunities — the pre-award pipeline front-door (RFQ intake → quoting → sent →
won/lost/declined). The app owns this end-to-end; QBO still mints the quote number
and generates the customer PDF. Stage timestamps power the pipeline analytics
(volume, 24-hr SLA, sales-cycle, win rate).

Customer link uses the QBO id STRING at the API boundary → internal qbo_customers.id
for storage. Gated page.estimate OR page.customers.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text, bindparam

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS, PAGE_ESTIMATE

router = APIRouter(prefix="/api/opportunities", tags=["opportunities"])

# Lifecycle. Terminal states carry the outcome; a decided_at stamp marks them.
OPEN_STATUSES = ("received", "quoting", "sent")
DECIDED_STATUSES = ("won", "lost", "declined")
ALL_STATUSES = OPEN_STATUSES + DECIDED_STATUSES


def _require(user):
    if not (has_capability(user, PAGE_CUSTOMERS) or has_capability(user, PAGE_ESTIMATE)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _resolve_customer(conn, customer_qbo_id):
    return conn.execute(text(
        "SELECT id, qbo_id, display_name FROM qbo_customers WHERE qbo_id = :q"
    ), {"q": str(customer_qbo_id)}).mappings().first()


_SELECT = """
    SELECT o.id, o.qbo_customer_id, qc.qbo_id AS customer_qbo_id, qc.display_name AS customer_name,
           o.contact_id, ct.full_name AS contact_name,
           o.title, o.source, o.rfq_received_date, o.target_start_date,
           o.quote_number, o.qbo_estimate_id, o.app_estimate_id, o.project_qbo_id,
           o.estimator_user_id,
           TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS estimator_name,
           u.email AS estimator_email,
           o.status, o.received_at, o.quoting_started_at, o.sent_at, o.decided_at,
           o.notes, o.created_at, o.updated_at
    FROM opportunities o
    JOIN qbo_customers qc ON qc.id = o.qbo_customer_id
    LEFT JOIN contacts ct ON ct.id = o.contact_id
    LEFT JOIN users u ON u.id = o.estimator_user_id
"""


def _row(r):
    est = (r["estimator_name"] or "").strip() or r["estimator_email"]
    return {
        "id": r["id"], "customer_qbo_id": r["customer_qbo_id"], "customer_name": r["customer_name"],
        "contact_id": r["contact_id"], "contact_name": r["contact_name"],
        "title": r["title"], "source": r["source"],
        "rfq_received_date": str(r["rfq_received_date"]) if r["rfq_received_date"] else None,
        "target_start_date": str(r["target_start_date"]) if r["target_start_date"] else None,
        "quote_number": r["quote_number"], "qbo_estimate_id": r["qbo_estimate_id"],
        "app_estimate_id": r["app_estimate_id"], "project_qbo_id": r["project_qbo_id"],
        "estimator_user_id": r["estimator_user_id"], "estimator_name": est if r["estimator_user_id"] else None,
        "status": r["status"],
        "received_at": str(r["received_at"]) if r["received_at"] else None,
        "quoting_started_at": str(r["quoting_started_at"]) if r["quoting_started_at"] else None,
        "sent_at": str(r["sent_at"]) if r["sent_at"] else None,
        "decided_at": str(r["decided_at"]) if r["decided_at"] else None,
        "notes": r["notes"],
        "created_at": str(r["created_at"]) if r["created_at"] else None,
    }


@router.get("")
def list_opportunities(status: Optional[str] = None, customer_qbo_id: Optional[str] = None,
                       user=Depends(get_current_user)):
    _require(user)
    where, params = [], {}
    if status in ("open",):
        where.append("o.status IN :open")
        params["open"] = OPEN_STATUSES
    elif status in ALL_STATUSES:
        where.append("o.status = :st")
        params["st"] = status
    if customer_qbo_id:
        where.append("qc.qbo_id = :cq")
        params["cq"] = str(customer_qbo_id)
    sql = _SELECT + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY o.created_at DESC, o.id DESC"
    stmt = text(sql)
    if "open" in params:
        stmt = stmt.bindparams(bindparam("open", expanding=True))  # IN (...) list
    with engine.connect() as conn:
        rows = conn.execute(stmt, params).mappings().all()
    return {"opportunities": [_row(r) for r in rows]}


@router.get("/metrics")
def metrics(days: int = 365, user=Depends(get_current_user)):
    """Pipeline analytics over the last `days` (by RFQ received date, falling back to
    created_at): volume, status mix, win rate, and average turn-times in days."""
    _require(user)
    days = max(1, min(int(days or 365), 3650))
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT status, rfq_received_date, received_at, quoting_started_at, sent_at, decided_at, created_at
            FROM opportunities
            WHERE COALESCE(rfq_received_date, DATE(created_at)) >= DATE_SUB(CURDATE(), INTERVAL :d DAY)
        """), {"d": days}).mappings().all()

    def daydiff(a, b):
        if not a or not b:
            return None
        return (b - a).total_seconds() / 86400.0

    from datetime import datetime, date

    def as_dt(v):
        if v is None:
            return None
        if isinstance(v, datetime):
            return v
        if isinstance(v, date):
            return datetime(v.year, v.month, v.day)
        return None

    by_status = {s: 0 for s in ALL_STATUSES}
    prep, cycle, sla = [], [], []      # received→sent, sent→decided, received→quoting
    sla_met = 0
    sla_total = 0
    for r in rows:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
        rec = as_dt(r["rfq_received_date"]) or as_dt(r["received_at"]) or as_dt(r["created_at"])
        d1 = daydiff(rec, as_dt(r["sent_at"]))
        d2 = daydiff(as_dt(r["sent_at"]), as_dt(r["decided_at"]))
        d3 = daydiff(rec, as_dt(r["quoting_started_at"]))
        if d1 is not None and d1 >= 0:
            prep.append(d1)
        if d2 is not None and d2 >= 0:
            cycle.append(d2)
        if d3 is not None and d3 >= 0:
            sla.append(d3); sla_total += 1
            if d3 <= 1.0:
                sla_met += 1

    def avg(xs):
        return round(sum(xs) / len(xs), 1) if xs else None

    won = by_status.get("won", 0)
    decided = won + by_status.get("lost", 0) + by_status.get("declined", 0)
    return {
        "window_days": days,
        "total": len(rows),
        "by_status": by_status,
        "open": sum(by_status.get(s, 0) for s in OPEN_STATUSES),
        "win_rate": round(won / decided, 3) if decided else None,
        "avg_days_received_to_sent": avg(prep),
        "avg_days_sent_to_decided": avg(cycle),
        "avg_days_received_to_quoting": avg(sla),
        "sla_24h_met_pct": round(sla_met / sla_total, 3) if sla_total else None,
    }


@router.get("/{opp_id}")
def get_opportunity(opp_id: int, user=Depends(get_current_user)):
    _require(user)
    with engine.connect() as conn:
        row = conn.execute(text(_SELECT + " WHERE o.id = :id"), {"id": opp_id}).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    return {"opportunity": _row(row)}


class OpportunityIn(BaseModel):
    customer_qbo_id: str
    contact_id: Optional[int] = None
    title: Optional[str] = None
    source: Optional[str] = None
    rfq_received_date: Optional[str] = None
    target_start_date: Optional[str] = None
    estimator_user_id: Optional[int] = None
    notes: Optional[str] = None


@router.post("")
def create_opportunity(body: OpportunityIn, user=Depends(get_current_user)):
    """RFQ intake — starts a tracked opportunity at status 'received'."""
    _require(user)
    with engine.begin() as conn:
        cust = _resolve_customer(conn, body.customer_qbo_id)
        if not cust:
            raise HTTPException(status_code=404, detail="Customer not found")
        if body.contact_id is not None:
            ok = conn.execute(text("SELECT 1 FROM contacts WHERE id=:id AND qbo_customer_id=:cid"),
                              {"id": body.contact_id, "cid": cust["id"]}).scalar()
            if not ok:
                raise HTTPException(status_code=400, detail="Contact does not belong to this customer")
        res = conn.execute(text("""
            INSERT INTO opportunities
              (qbo_customer_id, contact_id, title, source, rfq_received_date, target_start_date,
               estimator_user_id, status, received_at, notes, created_by_user_id)
            VALUES (:cid,:contact,:title,:source,:rfq,:target,:est,'received',NOW(),:notes,:uid)
        """), {"cid": cust["id"], "contact": body.contact_id, "title": body.title,
               "source": body.source, "rfq": body.rfq_received_date or None,
               "target": body.target_start_date or None, "est": body.estimator_user_id,
               "notes": body.notes, "uid": user.get("id")})
        row = conn.execute(text(_SELECT + " WHERE o.id = :id"), {"id": res.lastrowid}).mappings().first()
    return {"opportunity": _row(row)}


class OpportunityPatch(BaseModel):
    contact_id: Optional[int] = None
    title: Optional[str] = None
    source: Optional[str] = None
    rfq_received_date: Optional[str] = None
    target_start_date: Optional[str] = None
    estimator_user_id: Optional[int] = None
    quote_number: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None


# Which timestamp to stamp when moving INTO a status (only if not already set).
_STATUS_STAMP = {"quoting": "quoting_started_at", "sent": "sent_at",
                 "won": "decided_at", "lost": "decided_at", "declined": "decided_at"}


@router.patch("/{opp_id}")
def update_opportunity(opp_id: int, body: OpportunityPatch, user=Depends(get_current_user)):
    _require(user)
    fields = body.model_dump(exclude_unset=True)
    if "status" in fields and fields["status"] not in ALL_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {', '.join(ALL_STATUSES)}")
    with engine.begin() as conn:
        cur = conn.execute(text("SELECT * FROM opportunities WHERE id=:id"), {"id": opp_id}).mappings().first()
        if not cur:
            raise HTTPException(status_code=404, detail="Opportunity not found")
        cols = {"contact_id", "title", "source", "rfq_received_date", "target_start_date",
                "estimator_user_id", "quote_number", "status", "notes"}
        sets, params = [], {"id": opp_id}
        for k, v in fields.items():
            if k in cols:
                sets.append(f"{k} = :{k}")
                params[k] = v or None if k in ("rfq_received_date", "target_start_date") else v
        # stamp the stage timestamp on a status transition (once)
        if "status" in fields:
            stamp = _STATUS_STAMP.get(fields["status"])
            if stamp and not cur[stamp]:
                sets.append(f"{stamp} = NOW()")
        if sets:
            conn.execute(text(f"UPDATE opportunities SET {', '.join(sets)} WHERE id = :id"), params)
        row = conn.execute(text(_SELECT + " WHERE o.id = :id"), {"id": opp_id}).mappings().first()
    return {"opportunity": _row(row)}


@router.delete("/{opp_id}")
def delete_opportunity(opp_id: int, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        n = conn.execute(text("DELETE FROM opportunities WHERE id=:id"), {"id": opp_id}).rowcount
    if not n:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    return {"ok": True}
