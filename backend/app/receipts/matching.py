"""
Costs the app knows about before QuickBooks does.

QuickBooks is always the record of what was spent. A receipt, a typed entry or a
job tag on a card charge (the `receipts` table, by `source`) only fills the gap
until the real line posts, so each entry must clear itself or the cost would be
counted twice. After every sync:

  * an open entry whose amount and date match a line tagged to the same job is
    marked allocated (matched_how = 'auto') and stops counting
  * if the matching line has no job tag, the entry stays open and records that
    line, so the office sees "this receipt is that charge: tag it to this job"
  * a card charge tagged in the app clears once the line has that job in QuickBooks

Match: amount within MATCH_TOL_ABS / MATCH_TOL_PCT, line dated from DAYS_BEFORE
before the entry to DAYS_AFTER after it (Hotel Engine statements and rental bills
arrive weeks later). Each line clears one entry.
"""
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import text

from app.db import engine

MATCH_TOL_ABS, MATCH_TOL_PCT = 1.0, 0.01
DAYS_BEFORE, DAYS_AFTER = 5, 60
UNTAGGED_DAYS = 90

# receipts.category -> job cost category
CATEGORY_MAP = {"travel": "Travel", "materials": "Materials", "propane_fuel": "Propane", "lodging": "Lodging",
                "lifts": "Lifts", "rentals": "Other rentals", "other": "Other"}
ITEM_SQL = """COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')),
                 SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')), ':', 1))"""
VENDOR_SQL = """COALESCE(JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.VendorRef.name')),
                         JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.EntityRef.name')))"""


def open_totals(conn):
    """{entity_id: {job cost category: amount}} still waiting on QuickBooks."""
    out = defaultdict(lambda: defaultdict(float))
    for r in conn.execute(text("""
        SELECT project_qbo_id, category, SUM(amount) FROM receipts
        WHERE status <> 'allocated' AND amount IS NOT NULL GROUP BY project_qbo_id, category
    """)).all():
        out[str(r[0])][CATEGORY_MAP.get(r[1], "Other")] += float(r[2] or 0)
    return out


def _vendor_hit(a, b):
    a, b = (a or "").lower(), (b or "").lower()
    return bool(a and b) and (a in b or b in a or a.split()[0] == b.split()[0])


def match_all():
    with engine.begin() as conn:
        entries = conn.execute(text("""
            SELECT id, project_qbo_id, amount, COALESCE(receipt_date, DATE(created_at)) AS d, vendor, source, qbo_line_id
            FROM receipts WHERE status <> 'allocated' AND amount IS NOT NULL
        """)).mappings().all()
        if not entries:
            return {"open": 0, "cleared": 0, "found": 0}
        since = min(e["d"] for e in entries) - timedelta(days=DAYS_BEFORE)
        lines = conn.execute(text(f"""
            SELECT l.id, l.line_customer_qbo_id AS e, l.amount AS a, t.txn_date AS d, {VENDOR_SQL} AS vendor
            FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
            WHERE t.entity_type IN ('Bill', 'Purchase') AND t.txn_date >= :s AND l.amount > 0
        """), {"s": since}).mappings().all()
        used = set(conn.execute(text("SELECT qbo_line_id FROM receipts WHERE status = 'allocated' AND qbo_line_id IS NOT NULL")).scalars())
        by_line = {l["id"]: l for l in lines}
        cleared = found = 0
        for x in sorted(entries, key=lambda v: v["d"]):
            pid, amt = str(x["project_qbo_id"]), float(x["amount"])
            # a charge already linked to this entry: cleared once it carries the job
            linked = by_line.get(x["qbo_line_id"]) if x["qbo_line_id"] else None
            if linked and str(linked["e"] or "") == pid:
                best = linked
            elif linked and linked["e"] and x["source"] == "card":
                best = linked                 # QuickBooks tagged it to another job: QuickBooks wins
            elif x["source"] == "card":
                best = None                   # still waiting on the tag
            else:
                tol = max(MATCH_TOL_ABS, MATCH_TOL_PCT * amt)
                pool = [l for l in lines if l["id"] not in used and l["d"]
                        and abs(float(l["a"]) - amt) <= tol
                        and x["d"] - timedelta(days=DAYS_BEFORE) <= l["d"] <= x["d"] + timedelta(days=DAYS_AFTER)]
                def score(l):
                    return (not _vendor_hit(x["vendor"], l["vendor"]), abs((l["d"] - x["d"]).days))
                tagged = sorted((l for l in pool if str(l["e"] or "") == pid), key=score)
                untagged = sorted((l for l in pool if not l["e"]), key=score)
                best = tagged[0] if tagged else None
                if not best and untagged and x["qbo_line_id"] != untagged[0]["id"]:
                    conn.execute(text("UPDATE receipts SET qbo_line_id = :l, matched_how = 'found' WHERE id = :i"),
                                 {"l": untagged[0]["id"], "i": x["id"]})
                    found += 1
            if best:
                used.add(best["id"])
                conn.execute(text("""UPDATE receipts SET status = 'allocated', qbo_line_id = :l, matched_how = 'auto',
                                       matched_at = NOW(), allocated_at = NOW() WHERE id = :i"""),
                             {"l": best["id"], "i": x["id"]})
                cleared += 1
    return {"open": len(entries) - cleared, "cleared": cleared, "found": found}


def untagged_charges(conn, days=UNTAGGED_DAYS):
    """Job-type bills and card charges with no job, newest first. Company spend
    ('Other') stays out, and a charge already given a job in the app is skipped."""
    from app.jobcost.service import category_of
    since = date.today() - timedelta(days=days)
    done = {r[0]: r for r in conn.execute(text("""
        SELECT r.qbo_line_id, r.project_qbo_id, r.id, r.source, qc.display_name
        FROM receipts r LEFT JOIN qbo_customers qc ON qc.qbo_id = r.project_qbo_id COLLATE utf8mb4_unicode_ci
        WHERE r.qbo_line_id IS NOT NULL
    """)).all()}
    out = []
    for r in conn.execute(text(f"""
        SELECT l.id, l.amount AS a, l.description AS d, t.entity_type AS type, t.txn_date AS date, t.doc_number AS doc,
               {VENDOR_SQL} AS vendor, {ITEM_SQL} AS item
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE l.line_customer_qbo_id IS NULL AND t.entity_type IN ('Bill', 'Purchase') AND t.txn_date >= :s AND l.amount > 0
        ORDER BY t.txn_date DESC, l.id DESC
    """), {"s": since}).mappings():
        cat = category_of(r["item"])
        if not cat or cat in ("Other", "Crew labor"):
            continue
        link = done.get(r["id"])
        if link and link[3] == "card":
            continue
        out.append({"line_id": r["id"], "date": str(r["date"]), "type": "Card" if r["type"] == "Purchase" else "Bill", "doc": r["doc"],
                    "vendor": r["vendor"] or "Unknown", "item": r["item"], "category": cat, "description": r["d"],
                    "amount": float(r["a"]),
                    "suggested": {"entity_id": str(link[1]), "name": link[4], "receipt_id": link[2]} if link else None})
    return out
