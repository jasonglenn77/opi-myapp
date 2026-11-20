"""Work packages: assignments per estimate (2026-11-18 owner decision).

A project's estimates are grouped into PACKAGES (table project_phases; the UI
says "package", never "phase"). Estimates in one package share dates: the
package's schedule lines (project_schedule_items.package_id), usually one date
range, more when the work breaks. A change order with its own dates gets its own
package; an add-on to the original joins the original's package.

Per estimate: the PM (project_estimate_phase.pm_id; usually one PM for all, set
in bulk) and the crew (project_estimate_billing.crew_id, the same field Billing
uses). Per package: dates, travel days, wire guidance, equipment, days off.
Per project: the status (worked out from the dates) and the overage days, kept
on the project's LAST line: overage is only for running past the scheduled end
without a change order.

Every page that reads project_schedule_items keeps working: the lines are still
the project's lines. The package's PMs and crews are written onto its lines
(sync_lines) through the one save path (projects.service.save_schedule_item), so
history, crew availability, the portals and the Tracker see the same people.
"""
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import bindparam, text

from app.db import engine

ACCEPTED = ("Accepted", "Converted", "Closed")


def _x(sql, *names):
    q = text(sql)
    return q.bindparams(*[bindparam(n, expanding=True) for n in names]) if names else q


def _flt(col, eids):
    return f" AND {col} IN :eids" if eids is not None else ""


def ensure_all(conn, eids=None, backfill=False):
    """Make sure every project (or the given project qbo_ids) has a package,
    every estimate is in one, and every line belongs to one. Idempotent.

    - A project with no package gets "package 1".
    - An estimate in no package joins the project's LAST package. With
      backfill=True (the one-time deploy run) it's confirmed; otherwise it
      arrives unconfirmed, so Project Setup asks where it belongs.
    - A line in no package goes to the project's FIRST package.
    - An estimate with no PM takes its package's primary PM (from its lines).
    """
    if eids is not None:
        eids = [str(e) for e in eids if e]
        if not eids:
            return
    p = {"eids": eids} if eids is not None else {}
    names = ("eids",) if eids is not None else ()
    # 2026-11-19: read first, write only when something is missing. Every page
    # that shows packages calls this; Project Setup opens four of them at once,
    # and four writers on the same project deadlocked (500s, and a card that
    # failed fell back to the old line layout).
    if not backfill and not _missing(conn, eids, names, p):
        return
    conn.execute(_x(f"""
        INSERT INTO project_phases (entity_id, seq)
        SELECT DISTINCT qc.qbo_id, 1 FROM projects pr JOIN qbo_customers qc ON qc.id = pr.qbo_customer_id
        WHERE qc.is_project = 1 {_flt('qc.qbo_id', eids)}
          AND NOT EXISTS (SELECT 1 FROM project_phases ph WHERE ph.entity_id = qc.qbo_id)""", *names), p)
    conn.execute(_x(f"""
        INSERT INTO project_estimate_phase (entity_id, estimate_qbo_id, phase_id, confirmed)
        SELECT t.customer_qbo_id, t.qbo_id,
               (SELECT ph.id FROM project_phases ph WHERE ph.entity_id = t.customer_qbo_id ORDER BY ph.seq DESC, ph.id DESC LIMIT 1),
               :cf
        FROM (SELECT DISTINCT customer_qbo_id, qbo_id FROM qbo_transactions
              WHERE entity_type = 'Estimate' AND customer_qbo_id IS NOT NULL {_flt('customer_qbo_id', eids)}) t
        WHERE EXISTS (SELECT 1 FROM project_phases ph WHERE ph.entity_id = t.customer_qbo_id)
          AND NOT EXISTS (SELECT 1 FROM project_estimate_phase ep
                          WHERE ep.entity_id = t.customer_qbo_id AND ep.estimate_qbo_id = t.qbo_id)""", *names),
        {**p, "cf": 1 if backfill else 0})
    conn.execute(_x(f"""
        UPDATE project_schedule_items psi
        JOIN projects pr ON pr.id = psi.project_id
        JOIN qbo_customers qc ON qc.id = pr.qbo_customer_id
        SET psi.package_id = (SELECT MIN(ph.id) FROM project_phases ph WHERE ph.entity_id = qc.qbo_id),
            psi.updated_at = psi.updated_at      -- a package link isn't an edit: keep the line's timestamp
        WHERE psi.package_id IS NULL {_flt('qc.qbo_id', eids)}""", *names), p)
    conn.execute(_x(f"""
        UPDATE project_estimate_phase ep
        SET ep.pm_id = (SELECT spm.project_manager_id FROM project_schedule_items psi
                        JOIN project_schedule_item_project_managers spm
                             ON spm.schedule_item_id = psi.id AND spm.unassigned_at IS NULL
                        WHERE psi.package_id = ep.phase_id
                        ORDER BY spm.is_primary DESC, psi.start_date IS NULL, psi.start_date, spm.id LIMIT 1)
        WHERE ep.pm_id IS NULL {_flt('ep.entity_id', eids)}""", *names), p)
    if backfill:
        conn.execute(_x(f"UPDATE project_estimate_phase SET confirmed = 1 WHERE confirmed = 0 {_flt('entity_id', eids)}", *names), p)


