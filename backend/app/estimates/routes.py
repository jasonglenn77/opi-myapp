from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.auth import get_current_user
from app.db import engine

router = APIRouter(prefix="/api/estimates", tags=["estimates"])


# ---------------------------------------------------------------------------
# GET /api/estimates/customers
#   Picker list — QBO customers in the "estimating" phase
#   (job=0, active=1, is_project=0), each joined with their estimate id if
#   one exists. The frontend uses estimate_id to decide whether to render a
#   "Create Estimate" or "Open Estimate" button.
# ---------------------------------------------------------------------------
@router.get("/customers")
def list_estimate_customers(_user=Depends(get_current_user)):
    # Three correlated subqueries on customer_contact_log give us
    # (last_contact_date, follow_up_qty, last_communication_type) without
    # extra round trips. Customer-list cardinality is small enough that
    # the simpler-to-read approach wins over a heavier window-function
    # / lateral-join variant.
    sql = """
        SELECT
            c.id                AS qbo_customer_id,
            c.qbo_id            AS qbo_id,
            c.display_name      AS display_name,
            c.email             AS email,
            c.meta_create_time  AS meta_create_time,
            e.id                AS estimate_id,
            e.revision_count    AS estimate_revision_count,
            e.updated_at        AS estimate_updated_at,
            m.status            AS pipeline_status,
            (SELECT MAX(contact_date) FROM customer_contact_log
              WHERE qbo_customer_id = c.id) AS last_contact_date,
            (SELECT COUNT(*) FROM customer_contact_log
              WHERE qbo_customer_id = c.id) AS follow_up_qty,
            (SELECT communication_type FROM customer_contact_log
              WHERE qbo_customer_id = c.id
              ORDER BY contact_date DESC, id DESC LIMIT 1)
                                AS last_communication_type
        FROM qbo_customers c
        LEFT JOIN estimates e               ON e.qbo_customer_id = c.id
        LEFT JOIN customer_estimating_meta m ON m.qbo_customer_id = c.id
        WHERE c.job = 0 AND c.active = 1 AND c.is_project = 0
        ORDER BY c.meta_create_time DESC, c.display_name
    """
    with engine.connect() as conn:
        rows = conn.execute(text(sql)).mappings().all()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Pipeline status — upsert per customer. NULL clears the status.
# ---------------------------------------------------------------------------
class CustomerStatusPatch(BaseModel):
    status: Optional[str] = None   # use null/empty to clear


@router.patch("/customers/{qbo_customer_id}/meta")
def upsert_customer_meta(
    qbo_customer_id: int,
    req: CustomerStatusPatch,
    _user=Depends(get_current_user),
):
    status = req.status if (req.status and req.status.strip()) else None
    with engine.begin() as conn:
        # Verify the customer exists (cheap sanity check; avoids orphan rows).
        ok = conn.execute(text("""
            SELECT 1 FROM qbo_customers WHERE id = :cid
        """), {"cid": qbo_customer_id}).first()
        if not ok:
            raise HTTPException(status_code=404, detail="Customer not found")

        conn.execute(text("""
            INSERT INTO customer_estimating_meta (qbo_customer_id, status)
            VALUES (:cid, :status)
            ON DUPLICATE KEY UPDATE status = VALUES(status)
        """), {"cid": qbo_customer_id, "status": status})
    return {"ok": True, "status": status}


