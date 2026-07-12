"""
Contacts — app-owned people under a customer company. Seeded once from QBO's
primary-contact fields (migration 0012), then managed here (multiple contacts per
customer). Estimates/opportunities file under a contact for granular reporting.
Not written back to QBO.

Customer links use the QBO id STRING at the API boundary (what the frontend has)
and resolve to the internal qbo_customers.id for storage. Gated page.customers OR
page.estimate (both office and estimators manage contacts).
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS, PAGE_ESTIMATE

router = APIRouter(prefix="/api/contacts", tags=["contacts"])


def _require(user):
    if not (has_capability(user, PAGE_CUSTOMERS) or has_capability(user, PAGE_ESTIMATE)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _resolve_customer(conn, customer_qbo_id):
    """Map a QBO customer id STRING → internal qbo_customers row (id, qbo_id, name)."""
    return conn.execute(text(
        "SELECT id, qbo_id, display_name FROM qbo_customers WHERE qbo_id = :q"
    ), {"q": str(customer_qbo_id)}).mappings().first()


def _fullname(first, last, full):
    if full and full.strip():
        return full.strip()
    combined = f"{first or ''} {last or ''}".strip()
    return combined or None


def _row(r):
    return {
        "id": r["id"],
        "qbo_customer_id": r["qbo_customer_id"],
        "customer_qbo_id": r["customer_qbo_id"],
        "customer_name": r["customer_name"],
        "first_name": r["first_name"], "last_name": r["last_name"],
        "full_name": _fullname(r["first_name"], r["last_name"], r["full_name"]),
        "email": r["email"], "phone": r["phone"], "title": r["title"],
        "is_primary": bool(r["is_primary"]), "active": bool(r["active"]),
        "source": r["source"], "notes": r["notes"],
    }


_SELECT = """
    SELECT c.id, c.qbo_customer_id, qc.qbo_id AS customer_qbo_id, qc.display_name AS customer_name,
           c.first_name, c.last_name, c.full_name, c.email, c.phone, c.title,
           c.is_primary, c.active, c.source, c.notes
    FROM contacts c JOIN qbo_customers qc ON qc.id = c.qbo_customer_id
"""


@router.get("")
def list_contacts(q: Optional[str] = None, limit: int = 200, user=Depends(get_current_user)):
    """Global contact list for the Contacts page + combobox search (name/email/company)."""
    _require(user)
    limit = max(1, min(int(limit or 200), 1000))
    like = f"%{(q or '').strip()}%"
    with engine.connect() as conn:
        rows = conn.execute(text(_SELECT + """
            WHERE :q = '' OR c.full_name LIKE :like OR c.first_name LIKE :like
                  OR c.last_name LIKE :like OR c.email LIKE :like OR qc.display_name LIKE :like
            ORDER BY qc.display_name, c.is_primary DESC, c.full_name
            LIMIT :limit
        """), {"q": (q or "").strip(), "like": like, "limit": limit}).mappings().all()
    return {"contacts": [_row(r) for r in rows]}


@router.get("/customer-options")
def customer_options(q: Optional[str] = None, limit: int = 50, user=Depends(get_current_user)):
    """Searchable customer-company list for the 'add contact' / intake pickers."""
    _require(user)
    limit = max(1, min(int(limit or 50), 200))
    like = f"%{(q or '').strip()}%"
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT qbo_id, display_name FROM qbo_customers
            WHERE COALESCE(is_project,0)=0 AND COALESCE(job,0)=0
              AND (:q = '' OR display_name LIKE :like)
            ORDER BY display_name LIMIT :limit
        """), {"q": (q or "").strip(), "like": like, "limit": limit}).mappings().all()
    return {"customers": [{"qbo_id": r["qbo_id"], "name": r["display_name"]} for r in rows]}


@router.get("/customer/{customer_qbo_id}")
def list_for_customer(customer_qbo_id: str, user=Depends(get_current_user)):
    """Contacts under one customer (by QBO id) — for the customer drill-down + intake picker."""
    _require(user)
    with engine.connect() as conn:
        cust = _resolve_customer(conn, customer_qbo_id)
        if not cust:
            raise HTTPException(status_code=404, detail="Customer not found")
        rows = conn.execute(text(_SELECT + """
            WHERE c.qbo_customer_id = :cid
            ORDER BY c.is_primary DESC, c.active DESC, c.full_name
        """), {"cid": cust["id"]}).mappings().all()
    return {"customer": {"qbo_id": cust["qbo_id"], "name": cust["display_name"]},
            "contacts": [_row(r) for r in rows]}


