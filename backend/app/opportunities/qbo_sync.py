"""
Keep the Pipeline (opportunities) current from the QBO estimate mirror.

The pipeline was seeded once from the B151 "Rolling Revenue" tab (July 2026) and
then froze: new quotes, wins and losses were only ever recorded in QBO. This pass
reads the local qbo_transactions mirror (no QBO API calls) and:

  1. creates an opportunity for every new quote (an estimate number with no
     opportunity yet) — title/city/state/estimator parsed from the customer memo
     ("Rack Installation for Lipsey's in Baton Rouge, LA | MT"), OH&P from the
     OH&P lines;
  2. marks an opportunity Won when any copy of its estimate is Accepted /
     Converted in QBO (order date + order value from that estimate), and Lost
     when the estimate was Rejected and never accepted (open ones only);
  3. links each opportunity to its QBO project (project_qbo_id) via the copy of
     the estimate that lives on the project customer — the project number often
     differs from the quote number (5574 → 4929), so the join is by doc_number;
  4. refreshes the contract value of open, workbook-seeded opportunities from
     the current QBO estimate total.

An estimate created directly on a project that already has other estimates is a
change order / add-on (Change Orders page), not a new quote — it is skipped so
the bid/win ratio isn't double counted (B151 "Notes" tab).

Runs after each transactions sync (best-effort) and on demand:
  python -m app.opportunities.qbo_sync            # dry run: prints the plan
  python -m app.opportunities.qbo_sync --apply
"""
import json
import re
import sys
from collections import defaultdict
from datetime import date

from sqlalchemy import text

from app.db import engine
from app.audit import record_audit

WON = "100% Won > Goes to Ops Tab"
LOST = "0% Lost"
NEW_STATUS = "20% Budgetary, Project Uncertain"
# Quotes numbered above the seed's last row are new; older gaps were left out
# of the workbook on purpose (templates, $0 shells, project add-ons).
SEED_MAX_QUOTE = 7257
SKIP_CUSTOMERS = {"template", "app test"}
SYNC_ACTOR = {"id": None, "email": "qbo-sync"}

_MEMO = re.compile(r"^(?P<scope>.+?)(?:\s+for\s+(?P<end>.+?))?\s+in\s+(?P<city>[^,|]+),\s*(?P<st>[A-Z]{2})\b")


def _f(v):
    return float(v) if v is not None else None


def _parse_memo(memo):
    """'Rack Installation for ADI in Easton, PA\\nJG' → scope, end user, city, ST, initials."""
    out = {"scope": None, "end": None, "city": None, "st": None, "initials": None}
    if not memo:
        return out
    lines = [l.strip() for l in memo.replace("\r", "").split("\n") if l.strip()]
    if not lines:
        return out
    if len(lines) > 1 and re.fullmatch(r"[A-Z]{2,3}", lines[-1]):
        out["initials"] = lines[-1]
    m = _MEMO.match(lines[0])
    if m:
        out.update(scope=m["scope"].strip(), end=(m["end"] or "").strip() or None,
                   city=m["city"].strip(), st=m["st"])
    else:
        out["scope"] = lines[0][:200]
    return out


def _ohp(raw):
    """Sum of OH&P item lines (nested inside group lines too)."""
    total = 0.0

    def walk(lines):
        nonlocal total
        for ln in lines or []:
            if ln.get("DetailType") == "GroupLineDetail":
                walk((ln.get("GroupLineDetail") or {}).get("Line"))
            elif ln.get("DetailType") == "SalesItemLineDetail":
                name = (((ln.get("SalesItemLineDetail") or {}).get("ItemRef") or {}).get("name") or "")
                if name.upper().startswith("OH&P"):
                    total += float(ln.get("Amount") or 0)
    walk(raw.get("Line"))
    return round(total, 2)


def _load_estimates(conn):
    rows = conn.execute(text("""
        SELECT t.qbo_id, t.doc_number, t.txn_date, t.total_amt, t.raw_json,
               t.meta_last_updated_time, c.id AS cust_id, c.qbo_id AS cust_qbo_id,
               c.display_name AS cust_name, c.is_project, c.parent_qbo_id
        FROM qbo_transactions t
        JOIN qbo_customers c ON c.qbo_id = t.customer_qbo_id
        WHERE t.entity_type = 'Estimate' AND t.doc_number IS NOT NULL
    """)).mappings().all()
    groups = defaultdict(list)
    for r in rows:
        raw = r["raw_json"]
        raw = json.loads(raw) if isinstance(raw, str) else (raw or {})
        groups[r["doc_number"].strip()].append({**r, "raw": raw, "st": raw.get("TxnStatus") or ""})
    return groups


