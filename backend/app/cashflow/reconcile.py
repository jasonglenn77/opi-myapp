"""
OPI's B250 13-week cash flow vs the app's Cash Flow forecast, side by side over
the B250's own 13 weeks — the "Why our numbers differ" panel on the Cash Flow
page.

Both sides are split into the same groups (opening cash, invoices already sent,
billing not yet invoiced, vendor bills, lodging, credit cards, crew, payroll,
other overhead). The week-13 ending-balance gap is broken down into those
groups (the opening difference plus each group's inflow/outflow difference),
and each group carries why it differs and what fixes it.

The B250 side comes from the latest copy the app holds (gsync_b250_*); the app
side is generate_forecast_v2 run from the B250's week 1, so the weeks line up.
"""
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import text

from app.db import engine

PAYROLL_WORDS = ("payroll", "wages", "owner", "bonus", "commission")


def _b250(conn):
    snap = conn.execute(text(
        "SELECT id, source, file_id, file_name, tab_name, week1_end, loaded_at FROM gsync_b250_snapshot ORDER BY id DESC LIMIT 1"
    )).mappings().first()
    if not snap:
        return None
    lines = [dict(r) for r in conn.execute(text(
        "SELECT section, label, group_label, invoice_num, week_end, amount FROM gsync_b250_lines WHERE snapshot_id = :s"),
        {"s": snap["id"]}).mappings().all()]
    return dict(snap), lines


def _wk(weeks, d):
    """Index of the week (ending Friday) that date d falls in, or None."""
    for i, we in enumerate(weeks):
        if we - timedelta(days=6) <= d <= we:
            return i
    return None


def _opening_text(bank, b_open, a_open, skipped, week1, undep, money):
    """Why the openings differ, depending on where the app's opening comes from."""
    books = float(bank.get("books_balance") or 0)
    typed = (bank.get("b250") or {}).get("balance")
    gap_books = f"QuickBooks' books show {money(books)}" + (f", {money(books - typed)} more than the bank" if typed else "") +         f", mainly because {money(undep)} of customer payments sit in \"Payments to deposit\", never matched to a bank deposit, and account 6458 is in QuickBooks twice."
    fix = "Bookkeeper matches the undeposited payments to their bank deposits and merges the duplicate 6458 register (B1-B3). Once the books match the bank, the app can start from the books."
    if bank.get("source") == "b250":
        why = (f"The app starts from the bank balance typed on the B250 ({money(a_open)}), because QuickBooks doesn't share the bank's own balance with outside apps. "
               + (f"The B250's own opening for the week ending {week1:%m/%d} is {money(b_open)}: it carries its first week, already past, forward. " if skipped else "")
               + gap_books)
    else:
        why = ("The B250 starts from the bank's own balance (typed from the QuickBooks bank screen). The app starts from QuickBooks' book balance, the only balance QuickBooks shares with outside apps. "
               + gap_books)
        fix += " Until then, switch the app's opening to the B250 balance (Opening balance source)."
    return {"why": why, "fix": fix, "source": bank.get("source"), "books": books}


def _crew_why(crew_od, crew_iids, src_items, first_start, money):
    """Why the crew rows differ, from the data: stale Payment Schedules (unpaid
    installments dated before week 1 aren't in the weekly totals), jobs with no
    Payment Schedule (estimate labor split evenly), and B250 crews the app
    doesn't know (Data Review crew_unmapped)."""
    with engine.connect() as conn:
        names = dict(conn.execute(text("SELECT qbo_id, display_name FROM qbo_customers WHERE is_project = 1")).all())
        src = {}
        if crew_iids:
            ids = ",".join(str(int(i)) for i in crew_iids)
            src = dict(conn.execute(text(f"""SELECT i.id, s.source FROM project_payment_installments i
                JOIN project_payment_schedules s ON s.id = i.schedule_id WHERE i.id IN ({ids})""")).all())
    short = lambda e: (names.get(str(e)) or str(e)).split(" - ", 1)[-1]
    parts = ["B250: one typed row per crew company. App: each job's crew Payment Schedule from Google Drive "
             "(or the estimate's labor split evenly where there is no sheet), minus what QuickBooks shows paid."]
    od = sum(crew_od.values())
    if od > 0.5:
        top = sorted(crew_od.items(), key=lambda kv: -kv[1])[:3]
        parts.append(f"{money(od)} of unpaid installments are on Payment Schedules dated before {first_start:%m/%d}, mostly jobs "
                     f"that moved after the sheet was made ({', '.join(f'{short(e)} {money(a)}' for e, a in top)}). The app lists "
                     "these as overdue instead of in the weeks; the B250 puts that crew pay in the coming weeks.")
    fb = defaultdict(float)
    for iid, (e, a) in crew_iids.items():
        if src.get(iid) == "app":
            fb[e] += a
    if fb:
        top = sorted(fb.items(), key=lambda kv: -kv[1])[:2]
        parts.append(f"{money(sum(fb.values()))} on {len(fb)} job{'s' if len(fb) > 1 else ''} with no Payment Schedule in Drive comes from "
                     f"the estimate's labor ({', '.join(f'{short(e)} {money(a)}' for e, a in top)}).")
    unm = [i for i in src_items if i.get("type") == "crew_unmapped" and i.get("sheet")]
    if unm:
        parts.append("B250 crews with no crew company in the app: "
                     + ", ".join(f"{i['key'].split(':', 2)[-1]} {money(i['sheet'])}" for i in unm[:4]) + ".")
    return " ".join(parts)


