"""
Billing & Schedule bundle (Projects hub Phase 3a).

One read-only endpoint that turns a project into its full cash picture:

  * AUTO-GENERATES the three schedules from the estimate baseline + assignment
    dates the first time (invoices 35/35/30 net-30, crew bi-weekly in arrears,
    expenses per estimate cost category) — so schedules exist "within the
    project" without a manual click. Never overwrites: it only creates a
    schedule that has zero rows, so hand-edits made via the per-panel endpoints
    survive.
  * BURNS DOWN each schedule against QuickBooks actuals so every line carries a
    confidence tier:
        realized   — paid/received (already in the bank balance)
        committed  — a real QBO invoice/bill, still open (A/R, A/P)
        scheduled  — from the app schedule (estimate + assignment dates)
        estimated  — allocated, not yet dated/matched
  * Rolls up the anatomy KPIs (contract / collected / open A/R / unbilled /
    crew left / expenses left) the cash-flow forecast aggregates.

The existing /api/invoices, /api/payments, /api/expenses endpoints stay the
source of truth for editing individual lines; this bundle composes them for the
tab + auto-seeds. Gated by page.customers.
"""
import json
from datetime import date, timedelta
from math import ceil

from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text, bindparam

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS

from app.invoices.routes import DEFAULT_TERMS, _project_ctx
from app.expenses.routes import CATEGORIES, _estimate_costs_by_category, _expense_category
from app.payments.routes import (
    _project_meta, _crew_options, _crew_vendor, _qbo_payments,
    _even_split, _converted_estimates_with_labor, _load_schedules,
)
from app.projects.routes import _operational_status, _latest_status
from app.offers.routes import _offer_rows, _estimate_suggestions

router = APIRouter(prefix="/api/billing", tags=["billing"])

EPS = 0.5  # dollars of slop when tiering against QBO totals


def _require(user):
    if not has_capability(user, PAGE_CUSTOMERS):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _pd(s):
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def _weekly_split(total, start, end):
    """Total estimated expenses spread evenly across the weeks in the project
    window (last week carries the rounding). The expense cash-out schedule."""
    if not start or not end or end < start or total <= 0:
        return []
    days = (end - start).days
    num = max(1, ceil(days / 7)) if days > 0 else 1
    base = round(total / num, 2)
    out = []
    for i in range(1, num + 1):
        amt = base if i < num else round(total - base * (num - 1), 2)
        out.append({"seq": i, "week_of": str(start + timedelta(days=7 * (i - 1))), "amount": amt})
    return out


def _weekly_remaining_split(estimated, paid, start, end):
    """Forward-looking weekly cash-out: only what's LEFT to pay (estimated minus
    what's already been paid), spread across the weeks that haven't happened yet
    (from today, or the project start if it hasn't started). Keeps the cash-flow
    forecast accurate as bills come in — paid amounts drop out of the schedule."""
    remaining = round(max(0.0, float(estimated or 0) - float(paid or 0)), 2)
    if remaining <= 0 or not start or not end or end < start:
        return []
    today = date.today()
    span_start = start if today < start else (end if today > end else today)
    days = (end - span_start).days
    num = max(1, ceil(days / 7)) if days > 0 else 1
    base = round(remaining / num, 2)
    out = []
    for i in range(1, num + 1):
        amt = base if i < num else round(remaining - base * (num - 1), 2)
        out.append({"seq": i, "week_of": str(span_start + timedelta(days=7 * (i - 1))), "amount": amt})
    return out


# ---------------------------------------------------------------------------
# Project context: name, dates, contract value, books-closed
# ---------------------------------------------------------------------------
def _canonical_status(conn, entity_id):
    """The Billing tab shows the SAME status as the Projects hub / Assignment: the
    project's final assignment-row status (NOT a derived operational status). A
    project can have dates + a paid deposit yet still be 'not started' / 'pending'
    — the office's status is the source of truth."""
    return _latest_status(conn, entity_id)


# ---------------------------------------------------------------------------
# Auto-generation (create-if-missing; never overwrites existing rows)
# ---------------------------------------------------------------------------
def _ensure_invoice_schedule(conn, entity_id, ctx):
    sid = conn.execute(text("SELECT id FROM project_invoice_schedules WHERE entity_id = :e"),
                       {"e": entity_id}).scalar()
    if sid:
        return
    contract = float(ctx.get("contract_value") or 0)
    start, end = _pd(ctx.get("start_date")), _pd(ctx.get("end_date"))
    if contract <= 0:
        return  # no baseline yet -> nothing to schedule
    net_days = 30
    terms = f"35% at PO / 35% at start / 30% at end, net-{net_days}"
    date_for = {"po": start, "start": start, "end": end}
    sid = conn.execute(text("""
        INSERT INTO project_invoice_schedules (entity_id, contract_value, terms_note, net_days)
        VALUES (:e, :c, :t, :n)
    """), {"e": entity_id, "c": contract, "t": terms, "n": net_days}).lastrowid
    n, acc = len(DEFAULT_TERMS), 0.0
    for idx, (seq, label, pct, key) in enumerate(DEFAULT_TERMS):
        amt = round(contract * pct / 100.0, 2) if idx < n - 1 else round(contract - acc, 2)
        if idx < n - 1:
            acc += amt
        inv_d = date_for.get(key)
        due_d = (inv_d + timedelta(days=net_days)) if inv_d else None
        conn.execute(text("""
            INSERT INTO project_invoice_milestones
              (schedule_id, seq, label, pct, invoice_date, due_date, amount, status, note)
            VALUES (:s, :seq, :l, :p, :iv, :du, :a, 'pending', NULL)
        """), {"s": sid, "seq": seq, "l": label, "p": pct, "iv": inv_d, "du": due_d, "a": amt})


