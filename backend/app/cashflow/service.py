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


def get_credit_cards() -> dict:
    """QBO Credit Card accounts + balances. PARKED / informational only — these
    are NOT folded into the forecast yet (pending how the owners pay the cards).
    In QBO a Credit Card balance is a liability: a negative balance = amount owed,
    a positive balance = a credit/overpayment on the card. We surface `owed` as the
    positive amount owed so the panel reads naturally."""
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT name, current_balance
                FROM qbo_accounts
                WHERE account_type = 'Credit Card' AND (active = 1 OR active IS NULL)
                ORDER BY current_balance ASC
            """)).mappings().all()
    except Exception:
        return {"available": False, "total_owed": 0.0, "accounts": []}
    accounts = []
    for r in rows:
        bal = float(r["current_balance"] or 0)
        accounts.append({
            "name": r["name"],
            "balance": round(bal, 2),          # QBO signed balance (negative = owed)
            "owed": round(-bal, 2),            # positive = owed on the card
            "credit_balance": bal > 0,         # unusual: a credit/overpayment sits on the card
        })
    total_owed = round(sum(a["owed"] for a in accounts), 2)
    return {"available": len(accounts) > 0, "total_owed": total_owed, "accounts": accounts}


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


def _zeros(n: int = WEEKS):
    return [0.0] * n


def generate_forecast(start_date: date | None = None,
                      opening_balance: float = 0.0,
                      weeks: int = WEEKS,
                      inc_active: bool = True,
                      inc_awarded: bool = True,
                      inc_jobcost: bool = True) -> dict:
    """Forward forecast as Committed (open invoices/bills + overhead run-rate)
    plus toggleable Projected layers: projected inflow (in-progress + awarded
    un-invoiced balance) and projected outflow (job-cost run-rate). Amounts dated
    past the horizon roll into a `beyond` bucket. `inc_*` flags fold each
    projected section into the weekly totals + rolling balance."""
    today = date.today()
    if start_date is None:
        start_date = _next_weekday(today, WEEK_END_WEEKDAY)  # coming Friday

    week_ends = [start_date + timedelta(days=7 * i) for i in range(weeks)]
    win_start = week_ends[0] - timedelta(days=6)
    win_end = week_ends[-1]
    beyond_cap = win_end + timedelta(days=180)   # how far past the window to gather "beyond"

    # ---- committed inflow / outflow ----
    inv_rows = _inflow_invoices(win_start, beyond_cap, week_ends, win_end, weeks)
    ap_rows = _outflow_bills(win_start, beyond_cap, week_ends, win_end, weeks)
    rec_rows = _outflow_recurring(today, weeks)

    # ---- projected inflow (two groups) + projected outflow (run-rate) ----
    active_rows = _inflow_projected(win_start, win_end, week_ends, weeks, "in_progress")
    awarded_rows = _inflow_projected(win_start, win_end, week_ends, weeks, "not_started")
    job_rows = _outflow_jobcost_runrate(today, weeks)

    def _beyond(rows):
        return round(sum(r.get("beyond", 0.0) for r in rows), 2)

    def _section(key, label, rows, included=None):
        wt = _column_sums(rows, weeks)
        s = {"key": key, "label": label, "rows": rows,
             "weekly_totals": [round(x, 2) for x in wt],
             "beyond": _beyond(rows), "grand_total": round(sum(wt), 2)}
        if included is not None:
            s["included"] = included
        return s

    inflow_committed = _section("invoiced", "Open invoices (by due date)", inv_rows)
    inflow_projected = [
        _section("proj_active", "In-progress — un-invoiced balance", active_rows, included=inc_active),
        _section("proj_awarded", "Awarded — not started (estimated)", awarded_rows, included=inc_awarded),
    ]
    outflow_committed = [
        _section("ap", "A/P — open bills", ap_rows),
        _section("recurring", "Recurring — overhead & payroll (run-rate)", rec_rows),
    ]
    outflow_projected = [
        _section("jobcost", "Projected — job costs (run-rate)", job_rows, included=inc_jobcost),
    ]

    # ---- combined weekly totals: committed always; projected only if included ----
    inv_wt = inflow_committed["weekly_totals"]
    act_wt, awd_wt = inflow_projected[0]["weekly_totals"], inflow_projected[1]["weekly_totals"]
    ap_wt, rec_wt = outflow_committed[0]["weekly_totals"], outflow_committed[1]["weekly_totals"]
    job_wt = outflow_projected[0]["weekly_totals"]

    inflow_weekly = [round(inv_wt[i]
                           + (act_wt[i] if inc_active else 0)
                           + (awd_wt[i] if inc_awarded else 0), 2) for i in range(weeks)]
    outflow_weekly = [round(ap_wt[i] + rec_wt[i]
                            + (job_wt[i] if inc_jobcost else 0), 2) for i in range(weeks)]

    inflow_beyond = round(inflow_committed["beyond"]
                          + (inflow_projected[0]["beyond"] if inc_active else 0)
                          + (inflow_projected[1]["beyond"] if inc_awarded else 0), 2)
    outflow_beyond = round(outflow_committed[0]["beyond"], 2)

    # ---- rolling balance ----
    opening, surplus, ending = _zeros(weeks), _zeros(weeks), _zeros(weeks)
    bal = float(opening_balance)
    for i in range(weeks):
        opening[i] = round(bal, 2)
        surplus[i] = round(inflow_weekly[i] - outflow_weekly[i], 2)
        bal = bal + inflow_weekly[i] - outflow_weekly[i]
        ending[i] = round(bal, 2)

    return {
        "mode": "forecast",
        "as_of": today.isoformat(),
        "start_date": week_ends[0].isoformat(),
        "weeks": weeks,
        "week_ends": [d.isoformat() for d in week_ends],
        "opening_balance": round(float(opening_balance), 2),
        "inflow": {
            "label": "Cash Inflow",
            "committed": inflow_committed,
            "projected": inflow_projected,
            "weekly_totals": inflow_weekly,
            "grand_total": round(sum(inflow_weekly), 2),
            "beyond_total": inflow_beyond,
        },
        "outflow": {
            "label": "Cash Outflow",
            "committed": outflow_committed,
            "projected": outflow_projected,
            "weekly_totals": outflow_weekly,
            "grand_total": round(sum(outflow_weekly), 2),
            "beyond_total": outflow_beyond,
        },
        "summary": {"opening": opening, "surplus": surplus, "ending": ending},
    }


def generate_forecast_v2(start_date: date | None = None,
                         weeks: int = 26,
                         opening_balance: float | None = None,
                         max_age_seconds: int = 1800) -> dict:
    """Phase-3b forecast: real bank balance anchor + committed QBO layers (open
    invoices / open bills, live) + recurring overhead run-rate + the SCHEDULED
    layer aggregated from every project's Billing tab (cached; re-bucketed here).

    Unbounded weekly horizon. The scheduled layer replaces the old crude proxies
    (un-invoiced-balance projected inflow, job-cost run-rate outflow). Undated
    projects' committed cash sits in `backlog` (off the weekly grid, option a)."""
    from . import schedule_forecast as SF

    today = date.today()
    if start_date is None:
        start_date = _next_weekday(today, WEEK_END_WEEKDAY)  # coming Friday
    week_ends = [start_date + timedelta(days=7 * i) for i in range(weeks)]
    win_start = week_ends[0] - timedelta(days=6)
    win_end = week_ends[-1]
    beyond_cap = win_end + timedelta(days=180)

    bank = get_bank_balance()
    if opening_balance is None:
        opening_balance = bank.get("balance", 0.0)

    # ---- committed layers (fast, live from QBO) ----
    inv_rows = _inflow_invoices(win_start, beyond_cap, week_ends, win_end, weeks, split_pastdue=True)
    ap_rows, ap_proj_rows = _outflow_bills2(win_start, beyond_cap, week_ends, win_end, weeks, split_pastdue=True)
    inv_wt = _column_sums(inv_rows, weeks)
    ap_wt = _column_sums(ap_rows, weeks)
    inv_pd = round(sum(r.get("pastdue", 0) for r in inv_rows), 2)   # overdue A/R
    ap_pd = round(sum(r.get("pastdue", 0) for r in ap_rows), 2)     # overdue A/P

    # ---- recurring overhead: the editable schedule (seeded from the run-rate the
    #      first time), expanded by cadence across the weekly grid ----
    from . import overhead as OV
    OV.seed_if_empty(today)
    rec_wt, rec_items, rec_cats = OV.expand(week_ends)  # cadence-based; no past-due

    # ---- scheduled layer (cached event pass, bucketed to this horizon) ----
    payload, cache_meta = SF.get_events(max_age_seconds)
    if payload:
        sched = SF.bucket_events(payload, start_date, weeks)
        sched_in, sched_out = sched["inflow"], sched["outflow"]
        backlog = sched["backlog"]
        sched_projects = sched["projects"]
        beyond_in, beyond_out = sched["beyond_in"], sched["beyond_out"]
        sched_pd_in, sched_pd_out = sched["pastdue_in"], sched["pastdue_out"]
        sched_in_rows, sched_out_rows = sched["sched_in_rows"], sched["sched_out_rows"]
        sched_out_by_type = sched["sched_out_by_type"]
    else:
        sched_in = [0.0] * weeks
        sched_out = [0.0] * weeks
        backlog = {"in": 0.0, "out": 0.0}
        sched_projects = []
        beyond_in = beyond_out = sched_pd_in = sched_pd_out = 0.0
        sched_in_rows = sched_out_rows = sched_out_by_type = []

    def _sec(key, label, rows, wt, tier, pastdue=0.0):
        return {"key": key, "label": label, "rows": rows, "tier": tier,
                "weekly_totals": [round(x, 2) for x in wt],
                "grand_total": round(sum(wt), 2), "pastdue": round(pastdue, 2)}

    inflow_weekly = [round(inv_wt[i] + sched_in[i], 2) for i in range(weeks)]
    outflow_weekly = [round(ap_wt[i] + rec_wt[i] + sched_out[i], 2) for i in range(weeks)]

    # ---- past-due column: everything dated before the current week, its own
    #      leading period so week 1 shows only its true Sat–Fri items. It settles
    #      off the opening bank balance; week 1 then opens at its ending. (Same
    #      ending balances as folding it into week 1 — just cleanly separated.) ----
    pastdue_in = round(inv_pd + sched_pd_in, 2)
    pastdue_out = round(ap_pd + sched_pd_out, 2)
    pd_opening = round(float(opening_balance), 2)
    pd_ending = round(pd_opening + pastdue_in - pastdue_out, 2)

    # ---- rolling weekly balance, opening at the post-past-due balance ----
    opening, surplus, ending = _zeros(weeks), _zeros(weeks), _zeros(weeks)
    bal = pd_ending
    for i in range(weeks):
        opening[i] = round(bal, 2)
        surplus[i] = round(inflow_weekly[i] - outflow_weekly[i], 2)
        bal = bal + inflow_weekly[i] - outflow_weekly[i]
        ending[i] = round(bal, 2)

    return {
        "mode": "forecast_v2",
        "as_of": today.isoformat(),
        "start_date": week_ends[0].isoformat(),
        "weeks": weeks,
        "week_ends": [d.isoformat() for d in week_ends],
        "opening_balance": round(float(opening_balance), 2),
        "bank": bank,
        "cache": cache_meta,
        "past_due": {
            "label": "Past due",
            "inflow": pastdue_in, "outflow": pastdue_out,
            "opening": pd_opening, "surplus": round(pastdue_in - pastdue_out, 2), "ending": pd_ending,
        },
        "inflow": {
            "label": "Cash Inflow",
            "sections": [
                _sec("ar", "Committed — open invoices (A/R, by due date)", inv_rows, inv_wt, "committed", inv_pd),
                {"key": "scheduled", "label": "Scheduled — to bill (project schedules)", "tier": "scheduled",
                 "rows": sched_in_rows,
                 "weekly_totals": [round(x, 2) for x in sched_in],
                 "grand_total": round(sum(sched_in), 2), "pastdue": round(sched_pd_in, 2)},
            ],
            "weekly_totals": inflow_weekly,
            "grand_total": round(sum(inflow_weekly), 2),
            "beyond_total": round(beyond_in, 2),
            "pastdue_total": pastdue_in,
        },
        "outflow": {
            "label": "Cash Outflow",
            "sections": [
                {**_sec("ap", "Committed — open bills (A/P, by due date)", ap_rows, ap_wt, "committed", ap_pd),
                 "alt_rows": ap_proj_rows, "view_a": "By vendor", "view_b": "By project"},
                {"key": "scheduled", "label": "Scheduled — crew & expenses (project schedules)", "tier": "scheduled",
                 "rows": sched_out_rows, "alt_rows": sched_out_by_type, "view_a": "By project", "view_b": "By type",
                 "weekly_totals": [round(x, 2) for x in sched_out],
                 "grand_total": round(sum(sched_out), 2), "pastdue": round(sched_pd_out, 2)},
                {**_sec("recurring", "Recurring — overhead & payroll", rec_cats, rec_wt, "estimated", 0.0),
                 "alt_rows": rec_items, "view_a": "By category", "view_b": "By item"},
            ],
            "weekly_totals": outflow_weekly,
            "grand_total": round(sum(outflow_weekly), 2),
            "beyond_total": round(beyond_out, 2),
            "pastdue_total": pastdue_out,
        },
        "backlog": backlog,
        "projects": sched_projects,
        "summary": {"opening": opening, "surplus": surplus, "ending": ending},
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

    opening, surplus, ending = _zeros(weeks), _zeros(weeks), _zeros(weeks)
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
def _inflow_invoices(win_start, beyond_cap, week_ends, win_end, weeks, split_pastdue=False):
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
               qc.qbo_id AS link_id, qc.is_project AS is_project,
               l.due_date, l.balance_amt AS amount
        FROM latest l
        LEFT JOIN qbo_customers qc ON qc.qbo_id = l.customer_qbo_id
        WHERE l.rn = 1
          AND l.balance_amt > 0
          AND l.due_date <= :bc
    """)
    with engine.connect() as conn:
        rows = conn.execute(sql, {"bc": beyond_cap}).mappings().all()
    return _bucket(rows, week_ends, win_end, weeks, split_pastdue)


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
        if remaining <= 0 or bd is None:
            continue  # nothing left to bill or no date to place it on
        weekly = [0.0] * weeks
        beyond = 0.0
        if bd > win_end:
            beyond = round(remaining, 2)        # past the 13-week horizon
        else:
            # bucket by date; anything already past lands in week 1 (imminent)
            idx = 0
            for i, we in enumerate(week_ends):
                if (we - timedelta(days=6)) <= bd <= we:
                    idx = i
                    break
            weekly[idx] = round(remaining, 2)
        out.append({"label": r["name"], "kind": "projected", "weekly": weekly,
                    "beyond": beyond, "total": round(sum(weekly), 2)})
    out.sort(key=lambda x: x["total"] + x["beyond"], reverse=True)
    return out


# ---------------------------------------------------------------------------
# Outflow A/P: open Bills by due date, grouped by vendor
# ---------------------------------------------------------------------------
def _outflow_bills(win_start, beyond_cap, week_ends, win_end, weeks, split_pastdue=False):
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
          AND due_date <= :bc
    """)
    with engine.connect() as conn:
        rows = conn.execute(sql, {"bc": beyond_cap}).mappings().all()
    return _bucket(rows, week_ends, win_end, weeks, split_pastdue)


