from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.audit import diff_fields, record_audit
from app.auth import get_current_user, require_capability
from app.db import engine
from app.quoting.snapshot import (estimate_id_for_set, get_reference_snapshot,
                                  snapshot_maps)

router = APIRouter(prefix="/api/quoting", tags=["quoting"])


@router.get("/lookup-values")
def list_lookup_values(estimate_id: Optional[int] = None, _user=Depends(get_current_user)):
    """
    Reference values for the Estimate page dropdowns.
    Rows are grouped by `category` and ordered by `sort_order`.
    Response shape: { "<category>": [ { key, value_num, value_text, sort_order }, ... ], ... }

    With `estimate_id`, serves that estimate's FROZEN snapshot instead of the
    live table, so an open quote always prices off the values it was started
    with (#2 packaging — see app/quoting/snapshot.py).
    """
    with engine.connect() as conn:
        snap = None
        if estimate_id:
            with engine.begin() as wconn:      # may lazily freeze a legacy estimate
                snap = get_reference_snapshot(wconn, estimate_id)
        if snap is not None:
            rows = snap.get("lookup_values", [])
        else:
            rows = conn.execute(text("""
                SELECT category, lookup_key, value_num, value_text, sort_order
                FROM lookup_values
                ORDER BY category, sort_order, lookup_key
            """)).mappings().all()

    grouped = defaultdict(list)
    for r in rows:
        grouped[r["category"]].append({
            "key":        r["lookup_key"],
            "value_num":  float(r["value_num"]) if r["value_num"] is not None else None,
            "value_text": r["value_text"],
            "sort_order": r["sort_order"],
        })

    return dict(grouped)


# ---------------------------------------------------------------------------
# Lookup-values admin (Settings → Lookup Tables). Manage the reference rows that
# drive the app's dropdowns. Admin-only (page.settings). Categories are fixed
# (they map to code); admins manage the ROWS within each category.
# ---------------------------------------------------------------------------
class LookupRow(BaseModel):
    category: Optional[str] = None      # required on create; ignored on update
    lookup_key: str
    value_num: Optional[float] = None
    value_text: Optional[str] = None
    sort_order: Optional[int] = 0
    reason: Optional[str] = None        # audit-only: why the change was made


@router.get("/lookup-values/admin")
def list_lookup_values_admin(_user=Depends(require_capability("page.settings"))):
    """Same rows as the read endpoint but grouped with ids, for the admin UI."""
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, category, lookup_key, value_num, value_text, sort_order
            FROM lookup_values ORDER BY category, sort_order, lookup_key
        """)).mappings().all()
    grouped = defaultdict(list)
    for r in rows:
        grouped[r["category"]].append({
            "id": r["id"], "lookup_key": r["lookup_key"],
            "value_num": float(r["value_num"]) if r["value_num"] is not None else None,
            "value_text": r["value_text"], "sort_order": r["sort_order"],
        })
    return {"categories": [{"category": k, "rows": v} for k, v in sorted(grouped.items())]}


@router.post("/lookup-values")
def create_lookup_value(body: LookupRow, user=Depends(require_capability("page.settings"))):
    if not (body.category or "").strip():
        raise HTTPException(status_code=400, detail="category is required")
    if not (body.lookup_key or "").strip():
        raise HTTPException(status_code=400, detail="key is required")
    try:
        with engine.begin() as conn:
            res = conn.execute(text("""
                INSERT INTO lookup_values (category, lookup_key, value_num, value_text, sort_order)
                VALUES (:c,:k,:n,:t,:s)
            """), {"c": body.category.strip(), "k": body.lookup_key.strip(),
                   "n": body.value_num, "t": (body.value_text or None), "s": body.sort_order or 0})
    except IntegrityError:
        raise HTTPException(status_code=400, detail="That key already exists in this category.")
    record_audit(user, "lookup.create", "lookup_value", res.lastrowid,
                 f"{body.category.strip()} / {body.lookup_key.strip()}",
                 {"values": {"value_num": body.value_num, "value_text": body.value_text},
                  "reason": body.reason or None})
    return {"ok": True, "id": res.lastrowid}


@router.patch("/lookup-values/{row_id}")
def update_lookup_value(row_id: int, body: LookupRow, user=Depends(require_capability("page.settings"))):
    if not (body.lookup_key or "").strip():
        raise HTTPException(status_code=400, detail="key is required")
    with engine.connect() as conn:
        old = conn.execute(text("SELECT * FROM lookup_values WHERE id=:id"), {"id": row_id}).mappings().first()
    try:
        with engine.begin() as conn:
            res = conn.execute(text("""
                UPDATE lookup_values SET lookup_key=:k, value_num=:n, value_text=:t, sort_order=:s
                WHERE id=:id
            """), {"k": body.lookup_key.strip(), "n": body.value_num,
                   "t": (body.value_text or None), "s": body.sort_order or 0, "id": row_id})
    except IntegrityError:
        raise HTTPException(status_code=400, detail="That key already exists in this category.")
    if res.rowcount == 0:
        raise HTTPException(status_code=404, detail="Lookup value not found")
    changes = diff_fields(dict(old or {}), {"lookup_key": body.lookup_key.strip(), "value_num": body.value_num,
                                            "value_text": body.value_text or None, "sort_order": body.sort_order or 0},
                          ["lookup_key", "value_num", "value_text", "sort_order"])
    if changes:
        record_audit(user, "lookup.update", "lookup_value", row_id,
                     f"{(old or {}).get('category', '?')} / {body.lookup_key.strip()}",
                     {"changes": changes, "reason": body.reason or None})
    return {"ok": True}


@router.delete("/lookup-values/{row_id}")
def delete_lookup_value(row_id: int, reason: Optional[str] = None,
                        user=Depends(require_capability("page.settings"))):
    with engine.begin() as conn:
        old = conn.execute(text("SELECT * FROM lookup_values WHERE id=:id"), {"id": row_id}).mappings().first()
        conn.execute(text("DELETE FROM lookup_values WHERE id=:id"), {"id": row_id})
    if old:
        record_audit(user, "lookup.delete", "lookup_value", row_id,
                     f"{old['category']} / {old['lookup_key']}",
                     {"deleted": {"value_num": old["value_num"], "value_text": old["value_text"]},
                      "reason": reason or None})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Productivity rates — drives the dropdowns in productivity-shape sections of
# the Base Quoting Metrics page (Teardrop, Bolted, Wire Decking, Anchors, ...).
# ---------------------------------------------------------------------------
@router.get("/productivity-rates")
def list_productivity_rates(
    category: Optional[str] = None,
    estimate_id: Optional[int] = None,
    _user=Depends(get_current_user),
):
    # With estimate_id, the picker lists the estimate's FROZEN rate catalog —
    # the frozen workbook-copy model: new lines on an old quote use its rates.
    if estimate_id:
        with engine.begin() as conn:
            snap = get_reference_snapshot(conn, estimate_id)
        if snap is not None:
            rows = snap.get("productivity_rates", [])
            if category:
                rows = [r for r in rows if r.get("category") == category]
            return sorted(rows, key=lambda r: (r.get("sort_order") or 0, r.get("item_name") or ""))

    sql = """
        SELECT id, category, item_name, standard_per_day,
               aggressive_multiplier, aggressive_per_day, unit, sort_order
        FROM productivity_rates
    """
    params = {}
    if category:
        sql += " WHERE category = :category"
        params["category"] = category
    sql += " ORDER BY sort_order, item_name"

    with engine.connect() as conn:
        rows = conn.execute(text(sql), params).mappings().all()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Rental rates — drives the dropdowns in rental-shape sections (Rentals - Rack
# Install, Rentals - Wire Guidance Install). One row per
# equipment_type × power_source × size_class × duration tuple.
# ---------------------------------------------------------------------------
@router.get("/rental-rates")
def list_rental_rates(estimate_id: Optional[int] = None, _user=Depends(get_current_user)):
    if estimate_id:
        with engine.begin() as conn:
            snap = get_reference_snapshot(conn, estimate_id)
        if snap is not None:
            return snap.get("rental_rates", [])
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, equipment_type, power_source, size_class, duration,
                   CAST(price AS DECIMAL(10,2)) AS price
            FROM rental_rates
            ORDER BY equipment_type, power_source, size_class,
                     FIELD(duration, 'day', 'week', 'month')
        """)).mappings().all()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Productivity-rates admin (Settings → Reference Data). Richer than lookup
