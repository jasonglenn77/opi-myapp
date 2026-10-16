"""
Ashley's Tracker — the office's estimates & progress-invoicing summary and the
per-PM project schedule, replacing the "Progress Invoice" workbook.

Invoicing view: one row per project with its status, PMs, dates, accepted
estimates and their invoice schedules. Billing numbers come from the SAME
composer the Billing & Schedule tab uses (billing.routes._compose_estimates),
so both screens always agree; edits go through /api/invoices (shared rows,
audited). Composing every project takes seconds, so each project's result is
cached in-process and recomputed only when its billing signature changes.

PM schedule view: every active PM assignment with its schedule window, for the
per-PM table and timeline.
"""
import json
import threading
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import bindparam, text

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS
from app.billing.routes import (
    _compose_estimates, _ensure_estimate_billing, _apply_assignment_default_crew,
    _ensure_invoice_schedules, _default_crew_for_project, _project_meta,
)
from app.invoices.routes import _project_ctx

router = APIRouter(prefix="/api/tracker", tags=["tracker"])

PAST_STATUSES = ("completed", "canceled")
SOON_DAYS = 14

_cache = {}            # entity_id -> (signature, composed billing dict)
_cache_lock = threading.Lock()


def _require(user):
    if not has_capability(user, PAGE_CUSTOMERS):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _d(v):
    return str(v)[:10] if v else None


def _initials(first, last):
    return ((first or "")[:1] + (last or "")[:1]).upper() or "?"


# ── bulk lookups ────────────────────────────────────────────────────────────
def _projects(conn, only=None):
    where = "AND qc.qbo_id = :only" if only else ""
    rows = conn.execute(text(f"""
        SELECT qc.qbo_id, qc.id AS qc_id, qc.display_name, pc.display_name AS customer
        FROM qbo_customers qc LEFT JOIN qbo_customers pc ON pc.qbo_id = qc.parent_qbo_id
        WHERE qc.is_project = 1 {where}
    """), {"only": only} if only else {}).mappings().all()
    return {str(r["qbo_id"]): dict(r) for r in rows}


def _schedule(conn, only=None):
    where = "WHERE qc.qbo_id = :only" if only else ""
    rows = conn.execute(text(f"""
        WITH ranked AS (
          SELECT qc.qbo_id, psi.status, psi.start_date, psi.end_date,
                 DATE_ADD(psi.end_date, INTERVAL COALESCE(psi.overage_days, 0) DAY) AS true_end,
                 ROW_NUMBER() OVER (PARTITION BY qc.qbo_id
                   ORDER BY psi.start_date IS NULL, psi.start_date DESC, psi.sort_order DESC, psi.id DESC) AS rn
          FROM project_schedule_items psi
          JOIN projects p ON p.id = psi.project_id
          JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
          {where}
        )
        SELECT qbo_id, MAX(CASE WHEN rn = 1 THEN status END) AS status,
               MIN(start_date) AS start_date, MAX(end_date) AS end_date, MAX(true_end) AS true_end
        FROM ranked GROUP BY qbo_id
    """), {"only": only} if only else {}).mappings().all()
    return {str(r["qbo_id"]): r for r in rows}


def _pms(conn, only=None):
    where = "AND qc.qbo_id = :only" if only else ""
    rows = conn.execute(text(f"""
        SELECT qc.qbo_id, m.id, m.first_name, m.last_name, MAX(spm.is_primary) AS is_primary
        FROM project_schedule_item_project_managers spm
        JOIN project_schedule_items psi ON psi.id = spm.schedule_item_id
        JOIN projects p ON p.id = psi.project_id
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        JOIN project_managers m ON m.id = spm.project_manager_id
        WHERE spm.unassigned_at IS NULL {where}
        GROUP BY qc.qbo_id, m.id, m.first_name, m.last_name
        ORDER BY is_primary DESC, m.first_name
    """), {"only": only} if only else {}).mappings().all()
    out = {}
    for r in rows:
        out.setdefault(str(r["qbo_id"]), []).append({
            "id": r["id"], "name": f"{r['first_name'] or ''} {r['last_name'] or ''}".strip(),
            "initials": _initials(r["first_name"], r["last_name"]), "primary": bool(r["is_primary"])})
    return out


def _estimate_dates(conn, only=None):
    where = "AND customer_qbo_id = :only" if only else ""
    rows = conn.execute(text(f"""
        SELECT qbo_id, MAX(txn_date) AS txn_date FROM qbo_transactions
        WHERE entity_type = 'Estimate' {where} GROUP BY qbo_id
    """), {"only": only} if only else {}).all()
    return {str(r[0]): r[1] for r in rows}


