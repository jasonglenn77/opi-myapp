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
import re
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


_LAST4 = re.compile(r"\((?:\*|x|X)?(\d{4})\)")


def get_bank_balance() -> dict:
    """Opening cash = the QBO Bank accounts the office has chosen to include
    (cashflow_bank_accounts; default = every active account). Each account
    carries its QBO balance, when QBO last changed it (balance as-of) and when
    the app last pulled the chart of accounts (nightly, with the transaction
    sync). Accounts that share a bank account number (the "(6458)" in the name,
    or QBO AcctNum) are flagged so a duplicate can't silently double the cash."""
    try:
        with engine.connect() as conn:
            rows = conn.execute(text("""
                SELECT a.qbo_id, a.name, a.account_sub_type, a.current_balance, a.active,
                       a.meta_last_updated_time,
                       JSON_UNQUOTE(JSON_EXTRACT(a.raw_json, '$.AcctNum')) AS acct_num,
                       JSON_UNQUOTE(JSON_EXTRACT(a.raw_json, '$.MetaData.CreateTime')) AS created
                FROM qbo_accounts a
                WHERE a.account_type = 'Bank'
                ORDER BY a.current_balance DESC
            """)).mappings().all()
            try:
                sel = {str(r[0]): bool(r[1]) for r in conn.execute(text(
                    "SELECT qbo_account_id, included FROM cashflow_bank_accounts")).all()}
            except Exception:
                sel = {}
            try:
                synced = conn.execute(text("""
                    SELECT MAX(finished_at) FROM qbo_sync_runs
                    WHERE sync_type = 'accounts' AND success = 1""")).scalar()
            except Exception:
                synced = None
    except Exception:
        return {"available": False, "balance": 0.0, "accounts": []}

    accounts = []
    for r in rows:
        active = r["active"] is None or bool(r["active"])
        qid = str(r["qbo_id"])
        m = _LAST4.search(r["name"] or "")
        last4 = m.group(1) if m else None
        included = sel.get(qid, active)
        accounts.append({
            "qbo_id": qid, "name": r["name"], "sub_type": r["account_sub_type"],
            "balance": round(float(r["current_balance"] or 0), 2),
            "active": active, "included": bool(included),
            "default_included": active, "chosen": qid in sel,
            "acct_last4": last4, "acct_num": r["acct_num"],
            "balance_as_of": r["meta_last_updated_time"].isoformat() if r["meta_last_updated_time"] else None,
            "created_in_qbo": (r["created"] or "")[:10] or None,
        })
    # same bank number on two accounts -> warn (look-alike / duplicate account)
    by_key = {}
    for a in accounts:
        for key in {a["acct_last4"] and f"#{a['acct_last4']}", a["acct_num"] and f"acct {a['acct_num']}"} - {None, ""}:
            by_key.setdefault(key, []).append(a)
    warnings = []
    for key, accs in by_key.items():
        if len(accs) > 1:
            for a in accs:
                a.setdefault("duplicate_of", [])
                a["duplicate_of"] += [b["name"] for b in accs if b is not a]
            warnings.append({"key": key, "accounts": [a["name"] for a in accs],
                             "included": [a["name"] for a in accs if a["included"]]})
    inc = [a for a in accounts if a["included"]]
    total = round(sum(a["balance"] for a in inc), 2)
    # 0085: the opening can start from the bank balance typed on the B250
    # (the bank's own balance) instead of the QuickBooks books.
    source = get_setting("opening_source", "b250")
    b250 = b250_opening()
    use_b250 = source == "b250" and b250 is not None
    return {
        "available": len(accounts) > 0 or use_b250,
        "balance": b250["balance"] if use_b250 else total,
        "source": "b250" if use_b250 else "qbo",
        "source_setting": source,
        "books_balance": total,
        "b250": b250,
        "accounts": accounts,
        "included_count": len(inc),
        "last_synced": synced.isoformat() if synced else None,   # UTC
        "duplicate_warnings": warnings,
    }


def get_setting(key, default=None):
    try:
        with engine.connect() as conn:
            v = conn.execute(text("SELECT svalue FROM cashflow_settings WHERE skey = :k"), {"k": key}).scalar()
        return v if v is not None else default
    except Exception:
        return default   # table not migrated yet


