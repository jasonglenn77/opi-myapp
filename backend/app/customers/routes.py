"""
Customers & Jobs API — the "money-in" (revenue) view, by customer.

Every QBO customer rolls up to a top-level company. Beneath it sit:
  * Projects  (is_project = 1)
  * Jobs      (job = 1, is_project = 0)   -- legacy QBO sub-customers
  * the customer's own directly-tagged invoices (a "Direct" bucket)

Accuracy notes (this page's whole point is trustworthy numbers):
  * Paid / Open AR come from each Invoice's balance_amt, NOT from Payment
    transactions. QBO often books a payment against the PARENT customer while
    the invoices live on child projects/jobs, so summing Payment rows badly
    misattributes cash. An invoice's balance_amt stays correct no matter where
    the payment was entered.
        invoiced  = SUM(Invoice.total_amt)
        open_ar   = SUM(Invoice.balance_amt)
        collected = invoiced - open_ar
  * Customers nest up to 3 levels deep (many projects sit under a job, not the
    company), so each invoice is rolled up to its ROOT company.
  * Expenses (Bill/Purchase/BillPayment) carry no customer and are NOT shown
    here — they are vendor money-out and live in Cash Flow / Crew Portal.

Read-only; gated by page.customers.
"""
from collections import defaultdict

from fastapi import APIRouter, Depends
from sqlalchemy import text

from app.db import engine
from app.auth import require_capability
from app.permissions import PAGE_CUSTOMERS

router = APIRouter(prefix="/api/customers", tags=["customers"])


def _blank():
    return {"invoiced": 0.0, "collected": 0.0, "open_ar": 0.0, "invoiced_ytd": 0.0, "last_txn": None}


def _add(dst, src):
    dst["invoiced"] += src["invoiced"]
    dst["collected"] += src["collected"]
    dst["open_ar"] += src["open_ar"]
    dst["invoiced_ytd"] += src["invoiced_ytd"]
    if src["last_txn"] and (not dst["last_txn"] or src["last_txn"] > dst["last_txn"]):
        dst["last_txn"] = src["last_txn"]


def _round(d):
    return {
        "invoiced": round(d["invoiced"], 2),
        "collected": round(d["collected"], 2),
        "open_ar": round(d["open_ar"], 2),
        "invoiced_ytd": round(d["invoiced_ytd"], 2),
        "last_txn": d["last_txn"],
    }


