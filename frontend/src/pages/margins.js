// Margins by PM & month (#/margins): finished jobs grouped by completion month and
// PM, with revenue, cost, profit and margin, against the margin the estimate
// planned. Click a cell (or a PM / month total) to list its jobs; Export sends
// exactly those jobs to the Financials Excel export. Backend: app/margins.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml as esc } from "../utils/html.js";
import { day, money0, projectLink } from "../utils/ui.js";
import { exportFinancialRows } from "../utils/financial-export.js";

const mname = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString([], { month: "short", year: "2-digit" });
const pct = (p, r) => (r ? (p / r) * 100 : null);
const tone = (v) => v == null ? "" : v < 10 ? "text-rose-700" : v < 20 ? "text-amber-700" : "text-emerald-700";

export async function marginsPage(routeFn) {
  const st = { months: 12, rows: [], sel: { pm: null, month: null }, pmFilter: "" };
  setShell({ title: "Margins by PM & Month", subtitle: "Finished jobs by the month they finished: revenue, cost, profit and margin, by PM. Click any number to see its jobs and export them.", routeFn,
    bodyHtml: `<div id="mgRoot"><div class="card p-6 text-sm text-black/45">Loading finished jobs…</div></div>` });
  const root = document.getElementById("mgRoot");

  async function load() {
    const d = await api(`/margins?months=${st.months}`);
    st.rows = d.rows;
    render();
  }

  function agg(list) {
    const r = list.reduce((a, x) => ({ rev: a.rev + x.revenue, cost: a.cost + x.cost, profit: a.profit + x.profit, n: a.n + 1 }), { rev: 0, cost: 0, profit: 0, n: 0 });
    r.margin = pct(r.profit, r.rev);
    return r;
  }

  function render() {
    const rows = st.pmFilter ? st.rows.filter((r) => r.pm === st.pmFilter) : st.rows;
    const months = [...new Set(rows.map((r) => r.month))].sort().reverse();
    const pms = [...new Set(st.rows.map((r) => r.pm))].sort();
    const shownPms = st.pmFilter ? [st.pmFilter] : pms;
    const all = agg(rows);
    const cell = (list, pm, month) => {
      if (!list.length) return `<td class="mg-c text-black/25">·</td>`;
      const a = agg(list);
      const on = st.sel.pm === pm && st.sel.month === month;
      return `<td class="mg-c"><button type="button" class="mg-btn${on ? " on" : ""}" data-pm="${esc(pm || "")}" data-month="${month || ""}">
        <span class="font-extrabold ${tone(a.margin)}">${a.margin == null ? "—" : `${a.margin.toFixed(1)}%`}</span><span class="block text-[11px] text-black/50">${money0(a.rev)} · ${a.n}</span></button></td>`;
    };
    const selRows = rows.filter((r) => (!st.sel.pm || r.pm === st.sel.pm) && (!st.sel.month || r.month === st.sel.month));
    const recent = new Date(); recent.setDate(recent.getDate() - 45);
    root.innerHTML = `
      <div class="su-kpis mb-4">
        ${tile("Revenue", money0(all.rev), `${all.n} finished jobs`)}
        ${tile("Cost", money0(all.cost), "Bills and card charges on the jobs")}
        ${tile("Profit", money0(all.profit), "Revenue minus cost")}
        ${tile("Margin", all.margin == null ? "—" : `${all.margin.toFixed(1)}%`, "Profit ÷ revenue", all.margin != null && all.margin < 15)}
      </div>
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <select id="mgMonths" class="input text-sm !w-auto">${[6, 12, 24, 36].map((m) => `<option value="${m}"${m === st.months ? " selected" : ""}>Last ${m} months</option>`).join("")}</select>
        <select id="mgPm" class="input text-sm !w-auto"><option value="">All PMs</option>${pms.map((p) => `<option${p === st.pmFilter ? " selected" : ""}>${esc(p)}</option>`).join("")}</select>
        <span class="text-sm text-white/55">Margin color: under 10% red, under 20% amber.</span>
      </div>
      <section class="card overflow-hidden mb-3"><div class="overflow-x-auto"><table class="mg-table">
        <thead><tr><th>Finished in</th>${shownPms.map((p) => `<th>${esc(p)}</th>`).join("")}<th>All PMs</th></tr></thead>
        <tbody>${months.map((m) => `<tr><th scope="row">${mname(m)}</th>${shownPms.map((p) => cell(rows.filter((r) => r.month === m && r.pm === p), p, m)).join("")}${cell(rows.filter((r) => r.month === m), null, m)}</tr>`).join("")}
          <tr class="mg-total"><th scope="row">All months</th>${shownPms.map((p) => cell(rows.filter((r) => r.pm === p), p, null)).join("")}${cell(rows, null, null)}</tr></tbody>
      </table></div></section>
      <section class="card overflow-hidden">
        <div class="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-black/5">
          <div class="font-extrabold text-ink-900 flex-1">${esc([st.sel.pm, st.sel.month ? mname(st.sel.month) : null].filter(Boolean).join(" · ") || "All finished jobs")} <span class="text-sm font-normal text-black/50">${selRows.length} jobs</span></div>
          <button type="button" class="pd-btn" id="mgExport">Export to Excel</button>
        </div>
        <div class="overflow-x-auto"><table class="mg-jobs"><thead><tr><th>Job</th><th>PM</th><th>Finished</th><th class="r">Revenue</th><th class="r">Cost</th><th class="r">Profit</th><th class="r">Margin</th><th class="r">Planned</th></tr></thead>
        <tbody>${selRows.slice(0, 500).map((r) => `<tr>
          <td><a class="font-semibold text-ink-900 hover:underline" href="${projectLink(r.id, "financials")}">${esc(r.name)}</a>${new Date(r.completed) > recent ? ` <span class="text-[10px] font-bold text-amber-700" title="Finished in the last 45 days: bills for it may still be coming in">costs may still come in</span>` : ""}</td>
          <td>${esc(r.pm)}</td><td title="${esc(r.completed_source || "")}">${day(r.completed)}</td>
          <td class="r">${money0(r.revenue)}</td><td class="r">${money0(r.cost)}</td><td class="r">${money0(r.profit)}</td>
          <td class="r font-bold ${tone(r.margin)}">${r.margin == null ? "—" : `${r.margin.toFixed(1)}%`}</td><td class="r text-black/55">${r.planned_margin == null ? "—" : `${r.planned_margin.toFixed(1)}%`}</td></tr>`).join("")}</tbody></table></div>
      </section>`;
    root.querySelector("#mgMonths").addEventListener("change", (e) => { st.months = +e.target.value; root.querySelector(".mg-table").style.opacity = .5; load(); });
    root.querySelector("#mgPm").addEventListener("change", (e) => { st.pmFilter = e.target.value; st.sel = { pm: null, month: null }; render(); });
    root.querySelectorAll(".mg-btn").forEach((b) => b.addEventListener("click", () => {
      st.sel = { pm: b.dataset.pm || null, month: b.dataset.month || null }; render();
      root.querySelector(".mg-jobs")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }));
    root.querySelector("#mgExport").addEventListener("click", async () => {
      const ids = selRows.map((r) => r.id);
      if (!ids.length) return;
      try { await exportFinancialRows(ids, [st.sel.pm, st.sel.month ? `finished ${st.sel.month}` : null].filter(Boolean).join(", ") || `finished, last ${st.months} months`); }
      catch (e) { alert(`The export failed: ${e?.message || e}`); }
    });
  }
  const tile = (label, value, caption, bad) => `<div class="card p-4 su-kpi !cursor-default"><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">${label}</div><div class="text-2xl font-extrabold tabular-nums ${bad ? "text-rose-700" : ""}">${value}</div><div class="text-xs text-black/50">${caption}</div></div>`;

  load();
}