def set_setting(key, value, actor=None):
    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO cashflow_settings (skey, svalue, updated_by) VALUES (:k, :v, :by)
            ON DUPLICATE KEY UPDATE svalue = VALUES(svalue), updated_by = VALUES(updated_by)
        """), {"k": key, "v": value, "by": actor})


def b250_opening():
    """The opening cash typed on the latest B250 copy: the bank's own balance
    (Julie copies it from the QuickBooks bank screen). None if no copy."""
    try:
        with engine.connect() as conn:
            r = conn.execute(text("""
                SELECT s.tab_name, s.week1_end, s.loaded_at, s.file_modified, s.source, l.amount
                FROM gsync_b250_snapshot s
                JOIN gsync_b250_lines l ON l.snapshot_id = s.id AND l.section = 'opening'
                ORDER BY s.id DESC LIMIT 1""")).mappings().first()
    except Exception:
        return None
    if not r or r["amount"] is None:
        return None
    return {"balance": round(float(r["amount"]), 2), "tab": r["tab_name"],
            "week1_end": r["week1_end"].isoformat() if r["week1_end"] else None,
            # file_modified is text on some databases, a datetime on others
            "as_of": str(r["file_modified"] or r["loaded_at"] or "").replace(" ", "T")[:19] or None,
            "source": r["source"]}


def set_bank_inclusion(choices: dict, actor: str | None = None) -> dict:
    """Persist include/exclude per QBO bank account: {qbo_account_id: bool}."""
    with engine.begin() as conn:
        for qid, inc in (choices or {}).items():
            conn.execute(text("""
                INSERT INTO cashflow_bank_accounts (qbo_account_id, included, updated_by)
                VALUES (:q, :i, :u)
                ON DUPLICATE KEY UPDATE included = VALUES(included), updated_by = VALUES(updated_by)
            """), {"q": str(qid), "i": 1 if inc else 0, "u": actor})
    return get_bank_balance()


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


OVERDUE_ROW = "Overdue — expected date passed"
CREW_MATCH_EARLY_DAYS = 3      # a crew payment up to 3 days before the pay date counts
CREW_MATCH_WINDOW_DAYS = 17    # ...and up to one pay cycle (+3 days) after it
CREW_MATCH_TOL_ABS = 250.0     # covered within $250 ...
CREW_MATCH_TOL_PCT = 0.05      # ... or 5% of the installment = paid


def _open_ar_v2(beyond_cap):
    """Open QBO invoices (latest version per doc) with every date the forecast
    needs: sent (txn_date), due, expected-paid (override > aligned milestone)."""
    from app.billing.retainage import is_retainage, release_dates
    from app.billing.routes import invoice_expected_dates
    sql = text("""
        WITH latest AS (
            SELECT qt.id, qt.qbo_id, qt.customer_qbo_id, qt.doc_number, qt.txn_date, qt.due_date,
                   qt.balance_amt, qt.total_amt, qt.raw_json,
                   ROW_NUMBER() OVER (
                       PARTITION BY qt.customer_qbo_id, COALESCE(qt.doc_number, qt.qbo_id)
                       ORDER BY qt.id DESC) AS rn
            FROM qbo_transactions qt
            WHERE qt.entity_type = 'Invoice'
        )
        SELECT COALESCE(qc.display_name, 'Unknown') AS name,
               qc.qbo_id AS link_id, qc.is_project AS is_project,
               l.qbo_id, l.doc_number, l.txn_date, l.due_date, l.balance_amt AS amount, l.total_amt, l.raw_json
        FROM latest l
        LEFT JOIN qbo_customers qc ON qc.qbo_id = l.customer_qbo_id
        WHERE l.rn = 1 AND l.balance_amt > 0
    """)
    with engine.connect() as conn:
        rows = [dict(r) for r in conn.execute(sql).mappings().all()]
        ov, ms = invoice_expected_dates(conn, [r["qbo_id"] for r in rows])
        ret = [r for r in rows if is_retainage(r["total_amt"], r["amount"], r["raw_json"])]
        rel = release_dates(conn, {str(r["link_id"]) for r in ret if r["link_id"]}) if ret else {}
    for r in rows:
        r["retainage"] = is_retainage(r["total_amt"], r["amount"], r["raw_json"])
        exp = ov.get(str(r["qbo_id"])) or ms.get(str(r["qbo_id"]))
        r["expected"] = date.fromisoformat(exp) if exp else None
        r["expected_src"] = "override" if ov.get(str(r["qbo_id"])) else ("milestone" if exp else None)
        r["release"] = rel.get(str(r["link_id"])) if r["retainage"] else None
        r.pop("raw_json", None)
    return rows


def _open_ap_v2():
    """Open QBO bills (latest version per doc), vendor + project tag + dates."""
    sql = text("""
        WITH latest AS (
            SELECT qt.id, qt.qbo_id, qt.vendor_qbo_id, qt.doc_number, qt.txn_date, qt.due_date, qt.balance_amt,
                   JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.VendorRef.name')) AS vendor,
                   ROW_NUMBER() OVER (PARTITION BY qt.vendor_qbo_id, COALESCE(qt.doc_number, qt.qbo_id)
                                      ORDER BY qt.id DESC) AS rn
            FROM qbo_transactions qt WHERE qt.entity_type = 'Bill'
        ),
        bill AS (
            SELECT l.id, l.qbo_id, l.doc_number, l.txn_date, l.due_date, l.balance_amt, l.vendor_qbo_id,
                   COALESCE(l.vendor, 'Unknown vendor') AS vendor,
                   (SELECT ln.line_customer_qbo_id FROM qbo_transaction_lines ln
                    WHERE ln.transaction_id = l.id AND ln.line_customer_qbo_id IS NOT NULL LIMIT 1) AS proj_qbo_id
            FROM latest l WHERE l.rn = 1 AND l.balance_amt > 0
        )
        SELECT b.*, qc.display_name AS proj_name, qc.is_project
        FROM bill b LEFT JOIN qbo_customers qc ON qc.qbo_id = b.proj_qbo_id
    """)
    with engine.connect() as conn:
        return [dict(r) for r in conn.execute(sql).mappings().all()]


def _match_overdue_crew(crew_events):
    """Owner rule (2026-10-26): an overdue, still-unpaid crew installment counts
    as PAID when QuickBooks shows the crew vendor paid on/after its pay date —
    crews are paid on company-wide bi-weekly runs, so one BillPayment usually
    covers several projects. Per vendor, payments (BillPayment + direct
    Purchase/check, by txn_date) are allocated to that vendor's overdue
    installments oldest-first within [pay_date-3d, pay_date+17d]; an
    installment covered to within max($250, 5%) is treated as paid.
    Returns (paid_events, unpaid_events) — each event gains `matched`
    [{date, amount}] when (partly) covered."""
    from sqlalchemy import bindparam
    vendors = sorted({str(e["vendor"]) for e in crew_events if e.get("vendor")})
    pays = {}
    if vendors:
        mn = min(date.fromisoformat(e["date"]) for e in crew_events) - timedelta(days=CREW_MATCH_EARLY_DAYS)
        with engine.connect() as conn:
            for r in conn.execute(text("""
                SELECT vendor_qbo_id, txn_date, total_amt FROM qbo_transactions
                WHERE entity_type IN ('BillPayment', 'Purchase') AND vendor_qbo_id IN :v
                  AND txn_date >= :mn AND total_amt > 0
                ORDER BY txn_date, id
            """).bindparams(bindparam("v", expanding=True)), {"v": vendors, "mn": mn}).mappings().all():
                pays.setdefault(str(r["vendor_qbo_id"]), []).append(
                    {"date": r["txn_date"], "left": float(r["total_amt"] or 0)})
    paid, unpaid = [], []
    for e in sorted(crew_events, key=lambda x: (x["date"], x.get("iid") or 0)):
        v = str(e.get("vendor") or "")
        d = date.fromisoformat(e["date"])
        need = float(e["amt"])
        got, matched = 0.0, []
        for p in pays.get(v, []):
            if p["left"] <= 0.005:
                continue
            if not (d - timedelta(days=CREW_MATCH_EARLY_DAYS) <= p["date"] <= d + timedelta(days=CREW_MATCH_WINDOW_DAYS)):
                continue
            take = min(p["left"], need - got)
            if take <= 0:
                break
            p["left"] -= take
            got += take
            matched.append({"date": p["date"].isoformat(), "amount": round(take, 2)})
            if got >= need - 0.005:
                break
        ev = {**e, "matched": matched, "matched_amt": round(got, 2)}
        if need - got <= max(CREW_MATCH_TOL_ABS, CREW_MATCH_TOL_PCT * need):
            paid.append(ev)
        else:
            if got > 0.5:
                ev["amt"] = round(need - got, 2)   # only the uncovered part stays overdue
            unpaid.append(ev)
    return paid, unpaid


def _bucket_rows_v2(items, week_ends, key_fn, link_fn=None):
    """Group (date, amount) items into weekly rows by key_fn(item). Items after
    the horizon go to `beyond`. Callers remove overdue items first."""
    weeks = len(week_ends)
    first_start = week_ends[0] - timedelta(days=6)
    grouped = {}
    for it in items:
        d = it["_date"]
        k = key_fn(it)
        g = grouped.setdefault(k, {"weekly": [0.0] * weeks, "beyond": 0.0, "link_id": None, "is_project": False})
        if link_fn:
            lid, isp = link_fn(it)
            if lid is not None and g["link_id"] is None:
                g["link_id"], g["is_project"] = str(lid), bool(isp)
        if d > week_ends[-1]:
            g["beyond"] += it["_amt"]
            continue
        idx = max(0, (d - first_start).days // 7)
        g["weekly"][min(idx, weeks - 1)] += it["_amt"]
    out = []
    for k, g in grouped.items():
        wk = [round(x, 2) for x in g["weekly"]]
        out.append({"label": k, "kind": "scheduled", "weekly": wk, "beyond": round(g["beyond"], 2),
                    "pastdue": 0.0, "link_id": g["link_id"], "is_project": g["is_project"],
                    "total": round(sum(wk), 2)})
    return out


def generate_forecast_v2(start_date: date | None = None,
                         weeks: int = 26,
                         opening_balance: float | None = None,
                         max_age_seconds: int = 1800,
                         count_overdue_plans: bool = False) -> dict:
    """Forecast from the chosen QBO bank accounts' balance + committed QBO layers
    (open invoices on their EXPECTED-PAID date, open bills on their due date) +
    recurring overhead + the SCHEDULED layer from every project's Billing tab.

    Owner rules (2026-10-26): no assumed lags — every item sits on its expected
    paid date. Nothing is settled into the opening. An unpaid item whose date
    has passed is "overdue — expected date passed":
      * open QBO invoices / bills (real documents) -> counted in week 1 on a
        flagged Overdue row and listed for follow-up;
      * crew installments -> first matched to the crew's QBO payments (paid on
        the bi-weekly runs => dropped as paid); the rest, plus never-invoiced
        milestones and unspent planned expenses, are flagged in week 1 but NOT
        counted (they need a new date) unless count_overdue_plans=True.
    Undated won projects stay off the grid in `backlog` ("Won — not scheduled")."""
    from . import schedule_forecast as SF

    today = date.today()
    if start_date is None:
        start_date = _next_weekday(today, WEEK_END_WEEKDAY)  # coming Friday
    week_ends = [start_date + timedelta(days=7 * i) for i in range(weeks)]
    first_start = week_ends[0] - timedelta(days=6)
    win_end = week_ends[-1]

    bank = get_bank_balance()
    if opening_balance is None:
        opening_balance = bank.get("balance", 0.0)

    overdue_items = []   # the follow-up list (every overdue thing, counted or not)

    def _days_late(d):
        return (first_start - d).days if d else None

    # ---- A/R: open invoices on expected-paid (override > milestone > due) ----
    ar_items, ar_overdue = [], []
    for r in _open_ar_v2(win_end + timedelta(days=180)):
        amt = float(r["amount"] or 0)
        if r["retainage"]:
            # held retainage: arrives at release (project end + 30); unknown or
            # already-past release -> beyond the horizon, never overdue
            d = r["release"] if (r["release"] and r["release"] >= first_start) else (win_end + timedelta(days=1))
            ar_items.append({**r, "_date": d, "_amt": amt, "_label": f"{r['name']} · retainage held"})
            continue
        d = r["expected"] or r["due_date"]
        if d is None:
            continue
        if d < first_start:
            ar_overdue.append({**r, "_date": d, "_amt": amt})
            overdue_items.append({
                "kind": "ar", "type": "Invoice sent — not paid", "counted": True,
                "label": r["name"], "link_id": str(r["link_id"]) if r["link_id"] else None,
                "is_project": bool(r["is_project"]), "doc": r["doc_number"], "qbo_id": str(r["qbo_id"]),
                "sent": r["txn_date"].isoformat() if r["txn_date"] else None,
                "due": r["due_date"].isoformat() if r["due_date"] else None,
                "expected": r["expected"].isoformat() if r["expected"] else None,
                "expected_src": r["expected_src"], "amount": round(amt, 2), "days_late": _days_late(d)})
        else:
            ar_items.append({**r, "_date": d, "_amt": amt, "_label": r["name"]})
    inv_rows = _bucket_rows_v2(ar_items, week_ends, lambda it: it["_label"],
                               lambda it: (it["link_id"], it["is_project"]))
    inv_rows.sort(key=lambda r: (r.get("label") or "").lower())
    ar_od_total = round(sum(x["_amt"] for x in ar_overdue), 2)
    if ar_od_total > 0.5:
        wk = [0.0] * weeks
        wk[0] = ar_od_total
        inv_rows.insert(0, {"label": f"⚠ {OVERDUE_ROW} ({len(ar_overdue)} invoices — follow up)",
                            "kind": "overdue", "flag": "overdue", "weekly": wk, "beyond": 0.0,
                            "pastdue": 0.0, "link_id": None, "is_project": False, "total": ar_od_total})
    inv_wt = _column_sums(inv_rows, weeks)

    # ---- A/P: open bills on their due date; past-due bills -> week 1 flagged ----
    ap_items, ap_overdue = [], []
    for r in _open_ap_v2():
        d = r["due_date"]
        amt = float(r["balance_amt"] or 0)
        if d is None:
            continue
        item = {**r, "_date": d, "_amt": amt}
        if d < first_start:
            ap_overdue.append(item)
            overdue_items.append({
                "kind": "ap", "type": "Bill past due — pay now", "counted": True,
                "label": r["vendor"], "project": r["proj_name"],
                "link_id": str(r["proj_qbo_id"]) if r["proj_name"] else None, "is_project": bool(r["is_project"]),
                "doc": r["doc_number"], "sent": r["txn_date"].isoformat() if r["txn_date"] else None,
                "due": d.isoformat(), "expected": None, "amount": round(amt, 2), "days_late": _days_late(d)})
        else:
            ap_items.append(item)
    ap_rows = _bucket_rows_v2(ap_items, week_ends, lambda it: it["vendor"])
    ap_proj_rows = _bucket_rows_v2(ap_items, week_ends, lambda it: it["proj_name"] or "Non-project / overhead",
                                   lambda it: (it["proj_qbo_id"] if it["proj_name"] else None, it["is_project"]))
    ap_rows.sort(key=lambda r: -(r["total"] + r["beyond"]))
    ap_proj_rows.sort(key=lambda r: (r.get("label") or "").lower())
    ap_od_total = round(sum(x["_amt"] for x in ap_overdue), 2)
    if ap_od_total > 0.5:
        for rows in (ap_rows, ap_proj_rows):
            wk = [0.0] * weeks
            wk[0] = ap_od_total
            rows.insert(0, {"label": f"⚠ Overdue — bills past due ({len(ap_overdue)})", "kind": "overdue",
                            "flag": "overdue", "weekly": wk, "beyond": 0.0, "pastdue": 0.0,
                            "link_id": None, "is_project": False, "total": ap_od_total})
    ap_wt = _column_sums(ap_rows, weeks)

    # ---- recurring overhead: editable schedule expanded by cadence ----
    from . import overhead as OV
    OV.seed_if_empty(today)
    rec_wt, rec_items, rec_cats = OV.expand(week_ends)

    # ---- scheduled layer (cached event pass, bucketed to this horizon) ----
    payload, cache_meta = SF.get_events(max_age_seconds)
    crew_paid_matched, plan_overdue = [], []
    if payload:
        sched = SF.bucket_events(payload, start_date, weeks)
        sched_in, sched_out = list(sched["inflow"]), list(sched["outflow"])
        backlog = sched["backlog"]
        sched_projects = sched["projects"]
        beyond_in, beyond_out = sched["beyond_in"], sched["beyond_out"]
        sched_in_rows, sched_out_rows = sched["sched_in_rows"], sched["sched_out_rows"]
        sched_out_by_type = sched["sched_out_by_type"]
        od = sched.get("overdue") or []
        crew_od = [e for e in od if e.get("src") == "crew"]
        crew_paid_matched, crew_unpaid = _match_overdue_crew(crew_od) if crew_od else ([], [])
        plan_overdue = [e for e in od if e.get("src") != "crew"] + crew_unpaid
    else:
        sched_in = [0.0] * weeks
        sched_out = [0.0] * weeks
        backlog = {"in": 0.0, "out": 0.0}
        sched_projects = []
        beyond_in = beyond_out = 0.0
        sched_in_rows = sched_out_rows = sched_out_by_type = []

    _PLAN_TYPE = {"invoice": "Planned invoice — date passed, not invoiced",
                  "crew": "Crew payment — date passed, no matching QBO payment",
                  "expense": "Planned expense — date passed, not spent"}
    plan_in = plan_out = 0.0
    for e in plan_overdue:
        d = date.fromisoformat(e["date"])
        is_in = e["dir"] == "in"
        if is_in:
            plan_in += e["amt"]
        else:
            plan_out += e["amt"]
        overdue_items.append({
            "kind": e.get("src"), "type": _PLAN_TYPE.get(e.get("src"), "Planned item — date passed"),
            "counted": bool(count_overdue_plans), "label": e.get("project"),
            "link_id": str(e.get("entity_id")) if e.get("entity_id") else None, "is_project": True,
            "detail": (e.get("label") if is_in else (e.get("crew") if e.get("src") == "crew" else e.get("cat"))),
            "doc": e.get("est"),
            "sent": e.get("sent") or e.get("send"), "due": e.get("due") or (e["date"] if not is_in else None),
            "expected": e.get("exp"), "date": e["date"],
            "amount": round(e["amt"], 2), "days_late": _days_late(d),
            "matched_amt": e.get("matched_amt") or 0.0})
    plan_in, plan_out = round(plan_in, 2), round(plan_out, 2)

    def _memo_row(label, amount):
        wk = [0.0] * weeks
        wk[0] = amount
        return {"label": label, "kind": "overdue", "flag": "overdue" if count_overdue_plans else "memo",
                "weekly": wk, "beyond": 0.0, "pastdue": 0.0, "link_id": None, "is_project": False,
                "total": amount if count_overdue_plans else 0.0}

    n_in = sum(1 for e in plan_overdue if e["dir"] == "in")
    n_out = len(plan_overdue) - n_in
    if plan_in > 0.5:
        sched_in_rows = [_memo_row(f"⚠ Overdue plans — dates passed, not invoiced ({n_in})"
                                   + ("" if count_overdue_plans else " · not in totals"), plan_in)] + list(sched_in_rows)
        if count_overdue_plans:
            sched_in[0] += plan_in
    if plan_out > 0.5:
        sched_out_rows = [_memo_row(f"⚠ Overdue plans — crew/expense dates passed ({n_out})"
                                    + ("" if count_overdue_plans else " · not in totals"), plan_out)] + list(sched_out_rows)
        if count_overdue_plans:
            sched_out[0] += plan_out

    def _sec(key, label, rows, wt, tier):
        return {"key": key, "label": label, "rows": rows, "tier": tier,
                "weekly_totals": [round(x, 2) for x in wt],
                "grand_total": round(sum(wt), 2), "pastdue": 0.0}

    inflow_weekly = [round(inv_wt[i] + sched_in[i], 2) for i in range(weeks)]
    outflow_weekly = [round(ap_wt[i] + rec_wt[i] + sched_out[i], 2) for i in range(weeks)]

    opening, surplus, ending = _zeros(weeks), _zeros(weeks), _zeros(weeks)
    bal = round(float(opening_balance), 2)
    for i in range(weeks):
        opening[i] = round(bal, 2)
        surplus[i] = round(inflow_weekly[i] - outflow_weekly[i], 2)
        bal = bal + inflow_weekly[i] - outflow_weekly[i]
        ending[i] = round(bal, 2)

    overdue_items.sort(key=lambda x: (not x["counted"], -(x["amount"] or 0)))
    crew_paid_list = [{
        "project": e.get("project"), "link_id": str(e.get("entity_id")) if e.get("entity_id") else None,
        "crew": e.get("crew"), "pay_date": e["date"], "send_invoice_date": e.get("send"),
        "amount": round(e["amt"], 2), "matched": e.get("matched") or []} for e in crew_paid_matched]

    return {
        "mode": "forecast_v2",
        "as_of": today.isoformat(),
        "start_date": week_ends[0].isoformat(),
        "weeks": weeks,
        "week_ends": [d.isoformat() for d in week_ends],
        "opening_balance": round(float(opening_balance), 2),
        "bank": bank,
        "cache": cache_meta,
        # kept for older clients: nothing is settled into the opening any more
        "past_due": {"label": "Past due", "inflow": 0.0, "outflow": 0.0,
                     "opening": round(float(opening_balance), 2), "surplus": 0.0,
                     "ending": round(float(opening_balance), 2)},
        "overdue": {
            "count_plans": bool(count_overdue_plans),
            "ar_counted": ar_od_total, "ap_counted": ap_od_total,
            "plans_in": plan_in, "plans_out": plan_out,
            "items": overdue_items,
            "crew_matched_paid": {"count": len(crew_paid_list),
                                  "amount": round(sum(x["amount"] for x in crew_paid_list), 2),
                                  "items": crew_paid_list},
        },
        "inflow": {
            "label": "Cash Inflow",
            "sections": [
                _sec("ar", "Open invoices (A/R, on expected-paid date)", inv_rows, inv_wt, "committed"),
                {"key": "scheduled", "label": "Need to bill (project schedules)", "tier": "scheduled",
                 "rows": sched_in_rows,
                 "weekly_totals": [round(x, 2) for x in sched_in],
                 "grand_total": round(sum(sched_in), 2), "pastdue": 0.0},
            ],
            "weekly_totals": inflow_weekly,
            "grand_total": round(sum(inflow_weekly), 2),
            "beyond_total": round(beyond_in, 2),
            "pastdue_total": 0.0,
        },
        "outflow": {
            "label": "Cash Outflow",
            "sections": [
                {**_sec("ap", "Open bills (A/P, by due date)", ap_rows, ap_wt, "committed"),
                 "alt_rows": ap_proj_rows, "view_a": "By vendor", "view_b": "By project"},
                {"key": "scheduled", "label": "Crew & expenses (project schedules)", "tier": "scheduled",
                 "rows": sched_out_rows, "alt_rows": sched_out_by_type, "view_a": "By project", "view_b": "By type",
                 "weekly_totals": [round(x, 2) for x in sched_out],
                 "grand_total": round(sum(sched_out), 2), "pastdue": 0.0},
                {**_sec("recurring", "Recurring — overhead & payroll", rec_cats, rec_wt, "estimated"),
                 "alt_rows": rec_items, "view_a": "By category", "view_b": "By item"},
            ],
            "weekly_totals": outflow_weekly,
            "grand_total": round(sum(outflow_weekly), 2),
            "beyond_total": round(beyond_out, 2),
            "pastdue_total": 0.0,
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

    pay_rows = _act_payments(win_start, win_end, week_index, weeks)          # by customer (linked)
    bp_rows = _act_billpay(win_start, win_end, week_index, weeks)            # by vendor
    pur_cat = _act_purchases_by(win_start, win_end, week_index, weeks, "category")
    pur_proj = _act_purchases_by(win_start, win_end, week_index, weeks, "project")

    inflow_totals = _column_sums(pay_rows, weeks)
    bp_totals = _column_sums(bp_rows, weeks)
    pur_totals = _column_sums(pur_cat, weeks)   # category & project views share the same total
    outflow_totals = [round(bp_totals[i] + pur_totals[i], 2) for i in range(weeks)]

    opening, surplus, ending = _zeros(weeks), _zeros(weeks), _zeros(weeks)
    bal = float(opening_balance)
    for i in range(weeks):
        opening[i] = round(bal, 2)
        surplus[i] = round(inflow_totals[i] - outflow_totals[i], 2)
        bal = bal + inflow_totals[i] - outflow_totals[i]
        ending[i] = round(bal, 2)

    def _asec(key, label, rows, wt, alt=None, va=None, vb=None):
        s = {"key": key, "label": label, "rows": rows, "tier": "committed",
             "weekly_totals": [round(x, 2) for x in wt], "grand_total": round(sum(wt), 2)}
        if alt is not None:
            s.update({"alt_rows": alt, "view_a": va, "view_b": vb})
        return s

    return {
        "mode": "actuals",
        "as_of": today.isoformat(),
        "start_date": week_ends[0].isoformat(),
        "weeks": weeks,
        "week_ends": [d.isoformat() for d in week_ends],
        "opening_balance": round(float(opening_balance), 2),
        "inflow": {
            "label": "Cash Collected",
            "sections": [_asec("payments", "Customer payments received", pay_rows, inflow_totals)],
            "weekly_totals": [round(x, 2) for x in inflow_totals],
            "grand_total": round(sum(inflow_totals), 2),
        },
        "outflow": {
            "label": "Cash Paid Out",
            "sections": [
                _asec("billpay", "Bill payments (vendors/contractors)", bp_rows, bp_totals),
                _asec("purchases", "Direct expenses (cards/checks)", pur_cat, pur_totals,
                      pur_proj, "By category", "By project"),
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
                   qt.total_amt, qt.raw_json,
                   ROW_NUMBER() OVER (
                       PARTITION BY qt.customer_qbo_id, COALESCE(qt.doc_number, qt.qbo_id)
                       ORDER BY qt.id DESC
                   ) AS rn
            FROM qbo_transactions qt
            WHERE qt.entity_type = 'Invoice'
        )
        SELECT COALESCE(qc.display_name, 'Unknown') AS name,
               qc.qbo_id AS link_id, qc.is_project AS is_project,
               l.due_date, l.balance_amt AS amount, l.total_amt, l.raw_json
        FROM latest l
        LEFT JOIN qbo_customers qc ON qc.qbo_id = l.customer_qbo_id
        WHERE l.rn = 1
          AND l.balance_amt > 0
          AND l.due_date <= :bc
    """)
    from app.billing.retainage import is_retainage, release_dates
    with engine.connect() as conn:
        rows = [dict(r) for r in conn.execute(sql, {"bc": beyond_cap}).mappings().all()]
        # Held retainage (paid except a held-back 5-15%) isn't past-due A/R: it
        # arrives when the customer releases it. Its own row per project, dated
        # at the project's end + 30 days; when that's unknown or already behind
        # us, it goes to "beyond" (expected later, timing unknown) — never Past due.
        ret = [r for r in rows if is_retainage(r["total_amt"], r["amount"], r["raw_json"])]
        rel = release_dates(conn, {str(r["link_id"]) for r in ret if r["link_id"]}) if ret else {}
    first_start = week_ends[0] - timedelta(days=6)
    for r in ret:
        d = rel.get(str(r["link_id"]))
        r["name"] = f"{r['name']} · retainage held"
        r["due_date"] = d if (d and d >= first_start) else (win_end + timedelta(days=1))
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
def _bucket_named(rows, week_index, weeks):
    """Group (name, due_date, amount [, link_id, is_project]) rows into weekly rows,
    carrying an optional project link so the Actuals view can drill to a project."""
    grouped = {}
    for r in rows:
        idx = week_index(r["due_date"])
        if idx is None:
            continue
        g = grouped.setdefault(r["name"], {"weekly": [0.0] * weeks, "link_id": None, "is_project": False})
        g["weekly"][idx] += float(r["amount"] or 0)
        if r.get("link_id") is not None and g["link_id"] is None:
            g["link_id"] = str(r["link_id"])
            g["is_project"] = bool(r.get("is_project"))
    out = [{"label": name, "weekly": [round(x, 2) for x in g["weekly"]],
            "link_id": g["link_id"], "is_project": g["is_project"],
            "total": round(sum(g["weekly"]), 2)} for name, g in grouped.items()]
    out.sort(key=lambda x: -x["total"])
    return out


