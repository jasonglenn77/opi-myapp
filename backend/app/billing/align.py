"""
Align invoice schedules to the ACTUAL QuickBooks invoices.

Each accepted estimate gets a planned invoice schedule (35/35/30 by default —
see billing.routes._ensure_invoice_schedules). Once real invoices exist in QBO
the plan should follow them. Rules, per estimate schedule:

  * No actual invoice linked to the estimate  -> untouched ("left alone").
  * Match invoices to milestones IN ORDER by amount (tolerance max($5, 1%)).
    A milestone already linked to an invoice (qbo_invoice_id, from a previous
    run) keeps that link, so re-runs are stable.
  * All invoices matched ("matched"): each matched milestone takes the
    invoice's amount, invoice date, due date and status (paid / sent /
    partial), and — once paid — the actual paid date as its expected-paid date.
    Its label is kept; pct becomes amount / current estimate value. The unbilled rest of the estimate (estimate value -
    invoiced) is trued up onto the remaining un-edited milestones (so the plan
    adds up to the estimate after it was revised); fully billed -> un-edited
    leftover rows are removed.
  * Some invoice doesn't fit the plan ("restructured"): the schedule becomes one
    row per actual invoice (matched rows keep their label; others are labelled
    "Invoice #NNNN") plus ONE remaining row for any unbilled balance (keeps the
    original label/dates when an old milestone's amount equals the balance,
    else "Balance to bill" with the last planned row's dates).
  * The schedule ALWAYS adds up to the CURRENT QBO estimate total: every pass
    (also with no invoices yet, e.g. the estimate was revised) trues the
    un-overridden, not-yet-invoiced rows up to the cent (proportionally; the last
    row absorbs rounding). Only a hand-set AMOUNT / % (amount_edited = 1, set by
    the PATCH when amount or pct changes) is held fixed — a date/label edit
    (edited = 1) isn't. If overrides leave nothing to true up, the Billing tab's
    Σ footer says how far off the user's schedule is.
  * Hand-set amounts are never changed unless the row IS an invoice (an
    invoice's facts win). A restructure that would have to rewrite one is
    skipped and reported as ambiguous (edited_conflict).
  * An invoice paid except a held-back 5-15% (billing/retainage.py) gets status
    'retainage' instead of 'partial' — held retainage, not overdue A/R.
  * Data Review (ambiguous_items): besides the alignment conflicts, partly
    billed estimates whose unbilled balance is due / undated / on a completed
    project ('unbilled_balance') and every project holding retainage
    ('retainage_held').
  * Invoices with no estimate link count toward the project's only accepted
    estimate; with several estimates they're reported, not guessed.

Every change is audited (audit_log, actor system:billing-align) with per-row
before/after plus a per-schedule snapshot (action billing.schedule_align) that
`--undo RUN_ID` restores.

CLI (inside the backend container):
    python -m app.billing.align                 # dry run, all projects
    python -m app.billing.align --apply         # write
    python -m app.billing.align --project 1960  # one project (dry run)
    python -m app.billing.align --undo RUN_ID   # restore a previous --apply run
Runs automatically after each QBO transactions sync and when a project's
Billing & Schedule tab is opened (align_project).
"""
import argparse
import hashlib
import json
import uuid
from datetime import date, datetime, timedelta

from sqlalchemy import text, bindparam

from app.db import engine
from app.audit import record_audit
from app.billing import retainage as RET

SYSTEM_ACTOR = {"id": None, "email": "system:billing-align"}
_ACCEPTED = ("Accepted", "Converted")
_FIELDS = ("seq", "label", "pct", "invoice_date", "due_date", "expected_paid_date",
           "amount", "status", "qbo_invoice_id")
BAL_MIN = 0.5          # a schedule is "off" / a balance is "left" above 50 cents
SOON_DAYS = 14         # unbilled balance planned within this many days needs attention


def _tol(a):
    return max(5.0, 0.01 * abs(float(a or 0)))


def _r2(v):
    return None if v is None else round(float(v), 2)


def _ds(v):
    return None if not v else str(v)[:10]


def _norm(f, v):
    if f in ("amount",):
        return _r2(v)
    if f == "pct":
        return None if v is None else round(float(v), 3)
    if f in ("invoice_date", "due_date", "expected_paid_date"):
        return _ds(v)
    if f == "seq":
        return None if v is None else int(v)
    return None if v is None else str(v)


def _fp(*parts):
    return hashlib.sha1(json.dumps(parts, default=str, sort_keys=True).encode()).hexdigest()[:16]


def _money(v):
    return f"${float(v):,.0f}" if v is not None else "—"


def _in(sql, **ids):
    q = text(sql)
    for k in ids:
        q = q.bindparams(bindparam(k, expanding=True))
    return q


# ---------------------------------------------------------------------------
# Data loading (bulk for all projects, or one project)
# ---------------------------------------------------------------------------
def _linked(raw_json, typ):
    try:
        return [str(l.get("TxnId")) for l in (json.loads(raw_json or "{}").get("LinkedTxn") or [])
                if l.get("TxnType") == typ and l.get("TxnId") is not None]
    except Exception:
        return []


