"""
Crew work offers (C3). The office sends a work offer to a crew for a project;
the labor amount + scope auto-fill from the accepted estimate (no negotiation).
The crew accepts/declines in the Crew Portal (office can also record it). A
decline is reassigned by withdrawing and sending a new offer to another crew.
An accepted offer feeds the payment schedule (C1).

Office endpoints gated page.customers; the crew accept/decline is gated
page.customers OR page.crew_portal.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text, bindparam

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS, PAGE_CREW_PORTAL, PAGE_SCHEDULE
from app.crew.timeoff import (
    load_time_off as _load_time_off, serialize as _ser_time_off,
    off_on_day as _off_on_day, max_off_in_window as _max_off_in_window,
)

router = APIRouter(prefix="/api/offers", tags=["offers"])


def _require_office(user):
    if not has_capability(user, PAGE_CUSTOMERS):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _require_office_or_crew(user):
    if not (has_capability(user, PAGE_CUSTOMERS) or has_capability(user, PAGE_CREW_PORTAL)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _project_exists(conn, entity_id):
    return conn.execute(text("SELECT 1 FROM qbo_customers WHERE qbo_id=:id AND is_project=1"),
                        {"id": entity_id}).scalar() is not None


def _estimate_suggestions(conn, entity_id):
    """Labor = Accepted/Converted estimate 'Contract Labor' lines; scope = the
    estimate's customer memo (best-effort)."""
    # crew "your rate" = cost_amount (fallback to amount); amount is the
    # customer rate used for revenue. Crew-facing pages use the your rate.
    labor = conn.execute(text("""
        SELECT ROUND(COALESCE(SUM(COALESCE(sl.cost_amount, sl.amount)), 0), 2)
        FROM qbo_sales_transaction_lines sl JOIN qbo_transactions t ON t.id = sl.transaction_id
        WHERE t.entity_type = 'Estimate' AND sl.item_name LIKE 'Contract Labor%'
          AND sl.project_customer_qbo_id = :id
          AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted')
    """), {"id": entity_id}).scalar()
    scope = conn.execute(text("""
        SELECT JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.CustomerMemo.value'))
        FROM qbo_transactions t
        WHERE t.entity_type = 'Estimate' AND t.customer_qbo_id = :id
          AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted')
        ORDER BY t.txn_date DESC LIMIT 1
    """), {"id": entity_id}).scalar()
    return float(labor or 0), (scope or None)


def _crew_options(conn):
    """Crew Model v2 (CR3): offers list/target COMPANIES only — one option per
    parent crew, labeled with the boss/owner when known."""
    rows = conn.execute(text("""
        SELECT id, name, boss_name, code, crew_capacity
        FROM work_crews
        WHERE parent_id IS NULL AND (is_active = 1 OR is_active IS NULL)
        ORDER BY sort_order, name
    """)).mappings().all()
    return [{"id": r["id"], "name": r["name"], "boss_name": r["boss_name"],
             "prefix": r["code"], "crew_capacity": r["crew_capacity"],
             "parent_name": None, "is_company": True} for r in rows]


def _company_of(conn, crew_id):
    """The crew's company id: itself for a parent row, its parent for a lead."""
    if not crew_id:
        return None
    r = conn.execute(text("SELECT id, parent_id FROM work_crews WHERE id = :id"),
                     {"id": int(crew_id)}).mappings().first()
    if not r:
        return None
    return int(r["parent_id"]) if r["parent_id"] is not None else int(r["id"])


