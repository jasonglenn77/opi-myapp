"""
PM project lifecycle + kickoff forms (Phase 3).

A project carries two things beyond its documents:
  * a 13-step lifecycle (assignment -> final invoice), each milestone with an
    SLA due-date computed from the project's anchor dates, and
  * two structured kickoff forms (Customer, Crew) filled during the kickoff
    calls — sectioned intake forms mirroring OPI's Word checklists.

Templates (milestones + form fields) live here in code, like the document
folder tree. Per-project status/answers live in project_milestones and
project_kickoff_responses. Gated by page.customers (same as the project page).
"""
import re
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS

router = APIRouter(prefix="/api/kickoff", tags=["kickoff"])

# ── lifecycle milestones ────────────────────────────────────────────────────
# anchor: which project date the SLA counts from
#   assigned     = PM assignment timestamp
#   start / end  = project start / end date
#   customer_held / crew_held = the held date entered on that kickoff form
#   None         = no computed due date
MILESTONES = [
    {"key": "kickoff_email",     "label": "Kickoff Schedule Email Sent",                                     "anchor": "assigned",     "offset": 1,  "sla": "Within 24h of assignment"},
    {"key": "precall_planning",  "label": "Pre-Call Planning for Kickoff",                                   "anchor": "assigned",     "offset": 7,  "sla": "Within 1 week of assignment"},
    {"key": "customer_kickoff",  "label": "Customer Kickoff Held",                                            "anchor": None,           "offset": 0,  "sla": "Fills the Customer kickoff form", "form": "customer"},
    {"key": "checklist_sent",    "label": "Kickoff Checklist Completed & Sent (Internal + External)",         "anchor": "customer_held","offset": 1,  "sla": "Within 24h of customer kickoff"},
    {"key": "procurement_check", "label": "Internal Materials & Equipment Procurement Check (Ops Team)",      "anchor": "customer_held","offset": 1,  "sla": "Within 24h of customer kickoff"},
    {"key": "crew_kickoff",      "label": "Crew Kickoff Held",                                                "anchor": "start",        "offset": -7, "sla": "7 days before project start", "form": "crew"},
    {"key": "crew_email",        "label": "Crew Email Sent (Checklist + Expectations Sheet)",                 "anchor": "crew_held",    "offset": 1,  "sla": "Within 24h of crew kickoff"},
    {"key": "text_threads",      "label": "Project Text Threads Created",                                     "anchor": "start",        "offset": -1, "sla": "24h before project start"},
    {"key": "day1_kickoff",      "label": "Day 1 Kickoff — Layout Confirmed, Roadblocks Identified",          "anchor": "start",        "offset": 1,  "sla": "24h after project start"},
    {"key": "before_photos",     "label": "Before Pictures Taken / BOLs Received & Filed",                    "anchor": "start",        "offset": 0,  "sla": "Day of project start"},
    {"key": "completion_media",  "label": "Completion Photos / Leftover Material / Videos / Form Signed & Filed","anchor": "end",       "offset": 0,  "sla": "Last day (project end)"},
    {"key": "marketing_videos",  "label": "Marketing Videos Filed",                                           "anchor": "end",          "offset": 3,  "sla": "Within 72h of project end"},
    {"key": "completion_email",  "label": "Completion Email Sent (incl. Completion Form)",                    "anchor": "end",          "offset": 0,  "sla": "Same day as project end — triggers ready-for-final-invoice", "final_invoice": True},
]
MILESTONE_KEYS = {m["key"] for m in MILESTONES}

