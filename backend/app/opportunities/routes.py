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
    SELECT o.id, o.qbo_customer_id, qc.qbo_id AS customer_qbo_id,
           COALESCE(qc.display_name, o.customer_name_raw) AS customer_name,
           o.contact_id, COALESCE(ct.full_name, o.contact_name_raw) AS contact_name,
           o.title, o.source, o.rfq_received_date, o.target_start_date,
           o.quote_number, o.qbo_estimate_id, o.app_estimate_id,
           o.project_qbo_id, pj.display_name AS project_name,
           o.estimator_user_id,
           TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS estimator_name,
           u.email AS estimator_email,
           o.status, o.pipeline_status, o.quoted_by,
           o.last_contact_date, o.follow_up_count, o.last_comm_type, o.most_recent_revision_date,
           o.city, o.state, o.labor_days, o.travel_days, o.total_revisions,
           o.contract_value, o.order_value, o.ohp_amount, o.ohp_pct,
           o.order_date, o.quote_sent_date, o.expected_decision_date,
           o.received_at, o.quoting_started_at, o.sent_at, o.decided_at,
           o.notes, o.created_at, o.updated_at,
           COALESCE(dc.c, 0) AS doc_count
    FROM opportunities o
    LEFT JOIN qbo_customers qc ON qc.id = o.qbo_customer_id
    LEFT JOIN contacts ct ON ct.id = o.contact_id
    LEFT JOIN users u ON u.id = o.estimator_user_id
    LEFT JOIN qbo_customers pj ON pj.qbo_id = o.project_qbo_id COLLATE utf8mb4_unicode_ci
    LEFT JOIN (SELECT entity_id, COUNT(*) AS c FROM documents
               WHERE entity_type='opportunity' GROUP BY entity_id) dc
           ON dc.entity_id COLLATE utf8mb4_unicode_ci = CAST(o.id AS CHAR) COLLATE utf8mb4_unicode_ci
