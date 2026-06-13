import { api } from "../api.js";
import { setShell } from "../shell.js";
import { fmtMoney } from "../utils/format.js";

export async function cashflowPage(routeFn) {
  const bodyHtml = `
    <div class="card p-5 mb-4">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div class="text-lg font-extrabold">13-Week Cash Flow Forecast</div>
          <div class="text-sm text-black/60">Generated from QuickBooks — open invoices in, open bills + recurring run-rates out.</div>
        </div>
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <div class="label mb-1">Opening cash balance</div>
            <input id="cfOpening" type="number" step="1000" class="input" style="width:180px" placeholder="0" />
          </div>
          <div>
            <div class="label mb-1">Start week ending</div>
            <input id="cfStart" type="date" class="input" style="width:170px" />
          </div>
          <button id="cfGenerate" class="btn-primary">Generate</button>
        </div>
      </div>
      <div class="text-[11px] text-black/40 mt-2">Opening balance is manual for now; it will auto-seed from your QuickBooks bank balance once account sync is added.</div>
    </div>

    <div id="cfKpis" class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4"></div>

    <div class="card p-0 overflow-hidden">
      <div id="cfGridWrap" class="overflow-x-auto">
        <div id="cfGrid" class="p-4 text-sm text-black/50">Loading…</div>
      </div>
    </div>
  `;

  setShell({ title: "", subtitle: "", bodyHtml, showLogout: true, routeFn });

  // Hide the empty page-title block (same pattern as Users page)
  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => {
      if (pageTitleBlock) pageTitleBlock.style.display = "";
    }, { once: true });
  }

  const openingEl = document.getElementById("cfOpening");
  const startEl = document.getElementById("cfStart");
  const grid = document.getElementById("cfGrid");
  const kpis = document.getElementById("cfKpis");

  // ---- formatting helpers ----
  const cell = (n) => {
    const v = Math.round(Number(n) || 0);
    if (v === 0) return `<span class="text-black/20">–</span>`;
    const s = Math.abs(v).toLocaleString("en-US");
    return v < 0 ? `<span class="text-red-600">(${s})</span>` : s;
  };
  const STICKY = "position:sticky;left:0;z-index:1;";

  function numCells(arr, extraCls = "") {
    return arr.map(v => `<td class="px-2 py-1 text-right whitespace-nowrap ${extraCls}" style="font-variant-numeric:tabular-nums">${cell(v)}</td>`).join("");
  }

  function dataRow(label, values, opts = {}) {
    const { bold = false, bg = "#ffffff", indent = false, toggleGroup = null } = opts;
    const labelCls = bold ? "font-bold" : "";
    const chevron = toggleGroup
      ? `<button data-toggle="${toggleGroup}" class="mr-1 text-black/40 hover:text-black" style="font-size:11px">▸</button>`
      : "";
    const padLeft = indent ? "padding-left:1.75rem" : "padding-left:0.75rem";
    return `
      <tr data-group-of="${toggleGroup || ""}">
        <td class="py-1 pr-3 ${labelCls} whitespace-nowrap" style="${STICKY}background:${bg};${padLeft}">${chevron}${label}</td>
        ${numCells(values, bold ? "font-semibold" : "")}
      </tr>`;
  }

  function detailRows(rows, group, bg = "#ffffff") {
    return rows.map(r => `
      <tr class="cf-detail" data-group="${group}" style="display:none">
        <td class="py-1 pr-3 text-black/60 whitespace-nowrap" style="${STICKY}background:${bg};padding-left:2.5rem">${escapeHtml(r.label)}</td>
        ${numCells(r.weekly, "text-black/60")}
      </tr>`).join("");
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function render(d) {
    const weeks = d.week_ends.map((w, i) => {
      const [y, m, day] = w.split("-");
      return `<th class="px-2 py-2 text-right whitespace-nowrap font-semibold">
        <div>${m}/${day}</div><div class="text-[10px] font-normal text-black/40">Wk ${i + 1}</div></th>`;
    }).join("");

    grid.innerHTML = `
      <table class="text-sm" style="border-collapse:separate;border-spacing:0;min-width:1100px">
        <thead>
          <tr class="border-b border-black/10 text-black/60">
            <th class="py-2 pr-3 text-left whitespace-nowrap" style="${STICKY}background:#fff">Week ending →</th>
            ${weeks}
          </tr>
        </thead>
        <tbody>
          ${dataRow("Opening Cash Balance", d.summary.opening, { bold: true, bg: "#f8fafc" })}

          <tr><td colspan="14" class="pt-3 pb-1 font-bold text-brand-700" style="${STICKY}background:#fff;padding-left:0.75rem">CASH INFLOW</td></tr>
          ${dataRow(`Cash Inflow`, d.inflow.weekly_totals, { bold: true, toggleGroup: "inflow", bg: "#f4f7f5" })}
          ${detailRows(d.inflow.rows, "inflow", "#fbfdfb")}

          <tr><td colspan="14" class="pt-3 pb-1 font-bold text-brand-700" style="${STICKY}background:#fff;padding-left:0.75rem">CASH OUTFLOW</td></tr>
          ${dataRow(`Cash Outflow`, d.outflow.weekly_totals, { bold: true, bg: "#fff7f7" })}
          ${dataRow(`A/P — open bills`, d.outflow.ap.weekly_totals, { toggleGroup: "ap", indent: true })}
          ${detailRows(d.outflow.ap.rows, "ap", "#fff")}
          ${dataRow(`Recurring (run-rate)`, d.outflow.recurring.weekly_totals, { toggleGroup: "recurring", indent: true })}
          ${detailRows(d.outflow.recurring.rows, "recurring", "#fff")}

          <tr><td colspan="14" class="pt-2"></td></tr>
          ${dataRow("Total Surplus / (Deficit)", d.summary.surplus, { bold: true, bg: "#f8fafc" })}
          ${dataRow("Ending Cash Balance", d.summary.ending, { bold: true, bg: "#eef2ff" })}
        </tbody>
      </table>
    `;

    // toggle handlers
    grid.querySelectorAll("[data-toggle]").forEach(btn => {
      btn.addEventListener("click", () => {
        const g = btn.getAttribute("data-toggle");
        const open = btn.textContent.trim() === "▾";
        btn.textContent = open ? "▸" : "▾";
        grid.querySelectorAll(`.cf-detail[data-group="${g}"]`).forEach(r => {
          r.style.display = open ? "none" : "table-row";
        });
      });
    });
  }

  function renderKpis(d) {
    const minEnding = Math.min(...d.summary.ending);
    const minIdx = d.summary.ending.indexOf(minEnding);
    const card = (label, value, sub, danger = false) => `
      <div class="card p-4">
        <div class="text-xs text-black/50 font-semibold">${label}</div>
        <div class="text-xl font-extrabold ${danger ? "text-red-600" : ""}">${value}</div>
        <div class="text-[11px] text-black/40">${sub}</div>
      </div>`;
    kpis.innerHTML =
      card("Ending balance (Wk 13)", fmtMoney(d.summary.ending[d.weeks - 1]), `as of ${d.week_ends[d.weeks - 1]}`, d.summary.ending[d.weeks - 1] < 0) +
      card("Lowest cash point", fmtMoney(minEnding), `week ${minIdx + 1} (${d.week_ends[minIdx]})`, minEnding < 0) +
      card("Total inflow (13 wk)", fmtMoney(d.inflow.grand_total), "open invoices by due date") +
      card("Total outflow (13 wk)", fmtMoney(d.outflow.grand_total), "bills + recurring run-rate");
  }

  async function load() {
    grid.innerHTML = `<div class="p-4 text-sm text-black/50">Loading…</div>`;
    const params = new URLSearchParams();
    const ob = parseFloat(openingEl.value);
    if (!Number.isNaN(ob)) params.set("opening_balance", String(ob));
    if (startEl.value) params.set("start_date", startEl.value);
    try {
      const d = await api(`/cashflow/forecast?${params.toString()}`);
      renderKpis(d);
      render(d);
    } catch (e) {
      kpis.innerHTML = "";
      grid.innerHTML = `<div class="p-4 text-sm text-red-700">Failed to load forecast: ${escapeHtml(e.message || e)}</div>`;
    }
  }

  document.getElementById("cfGenerate").addEventListener("click", load);
  load();
}
