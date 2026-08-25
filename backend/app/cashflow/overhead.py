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
              seed_amount DECIMAL(14,2) NULL,
              cadence VARCHAR(16) NOT NULL DEFAULT 'monthly',
              seed_cadence VARCHAR(16) NULL,
              anchor_date DATE NULL, seed_anchor_date DATE NULL, end_date DATE NULL,
              active TINYINT(1) NOT NULL DEFAULT 1,
              sort_order INT NOT NULL DEFAULT 0,
              edited TINYINT(1) NOT NULL DEFAULT 0,
              from_qbo TINYINT(1) NOT NULL DEFAULT 1,
              deleted_at DATETIME NULL,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB
        """))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS cashflow_overhead_history (
              id INT AUTO_INCREMENT PRIMARY KEY,
              overhead_id INT NOT NULL,
              action VARCHAR(16) NOT NULL,
              actor VARCHAR(255) NULL,
              item_name VARCHAR(120) NULL,
              old_amount DECIMAL(14,2) NULL, new_amount DECIMAL(14,2) NULL,
              old_cadence VARCHAR(16) NULL, new_cadence VARCHAR(16) NULL,
              old_anchor_date DATE NULL, new_anchor_date DATE NULL,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              INDEX idx_oh_hist (overhead_id, id)
            ) ENGINE=InnoDB
        """))


def _record_history(conn, oid, action, actor, item_name, old, new):
    """Log one change. old/new are dicts with amount/cadence/anchor_date keys
    (None where not applicable, e.g. create has no old, delete has no new)."""
    old = old or {}
    new = new or {}
    conn.execute(text("""
        INSERT INTO cashflow_overhead_history
          (overhead_id, action, actor, item_name,
           old_amount, new_amount, old_cadence, new_cadence, old_anchor_date, new_anchor_date)
        VALUES (:oid, :action, :actor, :name,
           :oa, :na, :oc, :nc, :oad, :nad)
    """), {"oid": oid, "action": action, "actor": actor, "name": item_name,
           "oa": old.get("amount"), "na": new.get("amount"),
           "oc": old.get("cadence"), "nc": new.get("cadence"),
           "oad": old.get("anchor_date"), "nad": new.get("anchor_date")})


def list_history(oid: int):
    ensure_table()
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT action, actor, item_name, old_amount, new_amount,
                   old_cadence, new_cadence, old_anchor_date, new_anchor_date, created_at
            FROM cashflow_overhead_history WHERE overhead_id = :oid
            ORDER BY id DESC
        """), {"oid": oid}).mappings().all()
    return [dict(r) for r in rows]


def revert_to_auto(oid: int, actor: str | None = None):
    """Restore an item to its auto-generated (seed) amount/cadence/anchor and clear
    the edited flag. No-op if there's no stored baseline."""
    ensure_table()
    with engine.begin() as conn:
        r = conn.execute(text(
            "SELECT name, amount, cadence, anchor_date, seed_amount, seed_cadence, seed_anchor_date "
            "FROM cashflow_overhead WHERE id = :oid"), {"oid": oid}).mappings().first()
        if not r or r["seed_amount"] is None:
            return False
        old = {"amount": r["amount"], "cadence": r["cadence"], "anchor_date": r["anchor_date"]}
        new = {"amount": r["seed_amount"], "cadence": r["seed_cadence"], "anchor_date": r["seed_anchor_date"]}
        conn.execute(text("""
            UPDATE cashflow_overhead
               SET amount = :a, cadence = :c, anchor_date = :d, edited = 0
             WHERE id = :oid
        """), {"a": new["amount"], "c": new["cadence"], "d": new["anchor_date"], "oid": oid})
        _record_history(conn, oid, "revert", actor, r["name"], old, new)
    return True


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
    conds = ["deleted_at IS NULL"]     # soft-deleted rows never appear here
    if active_only:
        conds.append("active = 1")
    where = "WHERE " + " AND ".join(conds)
    with engine.connect() as conn:
        rows = conn.execute(text(f"""
            SELECT id, name, category, amount, cadence, anchor_date, end_date,
                   active, sort_order, edited, from_qbo,
                   seed_amount, seed_cadence, seed_anchor_date
            FROM cashflow_overhead {where}
            ORDER BY sort_order, id
        """)).mappings().all()
    return [dict(r) for r in rows]


def list_deleted():
    """Soft-deleted items, with when + who deleted (from the latest delete log)."""
    ensure_table()
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT o.id, o.name, o.category, o.amount, o.cadence, o.anchor_date,
                   o.seed_amount, o.seed_cadence, o.seed_anchor_date, o.deleted_at,
                   (SELECT h.actor FROM cashflow_overhead_history h
                     WHERE h.overhead_id = o.id AND h.action = 'delete'
                     ORDER BY h.id DESC LIMIT 1) AS deleted_by
            FROM cashflow_overhead o
            WHERE o.deleted_at IS NOT NULL
            ORDER BY o.deleted_at DESC
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


