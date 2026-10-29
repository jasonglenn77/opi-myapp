"""
Crew "Payment Schedule" files (Google Drive) -> the app's crew payment schedules.

Owner decision 2026-10-26: like the Job Schedule, the Drive sheets WIN. Every
project folder under Drive "Customers" has a `7 Notes/Payment Schedule.xlsx`
(a few are Google Sheets): the crew's negotiated contract and its bi-weekly
draws. This module copies them into project_payment_schedules +
project_payment_installments every night (run.refresh_all, after the Drive
documents step) and on the Data Review "Refresh from Google" button. What it
can't match or map becomes a Data Review item (review_payments.py).

Locate
  One Drive query (`name contains 'Payment Schedule'`, ~1,400 files, 2 pages).
  A file counts when its folder is under Customers (drive_folders, the
  documents-sync mirror). Its project = the documents row of that file (a
  folder linked by hand in the holding area wins), else the nearest matched
  ancestor folder in drive_folders (project / project_via_quote, or an
  opportunity linked to a QBO project). Parses are cached in
  gsync_payment_files by Drive modifiedTime: only changed files are downloaded.
  Byte-identical blank templates (drive_sync_state.template_md5) are skipped.

Parse (openpyxl; Google Sheets exported to xlsx, Sheets API as a fallback)
  Header A2:B5 / E2:F4 by label (Project Name/Number/Start/End, Contract
  Value, Paid to Date, Remaining), the grid under the "Payment Number" header:
  #, pay date, amount, send-invoice date, comments + the unlabeled columns
  after Comments (crew notes, `pd` / `paid` / `pd 7.31` paid markers). Rows
  with a date but no amount are projections (skipped); rows with an amount
  but a TBD date are kept undated. Year typos (9/4/3036, 7/31/0206) are fixed
  from the neighbouring rows and flagged. Phase label rows prefix the notes.

Which files
  Version copies ("Payment Schedule", "… 1.0", "… 2.0", "Copy of …") of the
  same scope on the same project: the most recently modified one wins, the
  others are 'superseded'. A file whose every (date, amount) row is inside
  another file of the project is a 'duplicate' (IDL's "Permit Delay" rows are
  inside "1.0"). Scope/crew suffixes ("- Unload", "- Rosales", "- Phase 2")
  are separate schedules.

Map
  Project: the folder's project. The "Project Number" cell refines it — equal
  to an estimate/CO doc # on the project -> that estimate's schedule; pointing
  at a different project -> kept on the folder's project and flagged
  (ambiguous). A file outside any project folder falls back to the cell
  (QBO project prefix, else an estimate # on a project), else unmatched.
  Schedule key: an estimate-# file -> (project, that estimate); the main
  project-level file -> the project's main estimate (earliest accepted with
  Contract Labor); other scope files -> estimate_qbo_id 'gs-<hash of the file id>'.
  When a project-level file exists, the other accepted estimates' generated
  even-split schedules are folded in (source 'sheet_covered': one $0 undated
  row, contract 0) so change orders aren't counted twice.
  Crew company: the file-name suffix (company / code / lead name), a lead
  named in the comments, the schedule's crew already in the app, the single
  company assigned on the Assignment, the single crew vendor on the project's
  QBO Contract-Labor bills — else unknown (flagged).
  Contract value -> contract_labor (sheet CV, else the row total).
  Installments: pay date, amount, send-invoice date (sheet, else pay - 7),
  note = comments. Status 'paid' when the sheet marks it paid, OR a QBO
  Contract-Labor bill from the crew company's vendor on the project matches
  it (bill dated send-invoice-3 .. pay+21, amount within max($50, 5%)), OR
  the app already had it paid by hand; else 'pending'. Rows are written
  edited=1 (so Billing's "Refresh" keeps them) with source='sheet'.
  Project holds: unpaid dates pass through projects.holds (a date inside an
  active hold window moves by the hold length in whole weeks; a sheet date
  equal to the hold's recorded original keeps the moved value).
  Idempotent: the desired state is compared with the app and only differences
  are written (updated in place by seq so row ids stay stable); every project
  changed gets an audit_log entry (crew_payment.sheet_import).

  python -m app.gsync.payment_import                    # dry run (no writes)
  python -m app.gsync.payment_import --apply            # write
  options: --only-job NNNN  --reread (ignore the parse cache)  --verbose
"""
import argparse
import collections
import io
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

from sqlalchemy import text

from app.db import engine
from app.audit import record_audit

SOURCE = "payment_import"
ROOT = "1Et_Zd3qvaQCkfat6AFfCUw4t7vSgVjsM"          # Drive "Customers" (docs_sync.ROOT)
GSHEET = "application/vnd.google-apps.spreadsheet"
XLSX_MIMES = ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel",
              "application/vnd.ms-excel.sheet.macroEnabled.12", GSHEET)
PAYROLL_ANCHOR = date(2026, 1, 2)                    # company-wide bi-weekly payroll Friday
ACTOR = {"email": "payment-schedule@system.onpointinstallers.com"}
NAME_RX = re.compile(r"payment\s*sched", re.I)
PAID_RX = re.compile(r"^\s*(pd|paid)\b", re.I)
EPS = 0.5


def drive_link(fid, mime):
    return (f"https://docs.google.com/spreadsheets/d/{fid}/edit" if mime == GSHEET
            else f"https://drive.google.com/file/d/{fid}/view")


def _gs_key(file_id):
    """estimate_qbo_id of an extra scope/crew file's schedule (column is 40 chars,
    Google Sheet ids are 44): 'gs-' + a short hash; source_file_id has the id."""
    import hashlib
    return "gs-" + hashlib.sha1(file_id.encode()).hexdigest()[:20]


def on_cycle(d):
    return d is not None and (d - PAYROLL_ANCHOR).days % 14 == 0


def _iso(d):
    return d.isoformat() if d else None


def _d(v):
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        return None


# ── file name -> scope label / version ───────────────────────────────────────

def scope_of(name):
    """("unload", "1.0") from "Payment Schedule - Unload 1.0.xlsx". A version
    (N.N / vN / "Copy of" / "(1)") marks a copy of the same scope."""
    n = re.sub(r"\.(xlsx|xlsm|xls|csv)$", "", (name or "").strip(), flags=re.I)
    version = None
    if re.match(r"(?i)^copy of\s+", n):
        n, version = re.sub(r"(?i)^copy of\s+", "", n), "copy"
    m = re.search(r"\s*\((\d+)\)\s*$", n)
    if m:
        n, version = n[:m.start()], version or f"({m.group(1)})"
    n = NAME_RX.sub(" ", n, count=1)
    n = re.sub(r"(?i)\bschedule\b|\bule\b", " ", n)
    m = (re.search(r"(?i)(?:^|[\s_-])v(\d+(?:\.\d+)?)\s*$", n)
         or re.search(r"(?:^|[\s_-])(\d+\.0)\s*$", n))
    if m and re.search(r"(?i)phase\s*$", n[:m.start()]):
        m = None                                        # "Phase 2.0" is a scope, not a version
    if m:
        n, version = n[:m.start()], version or m.group(1)
    label = re.sub(r"\s+", " ", n).strip(" -_–—.")
    return label, version


# ── parsing ──────────────────────────────────────────────────────────────────

HEAD = {"project name": "name", "project number": "number", "project #": "number", "project start date": "start",
        "start date": "start", "estimated end date": "end", "end date": "end", "contract value": "cv",
        "paid to date": "ptd", "remaining value": "remaining", "remaining": "remaining"}
