"""Per-estimate reference snapshots (#2 from OPI pipeline feedback).

An estimate is a frozen copy of the quoting workbook: the lookup values and
productivity/rental rates it prices from are captured ONCE (at Start quote) and
stored on the estimate row (estimates.reference_snapshot, migration 0049).
Revisions inherit the parent's snapshot via _clone_estimate, so a 10/6 revision
prices exactly like the 9/5 send. Live tables are only consulted when an
estimate has no snapshot yet (legacy rows — lazily frozen on first read) or when
the estimator explicitly clicks "Update to current rates" (refresh_snapshot in
estimates/routes.py, which re-freezes and recomputes the line totals).

Snapshot JSON shape (raw table rows, reshaped by the serving endpoints):
  { "captured_at": "...", "lookup_values": [...],
    "productivity_rates": [...], "rental_rates": [...] }
"""
import json
from typing import Optional

from sqlalchemy import text


def _f(v):
    return float(v) if v is not None else None


def build_reference_snapshot(conn) -> dict:
    """Copy the three live reference tables into a snapshot dict."""
    lookups = conn.execute(text("""
        SELECT id, category, lookup_key, value_num, value_text, sort_order
        FROM lookup_values ORDER BY category, sort_order, lookup_key
    """)).mappings().all()
    prod = conn.execute(text("""
        SELECT id, category, item_name, standard_per_day, aggressive_multiplier,
               aggressive_per_day, unit, sort_order
        FROM productivity_rates ORDER BY category, sort_order, item_name
    """)).mappings().all()
    rentals = conn.execute(text("""
        SELECT id, equipment_type, power_source, size_class, duration,
               CAST(price AS DECIMAL(10,2)) AS price
        FROM rental_rates
        ORDER BY equipment_type, power_source, size_class,
                 FIELD(duration, 'day', 'week', 'month')
    """)).mappings().all()
    captured_at = conn.execute(text("SELECT NOW()")).scalar()
    return {
        "captured_at": str(captured_at),
        "lookup_values": [
            {"id": r["id"], "category": r["category"], "lookup_key": r["lookup_key"],
             "value_num": _f(r["value_num"]), "value_text": r["value_text"],
             "sort_order": r["sort_order"]} for r in lookups],
        "productivity_rates": [
            {"id": r["id"], "category": r["category"], "item_name": r["item_name"],
             "standard_per_day": r["standard_per_day"],
             "aggressive_multiplier": _f(r["aggressive_multiplier"]),
             "aggressive_per_day": r["aggressive_per_day"], "unit": r["unit"],
             "sort_order": r["sort_order"]} for r in prod],
        "rental_rates": [
            {"id": r["id"], "equipment_type": r["equipment_type"],
             "power_source": r["power_source"], "size_class": r["size_class"],
             "duration": r["duration"], "price": _f(r["price"])} for r in rentals],
    }


def store_reference_snapshot(conn, estimate_id: int, snap: Optional[dict] = None) -> dict:
    """Build (unless given) and persist the snapshot for an estimate."""
    snap = snap or build_reference_snapshot(conn)
    conn.execute(text("""
        UPDATE estimates SET reference_snapshot=:s, snapshot_at=NOW() WHERE id=:id
    """), {"s": json.dumps(snap), "id": estimate_id})
    return snap


def get_reference_snapshot(conn, estimate_id: Optional[int]) -> Optional[dict]:
    """The estimate's frozen reference data. Legacy estimates without one are
    frozen NOW at current live values (they have been silently pricing live
    anyway, so today's values are exactly what their screens show)."""
    if not estimate_id:
        return None
    row = conn.execute(text("SELECT id, reference_snapshot FROM estimates WHERE id=:id"),
                       {"id": estimate_id}).mappings().first()
    if not row:
        return None
    if row["reference_snapshot"]:
        try:
            snap = row["reference_snapshot"]
            return json.loads(snap) if isinstance(snap, str) else snap
        except Exception:
            return None
    return store_reference_snapshot(conn, estimate_id)


def snapshot_maps(snap: Optional[dict]):
    """(productivity_by_id, rental_by_id) for quick line-level resolution."""
    if not snap:
        return {}, {}
    return ({r["id"]: r for r in snap.get("productivity_rates", [])},
            {r["id"]: r for r in snap.get("rental_rates", [])})


def estimate_id_for_set(conn, metric_set_id: Optional[int]) -> Optional[int]:
    if not metric_set_id:
        return None
    return conn.execute(text("SELECT estimate_id FROM quote_metric_sets WHERE id=:id"),
                        {"id": metric_set_id}).scalar()


def diff_snapshot_vs_live(conn, snap: Optional[dict]) -> list:
    """Human-readable changes between an estimate's snapshot and today's live
    tables — powers the 'Update to current rates' confirmation dialog."""
    if not snap:
        return []
    live = build_reference_snapshot(conn)
    out = []

    def key_of(kind, r):
        if kind == "lookup":
            return f"{r['category']} / {r['lookup_key']}"
        if kind == "rate":
            return f"{r['category']} / {r['item_name']}"
        return " / ".join(str(v) for v in (r["equipment_type"], r["power_source"],
                                           r["size_class"], r["duration"]) if v)

    def compare(kind, old_rows, new_rows, fields):
        old_by, new_by = {r["id"]: r for r in old_rows}, {r["id"]: r for r in new_rows}
        for rid, o in old_by.items():
            n = new_by.get(rid)
            if not n:
                out.append({"kind": kind, "item": key_of(kind, o), "change": "removed"})
                continue
            for f in fields:
                ov, nv = o.get(f), n.get(f)
                try:
                    if ov is not None and nv is not None and float(ov) == float(nv):
                        continue
                except (TypeError, ValueError):
                    pass
                if ov != nv:
                    out.append({"kind": kind, "item": key_of(kind, n), "field": f,
                                "old": ov, "new": nv})
        for rid, n in new_by.items():
            if rid not in old_by:
                out.append({"kind": kind, "item": key_of(kind, n), "change": "added"})

    compare("lookup", snap.get("lookup_values", []), live["lookup_values"],
            ["value_num", "value_text"])
    compare("rate", snap.get("productivity_rates", []), live["productivity_rates"],
            ["standard_per_day", "aggressive_multiplier", "aggressive_per_day"])
    compare("rental", snap.get("rental_rates", []), live["rental_rates"], ["price"])
    return out
