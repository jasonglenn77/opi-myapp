"""Recurring overhead schedule (Phase 3b-2).

Editable recurring cash-out items (rent, insurance, payroll, loan payments, …)
that expand across the weekly forecast by their cadence. Replaces the trailing
run-rate as the forecast's "recurring" outflow. Auto-seeded from the run-rate the
first time so the projected balance is unchanged until the office refines the
items; from then on it's a real editable schedule like invoices/crew/expenses.
"""
from calendar import monthrange
from datetime import date, timedelta

from sqlalchemy import text

from app.db import engine

CADENCES = ("weekly", "biweekly", "monthly", "quarterly", "annual")
_STEP_DAYS = {"weekly": 7, "biweekly": 14}
_STEP_MONTHS = {"monthly": 1, "quarterly": 3, "annual": 12}


def ensure_table():
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS cashflow_overhead (
              id INT AUTO_INCREMENT PRIMARY KEY,
              name VARCHAR(120) NOT NULL,
              category VARCHAR(80) NULL,
              amount DECIMAL(14,2) NOT NULL DEFAULT 0,
              cadence VARCHAR(16) NOT NULL DEFAULT 'monthly',
              anchor_date DATE NULL, end_date DATE NULL,
              active TINYINT(1) NOT NULL DEFAULT 1,
              sort_order INT NOT NULL DEFAULT 0,
              edited TINYINT(1) NOT NULL DEFAULT 0,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB
        """))


def _add_months(d: date, n: int) -> date:
    m = d.month - 1 + n
    y = d.year + m // 12
    m = m % 12 + 1
    return date(y, m, min(d.day, monthrange(y, m)[1]))


def _occurrences(cadence, anchor, win_start, win_end, end_date):
    """The dates a recurring item lands on within [win_start, win_end]."""
    cadence = (cadence or "monthly").lower()
    if not anchor:
        anchor = win_start
    stop = win_end if not end_date else min(win_end, end_date)
    occ, d = [], anchor
    if cadence in _STEP_DAYS:
        step = _STEP_DAYS[cadence]
        if d < win_start:
            k = ((win_start - d).days + step - 1) // step
            d = d + timedelta(days=step * k)
        while d <= stop:
            occ.append(d)
            d = d + timedelta(days=step)
    else:
        months = _STEP_MONTHS.get(cadence, 1)
        while d < win_start:
            d = _add_months(d, months)
        while d <= stop:
            occ.append(d)
            d = _add_months(d, months)
    return occ


def list_overhead(active_only=False):
    ensure_table()
    where = "WHERE active = 1" if active_only else ""
    with engine.connect() as conn:
        rows = conn.execute(text(f"""
            SELECT id, name, category, amount, cadence, anchor_date, end_date,
                   active, sort_order, edited
            FROM cashflow_overhead {where}
            ORDER BY sort_order, id
        """)).mappings().all()
    return [dict(r) for r in rows]


_PERIODS_PER_YEAR = {"weekly": 52, "biweekly": 26, "monthly": 12, "quarterly": 4, "annual": 1}


def _detect_cadence(dates):
    """Infer a recurring cadence from the spacing of a sub-account's actual
    transactions (median gap in days). Defaults to monthly on thin history."""
    ds = sorted(set(dates))
    if len(ds) >= 2:
        gaps = sorted((ds[i + 1] - ds[i]).days for i in range(len(ds) - 1))
        gaps = [g for g in gaps if g > 0]
        med = gaps[len(gaps) // 2] if gaps else 30
    else:
        med = 30
    if med <= 10:
        return "weekly"
    if med <= 20:
        return "biweekly"
    if med <= 45:
        return "monthly"
    if med <= 135:
        return "quarterly"
    return "annual"


def seed_if_empty(today: date | None = None) -> int:
    """Populate from the trailing 12 months the first time: ONE item per overhead/
    payroll SUB-ACCOUNT, with a cadence detected from that account's actual
    transaction spacing and a per-occurrence amount = trailing total spread over
    that cadence (so the annual run-rate is preserved). Fully editable after."""
    ensure_table()
    with engine.connect() as conn:
        if conn.execute(text("SELECT COUNT(*) FROM cashflow_overhead")).scalar():
            return 0
    today = today or date.today()
    from collections import defaultdict
    from .service import _CATEGORY_TO_ROW  # account-name parent -> forecast row label
    start = today - timedelta(days=365)
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')) AS acct,
                   qt.txn_date AS d, l.amount AS amt
            FROM qbo_transactions qt
            JOIN qbo_transaction_lines l ON l.transaction_id = qt.id
            WHERE qt.entity_type = 'Purchase' AND qt.txn_date >= :start AND qt.txn_date < :today
              AND JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name') IS NOT NULL
        """), {"start": start, "today": today}).mappings().all()

    by_acct = defaultdict(list)  # full account name -> [(date, amount)]
    for r in rows:
        acct = r["acct"]
        if not acct or acct.split(":")[0] not in _CATEGORY_TO_ROW:
            continue  # only overhead/payroll accounts
        by_acct[acct].append((r["d"], float(r["amt"] or 0)))

    with engine.begin() as conn:
        so = 0
        for acct, txns in sorted(by_acct.items()):
            total = round(sum(a for _, a in txns), 2)
            if total <= 0:
                continue
            cadence = _detect_cadence([d for d, _ in txns])
            per_amt = round(total / _PERIODS_PER_YEAR[cadence], 2)  # preserve annual run-rate
            anchor = max(d for d, _ in txns)                        # real day-of-cycle
            parent = acct.split(":")[0]
            so += 1
            conn.execute(text("""
                INSERT INTO cashflow_overhead
                  (name, category, amount, cadence, anchor_date, active, sort_order, edited)
                VALUES (:n, :c, :a, :cad, :d, 1, :so, 0)
            """), {"n": acct, "c": _CATEGORY_TO_ROW.get(parent, parent),
                   "a": per_amt, "cad": cadence, "d": anchor, "so": so})
    return so