GRID = {"payment number": "num", "payment #": "num", "payment date": "date", "payment amount": "amount",
        "amount": "amount", "send invoice date": "inv", "invoice date": "inv", "comments": "comments", "comment": "comments"}


def _norm(v):
    return re.sub(r"\s+", " ", str(v)).strip().strip(":").lower() if isinstance(v, str) else None


def _num(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip().replace("$", "").replace(",", "")
        if re.fullmatch(r"-?\d+(\.\d+)?", s):
            return float(s)
    return None


def _date_cell(v, serial_ok=True):
    """(date | None, raw-text-if-unparsed). Excel/Sheets serials, datetimes,
    m/d/yyyy text."""
    if v is None or v == "":
        return None, None
    if isinstance(v, datetime):
        return v.date(), None
    if isinstance(v, date):
        return v, None
    if isinstance(v, (int, float)) and serial_ok and 20000 < v < 80000:
        return date(1899, 12, 30) + timedelta(days=int(v)), None
    s = str(v).strip()
    m = re.fullmatch(r"(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})", s)
    if m:
        mo, dd, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        y = y + 2000 if y < 100 and len(m.group(3)) == 2 else y
        try:
            return date(max(1, y), mo, dd), None
        except ValueError:
            return None, s
    try:
        return date.fromisoformat(s[:10]), None
    except ValueError:
        return None, s


def _job_num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return str(int(v)) if 100 <= v < 100000 else None
    m = re.search(r"(?<!\d)(\d{4,5})(?!\d)", str(v))
    return m.group(1) if m else None


def grid_from_xlsx(b):
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(b), data_only=True)
    best = None
    for ws in wb.worksheets[:4]:
        g = {}
        for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row or 0, 250), max_col=16):
            for c in row:
                if c.value not in (None, ""):
                    g[(c.row, c.column)] = c.value
        if any(_norm(v) == "payment number" or _norm(v) == "payment date" for v in g.values()):
            return g
        best = best or g
    return best or {}


def grid_from_values(values):
    g = {}
    for r, row in enumerate(values, start=1):
        for c, v in enumerate(row, start=1):
            if v not in (None, ""):
                g[(r, c)] = v
    return g


def parse_grid(g):
    """Parsed Payment Schedule: header fields + rows (+ parse notes)."""
    out = {"name": None, "number": None, "start": None, "end": None, "cv": None, "ptd": None,
           "remaining": None, "rows": [], "notes": [], "uses_paid_marker": False}
    labels = {}
    for (r, c), v in g.items():
        n = _norm(v)
        if n in HEAD and r <= 15 and HEAD[n] not in labels:
            labels[HEAD[n]] = (r, c)
    all_labels = set(HEAD) | set(GRID)
    for key, (r, c) in labels.items():
        val = None
        for dc in (1, 2):
            v = g.get((r, c + dc))
            if v is None:
                continue
            if _norm(v) in all_labels:
                break
            val = v
            break
        if key in ("start", "end"):
            out[key] = _iso(_date_cell(val)[0])
        elif key in ("cv", "ptd", "remaining"):
            out[key] = _num(val)
            if val is not None and out[key] is None:
                out["notes"].append(f"{key} not a number: {str(val)[:40]}")
        elif key == "number":
            out["number_raw"] = None if val is None else (f"{val:g}" if isinstance(val, float) else str(val).strip())[:60]
            out["number"] = _job_num(val)
        else:
            out[key] = None if val is None else str(val).strip()[:120]

    hdr = None
    for (r, c), v in sorted(g.items()):
        if _norm(v) in ("payment number", "payment date") and r <= 40:
            hdr = r
            break
    if hdr is None:
        return out
    cols = {}
    for (r, c), v in g.items():
        if r == hdr and _norm(v) in GRID:
            cols.setdefault(GRID[_norm(v)], c)
    cnum, cdate = cols.get("num", 1), cols.get("date", 2)
    camt, cinv = cols.get("amount", 3), cols.get("inv", 4)
    ccom = cols.get("comments", 5)
    extra = [c for c in range(ccom + 1, min(ccom + 5, 11))]
    last_row = max((r for (r, c) in g), default=hdr)
    phase, empty, prev_pay = None, 0, None
    for r in range(hdr + 1, last_row + 1):
        num, dv, av, iv = g.get((r, cnum)), g.get((r, cdate)), g.get((r, camt)), g.get((r, cinv))
        texts = [g.get((r, c)) for c in [ccom] + extra]
        if all(x in (None, "") for x in (num, dv, av, iv)) and all(t in (None, "") for t in texts):
            empty += 1
            if empty >= 8:
                break
            continue
        empty = 0
        amount = _num(av)
        pay, pay_raw = _date_cell(dv)
        if isinstance(num, str) and _num(num) is None and amount is None and pay is None:
            phase = num.strip()[:40]                    # "Phase 2.1" section row
            continue
        row_text = " ".join(str(t) for t in texts + [num] if isinstance(t, str)).lower()
        if amount is None or abs(amount) < 0.005:
            continue                                    # projection / placeholder / TBD amount
        if pay is None and ("total" in row_text or "subtotal" in row_text):
            continue
        inv, _ = _date_cell(iv)
        notes, paid, paid_note = [], False, None
        for t in texts:
            if t in (None, ""):
                continue
            if isinstance(t, (datetime, date)):
                t = f"{t.month}/{t.day}/{t.year}"
            s = str(t).strip()
            if isinstance(t, (int, float)) and not isinstance(t, bool):
                s = f"{t:g}"
            if PAID_RX.match(s):
                paid, paid_note = True, s[:40]
            if s and s != "-":
                notes.append(s)
        fixed = None
        if pay and not (2020 <= pay.year <= 2030):
            fixed = _fix_year(pay, prev_pay, inv)
        if pay and fixed is None and prev_pay and abs((pay - prev_pay).days) > 200:
            alt = _fix_year(pay, prev_pay, inv)
            if alt and abs((alt - prev_pay).days) < 60:
                fixed = alt
        if fixed:
            out["notes"].append(f"row {r}: pay date {pay_raw or pay} read as {fixed}")
            pay = fixed
        elif pay is None and pay_raw:
            out["notes"].append(f"row {r}: pay date '{pay_raw}' not a date")
        if pay and inv and not (0 <= (pay - inv).days <= 21):
            out["notes"].append(f"row {r}: send-invoice {inv} doesn't fit pay date {pay} — using pay − 7")
            inv = None
        out["rows"].append({
            "row": r, "num": _num(num), "pay_date": _iso(pay), "amount": round(amount, 2),
            "send_invoice_date": _iso(inv or (pay - timedelta(days=7) if pay else None)),
            "note": " · ".join(([phase] if phase else []) + notes)[:255] or None,
            "paid": paid, "paid_note": paid_note,
        })
        if paid:
            out["uses_paid_marker"] = True
        prev_pay = pay or prev_pay
    return out


def _fix_year(d, prev, inv):
    """Same month/day in the plausible year nearest the expected date."""
    expect = (prev + timedelta(days=14)) if prev else ((inv + timedelta(days=7)) if inv else None)
    if not expect:
        return None
    best = None
    for y in (expect.year - 1, expect.year, expect.year + 1):
        try:
            c = date(y, d.month, d.day)
        except ValueError:
            continue
        if best is None or abs((c - expect).days) < abs((best - expect).days):
            best = c
    return best if best and abs((best - expect).days) <= 45 else None


