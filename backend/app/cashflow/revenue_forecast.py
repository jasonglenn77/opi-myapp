"""
Revenue Forecast — the app's rebuild of the B151 "1. Rolling Summary" tab
(monthly earned revenue, gross profit, overhead and operating profit), computed
from app + QBO data instead of hand-kept rows.

How each month is built (same rules as the workbook):
  * every job's value is spread linearly by CALENDAR DAY across its dates;
  * open quotes count at their win probability (20/40/60/80% from the status;
    Red Flag 80%; Inactive / Lost count as nothing);
  * gross profit = each job's own OH&P % x its monthly revenue (no flat GM%);
  * operating profit = GP - overhead - owner comp; revenue gap to breakeven
    = |loss| / that month's GM%.

Where the app differs from the workbook (deliberately):
  * WON work comes from the QBO project: value = all Accepted/Converted
    estimates on the project (change orders included), dates = the project's
    Schedule items. The workbook used quote-time values and dates.
  * Overhead + owner comp come from the Cash Flow overhead list (one place to
    edit both reports); owner comp is the "Owner Guaranteed Contract Labor" line.
  * Every row counts — the workbook's SUMIFs stop at row 1992.
Jobs with no dates are listed separately (not guessed into a month).
"""
import json
import math
import re
from calendar import monthrange
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import text

from app.db import engine
from . import overhead as OV

OWNER_LINE = "owner guaranteed"
BUCKETS = [
    ("won", "Won (scheduled)"),
    ("red_flag", "80% Red Flag"),
    ("verbal", "80% Verbal approval"),
    ("p60", "60% Project confirmed"),
    ("p40", "40% Competitive"),
    ("p20", "20% Budgetary"),
]


def _month_starts(start, n):
    out, y, m = [], start.year, start.month
    for _ in range(n):
        out.append(date(y, m, 1))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


def _month_end(d):
    return date(d.year, d.month, monthrange(d.year, d.month)[1])


def _bucket_for(pstat):
    p = (pstat or "").lower()
    if "red flag" in p:
        return "red_flag", 0.8
    if "won" in p:
        return "won", 1.0
    if "inactive" in p or "lost" in p:
        return None, 0
    m = re.match(r"\s*(\d+)\s*%", p)
    w = int(m.group(1)) if m else 20
    return {80: "verbal", 60: "p60", 40: "p40", 20: "p20"}.get(w, "p20"), w / 100.0


def _allocate(ranges, value, months):
    """Spread `value` over the calendar days of `ranges` [(start, end), ...];
    returns {month_index: amount} for months inside the window."""
    days = []
    for s, e in ranges:
        if s and e and e >= s:
            days.append((s, e))
    total = sum((e - s).days + 1 for s, e in days)
    if not total or not value:
        return {}
    out = {}
    for i, ms in enumerate(months):
        me = _month_end(ms)
        n = 0
        for s, e in days:
            lo, hi = max(s, ms), min(e, me)
            if hi >= lo:
                n += (hi - lo).days + 1
        if n:
            out[i] = value * n / total
    return out


def _ohp_of(raw):
    tot = 0.0

    def walk(lines):
        nonlocal tot
        for ln in lines or []:
            if ln.get("DetailType") == "GroupLineDetail":
                walk((ln.get("GroupLineDetail") or {}).get("Line"))
            elif ln.get("DetailType") == "SalesItemLineDetail":
                nm = (((ln.get("SalesItemLineDetail") or {}).get("ItemRef") or {}).get("name") or "")
                if nm.upper().startswith("OH&P"):
                    tot += float(ln.get("Amount") or 0)
    walk(raw.get("Line"))
    return tot


