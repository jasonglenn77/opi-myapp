"""
Progress checks: are a job's financials moving with the job?

Runs on every project. Jobs at or above the size rule (or switched on by hand)
also need a sign-off at each checkpoint: 25, 50, 75 and 100 percent of the
scheduled job days.

Costs don't arrive evenly, so a straight line would call most jobs wrong. Each
cost type is compared to the job's own plan:

  crew labor        Payment Schedule rows dated up to the check
  other costs       the expense schedule the app already spreads by measured
                    timing, moved back by how long that category takes to reach
                    QuickBooks (a bill for this week isn't expected to be there yet)
  invoices          planned invoice dates

  known cost = QuickBooks + entries waiting on QuickBooks (receipts, typed
               entries, card charges given a job in the app)
  budget     = accepted estimate + Pending estimates

  over     known cost above budget by more than the over tolerance
  ahead    known cost above the plan by more than the variance tolerance
  behind   known cost below the plan by more than the variance tolerance. Often
           this means "not recorded yet", not "saved money".

Confidence comes from the capture matrix (expense_capture): where most dollars
never get a job tag, a low number proves little, and the page says so.
"""
import time
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import text

from app.assumptions import calibrate as CAL
from app.db import engine
from app.jobcost import service as JC
from app.receipts import matching

MILESTONES = (25, 50, 75, 100)
RECENT_FINISHED_DAYS = 180
SNAP_KEY = "progress"

DEFAULT_RULES = {"signoff_min": 500000, "over_pct": 0.10, "variance_pct": 0.20, "variance_abs": 1000}

# (bucket, job cost categories, expense schedule category)
BUCKETS = [("Crew labor", ("Crew labor",), None), ("Rentals & lifts", ("Lifts", "Other rentals"), "Rentals"),
           ("Materials", ("Materials",), "Materials"), ("Lodging", ("Lodging",), "Lodging"),
           ("Propane", ("Propane",), "Propane"), ("Travel", ("Travel",), "Travel")]
BUCKET_OF = {c: b for b, cats, _ in BUCKETS for c in cats}
PLAN_OF = {p: b for b, _, p in BUCKETS if p}
STATUS_RANK = {"over": 0, "ahead": 1, "behind": 2, "ok": 3}


def rules(conn=None):
    def read(c):
        r = c.execute(text("SELECT override_val FROM forecast_assumptions WHERE akey = 'progress_rules'")).scalar()
        return {**DEFAULT_RULES, **{k: v for k, v in (CAL._load(r) or {}).items() if v is not None}}
    if conn is not None:
        return read(conn)
    with engine.connect() as c:
        return read(c)


def _confidence(conn):
    cap = CAL.expense_capture(conn)
    out = {}
    for b, cats, _ in BUCKETS:
        rows = [cap[c] for c in cats if c in cap]
        tagged = sum(r["tagged"] for r in rows)
        total = tagged + sum(r["untagged"] for r in rows)
        share = tagged / total if total else None
        lag = max((r["entry_lag_days"] or 0 for r in rows), default=0)
        level = "unknown" if share is None else "high" if share >= 0.9 else "medium" if share >= 0.7 else "low"
        out[b] = {"tagged_share": round(share, 3) if share is not None else None, "entry_lag_days": lag, "level": level}
    return out


