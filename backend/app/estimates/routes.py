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


@router.post("")
def create_or_get_estimate(req: EstimateCreate, _user=Depends(get_current_user)):
    """
    Upsert by qbo_customer_id (1:1). Returns the existing estimate when
    one already exists — idempotent on retry. Otherwise creates a new
    one with all input fields NULL.
    """
    with engine.begin() as conn:
        existing = conn.execute(text("""
            SELECT id FROM estimates WHERE qbo_customer_id = :cid
        """), {"cid": req.qbo_customer_id}).first()
        if existing:
            return _load_estimate(conn, existing[0])

        # Verify the customer actually exists and is eligible — keeps junk
        # estimates from being created against non-customer ids. Also capture
        # the external qbo_id so the estimate row stands on its own even if
        # qbo_customers is later re-synced.
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

        result = conn.execute(text("""
            INSERT INTO estimates (qbo_customer_id, qbo_customer_qbo_id)
            VALUES (:cid, :qid)
        """), {"cid": customer["id"], "qid": customer["qbo_id"]})
        return _load_estimate(conn, result.lastrowid)


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
@router.post("/{estimate_id}/revisions")
def save_estimate_revision(estimate_id: int, _user=Depends(get_current_user)):
    import json

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
            INSERT INTO estimate_revisions (estimate_id, revision_number, snapshot_json)
            VALUES (:eid, :rn, :snap)
        """), {"eid": estimate_id, "rn": next_rev, "snap": snapshot_json})

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
            "saved_at":             str(saved_at) if saved_at else None,
            "latest_revision_date": str(saved_at.date()) if saved_at else None,
        }
