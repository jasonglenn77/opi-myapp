"""
Data Review — category "sources": where each number on OPI's B250 cash-flow
sheet comes from, and whether QuickBooks (or the crew Payment Schedules) back
it up. The app's Cash Flow page sources everything it can from QBO and the
Payment Schedules; where no system of record exists yet it keeps the B250's
value (owner decision 2026-10-27) and those lines are listed here as
"unsourced". Reads only the database: the latest gsync_b250_snapshot (b250_cash.py),
the QBO mirror, cashflow_overhead and the crew payment schedules.

Types
  b250_missing           no B250 copy loaded yet (share it with the service account or upload it)
  bank_opening           B250 opening cash vs the QBO bank accounts chosen on Cash Flow
  bank_duplicate         two QBO bank accounts with the same bank number
  undeposited            customer payments sitting in "Payments to deposit"
  unsourced_overhead     a Cash Flow overhead line copied from the B250 (no QBO record)
  unsourced_vendor       B250 A/P placeholder for weeks 5-13 vs the vendor's QBO bills
  unsourced_forecast_inv B250 dealer "Forecasted Invoices" (no project behind them)
  unsourced_operating    B250 taxes/insurance, professional fees vs QBO postings
  ar_paid_or_missing     invoice on the B250 that QBO shows paid / doesn't have
  ar_amount              B250 invoice amount differs from the QBO open balance
  ar_not_on_b250         open QBO invoice (< 90 days) the B250 doesn't list
  ar_stale               open QBO invoice > 90 days old, not on the B250 or SnapShot
  ar_duplicate           same customer, amount and date invoiced twice in QBO
  crew_vs_schedule       B250 crew payday amounts differ from the Payment Schedules
  crew_unmapped          B250 crew row the app can't tie to a crew company
  crew_total             B250 contractors total vs Payment Schedules total
  books_rent_missing / books_rent_payee / books_vendor_gap / books_account_stopped /
  books_wip / books_owner_account   QuickBooks bookkeeping gaps
  b250_monthly_revenue / b250_monthly_bookings   MonthlyYearly Totals vs QBO
  sheet_formula          a B250 total formula that skips typed rows
"""
import collections
import re
from datetime import date, timedelta

from sqlalchemy import text

from .review import _item, _money, _md

CAT = "sources"
HIGH = 25000
FIX_B250 = "Correct the B250 (or tell us which side is right)."


def _sev(amount, hi=HIGH):
    return "high" if abs(amount or 0) >= hi else "medium"


def _m(d):
    return d.strftime("%b %Y")


def _months_back(today, n):
    """First days of the last n complete months, oldest first."""
    out, y, m = [], today.year, today.month
    for _ in range(n):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        out.append(date(y, m, 1))
    return out[::-1]


def _has(conn, entity):
    return bool(conn.execute(text("SELECT 1 FROM qbo_transactions WHERE entity_type = :e LIMIT 1"), {"e": entity}).first())


def _snapshot(conn):
    try:
        snap = conn.execute(text("SELECT * FROM gsync_b250_snapshot ORDER BY id DESC LIMIT 1")).mappings().first()
    except Exception:
        return None, []
    if not snap:
        return None, []
    lines = [dict(r) for r in conn.execute(text(
        "SELECT * FROM gsync_b250_lines WHERE snapshot_id = :s ORDER BY row_num, col"), {"s": snap["id"]}).mappings()]
    for ln in lines:
        ln["amount"] = float(ln["amount"]) if ln["amount"] is not None else None
    return dict(snap), lines


def _src(snap):
    return f"B250 tab \"{snap['tab_name']}\" (week 1 ending {_md(snap['week1_end'])})"


# ── bank ─────────────────────────────────────────────────────────────────────

def bank_items(conn, snap, lines):
    out = []
    from app.cashflow.service import get_bank_balance
    bank = get_bank_balance()
    accts = bank.get("accounts") or []
    inc = [a for a in accts if a["included"]]
    qbo_bal = round(sum(a["balance"] for a in inc), 2)
    opening = next((ln["amount"] for ln in lines if ln["section"] == "opening"), None)
    if opening is not None:
        diff = qbo_bal - opening
        if abs(diff) > 5000:
            each = "; ".join(f"{a['name']} {_money(a['balance'])}{'' if a['included'] else ' (not counted)'}" for a in accts)
            close = [a["name"] for a in accts if abs(a["balance"] - opening) <= 5000]
            out.append(_item(CAT, "bank_opening", "opening", "high",
                             f"Opening cash: B250 {_money(opening)} vs QuickBooks {_money(qbo_bal)} ({'+' if diff > 0 else '−'}{_money(abs(diff))})",
                             f"{_src(snap)} starts week 1 with {_money(opening)}, typed by hand (no formula). QuickBooks bank accounts: {each}. "
                             + (f"Matches {', '.join(close)} alone." if close else "No QuickBooks bank account or combination of the counted ones equals it.")
                             + " The QuickBooks book balance also differs from the bank when payments are still in \"Payments to deposit\".",
                             fix="Tell us which bank account(s) the B250 opening balance is; merge or close the duplicate account in QuickBooks; then pick the right accounts on the Cash Flow page.",
                             sheet=opening, qbo=qbo_bal, link="#/cashflow"))
    for w in bank.get("warnings") or []:
        out.append(_item(CAT, "bank_duplicate", w["key"], "high",
                         f"Two QuickBooks bank accounts share bank number {w['key']}: {' and '.join(w['accounts'])}",
                         f"Counted on Cash Flow: {', '.join(w['included']) or 'none'}. If both are the same real account the cash is double-counted; "
                         "if one is a leftover from a bank-feed reconnect, its balance is wrong.",
                         fix="Merge or make inactive the duplicate in QuickBooks; keep only the real account counted on Cash Flow.",
                         qbo=sorted(w["accounts"]), link="#/cashflow"))
    # undeposited funds
    for r in conn.execute(text("""SELECT qbo_id, name, current_balance FROM qbo_accounts
            WHERE account_sub_type = 'UndepositedFunds' AND COALESCE(current_balance, 0) <> 0""")).mappings():
        bal = float(r["current_balance"] or 0)
        if _has(conn, "Deposit"):
            deposited = set()
            for (raw,) in conn.execute(text("SELECT raw_json FROM qbo_transactions WHERE entity_type = 'Deposit'")):
                import json
                d = raw if isinstance(raw, dict) else json.loads(raw)
                for ln in d.get("Line") or []:
                    for lt in ln.get("LinkedTxn") or []:
                        if lt.get("TxnType") == "Payment":
                            deposited.add(str(lt.get("TxnId")))
            pays = conn.execute(text("""SELECT qbo_id, txn_date, total_amt FROM qbo_transactions
                WHERE entity_type = 'Payment' AND raw_json->>'$.DepositToAccountRef.value' = :a
                  AND txn_date < :cut AND total_amt > 0"""), {"a": r["qbo_id"], "cut": date.today() - timedelta(days=3)}).all()
            und = [p for p in pays if str(p[0]) not in deposited]
            amt = sum(float(p[2]) for p in und)
            recent = [p for p in und if p[1] >= date.today() - timedelta(days=60)]
            detail = (f"{len(und)} customer payments recorded more than 3 days ago were never put on a QuickBooks deposit "
                      f"({_money(amt)}; {len(recent)} of them in the last 60 days, {_money(sum(float(p[2]) for p in recent))}). "
                      f"Oldest {_md(min(p[1] for p in und)) if und else '—'}. Account balance {_money(bal)}.")
        else:
            amt = bal
            detail = (f"QuickBooks shows {_money(bal)} in \"{r['name']}\" — customer payments recorded but never deposited in QuickBooks "
                      "(or deposited with a separate entry, which counts the cash twice). Which payments: not yet synced "
                      "(QuickBooks deposits start mirroring with the next QuickBooks sync).")
        out.append(_item(CAT, "undeposited", str(r["qbo_id"]), _sev(amt),
                         f"{_money(amt)} of customer payments not deposited in QuickBooks", detail,
                         fix="In QuickBooks, match each bank deposit to its received payments (Bank Deposit → select the payments) so the book balance equals the bank.",
                         qbo=round(amt, 2)))
    return out