def _load(conn, entity_ids):
    if not entity_ids:
        return {}
    ids = sorted(set(str(e) for e in entity_ids))
    data = {e: {"name": None, "scheds": {}, "estimates": {}, "invoices": [], "credits": [],
                "status": None} for e in ids}
    for r in conn.execute(_in("SELECT qbo_id, display_name FROM qbo_customers WHERE qbo_id IN :ids", ids=1),
                          {"ids": ids}).mappings():
        data[str(r["qbo_id"])]["name"] = r["display_name"]
    # the project's status = its final assignment row's (same rule as the hub)
    for r in conn.execute(_in("""
        SELECT qbo_id, status FROM (
          SELECT qc.qbo_id, psi.status,
                 ROW_NUMBER() OVER (PARTITION BY qc.qbo_id ORDER BY psi.start_date IS NULL, psi.start_date DESC,
                                    psi.sort_order DESC, psi.id DESC) AS rn
          FROM project_schedule_items psi JOIN projects p ON p.id = psi.project_id
          JOIN qbo_customers qc ON qc.id = p.qbo_customer_id WHERE qc.qbo_id IN :ids
        ) x WHERE rn = 1
    """, ids=1), {"ids": ids}).mappings():
        data[str(r["qbo_id"])]["status"] = r["status"]
    for s in conn.execute(_in("""
        SELECT id, entity_id, estimate_qbo_id, estimate_doc_number, contract_value
        FROM project_invoice_schedules WHERE entity_id IN :ids AND estimate_qbo_id IS NOT NULL
    """, ids=1), {"ids": ids}).mappings():
        data[str(s["entity_id"])]["scheds"][str(s["estimate_qbo_id"])] = {**dict(s), "ms": []}
    by_sid = {s["id"]: s for d in data.values() for s in d["scheds"].values()}
    if by_sid:
        for m in conn.execute(_in("""
            SELECT id, schedule_id, seq, label, pct, invoice_date, due_date, expected_paid_date,
                   amount, status, note, edited, amount_edited, qbo_invoice_id
            FROM project_invoice_milestones WHERE schedule_id IN :sids ORDER BY seq, id
        """, sids=1), {"sids": list(by_sid)}).mappings():
            by_sid[m["schedule_id"]]["ms"].append(dict(m))
    for r in conn.execute(_in("""
        SELECT qbo_id, doc_number, customer_qbo_id, total_amt,
               JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.TxnStatus')) AS st
        FROM qbo_transactions WHERE entity_type='Estimate' AND customer_qbo_id IN :ids
    """, ids=1), {"ids": ids}).mappings():
        data[str(r["customer_qbo_id"])]["estimates"][str(r["qbo_id"])] = {
            "qbo_id": str(r["qbo_id"]), "doc": r["doc_number"], "value": float(r["total_amt"] or 0),
            "accepted": r["st"] in _ACCEPTED, "status": r["st"]}
    pay_ids = set()
    for r in conn.execute(_in("""
        SELECT qbo_id, doc_number, customer_qbo_id, txn_date, due_date, total_amt, balance_amt, raw_json
        FROM qbo_transactions WHERE entity_type='Invoice' AND customer_qbo_id IN :ids
        ORDER BY txn_date, doc_number
    """, ids=1), {"ids": ids}).mappings():
        total = float(r["total_amt"] or 0)
        if abs(total) < 0.005:
            continue  # voided
        inv = {"qbo_id": str(r["qbo_id"]), "doc": r["doc_number"], "txn_date": _ds(r["txn_date"]),
               "due_date": _ds(r["due_date"]), "amount": round(total, 2),
               "balance": round(float(r["balance_amt"] or 0), 2),
               "est_ids": _linked(r["raw_json"], "Estimate"),
               "pay_ids": _linked(r["raw_json"], "Payment"),
               "retainage": RET.is_retainage(total, r["balance_amt"], r["raw_json"])}
        pay_ids.update(inv["pay_ids"])
        data[str(r["customer_qbo_id"])]["invoices"].append(inv)
    pay_dates = {}
    if pay_ids:
        for r in conn.execute(_in("""
            SELECT qbo_id, txn_date FROM qbo_transactions WHERE entity_type='Payment' AND qbo_id IN :p
        """, p=1), {"p": sorted(pay_ids)}).all():
            pay_dates[str(r[0])] = _ds(r[1])
    for d in data.values():
        for inv in d["invoices"]:
            ds = [pay_dates[p] for p in inv["pay_ids"] if pay_dates.get(p)]
            inv["paid_date"] = max(ds) if ds else None
    for r in conn.execute(_in("""
        SELECT qbo_id, doc_number, customer_qbo_id, txn_date, total_amt
        FROM qbo_transactions WHERE entity_type='CreditMemo' AND customer_qbo_id IN :ids
    """, ids=1), {"ids": ids}).mappings():
        data[str(r["customer_qbo_id"])]["credits"].append(
            {"qbo_id": str(r["qbo_id"]), "doc": r["doc_number"], "date": _ds(r["txn_date"]),
             "amount": float(r["total_amt"] or 0)})
    # estimates an invoice links to that aren't this project's (another customer)
    foreign = {e for d in data.values() for inv in d["invoices"] for e in inv["est_ids"]
               if e not in d["estimates"]}
    data["_foreign_est"] = {}
    if foreign:
        for r in conn.execute(_in("""
            SELECT t.qbo_id, t.doc_number, t.customer_qbo_id, qc.display_name
            FROM qbo_transactions t LEFT JOIN qbo_customers qc ON qc.qbo_id = t.customer_qbo_id
            WHERE t.entity_type='Estimate' AND t.qbo_id IN :f
        """, f=1), {"f": sorted(foreign)}).mappings():
            data["_foreign_est"][str(r["qbo_id"])] = dict(r)
    return data


# ---------------------------------------------------------------------------
# Planning (pure — no writes)
# ---------------------------------------------------------------------------
def _inv_status(inv):
    if inv["balance"] <= 0.01:
        return "paid"
    if inv["balance"] < inv["amount"] - 0.01:
        # paid except a held-back 5-15% -> retainage (not overdue A/R)
        return "retainage" if inv.get("retainage") else "partial"
    return "sent"


def _locked(m):
    """A hand-set amount / % (amount_edited) — the true-up never moves it."""
    return bool(m.get("amount_edited"))


