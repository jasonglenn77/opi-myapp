"""
Receipts flow (Crew Portal build step 4; Design v3 item 5, migration 0055).

Real-time project spend + the credit-card reconciliation queue. Today's manual
process is: company card -> paper receipt -> PM reconciles against the
statement -> office allocates the expense in QBO. This mirrors it:

  1. Crew (passcode token) or PM/office (user token) uploads the receipt file
     (photo/PDF) through the SAME documents path the forms use, filed into the
     project's "8 Receipts" folder tree, then files a `receipts` row with
     amount / category (travel | materials | propane_fuel | other) / vendor /
     date. charged_back=1 means "should be charged back to the customer" ->
     the PM is flagged for a change order (rendered as a flag everywhere).
  2. PM marks it `reconciled` (page.pm_portal tier).
  3. Office marks it `allocated` in QBO (page.financials or admin tier).
     Backwards moves are allowed for corrections BY THE SAME TIER
     (reconciled -> uploaded by the PM tier; allocated -> reconciled by the
     office tier).

Receipts not yet allocated show as a SOFT overlay on the PM Overview's expense
burndown ("+ $X in receipts pending" — an early signal before QBO).

Auth matrix
-----------
  POST /upload, POST /            crew token (require_crew_project write=True:
                                  assigned projects only, past = read-only) OR
                                  user token w/ page.pm_portal or page.financials
  GET  /                          user token w/ page.pm_portal or page.financials
                                  (all rows + per-category totals) OR crew token
                                  (scoped; ONLY their own crew's submissions)
  PATCH /{id} {status}            user tokens only (a crew token 401s):
                                  -> reconciled / undo to uploaded: PM tier
                                  -> allocated / undo to reconciled: office tier
Every write is audited (amounts are fine to log — never a passcode).
"""
import json
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import text

from app.db import engine
from app.audit import record_audit
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_PM_PORTAL, PAGE_FINANCIALS
from app.crewauth.routes import get_user_or_crew, actor_for_audit, require_crew_project
from app.documents.routes import store_document_bytes
from app.s3 import signed_file_url

router = APIRouter(prefix="/api/receipts", tags=["receipts"])

CATEGORIES = ("travel", "materials", "propane_fuel", "other")
STATUSES = ("uploaded", "reconciled", "allocated")

# Where receipt files land in the project's S3 document tree (keys from
# documents.routes.FOLDER_TREE, so they show in the Documents tab). The tree's
# "8 Receipts" folder has exactly two subfolders — travel receipts file into
# "8_receipts/travel", every other category into "8_receipts/materials" (the
# first subfolder; propane_fuel/other have no dedicated subfolder in the
# established Drive-mirrored tree).
RECEIPT_FOLDER_DEFAULT = "8_receipts/materials"
RECEIPT_FOLDER_BY_CATEGORY = {
    "travel": "8_receipts/travel",
    "materials": "8_receipts/materials",
    "propane_fuel": "8_receipts/materials",
    "other": "8_receipts/materials",
}

MAX_UPLOAD_BYTES = 100 * 1024 * 1024   # same cap as /api/documents + /api/forms/upload
ALLOWED_CT_PREFIXES = ("image/",)
ALLOWED_CT_EXACT = ("application/pdf",)

# Valid status transitions -> the tier allowed to make them.
# "pm" = page.pm_portal or page.financials; "office" = page.financials or admin.
TRANSITIONS = {
    ("uploaded", "reconciled"): "pm",
    ("reconciled", "uploaded"): "pm",        # PM-tier correction
    ("reconciled", "allocated"): "office",
    ("allocated", "reconciled"): "office",   # office-tier correction
}


# ── helpers ─────────────────────────────────────────────────────────────────
def _project_meta(conn, project_qbo_id):
    return conn.execute(text(
        "SELECT qbo_id, display_name FROM qbo_customers WHERE qbo_id = :id"
    ), {"id": project_qbo_id}).mappings().first()