# ── kickoff form templates ──────────────────────────────────────────────────
# Section title None = ungrouped fields. Field types: yn, yn_note, text, textarea.
_CUSTOMER_SECTIONS = [
    (None, [
        ("Project Name, Address and Start Date", "text"),
        ("Quote and PO Reviewed and Are Correct", "yn"),
        ("On Point Providing Materials", "yn"),
    ]),
    ("Drawing", [
        ("Elevations", "yn"), ("Layout", "yn"),
        ("Building Column Dims Confirmed and on Drawing", "yn_note"),
        ("Structural Engineering Calcs Provided", "yn"),
        ("Anchor Inspection", "yn"),
        ("Anchors per baseplate", "text"),
    ]),
    ("On Point Customer Contact", [
        ("Name", "text"), ("Phone Number", "text"), ("Email", "text"),
    ]),
    ("Site Contact", [
        ("Name", "text"), ("Phone Number", "text"), ("Email", "text"),
    ]),
    (None, [
        ("Site Condition (Clean / Clear)", "yn"),
        ("On Point Providing Rentals", "yn"),
        ("Socks / Diapers / Non-Marking Tires", "yn"),
        ("Pre-Drop Available", "yn"),
    ]),
    ("Access", [("Dock Height Dock Doors", "yn"), ("Ground Ramp", "yn")]),
    ("Work Hours", [("7 Days a week 7-7 Confirmation", "yn")]),
    ("Materials", [
        ("Staging Area", "yn"), ("Materials On Site", "yn"), ("Total Trucks", "text"),
        ("BOM's List / Count Sheet Received", "yn"), ("Building Open and Accessible", "yn"),
        ("Lockbox or Door Keypad", "yn"), ("LP and Gas Allowed in Building", "yn"),
        ("Lights / Power", "yn"), ("Temperatures (Ambient / Freezer / Blast Freezer)", "text"),
        ("Bathrooms", "yn"), ("Dumpster Provided", "text"), ("What Dock Door Can We Drop", "text"),
    ]),
    (None, [
        ("GC Contact Info", "text"), ("Superintendent Contact Info", "text"),
        ("On Point Crew Lead", "text"), ("Active Warehouse", "yn"),
    ]),
    ("Specific Safety Requirements", [("Safety Orientations", "yn")]),
    ("Wire Guidance", [
        ("Wire Guidance", "yn"), ("Water Supply", "yn_note"), ("Slurry Pan Drop Location", "text"),
        ("Wire Guidance Layout", "yn"), ("Measurements Confirmed", "yn"),
        ("Out of Aisle Extension Distance", "text"),
        ("Distance Off Racks If Not Centered in Aisle", "text"),
        ("Magnets Quoted", "yn"), ("Magnet Placement Confirmation", "text"),
        ("New Line Driver Or Existing", "text"), ("Line Driver Brand", "text"),
        ("Line Driver Location On Drawing Confirmed", "yn"),
    ]),
    (None, [("Notes", "textarea")]),
]

_CREW_SECTIONS = [
    (None, [
        ("Project Name, Address and Start Date", "text"),
        ("Crew Boss", "text"),
        ("Crew Lead and Phone Number", "text"),
        ("Full Scope of Work Reviewed / Received", "yn"),
        ("On Point Providing Materials", "yn"),
        ("Drill Bits Needed", "yn"),
        ("Banding Needed", "yn"),
        ("Torque Wrench Needed", "yn"),
    ]),
    ("Drawing", [
        ("Elevations", "yn"), ("Layout", "yn"),
        ("Building Column Dims Confirmed and on Drawing", "yn_note"),
        ("Structural Engineering Calcs Provided", "yn"),
        ("Anchor Torque Requirements Confirmed", "yn"),
        ("Anchors per baseplate", "text"),
    ]),
    ("Site Contact", [("Name", "text"), ("Phone Number", "text")]),
    (None, [
        ("Site Condition Expectations (Clean / Clear)", "yn"),
        ("Rental Equipment Needs Reviewed and Approved", "yn"),
    ]),
    ("Access", [("Dock Height Dock Doors", "yn"), ("Ground Ramp", "yn")]),
    ("Work Hours", [("7 Days a week 7-7 Confirmation", "yn")]),
    ("Materials", [
        ("Staging Area", "yn"), ("Materials On Site", "yn"), ("Total Trucks", "text"),
        ("BOM's List / Count Sheet Received", "yn"), ("Building Open and Accessible", "yn"),
        ("Lockbox or Door Keypad", "yn"), ("LP and Gas Allowed in Building", "yn"),
        ("Lights / Power", "yn"), ("Temperatures (Ambient / Freezer / Blast Freezer)", "text"),
        ("Bathrooms", "yn"), ("Dumpster Provided", "text"),
    ]),
    (None, [
        ("GC Contact Info", "text"), ("Superintendent Contact Info", "text"),
        ("Active Warehouse", "yn"),
    ]),
    ("Safety Requirements", [
        ("Safety Orientations", "yn"),
        ("On Point Vests and Hard Hats", "yn"),
        ("Do all Crew Members have Licenses for FL, SL and Fall Protection", "yn"),
        ("Crew Understands Safety Checklist Expectations", "yn"),
        ("Crew Understands Not to Climb in Racks without Proper Fall Protection", "yn"),
    ]),
    ("Wire Guidance", [
        ("Wire Guidance", "yn"), ("Water Supply", "yn_note"),
        ("Slurry Pan Needed", "yn"), ("Slurry Pan Drop Location", "text"),
        ("Wire Guidance Layout", "yn"), ("Measurements Confirmed", "yn"),
        ("Out of Aisle Extension Distance", "text"),
        ("Distance Off Racks If Not Centered in Aisle", "text"),
        ("Magnets Quoted", "yn"), ("Magnet Placement Confirmation", "text"),
        ("New Line Driver Or Existing", "text"), ("Line Driver Brand", "text"),
        ("Line Driver Location On Drawing Confirmed", "yn"),
    ]),
    (None, [("Notes", "textarea")]),
]

