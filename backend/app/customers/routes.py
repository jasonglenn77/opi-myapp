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
        # Canonical project status = the FINAL assignment row's status (latest by
        # start_date, then sort_order, then id), identical to the Projects page's
        # operational_status. `end_date` (max) drives last-activity.
        psi_rows = conn.execute(text("""
            SELECT project_qbo_id, latest_status, end_date FROM (
              SELECT qc.qbo_id AS project_qbo_id, psi.status AS latest_status,
                     MAX(psi.end_date) OVER (PARTITION BY qc.qbo_id) AS end_date,
                     ROW_NUMBER() OVER (PARTITION BY qc.qbo_id
                       ORDER BY psi.start_date IS NULL, psi.start_date DESC, psi.sort_order DESC, psi.id DESC) AS rn
              FROM myapp.projects p
              JOIN myapp.qbo_customers qc ON qc.id = p.qbo_customer_id AND qc.is_project = 1
              JOIN myapp.project_schedule_items psi ON psi.project_id = p.id
            ) x WHERE rn = 1
        """)).mappings().all()
        # PIPELINE avenue = opportunities (the Pipeline page's source) that have NOT
        # been won → project. Won ones (status='won', or a project link) drop out
        # here and appear under Projects instead — that's the supersession rule.
        opp_rows = conn.execute(text("""
            SELECT o.id AS opp_id, qc.qbo_id AS customer_qbo_id,
                   o.title, o.quote_number, o.pipeline_status, o.status,
                   COALESCE(o.contract_value, o.order_value, 0) AS value,
                   COALESCE(ct.full_name, o.contact_name_raw) AS contact_name,
                   o.last_contact_date, o.rfq_received_date, o.created_at
            FROM opportunities o
            JOIN qbo_customers qc ON qc.id = o.qbo_customer_id
            LEFT JOIN contacts ct ON ct.id = o.contact_id
            WHERE o.active = 1 AND o.project_qbo_id IS NULL
              AND COALESCE(o.status,'') <> 'won'
        """)).mappings().all()
        # Change orders / pending estimates per project = every QBO Estimate tagged
        # to the project (via line-level project tag), beyond the original contract.
        co_rows = conn.execute(text("""
            SELECT project_qbo_id, doc_number, txn_date, total_amt AS amount,
                   JSON_UNQUOTE(JSON_EXTRACT(raw_json,'$.TxnStatus')) AS txn_status
            FROM (
              SELECT DISTINCT sl.project_customer_qbo_id AS project_qbo_id,
                     t.qbo_id, t.doc_number, t.txn_date, t.total_amt, t.raw_json
              FROM qbo_transactions t
              JOIN qbo_sales_transaction_lines sl ON sl.transaction_id = t.id
              WHERE t.entity_type = 'Estimate' AND sl.project_customer_qbo_id IS NOT NULL
            ) e
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

    proj_latest, proj_end = {}, {}
    for r in psi_rows:
        proj_latest[r["project_qbo_id"]] = r["latest_status"]
        if r["end_date"]:
            proj_end[r["project_qbo_id"]] = str(r["end_date"])

    # Change orders / pending estimates per project: sort each project's tagged
    # estimates by date; the oldest is the original contract (already in the
    # project's value), the rest are change orders shown nested under the project.
    def _co_status(ts):
        ts = (ts or "").strip()
        if ts in ("Converted", "Accepted", "Closed"):
            return "approved"
        if ts == "Pending":
            return "pending"
        if ts == "Rejected":
            return "rejected"
        return "open"

    co_by_proj = defaultdict(list)
    for r in co_rows:
        co_by_proj[str(r["project_qbo_id"])].append(r)
    co_summary = {}
    for pq, ests in co_by_proj.items():
        ests.sort(key=lambda e: str(e["txn_date"] or ""))
        cos = ests[1:]  # everything beyond the original contract
        items = [{"doc": e["doc_number"], "amount": round(float(e["amount"] or 0), 2),
                  "status": _co_status(e["txn_status"]),
                  "date": str(e["txn_date"]) if e["txn_date"] else None} for e in cos]
        if items:
            co_summary[pq] = {"items": items, "count": len(items),
                              "pending": sum(1 for i in items if i["status"] == "pending")}

    entities = []
    for c in custs:
        if not (c["is_project"] or c["job"]):
            continue
        root = root_of(c["qbo_id"])
        f = fin.get(c["qbo_id"]) or {"invoiced": 0, "open_ar": 0, "collected": 0, "last_txn": None}
        is_proj = bool(c["is_project"])
        ent = {
            "customer_qbo_id": root, "customer_name": name_of.get(root) or "(unknown)",
            "avenue": "project" if is_proj else "job",
            "type": "project" if is_proj else "job",
            "entity_id": c["qbo_id"], "name": c["display_name"],
            "status": proj_latest.get(c["qbo_id"], "needs_attention") if is_proj
                      else ("active" if c["active"] else "inactive"),
            "value": round(f["invoiced"], 2), "open_ar": round(f["open_ar"], 2),
            "collected": round(f["collected"], 2), "contact_name": None,
            "last_activity": proj_end.get(c["qbo_id"]) or f["last_txn"],
        }
        if is_proj:
            co = co_summary.get(str(c["qbo_id"]))
            if co:
                ent["co_count"] = co["count"]
                ent["co_pending"] = co["pending"]
                ent["change_orders"] = co["items"]
        entities.append(ent)
    for o in opp_rows:
        root = root_of(o["customer_qbo_id"])
        nm = (f"#{o['quote_number']} {o['title'] or ''}").strip() if o["quote_number"] else (o["title"] or "(opportunity)")
        entities.append({
            "customer_qbo_id": root, "customer_name": name_of.get(root) or "(unknown)",
            "avenue": "pipeline", "type": "pipeline", "entity_id": o["opp_id"], "name": nm,
            "status": o["pipeline_status"] or o["status"] or "open",
            "value": float(o["value"] or 0), "open_ar": 0.0, "collected": 0.0,
            "contact_name": o["contact_name"],
            "last_activity": str(o["last_contact_date"] or o["rfq_received_date"] or o["created_at"] or "") or None,
        })

    # Per-customer rollups for the group-by-customer view. Revenue (invoiced) comes
    # from projects/jobs only — pipeline face value is a separate figure.
    roll = defaultdict(lambda: {"name": "", "pipeline_count": 0, "job_count": 0, "project_count": 0,
                                "invoiced": 0.0, "open_ar": 0.0, "collected": 0.0,
                                "pipeline_value": 0.0, "last_activity": None})
    for e in entities:
        r = roll[e["customer_qbo_id"]]
        r["name"] = e["customer_name"]
        r[e["avenue"] + "_count"] += 1
        if e["avenue"] == "pipeline":
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
