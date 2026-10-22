// Revenue Forecast — the B151 "1. Rolling Summary" rebuilt from app data.
//
// Monthly earned revenue (won projects + probability-weighted pipeline), gross
// profit at each job's OH&P %, overhead and owner comp from the Cash Flow
// overhead list, operating profit and the revenue gap to breakeven. Bucket rows
// expand to the jobs behind them; jobs with no dates are listed separately so
// they can be scheduled instead of silently dropping out.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

const k = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) < 0.5) return "–";
  const s = Math.round(Math.abs(n)).toLocaleString("en-US");
  return n < 0 ? `(${s})` : s;
};
const money = (v) => (v == null ? "—" : (Number(v) < 0 ? "-$" : "$") + Math.round(Math.abs(Number(v))).toLocaleString("en-US"));
const short = (v) => {
  const n = Number(v) || 0, a = Math.abs(n);
  const s = a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M" : a >= 1e3 ? Math.round(a / 1e3) + "k" : Math.round(a).toString();
  return (n < 0 ? "-$" : "$") + s;
};
const monLabel = (ym) => { const [y, m] = ym.split("-"); return new Date(+y, +m - 1, 1).toLocaleString("en-US", { month: "short" }) + "-" + y.slice(2); };
const fmtMDY = (iso) => { if (!iso) return "—"; const [y, m, d] = iso.split("-"); return `${+m}/${+d}/${y.slice(2)}`; };
const PREF = "opi_revenue_prefs";
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF) || "{}"); } catch (_) { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch (_) {} };

