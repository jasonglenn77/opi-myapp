"""
Data Review — every place OPI's Google sheets, QuickBooks and the app disagree,
as a worklist for the office. Nothing here changes data: each item says what
differs, which side is probably right, and where to fix it. Staff mark items
Fixed / Ignored (data_review_state); an Ignored item re-opens if the
difference changes (fingerprint).

Categories
  todo      To-do: won quotes that still need a QuickBooks project.
  pipeline  B151 vs QBO estimates vs the app's Pipeline.
  schedule  Job Schedule (Drive) vs Assignments / Schedule in the app.
"""
import collections
import hashlib
import json
import re
from datetime import date, timedelta

from sqlalchemy import text

from app.db import engine
from . import sheets

# Job Schedule cell colours → PM first name ("Color Code" tab).
PM_FILL = {"FFFF0000": "Kelly", "FFFF00FF": "Leonardo", "FFA4C2F4": "Tim", "FFF9CB9C": "Amy", "FF6AA84F": "Jack"}
SEV_ORDER = {"high": 0, "medium": 1, "low": 2}


def _fp(*parts):
    return hashlib.sha1(json.dumps(parts, default=str, sort_keys=True).encode()).hexdigest()[:16]


def _item(cat, typ, key, sev, title, detail, *, fix=None, link=None, sheet=None, app=None, qbo=None, ref=None, fp=None):
    return {"key": f"{cat}:{typ}:{key}", "category": cat, "type": typ, "severity": sev, "title": title,
            "detail": detail, "fix": fix, "link": link, "sheet": sheet, "app": app, "qbo": qbo, "ref": ref,
            "fingerprint": fp or _fp(sheet, app, qbo)}


def _money(v):
    return f"${float(v):,.0f}" if v is not None else "—"


def _md(d):
    if not d:
        return "—"
    d = d if isinstance(d, date) else date.fromisoformat(str(d)[:10])
    return f"{d.month}/{d.day}/{str(d.year)[2:]}"


def _won(ps):
    p = (ps or "").lower()
    return "won" in p or "red flag" in p


def _open(ps):
    p = (ps or "").lower()
    return not (_won(ps) or "lost" in p or "inactive" in p)


# ── QBO estimate groups ──────────────────────────────────────────────────────

def _estimates(conn):
    g = collections.defaultdict(list)
    for r in conn.execute(text("""
        SELECT t.qbo_id, t.doc_number, t.txn_date, t.total_amt,
               JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) AS st,
               JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.CustomerMemo.value')) AS memo,
               c.qbo_id AS cust_qbo_id, c.display_name AS cust, c.is_project, c.parent_qbo_id
        FROM qbo_transactions t JOIN qbo_customers c ON c.qbo_id = t.customer_qbo_id
        WHERE t.entity_type = 'Estimate' AND t.doc_number IS NOT NULL
    """)).mappings():
        g[r["doc_number"].strip()].append(dict(r))
    return g


def _recurring_series(ests):
    """Estimates QBO re-creates on a schedule: same customer + total + memo,
    3+ copies. Returns {doc_number: series_id} and the series list."""
    groups = collections.defaultdict(list)
    for doc, copies in ests.items():
        for c in copies:
            if c["is_project"] or not c["total_amt"]:
                continue
            groups[(c["cust_qbo_id"], float(c["total_amt"]), (c["memo"] or "")[:120])].append((c["txn_date"], doc))
    series, by_doc = [], {}
    for (cust, total, memo), lst in groups.items():
        docs = sorted(set(d for _, d in lst), key=lambda d: (len(d), d))
        if len(docs) >= 3:
            sid = len(series)
            cust_name = next(c["cust"] for d in docs for c in ests[d] if c["cust_qbo_id"] == cust)
            series.append({"customer": cust_name, "total": total, "memo": memo, "docs": docs,
                           "first": min(t for t, _ in lst), "last": max(t for t, _ in lst)})
            for d in docs:
                by_doc[d] = sid
    return by_doc, series