def _series(conn, ids):
    """Dated plan and actual rows per job and bucket, plus invoices."""
    from sqlalchemy import bindparam
    plan, act = defaultdict(list), defaultdict(list)
    inv_plan, inv_act = defaultdict(list), defaultdict(list)
    q = lambda sql: text(sql).bindparams(bindparam("ids", expanding=True))
    for r in conn.execute(q("""
        SELECT s.entity_id, i.pay_date, i.amount FROM project_payment_installments i
        JOIN project_payment_schedules s ON s.id = i.schedule_id
        WHERE s.entity_id IN :ids AND i.pay_date IS NOT NULL AND i.amount <> 0
    """), {"ids": ids}).all():
        plan[(str(r[0]), "Crew labor")].append((r[1], float(r[2])))
    for r in conn.execute(q("""
        SELECT entity_id, category, week_of, amount FROM project_expense_installments
        WHERE entity_id IN :ids AND week_of IS NOT NULL
    """), {"ids": ids}).all():
        b = PLAN_OF.get(r[1])
        if b:
            plan[(str(r[0]), b)].append((r[2], float(r[3] or 0)))
    for r in conn.execute(q("""
        SELECT l.line_customer_qbo_id, t.txn_date,
               COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')),
                 SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')), ':', 1)) AS item,
               l.amount
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE l.line_customer_qbo_id IN :ids AND t.entity_type IN ('Bill', 'Purchase')
    """), {"ids": ids}).all():
        b = BUCKET_OF.get(JC.category_of(r[2]))
        if b and r[1]:
            act[(str(r[0]), b)].append((r[1], float(r[3] or 0)))
    for r in conn.execute(q("""
        SELECT s.entity_id, m.invoice_date, m.amount FROM project_invoice_milestones m
        JOIN project_invoice_schedules s ON s.id = m.schedule_id
        WHERE s.entity_id IN :ids AND m.invoice_date IS NOT NULL
    """), {"ids": ids}).all():
        inv_plan[str(r[0])].append((r[1], float(r[2] or 0)))
    for r in conn.execute(q("""
        SELECT customer_qbo_id, txn_date, total_amt FROM qbo_transactions
        WHERE customer_qbo_id IN :ids AND entity_type = 'Invoice' AND total_amt > 0
    """), {"ids": ids}).all():
        inv_act[str(r[0])].append((r[1], float(r[2] or 0)))
    return plan, act, inv_plan, inv_act


def _through(rows, d):
    return sum(a for x, a in rows if x <= d)


def status_of(known, planned, budget, rl):
    if budget > 0 and known > budget * (1 + rl["over_pct"]):
        return "over"
    gap = known - planned
    if planned > 0 and abs(gap) > max(rl["variance_abs"], rl["variance_pct"] * planned):
        return "ahead" if gap > 0 else "behind"
    return "ok"


def data_sig():
    with engine.connect() as conn:
        return JC.data_sig() + "|" + "|".join(str(conn.execute(text(q)).scalar()) for q in (
            "SELECT CONCAT(COUNT(*), '/', COALESCE(SUM(amount), 0)) FROM project_payment_installments",
            "SELECT CONCAT(COUNT(*), '/', COALESCE(SUM(amount), 0), '/', COALESCE(MAX(updated_at), '')) FROM project_expense_installments",
            "SELECT CONCAT(COUNT(*), '/', COALESCE(SUM(amount), 0)) FROM project_invoice_milestones",
            "SELECT CONCAT(COUNT(*), '/', COALESCE(SUM(status = 'allocated'), 0), '/', COALESCE(SUM(amount), 0)) FROM receipts",
            "SELECT override_val FROM forecast_assumptions WHERE akey = 'progress_rules'"))


