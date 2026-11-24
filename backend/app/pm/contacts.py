"""PM Portal Contacts tab (2026-11-22, Leo's PM feedback): one directory per job
so PMs don't retype emails and phone numbers.

  site      contacts filed on the project itself (contacts.qbo_customer_id = the
            project's customer row): the site / GC people for this job
  customer  contacts on the project's parent customer, plus QuickBooks' email
  crews     every crew company and lead on the job's schedule lines (and the
            estimates' paid crews): boss / lead name with phone and email

  GET    /api/pm/project/{qbo_id}/contacts
  POST   /api/pm/project/{qbo_id}/contacts          add a site (or customer) contact
  PATCH  /api/pm/contacts/{contact_id}               edit or remove a contact
  PATCH  /api/pm/crew-contact/{crew_id}              a crew boss's / lead's phone + email
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import bindparam, text

from app.audit import record_audit
from app.auth import require_capability
from app.db import engine
from app.permissions import PAGE_PM_PORTAL

router = APIRouter(prefix="/api/pm", tags=["pm"])
CAP = PAGE_PM_PORTAL


def _name(r):
    full = (r.get("full_name") or "").strip()
    return full or f"{r.get('first_name') or ''} {r.get('last_name') or ''}".strip() or None


def _contacts(conn, cid):
    rows = conn.execute(text("""SELECT id, first_name, last_name, full_name, email, phone, title, is_primary, notes
                                FROM contacts WHERE qbo_customer_id = :c AND active = 1
                                ORDER BY is_primary DESC, full_name"""), {"c": cid}).mappings().all()
    return [{"id": r["id"], "name": _name(r), "email": r["email"], "phone": r["phone"], "title": r["title"],
             "is_primary": bool(r["is_primary"]), "notes": r["notes"]} for r in rows]


def _crews(conn, cust_pk, qbo_id):
    ids = set()
    for r in conn.execute(text("""
        SELECT w.company_id, w.lead_crew_id, w.work_crew_id
        FROM project_schedule_item_work_crews w
        JOIN project_schedule_items psi ON psi.id = w.schedule_item_id
        JOIN projects pr ON pr.id = psi.project_id
        WHERE pr.qbo_customer_id = :c AND w.unassigned_at IS NULL AND COALESCE(psi.status, '') <> 'canceled'"""),
            {"c": cust_pk}).all():
        ids.update(int(x) for x in r if x)
    ids.update(int(r[0]) for r in conn.execute(text(
        "SELECT crew_id FROM project_estimate_billing WHERE entity_id = :e AND crew_id IS NOT NULL"), {"e": qbo_id}).all())
    if not ids:
        return []
    q = text("SELECT id, name, boss_name, parent_id, code, phone, email FROM work_crews WHERE id IN :ids").bindparams(
        bindparam("ids", expanding=True))
    by = {int(r["id"]): dict(r) for r in conn.execute(q, {"ids": list(ids)}).mappings()}
    parents = {int(r["parent_id"]) for r in by.values() if r["parent_id"]} - set(by)
    if parents:
        by.update({int(r["id"]): dict(r) for r in conn.execute(q, {"ids": list(parents)}).mappings()})
    out = {}
    for i, r in by.items():
        co = int(r["parent_id"] or i)
        if co not in by:
            continue
        g = out.setdefault(co, {"id": co, "company": by[co]["name"], "code": by[co]["code"],
                                "boss": {"id": co, "name": by[co]["boss_name"] or by[co]["name"],
                                         "phone": by[co]["phone"], "email": by[co]["email"]}, "leads": []})
        if r["parent_id"] and i in ids:
            g["leads"].append({"id": i, "name": r["name"], "phone": r["phone"], "email": r["email"]})
    for g in out.values():
        g["leads"].sort(key=lambda x: x["name"] or "")
    return sorted(out.values(), key=lambda g: g["company"] or "")


@router.get("/project/{qbo_id}/contacts")
def project_contacts(qbo_id: str, user=Depends(require_capability(CAP))):
    with engine.connect() as conn:
        p = conn.execute(text("SELECT id, qbo_id, display_name, email, parent_qbo_id FROM qbo_customers WHERE qbo_id = :q"),
                         {"q": qbo_id}).mappings().first()
        if not p:
            raise HTTPException(404, "Project not found")
        parent = conn.execute(text("SELECT id, qbo_id, display_name, email FROM qbo_customers WHERE qbo_id = :q"),
                              {"q": p["parent_qbo_id"]}).mappings().first() if p["parent_qbo_id"] else None
        return {
            "project": {"qbo_id": p["qbo_id"], "name": p["display_name"], "email": p["email"]},
            "site": _contacts(conn, p["id"]),
            "customer": {"qbo_id": parent["qbo_id"], "name": parent["display_name"], "email": parent["email"],
                         "contacts": _contacts(conn, parent["id"])} if parent else None,
            "crews": _crews(conn, p["id"], qbo_id),
        }


def _clean(v, n):
    v = (v or "").strip()
    return v[:n] or None


class ContactIn(BaseModel):
    name: Optional[str] = None
    title: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    notes: Optional[str] = None
    where: str = "site"            # site = on the project, customer = on its parent customer


@router.post("/project/{qbo_id}/contacts")
def add_contact(qbo_id: str, body: ContactIn, user=Depends(require_capability(CAP))):
    name, email = _clean(body.name, 255), _clean(body.email, 255)
    if not (name or email):
        raise HTTPException(400, "Add a name or an email.")
    with engine.begin() as conn:
        p = conn.execute(text("SELECT id, display_name, parent_qbo_id FROM qbo_customers WHERE qbo_id = :q"),
                         {"q": qbo_id}).mappings().first()
        if not p:
            raise HTTPException(404, "Project not found")
        cid, label = p["id"], p["display_name"]
        if body.where == "customer" and p["parent_qbo_id"]:
            par = conn.execute(text("SELECT id, display_name FROM qbo_customers WHERE qbo_id = :q"),
                               {"q": p["parent_qbo_id"]}).mappings().first()
            if par:
                cid, label = par["id"], par["display_name"]
        first, _, last = (name or "").partition(" ")
        new_id = conn.execute(text("""
            INSERT INTO contacts (qbo_customer_id, first_name, last_name, full_name, email, phone, title,
                                  is_primary, source, notes, created_by_user_id)
            VALUES (:c, :fn, :ln, :full, :em, :ph, :ti, 0, 'pm', :no, :u)"""),
            {"c": cid, "fn": first or None, "ln": last or None, "full": name, "em": email,
             "ph": _clean(body.phone, 64), "ti": _clean(body.title, 120), "no": _clean(body.notes, 2000),
             "u": user.get("id")}).lastrowid
    record_audit(user, "contact.create", "contact", new_id, name or email, {"customer": label, "from": "pm_portal"})
    return project_contacts(qbo_id, user)


class ContactPatch(BaseModel):
    name: Optional[str] = None
    title: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    notes: Optional[str] = None
    active: Optional[bool] = None


@router.patch("/contacts/{contact_id}")
def edit_contact(contact_id: int, body: ContactPatch, user=Depends(require_capability(CAP))):
    sets, params = [], {"i": contact_id}
    if body.name is not None:
        name = _clean(body.name, 255)
        first, _, last = (name or "").partition(" ")
        sets += ["full_name = :full", "first_name = :fn", "last_name = :ln"]
        params.update(full=name, fn=first or None, ln=last or None)
    for f, n in (("title", 120), ("phone", 64), ("email", 255), ("notes", 2000)):
        v = getattr(body, f)
        if v is not None:
            sets.append(f"{f} = :{f}")
            params[f] = _clean(v, n)
    if body.active is not None:
        sets.append("active = :act")
        params["act"] = 1 if body.active else 0
    if not sets:
        return {"ok": True}
    with engine.begin() as conn:
        cur = conn.execute(text("SELECT full_name, email FROM contacts WHERE id = :i"), {"i": contact_id}).mappings().first()
        if not cur:
            raise HTTPException(404, "Contact not found")
        conn.execute(text(f"UPDATE contacts SET {', '.join(sets)} WHERE id = :i"), params)
    record_audit(user, "contact.remove" if body.active is False else "contact.update", "contact", contact_id,
                 cur["full_name"] or cur["email"], {k: v for k, v in body.model_dump().items() if v is not None})
    return {"ok": True}


class CrewContact(BaseModel):
    phone: Optional[str] = None
    email: Optional[str] = None


@router.patch("/crew-contact/{crew_id}")
def edit_crew_contact(crew_id: int, body: CrewContact, user=Depends(require_capability(CAP))):
    ph, em = _clean(body.phone, 64), _clean(body.email, 255)
    with engine.begin() as conn:
        cur = conn.execute(text("SELECT name, phone, email FROM work_crews WHERE id = :i"), {"i": crew_id}).mappings().first()
        if not cur:
            raise HTTPException(404, "Crew not found")
        conn.execute(text("UPDATE work_crews SET phone = :p, email = :e WHERE id = :i"), {"p": ph, "e": em, "i": crew_id})
    record_audit(user, "crew.contact", "work_crew", crew_id, cur["name"],
                 {"changes": {"phone": [cur["phone"], ph], "email": [cur["email"], em]}})
    return {"ok": True}