# ── unsourced values ─────────────────────────────────────────────────────────

_PER_MONTH = {"weekly": 52 / 12, "biweekly": 26 / 12, "semimonthly": 2, "monthly": 1, "quarterly": 1 / 3, "annual": 1 / 12}


def _vendor_bills(conn, pattern, since):
    return conn.execute(text("""SELECT DATE_FORMAT(txn_date, '%Y-%m-01') m, SUM(total_amt) FROM qbo_transactions
        WHERE entity_type = 'Bill' AND txn_date >= :s AND LOWER(raw_json->>'$.VendorRef.name') LIKE :p GROUP BY m ORDER BY m"""),
        {"s": since, "p": pattern}).all()


def _card_spend(conn, since):
    return conn.execute(text("""SELECT COALESCE(SUM(CASE WHEN t.raw_json->>'$.Credit' = 'true' THEN -t.total_amt ELSE t.total_amt END), 0)
        FROM qbo_transactions t JOIN qbo_accounts a ON a.qbo_id = t.raw_json->>'$.AccountRef.value' AND a.account_type = 'Credit Card'
        WHERE t.entity_type = 'Purchase' AND t.txn_date >= :s"""), {"s": since}).scalar() or 0


def _card_evidence(conn, today):
    since = today - timedelta(weeks=13)
    # How card bills actually get paid in QBO: CreditCardPayment, a Transfer to
    # the card account, or a journal entry against it. OPI's books (10/2026)
    # show none of the first two since 2023 — card activity reaches QBO only as
    # month-end journal entries — so say that rather than report "$0/week".
    paid = conn.execute(text("""SELECT
          (SELECT COALESCE(SUM(total_amt), 0) FROM qbo_transactions
             WHERE entity_type = 'CreditCardPayment' AND txn_date >= :s)
        + (SELECT COALESCE(SUM(t.total_amt), 0) FROM qbo_transactions t
             JOIN qbo_accounts a ON a.qbo_id = t.raw_json->>'$.ToAccountRef.value' AND a.account_type = 'Credit Card'
             WHERE t.entity_type = 'Transfer' AND t.txn_date >= :s)"""), {"s": since}).scalar() or 0
    if (_has(conn, "CreditCardPayment") or _has(conn, "Transfer")) and float(paid) == 0:
        je = conn.execute(text("""SELECT MAX(t.txn_date), SUM(l.amount) FROM qbo_transactions t
            JOIN qbo_transaction_lines l ON l.transaction_id = t.id
            JOIN qbo_accounts a ON a.qbo_id = l.account_qbo_id AND a.account_type = 'Credit Card'
            WHERE t.entity_type = 'JournalEntry'
              AND t.txn_date = (SELECT MAX(t2.txn_date) FROM qbo_transactions t2
                  JOIN qbo_transaction_lines l2 ON l2.transaction_id = t2.id
                  JOIN qbo_accounts a2 ON a2.qbo_id = l2.account_qbo_id AND a2.account_type = 'Credit Card'
                  WHERE t2.entity_type = 'JournalEntry')""")).first()
        spend = float(_card_spend(conn, since))
        last_je = f" The last journal entry against the card accounts was on {_md(je[0])} ({_money(je[1])})." if je and je[0] else ""
        return spend / 13, (f"QuickBooks records no payments to the card accounts in the last 13 weeks (no card payments "
                            f"or transfers), so the card payoff can't be sourced from QuickBooks.{last_je} "
                            f"Categorized card spending, last 13 weeks ≈ {_money(spend / 13)}/week. "
                            f"Needs Chase statement balances and due dates, or card payments recorded in QuickBooks.")
    if _has(conn, "CreditCardPayment"):
        tot = conn.execute(text("""SELECT COALESCE(SUM(total_amt), 0), COUNT(*) FROM qbo_transactions
            WHERE entity_type = 'CreditCardPayment' AND txn_date >= :s"""), {"s": since}).first()
        return float(tot[0]) / 13, f"QuickBooks card payments, last 13 weeks: {_money(tot[0])} in {tot[1]} payments ≈ {_money(float(tot[0]) / 13)}/week"
    if _has(conn, "Transfer"):
        tot = conn.execute(text("""SELECT COALESCE(SUM(t.total_amt), 0), COUNT(*) FROM qbo_transactions t
            JOIN qbo_accounts a ON a.qbo_id = t.raw_json->>'$.ToAccountRef.value' AND a.account_type = 'Credit Card'
            WHERE t.entity_type = 'Transfer' AND t.txn_date >= :s"""), {"s": since}).first()
        return float(tot[0]) / 13, f"QuickBooks transfers to card accounts, last 13 weeks: {_money(tot[0])} ≈ {_money(float(tot[0]) / 13)}/week"
    tot = conn.execute(text("""SELECT COALESCE(SUM(CASE WHEN t.raw_json->>'$.Credit' = 'true' THEN -t.total_amt ELSE t.total_amt END), 0)
        FROM qbo_transactions t JOIN qbo_accounts a ON a.qbo_id = t.raw_json->>'$.AccountRef.value' AND a.account_type = 'Credit Card'
        WHERE t.entity_type = 'Purchase' AND t.txn_date >= :s"""), {"s": since}).scalar()
    return float(tot or 0) / 13, (f"Card payments not yet synced from QuickBooks; categorized card spending, last 13 weeks ≈ "
                                  f"{_money(float(tot or 0) / 13)}/week (card accounts aren't reconciled, so this is a floor)")


