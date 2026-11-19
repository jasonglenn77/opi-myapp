"""Project Setup, "First invoice sent", per estimate (2026-11-18 owner feedback).

For each accepted estimate on a project: its first QuickBooks invoice (linked to
the estimate in QuickBooks, as 99% are), with sent / due / expected dates, terms
and status; and whether a first invoice is needed at all. The office sets that
per estimate (project_estimate_first_invoice, 0108); with no setting the billing
rule decides: change orders and small estimates bill once, at completion
(billing/invoice_dates.single_invoice), so they need no first invoice.

The step is done when every accepted estimate that needs a first invoice has one.
"""
from collections import defaultdict

from sqlalchemy import bindparam, text

from app.assumptions import calibrate as CAL
from app.billing import invoice_dates as IDT

ACCEPTED = ("Accepted", "Converted", "Closed")


def _x(sql, *names):
    q = text(sql)
    return q.bindparams(*[bindparam(n, expanding=True) for n in names]) if names else q


def by_project(conn, eids, detail=False):
    """{eid: [estimate, ...]} for accepted estimates (oldest first). detail=True
    adds every invoice per estimate with expected dates."""
    eids = [str(e) for e in eids if e]
    if not eids:
        return {}
    ests = conn.execute(_x("""
        WITH latest AS (
          SELECT t.customer_qbo_id AS e, t.qbo_id, t.doc_number, t.txn_date, t.total_amt, t.id,
                 JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) AS st,
                 ROW_NUMBER() OVER (PARTITION BY t.customer_qbo_id, COALESCE(t.doc_number, t.qbo_id) ORDER BY t.id DESC) AS rn
          FROM qbo_transactions t WHERE t.entity_type = 'Estimate' AND t.customer_qbo_id IN :e)
        SELECT e, qbo_id, doc_number, txn_date, total_amt, st FROM latest WHERE rn = 1 ORDER BY e, txn_date, doc_number""", "e"),
        {"e": eids}).mappings().all()
    kinds = {(str(r[0]), str(r[1])): r[2] for r in conn.execute(_x("""
        SELECT project_qbo_id, qbo_estimate_id, kind FROM project_change_orders
        WHERE qbo_estimate_id IS NOT NULL AND project_qbo_id IN :e""", "e"), {"e": eids}).all()}
    marks = {(str(r["entity_id"]), str(r["estimate_qbo_id"])): dict(r) for r in conn.execute(_x("""
        SELECT entity_id, estimate_qbo_id, need, note, by_email, at FROM project_estimate_first_invoice
        WHERE entity_id IN :e""", "e"), {"e": eids}).mappings().all()}
    invs = defaultdict(list)
    for r in conn.execute(_x("""
        SELECT t.customer_qbo_id AS e, t.qbo_id, t.doc_number, t.txn_date, t.due_date, t.total_amt, t.balance_amt,
               JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.SalesTermRef.name')) AS terms,
               lt.est AS est
        FROM qbo_transactions t
        JOIN JSON_TABLE(t.raw_json, '$.LinkedTxn[*]' COLUMNS (typ VARCHAR(20) PATH '$.TxnType', est VARCHAR(40) PATH '$.TxnId')) lt
             ON lt.typ = 'Estimate'
        WHERE t.entity_type = 'Invoice' AND t.customer_qbo_id IN :e
        ORDER BY t.txn_date, t.id""", "e"), {"e": eids}).mappings().all():
        invs[(str(r["e"]), str(r["est"]))].append(dict(r))
    exp = {}
    if detail:
        ids = [str(i["qbo_id"]) for lst in invs.values() for i in lst]
        if ids:
            from app.billing.routes import invoice_expected_dates
            ov, ms = invoice_expected_dates(conn, ids)
            exp = {k: (ov.get(k), ms.get(k)) for k in ids}
    planned = {}
    if detail:      # the estimate's first planned (not yet sent) invoice row on Billing & Schedule
        for r in conn.execute(_x("""
            SELECT s.entity_id, s.estimate_qbo_id, s.net_days, m.id, m.label, m.pct, m.amount, m.invoice_date, m.due_date, m.expected_paid_date
            FROM project_invoice_milestones m JOIN project_invoice_schedules s ON s.id = m.schedule_id
            WHERE s.entity_id IN :e AND m.qbo_invoice_id IS NULL ORDER BY m.seq, m.id""", "e"), {"e": eids}).mappings().all():
            planned.setdefault((str(r["entity_id"]), str(r["estimate_qbo_id"])), {
                "id": r["id"], "label": r["label"], "pct": float(r["pct"]) if r["pct"] is not None else None,
                "amount": round(float(r["amount"] or 0), 2), "net_days": r["net_days"],
                "invoice_date": str(r["invoice_date"]) if r["invoice_date"] else None,
                "due_date": str(r["due_date"]) if r["due_date"] else None,
                "expected_paid_date": str(r["expected_paid_date"]) if r["expected_paid_date"] else None})
    it = CAL.invoice_timing(conn)
    out = defaultdict(list)
    seen = defaultdict(int)
    for r in ests:
        e, q = str(r["e"]), str(r["qbo_id"])
        idx = seen[e]
        seen[e] += 1
        if r["st"] not in ACCEPTED:
            continue
        is_co = kinds.get((e, q), "original" if idx == 0 else "change_order") == "change_order"
        total = float(r["total_amt"] or 0)
        single = IDT.single_invoice(total, is_co, it)
        m = marks.get((e, q))
        need = m["need"] if m else ("not_needed" if single else "needed")
        lst = invs.get((e, q), [])
        first = lst[0] if lst else None
        row = {"qbo_id": q, "doc_number": r["doc_number"], "date": str(r["txn_date"]) if r["txn_date"] else None,
               "total": round(total, 2), "status": r["st"], "change_order": is_co,
               "need": need, "need_set": bool(m), "need_by": m["by_email"] if m else None, "need_note": m["note"] if m else None,
               "default_reason": ("Change orders bill once, at completion" if is_co and single else
                                  f"Under ${float(it.get('single_below') or 0):,.0f}: billed once, at completion" if single else
                                  "Billed in parts (the terms): the first part goes out at the start"),
               "invoiced": bool(first), "invoices_n": len(lst)}
        if detail and first:
            amt, bal = float(first["total_amt"] or 0), float(first["balance_amt"] or 0)
            ov, msd = exp.get(str(first["qbo_id"]), (None, None))
            row["invoice"] = {"qbo_id": str(first["qbo_id"]), "doc_number": first["doc_number"],
                              "date": str(first["txn_date"]) if first["txn_date"] else None,
                              "due": str(first["due_date"]) if first["due_date"] else None,
                              "expected": str(ov or msd or first["due_date"] or "") or None, "expected_set": bool(ov),
                              "amount": round(amt, 2), "balance": round(bal, 2), "terms": first["terms"],
                              "pct": round(100 * amt / total, 1) if total else None,
                              "status": "Paid" if bal <= 0.01 else ("Partly paid" if bal < amt - 0.01 else "Open (sent)")}
        if detail and not first:
            row["planned"] = planned.get((e, q))
        out[e].append(row)
    return out


def step_state(rows):
    """(done, detail) for the Setup step from by_project rows of one project."""
    if not rows:
        return False, ""
    want = [r for r in rows if r["need"] == "needed"]
    missing = [r for r in want if not r["invoiced"]]
    sent = sum(1 for r in want if r["invoiced"])
    if not want:
        return True, "No first invoice needed (" + ", ".join(f"#{r['doc_number']}" for r in rows[:4]) + (" …" if len(rows) > 4 else "") + ")"
    if not missing:
        return True, f"First invoice sent on {sent} estimate{'s' if sent != 1 else ''}"
    return False, (f"{len(missing)} estimate{'s' if len(missing) != 1 else ''} still need a first invoice: "
                   + ", ".join(f"#{r['doc_number']}" for r in missing[:4]) + (" …" if len(missing) > 4 else ""))