def read_file(f):
    """Download + parse one Drive file -> parsed dict."""
    from app import gdrive as g
    if f["mimeType"] == GSHEET:
        try:
            grid = grid_from_xlsx(g.export(f["id"], g.XLSX))
        except Exception:
            grid = grid_from_values(g.sheet_values(f["id"], "A1:P250"))
    else:
        grid = grid_from_xlsx(g.download(f["id"]))
    return parse_grid(grid)


# ── locate ───────────────────────────────────────────────────────────────────

def list_drive_files():
    import time
    from app import gdrive as g
    for attempt in range(3):
        try:
            files = g.list_files("name contains 'Payment Sched' and trashed = false "
                                 "and mimeType != 'application/vnd.google-apps.folder'")
            break
        except Exception:
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))
    return [f for f in files if NAME_RX.search(f.get("name") or "") and (
        f.get("mimeType") in XLSX_MIMES or re.search(r"\.xls[xm]?$", f.get("name") or "", re.I))]


def _folder_index(conn):
    return {r[0]: (r[1], r[2], r[3], r[4], r[5], r[6]) for r in conn.execute(text(
        "SELECT drive_id, parent_id, name, match_kind, entity_type, entity_id, path FROM drive_folders"))}


def _resolve_folder(folders, opp_project, parent):
    """(in_customers, entity_id|None, match_kind, note, path)."""
    cur, guard, path = parent, 0, None
    if parent in folders:
        path = folders[parent][5]
    while cur and guard < 30:
        if cur == ROOT:
            return True, None, None, "not inside a project folder", path
        f = folders.get(cur)
        if not f:
            return False, None, None, None, path
        pid, name, kind, etype, eid = f[0], f[1], f[2], f[3], f[4]
        if kind:
            if etype == "project" and eid:
                return True, str(eid), "folder", None, path
            if etype == "opportunity" and eid:
                pq = opp_project.get(str(eid))
                if pq:
                    return True, str(pq), "folder_quote", None, path
                return True, None, "opportunity", f"folder {name} is a Pipeline quote with no QBO project", path
            return True, None, kind, f"folder {name}: {kind.replace('_', ' ')}", path
        cur, guard = pid, guard + 1
    return False, None, None, None, path


# ── app reference data ───────────────────────────────────────────────────────

class Ref:
    def __init__(self, conn):
        self.projects, self.prefix = {}, {}
        for r in conn.execute(text("SELECT qbo_id, display_name FROM qbo_customers WHERE is_project = 1")).mappings():
            self.projects[str(r["qbo_id"])] = r["display_name"]
            m = re.match(r"\s*(\d{4,5})\b", r["display_name"] or "")
            if m:
                self.prefix.setdefault(m.group(1), str(r["qbo_id"]))
        self.prefix_of = {q: re.match(r"\s*(\d{4,5})\b", n or "").group(1)
                          for q, n in self.projects.items() if re.match(r"\s*(\d{4,5})\b", n or "")}
        self.est_by_doc = collections.defaultdict(list)       # doc -> [(project qbo_id, estimate qbo_id)]
        for r in conn.execute(text("""
            SELECT t.qbo_id, t.doc_number, t.customer_qbo_id FROM qbo_transactions t
            JOIN qbo_customers c ON c.qbo_id = t.customer_qbo_id AND c.is_project = 1
            WHERE t.entity_type = 'Estimate' AND t.doc_number IS NOT NULL""")).mappings():
            self.est_by_doc[str(r["doc_number"]).strip()].append((str(r["customer_qbo_id"]), str(r["qbo_id"])))
        self.opp_project = {str(r[0]): str(r[1]) for r in conn.execute(text(
            "SELECT id, project_qbo_id FROM opportunities WHERE project_qbo_id IS NOT NULL AND project_qbo_id <> ''"))}
        self.doc_entity = {str(r[0]): str(r[1]) for r in conn.execute(text("""
            SELECT source_drive_id, entity_id FROM documents
            WHERE entity_type = 'project' AND source_drive_id IS NOT NULL AND original_filename LIKE '%ayment%'"""))}
        crews = conn.execute(text("SELECT id, parent_id, name, code, vendor_qbo_id, is_active FROM work_crews")).mappings().all()
        self.company_of = {int(c["id"]): int(c["parent_id"] or c["id"]) for c in crews}
        self.company_name = {int(c["id"]): c["name"] for c in crews if c["parent_id"] is None}
        self.vendor_company = {}
        for c in crews:
            if c["vendor_qbo_id"]:
                self.vendor_company.setdefault(str(c["vendor_qbo_id"]), self.company_of[int(c["id"])])
        self.company_vendor = {int(c["id"]): str(c["vendor_qbo_id"]) for c in crews
                               if c["parent_id"] is None and c["vendor_qbo_id"]}
        # crew aliases: codes (case-sensitive, exact token) and name tokens -> companies
        self.codes = {}
        tok = collections.defaultdict(set)
        stop = {"and", "the", "jr", "llc", "inc", "installers", "installations", "installation", "services", "systems",
                "solutions", "warehouse", "rack", "pallet", "material", "handling", "enterprises", "new", "era", "phase"}
        for c in crews:
            comp = self.company_of[int(c["id"])]
            if c["parent_id"] is None and c["code"]:
                self.codes[c["code"].upper()] = comp
            for w in re.findall(r"[A-Za-z&]+", c["name"] or ""):
                w = w.lower()
                if len(w) >= 3 and w not in stop:
                    tok[w].add(comp)
        self.name_tokens = {w: next(iter(s)) for w, s in tok.items() if len(s) == 1}
        self.company_full = {c["name"].lower(): int(c["id"]) for c in crews if c["parent_id"] is None and c["name"]}


def crew_from_text(ref, label, use_codes=True):
    """Company id named in a file-name suffix / comment, or None (none or several)."""
    if not label:
        return None, None
    found = {}
    low = label.lower()
    for full, cid in ref.company_full.items():
        if len(full) >= 3 and re.search(rf"(?<![a-z]){re.escape(full)}(?![a-z])", low):
            found[cid] = full
    if use_codes:
        for t in re.findall(r"[A-Za-z]+", label):
            if t.isupper() and t in ref.codes:
                found[ref.codes[t]] = t
    for t in re.findall(r"[A-Za-z&]+", low):
        if t in ref.name_tokens:
            found[ref.name_tokens[t]] = t
    if len(found) == 1:
        cid, why = next(iter(found.items()))
        return cid, why
    return None, ("several crews: " + ", ".join(sorted(ref.company_name.get(c, str(c)) for c in found))) if found else None


# ── QBO crew bills ───────────────────────────────────────────────────────────

def project_bills(conn, entity_id):
    rows = conn.execute(text("""
        SELECT t.qbo_id, t.txn_date, t.vendor_qbo_id, ROUND(SUM(l.amount), 2) AS amt
        FROM qbo_transaction_lines l JOIN qbo_transactions t ON t.id = l.transaction_id
        WHERE l.line_customer_qbo_id = :e AND t.entity_type = 'Bill'
          AND JSON_UNQUOTE(JSON_EXTRACT(l.raw_json, '$.ItemBasedExpenseLineDetail.ItemRef.name')) LIKE 'Contract Labor%'
        GROUP BY t.qbo_id, t.txn_date, t.vendor_qbo_id ORDER BY t.txn_date
    """), {"e": entity_id}).mappings().all()
    return [{"id": str(r["qbo_id"]), "date": r["txn_date"], "vendor": str(r["vendor_qbo_id"] or ""),
             "amount": float(r["amt"] or 0)} for r in rows if float(r["amt"] or 0) > EPS]