def unsourced_items(conn, snap, lines, today):
    out = []
    cols = {r[0] for r in conn.execute(text("""SELECT column_name FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'cashflow_overhead'"""))}
    if "source" in cols:
        rows = conn.execute(text("""SELECT id, name, amount, cadence, anchor_date, source_note FROM cashflow_overhead
            WHERE deleted_at IS NULL AND active = 1 AND source = 'b250'""")).mappings().all()
    else:
        rows = conn.execute(text("""SELECT id, name, amount, cadence, anchor_date, NULL source_note FROM cashflow_overhead
            WHERE deleted_at IS NULL AND active = 1 AND (name LIKE '%W-2%' OR name LIKE '%Bonus%' OR name LIKE '%Hotel Engine%'
              OR name LIKE '%credit card%')""")).mappings().all()
    m3 = _months_back(today, 3)
    for r in rows:
        name, amt = r["name"], float(r["amount"] or 0)
        per_m = amt * _PER_MONTH.get(r["cadence"], 1)
        low = name.lower()
        qbo = None
        if "hotel engine" in low:
            bills = dict((m, float(v)) for m, v in _vendor_bills(conn, "%hotel engine%", m3[0]))
            vals = [bills.get(str(m), 0.0) for m in m3]
            qbo = round(sum(vals) / 3, 2)
            ev = ("QuickBooks Hotel Engine bills: " + ", ".join(f"{_m(m)} {_money(v)}" for m, v in zip(m3, vals))
                  + f" — average {_money(qbo)}/month. Lodging is also in the project expense plans, so this line may count some of it twice.")
        elif "card" in low:
            wk, ev = _card_evidence(conn, today)
            qbo = round(wk, 2)
        elif "w-2" in low:
            ev = "No QuickBooks record: W-2 payroll runs in QuickBooks Payroll / the payroll provider, which the QuickBooks connection can't read."
        elif "bonus" in low or "commission" in low:
            ev = ("No QuickBooks record: no account carries bonuses or commissions (a couple of one-off bonuses were booked "
                  "to other accounts); they'd come from the payroll register and the commission plan.")
        else:
            ev = r["source_note"] or "No QuickBooks record found."
        out.append(_item(CAT, "unsourced_overhead", str(r["id"]), "medium",
                         f"Unsourced (from B250): {name} {_money(amt)} {r['cadence']}",
                         f"The Cash Flow forecast uses the B250's {_money(amt)} {r['cadence']} (≈ {_money(per_m)}/month) from {_md(r['anchor_date'])}. {ev}",
                         fix="Give us the real source (payroll register, card statements, …) — until then the app keeps the B250 value.",
                         sheet=amt, qbo=qbo, link="#/cashflow"))
    if not snap:
        return out
    w5 = snap["week1_end"] + timedelta(days=28)
    since13 = today - timedelta(weeks=13)
    ap = collections.defaultdict(list)
    for ln in lines:
        if ln["section"] == "ap" and ln["week_end"] and ln["week_end"] >= w5 and ln["amount"]:
            ap[ln["label"]].append(ln["amount"])
    for vendor, vals in sorted(ap.items()):
        low = vendor.lower()
        if "hotel engine" in low or "credit card" in low:
            continue                                  # listed with the overhead lines above
        b_wk = sum(vals) / 9
        tok = re.sub(r"[^a-z0-9 ]", " ", low).split()
        tok = next((t for t in tok if len(t) > 2 and t not in ("inc", "the", "misc")), None)
        if not tok:
            qbo_wk, ev = None, "Catch-all line; no single QuickBooks vendor."
        else:
            tot = conn.execute(text("""SELECT COALESCE(SUM(total_amt), 0), COUNT(*) FROM qbo_transactions
                WHERE entity_type = 'Bill' AND txn_date >= :s AND LOWER(raw_json->>'$.VendorRef.name') LIKE :p"""),
                {"s": since13, "p": f"%{tok}%"}).first()
            qbo_wk = round(float(tot[0]) / 13, 2)
            ev = f"QuickBooks bills from \"{tok}\" vendors, last 13 weeks: {_money(tot[0])} ({tot[1]} bills) ≈ {_money(qbo_wk)}/week."
        out.append(_item(CAT, "unsourced_vendor", vendor, "medium",
                         f"Unsourced (B250 placeholder): {vendor} ≈ {_money(b_wk)}/week in weeks 5–13",
                         f"{_src(snap)}: round numbers typed for weeks 5–13 (total {_money(sum(vals))}). {ev} "
                         "The app forecasts rentals/materials from each won job's estimate and schedule instead.",
                         sheet=round(b_wk, 2), qbo=qbo_wk))
    fc = collections.defaultdict(float)
    for ln in lines:
        if ln["section"] == "forecast_invoice" and ln["amount"]:
            fc[ln["group_label"] or "?"] += ln["amount"]
    if fc:
        tot = sum(fc.values())
        out.append(_item(CAT, "unsourced_forecast_inv", "total", _sev(tot),
                         f"Unsourced (B250): {_money(tot)} of dealer \"Forecasted Invoices\"",
                         f"{_src(snap)}: typed per dealer with no invoice, project or estimate behind them — "
                         + ", ".join(f"{k} {_money(v)}" for k, v in sorted(fc.items(), key=lambda x: -x[1]))
                         + ". The app builds future invoices per project from won QuickBooks estimates, the Job Schedule dates and each customer's terms.",
                         fix="For each dealer forecast, note which job and milestone it is (or set the job's billing dates in the app).",
                         sheet=round(tot, 2), link="#/cashflow"))
    m3s = _months_back(today, 3)[0]
    for label, where in (("Taxes and Insurance", "(a.fully_qualified_name LIKE 'Taxes and Insurance%' AND a.fully_qualified_name NOT LIKE '%Income Tax%') OR LOWER(a.name) LIKE '%insurance%'"),
                         ("Professional Fees", "a.fully_qualified_name LIKE 'Professional Fees%'")):
        vals = [ln["amount"] for ln in lines if ln["section"] == "operating" and (ln["label"] or "").lower() == label.lower()
                and ln["week_end"] and ln["week_end"] > snap["week1_end"] and ln["amount"]]
        if not vals:
            continue
        b_m = sum(vals) / 12 * (52 / 12)
        q = conn.execute(text(f"""SELECT COALESCE(SUM(l.amount), 0) FROM qbo_transaction_lines l
            JOIN qbo_transactions t ON t.id = l.transaction_id JOIN qbo_accounts a ON a.qbo_id = l.account_qbo_id
            WHERE t.entity_type IN ('Purchase', 'Bill') AND t.txn_date >= :s AND t.txn_date < :e AND a.account_type IN ('Expense', 'Other Expense')
              AND ({where})"""), {"s": m3s, "e": date(today.year, today.month, 1)}).scalar()
        q_m = float(q or 0) / 3
        out.append(_item(CAT, "unsourced_operating", label, "medium",
                         f"Unsourced (B250): {label} ≈ {_money(b_m)}/month vs QuickBooks {_money(q_m)}/month",
                         f"{_src(snap)}: {', '.join(_money(v) for v in vals[:8])} typed in weeks 2–13. "
                         f"QuickBooks postings to {label} accounts, last 3 complete months: average {_money(q_m)}/month.",
                         sheet=round(b_m, 2), qbo=round(q_m, 2)))
    return out


