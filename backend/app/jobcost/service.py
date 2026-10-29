"""
Job cost vs estimate, per job and per cost category (the dashboard's
"Job cost vs estimate" panel and its drill-downs).

  estimate = the cost lines of the project's latest accepted / converted /
             closed estimate(s) in QuickBooks (YOUR-RATE cost; Contract Labor
             falls back to the line amount, the same as the Billing tab)
  actual   = QuickBooks bills and card purchases tagged to the project,
             by item or expense account

Only QuickBooks Projects count: OPI moved jobs into QBO Projects in Dec 2024,
and before 2025 job costs were almost never tagged to a job, so older work has
no actuals to compare.

Rules (also listed on the Assumptions page):
  finished     = scheduled end date at least FINISHED_AFTER_DAYS ago, or the
                 project's status is completed
  active       = started, not finished
  over         = actual more than OVER_PCT above estimate
  typical job  = the median job's actual / estimate
"""
import time
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import text

from app.db import engine

FINISHED_AFTER_DAYS = 45
OVER_PCT = 0.10
CACHE_SECONDS = 600

# Display order. "Lifts" is split out of rentals: it's the biggest non-crew cost.
CATEGORIES = ["Crew labor", "Lifts", "Other rentals", "Materials", "Lodging", "Propane", "Travel", "Other"]


def category_of(item):
    """Cost line (estimate item or bill item/account) -> category, or None for
    margin lines (OH&P, Buffer) that are not money going out."""
    from app.expenses.routes import _expense_category
    name = item or ""
    if name.startswith("Contract Labor"):
        return "Crew labor"
    if "lift" in name.lower():
        return "Lifts"
    cat = _expense_category(name)
    if cat is None:
        return None
    return "Other rentals" if cat == "Rentals" else cat


_cache = {"at": 0.0, "data": None}


def _load():
    with engine.connect() as conn:
        projects = {}
        for r in conn.execute(text("""
            SELECT qc.qbo_id, qc.display_name, MIN(psi.start_date) AS s, MAX(psi.end_date) AS e,
                   (SELECT psi2.status FROM project_schedule_items psi2 WHERE psi2.project_id = p.id
                    ORDER BY psi2.start_date IS NULL, psi2.start_date DESC, psi2.sort_order DESC, psi2.id DESC
                    LIMIT 1) AS status,
                   (SELECT TRIM(CONCAT(COALESCE(pm.first_name, ''), ' ', COALESCE(pm.last_name, '')))
                    FROM project_schedule_items psi3
                    JOIN project_schedule_item_project_managers spm
                         ON spm.schedule_item_id = psi3.id AND spm.unassigned_at IS NULL
                    JOIN project_managers pm ON pm.id = spm.project_manager_id
                    WHERE psi3.project_id = p.id
                    ORDER BY spm.is_primary DESC, psi3.start_date DESC LIMIT 1) AS pm
            FROM qbo_customers qc
            JOIN projects p ON p.qbo_customer_id = qc.id
            JOIN project_schedule_items psi ON psi.project_id = p.id
            WHERE qc.is_project = 1
            GROUP BY qc.qbo_id, qc.display_name, p.id
        """)).mappings().all():
            projects[str(r["qbo_id"])] = {"name": r["display_name"], "start": r["s"], "end": r["e"],
                                          "status": r["status"], "pm": r["pm"] or None}

        est = defaultdict(lambda: defaultdict(float))
        for r in conn.execute(text("""
            WITH latest AS (
              SELECT t.id, t.customer_qbo_id, ROW_NUMBER() OVER (
                       PARTITION BY t.customer_qbo_id, COALESCE(t.doc_number, CONCAT('__nd__', t.qbo_id))
                       ORDER BY t.id DESC) AS rn
              FROM qbo_transactions t
              JOIN qbo_customers qc ON qc.qbo_id = t.customer_qbo_id AND qc.is_project = 1
              WHERE t.entity_type = 'Estimate' AND (t.total_amt IS NULL OR t.total_amt > 0)
                AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted', 'Closed'))
            SELECT latest.customer_qbo_id AS e, l.item_name AS item,
                   SUM(CASE WHEN l.item_name LIKE 'Contract Labor%' THEN COALESCE(l.cost_amount, l.amount)
                            ELSE COALESCE(l.cost_amount, 0) END) AS v
            FROM latest JOIN qbo_sales_transaction_lines l
                 ON l.transaction_id = latest.id AND l.line_level = 'child'
            WHERE latest.rn = 1
            GROUP BY latest.customer_qbo_id, l.item_name
        """)).all():
            cat = category_of(r[1])
            if cat and r[2]:
                est[str(r[0])][cat] += float(r[2])

        act = defaultdict(lambda: defaultdict(float))
        for r in conn.execute(text("""
            SELECT l.line_customer_qbo_id AS e,
                   COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')),
                     SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')), ':', 1)) AS item,
                   SUM(l.amount) AS v
            FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
            JOIN qbo_customers qc ON qc.qbo_id = l.line_customer_qbo_id AND qc.is_project = 1
            WHERE t.entity_type IN ('Bill', 'Purchase')
            GROUP BY l.line_customer_qbo_id, item
        """)).all():
            cat = category_of(r[1])
            if cat and r[2]:
                act[str(r[0])][cat] += float(r[2])

    today = date.today()
    fin_cut = today - timedelta(days=FINISHED_AFTER_DAYS)
    jobs = []
    for pid, p in projects.items():
        if not p["start"] or not p["end"]:
            continue
        if p["end"] <= fin_cut or (p["status"] or "").lower() in ("completed", "complete"):
            state = "finished"
        elif p["start"] <= today:
            state = "active"
        else:
            continue  # not started: nothing to compare yet
        cats = set(est.get(pid, {})) | set(act.get(pid, {}))
        if not cats:
            continue
        jobs.append({"id": pid, "name": p["name"], "pm": p["pm"], "state": state,
                     "start": str(p["start"]), "end": str(p["end"]),
                     "est": {c: round(est[pid].get(c, 0.0), 2) for c in cats},
                     "act": {c: round(act[pid].get(c, 0.0), 2) for c in cats}})
    return {"jobs": jobs, "built": time.time()}


