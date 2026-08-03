"""
Change orders — supplemental / additional project estimates. The office creates
these in QBO (skipping the quoting-metrics workbook); they sync in as Estimates
tagged to the project. This module classifies + annotates them (original
cost-basis vs change order, CO #, reason, scope, approval status) and rolls up
the revised contract value. Also supports a quick app-side DRAFT captured before
it exists in QBO, linkable later by doc number. Ties to the per-estimate payment
schedules (Payments tab) which key on the same QBO estimates. Gated page.customers.
"""
from typing import Optional, List
from datetime import date as _date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import text

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS
from app.phases.routes import phases_payload

router = APIRouter(prefix="/api/change-orders", tags=["change-orders"])


def _require(user):
    if not has_capability(user, PAGE_CUSTOMERS):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _project_exists(conn, project_qbo_id):
    return conn.execute(text("SELECT 1 FROM qbo_customers WHERE qbo_id=:id AND is_project=1"),
                        {"id": project_qbo_id}).scalar() is not None


def _project_estimates(conn, project_qbo_id):
    """Every QBO Estimate tagged to the project — customer amount + contract labor
    ("your rate") + QBO status. Ordered oldest-first (earliest = the original)."""
    rows = conn.execute(text("""
        SELECT t.qbo_id, t.doc_number, t.txn_date,
               ROUND(MAX(t.total_amt), 2) AS amount,
               ROUND(COALESCE(SUM(CASE WHEN sl.item_name = 'Contract Labor'
                                       THEN COALESCE(sl.cost_amount, sl.amount) END), 0), 2) AS contract_labor,
               MAX(JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus'))) AS qbo_status
        FROM qbo_transactions t
        JOIN qbo_sales_transaction_lines sl ON sl.transaction_id = t.id
        WHERE t.entity_type = 'Estimate' AND sl.project_customer_qbo_id = :id
        GROUP BY t.qbo_id, t.doc_number, t.txn_date
        ORDER BY t.txn_date, t.doc_number
    """), {"id": project_qbo_id}).mappings().all()
    return rows


# QBO TxnStatus → our approval status (used when staff haven't set one).
def _derive_status(qbo_status):
    return {"Converted": "approved", "Accepted": "approved", "Closed": "approved",
            "Pending": "sent", "Rejected": "rejected"}.get(qbo_status or "", "draft")


def _overlays(conn, project_qbo_id):
    return conn.execute(text("""
        SELECT id, qbo_estimate_id, kind, co_number, title, reason, scope, amount, contract_labor, status
        FROM project_change_orders WHERE project_qbo_id = :p
    """), {"p": project_qbo_id}).mappings().all()


def _build(conn, project_qbo_id):
    ests = _project_estimates(conn, project_qbo_id)
    overlays = _overlays(conn, project_qbo_id)
    by_est = {o["qbo_estimate_id"]: o for o in overlays if o["qbo_estimate_id"]}
    drafts = [o for o in overlays if not o["qbo_estimate_id"]]

    items = []
    for idx, e in enumerate(ests):
        ov = by_est.get(e["qbo_id"])
        kind = ov["kind"] if ov else ("original" if idx == 0 else "change_order")
        status = ov["status"] if ov else _derive_status(e["qbo_status"])
        items.append({
            "co_id": ov["id"] if ov else None, "source": "qbo",
            "qbo_estimate_id": e["qbo_id"], "doc_number": e["doc_number"],
            "txn_date": str(e["txn_date"]) if e["txn_date"] else None,
            "kind": kind, "co_number": None,
            "title": ov["title"] if ov else None, "reason": ov["reason"] if ov else None,
            "scope": ov["scope"] if ov else None, "status": status,
            "amount": float(e["amount"] or 0), "contract_labor": float(e["contract_labor"] or 0),
            "qbo_status": e["qbo_status"],
        })
    for o in drafts:
        items.append({
            "co_id": o["id"], "source": "draft", "qbo_estimate_id": None, "doc_number": None,
            "txn_date": None, "kind": o["kind"], "co_number": None,
            "title": o["title"], "reason": o["reason"], "scope": o["scope"], "status": o["status"],
            "amount": float(o["amount"] or 0), "contract_labor": float(o["contract_labor"] or 0),
            "qbo_status": None,
        })

    # CO # is a single display sequence across all change orders (QBO first by
    # date, then drafts) so numbers never collide regardless of source.
    co_seq = 0
    for i in items:
        if i["kind"] == "change_order":
            co_seq += 1
            i["co_number"] = co_seq

    orig = [i for i in items if i["kind"] == "original"]
    cos = [i for i in items if i["kind"] == "change_order"]
    approved_cos = [i for i in cos if i["status"] == "approved"]
    original_amount = round(sum(i["amount"] for i in orig), 2)
    approved_co_amount = round(sum(i["amount"] for i in approved_cos), 2)
    pending_co_amount = round(sum(i["amount"] for i in cos if i["status"] in ("sent", "draft")), 2)
    labor_total = round(sum(i["contract_labor"] for i in items if i["status"] == "approved"), 2)
    rollup = {
        "original_amount": original_amount,
        "approved_co_amount": approved_co_amount,
        "pending_co_amount": pending_co_amount,
        "revised_contract": round(original_amount + approved_co_amount, 2),
        "contract_labor_total": labor_total,
        "change_order_count": len(cos),
        "approved_change_order_count": len(approved_cos),
    }
    return items, rollup