# values: each row is an install item with a standard and aggressive per-day
# rate. aggressive_per_day is derived (standard × multiplier). page.settings.
# ---------------------------------------------------------------------------
class ProductivityRow(BaseModel):
    category: Optional[str] = None        # required on create; ignored on update
    item_name: str
    standard_per_day: Optional[int] = 0
    aggressive_multiplier: Optional[float] = 1.0
    unit: Optional[str] = None
    sort_order: Optional[int] = 0
    reason: Optional[str] = None          # audit-only: why the change was made


def _agg_per_day(std, mult):
    return int(round((std or 0) * (mult if mult is not None else 1.0)))


@router.get("/productivity-rates/admin")
def list_productivity_rates_admin(_user=Depends(require_capability("page.settings"))):
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, category, item_name, standard_per_day, aggressive_multiplier,
                   aggressive_per_day, unit, sort_order
            FROM productivity_rates ORDER BY category, sort_order, item_name
        """)).mappings().all()
    grouped = defaultdict(list)
    for r in rows:
        grouped[r["category"]].append({
            "id": r["id"], "item_name": r["item_name"],
            "standard_per_day": r["standard_per_day"],
            "aggressive_multiplier": float(r["aggressive_multiplier"]) if r["aggressive_multiplier"] is not None else None,
            "aggressive_per_day": r["aggressive_per_day"],
            "unit": r["unit"], "sort_order": r["sort_order"],
        })
    return {"categories": [{"category": k, "rows": v} for k, v in sorted(grouped.items())]}


@router.post("/productivity-rates")
def create_productivity_rate(body: ProductivityRow, user=Depends(require_capability("page.settings"))):
    if not (body.category or "").strip():
        raise HTTPException(status_code=400, detail="category is required")
    if not (body.item_name or "").strip():
        raise HTTPException(status_code=400, detail="item name is required")
    agg = _agg_per_day(body.standard_per_day, body.aggressive_multiplier)
    try:
        with engine.begin() as conn:
            res = conn.execute(text("""
                INSERT INTO productivity_rates (category, item_name, standard_per_day,
                    aggressive_multiplier, aggressive_per_day, unit, sort_order)
                VALUES (:c,:i,:s,:m,:a,:u,:o)
            """), {"c": body.category.strip(), "i": body.item_name.strip(),
                   "s": body.standard_per_day or 0, "m": body.aggressive_multiplier,
                   "a": agg, "u": (body.unit or None), "o": body.sort_order or 0})
    except IntegrityError:
        raise HTTPException(status_code=400, detail="That item already exists in this category.")
    record_audit(user, "rate.create", "productivity_rate", res.lastrowid,
                 f"{body.category.strip()} / {body.item_name.strip()}",
                 {"values": {"standard_per_day": body.standard_per_day, "aggressive_multiplier": body.aggressive_multiplier},
                  "reason": body.reason or None})
    return {"ok": True, "id": res.lastrowid}


@router.patch("/productivity-rates/{row_id}")
def update_productivity_rate(row_id: int, body: ProductivityRow, user=Depends(require_capability("page.settings"))):
    if not (body.item_name or "").strip():
        raise HTTPException(status_code=400, detail="item name is required")
    agg = _agg_per_day(body.standard_per_day, body.aggressive_multiplier)
    with engine.connect() as conn:
        old = conn.execute(text("SELECT * FROM productivity_rates WHERE id=:id"), {"id": row_id}).mappings().first()
    try:
        with engine.begin() as conn:
            res = conn.execute(text("""
                UPDATE productivity_rates SET item_name=:i, standard_per_day=:s,
                    aggressive_multiplier=:m, aggressive_per_day=:a, unit=:u, sort_order=:o
                WHERE id=:id
            """), {"i": body.item_name.strip(), "s": body.standard_per_day or 0,
                   "m": body.aggressive_multiplier, "a": agg, "u": (body.unit or None),
                   "o": body.sort_order or 0, "id": row_id})
    except IntegrityError:
        raise HTTPException(status_code=400, detail="That item already exists in this category.")
    if res.rowcount == 0:
        raise HTTPException(status_code=404, detail="Productivity rate not found")
    changes = diff_fields(dict(old or {}), {"item_name": body.item_name.strip(), "standard_per_day": body.standard_per_day or 0,
                                            "aggressive_multiplier": body.aggressive_multiplier, "aggressive_per_day": agg,
                                            "unit": body.unit or None, "sort_order": body.sort_order or 0},
                          ["item_name", "standard_per_day", "aggressive_multiplier", "aggressive_per_day", "unit", "sort_order"])
    if changes:
        record_audit(user, "rate.update", "productivity_rate", row_id,
                     f"{(old or {}).get('category', '?')} / {body.item_name.strip()}",
                     {"changes": changes, "reason": body.reason or None})
    return {"ok": True}


@router.delete("/productivity-rates/{row_id}")
def delete_productivity_rate(row_id: int, reason: Optional[str] = None,
                             user=Depends(require_capability("page.settings"))):
    with engine.begin() as conn:
        old = conn.execute(text("SELECT * FROM productivity_rates WHERE id=:id"), {"id": row_id}).mappings().first()
        conn.execute(text("DELETE FROM productivity_rates WHERE id=:id"), {"id": row_id})
    if old:
        record_audit(user, "rate.delete", "productivity_rate", row_id,
                     f"{old['category']} / {old['item_name']}",
                     {"deleted": {"standard_per_day": old["standard_per_day"],
                                  "aggressive_multiplier": old["aggressive_multiplier"]},
                      "reason": reason or None})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Rental-rates admin. Flat list keyed by equipment × power × size × duration.
# ---------------------------------------------------------------------------
_DURATIONS = ("day", "week", "month")


class RentalRow(BaseModel):
    equipment_type: str
    power_source: Optional[str] = None
    size_class: Optional[str] = None
    duration: str
    price: Optional[float] = 0
    reason: Optional[str] = None          # audit-only: why the change was made


def _rental_label(r):
    return " / ".join(str(v) for v in (r.get("equipment_type"), r.get("power_source"),
                                       r.get("size_class"), r.get("duration")) if v)


@router.get("/rental-rates/admin")
def list_rental_rates_admin(_user=Depends(require_capability("page.settings"))):
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT id, equipment_type, power_source, size_class, duration,
                   CAST(price AS DECIMAL(10,2)) AS price
            FROM rental_rates
            ORDER BY equipment_type, power_source, size_class,
                     FIELD(duration, 'day', 'week', 'month')
        """)).mappings().all()
    return {"rows": [{**dict(r), "price": float(r["price"]) if r["price"] is not None else None} for r in rows]}


