"""Job history (2026-11-24, owner): one read-only view that lines up a job's
estimates and POs, Ashley's Job Schedule, the invoice schedule and the crew pay,
to see what really happened and check the schedules against it.

Change orders used to be added to a job as "overage days"; really each one
extended the job. And crew pay was kept by hand on one sheet for the whole job,
so after several change orders it drifted. This puts the pieces side by side:

  phases      the job's runs of work on the synced Job Schedule (gsync_schedule_days).
              A new phase starts after a gap of more than a week, or where the
              sheet's description names a new phase ("Phase 2.1")
  estimates   each accepted estimate's contract labor, split by its line groups and
              placed in a phase: by the phase its lines name, else the pipeline
              target dates, else the first phase after it was accepted
  days        crew-days = contract labor / the job's crew-day rate (the rate the
              estimates are priced at: labor / pipeline labor days, the median);
              mobilization lines are travel, not on-site days
  pay         the bi-weekly ledger: each payday pays the work done through the
              week before (crew invoice date), at the crew-day rate, plus the
              trip's mobilization in its first period; against what the crew
              schedules plan and what QuickBooks paid
  invoices    each estimate's invoice schedule rows vs its QuickBooks invoices

Nothing here writes. The comparisons are estimates of what should have
happened, to review with the office; they never change a schedule.
"""
import re
from collections import Counter, defaultdict
from datetime import date, timedelta
from statistics import median

from sqlalchemy import bindparam, text

from app.gsync.review import _kind
from . import estimates_list as EL

ACCEPTED = ("Accepted", "Converted", "Closed")
DEFAULT_RATE = 1600.0
_PHASE = re.compile(r"\bphases?\s*#?\s*(\d+(?:\.\d+)?)", re.I)
_OTHER_EST = re.compile(r"\b(?:estimate|quote)\s*#?\s*(\d{3,6})\b|\bchange\s*order\b", re.I)
_WS = re.compile(r"\s+")


def _q(sql, *expanding):
    t = text(sql)
    for n in expanding:
        t = t.bindparams(bindparam(n, expanding=True))
    return t


def _d(x):
    if not x:
        return None
    return x if isinstance(x, date) else date.fromisoformat(str(x)[:10])


def _s(x):
    return str(x)[:10] if x else None


def _r2(x):
    return round(float(x or 0), 2)


def _friday_on_or_after(d):
    return d + timedelta(days=(4 - d.weekday()) % 7)


def _tok_match(t, bt):
    """A line's phase token fits a sheet phase: same, or one is the other's sub-phase."""
    if not t or not bt:
        return False
    return t == bt or bt.startswith(t + ".") or t.startswith(bt + ".")


# ---------------------------------------------------------------- the sheet
def _phases(conn, number, since):
    rows = conn.execute(text("""SELECT day, crew, job, descr, extra FROM gsync_schedule_days
        WHERE job LIKE :j AND day >= :since ORDER BY day, crew"""), {"j": f"%{number}%", "since": since}).mappings().all()
    rx = re.compile(rf"\b{re.escape(number)}\b")
    cells = [r for r in rows if rx.search(r["job"] or "")]
    work = []
    off = []
    for c in cells:
        k = _kind(c["descr"] or c["extra"])
        if k == "work":
            work.append(c)
        else:
            off.append(c)
    blocks = []
    for c in work:
        lab = _WS.sub(" ", (c["descr"] or c["extra"] or "").strip())
        m = _PHASE.search(lab)
        tok = m.group(1) if m else None
        b = blocks[-1] if blocks else None
        if b and (c["day"] - b["end"]).days <= 7 and not (tok and b["tok"] and tok != b["tok"]):
            b["end"] = c["day"]
            b["cells"].append(c["day"])
            b["crews"].add((c["crew"] or "").strip())
            b["labels"][lab] += 1
            b["tok"] = b["tok"] or tok
        else:
            blocks.append({"start": c["day"], "end": c["day"], "cells": [c["day"]], "tok": tok,
                           "crews": {(c["crew"] or "").strip()}, "labels": Counter({lab: 1})})
    out = []
    for i, b in enumerate(blocks):
        label = b["labels"].most_common(1)[0][0]
        name = f"Phase {b['tok']}" if b["tok"] else f"Block {i + 1}"
        offs = sum(1 for c in off if b["start"] <= c["day"] <= b["end"])
        out.append({"key": f"b{i}", "name": name, "tok": b["tok"], "label": label,
                    "crews": sorted(x for x in b["crews"] if x), "start": b["start"], "end": b["end"],
                    "cells": sorted(b["cells"]), "work_days": len(b["cells"]), "off_days": offs})
    return out, len(cells) > 0


