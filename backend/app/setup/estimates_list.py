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


_PO_IN_NAME = [re.compile(r"\bP\.?\s?O\.?\s*#?\s*([A-Z0-9][A-Z0-9\-]{4,})", re.I),
               re.compile(r"\b([A-Z]{1,3}\d{6,}[A-Z]{0,3})\b")]
_EST_IN_PO = re.compile(r"\bEstimate\s*#?\s*(\d{3,6})\b", re.I)


def _po_number_in_name(name):
    """'OPI PO #1700032907 - Adidas.pdf' -> 1700032907; 'SA1700029787KM - OPI.pdf'
    -> SA1700029787KM. The PDF's own text often has no readable PO label."""
    base = re.sub(r"\.[a-z0-9]{2,4}$", "", name or "", flags=re.I)
    for rx in _PO_IN_NAME:
        m = rx.search(base)
        if m and re.search(r"\d{4,}", m.group(1)):
            return m.group(1)
    return None


def _po_files(conn, project_qbo_id, opp_ids):
    # every pipeline item linked to the project (one per change order) can hold POs
    linked = [str(r[0]) for r in conn.execute(text("SELECT id FROM opportunities WHERE project_qbo_id = :e"),
                                              {"e": project_qbo_id}).all()]
    q = text("""
        SELECT id, s3_key, original_filename, drive_modified, entity_type FROM documents
        WHERE folder = '5_purchase_orders' AND drive_removed_at IS NULL AND LOWER(original_filename) LIKE '%.pdf'
          AND ((entity_type = 'project' AND entity_id = :e) OR (entity_type = 'opportunity' AND entity_id IN :o))
        ORDER BY drive_modified DESC, id DESC""").bindparams(bindparam("o", expanding=True))
    out = []
    for d in conn.execute(q, {"e": project_qbo_id, "o": sorted({str(i) for i in opp_ids} | set(linked)) or ["-"]}).mappings().all():
        info = EST.po_info(conn, d)
        num = info.get("po_number")
        from_name = _po_number_in_name(d["original_filename"])
        out.append({"document_id": d["id"], "filename": d["original_filename"],
                    "po_number": num or from_name, "po_number_from": "pdf" if num else ("file name" if from_name else None),
                    "total": info.get("total"), "terms": _po_terms(info.get("snippet")),
                    # estimate numbers the PO's lines name: "Rack Install (Estimate 7103)"
                    "names_estimates": sorted(set(_EST_IN_PO.findall(info.get("snippet") or ""))),
                    "estimates": []})
    return out


def _links(conn, project_qbo_id):
    try:
        return {str(r["estimate_qbo_id"]): dict(r) for r in conn.execute(text(
            "SELECT estimate_qbo_id, document_id, no_po, by_email, at FROM project_estimate_po_link WHERE entity_id = :e"),
            {"e": project_qbo_id}).mappings().all()}
    except Exception:
        return {}


def _match(est, pos, used, link=None, strong=False):
    """(PO file, how) for this estimate. A tie set by hand wins; then the PO
    number on the estimate; then a PO whose lines name this estimate; then a PO
    for the same total no other estimate took. Among several candidates the one
    for the same total wins. strong=True: only a number or named-estimate tie
    whose total also matches (claimed first, so a mistyped PO number on another
    estimate can't take that file)."""
    if link:
        if link.get("no_po"):
            return None, "no_po"
        p = next((x for x in pos if x["document_id"] == link.get("document_id")), None)
        if p:
            return p, "hand"
    same_total = lambda c: c["total"] is not None and abs(c["total"] - est["total"]) <= 1
    pick = lambda cands: (next((c for c in cands if same_total(c)), None) or cands[0]) if cands else None
    n = _norm(est["po_number"])
    by_num = [x for x in pos if n and _norm(x["po_number"]) and
              (_norm(x["po_number"]) == n or (len(n) >= 5 and (n in _norm(x["po_number"]) or _norm(x["po_number"]) in n)))]
    doc = str(est.get("doc_number") or "")
    by_name = [x for x in pos if doc and doc in x["names_estimates"]]
    if strong:
        for cands, how in ((by_num, "number"), (by_name, "names")):
            p = next((c for c in cands if same_total(c) and c["document_id"] not in used), None)
            if p:
                return p, how
        return None, None
    free_same = next((x for x in pos if x["document_id"] not in used and same_total(x)), None)
    for cands, how in ((by_num, "number"), (by_name, "names")):
        p = pick(cands)
        if p:
            # the number/name points at a PO for a different amount while an
            # untaken PO has exactly this estimate's total: that one is its PO
            if not same_total(p) and free_same:
                return free_same, "total"
            return p, how
    if free_same:
        return free_same, "total"
    return None, None