@router.post("/rental-rates")
def create_rental_rate(body: RentalRow, user=Depends(require_capability("page.settings"))):
    if not (body.equipment_type or "").strip():
        raise HTTPException(status_code=400, detail="equipment type is required")
    if body.duration not in _DURATIONS:
        raise HTTPException(status_code=400, detail="duration must be day, week or month")
    try:
        with engine.begin() as conn:
            res = conn.execute(text("""
                INSERT INTO rental_rates (equipment_type, power_source, size_class, duration, price)
                VALUES (:e,:p,:s,:d,:pr)
            """), {"e": body.equipment_type.strip(), "p": (body.power_source or None),
                   "s": (body.size_class or None), "d": body.duration, "pr": body.price or 0})
    except IntegrityError:
        raise HTTPException(status_code=400, detail="That equipment/power/size/duration combination already exists.")
    record_audit(user, "rate.create", "rental_rate", res.lastrowid,
                 _rental_label(body.model_dump()),
                 {"values": {"price": body.price}, "reason": body.reason or None})
    return {"ok": True, "id": res.lastrowid}


@router.patch("/rental-rates/{row_id}")
def update_rental_rate(row_id: int, body: RentalRow, user=Depends(require_capability("page.settings"))):
    if not (body.equipment_type or "").strip():
        raise HTTPException(status_code=400, detail="equipment type is required")
    if body.duration not in _DURATIONS:
        raise HTTPException(status_code=400, detail="duration must be day, week or month")
    with engine.connect() as conn:
        old = conn.execute(text("SELECT * FROM rental_rates WHERE id=:id"), {"id": row_id}).mappings().first()
    try:
        with engine.begin() as conn:
            res = conn.execute(text("""
                UPDATE rental_rates SET equipment_type=:e, power_source=:p, size_class=:s,
                    duration=:d, price=:pr WHERE id=:id
            """), {"e": body.equipment_type.strip(), "p": (body.power_source or None),
                   "s": (body.size_class or None), "d": body.duration, "pr": body.price or 0, "id": row_id})
    except IntegrityError:
        raise HTTPException(status_code=400, detail="That equipment/power/size/duration combination already exists.")
    if res.rowcount == 0:
        raise HTTPException(status_code=404, detail="Rental rate not found")
    changes = diff_fields(dict(old or {}), {"equipment_type": body.equipment_type.strip(),
                                            "power_source": body.power_source or None,
                                            "size_class": body.size_class or None,
                                            "duration": body.duration, "price": body.price or 0},
                          ["equipment_type", "power_source", "size_class", "duration", "price"])
    if changes:
        record_audit(user, "rate.update", "rental_rate", row_id,
                     _rental_label(body.model_dump()),
                     {"changes": changes, "reason": body.reason or None})
    return {"ok": True}