# ---------------------------------------------------------------- estimates
def _estimates(conn, eid):
    return conn.execute(text("""
        WITH latest AS (
          SELECT t.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(t.doc_number, t.qbo_id) ORDER BY t.id DESC) AS rn
          FROM qbo_transactions t WHERE t.entity_type = 'Estimate' AND t.customer_qbo_id = :p)
        SELECT id, qbo_id, doc_number, txn_date, total_amt,
               JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.TxnStatus')) AS status,
               JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.AcceptedDate')) AS accepted_date
        FROM latest WHERE rn = 1 ORDER BY txn_date, id"""), {"p": eid}).mappings().all()


def _labor_groups(conn, txn_id):
    """The estimate's contract labor per line group, in line order:
    [{name, desc, labor, mob, tok, other}]"""
    rows = conn.execute(text("""SELECT line_level, line_key, parent_line_key, group_item_name, item_name,
               description, amount, cost_amount
        FROM qbo_sales_transaction_lines WHERE transaction_id = :t ORDER BY id"""), {"t": txn_id}).mappings().all()
    groups, by = [], {}
    for r in rows:
        if r["line_level"] == "parent" and r["group_item_name"]:
            g = {"name": r["group_item_name"], "desc": _WS.sub(" ", r["description"] or "").strip(), "labor": 0.0}
            groups.append(g)
            by[r["line_key"]] = g
    for r in rows:
        if not (r["item_name"] or "").startswith("Contract Labor"):
            continue
        amt = float(r["cost_amount"] if r["cost_amount"] is not None else (r["amount"] or 0))
        g = by.get(r["parent_line_key"]) if r["line_level"] == "child" else None
        if g is None:
            g = {"name": r["item_name"], "desc": _WS.sub(" ", r["description"] or "").strip(), "labor": 0.0}
            groups.append(g)
        g["labor"] += amt
    out = []
    for g in groups:
        if abs(g["labor"]) < 0.005:
            continue
        txt = f"{g['name']} {g['desc']}"
        m = _PHASE.search(g["desc"]) or _PHASE.search(g["name"])
        o = _OTHER_EST.search(g["desc"])
        out.append({"name": g["name"], "desc": g["desc"][:160], "labor": round(g["labor"], 2),
                    "mob": bool(re.match(r"\s*mobili", txt, re.I)) or g["name"].lower().startswith("mobili"),
                    "tok": m.group(1) if m else None, "other": bool(o)})
    return out