def _outflow_bills2(win_start, beyond_cap, week_ends, win_end, weeks, split_pastdue=False):
    """Committed A/P bucketed BOTH ways — by vendor (company) and by project — so
    the section can toggle between them. A bill's project is the customer tag on
    its lines; untagged bills fall under 'Non-project / overhead'."""
    sql = text("""
        WITH latest AS (
            SELECT qt.id, qt.vendor_qbo_id, qt.doc_number, qt.due_date, qt.balance_amt,
                   JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.VendorRef.name')) AS vendor,
                   ROW_NUMBER() OVER (PARTITION BY qt.vendor_qbo_id, COALESCE(qt.doc_number, qt.qbo_id)
                                      ORDER BY qt.id DESC) AS rn
            FROM qbo_transactions qt WHERE qt.entity_type = 'Bill'
        ),
        bill AS (
            SELECT l.id, l.due_date, l.balance_amt,
                   COALESCE(l.vendor, 'Unknown vendor') AS vendor,
                   (SELECT ln.line_customer_qbo_id FROM qbo_transaction_lines ln
                    WHERE ln.transaction_id = l.id AND ln.line_customer_qbo_id IS NOT NULL LIMIT 1) AS proj_qbo_id
            FROM latest l WHERE l.rn = 1 AND l.balance_amt > 0 AND l.due_date <= :bc
        )
        SELECT b.vendor, b.due_date, b.balance_amt AS amount, b.proj_qbo_id,
               qc.display_name AS proj_name, qc.is_project
        FROM bill b LEFT JOIN qbo_customers qc ON qc.qbo_id = b.proj_qbo_id
    """)
    with engine.connect() as conn:
        rows = conn.execute(sql, {"bc": beyond_cap}).mappings().all()
    vend_in = [{"name": r["vendor"], "due_date": r["due_date"], "amount": r["amount"]} for r in rows]
    proj_in = [{"name": (r["proj_name"] or "Non-project / overhead"),
                "due_date": r["due_date"], "amount": r["amount"],
                "link_id": r["proj_qbo_id"] if r["proj_name"] else None,
                "is_project": bool(r["is_project"])} for r in rows]
    return (_bucket(vend_in, week_ends, win_end, weeks, split_pastdue),
            _bucket(proj_in, week_ends, win_end, weeks, split_pastdue))