# ── pipeline + to-do ─────────────────────────────────────────────────────────

def pipeline_items(conn):
    rows = sheets.load_b151(conn)
    if not rows:
        return [], {"b151_rows": 0}
    ests = _estimates(conn)
    rec_by_doc, series = _recurring_series(ests)
    opps = {o["quote_number"].strip(): dict(o) for o in conn.execute(text(
        "SELECT id, quote_number, pipeline_status, project_qbo_id FROM opportunities WHERE quote_number IS NOT NULL")).mappings()}
    today = date.today()
    out = []
    by_q = collections.defaultdict(list)
    for r in rows:
        by_q[r["quote"]].append(r)

    for q, rs in by_q.items():
        r = rs[0]
        ps = r.get("status")
        label = f"#{q} {r.get('customer') or ''} — {r.get('description') or ''}".strip(" —")
        copies = ests.get(q, [])
        proj = [c for c in copies if c["is_project"]]
        acc = [c for c in copies if c["st"] in ("Accepted", "Converted")]
        opp = opps.get(q)
        ref = {"quote": q, "opp_id": opp["id"] if opp else None, "b151_row": r["row"]}

        if len(rs) > 1:
            out.append(_item("pipeline", "duplicate_row", q, "medium", f"Quote #{q} is on the B151 {len(rs)} times",
                             "Rows " + ", ".join(str(x["row"]) for x in rs) + ": " +
                             " | ".join(f"{x.get('status')} · {x.get('customer')} · {_money(x.get('tcv'))}" for x in rs),
                             fix="Keep one row in the B151 (or give the other job its own quote #).",
                             sheet=[x["row"] for x in rs], ref=ref))

        if _won(ps):
            od = r.get("order_date")
            recent = (od and od >= str(today - timedelta(days=365))) or (r.get("end") and r.get("end") >= str(today - timedelta(days=60)))
            # To-do is for firm wins only (100% Won) — Red Flag jobs aren't ready for a project yet.
            if not proj and recent and (ps or "").startswith("100%"):
                out.append(_item("todo", "create_qbo_project", q, "high",
                                 f"Create the QuickBooks project for #{q}",
                                 f"{label}. Won on the B151 ({ps}, ordered {_md(od)}, {_money(r.get('order_value') or r.get('tcv'))}) "
                                 f"but no QuickBooks project carries estimate #{q} yet"
                                 + (" — the estimate is still on the contact only." if copies else ", and the estimate isn't in QuickBooks."),
                                 fix="In QuickBooks: create the project under the customer and copy estimate "
                                     f"#{q} onto it (Accepted). It shows up here as done after the next sync.",
                                 link="#/pipeline", sheet=ps, qbo=[c["st"] for c in copies], ref=ref))
            elif proj and not acc and any(c["st"] == "Rejected" for c in proj):
                out.append(_item("pipeline", "won_but_rejected", q, "medium", f"#{q} is Won on the B151 but Rejected in QuickBooks",
                                 f"{label}. The project copy of estimate #{q} is marked Rejected.",
                                 fix="Set the estimate to Accepted in QuickBooks — or correct the B151 status.",
                                 sheet=ps, qbo=[c["st"] for c in proj], ref=ref))
        elif acc:
            out.append(_item("pipeline", "accepted_not_won", q, "high", f"#{q} is accepted in QuickBooks but \"{ps}\" on the B151",
                             f"{label}. QuickBooks shows estimate #{q} {acc[0]['st']} ({_money(acc[0]['total_amt'])}"
                             f"{' on project ' + acc[0]['cust'] if acc[0]['is_project'] else ''}).",
                             fix="Update the B151 status to Won (or Red Flag) — the Pipeline follows the B151.",
                             sheet=ps, qbo=acc[0]["st"], ref=ref))

        if not copies and (_open(ps) or _won(ps)):
            out.append(_item("pipeline", "not_in_qbo", q, "low" if not _won(ps) else "medium",
                             f"#{q} is on the B151 but not in QuickBooks",
                             f"{label} ({ps}). No QuickBooks estimate is numbered {q}"
                             + (" — not a whole number, likely a typo or a phase suffix." if not re.fullmatch(r"\d+", q) else "."),
                             fix="Check the quote # in the B151, or create the estimate in QuickBooks.", sheet=ps, ref=ref))

        if copies:
            if _won(ps) and acc:
                q_total = sum(float(c["total_amt"] or 0) for c in acc if c["is_project"]) or max(float(c["total_amt"] or 0) for c in acc)
                s_total = r.get("order_value") or r.get("tcv")
                what = "Order value"
            elif _open(ps):
                live = [c for c in copies if not c["is_project"]] or copies
                q_total = float(max(live, key=lambda c: str(c["txn_date"]))["total_amt"] or 0)
                s_total = r.get("tcv")
                what = "Contract value"
            else:
                q_total = s_total = None
            try:
                s_total = float(s_total) if s_total not in (None, "") else None
            except (TypeError, ValueError):
                s_total = None
            if q_total is not None and s_total is not None and abs(q_total - s_total) > max(1.0, 0.005 * abs(q_total)):
                sev = "medium" if abs(q_total - s_total) >= 10000 else "low"
                out.append(_item("pipeline", "value_differs", q, sev, f"#{q}: {what.lower()} differs — B151 {_money(s_total)} vs QuickBooks {_money(q_total)}",
                                 f"{label} ({ps}).",
                                 fix="Update whichever is out of date. The Revenue Forecast uses QuickBooks for won jobs and the B151 for open quotes.",
                                 sheet=s_total, qbo=q_total, ref=ref))

        try:
            tcv = float(r.get("tcv") or 0)
        except (TypeError, ValueError):
            tcv = 0
        if tcv < 0:
            out.append(_item("pipeline", "negative_value", q, "medium", f"#{q} has a negative contract value on the B151 ({_money(tcv)})",
                             label, fix="Fix the sign in the B151.", sheet=tcv, ref=ref))
        if (_open(ps) or _won(ps)) and not r.get("start"):
            out.append(_item("pipeline", "missing_dates", q, "low", f"#{q} has no estimated start date",
                             f"{label} ({ps}). It can't be placed in a month on the Revenue Forecast.",
                             fix="Enter the estimated start and end dates in the B151.", ref=ref))

    # QBO quotes the B151 doesn't have (recent, priced, not change orders / recurring copies)
    by_project = collections.defaultdict(set)
    for doc, copies in ests.items():
        for c in copies:
            if c["is_project"]:
                by_project[c["cust_qbo_id"]].add(doc)
    cutoff = today - timedelta(days=120)
    for doc, copies in ests.items():
        if doc in by_q or doc in rec_by_doc or not re.fullmatch(r"\d+", doc):
            continue
        first = min(c["txn_date"] for c in copies if c["txn_date"]) if any(c["txn_date"] for c in copies) else None
        if not first or first < cutoff or max(float(c["total_amt"] or 0) for c in copies) <= 0:
            continue
        if all(c["is_project"] for c in copies) and any(
                int(o) < int(doc) for c in copies for o in by_project[c["cust_qbo_id"]] if o.isdigit()):
            continue   # change order on an existing project
        c0 = copies[0]
        out.append(_item("pipeline", "missing_from_b151", doc, "medium" if c0["st"] in ("Accepted", "Converted") else "low",
                         f"QuickBooks estimate #{doc} isn't on the B151",
                         f"{c0['cust']} · {_money(c0['total_amt'])} · {c0['st']} · {_md(first)}"
                         + (f" · \"{(c0['memo'] or '').splitlines()[0][:80]}\"" if c0["memo"] else ""),
                         fix="Add the quote to the B151 so the Pipeline and the forecast include it.",
                         qbo=c0["st"], ref={"quote": doc}))

    for i, srs in enumerate(series):
        if srs["last"] < today - timedelta(days=62):
            continue
        out.append(_item("pipeline", "recurring_estimate", f"{srs['customer']}|{srs['total']}", "high",
                         f"QuickBooks keeps re-creating a {_money(srs['total'])} estimate for {srs['customer']}",
                         f"{len(srs['docs'])} copies since {_md(srs['first'])} (latest {_md(srs['last'])}): "
                         f"#{', #'.join(srs['docs'][-6:])}. \"{srs['memo'][:90]}\". This is a recurring-transaction "
                         "template, not new quotes — each copy also takes a quote number.",
                         fix="In QuickBooks: Settings → Recurring transactions → delete (or pause) this estimate template.",
                         qbo=srs["docs"], ref={"quotes": srs["docs"]}, fp=_fp(srs["total"], srs["customer"])))
    return out, {"b151_rows": len(rows)}


