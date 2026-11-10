"""
The project's first QuickBooks estimate, drafted the way OPI's office builds it.

Researched 2026-11-05 on 918 won jobs (estimator's estimate vs the project's
first estimate vs the PO and the quoting-metrics workbook):

  copy        the estimator's estimate (Pending, under the dealer) is copied onto
              the new project with the same number
  PO line     a top text line "PO #<number>" plus the job site (908 of 918)
  OH&P        each group's OH&P lines go to $0 and the amount is spread equally
              over the group's other non-zero lines, Buffer excluded (most groups;
              some are rounded or split by judgment)
  options     when the quote priced options, only the group(s) the PO bought stay
  terms       the Payment Terms line carries over: 35% on PO / 35% at start /
              30% at completion on almost every job, so the first invoice is
              usually 35% of the estimate

draft(opportunity_id) returns the proposal for staff to check against the PO
before they enter it in QuickBooks (or push it, once that's switched on).
"""
import io
import re
from itertools import combinations

from sqlalchemy import text

from app.db import engine

def _is_ohp(item):     # "OH&P", "OH&P - Daily Rate Non Local", ...
    return (item or "").startswith("OH&P")


def _is_skip(item):
    return _is_ohp(item) or (item or "").startswith("Buffer")


def _groups(conn, txn_id):
    """[{name, total, description, lines: [{item, description, amount}]}] and the text lines."""
    rows = conn.execute(text("""
        SELECT line_level, line_key, parent_line_key, group_item_name, item_name, amount, description
        FROM qbo_sales_transaction_lines WHERE transaction_id = :t ORDER BY id"""), {"t": txn_id}).mappings().all()
    groups, texts, by = [], [], {}
    for r in rows:
        if r["line_level"] == "parent" and r["group_item_name"]:
            g = {"name": r["group_item_name"], "total": float(r["amount"] or 0), "description": r["description"] or "", "lines": []}
            groups.append(g)
            by[r["line_key"]] = g
        elif r["line_level"] == "parent" and (r["item_name"] or r["description"]):
            texts.append({"item": r["item_name"] or "", "description": r["description"] or "", "amount": float(r["amount"] or 0)})
    for r in rows:
        if r["line_level"] == "child" and r["parent_line_key"] in by:
            by[r["parent_line_key"]]["lines"].append(
                {"item": r["item_name"], "description": r["description"] or "", "amount": float(r["amount"] or 0)})
    return groups, texts


def spread_ohp(lines):
    """OH&P to $0, spread equally over the other non-zero lines (Buffer excluded),
    in whole dollars like OPI's office; the remainder goes to the first line so the
    group total doesn't move."""
    ohp = round(sum(l["amount"] for l in lines if _is_ohp(l["item"])), 2)
    out = [{**l, "was": l["amount"]} for l in lines]
    targets = [i for i, l in enumerate(out) if not _is_skip(l["item"]) and abs(l["amount"]) > 0.005]
    for l in out:
        if _is_ohp(l["item"]):
            l["amount"] = 0.0
    if ohp and targets:
        share = float(int(ohp / len(targets)))
        for i in targets:
            out[i]["amount"] = round(out[i]["amount"] + share, 2)
        out[targets[0]]["amount"] = round(out[targets[0]]["amount"] + ohp - share * len(targets), 2)
    elif ohp:   # nothing to spread onto: leave it where it was
        for l in out:
            if _is_ohp(l["item"]):
                l["amount"] = l["was"]
    return out, ohp


def _pick_options(groups, po_total):
    """The groups the PO bought: every group when they already add up to the PO
    (or there's no PO total), else the smallest set of priced groups that does."""
    priced = [i for i, g in enumerate(groups) if abs(g["total"]) > 0.005]
    total = sum(groups[i]["total"] for i in priced)
    if not po_total or abs(total - po_total) <= 1:
        return priced, abs(total - (po_total or total)) <= 1
    if len(priced) <= 12:
        for n in range(1, len(priced) + 1):
            for combo in combinations(priced, n):
                if abs(sum(groups[i]["total"] for i in combo) - po_total) <= 1:
                    return list(combo), True
    return priced, False


