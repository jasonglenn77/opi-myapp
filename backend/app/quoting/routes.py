from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.auth import get_current_user
from app.db import engine

router = APIRouter(prefix="/api/quoting", tags=["quoting"])


@router.get("/lookup-values")
def list_lookup_values(_user=Depends(get_current_user)):
    """
    Reference values for the Estimate page dropdowns.
    Rows are grouped by `category` and ordered by `sort_order`.
    Response shape: { "<category>": [ { key, value_num, value_text, sort_order }, ... ], ... }
    """
    with engine.connect() as conn:
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
# Productivity rates — drives the dropdowns in productivity-shape sections of
# the Base Quoting Metrics page (Teardrop, Bolted, Wire Decking, Anchors, ...).
# ---------------------------------------------------------------------------
@router.get("/productivity-rates")
def list_productivity_rates(
    category: Optional[str] = None,
    _user=Depends(get_current_user),
):
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
def list_rental_rates(_user=Depends(get_current_user)):
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
# Per-set attribute update. Accepts a partial body — any field omitted from
# the request stays unchanged. The frontend Tab Settings card calls this on
# every input change.
# ---------------------------------------------------------------------------
class MetricSetAttrsPatch(BaseModel):
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


def _compute_line_totals(conn, payload: MetricLineWrite):
    """Returns (ext_cost, std_total, agg_total) based on line_kind + payload."""
    std_total = None
    agg_total = None
    ext_cost = None

    if payload.line_kind == "productivity" and payload.productivity_rate_id and payload.qty is not None:
        rate = conn.execute(text("""
            SELECT standard_per_day, aggressive_per_day
            FROM productivity_rates WHERE id = :id
        """), {"id": payload.productivity_rate_id}).mappings().first()
        if rate:
            if rate["standard_per_day"]:
                std_total = round(float(payload.qty) / float(rate["standard_per_day"]), 3)
            if rate["aggressive_per_day"]:
                agg_total = round(float(payload.qty) / float(rate["aggressive_per_day"]), 3)

    elif payload.line_kind == "rental" and payload.rental_rate_id and payload.qty is not None:
        rate = conn.execute(text("""
            SELECT price FROM rental_rates WHERE id = :id
        """), {"id": payload.rental_rate_id}).mappings().first()
        if rate:
            ext_cost = round(float(payload.qty) * float(rate["price"]), 2)

    elif payload.line_kind in ("labor_fixed", "free_form") \
            and payload.qty is not None and payload.unit_price is not None:
        ext_cost = round(float(payload.qty) * float(payload.unit_price), 2)

    elif payload.line_kind == "other_rental" \
            and payload.qty is not None and payload.unit_price is not None:
        mobs = float(payload.mobilizations) if payload.mobilizations is not None else 1.0
        ext_cost = round(float(payload.qty) * mobs * float(payload.unit_price), 2)

    return ext_cost, std_total, agg_total


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
    metric_set_id: int,
    section_code: Optional[str] = None,
    _user=Depends(get_current_user),
):
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
        WHERE l.metric_set_id = :metric_set_id
    """
    params = {"metric_set_id": metric_set_id}
    if section_code:
        sql += " AND l.section_code = :section_code"
        params["section_code"] = section_code
    sql += " ORDER BY l.sort_order, l.id"

    with engine.connect() as conn:
        rows = conn.execute(text(sql), params).mappings().all()
    return [dict(r) for r in rows]


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
    return dict(row)


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
    return dict(row)


@router.delete("/metric-lines/{line_id}")
def delete_metric_line(line_id: int, _user=Depends(get_current_user)):
    with engine.begin() as conn:
        result = conn.execute(text(
            "DELETE FROM quote_metric_lines WHERE id = :id"
        ), {"id": line_id})
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Line not found")
    return {"ok": True}