_FORM_META = {
    "customer": {"label": "Customer Kickoff Checklist", "milestone": "customer_kickoff", "sections": _CUSTOMER_SECTIONS},
    "crew":     {"label": "Crew Kickoff Checklist",     "milestone": "crew_kickoff",     "sections": _CREW_SECTIONS},
}


def _slug(s: str) -> str:
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", s.lower())).strip("_")


def _build_form(meta):
    """Turn the (title, [(label, type)]) sections into stable keyed sections."""
    used = set()
    sections = []
    for title, fields in meta["sections"]:
        sec_slug = _slug(title) if title else ""
        built = []
        for label, ftype in fields:
            base = (sec_slug + "__" if sec_slug else "") + _slug(label)
            key, i = base, 2
            while key in used:
                key, i = f"{base}_{i}", i + 1
            used.add(key)
            built.append({"key": key, "label": label, "type": ftype})
        sections.append({"title": title, "fields": built})
    return {"label": meta["label"], "milestone": meta["milestone"], "sections": sections}


FORMS = {k: _build_form(v) for k, v in _FORM_META.items()}
FORM_KEYS = {k: {f["key"] for s in v["sections"] for f in s["fields"]} for k, v in FORMS.items()}
HELD_KEY = "_held_date"


# ── helpers ─────────────────────────────────────────────────────────────────
def _require(user):
    if not has_capability(user, PAGE_CUSTOMERS):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _project_meta(conn, entity_id):
    """Resolve the project's display name, root customer, anchor dates and PM."""
    cust = conn.execute(text("SELECT display_name, parent_qbo_id, is_project FROM qbo_customers WHERE qbo_id=:id"),
                        {"id": entity_id}).mappings().first()
    if not cust:
        return None
    name = cust["display_name"]
    root_name, pq, guard = name, cust["parent_qbo_id"], 0
    while pq and guard < 10:
        p = conn.execute(text("SELECT display_name, parent_qbo_id FROM qbo_customers WHERE qbo_id=:id"),
                         {"id": pq}).mappings().first()
        if not p:
            break
        root_name, pq, guard = p["display_name"], p["parent_qbo_id"], guard + 1

    pr = conn.execute(text("""
        SELECT p.id,
               COALESCE(p.start_date, MIN(psi.start_date)) AS start_date,
               COALESCE(p.end_date,   MAX(psi.end_date))   AS end_date
        FROM projects p
        LEFT JOIN project_schedule_items psi ON psi.project_id = p.id
        WHERE p.qbo_customer_id = :id GROUP BY p.id
    """), {"id": entity_id}).mappings().first()

    start_date = end_date = assigned_at = pm_name = None
    if pr:
        start_date, end_date = pr["start_date"], pr["end_date"]
        a = conn.execute(text("""
            SELECT MIN(pm.created_at) AS assigned_at,
                   SUBSTRING_INDEX(GROUP_CONCAT(TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,'')))
                       ORDER BY pm.is_primary DESC, pm.created_at SEPARATOR '||'), '||', 1) AS pm_name
            FROM project_schedule_item_project_managers pm
            JOIN project_schedule_items ps2 ON ps2.id = pm.schedule_item_id
            LEFT JOIN project_managers u ON u.id = pm.project_manager_id
            WHERE ps2.project_id = :pid AND pm.unassigned_at IS NULL
        """), {"pid": pr["id"]}).mappings().first()
        if a:
            assigned_at = a["assigned_at"]
            pm_name = (a["pm_name"] or "").strip() or None

    return {
        "name": name, "customer_name": root_name,
        "is_project": bool(cust["is_project"]),
        "start_date": str(start_date) if start_date else None,
        "end_date": str(end_date) if end_date else None,
        "assigned_at": str(assigned_at) if assigned_at else None,
        "pm_name": pm_name,
    }