# ── A/R ──────────────────────────────────────────────────────────────────────

def ar_items(conn, snap, lines, today):
    out = []
    inv = {r["doc_number"]: dict(r) for r in conn.execute(text("""
        SELECT t.doc_number, t.qbo_id, t.customer_qbo_id, t.txn_date, t.due_date, t.total_amt, t.balance_amt, c.display_name cust
        FROM qbo_transactions t LEFT JOIN qbo_customers c ON c.qbo_id = t.customer_qbo_id
        WHERE t.entity_type = 'Invoice' AND t.doc_number IS NOT NULL""")).mappings()}
    if snap:
        b = collections.defaultdict(lambda: {"amount": 0.0, "weeks": [], "label": None, "dealer": None})
        for ln in lines:
            if ln["section"] == "inflow_invoice" and ln["invoice_num"]:
                x = b[ln["invoice_num"]]
                x["amount"] += ln["amount"] or 0
                x["label"], x["dealer"] = ln["label"], ln["group_label"]
                if ln["week_end"]:
                    x["weeks"].append(ln["week_end"])
        for n, x in sorted(b.items()):
            q = inv.get(n)
            where = f"{x['dealer']} / {x['label']}"
            if not q or float(q["balance_amt"] or 0) <= 0.005:
                same = [o for o in inv.values() if q and o["doc_number"] != n and o["customer_qbo_id"] == q["customer_qbo_id"]
                        and o["txn_date"] == q["txn_date"] and float(o["total_amt"] or 0) == float(q["total_amt"] or 0)
                        and float(o["balance_amt"] or 0) > 0]
                out.append(_item(CAT, "ar_paid_or_missing", n, _sev(x["amount"]),
                                 f"Invoice #{n} ({where}) is on the B250 for {_money(x['amount'])} but QuickBooks shows it "
                                 + ("paid" if q else "doesn't have it"),
                                 f"{_src(snap)} expects it in week ending {_md(min(x['weeks'])) if x['weeks'] else '—'}. "
                                 + (f"QuickBooks: {q['cust']}, {_money(q['total_amt'])} dated {_md(q['txn_date'])}, balance $0. " if q else "No QuickBooks invoice with this number. ")
                                 + (f"The open one is #{same[0]['doc_number']} — an identical invoice (same customer, amount and date)." if same else ""),
                                 fix=FIX_B250 if not same else "Check whether the customer was billed twice; void the duplicate in QuickBooks and fix the B250 row.",
                                 sheet=round(x["amount"], 2), qbo=float(q["balance_amt"] or 0) if q else None))
            elif abs(float(q["balance_amt"]) - x["amount"]) > 1:
                d = x["amount"] - float(q["balance_amt"])
                out.append(_item(CAT, "ar_amount", n, _sev(d),
                                 f"Invoice #{n} ({where}): B250 {_money(x['amount'])} vs QuickBooks open {_money(q['balance_amt'])}",
                                 f"{q['cust']}, invoiced {_md(q['txn_date'])} for {_money(q['total_amt'])}, due {_md(q['due_date'])}.",
                                 fix=FIX_B250, sheet=round(x["amount"], 2), qbo=float(q["balance_amt"])))
        snaps = [(ln["week_end"], round(ln["amount"] or 0, 2)) for ln in lines if ln["section"] == "snapshot"]
        cut = today - timedelta(days=90)
        for n, q in inv.items():
            bal = float(q["balance_amt"] or 0)
            if bal <= 0.005 or n in b:
                continue
            on_snap = any(d == q["txn_date"] and (abs(a - float(q["total_amt"])) < 1 or abs(a - bal) < 1) for d, a in snaps)
            stale = q["txn_date"] and q["txn_date"] < cut
            if on_snap and not stale:
                continue
            if stale and on_snap:
                continue                              # retainage etc., tracked on the SnapShot
            typ = "ar_stale" if stale else "ar_not_on_b250"
            out.append(_item(CAT, typ, n, _sev(bal),
                             f"Open invoice #{n} {q['cust']} {_money(bal)} is not on the B250"
                             + (f" ({(today - q['txn_date']).days} days old)" if stale else ""),
                             f"Invoiced {_md(q['txn_date'])} for {_money(q['total_amt'])}, due {_md(q['due_date'])}; QuickBooks balance {_money(bal)}. "
                             + ("Not on the B250 or its SnapShot, so the forecast never expects it." if stale else "Not on the B250's A/R rows."),
                             fix=("Decide: still collectible (add to the B250 / set an expected-pay date in the app), or write it off / apply the credit in QuickBooks."
                                  if stale else FIX_B250),
                             sheet=None, qbo=bal, link=f"#/entity/project/{q['customer_qbo_id']}" if q["customer_qbo_id"] else None))
    # duplicate invoices (QBO alone)
    for r in conn.execute(text("""
        SELECT t.customer_qbo_id, c.display_name cust, t.txn_date, t.total_amt,
               GROUP_CONCAT(t.doc_number ORDER BY t.doc_number) docs, SUM(t.balance_amt) bal, COUNT(*) n
        FROM qbo_transactions t LEFT JOIN qbo_customers c ON c.qbo_id = t.customer_qbo_id
        WHERE t.entity_type = 'Invoice' AND t.total_amt > 0 AND t.txn_date >= :s
        GROUP BY t.customer_qbo_id, c.display_name, t.txn_date, t.total_amt HAVING COUNT(*) > 1"""),
            {"s": today - timedelta(days=540)}).mappings():
        amt = float(r["total_amt"])
        out.append(_item(CAT, "ar_duplicate", f"{r['customer_qbo_id']}:{r['txn_date']}:{amt:.2f}",
                         _sev(amt) if float(r["bal"] or 0) > 0 else "low",
                         f"Possible duplicate invoices: {r['cust']} #{r['docs'].replace(',', ' and #')} — {r['n']} × {_money(amt)} on {_md(r['txn_date'])}",
                         f"Same customer, amount and date. Open balance across them: {_money(r['bal'])}.",
                         fix="Check whether the customer was billed twice; void the extra invoice in QuickBooks (or note why both are real).",
                         qbo=r["docs"], link=f"#/entity/project/{r['customer_qbo_id']}"))
    return out


