"""
Pending QuickBooks estimates filed under the customer that look like they belong
to one of that customer's jobs. Estimates tagged to the job already count as
pending there; these don't, so an overage can look unexplained.

An estimate qualifies when it's dated from a week before the job starts to 90 days
after it ends, and its memo names the job's company, and either:

  change order  the memo also says add, additional, modification, change order...
  same site     the memo names the job's city too

An estimate whose memo names a different city ("... in Burlington, NJ") is skipped,
and so is one carrying any project's number: that's the project's own quote.
So is one whose number is also on an estimate under a project: it was re-created
on the job, and the customer's Pending copy was left behind.
This is a lead: it could be a next phase or a quote that went nowhere, so it's never
added to the job's numbers until staff move it to the job in QuickBooks.
"""
import re
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import text

BEFORE_DAYS, AFTER_DAYS = 7, 90
SINCE = date(2024, 6, 1)
_WORDS = re.compile(r"\bc\.?o\.?\s*#|\bchange.?orders?\b|\badd(ing|ition|itions|itional|ed)?\b|\badd.?on\b|\bextra\b"
                    r"|\bmodif\w*|\brevis\w*|\b3rd crew\b", re.I)
_STOP = {"the", "and", "inc", "llc", "corp", "company", "co", "of", "at", "for", "a"}
_PLACE = re.compile(r"\b(?:in|at)\s+([A-Z][A-Za-z .'-]*?),?\s+[A-Z]{2}\b")


def _tokens(s):
    return {w for w in re.findall(r"[a-z0-9]+", (s or "").lower()) if w not in _STOP}


def _parts(name):
    """'6304 - DHL - Las Vegas, NV' -> ('6304', {'dhl'}, {'las', 'vegas'})."""
    bits = [b.strip() for b in (name or "").split(" - ")]
    if len(bits) < 3 or not bits[0].isdigit():
        return None
    return bits[0], _tokens(" ".join(bits[1:-1])), _tokens(bits[-1].split(",")[0])


def find(conn, jobs):
    """[{entity_id, doc, date, amount, customer, memo, why}], best job per estimate."""
    projects = conn.execute(text("SELECT qbo_id, parent_qbo_id, display_name FROM qbo_customers WHERE is_project = 1")).all()
    parents = {str(r[0]): str(r[1]) for r in projects if r[1]}
    numbers = {p[0] for p in (_parts(r[2]) for r in projects) if p}
    # QuickBooks keeps the customer's copy when an estimate is re-created on the job
    numbers |= {str(r[0]) for r in conn.execute(text("""
        SELECT DISTINCT t.doc_number FROM qbo_transactions t JOIN qbo_customers qc ON qc.qbo_id = t.customer_qbo_id
        WHERE t.entity_type = 'Estimate' AND qc.is_project = 1 AND t.doc_number IS NOT NULL""")).all()}
    by_parent = defaultdict(list)
    for e, j in jobs.items():
        p, parts = parents.get(str(e)), _parts(j.get("name"))
        if p and parts and j.get("start") and j.get("end"):
            by_parent[p].append((e, j, parts))

    out = []
    for r in conn.execute(text("""
        SELECT t.qbo_id, t.doc_number, t.txn_date, t.total_amt, t.customer_qbo_id, qc.display_name AS customer,
               JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.CustomerMemo.value')) AS memo
        FROM qbo_transactions t JOIN qbo_customers qc ON qc.qbo_id = t.customer_qbo_id
        WHERE t.entity_type = 'Estimate' AND qc.is_project = 0 AND t.txn_date >= :since
          AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) = 'Pending'
    """), {"since": SINCE}).mappings():
        if str(r["doc_number"]) in numbers:
            continue
        memo = " ".join((r["memo"] or "").split())
        said = _tokens(memo)
        place = _PLACE.search(memo)
        named = _tokens(place.group(1)) if place else set()
        best = None
        for e, j, (number, company, city) in by_parent.get(str(r["customer_qbo_id"]), []):
            if not company or not company <= said or (named and city and not named & city):
                continue
            if not date.fromisoformat(j["start"]) - timedelta(days=BEFORE_DAYS) <= r["txn_date"] \
                    <= date.fromisoformat(j["end"]) + timedelta(days=AFTER_DAYS):
                continue
            words, site = bool(_WORDS.search(memo)), bool(city) and city <= said
            if not words and not site:
                continue
            rank = (words, site)
            if best is None or rank > best[0]:
                best = (rank, e, words)
        if best:
            out.append({"entity_id": best[1], "qbo_id": str(r["qbo_id"]), "doc": r["doc_number"], "date": str(r["txn_date"]),
                        "amount": float(r["total_amt"] or 0), "customer": r["customer"], "memo": memo[:120],
                        "why": "change order" if best[2] else "same site"})
    return out
