"""
App-generated customer estimate PDF (Phase A, step 7/9).

A modern, minimal estimate in OPI's own brand (forest green + charcoal, matching the
logo and website) — not a QuickBooks clone. Keeps the estimate structure (header,
bill-to, itemized lines, total, terms) but with one consistent typeface, generous
whitespace, and the On Point Installations logo. Standard blocks come from
estimate_pdf_defaults; priced lines come from the quoting metrics (computeSetBundles),
so the PDF ties out to the workbook.

Pure-Python rendering via xhtml2pdf (no system libraries).
"""
import base64
import os
from html import escape
from io import BytesIO

from xhtml2pdf import pisa

# OPI brand (from the app's tailwind palette + logo).
GREEN = "#325241"      # brand.700 — headers / accents
GREEN_DK = "#22362d"   # brand.900 — logo-matching deep green
GREEN_50 = "#f4f7f5"   # brand.50  — subtle tint
INK = "#111827"        # ink.800
INK_SOFT = "#374151"   # ink.700
MUTED = "#6b7280"
LINE = "#eceef0"

_LOGO_PATH = os.path.join(os.path.dirname(__file__), "assets", "opi-logo.png")
try:
    with open(_LOGO_PATH, "rb") as _f:
        LOGO_URI = "data:image/png;base64," + base64.b64encode(_f.read()).decode()
except Exception:
    LOGO_URI = ""