@router.delete("/rental-rates/{row_id}")
def delete_rental_rate(row_id: int, reason: Optional[str] = None,
                       user=Depends(require_capability("page.settings"))):
    with engine.begin() as conn:
        old = conn.execute(text("SELECT * FROM rental_rates WHERE id=:id"), {"id": row_id}).mappings().first()
        conn.execute(text("DELETE FROM rental_rates WHERE id=:id"), {"id": row_id})
    if old:
        record_audit(user, "rate.delete", "rental_rate", row_id,
                     _rental_label(dict(old)),
                     {"deleted": {"price": old["price"]}, "reason": reason or None})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Section templates — pre-seeded rows that come with a section on first view.
# Each entry pairs a section_code with the line_kind it stores plus its row
# labels. The user can override labels or delete rows; subsequent reloads
# re-seed empty sections.
#
# OH&P and Profit % rows are intentionally omitted from labor blocks —
# they're computed totals, not user input, and live in the rollup layer.
# ---------------------------------------------------------------------------
SECTION_TEMPLATES: dict[str, dict] = {
    # Labor blocks (free_form: label + qty + unit_price -> ext_cost)
    "downtime_labor":         {"line_kind": "free_form", "labels": ["Materials", "Contract Labor", "Mgmt Travel", "Lodging"]},
    "remobilization_labor":   {"line_kind": "free_form", "labels": ["Materials", "Contract Labor", "Mgmt Travel", "Lodging"]},
    "dismantle_labor":        {"line_kind": "free_form", "labels": ["Materials", "Contract Labor", "Mgmt Travel", "Lodging"]},
    "mobilization_labor":     {"line_kind": "free_form", "labels": ["Materials", "Contract Labor", "Mgmt Travel", "Lodging"]},
    "upright_assembly_labor": {"line_kind": "free_form", "labels": ["Materials", "Contract Labor", "Mgmt Travel", "Lodging"]},
    "anchor_holes_labor":     {"line_kind": "free_form", "labels": ["Materials", "Contract Labor", "Mgmt Travel", "Lodging"]},
    # Wedge Anchors is a labor block with no fixed labels in the workbook —
    # the user types row descriptions themselves. No templates to seed.
    "wedge_anchors":          {"line_kind": "free_form", "labels": []},
    "miscellaneous_labor":    {"line_kind": "free_form", "labels": [
        "Materials", "Contract Labor", "Dumpsters/Site Rentals",
        "GC Licensing", "Lifts", "Lodging", "Mgmt Travel",
        "Partner Appreciation (Discount)", "Permitting", "Rentals",
        "Shipping/Freight",
    ]},

    # Other Rentals (other_rental: label + qty + mobs + unit_price -> ext_cost)
    "other_rentals_rack_install":  {"line_kind": "other_rental", "labels": [
        "Environmental Fees",
        "Hauling Each Way (# Trips)",
        "Liquid Propane (SHOULD BE ZERO IF ELECTRIC)",
        "Dumpster",
    ]},
    "other_rentals_wire_guidance": {"line_kind": "other_rental", "labels": [
        "Environmental Fees",
        "Hauling Each Way (# Trips)",
        "Liquid Propane (SHOULD BE ZERO IF ELECTRIC)",
        "Dumpster",
    ]},
}


def _ensure_labor_templates(conn, metric_set_id: int):
    """
    Idempotent: for each section template with no existing rows on the
    given metric set, insert the template rows. Safe to call on every page
    load — only writes when a section is empty.

    Re-seeds if the user deletes ALL rows from a section. That's intentional
    for now (cheap reset); if it becomes annoying we can track a "seeded"
    flag on the metric set instead.
    """
    for section_code, cfg in SECTION_TEMPLATES.items():
        labels = cfg.get("labels") or []
        line_kind = cfg.get("line_kind", "free_form")
        if not labels:
            continue
        existing = conn.execute(text("""
            SELECT COUNT(*) AS n FROM quote_metric_lines
            WHERE metric_set_id = :mid AND section_code = :sc
        """), {"mid": metric_set_id, "sc": section_code}).scalar() or 0
        if existing > 0:
            continue
        for idx, label in enumerate(labels):
            # 'other_rental' rows seed with mobilizations=1 so the user only
            # has to fill in qty + unit_price for a baseline calculation.
            mob_default = 1 if line_kind == "other_rental" else None
            conn.execute(text("""
                INSERT INTO quote_metric_lines
                  (metric_set_id, section_code, line_kind, sort_order, label,
                   qty, mobilizations, unit_price)
                VALUES (:mid, :sc, :lk, :so, :label, NULL, :mob, NULL)
            """), {
                "mid":   metric_set_id,
                "sc":    section_code,
                "lk":    line_kind,
                "so":    idx,
                "label": label,
                "mob":   mob_default,
            })