def _place(est, blocks):
    """Put each labor group of an estimate in a sheet phase. Returns [(group, block_key|None, how)]."""
    written = est["date"]
    ts = est["opp"]["target_start"] if est["opp"] else None

    def near(cands):
        if not cands:
            return None
        if ts:
            return min(cands, key=lambda b: 0 if b["start"] <= ts <= b["end"]
                       else min(abs((b["start"] - ts).days), abs((ts - b["end"]).days)))["key"]
        return cands[0]["key"]

    def by_tok(t):
        # a phase that was over before the estimate was written can't be its phase
        # ("already included in phase 1 and 2 scopes"); "Phase 2" with 2.1 and 2.2
        # on the sheet goes by the pipeline dates
        return near([b for b in blocks if _tok_match(t, b["tok"]) and (not written or b["end"] >= written)])

    placed, prev = [], None
    for g in est["groups"]:
        k = by_tok(g["tok"]) if g["tok"] else None
        if k:
            placed.append([g, k, "phase"]); prev = k
        elif g["tok"] and any(b["tok"] for b in blocks) and not any(_tok_match(g["tok"], b["tok"]) for b in blocks):
            # its lines name a phase the Job Schedule doesn't have (yet): don't guess
            placed.append([g, None, "no_phase"]); prev = "-"
        elif prev == "-" and not g["other"]:
            placed.append([g, None, "no_phase"])      # its trip/extra lines go with it
        elif g["other"] or prev is None:
            placed.append([g, None, "main"])
        else:
            placed.append([g, prev, "follows"])
    # the estimate's main phase: where most of its labor went, else by dates
    net = defaultdict(float)
    for g, k, _ in placed:
        if k:
            net[k] += g["labor"]
    main, how = None, None
    if net and max(net.values()) > 0:
        main, how = max(net.items(), key=lambda kv: kv[1])[0], "phase"
    else:
        acc = est["accepted"] or est["date"]
        cand = [b for b in blocks if not acc or b["end"] >= acc] or blocks
        main, how = near(cand), ("target" if ts else "accepted")
    for p in placed:
        if p[1] is None and p[2] == "main":
            p[1], p[2] = main, how
    return placed


def _rate(ests):
    samples = []
    for e in ests:
        days = float((e["opp"] or {}).get("labor_days") or 0)
        lab = sum(g["labor"] for g in e["groups"] if not g["mob"])
        if days > 0 and lab > 0:
            samples.append(lab / days)
    if len(samples) >= 2:
        return round(median(samples) / 50) * 50, f"the median of {len(samples)} estimates' labor ÷ pipeline labor days"
    return DEFAULT_RATE, "the usual $1,600 a crew-day (not enough estimates with labor days to work it out)"


# ---------------------------------------------------------------- money
def _crew_bills(conn, eid):
    from app.crewcheck import _crews
    company_of, cname, _, by_vendor = _crews(conn)
    if not by_vendor:
        return []
    rows = conn.execute(_q("""
        SELECT t.qbo_id, t.txn_date, t.doc_number, t.vendor_qbo_id, ROUND(SUM(l.amount), 2) AS amt
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE t.entity_type = 'Bill' AND l.line_customer_qbo_id = :e AND t.vendor_qbo_id IN :v
        GROUP BY t.id, t.qbo_id, t.txn_date, t.doc_number, t.vendor_qbo_id ORDER BY t.txn_date""", "v"),
        {"e": eid, "v": list(by_vendor)}).mappings().all()
    return [{"qbo_id": r["qbo_id"], "date": r["txn_date"], "doc": r["doc_number"], "amount": float(r["amt"] or 0),
             "crew": cname.get(by_vendor.get(str(r["vendor_qbo_id"]))) or "crew"}
            for r in rows if abs(float(r["amt"] or 0)) > 0.005]


def _crew_rows(conn, eid):
    return conn.execute(text("""
        SELECT s.id AS sid, s.estimate_qbo_id, s.estimate_doc_number, s.source, s.source_file_name,
               i.pay_date, i.send_invoice_date, i.amount, i.status, i.note
        FROM project_payment_schedules s JOIN project_payment_installments i ON i.schedule_id = s.id
        WHERE s.entity_id = :e ORDER BY i.pay_date IS NULL, i.pay_date, s.id, i.seq"""), {"e": eid}).mappings().all()