# ---------------------------------------------------------------------------
# Projected outflow: trailing-13-week run-rate of the JOB-COST cash-out that the
# committed view misses — vendor/contractor bill payments + job materials &
# other operating purchases not already in the overhead/payroll run-rate.
# Interim until the bi-weekly contractor payment schedule lands (then this is
# replaced by precise scheduled crew payments). Respects the exclude list.
# ---------------------------------------------------------------------------
def _outflow_jobcost_runrate(today, weeks):
    start = today - timedelta(weeks=RUNRATE_TRAILING_WEEKS)
    excluded = _excluded_categories()
    with engine.connect() as conn:
        bp = conn.execute(text("""
            SELECT COALESCE(SUM(total_amt), 0) FROM qbo_transactions
            WHERE entity_type = 'BillPayment' AND txn_date >= :s AND txn_date < :t
        """), {"s": start, "t": today}).scalar()
        pur = conn.execute(text("""
            SELECT SUBSTRING_INDEX(
                     JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')),
                     ':', 1) AS category,
                   SUM(l.amount) AS total
            FROM qbo_transactions qt
            JOIN qbo_transaction_lines l ON l.transaction_id = qt.id
            WHERE qt.entity_type = 'Purchase' AND qt.txn_date >= :s AND qt.txn_date < :t
              AND JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name') IS NOT NULL
            GROUP BY category
        """), {"s": start, "t": today}).mappings().all()

    # job materials & other = operating purchases not already in overhead/payroll
    # and not on the user's exclude list (transfers/financing/contra)
    other_total = 0.0
    for r in pur:
        cat = r["category"]
        if cat in _CATEGORY_TO_ROW or cat in excluded:
            continue
        other_total += float(r["total"] or 0)

    bp_weekly = round(float(bp or 0) / RUNRATE_TRAILING_WEEKS, 2)
    other_weekly = round(other_total / RUNRATE_TRAILING_WEEKS, 2)
    out = []
    if bp_weekly > 0:
        out.append({"label": "Vendor / contractor payments (run-rate)", "kind": "runrate",
                    "weekly": [bp_weekly] * weeks, "beyond": 0.0, "total": round(bp_weekly * weeks, 2)})
    if other_weekly > 0:
        out.append({"label": "Job materials & other (run-rate)", "kind": "runrate",
                    "weekly": [other_weekly] * weeks, "beyond": 0.0, "total": round(other_weekly * weeks, 2)})
    return out


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
            "beyond": 0.0,
            "total": round(wk * weeks, 2),
        })
    return out