def _missing(conn, eids, names, p):
    """Is anything for ensure_all to do? (read-only)"""
    return bool(conn.execute(_x(f"""
        SELECT
          EXISTS (SELECT 1 FROM projects pr JOIN qbo_customers qc ON qc.id = pr.qbo_customer_id
                  WHERE qc.is_project = 1 {_flt('qc.qbo_id', eids)}
                    AND NOT EXISTS (SELECT 1 FROM project_phases ph WHERE ph.entity_id = qc.qbo_id))
          OR EXISTS (SELECT 1 FROM qbo_transactions t
                     WHERE t.entity_type = 'Estimate' AND t.customer_qbo_id IS NOT NULL {_flt('t.customer_qbo_id', eids)}
                       AND EXISTS (SELECT 1 FROM project_phases ph WHERE ph.entity_id = t.customer_qbo_id)
                       AND NOT EXISTS (SELECT 1 FROM project_estimate_phase ep
                                       WHERE ep.entity_id = t.customer_qbo_id AND ep.estimate_qbo_id = t.qbo_id))
          OR EXISTS (SELECT 1 FROM project_schedule_items psi JOIN projects pr ON pr.id = psi.project_id
                     JOIN qbo_customers qc ON qc.id = pr.qbo_customer_id
                     WHERE psi.package_id IS NULL {_flt('qc.qbo_id', eids)})
          OR EXISTS (SELECT 1 FROM project_estimate_phase ep
                     JOIN project_schedule_items psi ON psi.package_id = ep.phase_id
                     JOIN project_schedule_item_project_managers spm
                          ON spm.schedule_item_id = psi.id AND spm.unassigned_at IS NULL
                     WHERE ep.pm_id IS NULL {_flt('ep.entity_id', eids)})""", *names), p).scalar())


def run_ensure(backfill=False):
    """ensure_all for every project in its own transaction (nightly cron; the
    deploy's one-time backfill passes backfill=True)."""
    with engine.begin() as conn:
        ensure_all(conn, backfill=backfill)
        n = conn.execute(text("SELECT COUNT(*) FROM project_phases")).scalar()
    return {"packages": int(n)}


def _iso(v):
    return str(v)[:10] if v else None


def _add(d, n):
    return (date.fromisoformat(d) + timedelta(days=int(n or 0))).isoformat() if d else None


