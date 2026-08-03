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
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text, bindparam

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS

from app.invoices.routes import DEFAULT_TERMS, _project_ctx
from app.expenses.routes import CATEGORIES, _estimate_costs_by_category
from app.payments.routes import (
    _project_meta, _crew_options, _crew_vendor, _qbo_payments,
    _even_split, _converted_estimates_with_labor, _load_schedules,
)
from app.projects.routes import _operational_status
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


# ---------------------------------------------------------------------------
# Project context: name, dates, contract value, books-closed
# ---------------------------------------------------------------------------
def _canonical_status(conn, entity_id):
    """The SAME project-grain operational status the Projects hub shows — so the
    Billing tab never disagrees with Assignment. Gathers the schedule-item
    statuses + PM/crew presence and runs the shared _operational_status()."""
    r = conn.execute(text("""
        SELECT
          GROUP_CONCAT(DISTINCT psi.status) AS all_statuses,
          MIN(psi.start_date)               AS start_date,
          COUNT(psi.id)                     AS n_items,
          MAX(CASE WHEN spm.id IS NOT NULL THEN 1 ELSE 0 END) AS has_pm,
          MAX(CASE WHEN swc.id IS NOT NULL THEN 1 ELSE 0 END) AS has_crew
        FROM projects p
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        LEFT JOIN project_schedule_items psi ON psi.project_id = p.id
        LEFT JOIN project_schedule_item_project_managers spm
               ON spm.schedule_item_id = psi.id AND spm.unassigned_at IS NULL
        LEFT JOIN project_schedule_item_work_crews swc
               ON swc.schedule_item_id = psi.id AND swc.unassigned_at IS NULL
        WHERE qc.qbo_id = :e
    """), {"e": entity_id}).mappings().first()
    statuses = (r["all_statuses"] or "") if r else ""
    stset = {s.strip() for s in statuses.split(",") if s.strip()}
    needs = (not r or (r["n_items"] or 0) == 0 or not stset or stset <= {"needs_attention"})
    p = {
        "needs_assignment": needs,
        "all_statuses": statuses,
        "start_date": r["start_date"] if r else None,
        "primary_project_manager": "x" if (r and r["has_pm"]) else "",
        "primary_work_crew": "x" if (r and r["has_crew"]) else "",
    }
    return _operational_status(p)


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
    crew_id = meta.get("suggested_crew_id")
    for e in _converted_estimates_with_labor(conn, entity_id):
        exists = conn.execute(text(
            "SELECT id FROM project_payment_schedules WHERE entity_id=:e AND estimate_qbo_id=:eq"),
            {"e": entity_id, "eq": e["qbo_id"]}).scalar()
        if exists:
            continue
        lead = 7
        rows = _even_split(float(e["contract_labor"] or 0), start, end, lead)
        sid = conn.execute(text("""
            INSERT INTO project_payment_schedules
              (entity_id, estimate_qbo_id, estimate_doc_number, crew_id, contract_labor,
               start_date, end_date, invoice_lead_days)
            VALUES (:e,:eq,:dn,:c,:cl,:s,:en,:l)
        """), {"e": entity_id, "eq": e["qbo_id"], "dn": e["doc_number"], "c": crew_id,
               "cl": e["contract_labor"], "s": start, "en": end, "l": lead}).lastrowid
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


def _qbo_crew_paid(conn, entity_id, vendor_ids):
    """Actual crew cash = Bill lines tagged to this project from ANY of the crew
    vendors (bi-weekly payroll bills split across projects)."""
    if not vendor_ids:
        return 0.0
    amt = conn.execute(text("""
        SELECT ROUND(SUM(l.amount), 2)
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE l.line_customer_qbo_id = :e AND t.entity_type = 'Bill'
          AND t.vendor_qbo_id IN :vs
    """).bindparams(bindparam("vs", expanding=True)),
        {"e": entity_id, "vs": list(vendor_ids)}).scalar()
    return float(amt or 0)