def _require_user_tier(actor):
    """User-token actors need the PM or office tier; crew actors pass (their
    project scoping happens in require_crew_project)."""
    if actor.get("kind") != "user":
        return
    u = actor["user"]
    if not (has_capability(u, PAGE_PM_PORTAL) or has_capability(u, PAGE_FINANCIALS)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _project_crew_names(conn, project_qbo_id):
    """Active crew name(s) on the project (assignment chain) — for the
    on-behalf submitted_by context."""
    return conn.execute(text("""
        SELECT GROUP_CONCAT(DISTINCT wc.name ORDER BY swc.is_primary DESC, wc.name
                            SEPARATOR ', ')
        FROM projects p
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        JOIN project_schedule_items psi ON psi.project_id = p.id
        JOIN project_schedule_item_work_crews swc ON swc.schedule_item_id = psi.id
        JOIN work_crews wc ON wc.id = swc.work_crew_id
        WHERE qc.qbo_id = :e AND swc.unassigned_at IS NULL
    """), {"e": project_qbo_id}).scalar()


def _user_display_name(conn, user_id, fallback):
    name = conn.execute(text("""
        SELECT TRIM(CONCAT(COALESCE(first_name,''),' ',COALESCE(last_name,'')))
        FROM users WHERE id = :id
    """), {"id": user_id}).scalar()
    return (name or "").strip() or fallback


def submitted_by_context(conn, actor, project_qbo_id):
    """crew_context-style JSON for `submitted_by` — the same shape
    forms.submit stores (user tokens = the PM/office acting on behalf of the
    assigned crew)."""
    if actor.get("kind") == "crew":
        return {"kind": "crew", "crew_id": actor.get("crew_id"),
                "crew_name": actor.get("crew_name"), "role": actor.get("role"),
                "label": actor.get("label")}
    u = actor["user"]
    return {"kind": "user", "user_id": u.get("id"), "email": u.get("email"),
            "on_behalf": True,
            "user": _user_display_name(conn, u.get("id"), u.get("email")),
            "crew": _project_crew_names(conn, project_qbo_id)}


def _parse_ctx(v):
    try:
        return json.loads(v) if isinstance(v, (str, bytes)) else v
    except Exception:
        return None


def _iso_date(s):
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


# ── upload (into the project's "8 Receipts" folder) ────────────────────────
@router.post("/upload")
async def upload_receipt_file(project_qbo_id: str = Query(...),
                              category: Optional[str] = Query(default=None),
                              file: UploadFile = File(...),
                              actor=Depends(get_user_or_crew)):
    """Store a receipt photo/PDF through the SAME S3 + documents-table path the
    Documents tab uses, filed under "8 Receipts" (travel -> its travel
    subfolder, everything else -> materials, the first subfolder). Returns the
    document id to reference from POST /api/receipts. Crew tokens are scoped
    to their assigned projects; completed projects are read-only."""
    _require_user_tier(actor)
    ct = (file.content_type or "").lower()
    if not (ct.startswith(ALLOWED_CT_PREFIXES) or ct in ALLOWED_CT_EXACT):
        raise HTTPException(status_code=400, detail="Only images and PDFs are allowed")
    body = await file.read()
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="File exceeds 100 MB limit")
    if category is not None and category not in CATEGORIES:
        raise HTTPException(status_code=400,
                            detail=f"category must be one of {', '.join(CATEGORIES)}")
    folder = RECEIPT_FOLDER_BY_CATEGORY.get(category or "", RECEIPT_FOLDER_DEFAULT)

    with engine.connect() as conn:
        if not _project_meta(conn, project_qbo_id):
            raise HTTPException(status_code=404, detail="Project not found")
        require_crew_project(conn, actor, project_qbo_id, write=True)

    uploader_id = actor["user"].get("id") if actor.get("kind") == "user" else None
    doc_id = store_document_bytes("project", project_qbo_id, folder,
                                  file.filename or "receipt", body,
                                  content_type=ct or "application/octet-stream",
                                  user_id=uploader_id)
    record_audit(actor_for_audit(actor), "receipt.upload", "document", doc_id, file.filename,
                 {"project_qbo_id": project_qbo_id, "folder": folder,
                  "category": category, "size_bytes": len(body)})
    return {"ok": True, "document_id": doc_id, "folder": folder, "filename": file.filename}


# ── create ──────────────────────────────────────────────────────────────────
class ReceiptCreate(BaseModel):
    project_qbo_id: str
    document_id: int
    amount: Optional[float] = None
    category: str = "other"
    vendor: Optional[str] = None
    receipt_date: Optional[str] = None    # YYYY-MM-DD
    charged_back: bool = False            # true = flag the PM for a change order
    notes: Optional[str] = None