def estimates(conn, eid):
    """The project's estimates (latest version of each), oldest first, with their
    package, PM, crew and status."""
    rows = conn.execute(text("""
        WITH latest AS (
          SELECT t.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(t.doc_number, t.qbo_id) ORDER BY t.id DESC) AS rn
          FROM qbo_transactions t WHERE t.entity_type = 'Estimate' AND t.customer_qbo_id = :e)
        SELECT l.qbo_id, l.doc_number, l.txn_date, l.total_amt,
               JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.TxnStatus')) AS status,
               JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AcceptedDate')) AS accepted_date,
               ep.phase_id AS package_id, ep.pm_id, ep.confirmed AS placed,
               b.crew_id, wc.name AS crew_name, COALESCE(wc.parent_id, wc.id) AS crew_company_id
        FROM latest l
        LEFT JOIN project_estimate_phase ep ON ep.entity_id = l.customer_qbo_id AND ep.estimate_qbo_id = l.qbo_id
        LEFT JOIN project_estimate_billing b ON b.entity_id = l.customer_qbo_id AND b.estimate_qbo_id = l.qbo_id
        LEFT JOIN work_crews wc ON wc.id = b.crew_id
        WHERE l.rn = 1 ORDER BY l.txn_date, l.id"""), {"e": eid}).mappings().all()
    try:
        from app.billing import invoice_dates as IDT
        cos = IDT.change_order_ids(conn, eid)
    except Exception:
        cos = {str(r["qbo_id"]) for r in rows[1:]}
    offers, by_est = {}, {}
    for r in conn.execute(text("""SELECT crew_id, status, sent_at, responded_at, estimate_qbo_id FROM work_offers
                                  WHERE entity_id = :e AND status <> 'withdrawn' ORDER BY id"""), {"e": eid}).mappings().all():
        if r["estimate_qbo_id"]:
            by_est[str(r["estimate_qbo_id"])] = dict(r)   # 2026-11-19: offers per estimate
        else:
            offers[r["crew_id"]] = dict(r)          # older project-wide offers: latest per crew
    out = []
    for r in rows:
        off = by_est.get(str(r["qbo_id"])) or offers.get(r["crew_id"]) or offers.get(r["crew_company_id"])
        out.append({"qbo_id": str(r["qbo_id"]), "doc_number": r["doc_number"], "date": _iso(r["txn_date"]),
                    "total": round(float(r["total_amt"] or 0), 2), "status": r["status"] or "",
                    "accepted": (r["status"] or "") in ACCEPTED, "accepted_date": _iso(r["accepted_date"]),
                    "change_order": str(r["qbo_id"]) in cos, "package_id": r["package_id"],
                    "placed": bool(r["placed"]), "pm_id": r["pm_id"], "crew_id": r["crew_id"], "crew_name": r["crew_name"],
                    "crew_company_id": r["crew_company_id"],
                    "offer": ({"status": off["status"], "sent_at": _iso(off["sent_at"]), "responded_at": _iso(off["responded_at"])}
                              if off else None)})
    return out


def _lines(conn, eid):
    return conn.execute(text("""
        SELECT psi.id, psi.package_id, psi.status, psi.start_date, psi.end_date, psi.overage_days, psi.travel_days,
               psi.wire_guidance, psi.equipment_type, psi.is_extra_row
        FROM project_schedule_items psi JOIN projects pr ON pr.id = psi.project_id
        JOIN qbo_customers qc ON qc.id = pr.qbo_customer_id
        WHERE qc.qbo_id = :e ORDER BY psi.start_date IS NULL, psi.start_date, psi.id"""), {"e": eid}).mappings().all()


