"""
13-Week Cash Flow Forecast generation.

Builds a forward-looking 13-week forecast from synced QuickBooks data:

  INFLOW   = open Invoices, bucketed into the week their due_date falls in.
  OUTFLOW  = (A/P)        open Bills, bucketed by due_date  [scheduled, precise]
           + (Recurring)  per-category weekly run-rates derived from trailing
                          Purchase history [overhead + payroll, for forward weeks]

Rolling balance: week 1 opens at `opening_balance`; each week's ending =
opening + (inflow - outflow); next week opens at the prior week's ending.

Everything here is QBO-derived. Manual overrides + the bank-balance auto-seed
come in later phases — this module proves the generated numbers reconcile with
the company's spreadsheet first.
"""
from datetime import date, timedelta
from collections import defaultdict

from sqlalchemy import text

from app.db import engine

# --- Recurring "Other Operating Expenses" rows -> QBO account-name parents ---
# (account names are hierarchical like "Office and IT:Office Supplies"; we group
#  on the parent, i.e. the text before the first ":")
OVERHEAD_CATEGORIES = {
    "Office and IT":            ["Office and IT"],
    "Professional Fees":        ["Professional Fees"],
    "Travel and Entertainment": ["Travel and Entertainment", "Travel, Job Related",
                                 "Meals, Job Related", "Entertainment - NDE"],
    "Occupancy":                ["Occupancy"],
    "Taxes and Insurance":      ["Taxes and Insurance"],
    "Charitable Contributions": ["Charitable Contributions"],
}
PAYROLL_CATEGORIES = ["General and Admin Payroll"]

# Flat map: account parent -> forecast row label (for the run-rate query)
_CATEGORY_TO_ROW = {}
for _row, _cats in OVERHEAD_CATEGORIES.items():
    for _c in _cats:
        _CATEGORY_TO_ROW[_c] = _row
for _c in PAYROLL_CATEGORIES:
    _CATEGORY_TO_ROW[_c] = "Payroll"

RUNRATE_TRAILING_WEEKS = 13
WEEKS = 13
WEEK_END_WEEKDAY = 4  # Friday (matches the spreadsheet's week-ending dates)


def _next_weekday(d: date, weekday: int) -> date:
    """Date of the given weekday (0=Mon..6=Sun) on or after d."""
    return d + timedelta(days=(weekday - d.weekday()) % 7)


def _zeros():
    return [0.0] * WEEKS


def generate_forecast(start_date: date | None = None,
                      opening_balance: float = 0.0,
                      weeks: int = WEEKS) -> dict:
    today = date.today()
    if start_date is None:
        start_date = _next_weekday(today, WEEK_END_WEEKDAY)  # coming Friday

    # 13 week-ending dates; each week covers (week_end - 6) .. week_end
    week_ends = [start_date + timedelta(days=7 * i) for i in range(weeks)]
    win_start = week_ends[0] - timedelta(days=6)
    win_end = week_ends[-1]

    def week_index(d):
        if d is None:
            return None
        for i, we in enumerate(week_ends):
            if (we - timedelta(days=6)) <= d <= we:
                return i
        return None

    inflow_rows = _inflow_invoices(win_start, win_end, week_index, weeks)
    ap_rows = _outflow_bills(win_start, win_end, week_index, weeks)
    recurring_rows = _outflow_recurring(today, weeks)

    # ---- weekly totals ----
    inflow_totals = _column_sums(inflow_rows, weeks)
    ap_totals = _column_sums(ap_rows, weeks)
    rec_totals = _column_sums(recurring_rows, weeks)
    outflow_totals = [round(ap_totals[i] + rec_totals[i], 2) for i in range(weeks)]

    # ---- rolling balance ----
    opening = _zeros()
    surplus = _zeros()
    ending = _zeros()
    bal = float(opening_balance)
    for i in range(weeks):
        opening[i] = round(bal, 2)
        surplus[i] = round(inflow_totals[i] - outflow_totals[i], 2)
        bal = bal + inflow_totals[i] - outflow_totals[i]
        ending[i] = round(bal, 2)

    return {
        "as_of": today.isoformat(),
        "start_date": week_ends[0].isoformat(),
        "weeks": weeks,
        "week_ends": [d.isoformat() for d in week_ends],
        "opening_balance": round(float(opening_balance), 2),
        "inflow": {
            "rows": inflow_rows,
            "weekly_totals": [round(x, 2) for x in inflow_totals],
            "grand_total": round(sum(inflow_totals), 2),
        },
        "outflow": {
            "ap": {"rows": ap_rows, "weekly_totals": [round(x, 2) for x in ap_totals]},
            "recurring": {"rows": recurring_rows, "weekly_totals": [round(x, 2) for x in rec_totals]},
            "weekly_totals": outflow_totals,
            "grand_total": round(sum(outflow_totals), 2),
        },
        "summary": {
            "opening": opening,
            "surplus": surplus,
            "ending": ending,
        },
    }