def _first_invoice_dates(conn):
    """Earliest invoice date per estimate qbo_id (LinkedTxn on the invoice)."""
    out = {}
    for r in conn.execute(text("""
        SELECT JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.LinkedTxn')) lt, txn_date
        FROM qbo_transactions WHERE entity_type = 'Invoice'
          AND JSON_SEARCH(raw_json, 'one', 'Estimate', NULL, '$.LinkedTxn[*].TxnType') IS NOT NULL
    """)).mappings():
        try:
            for l in json.loads(r["lt"] or "[]"):
                if l.get("TxnType") == "Estimate" and r["txn_date"]:
                    k = str(l.get("TxnId"))
                    if k not in out or r["txn_date"] < out[k]:
                        out[k] = r["txn_date"]
        except Exception:
            pass
    return out


def _accepted(copies):
    return [c for c in copies if c["st"] in ("Accepted", "Converted")]


def _order_date(est, inv_dates):
    d = est["raw"].get("AcceptedDate")
    if d:
        return d[:10]
    if est["qbo_id"] in inv_dates:
        return str(inv_dates[est["qbo_id"]])
    return str(est["txn_date"]) if est["txn_date"] else None


def _is_addon(doc, copies, groups_by_project):
    """Only on project customer(s), and the project carries an earlier estimate."""
    if any(not c["is_project"] for c in copies):
        return False
    try:
        n = int(doc)
    except ValueError:
        return True
    for c in copies:
        for other in groups_by_project.get(c["cust_qbo_id"], ()):
            try:
                if int(other) < n:
                    return True
            except ValueError:
                continue
    return False