# ---------------------------------------------------------------------------
# Contact log — CRUD per customer
# ---------------------------------------------------------------------------
@router.get("/customers/{qbo_customer_id}/contacts")
def list_customer_contacts(qbo_customer_id: int, _user=Depends(get_current_user)):
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, qbo_customer_id, contact_date, communication_type, notes, created_at
            FROM customer_contact_log
            WHERE qbo_customer_id = :cid
            ORDER BY contact_date DESC, id DESC
        """), {"cid": qbo_customer_id}).mappings().all()
    return [dict(r) for r in rows]


class ContactCreate(BaseModel):
    contact_date:        str               # ISO yyyy-mm-dd
    communication_type:  Optional[str] = None
    notes:               Optional[str] = None


@router.post("/customers/{qbo_customer_id}/contacts")
def create_customer_contact(
    qbo_customer_id: int,
    req: ContactCreate,
    _user=Depends(get_current_user),
):
    contact_date = (req.contact_date or "").strip()
    if not contact_date:
        raise HTTPException(status_code=400, detail="contact_date is required")

    with engine.begin() as conn:
        ok = conn.execute(text("""
            SELECT 1 FROM qbo_customers WHERE id = :cid
        """), {"cid": qbo_customer_id}).first()
        if not ok:
            raise HTTPException(status_code=404, detail="Customer not found")

        result = conn.execute(text("""
            INSERT INTO customer_contact_log
              (qbo_customer_id, contact_date, communication_type, notes)
            VALUES (:cid, :dt, :ctype, :notes)
        """), {
            "cid":   qbo_customer_id,
            "dt":    contact_date,
            "ctype": req.communication_type or None,
            "notes": req.notes or None,
        })
        row = conn.execute(text("""
            SELECT id, qbo_customer_id, contact_date, communication_type, notes, created_at
            FROM customer_contact_log WHERE id = :id
        """), {"id": result.lastrowid}).mappings().first()
    return dict(row)


@router.delete("/contacts/{contact_id}")
def delete_customer_contact(contact_id: int, _user=Depends(get_current_user)):
    with engine.begin() as conn:
        result = conn.execute(text("""
            DELETE FROM customer_contact_log WHERE id = :id
        """), {"id": contact_id})
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Contact not found")
    return {"ok": True}


class ContactPatch(BaseModel):
    contact_date: Optional[str] = None
    communication_type: Optional[str] = None
    notes: Optional[str] = None


@router.patch("/contacts/{contact_id}")
def update_customer_contact(contact_id: int, req: ContactPatch, _user=Depends(get_current_user)):
    sets, params = [], {"id": contact_id}
    if "contact_date" in req.__fields_set__:
        if not (req.contact_date or "").strip():
            raise HTTPException(status_code=400, detail="contact_date cannot be empty")
        sets.append("contact_date=:d"); params["d"] = req.contact_date
    if "communication_type" in req.__fields_set__:
        sets.append("communication_type=:ct"); params["ct"] = req.communication_type or None
    if "notes" in req.__fields_set__:
        sets.append("notes=:n"); params["n"] = req.notes or None
    if not sets:
        return {"ok": True}
    with engine.begin() as conn:
        result = conn.execute(text(f"UPDATE customer_contact_log SET {', '.join(sets)} WHERE id=:id"), params)
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Contact not found")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Shared loader — returns the full estimate row + the linked customer's
# display name and email for header rendering.
# ---------------------------------------------------------------------------
def _load_estimate(conn, estimate_id: int):
    row = conn.execute(text("""
        SELECT e.*,
               c.display_name AS customer_display_name,
               c.email        AS customer_email,
               c.qbo_id       AS customer_qbo_id
        FROM estimates e
        LEFT JOIN qbo_customers c ON c.id = e.qbo_customer_id
        WHERE e.id = :id
    """), {"id": estimate_id}).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="Estimate not found")
    return dict(row)


class EstimateCreate(BaseModel):
    qbo_customer_id: int
    quote_description: Optional[str] = None
    contact_id: Optional[int] = None


@router.post("")
def create_estimate(req: EstimateCreate, _user=Depends(get_current_user)):
    """
    Create a NEW quoting-metrics estimate for a customer. A customer may have
    many estimates (one per opportunity); this always inserts a new row in
    'draft' status. The QBO estimate is linked later, at transfer.
    """
    with engine.begin() as conn:
        # Verify the customer exists and is eligible (top-level estimating
        # customer). Capture qbo_id so the row stands alone across re-syncs.
        customer = conn.execute(text("""
            SELECT id, qbo_id FROM qbo_customers
            WHERE id = :cid AND job = 0 AND active = 1 AND is_project = 0
        """), {"cid": req.qbo_customer_id}).mappings().first()
        if not customer:
            raise HTTPException(
                status_code=400,
                detail="qbo_customer_id is not an eligible estimating customer "
                       "(must have job=0, active=1, is_project=0)"
            )

        # A chosen contact must belong to this customer.
        contact_id = req.contact_id
        if contact_id is not None:
            ok = conn.execute(text("SELECT 1 FROM contacts WHERE id=:id AND qbo_customer_id=:cid"),
                              {"id": contact_id, "cid": customer["id"]}).scalar()
            if not ok:
                raise HTTPException(status_code=400, detail="Contact does not belong to this customer")

        result = conn.execute(text("""
            INSERT INTO estimates (qbo_customer_id, qbo_customer_qbo_id, contact_id, quote_description, status)
            VALUES (:cid, :qid, :contact, :desc, 'draft')
        """), {"cid": customer["id"], "qid": customer["qbo_id"], "contact": contact_id,
               "desc": (req.quote_description or None)})
        return _load_estimate(conn, result.lastrowid)


# ===========================================================================
# Estimate TRACKING — OPI status + contact log over all QBO estimates.
# The QBO estimate is the spine; estimate_tracking is the OPI overlay.
# ===========================================================================
@router.get("/estimators")
def list_estimators(_user=Depends(get_current_user)):
    """Active users assignable as an estimate owner (estimator)."""
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, TRIM(CONCAT(COALESCE(first_name,''),' ',COALESCE(last_name,''))) AS name, email
            FROM users WHERE is_active = 1 ORDER BY name, email
        """)).mappings().all()
    return [{"id": r["id"], "name": (r["name"] or "").strip() or r["email"], "email": r["email"]} for r in rows]


