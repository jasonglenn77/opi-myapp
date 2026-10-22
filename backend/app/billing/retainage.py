"""
Retainage — the held-back part of a progress invoice.

Some customers (e.g. 5402 Ben E Keith) pay each progress invoice except a fixed
percentage (typically 5-15%) that they hold until the job is done. QuickBooks
has no retainage field on these invoices, so the app infers it: an invoice is
"retainage held" when it's been PAID EXCEPT FOR a balance of roughly 5-15% of
its total — or when the invoice text (lines, memo, private note, custom fields)
says "retainage"/"retention" and the open balance is a minority of the invoice.

Held retainage is not overdue A/R: it's money expected when the customer
releases it (after the job's final), so the Billing tab, Ashley's Tracker,
Data Review and Cash Flow treat it as its own thing.
"""
import json
from datetime import date, timedelta

from sqlalchemy import text, bindparam

RET_MIN, RET_MAX = 0.045, 0.155     # balance / total for the "paid except N%" pattern
KW_MAX = 0.30                       # with an explicit retainage keyword, allow up to 30%
KEYWORDS = ("retainage", "retention")
RELEASE_DAYS = 30                   # expected release: project end + net-30


def _has_keyword(raw_json):
    if not raw_json:
        return False
    try:
        d = raw_json if isinstance(raw_json, dict) else json.loads(raw_json)
    except Exception:
        return False
    # only the human-entered text — not BOM descriptions ("rubber retainer")
    bits = [str((d.get("CustomerMemo") or {}).get("value") or ""), str(d.get("PrivateNote") or "")]
    for cf in d.get("CustomField") or []:
        bits += [str(cf.get("Name") or ""), str(cf.get("StringValue") or "")]
    for ln in d.get("Line") or []:
        det = ln.get("SalesItemLineDetail") or {}
        bits.append(str((det.get("ItemRef") or {}).get("name") or ""))
        if not det:   # description-only / discount lines
            bits.append(str(ln.get("Description") or ""))
    blob = " ".join(bits).lower()
    return any(k in blob for k in KEYWORDS)


def is_retainage(total, balance, raw_json=None):
    """Paid except a held-back portion?"""
    total, balance = float(total or 0), float(balance or 0)
    if total <= 0.01 or balance <= 0.01 or balance >= total - 0.01:
        return False   # unpaid, fully paid, or a credit
    r = balance / total
    if RET_MIN <= r <= RET_MAX:
        return True
    return r <= KW_MAX and _has_keyword(raw_json)


def sql_condition(t="qt"):
    """SQL twin of the ratio rule (no keyword check) for set-based queries —
    TRUE when the row looks like held retainage."""
    return (f"({t}.balance_amt > 0.01 AND {t}.balance_amt < {t}.total_amt - 0.01 "
            f"AND {t}.balance_amt / NULLIF({t}.total_amt, 0) BETWEEN {RET_MIN} AND {RET_MAX})")


def _ds(v):
    return None if not v else str(v)[:10]


def held(conn, entity_ids=None):
    """Every invoice currently holding retainage (latest invoice version per doc),
    optionally limited to some projects. -> list of dicts, oldest first."""
    where = "AND qt.customer_qbo_id IN :ids" if entity_ids else ""
    q = text(f"""
        WITH latest AS (
          SELECT qt.qbo_id, qt.doc_number, qt.customer_qbo_id, qt.txn_date, qt.due_date,
                 qt.total_amt, qt.balance_amt, qt.raw_json,
                 ROW_NUMBER() OVER (PARTITION BY qt.customer_qbo_id, COALESCE(qt.doc_number, qt.qbo_id)
                                    ORDER BY qt.id DESC) AS rn
          FROM qbo_transactions qt
          WHERE qt.entity_type = 'Invoice' AND qt.balance_amt > 0.01
            AND qt.balance_amt < qt.total_amt - 0.01 {where}
        )
        SELECT l.*, qc.display_name FROM latest l
        LEFT JOIN qbo_customers qc ON qc.qbo_id = l.customer_qbo_id
        WHERE l.rn = 1 ORDER BY l.txn_date, l.doc_number
    """)
    params = {}
    if entity_ids:
        q = q.bindparams(bindparam("ids", expanding=True))
        params["ids"] = sorted({str(e) for e in entity_ids})
    rows = [dict(r) for r in conn.execute(q, params).mappings()
            if is_retainage(r["total_amt"], r["balance_amt"], r["raw_json"])]
    if not rows:
        return []
    # when the held part started: the latest payment applied to the invoice
    pay_ids = {}
    for r in rows:
        try:
            pay_ids[r["qbo_id"]] = [str(l.get("TxnId")) for l in (json.loads(r["raw_json"] or "{}").get("LinkedTxn") or [])
                                    if l.get("TxnType") == "Payment" and l.get("TxnId") is not None]
        except Exception:
            pay_ids[r["qbo_id"]] = []
    allp = sorted({p for v in pay_ids.values() for p in v})
    pdates = {}
    if allp:
        pq = text("SELECT qbo_id, txn_date FROM qbo_transactions WHERE entity_type='Payment' AND qbo_id IN :p") \
            .bindparams(bindparam("p", expanding=True))
        pdates = {str(a): _ds(b) for a, b in conn.execute(pq, {"p": allp}).all()}
    ests = {}
    today = date.today()
    out = []
    for r in rows:
        try:
            est = next((str(l.get("TxnId")) for l in (json.loads(r["raw_json"] or "{}").get("LinkedTxn") or [])
                        if l.get("TxnType") == "Estimate"), None)
        except Exception:
            est = None
        pds = [pdates[p] for p in pay_ids.get(r["qbo_id"], []) if pdates.get(p)]
        since = max(pds) if pds else (_ds(r["due_date"]) or _ds(r["txn_date"]))
        total, bal = float(r["total_amt"] or 0), float(r["balance_amt"] or 0)
        out.append({
            "entity_id": str(r["customer_qbo_id"]), "project": r["display_name"],
            "qbo_id": str(r["qbo_id"]), "doc": r["doc_number"], "estimate_qbo_id": est,
            "txn_date": _ds(r["txn_date"]), "due_date": _ds(r["due_date"]),
            "amount": round(total, 2), "held": round(bal, 2), "pct": round(bal / total * 100, 1),
            "held_since": since,
            "age_days": (today - date.fromisoformat(since)).days if since else None,
        })
    return out


def release_dates(conn, entity_ids):
    """entity_id -> expected retainage release date: the project's last
    assignment end (incl. overage days) + RELEASE_DAYS. None when undated."""
    if not entity_ids:
        return {}
    q = text("""
        SELECT qc.qbo_id, MAX(DATE_ADD(psi.end_date, INTERVAL COALESCE(psi.overage_days, 0) DAY)) AS e
        FROM project_schedule_items psi
        JOIN projects p ON p.id = psi.project_id
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        WHERE qc.qbo_id IN :ids AND COALESCE(psi.status, '') <> 'canceled'
        GROUP BY qc.qbo_id
    """).bindparams(bindparam("ids", expanding=True))
    return {str(a): (b + timedelta(days=RELEASE_DAYS) if b else None)
            for a, b in conn.execute(q, {"ids": sorted({str(e) for e in entity_ids})}).all()}