def _compute_runrate(today: date | None = None) -> dict:
    """The current auto-generated schedule from the trailing 12 months: one entry
    per overhead/payroll SUB-ACCOUNT -> {amount, cadence, anchor, category}, with
    cadence detected from that account's transaction spacing and a per-occurrence
    amount = trailing total spread over that cadence (preserves the annual run-rate).
    This is the live baseline; it drifts as new spending comes in."""
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

    by_acct = defaultdict(list)
    for r in rows:
        acct = r["acct"]
        if not acct or acct.split(":")[0] not in _CATEGORY_TO_ROW:
            continue  # only overhead/payroll accounts
        by_acct[acct].append((r["d"], float(r["amt"] or 0)))

    out = {}
    for acct, txns in by_acct.items():
        total = round(sum(a for _, a in txns), 2)
        if total <= 0:
            continue
        cadence = _detect_cadence([d for d, _ in txns])
        out[acct] = {
            "amount": round(total / _PERIODS_PER_YEAR[cadence], 2),  # per-occurrence
            "cadence": cadence,
            "anchor": max(d for d, _ in txns),                       # real day-of-cycle
            "category": _CATEGORY_TO_ROW.get(acct.split(":")[0], acct.split(":")[0]),
        }
    return out


def seed_if_empty(today: date | None = None) -> int:
    """First-time populate from the trailing-12-month run-rate (one item per
    sub-account). No-op once there are any items — after that the values are kept
    current by refresh_auto_from_runrate()."""
    ensure_table()
    with engine.connect() as conn:
        if conn.execute(text("SELECT COUNT(*) FROM cashflow_overhead")).scalar():
            return 0
    runrate = _compute_runrate(today)
    with engine.begin() as conn:
        so = 0
        for acct, v in sorted(runrate.items()):
            so += 1
            conn.execute(text("""
                INSERT INTO cashflow_overhead
                  (name, category, amount, seed_amount, cadence, seed_cadence,
                   anchor_date, seed_anchor_date, active, sort_order, edited)
                VALUES (:n, :c, :a, :a, :cad, :cad, :d, :d, 1, :so, 0)
            """), {"n": acct, "c": v["category"], "a": v["amount"],
                   "cad": v["cadence"], "d": v["anchor"], "so": so})
    return so


def refresh_auto_from_runrate(today: date | None = None) -> dict:
    """Keep the auto-generated items live. For every account in the current
    run-rate:
      - a soft-deleted item for that account -> left deleted (deletions stick);
      - a live item -> its baseline (seed_*) is refreshed to the current run-rate,
        and if it's NOT a manual override (edited=0) its shown amount/cadence/start
        are updated too;
      - no item yet -> a fresh auto item is added.
    Manual overrides keep their values (only their revert-target baseline moves).
    Safe to run every sync."""
    ensure_table()
    runrate = _compute_runrate(today)
    with engine.begin() as conn:
        existing = conn.execute(text(
            "SELECT id, name, edited, deleted_at FROM cashflow_overhead")).mappings().all()
        live = {r["name"]: r for r in existing if r["deleted_at"] is None}
        deleted = {r["name"] for r in existing if r["deleted_at"] is not None}
        next_so = (conn.execute(text("SELECT COALESCE(MAX(sort_order),0) FROM cashflow_overhead")).scalar() or 0)
        updated = inserted = skipped = 0
        for acct, v in sorted(runrate.items()):
            if acct in deleted:
                skipped += 1
                continue  # respect an intentional deletion
            row = live.get(acct)
            if row:
                if row["edited"]:
                    # override kept; only move the revert-target baseline
                    conn.execute(text("""
                        UPDATE cashflow_overhead
                           SET seed_amount=:a, seed_cadence=:cad, seed_anchor_date=:d
                         WHERE id=:id
                    """), {"a": v["amount"], "cad": v["cadence"], "d": v["anchor"], "id": row["id"]})
                else:
                    conn.execute(text("""
                        UPDATE cashflow_overhead
                           SET amount=:a, seed_amount=:a, cadence=:cad, seed_cadence=:cad,
                               anchor_date=:d, seed_anchor_date=:d
                         WHERE id=:id
                    """), {"a": v["amount"], "cad": v["cadence"], "d": v["anchor"], "id": row["id"]})
                updated += 1
            else:
                next_so += 1
                conn.execute(text("""
                    INSERT INTO cashflow_overhead
                      (name, category, amount, seed_amount, cadence, seed_cadence,
                       anchor_date, seed_anchor_date, active, sort_order, edited)
                    VALUES (:n, :c, :a, :a, :cad, :cad, :d, :d, 1, :so, 0)
                """), {"n": acct, "c": v["category"], "a": v["amount"],
                       "cad": v["cadence"], "d": v["anchor"], "so": next_so})
                inserted += 1
    return {"updated": updated, "inserted": inserted, "skipped_deleted": skipped}


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
def create(data: dict, actor: str | None = None) -> int:
    ensure_table()
    name = data.get("name") or "Overhead item"
    amount = float(data.get("amount") or 0)
    cadence = (data.get("cadence") or "monthly").lower()
    anchor = data.get("anchor_date")
    with engine.begin() as conn:
        so = conn.execute(text("SELECT COALESCE(MAX(sort_order),0)+1 FROM cashflow_overhead")).scalar()
        # A hand-added item's baseline IS its created state (revert = as created).
        oid = conn.execute(text("""
            INSERT INTO cashflow_overhead
              (name, category, amount, seed_amount, cadence, seed_cadence,
               anchor_date, seed_anchor_date, end_date, active, sort_order, edited, from_qbo)
            VALUES (:name, :category, :amount, :amount, :cadence, :cadence,
               :anchor_date, :anchor_date, :end_date, 1, :so, 1, 0)
        """), {
            "name": name, "category": data.get("category"),
            "amount": amount, "cadence": cadence,
            "anchor_date": anchor, "end_date": data.get("end_date"), "so": so,
        }).lastrowid
        _record_history(conn, oid, "create", actor, name,
                        None, {"amount": amount, "cadence": cadence, "anchor_date": anchor})
        return oid