def _ensure_crew_schedules(conn, entity_id, ctx, meta):
    start, end = _pd(ctx.get("start_date")), _pd(ctx.get("end_date"))
    if not start or not end or end < start:
        return  # no timeline -> can't place bi-weekly installments
    default_crew = _default_crew_for_project(conn, entity_id, meta)
    # crew per estimate comes from the estimate's billing header (rollup key); the
    # per-estimate schedules are grouped by crew in the rollup view.
    for e in _estimates_for_billing(conn, entity_id):
        if e["status"] != "accepted" or e["labor"] <= 0:
            continue
        crew_id = e["crew_id"] or default_crew
        exists = conn.execute(text(
            "SELECT id FROM project_payment_schedules WHERE entity_id=:e AND estimate_qbo_id=:eq"),
            {"e": entity_id, "eq": e["qbo_id"]}).scalar()
        if exists:
            continue
        lead = 7
        rows = _even_split(float(e["labor"] or 0), start, end, lead)
        sid = conn.execute(text("""
            INSERT INTO project_payment_schedules
              (entity_id, estimate_qbo_id, estimate_doc_number, crew_id, contract_labor,
               start_date, end_date, invoice_lead_days)
            VALUES (:e,:eq,:dn,:c,:cl,:s,:en,:l)
        """), {"e": entity_id, "eq": e["qbo_id"], "dn": e["doc_number"], "c": crew_id,
               "cl": e["labor"], "s": start, "en": end, "l": lead}).lastrowid
        for r in rows:
            conn.execute(text("""
                INSERT INTO project_payment_installments
                  (schedule_id, seq, pay_date, amount, send_invoice_date, status, note)
                VALUES (:sid,:seq,:pd,:amt,:inv,:st,:nt)
            """), {"sid": sid, "seq": r["seq"], "pd": r["pay_date"], "amt": r["amount"],
                   "inv": r["send_invoice_date"], "st": r["status"], "nt": r["note"]})


def _ensure_expense_items(conn, entity_id, ctx):
    existing = conn.execute(text(
        "SELECT COUNT(*) FROM project_expense_items WHERE entity_id = :e"), {"e": entity_id}).scalar()
    if existing:
        return
    by_cat = _estimate_costs_by_category(conn, entity_id)
    if not by_cat:
        return
    start = _pd(ctx.get("start_date"))
    so = 0
    for cat, amt in by_cat.items():
        so += 1
        conn.execute(text("""
            INSERT INTO project_expense_items
              (entity_id, category, description, amount, expense_date, status, sort_order, note)
            VALUES (:e, :c, :d, :a, :dt, 'planned', :so, 'From estimate')
        """), {"e": entity_id, "c": cat, "d": f"{cat} (estimated)", "a": amt,
               "dt": start, "so": so})


# ---------------------------------------------------------------------------
# Slice 2: billing organized by ESTIMATE
#   Each accepted/converted estimate has a billing header (assigned crew +
#   confirmed) and its own 35/35/30 invoice schedule. The project rolls them up.
# ---------------------------------------------------------------------------
_EST_STATUS = {"Accepted": "accepted", "Converted": "accepted",
               "Pending": "pending", "Rejected": "declined", "Closed": "declined"}


def _estimates_for_billing(conn, entity_id):
    """Every estimate on the project with its value, Contract-Labor total, status,
    and its billing header (assigned crew + confirmed), if any."""
    rows = conn.execute(text("""
        SELECT t.qbo_id, t.doc_number, t.txn_date, t.total_amt AS value,
               ROUND(SUM(CASE WHEN sl.item_name='Contract Labor'
                              THEN COALESCE(sl.cost_amount, sl.amount) ELSE 0 END), 2) AS labor,
               JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) AS txn_status
        FROM qbo_transactions t
        LEFT JOIN qbo_sales_transaction_lines sl ON sl.transaction_id = t.id
        WHERE t.entity_type='Estimate' AND t.customer_qbo_id = :e
        GROUP BY t.qbo_id, t.doc_number, t.txn_date, t.total_amt, txn_status
        ORDER BY t.txn_date, t.doc_number
    """), {"e": entity_id}).mappings().all()
    hdrs = {str(r["estimate_qbo_id"]): r for r in conn.execute(text(
        "SELECT estimate_qbo_id, crew_id, confirmed FROM project_estimate_billing WHERE entity_id=:e"),
        {"e": entity_id}).mappings().all()}
    out = []
    for r in rows:
        h = hdrs.get(str(r["qbo_id"]))
        out.append({
            "qbo_id": str(r["qbo_id"]), "doc_number": r["doc_number"],
            "value": float(r["value"] or 0), "labor": float(r["labor"] or 0),
            "status": _EST_STATUS.get(r["txn_status"], (r["txn_status"] or "").lower()),
            "crew_id": (h["crew_id"] if h else None),
            "confirmed": (bool(h["confirmed"]) if h else False),
            "has_header": bool(h),
        })
    return out


def _default_crew_for_project(conn, entity_id, meta):
    """Crew to seed a new estimate's assignment: whatever crew is already on the
    project's payment schedules, else the suggested crew from the assignment."""
    c = conn.execute(text(
        "SELECT crew_id FROM project_payment_schedules WHERE entity_id=:e AND crew_id IS NOT NULL ORDER BY id LIMIT 1"),
        {"e": entity_id}).scalar()
    return c or (meta or {}).get("suggested_crew_id")


def _ensure_estimate_billing(conn, entity_id, default_crew_id):
    """Create a billing header for any accepted estimate that lacks one, inheriting
    the project's default crew. The estimates present when a project is FIRST set
    up are auto-confirmed (they're the known baseline); estimates that convert
    LATER — after headers already exist — arrive unconfirmed (= needs review), so
    the office knows something new showed up."""
    initial_setup = conn.execute(text(
        "SELECT COUNT(*) FROM project_estimate_billing WHERE entity_id=:e"), {"e": entity_id}).scalar() == 0
    for e in _estimates_for_billing(conn, entity_id):
        if e["status"] == "accepted" and not e["has_header"]:
            conn.execute(text("""
                INSERT INTO project_estimate_billing
                  (entity_id, estimate_qbo_id, estimate_doc_number, crew_id, confirmed,
                   confirmed_at)
                VALUES (:e, :eq, :dn, :c, :cf, CASE WHEN :cf=1 THEN NOW() ELSE NULL END)
            """), {"e": entity_id, "eq": e["qbo_id"], "dn": e["doc_number"],
                   "c": default_crew_id, "cf": 1 if initial_setup else 0})