def data_sig():
    """Fingerprint of what _load reads (estimates, bills/purchases, job dates)."""
    with engine.connect() as conn:
        return "|".join(str(conn.execute(text(q)).scalar()) for q in (
            "SELECT MAX(id) FROM qbo_sync_runs",
            "SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(id), '')) FROM qbo_transactions",
            "SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(updated_at), '')) FROM project_schedule_items",
            "SELECT CURDATE()"))


SNAP_KEY = "jobcost"


def refresh_snapshot():
    from app import snapshots
    data = snapshots.rebuild(SNAP_KEY, _load, data_sig)
    if data is not None:
        _cache["data"], _cache["at"] = data, time.time()
    return data


def dataset(force=False):
    """0089: from memory, else the saved snapshot (rebuilt in the background when
    the QuickBooks / schedule data changed), else built now."""
    if force or not _cache["data"] or time.time() - _cache["at"] > CACHE_SECONDS:
        from app import snapshots
        data, _ = snapshots.serve(SNAP_KEY, _load, data_sig, max_age=CACHE_SECONDS * 6, force=force)
        _cache["data"], _cache["at"] = data, time.time()
    return _cache["data"]


def _scoped(scope, months):
    jobs = dataset()["jobs"]
    if scope == "active":
        return [j for j in jobs if j["state"] == "active"]
    out = [j for j in jobs if j["state"] == "finished"]
    if months:
        since = str(date.today() - timedelta(days=int(months * 30.4)))
        out = [j for j in out if j["end"] >= since]
    return out


