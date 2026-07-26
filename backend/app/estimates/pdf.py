"""
App-generated customer estimate PDF (Phase A, step 7/9).

Replicates OPI's QuickBooks estimate — the itemized customer quote — but
app-polished. Standard blocks (company header, Payment Terms, Stipulations, notes)
come from estimate_pdf_defaults (editable per quote); the priced line items come
from the quoting metrics (computeSetBundles on the client, the single source of
truth), so the PDF ties out to the workbook and the Review tab.

Pure-Python rendering via xhtml2pdf (no system libraries).
"""
from html import escape
from io import BytesIO

from xhtml2pdf import pisa

MAROON = "#8a1b2c"
MAROON_DK = "#6f1522"
INK = "#1f2937"
MUTED = "#6b7280"


def _money(v):
    try:
        return format(round(float(v), 2), ",.2f")
    except (TypeError, ValueError):
        return "0.00"


def _qty(v):
    try:
        n = float(v)
        return format(int(n), ",") if n == int(n) else format(n, ",g")
    except (TypeError, ValueError):
        return ""


def _multiline(s):
    return escape(str(s or "")).replace("\n", "<br/>")


def _line_rows(lines):
    rows = []
    for ln in lines or []:
        label = _multiline(ln.get("label"))
        desc = _multiline(ln.get("description"))
        qty = _qty(ln.get("qty"))
        rate = _money(ln.get("rate")) if ln.get("rate") not in (None, "") else ""
        amount = _money(ln.get("amount")) if ln.get("amount") not in (None, "") else ""
        rows.append(
            f'<tr>'
            f'<td class="c-item">{label}</td>'
            f'<td class="c-desc">{desc}</td>'
            f'<td class="c-qty">{qty}</td>'
            f'<td class="c-num">{rate}</td>'
            f'<td class="c-num">{amount}</td>'
            f'</tr>'
        )
    if not rows:
        rows.append('<tr><td class="c-item" colspan="5">—</td></tr>')
    return "\n".join(rows)


def build_estimate_html(d: dict) -> str:
    co = d.get("company") or {}
    co_name = escape(str(co.get("name") or "On Point Installations, LLC"))
    co_addr = _multiline(co.get("address"))
    co_phone = escape(str(co.get("phone") or ""))
    co_email = escape(str(co.get("email") or ""))

    estimate_no = escape(str(d.get("estimate_no") or "—"))
    est_date = escape(str(d.get("date") or ""))
    expiration = escape(str(d.get("expiration_date") or ""))
    sales_rep = escape(str(d.get("sales_rep") or ""))
    bill_to = "<br/>".join(escape(str(x)) for x in (d.get("bill_to") or []) if x)
    footer_title = escape(str(d.get("footer_title") or ""))
    preparer = escape(str(d.get("preparer") or ""))
    total = _money(d.get("total"))

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
@page {{ size: letter; margin: 1.4cm 1.5cm; }}
body {{ font-family: Helvetica, Arial, sans-serif; color: {INK}; font-size: 9.5pt; }}
.co-name {{ font-size: 12pt; font-weight: bold; color: {INK}; }}
.co-meta {{ font-size: 8.5pt; color: {MUTED}; line-height: 1.35; }}
.wordmark {{ text-align: center; color: {MAROON}; font-weight: bold; }}
.wm1 {{ font-size: 15pt; letter-spacing: 1px; }}
.wm2 {{ font-size: 7pt; letter-spacing: 3px; color: {MUTED}; }}
.bar {{ background: {MAROON}; color: #fff; font-weight: bold; padding: 7px 12px; font-size: 11pt; }}
.bar small {{ font-weight: normal; font-size: 8.5pt; }}
.barlabel {{ font-size: 8pt; }}
.blocklabel {{ font-size: 7.5pt; font-weight: bold; letter-spacing: 0.5px; color: {INK}; text-transform: uppercase; }}
.billto {{ font-size: 9.5pt; line-height: 1.4; margin-top: 2px; }}
table.lines {{ width: 100%; border-collapse: collapse; margin-top: 14px; }}
table.lines th {{ background: {MAROON}; color: #fff; font-size: 8pt; letter-spacing: 0.5px;
  padding: 6px 8px; text-align: left; }}
th.n {{ text-align: right; }}
.c-item {{ padding: 7px 8px; border-bottom: 1px solid #e8ebef; font-weight: bold; font-size: 8.5pt;
  color: {INK}; vertical-align: top; width: 13%; }}
.c-desc {{ padding: 7px 8px; border-bottom: 1px solid #e8ebef; font-size: 9pt; color: #374151;
  vertical-align: top; line-height: 1.4; }}
.c-qty {{ padding: 7px 8px; border-bottom: 1px solid #e8ebef; text-align: right; vertical-align: top; width: 8%; }}
.c-num {{ padding: 7px 8px; border-bottom: 1px solid #e8ebef; text-align: right; vertical-align: top;
  white-space: nowrap; width: 13%; }}
.foot-title {{ font-size: 9pt; color: #374151; margin-top: 16px; }}
.totalbar {{ background: {MAROON}; color: #fff; font-weight: bold; font-size: 12pt; padding: 8px 14px; }}
.totalbar .lbl {{ font-size: 9.5pt; font-weight: normal; }}
.sign {{ margin-top: 34px; font-size: 9pt; color: {MUTED}; }}
</style></head><body>

<table width="100%"><tr>
  <td width="40%" valign="top"><div class="co-name">{co_name}</div>
    <div class="co-meta">{co_addr}<br/>{co_phone}<br/>{co_email}</div></td>
  <td width="30%" valign="middle"><div class="wordmark"><div class="wm1">ON POINT</div><div class="wm2">INSTALLATIONS</div></div></td>
  <td width="30%" valign="top">
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><td class="bar">Estimate {estimate_no}</td></tr>
      <tr><td style="height:4px;"></td></tr>
      <tr><td class="bar"><span class="barlabel">DATE</span> <small>{est_date}</small></td></tr>
      <tr><td style="height:4px;"></td></tr>
      <tr><td class="bar"><span class="barlabel">EXPIRATION</span> <small>{expiration}</small></td></tr>
    </table>
  </td>
</tr></table>

<table width="100%" style="margin-top:16px;"><tr>
  <td width="60%" valign="top"><div class="blocklabel">Address</div><div class="billto">{bill_to}</div></td>
  <td width="40%" valign="top"><div class="blocklabel">Sales Rep</div><div class="billto">{sales_rep}</div></td>
</tr></table>

<table class="lines">
  <tr><th width="13%">ITEM</th><th>DESCRIPTION</th><th class="n" width="8%">QTY</th><th class="n" width="13%">RATE</th><th class="n" width="13%">AMOUNT</th></tr>
  {_line_rows(d.get("lines"))}
</table>

<table width="100%"><tr>
  <td width="55%" valign="top"><div class="foot-title">{footer_title}{("<br/>" + preparer) if preparer else ""}</div></td>
  <td width="45%" valign="top"><table width="100%"><tr>
    <td class="totalbar"><span class="lbl">TOTAL</span></td>
    <td class="totalbar" style="text-align:right;">${total}</td>
  </tr></table></td>
</tr></table>

<table width="100%" class="sign"><tr>
  <td width="50%">Accepted By ____________________________</td>
  <td width="50%">Accepted Date ______________________</td>
</tr></table>

</body></html>"""


def render_estimate_pdf(data: dict) -> bytes:
    out = BytesIO()
    result = pisa.CreatePDF(src=build_estimate_html(data), dest=out, encoding="utf-8")
    if result.err:
        raise RuntimeError("PDF generation failed")
    return out.getvalue()