# ---------------------------------------------------------------------------
# Quote metric sets — Base + Options + Project Rentals per estimate. The GET
# endpoint auto-creates the Base row on first call so the Quoting Metrics
# page always finds one to write into.
# ---------------------------------------------------------------------------
_METRIC_SET_ATTR_COLS = [
    "estimate_type_override",
    "installation_environment",
    "wire_guidance_linear_footage",
    "scissor_lifts_per_crew",
    "forklifts_per_crew",
    "scrubbers_per_wire_scope",
    "saws_per_wire_scope",
    "rack_install_labor_day_override",
    "rack_install_project_time_adder",
    "rack_install_buffer_day_counter",
    "wire_guidance_labor_day_override",
    "wire_guidance_project_time_adder",
    "wire_guidance_buffer_day_counter",
    "downtime_labor_day_override",
    "travel_labor_day_override",
]


def _list_metric_sets(conn, estimate_id: int):
    return conn.execute(text(f"""
        SELECT id, estimate_id, kind, label, sort_order, is_enabled,
               CAST(mobilizations AS DECIMAL(6,2)) AS mobilizations,
               estimate_type_override,
               installation_environment,
               CAST(wire_guidance_linear_footage AS DECIMAL(10,2)) AS wire_guidance_linear_footage,
               scissor_lifts_per_crew,
               forklifts_per_crew,
               scrubbers_per_wire_scope,
               saws_per_wire_scope,
               CAST(rack_install_labor_day_override   AS DECIMAL(8,2)) AS rack_install_labor_day_override,
               CAST(rack_install_project_time_adder   AS DECIMAL(8,2)) AS rack_install_project_time_adder,
               CAST(rack_install_buffer_day_counter   AS DECIMAL(8,2)) AS rack_install_buffer_day_counter,
               CAST(wire_guidance_labor_day_override  AS DECIMAL(8,2)) AS wire_guidance_labor_day_override,
               CAST(wire_guidance_project_time_adder  AS DECIMAL(8,2)) AS wire_guidance_project_time_adder,
               CAST(wire_guidance_buffer_day_counter  AS DECIMAL(8,2)) AS wire_guidance_buffer_day_counter,
               CAST(downtime_labor_day_override       AS DECIMAL(8,2)) AS downtime_labor_day_override,
               CAST(travel_labor_day_override         AS DECIMAL(8,2)) AS travel_labor_day_override
        FROM quote_metric_sets
        WHERE estimate_id = :estimate_id
        ORDER BY sort_order
    """), {"estimate_id": estimate_id}).mappings().all()


@router.get("/metric-sets")
def list_metric_sets(estimate_id: int, _user=Depends(get_current_user)):
    with engine.begin() as conn:
        rows = _list_metric_sets(conn, estimate_id)
        if not any(r["kind"] == "base" for r in rows):
            conn.execute(text("""
                INSERT INTO quote_metric_sets
                  (estimate_id, kind, label, sort_order, is_enabled, mobilizations)
                VALUES (:estimate_id, 'base', 'Base', 0, 1, 1)
            """), {"estimate_id": estimate_id})
            rows = _list_metric_sets(conn, estimate_id)

        # Ensure labor-block templates exist for the Base set. Idempotent —
        # only seeds rows when a labor section has zero lines.
        base = next((r for r in rows if r["kind"] == "base"), None)
        if base:
            _ensure_labor_templates(conn, base["id"])
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Create a new metric set for an estimate. Used by the "+ Add Option" tab on
# the Estimate workspace. Auto-assigns the next option sort_order (1, 2, 3,
# ...) and seeds labor-block templates on the new set so it feels populated
# right away.
# ---------------------------------------------------------------------------
class MetricSetCreate(BaseModel):
    estimate_id: int
    kind:        str   # 'option' | 'project_rentals'  (Base auto-creates elsewhere)
    label:       Optional[str] = None


@router.post("/metric-sets")
def create_metric_set(req: MetricSetCreate, _user=Depends(get_current_user)):
    if req.kind not in ("option", "project_rentals"):
        raise HTTPException(
            status_code=400,
            detail="kind must be 'option' or 'project_rentals' (base is auto-created)"
        )

    with engine.begin() as conn:
        if req.kind == "project_rentals":
            # Only one PR slot per estimate.
            existing = conn.execute(text("""
                SELECT id FROM quote_metric_sets
                WHERE estimate_id = :eid AND kind = 'project_rentals'
                LIMIT 1
            """), {"eid": req.estimate_id}).first()
            if existing:
                raise HTTPException(status_code=400, detail="Project Rentals set already exists for this estimate")
            sort_order = 99
            label = req.label or "Project Rentals"
        else:
            # Next free option sort_order, starting at 1.
            row = conn.execute(text("""
                SELECT COALESCE(MAX(sort_order), 0) AS max_so
                FROM quote_metric_sets
                WHERE estimate_id = :eid AND kind = 'option'
            """), {"eid": req.estimate_id}).mappings().first()
            sort_order = int(row["max_so"]) + 1
            label = req.label or f"Option {sort_order}"

        result = conn.execute(text("""
            INSERT INTO quote_metric_sets
              (estimate_id, kind, label, sort_order, is_enabled, mobilizations)
            VALUES (:eid, :kind, :label, :so, 1, 1)
        """), {
            "eid":   req.estimate_id,
            "kind":  req.kind,
            "label": label,
            "so":    sort_order,
        })
        new_id = result.lastrowid

        # Seed labor-block + other-rentals templates so the option starts in
        # a usable state, same as the Base set does on auto-create.
        _ensure_labor_templates(conn, new_id)

        # Return the fully-hydrated row (includes all per-set attr columns).
        row = conn.execute(text(f"""
            SELECT id, estimate_id, kind, label, sort_order, is_enabled,
                   CAST(mobilizations AS DECIMAL(6,2)) AS mobilizations
            FROM quote_metric_sets WHERE id = :id
        """), {"id": new_id}).mappings().first()
    return dict(row)