# ── crew pay: B250 vs Payment Schedules ──────────────────────────────────────

_GENERIC = {"installers", "installations", "installation", "install", "inc", "llc", "services", "systems", "the", "and", "of"}


def _toks(s):
    return {t for t in re.sub(r"[^a-z0-9& ]", " ", (s or "").lower()).split() if len(t) > 1 and t not in _GENERIC}


def crew_items(conn, snap, lines, today):
    if not snap:
        return []
    out = []
    crews = [dict(r) for r in conn.execute(text("SELECT id, parent_id, name, code, vendor_qbo_id FROM work_crews")).mappings()]
    by_id = {c["id"]: c for c in crews}

    def root(cid):
        seen = set()
        while cid in by_id and by_id[cid]["parent_id"] and cid not in seen:
            seen.add(cid)
            cid = by_id[cid]["parent_id"]
        return cid

    by_vendor = {str(c["vendor_qbo_id"]): root(c["id"]) for c in crews if c["vendor_qbo_id"]}
    vnames = {str(v): n for v, n in conn.execute(text("""SELECT DISTINCT vendor_qbo_id, raw_json->>'$.VendorRef.name'
        FROM qbo_transactions WHERE entity_type IN ('BillPayment', 'Bill') AND vendor_qbo_id IS NOT NULL AND txn_date >= :s"""),
        {"s": today - timedelta(days=400)})}
    w1 = snap["week1_end"]
    pays = conn.execute(text("""SELECT vendor_qbo_id, SUM(total_amt) FROM qbo_transactions WHERE entity_type = 'BillPayment'
        AND txn_date > :a AND txn_date <= :b GROUP BY vendor_qbo_id"""), {"a": w1 - timedelta(days=7), "b": w1}).all()
    rows = collections.defaultdict(dict)
    for ln in lines:
        if ln["section"] == "contractor":
            rows[ln["label"]][ln["week_end"]] = rows[ln["label"]].get(ln["week_end"], 0) + (ln["amount"] or 0)
    mapped = {}
    for label, wk in rows.items():
        cid = None
        a1 = wk.get(w1)
        if a1:
            v = next((str(v) for v, s in pays if abs(float(s) - a1) < 0.01 and str(v) in by_vendor), None)
            cid = by_vendor.get(v) if v else None
        if not cid:
            # a person's name ("Danny Salinas", "On Demand - Ruben Chavez") whose
            # initials are a crew boss code from the Job Schedule (DS, RC)
            words = re.findall(r"[A-Za-z]+", label.split(" - ")[-1])
            if len(words) == 2:
                ini = (words[0][0] + words[1][0]).upper()
                cid = next((c["id"] for c in crews if not c["parent_id"] and (c["code"] or "").upper() == ini), None)
        if not cid:
            lt = _toks(label)
            best = None
            for c in crews:
                score = len(lt & _toks(c["name"]))
                if c["vendor_qbo_id"] and str(c["vendor_qbo_id"]) in vnames:
                    score = max(score, len(lt & _toks(vnames[str(c["vendor_qbo_id"])])))
                if score and (not best or score > best[0]):
                    best = (score, root(c["id"]))
            cid = best[1] if best else None
        mapped[label] = cid
    # Payment Schedule installments per root crew per B250 week (weeks 2..13)
    weeks = sorted({ln["week_end"] for ln in lines if ln["week_end"] and ln["section"] == "contractor"} |
                   {w1 + timedelta(days=7 * i) for i in range(13)})
    fwd = [w for w in weeks if w > w1]
    plan = collections.defaultdict(lambda: collections.defaultdict(float))
    src = collections.defaultdict(lambda: collections.Counter())
    sheet_sum = collections.defaultdict(float)
    if fwd:
        for r in conn.execute(text("""SELECT s.crew_id, s.source, i.pay_date, i.amount FROM project_payment_installments i
                JOIN project_payment_schedules s ON s.id = i.schedule_id
                WHERE i.pay_date > :a AND i.pay_date <= :b AND i.amount <> 0"""), {"a": w1, "b": fwd[-1]}).mappings():
            wk = next(w for w in fwd if r["pay_date"] <= w)
            rc = root(r["crew_id"]) if r["crew_id"] else None
            plan[rc][wk] += float(r["amount"])
            is_sheet = r["source"] in ("sheet", "sheet_covered")
            src[rc]["sheet" if is_sheet else "app"] += 1
            if is_sheet:
                sheet_sum[rc] += float(r["amount"])
    # several B250 rows can be one crew company (a boss and a lead paid directly)
    groups = collections.defaultdict(list)
    for label in sorted(rows):
        groups[mapped[label] or ("?", label)].append(label)
    b_tot = s_tot = 0.0
    seen = set()
    for cid, labels in groups.items():
        label = " + ".join(labels)
        b_fwd = collections.defaultdict(float)
        for lb in labels:
            for w, a in rows[lb].items():
                if w and w > w1:
                    b_fwd[w] += a
        if isinstance(cid, tuple):
            if sum(b_fwd.values()):
                out.append(_item(CAT, "crew_unmapped", label, _sev(sum(b_fwd.values())),
                                 f"B250 crew \"{label}\" ({_money(sum(b_fwd.values()))} in weeks 2–13) isn't a crew company in the app",
                                 f"{_src(snap)}: " + ", ".join(f"{_md(w)} {_money(a)}" for w, a in sorted(b_fwd.items()) if a)
                                 + ". No Team Management crew or QuickBooks vendor matched the name, so it can't be compared to a Payment Schedule.",
                                 fix="Add the crew in Team Management (with its QuickBooks vendor) or tell us which crew this is.",
                                 sheet=round(sum(b_fwd.values()), 2)))
                b_tot += sum(b_fwd.values())
            continue
        seen.add(cid)
        sp = plan.get(cid, {})
        diffs = [(w, b_fwd.get(w, 0.0), sp.get(w, 0.0)) for w in fwd if abs(b_fwd.get(w, 0.0) - sp.get(w, 0.0)) > 5000]
        bt, st = sum(b_fwd.values()), sum(sp.values())
        b_tot += bt
        s_tot += st
        if diffs:
            name = by_id[cid]["name"]
            n = src.get(cid, {})
            out.append(_item(CAT, "crew_vs_schedule", str(cid), _sev(bt - st),
                             f"{name}: B250 {_money(bt)} vs Payment Schedules {_money(st)} for weeks 2–13 ({'+' if bt >= st else '−'}{_money(abs(bt - st))})",
                             f"B250 row{'s' if len(labels) > 1 else ''} \"{label}\". Paydays that differ by more than $5k: "
                             + "; ".join(f"{_md(w)} B250 {_money(b)} vs schedule {_money(s)}" for w, b, s in diffs)
                             + f". The app forecasts from the Payment Schedules ({n.get('sheet', 0)} rows from Drive sheets, {n.get('app', 0)} app-only).",
                             fix="The Payment Schedules are the app's source: if they're behind, update the sheet in the project's Drive folder; otherwise correct the B250.",
                             sheet=round(bt, 2), app=round(st, 2), link="#/cashflow"))
    for cid, sp in plan.items():
        if cid in seen or cid is None:
            continue
        st = sum(sp.values())
        s_tot += st
        if st > 5000:
            name = by_id.get(cid, {}).get("name", f"crew {cid}")
            out.append(_item(CAT, "crew_vs_schedule", str(cid), _sev(st),
                             f"{name}: {_money(st)} on Payment Schedules for weeks 2–13, not on the B250",
                             "Paydays: " + "; ".join(f"{_md(w)} {_money(a)}" for w, a in sorted(sp.items())),
                             fix="Add the crew's paydays to the B250 (or fix the Payment Schedule if the job moved).",
                             sheet=0, app=round(st, 2), link="#/cashflow"))
    none_amt = sum(plan.get(None, {}).values())
    s_tot += none_amt
    sheet_amt = sum(sheet_sum.values())
    if abs(b_tot - s_tot) > 5000:
        out.append(_item(CAT, "crew_total", "total", _sev(b_tot - s_tot),
                         f"Crew pay weeks 2–13: B250 {_money(b_tot)} vs Payment Schedules {_money(s_tot)}",
                         f"{_src(snap)}, weeks ending {_md(fwd[0])}–{_md(fwd[-1])}. Of the app's {_money(s_tot)}, "
                         f"{_money(sheet_amt)} comes from the Drive Payment Schedule sheets and {_money(s_tot - sheet_amt)} "
                         "from app-generated schedules (jobs with no sheet)."
                         + (f" Includes {_money(none_amt)} of schedule rows with no crew set." if none_amt else ""),
                         fix="The Payment Schedules are the app's source; see the per-crew items for where they differ.",
                         sheet=round(b_tot, 2), app=round(s_tot, 2), link="#/cashflow"))
    return out