# ── schedule ─────────────────────────────────────────────────────────────────

def _norm_slot(code):
    m = re.fullmatch(r"([A-Z]+?)(\d*)", (code or "").upper())
    if not m:
        return None
    pre, n = m.group(1), m.group(2) or "1"
    if pre in ("ABR", "ABM"):     # Abraham Rangel's crews are company AB in the app
        pre = "AB"
    return pre, f"{pre}{int(n) if n != '0' else 1}"


def _kind(desc):
    d = (desc or "").lower()
    for k, w in (("nowork", "no work"), ("na", "not available"), ("weather", "weather"), ("pulled", "pulled off")):
        if w in d:
            return k
    return "travel" if d.startswith("travel") else "work"


def _segments(days):
    segs = []
    for d in sorted(days):
        if segs and (d - segs[-1][-1]).days <= 7:
            segs[-1].append(d)
        else:
            segs.append([d])
    return segs


def schedule_items(conn):
    cells = conn.execute(text("SELECT day, crew, job, descr, extra, job_fill FROM gsync_schedule_days")).mappings().all()
    if not cells:
        return [], {"schedule_cells": 0}
    today = date.today()
    win = today - timedelta(days=45)
    data_first = min(c["day"] for c in cells)   # the synced copy starts at its oldest tab
    jobs = collections.defaultdict(lambda: {"days": collections.defaultdict(set), "desc": collections.Counter(), "pm": collections.Counter()})
    for c in cells:
        k = _kind(c["descr"] or c["extra"])
        if k != "work":   # travel, not available, no work, weather, pulled off
            continue
        for j in re.findall(r"\b(\d{4})\b", c["job"] or ""):
            J = jobs[j]
            J["days"][c["day"]].add(c["crew"])
            if c["descr"]:
                J["desc"][c["descr"]] += 1
            if c["job_fill"] in PM_FILL:
                J["pm"][PM_FILL[c["job_fill"]]] += 1

    projects = {}
    for r in conn.execute(text("""
        SELECT qc.qbo_id, qc.display_name, p.id AS pid
        FROM qbo_customers qc LEFT JOIN projects p ON p.qbo_customer_id = qc.id
        WHERE qc.is_project = 1
    """)).mappings():
        m = re.match(r"\s*(\d{4})\b", r["display_name"] or "")
        if m:
            projects.setdefault(m.group(1), dict(r))
    items = collections.defaultdict(list)
    for r in conn.execute(text("""
        SELECT psi.id, psi.project_id, psi.status, psi.start_date, psi.end_date, COALESCE(psi.overage_days, 0) od,
               psi.updated_at,
               (SELECT GROUP_CONCAT(COALESCE(w.slot_code, wc.code) ORDER BY w.id) FROM project_schedule_item_work_crews w
                  LEFT JOIN work_crews wc ON wc.id = w.company_id
                 WHERE w.schedule_item_id = psi.id AND w.unassigned_at IS NULL) AS crews,
               (SELECT GROUP_CONCAT(pm.first_name ORDER BY m.is_primary DESC) FROM project_schedule_item_project_managers m
                  JOIN project_managers pm ON pm.id = m.project_manager_id
                 WHERE m.schedule_item_id = psi.id AND m.unassigned_at IS NULL) AS pms
        FROM project_schedule_items psi WHERE psi.status <> 'canceled'
    """)).mappings():
        it = dict(r)
        it["eend"] = (it["end_date"] + timedelta(days=int(it["od"]))) if it["end_date"] else None
        items[it["project_id"]].append(it)

    out = []
    for j, J in sorted(jobs.items()):
        # whole visits that reach the window (a visit that started before it
        # keeps its real first day, as the Job Schedule import writes it)
        segs = [s for s in _segments(J["days"]) if s[-1] >= win]
        days = [d for s in segs for d in s]
        if not days:
            continue
        p = projects.get(j)
        name = p["display_name"] if p else (J["desc"].most_common(1)[0][0] if J["desc"] else f"Job {j}")
        link = f"#/entity/project/{p['qbo_id']}" if p else None
        ref = {"job": j, "qbo_id": p["qbo_id"] if p else None}
        sheet_crews = {_norm_slot(c) for d in days for c in J["days"][d]} - {None}
        s_first, s_last = min(days), max(days)
        if not p:
            out.append(_item("schedule", "not_in_app", j, "high", f"Job {j} is on the Job Schedule but isn't a project in the app",
                             f"{name}: {_md(s_first)} – {_md(s_last)} on the sheet.",
                             fix="Create the project in QuickBooks (it syncs into the app), then set its Assignment.",
                             sheet=[str(s_first), str(s_last)], ref=ref))
            continue
        its = [it for it in items.get(p["pid"], [])]
        dated = [it for it in its if it["start_date"]]
        relevant = [it for it in dated if (it["eend"] or it["start_date"]) >= s_first]
        if not dated:
            out.append(_item("schedule", "undated", j, "high", f"{name}: scheduled on the sheet, no dates in the app",
                             f"Sheet: {', '.join(f'{_md(s[0])} – {_md(s[-1])}' for s in segs)} with "
                             f"{', '.join(sorted(c for _, c in sheet_crews)) or 'no crew'}.",
                             fix="Open the project's Assignment and enter these dates and crews.", link=link,
                             sheet=[[str(s[0]), str(s[-1])] for s in segs], ref=ref))
            continue
        # dates: whole-job window first/last
        a_first = min(it["start_date"] for it in relevant or dated)
        a_last = max((it["eend"] or it["start_date"]) for it in relevant or dated)
        ds, de = (a_first - s_first).days, (a_last - s_last).days
        if s_first <= data_first + timedelta(days=6) and a_first < s_first:
            ds = 0   # the visit began before the oldest synced tab: the sheet's true start is unknown
        worst = max(abs(ds), abs(de))
        if worst:
            sev = "low" if worst <= 2 else "medium" if worst <= 14 else "high"
            out.append(_item("schedule", "dates", j, sev,
                             f"{name}: dates differ by up to {worst} day{'s' if worst != 1 else ''}",
                             f"Sheet {_md(s_first)} – {_md(s_last)} · App {_md(a_first)} – {_md(a_last)} "
                             f"(start {'+' if ds > 0 else ''}{ds}d, end {'+' if de > 0 else ''}{de}d).",
                             fix="Update the Assignment dates (or the sheet, if the app is right).", link=link,
                             sheet=[str(s_first), str(s_last)], app=[str(a_first), str(a_last)], ref=ref))
        if len(segs) > len(relevant or dated):
            out.append(_item("schedule", "phases", j, "medium",
                             f"{name}: the sheet has {len(segs)} separate visits, the app has {len(relevant or dated)}",
                             "Sheet visits: " + ", ".join(f"{_md(s[0])} – {_md(s[-1])}" for s in segs) + ".",
                             fix="Add a schedule line in the Assignment for each return trip / phase.", link=link,
                             sheet=[[str(s[0]), str(s[-1])] for s in segs], app=len(relevant or dated), ref=ref))
        app_crews = {_norm_slot(c) for it in (relevant or dated) for c in (it["crews"] or "").split(",") if c} - {None}
        if sheet_crews != app_crews:
            s_slots, a_slots = {s for _, s in sheet_crews}, {s for _, s in app_crews}
            s_co, a_co = {c for c, _ in sheet_crews}, {c for c, _ in app_crews}
            if s_slots != a_slots:
                if not app_crews:
                    sev, why = "high", "no crew in the app"
                elif s_co == a_co:
                    sev, why = "low", "same crew companies, different slot numbers"
                elif s_co & a_co:
                    sev, why = "medium", "some crews differ"
                else:
                    sev, why = "high", "different crew company"
                out.append(_item("schedule", "crews", j, sev, f"{name}: crews differ — {why}",
                                 f"Sheet {', '.join(sorted(s_slots)) or '—'} · App {', '.join(sorted(a_slots)) or '—'}.",
                                 fix="Update the crews on the Assignment.", link=link,
                                 sheet=sorted(s_slots), app=sorted(a_slots), ref=ref))
        sheet_pm = J["pm"].most_common(1)[0][0] if J["pm"] else None
        app_pms = {x for it in (relevant or dated) for x in (it["pms"] or "").split(",") if x}
        if sheet_pm and app_pms and sheet_pm not in app_pms:
            out.append(_item("schedule", "pm", j, "medium", f"{name}: PM differs — sheet {sheet_pm}, app {', '.join(sorted(app_pms))}",
                             "The sheet's colour code says a different PM.", fix="Update the PM on the Assignment.", link=link,
                             sheet=sheet_pm, app=sorted(app_pms), ref=ref))
        elif sheet_pm and not app_pms:
            out.append(_item("schedule", "pm", j, "low", f"{name}: no PM in the app (sheet: {sheet_pm})", "",
                             fix="Set the PM on the Assignment.", link=link, sheet=sheet_pm, ref=ref))

    # app status that the dates contradict (app-internal; no sheet needed)
    seen = set()
    for pid, its in items.items():
        for it in its:
            if not it["start_date"]:
                continue
            last = it["eend"] or it["start_date"]
            want = "completed" if last < today else "not_started" if it["start_date"] > today else "in_progress"
            bad = ((it["status"] == "in_progress" and want == "completed") or
                   (it["status"] == "not_started" and want != "not_started") or
                   (it["status"] == "completed" and want == "not_started"))
            if bad and last >= today - timedelta(days=120) and it["id"] not in seen:
                seen.add(it["id"])
                proj = next((p for p in projects.values() if p["pid"] == pid), None)
                nm = proj["display_name"] if proj else f"Project {pid}"
                out.append(_item("schedule", "status", it["id"], "medium" if want == "completed" else "low",
                                 f"{nm}: status is {it['status'].replace('_', ' ')}, dates say {want.replace('_', ' ')}",
                                 f"Scheduled {_md(it['start_date'])} – {_md(last)}.",
                                 fix="Update the status on the Assignment.",
                                 link=f"#/entity/project/{proj['qbo_id']}" if proj else None,
                                 app=it["status"], sheet=want, ref={"schedule_item_id": it["id"]}))
    return out, {"schedule_cells": len(cells)}