@router.get("/entities")
def customers_entities(user=Depends(require_capability(PAGE_CUSTOMERS))):
    """Flat list — one row per estimate / job / project — each resolved to its
    root customer. Powers the Customers table (sort/filter/search + group by
    customer). Estimates = open pipeline (tracked-not-lost, or untracked
    Pending/Accepted within ~18mo). Jobs/projects carry invoice financials."""
    with engine.connect() as conn:
        custs = conn.execute(text("""
            SELECT qbo_id, parent_qbo_id, display_name,
                   COALESCE(is_project,0) AS is_project, COALESCE(job,0) AS job, COALESCE(active,0) AS active
            FROM qbo_customers
        """)).mappings().all()
        inv = conn.execute(text("""
            SELECT customer_qbo_id,
                   SUM(total_amt) AS invoiced, SUM(balance_amt) AS open_ar,
                   SUM(total_amt - balance_amt) AS collected, MAX(txn_date) AS last_txn
            FROM qbo_transactions WHERE entity_type='Invoice' AND customer_qbo_id IS NOT NULL
            GROUP BY customer_qbo_id
        """)).mappings().all()
        psi_rows = conn.execute(text("""
            SELECT qc.qbo_id AS project_qbo_id, psi.status AS status, MAX(psi.end_date) AS end_date
            FROM myapp.projects p
            JOIN myapp.qbo_customers qc ON qc.id = p.qbo_customer_id AND qc.is_project = 1
            JOIN myapp.project_schedule_items psi ON psi.project_id = p.id
            GROUP BY qc.qbo_id, psi.status
        """)).mappings().all()
        est_rows = conn.execute(text("""
            SELECT t.qbo_id AS est_qbo_id, t.customer_qbo_id, t.doc_number AS est_no, t.txn_date,
                   ROUND(t.total_amt) AS amount,
                   JSON_UNQUOTE(JSON_EXTRACT(t.raw_json,'$.TxnStatus')) AS qbo_status,
                   JSON_UNQUOTE(JSON_EXTRACT(t.raw_json,'$.CustomerMemo.value')) AS memo,
                   et.status AS opi_status
            FROM qbo_transactions t
            LEFT JOIN estimate_tracking et ON et.qbo_estimate_id = t.qbo_id
            WHERE t.entity_type='Estimate' AND (
                (et.qbo_estimate_id IS NOT NULL AND et.status NOT LIKE '0%')
                OR (et.qbo_estimate_id IS NULL
                    AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json,'$.TxnStatus')) IN ('Pending','Accepted')
                    AND t.txn_date >= DATE_SUB(CURDATE(), INTERVAL 18 MONTH))
            )
        """)).mappings().all()

    by_qbo = {c["qbo_id"]: c for c in custs}
    parent_of = {c["qbo_id"]: (c["parent_qbo_id"] or None) for c in custs}
    name_of = {c["qbo_id"]: c["display_name"] for c in custs}

    def root_of(q):
        cur, guard = q, 0
        while guard < 10:
            p = parent_of.get(cur)
            if not p or p not in by_qbo:
                return cur
            cur, guard = p, guard + 1
        return cur

    fin = {r["customer_qbo_id"]: {
        "invoiced": float(r["invoiced"] or 0), "open_ar": float(r["open_ar"] or 0),
        "collected": float(r["collected"] or 0), "last_txn": str(r["last_txn"]) if r["last_txn"] else None,
    } for r in inv}

    STATUS_PRI = ["in_progress", "needs_attention", "scheduled", "not_started", "completed", "canceled"]
    proj_statuses, proj_end = defaultdict(set), {}
    for r in psi_rows:
        proj_statuses[r["project_qbo_id"]].add(r["status"])
        if r["end_date"] and (r["project_qbo_id"] not in proj_end or str(r["end_date"]) > proj_end[r["project_qbo_id"]]):
            proj_end[r["project_qbo_id"]] = str(r["end_date"])

    def proj_status(pq):
        s = proj_statuses.get(pq, set())
        for p in STATUS_PRI:
            if p in s:
                return p
        return None

    entities = []
    for c in custs:
        if not (c["is_project"] or c["job"]):
            continue
        root = root_of(c["qbo_id"])
        f = fin.get(c["qbo_id"]) or {"invoiced": 0, "open_ar": 0, "collected": 0, "last_txn": None}
        is_proj = bool(c["is_project"])
        entities.append({
            "customer_qbo_id": root, "customer_name": name_of.get(root) or "(unknown)",
            "type": "project" if is_proj else "job",
            "entity_id": c["qbo_id"], "name": c["display_name"],
            "status": (proj_status(c["qbo_id"]) or ("active" if c["active"] else "inactive")) if is_proj
                      else ("active" if c["active"] else "inactive"),
            "value": round(f["invoiced"], 2), "open_ar": round(f["open_ar"], 2),
            "collected": round(f["collected"], 2),
            "last_activity": proj_end.get(c["qbo_id"]) or f["last_txn"],
        })
    for e in est_rows:
        root = root_of(e["customer_qbo_id"])
        entities.append({
            "customer_qbo_id": root, "customer_name": name_of.get(root) or "(unknown)",
            "type": "estimate", "entity_id": e["est_qbo_id"],
            "name": (f"#{e['est_no']} {e['memo'] or ''}").strip() if e["est_no"] else (e["memo"] or "(estimate)"),
            "status": e["opi_status"] or e["qbo_status"] or "open",
            "value": float(e["amount"] or 0), "open_ar": 0.0, "collected": 0.0,
            "last_activity": str(e["txn_date"]) if e["txn_date"] else None,
        })

    # Per-customer rollups for the group-by-customer view. Revenue (invoiced)
    # comes from jobs/projects only — estimate face amounts are a separate
    # "pipeline" figure, never mixed into actual revenue.
    roll = defaultdict(lambda: {"name": "", "estimate_count": 0, "job_count": 0, "project_count": 0,
                                "invoiced": 0.0, "open_ar": 0.0, "collected": 0.0,
                                "pipeline_value": 0.0, "last_activity": None})
    for e in entities:
        r = roll[e["customer_qbo_id"]]
        r["name"] = e["customer_name"]
        r[e["type"] + "_count"] += 1
        if e["type"] == "estimate":
            r["pipeline_value"] += e["value"]
        else:
            r["invoiced"] += e["value"]; r["open_ar"] += e["open_ar"]; r["collected"] += e["collected"]
        if e["last_activity"] and (not r["last_activity"] or e["last_activity"] > r["last_activity"]):
            r["last_activity"] = e["last_activity"]
    customers = [{"customer_qbo_id": k, **{kk: (round(vv, 2) if isinstance(vv, float) else vv) for kk, vv in v.items()}}
                 for k, v in roll.items()]
    customers.sort(key=lambda c: c["invoiced"], reverse=True)

    return {"entities": entities, "customers": customers,
            "totals": {"entities": len(entities), "customers": len(customers)}}