def _signatures(conn, only=None):
    """Cheap per-project fingerprint of everything _compose_estimates reads."""
    p = {"only": only} if only else {}
    sig = {}

    def add(rows):
        for r in rows:
            sig.setdefault(str(r[0]), []).append(tuple(str(x) for x in r[1:]))

    add(conn.execute(text(f"""
        SELECT s.entity_id, COUNT(m.id), MAX(m.updated_at), COALESCE(SUM(m.amount), 0), COUNT(DISTINCT s.id)
        FROM project_invoice_schedules s LEFT JOIN project_invoice_milestones m ON m.schedule_id = s.id
        {"WHERE s.entity_id = :only" if only else ""} GROUP BY s.entity_id
    """), p).all())
    add(conn.execute(text(f"""
        SELECT customer_qbo_id, MAX(id), COUNT(*) FROM qbo_transactions
        WHERE entity_type IN ('Invoice', 'Estimate') {"AND customer_qbo_id = :only" if only else ""}
        GROUP BY customer_qbo_id
    """), p).all())
    add(conn.execute(text(f"""
        SELECT entity_id, MAX(updated_at), COUNT(*) FROM project_estimate_billing
        {"WHERE entity_id = :only" if only else ""} GROUP BY entity_id
    """), p).all())
    return {k: tuple(sorted(v)) for k, v in sig.items()}


def _needs_setup(conn, only=None):
    """Active/upcoming projects with an accepted estimate that has no invoice
    schedule yet — the same gap Billing & Schedule fills when it's opened."""
    rows = conn.execute(text(f"""
        SELECT DISTINCT t.customer_qbo_id
        FROM qbo_transactions t
        JOIN qbo_customers qc ON qc.qbo_id = t.customer_qbo_id AND qc.is_project = 1
        WHERE t.entity_type = 'Estimate' AND t.total_amt > 0
          AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted')
          AND NOT EXISTS (SELECT 1 FROM project_invoice_schedules s
                          WHERE s.entity_id = t.customer_qbo_id AND s.estimate_qbo_id = t.qbo_id)
          {"AND t.customer_qbo_id = :only" if only else ""}
    """), {"only": only} if only else {}).all()
    return [str(r[0]) for r in rows]


def _setup(entity_id):
    """Run Billing & Schedule's create-if-missing steps (billing headers + one
    invoice schedule per accepted estimate) so both screens show the same plan."""
    with engine.begin() as conn:
        ctx = _project_ctx(conn, entity_id)
        if not ctx:
            return
        meta = _project_meta(conn, entity_id) or {}
        _ensure_estimate_billing(conn, entity_id, _default_crew_for_project(conn, entity_id, meta))
        _apply_assignment_default_crew(conn, entity_id)
        _ensure_invoice_schedules(conn, entity_id, ctx)


def _billing(conn, entity_id, sig):
    with _cache_lock:
        hit = _cache.get(entity_id)
    if hit and hit[0] == sig:
        return hit[1]
    comp = _compose_estimates(conn, entity_id)
    with _cache_lock:
        _cache[entity_id] = (sig, comp)
    return comp