def build():
    today = date.today()
    cut = str(today - timedelta(days=RECENT_FINISHED_DAYS))
    jobs = [j for j in JC.dataset()["jobs"] if j["state"] in ("active", "upcoming") or j["end"] >= cut]
    ids = [j["id"] for j in jobs] or ["-"]
    with engine.connect() as conn:
        rl = rules(conn)
        conf = _confidence(conn)
        plan, act, inv_plan, inv_act = _series(conn, ids)
        waiting = matching.open_totals(conn)
    out = []
    for j in jobs:
        s, e = date.fromisoformat(j["start"]), date.fromisoformat(j["end"])
        span = max(1, (e - s).days)
        pct_time = 0.0 if today < s else min(1.0, (today - s).days / span)
        buckets = []
        for b, cats, _ in BUCKETS:
            est = sum(j["est"].get(c, 0.0) for c in cats)
            pend = sum((j.get("pend") or {}).get(c, 0.0) for c in cats)
            actual = sum(j["act"].get(c, 0.0) for c in cats)
            entries = sum(waiting.get(j["id"], {}).get(c, 0.0) for c in cats)
            p = plan.get((j["id"], b), [])
            lag = conf[b]["entry_lag_days"] if b != "Crew labor" else 0
            planned = _through(p, today - timedelta(days=int(lag or 0)))
            if not (est or pend or actual or entries or p):
                continue
            known = actual + entries
            st = status_of(known, planned, est + pend, rl) if j["state"] != "upcoming" else "ok"
            buckets.append({"bucket": b, "budget": round(est, 2), "pending": round(pend, 2), "planned": round(planned, 2),
                            "plan_total": round(sum(a for _, a in p), 2), "actual": round(actual, 2), "entries": round(entries, 2),
                            "known": round(known, 2), "status": st, "confidence": conf[b]["level"],
                            "tagged_share": conf[b]["tagged_share"], "entry_lag_days": lag})
        points = []
        for m in MILESTONES:
            d = e if m == 100 else s + timedelta(days=round(span * m / 100))
            reached = d <= today
            checks = []
            for b, cats, _ in BUCKETS:
                planned_at = _through(plan.get((j["id"], b), []), d)
                actual_at = _through(act.get((j["id"], b), []), d)
                total = sum(j["est"].get(c, 0.0) + (j.get("pend") or {}).get(c, 0.0) for c in cats)
                if planned_at or actual_at:
                    checks.append({"bucket": b, "planned": round(planned_at, 2), "actual": round(actual_at, 2),
                                   "status": status_of(actual_at, planned_at, total, rl) if reached else None})
            ip, ia = _through(inv_plan.get(j["id"], []), d), _through(inv_act.get(j["id"], []), d)
            settling = reached and (today - d).days < 18
            points.append({"milestone": m, "date": str(d), "reached": reached, "settling": settling, "checks": checks,
                           "invoice_planned": round(ip, 2), "invoiced": round(ia, 2)})
        inv_now = _through(inv_plan.get(j["id"], []), today)
        worst = min((x["status"] for x in buckets), key=lambda v: STATUS_RANK[v], default="ok")
        lab = next((x for x in buckets if x["bucket"] == "Crew labor"), None)
        cost_budget = sum(x["budget"] + x["pending"] for x in buckets)
        out.append({"id": j["id"], "name": j["name"], "pm": j["pm"], "state": j["state"], "start": j["start"], "end": j["end"],
                    "contract": j.get("contract", 0.0), "pending_contract": j.get("pending_contract", 0.0),
                    "invoiced": j.get("invoiced", 0.0), "open_ar": j.get("open_ar", 0.0), "invoice_planned": round(inv_now, 2),
                    "pct_time": round(pct_time, 3),
                    "pct_invoiced": round(j.get("invoiced", 0.0) / j["contract"], 3) if j.get("contract") else None,
                    "pct_labor": round(lab["known"] / (lab["budget"] + lab["pending"]), 3) if lab and lab["budget"] + lab["pending"] else None,
                    "pct_cost": round(sum(x["known"] for x in buckets) / cost_budget, 3) if cost_budget else None,
                    "status": worst, "buckets": buckets, "points": points})
    return {"built": time.time(), "jobs": out, "rules": rl, "confidence": conf}


def refresh_snapshot():
    from app import snapshots
    return snapshots.rebuild(SNAP_KEY, build, data_sig)


def apply_review(d):
    """Sign-off rule, the per-project switch and the saved sign-offs (live)."""
    with engine.connect() as conn:
        rl = rules(conn)
        setting = {r[0]: r[1] for r in conn.execute(text("SELECT entity_id, signoff FROM progress_settings")).all()}
        signed = {(r["entity_id"], r["milestone"]): dict(r) for r in conn.execute(text(
            "SELECT entity_id, milestone, decision, note, signed_by, signed_at FROM progress_signoffs")).mappings()}
    jobs = []
    for j in d["jobs"]:
        sw = setting.get(j["id"])
        by_size = j["contract"] >= rl["signoff_min"]
        required = bool(sw) if sw is not None else by_size
        pts, due = [], 0
        latest = max((p["milestone"] for p in j["points"] if p["reached"]), default=None)
        for p in j["points"]:
            s = signed.get((j["id"], p["milestone"]))
            n = {**p, "signoff": ({"decision": s["decision"], "note": s["note"], "by": s["signed_by"], "at": str(s["signed_at"])} if s else None)}
            # only the newest checkpoint falls due: signing it covers the ones before it
            n["due"] = required and p["milestone"] == latest and not s
            due += 1 if n["due"] else 0
            pts.append(n)
        jobs.append({**j, "points": pts, "signoff_required": required, "by_size": by_size,
                     "signoff_switch": None if sw is None else bool(sw), "signoffs_due": due})
    jobs.sort(key=lambda j: (-j["signoffs_due"], STATUS_RANK[j["status"]], -j["contract"]))
    return {**d, "jobs": jobs, "rules": rl}


def dataset(force=False):
    from app import snapshots
    data, meta = snapshots.serve(SNAP_KEY, build, data_sig, max_age=1800, force=force)
    return {**apply_review(data), "snapshot": meta}
