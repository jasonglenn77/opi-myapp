"""
Financial audit export (.xlsx). Every tab is a real Excel table: one header row,
one row per thing, filter arrows on every column, so it can be read as it comes
or sorted, filtered and pivoted.

  Summary         one row per project
  Cost buckets    one row per project and cost bucket
  Line detail     one row per QuickBooks line: estimate, pending estimate,
                  invoice, bill, card
  Crew payments   schedule rows and crew bills, side by side
  Crew forms      kickoff, daily and completion forms on file, and what's missing
  Open issues     undecided items from Contractor Payments
  Expense timing  how each cost type reaches QuickBooks (the capture matrix)
  Notes           what each number means, the filters used, who exported it
"""
import io
from collections import defaultdict
from datetime import date, datetime

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.table import Table, TableStyleInfo
from sqlalchemy import bindparam, text

from app.assumptions import calibrate as CAL
from app.crewpay import service as CP
from app.db import engine
from app.jobcost import completion as COMP, service as JC

APP_URL = "https://app.onpointinstallers.com"
MONEY = '#,##0.00;[Red]-#,##0.00'
HEAD_FILL = PatternFill("solid", fgColor="1F3A5F")
DATE_FIELDS = ("best", "last_scheduled", "marked_complete", "completion_form", "final_invoice", "last_cost")


def _d(v):
    if not v:
        return None
    return v if isinstance(v, date) else date.fromisoformat(str(v)[:10])


def _clean(v):
    """QuickBooks text goes in as text: never a formula, no control characters."""
    if not isinstance(v, str):
        return v
    v = ILLEGAL_CHARACTERS_RE.sub("", v)
    return " " + v if v[:1] in ("=", "+", "@") else v


def _sheet(wb, title, name, cols, rows, first=False):
    """cols = [(header, width, kind)], kind: text | money | date | pct | int | link.
    A link cell is (text, url)."""
    ws = wb.active if first else wb.create_sheet()
    ws.title = title
    ws.append([c[0] for c in cols])
    for row in rows:
        ws.append([_clean(v[0] if isinstance(v, tuple) else v) for v in row])
    for i, (h, w, kind) in enumerate(cols, 1):
        letter = get_column_letter(i)
        ws.column_dimensions[letter].width = w
        c = ws.cell(row=1, column=i)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = HEAD_FILL
        c.alignment = Alignment(vertical="center", wrap_text=True)
        fmt = {"money": MONEY, "date": "m/d/yyyy", "pct": "0%", "int": "0"}.get(kind)
        if fmt or kind == "link":
            for r, row in enumerate(rows, 2):
                cell = ws.cell(row=r, column=i)
                if fmt:
                    cell.number_format = fmt
                if kind == "link" and isinstance(row[i - 1], tuple):
                    cell.hyperlink = row[i - 1][1]
                    cell.font = Font(color="1F5FBF", underline="single")
    ws.freeze_panes = "B2"
    ws.row_dimensions[1].height = 32
    if rows:
        t = Table(displayName=name, ref=f"A1:{get_column_letter(len(cols))}{len(rows) + 1}")
        t.tableStyleInfo = TableStyleInfo(name="TableStyleLight1", showRowStripes=True)
        ws.add_table(t)
    return ws


def _crew_names(rows):
    out = defaultdict(set)
    for r in rows:
        if r["schedule"] or r["paid"]:
            out[r["entity_id"]].add(r["crew"])
    return out


def select_jobs(conn, status=None, pm=None, crew=None, date_from=None, date_to=None, date_field="best", q=None, ids=None):
    """`ids` (project QuickBooks ids) = exactly the projects a page has filtered to."""
    done = COMP.load(conn)
    crew_rows = CP.dataset()["rows"]
    crews = _crew_names(crew_rows)
    states = {s for s in (status or []) if s}
    only = {str(i) for i in ids} if ids is not None else None
    out = []
    for j in JC.dataset()["jobs"]:
        if only is not None and j["id"] not in only:
            continue
        c = done.get(j["id"]) or {}
        if states and j["state"] not in states and (j.get("status") or "") not in states:
            continue
        if pm and (j["pm"] or "") != pm:
            continue
        if crew and crew not in crews.get(j["id"], ()):
            continue
        if q and q.lower() not in j["name"].lower():
            continue
        when = _d(c.get(date_field))
        if date_from and (not when or when < date_from):
            continue
        if date_to and (not when or when > date_to):
            continue
        out.append({**j, "done": c, "crews": sorted(crews.get(j["id"], ()))})
    out.sort(key=lambda j: j["name"])
    return out