def match_bills(rows, bills, used, vendor):
    """{row index: bill} — one bill per row, date window + amount tolerance."""
    out = {}
    pool = [b for b in bills if (vendor is None or b["vendor"] == vendor)]
    for idx, r in sorted(enumerate(rows), key=lambda x: x[1]["pay_date"] or "9999"):
        pay = _d(r["pay_date"])
        if not pay:
            continue
        inv = _d(r["send_invoice_date"]) or pay - timedelta(days=7)
        tol = max(50.0, 0.05 * abs(r["amount"]))
        best = None
        for b in pool:
            if b["id"] in used or not b["date"]:
                continue
            if not (inv - timedelta(days=3) <= b["date"] <= pay + timedelta(days=21)):
                continue
            diff = abs(b["amount"] - r["amount"])
            if diff > tol:
                continue
            score = (abs((b["date"] - (pay - timedelta(days=1))).days), diff)
            if best is None or score < best[0]:
                best = (score, b)
        if best:
            used.add(best[1]["id"])
            out[idx] = best[1]
    return out


# ── plan ─────────────────────────────────────────────────────────────────────

def _load_cache(conn):
    out = {}
    for r in conn.execute(text("SELECT * FROM gsync_payment_files")).mappings():
        d = dict(r)
        if isinstance(d.get("parsed"), str):
            d["parsed"] = json.loads(d["parsed"])
        out[d["file_id"]] = d
    return out


def locate_and_parse(conn, ref, reread=False, only_job=None, log=print):
    """[file record] for every Payment Schedule file under Customers — parsed
    (from the cache when modifiedTime is unchanged)."""
    files = list_drive_files()
    folders = _folder_index(conn)
    cache = _load_cache(conn)
    tmpl = set()
    try:
        tm = json.loads(conn.execute(text("SELECT v FROM drive_sync_state WHERE k = 'template_md5'")).scalar() or "{}")
        tmpl = {m for m, n in tm.items() if NAME_RX.search(n or "")}
    except Exception:
        pass
    recs, to_read = [], []
    for f in files:
        parent = (f.get("parents") or [None])[0]
        inside, eid, kind, note, path = _resolve_folder(folders, ref.opp_project, parent)
        if not inside:
            continue
        if ref.doc_entity.get(f["id"]):
            eid, kind, note = ref.doc_entity[f["id"]], kind if eid == ref.doc_entity[f["id"]] else "document_link", None
        label, version = scope_of(f["name"])
        rec = {"file_id": f["id"], "name": f["name"], "mime_type": f["mimeType"], "modified": f.get("modifiedTime"),
               "md5": f.get("md5Checksum"), "parent_id": parent, "path": path, "folder_entity": eid,
               "folder_kind": kind, "folder_note": note, "scope_label": label, "version": version,
               "owners": [o.get("emailAddress") for o in f.get("owners") or []]}
        c = cache.get(f["id"])
        if f.get("md5Checksum") and f["md5Checksum"] in tmpl:
            rec["parse_status"], rec["parsed"], rec["read_at"] = "blank", None, datetime.now()
        elif c and not reread and c["modified"] == rec["modified"] and c["status"] != "error" and c.get("read_at"):
            clean = {k: v for k, v in (c["parsed"] or {}).items() if not k.startswith("_")}
            ok = "rows" in clean and (clean["rows"] or clean.get("cv"))
            rec["parse_status"], rec["parsed"] = ("ok", clean) if ok else ("blank", None)
            rec["read_at"] = c.get("read_at")
        else:
            to_read.append(rec)
        recs.append(rec)
    if only_job:
        to_read = [r for r in to_read if ref.prefix_of.get(r["folder_entity"] or "") == only_job
                   or r["folder_entity"] is None]
    log(f"payment files: {len(recs)} under Customers ({len(files)} Drive hits); reading {len(to_read)}")

    def work(rec):
        try:
            p = read_file({"id": rec["file_id"], "mimeType": rec["mime_type"]})
            rec["parsed"] = p
            rec["parse_status"] = "ok" if (p["rows"] or p.get("cv")) else "blank"
            rec["read_at"], rec["fresh"] = datetime.now(), True
        except Exception as e:
            rec["parse_status"], rec["error"], rec["parsed"] = "error", str(e)[:2000], None
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(work, to_read))
    for r in recs:
        r.setdefault("parse_status", "skipped")    # not read this run (--only-job)
    if only_job:
        recs = [r for r in recs if ref.prefix_of.get(r["folder_entity"] or "") == only_job
                or (r.get("parsed") or {}).get("number") == only_job]
    return recs


def resolve_entities(recs, ref):
    """Sets entity_id / estimate target / match_kind on each parsed file."""
    for r in recs:
        p = r.get("parsed") or {}
        num = p.get("number")
        fe = r["folder_entity"]
        r["entity_id"], r["estimate_qbo_id"], r["match_kind"], r["match_note"] = None, None, None, r.get("folder_note")
        if fe and fe in ref.projects:
            r["entity_id"], r["match_kind"] = fe, r["folder_kind"] or "folder"
            if num and num != ref.prefix_of.get(fe):
                ests = [e for (pq, e) in ref.est_by_doc.get(num, []) if pq == fe]
                if ests:
                    r["estimate_qbo_id"], r["match_kind"] = ests[0], "folder+estimate"
                else:
                    other = ref.prefix.get(num) or next((pq for (pq, e) in ref.est_by_doc.get(num, [])), None)
                    if other and other != fe:
                        r["match_note"] = (f"Project Number cell {num} belongs to {ref.projects.get(other)}; "
                                           f"kept on the folder's project")
                        r["ambiguous_other"] = other
                    elif not other:
                        r["match_note"] = f"Project Number cell {num} is not a project or estimate # in QuickBooks"
            continue
        if num and num in ref.prefix:
            r["entity_id"], r["match_kind"] = ref.prefix[num], "number"
        elif num and ref.est_by_doc.get(num):
            projs = {pq for (pq, e) in ref.est_by_doc[num]}
            if len(projs) == 1:
                pq = next(iter(projs))
                r["entity_id"], r["match_kind"] = pq, "estimate_number"
                r["estimate_qbo_id"] = next(e for (q, e) in ref.est_by_doc[num] if q == pq)
            else:
                r["match_note"] = f"estimate # {num} is on several projects"
        else:
            r["match_note"] = (r.get("folder_note") or "no project folder") + (
                f"; Project Number cell {num} not found in QuickBooks" if num else "; no Project Number on the sheet")


def choose_files(recs):
    """Status per parsed file: ok / superseded / duplicate (and blank/error)."""
    by_ent = collections.defaultdict(list)
    for r in recs:
        r["status"] = r["parse_status"] if r["parse_status"] in ("blank", "error", "skipped") else "ok"
        if r["status"] == "ok" and not r.get("entity_id"):
            r["status"] = "unmatched"
        if r["status"] == "ok":
            by_ent[r["entity_id"]].append(r)
    for eid, fs in by_ent.items():
        groups = collections.defaultdict(list)
        for f in fs:
            groups[((f["scope_label"] or "").lower(), f.get("estimate_qbo_id"))].append(f)
        for g in groups.values():
            if len(g) > 1:
                g.sort(key=lambda f: f["modified"] or "", reverse=True)
                for f in g[1:]:
                    f["status"], f["superseded_by"] = "superseded", g[0]["file_id"]
        live = [f for f in fs if f["status"] == "ok"]
        for a in live:
            sa = {(x["pay_date"], x["amount"]) for x in a["parsed"]["rows"]}
            if len(sa) < 2:
                continue                # one-row phases often repeat an amount on the same payday
            for b in live:
                if a is b or b["status"] != "ok":
                    continue
                sb = {(x["pay_date"], x["amount"]) for x in b["parsed"]["rows"]}
                if sa <= sb and (len(sa) < len(sb) or (b["modified"] or "") > (a["modified"] or "")):
                    a["status"], a["duplicate_of"] = "duplicate", b["file_id"]
                    break