class ContactIn(BaseModel):
    customer_qbo_id: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    title: Optional[str] = None
    is_primary: bool = False
    notes: Optional[str] = None


@router.post("")
def create_contact(body: ContactIn, user=Depends(get_current_user)):
    _require(user)
    full = _fullname(body.first_name, body.last_name, None)
    if not (full or (body.email and body.email.strip())):
        raise HTTPException(status_code=400, detail="A name or email is required")
    with engine.begin() as conn:
        cust = _resolve_customer(conn, body.customer_qbo_id)
        if not cust:
            raise HTTPException(status_code=404, detail="Customer not found")
        if body.is_primary:
            conn.execute(text("UPDATE contacts SET is_primary=0 WHERE qbo_customer_id=:cid"),
                         {"cid": cust["id"]})
        res = conn.execute(text("""
            INSERT INTO contacts (qbo_customer_id, first_name, last_name, full_name, email, phone,
                                  title, is_primary, source, notes, created_by_user_id)
            VALUES (:cid,:fn,:ln,:full,:email,:phone,:title,:prim,'manual',:notes,:uid)
        """), {"cid": cust["id"], "fn": body.first_name, "ln": body.last_name, "full": full,
               "email": body.email, "phone": body.phone, "title": body.title,
               "prim": 1 if body.is_primary else 0, "notes": body.notes, "uid": user.get("id")})
        new_id = res.lastrowid
        row = conn.execute(text(_SELECT + " WHERE c.id = :id"), {"id": new_id}).mappings().first()
    return {"contact": _row(row)}


class ContactPatch(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    title: Optional[str] = None
    is_primary: Optional[bool] = None
    active: Optional[bool] = None
    notes: Optional[str] = None


@router.patch("/{contact_id}")
def update_contact(contact_id: int, body: ContactPatch, user=Depends(get_current_user)):
    _require(user)
    fields = body.model_dump(exclude_unset=True)
    with engine.begin() as conn:
        cur = conn.execute(text("SELECT qbo_customer_id, first_name, last_name FROM contacts WHERE id=:id"),
                           {"id": contact_id}).mappings().first()
        if not cur:
            raise HTTPException(status_code=404, detail="Contact not found")
        # keep full_name in sync when a name part changes
        if "first_name" in fields or "last_name" in fields:
            fn = fields.get("first_name", cur["first_name"])
            ln = fields.get("last_name", cur["last_name"])
            fields["full_name"] = _fullname(fn, ln, None)
        if fields.get("is_primary"):
            conn.execute(text("UPDATE contacts SET is_primary=0 WHERE qbo_customer_id=:cid AND id<>:id"),
                         {"cid": cur["qbo_customer_id"], "id": contact_id})
        cols = {"first_name", "last_name", "full_name", "email", "phone", "title",
                "is_primary", "active", "notes"}
        sets, params = [], {"id": contact_id}
        for k, v in fields.items():
            if k in cols:
                sets.append(f"{k} = :{k}")
                params[k] = (1 if v else 0) if k in ("is_primary", "active") else v
        if sets:
            conn.execute(text(f"UPDATE contacts SET {', '.join(sets)} WHERE id = :id"), params)
        row = conn.execute(text(_SELECT + " WHERE c.id = :id"), {"id": contact_id}).mappings().first()
    return {"contact": _row(row)}


@router.delete("/{contact_id}")
def delete_contact(contact_id: int, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        n = conn.execute(text("DELETE FROM contacts WHERE id=:id"), {"id": contact_id}).rowcount
        if not n:
            raise HTTPException(status_code=404, detail="Contact not found")
        # detach from any opportunities rather than leaving a dangling id
        conn.execute(text("UPDATE opportunities SET contact_id=NULL WHERE contact_id=:id"),
                     {"id": contact_id})
    return {"ok": True}