def expand(week_ends):
    """Expand active overhead items into weekly buckets aligned to `week_ends`.
    Returns (weekly_totals, per_item_detail, per_category_detail)."""
    weeks = len(week_ends)
    win_start = week_ends[0] - timedelta(days=6)
    win_end = week_ends[-1]

    def week_index(d):
        for i, we in enumerate(week_ends):
            if (we - timedelta(days=6)) <= d <= we:
                return i
        return None

    weekly = [0.0] * weeks
    detail = []
    cat_wk = {}  # category (top-level) -> weekly[]
    for r in list_overhead(active_only=True):
        amt = float(r["amount"] or 0)
        wk = [0.0] * weeks
        for d in _occurrences(r["cadence"], r["anchor_date"], win_start, win_end, r["end_date"]):
            i = week_index(d)
            if i is not None:
                wk[i] += amt
                weekly[i] += amt
        # item label shows just the sub-account (its category groups it)
        sub = r["name"].split(":", 1)[1].strip() if r["name"] and ":" in r["name"] else r["name"]
        detail.append({"id": r["id"], "label": sub, "category": r["category"],
                       "cadence": r["cadence"], "amount": round(amt, 2),
                       "weekly": [round(x, 2) for x in wk], "total": round(sum(wk), 2)})
        ca = cat_wk.setdefault(r["category"] or "Other", [0.0] * weeks)
        for i in range(weeks):
            ca[i] += wk[i]
    cat_detail = [{"label": c, "weekly": [round(x, 2) for x in v], "total": round(sum(v), 2)}
                  for c, v in cat_wk.items()]
    cat_detail.sort(key=lambda r: -r["total"])
    return [round(x, 2) for x in weekly], detail, cat_detail


# --- CRUD ---------------------------------------------------------------------
def create(data: dict) -> int:
    ensure_table()
    with engine.begin() as conn:
        so = conn.execute(text("SELECT COALESCE(MAX(sort_order),0)+1 FROM cashflow_overhead")).scalar()
        return conn.execute(text("""
            INSERT INTO cashflow_overhead
              (name, category, amount, cadence, anchor_date, end_date, active, sort_order, edited)
            VALUES (:name, :category, :amount, :cadence, :anchor_date, :end_date, 1, :so, 1)
        """), {
            "name": data.get("name") or "Overhead item",
            "category": data.get("category"),
            "amount": float(data.get("amount") or 0),
            "cadence": (data.get("cadence") or "monthly").lower(),
            "anchor_date": data.get("anchor_date"),
            "end_date": data.get("end_date"),
            "so": so,
        }).lastrowid


_FIELDS = {"name", "category", "amount", "cadence", "anchor_date", "end_date", "active"}


def update(oid: int, data: dict):
    ensure_table()
    sets = {k: v for k, v in data.items() if k in _FIELDS}
    if not sets:
        return
    if "cadence" in sets and sets["cadence"]:
        sets["cadence"] = str(sets["cadence"]).lower()
    cols = ", ".join(f"{k} = :{k}" for k in sets)
    sets["oid"] = oid
    with engine.begin() as conn:
        conn.execute(text(f"UPDATE cashflow_overhead SET {cols}, edited = 1 WHERE id = :oid"), sets)


def delete(oid: int):
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM cashflow_overhead WHERE id = :oid"), {"oid": oid})