_NUM = r"((?=[A-Z0-9\-_/]*\d)[A-Z0-9][A-Z0-9\-_/]{2,})"     # a token with at least one digit
_PO_NUM = [
    r"P\.?\s*O\.?\s*(?:NUMBER|NO\.?|#)\s*:?\s*\n?\s*" + _NUM,
    r"PURCHASE\s+ORDER\s*(?:NUMBER|NO\.?|#)\s*:?\s*\n?\s*" + _NUM,
    r"\bPO\s*#?\s*:?\s*" + _NUM,
]
# the PO's own total comes first; a quote attached behind it has its own TOTAL later
_TOTAL = r"(?:GRAND\s+)?TOTAL\s*(?:DUE|AMOUNT)?\s*:?\s*\$?\s*([\d,]+\.\d{2})"


def parse_po(txt):
    """{po_number, total} from a PO's text, best effort."""
    po = None
    for p in _PO_NUM:
        m = re.search(p, txt, re.I)
        if m and not re.fullmatch(r"(?i)date|number|box", m.group(1)):
            po = m.group(1).strip().rstrip(".")
            break
    m = re.search(_TOTAL, txt, re.I)
    if m:
        total = float(m.group(1).replace(",", ""))
    else:          # no TOTAL label: the largest amount on the first page
        vals = [float(v.replace(",", "")) for v in re.findall(r"\$\s*([\d,]+\.\d{2})", txt[:3000])]
        total = max(vals) if vals else None
    return {"po_number": po, "total": total}


def _pdf_text(key):
    from pypdf import PdfReader
    from app.s3 import s3_client, AWS_BUCKET
    body = s3_client.get_object(Bucket=AWS_BUCKET, Key=key)["Body"].read()
    return "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(body)).pages[:4])


def po_info(conn, doc):
    """Parsed PO, cached per document (reading S3 + the PDF is slow)."""
    row = conn.execute(text("SELECT po_number, po_total, text_snippet FROM setup_po_parsed WHERE document_id = :d"),
                       {"d": doc["id"]}).mappings().first()
    if row:
        return {"po_number": row["po_number"], "total": float(row["po_total"]) if row["po_total"] is not None else None,
                "snippet": row["text_snippet"]}
    try:
        txt = _pdf_text(doc["s3_key"])
    except Exception as e:  # unreadable PDF: remember that too, so it isn't re-read every time
        txt = ""
    info = parse_po(txt) if txt else {"po_number": None, "total": None}
    snippet = re.sub(r"[ \t]+", " ", txt)[:1500]
    conn.execute(text("""INSERT INTO setup_po_parsed (document_id, po_number, po_total, text_snippet)
                         VALUES (:d, :n, :t, :s) ON DUPLICATE KEY UPDATE po_number = VALUES(po_number),
                         po_total = VALUES(po_total), text_snippet = VALUES(text_snippet), parsed_at = NOW()"""),
                 {"d": doc["id"], "n": info["po_number"], "t": info["total"], "s": snippet})
    return {**info, "snippet": snippet}


def _site(conn, opp):
    """Job site for the PO line: the project's name less its number, else the opportunity's city/state."""
    if opp.get("project_name"):
        bits = [b.strip() for b in opp["project_name"].split(" - ")]
        if len(bits) >= 2 and bits[0].isdigit():
            return " - ".join(bits[1:])
    return ", ".join(x for x in (opp.get("city"), opp.get("state")) if x)


def terms_percents(texts):
    t = " ".join(x["description"] for x in texts if x["item"] == "Payment Terms")
    return [int(v) for v in re.findall(r"(\d{1,3})\s*%", t)][:6], t


