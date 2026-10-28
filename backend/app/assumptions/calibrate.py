"""
Forecast assumptions measured from QuickBooks history (migration 0084).

Expense timing: for every job-tagged Bill / card Purchase line in the last
WINDOW_MONTHS, where did its date fall relative to the project's scheduled
start/end?  The dollar share per bucket is the category's timing profile; the
expense schedule spreads each category's estimate by it instead of evenly.
Bill-to-payment lag (BillPayment date - Bill date, dollar-weighted) sets when
the cash actually leaves.

Estimate accuracy (actual / estimate per category on finished projects) is
measured for review only; it is never applied to amounts.

Everything stored here is shown on the Assumptions page with its evidence, and
an owner override (override_val) wins over the measured value.
"""
import json
from collections import defaultdict
from datetime import date, timedelta
from math import ceil

from sqlalchemy import text

from app.db import engine

WINDOW_MONTHS = 24
MIN_PROJECTS = 15          # fewer dated projects than this -> no profile (even spread)
FINISHED_AFTER_DAYS = 45   # a project counts as finished 45 days after its end date

# (key, label) in time order. Shares in a profile sum to 1.
BUCKETS = [
    ("before", "Before start"),
    ("q1", "First quarter of the job"),
    ("q2", "Second quarter"),
    ("q3", "Third quarter"),
    ("q4", "Last quarter"),
    ("after30", "Up to 30 days after end"),
    ("after30plus", "More than 30 days after end"),
]
BUCKET_KEYS = [k for k, _ in BUCKETS]


def _project_windows(conn):
    return {r[0]: (r[1], r[2]) for r in conn.execute(text("""
        SELECT qc.qbo_id, MIN(psi.start_date), MAX(psi.end_date)
        FROM qbo_customers qc JOIN projects p ON p.qbo_customer_id = qc.id
        JOIN project_schedule_items psi ON psi.project_id = p.id
        WHERE qc.is_project = 1
        GROUP BY qc.qbo_id
        HAVING MIN(psi.start_date) IS NOT NULL AND MAX(psi.end_date) >= MIN(psi.start_date)
    """)).all()}


def _bucket(d, start, end):
    if d < start:
        return "before"
    if d <= end:
        f = (d - start).days / max(1, (end - start).days)
        return BUCKET_KEYS[1 + min(3, int(f * 4))]
    return "after30" if (d - end).days <= 30 else "after30plus"


def _wavg(pairs):
    w = sum(a for _, a in pairs if a > 0)
    return round(sum(d * a for d, a in pairs if a > 0) / w, 1) if w else None


def measure_expense_timing(conn):
    from app.expenses.routes import _expense_category
    since = date.today() - timedelta(days=int(WINDOW_MONTHS * 30.4))
    windows = _project_windows(conn)
    rows = conn.execute(text("""
        SELECT l.line_customer_qbo_id AS e, t.qbo_id, t.entity_type AS et, t.txn_date AS d,
               DATE(t.meta_create_time) AS cd,
               COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')),
                 SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')), ':', 1)) AS item,
               l.amount AS a
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE l.line_customer_qbo_id IS NOT NULL AND t.entity_type IN ('Bill', 'Purchase')
          AND t.txn_date >= :since
    """), {"since": since}).mappings().all()
    paid = {}
    for r in conn.execute(text("""
        SELECT t.txn_date, JSON_UNQUOTE(JSON_EXTRACT(j.v, '$.TxnId')) AS bid
        FROM qbo_transactions t,
             JSON_TABLE(t.raw_json, '$.Line[*].LinkedTxn[*]' COLUMNS (v JSON PATH '$')) j
        WHERE t.entity_type = 'BillPayment' AND t.txn_date >= :since
          AND JSON_UNQUOTE(JSON_EXTRACT(j.v, '$.TxnType')) = 'Bill'
    """), {"since": since}).all():
        paid.setdefault(r[1], r[0])

    share = defaultdict(lambda: defaultdict(float))
    tot, dated_tot = defaultdict(float), defaultdict(float)
    projects, bills = defaultdict(set), defaultdict(int)
    lag_entry, lag_paid = defaultdict(list), defaultdict(list)
    top_items = defaultdict(lambda: defaultdict(float))
    for r in rows:
        cat = _expense_category(r["item"])
        if not cat:
            continue
        a = float(r["a"] or 0)
        tot[cat] += a
        bills[cat] += 1
        top_items[cat][r["item"] or "?"] += a
        if r["cd"] and r["d"]:
            lag_entry[cat].append(((r["cd"] - r["d"]).days, a))
        if r["et"] == "Bill" and r["qbo_id"] in paid:
            lag_paid[cat].append(((paid[r["qbo_id"]] - r["d"]).days, a))
        w = windows.get(r["e"])
        if not w or not r["d"]:
            continue
        share[cat][_bucket(r["d"], *w)] += a
        dated_tot[cat] += a
        projects[cat].add(r["e"])

    out = {}
    for cat in tot:
        n = len(projects[cat])
        prof = ({k: round(share[cat][k] / dated_tot[cat], 4) for k in BUCKET_KEYS}
                if dated_tot[cat] > 0 and n >= MIN_PROJECTS else None)
        out[cat] = {
            "calibrated": {"profile": prof,
                           "paid_lag_days": _wavg(lag_paid[cat]),
                           "entry_lag_days": _wavg(lag_entry[cat])},
            "basis": {"projects": n, "lines": bills[cat], "amount": round(tot[cat], 2),
                      "dated_amount": round(dated_tot[cat], 2),
                      "paid_bills": len(lag_paid[cat]),
                      "since": str(since), "min_projects": MIN_PROJECTS,
                      "top_items": [[k, round(v, 2)] for k, v in
                                    sorted(top_items[cat].items(), key=lambda x: -x[1])[:5]]},
        }
    return out