def timeline(lines):
    """Project timeline from its lines: start, scheduled end, overage (on the
    last line), expected finish, and the breaks between date ranges."""
    dated = sorted([l for l in lines if l["start_date"] and l["end_date"] and l["status"] != "canceled"],
                   key=lambda l: (l["start_date"], l["end_date"]))
    if not dated:
        return {"start": None, "end": None, "overage_days": 0, "finish": None, "breaks": [], "ranges": 0}
    start = _iso(dated[0]["start_date"])
    last = max(dated, key=lambda l: (l["end_date"], l["id"]))
    end = _iso(last["end_date"])
    ov = int(last["overage_days"] or 0)
    breaks, reach = [], _iso(dated[0]["end_date"])
    for l in dated[1:]:
        s = _iso(l["start_date"])
        if s and reach and s > _add(reach, 1):
            breaks.append({"from": _add(reach, 1), "to": _add(s, -1)})
        reach = max(reach, _iso(l["end_date"]))
    early_ov = sum(int(l["overage_days"] or 0) for l in dated if l["id"] != last["id"])
    return {"start": start, "end": end, "overage_days": ov, "finish": _add(end, ov), "breaks": breaks,
            "ranges": len(dated), "last_line_id": last["id"], "overage_elsewhere": early_ov}


def bundle(conn, eid):
    """Packages with their estimates and line ids, plus the project timeline."""
    ensure_all(conn, [eid])
    pk = conn.execute(text("SELECT id, seq, name FROM project_phases WHERE entity_id = :e ORDER BY seq, id"),
                      {"e": eid}).mappings().all()
    ests = estimates(conn, eid)
    lines = _lines(conn, eid)
    by_pk = defaultdict(list)
    for l in lines:
        by_pk[l["package_id"]].append(l)
    pkgs = []
    for i, p in enumerate(pk):
        ls = by_pk.get(p["id"], [])
        tl = timeline(ls)
        mine = [e for e in ests if e["package_id"] == p["id"]]
        pkgs.append({"id": p["id"], "seq": p["seq"], "name": p["name"] or f"Package {i + 1}", "custom_name": bool(p["name"]),
                     "line_ids": [l["id"] for l in ls], "start": tl["start"], "end": tl["end"], "breaks": tl["breaks"],
                     "has_dates": bool(tl["start"]), "travel_days": max([int(l["travel_days"] or 0) for l in ls] or [0]),
                     "estimates": [e["qbo_id"] for e in mine],
                     "accepted_total": round(sum(e["total"] for e in mine if e["accepted"]), 2)})
    props = []
    try:     # the Job Schedule sheet's would-be changes (reference only, 0110)
        import json
        for r in conn.execute(text("""SELECT g.id, g.schedule_item_id, g.job, g.visit_first, g.visit_last, g.changes
                                       FROM gsync_schedule_proposals g JOIN qbo_customers qc ON qc.id = g.qbo_customer_id
                                       WHERE qc.qbo_id = :e ORDER BY g.visit_first"""), {"e": eid}).mappings().all():
            ch = r["changes"]
            props.append({"id": r["id"], "schedule_item_id": r["schedule_item_id"], "job": r["job"],
                          "visit": [_iso(r["visit_first"]), _iso(r["visit_last"])],
                          "changes": json.loads(ch) if isinstance(ch, str) else ch})
    except Exception:
        props = []
    return {"entity_id": str(eid), "packages": pkgs, "estimates": ests, "timeline": timeline(lines), "job_schedule": props}


def dates_by_estimate(conn, eids):
    """{(eid, estimate_qbo_id): {"start", "end", "finish"}} from each estimate's
    package lines. finish adds the project's overage when the package holds the
    project's last line. For billing / crew pay / expenses per estimate."""
    eids = [str(e) for e in eids if e]
    if not eids:
        return {}
    lines = conn.execute(_x("""
        SELECT qc.qbo_id AS e, psi.id, psi.package_id, psi.status, psi.start_date, psi.end_date, psi.overage_days
        FROM project_schedule_items psi JOIN projects pr ON pr.id = psi.project_id
        JOIN qbo_customers qc ON qc.id = pr.qbo_customer_id WHERE qc.qbo_id IN :e""", "e"), {"e": eids}).mappings().all()
    by_e = defaultdict(list)
    for l in lines:
        by_e[str(l["e"])].append(l)
    maps = conn.execute(_x("SELECT entity_id, estimate_qbo_id, phase_id FROM project_estimate_phase WHERE entity_id IN :e", "e"),
                        {"e": eids}).all()
    out = {}
    tl_cache = {}
    for e, q, pid in maps:
        e = str(e)
        if e not in tl_cache:
            tl_cache[e] = timeline(by_e.get(e, []))
        proj = tl_cache[e]
        mine = [l for l in by_e.get(e, []) if l["package_id"] == pid]
        t = timeline(mine)
        if not t["start"]:
            continue
        holds_last = proj.get("last_line_id") in {l["id"] for l in mine}
        out[(e, str(q))] = {"start": t["start"], "end": t["end"],
                            "finish": _add(t["end"], proj["overage_days"]) if holds_last else t["end"]}
    return out