def _act_payments(win_start, win_end, week_index, weeks):
    """Customer payments received, by customer (linked to the project)."""
    sql = text("""
        SELECT COALESCE(qc.display_name,
                        JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.CustomerRef.name')),
                        'Unknown') AS name,
               qc.qbo_id AS link_id, qc.is_project AS is_project,
               qt.txn_date AS due_date, qt.total_amt AS amount
        FROM qbo_transactions qt
        LEFT JOIN qbo_customers qc ON qc.qbo_id = qt.customer_qbo_id
        WHERE qt.entity_type = 'Payment' AND qt.txn_date BETWEEN :ws AND :we
          AND qt.total_amt IS NOT NULL
    """)
    with engine.connect() as conn:
        rows = conn.execute(sql, {"ws": win_start, "we": win_end}).mappings().all()
    return _bucket_named(rows, week_index, weeks)


def _act_billpay(win_start, win_end, week_index, weeks):
    """Bill payments (vendors/contractors), by vendor. BillPayments carry no
    project tag, so this is vendor-only (the vendor is the crew/company paid)."""
    sql = text("""
        SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(qt.raw_json, '$.VendorRef.name')),
                        'Unknown vendor') AS name,
               qt.txn_date AS due_date, qt.total_amt AS amount
        FROM qbo_transactions qt
        WHERE qt.entity_type = 'BillPayment' AND qt.txn_date BETWEEN :ws AND :we
          AND qt.total_amt IS NOT NULL
    """)
    with engine.connect() as conn:
        rows = conn.execute(sql, {"ws": win_start, "we": win_end}).mappings().all()
    return _bucket_named(rows, week_index, weeks)


