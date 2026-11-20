"""Crew offer paperwork saved in the job's 7 Notes folder when an offer is
marked sent (2026-11-19 owner feedback):

  * "Payment Schedule - <job> - #<estimate>.xlsx", laid out like OPI's Drive
    Payment Schedule (Estimated Contract Payment Schedule: project, dates,
    contract / paid / remaining, then one row per payment with its send-invoice
    date and comment)
  * "Crew offer - <job> - #<estimate> - <crew>.eml", the email exactly as copied
    (HTML with the payment grid, plus a plain-text copy). Opens in Outlook and in
    the app's document viewer.
"""
import io
import re
from datetime import date, datetime
from email.message import EmailMessage

from sqlalchemy import text

from app.db import engine
from app.s3 import AWS_BUCKET, build_document_key, s3_client

FOLDER = "7_notes"


def _job_parts(name):
    """'6025 - Maersk - Hopedale, MA' -> ('6025', 'Maersk', 'Hopedale, MA')."""
    parts = [p.strip() for p in str(name or "").split(" - ")]
    num = parts[0] if parts and re.fullmatch(r"\d+", parts[0] or "") else ""
    rest = parts[1:] if num else parts
    return num, (rest[0] if rest else name or ""), (" - ".join(rest[1:]) if len(rest) > 1 else "")


def _d(v):
    if not v:
        return None
    if isinstance(v, (date, datetime)):
        return v if isinstance(v, date) else v.date()
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


def schedule_data(conn, entity_id, estimate_qbo_id):
    proj = conn.execute(text("SELECT display_name FROM qbo_customers WHERE qbo_id = :e"), {"e": entity_id}).scalar()
    s = conn.execute(text("""SELECT id, estimate_doc_number, contract_labor, start_date, end_date, invoice_lead_days
                             FROM project_payment_schedules WHERE entity_id = :e AND estimate_qbo_id = :q"""),
                     {"e": entity_id, "q": estimate_qbo_id}).mappings().first()
    rows = []
    if s:
        rows = [dict(r) for r in conn.execute(text("""
            SELECT seq, pay_date, amount, send_invoice_date, status, note FROM project_payment_installments
            WHERE schedule_id = :s ORDER BY pay_date IS NULL, pay_date, seq, id"""), {"s": s["id"]}).mappings()]
    lead = int((s or {}).get("invoice_lead_days") or 7)
    for r in rows:
        if not r["send_invoice_date"] and r["pay_date"]:
            r["send_invoice_date"] = _d(r["pay_date"]).fromordinal(_d(r["pay_date"]).toordinal() - lead)
    paid = sum(float(r["amount"] or 0) for r in rows if r["status"] == "paid")
    return {"project": proj or entity_id, "doc": (s or {}).get("estimate_doc_number"),
            "labor": float((s or {}).get("contract_labor") or 0), "start": _d((s or {}).get("start_date")),
            "end": _d((s or {}).get("end_date")), "rows": rows, "paid": paid}