def _ensure_invoice_schedules(conn, entity_id, ctx):
    """One 35/35/30 net-30 invoice schedule per accepted estimate (create-if-missing)."""
    start, end = _pd(ctx.get("start_date")), _pd(ctx.get("end_date"))
    date_for = {"po": start, "start": start, "end": end}
    net_days = 30
    for e in _estimates_for_billing(conn, entity_id):
        if e["status"] != "accepted" or e["value"] <= 0:
            continue
        exists = conn.execute(text(
            "SELECT id FROM project_invoice_schedules WHERE entity_id=:e AND estimate_qbo_id=:eq"),
            {"e": entity_id, "eq": e["qbo_id"]}).scalar()
        if exists:
            continue
        contract = e["value"]
        terms = f"35% PO / 35% start / 30% end, net-{net_days}"
        sid = conn.execute(text("""
            INSERT INTO project_invoice_schedules
              (entity_id, estimate_qbo_id, estimate_doc_number, contract_value, terms_note, net_days)
            VALUES (:e, :eq, :dn, :c, :t, :n)
        """), {"e": entity_id, "eq": e["qbo_id"], "dn": e["doc_number"],
               "c": contract, "t": terms, "n": net_days}).lastrowid
        n, acc = len(DEFAULT_TERMS), 0.0
        for idx, (seq, label, pct, key) in enumerate(DEFAULT_TERMS):
            amt = round(contract * pct / 100.0, 2) if idx < n - 1 else round(contract - acc, 2)
            if idx < n - 1:
                acc += amt
            inv_d = date_for.get(key)
            due_d = (inv_d + timedelta(days=net_days)) if inv_d else None
            conn.execute(text("""
                INSERT INTO project_invoice_milestones
                  (schedule_id, seq, label, pct, invoice_date, due_date, amount, status, note)
                VALUES (:s,:seq,:l,:p,:iv,:du,:a,'pending',NULL)
            """), {"s": sid, "seq": seq, "l": label, "p": pct, "iv": inv_d, "du": due_d, "a": amt})


def _compose_estimates(conn, entity_id):
    """The per-estimate billing view: each accepted estimate with its invoice
    schedule (tiered against QBO), plus the pending tray and a needs-review count.
    Invoice milestones tier by a single project-wide burn-down (collected fills the
    earliest invoice dates, then invoiced-A/R, then scheduled) since QBO invoices
    aren't reliably tagged per estimate."""
    ests = _estimates_for_billing(conn, entity_id)
    invoiced, open_ar = _qbo_invoiced(conn, entity_id)
    collected = round(invoiced - open_ar, 2)

    # actual QBO invoices grouped by the estimate they're linked to (LinkedTxn),
    # and each estimate's own crew payment installments — both shown per estimate.
    actuals_by_est = {}
    for a in _actual_invoices(conn, entity_id):
        actuals_by_est.setdefault(str(a.get("estimate_doc") or ""), []).append(a)
    crew_map = _load_schedules(conn, entity_id)  # keyed by estimate_qbo_id

    # load per-estimate invoice schedules + milestones
    scheds = {}
    for s in conn.execute(text(
        "SELECT id, estimate_qbo_id FROM project_invoice_schedules WHERE entity_id=:e AND estimate_qbo_id IS NOT NULL"),
        {"e": entity_id}).mappings().all():
        ms = conn.execute(text("""
            SELECT id, seq, label, pct, invoice_date, due_date, amount, status, note, edited
            FROM project_invoice_milestones WHERE schedule_id=:sid ORDER BY seq, id
        """), {"sid": s["id"]}).mappings().all()
        scheds[str(s["estimate_qbo_id"])] = (s["id"], ms)

    # global burn-down across all milestones by invoice date
    flat = []
    for eq, (sid, ms) in scheds.items():
        for m in ms:
            flat.append(m)
    flat.sort(key=lambda m: (str(m["invoice_date"] or "9999"), m["seq"] or 0))
    tier_by, cum = {}, 0.0
    for m in flat:
        amt = float(m["amount"] or 0)
        tier_by[m["id"]] = ("realized" if cum + amt <= collected + EPS
                            else "committed" if cum + amt <= invoiced + EPS else "scheduled")
        cum += amt

    def _ms_out(m):
        t = tier_by.get(m["id"], "scheduled")
        return {
            "id": m["id"], "seq": m["seq"], "label": m["label"], "pct": float(m["pct"] or 0),
            "invoice_date": str(m["invoice_date"]) if m["invoice_date"] else None,
            "due_date": str(m["due_date"]) if m["due_date"] else None,
            "amount": float(m["amount"] or 0), "tier": t, "edited": bool(m["edited"]),
            "status_label": {"realized": "Paid", "committed": "Sent · A/R"}.get(t, "To bill"),
        }

    accepted, pending, needs_review = [], [], 0
    for e in ests:
        if e["status"] == "pending":
            pending.append({"qbo_id": e["qbo_id"], "doc": e["doc_number"], "value": e["value"]})
            continue
        if e["status"] != "accepted":
            continue
        sid, ms = scheds.get(e["qbo_id"], (None, []))
        milestones = [_ms_out(m) for m in ms]
        if not e["confirmed"]:
            needs_review += 1
        cs, cinsts = crew_map.get(e["qbo_id"], (None, []))
        accepted.append({
            "qbo_id": e["qbo_id"], "doc": e["doc_number"], "value": e["value"],
            "labor": e["labor"], "confirmed": e["confirmed"], "crew_id": e["crew_id"],
            "schedule_id": sid, "milestones": milestones,
            "invoice_subtotal": round(sum(m["amount"] for m in milestones), 2),
            "invoice_actuals": actuals_by_est.get(str(e["doc_number"] or ""), []),
            "crew_schedule_id": (cs["id"] if cs else None),
            "crew_installments": cinsts,
        })
    return {
        "accepted": accepted, "pending": pending, "needs_review": needs_review,
        "invoiced_qbo": round(invoiced, 2), "collected": collected, "open_ar": round(open_ar, 2),
        "contract_total": round(sum(a["value"] for a in accepted), 2),
    }


# ---------------------------------------------------------------------------
# QBO burn-down
# ---------------------------------------------------------------------------
def _qbo_invoiced(conn, entity_id):
    """Latest-version invoices for this project customer -> (invoiced, open A/R)."""
    r = conn.execute(text("""
        WITH latest AS (
          SELECT qt.total_amt, qt.balance_amt,
                 ROW_NUMBER() OVER (
                   PARTITION BY qt.customer_qbo_id, COALESCE(qt.doc_number, qt.qbo_id)
                   ORDER BY qt.id DESC) AS rn
          FROM qbo_transactions qt
          WHERE qt.entity_type = 'Invoice' AND qt.customer_qbo_id = :e
        )
        SELECT COALESCE(SUM(total_amt),0) AS invoiced,
               COALESCE(SUM(balance_amt),0) AS open_ar
        FROM latest WHERE rn = 1
    """), {"e": entity_id}).mappings().first()
    invoiced = float(r["invoiced"] or 0)
    open_ar = float(r["open_ar"] or 0)
    return invoiced, open_ar