def _flags(j, labor_paid):
    fl = []
    est, pend = j["est"].get("Crew labor", 0.0), (j.get("pend") or {}).get("Crew labor", 0.0)
    if est and labor_paid > est * (1 + JC.OVER_PCT):
        fl.append("Labor over estimate, pending covers it" if labor_paid <= (est + pend) * (1 + JC.OVER_PCT) else "Labor over estimate")
    if j["done"].get("flag"):
        fl.append(f"Completion dates {j['done']['gap_days']} days apart")
    if j.get("pending_contract"):
        fl.append("Pending estimates")
    return "; ".join(fl)


def _lines(conn, ids):
    """Every QuickBooks line on the jobs, one row per line, one shape."""
    q = lambda s: text(s).bindparams(bindparam("ids", expanding=True))
    out = []
    for r in conn.execute(q("""
        WITH est AS (
          SELECT t.*, JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.TxnStatus')) AS st, ROW_NUMBER() OVER (
                   PARTITION BY t.customer_qbo_id, COALESCE(t.doc_number, CONCAT('__nd__', t.qbo_id)) ORDER BY t.id DESC) AS rn
          FROM qbo_transactions t WHERE t.entity_type = 'Estimate' AND t.customer_qbo_id IN :ids)
        SELECT est.customer_qbo_id AS e, est.st, est.txn_date AS d, est.doc_number AS doc, l.item_name AS item, l.description AS descr,
               l.qty, l.unit_price, l.amount, l.cost_amount
        FROM est JOIN qbo_sales_transaction_lines l ON l.transaction_id = est.id AND l.line_level = 'child'
        WHERE est.rn = 1 AND est.st IN ('Accepted', 'Converted', 'Closed', 'Pending')
    """), {"ids": ids}).mappings():
        labor = (r["item"] or "").startswith("Contract Labor")
        cost = r["cost_amount"] if r["cost_amount"] is not None else (r["amount"] if labor else None)
        src = "Pending estimate" if r["st"] == "Pending" else "Estimate"
        out.append((r["e"], src, r["st"], r["d"], r["doc"], None, r["item"], r["descr"], r["qty"], r["unit_price"],
                    r["amount"], cost, None))
    for r in conn.execute(q("""
        SELECT l.project_customer_qbo_id AS e, t.entity_type AS ty, t.txn_date AS d, t.doc_number AS doc, t.balance_amt AS bal,
               l.item_name AS item, l.description AS descr, l.qty, l.unit_price, l.amount
        FROM qbo_sales_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE t.entity_type IN ('Invoice', 'CreditMemo') AND l.line_level = 'child' AND l.project_customer_qbo_id IN :ids
    """), {"ids": ids}).mappings():
        credit = r["ty"] == "CreditMemo"
        amt = -float(r["amount"] or 0) if credit else r["amount"]
        out.append((r["e"], "Credit memo" if credit else "Invoice", "Open" if float(r["bal"] or 0) > 0 else "Paid", r["d"], r["doc"],
                    None, r["item"], r["descr"], r["qty"], r["unit_price"], amt, None, None))
    for r in conn.execute(q("""
        SELECT l.line_customer_qbo_id AS e, t.entity_type AS ty, t.txn_date AS d, t.doc_number AS doc, t.balance_amt AS bal,
               COALESCE(JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.VendorRef.name')), JSON_UNQUOTE(JSON_EXTRACT(t.raw_json, '$.EntityRef.name'))) AS vendor,
               COALESCE(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')),
                 SUBSTRING_INDEX(JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.AccountBasedExpenseLineDetail.AccountRef.name')), ':', 1)) AS item,
               l.description AS descr, l.qty, l.unit_price, l.amount
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE t.entity_type IN ('Bill', 'Purchase') AND l.line_customer_qbo_id IN :ids
    """), {"ids": ids}).mappings():
        bill = r["ty"] == "Bill"
        out.append((r["e"], "Bill" if bill else "Card or check", ("Open" if float(r["bal"] or 0) > 0 else "Paid") if bill else "Paid",
                    r["d"], r["doc"], r["vendor"], r["item"], r["descr"], r["qty"], r["unit_price"], None, None, r["amount"]))
    return out