@router.get("/tracking")
def list_estimate_tracking(
    search: Optional[str] = None,
    status: Optional[str] = None,
    owner_id: Optional[int] = None,
    show_all: int = 0,
    _user=Depends(get_current_user),
):
    """All QBO estimates + OPI overlay. OPI status uses the pipeline-status
    vocabulary (lookup_values.estimate_pipeline_status, e.g. "60% Project
    Confirmed…"); the "0% …" statuses mean lost/inactive. Default view = active
    + recent: tracked-and-not-0% OR untracked Pending/Accepted within ~18 months.
    show_all=1 removes the filter."""
    where = ["t.entity_type = 'Estimate'"]
    params: dict = {}

    if not show_all:
        where.append("""(
            (et.qbo_estimate_id IS NOT NULL AND et.status NOT LIKE '0%')
            OR (et.qbo_estimate_id IS NULL
                AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json,'$.TxnStatus')) IN ('Pending','Accepted')
                AND t.txn_date >= DATE_SUB(CURDATE(), INTERVAL 18 MONTH))
        )""")
    if status:
        where.append("et.status = :status")
        params["status"] = status
    if owner_id:
        where.append("et.owner_user_id = :owner_id")
        params["owner_id"] = owner_id
    if search:
        where.append("(c.display_name LIKE :q OR t.doc_number LIKE :q "
                     "OR JSON_UNQUOTE(JSON_EXTRACT(t.raw_json,'$.CustomerMemo.value')) LIKE :q)")
        params["q"] = f"%{search}%"

    sql = text(f"""
        SELECT
            t.qbo_id                                              AS qbo_estimate_id,
            t.doc_number                                          AS est_no,
            t.txn_date                                            AS txn_date,
            ROUND(t.total_amt)                                    AS amount,
            JSON_UNQUOTE(JSON_EXTRACT(t.raw_json,'$.TxnStatus'))  AS qbo_status,
            JSON_UNQUOTE(JSON_EXTRACT(t.raw_json,'$.CustomerMemo.value')) AS description,
            c.id                                                  AS qbo_customer_id,
            c.display_name                                        AS customer_name,
            et.status                                             AS opi_status,
            et.owner_user_id                                      AS owner_user_id,
            TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS owner_name,
            (SELECT MAX(contact_date) FROM customer_contact_log cl
               WHERE cl.qbo_estimate_id = t.qbo_id)               AS last_contact_date,
            (SELECT COUNT(*) FROM customer_contact_log cl
               WHERE cl.qbo_estimate_id = t.qbo_id)               AS contact_count,
            (SELECT e.id FROM estimates e
               WHERE e.qbo_estimate_id = t.qbo_id LIMIT 1)        AS app_estimate_id
        FROM qbo_transactions t
        LEFT JOIN qbo_customers c       ON c.qbo_id = t.customer_qbo_id
        LEFT JOIN estimate_tracking et  ON et.qbo_estimate_id = t.qbo_id
        LEFT JOIN users u               ON u.id = et.owner_user_id
        WHERE {" AND ".join(where)}
        ORDER BY t.txn_date DESC, t.qbo_id DESC
        LIMIT 1000
    """)
    with engine.connect() as conn:
        rows = conn.execute(sql, params).mappings().all()

    out = []
    # Pre-QBO drafts: quoting-metrics estimates not yet linked to a QBO estimate.
    # Shown with a badge so the full pipeline is visible in one place.
    with engine.connect() as conn:
        drafts = conn.execute(text("""
            SELECT e.id, e.quote_description, e.status, e.updated_at,
                   c.id AS qbo_customer_id, c.display_name AS customer_name
            FROM estimates e LEFT JOIN qbo_customers c ON c.id = e.qbo_customer_id
            WHERE e.qbo_estimate_id IS NULL AND e.status IN ('draft','ready_for_qbo')
            ORDER BY e.updated_at DESC
        """)).mappings().all()
    for d in drafts:
        out.append({
            "qbo_estimate_id": None, "app_estimate_id": d["id"], "is_draft": True,
            "draft_status": d["status"],
            "est_no": "—", "txn_date": str(d["updated_at"])[:10] if d["updated_at"] else None,
            "amount": 0, "qbo_status": None,
            "description": d["quote_description"], "qbo_customer_id": d["qbo_customer_id"],
            "customer_name": d["customer_name"], "opi_status": "", "is_tracked": False,
            "owner_user_id": None, "owner_name": None, "last_contact_date": None, "contact_count": 0,
        })

    for r in rows:
        out.append({
            "qbo_estimate_id": r["qbo_estimate_id"], "is_draft": False,
            "est_no": r["est_no"],
            "txn_date": str(r["txn_date"]) if r["txn_date"] else None,
            "amount": float(r["amount"] or 0),
            "qbo_status": r["qbo_status"],
            "description": r["description"],
            "qbo_customer_id": r["qbo_customer_id"],
            "customer_name": r["customer_name"],
            "opi_status": r["opi_status"] or "",          # pipeline status; '' = not set
            "is_tracked": r["opi_status"] is not None,
            "owner_user_id": r["owner_user_id"],
            "owner_name": (r["owner_name"] or "").strip() or None,
            "last_contact_date": str(r["last_contact_date"]) if r["last_contact_date"] else None,
            "contact_count": int(r["contact_count"] or 0),
            "app_estimate_id": r["app_estimate_id"],   # linked quoting-metrics estimate, if any
        })
    return {"estimates": out}


