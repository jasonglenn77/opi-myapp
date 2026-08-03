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
NON_EXPENSE_ITEMS = {"Contract Labor", "Contract Labor - Daily Rate Local", "Buffer", "OH&P"}

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
    if not item_name or item_name in NON_EXPENSE_ITEMS:
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
