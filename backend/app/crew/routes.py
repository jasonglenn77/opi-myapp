"""
Crew Portal API — the crew hierarchy (parent company → child crews → projects),
scoped to the caller:
  * admin/office (project.view_all) -> all parent crews
  * a crew_lead linked to a PARENT crew -> that parent + its children
  * a crew_foreman linked to a CHILD crew -> that child only (under its parent)
Projects attach to CHILD crews via project_schedule_item_work_crews.
"""
from collections import defaultdict

from fastapi import APIRouter, Depends
from sqlalchemy import text

import re

from app.db import engine
from app.auth import require_capability, require_admin
from app.permissions import PROJECT_VIEW_ALL

router = APIRouter(prefix="/api/crew", tags=["crew"])

# Project status buckets for portal metrics.
_ACTIVE = {"in_progress"}
_UPCOMING = {"not_started", "needs_attention", "scheduled"}
_COMPLETED = {"completed"}


def _bucket(status):
    if status in _ACTIVE:
        return "active"
    if status in _UPCOMING:
        return "upcoming"
    if status in _COMPLETED:
        return "completed"
    return "other"


def _metrics(projects):
    """{project_count, active, upcoming, completed, other} for a list of projects."""
    m = {"project_count": len(projects), "active": 0, "upcoming": 0, "completed": 0, "other": 0}
    for pr in projects:
        m[_bucket(pr.get("status"))] += 1
    return m