def _all_crew_vendor_ids(conn, entity_id):
    """Every crew vendor tied to the project — from its payment schedules AND from
    the crews assigned on the Assignment page. A project can have more than one
    crew (e.g. two installers), so crew burn-down must sum across all of them."""
    ids = set()
    crew_ids = set(conn.execute(text(
        "SELECT DISTINCT crew_id FROM project_payment_schedules WHERE entity_id=:e AND crew_id IS NOT NULL"),
        {"e": entity_id}).scalars().all())
    crew_ids |= set(conn.execute(text("""
        SELECT DISTINCT swc.work_crew_id
        FROM projects p JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        JOIN project_schedule_items psi ON psi.project_id = p.id
        JOIN project_schedule_item_work_crews swc
             ON swc.schedule_item_id = psi.id AND swc.unassigned_at IS NULL
        WHERE qc.qbo_id = :e AND swc.work_crew_id IS NOT NULL
    """), {"e": entity_id}).scalars().all())
    for cid in crew_ids:
        v = _crew_vendor(conn, cid)
        if v:
            ids.add(v)
    return ids


def _crew_labor_bills(conn, entity_id):
    """Actual crew cash = every 'Contract Labor' bill line tagged to this project,
    from ANY vendor. This is the reliable signal (verified across projects): it
    captures every crew that worked — even ones not registered in the app — and
    excludes non-labor lines a crew vendor might also bill (e.g. materials).
    Returns per-vendor/date rows; the total is what's been paid to crews."""
    rows = conn.execute(text("""
        SELECT t.txn_date, t.doc_number,
               JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.VendorRef.name')) AS vendor,
               ROUND(SUM(l.amount), 2) AS amt
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE l.line_customer_qbo_id = :e AND t.entity_type = 'Bill'
          AND JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')) = 'Contract Labor'
        GROUP BY t.id, t.txn_date, t.doc_number, vendor
        ORDER BY t.txn_date
    """), {"e": entity_id}).mappings().all()
    return [{"date": str(r["txn_date"]) if r["txn_date"] else None,
             "vendor": r["vendor"] or "Unknown vendor", "amount": float(r["amt"] or 0),
             "doc": r["doc_number"]} for r in rows]


def _estimate_docs(conn, entity_id):
    """qbo estimate id -> doc_number for this project (to tag actuals by estimate)."""
    return {str(r["qbo_id"]): r["doc_number"] for r in conn.execute(text(
        "SELECT qbo_id, doc_number FROM qbo_transactions WHERE entity_type='Estimate' AND customer_qbo_id=:e"),
        {"e": entity_id}).mappings().all()}


def _linked_estimate_doc(raw_json, est_docs):
    """Find the estimate a QBO doc was created from, via its LinkedTxn."""
    try:
        for l in (json.loads(raw_json or "{}").get("LinkedTxn") or []):
            if l.get("TxnType") == "Estimate":
                return est_docs.get(str(l.get("TxnId")))
    except Exception:
        pass
    return None


def _actual_invoices(conn, entity_id):
    """The real QBO invoices for this project — shown next to the planned
    milestones so office staff can compare plan vs. actual, tagged by estimate #."""
    est_docs = _estimate_docs(conn, entity_id)
    rows = conn.execute(text("""
        WITH latest AS (
          SELECT qt.doc_number, qt.txn_date, qt.due_date, qt.total_amt, qt.balance_amt, qt.raw_json,
                 ROW_NUMBER() OVER (PARTITION BY COALESCE(qt.doc_number, qt.qbo_id) ORDER BY qt.id DESC) AS rn
          FROM qbo_transactions qt
          WHERE qt.entity_type = 'Invoice' AND qt.customer_qbo_id = :e
        )
        SELECT doc_number, txn_date, due_date, total_amt, balance_amt, raw_json
        FROM latest WHERE rn = 1 ORDER BY txn_date, doc_number
    """), {"e": entity_id}).mappings().all()
    out = []
    for r in rows:
        total = float(r["total_amt"] or 0)
        bal = float(r["balance_amt"] or 0)
        out.append({
            "doc_number": r["doc_number"],
            "estimate_doc": _linked_estimate_doc(r["raw_json"], est_docs),
            "txn_date": str(r["txn_date"]) if r["txn_date"] else None,
            "due_date": str(r["due_date"]) if r["due_date"] else None,
            "amount": round(total, 2), "balance": round(bal, 2),
            "status": "Paid" if bal <= 0.01 else ("Partial" if bal < total else "Open"),
        })
    return out


def _actual_expenses(conn, entity_id):
    """Real QBO bills/purchases tagged to this project — the actual per-line spend,
    categorized by item / expense account. 'Contract Labor' lines (and margin
    items) are skipped here because they're crew payments, not project expenses —
    they belong to the crew section (any vendor, registered or not)."""
    rows = conn.execute(text("""
        SELECT t.txn_date, t.entity_type, t.vendor_qbo_id, t.doc_number,
               JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.VendorRef.name')) AS vendor,
               COALESCE(
                 JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')),
                 SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')), ':', 1)
               ) AS item_or_account,
               ROUND(SUM(l.amount), 2) AS amt
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE l.line_customer_qbo_id = :e AND t.entity_type IN ('Bill', 'Purchase')
        GROUP BY t.id, t.txn_date, t.entity_type, t.vendor_qbo_id, t.doc_number, vendor, item_or_account
        ORDER BY t.txn_date
    """), {"e": entity_id}).mappings().all()
    out = []
    for r in rows:
        cat = _expense_category(r["item_or_account"])
        if cat is None:
            continue  # Contract Labor / Buffer / OH&P — crew or margin, not an expense
        out.append({
            "date": str(r["txn_date"]) if r["txn_date"] else None,
            "vendor": r["vendor"] or "Unknown vendor", "amount": float(r["amt"] or 0),
            "type": r["entity_type"], "doc": r["doc_number"],
            "category": cat, "source_item": r["item_or_account"],
        })
    return out


