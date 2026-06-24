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


# ---------------------------------------------------------------------------
# Category settings (user-managed: which expense categories are "operating"
# cash vs. transfers/financing to exclude). Persisted, shared across users.
# Default = included; only exclusions are stored.
# ---------------------------------------------------------------------------
def ensure_cashflow_tables():
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS cashflow_category_settings (
              category VARCHAR(255) NOT NULL PRIMARY KEY,
              excluded TINYINT(1) NOT NULL DEFAULT 0,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB
        """))


def _excluded_categories() -> set:
    try:
        with engine.connect() as conn:
            return set(conn.execute(
                text("SELECT category FROM cashflow_category_settings WHERE excluded = 1")
            ).scalars().all())
    except Exception:
        return set()  # table not created yet


def list_expense_categories() -> list:
    """All Purchase expense categories (account parents) with a trailing-12-month
    total, the current include/exclude flag, and — when the chart of accounts has
    been synced — the QBO classification + a suggested-exclude flag (anything that
    isn't a P&L 'Expense' account: bank transfers, liabilities, assets/capex)."""
    ensure_cashflow_tables()
    start = date.today() - timedelta(days=365)
    base = """
        SELECT g.category, g.line_ct, g.total_12mo {extra}
        FROM (
          SELECT SUBSTRING_INDEX(
                   JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')),
                   ':', 1) AS category,
                 COUNT(*) AS line_ct,
                 ROUND(SUM(l.amount)) AS total_12mo
          FROM qbo_transactions qt
          JOIN qbo_transaction_lines l ON l.transaction_id = qt.id
          WHERE qt.entity_type = 'Purchase'
            AND qt.txn_date >= :start
            AND JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name') IS NOT NULL
          GROUP BY category
        ) g
        {join}
        ORDER BY g.total_12mo DESC
    """
    excluded = _excluded_categories()
    with engine.connect() as conn:
        try:
            sql = text(base.format(
                extra=", acc.classification AS classification, acc.account_type AS account_type",
                join="LEFT JOIN qbo_accounts acc ON acc.name = g.category",
            ))
            rows = conn.execute(sql, {"start": start}).mappings().all()
        except Exception:
            # Chart of accounts not synced yet -> no classification available.
            sql = text(base.format(extra="", join=""))
            rows = conn.execute(sql, {"start": start}).mappings().all()

    out = []
    for r in rows:
        cls = r.get("classification") if hasattr(r, "get") else None
        # Suggest excluding anything that isn't a P&L Expense account.
        suggested = bool(cls) and cls != "Expense"
        out.append({
            "category": r["category"],
            "line_ct": int(r["line_ct"]),
            "total_12mo": float(r["total_12mo"] or 0),
            "excluded": r["category"] in excluded,
            "classification": cls,
            "account_type": r.get("account_type") if hasattr(r, "get") else None,
            "suggested_exclude": suggested,
        })
    return out


def get_bank_balance() -> dict:
    """Total current cash across QBO Bank accounts (for the opening balance)."""
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT name, current_balance
                FROM qbo_accounts
                WHERE account_type = 'Bank' AND (active = 1 OR active IS NULL)
                ORDER BY current_balance DESC
            """)).mappings().all()
    except Exception:
        return {"available": False, "balance": 0.0, "accounts": []}
    total = sum(float(r["current_balance"] or 0) for r in rows)
    return {
        "available": len(rows) > 0,
        "balance": round(total, 2),
        "accounts": [{"name": r["name"], "balance": float(r["current_balance"] or 0)} for r in rows],
    }


def set_excluded_categories(categories: list) -> dict:
    """Replace the exclusion set with the supplied categories."""
    ensure_cashflow_tables()
    cats = sorted({c.strip() for c in categories if c and c.strip()})
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM cashflow_category_settings"))
        for c in cats:
            conn.execute(text(
                "INSERT INTO cashflow_category_settings (category, excluded) VALUES (:c, 1)"
            ), {"c": c})
    return {"ok": True, "excluded": cats}


def _next_weekday(d: date, weekday: int) -> date:
    """Date of the given weekday (0=Mon..6=Sun) on or after d."""
    return d + timedelta(days=(weekday - d.weekday()) % 7)


def _zeros():
    return [0.0] * WEEKS


def generate_forecast(start_date: date | None = None,
                      opening_balance: float = 0.0,
                      weeks: int = WEEKS,
                      include_projected: bool = False) -> dict:
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
    invoiced_totals = _column_sums(inflow_rows, weeks)

    # optional projected (not-yet-invoiced) inflow, split into two groups:
    #   in-progress (un-invoiced balance) and awarded-but-not-started (estimated)
    projected_block = None
    inflow_totals = list(invoiced_totals)
    if include_projected:
        active_rows = _inflow_projected(win_start, win_end, week_ends, weeks, "in_progress")
        awarded_rows = _inflow_projected(win_start, win_end, week_ends, weeks, "not_started")

        def _section(key, label, rows):
            if not rows:
                return None
            wt = _column_sums(rows, weeks)
            return {"key": key, "label": label, "rows": rows,
                    "weekly_totals": [round(x, 2) for x in wt], "grand_total": round(sum(wt), 2)}

        sections = [s for s in (
            _section("proj_active", "In-progress — un-invoiced balance", active_rows),
            _section("proj_awarded", "Awarded — not started (estimated)", awarded_rows),
        ) if s]
        proj_totals = _column_sums(active_rows + awarded_rows, weeks)
        projected_block = {
            "label": "Projected / TBD",
            "sublabel": "by project end date",
            "sections": sections,
            "weekly_totals": [round(x, 2) for x in proj_totals],
            "grand_total": round(sum(proj_totals), 2),
        }
        inflow_totals = [invoiced_totals[i] + proj_totals[i] for i in range(weeks)]

    ap_totals = _column_sums(ap_rows, weeks)
    rec_totals = _column_sums(recurring_rows, weeks)
    outflow_totals = [round(ap_totals[i] + rec_totals[i], 2) for i in range(weeks)]

    # ---- rolling balance (inflow_totals already includes projected when on) ----
    opening = _zeros()
    surplus = _zeros()
    ending = _zeros()
    bal = float(opening_balance)
    for i in range(weeks):
        opening[i] = round(bal, 2)
        surplus[i] = round(inflow_totals[i] - outflow_totals[i], 2)
        bal = bal + inflow_totals[i] - outflow_totals[i]
        ending[i] = round(bal, 2)

    inflow_obj = {
        "label": "Cash Inflow",
        "sublabel": "open invoices by due date" + (" + projected" if include_projected else ""),
        "rows": inflow_rows,
        "weekly_totals": [round(x, 2) for x in inflow_totals],
        "grand_total": round(sum(inflow_totals), 2),
    }
    if projected_block:
        inflow_obj["projected"] = projected_block

    return {
        "mode": "forecast",
        "as_of": today.isoformat(),
        "start_date": week_ends[0].isoformat(),
        "weeks": weeks,
        "week_ends": [d.isoformat() for d in week_ends],
        "opening_balance": round(float(opening_balance), 2),
        "inflow": inflow_obj,
        "outflow": {
            "label": "Cash Outflow",
            "sections": [
                {"key": "ap", "label": "A/P — open bills", "rows": ap_rows,
                 "weekly_totals": [round(x, 2) for x in ap_totals]},
                {"key": "recurring", "label": "Recurring (run-rate)", "rows": recurring_rows,
                 "weekly_totals": [round(x, 2) for x in rec_totals]},
            ],
            "weekly_totals": outflow_totals,
            "grand_total": round(sum(outflow_totals), 2),
        },
        "summary": {
            "opening": opening,
            "surplus": surplus,
            "ending": ending,
        },
    }


def generate_actuals(start_date: date | None = None,
                     opening_balance: float = 0.0,
                     weeks: int = WEEKS) -> dict:
    """
    Historical realized cash flow from actual payment movement:
      IN  = Payment      (cash received against invoices), by txn_date
      OUT = BillPayment  (cash paid against bills) + Purchase (direct expenses), by txn_date

    Default window = the trailing `weeks` ending on the most recent Friday.
    """
    today = date.today()
    last_friday = today - timedelta(days=(today.weekday() - WEEK_END_WEEKDAY) % 7)
    if start_date is None:
        start_date = last_friday - timedelta(days=7 * (weeks - 1))

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

    payments = _actual_payments(win_start, win_end, week_index, weeks)
    billpays = _actual_billpayments(win_start, win_end, week_index, weeks)
    purchases = _actual_purchases(win_start, win_end, week_index, weeks)

    inflow_totals = _column_sums(payments, weeks)
    bp_totals = _column_sums(billpays, weeks)
    pur_totals = _column_sums(purchases, weeks)
    outflow_totals = [round(bp_totals[i] + pur_totals[i], 2) for i in range(weeks)]

    opening, surplus, ending = _zeros(), _zeros(), _zeros()
    bal = float(opening_balance)
    for i in range(weeks):
        opening[i] = round(bal, 2)
        surplus[i] = round(inflow_totals[i] - outflow_totals[i], 2)
        bal = bal + inflow_totals[i] - outflow_totals[i]
        ending[i] = round(bal, 2)

    return {
        "mode": "actuals",
        "as_of": today.isoformat(),
        "start_date": week_ends[0].isoformat(),
        "weeks": weeks,
        "week_ends": [d.isoformat() for d in week_ends],
        "opening_balance": round(float(opening_balance), 2),
        "inflow": {
            "label": "Cash Collected",
            "sublabel": "customer payments received",
            "rows": payments,
            "weekly_totals": [round(x, 2) for x in inflow_totals],
            "grand_total": round(sum(inflow_totals), 2),
        },
        "outflow": {
            "label": "Cash Paid Out",
            "sections": [
                {"key": "billpay", "label": "Bill payments (vendors/contractors)", "rows": billpays,
                 "weekly_totals": [round(x, 2) for x in bp_totals]},
                {"key": "purchases", "label": "Direct expenses (cards/checks)", "rows": purchases,
                 "weekly_totals": [round(x, 2) for x in pur_totals]},
            ],
            "weekly_totals": outflow_totals,
            "grand_total": round(sum(outflow_totals), 2),
        },
        "summary": {"opening": opening, "surplus": surplus, "ending": ending},
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
# Projected inflow: revenue still to be invoiced on ACTIVE projects.
#   per project: expected = SUM(project-level Estimate totals)
#                invoiced = SUM(project-level Invoice totals, paid + open)
#                projected = max(0, expected - invoiced)   [the not-yet-billed part]
# Bucketed by the project's assignment END date (project.end_date, falling back
# to the latest schedule item). Already-past end dates are treated as imminent
# (week 1). This never double-counts invoiced AR — only the un-billed remainder.
# NB: projects.qbo_customer_id is the qbo_customers INTERNAL id (not the qbo_id).
# ---------------------------------------------------------------------------
def _inflow_projected(win_start, win_end, week_ends, weeks, status):
    """Un-invoiced project balance for projects of the given status, bucketed by
    the project's end date (falling back to schedule end, then start date)."""
    sql = text("""
        SELECT qc.qbo_id AS pid, qc.display_name AS name,
               COALESCE(p.end_date,
                        (SELECT MAX(psi.end_date) FROM project_schedule_items psi
                         WHERE psi.project_id = p.id),
                        p.start_date) AS bucket_date,
               (SELECT COALESCE(SUM(e.total_amt), 0) FROM qbo_transactions e
                WHERE e.entity_type = 'Estimate' AND e.customer_qbo_id = qc.qbo_id) AS expected,
               (SELECT COALESCE(SUM(iv.total_amt), 0) FROM qbo_transactions iv
                WHERE iv.entity_type = 'Invoice' AND iv.customer_qbo_id = qc.qbo_id) AS invoiced
        FROM projects p
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        WHERE p.status = :status
    """)
    with engine.connect() as conn:
        rows = conn.execute(sql, {"status": status}).mappings().all()

    out = []
    for r in rows:
        remaining = float(r["expected"] or 0) - float(r["invoiced"] or 0)
        bd = r["bucket_date"]
        if remaining <= 0 or bd is None or bd > win_end:
            continue  # nothing left to bill, no date, or beyond the window
        # bucket by date; anything already past lands in week 1 (imminent)
        idx = 0
        for i, we in enumerate(week_ends):
            if (we - timedelta(days=6)) <= bd <= we:
                idx = i
                break
        weekly = [0.0] * weeks
        weekly[idx] = round(remaining, 2)
        out.append({"label": r["name"], "kind": "projected",
                    "weekly": weekly, "total": round(remaining, 2)})
    out.sort(key=lambda x: x["total"], reverse=True)
    return out


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
# Actuals queries (realized cash by txn_date)
# ---------------------------------------------------------------------------
def _actual_payments(win_start, win_end, week_index, weeks):
    sql = text("""
        SELECT COALESCE(qc.display_name,
                        JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.CustomerRef.name')),
                        'Unknown') AS name,
               qt.txn_date AS due_date, qt.total_amt AS amount
        FROM qbo_transactions qt
        LEFT JOIN qbo_customers qc ON qc.qbo_id = qt.customer_qbo_id
        WHERE qt.entity_type = 'Payment'
          AND qt.txn_date BETWEEN :ws AND :we
          AND qt.total_amt IS NOT NULL
    """)
    with engine.connect() as conn:
        rows = conn.execute(sql, {"ws": win_start, "we": win_end}).mappings().all()
    return _bucket_by_name(rows, week_index, weeks)


def _actual_billpayments(win_start, win_end, week_index, weeks):
    sql = text("""
        SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.VendorRef.name')),
                        'Unknown vendor') AS name,
               qt.txn_date AS due_date, qt.total_amt AS amount
        FROM qbo_transactions qt
        WHERE qt.entity_type = 'BillPayment'
          AND qt.txn_date BETWEEN :ws AND :we
          AND qt.total_amt IS NOT NULL
    """)
    with engine.connect() as conn:
        rows = conn.execute(sql, {"ws": win_start, "we": win_end}).mappings().all()
    return _bucket_by_name(rows, week_index, weeks)


def _actual_purchases(win_start, win_end, week_index, weeks):
    """Direct expenses (cards/checks), grouped by account category, by header date."""
    sql = text("""
        SELECT COALESCE(
                 SUBSTRING_INDEX(
                   JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')),
                   ':', 1),
                 'Other') AS name,
               qt.txn_date AS due_date, l.amount AS amount
        FROM qbo_transactions qt
        JOIN qbo_transaction_lines l ON l.transaction_id = qt.id
        WHERE qt.entity_type = 'Purchase'
          AND qt.txn_date BETWEEN :ws AND :we
          AND l.amount IS NOT NULL
    """)
    with engine.connect() as conn:
        rows = conn.execute(sql, {"ws": win_start, "we": win_end}).mappings().all()
    grouped = _bucket_by_name(rows, week_index, weeks)
    # Drop categories the user has classified as transfers/financing (non-operating).
    excluded = _excluded_categories()
    return [r for r in grouped if r["label"] not in excluded]


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