def _true_up(free, target, pct):
    """Spread `target` over the un-overridden rows in proportion to their current
    amounts (equal split when they're all zero); the last row absorbs rounding,
    so the schedule adds up to the cent."""
    cur = round(sum(float(r["amount"] or 0) for r in free), 2)
    if abs(cur - target) <= 0.005 and all(r.get("amount") is not None for r in free):
        return
    acc = 0.0
    for i, r in enumerate(free):
        last = i == len(free) - 1
        share = (float(r["amount"] or 0) / cur) if cur > 0 else 1.0 / len(free)
        amt = round(target - acc, 2) if last else round(target * share, 2)
        acc = round(acc + amt, 2)
        r.update(amount=amt, pct=pct(amt))


def _inv_fields(inv, m):
    """Target fields for a milestone that IS this invoice."""
    st = _inv_status(inv)
    exp = m.get("expected_paid_date") if m else None
    if st == "paid":
        exp = inv["paid_date"] or _ds(exp) or inv["due_date"]
    return {"amount": inv["amount"], "invoice_date": inv["txn_date"], "due_date": inv["due_date"],
            "expected_paid_date": _ds(exp), "status": st, "qbo_invoice_id": inv["qbo_id"]}


def _assign_invoices(d, ambiguous, eid):
    """invoice -> estimate schedule key. Returns {est_qbo_id: [inv, ...]}."""
    scheds = d["scheds"]
    accepted = [k for k in scheds if (d["estimates"].get(k) or {}).get("accepted")]
    out = {}
    for inv in d["invoices"]:
        ests = [e for e in dict.fromkeys(inv["est_ids"])]
        if len(ests) > 1:
            ambiguous.append(("invoice_multi_estimate", eid, {"inv": inv, "ests": ests}))
            continue
        if ests:
            k = ests[0]
            if k in scheds and k in accepted:
                out.setdefault(k, []).append(inv)
            else:
                e = d["estimates"].get(k)
                why = ("other_customer" if not e else "not_accepted" if not e["accepted"] else "no_schedule")
                ambiguous.append(("invoice_other_estimate", eid, {"inv": inv, "est": k, "why": why, "e": e}))
            continue
        if len(accepted) == 1:
            out.setdefault(accepted[0], []).append(inv)
        else:
            ambiguous.append(("invoice_unlinked", eid, {"inv": inv, "n_est": len(accepted)}))
    return out


def _plan_schedule(sched, est, invs):
    """-> (cls, target_rows, sched_changes, note). target rows carry 'id' (None
    = insert); rows of the current schedule missing from target are deleted.
    cls: matched | restructured | left_alone | ambiguous."""
    ms = sched["ms"]
    value = float(est["value"])
    sched_changes = {}
    pct = lambda a: round(a / value * 100.0, 3) if value else None
    if invs or value > 0:
        if _r2(sched["contract_value"]) != _r2(value):
            sched_changes["contract_value"] = [_r2(sched["contract_value"]), _r2(value)]
        if (sched["estimate_doc_number"] or None) != (est["doc"] or None):
            sched_changes["estimate_doc_number"] = [sched["estimate_doc_number"], est["doc"]]

    if not invs:
        # unlink rows whose invoice vanished (voided/deleted), then true the
        # un-overridden rows up so the plan adds up to the CURRENT estimate value
        # (estimate revised before anything was billed).
        rows = [dict(m) for m in ms]
        for r in rows:
            if r.get("qbo_invoice_id"):
                r.update(qbo_invoice_id=None, status="pending")
        free = [r for r in rows if not _locked(r)]
        if value > 0 and free:
            locked_sum = round(sum(float(r["amount"] or 0) for r in rows if _locked(r)), 2)
            _true_up(free, round(max(0.0, value - locked_sum), 2), pct)
        changed = any(_norm(f, r.get(f)) != _norm(f, m.get(f)) for r, m in zip(rows, ms) for f in _FIELDS)
        return ("left_alone", rows if changed else None, sched_changes, None)

    invs = sorted(invs, key=lambda i: (i["txn_date"] or "9999", str(i["doc"] or "")))
    by_q = {i["qbo_id"]: i for i in invs}
    pair = {}      # inv qbo_id -> milestone id
    used = set()
    for m in ms:   # 1) keep existing links
        q = m.get("qbo_invoice_id")
        if q and str(q) in by_q and str(q) not in pair:
            pair[str(q)] = m["id"]
            used.add(m["id"])
    for inv in invs:  # 2) match remaining invoices in order by amount
        if inv["qbo_id"] in pair:
            continue
        for m in ms:
            if m["id"] in used:
                continue
            if abs(float(m["amount"] or 0) - inv["amount"]) <= _tol(inv["amount"]):
                pair[inv["qbo_id"]] = m["id"]
                used.add(m["id"])
                break
    mby = {m["id"]: m for m in ms}
    invoiced = round(sum(i["amount"] for i in invs), 2)
    remaining = round(value - invoiced, 2)
    unmatched = [m for m in ms if m["id"] not in used]

    if len(pair) == len(invs):
        cls = "matched"
        rows = []
        for m in ms:
            r = dict(m)
            if m["id"] in used:
                inv = by_q[next(q for q, mid in pair.items() if mid == m["id"])]
                r.update(_inv_fields(inv, m), pct=pct(inv["amount"]))
            else:
                if r.get("qbo_invoice_id"):
                    r.update(qbo_invoice_id=None, status="pending")
            rows.append(r)
        free = [r for r in rows if r["id"] not in used and not _locked(r)]
        edited_sum = round(sum(float(r["amount"] or 0) for r in rows
                               if r["id"] not in used and _locked(r)), 2)
        target = round(remaining - edited_sum, 2)
        free_keys = {id(r) for r in free}
        if remaining <= BAL_MIN:
            rows = [r for r in rows if id(r) not in free_keys]
        elif free:
            if target <= BAL_MIN:
                rows = [r for r in rows if id(r) not in free_keys]
            else:
                _true_up(free, target, pct)
        elif not [r for r in rows if r["id"] not in used] and remaining > BAL_MIN:
            rows.append({"id": None, "seq": max([r["seq"] or 0 for r in rows] + [0]) + 1,
                         "label": "Balance to bill", "pct": pct(remaining), "invoice_date": None,
                         "due_date": None, "expected_paid_date": None, "amount": remaining,
                         "status": "pending", "qbo_invoice_id": None, "edited": 0})
        note = "over-billed" if remaining < -_tol(value) else None
        return (cls, rows, sched_changes, note)

    # restructure
    if any(_locked(m) for m in unmatched):
        return ("ambiguous", None, {}, "edited_conflict")
    free_ids = [m["id"] for m in unmatched]
    same_shape = len(invs) == len(ms) and abs(remaining) <= _tol(value)
    rows, seq = [], 0
    rem_src = None
    if remaining > BAL_MIN:
        rem_src = next((m for m in unmatched if abs(float(m["amount"] or 0) - remaining) <= _tol(remaining)), None)
        if rem_src is None and unmatched:
            rem_src = unmatched[-1]
        if rem_src is not None:
            free_ids.remove(rem_src["id"])
    for inv in invs:
        seq += 1
        mid = pair.get(inv["qbo_id"])
        if mid:
            r = dict(mby[mid])
        else:
            rid = free_ids.pop(0) if free_ids else None
            full = abs(inv["amount"] - value) <= _tol(value)
            r = dict(mby[rid]) if rid else {"id": None, "note": None, "edited": 0}
            if not (rid and same_shape):   # same count of invoices as milestones -> keep labels by position
                r["label"] = f"Full invoice #{inv['doc']}" if full else f"Invoice #{inv['doc'] or inv['qbo_id']}"
        r.update(_inv_fields(inv, mby.get(mid) or {}), seq=seq, pct=pct(inv["amount"]))
        rows.append(r)
    if remaining > BAL_MIN:
        seq += 1
        if rem_src is not None:
            r = dict(rem_src)
            if abs(float(rem_src["amount"] or 0) - remaining) > _tol(remaining):
                r["label"] = "Balance to bill"
        else:
            r = {"id": None, "label": "Balance to bill", "invoice_date": None, "due_date": None,
                 "expected_paid_date": None, "note": None, "edited": 0}
        r.update(seq=seq, amount=remaining, pct=pct(remaining), status="pending", qbo_invoice_id=None)
        rows.append(r)
    note = "over-billed" if remaining < -_tol(value) else None
    return ("restructured", rows, sched_changes, note)