# ---------------------------------------------------------------------------
# Per-set attribute update. Accepts a partial body — any field omitted from
# the request stays unchanged. The frontend Tab Settings card calls this on
# every input change.
# ---------------------------------------------------------------------------
class MetricSetAttrsPatch(BaseModel):
    is_enabled:                          Optional[int]    = None   # 0 / 1 toggle from the Review tab
    mobilizations:                       Optional[float]  = None
    estimate_type_override:              Optional[str]    = None
    installation_environment:            Optional[str]    = None
    wire_guidance_linear_footage:        Optional[float]  = None
    scissor_lifts_per_crew:              Optional[int]    = None
    forklifts_per_crew:                  Optional[int]    = None
    scrubbers_per_wire_scope:            Optional[int]    = None
    saws_per_wire_scope:                 Optional[int]    = None
    rack_install_labor_day_override:     Optional[float]  = None
    rack_install_project_time_adder:     Optional[float]  = None
    rack_install_buffer_day_counter:     Optional[float]  = None
    wire_guidance_labor_day_override:    Optional[float]  = None
    wire_guidance_project_time_adder:    Optional[float]  = None
    wire_guidance_buffer_day_counter:    Optional[float]  = None
    downtime_labor_day_override:         Optional[float]  = None
    travel_labor_day_override:           Optional[float]  = None


# Fields whose NULL is a legitimate value the user can save (clear an
# override). For these we honor the explicit null; for the rest, an omitted
# or null field is treated as "don't change".
_NULLABLE_ATTRS = {
    "estimate_type_override",
    "rack_install_labor_day_override",
    "rack_install_project_time_adder",
    "rack_install_buffer_day_counter",
    "wire_guidance_labor_day_override",
    "wire_guidance_project_time_adder",
    "wire_guidance_buffer_day_counter",
    "downtime_labor_day_override",
    "travel_labor_day_override",
}


@router.patch("/metric-sets/{set_id}")
def update_metric_set(set_id: int, req: MetricSetAttrsPatch, _user=Depends(get_current_user)):
    payload = req.model_dump(exclude_unset=True)
    if not payload:
        return {"ok": True, "updated": False}

    set_clauses = []
    params: dict = {"id": set_id}
    for field, value in payload.items():
        if value is None and field not in _NULLABLE_ATTRS:
            continue
        set_clauses.append(f"{field} = :{field}")
        params[field] = value
    if not set_clauses:
        return {"ok": True, "updated": False}

    with engine.begin() as conn:
        result = conn.execute(text(f"""
            UPDATE quote_metric_sets
            SET {', '.join(set_clauses)}
            WHERE id = :id
        """), params)
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Metric set not found")
        # Return the refreshed row so the client can re-sync.
        row = conn.execute(text("""
            SELECT * FROM quote_metric_sets WHERE id = :id
        """), {"id": set_id}).mappings().first()
    return dict(row) if row else {"ok": True, "updated": True}


# ---------------------------------------------------------------------------
# Quote metric lines — the editable line items inside a metric set. For now
# the page only drives `line_kind = 'productivity'` (Teardrop slice), but
# the create/update logic is shape-aware so adding rentals and labor lines
# later is just a UI exercise.
# ---------------------------------------------------------------------------
class MetricLineWrite(BaseModel):
    metric_set_id: int
    section_code: str
    line_kind: str
    sort_order: int = 0
    productivity_rate_id: Optional[int] = None
    rental_rate_id: Optional[int] = None
    label: Optional[str] = None
    qty: Optional[float] = None
    mobilizations: Optional[float] = None
    unit_price: Optional[float] = None
    notes: Optional[str] = None


def _snapshot_rate(conn, payload: MetricLineWrite, kind: str):
    """Resolve the rate row a line prices from — the estimate's frozen snapshot
    first (#2 packaging), the live table only as a fallback (legacy paths)."""
    eid = estimate_id_for_set(conn, payload.metric_set_id)
    snap = get_reference_snapshot(conn, eid)
    prod_by, rent_by = snapshot_maps(snap)
    if kind == "productivity":
        return prod_by.get(payload.productivity_rate_id) or conn.execute(text(
            "SELECT standard_per_day, aggressive_per_day FROM productivity_rates WHERE id = :id"
        ), {"id": payload.productivity_rate_id}).mappings().first()
    return rent_by.get(payload.rental_rate_id) or conn.execute(text(
        "SELECT price FROM rental_rates WHERE id = :id"
    ), {"id": payload.rental_rate_id}).mappings().first()