def plan(conn, link_only=False):
    """link_only: while the Pipeline mirrors the B151 (app.gsync.b151), QBO only
    supplies the project link — statuses/values/new quotes come from the sheet."""
    groups = _load_estimates(conn)
    inv_dates = _first_invoice_dates(conn)
    by_project = defaultdict(set)
    for doc, copies in groups.items():
        for c in copies:
            if c["is_project"]:
                by_project[c["cust_qbo_id"]].add(doc)

    opps = conn.execute(text("""
        SELECT id, quote_number, status, pipeline_status, project_qbo_id, contract_value,
               order_value, order_date, decided_at, app_estimate_id, metrics_source, title
        FROM opportunities WHERE quote_number IS NOT NULL
    """)).mappings().all()
    by_quote = {o["quote_number"].strip(): o for o in opps}

    contacts = {}
    for r in conn.execute(text("SELECT id, qbo_customer_id, LOWER(full_name) n FROM contacts WHERE active = 1")).mappings():
        contacts.setdefault((r["qbo_customer_id"], r["n"]), r["id"])

    creates, updates, skipped = [], [], defaultdict(int)

    for doc, copies in groups.items():
        acc = _accepted(copies)
        proj = [c for c in copies if c["is_project"]]
        proj_pick = (sorted([c for c in proj if c in acc], key=lambda c: -(float(c["total_amt"] or 0)))
                     or proj)
        project_qbo_id = proj_pick[0]["cust_qbo_id"] if proj_pick else None
        opp = by_quote.get(doc)

        if opp:
            ch = {}
            if project_qbo_id and opp["project_qbo_id"] != project_qbo_id:
                ch["project_qbo_id"] = project_qbo_id
            if link_only:
                if ch:
                    updates.append({"id": opp["id"], "quote": doc, "title": opp["title"],
                                    "old": {k: opp.get(k) for k in ch}, "new": ch})
                continue
            decided = opp["status"] in ("won", "lost", "declined")
            if acc and opp["pipeline_status"] != WON and not (opp["pipeline_status"] or "").startswith("80% Red Flag"):
                best = max(acc, key=lambda c: float(c["total_amt"] or 0))
                ch.update(status="won", pipeline_status=WON)
                if not opp["order_date"]:
                    ch["order_date"] = _order_date(best, inv_dates)
                if not opp["order_value"]:
                    ch["order_value"] = _f(best["total_amt"])
                # The accepted estimate is the deal; a stale quote-time value
                # (e.g. 7161 quoted $173k, accepted $26k) would inflate the forecast.
                if opp["contract_value"] is None or abs(float(opp["contract_value"]) - float(best["total_amt"] or 0)) > 0.5:
                    ch["contract_value"] = _f(best["total_amt"])
                if not opp["decided_at"]:
                    ch["decided_at"] = ch.get("order_date") or str(date.today())
            elif (not acc and not decided and any(c["st"] == "Rejected" for c in copies)
                  and not any(c["st"] == "Pending" for c in copies)):
                ch.update(status="lost", pipeline_status=LOST, decided_at=str(date.today()))
            elif not decided and not opp["app_estimate_id"]:
                live = [c for c in copies if not c["is_project"]] or copies
                cur = max(live, key=lambda c: (c["meta_last_updated_time"] or c["txn_date"] or date.min).__str__())
                tv = _f(cur["total_amt"])
                if tv and (opp["contract_value"] is None or abs(float(opp["contract_value"]) - tv) > 0.5):
                    ch["contract_value"] = tv
            if ch:
                updates.append({"id": opp["id"], "quote": doc, "title": opp["title"],
                                "old": {k: opp.get(k) for k in ch}, "new": ch})
            continue

        # ── no opportunity yet ──
        if link_only:
            continue
        if not re.fullmatch(r"\d+", doc) or int(doc) <= SEED_MAX_QUOTE:
            skipped["pre-seed or non-numeric"] += 1
            continue
        if _is_addon(doc, copies, by_project):
            skipped["change order / add-on on an existing project"] += 1
            continue
        contact_copies = [c for c in copies if not c["is_project"]]
        src = (sorted(contact_copies, key=lambda c: str(c["txn_date"])) or sorted(copies, key=lambda c: str(c["txn_date"])))[0]
        if (src["cust_name"] or "").strip().lower() in SKIP_CUSTOMERS:
            skipped["template / test customer"] += 1
            continue
        total = max(float(c["total_amt"] or 0) for c in copies)
        if total <= 0:
            skipped["$0 shell (picked up once priced)"] += 1
            continue
        memo = _parse_memo((src["raw"].get("CustomerMemo") or {}).get("value"))
        # QBO nests people (and projects) under the dealer company: the customer
        # is the parent, and a person sub-customer is the contact.
        cust_id, cust_name = src["cust_id"], src["cust_name"]
        contact_name = None
        if src["parent_qbo_id"]:
            par = conn.execute(text("SELECT id, display_name FROM qbo_customers WHERE qbo_id = :q"),
                               {"q": src["parent_qbo_id"]}).mappings().first()
            if par:
                cust_id, cust_name = par["id"], par["display_name"]
                if not src["is_project"]:
                    contact_name = src["cust_name"]
        if not contact_name:
            ba = src["raw"].get("BillAddr") or {}
            for ln in (ba.get("Line2"), ba.get("Line1")):
                ln = (ln or "").strip()
                if ln and ln.lower() != (cust_name or "").lower() and not re.search(r"\d", ln):
                    contact_name = ln[:255]
                    break
        contact_id = contacts.get((cust_id, contact_name.lower())) if contact_name else None
        end_user = memo["end"] or cust_name
        loc = " ".join(x for x in (memo["city"], memo["st"]) if x)
        title = "-".join(x for x in (end_user, loc, memo["scope"]) if x)[:255]
        ohp = _ohp(src["raw"])
        sent = ((src["raw"].get("DeliveryInfo") or {}).get("DeliveryTime") or "")[:10] or None
        row = {
            "qbo_customer_id": cust_id, "customer_name_raw": cust_name,
            "contact_id": contact_id, "contact_name_raw": contact_name,
            "title": title, "source": "qbo_sync", "quote_number": doc,
            "qbo_estimate_id": src["qbo_id"], "project_qbo_id": project_qbo_id,
            "rfq_received_date": str(src["txn_date"]) if src["txn_date"] else None,
            "quote_sent_date": sent, "city": memo["city"], "state": memo["st"],
            "quoted_by": memo["initials"], "contract_value": total,
            "ohp_amount": ohp or None, "ohp_pct": round(ohp / total * 100, 2) if ohp and total else None,
            "status": "sent", "pipeline_status": NEW_STATUS,
            "order_date": None, "order_value": None, "decided_at": None,
        }
        if acc:
            best = max(acc, key=lambda c: float(c["total_amt"] or 0))
            row.update(status="won", pipeline_status=WON, order_date=_order_date(best, inv_dates),
                       order_value=_f(best["total_amt"]))
            row["decided_at"] = row["order_date"]
        elif any(c["st"] == "Rejected" for c in copies) and not any(c["st"] == "Pending" for c in copies):
            row.update(status="lost", pipeline_status=LOST, decided_at=row["rfq_received_date"])
        creates.append(row)

    return {"creates": creates, "updates": updates, "skipped": dict(skipped)}