"""


def _num(v):
    return float(v) if v is not None else None


def _row(r):
    est = (r["estimator_name"] or "").strip() or r["estimator_email"]
    return {
        "id": r["id"], "customer_qbo_id": r["customer_qbo_id"], "customer_name": r["customer_name"],
        "contact_id": r["contact_id"], "contact_name": r["contact_name"],
        "title": r["title"], "source": r["source"],
        "rfq_received_date": str(r["rfq_received_date"]) if r["rfq_received_date"] else None,
        "target_start_date": str(r["target_start_date"]) if r["target_start_date"] else None,
        "quote_number": r["quote_number"], "qbo_estimate_id": r["qbo_estimate_id"],
        "app_estimate_id": r["app_estimate_id"],
        "project_qbo_id": r["project_qbo_id"], "project_name": r["project_name"],
        "estimator_user_id": r["estimator_user_id"], "estimator_name": est if r["estimator_user_id"] else None,
        "status": r["status"], "pipeline_status": r["pipeline_status"], "quoted_by": r["quoted_by"],
        "last_contact_date": str(r["last_contact_date"]) if r["last_contact_date"] else None,
        "follow_up_count": r["follow_up_count"], "last_comm_type": r["last_comm_type"],
        "most_recent_revision_date": str(r["most_recent_revision_date"]) if r["most_recent_revision_date"] else None,
        "city": r["city"], "state": r["state"],
        "labor_days": _num(r["labor_days"]), "travel_days": _num(r["travel_days"]),
        "total_revisions": r["total_revisions"],
        "contract_value": _num(r["contract_value"]), "order_value": _num(r["order_value"]),
        "ohp_amount": _num(r["ohp_amount"]), "ohp_pct": _num(r["ohp_pct"]),
        "order_date": str(r["order_date"]) if r["order_date"] else None,
        "quote_sent_date": str(r["quote_sent_date"]) if r["quote_sent_date"] else None,
        "expected_decision_date": str(r["expected_decision_date"]) if r["expected_decision_date"] else None,
        "received_at": str(r["received_at"]) if r["received_at"] else None,
        "quoting_started_at": str(r["quoting_started_at"]) if r["quoting_started_at"] else None,
        "sent_at": str(r["sent_at"]) if r["sent_at"] else None,
        "decided_at": str(r["decided_at"]) if r["decided_at"] else None,
        "notes": r["notes"],
        "doc_count": int(r["doc_count"] or 0),
        "created_at": str(r["created_at"]) if r["created_at"] else None,
    }


@router.get("")
def list_opportunities(status: Optional[str] = None, customer_qbo_id: Optional[str] = None,
                       q: Optional[str] = None, unlinked: Optional[int] = None,
                       limit: int = 200, offset: int = 0,
                       user=Depends(get_current_user)):
    _require(user)
    where, params = [], {}
    if status in ("open",):
        where.append("o.status IN :open")
        params["open"] = OPEN_STATUSES
    elif status in ALL_STATUSES:
        where.append("o.status = :st")
        params["st"] = status
    if unlinked:
        where.append("o.qbo_customer_id IS NULL")
    if customer_qbo_id:
        where.append("qc.qbo_id = :cq")
        params["cq"] = str(customer_qbo_id)
    if q:
        # display_name (utf8mb4_unicode_ci) and customer_name_raw (utf8mb4_0900_ai_ci)
        # have different collations, so COALESCE(...) LIKE errors without an explicit
        # COLLATE. Pin both to unicode_ci for the comparison.
        where.append(
            "(COALESCE(qc.display_name COLLATE utf8mb4_unicode_ci, "
            "o.customer_name_raw COLLATE utf8mb4_unicode_ci) LIKE :q "
            "OR o.title COLLATE utf8mb4_unicode_ci LIKE :q "
            "OR o.quote_number COLLATE utf8mb4_unicode_ci LIKE :q)")
        params["q"] = f"%{q}%"
    limit = max(1, min(int(limit), 5000))
    offset = max(0, int(offset))
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""
    # Seeded rows share a created_at, so order by the RFQ/received date (then quote#).
    order = (" ORDER BY COALESCE(o.rfq_received_date, DATE(o.created_at)) DESC, "
             "o.id DESC LIMIT :limit OFFSET :offset")
    params["limit"], params["offset"] = limit, offset
    count_stmt = text("SELECT COUNT(*) FROM opportunities o "
                      "LEFT JOIN qbo_customers qc ON qc.id = o.qbo_customer_id" + where_sql)
    stmt = text(_SELECT + where_sql + order)
    if "open" in params:
        stmt = stmt.bindparams(bindparam("open", expanding=True))  # IN (...) list
        count_stmt = count_stmt.bindparams(bindparam("open", expanding=True))
    with engine.connect() as conn:
        total = conn.execute(count_stmt, {k: v for k, v in params.items()
                                          if k not in ("limit", "offset")}).scalar()
        rows = conn.execute(stmt, params).mappings().all()
    return {"opportunities": [_row(r) for r in rows], "total": total,
            "limit": limit, "offset": offset}


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


# NOTE: /project-options and /by-project/* MUST precede /{opp_id} (int) so they
# aren't captured as an opp_id and 422'd.
@router.get("/project-options")
def project_options(q: Optional[str] = None, limit: int = 30, user=Depends(get_current_user)):
    """Searchable QBO project list for linking a won opportunity."""
    _require(user)
    limit = max(1, min(int(limit or 30), 100))
    like = f"%{(q or '').strip()}%"
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT qbo_id, display_name FROM qbo_customers
            WHERE is_project = 1 AND (:q = '' OR display_name LIKE :like)
            ORDER BY display_name LIMIT :limit
        """), {"q": (q or "").strip(), "like": like, "limit": limit}).mappings().all()
    return {"projects": [{"qbo_id": r["qbo_id"], "name": r["display_name"]} for r in rows]}


