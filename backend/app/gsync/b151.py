"""
Mirror the B151 "Rolling Revenue" tab into the Pipeline (opportunities).

The estimators keep the B151 current, so while OPI transitions the Pipeline
follows it row for row: status, follow-up info, dates, contact, values. Rules:
  * match by quote # (= QBO estimate number); B151 quotes the app doesn't have
    are created (source 'b151');
  * quotes built in the app (metrics_source 'app') keep their app quoting
    metrics — only status / follow-up / dates come from the B151;
  * never touched: the app estimate link, estimator user, contact link, notes,
    QBO project link (that comes from QBO);
  * every changed field is recorded in the run summary + audit log.
Disagreements the B151 can't settle (e.g. QBO accepted but B151 not Won) are
surfaced on the Data Review page instead of being changed here.
"""
import re
from datetime import date

from sqlalchemy import text

WON = "100% Won > Goes to Ops Tab"


def lifecycle(pstat, current=None):
    p = (pstat or "").lower()
    if "won" in p or "red flag" in p:
        return "won"
    if "lost" in p:
        return "lost"
    if "inactive" in p:
        return "declined"
    # open: keep an app-side stage (received / quoting) rather than forcing 'sent'
    return current if current in ("received", "quoting", "sent") else "sent"


def _num(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = re.sub(r"[^0-9.\-]", "", str(v))
    try:
        return float(s) if s not in ("", "-", ".") else None
    except ValueError:
        return None


def _date(v):
    if not v:
        return None
    s = str(v)[:10]
    return s if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s) else None


def _txt(v, n=255):
    if v is None:
        return None
    s = str(v).strip()
    return s[:n] if s and s not in ("-",) else None


def target_fields(r):
    """B151 row → opportunity columns."""
    ohp_pct = _num(r.get("ohp_pct"))
    if ohp_pct is not None and abs(ohp_pct) <= 3:   # sheet stores 0.46 for 46%
        ohp_pct = round(ohp_pct * 100, 2)
    comm = _txt(r.get("comm_type"), 8)
    fu = _num(r.get("follow_ups"))
    rev = _num(r.get("revisions"))
    return {
        "pipeline_status": _txt(r.get("status"), 64),
        "last_contact_date": _date(r.get("last_contact")),
        "follow_up_count": int(fu) if fu is not None else None,
        "last_comm_type": comm,          # ES / ER / PC / LVM, sometimes "ES, ER"
        "rfq_received_date": _date(r.get("requested")),
        "most_recent_revision_date": _date(r.get("revised")),
        "total_revisions": int(rev) if rev is not None else None,
        "order_date": _date(r.get("order_date")),
        "quoted_by": _txt(r.get("quoted_by"), 64),
        "contact_name_raw": _txt(r.get("contact")),
        "customer_name_raw": _txt(r.get("customer")),
        "city": _txt(r.get("city"), 120),
        "state": _txt(r.get("state"), 64),
        "title": _txt(r.get("description")),
        "labor_days": _num(r.get("labor_days")),
        "travel_days": _num(r.get("travel_days")),
        "target_start_date": _date(r.get("start")),
        "target_end_date": _date(r.get("end")),
        "ohp_amount": _num(r.get("ohp_amount")),
        "ohp_pct": ohp_pct,
        "contract_value": _num(r.get("tcv")),
        "quote_sent_date": _date(r.get("sent")),
        "order_value": _num(r.get("order_value")),
        "expected_decision_date": _date(r.get("decision")),
        "discounted_contract_value": _num(r.get("discounted")),
        # The quoting-metrics workbook the row's "Link" cell points at. Only set
        # when the sheet has one — an app-entered link is never cleared.
        "workbook_url": _txt(r.get("link_url"), 512),
    }


METRIC_FIELDS = {"labor_days", "travel_days", "ohp_amount", "ohp_pct", "contract_value", "discounted_contract_value"}