def _diff(sched, rows):
    """Current milestones vs target rows -> list of ops."""
    ops = []
    if rows is None:
        return ops
    cur = {m["id"]: m for m in sched["ms"]}
    keep = set()
    for r in rows:
        if r.get("id") and r["id"] in cur:
            keep.add(r["id"])
            old = cur[r["id"]]
            ch = {f: [_norm(f, old.get(f)), _norm(f, r.get(f))] for f in _FIELDS
                  if _norm(f, old.get(f)) != _norm(f, r.get(f))}
            if ch:
                ops.append({"op": "update", "id": r["id"], "label": r.get("label"), "changes": ch})
        else:
            ops.append({"op": "insert", "row": {f: _norm(f, r.get(f)) for f in _FIELDS}})
    for mid, m in cur.items():
        if mid not in keep:
            ops.append({"op": "delete", "id": mid, "label": m["label"],
                        "row": {f: _norm(f, m.get(f)) for f in _FIELDS + ("edited", "note")}})
    return ops


def _unbilled_balance(rows, invs, proj_status, today=None):
    """Partly-billed estimate whose unbilled balance needs attention: its
    remaining (not-yet-invoiced) row(s) are planned in the past / within
    SOON_DAYS, have no date, or the project is already completed. -> dict|None."""
    if not invs:
        return None
    rest = [r for r in rows if not r.get("qbo_invoice_id")]
    bal = round(sum(float(r.get("amount") or 0) for r in rest), 2)
    if bal <= BAL_MIN:
        return None
    today = today or date.today()
    dates = sorted(_ds(r.get("invoice_date")) for r in rest if r.get("invoice_date"))
    when = dates[0] if dates else None
    undated = any(not r.get("invoice_date") for r in rest)
    done = proj_status == "completed"
    if when and when < today.isoformat():
        why = "past"
    elif done:
        why = "completed"
    elif undated:
        why = "no_date"
    elif when and when <= (today + timedelta(days=SOON_DAYS)).isoformat():
        why = "soon"
    else:
        return None
    return {"balance": bal, "date": when, "why": why, "labels": [r.get("label") for r in rest],
            "invoiced": round(sum(i["amount"] for i in invs), 2)}


def plan_project(d, eid):
    """-> (results, ambiguous). results: one dict per estimate schedule."""
    ambiguous, results = [], []
    by_est = _assign_invoices(d, ambiguous, eid)
    for k, sched in d["scheds"].items():
        est = d["estimates"].get(k)
        invs = by_est.get(k, [])
        if not est or not est["accepted"]:
            continue  # not shown on the Billing tab
        cls, rows, sch, note = _plan_schedule(sched, est, invs)
        ops = _diff(sched, rows)
        if cls == "ambiguous":
            ambiguous.append(("edited_conflict", eid, {"est": est, "invs": invs, "ms": sched["ms"]}))
        if note == "over-billed":
            ambiguous.append(("overbilled", eid, {"est": est, "invs": invs}))
        ub = _unbilled_balance(rows if rows is not None else sched["ms"], invs, d.get("status"))
        if ub:
            ambiguous.append(("unbilled_balance", eid, {"est": est, "invs": invs, **ub}))
        results.append({"entity_id": eid, "project": d["name"], "schedule_id": sched["id"],
                        "estimate_qbo_id": k, "doc": est["doc"], "value": est["value"],
                        "invoices": len(invs), "cls": cls, "ops": ops,
                        "sched_changes": sch if ops or sch else {}})
    for c in d["credits"]:
        ambiguous.append(("credit_memo", eid, {"cm": c}))
    return results, ambiguous


# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------
def _apply(conn, res, run_id):
    """Write one estimate's ops. Returns audit entries to record after commit."""
    sid = res["schedule_id"]
    audits = []
    before = [dict((k, _norm(k, v) if k in _FIELDS else v) for k, v in m.items())
              for m in conn.execute(text("""
                  SELECT id, seq, label, pct, invoice_date, due_date, expected_paid_date, amount,
                         status, note, edited, amount_edited, qbo_invoice_id
                  FROM project_invoice_milestones WHERE schedule_id=:s ORDER BY seq, id"""),
                  {"s": sid}).mappings()]
    common = {"entity_id": res["entity_id"], "project": res["project"], "estimate_doc": res["doc"],
              "via": "align", "run_id": run_id}
    for op in res["ops"]:
        if op["op"] == "update":
            sets = ", ".join(f"{f} = :{f}" for f in op["changes"])
            params = {f: v[1] for f, v in op["changes"].items()}
            conn.execute(text(f"UPDATE project_invoice_milestones SET {sets}, aligned_at = NOW() WHERE id = :id"),
                         {**params, "id": op["id"]})
            audits.append(("billing.milestone_align", op["id"], op["label"], {**common, "changes": op["changes"]}))
        elif op["op"] == "insert":
            r = op["row"]
            new_id = conn.execute(text("""
                INSERT INTO project_invoice_milestones
                  (schedule_id, seq, label, pct, invoice_date, due_date, expected_paid_date, amount,
                   status, qbo_invoice_id, edited, aligned_at)
                VALUES (:s, :seq, :label, :pct, :invoice_date, :due_date, :expected_paid_date, :amount,
                        :status, :qbo_invoice_id, 0, NOW())
            """), {"s": sid, **r}).lastrowid
            audits.append(("billing.milestone_align_add", new_id, r["label"], {**common, "after": r}))
        else:
            conn.execute(text("DELETE FROM project_invoice_milestones WHERE id = :id"), {"id": op["id"]})
            audits.append(("billing.milestone_align_delete", op["id"], op["label"], {**common, "deleted": op["row"]}))
    if res["sched_changes"]:
        sets = ", ".join(f"{f} = :{f}" for f in res["sched_changes"])
        conn.execute(text(f"UPDATE project_invoice_schedules SET {sets} WHERE id = :id"),
                     {**{f: v[1] for f, v in res["sched_changes"].items()}, "id": sid})
    # 0087: a row that IS an invoice follows it; one whose invoice went away is
    # app-dated again (billing/invoice_dates.py re-places it from the job dates)
    conn.execute(text("""UPDATE project_invoice_milestones SET date_basis = 'invoice'
                         WHERE schedule_id = :s AND qbo_invoice_id IS NOT NULL"""), {"s": sid})
    conn.execute(text("""UPDATE project_invoice_milestones SET date_basis = 'auto_history'
                         WHERE schedule_id = :s AND qbo_invoice_id IS NULL
                           AND (date_basis IS NULL OR date_basis = 'invoice')"""), {"s": sid})
    # bump updated_at so cash-flow / tracker caches see delete-only changes too
    conn.execute(text("UPDATE project_invoice_milestones SET updated_at = CURRENT_TIMESTAMP WHERE schedule_id = :s"),
                 {"s": sid})
    after = [dict((k, _norm(k, v) if k in _FIELDS else v) for k, v in m.items())
             for m in conn.execute(text("""
                 SELECT id, seq, label, pct, invoice_date, due_date, expected_paid_date, amount,
                        status, note, edited, amount_edited, qbo_invoice_id
                 FROM project_invoice_milestones WHERE schedule_id=:s ORDER BY seq, id"""),
                 {"s": sid}).mappings()]
    audits.insert(0, ("billing.schedule_align", None, f"Estimate #{res['doc']}", {
        **common, "schedule_id": sid, "estimate_qbo_id": res["estimate_qbo_id"], "class": res["cls"],
        "schedule_changes": res["sched_changes"], "before": before, "after": after}))
    return audits


def _record(audits):
    for action, tid, label, det in audits:
        if action == "billing.schedule_align":
            record_audit(SYSTEM_ACTOR, action, "project", det["entity_id"], label, det)
        else:
            record_audit(SYSTEM_ACTOR, action, "invoice_milestone", tid, label, det)


def align_project(conn, entity_id, run_id=None):
    """Cheap per-project path (Billing tab open). Writes inside `conn`'s
    transaction; returns the audit entries — call record_alignment(audits)
    after the transaction commits."""
    d = _load(conn, [entity_id]).get(str(entity_id))
    if not d or not d["scheds"]:
        return []
    results, _ = plan_project(d, str(entity_id))
    audits = []
    run_id = run_id or f"tab-{uuid.uuid4().hex[:8]}"
    for res in results:
        if res["ops"] or res["sched_changes"]:
            audits += _apply(conn, res, run_id)
    return audits


def record_alignment(audits):
    _record(audits or [])