class EstimateTrackingPatch(BaseModel):
    status: Optional[str] = None
    owner_user_id: Optional[int] = None
    notes: Optional[str] = None


@router.patch("/tracking/{qbo_estimate_id}")
def upsert_estimate_tracking(qbo_estimate_id: str, req: EstimateTrackingPatch,
                             _user=Depends(get_current_user)):
    # Status is a free-form pipeline value from the lookup; the UI constrains it.
    if req.status is not None and len(req.status) > 64:
        raise HTTPException(status_code=400, detail="Status too long")
    with engine.begin() as conn:
        exists = conn.execute(text(
            "SELECT 1 FROM qbo_transactions WHERE qbo_id = :id AND entity_type='Estimate'"),
            {"id": qbo_estimate_id}).first()
        if not exists:
            raise HTTPException(status_code=404, detail="Estimate not found")
        cur = conn.execute(text("SELECT status FROM estimate_tracking WHERE qbo_estimate_id=:id"),
                           {"id": qbo_estimate_id}).mappings().first()
        status = req.status if req.status is not None else (cur["status"] if cur else "")
        sets, params = ["status=:status"], {"id": qbo_estimate_id, "status": status}
        if "owner_user_id" in req.__fields_set__:
            sets.append("owner_user_id=:owner"); params["owner"] = req.owner_user_id
        if "notes" in req.__fields_set__:
            sets.append("notes=:notes"); params["notes"] = req.notes
        if cur:
            conn.execute(text(f"UPDATE estimate_tracking SET {', '.join(sets)} WHERE qbo_estimate_id=:id"), params)
        else:
            conn.execute(text("""
                INSERT INTO estimate_tracking (qbo_estimate_id, status, owner_user_id, notes)
                VALUES (:id, :status, :owner, :notes)
            """), {"id": qbo_estimate_id, "status": status,
                   "owner": req.owner_user_id if "owner_user_id" in req.__fields_set__ else None,
                   "notes": req.notes if "notes" in req.__fields_set__ else None})
    return {"ok": True, "status": status}