# ── QuickBooks bookkeeping gaps ──────────────────────────────────────────────

def _payee():
    return "COALESCE(t.raw_json->>'$.EntityRef.name', t.raw_json->>'$.VendorRef.name')"


def books_items(conn, snap, lines, today):
    out = []
    m6 = _months_back(today, 6)
    m12 = _months_back(today, 12)
    this_m = date(today.year, today.month, 1)
    rent = conn.execute(text("SELECT qbo_id, fully_qualified_name FROM qbo_accounts WHERE name = 'Rent' LIMIT 1")).first()
    if rent:
        posts = conn.execute(text(f"""SELECT t.qbo_id, t.entity_type, t.txn_date, l.amount, {_payee()} payee
            FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
            WHERE l.account_qbo_id = :a AND t.txn_date >= :s AND t.entity_type IN ('Purchase', 'Bill', 'JournalEntry') AND l.amount > 0"""),
            {"a": rent[0], "s": m12[0]}).mappings().all()
        months = {date(p["txn_date"].year, p["txn_date"].month, 1) for p in posts if p["amount"] >= 1000}
        miss = [m for m in m6 if m not in months]
        if miss:
            out.append(_item(CAT, "books_rent_missing", "rent", "medium",
                             f"No rent booked in QuickBooks for {', '.join(_m(m) for m in miss)}",
                             f"\"{rent[1]}\" has postings of $1,000+ in {len(months)} of the last 12 months but none in {', '.join(_m(m) for m in miss)}. "
                             "The B250 pays $40k occupancy each month, so either the payment wasn't entered or it went to another account.",
                             fix="Enter (or recode) the missing rent payments in QuickBooks.", qbo=[str(m) for m in miss]))
        cnt = collections.Counter()
        for p in posts:
            cnt[(p["payee"] or "").strip()] += 1
        landlords = {k for k, n in cnt.items() if k and n >= 3}
        usual = {round(float(p["amount"]), 2) for p in posts if (p["payee"] or "").strip() in landlords}
        for p in posts:
            if (p["payee"] or "").strip() not in landlords and float(p["amount"]) >= 1000 \
                    and not (not p["payee"] and round(float(p["amount"]), 2) in usual):   # unnamed regular rent payment
                out.append(_item(CAT, "books_rent_payee", f"{p['entity_type']}:{p['qbo_id']}", _sev(p["amount"]),
                                 f"{_money(p['amount'])} to {p['payee'] or 'no payee'} booked as Rent on {_md(p['txn_date'])}",
                                 f"Regular payees on this account (3+ postings a year): {', '.join(sorted(landlords)) or '—'}. This payee isn't one of them, so it's probably miscoded.",
                                 fix="Recode it to the right account in QuickBooks.", qbo=float(p["amount"])))
    # vendors billed monthly with a missing month (e.g. Hotel Engine)
    vb = conn.execute(text("""SELECT raw_json->>'$.VendorRef.name' v, DATE_FORMAT(txn_date, '%Y-%m-01') m, SUM(total_amt) amt
        FROM qbo_transactions WHERE entity_type = 'Bill' AND txn_date >= :s AND txn_date < :e GROUP BY v, m"""),
        {"s": m12[0], "e": this_m}).all()
    per = collections.defaultdict(dict)
    for v, m, a in vb:
        per[v][date.fromisoformat(m)] = float(a or 0)
    crew_vendors = {n for (n,) in conn.execute(text("""SELECT DISTINCT t.raw_json->>'$.VendorRef.name' FROM qbo_transactions t
        JOIN work_crews w ON w.vendor_qbo_id = t.vendor_qbo_id WHERE t.entity_type = 'Bill'"""))}
    for v, ms in per.items():
        if not v or v in crew_vendors or len(ms) < 6 or sum(ms.values()) < 50000:
            continue
        miss = [m for m in m6 if m not in ms]
        if miss and len(miss) <= 3:
            avg = sum(ms.values()) / len(ms)
            out.append(_item(CAT, "books_vendor_gap", v, _sev(avg),
                             f"{v}: no QuickBooks bill for {', '.join(_m(m) for m in miss)}",
                             f"Billed in {len(ms)} of the last 12 months (average {_money(avg)} per billed month), but nothing in {', '.join(_m(m) for m in miss)}. "
                             "Either the bill wasn't entered or it was combined into another month — the forecast's trailing averages are off either way.",
                             fix="Enter the missing bill in QuickBooks (or note it was combined).", qbo={str(m): None for m in miss}))
    # expense accounts posted every month that stopped
    acc = conn.execute(text("""SELECT a.qbo_id, a.fully_qualified_name n, COUNT(DISTINCT DATE_FORMAT(t.txn_date, '%Y-%m')) months,
               MAX(t.txn_date) last, SUM(l.amount) / COUNT(DISTINCT DATE_FORMAT(t.txn_date, '%Y-%m')) avg
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id JOIN qbo_accounts a ON a.qbo_id = l.account_qbo_id
        WHERE t.entity_type IN ('Purchase', 'Bill') AND a.account_type IN ('Expense', 'Other Expense', 'Cost of Goods Sold')
          AND t.txn_date >= :s AND l.amount > 0
        GROUP BY a.qbo_id, a.fully_qualified_name HAVING months >= 9 AND last < :cut"""),
        {"s": m12[0], "cut": today - timedelta(days=45)}).mappings().all()
    for r in acc:
        if rent and str(r["qbo_id"]) == str(rent[0]):
            continue                                  # rent has its own month-by-month item
        out.append(_item(CAT, "books_account_stopped", str(r["qbo_id"]), _sev(r["avg"]),
                         f"\"{r['n']}\" stopped: nothing booked since {_md(r['last'])}",
                         f"Posted in {r['months']} of the last 12 months (about {_money(r['avg'])} a month) — nothing in the last {(today - r['last']).days} days.",
                         fix="Enter the missing bills/payments in QuickBooks (or confirm the cost really stopped).",
                         qbo=str(r["last"])))
    wip = conn.execute(text("""SELECT MAX(t.txn_date) FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        JOIN qbo_accounts a ON a.qbo_id = l.account_qbo_id
        WHERE t.entity_type = 'JournalEntry' AND LOWER(a.name) REGEXP 'excess of|wip|work in progress'""")).scalar()
    if wip and wip < today - timedelta(days=60):
        out.append(_item(CAT, "books_wip", "wip", "medium",
                         f"Monthly WIP journal entries stopped after {_md(wip)}",
                         "The over/under-billing entries (Billings in Excess of Cost / Costs in Excess of Billings) were booked monthly until "
                         f"{_md(wip)}. Without them QuickBooks profit by month is cash-based, not earned.",
                         fix="Restart the monthly WIP entries (the app's tracker can produce the numbers).", qbo=str(wip)))
    own = conn.execute(text("""SELECT DATE_FORMAT(t.txn_date, '%Y-%m-01') m, a.name, SUM(l.amount) amt
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id JOIN qbo_accounts a ON a.qbo_id = l.account_qbo_id
        WHERE LOWER(a.name) LIKE '%owner%' AND LOWER(a.name) LIKE '%contract labor%' AND t.txn_date >= :s AND t.txn_date < :e
        GROUP BY m, a.name"""), {"s": m12[0], "e": this_m}).all()
    dom = {}
    for m, n, a in own:
        if float(a or 0) >= 10000 and (m not in dom or float(a) > dom[m][1]):
            dom[m] = (n, float(a))
    if len({n for n, _ in dom.values()}) > 1:
        seq = "; ".join(f"{_m(date.fromisoformat(m))} {n} {_money(a)}" for m, (n, a) in sorted(dom.items()))
        out.append(_item(CAT, "books_owner_account", "owner", "medium",
                         "Owner pay switches between QuickBooks accounts",
                         f"Monthly owner pay by account: {seq}. Switching accounts breaks the run-rate and the P&L comparisons.",
                         fix="Pick one owner-pay account and recode the other months to it.",
                         qbo=sorted({n for n, _ in dom.values()})))
    if snap:
        out += _monthly_items(conn, snap, lines, today)
    return out