def _won_projects(conn):
    """QBO projects with accepted work: value (incl. change orders), OH&P %,
    and Schedule ranges."""
    ests = conn.execute(text("""
        SELECT c.qbo_id, c.display_name, t.total_amt, t.raw_json
        FROM qbo_transactions t
        JOIN qbo_customers c ON c.qbo_id = t.customer_qbo_id AND c.is_project = 1
        WHERE t.entity_type = 'Estimate'
          AND JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) IN ('Accepted', 'Converted')
    """)).mappings().all()
    proj = {}
    for r in ests:
        raw = r["raw_json"]
        raw = json.loads(raw) if isinstance(raw, str) else (raw or {})
        p = proj.setdefault(r["qbo_id"], {"qbo_id": r["qbo_id"], "name": r["display_name"], "value": 0.0, "ohp": 0.0})
        p["value"] += float(r["total_amt"] or 0)
        p["ohp"] += _ohp_of(raw)

    ranges = defaultdict(list)
    for r in conn.execute(text("""
        SELECT qc.qbo_id, psi.start_date, psi.end_date, COALESCE(psi.overage_days, 0) od
        FROM project_schedule_items psi
        JOIN projects p ON p.id = psi.project_id
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        WHERE psi.start_date IS NOT NULL AND psi.end_date IS NOT NULL
    """)).mappings():
        ranges[r["qbo_id"]].append((r["start_date"], r["end_date"] + timedelta(days=int(r["od"] or 0))))
    for q, p in proj.items():
        p["ranges"] = ranges.get(q, [])
    return proj