# ── writes ────────────────────────────────────────────────────────────────────

def _project_row(conn, eid):
    r = conn.execute(text("""SELECT qc.id AS cid, pr.id AS pid FROM qbo_customers qc
                             JOIN projects pr ON pr.qbo_customer_id = qc.id WHERE qc.qbo_id = :e LIMIT 1"""),
                     {"e": eid}).mappings().first()
    if not r:
        raise ValueError("Project not found")
    return r


def new_package(conn, eid, name=None):
    seq = int(conn.execute(text("SELECT COALESCE(MAX(seq), 0) FROM project_phases WHERE entity_id = :e"), {"e": eid}).scalar() or 0) + 1
    conn.execute(text("INSERT INTO project_phases (entity_id, seq, name) VALUES (:e, :s, :n)"), {"e": eid, "s": seq, "n": name})
    return int(conn.execute(text("SELECT LAST_INSERT_ID()")).scalar())


def add_line(conn, eid, package_id):
    """A new undated line in the package (its dates, or a break in the work)."""
    pr = _project_row(conn, eid)
    conn.execute(text("""INSERT INTO project_schedule_items (project_id, status, is_extra_row, package_id, sort_order)
                         VALUES (:p, 'not_started', 1, :k,
                                 (SELECT COALESCE(MAX(x.sort_order), 0) + 1 FROM (SELECT sort_order FROM project_schedule_items WHERE project_id = :p) x))"""),
                 {"p": pr["pid"], "k": package_id})
    return int(conn.execute(text("SELECT LAST_INSERT_ID()")).scalar())


def move_estimate(conn, eid, est_qbo_id, package_id):
    """Put an estimate in a package ("new" = its own new package with one undated
    line). An emptied package with no dated lines is removed."""
    old = conn.execute(text("SELECT phase_id FROM project_estimate_phase WHERE entity_id = :e AND estimate_qbo_id = :q"),
                       {"e": eid, "q": est_qbo_id}).scalar()
    if package_id == "new":
        package_id = new_package(conn, eid)
        add_line(conn, eid, package_id)
    else:
        package_id = int(package_id)
        ok = conn.execute(text("SELECT 1 FROM project_phases WHERE id = :k AND entity_id = :e"), {"k": package_id, "e": eid}).scalar()
        if not ok:
            raise ValueError("That package isn't on this project")
    pm = conn.execute(text("""SELECT pm_id FROM project_estimate_phase WHERE phase_id = :k AND pm_id IS NOT NULL LIMIT 1"""),
                      {"k": package_id}).scalar()
    conn.execute(text("""INSERT INTO project_estimate_phase (entity_id, estimate_qbo_id, phase_id, confirmed, pm_id)
                         VALUES (:e, :q, :k, 1, :pm)
                         ON DUPLICATE KEY UPDATE phase_id = VALUES(phase_id), confirmed = 1,
                                                 pm_id = COALESCE(project_estimate_phase.pm_id, VALUES(pm_id))"""),
                 {"e": eid, "q": est_qbo_id, "k": package_id, "pm": pm})
    if old and old != package_id:
        _drop_if_empty(conn, eid, old)
    return package_id


