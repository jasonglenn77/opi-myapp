"""Project Setup, "Project estimate created" (2026-11-18 owner feedback).

Every estimate on the project, one line each (the original first, then change
orders by date), with its status and amount (QuickBooks' bottom line, so a
discount or deduct line counts), and how it ties to a PO on file: PO number on
the estimate vs the PO files in the job's "5 Purchase Orders" folders, PO total
vs estimate total, PO terms vs the estimate's payment terms.

Read-only: nothing here changes the project.
"""
import re

from sqlalchemy import bindparam, text

from app.setup import estimate as EST

ACCEPTED = ("Accepted", "Converted", "Closed")
_PO_ON_EST = re.compile(r"\bP\.?\s?O\.?\s*(?:#|No\.?|Number)?\s*:?\s*([A-Z0-9][A-Z0-9\-_/.]*)", re.I)
_NET = re.compile(r"\bnet\s*-?\s*(\d{1,3})\b", re.I)


def _norm(v):
    return re.sub(r"[^A-Z0-9]", "", (v or "").upper())


def _po_number_on_estimate(texts):
    """The PO number typed on the estimate's top line, if there is one ("PO #"
    left blank on change orders gives None: a PO number has a digit in it)."""
    for t in texts:
        m = _PO_ON_EST.search(t["description"] or "")
        if m:
            tok = m.group(1).strip(".")
            return tok if re.search(r"\d", tok) else None
    return None


def _terms(texts):
    t = " ".join(x["description"] for x in texts if x["item"] == "Payment Terms" or
                 re.search(r"invoicing schedule|^terms\s*:", x["description"] or "", re.I))
    t = re.sub(r"\s+", " ", t).strip()
    pcts = [int(v) for v in re.findall(r"(\d{1,3})\s*%", t)][:6]
    net = _NET.search(t)
    return {"text": t[:300] or None, "percents": pcts, "net_days": int(net.group(1)) if net else None}


def _po_terms(snippet):
    """Net days from the PO's text ("NET 30 DAYS", "paid Net 45 days"). A PO's
    "Terms" label is usually delivery or legal terms, so only Net days count."""
    net = _NET.search(snippet or "")
    return {"text": f"Net {net.group(1)}" if net else None, "net_days": int(net.group(1)) if net else None}


def _po_files(conn, project_qbo_id, opp_ids):
    q = text("""
        SELECT id, s3_key, original_filename, drive_modified, entity_type FROM documents
        WHERE folder = '5_purchase_orders' AND drive_removed_at IS NULL AND LOWER(original_filename) LIKE '%.pdf'
          AND ((entity_type = 'project' AND entity_id = :e) OR (entity_type = 'opportunity' AND entity_id IN :o))
        ORDER BY drive_modified DESC, id DESC""").bindparams(bindparam("o", expanding=True))
    out = []
    for d in conn.execute(q, {"e": project_qbo_id, "o": [str(i) for i in opp_ids] or ["-"]}).mappings().all():
        info = EST.po_info(conn, d)
        out.append({"document_id": d["id"], "filename": d["original_filename"], "po_number": info.get("po_number"),
                    "total": info.get("total"), "terms": _po_terms(info.get("snippet"))})
    return out


def _match(est, pos, used):
    """The PO file for this estimate: same PO number, else (no number on the
    estimate) a PO for the same total that no other estimate took."""
    n = _norm(est["po_number"])
    if n:
        for p in pos:
            pn = _norm(p["po_number"])
            if pn and (pn == n or (len(n) >= 5 and (n in pn or pn in n))):
                return p
        return None
    for p in pos:
        if p["document_id"] not in used and p["total"] is not None and abs(p["total"] - est["total"]) <= 1:
            return p
    return None


def overview(conn, project_qbo_id, opp_ids, reviews=None):
    rows = conn.execute(text("""
        WITH latest AS (
          SELECT t.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(t.doc_number, t.qbo_id) ORDER BY t.id DESC) AS rn
          FROM qbo_transactions t WHERE t.entity_type = 'Estimate' AND t.customer_qbo_id = :p)
        SELECT id, qbo_id, doc_number, txn_date, total_amt,
               JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.TxnStatus')) AS status,
               JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.AcceptedDate')) AS accepted_date,
               JSON_UNQUOTE(JSON_EXTRACT(raw_json, '$.MetaData.CreateTime')) AS created
        FROM latest WHERE rn = 1 ORDER BY txn_date, id"""), {"p": project_qbo_id}).mappings().all()
    pos = _po_files(conn, project_qbo_id, opp_ids)
    reason = " ".join((r or {}).get("reason") or "" for r in (reviews or {}).values())
    ests, used = [], set()
    for i, r in enumerate(rows):
        groups, texts = EST._groups(conn, r["id"])
        e = {"qbo_id": str(r["qbo_id"]), "doc_number": r["doc_number"], "date": str(r["txn_date"]) if r["txn_date"] else None,
             "accepted_date": (r["accepted_date"] or "")[:10] or None, "created": (r["created"] or "")[:10] or None,
             "status": r["status"] or "", "total": round(float(r["total_amt"] or 0), 2), "original": i == 0,
             "po_number": _po_number_on_estimate(texts), "terms": _terms(texts),
             "reopened": bool(r["doc_number"] and re.search(rf"#{re.escape(str(r['doc_number']))}\b", reason)),
             "groups": [{"name": g["name"], "total": round(g["total"], 2)} for g in groups]}
        p = _match(e, pos, used)
        if p:
            used.add(p["document_id"])
        checks = []
        if p:
            checks.append({"ok": True, "text": f"PO on file: {p['filename']}" + (f" (PO #{p['po_number']})" if p["po_number"] else "")})
            if p["total"] is not None:
                diff = round(e["total"] - p["total"], 2)
                checks.append({"ok": abs(diff) <= 1, "text": f"PO total ${p['total']:,.2f} vs estimate ${e['total']:,.2f}"
                               + ("" if abs(diff) <= 1 else f" (differs by ${abs(diff):,.2f})")})
            else:
                checks.append({"ok": None, "text": "Couldn't read the PO total; open the PO to compare."})
            pt, et = p["terms"], e["terms"]
            if pt["net_days"] and et["net_days"]:
                checks.append({"ok": pt["net_days"] == et["net_days"],
                               "text": f"PO terms Net {pt['net_days']} vs estimate Net {et['net_days']}"})
            else:
                checks.append({"ok": None, "text": f"PO terms: {pt['text'] or 'not found on the PO'}"})
        elif e["po_number"]:
            checks.append({"ok": False, "text": f"PO #{e['po_number']} is on the estimate, but no PO file with that number is in 5 Purchase Orders."})
        else:
            checks.append({"ok": None, "text": "No PO number on the estimate and no matching PO on file (a change order may not have one)."})
        e["po"] = p
        e["checks"] = checks
        e["ties"] = (None if not p else all(c["ok"] is not False for c in checks))
        ests.append(e)
    acc = [e for e in ests if e["status"] in ACCEPTED]
    pend = [e for e in ests if e["status"] == "Pending"]
    return {"estimates": ests, "po_files": pos,
            "accepted_total": round(sum(e["total"] for e in acc), 2), "accepted_n": len(acc),
            "pending_total": round(sum(e["total"] for e in pend), 2), "pending_n": len(pend),
            "other_n": len(ests) - len(acc) - len(pend)}