@router.get("/project/{project_qbo_id}")
def get_change_orders(project_qbo_id: str, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:  # begin(): phase auto-assign writes must commit
        if not _project_exists(conn, project_qbo_id):
            raise HTTPException(status_code=404, detail="Project not found")
        name = conn.execute(text("SELECT display_name FROM qbo_customers WHERE qbo_id=:id"),
                            {"id": project_qbo_id}).scalar()
        items, rollup = _build(conn, project_qbo_id)
        # Phases group the ACCEPTED estimates into work windows (auto-suggested).
        accepted_ids = [i["qbo_estimate_id"] for i in items
                        if i["qbo_estimate_id"] and i["status"] == "approved"]
        phases = phases_payload(conn, project_qbo_id, accepted_ids)
    return {"project": {"qbo_id": project_qbo_id, "name": name},
            "items": items, "rollup": rollup, **phases}


@router.get("/project/{project_qbo_id}/estimate/{qbo_estimate_id}/lines")
def estimate_lines(project_qbo_id: str, qbo_estimate_id: str, user=Depends(get_current_user)):
    """The QBO line items on one estimate — so each estimate in the Change Orders
    tab can expand to show what's in it (item, qty, rate, customer amount, cost)."""
    _require(user)
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT sl.item_name, sl.description, sl.qty, sl.unit_price, sl.amount, sl.cost_amount
            FROM qbo_sales_transaction_lines sl
            JOIN qbo_transactions t ON t.id = sl.transaction_id
            WHERE t.entity_type = 'Estimate' AND t.qbo_id = :e AND sl.line_level = 'child'
            ORDER BY sl.line_num, sl.id
        """), {"e": qbo_estimate_id}).mappings().all()
    num = lambda v: float(v) if v is not None else None
    return {"lines": [{
        "item": r["item_name"], "description": r["description"],
        "qty": num(r["qty"]), "unit_price": num(r["unit_price"]),
        "amount": float(r["amount"] or 0), "cost_amount": num(r["cost_amount"]),
    } for r in rows]}


class COPdfLine(BaseModel):
    label: str = ""
    description: str = ""
    qty: Optional[float] = None
    rate: Optional[float] = None
    amount: Optional[float] = None


class COPdfReq(BaseModel):
    title: Optional[str] = None
    lines: List[COPdfLine] = []
    total: float = 0.0


@router.post("/project/{project_qbo_id}/estimate-pdf")
def co_estimate_pdf(project_qbo_id: str, req: COPdfReq, user=Depends(get_current_user)):
    """Generate an OPI-branded change-order estimate PDF from an editable form —
    the app-native path for creating a change order (no need to build it in QBO
    first). Reuses the estimate-PDF renderer + the company defaults."""
    _require(user)
    from app.estimates.pdf import render_estimate_pdf
    with engine.connect() as conn:
        proj = conn.execute(text("SELECT display_name FROM qbo_customers WHERE qbo_id=:e AND is_project=1"),
                            {"e": project_qbo_id}).scalar()
        if not proj:
            raise HTTPException(status_code=404, detail="Project not found")
        dfl = {k: v for k, v in conn.execute(text("SELECT setting_key, setting_value FROM estimate_pdf_defaults")).all()}
    today = _date.today()
    try:
        exp_days = int(dfl.get("expiration_days") or 30)
    except (TypeError, ValueError):
        exp_days = 30
    data = {
        "company": {"name": dfl.get("company_name"), "address": dfl.get("company_address"),
                    "phone": dfl.get("company_phone"), "email": dfl.get("company_email")},
        "estimate_no":     "CO",
        "date":            today.strftime("%m/%d/%Y"),
        "expiration_date": (today + timedelta(days=exp_days)).strftime("%m/%d/%Y"),
        "sales_rep":       dfl.get("sales_rep"),
        "bill_to":         [proj, ("Change order — " + req.title) if req.title else "Change order"],
        "footer_title":    req.title or "Change Order",
        "preparer":        user.get("email"),
        "lines":           [ln.model_dump() for ln in req.lines],
        "total":           req.total,
    }
    pdf = render_estimate_pdf(data)
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": 'inline; filename="Change-Order-Estimate.pdf"'})


_KINDS = ("original", "change_order")
_STATUSES = ("draft", "sent", "approved", "rejected")


class EstimateOverlay(BaseModel):
    kind: Optional[str] = None
    co_number: Optional[int] = None
    title: Optional[str] = None
    reason: Optional[str] = None
    scope: Optional[str] = None
    status: Optional[str] = None


@router.put("/project/{project_qbo_id}/estimate/{qbo_estimate_id}")
def upsert_estimate_overlay(project_qbo_id: str, qbo_estimate_id: str,
                            body: EstimateOverlay, user=Depends(get_current_user)):
    """Classify / annotate a QBO estimate (idempotent — creates the overlay row on
    first edit, updates it after)."""
    _require(user)
    if body.kind and body.kind not in _KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {_KINDS}")
    if body.status and body.status not in _STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {_STATUSES}")
    with engine.begin() as conn:
        est = conn.execute(text("""
            SELECT MAX(JSON_UNQUOTE(JSON_EXTRACT(t.raw_json,'$.TxnStatus'))) AS qs
            FROM qbo_transactions t JOIN qbo_sales_transaction_lines sl ON sl.transaction_id=t.id
            WHERE t.entity_type='Estimate' AND t.qbo_id=:e AND sl.project_customer_qbo_id=:p
        """), {"e": qbo_estimate_id, "p": project_qbo_id}).mappings().first()
        if not est or est["qs"] is None:
            raise HTTPException(status_code=404, detail="Estimate not tagged to this project")
        existing = conn.execute(text("SELECT id FROM project_change_orders WHERE qbo_estimate_id=:e"),
                                {"e": qbo_estimate_id}).mappings().first()
        kind = body.kind or "change_order"
        status = body.status or _derive_status(est["qs"])
        if existing:
            fields = body.model_dump(exclude_unset=True)
            sets, params = [], {"id": existing["id"]}
            for k in ("kind", "co_number", "title", "reason", "scope", "status"):
                if k in fields:
                    sets.append(f"{k} = :{k}"); params[k] = fields[k]
            if sets:
                conn.execute(text(f"UPDATE project_change_orders SET {', '.join(sets)} WHERE id=:id"), params)
            cid = existing["id"]
        else:
            res = conn.execute(text("""
                INSERT INTO project_change_orders
                    (project_qbo_id, qbo_estimate_id, kind, co_number, title, reason, scope, status, created_by_user_id)
                VALUES (:p,:e,:kind,:co,:title,:reason,:scope,:status,:uid)
            """), {"p": project_qbo_id, "e": qbo_estimate_id, "kind": kind, "co": body.co_number,
                   "title": body.title, "reason": body.reason, "scope": body.scope,
                   "status": status, "uid": user.get("id")})
            cid = res.lastrowid
        items, rollup = _build(conn, project_qbo_id)
    return {"ok": True, "co_id": cid, "items": items, "rollup": rollup}


class DraftCreate(BaseModel):
    kind: str = "change_order"
    title: Optional[str] = None
    reason: Optional[str] = None
    scope: Optional[str] = None
    amount: Optional[float] = None
    contract_labor: Optional[float] = None
    status: str = "draft"


@router.post("/project/{project_qbo_id}/draft")
def create_draft(project_qbo_id: str, body: DraftCreate, user=Depends(get_current_user)):
    """Quick app-side change order not yet in QBO (no workbook)."""
    _require(user)
    if body.kind not in _KINDS or body.status not in _STATUSES:
        raise HTTPException(status_code=400, detail="Invalid kind or status")
    with engine.begin() as conn:
        if not _project_exists(conn, project_qbo_id):
            raise HTTPException(status_code=404, detail="Project not found")
        # co_number is a display sequence assigned at read time (see _build), so
        # we don't store one here.
        res = conn.execute(text("""
            INSERT INTO project_change_orders
                (project_qbo_id, kind, title, reason, scope, amount, contract_labor, status, created_by_user_id)
            VALUES (:p,:kind,:title,:reason,:scope,:amount,:labor,:status,:uid)
        """), {"p": project_qbo_id, "kind": body.kind, "title": body.title,
               "reason": body.reason, "scope": body.scope, "amount": body.amount,
               "labor": body.contract_labor, "status": body.status, "uid": user.get("id")})
        items, rollup = _build(conn, project_qbo_id)
    return {"ok": True, "co_id": res.lastrowid, "items": items, "rollup": rollup}


class DraftPatch(BaseModel):
    kind: Optional[str] = None
    co_number: Optional[int] = None
    title: Optional[str] = None
    reason: Optional[str] = None
    scope: Optional[str] = None
    amount: Optional[float] = None
    contract_labor: Optional[float] = None
    status: Optional[str] = None


def _project_of(conn, co_id):
    return conn.execute(text("SELECT project_qbo_id FROM project_change_orders WHERE id=:i"),
                        {"i": co_id}).scalar()


@router.patch("/{co_id}")
def patch_change_order(co_id: int, body: DraftPatch, user=Depends(get_current_user)):
    _require(user)
    fields = body.model_dump(exclude_unset=True)
    with engine.begin() as conn:
        pid = _project_of(conn, co_id)
        if not pid:
            raise HTTPException(status_code=404, detail="Change order not found")
        cols = {"kind", "co_number", "title", "reason", "scope", "amount", "contract_labor", "status"}
        sets, params = [], {"id": co_id}
        for k, v in fields.items():
            if k in cols:
                sets.append(f"{k} = :{k}"); params[k] = v
        if sets:
            conn.execute(text(f"UPDATE project_change_orders SET {', '.join(sets)} WHERE id=:id"), params)
        items, rollup = _build(conn, pid)
    return {"ok": True, "items": items, "rollup": rollup}


@router.delete("/{co_id}")
def delete_change_order(co_id: int, user=Depends(get_current_user)):
    """Deletes the overlay row. For a QBO estimate this just removes the
    classification (the estimate itself stays in QBO)."""
    _require(user)
    with engine.begin() as conn:
        pid = _project_of(conn, co_id)
        if not pid:
            raise HTTPException(status_code=404, detail="Change order not found")
        conn.execute(text("DELETE FROM project_change_orders WHERE id=:id"), {"id": co_id})
        items, rollup = _build(conn, pid)
    return {"ok": True, "items": items, "rollup": rollup}


class LinkReq(BaseModel):
    doc_number: str


@router.post("/{co_id}/link-qbo")
def link_draft_to_qbo(co_id: int, body: LinkReq, user=Depends(get_current_user)):
    """Attach a draft change order to its QBO estimate once it exists (match by
    doc number among estimates tagged to the project)."""
    _require(user)
    with engine.begin() as conn:
        row = conn.execute(text("SELECT project_qbo_id, qbo_estimate_id FROM project_change_orders WHERE id=:i"),
                           {"i": co_id}).mappings().first()
        if not row:
            raise HTTPException(status_code=404, detail="Change order not found")
        if row["qbo_estimate_id"]:
            raise HTTPException(status_code=400, detail="Already linked")
        est = conn.execute(text("""
            SELECT DISTINCT t.qbo_id FROM qbo_transactions t
            JOIN qbo_sales_transaction_lines sl ON sl.transaction_id=t.id
            WHERE t.entity_type='Estimate' AND t.doc_number=:d AND sl.project_customer_qbo_id=:p
        """), {"d": body.doc_number, "p": row["project_qbo_id"]}).mappings().first()
        if not est:
            raise HTTPException(status_code=404, detail="No estimate #%s tagged to this project (synced?)" % body.doc_number)
        dup = conn.execute(text("SELECT 1 FROM project_change_orders WHERE qbo_estimate_id=:e AND id<>:i"),
                           {"e": est["qbo_id"], "i": co_id}).scalar()
        if dup:
            raise HTTPException(status_code=400, detail="That estimate is already linked to another change order")
        conn.execute(text("UPDATE project_change_orders SET qbo_estimate_id=:e WHERE id=:i"),
                     {"e": est["qbo_id"], "i": co_id})
        items, rollup = _build(conn, row["project_qbo_id"])
    return {"ok": True, "items": items, "rollup": rollup}