@router.get("/tracking/{qbo_estimate_id}/contacts")
def list_estimate_contacts(qbo_estimate_id: str, _user=Depends(get_current_user)):
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, contact_date, communication_type, notes, created_at
            FROM customer_contact_log
            WHERE qbo_estimate_id = :id
            ORDER BY contact_date DESC, id DESC
        """), {"id": qbo_estimate_id}).mappings().all()
    return [dict(r) for r in rows]


class EstimateContactCreate(BaseModel):
    contact_date: str
    communication_type: Optional[str] = None
    notes: Optional[str] = None


@router.post("/tracking/{qbo_estimate_id}/contacts")
def create_estimate_contact(qbo_estimate_id: str, req: EstimateContactCreate,
                            _user=Depends(get_current_user)):
    if not (req.contact_date or "").strip():
        raise HTTPException(status_code=400, detail="contact_date is required")
    with engine.begin() as conn:
        cust = conn.execute(text("""
            SELECT c.id FROM qbo_transactions t JOIN qbo_customers c ON c.qbo_id = t.customer_qbo_id
            WHERE t.qbo_id = :id AND t.entity_type='Estimate'
        """), {"id": qbo_estimate_id}).scalar()
        conn.execute(text("""
            INSERT INTO customer_contact_log (qbo_customer_id, qbo_estimate_id, contact_date, communication_type, notes)
            VALUES (:cid, :eid, :d, :ct, :n)
        """), {"cid": cust, "eid": qbo_estimate_id, "d": req.contact_date,
               "ct": req.communication_type, "n": req.notes})
    return {"ok": True}


# ===========================================================================
# Quoting-metrics estimate lifecycle (Phase 0b): list, ready-for-QBO, link.
# Declared before /{estimate_id} so /quoting-list isn't parsed as an int.
# ===========================================================================
# Link (qbo_estimate_id) and ready-status are INDEPENDENT — an estimate can be
# linked while still draft, or ready without a link. Both are settable anytime.
QUOTING_STATUSES = ["draft", "ready_for_qbo"]


class EstimateStatusPatch(BaseModel):
    status: str


class EstimateLinkRequest(BaseModel):
    est_no: str


@router.get("/quoting-list")
def list_quoting_estimates(_user=Depends(get_current_user)):
    """All quoting-metrics estimates (one per opportunity) for the QM landing."""
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT e.id, e.qbo_customer_id, c.display_name AS customer_name,
                   e.quote_description, e.quote_number, e.status, e.qbo_estimate_id,
                   e.revision_count, e.updated_at, e.created_at
            FROM estimates e
            LEFT JOIN qbo_customers c ON c.id = e.qbo_customer_id
            ORDER BY e.updated_at DESC, e.id DESC
        """)).mappings().all()
    return [dict(r) for r in rows]


@router.patch("/{estimate_id}/status")
def set_estimate_status(estimate_id: int, req: EstimateStatusPatch, _user=Depends(get_current_user)):
    if req.status not in ("draft", "ready_for_qbo"):
        raise HTTPException(status_code=400, detail="status must be draft or ready_for_qbo")
    with engine.begin() as conn:
        est = conn.execute(text("SELECT id, status FROM estimates WHERE id=:id"), {"id": estimate_id}).mappings().first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")
        if req.status == "ready_for_qbo":
            conn.execute(text("UPDATE estimates SET status='ready_for_qbo', ready_at=NOW(), ready_by_user_id=:u WHERE id=:id"),
                         {"id": estimate_id, "u": _user.get("id")})
        else:
            conn.execute(text("UPDATE estimates SET status='draft', ready_at=NULL, ready_by_user_id=NULL WHERE id=:id"),
                         {"id": estimate_id})
    return {"ok": True, "status": req.status}


@router.get("/{estimate_id}/qbo-candidates")
def qbo_estimate_candidates(estimate_id: int, _user=Depends(get_current_user)):
    """Recent QBO estimates for this estimate's customer — to help pick the No. to link."""
    with engine.connect() as conn:
        est = conn.execute(text("SELECT qbo_customer_qbo_id FROM estimates WHERE id=:id"), {"id": estimate_id}).mappings().first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")
        rows = conn.execute(text("""
            SELECT t.qbo_id, t.doc_number AS est_no, t.txn_date, ROUND(t.total_amt) AS amount
            FROM qbo_transactions t
            WHERE t.entity_type='Estimate' AND t.customer_qbo_id = :cid
              AND t.qbo_id NOT IN (SELECT qbo_estimate_id FROM estimates WHERE qbo_estimate_id IS NOT NULL)
            ORDER BY t.txn_date DESC LIMIT 25
        """), {"cid": est["qbo_customer_qbo_id"]}).mappings().all()
    return [{"qbo_id": r["qbo_id"], "est_no": r["est_no"], "txn_date": str(r["txn_date"]) if r["txn_date"] else None, "amount": float(r["amount"] or 0)} for r in rows]