def _offer_rows(conn, where, params):
    """Offer rows labeled by COMPANY (CR3): new offers point at the parent crew
    id; legacy offers to child crews resolve via parent lookup. company_id is
    included so rollup matching can compare at the company level."""
    rows = conn.execute(text(f"""
        SELECT o.id, o.entity_id, o.crew_id, o.labor_amount, o.scope, o.status,
               o.sent_at, o.responded_at, o.response_note,
               COALESCE(pc.id, wc.id) AS company_id,
               TRIM(CONCAT(COALESCE(pc.name, wc.name, ''),
                    CASE WHEN COALESCE(pc.boss_name, wc.boss_name) IS NOT NULL
                         THEN CONCAT(' · ', COALESCE(pc.boss_name, wc.boss_name)) ELSE '' END)) AS crew_name
        FROM work_offers o
        LEFT JOIN work_crews wc ON wc.id = o.crew_id
        LEFT JOIN work_crews pc ON pc.id = wc.parent_id
        WHERE {where} ORDER BY o.created_at DESC, o.id DESC
    """), params).mappings().all()
    return [{
        "id": r["id"], "entity_id": r["entity_id"], "crew_id": r["crew_id"],
        "company_id": r["company_id"],
        "crew_name": (r["crew_name"] or "").strip() or None,
        "labor_amount": float(r["labor_amount"] or 0), "scope": r["scope"], "status": r["status"],
        "sent_at": str(r["sent_at"]) if r["sent_at"] else None,
        "responded_at": str(r["responded_at"]) if r["responded_at"] else None,
        "response_note": r["response_note"],
    } for r in rows]