def _compute_line_totals(conn, payload: MetricLineWrite):
    """Returns (ext_cost, std_total, agg_total) based on line_kind + payload."""
    std_total = None
    agg_total = None
    ext_cost = None

    if payload.line_kind == "productivity" and payload.productivity_rate_id and payload.qty is not None:
        rate = _snapshot_rate(conn, payload, "productivity")
        if rate:
            if rate["standard_per_day"]:
                std_total = round(float(payload.qty) / float(rate["standard_per_day"]), 3)
            if rate["aggressive_per_day"]:
                agg_total = round(float(payload.qty) / float(rate["aggressive_per_day"]), 3)

    elif payload.line_kind == "rental" and payload.rental_rate_id and payload.qty is not None:
        rate = _snapshot_rate(conn, payload, "rental")
        if rate and rate["price"] is not None:
            ext_cost = round(float(payload.qty) * float(rate["price"]), 2)

    elif payload.line_kind in ("labor_fixed", "free_form") \
            and payload.qty is not None and payload.unit_price is not None:
        ext_cost = round(float(payload.qty) * float(payload.unit_price), 2)

    elif payload.line_kind == "other_rental" \
            and payload.qty is not None and payload.unit_price is not None:
        mobs = float(payload.mobilizations) if payload.mobilizations is not None else 1.0
        ext_cost = round(float(payload.qty) * mobs * float(payload.unit_price), 2)

    return ext_cost, std_total, agg_total


def _overlay_snapshot_values(rows, snap):
    """Replace the live-joined rate columns with the estimate's frozen values.
    The LEFT JOINs below stay as the fallback for rows a snapshot doesn't know."""
    if not snap:
        return [dict(r) for r in rows]
    prod_by, rent_by = snapshot_maps(snap)
    out = []
    for r in rows:
        d = dict(r)
        p = prod_by.get(d.get("productivity_rate_id"))
        if p:
            d["productivity_item_name"] = p.get("item_name")
            d["productivity_std_per_day"] = p.get("standard_per_day")
            d["productivity_agg_per_day"] = p.get("aggressive_per_day")
            d["productivity_unit"] = p.get("unit")
        rr = rent_by.get(d.get("rental_rate_id"))
        if rr:
            d["rental_equipment_type"] = rr.get("equipment_type")
            d["rental_power_source"] = rr.get("power_source")
            d["rental_size_class"] = rr.get("size_class")
            d["rental_duration"] = rr.get("duration")
            d["rental_price"] = rr.get("price")
        out.append(d)
    return out


def _fetch_line(conn, line_id: int):
    return conn.execute(text("""
        SELECT l.id, l.metric_set_id, l.section_code, l.line_kind, l.sort_order,
               l.productivity_rate_id, l.rental_rate_id, l.label,
               CAST(l.qty AS DECIMAL(12,3))        AS qty,
               CAST(l.mobilizations AS DECIMAL(6,2)) AS mobilizations,
               CAST(l.unit_price AS DECIMAL(12,2)) AS unit_price,
               CAST(l.ext_cost AS DECIMAL(14,2))   AS ext_cost,
               CAST(l.std_total AS DECIMAL(12,3))  AS std_total,
               CAST(l.agg_total AS DECIMAL(12,3))  AS agg_total,
               l.notes,
               pr.item_name             AS productivity_item_name,
               pr.standard_per_day      AS productivity_std_per_day,
               pr.aggressive_per_day    AS productivity_agg_per_day,
               pr.unit                  AS productivity_unit,
               rr.equipment_type        AS rental_equipment_type,
               rr.power_source          AS rental_power_source,
               rr.size_class            AS rental_size_class,
               rr.duration              AS rental_duration,
               CAST(rr.price AS DECIMAL(10,2)) AS rental_price
        FROM quote_metric_lines l
        LEFT JOIN productivity_rates pr ON pr.id = l.productivity_rate_id
        LEFT JOIN rental_rates      rr ON rr.id = l.rental_rate_id
        WHERE l.id = :id
    """), {"id": line_id}).mappings().first()


@router.get("/metric-lines")
def list_metric_lines(
    metric_set_id: Optional[int] = None,
    estimate_id:   Optional[int] = None,
    section_code:  Optional[str] = None,
    _user=Depends(get_current_user),
):
    """
    Pass `metric_set_id` to scope to one set (the Base / Option / Project
    Rentals editor uses this). Pass `estimate_id` to return every line for
    every set on that estimate at once — used by the Review tab's rollup.
    """
    if metric_set_id is None and estimate_id is None:
        raise HTTPException(status_code=400, detail="metric_set_id or estimate_id is required")

    sql = """
        SELECT l.id, l.metric_set_id, l.section_code, l.line_kind, l.sort_order,
               l.productivity_rate_id, l.rental_rate_id, l.label,
               CAST(l.qty AS DECIMAL(12,3))        AS qty,
               CAST(l.mobilizations AS DECIMAL(6,2)) AS mobilizations,
               CAST(l.unit_price AS DECIMAL(12,2)) AS unit_price,
               CAST(l.ext_cost AS DECIMAL(14,2))   AS ext_cost,
               CAST(l.std_total AS DECIMAL(12,3))  AS std_total,
               CAST(l.agg_total AS DECIMAL(12,3))  AS agg_total,
               l.notes,
               pr.item_name             AS productivity_item_name,
               pr.standard_per_day      AS productivity_std_per_day,
               pr.aggressive_per_day    AS productivity_agg_per_day,
               pr.unit                  AS productivity_unit,
               rr.equipment_type        AS rental_equipment_type,
               rr.power_source          AS rental_power_source,
               rr.size_class            AS rental_size_class,
               rr.duration              AS rental_duration,
               CAST(rr.price AS DECIMAL(10,2)) AS rental_price
        FROM quote_metric_lines l
        LEFT JOIN productivity_rates pr ON pr.id = l.productivity_rate_id
        LEFT JOIN rental_rates      rr ON rr.id = l.rental_rate_id
    """
    params: dict = {}
    where = []
    if metric_set_id is not None:
        where.append("l.metric_set_id = :metric_set_id")
        params["metric_set_id"] = metric_set_id
    if estimate_id is not None:
        sql += " JOIN quote_metric_sets s ON s.id = l.metric_set_id"
        where.append("s.estimate_id = :estimate_id")
        params["estimate_id"] = estimate_id
    if section_code:
        where.append("l.section_code = :section_code")
        params["section_code"] = section_code
    sql += " WHERE " + " AND ".join(where) + " ORDER BY l.metric_set_id, l.sort_order, l.id"

    with engine.connect() as conn:
        rows = conn.execute(text(sql), params).mappings().all()
    # Serve rate values from the estimate's frozen snapshot, not the live join.
    with engine.begin() as conn:
        eid = estimate_id if estimate_id is not None else estimate_id_for_set(conn, metric_set_id)
        snap = get_reference_snapshot(conn, eid)
    return _overlay_snapshot_values(rows, snap)