@router.post("/{estimate_id}/link-qbo")
def link_estimate_to_qbo(estimate_id: int, req: EstimateLinkRequest, _user=Depends(get_current_user)):
    """Link this quoting estimate to a QBO estimate (by Estimate No.) and seed a
    tracking row so it flows into the Estimates page. Independent of ready-status
    (can link a draft); the QBO estimate must already exist + be synced."""
    est_no = (req.est_no or "").strip()
    if not est_no:
        raise HTTPException(status_code=400, detail="Estimate No. is required")
    with engine.begin() as conn:
        est = conn.execute(text("SELECT id, qbo_customer_qbo_id FROM estimates WHERE id=:id"), {"id": estimate_id}).mappings().first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")
        qbo = conn.execute(text("""
            SELECT qbo_id FROM qbo_transactions
            WHERE entity_type='Estimate' AND doc_number=:n
            ORDER BY (customer_qbo_id = :cid) DESC, txn_date DESC LIMIT 1
        """), {"n": est_no, "cid": est["qbo_customer_qbo_id"]}).mappings().first()
        if not qbo:
            raise HTTPException(status_code=404, detail=f"No QuickBooks estimate found with No. {est_no}. Create it in QBO first, then link.")
        already = conn.execute(text("SELECT id FROM estimates WHERE qbo_estimate_id=:q AND id<>:id"),
                               {"q": qbo["qbo_id"], "id": estimate_id}).first()
        if already:
            raise HTTPException(status_code=400, detail=f"Estimate No. {est_no} is already linked to another quoting estimate.")
        conn.execute(text("""
            UPDATE estimates SET qbo_estimate_id=:q, linked_at=NOW(), linked_by_user_id=:u,
                quote_number=:n WHERE id=:id
        """), {"q": qbo["qbo_id"], "u": _user.get("id"), "n": est_no, "id": estimate_id})
        conn.execute(text("""
            INSERT IGNORE INTO estimate_tracking (qbo_estimate_id, status) VALUES (:q, '')
        """), {"q": qbo["qbo_id"]})
    return {"ok": True, "qbo_estimate_id": qbo["qbo_id"], "est_no": est_no}


@router.post("/{estimate_id}/unlink-qbo")
def unlink_estimate_from_qbo(estimate_id: int, _user=Depends(get_current_user)):
    """Remove the link to a QBO estimate (ready-status is unchanged)."""
    with engine.begin() as conn:
        if not conn.execute(text("SELECT id FROM estimates WHERE id=:id"), {"id": estimate_id}).first():
            raise HTTPException(status_code=404, detail="Estimate not found")
        conn.execute(text("""
            UPDATE estimates SET qbo_estimate_id=NULL, linked_at=NULL, linked_by_user_id=NULL, quote_number=NULL
            WHERE id=:id
        """), {"id": estimate_id})
    return {"ok": True}


@router.get("/{estimate_id}")
def get_estimate(estimate_id: int, _user=Depends(get_current_user)):
    with engine.connect() as conn:
        return _load_estimate(conn, estimate_id)


# ---------------------------------------------------------------------------
# GET /api/estimates/by-qbo-customer/{qbo_id}
#   Lookup helper for project-context UI: given a customer's QBO id (which
#   stays stable even after is_project flips to 1), return the estimate if
#   one exists. Returns null when there's no estimate — clients can use
#   that to decide whether to render a "View Estimate" link.
# ---------------------------------------------------------------------------
@router.get("/by-qbo-customer/{qbo_id}")
def get_estimate_by_qbo_customer(qbo_id: str, _user=Depends(get_current_user)):
    with engine.connect() as conn:
        row = conn.execute(text("""
            SELECT id FROM estimates WHERE qbo_customer_qbo_id = :qid
            LIMIT 1
        """), {"qid": qbo_id}).first()
        if not row:
            return None
        return _load_estimate(conn, row[0])


# ---------------------------------------------------------------------------
# PATCH /api/estimates/{id}
#   Partial update — any field omitted from the body is left unchanged.
#   Empty strings get coerced to NULL so the DB stays clean.
# ---------------------------------------------------------------------------
class EstimatePatch(BaseModel):
    # General Info
    quote_number:                  Optional[str]   = None
    quote_description:             Optional[str]   = None
    contact_first:                 Optional[str]   = None
    contact_last:                  Optional[str]   = None
    end_user:                      Optional[str]   = None
    quoted_by:                     Optional[str]   = None
    quote_notes:                   Optional[str]   = None
    date_of_request:               Optional[str]   = None
    start_date:                    Optional[str]   = None
    project_city:                  Optional[str]   = None
    project_state:                 Optional[str]   = None
    end_date:                      Optional[str]   = None
    # revision_count + latest_revision_date are server-managed by the
    # POST /revisions endpoint — they are intentionally NOT patchable here.

    # Key Estimating Inputs
    one_way_travel_hrs:            Optional[float] = None
    equipment_requirement:         Optional[str]   = None
    rack_height:                   Optional[str]   = None
    project_time_budget_adder:     Optional[str]   = None
    project_time_budget_pct:       Optional[float] = None
    rack_install_profit_target:    Optional[float] = None
    rental_rack_profit_target:     Optional[float] = None
    mobilization_profit_target:    Optional[float] = None
    estimate_type:                 Optional[str]   = None
    breaking_out_mobilization:     Optional[str]   = None
    rent_wire_guidance_equipment:  Optional[str]   = None
    crew_count:                    Optional[int]   = None
    crew_size:                     Optional[str]   = None
    wire_guidance_profit_target:   Optional[float] = None
    rental_wire_profit_target:     Optional[float] = None
    lodging_cost_per_day:          Optional[float] = None
    mgmt_travel_multiplier:        Optional[float] = None