export async function revenuePage(routeFn) {
  const prefs = loadPrefs();
  const st = { months: prefs.months || 12, start: "", data: null, open: new Set(), unsched: "won" };

  setShell({
    title: "Revenue Forecast",
    subtitle: "Monthly earned revenue, gross profit and operating profit — won work plus the weighted pipeline.",
    bodyHtml: `
      <div class="card px-4 py-3 mb-4">
        <div class="flex flex-wrap items-end gap-x-3 gap-y-2">
          <div><div class="label mb-0.5">First month</div><input id="rfStart" type="month" class="input py-1.5" style="width:160px"></div>
          <div>
            <div class="label mb-0.5">Months</div>
            <div class="flex items-center gap-1">${[12, 24, 36].map((n) => `<button type="button" data-months="${n}" class="rf-seg">${n}</button>`).join("")}</div>
          </div>
          <button id="rfInfo" type="button" class="rf-seg" title="How this page works">How it works</button>
        </div>
        <div id="rfInfoBox" class="rf-info hidden">
          <p><b>Same rules as the B151 Rolling Summary.</b> Each job's value is spread by calendar day across its dates. Open quotes count at their win chance (20 / 40 / 60 / 80%, Red Flag 80%); Inactive and Lost count as nothing. Gross profit is each job's own OH&amp;P %. Operating profit = gross profit − overhead − owner comp; the breakeven gap is the extra revenue needed to cover a loss at that month's margin.</p>
          <p><b>Where the numbers come from.</b> <i>Won</i> = QuickBooks projects with an accepted estimate — the full contract including change orders — spread across the project's Schedule dates. <i>Pipeline</i> = open quotes on the Pipeline page at their est. start / end. <i>Overhead</i> and <i>owner comp</i> = the Cash Flow page's Overhead list, so both reports always agree.</p>
          <p><b>Not guessed:</b> jobs with no dates can't be placed in a month — they're listed under <i>Not in the forecast</i> below. Set their dates (Schedule for won jobs, est. start on the Pipeline) and they flow in.</p>
        </div>
      </div>
      <div id="rfRoot"><div class="card p-6 text-sm text-black/45">Building the forecast…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("rfRoot");
  const startEl = document.getElementById("rfStart");

  const segs = () => document.querySelectorAll("[data-months]").forEach((b) => b.classList.toggle("rf-seg-on", +b.dataset.months === st.months));
  segs();

  async function load() {
    root.innerHTML = `<div class="card p-6 text-sm text-black/45">Building the forecast…</div>`;
    try {
      const q = new URLSearchParams({ months: st.months });
      if (st.start) q.set("start_month", st.start);
      st.data = await api(`/cashflow/revenue-forecast?${q}`);
      if (!startEl.value) startEl.value = st.data.months[0];
      render();
    } catch (e) {
      root.innerHTML = `<div class="card p-6 text-sm text-red-700">Couldn't build the forecast: ${escapeHtml(e?.message || String(e))}</div>`;
    }
  }

  function render() {
    const d = st.data, T = d.totals, W = d.window, n = d.months.length;
    const pipeRev = W.revenue - W.won_revenue;
    const losing = T.operating_profit.filter((x) => x < 0).length;
    const sum = (a) => a.reduce((s, x) => s + x, 0);
    const cells = (arr, cls = "") => arr.map((v) => `<td class="rf-num ${cls} ${v < 0 ? "rf-neg" : ""}">${k(v)}</td>`).join("") +
      `<td class="rf-num rf-tot ${cls} ${sum(arr) < 0 ? "rf-neg" : ""}">${k(sum(arr))}</td>`;
    const unWon = d.unscheduled.filter((u) => u.bucket === "won");
    const unPipe = d.unscheduled.filter((u) => u.bucket !== "won");

    const bucketRows = d.buckets.map((b) => {
      const items = d.items.filter((i) => i.bucket === b.key);
      const isOpen = st.open.has(b.key);
      const head = `<tr class="rf-bucket" data-bucket="${b.key}">
          <th class="rf-lbl"><span class="rf-car">${items.length ? (isOpen ? "▾" : "▸") : ""}</span>${escapeHtml(b.label)} <span class="rf-cnt">${items.length}</span></th>
          ${cells(b.revenue)}</tr>`;
      if (!isOpen) return head;
      return head + items.map((i) => `<tr class="rf-item">
          <th class="rf-lbl rf-ilbl">${itemLink(i)}<div class="rf-imeta">${i.kind === "project" ? "" : `${Math.round(i.weight * 100)}% of ${short(i.value)} · `}${fmtMDY(i.start)} – ${fmtMDY(i.end)}${i.end_estimated ? " (est.)" : ""} · OH&amp;P ${i.ohp_pct}%</div></th>
          ${cells(i.months, "rf-icell")}</tr>`).join("");
    }).join("");

    root.innerHTML = `
      <div class="rf-kpis">
        ${kpi("Revenue", short(W.revenue), `${monLabel(d.months[0])} – ${monLabel(d.months[n - 1])}`)}
        ${kpi("Won work", short(W.won_revenue), `${W.revenue ? Math.round(W.won_revenue / W.revenue * 100) : 0}% of the forecast`)}
        ${kpi("Weighted pipeline", short(pipeRev), "open quotes × win chance")}
        ${kpi("Gross profit", short(W.gp), `${W.gm_pct}% margin`)}
        ${kpi("Operating profit", short(W.operating_profit), losing ? `${losing} month${losing > 1 ? "s" : ""} below breakeven` : "every month above breakeven", W.operating_profit < 0 ? "rf-kpi-bad" : "rf-kpi-good")}
      </div>

      <div class="card rf-card">
        <div class="rf-tablewrap"><table class="rf-table">
          <thead><tr><th class="rf-lbl">Monthly</th>${d.months.map((m) => `<th class="rf-num">${monLabel(m)}</th>`).join("")}<th class="rf-num rf-tot">Total</th></tr></thead>
          <tbody>
            <tr class="rf-sec"><th class="rf-lbl" colspan="${n + 2}">Revenue (weighted)</th></tr>
            ${bucketRows}
            <tr class="rf-sum"><th class="rf-lbl">Total revenue</th>${cells(T.revenue)}</tr>
            <tr class="rf-sec"><th class="rf-lbl" colspan="${n + 2}">Profit</th></tr>
            <tr><th class="rf-lbl">Gross profit</th>${cells(T.gp)}</tr>
            <tr><th class="rf-lbl">Gross margin %</th>${T.gm_pct.map((v) => `<td class="rf-num">${v ? v.toFixed(0) + "%" : "–"}</td>`).join("")}<td class="rf-num rf-tot">${W.gm_pct ? W.gm_pct.toFixed(0) + "%" : "–"}</td></tr>
            <tr><th class="rf-lbl">Overhead <span class="rf-cnt">Cash Flow list</span></th>${cells(T.opex.map((x) => -x))}</tr>
            <tr><th class="rf-lbl">Owner comp</th>${cells(T.owner_comp.map((x) => -x))}</tr>
            <tr class="rf-sum"><th class="rf-lbl">Operating profit</th>${cells(T.operating_profit)}</tr>
            <tr><th class="rf-lbl">Revenue gap to breakeven</th>${cells(T.breakeven_gap, "rf-gap")}</tr>
          </tbody>
        </table></div>
        <div class="rf-foot">Click a revenue line to see the jobs behind it. Amounts in dollars; negatives in parentheses.${T.owner_comp.some((x) => !x) ? ` <b>Owner comp is $0 in some months</b> — its line on the Cash Flow Overhead list has an end date.` : ""}</div>
      </div>

      <div class="card rf-card">
        <div class="rf-h">Not in the forecast — no dates yet</div>
        <div class="rf-sub">These can't be placed in a month until they have dates. ${short(unWon.reduce((s, u) => s + u.value, 0))} of won work and ${short(unPipe.reduce((s, u) => s + u.weighted, 0))} of weighted pipeline are waiting.</div>
        <div class="flex items-center gap-1 my-2">
          <button type="button" data-unsched="won" class="rf-seg ${st.unsched === "won" ? "rf-seg-on" : ""}">Won, no Schedule dates (${unWon.length})</button>
          <button type="button" data-unsched="pipe" class="rf-seg ${st.unsched === "pipe" ? "rf-seg-on" : ""}">Open quotes, no est. start (${unPipe.length})</button>
        </div>
        <div class="rf-tablewrap"><table class="rf-table rf-list">
          <thead><tr><th class="rf-lbl">${st.unsched === "won" ? "Project" : "Quote"}</th><th>Status</th><th class="rf-num">Value</th><th class="rf-num">Weighted</th></tr></thead>
          <tbody>${(st.unsched === "won" ? unWon : unPipe).slice(0, 200).map((u) => `<tr>
            <th class="rf-lbl rf-ilbl">${itemLink(u)}${u.customer && u.kind !== "project" ? `<div class="rf-imeta">${escapeHtml(u.customer)}</div>` : ""}</th>
            <td>${u.bucket === "won" ? "Won" : escapeHtml(d.buckets.find((b) => b.key === u.bucket)?.label || u.bucket)}</td>
            <td class="rf-num">${money(u.value)}</td><td class="rf-num">${money(u.weighted)}</td></tr>`).join("")}</tbody>
        </table></div>
      </div>`;
  }

  function itemLink(i) {
    if (i.kind === "project") return `<a class="rf-link" href="#/entity/project/${encodeURIComponent(i.id)}">${escapeHtml(i.name)}</a>`;
    return `<a class="rf-link" href="#/pipeline" data-opp="${i.id}">${i.quote ? `<span class="rf-q">#${escapeHtml(i.quote)}</span> ` : ""}${escapeHtml(i.name)}</a>`;
  }
  function kpi(label, value, sub, cls = "") {
    return `<div class="card rf-kpi ${cls}"><div class="rf-kpi-l">${label}</div><div class="rf-kpi-v">${value}</div><div class="rf-kpi-s">${sub}</div></div>`;
  }

  document.addEventListener("click", (e) => {
    if (!document.body.contains(root)) return;
    const t = e.target;
    const m = t.closest("[data-months]");
    if (m) { st.months = +m.dataset.months; savePrefs({ months: st.months }); segs(); load(); return; }
    if (t.closest("#rfInfo")) { document.getElementById("rfInfoBox").classList.toggle("hidden"); return; }
    const b = t.closest("[data-bucket]");
    if (b) { const key = b.dataset.bucket; st.open.has(key) ? st.open.delete(key) : st.open.add(key); render(); return; }
    const u = t.closest("[data-unsched]");
    if (u) { st.unsched = u.dataset.unsched; render(); }
  });
  startEl.addEventListener("change", () => { st.start = startEl.value; load(); });

  load();
}
