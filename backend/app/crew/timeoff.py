"""
Crew time-off helpers (0063 + 0070 count model) — the ONE place that reads
crew_time_off and turns it into "how many of a Crew Boss's crews are out".

Row meaning (0070): company_id has crew_count crews unavailable on every day
of start_date..end_date (inclusive). crew_count NULL = ALL the company's
crews. lead_ids = OPTIONAL list of specific lead work_crews ids that are out
(informational + lets the Schedule page grey that lead's line).

Consumers: /api/crew-time-off CRUD (main.py), /api/schedule (grey lines),
/assignment/bundle (non-blocking editor warnings), /api/offers/crew-roster
and /api/offers/crew-availability (free-crew counts).
"""
import json
from datetime import date, timedelta

from sqlalchemy import text


def _parse_ids(v):
    if v is None:
        return []
    if isinstance(v, (bytes, bytearray)):
        v = v.decode("utf-8")
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return []
    if not isinstance(v, (list, tuple)):
        return []
    out = []
    for x in v:
        try:
            out.append(int(x))
        except (TypeError, ValueError):
            pass
    return out


def load_time_off(conn, where="1=1", params=None):
    """Normalized time-off rows (dates as date objects). `where` may reference
    cto.* / co.* (co = the company work_crews row)."""
    rows = conn.execute(text(f"""
        SELECT cto.id, COALESCE(cto.company_id, cto.crew_id) AS company_id,
               cto.crew_count, cto.lead_ids, cto.start_date, cto.end_date,
               cto.reason, cto.created_at, cto.updated_at,
               co.name AS company_name, co.code AS company_code,
               TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS added_by_name,
               u.email AS added_by_email
        FROM crew_time_off cto
        JOIN work_crews co ON co.id = COALESCE(cto.company_id, cto.crew_id)
        LEFT JOIN users u ON u.id = cto.created_by_user_id
        WHERE {where}
        ORDER BY cto.start_date, cto.id
    """), params or {}).mappings().all()
    all_lead_ids = set()
    parsed = []
    for r in rows:
        ids = _parse_ids(r["lead_ids"])
        all_lead_ids.update(ids)
        parsed.append((r, ids))
    leads = {}
    if all_lead_ids:
        ph = ",".join(str(int(i)) for i in sorted(all_lead_ids))
        for l in conn.execute(text(
                f"SELECT id, name, code FROM work_crews WHERE id IN ({ph})")).mappings().all():
            leads[int(l["id"])] = {"id": int(l["id"]), "name": l["name"], "code": l["code"]}
    out = []
    for r, ids in parsed:
        out.append({
            "id": int(r["id"]),
            "company_id": int(r["company_id"]),
            "company_name": r["company_name"],
            "company_code": r["company_code"],
            "crew_count": int(r["crew_count"]) if r["crew_count"] is not None else None,
            "leads": [leads[i] for i in ids if i in leads],
            "start_date": r["start_date"], "end_date": r["end_date"],
            "reason": r["reason"],
            "added_by": (r["added_by_name"] or "").strip() or r["added_by_email"],
            "created_at": r["created_at"], "updated_at": r["updated_at"],
        })
    return out


def count_label(t):
    """'All crews' / '2 crews' / '1 crew (Ruben Chavez)'."""
    if t["crew_count"] is None:
        base = "All crews"
    else:
        n = int(t["crew_count"])
        base = f"{n} crew{'' if n == 1 else 's'}"
    names = ", ".join(l["name"] for l in t.get("leads") or [])
    return f"{base} ({names})" if names else base


def serialize(t):
    """JSON shape shared by every endpoint. Keeps the 0063 compat fields
    (crew_id / level / name / crew_name) so older callers keep rendering:
    level 'company' = whole company off, 'lead' = exactly one named lead,
    'count' = N crews."""
    leads = t.get("leads") or []
    if t["crew_count"] is None:
        level, crew_id, name = "company", t["company_id"], t["company_name"]
    elif t["crew_count"] == 1 and len(leads) == 1:
        level, crew_id, name = "lead", leads[0]["id"], leads[0]["name"]
    else:
        level, crew_id, name = "count", t["company_id"], count_label(t)
    return {
        "id": t["id"],
        "company_id": t["company_id"],
        "company_name": t["company_name"],
        "company_code": t["company_code"],
        "crew_count": t["crew_count"],
        "lead_ids": [l["id"] for l in leads],
        "leads": leads,
        "count_label": count_label(t),
        "start_date": str(t["start_date"]), "end_date": str(t["end_date"]),
        "reason": t["reason"],
        "added_by": t.get("added_by"),
        "created_at": str(t["created_at"]) if t.get("created_at") else None,
        "updated_at": str(t["updated_at"]) if t.get("updated_at") else None,
        # 0063 compat
        "crew_id": crew_id, "level": level, "name": name, "crew_name": name,
    }


def off_count(t, capacity):
    """Crews this row takes out of `capacity` (NULL count = all)."""
    cap = max(0, int(capacity or 0))
    if t["crew_count"] is None:
        return cap
    return max(0, min(int(t["crew_count"]), cap))


def off_on_day(rows, d, capacity):
    """Crews out on day d for one company's rows (summed, capped)."""
    cap = max(0, int(capacity or 0))
    n = sum(off_count(t, cap) for t in rows if t["start_date"] <= d <= t["end_date"])
    return min(n, cap)


def max_off_in_window(rows, ws, we, capacity):
    """Peak crews-out on any single day of [ws, we] (we None = open-ended,
    ws onward). 0 when nothing overlaps."""
    hits = [t for t in rows if t["end_date"] >= ws and (we is None or t["start_date"] <= we)]
    if not hits:
        return 0
    lo = max(ws, min(t["start_date"] for t in hits))
    hi = max(t["end_date"] for t in hits)
    if we is not None:
        hi = min(hi, we)
    best, d = 0, lo
    while d <= hi:
        best = max(best, off_on_day(hits, d, capacity))
        d += timedelta(days=1)
    return best
