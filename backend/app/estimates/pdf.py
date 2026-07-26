"""
App-generated customer estimate PDF (Phase A, step 7/9).

Replicates OPI's QuickBooks estimate — the itemized customer quote — but modernized
and app-polished, with the On Point Installations logo. Standard blocks come from
estimate_pdf_defaults (editable per quote); priced line items come from the quoting
metrics (computeSetBundles on the client), so the PDF ties out to the workbook.

Pure-Python rendering via xhtml2pdf (no system libraries).
"""
import base64
import os
from html import escape
from io import BytesIO

from xhtml2pdf import pisa

MAROON = "#7c1d2b"
GREEN = "#1f3a2c"
INK = "#222831"
MUTED = "#6b7280"
LINE = "#e6e8eb"

_LOGO_PATH = os.path.join(os.path.dirname(__file__), "assets", "opi-logo.png")
try:
    with open(_LOGO_PATH, "rb") as _f:
        LOGO_URI = "data:image/png;base64," + base64.b64encode(_f.read()).decode()
except Exception:
    LOGO_URI = ""


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


def _ml(s):
    return escape(str(s or "")).replace("\n", "<br/>")


def _line_rows(lines):
    rows = []
    for ln in lines or []:
        rate = _money(ln.get("rate")) if ln.get("rate") not in (None, "") else ""
        amount = _money(ln.get("amount")) if ln.get("amount") not in (None, "") else ""
        rows.append(
            f'<tr>'
            f'<td class="c-item">{_ml(ln.get("label"))}</td>'
            f'<td class="c-desc">{_ml(ln.get("description"))}</td>'
            f'<td class="c-qty">{_qty(ln.get("qty"))}</td>'
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
    co_addr = _ml(co.get("address"))
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

    logo = f'<img src="{LOGO_URI}" style="width:150px;" />' if LOGO_URI else \
        f'<div style="font-size:16pt;font-weight:bold;color:{GREEN};">ON POINT<br/><span style="font-size:8pt;letter-spacing:3px;color:{MUTED};">INSTALLATIONS</span></div>'

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
@page {{ size: letter; margin: 1.3cm 1.4cm; }}
body {{ font-family: Helvetica, Arial, sans-serif; color: {INK}; font-size: 9.5pt; }}
.co-name {{ font-size: 10.5pt; font-weight: bold; color: {INK}; margin-top: 6px; }}
.co-meta {{ font-size: 8pt; color: {MUTED}; line-height: 1.4; }}
.est-box {{ border: 1px solid {LINE}; }}
.est-title {{ color: {MAROON}; font-size: 15pt; font-weight: bold; letter-spacing: 3px; padding: 8px 12px 2px; }}
.est-no {{ color: {INK}; font-size: 11pt; font-weight: bold; padding: 0 12px 8px; }}
.est-row td {{ padding: 5px 12px; font-size: 8.5pt; border-top: 1px solid {LINE}; }}
.est-lbl {{ color: {MUTED}; text-transform: uppercase; letter-spacing: 0.5px; font-size: 7.5pt; }}
.rule {{ border-bottom: 2px solid {MAROON}; margin: 14px 0 0; }}
.blocklabel {{ font-size: 7.5pt; font-weight: bold; letter-spacing: 0.6px; color: {MAROON}; text-transform: uppercase; }}
.billto {{ font-size: 9.5pt; line-height: 1.45; margin-top: 3px; color: {INK}; }}
table.lines {{ width: 100%; border-collapse: collapse; margin-top: 16px; }}
table.lines th {{ background: {MAROON}; color: #fff; font-size: 7.5pt; letter-spacing: 0.6px;
  padding: 7px 10px; text-align: left; }}
th.n {{ text-align: right; }}
.c-item {{ padding: 9px 10px; border-bottom: 1px solid {LINE}; font-weight: bold; font-size: 8.5pt;
  color: {INK}; vertical-align: top; width: 14%; }}
.c-desc {{ padding: 9px 10px; border-bottom: 1px solid {LINE}; font-size: 9pt; color: #3a4046;
  vertical-align: top; line-height: 1.45; }}
.c-qty {{ padding: 9px 8px; border-bottom: 1px solid {LINE}; text-align: right; vertical-align: top;
  width: 8%; color: {MUTED}; }}
.c-num {{ padding: 9px 10px; border-bottom: 1px solid {LINE}; text-align: right; vertical-align: top;
  white-space: nowrap; width: 13%; color: {INK}; }}
.foot-title {{ font-size: 9pt; color: #3a4046; padding-top: 18px; line-height: 1.4; }}
.foot-prep {{ color: {MUTED}; font-size: 8.5pt; }}
.totalbox td {{ padding: 10px 14px; }}
.total-lbl {{ background: {INK}; color: #fff; font-size: 9.5pt; letter-spacing: 1px; }}
.total-amt {{ background: {MAROON}; color: #fff; font-size: 13pt; font-weight: bold; text-align: right; }}
.sign td {{ padding-top: 6px; font-size: 8.5pt; color: {MUTED}; border-top: 1px solid #cfd3d8; }}
</style></head><body>

<table width="100%">
  <tr>
    <td width="52%" valign="top">
      {logo}
      <div class="co-name">{co_name}</div>
      <div class="co-meta">{co_addr}<br/>{co_phone} &nbsp;&middot;&nbsp; {co_email}</div>
    </td>
    <td width="48%" valign="top">
      <table width="100%" class="est-box" cellspacing="0">
        <tr><td class="est-title">ESTIMATE</td></tr>
        <tr><td class="est-no">#{estimate_no}</td></tr>
        <tr class="est-row"><td><span class="est-lbl">Date</span>&nbsp;&nbsp;{est_date}</td></tr>
        <tr class="est-row"><td><span class="est-lbl">Valid Until</span>&nbsp;&nbsp;{expiration}</td></tr>
      </table>
    </td>
  </tr>
</table>
<div class="rule"></div>

<table width="100%" style="margin-top:16px;"><tr>
  <td width="60%" valign="top"><div class="blocklabel">Prepared For</div><div class="billto">{bill_to}</div></td>
  <td width="40%" valign="top"><div class="blocklabel">Sales Rep</div><div class="billto">{sales_rep}</div></td>
</tr></table>

<table class="lines">
  <tr><th width="14%">ITEM</th><th>DESCRIPTION</th><th class="n" width="8%">QTY</th><th class="n" width="13%">RATE</th><th class="n" width="13%">AMOUNT</th></tr>
  {_line_rows(d.get("lines"))}
</table>

<table width="100%"><tr>
  <td width="52%" valign="top"><div class="foot-title">{footer_title}{('<br/><span class="foot-prep">Prepared by ' + preparer + '</span>') if preparer else ''}</div></td>
  <td width="48%" valign="top"><table width="100%" cellspacing="0" class="totalbox">
    <tr><td class="total-lbl">TOTAL</td><td class="total-amt">${total}</td></tr>
  </table></td>
</tr></table>

<table width="100%" style="margin-top:40px;"><tr>
  <td width="48%" class="sign">Accepted By</td>
  <td width="4%"></td>
  <td width="48%" class="sign">Accepted Date</td>
</tr></table>

</body></html>"""


def render_estimate_pdf(data: dict) -> bytes:
    out = BytesIO()
    result = pisa.CreatePDF(src=build_estimate_html(data), dest=out, encoding="utf-8")
    if result.err:
        raise RuntimeError("PDF generation failed")
    return out.getvalue()