def _project_offer(conn, entity_id):
    """Current crew job-offer state for the project (surfaced in the crew section)."""
    offers = _offer_rows(conn, "o.entity_id = :e", {"e": entity_id})
    accepted = next((o for o in offers if o["status"] == "accepted"), None)
    current = accepted or next((o for o in offers if o["status"] == "sent"), None)
    labor, scope = _estimate_suggestions(conn, entity_id)
    return {"current": current, "accepted": accepted,
            "suggested_labor": labor, "suggested_scope": scope}


def _qbo_expense_spend(conn, entity_id, crew_vendor_ids):
    """Bills/Purchases tagged to this project (line_customer_qbo_id) that are NOT
    the crew vendor(s) — i.e. materials/rentals/etc. actually spent to date."""
    rows = conn.execute(text("""
        SELECT COALESCE(t.vendor_qbo_id,'') AS v, ROUND(SUM(l.amount),2) AS amt
        FROM qbo_transaction_lines l
        JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE l.line_customer_qbo_id = :e AND t.entity_type IN ('Bill','Purchase')
        GROUP BY t.vendor_qbo_id
    """), {"e": entity_id}).mappings().all()
    excl = {str(v) for v in (crew_vendor_ids or []) if v}
    total = 0.0
    for r in rows:
        if str(r["v"]) in excl:
            continue
        total += float(r["amt"] or 0)
    return round(total, 2)


# ---------------------------------------------------------------------------
# Tiering
# ---------------------------------------------------------------------------
def _tier_by_burndown(amount, cum_before, paid, committed):
    """Given a line's amount and the cumulative amount before it, decide its tier
    by how far QBO's paid/committed totals reach down the stack."""
    cum_after = cum_before + amount
    if cum_after <= paid + EPS:
        return "realized"
    if cum_after <= committed + EPS:
        return "committed"
    return "scheduled"


# ---------------------------------------------------------------------------
# Compose
# ---------------------------------------------------------------------------
def _compose_invoices(conn, entity_id, books_closed):
    """Project-level invoice roll-up — aggregates ALL per-estimate schedules into
    the summary + flat milestone list the cash view uses. (Per-estimate breakdown
    is in _compose_estimates.)"""
    first = conn.execute(text(
        "SELECT id FROM project_invoice_schedules WHERE entity_id = :e ORDER BY id LIMIT 1"),
        {"e": entity_id}).scalar()
    ms = conn.execute(text("""
        SELECT m.* FROM project_invoice_milestones m
        JOIN project_invoice_schedules s ON s.id = m.schedule_id
        WHERE s.entity_id = :e
        ORDER BY m.invoice_date, m.seq, m.id
    """), {"e": entity_id}).mappings().all()
    estimate_total = round(sum(float(m["amount"] or 0) for m in ms), 2)
    invoiced, open_ar = _qbo_invoiced(conn, entity_id)
    paid = max(0.0, invoiced - open_ar)

    lines, cum = [], 0.0
    for m in ms:
        amt = float(m["amount"] or 0)
        tier = _tier_by_burndown(amt, cum, paid, invoiced)
        if books_closed and tier == "scheduled":
            tier = "realized"  # books closed: nothing left to bill on the plan
        cum += amt
        label = {"realized": "Paid", "committed": "Sent · A/R", "scheduled": "Scheduled"}[tier]
        lines.append({
            "id": m["id"], "seq": m["seq"], "label": m["label"], "pct": float(m["pct"] or 0),
            "invoice_date": str(m["invoice_date"]) if m["invoice_date"] else None,
            "due_date": str(m["due_date"]) if m["due_date"] else None,
            "amount": amt, "tier": tier, "status_label": label, "edited": bool(m["edited"]),
        })

    if books_closed:
        # Trust actuals: the "contract" for the bar is what was actually invoiced,
        # nothing is left to bill, and we surface the estimate-vs-actual variance.
        total = round(invoiced, 2)
        bar_paid = round(paid, 2)
        bar_ar = round(open_ar, 2)
        bar_sched = 0.0
    else:
        total = estimate_total
        bar_paid = round(min(paid, total), 2)
        bar_ar = round(max(0.0, min(invoiced, total) - bar_paid), 2)
        bar_sched = round(max(0.0, total - bar_paid - bar_ar), 2)
    return {
        "schedule_id": first,
        "contract_value": total,
        "estimate_total": estimate_total,
        "invoiced_qbo": round(invoiced, 2),
        "paid_qbo": round(paid, 2),
        "variance": round(invoiced - estimate_total, 2),
        "milestones": lines,
        "actuals": _actual_invoices(conn, entity_id),
        "summary": {"paid": bar_paid, "ar": bar_ar, "scheduled": bar_sched, "total": round(bar_paid + bar_ar + bar_sched, 2)},
    }


