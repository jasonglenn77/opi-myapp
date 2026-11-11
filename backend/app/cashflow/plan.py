"""
Cash Plan: the owners' view of cash, built on the 13-week forecast
(service.generate_forecast_v2, which stays the source of truth) with what the
owner docs asked for added as separate, switchable lines:

  Money in
    Open invoices (A/R)              forecast, on each invoice's expected-paid date
    Invoices to send (won, scheduled) forecast, from the project billing schedules
    Won, not scheduled yet           backlog jobs: assumed to start START_LAG weeks
                                     out, 35% / 35% / 30% (OPI's usual terms)
    Pipeline (weighted)              open quotes with a start date, value x win
                                     probability, 35/35/30 around their dates
  Money out
    Crew pay                         forecast crew installments; optionally moved
                                     to bi-weekly crew paydays (pay every other Friday)
    Project expenses                 forecast
    Open bills (A/P)                 forecast
    Payroll                          from the overhead list (W-2 wages, owner
                                     guaranteed labor, labor burden, bonus)
    Other overhead                   the rest of the overhead list
    Pipeline costs (weighted)        open quotes: value minus OH&P, spread over the job

Every assumption is returned in "assumptions" and shown on the page.
"""
import math
from datetime import date, timedelta

from sqlalchemy import text

from app.db import engine
from . import service as S
from .revenue_forecast import _bucket_for

TERMS = (0.35, 0.35, 0.30)      # on order / at start / at completion
PAY_LAG_DAYS = 30               # invoice to cash
ORDER_LEAD_DAYS = 21            # first invoice (PO receipt) this long before the start
START_LAG_WEEKS = 4             # won-not-scheduled jobs: assumed start
PAYROLL_WORDS = ("payroll", "wages", "owner guaranteed", "bonus", "labor burden")


def _week_index(d, week_ends):
    for i, we in enumerate(week_ends):
        if d <= we:
            return i
    return None


def _add(arr, d, amt, week_ends, start):
    if d < start:
        d = start
    i = _week_index(d, week_ends)
    if i is not None:
        arr[i] += amt
        return True
    return False