def _invoices(conn, eid):
    rows = conn.execute(text("""SELECT qbo_id, doc_number, txn_date, total_amt,
               JSON_EXTRACT(raw_json, '$.Balance') AS bal, JSON_EXTRACT(raw_json, '$.LinkedTxn') AS linked
        FROM qbo_transactions WHERE entity_type = 'Invoice' AND customer_qbo_id = :e ORDER BY txn_date"""), {"e": eid}).mappings().all()
    import json
    out = []
    for r in rows:
        try:
            links = json.loads(r["linked"] or "[]") or []
        except Exception:
            links = []
        ests = [str(x.get("TxnId")) for x in links if x.get("TxnType") == "Estimate"]
        out.append({"qbo_id": str(r["qbo_id"]), "doc": r["doc_number"], "date": _s(r["txn_date"]),
                    "amount": _r2(r["total_amt"]), "balance": _r2(r["bal"]), "estimates": ests})
    return out


def _milestones(conn, eid):
    rows = conn.execute(text("""SELECT s.id AS sid, s.estimate_qbo_id, s.estimate_doc_number, m.seq, m.label, m.amount,
               m.invoice_date, m.due_date, m.expected_paid_date, m.status, m.qbo_invoice_id, m.edited
        FROM project_invoice_schedules s JOIN project_invoice_milestones m ON m.schedule_id = s.id
        WHERE s.entity_id = :e ORDER BY s.id, m.seq"""), {"e": eid}).mappings().all()
    by = defaultdict(list)
    for r in rows:
        by[str(r["estimate_qbo_id"])].append({"seq": r["seq"], "label": r["label"], "amount": _r2(r["amount"]),
            "invoice_date": _s(r["invoice_date"]), "expected_paid": _s(r["expected_paid_date"]),
            "status": r["status"], "qbo_invoice_id": r["qbo_invoice_id"], "edited": bool(r["edited"]),
            "doc": r["estimate_doc_number"]})
    return by


def _app_lines(conn, eid):
    return conn.execute(text("""
        SELECT psi.id, psi.start_date, psi.end_date, COALESCE(psi.overage_days, 0) AS overage, psi.status
        FROM project_schedule_items psi JOIN projects p ON p.id = psi.project_id
        JOIN qbo_customers qc ON qc.id = p.qbo_customer_id
        WHERE qc.qbo_id = :e AND COALESCE(psi.status, '') <> 'canceled' AND psi.start_date IS NOT NULL
        ORDER BY psi.start_date"""), {"e": eid}).mappings().all()


def _spare(finished, ests, hit):
    """A clue for 'done early': a finished phase with Job Schedule days no estimate fills."""
    need = sum(e["days"] for e in ests if e["doc"] in {d for d, _ in hit})
    for b in finished:
        spare = b["work_days"] - b["est_days"]
        if spare > 0 and abs(spare - need) <= 2:
            return (f" (If the work was done early instead: {b['name']} has {spare:g} Job Schedule days no estimate fills, "
                    f"and those estimates need {need:g}.)")
    return ""