def _ensure_schedules(entity_id):
    """Billing & Schedule's create-if-missing steps (billing headers + one
    invoice schedule per accepted estimate). Lazy import: routes imports us."""
    from app.billing import routes as B
    try:
        with engine.begin() as conn:
            ctx = B._project_ctx(conn, entity_id)
            if not ctx:
                return
            meta = B._project_meta(conn, entity_id) or {}
            B._ensure_estimate_billing(conn, entity_id, B._default_crew_for_project(conn, entity_id, meta))
            B._apply_assignment_default_crew(conn, entity_id)
            B._ensure_invoice_schedules(conn, entity_id, ctx)
    except Exception:
        pass


def _all_entity_ids(conn):
    return [str(r[0]) for r in conn.execute(text(
        "SELECT DISTINCT entity_id FROM project_invoice_schedules WHERE estimate_qbo_id IS NOT NULL")).all()]


def run(apply=False, project=None, triggered_by="cli"):
    """Plan (and optionally apply) alignment for all projects (or one)."""
    run_id = f"{triggered_by}-{datetime.now().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:4]}"
    with engine.connect() as conn:
        ids = [str(project)] if project else _all_entity_ids(conn)
        data = _load(conn, ids)
    foreign = data.pop("_foreign_est", {})
    results, amb = [], []
    for eid in ids:
        if eid in data:
            r, a = plan_project(data[eid], eid)
            results += r
            amb += a
    applied = 0
    if apply:
        # accepted estimates that are already billed but have no schedule yet:
        # create it exactly as opening the Billing tab would, then align it too.
        setup = sorted({eid for typ, eid, x in amb if typ == "invoice_other_estimate" and x.get("why") == "no_schedule"})
        if setup:
            for eid in setup:
                _ensure_schedules(eid)
            with engine.connect() as conn:
                more = _load(conn, setup)
            more.pop("_foreign_est", None)
            results = [r for r in results if r["entity_id"] not in setup]
            amb = [a for a in amb if a[1] not in setup]
            for eid in setup:
                data[eid] = more[eid]
                r, a2 = plan_project(more[eid], eid)
                results += r
                amb += a2
        for res in results:
            if not (res["ops"] or res["sched_changes"]):
                continue
            with engine.begin() as conn:
                audits = _apply(conn, res, run_id)
            _record(audits)
            applied += 1
    counts = {}
    for res in results:
        key = res["cls"]
        counts.setdefault(key, {"estimates": 0, "changed": 0})
        counts[key]["estimates"] += 1
        counts[key]["changed"] += 1 if (res["ops"] or res["sched_changes"]) else 0
    return {"run_id": run_id, "applied": apply, "applied_schedules": applied, "counts": counts,
            "results": results, "ambiguous": amb, "foreign": foreign, "names": {e: data[e]["name"] for e in data}}


def run_after_sync():
    """Best-effort hook for qbo.service.run_transactions_sync."""
    try:
        r = run(apply=True, triggered_by="sync")
        return {"applied_schedules": r["applied_schedules"], "counts": r["counts"]}
    except Exception as e:  # never fail the sync
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Data Review items (same shape as gsync.review._item, category 'billing')
# ---------------------------------------------------------------------------
def _item(typ, key, sev, title, detail, *, fix=None, link=None, app=None, qbo=None, ref=None, fp=None):
    return {"key": f"billing:{typ}:{key}", "category": "billing", "type": typ, "severity": sev,
            "title": title, "detail": detail, "fix": fix, "link": link, "sheet": None, "app": app,
            "qbo": qbo, "ref": ref, "fingerprint": fp or _fp(None, app, qbo)}


def _md(s):
    if not s:
        return "—"
    d = date.fromisoformat(str(s)[:10])
    return f"{d.month}/{d.day}/{str(d.year)[2:]}"