def main_estimate(conn, entity_id):
    from app.payments.routes import _converted_estimates_with_labor
    ests = _converted_estimates_with_labor(conn, entity_id)
    return ests


def plan_project(conn, ref, entity_id, files, holds_map, today):
    """Desired schedules for one project + issues."""
    from app.billing.routes import _single_assigned_company
    ests = main_estimate(conn, entity_id)
    est_ids = [e["qbo_id"] for e in ests]
    existing = {s["estimate_qbo_id"]: dict(s) for s in conn.execute(text("""
        SELECT id, estimate_qbo_id, estimate_doc_number, crew_id, contract_labor, start_date, end_date,
               source, source_file_id FROM project_payment_schedules WHERE entity_id = :e"""),
        {"e": entity_id}).mappings()}
    targets = {}                                        # estimate key -> file
    est_files = [f for f in files if f.get("estimate_qbo_id")]
    proj_files = sorted([f for f in files if not f.get("estimate_qbo_id")],
                        key=lambda f: ((f["scope_label"] or "") != "", -sum(x["amount"] for x in f["parsed"]["rows"]),
                                       f["file_id"]))
    for f in sorted(est_files, key=lambda f: f["modified"] or "", reverse=True):
        k = f["estimate_qbo_id"] if f["estimate_qbo_id"] not in targets else _gs_key(f["file_id"])
        targets[k] = f
    main = next((e for e in est_ids if e not in targets), None)
    for i, f in enumerate(proj_files):
        if i == 0 and main:
            targets[main] = f
        else:
            targets[_gs_key(f["file_id"])] = f
    covered = [e for e in ests if e["qbo_id"] not in targets] if proj_files else []
    if proj_files:              # stale app schedules too (estimate since rejected / no labor any more)
        seen = {e["qbo_id"] for e in covered} | set(targets)
        covered += [{"qbo_id": k, "doc_number": x["estimate_doc_number"], "contract_labor": float(x["contract_labor"] or 0)}
                    for k, x in existing.items() if k not in seen and not str(k).startswith("gs-")
                    and x["source"] != "sheet"]

    bills = project_bills(conn, entity_id)
    bill_companies = {ref.vendor_company.get(b["vendor"]) for b in bills} - {None}
    assigned = None
    try:
        assigned = _single_assigned_company(conn, entity_id)
    except Exception:
        pass
    hold = holds_map.get(str(entity_id)) if holds_map else None
    used = set()
    desired, issues = [], []
    # estimate-keyed schedules first, so extra scope files can inherit their crew
    for key, f in sorted(targets.items(), key=lambda kv: (kv[0].startswith("gs-"), kv[1]["file_id"])):
        p = f["parsed"]
        ex = existing.get(key)
        # crew company
        crew, why = None, None
        c, w = crew_from_text(ref, f["scope_label"])
        if c:
            crew, why = c, f"file name ({w})"
        elif w:
            why = w
        if not crew:
            cs = {crew_from_text(ref, r["note"], use_codes=False)[0] for r in p["rows"] if r.get("note")} - {None}
            if len(cs) == 1:
                crew, why = cs.pop(), "comments"
        if not crew and bill_companies:
            # the crew company whose QBO Contract-Labor bills line up with the sheet's rows
            fit = sorted(((len(match_bills(p["rows"], bills, set(used), ref.company_vendor.get(c))), c)
                          for c in bill_companies if ref.company_vendor.get(c)), reverse=True)
            if fit and fit[0][0] > 0 and (len(fit) == 1 or fit[0][0] > fit[1][0]):
                crew, why = fit[0][1], f"QBO bills ({fit[0][0]} rows match)"
        if not crew and ex and ex["crew_id"]:
            crew, why = ref.company_of.get(int(ex["crew_id"])), "app schedule"
        if not crew and assigned:
            crew, why = int(assigned), "assignment"
        if not crew and len(bill_companies) == 1:
            crew, why = next(iter(bill_companies)), "QBO bills (only crew vendor)"
        if not crew:
            known = {c for c in (ref.company_of.get(int(x["crew_id"])) for x in existing.values()
                                 if x["crew_id"] and x["source"] != "sheet_covered") if c}
            known |= {d["crew_company"] for d in desired if d["crew_company"]}
            if len(known) == 1:
                crew, why = next(iter(known)), "project's other schedule"
        crew_id = None
        if crew:
            crew_id = int(ex["crew_id"]) if ex and ex["crew_id"] and ref.company_of.get(int(ex["crew_id"])) == crew else crew
        elif ex and ex["crew_id"]:
            crew_id = int(ex["crew_id"])
        vendor = ref.company_vendor.get(crew) if crew else None
        rows = p["rows"]
        matched = match_bills(rows, bills, used, vendor)
        cv = p.get("cv")
        total = round(sum(r["amount"] for r in rows), 2)
        inst = []
        for i, r in enumerate(rows):
            b = matched.get(i)
            inst.append({"seq": i + 1, "pay_date": r["pay_date"], "amount": r["amount"],
                         "send_invoice_date": r["send_invoice_date"], "note": r["note"],
                         "sheet_paid": 1 if r["paid"] else 0, "qbo_txn_id": b["id"] if b else None,
                         "qbo_amount": b["amount"] if b else None, "qbo_date": _iso(b["date"]) if b else None})
        desired.append({"key": key, "file": f, "crew_id": crew_id, "crew_company": crew, "crew_why": why,
                        "vendor": vendor, "contract_labor": round(cv, 2) if cv is not None else total,
                        "start_date": p.get("start"), "end_date": p.get("end"), "rows": inst, "total": total,
                        "doc_number": (next((e["doc_number"] for e in ests if e["qbo_id"] == key), None)
                                       or (f"PS {f['scope_label']}" if f["scope_label"] else "PS"))[:50]})
        # issues for this file
        if not crew:
            issues.append(("unknown_crew", f, {"why": why}))
        if cv is not None and abs(cv - total) > 1:
            issues.append(("total_mismatch", f, {"cv": cv, "total": total}))
        off = [r["pay_date"] for r in rows if r["pay_date"] and not on_cycle(_d(r["pay_date"]))]
        if off:
            issues.append(("off_calendar", f, {"dates": off}))
        undated = [r for r in rows if not r["pay_date"]]
        if p.get("notes") or undated:
            issues.append(("bad_date", f, {"notes": p.get("notes"), "undated": len(undated)}))
        # paid reconciliation (burn-down as a second chance: one bill can cover two rows)
        vbills = [b for b in bills if vendor is None or b["vendor"] == vendor]
        no_qbo, not_marked, cum = [], [], 0.0
        for i, r in sorted(enumerate(rows), key=lambda x: x[1]["pay_date"] or "9999"):
            cum += r["amount"]
            pay = _d(r["pay_date"])
            paid_by = sum(b["amount"] for b in vbills if pay and b["date"] and b["date"] <= pay + timedelta(days=21))
            if r["paid"] and i not in matched and paid_by + EPS < cum:
                no_qbo.append(r["pay_date"] or f"row {r['row']}")
            if p.get("uses_paid_marker") and not r["paid"] and i in matched:
                not_marked.append(r["pay_date"])
        if no_qbo:
            issues.append(("sheet_paid_no_qbo", f, {"dates": no_qbo, "vendor": vendor}))
        if not_marked:
            issues.append(("qbo_paid_not_marked", f, {"dates": not_marked}))
        if f.get("ambiguous_other"):
            issues.append(("ambiguous_project", f, {"other": f["ambiguous_other"]}))
    # crews paid more in QBO than every sheet of the project adds up to (a
    # change order / phase that isn't on any sheet, now folded into the sheet)
    paid_all = round(sum(b["amount"] for b in bills), 2)
    sheet_all = round(sum(d["total"] for d in desired), 2)
    if desired and paid_all > sheet_all + max(100.0, 0.01 * sheet_all):
        f0 = next((d["file"] for d in desired if not d["file"].get("estimate_qbo_id")), desired[0]["file"])
        issues.append(("paid_over_sheet", f0, {"paid": paid_all, "sheet": sheet_all,
                                               "covered": [[e["doc_number"], e["contract_labor"]] for e in covered]}))
    return {"entity_id": entity_id, "desired": desired, "covered": covered, "existing": existing,
            "issues": issues, "hold": hold}