# ---------------------------------------------------------------------------
# Forecast bucketing: (name, due_date, amount) -> {name: weekly[13] + beyond}.
# Dates after the window land in `beyond`; in-window dates in their week.
# Callers exclude before-window dates via SQL (so past-due isn't double-placed).
# ---------------------------------------------------------------------------
def _bucket(rows, week_ends, win_end, weeks, split_pastdue=False):
    grouped = defaultdict(lambda: {"weekly": [0.0] * weeks, "beyond": 0.0, "pastdue": 0.0,
                                   "link_id": None, "is_project": False})
    first_start = week_ends[0] - timedelta(days=6)   # Saturday of the current week
    for r in rows:
        d = r["due_date"]
        if d is None:
            continue
        amt = float(r["amount"] or 0)
        g0 = grouped[r["name"]]
        if r.get("link_id") is not None and g0["link_id"] is None:
            g0["link_id"] = str(r["link_id"])
            g0["is_project"] = bool(r.get("is_project"))
        if d > win_end:
            grouped[r["name"]]["beyond"] += amt
            continue
        if d < first_start:
            # overdue: its own "Past due" column (Forecast+) so week 1 stays clean,
            # or folded into the current week for the old forecast.
            if split_pastdue:
                grouped[r["name"]]["pastdue"] += amt
            else:
                grouped[r["name"]]["weekly"][0] += amt
            continue
        for i, we in enumerate(week_ends):
            if (we - timedelta(days=6)) <= d <= we:
                grouped[r["name"]]["weekly"][i] += amt
                break
    out = []
    for name, v in grouped.items():
        wk = [round(x, 2) for x in v["weekly"]]
        out.append({"label": name, "kind": "scheduled", "weekly": wk,
                    "beyond": round(v["beyond"], 2), "pastdue": round(v["pastdue"], 2),
                    "link_id": v["link_id"], "is_project": v["is_project"],
                    "total": round(sum(wk), 2)})
    out.sort(key=lambda x: x["total"] + x["beyond"] + x["pastdue"], reverse=True)
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