def _to_items(amb, names, foreign):
    out = []
    for typ, eid, x in amb:
        name = names.get(eid) or eid
        link = f"#/entity/project/{eid}"
        ref = {"entity_id": eid}
        if typ in ("invoice_unlinked", "invoice_other_estimate", "invoice_multi_estimate"):
            inv = x["inv"]
            what = f"Invoice #{inv['doc']} ({_money(inv['amount'])}, {_md(inv['txn_date'])})"
            if typ == "invoice_unlinked":
                title = f"{name}: {what} isn't linked to an estimate"
                detail = (f"The project has {x['n_est']} accepted estimates, so the app can't tell which "
                          f"schedule this invoice pays down. It stays out of the schedule alignment.")
                fix = "In QuickBooks, create the invoice from (or link it to) the right estimate."
                sev = "medium"
            elif typ == "invoice_other_estimate":
                f, e, why = foreign.get(x["est"]), x.get("e"), x.get("why")
                sev = "medium"
                if why == "no_schedule":
                    title = f"{name}: {what} bills estimate #{e['doc']}, which has no invoice schedule yet"
                    detail = ("The estimate is accepted in QuickBooks but its schedule hasn't been created; "
                              "opening Billing & Schedule (or the next sync) creates and aligns it.")
                    fix = "Open the project's Billing & Schedule tab."
                    sev = "low"
                elif why == "not_accepted":
                    title = f"{name}: {what} bills estimate #{e['doc']}, which is {e['status'] or 'not accepted'} in QuickBooks"
                    detail = "Only accepted estimates get an invoice schedule, so this invoice isn't on any schedule."
                    fix = "Mark the estimate Accepted in QuickBooks (or re-link the invoice)."
                else:
                    where = (f"estimate #{f['doc_number']} on {f['display_name'] or f['customer_qbo_id']}"
                             if f else f"estimate qbo id {x['est']}, which isn't in the app")
                    title = f"{name}: {what} is linked to {where}"
                    detail = "The linked estimate belongs to another customer/project, so the invoice can't be aligned."
                    fix = "Move the estimate (or the invoice) to the same project in QuickBooks."
            else:
                title = f"{name}: {what} is linked to several estimates"
                detail = f"Linked estimates (qbo ids): {', '.join(x['ests'])}. Not aligned automatically."
                fix = "Split the invoice per estimate in QuickBooks, or adjust the schedules by hand."
                sev = "low"
            out.append(_item(typ, inv["qbo_id"], sev, title, detail, fix=fix, link=link,
                             qbo=[inv["doc"], inv["amount"], x.get("est") or x.get("ests")], ref=ref))
        elif typ == "overbilled":
            est, invs = x["est"], x["invs"]
            tot = round(sum(i["amount"] for i in invs), 2)
            over = round(tot - est["value"], 2)
            sev = "high" if est["value"] and over > 0.1 * est["value"] else "medium"
            out.append(_item(typ, f"{eid}:{est['qbo_id']}", sev,
                             f"{name}: invoices exceed estimate #{est['doc']} by {_money(over)}",
                             f"{len(invs)} invoice(s) total {_money(tot)} vs the estimate's {_money(est['value'])}. "
                             f"Likely a change order billed on this estimate.",
                             fix="Raise the estimate (or add a change-order estimate) in QuickBooks.",
                             link=link, qbo=[tot, est["value"]], ref={**ref, "estimate_qbo_id": est["qbo_id"]}))
        elif typ == "edited_conflict":
            est, invs = x["est"], x["invs"]
            out.append(_item(typ, f"{eid}:{est['qbo_id']}", "medium",
                             f"{name}: estimate #{est['doc']} invoices don't fit the hand-edited schedule",
                             f"Actual invoices {', '.join('#' + str(i['doc']) + ' ' + _money(i['amount']) for i in invs)} "
                             f"don't match the planned milestones, and some milestones were edited by hand, so the "
                             f"schedule wasn't rewritten automatically.",
                             fix="Open Billing & Schedule and adjust the milestones to the actual invoices.",
                             link=link, app=[[m["label"], _r2(m["amount"])] for m in x["ms"]],
                             qbo=[[i["doc"], i["amount"]] for i in invs],
                             ref={**ref, "estimate_qbo_id": est["qbo_id"]}))
        elif typ == "unbilled_balance":
            est, why = x["est"], x["why"]
            when = {"past": f"was planned for {_md(x['date'])} and hasn't been invoiced",
                    "completed": (f"is planned for {_md(x['date'])} but the project is completed" if x["date"]
                                  else "has no invoice date and the project is completed"),
                    "no_date": "has no invoice date",
                    "soon": f"is planned for {_md(x['date'])}"}[why]
            sev = "high" if why in ("past", "completed") else "medium"
            labels = ", ".join(dict.fromkeys(l or "Balance to bill" for l in x["labels"]))
            out.append(_item(typ, f"{eid}:{est['qbo_id']}", sev,
                             f"{name}: {_money(x['balance'])} left to bill on estimate #{est['doc']}",
                             f"Partly billed: {len(x['invs'])} invoice(s) total {_money(x['invoiced'])} of the "
                             f"estimate's {_money(est['value'])}. The remaining {_money(x['balance'])} ({labels}) {when}.",
                             fix=("Send the final invoice in QuickBooks — or, if the job closed short, "
                                  "reduce the estimate so the schedule matches what was billed."
                                  if why in ("past", "completed") else
                                  "Plan the final invoice: set its date on the project's Billing tab."),
                             link=f"{link}?tab=billing", app=[x["balance"], x["date"]],
                             qbo=[x["invoiced"], est["value"]],
                             ref={**ref, "estimate_qbo_id": est["qbo_id"], "amount": x["balance"],
                                  "date": x["date"], "why": why}))
        elif typ == "credit_memo":
            cm = x["cm"]
            out.append(_item(typ, cm["qbo_id"], "low",
                             f"{name}: credit memo #{cm['doc']} ({_money(cm['amount'])}, {_md(cm['date'])})",
                             "Credit memos reduce what's collected but aren't part of the invoice schedule; "
                             "check the estimate/schedule reflects the credit.",
                             fix="Review the schedule; adjust the remaining milestone if the credit reduces the contract.",
                             link=link, qbo=[cm["doc"], cm["amount"]], ref=ref))
    return out


def ambiguous_items(conn=None):
    """Billing items for Data Review (category 'billing'). Read-only."""
    if conn is None:
        with engine.connect() as c:
            return ambiguous_items(c)
    ids = _all_entity_ids(conn)
    data = _load(conn, ids)
    foreign = data.pop("_foreign_est", {})
    amb = []
    for eid in ids:
        if eid in data:
            amb += plan_project(data[eid], eid)[1]
    return (_to_items(amb, {e: data[e]["name"] for e in data}, foreign)
            + retainage_items(conn, {e: data[e].get("status") for e in data}))