# ── row composition ─────────────────────────────────────────────────────────
def _row(eid, proj, sched, pms, est_dates, comp, today):
    status = (sched["status"] if sched else None) or "needs_attention"
    start = _d(sched["start_date"]) if sched else None
    end = _d(sched["true_end"] or sched["end_date"]) if sched else None
    days = None
    if start and end:
        days = (date.fromisoformat(end) - date.fromisoformat(start)).days + 1

    estimates, milestones = [], []
    for a in comp.get("accepted", []):
        ms = []
        for m in a.get("milestones", []):
            # A partly-sent invoice whose leftover is rounding-sized counts as sent.
            left = float(m.get("remaining") or 0)
            if m["tier"] == "partial" and left < max(100.0, 0.01 * float(m.get("amount") or 0)):
                m = {**m, "tier": "committed", "status_label": "Sent · A/R"}
            unbilled = m["tier"] in ("scheduled", "partial")
            inv = m.get("invoice_date")
            flag = None
            if unbilled and inv and inv < today.isoformat():
                flag = "overdue_send"
            elif unbilled and inv and inv <= (today + timedelta(days=SOON_DAYS)).isoformat():
                flag = "send_soon"
            elif m["tier"] in ("committed", "partial") and m.get("due_date") and m["due_date"] < today.isoformat():
                flag = "payment_late"
            mm = {k: m.get(k) for k in ("id", "seq", "label", "pct", "amount", "invoice_date", "due_date",
                                         "expected_paid_date", "tier", "status_label", "edited", "remaining")}
            mm["flag"] = flag
            mm["estimate_doc"] = a.get("doc")
            ms.append(mm)
            milestones.append(mm)
        acts = a.get("invoice_actuals") or []
        e_inv = round(sum(float(x.get("amount") or 0) for x in acts), 2)
        e_open = round(sum(float(x.get("balance") or 0) for x in acts), 2)
        estimates.append({
            "qbo_id": a["qbo_id"], "doc": a.get("doc"), "date": _d(est_dates.get(str(a["qbo_id"]))),
            "value": a.get("value") or 0, "schedule_id": a.get("schedule_id"),
            "scheduled": a.get("invoice_subtotal") or 0,
            "invoiced": e_inv, "paid": round(e_inv - e_open, 2), "open_ar": e_open,
            "to_bill": round(max(0.0, (a.get("value") or 0) - e_inv), 2),
            "milestones": ms,
            "invoices": [{
                "doc": x.get("doc_number"), "date": x.get("txn_date"), "due": x.get("due_date"),
                "amount": x.get("amount"), "balance": x.get("balance"), "status": x.get("status"),
                "late": bool(float(x.get("balance") or 0) > 0.01 and x.get("due_date")
                             and str(x.get("due_date")) < today.isoformat()),
                "estimate_doc": x.get("estimate_doc"),
            } for x in acts],
        })

    contract = round(sum(e["value"] for e in estimates), 2)
    invoiced = round(float(comp.get("invoiced_qbo") or 0), 2)
    open_ar = round(float(comp.get("open_ar") or 0), 2)
    collected = round(float(comp.get("collected") or 0), 2)
    remaining = round(max(0.0, contract - invoiced), 2)
    flags = sorted({m["flag"] for m in milestones if m["flag"]})
    pending = comp.get("pending") or []
    if pending:
        flags.append("pending_estimate")
    unbilled = sorted((m for m in milestones if m["tier"] in ("scheduled", "partial") and m.get("invoice_date")),
                      key=lambda m: m["invoice_date"])
    nxt = unbilled[0] if unbilled else None
    past = status in PAST_STATUSES
    relevant = (not past) or open_ar > 0.5 or bool({"overdue_send", "send_soon", "payment_late"} & set(flags))
    name = proj["display_name"] or ""
    num = name.split(" - ")[0].strip() if " - " in name else ""
    return {
        "entity_id": eid, "qc_id": proj.get("qc_id"), "name": name, "number": num, "customer": proj.get("customer"),
        "status": status, "past": past, "relevant": relevant,
        "pms": pms, "start": start, "end": end, "days": days,
        "contract": contract, "invoiced": invoiced, "collected": collected, "open_ar": open_ar,
        "remaining": remaining, "pct_invoiced": round(invoiced / contract * 100, 1) if contract else None,
        "estimates": estimates, "pending_estimates": pending,
        "next": ({"label": nxt["label"], "date": nxt["invoice_date"], "amount": nxt.get("remaining") or nxt["amount"],
                  "flag": nxt["flag"]} if nxt else None),
        "flags": flags,
    }


def _build(only=None):
    today = date.today()
    with engine.connect() as conn:
        projs = _projects(conn, only)
        if only and not projs:
            return None
        sched = _schedule(conn, only)
        todo = [e for e in _needs_setup(conn, only)
                if e in projs and ((sched.get(e) or {}).get("status") or "needs_attention") not in PAST_STATUSES]
    for e in todo:
        try:
            _setup(e)
        except Exception:
            pass   # the row still renders from whatever exists
    with engine.connect() as conn:
        pms = _pms(conn, only)
        est_dates = _estimate_dates(conn, only)
        sigs = _signatures(conn, only)
        rows = []
        for eid, proj in projs.items():
            comp = _billing(conn, eid, sigs.get(eid, ()))
            rows.append(_row(eid, proj, sched.get(eid), pms.get(eid, []), est_dates, comp, today))
    return rows


# ── endpoints ───────────────────────────────────────────────────────────────
@router.get("/invoicing")
def invoicing(user=Depends(get_current_user)):
    _require(user)
    rows = _build()
    return {"today": date.today().isoformat(), "soon_days": SOON_DAYS, "rows": rows}