# ── apply ────────────────────────────────────────────────────────────────────

def _hold_date(conn, hold, holds_map, entity_id, kind, row_id, field, d, weekly):
    """Project holds (projects/holds.py): a sheet date equal to the hold's
    recorded original keeps the moved value; a date inside the active hold
    window moves (whole weeks for pay rows); anything else = the sheet."""
    if not hold or d is None:
        return d
    from app.projects import holds as H
    if row_id:
        r = conn.execute(text("""SELECT orig_value, shifted_value FROM project_hold_shifts
             WHERE hold_id = :h AND kind = :k AND row_id = :r AND field = :f AND detached = 0"""),
                         {"h": hold["id"], "k": kind, "r": int(row_id), "f": field}).mappings().first()
        if r and r["orig_value"] == d.isoformat() and r["shifted_value"]:
            return _d(r["shifted_value"])
    d2 = H.shift_for_forecast(entity_id, d, holds_map)
    if d2 != d and weekly:
        d2 = d + timedelta(days=H._weeks(int(hold.get("shift_days") or 0)))
    return d2


def _num_eq(a, b):
    if a is None or b is None:
        return a is None and b is None
    return abs(float(a) - float(b)) < 0.005


def apply_project(conn, plan, holds_map, today, do_apply):
    """Write the desired state; returns change list (empty = already in sync)."""
    eid, hold = plan["entity_id"], plan["hold"]
    changes = []
    keep_keys = set()
    for d in plan["desired"]:
        f = d["file"]
        keep_keys.add(d["key"])
        ex = plan["existing"].get(d["key"])
        sid = ex["id"] if ex else None
        start = _hold_date(conn, hold, holds_map, eid, "crew_schedule", sid, "start_date", _d(d["start_date"]), False)
        end = _hold_date(conn, hold, holds_map, eid, "crew_schedule", sid, "end_date", _d(d["end_date"]), False)
        p = f["parsed"]
        vals = {"estimate_doc_number": d["doc_number"], "crew_id": d["crew_id"], "contract_labor": d["contract_labor"],
                "start_date": start, "end_date": end, "source": "sheet", "source_file_id": f["file_id"],
                "source_file_name": f["name"][:255], "source_modified": f["modified"],
                "source_label": (f["scope_label"] or None) and f["scope_label"][:120],
                "sheet_project_number": (p.get("number_raw") or p.get("number") or None),
                "sheet_paid_to_date": p.get("ptd")}
        if ex:
            full = conn.execute(text("SELECT * FROM project_payment_schedules WHERE id = :i"), {"i": sid}).mappings().first()
            diff = {k: [full[k], v] for k, v in vals.items()
                    if not (_num_eq(full[k], v) if k in ("contract_labor", "sheet_paid_to_date", "crew_id")
                            else (str(full[k]) if full[k] is not None else None) == (str(v) if v is not None else None))}
            if diff:
                changes.append({"schedule": d["key"], "fields": {k: [str(a) if a is not None else None, str(b) if b is not None else None]
                                                                for k, (a, b) in diff.items()}})
                if do_apply:
                    sets = ", ".join(f"{k} = :{k}" for k in diff)
                    conn.execute(text(f"UPDATE project_payment_schedules SET {sets}, synced_at = NOW() WHERE id = :id"),
                                 {**{k: v for k, (_, v) in diff.items()}, "id": sid})
        else:
            changes.append({"schedule": d["key"], "created": True, "file": f["name"]})
            if do_apply:
                sid = conn.execute(text("""INSERT INTO project_payment_schedules
                    (entity_id, estimate_qbo_id, estimate_doc_number, crew_id, contract_labor, start_date, end_date,
                     invoice_lead_days, source, source_file_id, source_file_name, source_modified, source_label,
                     sheet_project_number, sheet_paid_to_date, synced_at)
                    VALUES (:e, :k, :estimate_doc_number, :crew_id, :contract_labor, :start_date, :end_date, 7, :source,
                     :source_file_id, :source_file_name, :source_modified, :source_label, :sheet_project_number,
                     :sheet_paid_to_date, NOW())"""), {"e": eid, "k": d["key"], **vals}).lastrowid
        changes += _sync_rows(conn, sid, d, hold, holds_map, eid, do_apply)

    # change orders folded into the project's sheet
    primary = next((d["file"] for d in plan["desired"] if not d["file"].get("estimate_qbo_id")), None)
    for e in plan["covered"]:
        keep_keys.add(e["qbo_id"])
        ex = plan["existing"].get(e["qbo_id"])
        note = f"Included in the Drive Payment Schedule ({primary['name']})"[:255]
        d = {"rows": [{"seq": 1, "pay_date": None, "amount": 0.0, "send_invoice_date": None, "note": note,
                       "sheet_paid": 0, "qbo_txn_id": None}], "key": e["qbo_id"]}
        vals = {"contract_labor": 0.0, "source": "sheet_covered", "source_file_id": primary["file_id"],
                "source_file_name": primary["name"][:255], "source_modified": primary["modified"]}
        sid = ex["id"] if ex else None
        if ex:
            full = conn.execute(text("SELECT * FROM project_payment_schedules WHERE id = :i"), {"i": sid}).mappings().first()
            diff = {k: v for k, v in vals.items() if not (_num_eq(full[k], v) if k == "contract_labor" else full[k] == v)}
            if diff:
                changes.append({"schedule": e["qbo_id"], "covered_by_sheet": True, "was_labor": float(full["contract_labor"] or 0)})
                if do_apply:
                    sets = ", ".join(f"{k} = :{k}" for k in diff)
                    conn.execute(text(f"UPDATE project_payment_schedules SET {sets}, synced_at = NOW() WHERE id = :id"),
                                 {**diff, "id": sid})
        else:
            changes.append({"schedule": e["qbo_id"], "covered_by_sheet": True, "created": True})
            if do_apply:
                sid = conn.execute(text("""INSERT INTO project_payment_schedules
                    (entity_id, estimate_qbo_id, estimate_doc_number, crew_id, contract_labor, invoice_lead_days,
                     source, source_file_id, source_file_name, source_modified, synced_at)
                    VALUES (:e, :k, :dn, NULL, 0, 7, 'sheet_covered', :f, :fn, :fm, NOW())"""),
                    {"e": eid, "k": e["qbo_id"], "dn": e["doc_number"], "f": primary["file_id"],
                     "fn": primary["name"][:255], "fm": primary["modified"]}).lastrowid
        changes += _sync_rows(conn, sid, d, None, holds_map, eid, do_apply, covered=True)

    # sheet-owned schedules no longer backed by a file -> released
    for k, ex in plan["existing"].items():
        if k in keep_keys or ex["source"] not in ("sheet", "sheet_covered"):
            continue
        changes.append({"schedule": k, "released": True, "file_id": ex["source_file_id"]})
        if do_apply:
            conn.execute(text("DELETE FROM project_payment_installments WHERE schedule_id = :s"), {"s": ex["id"]})
            conn.execute(text("DELETE FROM project_payment_schedules WHERE id = :s"), {"s": ex["id"]})
    return changes