def retainage_items(conn, statuses=None):
    """One Data Review item per project holding retainage (type 'retainage_held'):
    every held invoice with its amount and how long it's been held, so the
    office can chase the release. Low priority while the job is running;
    medium once it's completed; high when completed and held over 60 days."""
    held = RET.held(conn)
    by = {}
    for h in held:
        by.setdefault(h["entity_id"], []).append(h)
    statuses = dict(statuses or {})
    missing = [e for e in by if e not in statuses]
    if missing:
        d = _load(conn, missing)
        d.pop("_foreign_est", None)
        statuses.update({e: v.get("status") for e, v in d.items()})
    rel = RET.release_dates(conn, list(by))
    out = []
    for eid, hs in by.items():
        total = round(sum(h["held"] for h in hs), 2)
        oldest = max((h["age_days"] or 0) for h in hs)
        done = statuses.get(eid) == "completed"
        sev = ("high" if oldest > 60 else "medium") if done else "low"
        name = hs[0]["project"] or eid
        lst = "; ".join(f"#{h['doc']} {_money(h['held'])} of {_money(h['amount'])} ({h['pct']:g}%), "
                        f"held {h['age_days']}d" if h["age_days"] is not None else
                        f"#{h['doc']} {_money(h['held'])} of {_money(h['amount'])} ({h['pct']:g}%)" for h in hs)
        r = rel.get(eid)
        when = (f"Release expected around {_md(r)} (project end + {RET.RELEASE_DAYS} days)." if r
                else "No assignment end date, so no expected release date.")
        out.append(_item("retainage_held", eid, sev,
                         f"{name}: {_money(total)} retainage held on {len(hs)} invoice(s)",
                         f"Paid except a held-back portion: {lst}. {when} "
                         f"{'The project is completed — request the release.' if done else 'Expected after the final invoice; not overdue A/R.'}",
                         fix=("Ask the customer to release the retainage (send the release / final pay application)."
                              if done else "Nothing to do until the job is done — then request the release."),
                         link=f"#/entity/project/{eid}?tab=billing",
                         qbo=[[h["doc"], h["amount"], h["held"]] for h in hs],
                         ref={"entity_id": eid, "held": total, "oldest_days": oldest,
                              "invoices": [h["doc"] for h in hs]},
                         fp=_fp("retainage", [[h["doc"], h["held"]] for h in hs], done)))
    return out


# ---------------------------------------------------------------------------
# Undo
# ---------------------------------------------------------------------------
def undo(run_id):
    """Restore every schedule a run touched to its 'before' snapshot."""
    n = 0
    with engine.begin() as conn:
        rows = conn.execute(text("""
            SELECT detail FROM audit_log WHERE action = 'billing.schedule_align'
              AND JSON_UNQUOTE(JSON_EXTRACT(detail, '$.run_id')) = :r ORDER BY id DESC
        """), {"r": run_id}).scalars().all()
        for raw in rows:
            det = json.loads(raw)
            sid = det["schedule_id"]
            conn.execute(text("DELETE FROM project_invoice_milestones WHERE schedule_id = :s"), {"s": sid})
            for m in det["before"]:
                conn.execute(text("""
                    INSERT INTO project_invoice_milestones
                      (id, schedule_id, seq, label, pct, invoice_date, due_date, expected_paid_date,
                       amount, status, note, edited, amount_edited, qbo_invoice_id)
                    VALUES (:id, :s, :seq, :label, :pct, :invoice_date, :due_date, :expected_paid_date,
                            :amount, :status, :note, :edited, :amount_edited, :qbo_invoice_id)
                """), {**{k: m.get(k) for k in ("id", "seq", "label", "pct", "invoice_date", "due_date",
                                                "expected_paid_date", "amount", "status", "note", "edited",
                                                "qbo_invoice_id")},
                       "amount_edited": m.get("amount_edited", m.get("edited") or 0), "s": sid})
            for f, (old, _new) in (det.get("schedule_changes") or {}).items():
                conn.execute(text(f"UPDATE project_invoice_schedules SET {f} = :v WHERE id = :s"),
                             {"v": old, "s": sid})
            n += 1
    record_audit(SYSTEM_ACTOR, "billing.align_undo", None, None, run_id, {"schedules": n})
    return n


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _fmt_op(op):
    if op["op"] == "update":
        return f"      ~ #{op['id']} {op['label']}: " + "; ".join(f"{f} {a}→{b}" for f, (a, b) in op["changes"].items())
    if op["op"] == "insert":
        r = op["row"]
        return f"      + {r['label']} ${r['amount']:,.2f} inv {r['invoice_date']} due {r['due_date']} [{r['status']}]"
    r = op["row"]
    return f"      - #{op['id']} {op['label']} ${(r['amount'] or 0):,.2f}"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Align invoice schedules to actual QBO invoices.")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--project")
    ap.add_argument("--undo")
    ap.add_argument("--verbose", "-v", action="store_true", help="list every planned change")
    a = ap.parse_args(argv)
    if a.undo:
        print(f"restored {undo(a.undo)} schedule(s) from run {a.undo}")
        return
    r = run(apply=a.apply, project=a.project)
    print(f"run {r['run_id']} — {'APPLIED' if a.apply else 'DRY RUN'}")
    for cls in ("matched", "restructured", "left_alone", "ambiguous"):
        c = r["counts"].get(cls, {"estimates": 0, "changed": 0})
        print(f"  {cls:13s} {c['estimates']:4d} estimates  ({c['changed']} with changes)")
    if a.apply:
        print(f"  applied to {r['applied_schedules']} schedule(s)")
    show = r["results"] if (a.verbose or a.project) else []
    for res in show:
        if res["ops"] or res["sched_changes"] or a.project:
            print(f"  [{res['cls']}] {res['project']} — est #{res['doc']} ${res['value']:,.2f} "
                  f"({res['invoices']} inv) sched {res['schedule_id']} {res['sched_changes'] or ''}")
            for op in res["ops"]:
                print(_fmt_op(op))
    items = _to_items(r["ambiguous"], r["names"], r["foreign"])
    with engine.connect() as conn:
        items += retainage_items(conn) if not a.project else [
            i for i in retainage_items(conn) if i["ref"]["entity_id"] == str(a.project)]
    by = {}
    for it in items:
        by.setdefault(it["type"], []).append(it)
    print(f"ambiguous / review items: {len(items)}")
    for typ, its in sorted(by.items()):
        print(f"  {typ}: {len(its)}")
        for it in its[: (1000 if a.verbose else 15)]:
            print(f"    [{it['severity']}] {it['title']}")


if __name__ == "__main__":
    main()