# ── B151 vs Job Schedule (the two Google sheets against each other) ──────────

def sheets_items(conn):
    """Where the B151 forecast and the Job Schedule disagree about the same job.
    The Job Schedule is keyed by PROJECT # and the B151 by QUOTE #; a project
    can carry several quotes (the quote # often differs), so the join goes
    project → its QBO estimates' numbers → B151 rows."""
    rows = sheets.load_b151(conn)
    cells = conn.execute(text("SELECT day, job, descr, extra FROM gsync_schedule_days")).mappings().all()
    if not rows or not cells:
        return [], {}
    today = date.today()
    win = today - timedelta(days=45)
    b151 = {}
    for r in rows:
        b151.setdefault(r["quote"], r)
    days = collections.defaultdict(set)
    oldest = min(c["day"] for c in cells)
    for c in cells:
        if _kind(c["descr"] or c["extra"]) != "work":
            continue
        for j in re.findall(r"\b(\d{4})\b", c["job"] or ""):
            days[j].add(c["day"])
    # project job # → quote numbers on that project (QBO estimates on the project customer)
    proj_quotes = collections.defaultdict(set)
    proj_name = {}
    for r in conn.execute(text("""
        SELECT c.display_name, t.doc_number
        FROM qbo_transactions t JOIN qbo_customers c ON c.qbo_id = t.customer_qbo_id AND c.is_project = 1
        WHERE t.entity_type = 'Estimate' AND t.doc_number IS NOT NULL
    """)).mappings():
        m = re.match(r"\s*(\d{4})\b", r["display_name"] or "")
        if m:
            proj_quotes[m.group(1)].add(r["doc_number"].strip())
            proj_name[m.group(1)] = r["display_name"]
    out = []
    for j, ds in sorted(days.items()):
        if max(ds) < win:
            continue
        name = proj_name.get(j, f"Job {j}")
        quotes = sorted(q for q in (proj_quotes.get(j, set()) | {j}) if q in b151)
        s_first, s_last = min(ds), max(ds)
        ref = {"job": j, "quotes": quotes}
        if not quotes:
            out.append(_item("sheets", "scheduled_not_on_b151", j, "medium",
                             f"{name}: on the Job Schedule, no matching quote on the B151",
                             f"Scheduled {_md(s_first)} – {_md(s_last)}. None of the project's QuickBooks estimate numbers "
                             f"({', '.join(sorted(proj_quotes.get(j, []))) or 'none'}) is on the B151.",
                             fix="Add the quote to the B151 (or check its quote #).", ref=ref))
            continue
        rs = [b151[q] for q in quotes]
        if not any(_won(r.get("status")) for r in rs):
            out.append(_item("sheets", "scheduled_not_won", j, "high",
                             f"{name}: scheduled, but the B151 still says \"{rs[0].get('status')}\"",
                             f"Job Schedule {_md(s_first)} – {_md(s_last)}; B151 "
                             + ", ".join(f"#{r['quote']} {r.get('status')}" for r in rs) + ".",
                             fix="Set the B151 status to Won (or Red Flag).", sheet=[r.get("status") for r in rs], ref=ref))
        won = [r for r in rs if _won(r.get("status"))] or rs
        starts = [r["start"] for r in won if r.get("start")]
        ends = [r["end"] for r in won if r.get("end")]
        if not starts:
            out.append(_item("sheets", "b151_no_dates", j, "low", f"{name}: scheduled, but the B151 has no estimated dates",
                             f"Job Schedule {_md(s_first)} – {_md(s_last)}; B151 #{', #'.join(r['quote'] for r in won)} has no start date.",
                             fix="Enter the dates in the B151 so the forecast places it correctly.", ref=ref))
            continue
        b_first = date.fromisoformat(min(starts))
        b_last = date.fromisoformat(max(ends)) if ends else b_first
        d_start, d_end = (b_first - s_first).days, (b_last - s_last).days
        if s_first <= oldest + timedelta(days=1):
            d_start = 0      # the job started before the oldest tab the sync reads
        worst = max(abs(d_start), abs(d_end))
        if worst > 2:
            sev = "low" if worst <= 7 else "medium" if worst <= 30 else "high"
            out.append(_item("sheets", "dates", j, sev, f"{name}: B151 dates are {worst} days off the Job Schedule",
                             f"Job Schedule {_md(s_first)} – {_md(s_last)} · B151 {_md(b_first)} – {_md(b_last)} "
                             f"(#{', #'.join(r['quote'] for r in won)}).",
                             fix="Update the B151 est. start / end to match the Job Schedule.",
                             sheet=[str(s_first), str(s_last)], app=[str(b_first), str(b_last)], ref=ref))
    # Won on the B151, starting within 30 days, not on the Job Schedule.
    scheduled_quotes = set()
    for j in days:
        scheduled_quotes |= proj_quotes.get(j, set()) | {j}
    for q, r in b151.items():
        if not (r.get("status") or "").startswith("100%") or not r.get("start") or q in scheduled_quotes:
            continue
        st = date.fromisoformat(r["start"])
        if today <= st <= today + timedelta(days=30):
            out.append(_item("sheets", "won_not_scheduled", q, "high",
                             f"#{q} is Won and starts {_md(st)}, but isn't on the Job Schedule",
                             f"#{q} {r.get('customer') or ''} — {r.get('description') or ''} (B151 est. {_md(st)} – {_md(r.get('end'))}).",
                             fix="Put it on the Job Schedule (crew, PM) — or correct the B151 start date.", ref={"quote": q}))
    return out, {}


