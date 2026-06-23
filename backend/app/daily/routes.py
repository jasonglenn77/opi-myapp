"""
Daily project requirements checklist (Phase 4).

A per-project, per-day checklist the PM and crew foreman both complete on active
projects (14 items in 9 groups, some crew-sourced). One shared log surfaced in
two places: the project detail page's "Daily Log" tab (PM, gated page.customers)
and the Crew Foreman portal (foreman, gated page.crew_portal).

The reminder cadence (10 AM / 12 PM / 7 PM texts) is the Phase 5 layer on top.
Template lives here in code; per-day status lives in project_daily_log.
"""
import re
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import text

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS, PAGE_CREW_PORTAL

router = APIRouter(prefix="/api/daily", tags=["daily"])

# (group, [(label, crew_sourced)]) — crew_sourced items originate with the crew.
_DAILY_GROUPS = [
    ("Daily Check-In", [
        ("Video call made", False),
        ("House-keeping checked", False),
    ]),
    ("PPE", [
        ("On Point vests & hard hats worn", False),
        ("Double lanyard with double anchor points on harnesses", False),
    ]),
    ("Daily Planning", [
        ("Plan for the day & progress expectations confirmed", False),
        ("At least 2 days of materials confirmed", False),
    ]),
    ("Rentals", [
        ("Rental equipment sufficient", False),
    ]),
    ("Anchors", [
        ("Proper anchoring practices / tools confirmed", False),
    ]),
    ("Safety", [
        ("Daily safety checklist completed", True),
    ]),
    ("Visual Inspection", [
        ("Crew checking received materials for damage (with photos)", False),
    ]),
    ("BOLs", [
        ("BOL: printed name, truck #, time of day, noted damage", False),
    ]),
    ("Daily Update", [
        ("Progress photos uploaded to Drive", True),
        ("Progression drawing updated", True),
        ("Progress email sent", False),
    ]),
]


def _slug(s: str) -> str:
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9]+", "_", s.lower())).strip("_")


def _build_groups():
    used, groups = set(), []
    for title, items in _DAILY_GROUPS:
        g_slug = _slug(title)
        built = []
        for label, crew in items:
            base = f"{g_slug}__{_slug(label)}"
            key, i = base, 2
            while key in used:
                key, i = f"{base}_{i}", i + 1
            used.add(key)
            built.append({"key": key, "label": label, "crew_sourced": crew})
        groups.append({"title": title, "items": built})
    return groups


GROUPS = _build_groups()
ALL_KEYS = {it["key"] for g in GROUPS for it in g["items"]}
ITEM_COUNT = len(ALL_KEYS)


def _require(user):
    if not (has_capability(user, PAGE_CUSTOMERS) or has_capability(user, PAGE_CREW_PORTAL)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _project_name(conn, entity_id):
    cust = conn.execute(text("SELECT display_name, parent_qbo_id FROM qbo_customers WHERE qbo_id=:id"),
                        {"id": entity_id}).mappings().first()
    if not cust:
        return None
    root, pq, guard = cust["display_name"], cust["parent_qbo_id"], 0
    while pq and guard < 10:
        p = conn.execute(text("SELECT display_name, parent_qbo_id FROM qbo_customers WHERE qbo_id=:id"),
                         {"id": pq}).mappings().first()
        if not p:
            break
        root, pq, guard = p["display_name"], p["parent_qbo_id"], guard + 1
    return {"name": cust["display_name"], "customer_name": root}


def _valid_date(s: Optional[str]) -> str:
    if not s:
        raise HTTPException(status_code=400, detail="date required")
    try:
        return date.fromisoformat(str(s)[:10]).isoformat()
    except ValueError:
        raise HTTPException(status_code=400, detail="bad date")


@router.get("/project/{entity_id}")
def get_daily(entity_id: str, date: str = Query(...), user=Depends(get_current_user)):
    """Checklist template + status for one day, plus recent-day history."""
    _require(user)
    d = _valid_date(date)
    with engine.connect() as conn:
        meta = _project_name(conn, entity_id)
        if not meta:
            raise HTTPException(status_code=404, detail="Project not found")
        rows = conn.execute(text("""
            SELECT l.item_key, l.done, l.note, l.updated_at,
                   TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))) AS done_by
            FROM project_daily_log l LEFT JOIN users u ON u.id = l.updated_by_user_id
            WHERE l.entity_id=:e AND l.log_date=:d
        """), {"e": entity_id, "d": d}).mappings().all()
        st = {r["item_key"]: r for r in rows}
        # recent days with any activity (for the history strip)
        hist = conn.execute(text("""
            SELECT log_date, SUM(done) AS done_count, COUNT(*) AS touched
            FROM project_daily_log WHERE entity_id=:e
            GROUP BY log_date ORDER BY log_date DESC LIMIT 14
        """), {"e": entity_id}).mappings().all()

    groups = []
    for g in GROUPS:
        items = []
        for it in g["items"]:
            s = st.get(it["key"])
            items.append({
                "key": it["key"], "label": it["label"], "crew_sourced": it["crew_sourced"],
                "done": bool(s["done"]) if s else False,
                "note": (s["note"] if s else None),
                "done_by": (s["done_by"].strip() if s and s["done_by"] else None) if s else None,
                "done_at": str(s["updated_at"]) if s and s["updated_at"] else None,
            })
        groups.append({"title": g["title"], "items": items})

    history = [{"date": str(h["log_date"]), "done": int(h["done_count"] or 0), "touched": int(h["touched"] or 0)} for h in hist]
    return {"entity": {"type": "project", "id": entity_id, **meta},
            "date": d, "item_count": ITEM_COUNT, "groups": groups, "history": history}


class DailyItemUpdate(BaseModel):
    log_date: str
    item_key: str
    done: Optional[bool] = None
    note: Optional[str] = None


@router.post("/project/{entity_id}/item")
def update_daily_item(entity_id: str, body: DailyItemUpdate, user=Depends(get_current_user)):
    _require(user)
    if body.item_key not in ALL_KEYS:
        raise HTTPException(status_code=400, detail="Unknown item")
    d = _valid_date(body.log_date)
    uid = user.get("id")
    with engine.begin() as conn:
        if not _project_name(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        existing = conn.execute(text("""SELECT id, done, note FROM project_daily_log
                                        WHERE entity_id=:e AND log_date=:d AND item_key=:k"""),
                                {"e": entity_id, "d": d, "k": body.item_key}).mappings().first()
        done = (1 if body.done else 0) if body.done is not None else (existing["done"] if existing else 0)
        note = body.note if body.note is not None else (existing["note"] if existing else None)
        conn.execute(text("""
            INSERT INTO project_daily_log (entity_id, log_date, item_key, done, note, updated_by_user_id)
            VALUES (:e,:d,:k,:done,:note,:u)
            ON DUPLICATE KEY UPDATE done=VALUES(done), note=VALUES(note), updated_by_user_id=VALUES(updated_by_user_id)
        """), {"e": entity_id, "d": d, "k": body.item_key, "done": done, "note": note, "u": uid})
    return {"ok": True}