@router.post("/metric-lines")
def create_metric_line(req: MetricLineWrite, _user=Depends(get_current_user)):
    with engine.begin() as conn:
        ext_cost, std_total, agg_total = _compute_line_totals(conn, req)
        result = conn.execute(text("""
            INSERT INTO quote_metric_lines (
                metric_set_id, section_code, line_kind, sort_order,
                productivity_rate_id, rental_rate_id, label,
                qty, mobilizations, unit_price, ext_cost, std_total, agg_total, notes
            ) VALUES (
                :metric_set_id, :section_code, :line_kind, :sort_order,
                :productivity_rate_id, :rental_rate_id, :label,
                :qty, :mobilizations, :unit_price, :ext_cost, :std_total, :agg_total, :notes
            )
        """), {
            **req.model_dump(),
            "ext_cost": ext_cost,
            "std_total": std_total,
            "agg_total": agg_total,
        })
        row = _fetch_line(conn, result.lastrowid)
        snap = get_reference_snapshot(conn, estimate_id_for_set(conn, row["metric_set_id"]))
    return _overlay_snapshot_values([row], snap)[0]


@router.put("/metric-lines/{line_id}")
def update_metric_line(line_id: int, req: MetricLineWrite, _user=Depends(get_current_user)):
    with engine.begin() as conn:
        existing = conn.execute(text(
            "SELECT id FROM quote_metric_lines WHERE id = :id"
        ), {"id": line_id}).first()
        if not existing:
            raise HTTPException(status_code=404, detail="Line not found")

        ext_cost, std_total, agg_total = _compute_line_totals(conn, req)
        conn.execute(text("""
            UPDATE quote_metric_lines
            SET metric_set_id = :metric_set_id,
                section_code = :section_code,
                line_kind = :line_kind,
                sort_order = :sort_order,
                productivity_rate_id = :productivity_rate_id,
                rental_rate_id = :rental_rate_id,
                label = :label,
                qty = :qty,
                mobilizations = :mobilizations,
                unit_price = :unit_price,
                ext_cost = :ext_cost,
                std_total = :std_total,
                agg_total = :agg_total,
                notes = :notes
            WHERE id = :id
        """), {
            **req.model_dump(),
            "id": line_id,
            "ext_cost": ext_cost,
            "std_total": std_total,
            "agg_total": agg_total,
        })
        row = _fetch_line(conn, line_id)
        snap = get_reference_snapshot(conn, estimate_id_for_set(conn, row["metric_set_id"]))
    return _overlay_snapshot_values([row], snap)[0]


@router.delete("/metric-lines/{line_id}")
def delete_metric_line(line_id: int, _user=Depends(get_current_user)):
    with engine.begin() as conn:
        result = conn.execute(text(
            "DELETE FROM quote_metric_lines WHERE id = :id"
        ), {"id": line_id})
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Line not found")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Bulk delete — clear every line in a section for a given metric set. Used by
# the "Clear" button on each section card. Idempotent: returns the row count
# even when nothing matched.
# ---------------------------------------------------------------------------
@router.delete("/metric-lines")
def delete_metric_lines_bulk(
    metric_set_id: int,
    section_code:  str,
    _user=Depends(get_current_user),
):
    with engine.begin() as conn:
        result = conn.execute(text("""
            DELETE FROM quote_metric_lines
            WHERE metric_set_id = :mid AND section_code = :sc
        """), {"mid": metric_set_id, "sc": section_code})
    return {"ok": True, "deleted": result.rowcount or 0}


# ---------------------------------------------------------------------------
# Delete a metric set entirely. Cascades to quote_metric_lines via the FK
# (ON DELETE CASCADE). Base sets are protected — there must always be a
# Base for an estimate.
# ---------------------------------------------------------------------------
@router.delete("/metric-sets/{set_id}")
def delete_metric_set(set_id: int, _user=Depends(get_current_user)):
    with engine.begin() as conn:
        row = conn.execute(text("""
            SELECT kind FROM quote_metric_sets WHERE id = :id
        """), {"id": set_id}).first()
        if not row:
            raise HTTPException(status_code=404, detail="Metric set not found")
        if row[0] == "base":
            raise HTTPException(status_code=400, detail="The Base set cannot be deleted")
        conn.execute(text("""
            DELETE FROM quote_metric_sets WHERE id = :id
        """), {"id": set_id})
    return {"ok": True}