_PATCHABLE_FIELDS = set(EstimatePatch.model_fields.keys())


@router.patch("/{estimate_id}")
def update_estimate(estimate_id: int, req: EstimatePatch, _user=Depends(get_current_user)):
    payload = req.model_dump(exclude_unset=True)
    if not payload:
        return _load_estimate_or_404(estimate_id)

    set_clauses = []
    params: dict = {"id": estimate_id}
    for field, value in payload.items():
        if field not in _PATCHABLE_FIELDS:
            continue
        # Coerce empty-string -> NULL for cleaner storage.
        if isinstance(value, str) and value == "":
            value = None
        set_clauses.append(f"{field} = :{field}")
        params[field] = value

    if not set_clauses:
        return _load_estimate_or_404(estimate_id)

    with engine.begin() as conn:
        result = conn.execute(text(f"""
            UPDATE estimates
            SET {', '.join(set_clauses)}
            WHERE id = :id
        """), params)
        if result.rowcount == 0:
            # rowcount can be 0 if values are unchanged; confirm existence.
            exists = conn.execute(text("""
                SELECT 1 FROM estimates WHERE id = :id
            """), {"id": estimate_id}).first()
            if not exists:
                raise HTTPException(status_code=404, detail="Estimate not found")
        return _load_estimate(conn, estimate_id)


def _load_estimate_or_404(estimate_id: int):
    with engine.connect() as conn:
        return _load_estimate(conn, estimate_id)


# ---------------------------------------------------------------------------
# POST /api/estimates/{id}/revisions
#   Snapshot the current estimate state (header + all metric sets + all
#   metric lines) into estimate_revisions and increment revision_count.
#   The frontend's "Save Revision" button on the Review tab calls this.
# ---------------------------------------------------------------------------
class RevisionMeta(BaseModel):
    reason: Optional[str] = None
    note: Optional[str] = None
    total_amount: Optional[float] = None


@router.post("/{estimate_id}/revisions")
def save_estimate_revision(estimate_id: int, body: Optional[RevisionMeta] = None,
                           user=Depends(get_current_user)):
    import json
    meta = body or RevisionMeta()

    with engine.begin() as conn:
        # Verify the estimate exists.
        est = conn.execute(text("""
            SELECT * FROM estimates WHERE id = :id
        """), {"id": estimate_id}).mappings().first()
        if not est:
            raise HTTPException(status_code=404, detail="Estimate not found")

        # Pull all metric sets for this estimate (full row — includes per-set attrs).
        sets = conn.execute(text("""
            SELECT * FROM quote_metric_sets WHERE estimate_id = :eid ORDER BY sort_order, id
        """), {"eid": estimate_id}).mappings().all()

        # Pull all lines for those sets in one shot.
        lines = conn.execute(text("""
            SELECT l.*
            FROM quote_metric_lines l
            JOIN quote_metric_sets s ON s.id = l.metric_set_id
            WHERE s.estimate_id = :eid
            ORDER BY l.metric_set_id, l.sort_order, l.id
        """), {"eid": estimate_id}).mappings().all()

        # Compose the snapshot. json.dumps with default=str so Decimal/date
        # values serialize cleanly.
        snapshot = {
            "estimate":     {k: v for k, v in est.items()},
            "metric_sets":  [dict(r) for r in sets],
            "metric_lines": [dict(r) for r in lines],
        }
        snapshot_json = json.dumps(snapshot, default=str)

        # Next revision_number = current + 1.
        next_rev = int(est["revision_count"] or 0) + 1

        conn.execute(text("""
            INSERT INTO estimate_revisions
                (estimate_id, revision_number, reason, note, total_amount, saved_by_user_id, snapshot_json)
            VALUES (:eid, :rn, :reason, :note, :total, :uid, :snap)
        """), {"eid": estimate_id, "rn": next_rev, "reason": (meta.reason or None),
               "note": (meta.note or None), "total": meta.total_amount,
               "uid": user.get("id"), "snap": snapshot_json})

        # Read the auto-stamped saved_at back so the client can show "last saved".
        saved = conn.execute(text("""
            SELECT saved_at FROM estimate_revisions
            WHERE estimate_id = :eid AND revision_number = :rn
        """), {"eid": estimate_id, "rn": next_rev}).mappings().first()
        saved_at = saved["saved_at"] if saved else None

        # Mirror the latest revision date onto the estimates row so list views
        # (and the workspace header) can show it without a sub-query.
        conn.execute(text("""
            UPDATE estimates
            SET revision_count = :rn,
                latest_revision_date = CURRENT_DATE
            WHERE id = :eid
        """), {"eid": estimate_id, "rn": next_rev})

        return {
            "ok":                   True,
            "revision_number":      next_rev,
            "reason":               meta.reason or None,
            "saved_at":             str(saved_at) if saved_at else None,
            "latest_revision_date": str(saved_at.date()) if saved_at else None,
        }


