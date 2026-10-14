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
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS, PAGE_PM_PORTAL

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
# Mirror OPI's Word checklists in order and wording ("Customer Project Kickoff
# Checklist 2025 V3", "Crew Project Kickoff Checklist 2025 V2").
# Field: (key, label, type, opts). Types: yn, yn_note (Y/N + where/note),
# text, textarea, date, select (opts["options"]), label (a sub-heading row).
# opts["shared"]: the item exists on BOTH checklists — one stored answer
# (form_key 'shared') shown on both, stamped with the form that set it.
# opts["auto"]: prefill from project data when empty (see _autofill).
S = {"shared": True}


def F(key, label, ftype="yn", **opts):
    return {"key": key, "label": label, "type": ftype, **opts}


def _sh(field):
    return {**field, "shared": True}


_HEADER = [
    _sh(F("project_name", "Project Name & Quote #", "text", auto="project_name")),
    _sh(F("address", "Address", "text", auto="address")),
    _sh(F("start_date", "Start Date", "date", auto="start_date")),
]

_FACILITY = [_sh(f) for f in [
    F("onsite_contact", "Onsite Contact", "text"),
    F("onsite_phone", "Phone #", "text"),
    F("onsite_email", "Email", "text"),
    F("site_clean", "Site Condition (Clean/Clear)"),
    F("active_warehouse", "Active Warehouse"),
    F("work_hours", "Work Hours Confirmed", hint="7 Days a Week 7AM - 7PM"),
    F("building_open", "Building Open & Accessible"),
    F("lockbox", "Lockbox or Door Keypad"),
    F("propane_allowed", "Propane & Gas Allowed in Building"),
    F("lights_power", "Lights/Power"),
    F("bathrooms", "Bathrooms"),
    F("temperatures", "Temperatures", "select",
      options=["Ambient", "Cooler", "Freezer", "Blast Freezer"], auto="temperatures"),
    F("safety_orientations", "Site Safety Orientations"),
    F("ear_eye_protection", "Ear or Eye Protections"),
    F("ground_ramp", "Ground Ramp"),
    F("unload_inside", "Can trucks be unloaded inside"),
    F("pallet_jack", "If N, is a pallet jack provided"),
    F("dock_door_access", "Dock Door Access"),
    F("dock_door_number", "Dock Door #", "text"),
    F("staging_area", "Staging Area"),
    F("active_construction", "Active Construction Site"),
    F("gc_contact", "GC/Superintendent Contact info", "text"),
]]


def _bom(with_drawing_version):
    rows = [
        F("bom_received", "BOM List/ Count Sheet Received"),
        F("truck_count", "Total Truck Count", "text"),
        F("materials_onsite", "Materials Onsite"),
        F("anchor_inspection", "Anchor Inspection"),
        F("anchor_specs", "Anchor Specs", "label"),
        F("anchor_size", "Anchor Size", "text"),
        F("anchors_per_baseplate", "# Per Baseplate/ Per Upright", "text"),
        F("anchor_ft_lbs", "FT-LBS", "text"),
        F("anchor_placement", "Anchor placement", "text"),
        F("drawings_received", "Drawings Received"),
    ]
    if with_drawing_version:
        rows.append(F("drawing_version", "Drawing Version & Revision #", "text", customer_only=True))
    rows += [
        F("calcs_provided", "Structural Engineering Calcs Provided"),
        F("elevations", "Elevations"),
        F("layout", "Layout"),
        F("start_ref_point", "Starting reference point"),
        F("measure_off_cc", "Measurement off CC"),
        F("column_size", "Building Column Size", "text"),
        F("tek_screw_wiredecks", "Tek Screw Wiredecks"),
        F("row_spacers", "Row Spacers Count & Elevations"),
        F("ergs", "ERG's and/or Column protectors"),
        F("erg_anchor_size", "Anchor Size", "text"),
        F("wire_guidance", "Wire Guidance", auto="wire_guidance"),
        F("wg_layout", "Wire Guidance Layout"),
        F("wg_measurements", "Measurements Confirmed"),
        F("wg_out_of_aisle", "Out of Aisle Extension Distance"),
        F("wg_center_aisles", "Center of Aisles"),
        F("wg_distance_off_rack", "Distance off Rack if N", "text"),
        F("wg_line_driver_location", "Line Driver Location on Drawing"),
        F("wg_line_driver_new", "New Line Driver or Existing", "text"),
        F("wg_line_driver_brand", "Line Driver Brand", "text"),
        F("wg_water_supply", "Water Supply", "yn_note", note_label="Where"),
        F("wg_magnet_quoted", "Magnet Quoted"),
        F("wg_magnet_placement", "Magnet Placement Confirmation"),
    ]
    # Drawing Version is customer-only; everything else is the same item on both.
    return [f if f.get("customer_only") else _sh(f) for f in rows]


