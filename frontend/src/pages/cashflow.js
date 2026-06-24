import { api } from "../api.js";
import { setShell } from "../shell.js";
import { fmtMoney } from "../utils/format.js";

export async function cashflowPage(routeFn) {
  let mode = "forecast"; // "forecast" | "actuals"

  const bodyHtml = `
    <div class="card p-5 mb-4">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div class="flex items-center gap-2">
            <button id="cfModeForecast" class="px-3 py-1.5 rounded-xl text-sm font-bold border border-black/15">Forecast</button>
            <button id="cfModeActuals" class="px-3 py-1.5 rounded-xl text-sm font-bold border border-black/15">Actuals</button>
          </div>
          <div id="cfModeDesc" class="text-sm text-black/60 mt-2"></div>
          <label id="cfProjectedWrap" class="mt-2 inline-flex items-center gap-2 text-sm text-black/70 cursor-pointer">
            <input type="checkbox" id="cfProjected" class="h-4 w-4 rounded border-black/25" />
            Include projected / TBD invoices <span class="text-black/40">(un-invoiced balance on active projects)</span>
          </label>
        </div>
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <div class="label mb-1">Opening cash balance</div>
            <input id="cfOpening" type="number" step="1000" class="input" style="width:170px" placeholder="0" />
            <div id="cfBalSource" class="text-[10px] text-black/40 mt-0.5"></div>
          </div>
          <div>
            <div class="label mb-1">Start week ending</div>
            <input id="cfStart" type="date" class="input" style="width:165px" />
          </div>
          <div id="cfWeeksWrap" class="hidden">
            <div class="label mb-1"># weeks</div>
            <input id="cfWeeks" type="number" min="1" max="52" step="1" class="input" style="width:90px" value="13" />
          </div>
          <button id="cfGenerate" class="btn-primary">Generate</button>
          <button id="cfCategories" class="px-3 py-2 rounded-xl text-sm font-semibold border border-black/15 hover:bg-black/5">Categories</button>
        </div>
      </div>
      <div id="cfHint" class="text-[11px] text-black/40 mt-2"></div>
    </div>

    <div id="cfCatModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 flex flex-col" style="width:100%;max-width:44rem;max-height:85vh;overflow:hidden;">
        <div class="flex items-center justify-between mb-1">
          <div class="text-lg font-extrabold">Expense Categories</div>
          <button id="cfCatClose" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>
        <div class="text-xs text-black/50 mb-3">Toggle <span class="font-semibold">Exclude</span> for accounts that aren't true operating spend (bank transfers, credit-card payments, loan principal). Excluded accounts won't count in Actuals cash-out. 12-month totals shown for context.</div>
        <div id="cfCatList" class="divide-y divide-black/5 border-y border-black/10" style="flex:1 1 auto;min-height:0;overflow-y:auto;"></div>
        <div class="flex items-center justify-between gap-2 pt-3">
          <button id="cfCatSuggest" type="button" class="text-sm font-semibold text-brand-700 hover:underline">Apply suggested exclusions</button>
          <div class="flex gap-2">
            <button id="cfCatCancel" type="button" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Cancel</button>
            <button id="cfCatSave" type="button" class="btn-primary">Save</button>
          </div>
        </div>
        <div id="cfCatMsg" class="text-sm text-red-700 min-h-[1.25rem]"></div>
      </div>
    </div>

    <div id="cfKpis" class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4"></div>

    <div class="card p-0 overflow-hidden">
      <div class="overflow-x-auto">
        <div id="cfGrid" class="p-4 text-sm text-black/50">Loading…</div>
      </div>
    </div>
  `;

  setShell({ title: "", subtitle: "", bodyHtml, showLogout: true, routeFn });

  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => { if (pageTitleBlock) pageTitleBlock.style.display = ""; }, { once: true });
  }

  const openingEl = document.getElementById("cfOpening");
  const startEl = document.getElementById("cfStart");
  const weeksEl = document.getElementById("cfWeeks");
  const weeksWrap = document.getElementById("cfWeeksWrap");
  const grid = document.getElementById("cfGrid");
  const kpis = document.getElementById("cfKpis");
  const modeDesc = document.getElementById("cfModeDesc");
  const hint = document.getElementById("cfHint");
  const btnForecast = document.getElementById("cfModeForecast");
  const btnActuals = document.getElementById("cfModeActuals");
  const projectedEl = document.getElementById("cfProjected");
  const projectedWrap = document.getElementById("cfProjectedWrap");

  // ---- formatting helpers ----
  const cell = (n) => {
    const v = Math.round(Number(n) || 0);
    if (v === 0) return `<span class="text-black/20">–</span>`;
    const s = Math.abs(v).toLocaleString("en-US");
    return v < 0 ? `<span class="text-red-600">(${s})</span>` : s;
  };
  const STICKY = "position:sticky;left:0;z-index:1;";
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const numCells = (arr, extraCls = "") =>
    arr.map(v => `<td class="px-2 py-1 text-right whitespace-nowrap ${extraCls}" style="font-variant-numeric:tabular-nums">${cell(v)}</td>`).join("");

  function dataRow(label, values, opts = {}) {
    const { bold = false, bg = "#ffffff", indent = false, toggleGroup = null } = opts;
    const chevron = toggleGroup ? `<button data-toggle="${toggleGroup}" class="mr-1 text-black/40 hover:text-black" style="font-size:11px">▸</button>` : "";
    const pad = indent ? "padding-left:1.75rem" : "padding-left:0.75rem";
    return `<tr>
        <td class="py-1 pr-3 ${bold ? "font-bold" : ""} whitespace-nowrap" style="${STICKY}background:${bg};${pad}">${chevron}${escapeHtml(label)}</td>
        ${numCells(values, bold ? "font-semibold" : "")}
      </tr>`;
  }

  const detailRows = (rows, group, bg = "#ffffff") => rows.map(r => `
      <tr class="cf-detail" data-group="${group}" style="display:none">
        <td class="py-1 pr-3 text-black/60 whitespace-nowrap" style="${STICKY}background:${bg};padding-left:2.5rem">${escapeHtml(r.label)}</td>
        ${numCells(r.weekly, "text-black/60")}
      </tr>`).join("");

  const sectionHeader = (text2, cols) => `<tr><td colspan="${1 + cols}" class="pt-3 pb-1 font-bold text-brand-700" style="${STICKY}background:#fff;padding-left:0.75rem">${text2}</td></tr>`;

  function render(d) {
    const weekCols = d.week_ends.map((w, i) => {
      const [, m, day] = w.split("-");
      return `<th class="px-2 py-2 text-right whitespace-nowrap font-semibold"><div>${m}/${day}</div><div class="text-[10px] font-normal text-black/40">Wk ${i + 1}</div></th>`;
    }).join("");

    const outSections = d.outflow.sections.map((s, i) =>
      dataRow(s.label, s.weekly_totals, { toggleGroup: `out${i}`, indent: true }) +
      detailRows(s.rows, `out${i}`)
    ).join("");

    grid.innerHTML = `
      <table class="text-sm" style="border-collapse:separate;border-spacing:0;min-width:${260 + d.weeks * 70}px">
        <thead>
          <tr class="border-b border-black/10 text-black/60">
            <th class="py-2 pr-3 text-left whitespace-nowrap" style="${STICKY}background:#fff">Week ending →</th>
            ${weekCols}
          </tr>
        </thead>
        <tbody>
          ${dataRow("Opening Cash Balance", d.summary.opening, { bold: true, bg: "#f8fafc" })}

          ${sectionHeader(d.inflow.label.toUpperCase() + (d.inflow.sublabel ? ` <span class="font-normal text-black/40 text-xs">(${d.inflow.sublabel})</span>` : ""), d.weeks)}
          ${dataRow(d.inflow.label, d.inflow.weekly_totals, { bold: true, toggleGroup: "inflow", bg: "#f4f7f5" })}
          ${detailRows(d.inflow.rows, "inflow", "#fbfdfb")}
          ${(d.inflow.projected?.sections || []).map((s, i) =>
            dataRow(s.label, s.weekly_totals, { toggleGroup: `proj${i}`, indent: true, bg: "#f4f7f5" }) +
            detailRows(s.rows, `proj${i}`)
          ).join("")}

          ${sectionHeader(d.outflow.label.toUpperCase(), d.weeks)}
          ${dataRow(d.outflow.label, d.outflow.weekly_totals, { bold: true, bg: "#fff7f7" })}
          ${outSections}

          <tr><td colspan="${1 + d.weeks}" class="pt-2"></td></tr>
          ${dataRow("Total Surplus / (Deficit)", d.summary.surplus, { bold: true, bg: "#f8fafc" })}
          ${dataRow("Ending Cash Balance", d.summary.ending, { bold: true, bg: "#eef2ff" })}
        </tbody>
      </table>
    `;

    grid.querySelectorAll("[data-toggle]").forEach(btn => {
      btn.addEventListener("click", () => {
        const g = btn.getAttribute("data-toggle");
        const open = btn.textContent.trim() === "▾";
        btn.textContent = open ? "▸" : "▾";
        grid.querySelectorAll(`.cf-detail[data-group="${g}"]`).forEach(r => { r.style.display = open ? "none" : "table-row"; });
      });
    });
  }

  function renderKpis(d) {
    const minEnding = Math.min(...d.summary.ending);
    const minIdx = d.summary.ending.indexOf(minEnding);
    const inLabel = d.mode === "actuals" ? "Total collected" : "Total inflow";
    const outLabel = d.mode === "actuals" ? "Total paid out" : "Total outflow";
    const card = (label, value, sub, danger = false) => `
      <div class="card p-4">
        <div class="text-xs text-black/50 font-semibold">${label}</div>
        <div class="text-xl font-extrabold ${danger ? "text-red-600" : ""}">${value}</div>
        <div class="text-[11px] text-black/40">${sub}</div>
      </div>`;
    kpis.innerHTML =
      card(`Ending balance (Wk ${d.weeks})`, fmtMoney(d.summary.ending[d.weeks - 1]), `as of ${d.week_ends[d.weeks - 1]}`, d.summary.ending[d.weeks - 1] < 0) +
      card("Lowest cash point", fmtMoney(minEnding), `week ${minIdx + 1} (${d.week_ends[minIdx]})`, minEnding < 0) +
      card(`${inLabel} (${d.weeks} wk)`, fmtMoney(d.inflow.grand_total), d.inflow.sublabel || "") +
      card(`${outLabel} (${d.weeks} wk)`, fmtMoney(d.outflow.grand_total), "");
  }

  function applyModeUi() {
    const active = "bg-ink-900 text-white border-ink-900";
    btnForecast.className = `px-3 py-1.5 rounded-xl text-sm font-bold border ${mode === "forecast" ? active : "border-black/15"}`;
    btnActuals.className = `px-3 py-1.5 rounded-xl text-sm font-bold border ${mode === "actuals" ? active : "border-black/15"}`;
    weeksWrap.classList.toggle("hidden", mode !== "actuals");
    projectedWrap.classList.toggle("hidden", mode !== "forecast");
    if (mode === "forecast") {
      modeDesc.textContent = "Forward 13 weeks — open invoices in, open bills + recurring run-rates out.";
      hint.textContent = "Opening balance is manual for now; it will auto-seed from your QuickBooks bank balance once account sync is added.";
    } else {
      modeDesc.textContent = "Historical realized cash — actual customer payments in, actual bill payments + card/check spend out.";
      hint.textContent = "Note: “Direct expenses” currently includes some bank transfers / credit-card payments that aren't true operating spend — tell me which accounts to exclude and I'll refine it.";
    }
  }

  async function load() {
    grid.innerHTML = `<div class="p-4 text-sm text-black/50">Loading…</div>`;
    const params = new URLSearchParams();
    const ob = parseFloat(openingEl.value);
    if (!Number.isNaN(ob)) params.set("opening_balance", String(ob));
    if (startEl.value) params.set("start_date", startEl.value);
    if (mode === "actuals") params.set("weeks", String(parseInt(weeksEl.value, 10) || 13));
    if (mode === "forecast" && projectedEl.checked) params.set("projected", "1");
    const endpoint = mode === "actuals" ? "actuals" : "forecast";
    try {
      const d = await api(`/cashflow/${endpoint}?${params.toString()}`);
      renderKpis(d);
      render(d);
    } catch (e) {
      kpis.innerHTML = "";
      grid.innerHTML = `<div class="p-4 text-sm text-red-700">Failed to load: ${escapeHtml(e.message || e)}</div>`;
    }
  }

  function setMode(m) {
    if (mode === m) return;
    mode = m;
    startEl.value = ""; // reset to mode-appropriate default
    applyModeUi();
    load();
  }

  btnForecast.addEventListener("click", () => setMode("forecast"));
  btnActuals.addEventListener("click", () => setMode("actuals"));
  document.getElementById("cfGenerate").addEventListener("click", load);
  projectedEl.addEventListener("change", load);

  // ---- Categories modal ----
  const catModal = document.getElementById("cfCatModal");
  const catList = document.getElementById("cfCatList");
  const catMsg = document.getElementById("cfCatMsg");
  const openCat = () => { catModal.classList.remove("hidden"); catModal.classList.add("flex"); };
  const closeCat = () => { catModal.classList.add("hidden"); catModal.classList.remove("flex"); };

  catModal.addEventListener("click", (e) => { if (e.target === catModal) closeCat(); });
  document.getElementById("cfCatClose").addEventListener("click", closeCat);
  document.getElementById("cfCatCancel").addEventListener("click", closeCat);

  async function openCategories() {
    catMsg.textContent = "";
    catList.innerHTML = `<div class="py-4 text-sm text-black/40">Loading…</div>`;
    openCat();
    try {
      const { categories } = await api("/cashflow/categories");
      const badge = (c) => {
        if (c.suggested_exclude) return `<span class="ml-2 inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-700">Suggested${c.classification ? " · " + escapeHtml(c.classification) : ""}</span>`;
        if (c.classification === "Expense") return `<span class="ml-2 inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-bold bg-emerald-50 text-emerald-700">Operating</span>`;
        return "";
      };
      catList.innerHTML = categories.map(c => `
        <label class="flex items-center justify-between gap-3 py-2 cursor-pointer">
          <div class="min-w-0">
            <div class="text-sm font-semibold text-ink-900 truncate">${escapeHtml(c.category)}${badge(c)}</div>
            <div class="text-[11px] text-black/40">12-mo: ${fmtMoney(c.total_12mo)} · ${c.line_ct} txns</div>
          </div>
          <span class="flex items-center gap-2 shrink-0 text-xs font-semibold text-black/60">
            Exclude
            <input type="checkbox" class="h-4 w-4 rounded border-black/20" data-cat="${escapeHtml(c.category)}" data-suggested="${c.suggested_exclude ? "1" : "0"}" ${c.excluded ? "checked" : ""} />
          </span>
        </label>`).join("") || `<div class="py-4 text-sm text-black/40">No expense categories found.</div>`;
    } catch (e) {
      catList.innerHTML = `<div class="py-4 text-sm text-red-700">Failed to load categories: ${escapeHtml(e.message || e)}</div>`;
    }
  }

  document.getElementById("cfCategories").addEventListener("click", openCategories);

  document.getElementById("cfCatSuggest").addEventListener("click", () => {
    catList.querySelectorAll('input[data-suggested="1"]').forEach(i => { i.checked = true; });
  });

  document.getElementById("cfCatSave").addEventListener("click", async () => {
    catMsg.textContent = "";
    const excluded = Array.from(catList.querySelectorAll("input[data-cat]:checked")).map(i => i.getAttribute("data-cat"));
    try {
      await api("/cashflow/categories", { method: "PUT", body: JSON.stringify({ excluded }) });
      closeCat();
      load(); // re-render with the new exclusions applied
    } catch (e) {
      catMsg.textContent = "Failed to save: " + (e.message || e);
    }
  });

  // Auto-fill the opening balance from QuickBooks bank accounts (if synced).
  const balSource = document.getElementById("cfBalSource");
  try {
    const ob = await api("/cashflow/opening-balance");
    if (ob.available) {
      if (!openingEl.value) openingEl.value = Math.round(ob.balance);
      const names = ob.accounts.map(a => a.name).join(", ");
      balSource.textContent = `Auto-filled from QuickBooks (${names}). Edit to override.`;
    } else {
      balSource.textContent = "Sync the chart of accounts to auto-fill from your bank balance.";
    }
  } catch (e) { /* leave manual */ }

  applyModeUi();
  load();
}