def schedule_xlsx(sd):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    wb = Workbook()
    ws = wb.active
    ws.title = "Payment Schedule"
    blue = PatternFill("solid", fgColor="A9C4EB")
    thin = Side(style="thin", color="BFBFBF")
    box = Border(left=thin, right=thin, top=thin, bottom=thin)
    bold = Font(bold=True)
    center = Alignment(horizontal="center", vertical="center")
    num, name, _loc = _job_parts(sd["project"])
    ws.merge_cells("A1:F1")
    ws["A1"] = "Estimated Contract Payment Schedule"
    ws["A1"].font, ws["A1"].fill, ws["A1"].alignment = bold, blue, center
    money = '"$"#,##0.00'
    left = [("Project Name", name), ("Project Number", int(num) if num else ""),
            ("Project Start Date", sd["start"]), ("Estimated End Date", sd["end"])]
    right = [("Contract Value", sd["labor"]), ("Paid to Date", sd["paid"]), ("Remaining Value", sd["labor"] - sd["paid"])]
    for i, (k, v) in enumerate(left, start=2):
        ws.cell(i, 1, k)
        c = ws.cell(i, 2, v)
        c.alignment = center
        if isinstance(v, date):
            c.number_format = "m/d/yyyy"
        elif isinstance(v, int):
            c.number_format = "#,##0"
    for i, (k, v) in enumerate(right, start=2):
        ws.cell(i, 5, k)
        ws.cell(i, 6, round(v, 2)).number_format = money
    if sd["doc"]:
        ws.cell(6, 1, "Estimate")
        ws.cell(6, 2, f"#{sd['doc']}").alignment = center
    heads = ["Payment Number", "Payment Date", "Payment Amount", "Send Invoice Date", "Comments", ""]
    for j, h in enumerate(heads, start=1):
        c = ws.cell(7, j, h)
        c.font, c.fill, c.alignment, c.border = bold, blue, center, box
    for i, r in enumerate(sd["rows"], start=8):
        vals = [i - 7, _d(r["pay_date"]), round(float(r["amount"] or 0), 2), _d(r["send_invoice_date"]), r["note"] or "", ""]
        for j, v in enumerate(vals, start=1):
            c = ws.cell(i, j, v)
            c.alignment, c.border = center, box
            if j in (2, 4) and v:
                c.number_format = "m/d/yyyy"
            if j == 3:
                c.number_format = money
    end = 8 + len(sd["rows"])
    ws.cell(end, 2, "Total").font = bold
    t = ws.cell(end, 3, round(sum(float(r["amount"] or 0) for r in sd["rows"]), 2))
    t.number_format, t.font = money, bold
    for col, w in zip("ABCDEF", (20, 18, 18, 20, 26, 14)):
        ws.column_dimensions[col].width = w
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def offer_eml(subject, html_body, text_body):
    m = EmailMessage()
    m["Subject"] = subject
    m["X-Unsent"] = "1"           # Outlook opens it as a draft ready to send
    m.set_content(text_body or "")
    if html_body:
        m.add_alternative(f"<!doctype html><html><body>{html_body}</body></html>", subtype="html")
    return bytes(m)


def _safe(s):
    return re.sub(r'[\\/:*?"<>|]+', "-", str(s or "")).strip()[:120]


def _put(conn, entity_id, filename, body, ctype, user_id):
    key = build_document_key("project", str(entity_id), FOLDER, filename)
    s3_client.put_object(Bucket=AWS_BUCKET, Key=key, Body=body, ContentType=ctype)
    return conn.execute(text("""
        INSERT INTO documents (entity_type, entity_id, folder, s3_bucket, s3_key, original_filename, content_type,
                               size_bytes, uploaded_by_user_id)
        VALUES ('project', :i, :f, :b, :k, :fn, :ct, :sz, :u)"""),
        {"i": str(entity_id), "f": FOLDER, "b": AWS_BUCKET, "k": key, "fn": filename, "ct": ctype,
         "sz": len(body), "u": user_id}).lastrowid


def save_offer_docs(entity_id, estimate_qbo_id, crew_name, script_html, script_text, user_id):
    """Save the payment schedule (.xlsx) and the offer email (.eml) in 7 Notes.
    Returns [{id, filename}] (empty when S3 isn't reachable: the offer stands)."""
    with engine.begin() as conn:
        sd = schedule_data(conn, entity_id, estimate_qbo_id)
        num, name, _loc = _job_parts(sd["project"])
        job = _safe(f"{num} {name}".strip())
        est = f"#{sd['doc']}" if sd["doc"] else ""
        stamp = date.today().isoformat()
        out = []
        x = schedule_xlsx(sd)
        fn = _safe(f"Payment Schedule - {job} {est} - {stamp}") + ".xlsx"
        out.append({"id": _put(conn, entity_id, fn, x,
                               "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", user_id),
                    "filename": fn})
        if script_html or script_text:
            subject = f"Job offer: {sd['project']}{' ' + est if est else ''}"
            e = offer_eml(subject, script_html, script_text)
            fn = _safe(f"Crew offer - {job} {est} - {crew_name or 'crew'} - {stamp}") + ".eml"
            out.append({"id": _put(conn, entity_id, fn, e, "message/rfc822", user_id), "filename": fn})
    return out
