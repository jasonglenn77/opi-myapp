"""
Project expense schedule (Projects hub Phase 2, Billing & Schedule).

The office plans expected non-labor outflows across the project timeline —
materials, rentals, lodging, propane, travel — each dated so they feed the
cashflow OUTflows (Phase 3). Crew labor lives in the crew payment schedule.
Keyed by project qbo_id (entity_id). Gated by page.customers.

"Seed from estimate" pre-populates from the estimate's per-item cost lines
(YOUR-RATE cost_amount) so the office starts from the quoted expected costs.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import text

from app.db import engine
from app.auth import get_current_user
from app.permissions import has_capability, PAGE_CUSTOMERS

router = APIRouter(prefix="/api/expenses", tags=["expenses"])

CATEGORIES = ["Materials", "Rentals", "Lodging", "Propane", "Travel", "Other"]

# Estimate cost lines that are NOT real project expenses: Contract Labor is the
# crew payment schedule; Buffer / OH&P are margin, not outflows.
# Crew/margin line items are NOT project expenses. QBO now has naming variants
# ("Contract Labor - Daily Rate Local/Non-Local", "OH&P - Daily Rate ...",
# "OH&P - Socks & Diapers"), so match by PREFIX, not exact name.
NON_EXPENSE_PREFIXES = ("Contract Labor", "OH&P", "Buffer")

# Keyword -> expense category. Any non-excluded cost line maps here by keyword,
# defaulting to "Other" so nothing is silently dropped (Lifts, Scrubbers,
# Dumpsters, permits, freight, etc. all get counted).
_CATEGORY_KEYWORDS = [
    ("lodging", "Lodging"),
    ("travel", "Travel"),
    ("propane", "Propane"),
    ("lift", "Rentals"), ("scrubber", "Rentals"), ("saw", "Rentals"),
    ("slurry", "Rentals"), ("dumpster", "Rentals"), ("rental", "Rentals"),
    ("scissor", "Rentals"), ("forklift", "Rentals"), ("boom", "Rentals"),
    ("material", "Materials"), ("freight", "Materials"), ("shipping", "Materials"),
]


def _expense_category(item_name: str) -> str | None:
    """Map an estimate cost line-item to an expense category, or None if it's not
    a real outflow (labor/buffer/OH&P)."""
    if not item_name or any(item_name.startswith(p) for p in NON_EXPENSE_PREFIXES):
        return None
    low = item_name.lower()
    for kw, cat in _CATEGORY_KEYWORDS:
        if kw in low:
            return cat
    return "Other"


def _require(user):
    if not has_capability(user, PAGE_CUSTOMERS):
        raise HTTPException(status_code=403, detail="Insufficient permissions")


def _num(v):
    return float(v) if v is not None else None


def _project_exists(conn, entity_id):
    return conn.execute(text("SELECT 1 FROM qbo_customers WHERE qbo_id = :e AND is_project = 1"),
                        {"e": entity_id}).scalar() is not None


def _estimate_costs_by_category(conn, entity_id):
    """Sum estimate YOUR-RATE cost per expense category for this project."""
    rows = conn.execute(text("""
        WITH latest AS (
          SELECT t.*, ROW_NUMBER() OVER (
                   PARTITION BY t.customer_qbo_id, t.entity_type,
                                COALESCE(t.doc_number, CONCAT('__nd__', t.qbo_id))
                   ORDER BY t.id DESC) AS rn
          FROM qbo_transactions t
          JOIN qbo_customers qc ON qc.qbo_id = t.customer_qbo_id
               AND qc.is_project = 1 AND qc.qbo_id = :e
          WHERE t.entity_type = 'Estimate'
            AND (t.total_amt IS NULL OR t.total_amt > 0)
            AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted', 'Closed')
        )
        SELECT COALESCE(qstl.item_name, 'Other') AS item,
               SUM(COALESCE(qstl.cost_amount, 0)) AS cost
        FROM latest qt
        JOIN qbo_sales_transaction_lines qstl
          ON qstl.transaction_id = qt.id AND qstl.line_level = 'child'
        WHERE qt.rn = 1
        GROUP BY COALESCE(qstl.item_name, 'Other')
    """), {"e": entity_id}).mappings().all()
    by_cat = {}
    for r in rows:
        cat = _expense_category(r["item"])
        if not cat:
            continue
        amt = float(r["cost"] or 0)
        if amt > 0:
            by_cat[cat] = round(by_cat.get(cat, 0) + amt, 2)
    return by_cat


def _estimate_costs_by_estimate(conn, entity_id):
    """{estimate qbo_id: {category: cost}}: the same costs as above, per accepted
    estimate (2026-11-18: expenses are planned per estimate, rolled up by item)."""
    rows = conn.execute(text("""
        WITH latest AS (
          SELECT t.*, ROW_NUMBER() OVER (
                   PARTITION BY t.customer_qbo_id, t.entity_type,
                                COALESCE(t.doc_number, CONCAT('__nd__', t.qbo_id))
                   ORDER BY t.id DESC) AS rn
          FROM qbo_transactions t
          JOIN qbo_customers qc ON qc.qbo_id = t.customer_qbo_id
               AND qc.is_project = 1 AND qc.qbo_id = :e
          WHERE t.entity_type = 'Estimate'
            AND (t.total_amt IS NULL OR t.total_amt > 0)
            AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted', 'Closed')
        )
        SELECT qt.qbo_id AS q, COALESCE(qstl.item_name, 'Other') AS item, SUM(COALESCE(qstl.cost_amount, 0)) AS cost
        FROM latest qt
        JOIN qbo_sales_transaction_lines qstl ON qstl.transaction_id = qt.id AND qstl.line_level = 'child'
        WHERE qt.rn = 1
        GROUP BY qt.qbo_id, COALESCE(qstl.item_name, 'Other')
    """), {"e": entity_id}).mappings().all()
    out = {}
    for r in rows:
        cat = _expense_category(r["item"])
        amt = float(r["cost"] or 0)
        if cat and amt > 0:
            d = out.setdefault(str(r["q"]), {})
            d[cat] = round(d.get(cat, 0) + amt, 2)
    return out


def _items(conn, entity_id):
    rows = conn.execute(text("""
        SELECT id, category, description, amount, expense_date, status, note, sort_order
        FROM project_expense_items WHERE entity_id = :e
        ORDER BY sort_order, expense_date, id
    """), {"e": entity_id}).mappings().all()
    return [{
        "id": r["id"], "category": r["category"], "description": r["description"],
        "amount": _num(r["amount"]),
        "expense_date": str(r["expense_date"]) if r["expense_date"] else None,
        "status": r["status"], "note": r["note"],
    } for r in rows]


@router.get("/project/{entity_id}")
def get_expenses(entity_id: str, user=Depends(get_current_user)):
    _require(user)
    with engine.connect() as conn:
        if not _project_exists(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        items = _items(conn, entity_id)
        suggested = _estimate_costs_by_category(conn, entity_id)
    total = round(sum(i["amount"] or 0 for i in items), 2)
    return {
        "entity": {"type": "project", "id": entity_id},
        "items": items,
        "categories": CATEGORIES,
        "suggested_from_estimate": suggested,
        "suggested_total": round(sum(suggested.values()), 2),
        "total": total,
    }


@router.post("/project/{entity_id}/item")
def add_item(entity_id: str, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        if not _project_exists(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        nxt = conn.execute(text("SELECT COALESCE(MAX(sort_order),0)+1 FROM project_expense_items WHERE entity_id = :e"),
                           {"e": entity_id}).scalar()
        conn.execute(text("INSERT INTO project_expense_items (entity_id, category, sort_order) VALUES (:e,'Materials',:so)"),
                     {"e": entity_id, "so": nxt})
    return {"ok": True}


@router.post("/project/{entity_id}/seed")
def seed_from_estimate(entity_id: str, user=Depends(get_current_user)):
    """Create one expense line per estimate cost category (skips categories that
    already have a line so re-seeding doesn't duplicate)."""
    _require(user)
    with engine.begin() as conn:
        if not _project_exists(conn, entity_id):
            raise HTTPException(status_code=404, detail="Project not found")
        by_cat = _estimate_costs_by_category(conn, entity_id)
        existing = {r[0] for r in conn.execute(text(
            "SELECT DISTINCT category FROM project_expense_items WHERE entity_id = :e"), {"e": entity_id}).all()}
        so = conn.execute(text("SELECT COALESCE(MAX(sort_order),0) FROM project_expense_items WHERE entity_id = :e"),
                          {"e": entity_id}).scalar() or 0
        created = 0
        for cat, amt in by_cat.items():
            if cat in existing:
                continue
            so += 1
            conn.execute(text("""
                INSERT INTO project_expense_items (entity_id, category, description, amount, sort_order, note)
                VALUES (:e, :c, :d, :a, :so, 'From estimate')
            """), {"e": entity_id, "c": cat, "d": f"{cat} (estimated)", "a": amt, "so": so})
            created += 1
    return {"ok": True, "created": created}


class ItemPatch(BaseModel):
    category: Optional[str] = None
    description: Optional[str] = None
    amount: Optional[float] = None
    expense_date: Optional[str] = None
    status: Optional[str] = None
    note: Optional[str] = None


@router.patch("/item/{item_id}")
def patch_item(item_id: int, req: ItemPatch, user=Depends(get_current_user)):
    _require(user)
    fields = req.model_dump(exclude_unset=True)
    if not fields:
        return {"ok": True}
    sets, params = ["edited = 1"], {"id": item_id}
    for k, v in fields.items():
        sets.append(f"{k} = :{k}")
        params[k] = (v if v != "" else None)
    with engine.begin() as conn:
        conn.execute(text(f"UPDATE project_expense_items SET {', '.join(sets)} WHERE id = :id"), params)
    return {"ok": True}


@router.delete("/item/{item_id}")
def delete_item(item_id: int, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM project_expense_items WHERE id = :id"), {"id": item_id})
    return {"ok": True}


# ── editable weekly expense schedule (per category) ─────────────────────────
class ExpInstPatch(BaseModel):
    week_of: Optional[str] = None
    expected_paid_date: Optional[str] = None   # 0079: planned pay date (blank = week_of)
    amount: Optional[float] = None


def _group(conn, inst_id):
    return conn.execute(text("SELECT entity_id, category, estimate_qbo_id FROM project_expense_installments WHERE id = :id"),
                        {"id": inst_id}).mappings().first()


def _group_target(conn, entity_id, category, q):
    """What the estimate has for this item (per estimate; a plan made for the
    whole project before 2026-11-18 uses the project's item total)."""
    if q:
        return float((_estimate_costs_by_estimate(conn, entity_id).get(str(q)) or {}).get(category) or 0)
    return float(conn.execute(text("SELECT COALESCE(SUM(amount), 0) FROM project_expense_items WHERE entity_id = :e AND category = :c"),
                              {"e": entity_id, "c": category}).scalar() or 0)


def rebalance_group(conn, entity_id, category, q):
    """2026-11-19 (owner): the rows of one plan (item x estimate) add up to the
    estimate's amount for it. Rows whose amount someone typed stay as typed; the
    others share the rest in proportion (equally if they're all 0). With no such
    row, the last row takes the difference."""
    target = round(_group_target(conn, entity_id, category, q), 2)
    rows = conn.execute(text("""SELECT id, amount, amount_edited, app_amount FROM project_expense_installments
                                WHERE entity_id = :e AND category = :c AND estimate_qbo_id <=> :q
                                ORDER BY week_of IS NULL, week_of, seq, id"""), {"e": entity_id, "c": category, "q": q}).mappings().all()
    if not rows or target <= 0:
        return
    fixed = [r for r in rows if r["amount_edited"]]
    flex = [r for r in rows if not r["amount_edited"]]
    left = round(target - sum(float(r["amount"] or 0) for r in fixed), 2)
    upd = {}
    if flex:
        # weights = the app's plan for each row (keeps Lodging's shape, months
        # even); a row added by hand weighs as much as an average row
        ws = [float(r["app_amount"]) if r["app_amount"] is not None else None for r in flex]
        known = [w for w in ws if w and w > 0]
        if not known:
            known = [float(r["amount"] or 0) for r in flex if float(r["amount"] or 0) > 0.004]
            ws = [float(r["amount"] or 0) if float(r["amount"] or 0) > 0.004 else None for r in flex]
        avg = (sum(known) / len(known)) if known else 1.0
        ws = [w if w and w > 0 else avg for w in ws]
        cur = sum(ws)
        alloc = [w / cur for w in ws]
        run = 0.0
        for i, (r, w) in enumerate(zip(flex, alloc)):
            amt = round(left * w, 2) if i < len(flex) - 1 else round(left - run, 2)
            run = round(run + amt, 2)
            upd[r["id"]] = amt
    else:
        r = rows[-1]
        upd[r["id"]] = round(float(r["amount"] or 0) + left, 2)
    for i, a in upd.items():
        conn.execute(text("UPDATE project_expense_installments SET amount = :a WHERE id = :i"), {"a": a, "i": i})
    conn.execute(text("DELETE FROM project_expense_sum_ok WHERE entity_id = :e AND category = :c AND estimate_qbo_id = :q"),
                 {"e": entity_id, "c": category, "q": q or ""})


@router.patch("/expense-installment/{inst_id}")
def patch_expense_installment(inst_id: int, req: ExpInstPatch, user=Depends(get_current_user)):
    _require(user)
    fields = req.model_dump(exclude_unset=True)
    if not fields:
        return {"ok": True}
    sets, params = ["edited = 1"], {"id": inst_id}
    if "amount" in fields:
        sets.append("amount_edited = 1")      # typed: kept when the plan re-balances
    for k, v in fields.items():
        sets.append(f"{k} = :{k}")
        params[k] = (v if v != "" else None)
    with engine.begin() as conn:
        conn.execute(text(f"UPDATE project_expense_installments SET {', '.join(sets)} WHERE id = :id"), params)
    return {"ok": True}


@router.post("/project/{entity_id}/category/{category}/installment")
def add_expense_installment(entity_id: str, category: str, estimate_qbo_id: Optional[str] = None,
                            user=Depends(get_current_user)):
    """A new row in one plan (item x estimate), dated a month after its last row;
    the rows nobody typed re-balance so the plan still adds up (2026-11-19)."""
    _require(user)
    q = estimate_qbo_id or None
    with engine.begin() as conn:
        last = conn.execute(text("""SELECT MAX(seq), MAX(week_of), MAX(expected_paid_date) FROM project_expense_installments
                                    WHERE entity_id=:e AND category=:c AND estimate_qbo_id <=> :q"""),
                            {"e": entity_id, "c": category, "q": q}).first()
        import calendar
        from datetime import date as _dt

        def _next_month(d):
            if not d:
                return None
            y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
            return _dt(y, m, min(d.day, calendar.monthrange(y, m)[1]) if d.day < 28 else calendar.monthrange(y, m)[1])
        conn.execute(text("""
            INSERT INTO project_expense_installments (entity_id, category, seq, week_of, expected_paid_date, amount, edited, basis, estimate_qbo_id)
            VALUES (:e, :c, :s, :w, :p, 0, 1, 'manual', :q)
        """), {"e": entity_id, "c": category, "s": int(last[0] or 0) + 1, "w": _next_month(last[1]),
               "p": _next_month(last[2]), "q": q})
        rebalance_group(conn, entity_id, category, q)
    return {"ok": True}


@router.delete("/expense-installment/{inst_id}")
def delete_expense_installment(inst_id: int, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        g = _group(conn, inst_id)
        conn.execute(text("DELETE FROM project_expense_installments WHERE id = :id"), {"id": inst_id})
        if g:
            rebalance_group(conn, g["entity_id"], g["category"], g["estimate_qbo_id"])
    return {"ok": True}


@router.post("/expense-installment/{inst_id}/revert")
def revert_expense_installment(inst_id: int, user=Depends(get_current_user)):
    """Back to what the app planned for this row (dates and amount)."""
    _require(user)
    with engine.begin() as conn:
        r = conn.execute(text("SELECT app_week_of, app_expected_paid_date, app_amount FROM project_expense_installments WHERE id = :i"),
                         {"i": inst_id}).mappings().first()
        if not r or r["app_amount"] is None:
            raise HTTPException(status_code=400, detail="The app has no plan saved for this row (added by hand).")
        conn.execute(text("""UPDATE project_expense_installments SET week_of = :w, expected_paid_date = :p, amount = :a,
                             edited = 0, amount_edited = 0 WHERE id = :i"""),
                     {"w": r["app_week_of"], "p": r["app_expected_paid_date"], "a": r["app_amount"], "i": inst_id})
        g = _group(conn, inst_id)
        rebalance_group(conn, g["entity_id"], g["category"], g["estimate_qbo_id"])
    return {"ok": True}


@router.post("/project/{entity_id}/category/{category}/rebalance")
def rebalance_plan(entity_id: str, category: str, estimate_qbo_id: Optional[str] = None, user=Depends(get_current_user)):
    _require(user)
    with engine.begin() as conn:
        rebalance_group(conn, entity_id, category, estimate_qbo_id or None)
    return {"ok": True}


@router.post("/project/{entity_id}/category/{category}/keep")
def keep_plan_total(entity_id: str, category: str, estimate_qbo_id: Optional[str] = None, user=Depends(get_current_user)):
    """Keep a plan that doesn't add up to the estimate (on purpose)."""
    _require(user)
    q = estimate_qbo_id or None
    with engine.begin() as conn:
        tot = conn.execute(text("""SELECT COALESCE(SUM(amount), 0) FROM project_expense_installments
                                   WHERE entity_id = :e AND category = :c AND estimate_qbo_id <=> :q"""),
                           {"e": entity_id, "c": category, "q": q}).scalar()
        conn.execute(text("""INSERT INTO project_expense_sum_ok (entity_id, category, estimate_qbo_id, total, by_email)
                             VALUES (:e, :c, :q, :t, :u)
                             ON DUPLICATE KEY UPDATE total = VALUES(total), by_email = VALUES(by_email), at = CURRENT_TIMESTAMP"""),
                     {"e": entity_id, "c": category, "q": q or "", "t": tot, "u": user.get("email")})
    return {"ok": True}