# ---------------------------------------------------------------- the view
def history(conn, eid, opp_ids):
    eid = str(eid)
    name = conn.execute(text("SELECT display_name FROM qbo_customers WHERE qbo_id = :e"), {"e": eid}).scalar() or ""
    m = re.match(r"\s*(\d{4})\b", name)
    number = m.group(1) if m else None

    opps = {}
    for r in conn.execute(text("""SELECT id, quote_number, target_start_date, target_end_date, labor_days, travel_days, title
                                  FROM opportunities WHERE project_qbo_id = :e"""), {"e": eid}).mappings().all():
        if r["quote_number"]:
            opps[str(r["quote_number"]).strip()] = {"id": r["id"], "title": r["title"],
                "target_start": r["target_start_date"], "target_end": r["target_end_date"],
                "labor_days": float(r["labor_days"] or 0), "travel_days": float(r["travel_days"] or 0)}

    ov = EL.overview(conn, eid, opp_ids or list(o["id"] for o in opps.values()) or [0])
    po_by = {e["qbo_id"]: e for e in ov["estimates"]}

    ests = []
    for r in _estimates(conn, eid):
        doc = str(r["doc_number"] or "")
        e = {"qbo_id": str(r["qbo_id"]), "doc": doc, "status": r["status"] or "", "date": r["txn_date"],
             "accepted": _d((r["accepted_date"] or "")[:10] or None), "total": _r2(r["total_amt"]),
             "opp": opps.get(doc)}
        e["groups"] = _labor_groups(conn, r["id"]) if e["status"] in ACCEPTED else []
        e["labor"] = round(sum(g["labor"] for g in e["groups"]), 2)
        ests.append(e)
    accepted = [e for e in ests if e["status"] in ACCEPTED]
    since = min([e["date"] for e in accepted if e["date"]] or [date.today()]) - timedelta(days=30)
    blocks, on_sheet = _phases(conn, number, since) if number else ([], False)
    bk = {b["key"]: b for b in blocks}
    rate, rate_from = _rate(accepted)

    # place every labor group
    for b in blocks:
        b.update(parts=[], labor=0.0, mob=0.0, est_days=0.0)
    unplaced = []
    for e in accepted:
        e["parts"] = []
        for g, k, how in (_place(e, blocks) if blocks else [(g, None, None) for g in e["groups"]]):
            days = 0.0 if g["mob"] else round(g["labor"] / rate, 2)
            part = {"doc": e["doc"], "group": g["name"], "desc": g["desc"], "labor": g["labor"], "mob": g["mob"],
                    "days": days, "how": how, "block": k}
            e["parts"].append(part)
            if k:
                b = bk[k]
                b["parts"].append(part)
                b["labor"] += g["labor"]
                b["mob"] += g["labor"] if g["mob"] else 0
                b["est_days"] += days
            else:
                part["why"] = ((f"its lines name Phase {g['tok']}, which isn't on the Job Schedule yet" if g["tok"]
                                else "goes with the lines above, whose phase isn't on the Job Schedule yet") if how == "no_phase"
                               else "no phase on the Job Schedule to put it in")
                unplaced.append(part)

    # app schedule lines per phase (by overlap)
    lines = _app_lines(conn, eid)
    for b in blocks:
        b["app_lines"] = []
    for ln in lines:
        s, en = ln["start_date"], ln["end_date"] or ln["start_date"]
        hit = next((b for b in blocks if s <= b["end"] and en >= b["start"]), None)
        if hit:
            base = sum(1 for d in hit["cells"] if s <= d <= en)
            hit["app_lines"].append({"id": ln["id"], "start": _s(s), "end": _s(en), "overage": int(ln["overage"]),
                                     "base_days": base})

    # ---- pay ledger
    bills = _crew_bills(conn, eid)
    crew = _crew_rows(conn, eid)
    sched_dates = sorted({r["pay_date"] for r in crew if r["pay_date"]})
    for bl in bills:
        near = [p for p in sched_dates if abs((p - bl["date"]).days) <= 6 and p >= bl["date"] - timedelta(days=3)]
        bl["pay_date"] = min(near, key=lambda p: abs((p - bl["date"]).days)) if near else _friday_on_or_after(bl["date"])
    pays = sorted(set(sched_dates) | {bl["pay_date"] for bl in bills})
    last_work = max([b["end"] for b in blocks] or [None]) if blocks else None
    if last_work:
        nxt = (pays[-1] + timedelta(days=14)) if pays else _friday_on_or_after(blocks[0]["start"] + timedelta(days=7))
        while nxt - timedelta(days=7) < last_work + timedelta(days=7) and len(pays) < 200:
            if not pays or nxt > pays[-1]:
                pays.append(nxt)
            nxt += timedelta(days=14)
    cell_block = {}
    for b in blocks:
        for d in b["cells"]:
            cell_block.setdefault(d, []).append(b)
    mob_paid = set()
    periods, prev_cut = [], None
    cum = {"expected": 0.0, "scheduled": 0.0, "paid": 0.0}
    for p in pays:
        cut = p - timedelta(days=7)
        days_by = Counter()
        for b in blocks:
            for d in b["cells"]:
                if (prev_cut is None or d > prev_cut) and d <= cut:
                    days_by[b["key"]] += 1
        mob = 0.0
        for k in days_by:
            if k not in mob_paid:
                mob_paid.add(k)
                mob += bk[k]["mob"]
        nd = sum(days_by.values())
        expected = round(nd * rate + mob, 2)
        srows = [r for r in crew if r["pay_date"] == p]
        prow = [bl for bl in bills if bl["pay_date"] == p]
        sched = round(sum(float(r["amount"] or 0) for r in srows), 2)
        paid = round(sum(bl["amount"] for bl in prow), 2)
        if not (nd or sched or paid):
            prev_cut = cut
            continue
        for k, v in (("expected", expected), ("scheduled", sched), ("paid", paid)):
            cum[k] = round(cum[k] + v, 2)
        periods.append({"pay_date": _s(p), "work_from": _s((prev_cut + timedelta(days=1)) if prev_cut else None),
                        "work_to": _s(cut), "days": nd,
                        "by_phase": [{"name": bk[k]["name"], "days": v} for k, v in days_by.items()],
                        "at_rate": round(nd * rate, 2), "mob": mob, "expected": expected,
                        "scheduled": sched, "scheduled_rows": [{"doc": r["estimate_doc_number"], "amount": _r2(r["amount"]),
                                                                "note": r["note"], "status": r["status"]} for r in srows],
                        "paid": paid, "bills": [{"date": _s(bl["date"]), "amount": bl["amount"], "crew": bl["crew"]} for bl in prow],
                        "future": p > date.today(), "cum": dict(cum)})
        prev_cut = cut
    undated = [{"doc": r["estimate_doc_number"], "amount": _r2(r["amount"]), "note": r["note"], "status": r["status"]}
               for r in crew if not r["pay_date"] and abs(float(r["amount"] or 0)) > 0.005]

    # ---- invoices + crew schedule per estimate
    invs = _invoices(conn, eid)
    ms = _milestones(conn, eid)
    est_ids = {e["qbo_id"] for e in ests}
    crew_by = defaultdict(lambda: {"total": 0.0, "n": 0, "covered": False, "source": None})
    for r in crew:
        c = crew_by[str(r["estimate_qbo_id"])]
        c["total"] = round(c["total"] + float(r["amount"] or 0), 2)
        c["n"] += 1 if abs(float(r["amount"] or 0)) > 0.005 else 0
        c["covered"] = c["covered"] or r["source"] == "sheet_covered"
        c["source"] = r["source_file_name"] or c["source"]
    today = date.today()
    out_ests = []
    for e in ests:
        po = (po_by.get(e["qbo_id"]) or {}).get("po")
        qinv = [i for i in invs if e["qbo_id"] in i["estimates"]]
        invoiced = round(sum(i["amount"] for i in qinv), 2)
        open_bal = round(sum(i["balance"] for i in qinv), 2)
        net = defaultdict(float)
        for p in e.get("parts", []):
            if p["block"]:
                net[p["block"]] += p["labor"]
        # lines that net to $0 in a phase (5184's Phase 2 lines moved to #7103) don't put it there
        phases = sorted((k for k, v in net.items() if abs(v) >= 1), key=lambda k: bk[k]["start"])
        done = bool(phases) and all(bk[k]["end"] < today for k in phases)
        flags = []
        if e["status"] in ACCEPTED and done and invoiced < e["total"] - 1:
            plan = [m for m in ms.get(e["qbo_id"], []) if not m["qbo_invoice_id"]]
            when = min([m["invoice_date"] for m in plan if m["invoice_date"]] or [None])
            flags.append({"tone": "warn", "text": f"Work looks done on the Job Schedule ({bk[phases[-1]]['name']} ended "
                          f"{bk[phases[-1]]['end']:%b %-d}), but ${e['total'] - invoiced:,.0f} isn't invoiced yet"
                          + (f"; the invoice schedule has it for {date.fromisoformat(when):%b %-d, %Y}" if when else
                             "; the invoice schedule has no date for it")})
        c = crew_by.get(e["qbo_id"])
        out_ests.append({
            "qbo_id": e["qbo_id"], "doc": e["doc"], "status": e["status"], "date": _s(e["date"]), "accepted": _s(e["accepted"]),
            "total": e["total"], "labor": e["labor"],
            "days": round(sum(p["days"] for p in e.get("parts", [])), 2),
            "opp": ({"title": e["opp"]["title"], "target_start": _s(e["opp"]["target_start"]), "target_end": _s(e["opp"]["target_end"]),
                     "labor_days": e["opp"]["labor_days"]} if e["opp"] else None),
            "po": ({"document_id": po["document_id"], "filename": po["filename"], "po_number": po["po_number"], "total": po["total"]}
                   if po else None),
            "phases": [bk[k]["name"] for k in phases],
            "parts": [{k: v for k, v in p.items() if k != "block"} | {"phase": bk[p["block"]]["name"] if p["block"] else None}
                      for p in e.get("parts", [])],
            "invoices": qinv, "invoiced": invoiced, "open_balance": open_bal,
            "milestones": ms.get(e["qbo_id"], []),
            "crew": ({"total": c["total"], "n": c["n"], "covered": c["covered"], "source": c["source"]} if c else None),
            "flags": flags,
        })
    # schedules left on estimates no longer on the job in QuickBooks
    orphans = []
    for q, rows_ in ms.items():
        if q not in est_ids:
            orphans.append({"kind": "invoice", "doc": rows_[0]["doc"], "amount": round(sum(m["amount"] for m in rows_), 2),
                            "open": round(sum(m["amount"] for m in rows_ if not m["qbo_invoice_id"]), 2)})
    for q, c in crew_by.items():
        if q not in est_ids and c["total"]:
            doc = next((r["estimate_doc_number"] for r in crew if str(r["estimate_qbo_id"]) == q), None)
            orphans.append({"kind": "crew", "doc": doc, "amount": c["total"], "source": c["source"]})

    # ---- per phase summary + findings
    est_by = {e["doc"]: e for e in accepted}
    out_blocks, findings = [], []
    for b in blocks:
        est_days = round(b["est_days"], 1)
        over = sum(l["overage"] for l in b["app_lines"])
        agg = {}
        for p in b["parts"]:
            a = agg.setdefault(p["doc"], {"doc": p["doc"], "labor": 0.0, "days": 0.0, "mob": 0.0, "how": [], "lines": []})
            a["labor"] += p["labor"]; a["days"] += p["days"]; a["mob"] += p["labor"] if p["mob"] else 0.0
            if p["how"] not in a["how"]:
                a["how"].append(p["how"])
            a["lines"].append({"group": p["group"], "desc": p["desc"], "labor": p["labor"], "days": p["days"], "mob": p["mob"], "how": p["how"]})
        rows_b = [dict(a, labor=round(a["labor"], 2), days=round(a["days"], 2), mob=round(a["mob"], 2))
                  for a in agg.values() if abs(a["labor"]) >= 1]
        base = max(rows_b, key=lambda a: a["labor"])["doc"] if rows_b else None
        def _when(a):
            e = est_by.get(a["doc"]) or {}
            o = e.get("opp") or {}
            return str(o.get("target_start") or e.get("accepted") or e.get("date") or "")
        rows_b.sort(key=lambda a: (a["doc"] != base, _when(a), a["doc"]))
        for a in rows_b:
            a["base"] = a["doc"] == base
            a["target"] = _s(((est_by.get(a["doc"]) or {}).get("opp") or {}).get("target_start"))
        co_docs = [a["doc"] for a in rows_b if not a["base"]]
        fit = est_days - b["work_days"]
        if over and abs(fit) <= 2:
            findings.append({"tone": "info", "text": f"{b['name']}: the app has {over} overage days, but the estimates placed here need "
                             f"{est_days:g} crew-days and the Job Schedule shows {b['work_days']}. The overage looks like "
                             f"change-order days" + (f" ({', '.join('#' + d for d in co_docs)})" if co_docs else "") + ", not real overage."})
        elif fit < -2:
            findings.append({"tone": "warn", "text": f"{b['name']}: the Job Schedule shows {b['work_days']} work days, "
                             f"{-fit:g} more than the {est_days:g} crew-days the estimates placed here need: real overage, or an estimate placed elsewhere."})
        elif fit > 2:
            findings.append({"tone": "warn", "text": f"{b['name']}: the estimates placed here need {est_days:g} crew-days, "
                             f"{fit:g} more than the {b['work_days']} work days on the Job Schedule."})
        out_blocks.append({"key": b["key"], "name": b["name"], "label": b["label"], "crews": b["crews"],
                           "start": _s(b["start"]), "end": _s(b["end"]), "work_days": b["work_days"], "off_days": b["off_days"],
                           "est_days": est_days, "labor": round(b["labor"], 2), "mob": round(b["mob"], 2),
                           "done": b["end"] < today, "app_lines": b["app_lines"],
                           "estimates": rows_b})
    finished = [b for b in out_blocks if b["done"]]
    paid_total = round(sum(bl["amount"] for bl in bills), 2)
    labor_done = round(sum(b["labor"] for b in finished), 2)
    if finished and bills:
        diff = round(paid_total - labor_done, 2)
        findings.append({"tone": "good" if abs(diff) < 1 else "warn",
                         "text": f"The crew was paid ${paid_total:,.2f}; the contract labor of the finished phases "
                                 f"({', '.join(b['name'] for b in finished)}) is ${labor_done:,.2f}"
                                 + (" — they match." if abs(diff) < 1 else f" — {'over' if diff > 0 else 'under'} by ${abs(diff):,.2f}.")})
        if diff > 1:
            # paid ahead: is the difference exactly the labor of estimates planned for a later phase?
            from itertools import combinations
            later = [(e["doc"], e["labor"]) for e in out_ests if e["labor"] > 0 and e["phases"]
                     and all(not next(b for b in out_blocks if b["name"] == n)["done"] for n in e["phases"])]
            hit = next((c for n in (1, 2, 3) for c in combinations(later, n) if abs(sum(x[1] for x in c) - diff) < 1), None)
            if hit:
                docs = " + ".join(f"#{d}" for d, _ in hit)
                findings.append({"tone": "warn", "text": f"The ${diff:,.2f} extra is exactly the contract labor of {docs}, which "
                                 f"{'is' if len(hit) == 1 else 'are'} planned for a later phase, so the crew was paid in advance for it. "
                                 "When that phase's crew pay is scheduled, count this as already paid so it isn't paid twice."
                                 + _spare(finished, out_ests, hit)})
    for o in orphans:
        findings.append({"tone": "bad", "text": (f"#{o['doc']}'s invoice schedule (${o['amount']:,.2f}, ${o['open']:,.2f} not invoiced)" if o["kind"] == "invoice"
                         else f"#{o['doc']}'s crew schedule (${o['amount']:,.2f})") + " is on an estimate that's no longer on this job in QuickBooks."})
    return {"job_number": number, "name": name, "on_sheet": on_sheet, "rate": rate, "rate_from": rate_from,
            "phases": out_blocks, "estimates": out_ests, "unplaced": unplaced, "periods": periods, "undated": undated,
            "bills_total": paid_total, "orphans": orphans, "findings": findings,
            "po_files": [{"document_id": p["document_id"], "filename": p["filename"], "po_number": p["po_number"],
                          "total": p.get("total"), "estimates": p.get("estimates", [])} for p in ov["po_files"]]}