def _actual_invoices(conn, entity_id):
    """The real QBO invoices for this project — shown next to the planned
    milestones so office staff can compare plan vs. actual."""
    rows = conn.execute(text("""
        WITH latest AS (
          SELECT qt.doc_number, qt.txn_date, qt.due_date, qt.total_amt, qt.balance_amt,
                 ROW_NUMBER() OVER (PARTITION BY COALESCE(qt.doc_number, qt.qbo_id) ORDER BY qt.id DESC) AS rn
          FROM qbo_transactions qt
          WHERE qt.entity_type = 'Invoice' AND qt.customer_qbo_id = :e
        )
        SELECT doc_number, txn_date, due_date, total_amt, balance_amt
        FROM latest WHERE rn = 1 ORDER BY txn_date, doc_number
    """), {"e": entity_id}).mappings().all()
    out = []
    for r in rows:
        total = float(r["total_amt"] or 0)
        bal = float(r["balance_amt"] or 0)
        out.append({
            "doc_number": r["doc_number"],
            "txn_date": str(r["txn_date"]) if r["txn_date"] else None,
            "due_date": str(r["due_date"]) if r["due_date"] else None,
            "amount": round(total, 2), "balance": round(bal, 2),
            "status": "Paid" if bal <= 0.01 else ("Partial" if bal < total else "Open"),
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
    sched = conn.execute(text(
        "SELECT * FROM project_invoice_schedules WHERE entity_id = :e"), {"e": entity_id}).mappings().first()
    ms = []
    if sched:
        ms = conn.execute(text(
            "SELECT * FROM project_invoice_milestones WHERE schedule_id = :s ORDER BY seq, id"),
            {"s": sched["id"]}).mappings().all()
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
        "schedule_id": sched["id"] if sched else None,
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
    paid = _qbo_crew_paid(conn, entity_id, crew_vendor_ids)

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
    return {
        "contract_labor": total,
        "estimate_total": estimate_total,
        "paid_qbo": round(paid, 2),
        "variance": round(paid - estimate_total, 2),
        "crew_name": crew_name,
        "schedules": schedules,       # grouped by estimate, each editable
        "installments": flat_lines,   # flattened, for the contribution strip
        "vendor_available": bool(crew_vendor_ids),
        "summary": {"paid": bar_paid, "scheduled": bar_sched, "total": round(bar_paid + bar_sched, 2)},
    }


def _compose_expenses(conn, entity_id, crew_vendor_ids, books_closed):
    items = conn.execute(text("""
        SELECT id, category, description, amount, expense_date, status, note, sort_order, edited
        FROM project_expense_items WHERE entity_id = :e ORDER BY sort_order, expense_date, id
    """), {"e": entity_id}).mappings().all()
    estimate_total = round(sum(float(i["amount"] or 0) for i in items), 2)
    spent = _qbo_expense_spend(conn, entity_id, crew_vendor_ids)

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
    return {
        "estimate_total": estimate_total,
        "spent_qbo": round(spent, 2),
        "over": over,
        "variance": round(spent - estimate_total, 2),
        "items": lines,
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

        # invoices — rebuild unless a milestone was hand-edited (or force)
        sid = conn.execute(text("SELECT id FROM project_invoice_schedules WHERE entity_id=:e"),
                           {"e": entity_id}).scalar()
        if sid:
            inv_edited = conn.execute(text(
                "SELECT MAX(edited) FROM project_invoice_milestones WHERE schedule_id=:s"), {"s": sid}).scalar()
            if force or not inv_edited:
                conn.execute(text("DELETE FROM project_invoice_milestones WHERE schedule_id=:s"), {"s": sid})
                conn.execute(text("DELETE FROM project_invoice_schedules WHERE id=:s"), {"s": sid})

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
        _ensure_invoice_schedule(conn, entity_id, ctx)
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

        # auto-generate the three schedules the first time (create-if-missing)
        _ensure_invoice_schedule(conn, entity_id, ctx)
        _ensure_crew_schedules(conn, entity_id, ctx, meta)
        _ensure_expense_items(conn, entity_id, ctx)

        # Canonical status (same as the Projects hub / Assignment) drives books-closed.
        op_status = _canonical_status(conn, entity_id)
        has_dates = bool(ctx.get("start_date") and ctx.get("end_date"))
        if op_status == "needs_assignment" and not has_dates:
            op_status = "needs_dates"
        books_closed = op_status == "complete"

        crew_vendor_ids = _all_crew_vendor_ids(conn, entity_id)
        inv = _compose_invoices(conn, entity_id, books_closed)
        crew = _compose_crew(conn, entity_id, meta, crew_vendor_ids, books_closed)
        crew["offer"] = _project_offer(conn, entity_id)
        exp = _compose_expenses(conn, entity_id, crew_vendor_ids, books_closed)
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
        "kpis": kpis,
        "crews": crews,
    }