def _monthly_items(conn, snap, lines, today):
    out = []

    def sev(b, q):                                    # small rounding-level gaps stay low
        return _sev(b - q) if abs(b - q) >= 0.02 * max(abs(q), 1) else "low"

    this_m = date(today.year, today.month, 1)
    start = _months_back(today, 12)[0]
    pay = {date.fromisoformat(m): float(a) for m, a in conn.execute(text("""SELECT DATE_FORMAT(txn_date, '%Y-%m-01') m, SUM(total_amt)
        FROM qbo_transactions WHERE entity_type = 'Payment' AND txn_date >= :s GROUP BY m"""), {"s": start})}
    book = {date.fromisoformat(m): float(a) for m, a in conn.execute(text("""
        SELECT DATE_FORMAT(COALESCE(STR_TO_DATE(raw_json->>'$.AcceptedDate', '%Y-%m-%d'), txn_date), '%Y-%m-01') m, SUM(total_amt)
        FROM qbo_transactions WHERE entity_type = 'Estimate' AND raw_json->>'$.TxnStatus' IN ('Accepted', 'Converted', 'Closed')
          AND customer_qbo_id IN (SELECT qbo_id FROM qbo_customers WHERE is_project = 1)
          AND COALESCE(STR_TO_DATE(raw_json->>'$.AcceptedDate', '%Y-%m-%d'), txn_date) >= :s GROUP BY m"""), {"s": start}) if m}
    for ln in lines:
        if ln["section"] != "monthly" or not ln["week_end"] or ln["week_end"] < start or ln["week_end"] >= this_m:
            continue
        m, b = ln["week_end"], ln["amount"] or 0
        if ln["label"] == "revenue":
            q = pay.get(m, 0.0)
            if abs(b - q) > 1000:
                out.append(_item(CAT, "b250_monthly_revenue", str(m), sev(b, q),
                                 f"{_m(m)} \"Revenue\": B250 {_money(b)} vs QuickBooks payments received {_money(q)}",
                                 "The B250 MonthlyYearly \"Revenue\" column is cash collected (it equals QuickBooks customer payments in the months that match), "
                                 "not earned revenue. Gaps are usually deposits not tied to an invoice, or a typo.",
                                 fix="Correct the B250 month (and relabel the column \"Cash collected\").", sheet=b, qbo=round(q, 2)))
        elif ln["label"] == "bookings":
            q = book.get(m, 0.0)
            if abs(b - q) > 1000:
                out.append(_item(CAT, "b250_monthly_bookings", str(m), sev(b, q),
                                 f"{_m(m)} bookings: B250 {_money(b)} vs QuickBooks accepted estimates {_money(q)}",
                                 "B250 bookings track QuickBooks estimates accepted that month (the B151 Order Value totals differ again).",
                                 fix="Agree one bookings definition (accepted date × QuickBooks estimate total) and correct the B250 month.",
                                 sheet=b, qbo=round(q, 2)))
    return out