_CUSTOMER_FORM = [
    (None, _HEADER),
    ("Customer Contacts", [
        F("sales_rep_name", "Customer Sales Representative", "text", auto="sales_rep_name"),
        F("sales_rep_phone", "Phone #", "text", auto="sales_rep_phone"),
        F("sales_rep_email", "Email", "text", auto="sales_rep_email"),
        F("cust_pm_name", "Customer Project Manager", "text"),
        F("cust_pm_phone", "Phone #", "text"),
        F("cust_pm_email", "Email", "text"),
    ]),
    ("PO & Quote Review", [
        F("po_quote_reviewed", "PO & Quote Reviewed and Correct"),
        _sh(F("opi_materials", "On Point Providing Materials")),
        _sh(F("opi_dumpsters", "On Point Providing Dumpsters")),
        F("dumpster_dock_door", "Dock Door to drop", "text"),
        _sh(F("opi_slurry_pan", "On Point Providing Slurry Pan")),
        F("slurry_dock_door", "Dock Door to drop", "text"),
        F("opi_rentals", "On Point Providing Rentals"),
        F("electric_only", "Electric Only"),
        F("socks_diapers", "Socks/Diapers/Non-marking tires",
          hint="If socks and diapers were not included, they cost OPI $350 per machine."),
        F("pre_drop", "Pre-drop Available"),
        F("pre_drop_location", "Dock door drop or ground ramp", "text"),
    ]),
    ("Facility Checklist", _FACILITY),
    ("BOM & Drawing Review", _bom(True)),
    (None, [F("notes", "Notes", "textarea")]),
]

_CREW_FORM = [
    (None, _HEADER),
    ("Crew", [
        F("crew_boss", "Crew Boss", "text", auto="crew_boss"),
        F("crew_boss_phone", "Phone #", "text"),
        F("crew_lead", "Crew Lead", "text", auto="crew_lead"),
        F("crew_lead_phone", "Phone #", "text"),
        F("crew_size", "Crew Size", "text", auto="crew_size"),
    ]),
    ("Scope & Materials Review", [
        F("scope_reviewed", "Full Scope of Work Reviewed/Received"),
        _sh(F("opi_materials", "On Point Providing Materials")),
        F("drill_bits", "Drill Bits Needed"),
        F("banding", "Banding Needed"),
        F("torque_wrench", "Torque Wrench Needed"),
        F("saw_blades", "Saw blades/ Cutting Disc Needed"),
        F("wire_epoxy", "Wire and/or epoxy Needed"),
        F("rentals_reviewed", "Rental Equipment Needed Reviewed/Approved"),
        _sh(F("opi_dumpsters", "Dumpster Provided")),
        _sh(F("opi_slurry_pan", "Slurry Pan Provided")),
        F("safety_reviewed", "Safety Requirements Reviewed"),
        F("hard_hats_vests", "OPI Hard hats and Vest Needed"),
        F("timeline_reviewed", "Project Timeline Reviewed"),
    ]),
    ("Facility Checklist", _FACILITY),
    ("BOM & Drawing Review", _bom(False)),
    (None, [F("notes", "Notes", "textarea")]),
]

_FORM_META = {
    "customer": {"label": "Customer Kickoff Checklist", "milestone": "customer_kickoff", "sections": _CUSTOMER_FORM},
    "crew":     {"label": "Crew Kickoff Checklist",     "milestone": "crew_kickoff",     "sections": _CREW_FORM},
}
FORM_LABELS = {"customer": "Customer kickoff", "crew": "Crew kickoff"}
SHARED_FORM = "shared"