def _compose_crew(conn, entity_id, meta, crew_vendor_ids, books_closed):
    sched_map = _load_schedules(conn, entity_id)
    labor_bills = _crew_labor_bills(conn, entity_id)   # all crews, item-based
    paid = round(sum(b["amount"] for b in labor_bills), 2)

    # Sum installments that land on the same pay date across all of the project's
    # schedules (main estimate + change orders) — the cash view cares about total
    # crew cash per date, not per estimate.
    # Tier each installment by a single burn-down across the whole project (paid
    # QBO fills the earliest pay dates first). Installments are grouped by estimate
    # for display + editing, but the tiering order is global by pay_date.
    flat = []
    for est_qbo, (s, insts) in sched_map.items():
        for i in insts:
            flat.append((i, s))
    flat.sort(key=lambda x: (x[0].get("pay_date") or "9999", x[0].get("id") or 0))
    estimate_total = round(sum(float(i["amount"] or 0) for (i, _) in flat), 2)
    tier_by_id, cum = {}, 0.0
    for (i, _s) in flat:
        amt = float(i["amount"] or 0)
        tier_by_id[i["id"]] = "realized" if (books_closed or cum + amt <= paid + EPS) else "scheduled"
        cum += amt

    def _inst_out(i):
        t = tier_by_id.get(i["id"], "scheduled")
        return {
            "id": i["id"], "seq": i["seq"], "pay_date": i.get("pay_date"),
            "amount": float(i["amount"] or 0), "note": i.get("note"),
            "tier": t, "status_label": "Paid" if t == "realized" else "Scheduled",
            "edited": bool(i.get("edited")),
        }

    crew_name = None
    schedules, flat_lines = [], []
    for est_qbo, (s, insts) in sorted(sched_map.items(), key=lambda kv: (kv[1][0] or {}).get("estimate_doc_number") or ""):
        if not s:
            continue
        if s.get("crew_name"):
            crew_name = crew_name or s["crew_name"]
        out_insts = [_inst_out(i) for i in insts]
        flat_lines.extend(out_insts)
        schedules.append({
            "schedule_id": s["id"], "estimate_qbo_id": s.get("estimate_qbo_id"),
            "estimate_doc_number": s.get("estimate_doc_number"),
            "crew_id": s.get("crew_id"), "crew_name": s.get("crew_name"),
            "start_date": s.get("start_date"), "end_date": s.get("end_date"),
            "contract_labor": s.get("contract_labor"),
            "installments": out_insts,
            "subtotal": round(sum(x["amount"] for x in out_insts), 2),
        })

    if books_closed:
        total = round(paid, 2)          # actual paid is the truth
        bar_paid = round(paid, 2)
        bar_sched = 0.0
    else:
        total = estimate_total
        bar_paid = round(min(paid, total), 2)
        bar_sched = round(max(0.0, total - bar_paid), 2)
    # crews actually paid in QBO (any vendor) — surfaces multi-crew reality
    paid_by_vendor = {}
    for b in labor_bills:
        paid_by_vendor[b["vendor"]] = round(paid_by_vendor.get(b["vendor"], 0) + b["amount"], 2)
    return {
        "contract_labor": total,
        "estimate_total": estimate_total,
        "paid_qbo": round(paid, 2),
        "variance": round(paid - estimate_total, 2),
        "crew_name": crew_name,
        "schedules": schedules,       # grouped by estimate, each editable
        "installments": flat_lines,   # flattened, for the contribution strip
        "actuals": labor_bills,       # actual crew (Contract Labor) bills from QBO
        "paid_by_vendor": paid_by_vendor,
        "vendor_available": bool(crew_vendor_ids),
        "summary": {"paid": bar_paid, "scheduled": bar_sched, "total": round(bar_paid + bar_sched, 2)},
    }


def _compose_crew_rollups(conn, entity_id, books_closed):
    """Crew payments grouped into rollups by assigned crew: the per-estimate
    schedules for one crew are summed into a single lump per pay date, tiered
    against that crew's actual QBO Contract-Labor bills. Reassigning an estimate
    to another crew simply moves it to a different rollup group (the 3-and-1 case)."""
    from app.payments.routes import _crew_vendor
    sched_map = _load_schedules(conn, entity_id)
    paid_by_vid = {str(r["v"]): float(r["amt"] or 0) for r in conn.execute(text("""
        SELECT t.vendor_qbo_id AS v, ROUND(SUM(l.amount), 2) AS amt
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE l.line_customer_qbo_id = :e AND t.entity_type = 'Bill'
          AND JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')) = 'Contract Labor'
          AND t.vendor_qbo_id IS NOT NULL
        GROUP BY t.vendor_qbo_id
    """), {"e": entity_id}).mappings().all()}
    offers = _offer_rows(conn, "o.entity_id = :e", {"e": entity_id})

    groups = {}
    for eq, (s, insts) in sched_map.items():
        if not s:
            continue
        cid = s.get("crew_id")
        g = groups.setdefault(cid, {"crew_id": cid, "crew_name": s.get("crew_name"),
                                    "estimates": [], "labor": 0.0, "by_date": {}})
        g["estimates"].append({"doc": s.get("estimate_doc_number"), "qbo_id": eq,
                               "labor": round(float(s.get("contract_labor") or 0), 2)})
        g["labor"] = round(g["labor"] + float(s.get("contract_labor") or 0), 2)
        for i in insts:
            d = i.get("pay_date")
            if d:
                g["by_date"][d] = round(g["by_date"].get(d, 0.0) + float(i["amount"] or 0), 2)

    out = []
    for cid, g in groups.items():
        vid = _crew_vendor(conn, cid) if cid else None
        paid = paid_by_vid.get(str(vid), 0.0) if vid else 0.0
        installments, cum = [], 0.0
        for idx, d in enumerate(sorted(g["by_date"].keys())):
            amt = g["by_date"][d]
            tier = "realized" if (books_closed or cum + amt <= paid + EPS) else "scheduled"
            cum += amt
            installments.append({"seq": idx + 1, "pay_date": d, "amount": amt, "tier": tier,
                                 "status_label": "Paid" if tier == "realized" else "Scheduled"})
        crew_offer = next((o for o in offers if o["crew_id"] == cid and o["status"] in ("accepted", "sent")), None)
        out.append({
            "crew_id": cid, "crew_name": g["crew_name"],
            "estimates": sorted(g["estimates"], key=lambda x: x["doc"] or ""),
            "labor": g["labor"], "paid_qbo": round(paid, 2),
            "remaining": round(max(0.0, g["labor"] - paid), 2),
            "installments": installments, "offer": crew_offer,
        })
    out.sort(key=lambda x: -x["labor"])
    return {"rollups": out,
            "total_labor": round(sum(g["labor"] for g in out), 2),
            "total_paid": round(sum(g["paid_qbo"] for g in out), 2)}