@router.get("/hierarchy")
def customers_hierarchy(user=Depends(require_capability(PAGE_CUSTOMERS))):
    with engine.connect() as conn:
        custs = conn.execute(text("""
            SELECT qbo_id, parent_qbo_id, display_name,
                   COALESCE(is_project, 0) AS is_project,
                   COALESCE(job, 0)        AS job,
                   COALESCE(active, 0)     AS active
            FROM qbo_customers
        """)).mappings().all()

        inv = conn.execute(text("""
            SELECT customer_qbo_id,
                   SUM(total_amt)                  AS invoiced,
                   SUM(balance_amt)                AS open_ar,
                   SUM(total_amt - balance_amt)    AS collected,
                   SUM(CASE WHEN YEAR(txn_date) = YEAR(CURDATE()) THEN total_amt ELSE 0 END) AS invoiced_ytd,
                   MAX(txn_date)                   AS last_txn
            FROM qbo_transactions
            WHERE entity_type = 'Invoice' AND customer_qbo_id IS NOT NULL
            GROUP BY customer_qbo_id
        """)).mappings().all()

    by_qbo = {c["qbo_id"]: c for c in custs}
    parent_of = {c["qbo_id"]: (c["parent_qbo_id"] or None) for c in custs}

    def root_of(q):
        cur, guard = q, 0
        while guard < 10:
            p = parent_of.get(cur)
            if not p or p not in by_qbo:
                return cur
            cur, guard = p, guard + 1
        return cur

    # Per-customer (directly-tagged) invoice financials.
    fin = {}
    for r in inv:
        fin[r["customer_qbo_id"]] = {
            "invoiced": float(r["invoiced"] or 0),
            "open_ar": float(r["open_ar"] or 0),
            "collected": float(r["collected"] or 0),
            "invoiced_ytd": float(r["invoiced_ytd"] or 0),
            "last_txn": str(r["last_txn"]) if r["last_txn"] else None,
        }

    # Group every customer under its root company.
    subtree = defaultdict(list)
    for c in custs:
        subtree[root_of(c["qbo_id"])].append(c)

    customers = []
    for root_id, members in subtree.items():
        root = by_qbo[root_id]
        if root["is_project"] or root["job"]:
            continue  # roots should be top-level companies; skip stray nested roots

        roll = _blank()
        direct = _blank()
        children = []
        project_count = job_count = 0

        for m in members:
            mfin = fin.get(m["qbo_id"])
            f = {
                "invoiced": float(mfin["invoiced"]) if mfin else 0.0,
                "collected": float(mfin["collected"]) if mfin else 0.0,
                "open_ar": float(mfin["open_ar"]) if mfin else 0.0,
                "invoiced_ytd": float(mfin["invoiced_ytd"]) if mfin else 0.0,
                "last_txn": mfin["last_txn"] if mfin else None,
            }
            _add(roll, f)
            if m["qbo_id"] != root_id and (m["is_project"] or m["job"]):
                kind = "project" if m["is_project"] else "job"
                project_count += 1 if m["is_project"] else 0
                job_count += 1 if m["job"] and not m["is_project"] else 0
                if mfin:  # only list children that actually have invoices
                    children.append({
                        "type": kind,
                        "qbo_id": m["qbo_id"],
                        "name": m["display_name"],
                        "active": bool(m["active"]),
                        **_round(f),
                    })
            else:
                # the root company itself, or a plain (non-project/job) sub-customer
                _add(direct, f)

        # Skip pure leads: no invoices anywhere and no projects/jobs.
        if roll["invoiced"] == 0 and not children:
            continue

        children.sort(key=lambda x: x["invoiced"], reverse=True)
        if direct["invoiced"] > 0:
            children.append({
                "type": "direct",
                "qbo_id": root_id,
                "name": "Direct to customer (not a project/job)",
                "active": bool(root["active"]),
                **_round(direct),
            })

        customers.append({
            "qbo_id": root_id,
            "name": root["display_name"] or "(unnamed customer)",
            "active": bool(root["active"]),
            "project_count": project_count,
            "job_count": job_count,
            **_round(roll),
            "children": children,
        })

    customers.sort(key=lambda c: c["invoiced"], reverse=True)

    totals = {
        "customer_count": len(customers),
        "project_count": sum(c["project_count"] for c in customers),
        "job_count": sum(c["job_count"] for c in customers),
        "invoiced": round(sum(c["invoiced"] for c in customers), 2),
        "collected": round(sum(c["collected"] for c in customers), 2),
        "open_ar": round(sum(c["open_ar"] for c in customers), 2),
    }
    return {"customers": customers, "totals": totals}