def _sync_rows(conn, sid, d, hold, holds_map, eid, do_apply, covered=False):
    existing = [] if not sid else [dict(r) for r in conn.execute(text("""
        SELECT id, seq, pay_date, amount, send_invoice_date, status, note, edited, source, sheet_paid,
               paid_source, qbo_txn_id FROM project_payment_installments WHERE schedule_id = :s ORDER BY seq, id"""),
        {"s": sid}).mappings()]
    # 0088: changes made in the app win over the sheet (gsync/overrides.py):
    # rows added in the app are kept as they are, sheet rows removed in the app
    # stay removed, and edited fields keep the app's value - each listed on
    # Data Review until the sheet says the same.
    from . import overrides as OV
    ov_rows = OV.open_for(conn, "project_payment_installments", [r["id"] for r in existing])
    added = [r for r in existing if "added" in ov_rows.get(r["id"], {})]
    existing = [r for r in existing if r not in added]
    deleted = {f.split(":", 1)[1]: ov for f, ov in (OV.open_for(conn, "project_payment_schedules", [sid]).get(sid) or {}).items()
               if f.startswith("deleted:")} if sid else {}
    rows = []
    for r in d["rows"]:
        ov = deleted.pop(str(r["seq"]), None)
        if ov:   # the sheet still has the row someone removed in the app: keep it removed
            OV.keep_app(conn, ov, f"{r['pay_date']} ${float(r['amount'] or 0):,.0f}", do_apply, sheet_ref=f"payment #{r['seq']}")
            continue
        rows.append(r)
    for ov in deleted.values():   # the sheet no longer has that row: resolved
        OV.keep_app(conn, ov, None, do_apply)
    for a in added:               # the sheet now has the row the app added: drop the app's copy
        twin = next((r for r in rows if r["pay_date"] and a["pay_date"] and abs((_d(r["pay_date"]) - _d(a["pay_date"])).days) <= 3
                     and abs(float(r["amount"]) - float(a["amount"] or 0)) < 1), None)
        if twin and do_apply:
            conn.execute(text("DELETE FROM project_payment_installments WHERE id = :id"), {"id": a["id"]})
            OV.keep_app(conn, ov_rows[a["id"]]["added"], ov_rows[a["id"]]["added"]["app_value"], do_apply)
    # app-marked paid rows (by hand, not by this import) stay paid
    app_paid = [r for r in existing if (r["status"] or "") == "paid" and (r["paid_source"] in (None, "app"))]
    changes = []
    for i, r in enumerate(rows):
        ex = existing[i] if i < len(existing) else None
        pay = _d(r["pay_date"])
        hand = next((a for a in app_paid if a["pay_date"] and pay and abs((a["pay_date"] - pay).days) <= 3
                     and abs(float(a["amount"]) - r["amount"]) < 1), None)
        if hand:
            app_paid.remove(hand)
        srcs = [s for s, on in (("sheet", r["sheet_paid"]), ("qbo", r["qbo_txn_id"])) if on]
        if hand:
            status, psrc = "paid", "+".join(["app"] + srcs) if srcs else "app"
        elif srcs:
            status, psrc = "paid", "+".join(srcs)
        else:
            status, psrc = "pending", None
        inv = _d(r["send_invoice_date"])
        if status != "paid":
            pay = _hold_date(conn, hold, holds_map, eid, "crew_installment", ex and ex["id"], "pay_date", pay, True)
            inv = _hold_date(conn, hold, holds_map, eid, "crew_installment", ex and ex["id"], "send_invoice_date", inv, True)
        want = {"seq": r["seq"], "pay_date": pay, "amount": r["amount"], "send_invoice_date": inv, "status": status,
                "note": r["note"], "edited": 1, "source": "sheet", "sheet_paid": r["sheet_paid"],
                "paid_source": psrc, "qbo_txn_id": r["qbo_txn_id"]}
        if ex:
            for f, ov in (ov_rows.get(ex["id"]) or {}).items():
                if f in want and OV.keep_app(conn, ov, want[f], do_apply, sheet_ref=f"payment #{r['seq']}"):
                    want[f] = ex[f]   # keep the app's value
            diff = {k: v for k, v in want.items()
                    if not (_num_eq(ex[k], v) if k == "amount" else (ex[k] if k not in ("pay_date", "send_invoice_date")
                                                                      else _d(ex[k])) == v)}
            if diff:
                changes.append({"row": r["seq"], "id": ex["id"],
                                "changed": {k: [str(ex[k]) if ex[k] is not None else None,
                                                str(v) if v is not None else None] for k, v in diff.items()}})
                if do_apply:
                    sets = ", ".join(f"{k} = :{k}" for k in diff)
                    conn.execute(text(f"UPDATE project_payment_installments SET {sets} WHERE id = :id"),
                                 {**diff, "id": ex["id"]})
        else:
            changes.append({"row": r["seq"], "new": {"pay_date": _iso(pay), "amount": r["amount"], "status": status}})
            if do_apply:
                conn.execute(text("""INSERT INTO project_payment_installments
                    (schedule_id, seq, pay_date, amount, send_invoice_date, status, note, edited, source, sheet_paid,
                     paid_source, qbo_txn_id)
                    VALUES (:sid, :seq, :pay_date, :amount, :send_invoice_date, :status, :note, 1, 'sheet', :sheet_paid,
                     :paid_source, :qbo_txn_id)"""), {"sid": sid, **want})
    for ex in existing[len(rows):]:
        changes.append({"row": ex["seq"], "id": ex["id"], "deleted": {"pay_date": _iso(ex["pay_date"]),
                                                                       "amount": float(ex["amount"]), "status": ex["status"]}})
        if do_apply:
            conn.execute(text("DELETE FROM project_payment_installments WHERE id = :id"), {"id": ex["id"]})
    return [dict(c, schedule_id=sid) for c in changes]


# ── issues + cache rows ──────────────────────────────────────────────────────

def file_issues(recs, ref, today):
    """Per-file issues that don't need the app plan (unmatched, versions)."""
    out = collections.defaultdict(list)
    for r in recs:
        if r["status"] == "unmatched":
            out[r["file_id"]].append({"type": "unmatched_file", "note": r.get("match_note")})
        if r["status"] in ("superseded", "duplicate"):
            other = r.get("superseded_by") or r.get("duplicate_of")
            future = [x["pay_date"] for x in (r.get("parsed") or {}).get("rows", [])
                      if x["pay_date"] and x["pay_date"] >= (today - timedelta(days=30)).isoformat()]
            if future:
                out[r["file_id"]].append({"type": "skipped_" + r["status"], "other": other, "future": future})
        if r.get("ambiguous_other") and r["status"] != "ok":
            out[r["file_id"]].append({"type": "ambiguous_project", "other": r["ambiguous_other"]})
    return out