# ── assembly ─────────────────────────────────────────────────────────────────

def _optional_items(conn):
    """Checks that live in other modules (Drive documents, billing) — included
    when present, never allowed to break the page."""
    import importlib
    out = []
    for mod, fn in (("app.gsync.review_docs", "docs_items"), ("app.billing.align", "ambiguous_items")):
        try:
            out += getattr(importlib.import_module(mod), fn)(conn)
        except Exception:
            pass
    return out


def build():
    with engine.connect() as conn:
        p_items, p_meta = pipeline_items(conn)
        s_items, s_meta = schedule_items(conn)
        x_items, _ = sheets_items(conn)
        o_items = _optional_items(conn)
        state = {r["item_key"]: dict(r) for r in conn.execute(text(
            "SELECT item_key, status, note, fingerprint, updated_by_email, updated_at FROM data_review_state")).mappings()}
        last_refresh = conn.execute(text("SELECT MAX(finished_at) FROM gsync_runs WHERE ok = 1")).scalar()
    items = p_items + s_items + x_items + o_items
    for it in items:
        st = state.get(it["key"])
        it["state"] = "open"
        if st:
            it["note"] = st["note"]
            it["state_by"] = st["updated_by_email"]
            it["state_at"] = str(st["updated_at"]) if st["updated_at"] else None
            # Ignored sticks while the difference is unchanged. Fixed sticks only
            # until the next refresh: if the difference is still there after it,
            # the fix didn't take and the item re-opens.
            if st["status"] == "ignored" and st["fingerprint"] == it["fingerprint"]:
                it["state"] = "ignored"
            elif st["status"] == "fixed":
                if last_refresh and st["updated_at"] and last_refresh > st["updated_at"]:
                    it["still_differs"] = True
                else:
                    it["state"] = "fixed"
    items.sort(key=lambda i: (i["state"] != "open", SEV_ORDER.get(i["severity"], 3), i["category"], i["title"]))
    counts = collections.Counter((i["category"], i["state"]) for i in items)
    return {"items": items,
            "counts": {c: {"open": counts[(c, "open")], "fixed": counts[(c, "fixed")], "ignored": counts[(c, "ignored")]}
                       for c in ("todo", "pipeline", "schedule", "sheets", "documents", "old_estimates", "billing")},
            "meta": {**p_meta, **s_meta}}


def set_state(key, status, note, user, fingerprint):
    with engine.begin() as conn:
        conn.execute(text("""
            INSERT INTO data_review_state (item_key, status, note, fingerprint, updated_by_user_id, updated_by_email)
            VALUES (:k, :s, :n, :f, :uid, :em)
            ON DUPLICATE KEY UPDATE status = VALUES(status), note = VALUES(note), fingerprint = VALUES(fingerprint),
              updated_by_user_id = VALUES(updated_by_user_id), updated_by_email = VALUES(updated_by_email)
        """), {"k": key, "s": status, "n": (note or "")[:1000] or None, "f": fingerprint,
               "uid": (user or {}).get("id"), "em": (user or {}).get("email")})