# ---------------------------------------------------------------------------
# Inflow: open Invoices by due date (deduped to the latest version per doc)
# ---------------------------------------------------------------------------
def _inflow_invoices(win_start, win_end, week_index, weeks):
    sql = text("""
        WITH latest AS (
            SELECT qt.id, qt.customer_qbo_id, qt.doc_number, qt.due_date, qt.balance_amt,
                   ROW_NUMBER() OVER (
                       PARTITION BY qt.customer_qbo_id, COALESCE(qt.doc_number, qt.qbo_id)
                       ORDER BY qt.id DESC
                   ) AS rn
            FROM qbo_transactions qt
            WHERE qt.entity_type = 'Invoice'
        )
        SELECT COALESCE(qc.display_name, 'Unknown') AS name,
               l.due_date, l.balance_amt AS amount
        FROM latest l
        LEFT JOIN qbo_customers qc ON qc.qbo_id = l.customer_qbo_id
        WHERE l.rn = 1
          AND l.balance_amt > 0
          AND l.due_date BETWEEN :ws AND :we
    """)
    with engine.connect() as conn:
        rows = conn.execute(sql, {"ws": win_start, "we": win_end}).mappings().all()
    return _bucket_by_name(rows, week_index, weeks)


# ---------------------------------------------------------------------------
# Outflow A/P: open Bills by due date, grouped by vendor
# ---------------------------------------------------------------------------
def _outflow_bills(win_start, win_end, week_index, weeks):
    sql = text("""
        WITH latest AS (
            SELECT qt.id, qt.vendor_qbo_id, qt.doc_number, qt.due_date, qt.balance_amt,
                   JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.VendorRef.name')) AS vendor,
                   ROW_NUMBER() OVER (
                       PARTITION BY qt.vendor_qbo_id, COALESCE(qt.doc_number, qt.qbo_id)
                       ORDER BY qt.id DESC
                   ) AS rn
            FROM qbo_transactions qt
            WHERE qt.entity_type = 'Bill'
        )
        SELECT COALESCE(vendor, 'Unknown vendor') AS name,
               due_date, balance_amt AS amount
        FROM latest
        WHERE rn = 1
          AND balance_amt > 0
          AND due_date BETWEEN :ws AND :we
    """)
    with engine.connect() as conn:
        rows = conn.execute(sql, {"ws": win_start, "we": win_end}).mappings().all()
    return _bucket_by_name(rows, week_index, weeks)


# ---------------------------------------------------------------------------
# Outflow recurring: per-category weekly run-rate from trailing Purchase history
# ---------------------------------------------------------------------------
def _outflow_recurring(today, weeks):
    runrate_start = today - timedelta(weeks=RUNRATE_TRAILING_WEEKS)
    sql = text("""
        SELECT SUBSTRING_INDEX(
                 JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')),
                 ':', 1) AS category,
               SUM(l.amount) AS total
        FROM qbo_transactions qt
        JOIN qbo_transaction_lines l ON l.transaction_id = qt.id
        WHERE qt.entity_type = 'Purchase'
          AND qt.txn_date >= :rr_start
          AND qt.txn_date < :today
          AND JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name') IS NOT NULL
        GROUP BY category
    """)
    with engine.connect() as conn:
        rows = conn.execute(sql, {"rr_start": runrate_start, "today": today}).mappings().all()

    # Aggregate matched categories into forecast rows, as a weekly run-rate.
    per_row_weekly = defaultdict(float)
    for r in rows:
        row_label = _CATEGORY_TO_ROW.get(r["category"])
        if not row_label:
            continue  # unmapped (financing, transfers, job materials) -> excluded
        per_row_weekly[row_label] += float(r["total"] or 0) / RUNRATE_TRAILING_WEEKS

    # Emit one row per forecast label, same run-rate applied to every week.
    # Order: payroll first, then overhead rows in declared order.
    ordered_labels = ["Payroll"] + list(OVERHEAD_CATEGORIES.keys())
    out = []
    for label in ordered_labels:
        if label not in per_row_weekly:
            continue
        wk = round(per_row_weekly[label], 2)
        out.append({
            "label": label,
            "kind": "runrate",
            "weekly": [wk] * weeks,
            "total": round(wk * weeks, 2),
        })
    return out


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _bucket_by_name(rows, week_index, weeks):
    """Group flat (name, due_date, amount) rows into {name: weekly[13]} rows."""
    grouped = defaultdict(lambda: [0.0] * weeks)
    for r in rows:
        idx = week_index(r["due_date"])
        if idx is None:
            continue
        grouped[r["name"]][idx] += float(r["amount"] or 0)
    out = []
    for name, weekly in grouped.items():
        out.append({
            "label": name,
            "kind": "actual",
            "weekly": [round(x, 2) for x in weekly],
            "total": round(sum(weekly), 2),
        })
    out.sort(key=lambda x: x["total"], reverse=True)
    return out


def _column_sums(rows, weeks):
    totals = [0.0] * weeks
    for r in rows:
        for i in range(weeks):
            totals[i] += r["weekly"][i]
    return totals