def _store(conn, recs, issues_by_file, full_listing):
    now = datetime.now().replace(microsecond=0)
    for r in recs:
        parsed = dict(r.get("parsed") or {}) if r.get("parsed") is not None else None
        meta = {"_issues": issues_by_file.get(r["file_id"], []), "_version": r.get("version"),
                "_owners": r.get("owners"), "_superseded_by": r.get("superseded_by"),
                "_duplicate_of": r.get("duplicate_of"), "_estimate_qbo_id": r.get("estimate_qbo_id"),
                "_schedule_key": r.get("schedule_key")}
        parsed = {**(parsed or {}), **meta}
        conn.execute(text("""
            INSERT INTO gsync_payment_files (file_id, name, mime_type, modified, md5, parent_id, path, entity_id,
              match_kind, match_note, scope_label, status, error, parsed, read_at, seen_at)
            VALUES (:file_id, :name, :mime_type, :modified, :md5, :parent_id, :path, :entity_id, :match_kind,
              :match_note, :scope_label, :status, :error, :parsed, :read_at, :now)
            ON DUPLICATE KEY UPDATE name = VALUES(name), mime_type = VALUES(mime_type), modified = VALUES(modified),
              md5 = VALUES(md5), parent_id = VALUES(parent_id), path = VALUES(path), entity_id = VALUES(entity_id),
              match_kind = VALUES(match_kind), match_note = VALUES(match_note), scope_label = VALUES(scope_label),
              status = VALUES(status), error = VALUES(error), parsed = VALUES(parsed),
              read_at = COALESCE(VALUES(read_at), read_at), seen_at = VALUES(seen_at)
        """), {"file_id": r["file_id"], "name": r["name"][:255], "mime_type": r["mime_type"], "modified": r["modified"],
               "md5": r.get("md5"), "parent_id": r.get("parent_id"), "path": (r.get("path") or "")[:1024] or None,
               "entity_id": r.get("entity_id"), "match_kind": r.get("match_kind"),
               "match_note": (r.get("match_note") or "")[:500] or None, "scope_label": (r.get("scope_label") or "")[:120] or None,
               "status": r["status"], "error": r.get("error"), "parsed": json.dumps(parsed, default=str),
               "read_at": r.get("read_at") if isinstance(r.get("read_at"), datetime) else None, "now": now})
    if full_listing:
        conn.execute(text("UPDATE gsync_payment_files SET status = 'removed' WHERE seen_at < :now OR seen_at IS NULL"),
                     {"now": now})


# ── run ──────────────────────────────────────────────────────────────────────

def run(do_apply=False, only_job=None, reread=False, verbose=False, log=print):
    today = date.today()
    with engine.connect() as conn:
        ref = Ref(conn)
        prev_seen = conn.execute(text("SELECT COUNT(*) FROM gsync_payment_files WHERE status <> 'removed'")).scalar() or 0
        recs = locate_and_parse(conn, ref, reread=reread, only_job=only_job, log=log)
    if not only_job and prev_seen and len(recs) < prev_seen * 0.8:
        raise RuntimeError(f"Drive listing looks incomplete ({len(recs)} Payment Schedule files vs {prev_seen} "
                           "last time) — nothing changed")
    resolve_entities(recs, ref)
    choose_files(recs)
    try:
        from app.projects import holds as H
        holds_map = H.active_holds()
    except Exception:
        holds_map = {}
    by_ent = collections.defaultdict(list)
    for r in recs:
        if r["status"] == "ok":
            by_ent[r["entity_id"]].append(r)
    issues_by_file = file_issues(recs, ref, today)
    summary = collections.Counter()
    for r in recs:
        summary[f"files_{r['status']}"] += 1
    summary["files"] = len(recs)
    summary["files_read"] = sum(1 for r in recs if r.get("fresh"))
    match_kinds = collections.Counter(r.get("match_kind") or "none" for r in recs if r["status"] == "ok")
    crew_why = collections.Counter()
    proj_changes, sample, errors = [], [], []
    for eid, files in sorted(by_ent.items()):
        try:
            with engine.begin() as conn:
                plan = plan_project(conn, ref, eid, files, holds_map, today)
                for d in plan["desired"]:
                    d["file"]["schedule_key"] = d["key"]
                    crew_why[(d["crew_why"] or "unknown").split(" (")[0]] += 1
                for typ, f, info in plan["issues"]:
                    issues_by_file[f["file_id"]].append({"type": typ, **info})
                ch = apply_project(conn, plan, holds_map, today, do_apply)
                summary["schedules"] += len(plan["desired"])
                summary["covered_schedules"] += len(plan["covered"])
                summary["installments"] += sum(len(d["rows"]) for d in plan["desired"])
                summary["paid_rows"] += sum(1 for d in plan["desired"] for r in d["rows"] if r["sheet_paid"] or r["qbo_txn_id"])
                summary["qbo_matched_rows"] += sum(1 for d in plan["desired"] for r in d["rows"] if r["qbo_txn_id"])
                if ch:
                    summary["projects_changed"] += 1
                    summary["schedules_created"] += sum(1 for c in ch if c.get("created"))
                    summary["schedules_released"] += sum(1 for c in ch if c.get("released"))
                    summary["rows_new"] += sum(1 for c in ch if "new" in c)
                    summary["rows_changed"] += sum(1 for c in ch if "changed" in c)
                    summary["rows_deleted"] += sum(1 for c in ch if "deleted" in c)
                    proj_changes.append((eid, ch, plan))
                    if len(sample) < 25:
                        sample.append({"project": ref.projects.get(eid), "changes": len(ch)})
        except Exception as e:
            errors.append({"project": ref.projects.get(eid), "entity_id": eid, "error": str(e)[:300]})
            if verbose:
                raise
    if do_apply:
        with engine.begin() as conn:
            _store(conn, recs, issues_by_file, full_listing=not only_job)
        for eid, ch, plan in proj_changes:
            record_audit(ACTOR, "crew_payment.sheet_import", "project", eid,
                         f"Crew payment schedule updated from Drive — {ref.projects.get(eid)}",
                         {"files": [{"id": d["file"]["file_id"], "name": d["file"]["name"],
                                     "modified": d["file"]["modified"], "schedule": d["key"]} for d in plan["desired"]],
                          "changes": ch[:300]})
    issue_counts = collections.Counter(i["type"] for v in issues_by_file.values() for i in v)
    out = {"apply": do_apply, **dict(summary), "match": dict(match_kinds), "crew_from": dict(crew_why),
           "issues": dict(issue_counts), "errors": errors[:20], "sample": sample}
    if verbose:
        out["_changes"] = [(ref.projects.get(e), c) for e, c, _ in proj_changes]
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m app.gsync.payment_import")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--only-job")
    ap.add_argument("--reread", action="store_true", help="ignore the parse cache (re-download every file)")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args(argv)
    s = run(do_apply=a.apply, only_job=a.only_job, reread=a.reread, verbose=a.verbose)
    print(json.dumps(s, indent=1, default=str)[:200000])


if __name__ == "__main__":
    main()