def build(status=None, pm=None, crew=None, date_from=None, date_to=None, date_field="best", q=None, who=None, ids=None):
    with engine.connect() as conn:
        jobs = select_jobs(conn, status, pm, crew, date_from, date_to, date_field, q, ids)
        ids = [j["id"] for j in jobs] or ["-"]
        lines = _lines(conn, ids)
        cap = CAL.expense_capture(conn)
        by_id = {j["id"]: j for j in jobs}
        scheds, insts = CP._schedules(conn)
        co, by_vendor = CP._crews(conn)
        paid_lines = [l for l in CP._paid_lines(conn) if str(l["e"] or "") in by_id]
    url = lambda j: f"{APP_URL}/#/entity/project/{j['id']}"
    wb = Workbook()

    labor_paid = lambda j: j["act"].get("Crew labor", 0.0)
    total = lambda d: sum(d.values()) if d else 0.0
    rows = [[(j["name"], url(j)), j["pm"], ", ".join(j["crews"]), j["state"].title(), j["status"], _d(j["start"]),
             _d(j["done"].get("best")), j["done"].get("best_source"), _d(j["done"].get("last_scheduled")), _d(j["done"].get("marked_complete")),
             _d(j["done"].get("completion_form")), _d(j["done"].get("final_invoice")), _d(j["done"].get("last_cost")),
             j.get("contract"), j.get("pending_contract"), j.get("invoiced"), j.get("open_ar"), total(j["est"]), total(j.get("pend")),
             total(j["act"]), j["est"].get("Crew labor", 0.0), (j.get("pend") or {}).get("Crew labor", 0.0), labor_paid(j),
             (j.get("contract") or 0) - total(j["act"]), _flags(j, labor_paid(j))] for j in jobs]
    _sheet(wb, "Summary", "Summary", [
        ("Project", 44, "link"), ("PM", 18, "text"), ("Crew", 26, "text"), ("State", 10, "text"), ("Status", 12, "text"), ("Start", 11, "date"),
        ("Completion (best)", 12, "date"), ("Completion source", 18, "text"), ("Last scheduled day", 12, "date"), ("Marked complete", 12, "date"),
        ("Completion form", 12, "date"), ("Last invoice", 12, "date"), ("Last cost", 12, "date"),
        ("Contract", 14, "money"), ("Pending estimates", 14, "money"), ("Invoiced", 14, "money"), ("Open A/R", 14, "money"),
        ("Estimated cost", 14, "money"), ("Pending cost", 14, "money"), ("Actual cost", 14, "money"),
        ("Labor estimate", 14, "money"), ("Labor pending", 14, "money"), ("Labor actual", 14, "money"),
        ("Contract less actual cost", 15, "money"), ("Flags", 44, "text")], rows, first=True)

    rows = []
    for j in jobs:
        for cat in JC.CATEGORIES:
            e, p, a = j["est"].get(cat, 0.0), (j.get("pend") or {}).get(cat, 0.0), j["act"].get(cat, 0.0)
            if e or p or a:
                rows.append([(j["name"], url(j)), j["pm"], j["state"].title(), cat, e, p, e + p, a, a - e, a - e - p,
                             (a / (e + p)) if e + p else None])
    _sheet(wb, "Cost buckets", "CostBuckets", [
        ("Project", 44, "link"), ("PM", 18, "text"), ("State", 10, "text"), ("Bucket", 15, "text"), ("Estimate", 14, "money"),
        ("Pending", 14, "money"), ("Estimate + pending", 14, "money"), ("Actual", 14, "money"), ("Actual less estimate", 14, "money"),
        ("Actual less estimate + pending", 16, "money"), ("Actual share of budget", 11, "pct")], rows)

    def bucket(item):
        return JC.category_of(item) or "Margin (OH&P, Buffer)"
    order = {"Estimate": 0, "Pending estimate": 1, "Invoice": 2, "Credit memo": 3, "Bill": 4, "Card or check": 5}
    rows = [[by_id[str(l[0])]["name"], by_id[str(l[0])]["pm"], l[1], l[2], _d(l[3]), l[4], l[5], l[6], bucket(l[6]), l[7],
             float(l[8]) if l[8] is not None else None, float(l[9]) if l[9] is not None else None,
             float(l[10]) if l[10] is not None else None, float(l[11]) if l[11] is not None else None,
             float(l[12]) if l[12] is not None else None]
            for l in sorted(lines, key=lambda x: (by_id[str(x[0])]["name"], order[x[1]], str(x[3]), str(x[4])))]
    _sheet(wb, "Line detail", "LineDetail", [
        ("Project", 44, "text"), ("PM", 18, "text"), ("Source", 16, "text"), ("Status", 11, "text"), ("Date", 11, "date"), ("Doc #", 12, "text"),
        ("Vendor", 26, "text"), ("Item or account", 30, "text"), ("Bucket", 18, "text"), ("Description", 50, "text"), ("Qty", 9, "text"),
        ("Unit price", 12, "money"), ("Customer price", 14, "money"), ("Cost basis", 14, "money"), ("Actual cost", 14, "money")], rows)

    rows = []
    for s in scheds:
        e = str(s["entity_id"])
        if e not in by_id:
            continue
        c = co.get(s["crew_id"]) or {}
        for i in insts.get(s["id"], []):
            if float(i["amount"] or 0):
                paid_how = {"sheet": "Marked on sheet", "qbo": "QuickBooks bill", "sheet+qbo": "Sheet and QuickBooks"}.get(i["paid_source"], i["paid_source"])
                rows.append([by_id[e]["name"], c.get("name") or "No crew set", "Scheduled", _d(i["pay_date"]), _d(i["send_invoice_date"]),
                             float(i["amount"]), None, (i["status"] or "").title(), paid_how, i["note"], s["source_file_name"], None,
                             float(s["lodging_included"] or 0) or None])
    for l in paid_lines:
        rows.append([by_id[str(l["e"])]["name"], (by_vendor.get(str(l["vendor"] or "")) or {}).get("name") or l["vendor_name"],
                     "Paid (QuickBooks)", _d(l["d"]), None, None, float(l["a"] or 0), None, "Bill" if l["type"] == "Bill" else "Card or check",
                     l["descr"], None, l["doc"], None])
    rows.sort(key=lambda r: (r[0], r[1], str(r[3])))
    _sheet(wb, "Crew payments", "CrewPayments", [
        ("Project", 44, "text"), ("Crew", 24, "text"), ("Row", 16, "text"), ("Date", 11, "date"), ("Send invoice", 11, "date"),
        ("Scheduled", 14, "money"), ("Paid", 14, "money"), ("Schedule status", 11, "text"), ("How", 18, "text"), ("Note", 40, "text"),
        ("Schedule file", 36, "text"), ("QuickBooks doc #", 14, "text"), ("Schedule includes lodging", 14, "money")], rows)

    crew_data = CP.dataset()
    labels = {"kickoff": "Kickoff checklist", "daily": "Daily forms", "completion": "Completion form"}
    rows = [[f["job"], f["crew"], f["pm"], {"finished": "Finished", "active": "In progress"}.get(f["state"], "Not started"), f["kickoff"], f["daily"],
             f["completion"], f["draft"], _d(f.get("completed_on")), ", ".join(labels[g] for g in f["missing"]) or "Nothing missing"]
            for f in crew_data.get("forms", []) if f["entity_id"] in by_id]
    _sheet(wb, "Crew forms", "CrewForms", [
        ("Project", 44, "text"), ("Crew", 24, "text"), ("PM", 16, "text"), ("Status", 11, "text"), ("Kickoff forms", 10, "text"), ("Daily forms", 10, "text"),
        ("Signed completion forms", 12, "text"), ("Unsigned drafts", 10, "text"), ("Date on completion form", 12, "date"), ("Missing", 44, "text")], rows)

    issues = [i for i in crew_data["issues"] if not i.get("entity_id") or i["entity_id"] in by_id]
    rows = [[i["label"], i["job"], i["crew"], i["pm"], i["amount"], i["detail"],
             (i.get("decision") or {}).get("label") or "Not decided", (i.get("decision") or {}).get("by"), (i.get("decision") or {}).get("note")]
            for i in issues]
    _sheet(wb, "Open issues", "OpenIssues", [
        ("Issue", 34, "text"), ("Project", 40, "text"), ("Crew", 22, "text"), ("PM", 16, "text"), ("Amount", 14, "money"), ("Detail", 70, "text"),
        ("Decision", 22, "text"), ("Decided by", 22, "text"), ("Decision note", 40, "text")], rows)

    rows = []
    for cat, v in cap.items():
        for kind, g in (("All", v), ("Bills", v.get("bills")), ("Cards and checks", v.get("cards"))):
            if g:
                rows.append([cat, kind, g.get("tagged"), g.get("untagged"), g.get("tagged_share"), g.get("entry_lag_days"), g.get("after_end_share")])
    _sheet(wb, "Expense timing", "ExpenseTiming", [
        ("Category", 16, "text"), ("Bills or cards", 16, "text"), ("Tagged to a job", 15, "money"), ("Not tagged", 15, "money"),
        ("Share tagged", 10, "pct"), ("Days from charge to entry", 12, "text"), ("Share dated after job end", 12, "pct")], rows)

    ws = wb.create_sheet("Notes")
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 110
    filters = ", ".join(f"{k}: {v}" for k, v in (("Status", ", ".join(status or []) or None), ("PM", pm), ("Crew", crew),
                        (f"From ({date_field})", date_from), (f"To ({date_field})", date_to), ("Search", q)) if v) or "None"
    notes = [("Exported", f"{datetime.now():%m/%d/%Y %I:%M %p} by {who or 'unknown'}"), ("Filters", filters), ("Projects", str(len(jobs))),
             ("", ""),
             ("Estimate", "Latest version of each Accepted, Converted or Closed QuickBooks estimate on the project. Cost basis is the estimate's YOUR RATE cost; contract labor uses the line amount when no cost is set, the same as the Billing tab."),
             ("Pending", "Pending QuickBooks estimates on the project. Staff can run behind on change orders, so spend may arrive first. Pending is shown beside the estimate and is never counted as approved. A change order that was never entered can't appear here. A Pending estimate filed under the customer instead of the job isn't counted either; Contractor Payments lists the ones that look like they belong to a job."),
             ("Actual", "QuickBooks bills and card or check purchases tagged to the project. Job cost that was never tagged to a project is not included."),
             ("Crew labor", "Lines on Contract Labor items. Owner pay sits on General and Admin Payroll accounts and is not included."),
             ("Completion (best)", "OPI has no official completion date. Best = the date written on the crew's Project Completion Form, otherwise the last scheduled day. Scans and photos of the form can't be read, so those jobs use the last scheduled day and say so in Completion source. All the other dates are shown so they can be compared. Marked complete only exists from April 2026."),
             ("Scheduled vs paid", "Crews are paid in lump runs covering several jobs, so compare totals by job and crew, not row by row."),
             ("Crew forms", "Drive files are matched by name in the project folders, plus forms sent through the Crew Portal. A Word copy of the Completion Form has blank signature lines, so it counts as an unsigned draft. A PDF or photo is taken as signed, which a file name can't prove."),
             ("Expense timing", "Measured from the last 12 months of QuickBooks: how much of each cost type gets a job tag, how long entry takes, and how much lands after the job ends. The same numbers are on the Assumptions page.")]
    for a, b in notes:
        ws.append([a, b])
        ws.cell(row=ws.max_row, column=1).font = Font(bold=True)
        ws.cell(row=ws.max_row, column=2).alignment = Alignment(wrap_text=True, vertical="top")
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue(), len(jobs)