_FIELDS = {"name", "category", "amount", "cadence", "anchor_date", "end_date", "active"}


def update(oid: int, data: dict, actor: str | None = None):
    ensure_table()
    sets = {k: v for k, v in data.items() if k in _FIELDS}
    if not sets:
        return
    if "cadence" in sets and sets["cadence"]:
        sets["cadence"] = str(sets["cadence"]).lower()
    with engine.begin() as conn:
        before = conn.execute(text(
            "SELECT name, amount, cadence, anchor_date FROM cashflow_overhead WHERE id = :oid"),
            {"oid": oid}).mappings().first()
        cols = ", ".join(f"{k} = :{k}" for k in sets)
        params = {**sets, "oid": oid}
        conn.execute(text(f"UPDATE cashflow_overhead SET {cols}, edited = 1 WHERE id = :oid"), params)
        # Only log a history row when a tracked field actually changed.
        if before and any(k in sets for k in ("amount", "cadence", "anchor_date")):
            old = {"amount": before["amount"], "cadence": before["cadence"], "anchor_date": before["anchor_date"]}
            new = {"amount": sets.get("amount", before["amount"]),
                   "cadence": sets.get("cadence", before["cadence"]),
                   "anchor_date": sets.get("anchor_date", before["anchor_date"])}
            if (str(old["amount"]) != str(new["amount"]) or old["cadence"] != new["cadence"]
                    or str(old["anchor_date"]) != str(new["anchor_date"])):
                _record_history(conn, oid, "edit", actor, sets.get("name") or (before["name"] if before else None), old, new)


def delete(oid: int, actor: str | None = None):
    """Soft delete: stamp deleted_at (row drops out of the forecast + main list but
    stays restorable) and log it."""
    ensure_table()
    with engine.begin() as conn:
        before = conn.execute(text(
            "SELECT name, amount, cadence, anchor_date FROM cashflow_overhead "
            "WHERE id = :oid AND deleted_at IS NULL"), {"oid": oid}).mappings().first()
        if not before:
            return
        conn.execute(text("UPDATE cashflow_overhead SET deleted_at = NOW() WHERE id = :oid"), {"oid": oid})
        _record_history(conn, oid, "delete", actor, before["name"],
                        {"amount": before["amount"], "cadence": before["cadence"],
                         "anchor_date": before["anchor_date"]}, None)


def restore(oid: int, actor: str | None = None):
    """Undo a soft delete — bring the item back into the forecast."""
    ensure_table()
    with engine.begin() as conn:
        before = conn.execute(text(
            "SELECT name, amount, cadence, anchor_date FROM cashflow_overhead "
            "WHERE id = :oid AND deleted_at IS NOT NULL"), {"oid": oid}).mappings().first()
        if not before:
            return False
        conn.execute(text("UPDATE cashflow_overhead SET deleted_at = NULL WHERE id = :oid"), {"oid": oid})
        _record_history(conn, oid, "restore", actor, before["name"],
                        None, {"amount": before["amount"], "cadence": before["cadence"],
                               "anchor_date": before["anchor_date"]})
    return True