def _same(a, b):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    try:
        return abs(float(a) - float(b)) < 0.005
    except (TypeError, ValueError):
        return str(a).strip() == str(b).strip()


def _customer_matcher(conn):
    rows = conn.execute(text("SELECT id, display_name FROM qbo_customers WHERE is_project = 0 AND active = 1")).all()
    norm = lambda s: re.sub(r"[^a-z0-9]", "", (s or "").lower())
    exact = {norm(n): i for i, n in rows}
    lst = [(norm(n), i) for i, n in rows]

    def match(name):
        n = norm(name)
        if not n:
            return None
        if n in exact:
            return exact[n]
        c = sorted((len(nn), i) for nn, i in lst if len(n) >= 3 and (n in nn or nn in n))
        return c[0][1] if c else None
    return match


def plan(conn, rows):
    opps = conn.execute(text("""
        SELECT id, quote_number, status, metrics_source, app_estimate_id, qbo_customer_id, decided_at,
               pipeline_status, last_contact_date, follow_up_count, last_comm_type, rfq_received_date,
               most_recent_revision_date, total_revisions, order_date, quoted_by, contact_name_raw,
               customer_name_raw, city, state, title, labor_days, travel_days, target_start_date,
               target_end_date, ohp_amount, ohp_pct, contract_value, quote_sent_date, order_value,
               expected_decision_date, discounted_contract_value, workbook_url
        FROM opportunities WHERE quote_number IS NOT NULL
    """)).mappings().all()
    by_q = {}
    for o in opps:
        by_q.setdefault(o["quote_number"].strip(), o)

    match = None
    seen, updates, creates = set(), [], []
    for r in rows:
        q = r["quote"]
        if q in seen:
            continue           # duplicate quote # in the sheet — first row wins (flagged on Data Review)
        seen.add(q)
        tgt = target_fields(r)
        o = by_q.get(q)
        if o is None:
            match = match or _customer_matcher(conn)
            st = lifecycle(tgt["pipeline_status"])
            creates.append({**tgt, "quote_number": q, "status": st,
                            "qbo_customer_id": match(tgt["customer_name_raw"]),
                            "decided_at": (tgt["order_date"] or str(date.today())) if st in ("won", "lost", "declined") else None})
            continue
        ch = {}
        for f, v in tgt.items():
            if f in METRIC_FIELDS and (o["metrics_source"] == "app" or o["app_estimate_id"]):
                continue
            if f == "workbook_url" and not v:
                continue
            if not _same(o[f], v):
                ch[f] = v
        st = lifecycle(tgt["pipeline_status"], o["status"])
        if st != o["status"]:
            ch["status"] = st
            if st in ("won", "lost", "declined") and not o["decided_at"]:
                ch["decided_at"] = tgt["order_date"] or str(date.today())
        if ch:
            updates.append({"id": o["id"], "quote": q, "old": {k: o.get(k) for k in ch}, "new": ch})
    return {"updates": updates, "creates": creates}


def apply(conn, p):
    for u in p["updates"]:
        sets = ", ".join(f"{k} = :{k}" for k in u["new"])
        conn.execute(text(f"UPDATE opportunities SET {sets} WHERE id = :id"), {**u["new"], "id": u["id"]})
    for c in p["creates"]:
        cols = list(c.keys()) + ["source", "active", "metrics_source"]
        conn.execute(text(f"""
            INSERT INTO opportunities ({", ".join(cols)}, received_at)
            VALUES ({", ".join(":" + k for k in c.keys())}, 'b151', 1, 'rr', :rfq_received_date)
        """), c)


def summarize(p):
    fields = {}
    for u in p["updates"]:
        for f in u["new"]:
            fields[f] = fields.get(f, 0) + 1
    return {"updated": len(p["updates"]), "created": len(p["creates"]),
            "fields_changed": dict(sorted(fields.items(), key=lambda kv: -kv[1])),
            "status_changes": sum(1 for u in p["updates"] if "pipeline_status" in u["new"])}