def measure_estimate_accuracy(conn):
    """Actual / estimate per category on projects that ended 45+ days ago
    within the window. Review-only: never applied to forecast amounts."""
    from app.expenses.routes import _estimate_costs_by_category
    import app.billing.routes as B
    since = date.today() - timedelta(days=int(WINDOW_MONTHS * 30.4))
    ids = [r[0] for r in conn.execute(text("""
        SELECT qc.qbo_id FROM qbo_customers qc JOIN projects p ON p.qbo_customer_id = qc.id
        JOIN project_schedule_items psi ON psi.project_id = p.id
        WHERE qc.is_project = 1 GROUP BY qc.qbo_id
        HAVING MAX(psi.end_date) < CURDATE() - INTERVAL :fin DAY AND MAX(psi.end_date) >= :since
    """), {"fin": FINISHED_AFTER_DAYS, "since": since}).all()]
    est, act, ratios, zero = defaultdict(float), defaultdict(float), defaultdict(list), defaultdict(int)
    for e in ids:
        ec = _estimate_costs_by_category(conn, e)
        if not ec:
            continue
        ac = defaultdict(float)
        for a in B._actual_expenses(conn, e):
            ac[a["category"]] += a["amount"]
        for cat, v in ec.items():
            if v <= 0:
                continue
            est[cat] += v
            act[cat] += ac.get(cat, 0.0)
            ratios[cat].append(ac.get(cat, 0.0) / v)
            zero[cat] += 1 if ac.get(cat, 0.0) <= 0 else 0
    out = {}
    for cat in est:
        rs = sorted(ratios[cat])
        out[cat] = {
            "calibrated": {"actual_to_estimate": round(act[cat] / est[cat], 3),
                           "median_ratio": round(rs[len(rs) // 2], 3)},
            "basis": {"projects": len(rs), "estimated": round(est[cat], 2), "actual": round(act[cat], 2),
                      "no_actual_projects": zero[cat], "since": str(since),
                      "finished_after_days": FINISHED_AFTER_DAYS},
        }
    return out


LODGING_VENDOR = "Hotel Engine"


def measure_lodging_billing(conn):
    """How Hotel Engine bills lodging, from its recent bills. Since mid-2026 it
    sends one monthly statement, dated around the 11th, for the previous month's
    stays (the document number carries the stay month: 503231-2608-1 = August).
    Measured over the run of consecutive stay-months that each have exactly one
    bill (the monthly era): bill day of month, months after the stay month, and
    bill-to-payment days. None when the recent bills aren't monthly."""
    import re
    from statistics import median
    rows = conn.execute(text("""
        SELECT t.qbo_id, t.doc_number, t.txn_date, t.due_date, t.total_amt,
          (SELECT MIN(p.txn_date) FROM qbo_transactions p,
             JSON_TABLE(p.raw_json, '$.Line[*].LinkedTxn[*]' COLUMNS (id VARCHAR(40) COLLATE utf8mb4_unicode_ci PATH '$.TxnId', ty VARCHAR(20) PATH '$.TxnType')) j
           WHERE p.entity_type = 'BillPayment' AND j.ty = 'Bill' AND j.id = t.qbo_id) AS paid
        FROM qbo_transactions t
        WHERE t.entity_type = 'Bill' AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.VendorRef.name')) LIKE :v
          AND t.txn_date >= CURDATE() - INTERVAL 18 MONTH AND t.total_amt > 100
        ORDER BY t.txn_date
    """), {"v": f"%{LODGING_VENDOR}%"}).mappings().all()
    by_month = {}
    for r in rows:
        m = re.match(r"^\d+-(\d{2})(\d{2})-\d+$", r["doc_number"] or "")
        if not m:
            continue
        by_month.setdefault((2000 + int(m.group(1)), int(m.group(2))), []).append(r)
    run = []
    for ym in sorted(by_month, reverse=True):     # newest first: the current monthly run
        if len(by_month[ym]) != 1:
            break
        run.append((ym, by_month[ym][0]))
    if len(run) < 2:
        return None
    run.reverse()
    offs = [(r["txn_date"].year - y) * 12 + (r["txn_date"].month - mo) for (y, mo), r in run]
    lags = [(r["paid"] - r["txn_date"]).days for _, r in run if r["paid"]]
    dues = [(r["due_date"] - r["txn_date"]).days for _, r in run if r["due_date"]]
    return {
        "calibrated": {"cadence": "monthly", "bill_day": int(median(r["txn_date"].day for _, r in run)),
                       "month_offset": int(median(offs)),
                       "paid_lag_days": round(median(lags), 1) if lags else None,
                       "due_days": round(median(dues), 1) if dues else None},
        "basis": {"vendor": LODGING_VENDOR, "since": f"{run[0][0][0]}-{run[0][0][1]:02d}",
                  "bills": [{"doc": r["doc_number"], "stay_month": f"{y}-{mo:02d}", "date": str(r["txn_date"]),
                             "due": str(r["due_date"]) if r["due_date"] else None,
                             "paid": str(r["paid"]) if r["paid"] else None, "amount": float(r["total_amt"] or 0)}
                            for (y, mo), r in run]},
    }


def _upsert(conn, akey, grp, label, calibrated, basis):
    conn.execute(text("""
        INSERT INTO forecast_assumptions (akey, grp, label, calibrated, basis, computed_at)
        VALUES (:k, :g, :l, :c, :b, NOW())
        ON DUPLICATE KEY UPDATE grp = VALUES(grp), label = VALUES(label),
          calibrated = VALUES(calibrated), basis = VALUES(basis), computed_at = NOW()
    """), {"k": akey, "g": grp, "l": label, "c": json.dumps(calibrated), "b": json.dumps(basis)})


def recalibrate():
    """Re-measure every assumption from the synced QBO data. Overrides are kept."""
    with engine.begin() as conn:
        timing = measure_expense_timing(conn)
        for cat, v in timing.items():
            _upsert(conn, f"expense_timing.{cat}", "expense_timing", f"{cat} timing", v["calibrated"], v["basis"])
        lb = measure_lodging_billing(conn)
        if lb:
            _upsert(conn, "lodging_billing", "lodging_billing", "Lodging billing (Hotel Engine)", lb["calibrated"], lb["basis"])
        acc = measure_estimate_accuracy(conn)
        for cat, v in acc.items():
            _upsert(conn, f"estimate_accuracy.{cat}", "estimate_accuracy",
                    f"{cat} actual vs estimate", v["calibrated"], v["basis"])
    _cache.clear()
    return {"expense_timing": len(timing), "estimate_accuracy": len(acc)}


# ---------------------------------------------------------------------------
# Reading the effective (override > calibrated) value
# ---------------------------------------------------------------------------
_cache: dict = {}


def _load(v):
    if v is None or isinstance(v, (dict, list)):
        return v
    return json.loads(v)


def lodging_billing(conn):
    """Effective Hotel Engine billing calendar (override > measured), or None."""
    if "__lodging__" not in _cache:
        try:
            r = conn.execute(text(
                "SELECT calibrated, override_val FROM forecast_assumptions WHERE akey = 'lodging_billing'")).first()
        except Exception:
            r = None
        if not r:
            _cache["__lodging__"] = None
        else:
            eff = dict(_load(r[0]) or {})
            eff.update({k: v for k, v in (_load(r[1]) or {}).items() if v is not None})
            _cache["__lodging__"] = eff
    return _cache["__lodging__"]


def lodging_split(total, start, end, lb):
    """A job's lodging estimate on Hotel Engine's billing calendar: the nights
    are spread evenly over the job's scheduled days; each calendar month's
    nights are billed on the statement dated `bill_day` of the month
    `month_offset` later; the cash leaves `paid_lag_days` after that.
    Rows: week_of (= expected bill date), expected_paid_date, amount, stay_month."""
    from calendar import monthrange
    if not lb or total <= 0 or not start or not end or end < start:
        return []
    days = (end - start).days + 1
    per_month = {}
    d = start
    while d <= end:
        last = date(d.year, d.month, monthrange(d.year, d.month)[1])
        per_month[(d.year, d.month)] = per_month.get((d.year, d.month), 0) + (min(last, end) - d).days + 1
        d = last + timedelta(days=1)
    off, day = int(lb.get("month_offset") or 1), int(lb.get("bill_day") or 11)
    lag = int(round(lb.get("paid_lag_days") or 0))
    out, running, keys = [], 0.0, sorted(per_month)
    for i, (y, mo) in enumerate(keys):
        amt = round(total * per_month[(y, mo)] / days, 2) if i < len(keys) - 1 else round(total - running, 2)
        running += amt
        by, bm = y + (mo - 1 + off) // 12, (mo - 1 + off) % 12 + 1
        bill = date(by, bm, min(day, monthrange(by, bm)[1]))
        out.append({"seq": i + 1, "week_of": str(bill), "amount": amt,
                    "expected_paid_date": str(bill + timedelta(days=lag)) if lag else None,
                    "stay_month": f"{y}-{mo:02d}"})
    return out


def expense_timing(conn, category):
    """Effective timing for a category: {"profile": {...} | None, "paid_lag_days": n | None},
    or None if never measured. Overridden fields replace the measured ones."""
    if category not in _cache:
        try:
            r = conn.execute(text(
                "SELECT calibrated, override_val FROM forecast_assumptions WHERE akey = :k"),
                {"k": f"expense_timing.{category}"}).first()
        except Exception:
            r = None  # table not migrated yet
        if not r:
            _cache[category] = None
        else:
            eff = dict(_load(r[0]) or {})
            eff.update({k: v for k, v in (_load(r[1]) or {}).items() if v is not None})
            _cache[category] = eff
    return _cache[category]


def profile_split(total, start, end, timing):
    """Spread `total` by a timing profile. Rows: week_of (when the bill is
    expected), expected_paid_date (week_of + bill-to-payment lag), amount.

      before       -> one row the week before start
      q1..q4       -> each project week gets the quarter shares it overlaps
      after30      -> four weekly rows after the end date
      after30plus  -> one row six weeks after the end date
    Returns [] when there is no usable profile (caller falls back to even)."""
    prof = (timing or {}).get("profile")
    if not prof or total <= 0 or not start or not end or end < start:
        return []
    lag = (timing or {}).get("paid_lag_days")
    lag = int(round(lag)) if lag else 0
    n = max(1, ceil((end - start).days / 7)) if (end - start).days > 0 else 1
    weights = []   # (week_of, weight)
    if prof.get("before"):
        weights.append((start - timedelta(days=7), prof["before"]))
    for i in range(n):
        lo, hi = i / n, (i + 1) / n
        w = 0.0
        for q in range(4):
            ov = max(0.0, min(hi, (q + 1) / 4) - max(lo, q / 4))
            w += prof.get(f"q{q + 1}", 0) * ov * 4
        if w:
            weights.append((start + timedelta(days=7 * i), w))
    if prof.get("after30"):
        for k in range(1, 5):
            weights.append((end + timedelta(days=7 * k), prof["after30"] / 4))
    if prof.get("after30plus"):
        weights.append((end + timedelta(days=42), prof["after30plus"]))
    wsum = sum(w for _, w in weights)
    if wsum <= 0:
        return []
    out, running = [], 0.0
    for i, (wk, w) in enumerate(weights):
        amt = round(total * w / wsum, 2) if i < len(weights) - 1 else round(total - running, 2)
        running += amt
        if amt == 0:
            continue
        out.append({"seq": len(out) + 1, "week_of": str(wk), "amount": amt,
                    "expected_paid_date": str(wk + timedelta(days=lag)) if lag else None})
    return out


if __name__ == "__main__":
    print(recalibrate())