def _act_purchases_by(win_start, win_end, week_index, weeks, dim):
    """Direct expenses (cards/checks) grouped by `dim`: 'category' (expense
    account) or 'project' (the line's customer tag; untagged -> Non-project).
    Both views drop the same user-excluded categories, so their totals match."""
    sql = text("""
        SELECT COALESCE(SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(
                 l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')), ':', 1), 'Other') AS category,
               l.line_customer_qbo_id AS proj_id, qc.display_name AS proj_name, qc.is_project AS is_project,
               qt.txn_date AS due_date, l.amount AS amount
        FROM qbo_transactions qt
        JOIN qbo_transaction_lines l ON l.transaction_id = qt.id
        LEFT JOIN qbo_customers qc ON qc.qbo_id = l.line_customer_qbo_id
        WHERE qt.entity_type = 'Purchase' AND qt.txn_date BETWEEN :ws AND :we
          AND l.amount IS NOT NULL
    """)
    excluded = _excluded_categories()
    with engine.connect() as conn:
        raw = conn.execute(sql, {"ws": win_start, "we": win_end}).mappings().all()
    rows = []
    for r in raw:
        if r["category"] in excluded:
            continue
        if dim == "project":
            rows.append({"name": r["proj_name"] or "Non-project / overhead", "due_date": r["due_date"],
                         "amount": r["amount"], "link_id": r["proj_id"] if r["proj_name"] else None,
                         "is_project": r["is_project"]})
        else:
            rows.append({"name": r["category"], "due_date": r["due_date"], "amount": r["amount"]})
    return _bucket_named(rows, week_index, weeks)


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