def _held_date(conn, entity_id, form_key):
    r = conn.execute(text("""SELECT value FROM project_kickoff_responses
                             WHERE entity_id=:e AND form_key=:f AND field_key=:k"""),
                     {"e": entity_id, "f": form_key, "k": HELD_KEY}).mappings().first()
    return (r["value"] if r and r["value"] else None)


def _due_date(anchor_key, offset, meta, held):
    from datetime import date

    def parse(s):
        if not s:
            return None
        try:
            return date.fromisoformat(str(s)[:10])
        except ValueError:
            return None

    base = None
    if anchor_key == "assigned":
        base = parse(meta.get("assigned_at"))
    elif anchor_key == "start":
        base = parse(meta.get("start_date"))
    elif anchor_key == "end":
        base = parse(meta.get("end_date"))
    elif anchor_key == "customer_held":
        base = parse(held.get("customer"))
    elif anchor_key == "crew_held":
        base = parse(held.get("crew"))
    if not base:
        return None
    return str(base + timedelta(days=offset))


# ── endpoints ───────────────────────────────────────────────────────────────
@router.get("/project/{entity_id}")
def get_project_kickoff(entity_id: str, user=Depends(get_current_user)):
    """Lifecycle milestones (with computed due dates + status) and form summaries."""
    _require(user)
    with engine.connect() as conn:
        meta = _project_meta(conn, entity_id)
        if not meta:
            raise HTTPException(status_code=404, detail="Project not found")
        status_rows = conn.execute(text("""
            SELECT m.milestone_key, m.done, m.note, m.done_at,
                   TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS done_by
            FROM project_milestones m LEFT JOIN users u ON u.id = m.done_by_user_id
            WHERE m.entity_id=:e
        """), {"e": entity_id}).mappings().all()
        st = {r["milestone_key"]: r for r in status_rows}
        held = {"customer": _held_date(conn, entity_id, "customer"), "crew": _held_date(conn, entity_id, "crew")}
        # filled-field counts per form (excludes the reserved held key)
        counts = {}
        for fk in FORMS:
            n = conn.execute(text("""SELECT COUNT(*) FROM project_kickoff_responses
                                     WHERE entity_id=:e AND form_key=:f AND field_key<>:h
                                       AND value IS NOT NULL AND value<>''"""),
                             {"e": entity_id, "f": fk, "h": HELD_KEY}).scalar()
            counts[fk] = int(n or 0)

    milestones = []
    for m in MILESTONES:
        s = st.get(m["key"])
        milestones.append({
            "key": m["key"], "label": m["label"], "sla": m["sla"],
            "form": m.get("form"), "final_invoice": m.get("final_invoice", False),
            "due_date": _due_date(m["anchor"], m["offset"], meta, held),
            "done": bool(s["done"]) if s else False,
            "done_at": str(s["done_at"]) if s and s["done_at"] else None,
            "done_by": (s["done_by"].strip() if s and s["done_by"] else None) if s else None,
            "note": (s["note"] if s else None),
        })
    forms = [{
        "key": fk, "label": FORMS[fk]["label"], "milestone": FORMS[fk]["milestone"],
        "field_count": len(FORM_KEYS[fk]), "filled_count": counts.get(fk, 0),
        "held_date": held.get(fk),
    } for fk in FORMS]

    return {"entity": {"type": "project", "id": entity_id, **meta}, "milestones": milestones, "forms": forms}


class MilestoneUpdate(BaseModel):
    milestone_key: str
    done: Optional[bool] = None
    note: Optional[str] = None