def build(weeks=13, biweekly=True, anchor=None, min_prob=40):
    today = date.today()
    f = S.generate_forecast_v2(today, weeks=weeks)
    week_ends = [date.fromisoformat(w) for w in f["week_ends"]]
    n = len(week_ends)
    z = lambda: [0.0] * n
    sec = {(side, s["key"]): s for side in ("inflow", "outflow") for s in f[side]["sections"]}

    lines = []

    def line(key, side, label, weekly, layer="forecast", note=None, beyond=0.0):
        lines.append({"key": key, "side": side, "label": label, "weekly": [round(x, 2) for x in weekly],
                      "total": round(sum(weekly), 2), "layer": layer, "note": note, "beyond": round(beyond, 2)})

    ar = sec.get(("inflow", "ar"))
    if ar:
        line("ar", "in", "Open invoices (A/R)", ar["weekly_totals"], note="Each open invoice on its expected-paid date; overdue ones in week 1.")
    si = sec.get(("inflow", "scheduled"))
    if si:
        line("to_bill", "in", "Invoices to send (won, scheduled)", si["weekly_totals"], note="Project billing schedules, paid on their expected date.")

    # Crew pay vs expenses from the forecast's by-type view of the schedules.
    so = sec.get(("outflow", "scheduled"))
    crew, exp = z(), z()
    if so:
        for r in so.get("alt_rows") or []:
            tgt = crew if "crew" in (r.get("label") or "").lower() else exp
            for i, v in enumerate(r.get("weekly") or []):
                if i < n:
                    tgt[i] += float(v or 0)
    anchor_d = date.fromisoformat(anchor) if anchor else None
    if biweekly:
        # Every other Friday from the anchor payday: a week's crew pay moves to the
        # next payday on or after it.
        a = anchor_d or date(2026, 1, 9)
        paydays = []
        d = a
        while d < week_ends[0] - timedelta(days=7):
            d += timedelta(days=14)
        while d <= week_ends[-1] + timedelta(days=14):
            paydays.append(d)
            d += timedelta(days=14)
        moved = z()
        for i, v in enumerate(crew):
            if not v:
                continue
            pd_ = next((p for p in paydays if p >= week_ends[i] - timedelta(days=6)), None)
            j = _week_index(pd_, week_ends) if pd_ else None
            moved[j if j is not None else i] += v
        crew_note = f"Moved to bi-weekly crew paydays (every other Friday from {a.isoformat()})."
        line("crew", "out", "Crew pay (bi-weekly paydays)", moved, note=crew_note)
    else:
        line("crew", "out", "Crew pay", crew, note="Crew payment schedules as dated (weekly).")
    line("expenses", "out", "Project expenses", exp, note="Planned project expenses (lifts, materials, lodging…) by week.")
    ap = sec.get(("outflow", "ap"))
    if ap:
        line("ap", "out", "Open bills (A/P)", ap["weekly_totals"], note="Unpaid QuickBooks bills by due date.")
    rec = sec.get(("outflow", "recurring"))
    pay, oh = z(), z()
    if rec:
        for r in rec.get("alt_rows") or rec.get("rows") or []:
            lab = (r.get("label") or "").lower()
            tgt = pay if any(w in lab for w in PAYROLL_WORDS) else oh
            for i, v in enumerate(r.get("weekly") or []):
                if i < n:
                    tgt[i] += float(v or 0)
    line("payroll", "out", "Payroll", pay, note="W-2 wages, owner guaranteed labor, labor burden and bonus, from the overhead list (Cash Flow page).")
    line("overhead", "out", "Other overhead", oh, note="Rent, insurance, credit card and the rest of the overhead list.")

    # Won, not scheduled: the forecast's backlog jobs.
    won_in, won_out = z(), z()
    start_assumed = today + timedelta(weeks=START_LAG_WEEKS)
    backlog_jobs = [p for p in f.get("projects") or [] if not p.get("has_dates") and (p.get("backlog_in") or p.get("backlog_out"))]
    for p in backlog_jobs:
        v_in, v_out = float(p.get("backlog_in") or 0), float(p.get("backlog_out") or 0)
        s, e = start_assumed, start_assumed + timedelta(weeks=2)
        for pct, d in zip(TERMS, (s - timedelta(days=ORDER_LEAD_DAYS) + timedelta(days=PAY_LAG_DAYS),
                                   s + timedelta(days=PAY_LAG_DAYS), e + timedelta(days=PAY_LAG_DAYS))):
            _add(won_in, d, v_in * pct, week_ends, week_ends[0] - timedelta(days=6))
        for k in range(2):
            _add(won_out, s + timedelta(weeks=k), v_out / 2, week_ends, week_ends[0] - timedelta(days=6))
    line("won_unscheduled_in", "in", "Won, not scheduled yet", won_in, layer="won",
         note=f"{len(backlog_jobs)} won jobs with no dates: assumed to start in {START_LAG_WEEKS} weeks, billed 35/35/30.")
    line("won_unscheduled_out", "out", "Won, not scheduled: crew & expenses", won_out, layer="won",
         note="Their scheduled crew pay and expenses, over the first two weeks of the assumed start.")

    # Pipeline: open quotes, weighted.
    pin, pout = z(), z()
    counted, by_bucket = 0, {}
    with engine.connect() as conn:
        opps = conn.execute(text("""
            SELECT id, quote_number, title, pipeline_status, contract_value, ohp_amount, target_start_date, target_end_date,
                   labor_days, travel_days
            FROM opportunities WHERE active = 1 AND status NOT IN ('won', 'lost') AND contract_value > 0
              AND target_start_date >= :since"""), {"since": today - timedelta(days=30)}).mappings().all()
    for o in opps:
        bucket, w = _bucket_for(o["pipeline_status"])
        if not bucket or bucket in ("won", "red_flag") or w * 100 < min_prob:
            continue
        val = float(o["contract_value"]) * w
        cost = max(0.0, float(o["contract_value"]) - float(o["ohp_amount"] or 0)) * w
        s = max(o["target_start_date"], today + timedelta(days=ORDER_LEAD_DAYS))
        e = o["target_end_date"] or s + timedelta(days=max(0, math.ceil(max(float(o["labor_days"] or 0) + float(o["travel_days"] or 0), 1) * 7 / 5) - 1))
        if e < s:
            e = s
        hit = False
        for pct, d in zip(TERMS, (s - timedelta(days=ORDER_LEAD_DAYS) + timedelta(days=PAY_LAG_DAYS),
                                   s + timedelta(days=PAY_LAG_DAYS), e + timedelta(days=PAY_LAG_DAYS))):
            hit |= _add(pin, d, val * pct, week_ends, week_ends[0] - timedelta(days=6))
        days = max(1, (e - s).days + 1)
        wk = max(1, math.ceil(days / 7))
        for k in range(wk):
            hit |= _add(pout, s + timedelta(weeks=k), cost / wk, week_ends, week_ends[0] - timedelta(days=6))
        if hit:
            counted += 1
            by_bucket[o["pipeline_status"]] = by_bucket.get(o["pipeline_status"], 0) + 1
    line("pipeline_in", "in", "Pipeline (weighted)", pin, layer="pipeline",
         note=f"{counted} open quotes at {min_prob}%+ with a start date, at value x win probability, billed 35/35/30.")
    line("pipeline_out", "out", "Pipeline costs (weighted)", pout, layer="pipeline",
         note="Their cost (value minus OH&P) x win probability, spread over the job.")

    return {"as_of": today.isoformat(), "week_ends": f["week_ends"], "opening": f["opening_balance"], "bank": {
                "balance": f["bank"].get("balance"), "source": f["bank"].get("source"), "last_synced": str(f["bank"].get("last_synced") or "")},
            "lines": lines, "pipeline_by_status": by_bucket,
            "assumptions": {"terms": "35% at order, 35% at start, 30% at completion", "pay_lag_days": PAY_LAG_DAYS,
                            "order_lead_days": ORDER_LEAD_DAYS, "start_lag_weeks": START_LAG_WEEKS,
                            "biweekly": biweekly, "anchor": (anchor_d or date(2026, 1, 9)).isoformat(), "min_prob": min_prob},
            "backlog": [{"entity_id": p["entity_id"], "name": p["name"], "in": p.get("backlog_in"), "out": p.get("backlog_out")} for p in backlog_jobs]}