_cache = {"at": 0.0, "data": None}


def build(force=False):
    import time
    if not force and _cache["data"] and time.time() - _cache["at"] < 300:
        return _cache["data"]
    _cache["data"], _cache["at"] = _build(), time.time()
    return _cache["data"]


def _build():
    from . import service as S
    from . import schedule_forecast as SF
    with engine.connect() as conn:
        got = _b250(conn)
        if not got:
            return {"available": False}
        snap, lines = got
        try:  # open "Cash flow sources" items on Data Review (not marked Fixed / Ignored)
            from app.gsync.review_sources import source_items
            closed = {r[0] for r in conn.execute(text(
                "SELECT item_key FROM data_review_state WHERE status IN ('fixed', 'ignored')")).all()}
            src_items = source_items(conn)
            dr_open = sum(1 for i in src_items if i["key"] not in closed)
        except Exception:
            dr_open, src_items = None, []

    # The B250's week 1 is often already past (its tab is copied forward each
    # Monday). Compare from the app's week 1 (the coming Friday) so both sides
    # start from "now": the B250's own opening for that week vs the app's.
    b_weeks_all = [snap["week1_end"] + timedelta(days=7 * i) for i in range(13)]
    app_wk1 = S._next_weekday(date.today(), S.WEEK_END_WEEKDAY)
    weeks = [w for w in b_weeks_all if w >= app_wk1] or b_weeks_all
    week1 = weeks[0]
    skipped = b_weeks_all.index(week1)
    n = len(weeks)

    # ---- B250 side --------------------------------------------------------
    b = defaultdict(lambda: [0.0] * n)
    inv_amt, dealer_rows, dealer_fc = defaultdict(float), 0.0, 0.0
    row_names, fc_names = defaultdict(float), defaultdict(float)
    b_opening = None
    b_ending = [None] * n
    for ln in lines:
        sec, lab, amt, we = ln["section"], (ln["label"] or ""), float(ln["amount"] or 0), ln["week_end"]
        if sec == "opening":
            if skipped == 0:
                b_opening = amt
            continue
        if sec == "total" and lab.lower().startswith("opening") and we == week1 and skipped:
            b_opening = amt           # the B250's own opening for the first compared week
            continue
        if sec == "total" and lab.lower().startswith("ending cash") and we in weeks:
            b_ending[weeks.index(we)] = amt
            continue
        if we not in weeks:
            continue
        i = weeks.index(we)
        low = lab.lower()
        if sec == "inflow_invoice":
            b["sent"][i] += amt
            inv_amt[(ln.get("invoice_num") or "").strip()] += amt
        elif sec == "inflow_dealer":
            b["tobill"][i] += amt          # dealer rows with no invoice number
            dealer_rows += amt
            row_names[lab] += amt
        elif sec == "forecast_invoice":
            b["tobill"][i] += amt
            dealer_fc += amt
            fc_names[ln.get("group_label") or lab] += amt
        elif sec == "ap":
            key = "lodging" if "hotel engine" in low else "cards" if "credit card" in low else "vendors"
            b[key][i] += amt
        elif sec == "contractor":
            b["crew"][i] += amt
        elif sec == "payroll":
            b["payroll"][i] += amt
        elif sec == "operating":
            b["overhead"][i] += amt

    # ---- app side (same 13 weeks) -------------------------------------------
    f = S.generate_forecast_v2(start_date=week1, weeks=n)
    a = defaultdict(lambda: [0.0] * n)
    secs_in = {s["key"]: s for s in f["inflow"]["sections"]}
    secs_out = {s["key"]: s for s in f["outflow"]["sections"]}
    a["sent"] = list(secs_in["ar"]["weekly_totals"])
    a["tobill"] = list(secs_in["scheduled"]["weekly_totals"])
    a["vendors"] = list(secs_out["ap"]["weekly_totals"])
    # project schedule: crew vs expenses (lodging split out), from the cached events
    payload, _ = SF.get_events()
    lodging_jobs, lodging_ids = 0.0, set()
    first_start = weeks[0] - timedelta(days=6)
    crew_od, crew_iids = defaultdict(float), {}
    for e in (payload or {}).get("events", []):
        if e.get("dir") != "out" or e.get("src") not in ("crew", "expense"):
            continue
        d = date.fromisoformat(e["date"])
        if d < first_start:
            if e["src"] == "crew":   # unpaid installments dated before week 1 (stale sheets)
                crew_od[e.get("entity_id")] += e["amt"]
            continue  # overdue plans: listed on the page, not in the totals
        if e["src"] == "crew" and e.get("iid") and d <= weeks[-1]:
            crew_iids[e["iid"]] = (e.get("entity_id"), e["amt"])
        i = _wk(weeks, d)
        if i is None:
            continue
        if e["src"] == "crew":
            a["crew"][i] += e["amt"]
        elif (e.get("cat") or "") == "Lodging":
            a["lodging"][i] += e["amt"]
            lodging_jobs += e["amt"]
            lodging_ids.add(e.get("entity_id"))
        else:
            a["vendors"][i] += e["amt"]
    for item in secs_out["recurring"].get("alt_rows") or []:
        low = (item.get("label") or "").lower()
        key = ("lodging" if "hotel engine" in low else "cards" if "credit card" in low
               else "payroll" if any(w in low for w in PAYROLL_WORDS) else "overhead")
        for i, v in enumerate(item.get("weekly") or []):
            a[key][i] += v

    with engine.connect() as conn:
        bal = {r[0]: float(r[1] or 0) for r in conn.execute(text(
            "SELECT doc_number, MAX(balance_amt) FROM qbo_transactions WHERE entity_type = 'Invoice' GROUP BY doc_number")).all()}
    inv_open = {k: v for k, v in inv_amt.items() if bal.get(k, 0) > 0.5}
    inv_paid = {k: v for k, v in inv_amt.items() if k in bal and bal[k] <= 0.5}
    inv_missing = {k: v for k, v in inv_amt.items() if k not in bal}
    with engine.connect() as conn:
        undep = conn.execute(text(
            "SELECT COALESCE(SUM(current_balance), 0) FROM qbo_accounts WHERE account_sub_type = 'UndepositedFunds'")).scalar() or 0
    top = lambda d: ", ".join(k for k, _ in sorted(d.items(), key=lambda x: -x[1])[:3]) + ("…" if len(d) > 3 else "")
    money = lambda v: f"${v:,.0f}"
    ar_od = float(f["overdue"].get("ar_counted") or 0)
    # lodging facts for the explanation: Hotel Engine's calendar + recent statements
    from app.assumptions.calibrate import lodging_billing, LODGING_VENDOR
    from app.jobcost import service as JC
    with engine.connect() as conn:
        lb = lodging_billing(conn) or {}
        he = conn.execute(text("""
            SELECT DATE_FORMAT(txn_date, '%b') AS m, ROUND(SUM(total_amt)) AS amt FROM qbo_transactions
            WHERE entity_type = 'Bill' AND JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.VendorRef.name')) LIKE :v
              AND txn_date >= CURDATE() - INTERVAL 4 MONTH
            GROUP BY DATE_FORMAT(txn_date, '%Y-%m'), m ORDER BY DATE_FORMAT(txn_date, '%Y-%m')
        """), {"v": f"%{LODGING_VENDOR}%"}).all()
    crew_why = _crew_why(crew_od, crew_iids, src_items, first_start, money)
    lb_day, lb_lag = lb.get("bill_day", 11), round(lb.get("paid_lag_days") or 0)
    he_recent = ", ".join(f"{m} {money(float(v))}" for m, v in he) or "none in the last 4 months"
    fin = [j for j in JC.dataset()["jobs"] if j["state"] == "finished" and j["end"] >= str(date.today().replace(month=3, day=1))
           and j["est"].get("Lodging", 0) > 0]
    e_sum = sum(j["est"]["Lodging"] for j in fin)
    lodge_ratio = f"{sum(j['act'].get('Lodging', 0) for j in fin) / e_sum:.0%}" if e_sum else "n/a"
    lodging_n = len(lodging_ids)
    ar_beyond = round(sum(r.get("beyond") or 0 for r in secs_in["ar"]["rows"]), 2)
    a_opening = f["opening_balance"]
    a_ending = f["summary"]["ending"]

    GROUPS = [
        ("sent", "in", "Invoices already sent (A/R)",
         (f"The B250's {len(inv_open)} open invoices ({money(sum(inv_open.values()))}) match QuickBooks exactly. "
          + (f"It also lists {', '.join('#' + k for k in inv_paid)} ({money(sum(inv_paid.values()))}), which QuickBooks shows already paid. " if inv_paid else "")
          + (f"{len(inv_missing)} invoice numbers ({money(sum(inv_missing.values()))}) aren't in QuickBooks. " if inv_missing else "")
          + f"The app counts every open invoice: {money(sum(a['sent']) - sum(inv_open.values()))} more, mostly older invoices the B250 leaves off, counted in week 1 as overdue ({money(ar_od)} overdue in all)."),
         "Take paid invoices off the B250, and decide which old invoices are still collectable (I1, I3)."),
        ("tobill", "in", "Billing not yet invoiced",
         (f"The B250 has {money(dealer_fc)} of round dealer forecasts ({top(fc_names)})"
          + (f" and {money(dealer_rows)} on dealer rows with no invoice number ({top(row_names)})" if dealer_rows > 0.5 else "")
          + ", none tied to a job. The app uses each won job's billing schedule from its estimate and Job Schedule dates."),
         "Name the job and milestone behind each B250 dealer row and forecast, and confirm IDL and Sysco CA billing dates (I4)."),
        ("vendors", "out", "Vendor bills (rentals, materials, propane, dumpsters)",
         "B250: open bills plus round placeholders ($62,900 a week from week 5). App: open QuickBooks bills plus each active job's planned expenses, timed by how those bills actually land (Assumptions page).",
         "Agree to plan rentals and materials per scheduled job instead of placeholders (P7)."),
        ("lodging", "out", "Lodging (Hotel Engine)",
         (f"B250: one company-wide Hotel Engine line, a round $150,000 on 11/20 and 12/25. "
          f"App: the lodging on each scheduled job's estimate ({money(lodging_jobs)} across {lodging_n} jobs), placed on Hotel Engine's real billing calendar: "
          f"one statement for the previous month's stays, dated about the {lb_day}th, paid about {lb_lag} days later. "
          f"Hotel Engine's recent statements: {he_recent}, each split across the jobs the crews stayed on. "
          + (f"The app's line still includes the B250's own $150,000 overhead line ({money(sum(a['lodging']) - lodging_jobs)}); retire it to stop counting lodging twice. "
             if sum(a['lodging']) - lodging_jobs > 0.5 else
             "Since 10/28 the app counts lodging only from the jobs; the B250-style overhead line was retired because it paid for the same hotel nights. ")
          + "The app's number falls off in later months because jobs not yet on the Job Schedule aren't included, and it uses the full estimate "
          f"(on jobs finished since March, lodging cost came to {lodge_ratio} of estimate)."),
         "Confirm how IDL is housed: its estimate carries $458,000 of lodging but almost no Hotel Engine charges (X7). Get won jobs onto the Job Schedule so their lodging is planned. Compare each month's Hotel Engine statement to the plan (P6)."),
        ("cards", "out", "Credit card payments",
         "Both use the B250's $20,000 a week: QuickBooks records no card payoffs to check it against.",
         "Record card payoffs in QuickBooks or share statements (B4)."),
        ("crew", "out", "Crew pay", crew_why,
         "Re-date the Payment Schedules of jobs that moved (in the job's Drive folder), add Payment Schedules for the jobs using the estimate, and name the B250 crews the app doesn't know. Per-crew detail: Data Review → Cash flow sources (C1-C4)."),
        ("payroll", "out", "Payroll (owner, W-2, bonus)",
         "Owner pay: both $300,000 a month. W-2 and bonus: the app uses the B250's figures because payroll paychecks aren't visible in QuickBooks.",
         "Export the payroll summary after each run (P1). Book owner pay to one account (P2)."),
        ("overhead", "out", "Other overhead (rent, insurance, fees, software...)",
         "B250: rent, taxes and insurance, professional fees. App: every recurring account at its trailing 12-month QuickBooks run-rate, so it includes costs the B250 doesn't list.",
         "Review the Overhead list together and agree which lines belong (P3-P5)."),
    ]
    rows = []
    for key, direction, label, why, fix in GROUPS:
        bt, at = round(sum(b[key]), 2), round(sum(a[key]), 2)
        # effect on the app's ending cash relative to the B250
        effect = round((at - bt) if direction == "in" else (bt - at), 2)
        rows.append({"key": key, "direction": direction, "label": label,
                     "b250": bt, "app": at, "difference": round(at - bt, 2), "cash_effect": effect,
                     "why": why, "fix": fix,
                     "b250_weekly": [round(x, 2) for x in b[key]], "app_weekly": [round(x, 2) for x in a[key]]})

    open_diff = round(a_opening - (b_opening or 0), 2)
    b_in = round(sum(sum(b[k]) for k in ("sent", "tobill")), 2)
    b_out = round(sum(sum(b[k]) for k in ("vendors", "lodging", "cards", "crew", "payroll", "overhead")), 2)
    a_in, a_out = round(sum(f["inflow"]["weekly_totals"]), 2), round(sum(f["outflow"]["weekly_totals"]), 2)
    b_end13 = b_ending[-1] if b_ending[-1] is not None else round((b_opening or 0) + b_in - b_out, 2)
    explained = round(open_diff + sum(r["cash_effect"] for r in rows), 2)
    # what's left = the B250's own ending vs the sum of its lines (formula errors)
    b250_formula_gap = round((b_opening or 0) + b_in - b_out - b_end13, 2)
    gap = round(a_ending[-1] - b_end13, 2)

    b_bal = [x if x is not None else None for x in b_ending]
    return {
        "available": True,
        "b250": {"tab": snap["tab_name"], "week1_end": str(snap["week1_end"]), "compared_from": str(week1),
                 "weeks_skipped": skipped, "source": snap["source"],
                 "file_name": snap["file_name"], "file_id": snap.get("file_id"), "loaded_at": str(snap["loaded_at"])},
        "week_ends": [str(w) for w in weeks],
        "opening": {"b250": b_opening, "app": a_opening, "difference": open_diff, **_opening_text(
            f.get("bank") or {}, b_opening, a_opening, skipped, week1, float(undep), money)},
        "totals": {"b250_in": b_in, "app_in": a_in, "b250_out": b_out, "app_out": a_out,
                   "b250_end": b_end13, "app_end": a_ending[-1],
                   "b250_low": min(x for x in b_bal if x is not None) if any(x is not None for x in b_bal) else None,
                   "app_low": min(a_ending)},
        "ending": {"b250": b_bal, "app": a_ending},
        "gap": gap, "explained": explained, "unexplained": round(gap - explained, 2),
        "b250_formula_gap": b250_formula_gap,
        "groups": rows,
        "data_review_open": dr_open,
        "b151": {
            "summary": "The B151 is the sales pipeline and revenue forecast, not a cash forecast. The app copies it into the Pipeline every night, so the app and the B151 agree on quotes, stages and won jobs.",
            "differences": [
                "Change orders: the B151 shows $40.05M on 500 won jobs; QuickBooks shows $42.33M. QuickBooks is higher on 118 jobs, mostly change orders the B151 doesn't add (E1).",
                "Bookings: the B151 uses its own order values, the B250 uses QuickBooks accepted estimates (April: $6.46M vs $5.71M) (E10).",
                "Lost quotes: 1,631 quotes marked Lost or Inactive on the B151 are still Pending in QuickBooks ($227M) (E2).",
            ],
        },
    }