def _compose_expenses(conn, entity_id, books_closed, start=None, end=None):
    items = conn.execute(text("""
        SELECT id, category, description, amount, expense_date, status, note, sort_order, edited
        FROM project_expense_items WHERE entity_id = :e ORDER BY sort_order, expense_date, id
    """), {"e": entity_id}).mappings().all()
    estimate_total = round(sum(float(i["amount"] or 0) for i in items), 2)
    actuals = _actual_expenses(conn, entity_id)
    # Spend = the real (non-crew) QBO bills/purchases we actually list as actuals,
    # so the bar and the drill-down always reconcile to the same number.
    spent = round(sum(a["amount"] for a in actuals), 2)

    lines = []
    for i in items:
        st = (i["status"] or "planned").lower()
        tier = {"paid": "realized", "ordered": "committed"}.get(st, "estimated")
        if books_closed:
            tier = "realized"
        lines.append({
            "id": i["id"], "category": i["category"], "description": i["description"],
            "amount": float(i["amount"] or 0),
            "expense_date": str(i["expense_date"]) if i["expense_date"] else None,
            "status": i["status"], "note": i["note"], "edited": bool(i["edited"]),
            "tier": tier,
            "status_label": {"realized": "Paid", "committed": "Bill · A/P"}.get(tier, "Allocated"),
        })

    # Overspend surfaces explicitly: if actual QBO spend exceeds the estimate, the
    # bar shows the estimate as spent + an "over" segment; otherwise estimate less
    # what's been spent is still "allocated".
    over = round(max(0.0, spent - estimate_total), 2)
    if books_closed:
        base = round(min(spent, estimate_total), 2) if estimate_total else 0.0
        bar_committed = base
        bar_allocated = 0.0
    else:
        bar_committed = round(min(spent, estimate_total), 2)
        bar_allocated = round(max(0.0, estimate_total - spent), 2)

    # Per-category estimated-vs-actual, so the UI can lay the two side by side.
    # Estimated = the expense schedule rows; actual = the categorized QBO bills.
    cat_est, cat_act = {}, {}
    for i in items:
        c = i["category"] or "Other"
        cat_est[c] = round(cat_est.get(c, 0.0) + float(i["amount"] or 0), 2)
    cat_acts = {}
    for a in actuals:
        c = a["category"] or "Other"
        cat_act[c] = round(cat_act.get(c, 0.0) + a["amount"], 2)
        cat_acts.setdefault(c, []).append(a)
    # Each category line carries its own weekly cash-out schedule (that category's
    # estimated total spread evenly across the project weeks) + its actual bills,
    # so the UI can show estimated-vs-actual, then the weekly plan, then a drill-in.
    by_category = [
        {"category": c, "estimated": round(cat_est.get(c, 0.0), 2),
         "actual": round(cat_act.get(c, 0.0), 2),
         "variance": round(cat_act.get(c, 0.0) - cat_est.get(c, 0.0), 2),
         "remaining": round(max(0.0, cat_est.get(c, 0.0) - cat_act.get(c, 0.0)), 2),
         "weekly": _weekly_remaining_split(cat_est.get(c, 0.0), cat_act.get(c, 0.0), start, end),
         "actuals": cat_acts.get(c, [])}
        for c in sorted(set(cat_est) | set(cat_act))
    ]
    return {
        "estimate_total": estimate_total,
        "spent_qbo": round(spent, 2),
        "over": over,
        "variance": round(spent - estimate_total, 2),
        "items": lines,
        "actuals": actuals,
        "by_category": by_category,
        "categories": CATEGORIES,
        "summary": {"committed": bar_committed, "allocated": bar_allocated, "over": over,
                    "total": estimate_total},
    }


@router.post("/project/{entity_id}/regenerate")
def regenerate(entity_id: str, force: bool = False, user=Depends(get_current_user)):
    """Refresh the schedules from the current estimate + assignment dates.

    Default (Refresh): edit-PRESERVING — a schedule that has any hand-edited row
    is left untouched; only untouched schedules are rebuilt, and brand-new
    estimates get their schedule created. This is what the app calls when it
    detects drift, so the office rarely has to think about it.

    force=true (Rebuild all): discard everything and rebuild from scratch.
    """
    _require(user)
    with engine.begin() as conn:
        ctx = _project_ctx(conn, entity_id)
        if not ctx:
            raise HTTPException(status_code=404, detail="Project not found")
        meta = _project_meta(conn, entity_id) or {}

        # invoices — per estimate schedule; rebuild each unless a milestone was hand-edited
        for isid in conn.execute(text("SELECT id FROM project_invoice_schedules WHERE entity_id=:e"),
                                 {"e": entity_id}).scalars().all():
            inv_edited = conn.execute(text(
                "SELECT MAX(edited) FROM project_invoice_milestones WHERE schedule_id=:s"), {"s": isid}).scalar()
            if force or not inv_edited:
                conn.execute(text("DELETE FROM project_invoice_milestones WHERE schedule_id=:s"), {"s": isid})
                conn.execute(text("DELETE FROM project_invoice_schedules WHERE id=:s"), {"s": isid})

        # crew — per estimate schedule; keep any that has an edited installment
        for cs in conn.execute(text("SELECT id FROM project_payment_schedules WHERE entity_id=:e"),
                               {"e": entity_id}).scalars().all():
            cs_edited = conn.execute(text(
                "SELECT MAX(edited) FROM project_payment_installments WHERE schedule_id=:s"), {"s": cs}).scalar()
            if force or not cs_edited:
                conn.execute(text("DELETE FROM project_payment_installments WHERE schedule_id=:s"), {"s": cs})
                conn.execute(text("DELETE FROM project_payment_schedules WHERE id=:s"), {"s": cs})

        # expenses — keep if any item was hand-edited
        exp_edited = conn.execute(text(
            "SELECT MAX(edited) FROM project_expense_items WHERE entity_id=:e"), {"e": entity_id}).scalar()
        if force or not exp_edited:
            conn.execute(text("DELETE FROM project_expense_items WHERE entity_id=:e"), {"e": entity_id})

        # re-create whatever is now missing (untouched-and-cleared, or brand-new estimate)
        _ensure_estimate_billing(conn, entity_id, _default_crew_for_project(conn, entity_id, meta))
        _ensure_invoice_schedules(conn, entity_id, ctx)
        _ensure_crew_schedules(conn, entity_id, ctx, meta)
        _ensure_expense_items(conn, entity_id, ctx)
    return get_bundle(entity_id, user)