# ── sheet integrity ──────────────────────────────────────────────────────────

_RANGE = re.compile(r"([A-Z]+)(\d+):\1(\d+)", re.I)


def formula_items(snap, lines):
    out = []
    totals = collections.defaultdict(dict)
    for ln in lines:
        if ln["section"] == "total" and ln["formula"]:
            rr = _RANGE.findall(ln["formula"])
            if rr:
                totals[(ln["row_num"], ln["label"])][ln["col"]] = (int(rr[-1][1]), int(rr[-1][2]))
    cells = collections.defaultdict(list)
    for ln in lines:
        if ln["section"] not in ("total", "snapshot", "monthly") and ln["amount"] and ln["col"]:
            cells[ln["col"]].append(ln)
    for (row, label), cols in totals.items():
        lo = min(a for a, _ in cols.values())
        hi = max(b for _, b in cols.values())
        missed = []
        for col, (a, b) in cols.items():
            for ln in cells.get(col, []):
                if lo <= ln["row_num"] <= hi and not (a <= ln["row_num"] <= b):
                    missed.append((col, ln))
        if missed:
            amt = sum(ln["amount"] for _, ln in missed)
            out.append(_item(CAT, "sheet_formula", f"{row}", _sev(amt),
                             f"B250 \"{label}\" total (row {row}) leaves out {_money(amt)} of typed amounts",
                             f"{_src(snap)}: in columns {', '.join(sorted({c for c, _ in missed}))} the SUM starts lower than in the others, skipping "
                             + "; ".join(f"row {ln['row_num']} {ln['group_label'] or ln['label']} {ln['label'] if ln['group_label'] else ''} {_money(ln['amount'])} (week ending {_md(ln['week_end'])})".replace("  ", " ")
                                         for _, ln in missed[:8]) + ".",
                             fix="Fix the SUM range in those columns of the B250 so every row is counted.",
                             sheet=round(amt, 2)))
    return out


def source_items(conn):
    today = date.today()
    snap, lines = _snapshot(conn)
    out = []
    if not snap:
        out.append(_item(CAT, "b250_missing", "b250", "medium", "OPI's B250 cash-flow sheet isn't loaded",
                         "Share the \"B250.OP.13 Week Cash Flow Forecast\" workbook with the app's Google account (Viewer) so it's read every night, "
                         "or upload a copy (.xlsx) above. Until then only the QuickBooks-only checks run.", sheet=None))
    checks = (("bank", lambda: bank_items(conn, snap or {"tab_name": "—", "week1_end": None}, lines)),
              ("unsourced", lambda: unsourced_items(conn, snap, lines, today)),
              ("ar", lambda: ar_items(conn, snap, lines, today)),
              ("crew", lambda: crew_items(conn, snap, lines, today)),
              ("books", lambda: books_items(conn, snap, lines, today)),
              ("formulas", lambda: formula_items(snap, lines) if snap else []))
    for name, fn in checks:
        try:
            out += fn()
        except Exception as e:                       # one broken check must not hide the rest
            out.append(_item(CAT, "check_failed", name, "low", f"Cash-flow source check \"{name}\" failed", str(e)[:300]))
    return out