def draft(conn, opp_id):
    opp = conn.execute(text("""
        SELECT o.*, qc.display_name AS project_name FROM opportunities o
        LEFT JOIN qbo_customers qc ON qc.qbo_id = o.project_qbo_id WHERE o.id = :i"""), {"i": opp_id}).mappings().first()
    if not opp:
        return None
    opp = dict(opp)
    out = {"opportunity_id": opp_id, "quote_number": opp["quote_number"], "warnings": []}
    src = conn.execute(text("""
        SELECT t.id, t.qbo_id, t.doc_number, t.txn_date, t.total_amt, qc.display_name AS customer,
               JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) AS status
        FROM qbo_transactions t JOIN qbo_customers qc ON qc.qbo_id = t.customer_qbo_id
        WHERE t.entity_type = 'Estimate' AND t.doc_number = :q AND COALESCE(qc.is_project, 0) = 0
        ORDER BY t.txn_date DESC, t.id DESC LIMIT 1"""), {"q": opp["quote_number"]}).mappings().first()
    if not src and opp.get("project_qbo_id"):
        # already moved onto the project (no customer copy left): show what's there
        src = conn.execute(text("""
            SELECT t.id, t.qbo_id, t.doc_number, t.txn_date, t.total_amt, qc.display_name AS customer,
                   JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) AS status
            FROM qbo_transactions t JOIN qbo_customers qc ON qc.qbo_id = t.customer_qbo_id
            WHERE t.entity_type = 'Estimate' AND t.customer_qbo_id = :p ORDER BY t.txn_date, t.id LIMIT 1"""),
            {"p": opp["project_qbo_id"]}).mappings().first()
    po_docs = conn.execute(text("""
        SELECT id, s3_key, original_filename, drive_modified FROM documents
        WHERE entity_type = 'opportunity' AND entity_id = :i AND folder = '5_purchase_orders'
          AND LOWER(original_filename) LIKE '%.pdf' AND drive_removed_at IS NULL
        ORDER BY drive_modified DESC, id DESC"""), {"i": str(opp_id)}).mappings().all()
    po = None
    if po_docs:
        po = {**po_info(conn, po_docs[0]), "document_id": po_docs[0]["id"], "filename": po_docs[0]["original_filename"]}
    out["po"] = po
    if not src:
        out["warnings"].append(f"No QuickBooks estimate #{opp['quote_number']} found for this quote.")
        return out
    groups, texts = _groups(conn, src["id"])
    out["source"] = {"qbo_id": src["qbo_id"], "doc_number": src["doc_number"], "date": str(src["txn_date"]),
                     "total": float(src["total_amt"] or 0), "customer": src["customer"], "status": src["status"]}
    keep, exact = _pick_options(groups, po and po.get("total"))
    if po and po.get("total") and not exact:
        out["warnings"].append(f"The estimate's groups don't add up to the PO total ({po['total']:,.2f}). Check the PO against the quote.")
    elif po and po.get("total") and len(keep) < len([g for g in groups if abs(g['total']) > 0.005]):
        out["warnings"].append("The quote priced options. Only the group(s) adding up to the PO are kept.")
    if not po:
        out["warnings"].append("No PO PDF in the job's 5 Purchase Orders folder yet.")
    elif not po.get("po_number"):
        out["warnings"].append("Couldn't read the PO number from the PDF. Type it in the PO line.")
    built, ohp_total = [], 0.0
    for i, g in enumerate(groups):
        if i not in keep:
            continue
        lines, ohp = spread_ohp(g["lines"])
        ohp_total += ohp
        built.append({"name": g["name"], "description": g["description"], "total": round(sum(l["amount"] for l in lines), 2),
                      "ohp_spread": ohp, "lines": lines})
    total = round(sum(g["total"] for g in built), 2)
    site = _site(conn, opp)
    po_line = "\n".join(x for x in (f"PO #{po['po_number']}" if po and po.get("po_number") else "PO #", site) if x)
    pcts, terms = terms_percents(texts)
    first_pct = pcts[0] if pcts else None
    out.update({
        "po_line": po_line, "groups": built, "total": total, "ohp_total": round(ohp_total, 2),
        "text_lines": [t for t in texts if t["item"] in ("Payment Terms", "Stipulations") or t["description"].startswith("BOM")],
        "terms_percents": pcts, "terms": terms,
        "first_invoice": {"percent": first_pct, "amount": round(total * first_pct / 100, 2) if first_pct else None},
    })
    if not pcts:
        out["warnings"].append("No percentage payment terms on the quote. Check the PO for how to invoice.")
    if po and po.get("total") and abs(total - po["total"]) > 1:
        out["warnings"].append(f"Draft total {total:,.2f} differs from the PO total {po['total']:,.2f}.")
    return out
