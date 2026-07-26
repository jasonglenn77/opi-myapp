"""
App-generated customer-facing estimate PDF (Phase A, step 7).

The customer PDF is deliberately AGGREGATED/totalized — a clean quote the estimator
sends to the customer — NOT the granular QBO bundle lines (those are the office's
per-line mirror, a separate tool). All figures are computed on the client by
qm-rollup.js (the single source of truth); this module only renders the supplied
data into a branded PDF, so the number on the page always matches the Review tab.

Pure-Python rendering via xhtml2pdf (no system libraries), so the slim backend image
needs no extra apt packages.
"""
from html import escape
from io import BytesIO

from xhtml2pdf import pisa

BRAND = "#0f172a"      # ink-900 (matches the app shell)
ACCENT = "#2563eb"     # blue-600


def _money(v):
    try:
        return "$" + format(round(float(v)), ",")
    except (TypeError, ValueError):
        return "$0"


def _lines_html(lines):
    """lines: list of {label, description, amount}. Aggregated quote lines."""
    rows = []
    for ln in lines or []:
        label = escape(str(ln.get("label") or ""))
        desc = escape(str(ln.get("description") or "")).replace("\n", "<br/>")
        amount = _money(ln.get("amount"))
        rows.append(
            f'<tr>'
            f'<td class="cell lbl">{label}</td>'
            f'<td class="cell desc">{desc}</td>'
            f'<td class="cell amt">{amount}</td>'
            f'</tr>'
        )
    if not rows:
        rows.append('<tr><td class="cell" colspan="3">—</td></tr>')
    return "\n".join(rows)


def build_estimate_html(data: dict) -> str:
    """data keys: company, contact, location, quote_number, quote_date, project_name,
    estimator, scope, lines[], total, notes."""
    company = escape(str(data.get("company") or "Customer"))
    contact = escape(str(data.get("contact") or ""))
    location = escape(str(data.get("location") or ""))
    quote_number = escape(str(data.get("quote_number") or "—"))
    quote_date = escape(str(data.get("quote_date") or ""))
    project_name = escape(str(data.get("project_name") or ""))
    estimator = escape(str(data.get("estimator") or ""))
    scope = escape(str(data.get("scope") or "")).replace("\n", "<br/>")
    notes = escape(str(data.get("notes") or "")).replace("\n", "<br/>")
    total = _money(data.get("total"))
    rev = data.get("revision_no")
    rev_txt = f" &middot; Rev {escape(str(rev))}" if rev not in (None, "", 1) else ""

    bill_to = "<br/>".join([x for x in [company, contact, location] if x])

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
@page {{ size: letter; margin: 1.5cm 1.6cm; }}
body {{ font-family: Helvetica, Arial, sans-serif; color: #1f2937; font-size: 10pt; }}
.header {{ background: {BRAND}; color: #ffffff; padding: 14px 18px; }}
.brand {{ font-size: 18pt; font-weight: bold; letter-spacing: 0.5px; }}
.brand small {{ font-size: 8pt; color: #cbd5e1; font-weight: normal; }}
.doctype {{ font-size: 13pt; font-weight: bold; color: {ACCENT}; text-align: right; }}
.meta {{ margin-top: 14px; }}
.meta td {{ vertical-align: top; padding: 2px 0; font-size: 9.5pt; }}
.label {{ color: #6b7280; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.4px; }}
.billto {{ font-size: 10pt; line-height: 1.4; }}
.section-title {{ font-size: 8pt; text-transform: uppercase; letter-spacing: 0.5px;
  color: #6b7280; font-weight: bold; margin: 16px 0 4px 0; border-bottom: 1px solid #e5e7eb; padding-bottom: 3px; }}
.scope {{ font-size: 9.5pt; line-height: 1.45; color: #374151; }}
table.lines {{ width: 100%; border-collapse: collapse; margin-top: 4px; }}
table.lines th {{ background: #f3f4f6; color: #374151; font-size: 8pt; text-transform: uppercase;
  letter-spacing: 0.4px; text-align: left; padding: 6px 8px; border-bottom: 2px solid #d1d5db; }}
.cell {{ padding: 7px 8px; border-bottom: 1px solid #eceff3; font-size: 9.5pt; vertical-align: top; }}
.lbl {{ font-weight: bold; color: #111827; width: 22%; }}
.desc {{ color: #374151; }}
.amt {{ text-align: right; white-space: nowrap; width: 18%; font-weight: bold; }}
th.amt {{ text-align: right; }}
.total-row td {{ padding: 9px 8px; font-size: 11pt; font-weight: bold; color: #111827;
  border-top: 2px solid {BRAND}; }}
.total-row .amt {{ color: {ACCENT}; }}
.notes {{ font-size: 8.5pt; color: #6b7280; line-height: 1.4; margin-top: 14px; }}
.foot {{ margin-top: 22px; font-size: 8pt; color: #9ca3af; text-align: center;
  border-top: 1px solid #e5e7eb; padding-top: 8px; }}
</style></head><body>
<table width="100%"><tr>
  <td class="header" width="65%"><div class="brand">OnPoint Installers<br/><small>Warehouse Rack &amp; Pallet Systems Installation</small></div></td>
  <td class="header doctype" width="35%">ESTIMATE<br/><span style="font-size:9pt;color:#cbd5e1;font-weight:normal;">#{quote_number}{rev_txt}</span></td>
</tr></table>

<table width="100%" class="meta"><tr>
  <td width="55%"><div class="label">Prepared For</div><div class="billto">{bill_to}</div></td>
  <td width="45%">
    <table width="100%">
      <tr><td class="label">Date</td><td style="text-align:right;">{quote_date}</td></tr>
      <tr><td class="label">Project</td><td style="text-align:right;">{project_name}</td></tr>
      <tr><td class="label">Prepared By</td><td style="text-align:right;">{estimator}</td></tr>
    </table>
  </td>
</tr></table>

{"<div class='section-title'>Scope of Work</div><div class='scope'>" + scope + "</div>" if scope.strip() else ""}

<div class="section-title">Estimate</div>
<table class="lines">
  <tr><th width="22%">Item</th><th>Description</th><th class="amt" width="18%">Amount</th></tr>
  {_lines_html(data.get("lines"))}
  <tr class="total-row"><td colspan="2" style="text-align:right;">Total</td><td class="amt">{total}</td></tr>
</table>

{"<div class='notes'>" + notes + "</div>" if notes.strip() else ""}

<div class="foot">OnPoint Installers &middot; This estimate is valid for 30 days from the date above.</div>
</body></html>"""


def render_estimate_pdf(data: dict) -> bytes:
    """Render the estimate data dict to PDF bytes."""
    html = build_estimate_html(data)
    out = BytesIO()
    result = pisa.CreatePDF(src=html, dest=out, encoding="utf-8")
    if result.err:
        raise RuntimeError("PDF generation failed")
    return out.getvalue()