@router.get("/vendors")
def crew_vendors(_user=Depends(require_capability("page.crew_portal"))):
    """QBO vendors we've paid (for mapping a crew to its vendor)."""
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT vendor_qbo_id,
                   MAX(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.VendorRef.name'))) AS name,
                   ROUND(SUM(total_amt)) AS total_paid
            FROM qbo_transactions
            WHERE entity_type = 'BillPayment' AND vendor_qbo_id IS NOT NULL
            GROUP BY vendor_qbo_id
            ORDER BY total_paid DESC
        """)).mappings().all()
    return {"vendors": [{
        "vendor_qbo_id": r["vendor_qbo_id"],
        "name": r["name"],
        "total_paid": float(r["total_paid"] or 0),
    } for r in rows]}


@router.post("/auto-map-vendors")
def auto_map_vendors(_admin=Depends(require_admin)):
    """One-time helper: link unmapped PARENT crews to a QBO vendor by a
    high-confidence name match (prefix either direction). Leaves ambiguous ones
    (e.g. 'JG Pallet Rack' -> 'Jesus Gomez Gonzalez') for manual mapping."""
    return run_auto_map()


def run_auto_map():
    """Auto-map logic (callable without an auth dependency, e.g. via docker exec)."""
    def norm(s):
        return re.sub(r"[^a-z0-9]", "", (s or "").lower())

    with engine.connect() as conn:
        parents = conn.execute(text(
            "SELECT id, name, vendor_qbo_id FROM work_crews WHERE parent_id IS NULL AND is_active = 1"
        )).mappings().all()
        vendors = conn.execute(text("""
            SELECT vendor_qbo_id,
                   MAX(JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.VendorRef.name'))) AS name,
                   ROUND(SUM(total_amt)) AS total
            FROM qbo_transactions
            WHERE entity_type = 'BillPayment' AND vendor_qbo_id IS NOT NULL
            GROUP BY vendor_qbo_id
        """)).mappings().all()

    vlist = [{"id": v["vendor_qbo_id"], "name": v["name"], "norm": norm(v["name"]),
              "total": float(v["total"] or 0)} for v in vendors if norm(v["name"])]

    mapped, skipped = [], []
    with engine.begin() as conn:
        for p in parents:
            if p["vendor_qbo_id"]:
                continue
            pn = norm(p["name"])
            if len(pn) < 3:
                continue
            cands = [v for v in vlist if len(v["norm"]) >= 3 and (v["norm"].startswith(pn) or pn.startswith(v["norm"]))]
            if not cands:
                skipped.append(p["name"])
                continue
            best = max(cands, key=lambda v: v["total"])
            conn.execute(text("UPDATE work_crews SET vendor_qbo_id = :v WHERE id = :id"),
                         {"v": best["id"], "id": p["id"]})
            mapped.append({"crew": p["name"], "vendor": best["name"]})

    return {"mapped": mapped, "skipped_need_manual": skipped, "count": len(mapped)}


@router.get("/hierarchy")
def crew_hierarchy(user=Depends(require_capability("page.crew_portal"))):
    see_all = PROJECT_VIEW_ALL in (user.get("capabilities") or set())
    work_crew_id = user.get("work_crew_id")

    with engine.connect() as conn:
        crews = conn.execute(text("""
            SELECT id, name, code, parent_id, vendor_qbo_id
            FROM work_crews
            WHERE is_active = 1
            ORDER BY COALESCE(parent_id, id), parent_id IS NOT NULL, sort_order, id
        """)).mappings().all()

        # Crew earnings = what OPI pays the vendor (BillPayments), by vendor.
        earn_rows = conn.execute(text("""
            SELECT vendor_qbo_id,
                   ROUND(SUM(total_amt)) AS total_paid,
                   ROUND(SUM(CASE WHEN YEAR(txn_date) = YEAR(CURDATE()) THEN total_amt ELSE 0 END)) AS ytd_paid
            FROM qbo_transactions
            WHERE entity_type = 'BillPayment' AND vendor_qbo_id IS NOT NULL
            GROUP BY vendor_qbo_id
        """)).mappings().all()

        # Total billed by the vendor (all Bills) — to surface open/unpaid AP.
        billed_rows = conn.execute(text("""
            SELECT vendor_qbo_id, ROUND(SUM(total_amt)) AS total_billed
            FROM qbo_transactions
            WHERE entity_type = 'Bill' AND vendor_qbo_id IS NOT NULL
            GROUP BY vendor_qbo_id
        """)).mappings().all()

        # One row per (child crew, project), active pipeline first. Excludes canceled.
        proj_rows = conn.execute(text("""
            SELECT swc.work_crew_id AS crew_id,
                   qc.id            AS qbo_customer_id,
                   qc.qbo_id        AS project_qbo_id,
                   qc.display_name  AS project_name,
                   MIN(psi.start_date) AS start_date,
                   MAX(psi.end_date)   AS end_date,
                   MIN(psi.status)     AS status
            FROM myapp.project_schedule_item_work_crews swc
            JOIN myapp.project_schedule_items psi ON psi.id = swc.schedule_item_id
            JOIN myapp.projects p               ON p.id  = psi.project_id
            JOIN myapp.qbo_customers qc          ON qc.id = p.qbo_customer_id
            WHERE swc.unassigned_at IS NULL
              AND COALESCE(psi.status, '') <> 'canceled'
            GROUP BY swc.work_crew_id, qc.id, qc.qbo_id, qc.display_name
            ORDER BY MAX(psi.end_date) DESC, MIN(psi.start_date) DESC
        """)).mappings().all()

        # Project-attributed crew earnings: Bill lines tagged to a project (job
        # costing), by vendor. Attributed to the assigned crew whose parent has
        # that vendor (primary crew breaks ties for same-vendor multi-crew).
        bill_rows = conn.execute(text("""
            SELECT l.line_customer_qbo_id AS project_qbo_id,
                   qt.vendor_qbo_id       AS vendor_qbo_id,
                   SUM(l.amount)          AS amt,
                   SUM(CASE WHEN YEAR(qt.txn_date) = YEAR(CURDATE()) THEN l.amount ELSE 0 END) AS ytd
            FROM qbo_transactions qt
            JOIN qbo_transaction_lines l ON l.transaction_id = qt.id
            WHERE qt.entity_type = 'Bill'
              AND l.line_customer_qbo_id IS NOT NULL
              AND qt.vendor_qbo_id IS NOT NULL
            GROUP BY l.line_customer_qbo_id, qt.vendor_qbo_id
        """)).mappings().all()

        assign_rows = conn.execute(text("""
            SELECT qc.qbo_id            AS project_qbo_id,
                   wc.id               AS crew_id,
                   parent.vendor_qbo_id AS vendor_qbo_id,
                   MAX(swc.is_primary) AS is_primary
            FROM myapp.project_schedule_item_work_crews swc
            JOIN myapp.project_schedule_items psi ON psi.id = swc.schedule_item_id
            JOIN myapp.projects p               ON p.id  = psi.project_id
            JOIN myapp.qbo_customers qc          ON qc.id = p.qbo_customer_id
            JOIN myapp.work_crews wc             ON wc.id = swc.work_crew_id
            JOIN myapp.work_crews parent         ON parent.id = wc.parent_id
            WHERE swc.unassigned_at IS NULL AND parent.vendor_qbo_id IS NOT NULL
            GROUP BY qc.qbo_id, wc.id, parent.vendor_qbo_id
        """)).mappings().all()

    earnings_by_vendor = {str(r["vendor_qbo_id"]): r for r in earn_rows}
    billed_by_vendor = {str(r["vendor_qbo_id"]): float(r["total_billed"] or 0) for r in billed_rows}

    # (project, vendor) -> list of (crew_id, is_primary); pick the earning crew.
    assign_map = defaultdict(list)
    for r in assign_rows:
        assign_map[(str(r["project_qbo_id"]), str(r["vendor_qbo_id"]))].append(
            (r["crew_id"], int(r["is_primary"] or 0)))
    attributed = defaultdict(lambda: {"total": 0.0, "ytd": 0.0})            # per crew
    attributed_cp = defaultdict(lambda: {"total": 0.0, "ytd": 0.0})         # per (crew, project)
    for r in bill_rows:
        pqid = str(r["project_qbo_id"])
        cands = assign_map.get((pqid, str(r["vendor_qbo_id"])))
        if not cands:
            continue  # bill vendor isn't an assigned crew's company on this project
        crew_id = sorted(cands, key=lambda c: (0 if c[1] else 1, c[0]))[0][0]  # primary, else lowest id
        amt, ytd = float(r["amt"] or 0), float(r["ytd"] or 0)
        attributed[crew_id]["total"] += amt
        attributed[crew_id]["ytd"] += ytd
        attributed_cp[(crew_id, pqid)]["total"] += amt
        attributed_cp[(crew_id, pqid)]["ytd"] += ytd

    crews_by_id = {c["id"]: dict(c) for c in crews}
    children_by_parent = defaultdict(list)
    all_parent_ids = []
    for c in crews:
        if c["parent_id"] is None:
            all_parent_ids.append(c["id"])
        else:
            children_by_parent[c["parent_id"]].append(dict(c))

    projects_by_crew = defaultdict(list)
    for r in proj_rows:
        ce = attributed_cp.get((r["crew_id"], str(r["project_qbo_id"])), {"total": 0.0, "ytd": 0.0})
        projects_by_crew[r["crew_id"]].append({
            "qbo_customer_id": r["qbo_customer_id"],
            "project_qbo_id": str(r["project_qbo_id"]),
            "project_name": r["project_name"],
            "start_date": str(r["start_date"]) if r["start_date"] else None,
            "end_date": str(r["end_date"]) if r["end_date"] else None,
            "status": r["status"],
            "earnings": {"total": round(ce["total"], 2), "ytd": round(ce["ytd"], 2)},
        })

    # ---- scope which parents/children are visible ----
    child_filter = None  # None = all children of the visible parents
    if see_all:
        visible_parent_ids = all_parent_ids
    elif work_crew_id and work_crew_id in crews_by_id:
        linked = crews_by_id[work_crew_id]
        if linked["parent_id"] is None:
            visible_parent_ids = [linked["id"]]            # they ARE a parent
        else:
            visible_parent_ids = [linked["parent_id"]]     # their parent, but...
            child_filter = {linked["id"]}                  # ...only their own crew
    else:
        visible_parent_ids = []

    parents = []
    for pid in visible_parent_ids:
        p = crews_by_id.get(pid)
        if not p:
            continue
        kids = children_by_parent.get(pid, [])
        if child_filter is not None:
            kids = [k for k in kids if k["id"] in child_filter]
        children = []
        # parent rollup
        ptot = {"active": 0, "upcoming": 0, "completed": 0, "other": 0, "project_count": 0}
        crews_with_projects = 0
        crews_active = 0       # crews with a current (in-progress) project
        crews_upcoming = 0     # crews with upcoming work but nothing active
        crews_idle = 0         # crews with no current/upcoming work
        attr_total = 0.0
        attr_ytd = 0.0
        for k in kids:
            projs = projects_by_crew.get(k["id"], [])
            m = _metrics(projs)
            if projs:
                crews_with_projects += 1
            if m["active"] > 0:
                crews_active += 1
            elif m["upcoming"] > 0:
                crews_upcoming += 1
            else:
                crews_idle += 1
            for key in ptot:
                ptot[key] += m[key]
            ce = attributed.get(k["id"], {"total": 0.0, "ytd": 0.0})
            attr_total += ce["total"]
            attr_ytd += ce["ytd"]
            children.append({
                "id": k["id"],
                "name": k["name"],
                "code": k.get("code"),
                "projects": projs,
                "metrics": m,
                "earnings": {"total": round(ce["total"], 2), "ytd": round(ce["ytd"], 2)},
            })
        vid = p.get("vendor_qbo_id")
        earn = earnings_by_vendor.get(str(vid)) if vid else None
        total_paid = float(earn["total_paid"]) if earn and earn["total_paid"] is not None else None
        total_billed = billed_by_vendor.get(str(vid)) if vid else None
        open_bills = (round(total_billed - total_paid, 2)
                      if total_billed is not None and total_paid is not None
                      and total_billed > total_paid else None)
        parents.append({
            "id": p["id"],
            "name": p["name"],
            "code": p.get("code"),
            "vendor_qbo_id": vid,
            "children": children,
            "metrics": {
                "child_count": len(kids),
                "crews_with_projects": crews_with_projects,
                "crews_active": crews_active,
                "crews_upcoming": crews_upcoming,
                "crews_idle": crews_idle,
                **ptot,
            },
            "earnings": {
                "mapped": bool(vid),
                "total_paid": total_paid,
                "ytd_paid": float(earn["ytd_paid"]) if earn and earn["ytd_paid"] is not None else None,
                "total_billed": total_billed,
                "open_bills": open_bills,  # billed by vendor but not yet paid (AP)
                # Project-attributed (sum of children) — Bills job-costed to specific jobs.
                "attributed_total": round(attr_total, 2),
                "attributed_ytd": round(attr_ytd, 2),
            },
        })

    return {
        "scope": "all" if see_all else ("crew" if work_crew_id else "none"),
        "parents": parents,
    }