@router.post("/project/{entity_id}/milestone")
def update_milestone(entity_id: str, body: MilestoneUpdate, user=Depends(get_current_user)):
    _require(user)
    if body.milestone_key not in MILESTONE_KEYS:
        raise HTTPException(status_code=400, detail="Unknown milestone")
    uid = user.get("id")
    with engine.begin() as conn:
        if not _project_meta(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        # stamp who/when when transitioning to done; clear when un-done
        sets, params = [], {"e": entity_id, "k": body.milestone_key, "uid": uid}
        if body.done is not None:
            sets.append("done=:done")
            params["done"] = 1 if body.done else 0
            if body.done:
                sets.append("done_by_user_id=:uid"); sets.append("done_at=NOW()")
            else:
                sets.append("done_by_user_id=NULL"); sets.append("done_at=NULL")
        if body.note is not None:
            sets.append("note=:note"); params["note"] = body.note
        # upsert
        exists = conn.execute(text("SELECT id FROM project_milestones WHERE entity_id=:e AND milestone_key=:k"),
                              {"e": entity_id, "k": body.milestone_key}).first()
        if exists:
            conn.execute(text(f"UPDATE project_milestones SET {', '.join(sets)} WHERE entity_id=:e AND milestone_key=:k"), params)
        else:
            cols = ["entity_id", "milestone_key", "done", "done_by_user_id", "done_at", "note"]
            vals = {
                "entity_id": entity_id, "milestone_key": body.milestone_key,
                "done": 1 if body.done else 0,
                "done_by_user_id": uid if body.done else None,
                "note": body.note,
            }
            done_at_sql = "NOW()" if body.done else "NULL"
            conn.execute(text(f"""INSERT INTO project_milestones (entity_id, milestone_key, done, done_by_user_id, done_at, note)
                                  VALUES (:entity_id, :milestone_key, :done, :done_by_user_id, {done_at_sql}, :note)"""), vals)
    return {"ok": True}


@router.get("/project/{entity_id}/form/{form_key}")
def get_form(entity_id: str, form_key: str, user=Depends(get_current_user)):
    _require(user)
    if form_key not in FORMS:
        raise HTTPException(status_code=400, detail="Unknown form")
    with engine.connect() as conn:
        meta = _project_meta(conn, entity_id)
        if not meta:
            raise HTTPException(status_code=404, detail="Project not found")
        rows = conn.execute(text("""SELECT field_key, value FROM project_kickoff_responses
                                    WHERE entity_id=:e AND form_key=:f"""),
                            {"e": entity_id, "f": form_key}).mappings().all()
    responses = {r["field_key"]: r["value"] for r in rows}
    return {
        "entity": {"type": "project", "id": entity_id, "name": meta["name"], "customer_name": meta["customer_name"]},
        "form": FORMS[form_key],
        "responses": {k: v for k, v in responses.items() if k != HELD_KEY},
        "held_date": responses.get(HELD_KEY),
    }


class FormSave(BaseModel):
    responses: dict
    held_date: Optional[str] = None


@router.post("/project/{entity_id}/form/{form_key}")
def save_form(entity_id: str, form_key: str, body: FormSave, user=Depends(get_current_user)):
    _require(user)
    if form_key not in FORMS:
        raise HTTPException(status_code=400, detail="Unknown form")
    valid = FORM_KEYS[form_key]
    uid = user.get("id")
    # accept the field keys, plus per-field "<key>__note" companions for yn_note
    items = []
    for k, v in (body.responses or {}).items():
        base = k[:-6] if k.endswith("__note") else k
        if base in valid:
            items.append((k, None if v is None else str(v)))
    with engine.begin() as conn:
        if not _project_meta(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        if body.held_date is not None:
            items.append((HELD_KEY, body.held_date or None))
        for fk, val in items:
            conn.execute(text("""
                INSERT INTO project_kickoff_responses (entity_id, form_key, field_key, value, updated_by_user_id)
                VALUES (:e,:f,:k,:v,:u)
                ON DUPLICATE KEY UPDATE value=VALUES(value), updated_by_user_id=VALUES(updated_by_user_id)
            """), {"e": entity_id, "f": form_key, "k": fk, "v": val, "u": uid})
    return {"ok": True}
