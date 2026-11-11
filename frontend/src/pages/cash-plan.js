// Cash Plan: the owners' view of cash (backend/app/cashflow/plan.py). The 13-week
// forecast plus, as switchable lines: won jobs not scheduled yet, the weighted
// pipeline, payroll on its own line, and crew pay on bi-weekly paydays. A balance
// chart with the lowest week marked, and a printable one-page owner report.
// The Cash Flow page (#/cashflow) stays as it is.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml as esc } from "../utils/html.js";
import { day, money0 } from "../utils/ui.js";

const LAYERS = [["won", "Won, not scheduled"], ["pipeline", "Pipeline (weighted)"]];
const k$ = (n) => { const a = Math.abs(n); const s = n < 0 ? "-" : ""; return a >= 1e6 ? `${s}$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `${s}$${Math.round(a / 1e3)}k` : `${s}$${Math.round(a)}`; };

export async function cashPlanPage(routeFn) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("opi_cashplan") || "{}"); } catch (_) {}
  const st = { data: null, weeks: saved.weeks || 13, biweekly: saved.biweekly ?? true, anchor: saved.anchor || "", min_prob: saved.min_prob || 40,
               on: saved.on || { won: true, pipeline: false } };
  const remember = () => { try { localStorage.setItem("opi_cashplan", JSON.stringify({ weeks: st.weeks, biweekly: st.biweekly, anchor: st.anchor, min_prob: st.min_prob, on: st.on })); } catch (_) {} };

  setShell({
    title: "Cash Plan",
    subtitle: "The owners' view: the cash forecast, plus won jobs not scheduled yet, the weighted pipeline, payroll and bi-weekly crew pay. Switch lines on and off to see what-ifs.",
    bodyHtml: `<div id="cpnRoot"><div class="card p-6 text-sm text-black/45">Building the plan…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("cpnRoot");

  async function load() {
    remember();
    const q = new URLSearchParams({ weeks: st.weeks, biweekly: st.biweekly ? 1 : 0, min_prob: st.min_prob });
    if (st.anchor) q.set("anchor", st.anchor);
    try { st.data = await api(`/cash-plan?${q}`); render(); }
    catch (e) { root.innerHTML = `<div class="card p-6 text-sm text-rose-700">Couldn't build the plan: ${esc(e?.message || String(e))}</div>`; }
  }

  const shown = (l) => l.layer === "forecast" || st.on[l.layer];
  function compute() {
    const d = st.data, n = d.week_ends.length;
    const ins = d.lines.filter((l) => l.side === "in" && shown(l));
    const outs = d.lines.filter((l) => l.side === "out" && shown(l));
    const sum = (ls) => Array.from({ length: n }, (_, i) => ls.reduce((a, l) => a + l.weekly[i], 0));
    const tin = sum(ins), tout = sum(outs);
    const bal = []; let b = d.opening;
    for (let i = 0; i < n; i++) { b += tin[i] - tout[i]; bal.push(b); }
    let lo = 0; bal.forEach((v, i) => { if (v < bal[lo]) lo = i; });
    return { ins, outs, tin, tout, bal, lo };
  }

  function chart(bal, lo, weekEnds, opening, W = 760) {
    const H = 220, padL = 56, padR = 14, padT = 14, padB = 26;
    const vals = [opening, ...bal];
    const anyNeg = vals.some((v) => v < 0);
    let min = anyNeg ? Math.min(0, ...vals) : Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1; min -= span * 0.05; max += span * 0.08;
    const x = (i) => padL + (i * (W - padL - padR)) / (vals.length - 1);
    const y = (v) => padT + ((max - v) * (H - padT - padB)) / (max - min);
    const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const ticks = 4, grid = [];
    for (let t = 0; t <= ticks; t++) { const v = min + ((max - min) * t) / ticks; grid.push(v); }
    const labels = ["Today", ...weekEnds.map((w) => day(w).replace(/, \d+$/, "").replace(/ '\d+$/, ""))];
    const step = Math.ceil(labels.length / 7);
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="cpn-chart" role="img" aria-label="Projected cash balance by week; lowest ${money0(bal[lo])} in the week ending ${day(weekEnds[lo])}">
      ${grid.map((v) => `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="cpn-grid"/><text x="${padL - 8}" y="${y(v) + 3.5}" text-anchor="end" class="cpn-axis">${k$(v)}</text>`).join("")}
      ${anyNeg ? `<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" class="cpn-zero"/>` : ""}
      <polygon points="${x(0)},${y(Math.max(min, 0))} ${pts.join(" ")} ${x(vals.length - 1)},${y(Math.max(min, 0))}" class="cpn-area"/>
      <polyline points="${pts.join(" ")}" class="cpn-line"/>
      <circle cx="${x(lo + 1)}" cy="${y(bal[lo])}" r="5" class="cpn-low"/>
      <text x="${Math.min(x(lo + 1), W - padR - 4)}" y="${y(bal[lo]) + (y(bal[lo]) > padT + 30 ? -12 : 20)}" text-anchor="${x(lo + 1) > W - 120 ? "end" : "middle"}" class="cpn-lowlbl">Lowest ${k$(bal[lo])}</text>
      ${labels.map((l, i) => (i % step === 0 || i === labels.length - 1) ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="cpn-axis">${esc(l)}</text>` : "").join("")}
      <line class="cpn-cross" x1="0" x2="0" y1="${padT}" y2="${H - padB}" style="display:none"/>
      <rect class="cpn-hit" x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}" fill="transparent"/>
    </svg><div class="cpn-tip" style="display:none"></div>`;
  }

  function render() {
    const d = st.data, c = compute();
    const n = d.week_ends.length;
    const end = c.bal[n - 1];
    const row = (l) => `<tr class="${l.layer !== "forecast" ? "cpn-layer" : ""}"><th scope="row" title="${esc(l.note || "")}">${esc(l.label)}${l.layer !== "forecast" ? ` <span class="cpn-tag">${l.layer === "won" ? "assumed" : "weighted"}</span>` : ""}</th>${l.weekly.map((v) => `<td>${v ? k$(v) : "·"}</td>`).join("")}<td class="cpn-tot">${k$(l.total)}</td></tr>`;
    const totRow = (label, arr, cls = "") => `<tr class="cpn-sum ${cls}"><th scope="row">${label}</th>${arr.map((v) => `<td>${k$(v)}</td>`).join("")}<td class="cpn-tot">${k$(arr.reduce((a, v) => a + v, 0))}</td></tr>`;
    root.innerHTML = `
      <div class="cpn-print-head"><div class="text-xl font-extrabold">OnPoint Installers · Cash Plan</div><div class="text-sm">As of ${day(d.as_of)} · ${n} weeks · opening ${money0(d.opening)} (${esc(d.bank.source || "")})</div></div>
      <div class="su-kpis" id="cpnKpis">
        ${tile("Cash today", money0(d.opening), `Bank, ${esc(d.bank.source === "b250" ? "from the B250" : "QuickBooks")}`)}
        ${tile("Lowest point", money0(c.bal[c.lo]), `Week ending ${day(d.week_ends[c.lo])}`, c.bal[c.lo] < 0)}
        ${tile(`In ${n} weeks`, money0(end), `${end >= d.opening ? "+" : ""}${money0(end - d.opening)} vs today`, end < 0)}
        ${tile("Money in", money0(c.tin.reduce((a, v) => a + v, 0)), "Lines switched on below")}
        ${tile("Money out", money0(c.tout.reduce((a, v) => a + v, 0)), "Including payroll and overhead")}
      </div>
      <div class="flex flex-wrap items-center gap-2 my-4 cpn-noprint">
        ${LAYERS.map(([k, l]) => `<button type="button" class="is-cat${st.on[k] ? " on" : ""}" data-layer="${k}" aria-pressed="${!!st.on[k]}">${st.on[k] ? "✓ " : ""}${l}</button>`).join("")}
        <select id="cpnProb" class="input text-sm !w-auto" title="Which open quotes count in the pipeline line">${[20, 40, 60, 80].map((p) => `<option value="${p}"${p === st.min_prob ? " selected" : ""}>Quotes at ${p}%+</option>`).join("")}</select>
        <select id="cpnWeeks" class="input text-sm !w-auto">${[13, 26].map((w) => `<option value="${w}"${w === st.weeks ? " selected" : ""}>${w} weeks</option>`).join("")}</select>
        <label class="inline-flex items-center gap-2 text-sm text-white/80"><input type="checkbox" id="cpnBi" ${st.biweekly ? "checked" : ""}> Crew pay on bi-weekly paydays</label>
        ${st.biweekly ? `<label class="inline-flex items-center gap-2 text-sm text-white/70">from payday <input type="date" id="cpnAnchor" class="pd-in" value="${esc(st.anchor || d.assumptions.anchor)}"></label>` : ""}
        <span class="flex-1"></span>
        <button type="button" class="pd-btn" id="cpnPrint">Print owner report</button>
      </div>
      <section class="card p-4 mb-3 cpn-chartcard"><div class="flex flex-wrap justify-between gap-2 mb-1"><div class="font-extrabold text-ink-900">Projected cash balance</div><div class="text-xs text-black/50">End of each week, with the lines switched on</div></div>
        <div class="relative" id="cpnChart"></div></section>
      <section class="card overflow-hidden mb-3"><div class="overflow-x-auto" id="cpnGrid"><table class="cpn-table">
        <thead><tr><th scope="col">Week ending</th>${d.week_ends.map((w) => `<th scope="col">${day(w).replace(/, \d+$/, "")}</th>`).join("")}<th scope="col">Total</th></tr></thead>
        <tbody>
          <tr class="cpn-grp"><th colspan="${n + 2}">Money in</th></tr>${c.ins.map(row).join("")}${totRow("Total in", c.tin)}
          <tr class="cpn-grp"><th colspan="${n + 2}">Money out</th></tr>${c.outs.map(row).join("")}${totRow("Total out", c.tout)}
          ${totRow("Net", c.tin.map((v, i) => v - c.tout[i]), "cpn-net")}
          <tr class="cpn-sum cpn-bal"><th scope="row">Cash at week end</th>${c.bal.map((v, i) => `<td class="${v < 0 ? "text-rose-700" : ""}${i === c.lo ? " cpn-lowcell" : ""}">${k$(v)}</td>`).join("")}<td></td></tr>
        </tbody></table></div></section>
      <section class="card p-4 text-sm text-black/65">
        <div class="font-extrabold text-ink-900 mb-1">How this is built</div>
        <ul class="list-disc pl-5 grid gap-1">
          ${d.lines.map((l) => `<li><b>${esc(l.label)}:</b> ${esc(l.note || "")}</li>`).join("")}
          <li><b>Terms:</b> ${esc(d.assumptions.terms)}; invoices paid ${d.assumptions.pay_lag_days} days after they're sent; the first invoice goes out ${d.assumptions.order_lead_days} days before the start.</li>
          <li>The Cash Flow page is unchanged and stays the detailed forecast; this page reads it.</li>
        </ul>
      </section>`;
    drawChart(c);
    bind(c);
  }
  function drawChart(c) {
    const box = root.querySelector("#cpnChart");
    const w = Math.max(320, Math.floor(box.clientWidth || 760));
    box.innerHTML = chart(c.bal, c.lo, st.data.week_ends, st.data.opening, w);
    box.dataset.w = w;
  }
  let rz;
  window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (st.data && document.getElementById("cpnChart")) { const c = compute(); drawChart(c); bindChart(c); } }, 200); });
  const tile = (label, value, caption, bad) => `<div class="card p-4 su-kpi !cursor-default"><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">${label}</div><div class="text-2xl font-extrabold tabular-nums ${bad ? "text-rose-700" : ""}">${value}</div><div class="text-xs text-black/50">${caption}</div></div>`;

  function bind(c) {
    root.querySelectorAll("[data-layer]").forEach((b) => b.addEventListener("click", () => { st.on[b.dataset.layer] = !st.on[b.dataset.layer]; remember(); render(); }));
    root.querySelector("#cpnProb").addEventListener("change", (e) => { st.min_prob = +e.target.value; st.on.pipeline = true; load(); });
    root.querySelector("#cpnWeeks").addEventListener("change", (e) => { st.weeks = +e.target.value; load(); });
    root.querySelector("#cpnBi").addEventListener("change", (e) => { st.biweekly = e.target.checked; load(); });
    root.querySelector("#cpnAnchor")?.addEventListener("change", (e) => { st.anchor = e.target.value; load(); });
    root.querySelector("#cpnPrint").addEventListener("click", () => window.print());
    bindChart(c);
  }
  function bindChart(c) {
    // hover: crosshair + tooltip on the nearest week
    const box = root.querySelector("#cpnChart"), svg = box.querySelector("svg"), tip = box.querySelector(".cpn-tip"), cross = svg.querySelector(".cpn-cross");
    const d = st.data, n = d.week_ends.length;
    svg.querySelector(".cpn-hit").addEventListener("mousemove", (ev) => {
      const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
      const px = ((ev.clientX - r.left) / r.width) * vb.width;
      const i = Math.max(0, Math.min(n, Math.round(((px - 56) / (vb.width - 70)) * n)));
      if (Number.isNaN(i)) return;
      const xx = 56 + (i * (vb.width - 70)) / n;
      cross.setAttribute("x1", xx); cross.setAttribute("x2", xx); cross.style.display = "";
      const bal = i === 0 ? d.opening : c.bal[i - 1];
      tip.innerHTML = i === 0 ? `<b>Today</b><div>${money0(bal)}</div>` :
        `<b>Week ending ${day(d.week_ends[i - 1])}</b><div class="flex justify-between gap-4"><span>In</span><span>${money0(c.tin[i - 1])}</span></div><div class="flex justify-between gap-4"><span>Out</span><span>${money0(c.tout[i - 1])}</span></div><div class="flex justify-between gap-4 font-bold"><span>Cash</span><span>${money0(bal)}</span></div>`;
      tip.style.display = "block";
      const left = (xx / vb.width) * r.width;
      tip.style.left = `${Math.min(Math.max(0, left + 12), r.width - 170)}px`;
      tip.style.top = "8px";
    });
    svg.querySelector(".cpn-hit").addEventListener("mouseleave", () => { tip.style.display = "none"; cross.style.display = "none"; });
  }

  load();
}