def _build_form(meta):
    sections = [{"title": t, "fields": [dict(f) for f in fields]} for t, fields in meta["sections"]]
    return {"label": meta["label"], "milestone": meta["milestone"], "sections": sections}


FORMS = {k: _build_form(v) for k, v in _FORM_META.items()}
# Answerable fields per form (sub-heading "label" rows hold no answer).
FIELD_DEFS = {k: {f["key"]: f for s in v["sections"] for f in s["fields"] if f["type"] != "label"}
              for k, v in FORMS.items()}
FORM_KEYS = {k: set(v) for k, v in FIELD_DEFS.items()}
HELD_KEY = "_held_date"


# ── helpers ─────────────────────────────────────────────────────────────────
def _require(user):
    # Office project workspace (page.customers, now read-only there) and the
    # PM portal (page.pm_portal, the editing surface) both reach kickoff data.
    if not (has_capability(user, PAGE_CUSTOMERS) or has_capability(user, PAGE_PM_PORTAL)):
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

    # NB: projects.qbo_customer_id is the qbo_customers INTERNAL id, not the qbo_id,
    # so resolve the project through qbo_customers rather than matching entity_id directly.
    pr = conn.execute(text("""
        SELECT p.id,
               COALESCE(p.start_date, MIN(psi.start_date)) AS start_date,
               COALESCE(p.end_date,   MAX(psi.end_date))   AS end_date
        FROM projects p
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        LEFT JOIN project_schedule_items psi ON psi.project_id = p.id
        WHERE qc.qbo_id = :id GROUP BY p.id
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
            rows = _form_rows(conn, entity_id, fk)
            counts[fk] = sum(1 for k in FIELD_DEFS[fk]
                             if (r := rows.get((_store_key(fk, k), k))) and _norm(r["value"]) is not None)

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


def _store_key(form_key, field_key):
    """Where an answer lives: shared items under 'shared', the rest per form.
    yn_note companions ("<key>__note") follow their base field."""
    base = field_key[:-6] if field_key.endswith("__note") else field_key
    f = FIELD_DEFS[form_key].get(base)
    return SHARED_FORM if (f and f.get("shared")) else form_key


def _norm(v):
    v = None if v is None else str(v)
    return None if v is None or v.strip() == "" else v


def _source_label(src):
    if not src:
        return None
    if src.startswith("auto:"):
        return "Auto-filled from " + src[5:]
    return FORM_LABELS.get(src, src)


def _autofill(conn, entity_id, meta):
    """Suggested answers from data the app already has: {field_key: (value, where)}."""
    out = {}
    name = meta.get("name") or ""
    parts = [p.strip() for p in name.split(" - ")]
    opp = conn.execute(text("""
        SELECT id, quote_number, contact_id, app_estimate_id FROM opportunities
        WHERE project_qbo_id = :e ORDER BY id DESC LIMIT 1
    """), {"e": entity_id}).mappings().first()
    est = None
    if opp and opp["app_estimate_id"]:
        est = conn.execute(text("""
            SELECT crew_count, crew_size, project_city, project_state FROM estimates WHERE id = :i
        """), {"i": opp["app_estimate_id"]}).mappings().first()

    # Project name & quote # — OPI's QuickBooks naming is "<quote#> - <customer> - <city, ST>".
    pname = " - ".join(parts[:2]) if len(parts) >= 3 else name
    if opp and opp["quote_number"] and str(opp["quote_number"]) not in pname:
        pname = f"{pname} (Quote #{opp['quote_number']})"
    if pname:
        out["project_name"] = (pname, "the project name")
    if est and (est["project_city"] or est["project_state"]):
        out["address"] = (", ".join(x for x in (est["project_city"], est["project_state"]) if x), "the quote")
    elif len(parts) >= 3 and "," in parts[-1]:
        out["address"] = (parts[-1], "the project name (city, state)")
    if meta.get("start_date"):
        out["start_date"] = (str(meta["start_date"])[:10], "the project schedule")

    crews = conn.execute(text("""
        SELECT MAX(COALESCE(pc.name, wc.name)) AS company,
               MAX(COALESCE(pc.boss_name, wc.boss_name)) AS boss,
               MAX(CASE WHEN wc.parent_id IS NOT NULL THEN wc.name END) AS lead_name
        FROM projects p
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        JOIN project_schedule_items psi ON psi.project_id = p.id
        JOIN project_schedule_item_work_crews swc ON swc.schedule_item_id = psi.id
        JOIN work_crews wc ON wc.id = swc.work_crew_id
        LEFT JOIN work_crews pc ON pc.id = wc.parent_id
        WHERE qc.qbo_id = :e AND swc.unassigned_at IS NULL
        GROUP BY wc.id
    """), {"e": entity_id}).mappings().all()
    bosses = list(dict.fromkeys(
        (f"{c['boss']} ({c['company']})" if c["boss"] else c["company"]) for c in crews if c["company"]))
    leads = list(dict.fromkeys(c["lead_name"] for c in crews if c["lead_name"]))
    if bosses:
        out["crew_boss"] = (", ".join(bosses), "the crew assignment")
    if leads:
        out["crew_lead"] = (", ".join(leads), "the crew assignment")
    if est and est["crew_count"]:
        n = int(est["crew_count"])
        out["crew_size"] = (f"{n} crew{'s' if n != 1 else ''}" + (f" · {est['crew_size']}" if est["crew_size"] else ""),
                            "the quote")

    if opp and opp["contact_id"]:
        c = conn.execute(text("SELECT full_name, phone, email FROM contacts WHERE id = :i"),
                         {"i": opp["contact_id"]}).mappings().first()
        if c:
            for k, col in (("sales_rep_name", "full_name"), ("sales_rep_phone", "phone"), ("sales_rep_email", "email")):
                if c[col]:
                    out[k] = (c[col], "the RFQ contact")

    if opp and opp["app_estimate_id"]:
        base = conn.execute(text("""
            SELECT installation_environment, wire_guidance_linear_footage FROM quote_metric_sets
            WHERE estimate_id = :i AND kind = 'base' LIMIT 1
        """), {"i": opp["app_estimate_id"]}).mappings().first()
        if base:
            env = (base["installation_environment"] or "").lower()
            temp = ("Blast Freezer" if "blast" in env else "Freezer" if "freezer" in env
                    else "Cooler" if "cooler" in env else "Ambient" if "ambient" in env else None)
            if temp:
                out["temperatures"] = (temp, "the quote")
            if base["wire_guidance_linear_footage"] and float(base["wire_guidance_linear_footage"]) > 0:
                out["wire_guidance"] = ("Y", "the quote (wire guidance footage)")
    return out


def _form_rows(conn, entity_id, form_key):
    rows = conn.execute(text("""
        SELECT r.form_key, r.field_key, r.value, r.source, r.updated_at,
               TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS by_name
        FROM project_kickoff_responses r LEFT JOIN users u ON u.id = r.updated_by_user_id
        WHERE r.entity_id = :e AND r.form_key IN (:f, :s)
    """), {"e": entity_id, "f": form_key, "s": SHARED_FORM}).mappings().all()
    return {(r["form_key"], r["field_key"]): r for r in rows}


@router.get("/project/{entity_id}/form/{form_key}")
def get_form(entity_id: str, form_key: str, user=Depends(get_current_user)):
    """The checklist with its answers. Shared items come from the 'shared' store,
    each answer carries where it came from (which checklist / auto-fill, who,
    when) and the value it replaced; empty auto-fillable fields get a suggestion."""
    _require(user)
    if form_key not in FORMS:
        raise HTTPException(status_code=400, detail="Unknown form")
    with engine.connect() as conn:
        meta = _project_meta(conn, entity_id)
        if not meta:
            raise HTTPException(status_code=404, detail="Project not found")
        rows = _form_rows(conn, entity_id, form_key)
        hist = conn.execute(text("""
            SELECT h.form_key, h.field_key, h.old_value, h.old_source, h.changed_at,
                   TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS by_name
            FROM project_kickoff_history h LEFT JOIN users u ON u.id = h.changed_by_user_id
            WHERE h.entity_id = :e AND h.form_key IN (:f, :s) AND h.old_value IS NOT NULL AND h.old_value <> ''
            ORDER BY h.id DESC
        """), {"e": entity_id, "f": form_key, "s": SHARED_FORM}).mappings().all()
        auto = _autofill(conn, entity_id, meta)
    prev = {}
    for h in hist:
        prev.setdefault((h["form_key"], h["field_key"]), h)

    responses, info = {}, {}
    for key in FIELD_DEFS[form_key]:
        for fk in (key, f"{key}__note"):
            store = _store_key(form_key, fk)
            r = rows.get((store, fk))
            if r and _norm(r["value"]) is not None:
                responses[fk] = r["value"]
            p = prev.get((store, fk))
            if (r and _norm(r["value"]) is not None) or p:
                info[fk] = {
                    "shared": store == SHARED_FORM,
                    "source": _source_label(r["source"]) if r else None,
                    "by": ((r["by_name"] or "").strip() or None) if r else None,
                    "at": str(r["updated_at"]) if r and r["updated_at"] else None,
                    "prev": ({"value": p["old_value"], "source": _source_label(p["old_source"]),
                              "by": (p["by_name"] or "").strip() or None,
                              "at": str(p["changed_at"]) if p["changed_at"] else None} if p else None),
                }
    suggestions = {k: {"value": v, "source": f"Auto-filled from {where}", "where": where}
                   for k, (v, where) in auto.items()
                   if k in FIELD_DEFS[form_key] and FIELD_DEFS[form_key][k].get("auto") and k not in responses}
    held = rows.get((form_key, HELD_KEY))
    return {
        "entity": {"type": "project", "id": entity_id, "name": meta["name"], "customer_name": meta["customer_name"]},
        "form": FORMS[form_key],
        "other_form_label": FORM_LABELS["crew" if form_key == "customer" else "customer"],
        "responses": responses,
        "info": info,
        "suggestions": suggestions,
        "held_date": held["value"] if held else None,
    }


class FormSave(BaseModel):
    responses: dict
    held_date: Optional[str] = None
    # field_key -> "auto:<where>" for auto-filled values saved as-is
    sources: Optional[dict] = None


@router.post("/project/{entity_id}/form/{form_key}")
def save_form(entity_id: str, form_key: str, body: FormSave, user=Depends(get_current_user)):
    """Write only what changed. Shared items land in the 'shared' store (so the
    other checklist shows them too); every change keeps the replaced value in
    project_kickoff_history."""
    _require(user)
    if form_key not in FORMS:
        raise HTTPException(status_code=400, detail="Unknown form")
    valid = FORM_KEYS[form_key]
    uid = user.get("id")
    srcs = body.sources or {}
    changed = 0
    with engine.begin() as conn:
        if not _project_meta(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        rows = _form_rows(conn, entity_id, form_key)
        items = []
        for k, v in (body.responses or {}).items():
            base = k[:-6] if k.endswith("__note") else k
            if base in valid:
                src = srcs.get(k) if isinstance(srcs.get(k), str) and srcs[k].startswith("auto:") else form_key
                items.append((_store_key(form_key, k), k, _norm(v), src[:64]))
        if body.held_date is not None:
            items.append((form_key, HELD_KEY, _norm(body.held_date), form_key))
        for store, fk, val, src in items:
            cur = rows.get((store, fk))
            old = _norm(cur["value"]) if cur else None
            if old == val:
                continue
            conn.execute(text("""
                INSERT INTO project_kickoff_responses (entity_id, form_key, field_key, value, source, updated_by_user_id)
                VALUES (:e,:f,:k,:v,:s,:u)
                ON DUPLICATE KEY UPDATE value=VALUES(value), source=VALUES(source), updated_by_user_id=VALUES(updated_by_user_id)
            """), {"e": entity_id, "f": store, "k": fk, "v": val, "s": src, "u": uid})
            if fk != HELD_KEY:
                conn.execute(text("""
                    INSERT INTO project_kickoff_history
                        (entity_id, form_key, field_key, old_value, new_value, old_source, new_source, changed_by_user_id)
                    VALUES (:e,:f,:k,:ov,:nv,:os,:ns,:u)
                """), {"e": entity_id, "f": store, "k": fk, "ov": old, "nv": val,
                       "os": cur["source"] if cur else None, "ns": src, "u": uid})
            changed += 1
    return {"ok": True, "changed": changed}