@router.post("")
def create_receipt(body: ReceiptCreate, actor=Depends(get_user_or_crew)):
    """File the receipt row for an uploaded file. charged_back=1 marks it ⚑
    ("should be charged back to the customer" -> the PM needs a change
    order). Audited receipt.create — amounts are fine to log."""
    _require_user_tier(actor)
    if body.category not in CATEGORIES:
        raise HTTPException(status_code=400,
                            detail=f"category must be one of {', '.join(CATEGORIES)}")
    amount = None
    if body.amount is not None:
        try:
            amount = Decimal(str(body.amount)).quantize(Decimal("0.01"))
        except (InvalidOperation, ValueError):
            raise HTTPException(status_code=400, detail="amount must be a number")
        if amount < 0:
            raise HTTPException(status_code=400, detail="amount cannot be negative")
    rdate = None
    if body.receipt_date:
        rdate = _iso_date(body.receipt_date)
        if not rdate:
            raise HTTPException(status_code=400, detail="receipt_date must be YYYY-MM-DD")
    vendor = (body.vendor or "").strip()[:200] or None
    notes = (body.notes or "").strip()[:500] or None

    with engine.connect() as conn:
        meta = _project_meta(conn, body.project_qbo_id)
        if not meta:
            raise HTTPException(status_code=404, detail="Project not found")
        require_crew_project(conn, actor, body.project_qbo_id, write=True)
        # The document must be a real file on THIS project (no cross-filing).
        doc = conn.execute(text("""
            SELECT id FROM documents
            WHERE id = :d AND entity_type = 'project' AND entity_id = :e
        """), {"d": body.document_id, "e": str(body.project_qbo_id)}).scalar()
        if doc is None:
            raise HTTPException(status_code=400,
                                detail="document_id is not an uploaded file of this project")
        ctx = submitted_by_context(conn, actor, body.project_qbo_id)

    with engine.begin() as conn:
        rec_id = conn.execute(text("""
            INSERT INTO receipts (project_qbo_id, document_id, amount, category,
                                  vendor, receipt_date, charged_back, notes, submitted_by)
            VALUES (:p, :d, :a, :c, :v, :rd, :cb, :n, :sb)
        """), {"p": body.project_qbo_id, "d": body.document_id,
               "a": str(amount) if amount is not None else None,
               "c": body.category, "v": vendor,
               "rd": rdate.isoformat() if rdate else None,
               "cb": 1 if body.charged_back else 0, "n": notes,
               "sb": json.dumps(ctx)}).lastrowid

    record_audit(actor_for_audit(actor), "receipt.create", "receipt", rec_id,
                 f"{body.category} @ {meta['display_name']}",
                 {"project_qbo_id": body.project_qbo_id, "document_id": body.document_id,
                  "amount": str(amount) if amount is not None else None,
                  "category": body.category, "vendor": vendor,
                  "receipt_date": rdate.isoformat() if rdate else None,
                  "charged_back": bool(body.charged_back)})
    return {"ok": True, "id": rec_id, "status": "uploaded",
            "charged_back": bool(body.charged_back)}


# ── list ────────────────────────────────────────────────────────────────────
def _receipt_row(r):
    ctx = _parse_ctx(r["submitted_by"])
    return {
        "id": r["id"], "project_qbo_id": r["project_qbo_id"],
        "document_id": r["document_id"],
        "filename": r["original_filename"],
        "content_type": r["content_type"],
        "file_url": signed_file_url(r["s3_key"]) if r["s3_key"] else None,
        "amount": float(r["amount"]) if r["amount"] is not None else None,
        "category": r["category"], "vendor": r["vendor"],
        "receipt_date": str(r["receipt_date"]) if r["receipt_date"] else None,
        "charged_back": bool(r["charged_back"]), "notes": r["notes"],
        "submitted_by": ctx, "status": r["status"],
        "created_at": str(r["created_at"]) if r["created_at"] else None,
        "reconciled_by": (r["reconciled_by"] or "").strip() or None,
        "reconciled_at": str(r["reconciled_at"]) if r["reconciled_at"] else None,
        "allocated_by": (r["allocated_by"] or "").strip() or None,
        "allocated_at": str(r["allocated_at"]) if r["allocated_at"] else None,
    }