def _num0(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return 0.0


def _money(v, blank_zero=False):
    n = _num0(v)
    if blank_zero and n == 0:
        return ""
    return format(round(n, 2), ",.2f")


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
        rate_n, amt_n = _num0(ln.get("rate")), _num0(ln.get("amount"))
        note = rate_n == 0 and amt_n == 0          # boilerplate (Payment Terms / Stipulations)
        item_cls = "c-item note" if note else "c-item"
        desc_cls = "c-desc note" if note else "c-desc"
        qty = "" if note else _qty(ln.get("qty"))
        rate = "" if note else _money(ln.get("rate"), blank_zero=True)
        amount = "" if note else _money(ln.get("amount"), blank_zero=True)
        rows.append(
            f'<tr>'
            f'<td class="{item_cls}">{_ml(ln.get("label"))}</td>'
            f'<td class="{desc_cls}">{_ml(ln.get("description"))}</td>'
            f'<td class="c-qty">{qty}</td>'
            f'<td class="c-num">{rate}</td>'
            f'<td class="c-num strong">{amount}</td>'
            f'</tr>'
        )
    if not rows:
        rows.append('<tr><td class="c-item" colspan="5">—</td></tr>')
    return "\n".join(rows)


def build_estimate_html(d: dict) -> str:
    co = d.get("company") or {}
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

    logo = f'<img src="{LOGO_URI}" style="width:135px;" />' if LOGO_URI else \
        f'<div style="font-size:15pt;font-weight:bold;color:{GREEN_DK};">On Point Installations</div>'

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"/><style>
@page {{ size: letter; margin: 1.5cm 1.5cm; }}
body {{ font-family: Helvetica, Arial, sans-serif; color: {INK}; font-size: 9.5pt; }}
.co-meta {{ font-size: 8pt; color: {MUTED}; line-height: 1.5; margin-top: 10px; }}
.est-eyebrow {{ color: {GREEN}; font-size: 12pt; font-weight: bold; letter-spacing: 2px; }}
.est-no {{ color: {INK}; font-size: 20pt; font-weight: bold; margin-top: 2px; }}
.est-meta {{ margin-top: 10px; }}
.est-meta td {{ padding: 2px 0; font-size: 9pt; }}
.mlabel {{ color: {MUTED}; text-transform: uppercase; letter-spacing: 0.5px; font-size: 7.5pt;
  padding-right: 12px !important; }}
.rule {{ border-bottom: 1px solid {LINE}; margin: 20px 0 0; }}
.blocklabel {{ font-size: 7.5pt; font-weight: bold; letter-spacing: 0.8px; color: {GREEN};
  text-transform: uppercase; }}
.billto {{ font-size: 10pt; line-height: 1.5; margin-top: 4px; color: {INK}; }}
table.lines {{ width: 100%; border-collapse: collapse; margin-top: 20px; }}
table.lines th {{ background: {GREEN}; color: #fff; font-size: 7.5pt; letter-spacing: 0.8px;
  padding: 8px 12px; text-align: left; }}
th.n {{ text-align: right; }}
.c-item {{ padding: 11px 12px; border-bottom: 1px solid {LINE}; font-weight: bold; font-size: 9pt;
  color: {INK}; vertical-align: top; width: 15%; }}
.c-desc {{ padding: 11px 12px; border-bottom: 1px solid {LINE}; font-size: 9pt; color: {INK_SOFT};
  vertical-align: top; line-height: 1.5; }}
.c-qty {{ padding: 11px 8px; border-bottom: 1px solid {LINE}; text-align: right; vertical-align: top;
  width: 7%; color: {MUTED}; font-size: 9pt; }}
.c-num {{ padding: 11px 12px; border-bottom: 1px solid {LINE}; text-align: right; vertical-align: top;
  white-space: nowrap; width: 13%; color: {INK}; font-size: 9pt; }}
.c-num.strong {{ font-weight: bold; }}
.note {{ color: {MUTED} !important; font-size: 8pt !important; font-weight: normal !important; }}
.totalrow {{ margin-top: 4px; }}
.totalrow td {{ padding: 14px 12px; }}
.total-lbl {{ text-align: right; font-size: 9pt; letter-spacing: 1px; color: {MUTED};
  text-transform: uppercase; }}
.total-amt {{ text-align: right; font-size: 16pt; font-weight: bold; color: {GREEN_DK};
  border-top: 2px solid {GREEN}; white-space: nowrap; }}
.foot {{ margin-top: 26px; font-size: 9pt; color: {INK_SOFT}; }}
.foot .prep {{ color: {MUTED}; font-size: 8.5pt; }}
.sign td {{ padding-top: 8px; font-size: 8.5pt; color: {MUTED}; border-top: 1px solid #d7dade; }}
</style></head><body>

<table width="100%">
  <tr>
    <td width="50%" valign="top">
      {logo}
      <div class="co-meta">{co_addr}<br/>{co_phone} &nbsp;&middot;&nbsp; {co_email}</div>
    </td>
    <td width="50%" valign="top" align="right">
      <div class="est-eyebrow">ESTIMATE</div>
      <div class="est-no">#{estimate_no}</div>
      <table class="est-meta" align="right">
        <tr><td class="mlabel">Date</td><td align="right">{est_date}</td></tr>
        <tr><td class="mlabel">Valid Until</td><td align="right">{expiration}</td></tr>
      </table>
    </td>
  </tr>
</table>
<div class="rule"></div>

<table width="100%" style="margin-top:18px;"><tr>
  <td width="60%" valign="top"><div class="blocklabel">Prepared For</div><div class="billto">{bill_to}</div></td>
  <td width="40%" valign="top"><div class="blocklabel">Sales Rep</div><div class="billto">{sales_rep}</div></td>
</tr></table>

<table class="lines">
  <tr><th width="15%">ITEM</th><th>DESCRIPTION</th><th class="n" width="7%">QTY</th><th class="n" width="13%">RATE</th><th class="n" width="13%">AMOUNT</th></tr>
  {_line_rows(d.get("lines"))}
</table>

<table width="100%" class="totalrow"><tr>
  <td width="62%"></td>
  <td width="20%" class="total-lbl">Total</td>
  <td width="18%" class="total-amt">${total}</td>
</tr></table>

<div class="foot">{footer_title}{('<br/><span class="prep">Prepared by ' + preparer + '</span>') if preparer else ''}</div>

<table width="100%" style="margin-top:38px;"><tr>
  <td width="47%" class="sign">Accepted By</td>
  <td width="6%"></td>
  <td width="47%" class="sign">Accepted Date</td>
</tr></table>

</body></html>"""


def render_estimate_pdf(data: dict) -> bytes:
    out = BytesIO()
    result = pisa.CreatePDF(src=build_estimate_html(data), dest=out, encoding="utf-8")
    if result.err:
        raise RuntimeError("PDF generation failed")
    return out.getvalue()