def build(start=None, months=12):
    today = date.today()
    start = date(start.year, start.month, 1) if start else date(today.year, today.month, 1)
    months = max(1, min(int(months or 12), 60))
    mlist = _month_starts(start, months)
    win_end = _month_end(mlist[-1])

    with engine.connect() as conn:
        projects = _won_projects(conn)
        opps = conn.execute(text("""
            SELECT o.id, o.quote_number, o.title, o.pipeline_status, o.status, o.project_qbo_id,
                   o.contract_value, o.order_value, o.ohp_amount, o.ohp_pct,
                   o.target_start_date, o.target_end_date, o.labor_days, o.travel_days,
                   COALESCE(qc.display_name, o.customer_name_raw) AS customer
            FROM opportunities o LEFT JOIN qbo_customers qc ON qc.id = o.qbo_customer_id
            WHERE o.active = 1
        """)).mappings().all()

    items = []
    unscheduled = []

    # OH&P for won projects: OPI often folds the margin into the labor lines
    # (OH&P lines at $0), so prefer the quote's OH&P $ / contract value (the
    # workbook's figure), then explicit OH&P lines, then the won-quote average.
    quote_ohp = defaultdict(lambda: [0.0, 0.0])
    for o in opps:
        if o["project_qbo_id"] and o["ohp_amount"] is not None and o["contract_value"]:
            q = quote_ohp[o["project_qbo_id"]]
            q[0] += float(o["ohp_amount"])
            q[1] += float(o["contract_value"])
    won_q = [(float(o["ohp_amount"]), float(o["contract_value"])) for o in opps
             if (o["pipeline_status"] or "").startswith("100%") and o["ohp_amount"] is not None
             and o["contract_value"] and float(o["contract_value"]) > 0]
    avg_pct = (sum(a for a, _ in won_q) / sum(c for _, c in won_q)) if won_q else 0.3

    # ── won work, from QBO projects ──
    linked = set()
    for p in projects.values():
        linked.add(p["qbo_id"])
        if p["value"] <= 0:
            continue
        qa, qc = quote_ohp.get(p["qbo_id"], (0.0, 0.0))
        if qc > 0:
            pct, src = qa / qc, "quote"
        elif p["ohp"] > 0:
            pct, src = p["ohp"] / p["value"], "estimate"
        else:
            pct, src = avg_pct, "average"
        it = {"kind": "project", "id": p["qbo_id"], "name": p["name"], "bucket": "won", "weight": 1.0,
              "value": round(p["value"], 2), "weighted": round(p["value"], 2), "ohp_pct": round(pct * 100, 2),
              "ohp_source": src,
              "start": str(min(s for s, _ in p["ranges"])) if p["ranges"] else None,
              "end": str(max(e for _, e in p["ranges"])) if p["ranges"] else None}
        if not p["ranges"]:
            unscheduled.append({**it, "reason": "Won — no Schedule dates"})
            continue
        last = max(e for _, e in p["ranges"])
        if last < start:
            continue  # finished before the window
        it["alloc"] = _allocate(p["ranges"], p["value"], mlist)
        items.append(it)

    # ── pipeline (and won quotes with no QBO project) ──
    for o in opps:
        bucket, w = _bucket_for(o["pipeline_status"])
        if not bucket:
            continue
        if o["project_qbo_id"] and o["project_qbo_id"] in linked and bucket in ("won", "red_flag"):
            continue  # counted from the project above
        val = float((o["order_value"] if bucket == "won" and o["order_value"] else o["contract_value"]) or 0)
        if val <= 0:
            continue
        # Workbook rule: OH&P $ / total contract value; the stored % as fallback.
        tcv = float(o["contract_value"] or 0) or val
        pct = (float(o["ohp_amount"]) / tcv if o["ohp_amount"] is not None and tcv
               else float(o["ohp_pct"] or 0) / 100)
        s = o["target_start_date"]
        e = o["target_end_date"]
        est_end = False
        if s and not e:
            d = float(o["labor_days"] or 0) + float(o["travel_days"] or 0)
            e = s + timedelta(days=max(0, math.ceil(max(d, 1) * 7 / 5) - 1))
            est_end = True
        name = o["title"] or o["customer"] or f"Quote {o['quote_number']}"
        it = {"kind": "opportunity", "id": o["id"], "quote": o["quote_number"], "name": name,
              "customer": o["customer"], "bucket": bucket, "weight": w,
              "value": round(val, 2), "weighted": round(val * w, 2), "ohp_pct": round(pct * 100, 2),
              "start": str(s) if s else None, "end": str(e) if e else None, "end_estimated": est_end}
        if not s:
            unscheduled.append({**it, "reason": "No start date"})
            continue
        if e < start:
            continue
        it["alloc"] = _allocate([(s, e)], val * w, mlist)
        items.append(it)

    # ── roll-up ──
    n = len(mlist)
    rev = {b: [0.0] * n for b, _ in BUCKETS}
    gp = {b: [0.0] * n for b, _ in BUCKETS}
    for it in items:
        alloc = it.pop("alloc", {})
        it["months"] = [round(alloc.get(i, 0), 2) for i in range(n)]
        for i, v in alloc.items():
            rev[it["bucket"]][i] += v
            gp[it["bucket"]][i] += v * it["ohp_pct"] / 100
    items = [it for it in items if any(it["months"])]

    opex, owner = [0.0] * n, [0.0] * n
    for o in OV.list_overhead(active_only=True):
        is_owner = OWNER_LINE in (o["name"] or "").lower()
        for i, ms in enumerate(mlist):
            occ = OV._occurrences(o["cadence"], o["anchor_date"], ms, _month_end(ms), o["end_date"])
            amt = float(o["amount"] or 0) * len(occ)
            if is_owner:
                owner[i] += amt
            else:
                opex[i] += amt

    tot_rev = [sum(rev[b][i] for b, _ in BUCKETS) for i in range(n)]
    tot_gp = [sum(gp[b][i] for b, _ in BUCKETS) for i in range(n)]
    op = [tot_gp[i] - opex[i] - owner[i] for i in range(n)]
    gm = [(tot_gp[i] / tot_rev[i]) if tot_rev[i] else 0 for i in range(n)]
    gap = [(-op[i] / gm[i]) if op[i] < 0 and gm[i] else 0 for i in range(n)]
    won_rev = rev["won"]

    r2 = lambda xs: [round(x, 2) for x in xs]
    return {
        "months": [m.strftime("%Y-%m") for m in mlist],
        "buckets": [{"key": b, "label": lbl, "revenue": r2(rev[b]), "gp": r2(gp[b])} for b, lbl in BUCKETS],
        "totals": {
            "revenue": r2(tot_rev), "gp": r2(tot_gp), "gm_pct": [round(g * 100, 2) for g in gm],
            "opex": r2(opex), "owner_comp": r2(owner), "operating_profit": r2(op),
            "breakeven_gap": r2(gap), "won_revenue": r2(won_rev),
        },
        "window": {
            "revenue": round(sum(tot_rev), 2), "gp": round(sum(tot_gp), 2),
            "gm_pct": round(sum(tot_gp) / sum(tot_rev) * 100, 2) if sum(tot_rev) else 0,
            "won_revenue": round(sum(won_rev), 2),
            "operating_profit": round(sum(op), 2),
            "opex": round(sum(opex), 2), "owner_comp": round(sum(owner), 2),
        },
        "items": sorted(items, key=lambda x: -sum(x["months"])),
        "unscheduled": sorted(unscheduled, key=lambda x: -x["weighted"]),
        "as_of": str(today), "window_end": str(win_end),
        "avg_won_ohp_pct": round(avg_pct * 100, 2),
    }