@router.get("")
def list_receipts(project_qbo_id: str = Query(...), actor=Depends(get_user_or_crew)):
    """This project's receipts. PM/office users (page.pm_portal or
    page.financials): ALL rows + per-category totals split pending
    (uploaded+reconciled — not yet in QBO) vs allocated. Crew tokens: scoped
    to their assigned projects and ONLY their own crew's submissions (the boss
    master code sees every crew's field submissions; never PM/office rows)."""
    _require_user_tier(actor)
    with engine.connect() as conn:
        if not _project_meta(conn, project_qbo_id):
            raise HTTPException(status_code=404, detail="Project not found")
        require_crew_project(conn, actor, project_qbo_id)   # read OK on past

        rows = conn.execute(text("""
            SELECT r.*, d.original_filename, d.content_type, d.s3_key,
                   TRIM(CONCAT(COALESCE(ru.first_name,''),' ',COALESCE(ru.last_name,''))) AS reconciled_by,
                   TRIM(CONCAT(COALESCE(au.first_name,''),' ',COALESCE(au.last_name,''))) AS allocated_by
            FROM receipts r
            LEFT JOIN documents d ON d.id = r.document_id
            LEFT JOIN users ru ON ru.id = r.reconciled_by_user_id
            LEFT JOIN users au ON au.id = r.allocated_by_user_id
            WHERE r.project_qbo_id = :e
            ORDER BY r.created_at DESC, r.id DESC
        """), {"e": project_qbo_id}).mappings().all()

    items = [_receipt_row(dict(r)) for r in rows]

    if actor.get("kind") == "crew":
        # Only field submissions — the crew's own (boss master code: all crews).
        my_crew = actor.get("crew_id")
        items = [i for i in items
                 if (i["submitted_by"] or {}).get("kind") == "crew"
                 and (actor.get("role") == "boss"
                      or (i["submitted_by"] or {}).get("crew_id") == my_crew)]
        return {"project_qbo_id": str(project_qbo_id), "receipts": items}

    totals = {c: {"pending": 0.0, "allocated": 0.0} for c in CATEGORIES}
    for i in items:
        amt = i["amount"] or 0.0
        bucket = "allocated" if i["status"] == "allocated" else "pending"
        totals.setdefault(i["category"], {"pending": 0.0, "allocated": 0.0})
        totals[i["category"]][bucket] += amt
    by_category = [{"category": c, "pending": round(v["pending"], 2),
                    "allocated": round(v["allocated"], 2)}
                   for c, v in totals.items()]
    return {"project_qbo_id": str(project_qbo_id), "receipts": items,
            "totals": {"by_category": by_category,
                       "pending": round(sum(v["pending"] for v in totals.values()), 2),
                       "allocated": round(sum(v["allocated"] for v in totals.values()), 2)}}


# ── status transitions (the reconciliation queue) ───────────────────────────
class ReceiptStatusPatch(BaseModel):
    status: str


@router.patch("/{receipt_id}")
def set_receipt_status(receipt_id: int, body: ReceiptStatusPatch,
                       user=Depends(get_current_user)):
    """Move a receipt along uploaded -> reconciled -> allocated (backwards
    allowed for corrections by the same tier). reconciled = the PM tier
    (page.pm_portal / page.financials); allocated = the office tier
    (page.financials or admin). Crew tokens can't reach this (401 — user
    tokens only). Audited with old -> new."""
    new_status = (body.status or "").strip().lower()
    if new_status not in STATUSES:
        raise HTTPException(status_code=400,
                            detail=f"status must be one of {', '.join(STATUSES)}")
    with engine.begin() as conn:
        r = conn.execute(text("""
            SELECT id, project_qbo_id, status, amount, category FROM receipts WHERE id = :id
        """), {"id": receipt_id}).mappings().first()
        if not r:
            raise HTTPException(status_code=404, detail="Receipt not found")
        old_status = r["status"]
        if new_status == old_status:
            raise HTTPException(status_code=400, detail=f"Receipt is already {old_status}")
        tier = TRANSITIONS.get((old_status, new_status))
        if tier is None:
            raise HTTPException(status_code=400,
                                detail=f"Can't move a receipt from {old_status} to {new_status}")
        is_admin = (user.get("role") or "").lower() == "admin"
        if tier == "office":
            if not (has_capability(user, PAGE_FINANCIALS) or is_admin):
                raise HTTPException(status_code=403,
                                    detail="Allocating in QBO is an office action (financials access required)")
        else:
            if not (has_capability(user, PAGE_PM_PORTAL) or has_capability(user, PAGE_FINANCIALS)):
                raise HTTPException(status_code=403, detail="Insufficient permissions")

        if new_status == "reconciled" and old_status == "uploaded":
            conn.execute(text("""
                UPDATE receipts SET status = 'reconciled',
                    reconciled_by_user_id = :u, reconciled_at = NOW()
                WHERE id = :id
            """), {"id": receipt_id, "u": user.get("id")})
        elif new_status == "uploaded":
            conn.execute(text("""
                UPDATE receipts SET status = 'uploaded',
                    reconciled_by_user_id = NULL, reconciled_at = NULL
                WHERE id = :id
            """), {"id": receipt_id})
        elif new_status == "allocated":
            conn.execute(text("""
                UPDATE receipts SET status = 'allocated',
                    allocated_by_user_id = :u, allocated_at = NOW()
                WHERE id = :id
            """), {"id": receipt_id, "u": user.get("id")})
        else:  # allocated -> reconciled (undo the office step)
            conn.execute(text("""
                UPDATE receipts SET status = 'reconciled',
                    allocated_by_user_id = NULL, allocated_at = NULL
                WHERE id = :id
            """), {"id": receipt_id})

    record_audit(user, "receipt.status", "receipt", receipt_id,
                 f"{r['category']} @ {r['project_qbo_id']}",
                 {"changes": {"status": [old_status, new_status]},
                  "amount": str(r["amount"]) if r["amount"] is not None else None})
    return {"ok": True, "id": receipt_id, "status": new_status}