# NOTE: /analytics/revisions MUST be declared before /{estimate_id}/revisions —
# otherwise Starlette matches the latter with estimate_id="analytics" → 422.
@router.get("/analytics/revisions")
def revision_analytics(_user=Depends(get_current_user)):
    """Who revises: per-customer + per-contact revision activity and reason mix.
    Only estimates that have at least one revision event are counted."""
    with engine.connect() as conn:
        by_customer = conn.execute(text("""
            SELECT qc.qbo_id, qc.display_name AS name,
                   COUNT(DISTINCT r.estimate_id) AS estimates_revised,
                   COUNT(*) AS revision_events,
                   ROUND(COUNT(*) / COUNT(DISTINCT r.estimate_id), 2) AS avg_per_estimate
            FROM estimate_revisions r
            JOIN estimates e ON e.id = r.estimate_id
            JOIN qbo_customers qc ON qc.id = e.qbo_customer_id
            GROUP BY qc.qbo_id, qc.display_name
            ORDER BY revision_events DESC, estimates_revised DESC
            LIMIT 100
        """)).mappings().all()
        by_contact = conn.execute(text("""
            SELECT ct.id AS contact_id, ct.full_name AS contact_name, qc.display_name AS customer_name,
                   COUNT(DISTINCT r.estimate_id) AS estimates_revised, COUNT(*) AS revision_events
            FROM estimate_revisions r
            JOIN estimates e ON e.id = r.estimate_id
            JOIN contacts ct ON ct.id = e.contact_id
            JOIN qbo_customers qc ON qc.id = e.qbo_customer_id
            GROUP BY ct.id, ct.full_name, qc.display_name
            ORDER BY revision_events DESC
            LIMIT 100
        """)).mappings().all()
        by_reason = conn.execute(text("""
            SELECT COALESCE(NULLIF(reason,''), '(unspecified)') AS reason, COUNT(*) AS n
            FROM estimate_revisions GROUP BY reason ORDER BY n DESC
        """)).mappings().all()
        totals = conn.execute(text("""
            SELECT COUNT(*) AS revision_events, COUNT(DISTINCT estimate_id) AS estimates_revised
            FROM estimate_revisions
        """)).mappings().first()
    return {
        "totals": {"revision_events": totals["revision_events"], "estimates_revised": totals["estimates_revised"]},
        "by_customer": [{"qbo_id": r["qbo_id"], "name": r["name"],
                         "estimates_revised": r["estimates_revised"], "revision_events": r["revision_events"],
                         "avg_per_estimate": float(r["avg_per_estimate"] or 0)} for r in by_customer],
        "by_contact": [{"contact_id": r["contact_id"], "contact_name": r["contact_name"],
                        "customer_name": r["customer_name"], "estimates_revised": r["estimates_revised"],
                        "revision_events": r["revision_events"]} for r in by_contact],
        "by_reason": [{"reason": r["reason"], "n": r["n"]} for r in by_reason],
    }


@router.get("/{estimate_id}/revisions")
def list_estimate_revisions(estimate_id: int, _user=Depends(get_current_user)):
    """Revision history for one estimate (metadata only, not the full snapshots)."""
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT r.revision_number, r.reason, r.note, r.total_amount, r.saved_at,
                   TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS saved_by,
                   u.email AS saved_by_email
            FROM estimate_revisions r
            LEFT JOIN users u ON u.id = r.saved_by_user_id
            WHERE r.estimate_id = :eid
            ORDER BY r.revision_number DESC
        """), {"eid": estimate_id}).mappings().all()
    return {"revisions": [{
        "revision_number": r["revision_number"], "reason": r["reason"], "note": r["note"],
        "total_amount": float(r["total_amount"]) if r["total_amount"] is not None else None,
        "saved_at": str(r["saved_at"]) if r["saved_at"] else None,
        "saved_by": (r["saved_by"] or "").strip() or r["saved_by_email"],
    } for r in rows]}