@router.get("/by-project/{project_qbo_id}")
def opportunity_for_project(project_qbo_id: str, user=Depends(get_current_user)):
    """The opportunity linked to a project — powers the project's 'originating quote'."""
    _require(user)
    with engine.connect() as conn:
        row = conn.execute(text(_SELECT + " WHERE o.project_qbo_id = :p ORDER BY o.id DESC LIMIT 1"),
                           {"p": project_qbo_id}).mappings().first()
    return {"opportunity": _row(row) if row else None}


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
    project_qbo_id: Optional[str] = None   # link the won opportunity to its QBO project ("" to unlink)
    app_estimate_id: Optional[int] = None  # link an existing quoting-metrics estimate (0/null to unlink)
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
        if fields.get("project_qbo_id"):
            okp = conn.execute(text("SELECT 1 FROM qbo_customers WHERE qbo_id=:p AND is_project=1"),
                               {"p": fields["project_qbo_id"]}).scalar()
            if not okp:
                raise HTTPException(status_code=400, detail="project_qbo_id is not a project")
        cols = {"contact_id", "title", "source", "rfq_received_date", "target_start_date",
                "estimator_user_id", "quote_number", "status", "project_qbo_id", "notes",
                "app_estimate_id"}
        nullable = ("rfq_received_date", "target_start_date", "project_qbo_id", "app_estimate_id")
        sets, params = [], {"id": opp_id}
        for k, v in fields.items():
            if k in cols:
                sets.append(f"{k} = :{k}")
                params[k] = (v or None) if k in nullable else v
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


# ── Opportunity → Quoting-metrics estimate (the pipeline↔quote spine) ─────────
def _opp_for_quote(conn, opp_id):
    o = conn.execute(text(
        "SELECT o.id, o.qbo_customer_id, qc.qbo_id AS customer_qbo_id, o.contact_id, "
        "o.title, o.quoted_by, o.city, o.state, o.rfq_received_date, o.target_start_date, "
        "o.quote_number, o.app_estimate_id, o.status "
        "FROM opportunities o LEFT JOIN qbo_customers qc ON qc.id = o.qbo_customer_id "
        "WHERE o.id = :id"), {"id": opp_id}).mappings().first()
    if not o:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    return o


@router.post("/{opp_id}/start-quote")
def start_quote(opp_id: int, user=Depends(get_current_user)):
    """Create a NEW quoting-metrics estimate prefilled from this opportunity and
    link the two. Moves the opportunity into 'quoting'."""
    _require(user)
    with engine.begin() as conn:
        o = _opp_for_quote(conn, opp_id)
        if not o["qbo_customer_id"]:
            raise HTTPException(status_code=400, detail="Link a QuickBooks customer to this opportunity first.")
        cust = conn.execute(text(
            "SELECT id, qbo_id FROM qbo_customers WHERE id=:cid AND job=0 AND active=1 AND is_project=0"),
            {"cid": o["qbo_customer_id"]}).mappings().first()
        if not cust:
            raise HTTPException(status_code=400, detail="Opportunity customer is not an eligible estimating customer.")
        res = conn.execute(text("""
            INSERT INTO estimates
              (qbo_customer_id, qbo_customer_qbo_id, contact_id, quote_description, quoted_by,
               project_city, project_state, date_of_request, start_date, quote_number, status)
            VALUES (:cid,:qid,:contact,:desc,:by,:city,:state,:req,:start,:qnum,'draft')
        """), {"cid": cust["id"], "qid": cust["qbo_id"], "contact": o["contact_id"],
               "desc": o["title"], "by": o["quoted_by"],
               "city": o["city"], "state": (o["state"] or None) if not o["state"] or len(o["state"]) <= 2 else None,
               "req": o["rfq_received_date"], "start": o["target_start_date"],
               "qnum": o["quote_number"]})
        est_id = res.lastrowid
        sets = ["app_estimate_id = :eid"]
        params = {"eid": est_id, "id": opp_id}
        if o["status"] in ("received",):
            sets.append("status = 'quoting'")
            sets.append("quoting_started_at = COALESCE(quoting_started_at, NOW())")
        conn.execute(text(f"UPDATE opportunities SET {', '.join(sets)} WHERE id=:id"), params)
    return {"estimate_id": est_id}


@router.get("/{opp_id}/quote-options")
def quote_options(opp_id: int, user=Depends(get_current_user)):
    """Existing quoting-metrics estimates for this opportunity's customer, to link."""
    _require(user)
    with engine.connect() as conn:
        o = _opp_for_quote(conn, opp_id)
        if not o["qbo_customer_id"]:
            return {"estimates": []}
        rows = conn.execute(text("""
            SELECT id, quote_description, quote_number, status, qbo_estimate_id, created_at
            FROM estimates WHERE qbo_customer_id = :cid
            ORDER BY created_at DESC, id DESC LIMIT 50
        """), {"cid": o["qbo_customer_id"]}).mappings().all()
    return {"estimates": [{
        "id": r["id"], "quote_description": r["quote_description"], "quote_number": r["quote_number"],
        "status": r["status"], "linked_qbo": bool(r["qbo_estimate_id"]),
        "created_at": str(r["created_at"]) if r["created_at"] else None,
    } for r in rows]}