def _drop_if_empty(conn, eid, package_id):
    n_est = conn.execute(text("SELECT COUNT(*) FROM project_estimate_phase WHERE phase_id = :k"), {"k": package_id}).scalar()
    dated = conn.execute(text("""SELECT COUNT(*) FROM project_schedule_items WHERE package_id = :k
                                 AND (start_date IS NOT NULL OR end_date IS NOT NULL)"""), {"k": package_id}).scalar()
    n_pk = conn.execute(text("SELECT COUNT(*) FROM project_phases WHERE entity_id = :e"), {"e": eid}).scalar()
    if n_est == 0 and dated == 0 and n_pk > 1:
        # an emptied package with only blank lines: remove the lines (and the
        # PM / crew copied onto them), then the package
        ids = [r[0] for r in conn.execute(text("""SELECT id FROM project_schedule_items WHERE package_id = :k
                                                   AND start_date IS NULL AND end_date IS NULL"""), {"k": package_id}).all()]
        if ids:
            q = {"ids": ids}
            conn.execute(_x("DELETE FROM project_schedule_item_work_crews WHERE schedule_item_id IN :ids", "ids"), q)
            conn.execute(_x("DELETE FROM project_schedule_item_project_managers WHERE schedule_item_id IN :ids", "ids"), q)
            conn.execute(_x("DELETE FROM project_schedule_items WHERE id IN :ids", "ids"), q)
        left = conn.execute(text("SELECT COUNT(*) FROM project_schedule_items WHERE package_id = :k"), {"k": package_id}).scalar()
        if not left:
            conn.execute(text("DELETE FROM project_phases WHERE id = :k"), {"k": package_id})
            return True
    return False


def set_pm(conn, eid, est_qbo_ids, pm_id):
    """PM for one estimate, several, or (est_qbo_ids=None) every estimate."""
    if est_qbo_ids is None:
        conn.execute(text("UPDATE project_estimate_phase SET pm_id = :pm WHERE entity_id = :e"), {"pm": pm_id, "e": eid})
    else:
        conn.execute(_x("UPDATE project_estimate_phase SET pm_id = :pm WHERE entity_id = :e AND estimate_qbo_id IN :q", "q"),
                     {"pm": pm_id, "e": eid, "q": [str(q) for q in est_qbo_ids]})