def apply(conn, p):
    for r in p["creates"]:
        conn.execute(text("""
            INSERT INTO opportunities
              (qbo_customer_id, customer_name_raw, contact_id, contact_name_raw, title, source,
               quote_number, qbo_estimate_id, project_qbo_id, rfq_received_date, quote_sent_date,
               city, state, quoted_by, contract_value, ohp_amount, ohp_pct, status, active,
               pipeline_status, order_date, order_value, received_at, sent_at, decided_at)
            VALUES (:qbo_customer_id, :customer_name_raw, :contact_id, :contact_name_raw, :title, :source,
               :quote_number, :qbo_estimate_id, :project_qbo_id, :rfq_received_date, :quote_sent_date,
               :city, :state, :quoted_by, :contract_value, :ohp_amount, :ohp_pct, :status, 1,
               :pipeline_status, :order_date, :order_value, :rfq_received_date,
               COALESCE(:quote_sent_date, :rfq_received_date), :decided_at)
        """), r)
    for u in p["updates"]:
        sets = ", ".join(f"{k} = :{k}" for k in u["new"])
        conn.execute(text(f"UPDATE opportunities SET {sets} WHERE id = :id"), {**u["new"], "id": u["id"]})


def run(do_apply=False, link_only=False):
    with engine.begin() as conn:
        p = plan(conn, link_only=link_only)
        if do_apply:
            apply(conn, p)
    summary = {
        "created": len(p["creates"]),
        "created_won": sum(1 for r in p["creates"] if r["status"] == "won"),
        "created_lost": sum(1 for r in p["creates"] if r["status"] == "lost"),
        "marked_won": sum(1 for u in p["updates"] if u["new"].get("status") == "won"),
        "marked_lost": sum(1 for u in p["updates"] if u["new"].get("status") == "lost"),
        "linked_project": sum(1 for u in p["updates"] if "project_qbo_id" in u["new"]),
        "value_refreshed": sum(1 for u in p["updates"] if "contract_value" in u["new"]),
        "skipped": p["skipped"], "applied": do_apply,
    }
    if do_apply and (p["creates"] or p["updates"]):
        record_audit(SYNC_ACTOR, "opportunity.qbo_sync", "opportunity", None, "Pipeline sync from QBO",
                     {"summary": summary,
                      "status_changes": [{"id": u["id"], "quote": u["quote"], "changes":
                                          {k: [u["old"].get(k), v] for k, v in u["new"].items()
                                           if k in ("status", "pipeline_status", "contract_value")}}
                                         for u in p["updates"]
                                         if {"status", "contract_value"} & set(u["new"])],
                      "created_quotes": [r["quote_number"] for r in p["creates"]]})
    return summary, p


if __name__ == "__main__":
    s, p = run("--apply" in sys.argv, link_only="--link-only" in sys.argv)
    print(json.dumps(s, indent=2, default=str))
    if "-v" in sys.argv:
        for u in p["updates"]:
            if "status" in u["new"]:
                print("STATUS", u["quote"], u["old"].get("pipeline_status"), "->", u["new"]["pipeline_status"], "|", u["title"])
        for r in p["creates"][:40]:
            print("NEW", r["quote_number"], r["status"], r["contract_value"], r["quoted_by"], "|", r["title"])