HOW = {"hand": "Tied by hand", "number": "Same PO number", "names": "The PO names this estimate",
       "total": "Same total as the estimate"}


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
    links = _links(conn, project_qbo_id)
    reason = " ".join((r or {}).get("reason") or "" for r in (reviews or {}).values())
    ests, used = [], set()
    for i, r in enumerate(rows):
        groups, texts = EST._groups(conn, r["id"])
        ests.append({"qbo_id": str(r["qbo_id"]), "doc_number": r["doc_number"], "date": str(r["txn_date"]) if r["txn_date"] else None,
             "accepted_date": (r["accepted_date"] or "")[:10] or None, "created": (r["created"] or "")[:10] or None,
             "status": r["status"] or "", "total": round(float(r["total_amt"] or 0), 2), "original": i == 0,
             "po_number": _po_number_on_estimate(texts), "terms": _terms(texts),
             "reopened": bool(r["doc_number"] and re.search(rf"#{re.escape(str(r['doc_number']))}\b", reason)),
             "groups": [{"name": g["name"], "total": round(g["total"], 2)} for g in groups]})
    # ties set by hand, then exact ties (number or named estimate, same total), then the rest
    found = {}
    for e in ests:
        if links.get(e["qbo_id"]):
            found[e["qbo_id"]] = _match(e, pos, used, links[e["qbo_id"]])
    for strong in (True, False):
        for e in ests:
            if e["qbo_id"] in found:
                continue
            p, how = _match(e, pos, used, None, strong=strong)
            if p or not strong:
                found[e["qbo_id"]] = (p, how)
            if p:
                used.add(p["document_id"])
    for e in ests:
        link = links.get(e["qbo_id"])
        p, how = found.get(e["qbo_id"], (None, None))
        e["po_how"] = how
        e["po_link"] = ({"by": link.get("by_email"), "at": str(link.get("at"))[:10], "no_po": bool(link.get("no_po")),
                         "document_id": link.get("document_id")} if link else None)
        if p:
            used.add(p["document_id"])
            p["estimates"].append(e["doc_number"])
        checks = []
        if how == "no_po":
            checks.append({"ok": True, "text": f"No PO of its own (set by {link.get('by_email') or 'someone'})"})
        if p:
            by = f" by {link.get('by_email')}" if how == "hand" and link.get("by_email") else ""
            checks.append({"ok": True, "text": f"PO on file: {p['filename']}" + (f" (PO #{p['po_number']})" if p["po_number"] else "")
                           + f" · {HOW[how]}{by}"})
            if e["po_number"] and p["po_number"] and _norm(e["po_number"]) != _norm(p["po_number"]) and how != "number":
                checks.append({"ok": None, "text": f"The estimate says PO #{e['po_number']}; this file is PO #{p['po_number']}."})
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
        elif how == "no_po":
            pass
        elif e["po_number"]:
            checks.append({"ok": False, "text": f"PO #{e['po_number']} is on the estimate, but no PO file with that number is in 5 Purchase Orders."})
        else:
            checks.append({"ok": None, "text": "No PO number on the estimate and no matching PO on file (a change order may not have one)."})
        e["po"] = p
        e["checks"] = checks
        e["ties"] = ("no_po" if how == "no_po" else None if not p else all(c["ok"] is not False for c in checks))
    acc = [e for e in ests if e["status"] in ACCEPTED]
    pend = [e for e in ests if e["status"] == "Pending"]
    return {"estimates": ests, "po_files": pos,
            "accepted_total": round(sum(e["total"] for e in acc), 2), "accepted_n": len(acc),
            "pending_total": round(sum(e["total"] for e in pend), 2), "pending_n": len(pend),
            "other_n": len(ests) - len(acc) - len(pend)}