@router.get("/project/{entity_id}")
def list_for_project(entity_id: str, user=Depends(get_current_user)):
    _require_office(user)
    with engine.connect() as conn:
        if not _project_exists(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        offers = _offer_rows(conn, "o.entity_id = :e", {"e": entity_id})
        labor, scope = _estimate_suggestions(conn, entity_id)
        crews = _crew_options(conn)
    accepted = next((o for o in offers if o["status"] == "accepted"), None)
    current = accepted or next((o for o in offers if o["status"] == "sent"), None)
    return {"offers": offers, "current": current, "accepted": accepted,
            "suggested_labor": labor, "suggested_scope": scope, "crews": crews}


def _load_crew_world(conn):
    """Shared by crew-roster + crew-availability: active companies, their
    active leads, live bookings (assignment rows, v2 company/lead/slot columns
    with the legacy work_crew_id derivation as fallback) and 0070 time-off,
    each grouped by company id."""
    from collections import defaultdict
    companies = conn.execute(text("""
        SELECT id, name, code, boss_name, crew_capacity, vendor_qbo_id
        FROM work_crews
        WHERE parent_id IS NULL AND (is_active = 1 OR is_active IS NULL)
        ORDER BY sort_order, name
    """)).mappings().all()
    leads = conn.execute(text("""
        SELECT id, name, code, parent_id
        FROM work_crews
        WHERE parent_id IS NOT NULL AND (is_active = 1 OR is_active IS NULL)
        ORDER BY sort_order, id
    """)).mappings().all()
    scheds = conn.execute(text("""
        SELECT COALESCE(swc.company_id, wc.parent_id, wc.id) AS company_id,
               swc.slot_code,
               COALESCE(ld.name, CASE WHEN wc.parent_id IS NOT NULL THEN wc.name END) AS lead_name,
               qc.qbo_id AS entity_id, qc.display_name AS project_name,
               psi.id AS schedule_item_id,
               psi.start_date, psi.end_date,
               COALESCE(psi.travel_days, 0) AS travel_days,
               DATE_ADD(psi.end_date, INTERVAL COALESCE(psi.overage_days, 0) DAY) AS true_end
        FROM project_schedule_item_work_crews swc
        JOIN project_schedule_items psi ON psi.id = swc.schedule_item_id
        JOIN projects p ON p.id = psi.project_id
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        JOIN work_crews wc ON wc.id = swc.work_crew_id
        LEFT JOIN work_crews ld ON ld.id = swc.lead_crew_id
        WHERE swc.unassigned_at IS NULL AND psi.start_date IS NOT NULL
          AND COALESCE(psi.status, '') <> 'canceled'
    """)).mappings().all()
    time_off = _load_time_off(conn)

    leads_by_co = defaultdict(list)
    for l in leads:
        leads_by_co[int(l["parent_id"])].append({"id": l["id"], "name": l["name"]})
    by_co = defaultdict(list)
    for s_ in scheds:
        if s_["company_id"] is not None:
            by_co[int(s_["company_id"])].append(s_)
    to_by_co = defaultdict(list)
    for t in time_off:
        to_by_co[int(t["company_id"])].append(t)
    return companies, leads_by_co, by_co, to_by_co


def _require_schedule_or_office(user):
    if not (has_capability(user, PAGE_CUSTOMERS) or has_capability(user, PAGE_SCHEDULE)):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


@router.get("/crew-availability")
def crew_availability(start: str, end: str, crews_needed: Optional[int] = None,
                      user=Depends(get_current_user)):
    """Schedules-page "Crew availability" search (estimators asking the office
    whether crews are free before a project exists). Per Crew Boss company and
    per day of start..end: capacity (crew_capacity override, else active-lead
    count — same as crew-roster), booked = distinct crew lines busy that day
    (assignment start - travel-before .. true end + travel-after, the same span
    the Schedule grid draws), off = crews out on 0070 time-off, free =
    max(0, capacity - booked - off). Summary: min_free (free on EVERY day —
    "crews available for the whole range") and min_free_weekdays (Mon-Fri
    only). Booking rule shares _load_crew_world with crew-roster."""
    _require_schedule_or_office(user)
    from datetime import date, timedelta

    try:
        ws = date.fromisoformat(str(start)[:10])
        we = date.fromisoformat(str(end)[:10])
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid dates (YYYY-MM-DD)")
    if we < ws:
        ws, we = we, ws
    if (we - ws).days > 186:
        raise HTTPException(status_code=400, detail="Pick a range of 6 months or less")
    days = [ws + timedelta(days=i) for i in range((we - ws).days + 1)]

    with engine.connect() as conn:
        companies, leads_by_co, by_co, to_by_co = _load_crew_world(conn)

    out = []
    for c in companies:
        cid = int(c["id"])
        capacity = int(c["crew_capacity"] if c["crew_capacity"] is not None
                       else len(leads_by_co.get(cid, [])))
        # booking spans (travel split like the grid: ceil before, floor after)
        spans = []
        for b in by_co.get(cid, []):
            b_end = b["true_end"] or b["end_date"]
            if not (b["start_date"] and b_end):
                continue
            tr = int(b["travel_days"] or 0)
            s_ = b["start_date"] - timedelta(days=(tr + 1) // 2)
            e_ = b_end + timedelta(days=tr // 2)
            if e_ < ws or s_ > we:
                continue
            key = b["slot_code"] or f"?{b['schedule_item_id']}?{b['lead_name'] or ''}"
            spans.append((s_, e_, key, b))
        to_rows = [t for t in to_by_co.get(cid, []) if t["end_date"] >= ws and t["start_date"] <= we]

        per_day = []
        for d in days:
            busy = {k for (s_, e_, k, _) in spans if s_ <= d <= e_}
            off = _off_on_day(to_rows, d, capacity)
            per_day.append({
                "date": d.isoformat(), "weekday": d.weekday(),
                "booked": len(busy), "off": off,
                "free": max(0, capacity - len(busy) - off),
            })
        frees = [x["free"] for x in per_day]
        wk = [x["free"] for x in per_day if x["weekday"] < 5]
        bookings, seen = [], set()
        for (s_, e_, k, b) in sorted(spans, key=lambda x: (x[2], x[0])):
            sig = (k, str(b["entity_id"]))
            if sig in seen:
                continue
            seen.add(sig)
            bookings.append({
                "slot": b["slot_code"], "lead": b["lead_name"],
                "project": b["project_name"], "entity_id": str(b["entity_id"]),
                "from": str(s_), "thru": str(e_),
            })
        min_free = min(frees) if frees else 0
        min_wk = min(wk) if wk else min_free
        out.append({
            "id": cid, "name": c["name"], "code": c["code"], "boss_name": c["boss_name"],
            "capacity": capacity,
            "days": per_day,
            "min_free": min_free,
            "min_free_weekdays": min_wk,
            "max_free": max(frees) if frees else 0,
            "meets_need": (min_wk >= int(crews_needed)) if crews_needed else None,
            "bookings": bookings,
            "time_off": [_ser_time_off(t) for t in to_rows],
        })
    return {"start": ws.isoformat(), "end": we.isoformat(),
            "crews_needed": crews_needed, "companies": out}


@router.get("/crew-roster")
def crew_roster(project_qbo_id: Optional[str] = None, start: Optional[str] = None,
                end: Optional[str] = None, user=Depends(get_current_user)):
    """Crew Model v2 (CR3) browse-crews panel: ONE CARD PER COMPANY —
    "MTY · Jesse Rosales Jr. · X of Y crews available". Y = crew_capacity
    (fallback: active-lead count); X = Y minus the slots occupied by that
    company's assignments overlapping the project's window (true end = end +
    overage days; the project's own assignments don't count against it).
    Each card carries the occupied-slot list ("JR1 · Gustavo Ramirez — 6304
    DHL thru 10/09"; lead-less slots show "lead TBD"), the company's active
    leads (for the optional lead pick on assign), $ paid last 365d and jobs
    done last 365d."""
    _require_office(user)
    from datetime import date, timedelta
    from collections import defaultdict
    cutoff = date.today() - timedelta(days=365)

    def _d(s):
        try:
            return date.fromisoformat(str(s)[:10]) if s else None
        except ValueError:
            return None
    ps, pe = _d(start), _d(end)

    with engine.connect() as conn:
        companies, leads_by_co, by_co, to_by_co = _load_crew_world(conn)
        earned = {str(r["v"]): float(r["amt"] or 0) for r in conn.execute(text("""
            SELECT vendor_qbo_id AS v, ROUND(SUM(total_amt), 2) AS amt FROM qbo_transactions
            WHERE entity_type = 'Bill' AND txn_date >= :c AND vendor_qbo_id IS NOT NULL
            GROUP BY vendor_qbo_id
        """), {"c": cutoff}).mappings().all()}

    today = date.today()
    out = []
    for c in companies:
        cid = int(c["id"])
        bookings = by_co.get(cid, [])
        jobs_365 = len({b["entity_id"] for b in bookings if b["end_date"] and b["end_date"] >= cutoff})
        # Window for occupancy: the project's dates when given, else today onward.
        ws, we = (ps, pe) if (ps and pe) else (today, None)
        occupied_rows, occupied_slots = [], set()
        for b in bookings:
            if project_qbo_id and str(b["entity_id"]) == str(project_qbo_id):
                continue  # this project's own slots aren't "unavailable" to it
            b_end = b["true_end"] or b["end_date"]
            if not (b["start_date"] and b_end):
                continue
            if we is not None and b["start_date"] > we:
                continue
            if b_end < ws:
                continue
            slot_key = b["slot_code"] or f"?{b['entity_id']}?{b['lead_name'] or ''}"
            if slot_key in occupied_slots:
                continue
            occupied_slots.add(slot_key)
            occupied_rows.append({
                "slot": b["slot_code"], "lead": b["lead_name"],
                "project": b["project_name"], "entity_id": str(b["entity_id"]),
                "thru": str(b_end),
            })
        occupied_rows.sort(key=lambda x: (x["slot"] or "~", x["thru"]))
        capacity = c["crew_capacity"] if c["crew_capacity"] is not None else len(leads_by_co.get(cid, []))

        # 0063/0070 time-off overlapping the same occupancy window [ws, we]
        # (we None = open-ended, today onward). AVAILABILITY RULE (count
        # model): the company loses the PEAK number of crews out on any one
        # day of the window (a NULL-count row = all its crews), floored at 0.
        to_rows = [t for t in to_by_co.get(cid, [])
                   if t["end_date"] >= ws and (we is None or t["start_date"] <= we)]
        time_off_rows = [_ser_time_off(t) for t in to_rows]
        off_n = _max_off_in_window(to_rows, ws, we, capacity)
        company_off = bool(to_rows) and int(capacity) > 0 and off_n >= int(capacity)

        available = None
        if ps and pe:
            available = max(0, int(capacity) - len(occupied_rows) - off_n)
        out.append({
            "id": c["id"], "name": c["name"], "boss_name": c["boss_name"],
            "prefix": c["code"], "capacity": int(capacity),
            "available": available,
            "occupied": occupied_rows,
            "time_off": time_off_rows,
            "crews_off": off_n,
            "company_off": company_off,
            "leads": leads_by_co.get(cid, []),
            "earned_365": round(earned.get(str(c["vendor_qbo_id"]), 0), 2),
            "jobs_365": jobs_365,
        })
    return {"companies": out, "has_dates": bool(ps and pe)}


class OfferCreate(BaseModel):
    crew_id: int
    labor_amount: float
    scope: Optional[str] = None


@router.post("/project/{entity_id}")
def send_offer(entity_id: str, body: OfferCreate, user=Depends(get_current_user)):
    _require_office(user)
    with engine.begin() as conn:
        if not _project_exists(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        # CR3: offers target COMPANIES — a child-crew id is resolved to its
        # parent so the offer row always points at the company.
        company_id = _company_of(conn, body.crew_id)
        if not company_id:
            raise HTTPException(status_code=400, detail="Unknown crew")
        res = conn.execute(text("""
            INSERT INTO work_offers (entity_id, crew_id, labor_amount, scope, status, sent_at, created_by_user_id)
            VALUES (:e,:c,:amt,:sc,'sent',NOW(),:u)
        """), {"e": entity_id, "c": company_id, "amt": body.labor_amount,
               "sc": (body.scope or None), "u": user.get("id")})
    return {"ok": True, "id": res.lastrowid}


@router.post("/project/{entity_id}/backfill")
def backfill_accepted(entity_id: str, user=Depends(get_current_user)):
    """Record an accepted offer for a project that was already underway before the
    app existed (offer lived in Google Drive). Uses the crew already assigned on
    the payment schedule and the estimate's labor amount — so the app's offer
    tracker reflects the historical acceptance without re-sending anything."""
    _require_office(user)
    with engine.begin() as conn:
        if not _project_exists(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        existing = conn.execute(text("SELECT COUNT(*) FROM work_offers WHERE entity_id=:e"),
                                {"e": entity_id}).scalar()
        if existing:
            raise HTTPException(status_code=400, detail="This project already has offer records.")
        crew_id = conn.execute(text(
            """SELECT crew_id FROM project_payment_schedules
               WHERE entity_id=:e AND crew_id IS NOT NULL ORDER BY id LIMIT 1"""),
            {"e": entity_id}).scalar()
        if not crew_id:
            raise HTTPException(status_code=400,
                                detail="Assign a crew on the Assignment page first, then record.")
        crew_id = _company_of(conn, crew_id) or crew_id   # CR3: record at the company
        labor, scope = _estimate_suggestions(conn, entity_id)
        res = conn.execute(text("""
            INSERT INTO work_offers
              (entity_id, crew_id, labor_amount, scope, status, sent_at, responded_at,
               response_note, created_by_user_id, responded_by_user_id)
            VALUES (:e,:c,:amt,:sc,'accepted',NOW(),NOW(),
               'Backfilled — offer accepted before the app (recorded from QuickBooks)',:u,:u)
        """), {"e": entity_id, "c": crew_id, "amt": labor, "sc": (scope or None), "u": user.get("id")})
    return {"ok": True, "id": res.lastrowid}


def _auto_assign_accepted_offer(offer_id: int, actor_user_id: int):
    """Assignment-workflow glue (Jason item #4, 2026-10-06): the moment an offer
    is confirmed accepted, the company lands on the project schedule — unless it
    is already there. Rules:

      * company already assigned anywhere on the project (active swc row on any
        schedule item) → do nothing (no dupes);
      * exactly one ACTIVE schedule item (status not canceled/completed) →
        attach there; several → the earliest-dated active item (undated lines
        sort last); none → create one undated line via the normal create path
        (status 'needs_attention', the service's initial default);
      * lead_crew_id = the billing header's chosen lead for this project when it
        belongs to the offer's company (offers point at COMPANIES per CR3, so
        the offer itself carries no lead), else NULL ("lead TBD");
      * the write goes through projects.service.save_schedule_item — the SAME
        path as a manual assignment save — so the v2+legacy dual-write, the
        slot auto-suggest, project_events and the CR1 item history ("created/
        updated by <user>") all happen exactly as a hand edit would.

    Returns {"assigned": bool, "schedule_item_id": int|None}.
    """
    from app.projects.routes import ScheduleItemSaveRequest, CrewAssignmentEntry
    from app.projects.service import save_schedule_item

    with engine.connect() as conn:
        o = conn.execute(text("SELECT entity_id, crew_id FROM work_offers WHERE id=:id"),
                         {"id": offer_id}).mappings().first()
        if not o:
            return {"assigned": False, "schedule_item_id": None}
        entity_id = o["entity_id"]
        company_id = _company_of(conn, o["crew_id"])
        if not company_id:
            return {"assigned": False, "schedule_item_id": None}
        qc_id = conn.execute(text(
            "SELECT id FROM qbo_customers WHERE qbo_id=:e AND is_project=1"),
            {"e": entity_id}).scalar()
        if not qc_id:
            return {"assigned": False, "schedule_item_id": None}

        items = conn.execute(text("""
            SELECT psi.id, psi.status, psi.start_date, psi.end_date, psi.wire_guidance,
                   psi.travel_days, psi.overage_days, psi.equipment_type, psi.notes,
                   psi.sort_order
            FROM project_schedule_items psi
            JOIN projects p ON p.id = psi.project_id
            WHERE p.qbo_customer_id = :qc
            ORDER BY psi.sort_order, psi.id
        """), {"qc": int(qc_id)}).mappings().all()

        crew_rows = []
        if items:
            crew_rows = conn.execute(text("""
                SELECT swc.schedule_item_id, swc.work_crew_id, swc.is_primary, swc.slot_code,
                       COALESCE(swc.company_id, wc.parent_id, wc.id) AS company_id,
                       COALESCE(swc.lead_crew_id,
                                CASE WHEN swc.company_id IS NULL AND wc.parent_id IS NOT NULL
                                     THEN wc.id END) AS lead_crew_id
                FROM project_schedule_item_work_crews swc
                JOIN work_crews wc ON wc.id = swc.work_crew_id
                WHERE swc.unassigned_at IS NULL AND swc.schedule_item_id IN :ids
            """).bindparams(bindparam("ids", expanding=True)),
                {"ids": [int(i["id"]) for i in items]}).mappings().all()

        # No dupes: the company already assigned anywhere on the project → done.
        for r in crew_rows:
            if r["company_id"] is not None and int(r["company_id"]) == int(company_id):
                return {"assigned": False, "schedule_item_id": int(r["schedule_item_id"])}

        # Lead: the billing header's chosen crew, when it's a lead of this company.
        lead_id = None
        for h in conn.execute(text("""
            SELECT peb.crew_id, wc.parent_id
            FROM project_estimate_billing peb JOIN work_crews wc ON wc.id = peb.crew_id
            WHERE peb.entity_id = :e AND peb.crew_id IS NOT NULL ORDER BY peb.id
        """), {"e": entity_id}).mappings().all():
            if h["parent_id"] is not None and int(h["parent_id"]) == int(company_id):
                lead_id = int(h["crew_id"])
                break

        active = [i for i in items if (i["status"] or "") not in ("canceled", "completed")]
        target = None
        if active:
            # one active item → it; several → the earliest-dated (undated last)
            target = sorted(active, key=lambda i: (i["start_date"] is None, i["start_date"],
                                                   i["sort_order"] or 0, int(i["id"])))[0]

        new_entry = {"company_id": int(company_id), "lead_crew_id": lead_id,
                     "slot_code": None, "is_primary": False}

        if target is not None:
            sid = int(target["id"])
            pm_rows = conn.execute(text("""
                SELECT project_manager_id, is_primary
                FROM project_schedule_item_project_managers
                WHERE schedule_item_id = :sid AND unassigned_at IS NULL
            """), {"sid": sid}).mappings().all()
            existing = [r for r in crew_rows if int(r["schedule_item_id"]) == sid]
            entries = [CrewAssignmentEntry(
                company_id=int(r["company_id"]),
                lead_crew_id=(int(r["lead_crew_id"]) if r["lead_crew_id"] is not None else None),
                slot_code=r["slot_code"], is_primary=bool(r["is_primary"]),
            ) for r in existing if r["company_id"] is not None]
            new_entry["is_primary"] = not entries  # sole crew on the line → primary
            entries.append(CrewAssignmentEntry(**new_entry))
            req = ScheduleItemSaveRequest(
                schedule_item_id=sid,
                qbo_customer_id=int(qc_id),
                status=(target["status"] or "needs_attention"),
                start_date=(str(target["start_date"]) if target["start_date"] else None),
                end_date=(str(target["end_date"]) if target["end_date"] else None),
                wire_guidance=int(target["wire_guidance"] or 0),
                travel_days=int(target["travel_days"] or 0),
                overage_days=int(target["overage_days"] or 0),
                equipment_type=target["equipment_type"],
                notes=target["notes"],
                project_manager_ids=[int(r["project_manager_id"]) for r in pm_rows],
                primary_project_manager_id=next(
                    (int(r["project_manager_id"]) for r in pm_rows if r["is_primary"]), None),
                crew_assignments=entries,
            )
        else:
            # no active schedule line at all → create one undated line, crew attached
            new_entry["is_primary"] = True
            req = ScheduleItemSaveRequest(
                qbo_customer_id=int(qc_id),
                status="needs_attention",
                crew_assignments=[CrewAssignmentEntry(**new_entry)],
            )

    # save_schedule_item opens its own transaction — call it outside the read conn
    res = save_schedule_item(req=req, actor_user_id=actor_user_id)
    return {"assigned": True, "schedule_item_id": res.get("schedule_item_id")}


class OfferResponse(BaseModel):
    status: str          # accepted | declined
    note: Optional[str] = None


@router.post("/{offer_id}/respond")
def respond(offer_id: int, body: OfferResponse, user=Depends(get_current_user)):
    _require_office_or_crew(user)
    if body.status not in ("accepted", "declined"):
        raise HTTPException(status_code=400, detail="status must be accepted or declined")
    with engine.begin() as conn:
        o = conn.execute(text("SELECT entity_id, status FROM work_offers WHERE id=:id"),
                         {"id": offer_id}).mappings().first()
        if not o:
            raise HTTPException(status_code=404, detail="Offer not found")
        if o["status"] not in ("sent",):
            raise HTTPException(status_code=400, detail="Only a sent offer can be responded to")
        conn.execute(text("""UPDATE work_offers SET status=:s, responded_at=NOW(),
                             responded_by_user_id=:u, response_note=:n WHERE id=:id"""),
                     {"s": body.status, "u": user.get("id"), "n": (body.note or None), "id": offer_id})
        if body.status == "accepted":
            # only one accepted crew per project — withdraw other outstanding offers
            conn.execute(text("""UPDATE work_offers SET status='withdrawn'
                                 WHERE entity_id=:e AND id<>:id AND status='sent'"""),
                         {"e": o["entity_id"], "id": offer_id})
    out = {"ok": True}
    if body.status == "accepted":
        # Glue (#4): the accepted company goes on the project schedule unless it's
        # already there. The accept above is committed; a glue failure must not
        # un-accept the offer, so it degrades to assigned=false with the reason.
        try:
            out.update(_auto_assign_accepted_offer(offer_id, int(user.get("id"))))
        except Exception as exc:  # noqa: BLE001 — surfaced to the UI, accept stands
            out.update({"assigned": False, "schedule_item_id": None,
                        "assign_error": str(exc)})
    return out


@router.post("/{offer_id}/withdraw")
def withdraw(offer_id: int, user=Depends(get_current_user)):
    _require_office(user)
    with engine.begin() as conn:
        n = conn.execute(text("""UPDATE work_offers SET status='withdrawn'
                                 WHERE id=:id AND status='sent'"""), {"id": offer_id}).rowcount
    if not n:
        raise HTTPException(status_code=404, detail="No sent offer to withdraw")
    return {"ok": True}


@router.get("/crew/{crew_id}")
def list_for_crew(crew_id: int, user=Depends(get_current_user)):
    """Offers for a crew (Crew Portal). Includes the project name for context."""
    _require_office_or_crew(user)
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT o.id, o.entity_id, o.labor_amount, o.scope, o.status, o.sent_at,
                   qc.display_name AS project_name
            FROM work_offers o LEFT JOIN qbo_customers qc ON qc.qbo_id = o.entity_id
            WHERE o.crew_id = :c ORDER BY o.created_at DESC, o.id DESC
        """), {"c": crew_id}).mappings().all()
    return {"offers": [{
        "id": r["id"], "entity_id": r["entity_id"], "project_name": r["project_name"],
        "labor_amount": float(r["labor_amount"] or 0), "scope": r["scope"],
        "status": r["status"], "sent_at": str(r["sent_at"]) if r["sent_at"] else None,
    } for r in rows]}