def summary(scope="finished", months=12):
    """One row per category. Only jobs that had an estimate for the category are
    compared (a cost with no estimate line is counted separately as unbudgeted)."""
    jobs = _scoped(scope, months)
    rows = []
    for cat in CATEGORIES:
        ratios, e_tot, a_tot, over_n, zero_n, over_amt = [], 0.0, 0.0, 0, 0, 0.0
        unbudgeted_n, unbudgeted_amt = 0, 0.0
        for j in jobs:
            e, a = j["est"].get(cat, 0.0), j["act"].get(cat, 0.0)
            if e <= 0:
                if a > 0:
                    unbudgeted_n += 1
                    unbudgeted_amt += a
                continue
            ratios.append(a / e)
            e_tot += e
            a_tot += a
            if a > e * (1 + OVER_PCT):
                over_n += 1
                over_amt += a - e
            if a <= 0:
                zero_n += 1
        if not ratios and not unbudgeted_n:
            continue
        rs = sorted(ratios)
        rows.append({
            "category": cat, "jobs": len(rs),
            "estimated": round(e_tot, 2), "actual": round(a_tot, 2),
            "variance": round(a_tot - e_tot, 2),
            "ratio": round(a_tot / e_tot, 4) if e_tot else None,
            "typical": round(rs[len(rs) // 2], 4) if rs else None,
            "over_jobs": over_n, "over_amount": round(over_amt, 2),
            "zero_jobs": zero_n,
            "unbudgeted_jobs": unbudgeted_n, "unbudgeted_amount": round(unbudgeted_amt, 2),
        })
    return {"scope": scope, "months": months, "job_count": len(jobs), "categories": rows,
            "rules": {"finished_after_days": FINISHED_AFTER_DAYS, "over_pct": OVER_PCT},
            "built_at": dataset()["built"]}


def _elapsed(j):
    """Share of the scheduled job days already past (active jobs): a job half
    done should have spent about half its budget."""
    s, e = date.fromisoformat(j["start"]), date.fromisoformat(j["end"])
    span = max(1, (e - s).days)
    return round(min(1.0, max(0.0, (date.today() - s).days / span)), 3)


def category_jobs(cat, scope="finished", months=12):
    out = []
    for j in _scoped(scope, months):
        e, a = j["est"].get(cat, 0.0), j["act"].get(cat, 0.0)
        if e <= 0 and a <= 0:
            continue
        out.append({"id": j["id"], "name": j["name"], "pm": j["pm"], "start": j["start"], "end": j["end"],
                    "state": j["state"], "elapsed": _elapsed(j) if j["state"] == "active" else None,
                    "estimated": e, "actual": a, "variance": round(a - e, 2),
                    "ratio": round(a / e, 4) if e > 0 else None,
                    "flag": ("unbudgeted" if e <= 0 else "zero" if a <= 0
                             else "over" if a > e * (1 + OVER_PCT) else "ok")})
    out.sort(key=lambda r: -r["variance"])
    return out


def job_detail(entity_id, cat):
    """The estimate lines and the QuickBooks bills/purchases behind one job's
    number for one category."""
    with engine.connect() as conn:
        est_lines = [dict(r) for r in conn.execute(text("""
            WITH latest AS (
              SELECT t.id, t.doc_number, t.txn_date, ROW_NUMBER() OVER (
                       PARTITION BY t.customer_qbo_id, COALESCE(t.doc_number, CONCAT('__nd__', t.qbo_id))
                       ORDER BY t.id DESC) AS rn
              FROM qbo_transactions t
              WHERE t.entity_type = 'Estimate' AND t.customer_qbo_id = :e AND (t.total_amt IS NULL OR t.total_amt > 0)
                AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted', 'Closed'))
            SELECT latest.doc_number AS doc, l.item_name AS item, l.description AS description,
                   l.qty AS qty,
                   CASE WHEN l.item_name LIKE 'Contract Labor%' THEN COALESCE(l.cost_amount, l.amount)
                        ELSE COALESCE(l.cost_amount, 0) END AS amount
            FROM latest JOIN qbo_sales_transaction_lines l
                 ON l.transaction_id = latest.id AND l.line_level = 'child'
            WHERE latest.rn = 1
        """), {"e": entity_id}).mappings().all()]
        bills = [dict(r) for r in conn.execute(text("""
            SELECT t.entity_type AS type, t.doc_number AS doc, t.txn_date AS date,
                   COALESCE(JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.VendorRef.name')),
                            JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.EntityRef.name'))) AS vendor,
                   COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')),
                     SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')), ':', 1)) AS item,
                   l.description AS description, l.amount AS amount
            FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
            WHERE l.line_customer_qbo_id = :e AND t.entity_type IN ('Bill', 'Purchase')
            ORDER BY t.txn_date, t.id
        """), {"e": entity_id}).mappings().all()]
        # pending change orders (Change Orders tab) + this category's cost on the QBO ones
        try:
            from app.change_orders.routes import pending_change_orders
            pcos = pending_change_orders(conn, entity_id)
        except Exception:
            pcos = []
        pend_cost = {}
        for r in conn.execute(text("""
            SELECT t.doc_number AS doc, l.item_name AS item,
                   CASE WHEN l.item_name LIKE 'Contract Labor%' THEN COALESCE(l.cost_amount, l.amount)
                        ELSE COALESCE(l.cost_amount, 0) END AS amount
            FROM qbo_transactions t JOIN qbo_sales_transaction_lines l ON l.transaction_id = t.id AND l.line_level = 'child'
            WHERE t.entity_type = 'Estimate' AND t.customer_qbo_id = :e
              AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) = 'Pending'
        """), {"e": entity_id}).mappings():
            if category_of(r["item"]) == cat:
                pend_cost[r["doc"]] = pend_cost.get(r["doc"], 0.0) + float(r["amount"] or 0)
    pending = [{**c, "category_cost": round(pend_cost[c["doc_number"]], 2) if c.get("doc_number") in pend_cost else None}
               for c in pcos]
    est_out = [{"doc": r["doc"], "item": r["item"], "description": r["description"],
                "qty": float(r["qty"]) if r["qty"] is not None else None, "amount": float(r["amount"] or 0)}
               for r in est_lines if category_of(r["item"]) == cat and float(r["amount"] or 0) != 0]
    act_out = [{"type": "Card" if r["type"] == "Purchase" else "Bill", "doc": r["doc"], "date": str(r["date"]),
                "vendor": r["vendor"] or "Unknown", "item": r["item"], "description": r["description"],
                "amount": float(r["amount"] or 0)}
               for r in bills if category_of(r["item"]) == cat]
    return {"estimate_lines": est_out, "actual_lines": act_out, "pending_change_orders": pending}