# ── Pipeline contact-logging (Rolling Revenue follow-up workflow) ─────────────
class ContactLogIn(BaseModel):
    contact_date: Optional[str] = None          # defaults to today
    communication_type: Optional[str] = None    # LVM | PC | ES | ER
    notes: Optional[str] = None


@router.get("/{opp_id}/contact-log")
def contact_log(opp_id: int, user=Depends(get_current_user)):
    _require(user)
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, contact_date, communication_type, notes, created_at
            FROM customer_contact_log WHERE opportunity_id = :id
            ORDER BY contact_date DESC, id DESC
        """), {"id": opp_id}).mappings().all()
    return {"log": [{
        "id": r["id"], "contact_date": str(r["contact_date"]) if r["contact_date"] else None,
        "communication_type": r["communication_type"], "notes": r["notes"],
        "created_at": str(r["created_at"]) if r["created_at"] else None,
    } for r in rows]}


@router.post("/{opp_id}/contact-log")
def add_contact_log(opp_id: int, body: ContactLogIn, user=Depends(get_current_user)):
    """Log a follow-up on this opportunity and refresh its running summary
    (last contact date, follow-up count, last comm type) — mirrors the RR sheet."""
    _require(user)
    with engine.begin() as conn:
        o = conn.execute(text("SELECT id, qbo_customer_id FROM opportunities WHERE id=:id"),
                         {"id": opp_id}).mappings().first()
        if not o:
            raise HTTPException(status_code=404, detail="Opportunity not found")
        conn.execute(text("""
            INSERT INTO customer_contact_log (qbo_customer_id, opportunity_id, contact_date, communication_type, notes)
            VALUES (:cid, :oid, COALESCE(:d, CURDATE()), :ct, :notes)
        """), {"cid": o["qbo_customer_id"], "oid": opp_id,
               "d": body.contact_date or None, "ct": body.communication_type, "notes": body.notes})
        conn.execute(text("""
            UPDATE opportunities SET
              last_contact_date = GREATEST(COALESCE(last_contact_date, '1900-01-01'), COALESCE(:d, CURDATE())),
              follow_up_count = COALESCE(follow_up_count, 0) + 1,
              last_comm_type = COALESCE(:ct, last_comm_type)
            WHERE id = :id
        """), {"d": body.contact_date or None, "ct": body.communication_type, "id": opp_id})
        row = conn.execute(text(_SELECT + " WHERE o.id = :id"), {"id": opp_id}).mappings().first()
    return {"opportunity": _row(row)}


class LinkQuote(BaseModel):
    app_estimate_id: int


@router.post("/{opp_id}/link-quote")
def link_quote(opp_id: int, body: LinkQuote, user=Depends(get_current_user)):
    """Link an EXISTING estimate to this opportunity (must be the same customer)."""
    _require(user)
    with engine.begin() as conn:
        o = _opp_for_quote(conn, opp_id)
        est = conn.execute(text("SELECT id, qbo_customer_id FROM estimates WHERE id=:eid"),
                           {"eid": body.app_estimate_id}).mappings().first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")
        if o["qbo_customer_id"] and est["qbo_customer_id"] != o["qbo_customer_id"]:
            raise HTTPException(status_code=400, detail="That estimate belongs to a different customer.")
        sets = ["app_estimate_id = :eid"]
        if o["status"] in ("received",):
            sets.append("status = 'quoting'")
            sets.append("quoting_started_at = COALESCE(quoting_started_at, NOW())")
        conn.execute(text(f"UPDATE opportunities SET {', '.join(sets)} WHERE id=:id"),
                     {"eid": body.app_estimate_id, "id": opp_id})
    return {"ok": True, "estimate_id": body.app_estimate_id}