@router.get("/project/{entity_id}")
def project_row(entity_id: str, user=Depends(get_current_user)):
    _require(user)
    rows = _build(only=entity_id)
    if not rows:
        raise HTTPException(status_code=404, detail="Project not found")
    return rows[0]


@router.get("/project/{entity_id}/history")
def project_history(entity_id: str, user=Depends(get_current_user)):
    """Billing changes on this project (invoice lines + terms + crew splits):
    who, when, what changed — newest first."""
    _require(user)
    with engine.connect() as conn:
        ms_ids = [str(r[0]) for r in conn.execute(text("""
            SELECT m.id FROM project_invoice_milestones m
            JOIN project_invoice_schedules s ON s.id = m.schedule_id WHERE s.entity_id = :e
        """), {"e": entity_id}).all()]
        q = text(f"""
            SELECT a.id, a.action, a.target_type, a.target_id, a.target_label, a.detail, a.created_at,
                   COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,''))), ''),
                            a.actor_email) AS who
            FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
            WHERE (a.action LIKE 'billing.%' AND a.target_type = 'project' AND a.target_id = :e)
               OR (a.target_type = 'invoice_milestone' AND (
                     JSON_UNQUOTE(JSON_EXTRACT(a.detail, '$.entity_id')) = :e
                     {"OR a.target_id IN :ids" if ms_ids else ""}))
            ORDER BY a.id DESC LIMIT 200
        """)
        if ms_ids:
            q = q.bindparams(bindparam("ids", expanding=True))
        rows = conn.execute(q, {"e": entity_id, **({"ids": ms_ids} if ms_ids else {})}).mappings().all()
    out = []
    for r in rows:
        try:
            det = json.loads(r["detail"]) if r["detail"] else {}
        except Exception:
            det = {}
        out.append({"id": r["id"], "action": r["action"], "label": r["target_label"],
                    "who": r["who"], "at": str(r["created_at"]) if r["created_at"] else None,
                    "changes": det.get("changes"), "deleted": det.get("deleted"), "via": det.get("via")})
    return {"history": out}


@router.get("/pm-schedule")
def pm_schedule(user=Depends(get_current_user)):
    """Every active PM assignment: one entry per (PM, schedule item) with the
    item's window and the project's status — the per-PM table + timeline."""
    _require(user)
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT m.id AS pm_id, m.first_name, m.last_name, m.color,
                   qc.qbo_id, qc.display_name, psi.id AS item_id, psi.status,
                   psi.start_date, psi.end_date,
                   DATE_ADD(psi.end_date, INTERVAL COALESCE(psi.overage_days, 0) DAY) AS true_end,
                   MAX(spm.is_primary) AS is_primary
            FROM project_schedule_item_project_managers spm
            JOIN project_schedule_items psi ON psi.id = spm.schedule_item_id
            JOIN projects p ON p.id = psi.project_id
            JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
            JOIN project_managers m ON m.id = spm.project_manager_id
            WHERE spm.unassigned_at IS NULL AND m.is_active = 1
            GROUP BY m.id, m.first_name, m.last_name, m.color, qc.qbo_id, qc.display_name,
                     psi.id, psi.status, psi.start_date, psi.end_date, true_end
            ORDER BY m.first_name, m.last_name, psi.start_date
        """)).mappings().all()
    pms = {}
    for r in rows:
        pm = pms.setdefault(r["pm_id"], {
            "id": r["pm_id"], "name": f"{r['first_name'] or ''} {r['last_name'] or ''}".strip(),
            "initials": _initials(r["first_name"], r["last_name"]), "color": r["color"], "items": []})
        start, end = _d(r["start_date"]), _d(r["true_end"] or r["end_date"])
        pm["items"].append({
            "entity_id": str(r["qbo_id"]), "name": r["display_name"], "item_id": r["item_id"],
            "status": r["status"] or "needs_attention", "primary": bool(r["is_primary"]),
            "start": start, "end": end,
            "days": ((date.fromisoformat(end) - date.fromisoformat(start)).days + 1) if start and end else None,
        })
    return {"today": date.today().isoformat(), "pms": sorted(pms.values(), key=lambda p: p["name"])}


def _warm():
    """Build the per-project billing cache once at startup so the first visit
    after a deploy doesn't wait for every project to compose."""
    import time
    time.sleep(20)
    try:
        _build()
    except Exception:
        pass


threading.Thread(target=_warm, daemon=True).start()