def sync_lines(eid, actor_user_id, package_ids=None, crews=True):
    """Write each package's PMs (and crews) onto its lines through the normal save
    path, so every page that reads the lines sees them. PMs = the PMs of the
    package's estimates (primary = the first estimate's). Crews: a company picked
    on an estimate is ADDED to the package's lines; nothing is ever removed here
    (the estimate's crew is who's paid, not always everyone on site, e.g. a
    second crew working under the first). Crew bosses and slots are kept;
    removing a crew from a line is done on the line."""
    from app.projects.service import get_assignment_bundle, save_schedule_item
    from app.projects.routes import ScheduleItemSaveRequest
    with engine.connect() as conn:
        pr = _project_row(conn, eid)
        b = bundle(conn, eid)
        companies = {r[0]: r[1] for r in conn.execute(text("SELECT id, COALESCE(parent_id, id) FROM work_crews")).all()}
    ab = get_assignment_bundle(int(pr["cid"]))
    ests = {e["qbo_id"]: e for e in b["estimates"]}
    for p in b["packages"]:
        if package_ids is not None and p["id"] not in package_ids:
            continue
        mine = [ests[q] for q in p["estimates"] if q in ests]
        pms = []
        for e in mine:
            if e["pm_id"] and e["pm_id"] not in pms:
                pms.append(int(e["pm_id"]))
        want_cos = []
        for e in mine:
            c = companies.get(e["crew_id"]) if e["crew_id"] else None
            if c and c not in want_cos:
                want_cos.append(c)
        for it in ab.get("schedule_items", []):
            if it.get("package_id") != p["id"]:
                continue
            cur_pm = [int(a["project_manager_id"]) for a in it.get("active_project_managers") or []]
            cur_cr = [dict(x) for x in it.get("active_work_crews") or []]
            new_pm = pms or cur_pm
            entries = [{"company_id": int(x.get("company_id") or companies.get(x.get("work_crew_id")) or 0),
                        "lead_crew_id": x.get("lead_crew_id"), "slot_code": x.get("slot_code"),
                        "is_primary": bool(x.get("is_primary"))} for x in cur_cr]
            entries = [x for x in entries if x["company_id"]]
            if crews and want_cos:
                have = {x["company_id"] for x in entries}
                for c in want_cos:
                    if c not in have:
                        entries.append({"company_id": c, "lead_crew_id": None, "slot_code": None, "is_primary": False})
                if entries and not any(x["is_primary"] for x in entries):
                    entries[0]["is_primary"] = True
            same_pm = sorted(new_pm) == sorted(cur_pm)
            same_cr = sorted((x["company_id"], x["lead_crew_id"] or 0) for x in entries) == \
                sorted((int(x.get("company_id") or 0), x.get("lead_crew_id") or 0) for x in cur_cr if x.get("company_id"))
            if same_pm and same_cr:
                continue
            req = ScheduleItemSaveRequest(
                schedule_item_id=it["id"], qbo_customer_id=int(pr["cid"]), status=it.get("status") or "not_started",
                start_date=_iso(it.get("start_date")), end_date=_iso(it.get("end_date")),
                wire_guidance=int(it.get("wire_guidance") or 0), travel_days=int(it.get("travel_days") or 0),
                overage_days=int(it.get("overage_days") or 0), equipment_type=it.get("equipment_type"),
                project_manager_ids=new_pm, primary_project_manager_id=(new_pm[0] if new_pm else None),
                crew_assignments=entries, notes=it.get("notes"), non_working=it.get("non_working"))
            save_schedule_item(req=req, actor_user_id=actor_user_id)


def set_overage(eid, days, actor_user_id):
    """The project's overage days, on its last dated line."""
    from app.projects.service import get_assignment_bundle, save_schedule_item
    from app.projects.routes import ScheduleItemSaveRequest
    with engine.connect() as conn:
        pr = _project_row(conn, eid)
        tl = timeline(_lines(conn, eid))
    if not tl.get("last_line_id"):
        raise ValueError("Set the dates first: overage counts from the scheduled end")
    ab = get_assignment_bundle(int(pr["cid"]))
    it = next(x for x in ab["schedule_items"] if x["id"] == tl["last_line_id"])
    pms = [int(a["project_manager_id"]) for a in it.get("active_project_managers") or []]
    prim = next((int(a["project_manager_id"]) for a in it.get("active_project_managers") or [] if a.get("is_primary")), pms[0] if pms else None)
    req = ScheduleItemSaveRequest(
        schedule_item_id=it["id"], qbo_customer_id=int(pr["cid"]), status=it.get("status") or "not_started",
        start_date=_iso(it.get("start_date")), end_date=_iso(it.get("end_date")),
        wire_guidance=int(it.get("wire_guidance") or 0), travel_days=int(it.get("travel_days") or 0),
        overage_days=max(0, int(days or 0)), equipment_type=it.get("equipment_type"),
        project_manager_ids=pms, primary_project_manager_id=prim,
        crew_assignments=[{"company_id": int(x.get("company_id")), "lead_crew_id": x.get("lead_crew_id"),
                           "slot_code": x.get("slot_code"), "is_primary": bool(x.get("is_primary"))}
                          for x in it.get("active_work_crews") or [] if x.get("company_id")],
        notes=it.get("notes"), non_working=it.get("non_working"))
    return save_schedule_item(req=req, actor_user_id=actor_user_id)