@router.post("/project/{entity_id}/mark-complete")
def mark_complete(entity_id: str, user=Depends(get_current_user)):
    """Office confirms the project is done: mark every schedule item complete,
    which flips the canonical status to 'complete' and closes the books (figures
    reconcile to actuals). Reachable from the "appears complete" review banner."""
    _require(user)
    with engine.begin() as conn:
        if not _project_ctx(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        conn.execute(text("""
            UPDATE project_schedule_items psi
            JOIN projects p ON p.id = psi.project_id
            JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
            SET psi.status = 'completed'
            WHERE qc.qbo_id = :e
        """), {"e": entity_id})
    return get_bundle(entity_id, user)


@router.post("/project/{entity_id}/estimate/{estimate_qbo_id}/confirm")
def confirm_estimate(entity_id: str, estimate_qbo_id: str, user=Depends(get_current_user)):
    """Office reviewed a (newly-converted) estimate's invoice schedule + crew
    assignment and confirms it — clears the 'needs review' state."""
    _require(user)
    with engine.begin() as conn:
        n = conn.execute(text("""
            UPDATE project_estimate_billing SET confirmed=1, confirmed_at=NOW(), confirmed_by_user_id=:u
            WHERE entity_id=:e AND estimate_qbo_id=:eq
        """), {"u": user.get("id"), "e": entity_id, "eq": estimate_qbo_id}).rowcount
    if not n:
        raise HTTPException(status_code=404, detail="Estimate billing header not found")
    return get_bundle(entity_id, user)


class EstimateCrewAssign(BaseModel):
    crew_id: Optional[int] = None


@router.post("/project/{entity_id}/estimate/{estimate_qbo_id}/crew")
def assign_estimate_crew(entity_id: str, estimate_qbo_id: str, body: EstimateCrewAssign,
                         user=Depends(get_current_user)):
    """Assign an estimate to a work crew — the rollup key. Updates the billing
    header and the estimate's payment schedule so it regroups into that crew's
    rollup (this is how the 3-and-1 split is created)."""
    _require(user)
    with engine.begin() as conn:
        n = conn.execute(text("""
            UPDATE project_estimate_billing SET crew_id=:c
            WHERE entity_id=:e AND estimate_qbo_id=:eq
        """), {"c": body.crew_id, "e": entity_id, "eq": estimate_qbo_id}).rowcount
        if not n:
            raise HTTPException(status_code=404, detail="Estimate billing header not found")
        conn.execute(text("""
            UPDATE project_payment_schedules SET crew_id=:c
            WHERE entity_id=:e AND estimate_qbo_id=:eq
        """), {"c": body.crew_id, "e": entity_id, "eq": estimate_qbo_id})
    return get_bundle(entity_id, user)


def _drift_reasons(conn, entity_id, ctx, inv):
    """Has the schedule fallen out of sync with the current dates / estimate?
    Only flags UNEDITED schedules (edited ones are intentionally preserved)."""
    reasons = []
    cur_start, cur_end = ctx.get("start_date"), ctx.get("end_date")
    if cur_start and cur_end:
        for (s, insts) in _load_schedules(conn, entity_id).values():
            if not s:
                continue
            if any(i.get("edited") for i in insts):
                continue
            if s.get("start_date") != cur_start or s.get("end_date") != cur_end:
                reasons.append("Assignment dates changed since the crew schedule was built")
                break
    cur_contract = ctx.get("contract_value")
    inv_edited = any(m.get("edited") for m in inv["milestones"])
    if cur_contract and not inv_edited and abs(float(cur_contract) - inv["estimate_total"]) > 1:
        reasons.append("Estimate value changed since the invoice schedule was built")
    return reasons


@router.get("/project/{entity_id}")
def get_bundle(entity_id: str, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        ctx = _project_ctx(conn, entity_id)
        if not ctx:
            raise HTTPException(status_code=404, detail="Project not found")
        meta = _project_meta(conn, entity_id) or {}

        # auto-generate schedules the first time (create-if-missing)
        _ensure_estimate_billing(conn, entity_id, _default_crew_for_project(conn, entity_id, meta))
        _ensure_invoice_schedules(conn, entity_id, ctx)   # per estimate (35/35/30)
        _ensure_crew_schedules(conn, entity_id, ctx, meta)
        _ensure_expense_items(conn, entity_id, ctx)

        # Status = the project's final assignment-row status (same as the hub).
        # Books close ONLY when the office marks the project completed — not when
        # invoices happen to be paid.
        op_status = _canonical_status(conn, entity_id)
        has_dates = bool(ctx.get("start_date") and ctx.get("end_date"))
        books_closed = op_status == "completed"

        crew_vendor_ids = _all_crew_vendor_ids(conn, entity_id)
        inv = _compose_invoices(conn, entity_id, books_closed)
        crew = _compose_crew(conn, entity_id, meta, crew_vendor_ids, books_closed)
        crew["offer"] = _project_offer(conn, entity_id)
        # Already-started projects: the offer was accepted historically (in Google
        # Drive), so there's no app offer record — infer the working crew from the
        # real QBO bills so the office can one-click backfill an accepted offer.
        offers_exist = conn.execute(text(
            "SELECT COUNT(*) FROM work_offers WHERE entity_id=:e"), {"e": entity_id}).scalar()
        assigned = next((s for s in crew.get("schedules", []) if s.get("crew_id")), None)
        crew["offer"].update({
            "has_record": bool(offers_exist),
            "started": crew["paid_qbo"] > 0.5,
            "working": [{"vendor": v, "amount": a} for v, a in
                        sorted((crew.get("paid_by_vendor") or {}).items(), key=lambda kv: -kv[1])],
            "assigned_crew": ({"crew_id": assigned["crew_id"], "crew_name": assigned["crew_name"]}
                              if assigned else None),
        })
        exp = _compose_expenses(conn, entity_id, books_closed,
                                _pd(ctx.get("start_date")), _pd(ctx.get("end_date")))
        estimates = _compose_estimates(conn, entity_id)
        crew_rollups = _compose_crew_rollups(conn, entity_id, books_closed)
        crews = _crew_options(conn)
        drift = _drift_reasons(conn, entity_id, ctx, inv)

    kpis = {
        "contract": inv["summary"]["total"],
        "collected": inv["summary"]["paid"],
        "open_ar": inv["summary"]["ar"],
        "unbilled": inv["summary"]["scheduled"],
        "crew_left": crew["summary"]["scheduled"],
        "expenses_left": exp["summary"]["allocated"],
    }

    # "Looks complete" review flag: fully invoiced AND fully paid, but not yet
    # marked complete. Office reviews + confirms (late bills / under-runs mean we
    # never auto-close).
    appears_complete = (op_status != "complete" and inv["invoiced_qbo"] > 0
                        and inv["summary"]["ar"] < 1 and inv["summary"]["scheduled"] < 1)

    return {
        "project": {
            "id": entity_id, "name": ctx["name"],
            "customer_name": meta.get("customer_name"),
            "start_date": ctx.get("start_date"), "end_date": ctx.get("end_date"),
            "contract_value": ctx.get("contract_value"),
            "has_dates": has_dates, "books_closed": books_closed,
            "operational_status": op_status,
            "appears_complete": appears_complete,
            "drift": drift,
        },
        "invoices": inv,
        "crew": crew,
        "expenses": exp,
        "estimates": estimates,
        "crew_rollups": crew_rollups,
        "kpis": kpis,
        "crews": crews,
    }
