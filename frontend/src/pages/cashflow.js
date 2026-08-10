import { api } from "../api.js";
import { setShell } from "../shell.js";
import { fmtMoney } from "../utils/format.js";

export async function cashflowPage(routeFn) {
  let mode = "forecast_v2"; // "forecast_v2" | "forecast" | "actuals"

  const bodyHtml = `
    <div class="card px-4 py-3 mb-4">
      <div class="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div class="flex items-center gap-1.5">
          <button id="cfModeV2" class="px-3 py-1.5 rounded-xl text-sm font-bold border border-black/15">Forecast+</button>
          <button id="cfModeForecast" class="px-3 py-1.5 rounded-xl text-sm font-bold border border-black/15">Forecast (old)</button>
          <button id="cfModeActuals" class="px-3 py-1.5 rounded-xl text-sm font-bold border border-black/15">Actuals</button>
        </div>
        <div>
          <div class="label mb-0.5">Opening cash balance</div>
          <input id="cfOpening" type="number" step="1000" class="input py-1.5" style="width:150px" placeholder="0" />
        </div>
        <div>
          <div class="label mb-0.5">Start week ending</div>
          <input id="cfStart" type="date" class="input py-1.5" style="width:155px" />
        </div>
        <div id="cfWeeksWrap" class="hidden">
          <div class="label mb-0.5"># weeks</div>
          <input id="cfWeeks" type="number" min="1" max="520" step="1" class="input py-1.5" style="width:78px" value="13" />
        </div>
        <div id="cfHorizon" class="hidden">
          <div class="label mb-0.5">Horizon</div>
          <div class="flex items-center gap-1">
            <button data-wk="13" class="cf-wk px-2 py-1.5 rounded-lg text-xs font-bold border border-black/15">13</button>
            <button data-wk="26" class="cf-wk px-2 py-1.5 rounded-lg text-xs font-bold border border-black/15">26</button>
            <button data-wk="52" class="cf-wk px-2 py-1.5 rounded-lg text-xs font-bold border border-black/15">52</button>
            <input id="cfHorizonWeeks" type="number" min="4" max="520" step="1" class="input py-1.5 ml-1" style="width:74px" value="26" title="Weeks to forecast (no cap)" />
            <span class="text-[11px] text-black/40">wks</span>
          </div>
        </div>
        <button id="cfGenerate" class="btn-primary py-2">Generate</button>
        <button id="cfCategories" class="px-3 py-2 rounded-xl text-sm font-semibold border border-black/15 hover:bg-black/5">Categories</button>
        <button id="cfOverhead" class="hidden px-3 py-2 rounded-xl text-sm font-semibold border border-black/15 hover:bg-black/5">Overhead</button>
        <button id="cfInfo" type="button" title="How this page works" class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-black/15 text-black/55 hover:bg-black/5">
          <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5" stroke-linecap="round"/><circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none"/></svg>
        </button>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-x-4 mt-1.5">
        <div id="cfModeDesc" class="text-xs text-black/55"></div>
        <div id="cfBalSource" class="text-[10px] text-black/40"></div>
      </div>
    </div>

    <div id="cfCatModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 flex flex-col" style="width:100%;max-width:44rem;max-height:85vh;overflow:hidden;">
        <div class="flex items-center justify-between mb-1">
          <div class="text-lg font-extrabold">Expense Categories</div>
          <button id="cfCatClose" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>
        <div class="text-xs text-black/50 mb-3">Toggle <span class="font-semibold">Exclude</span> for accounts that aren't true operating spend (bank transfers, credit-card payments, loan principal). Excluded accounts are dropped from <span class="font-semibold">Actuals cash-out</span> and the <span class="font-semibold">forecast job-cost run-rate</span>. Everything is included by default — you only mark exclusions. 12-month totals shown for context.</div>
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

    <div id="cfInfoModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 flex flex-col" style="width:100%;max-width:42rem;max-height:85vh;overflow:hidden;">
        <div class="flex items-center justify-between mb-3">
          <div class="text-lg font-extrabold">How the Cash Flow page works</div>
          <button id="cfInfoClose" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>
        <div class="text-sm text-black/70 space-y-3 overflow-y-auto pr-1" style="min-height:0;">
          <p>Three views, switched at the top left:</p>
          <div>
            <div class="font-bold text-ink-900">🚀 Forecast+ — the new schedule-driven forecast</div>
            <p class="text-black/60">Starts from your real QuickBooks bank balance and rolls forward week by week, as far out as you set the horizon (no 13-week cap).</p>
            <ul class="list-disc ml-5 mt-1 space-y-1 text-black/60">
              <li><span class="font-semibold text-ink-900">Committed</span>: open invoices coming in and open bills going out, on their due dates.</li>
              <li><span class="font-semibold text-ink-900">Recurring</span>: an overhead &amp; payroll run-rate going out.</li>
              <li><span class="font-semibold text-ink-900">Scheduled</span>: the invoice, crew, and expense plans from every project's Billing &amp; Schedule tab — so this forecast is the sum of all those tabs. Edit a project's schedule and it flows up here.</li>
              <li><span class="font-semibold text-ink-900">Committed, not yet scheduled</span>: cash on won projects that don't have start dates yet is held in a backlog line, out of the weekly balance, until the dates are set.</li>
            </ul>
            <p class="text-black/50 mt-1">The scheduled layer is cached (it reads every project); <span class="font-semibold">↻ Refresh schedules</span> recomputes it after edits.</p>
          </div>
          <div>
            <div class="font-bold text-ink-900">📈 Forecast (old) — the next 13 weeks</div>
            <p class="text-black/60">A forward look at your cash position week by week. Each week opens at the prior week's ending balance, then adds inflow and subtracts outflow.</p>
            <ul class="list-disc ml-5 mt-1 space-y-1 text-black/60">
              <li><span class="font-semibold text-ink-900">Committed</span> (always counted): open invoices coming in by their due date; open bills plus an overhead &amp; payroll run-rate going out.</li>
              <li><span class="font-semibold text-ink-900">Projected</span> (each row has a checkbox to include or exclude): un-invoiced balance on active projects + awarded-but-not-started estimates coming in; a job-cost run-rate (contractor + materials) going out. Use these to see the realistic picture vs. just what's booked today.</li>
              <li><span class="font-semibold text-ink-900">Beyond 13 wk</span> column: amounts dated past the 13-week window (e.g. awarded work further out). Informational — it isn't part of the week-13 ending balance.</li>
            </ul>
          </div>
          <div>
            <div class="font-bold text-ink-900">📒 Actuals — what really happened</div>
            <p class="text-black/60">Historical realized cash for a date range you choose: actual customer payments received in, actual bill payments + card/check spend out.</p>
          </div>
          <div>
            <div class="font-bold text-ink-900">Opening balance</div>
            <p class="text-black/60">Auto-fills from your QuickBooks bank balance (editable). It seeds week 1.</p>
          </div>
          <div>
            <div class="font-bold text-ink-900">Categories</div>
            <p class="text-black/60">Classifies which accounts are true operating spend. Everything counts by default; you exclude non-operating items (bank transfers, credit-card payments, loan principal). Exclusions apply to Actuals cash-out and the forecast job-cost run-rate.</p>
          </div>
          <p class="text-[12px] text-black/45">All figures come from QuickBooks. Run a sync on the QuickBooks page to refresh invoices, bills, payments and bank balances. The projected job-cost run-rate is an interim estimate — it'll be replaced by scheduled crew payments once the contractor payment schedule is built.</p>
        </div>
      </div>
    </div>

    <div id="cfBacklogModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 flex flex-col" style="width:100%;max-width:56rem;max-height:85vh;overflow:hidden;">
        <div class="flex items-center justify-between mb-1">
          <div class="text-lg font-extrabold">Committed, not yet scheduled</div>
          <button id="cfBacklogClose" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>
        <div class="text-xs text-black/50 mb-3">Won projects with a contract but no start dates yet — so their cash isn't on the weekly grid. This is what would flow in and out <span class="font-semibold">if they all got scheduled</span>. Already-paid deposits are in your bank balance; sent invoices (A/R) are already on the forecast by their due date.</div>
        <div id="cfBacklogSummary" class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3"></div>
        <div id="cfBacklogBody" class="overflow-y-auto" style="flex:1 1 auto;min-height:0;"></div>
      </div>
    </div>

    <div id="cfOverheadModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 flex flex-col" style="width:100%;max-width:56rem;max-height:85vh;overflow:hidden;">
        <div class="flex items-center justify-between mb-1">
          <div class="text-lg font-extrabold">Recurring overhead</div>
          <button id="cfOverheadClose" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>
        <div class="text-xs text-black/50 mb-3">The recurring cash going out — rent, insurance, payroll, loan payments. Each item lands in the forecast by its cadence from the reference date. Seeded from your trailing spend; edit into real items. Changes show in the forecast right away.</div>
        <div id="cfOverheadBody" class="overflow-y-auto" style="flex:1 1 auto;min-height:0;">Loading…</div>
        <div class="flex items-center justify-between gap-2 pt-3 border-t border-black/10 mt-2">
          <button id="cfOverheadAdd" class="text-sm font-semibold text-brand-700 hover:underline">+ Add item</button>
          <button id="cfOverheadDone" class="btn-primary">Done</button>
        </div>
      </div>
    </div>

    <div id="cfKpis" class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4"></div>

    <div class="card p-0 overflow-hidden">
      <div class="overflow-x-auto">
        <div id="cfGrid" class="p-4 text-sm text-black/50">Loading…</div>
      </div>
    </div>

    <div id="cfCards" class="mt-4"></div>
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
  const btnV2 = document.getElementById("cfModeV2");
  const btnForecast = document.getElementById("cfModeForecast");
  const btnActuals = document.getElementById("cfModeActuals");
  const horizonWrap = document.getElementById("cfHorizon");
  const horizonWeeks = document.getElementById("cfHorizonWeeks");

  // forecast projected-layer toggles (row-level checkboxes drive these)
  const proj = { inc_active: true, inc_awarded: true, inc_jobcost: true };
  let lastBacklog = null; // most recent Forecast+ backlog, for the drill-down modal

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

  // collapse/expand chevrons shared by both renderers
  function wireToggles() {
    grid.querySelectorAll("[data-toggle]").forEach(btn => {
      btn.addEventListener("click", () => {
        const g = btn.getAttribute("data-toggle");
        const open = btn.textContent.trim() === "▾";
        btn.textContent = open ? "▸" : "▾";
        grid.querySelectorAll(`.cf-detail[data-group="${g}"]`).forEach(r => { r.style.display = open ? "none" : "table-row"; });
      });
    });
  }

  function render(d) {
    if (d.mode === "forecast_v2") return renderForecastV2(d);
    return d.mode === "forecast" ? renderForecast(d) : renderActuals(d);
  }

  // ── Forecast+ renderer (Phase 3b: committed QBO + scheduled project layer,
  //    unbounded weekly horizon, real bank anchor, option-a backlog) ──────────
  function renderForecastV2(d) {
    // Past-due column: everything dated before the current week, in its own
    // leading column so week 1 shows only its true Sat–Fri items.
    const pd = d.past_due || { opening: d.opening_balance, ending: d.opening_balance, inflow: 0, outflow: 0, surplus: 0 };
    const hasPD = Math.abs(pd.inflow) > 0.5 || Math.abs(pd.outflow) > 0.5;
    const PD_BG = "#fbf6ea", PD_SEP = "border-right:2px solid rgba(0,0,0,.18)";
    const pdCell = (v, extraCls = "") => hasPD
      ? `<td class="px-2 py-1 text-right whitespace-nowrap ${extraCls}" style="font-variant-numeric:tabular-nums;${PD_SEP};background:${PD_BG}">${cell(v)}</td>` : "";
    const extra = hasPD ? 1 : 0;

    const pdHead = hasPD
      ? `<th class="px-2 py-2 text-right whitespace-nowrap font-semibold" style="${PD_SEP};background:${PD_BG}"><div>Past due</div><div class="text-[10px] font-normal text-black/40">overdue</div></th>` : "";
    const weekCols = d.week_ends.map((w, i) => {
      const [, m, day] = w.split("-");
      return `<th class="px-2 py-2 text-right whitespace-nowrap font-semibold"><div>${m}/${day}</div><div class="text-[10px] font-normal text-black/40">Wk ${i + 1}</div></th>`;
    }).join("");

    const rowV2 = (label, pdv, weekly, { bold = false, bg = "#ffffff" } = {}) => `<tr>
        <td class="py-1 pr-3 ${bold ? "font-bold" : ""} whitespace-nowrap" style="${STICKY}background:${bg};padding-left:0.75rem">${escapeHtml(label)}</td>
        ${pdCell(pdv, bold ? "font-semibold" : "")}${numCells(weekly, bold ? "font-semibold" : "")}</tr>`;

    // confidence tiers: how firm a section's cash is (committed QBO > scheduled
    // app plans > estimated run-rate). Shades the section row + a dot.
    const TIER = {
      committed: { dot: "bg-ink-900", bg: "#eef1f4", name: "Committed" },
      scheduled: { dot: "bg-emerald-500", bg: "#f0f8f2", name: "Scheduled" },
      estimated: { dot: "border-[1.5px] border-black/40", bg: "#f7f7f8", name: "Estimated" },
    };
    const detailV2 = (rows, group, view = "") => rows.map(r => {
      const lbl = (r.link_id && r.is_project)
        ? `<a href="#/entity/project/${escapeHtml(String(r.link_id))}" data-cf-proj class="text-blue-700 hover:underline">${escapeHtml(r.label)}</a>`
        : escapeHtml(r.label);
      return `<tr class="cf-detail" data-group="${group}"${view ? ` data-view="${view}"` : ""} style="display:none">
        <td class="py-1 pr-3 text-black/60 whitespace-nowrap" style="${STICKY}background:#fbfbfb;padding-left:2.25rem">${lbl}</td>
        ${pdCell(r.pastdue || 0, "text-black/60")}${numCells(r.weekly, "text-black/60")}</tr>`;
    }).join("");
    const secRow = (s, group) => {
      const t = TIER[s.tier] || TIER.scheduled;
      const hasRows = s.rows && s.rows.length;
      const hasAlt = s.alt_rows && s.alt_rows.length;
      const chev = (hasRows || hasAlt) ? `<button data-toggle="${group}" class="mr-1 text-black/40 hover:text-black" style="font-size:11px">▸</button>` : "";
      const dot = `<span class="inline-block w-2 h-2 rounded-full align-middle mr-1.5 ${t.dot}"></span>`;
      const vt = hasAlt ? ` <button data-view-toggle="${group}" data-va="${escapeHtml(s.view_a || "A")}" data-vb="${escapeHtml(s.view_b || "B")}" class="ml-1 align-middle text-[10px] font-bold text-blue-600 border border-blue-200 rounded px-1.5 py-0.5 hover:bg-blue-50">${escapeHtml(s.view_a || "A")} ⇄</button>` : "";
      const label = `<td class="py-1 pr-3 whitespace-nowrap" style="${STICKY}background:${t.bg};padding-left:1.5rem">${chev}${dot}${escapeHtml(s.label)}${vt}</td>`;
      const detA = hasRows ? detailV2(s.rows, group, hasAlt ? "a" : "") : "";
      const detB = hasAlt ? detailV2(s.alt_rows, group, "b") : "";
      return `<tr>${label}${pdCell(s.pastdue || 0)}${numCells(s.weekly_totals)}</tr>` + detA + detB;
    };
    const inSecs = d.inflow.sections.map((s, i) => secRow(s, `inv2_${i}`)).join("");
    const outSecs = d.outflow.sections.map((s, i) => secRow(s, `outv2_${i}`)).join("");
    const legend = ["committed", "scheduled", "estimated"].map(k =>
      `<span class="inline-flex items-center gap-1.5 text-[11px] text-black/55"><span class="inline-block w-2 h-2 rounded-full ${TIER[k].dot}"></span>${TIER[k].name}</span>`).join("");

    // freshness + backlog strip
    const c = d.cache || {};
    const stamp = c.computed_at ? new Date(c.computed_at + "Z").toLocaleString() : "never";
    const fresh = c.computing
      ? `<span class="inline-flex items-center gap-1.5 text-amber-700"><span class="cf-spin animate-spin inline-block h-3 w-3 rounded-full border-2 border-amber-500 border-t-transparent"></span>Updating scheduled cash…</span>`
      : `<span class="text-black/50">Scheduled cash as of <b class="text-black/70">${stamp}</b>${c.stale ? ` <span class="text-amber-700 font-semibold">· stale</span>` : ""}</span>`;
    const bk = d.backlog || { in: 0, out: 0 };
    lastBacklog = bk;
    const hasBk = (bk.count || 0) > 0 || (bk.in || 0) > 0.5 || (bk.out || 0) > 0.5;
    const netPos = (bk.net || 0) >= 0;
    const backlogChip = hasBk
      ? `<button data-cf-backlog class="text-left text-[12px] text-black/70 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 hover:bg-amber-100">
           <b class="text-amber-800">Committed, not yet scheduled</b> · ${bk.count || 0} project${bk.count === 1 ? "" : "s"}
           <span class="text-black/55"> — to bill ${fmtMoney(bk.in || 0)} · est. out ${fmtMoney(bk.out || 0)} · </span><b class="${netPos ? "text-emerald-700" : "text-red-600"}">net ${netPos ? "+" : ""}${fmtMoney(bk.net || 0)}</b>
           <span class="text-brand-700 font-semibold ml-1">view →</span>
         </button>`
      : "";

    grid.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-3 px-1 pb-3">
        <div class="text-[12px]">${fresh} <button data-cf-refresh class="ml-2 font-semibold text-brand-700 hover:underline">↻ Refresh schedules</button></div>
        <div class="flex items-center gap-3">${legend}</div>
        ${backlogChip}
      </div>
      <table class="text-sm" style="border-collapse:separate;border-spacing:0;min-width:${300 + (d.weeks + extra) * 68}px">
        <thead>
          <tr class="border-b border-black/10 text-black/60">
            <th class="py-2 pr-3 text-left whitespace-nowrap" style="${STICKY}background:#fff">Week ending →</th>
            ${pdHead}${weekCols}
          </tr>
        </thead>
        <tbody>
          ${rowV2("Opening Cash Balance", pd.opening, d.summary.opening, { bold: true, bg: "#f8fafc" })}

          ${sectionHeader("CASH INFLOW", d.weeks + extra)}
          ${rowV2(d.inflow.label, d.inflow.pastdue_total, d.inflow.weekly_totals, { bold: true, bg: "#f4f7f5" })}
          ${inSecs}

          ${sectionHeader("CASH OUTFLOW", d.weeks + extra)}
          ${rowV2(d.outflow.label, d.outflow.pastdue_total, d.outflow.weekly_totals, { bold: true, bg: "#fff7f7" })}
          ${outSecs}

          <tr><td colspan="${1 + extra + d.weeks}" class="pt-2"></td></tr>
          ${rowV2("Total Surplus / (Deficit)", pd.surplus, d.summary.surplus, { bold: true, bg: "#f8fafc" })}
          ${rowV2("Ending Cash Balance", pd.ending, d.summary.ending, { bold: true, bg: "#eef2ff" })}
        </tbody>
      </table>
      ${hasPD ? `<div class="text-[11px] text-black/45 mt-2 px-1">The <b>Past due</b> column holds cash dated before the current week — overdue invoices to collect and bills/crew/expenses to catch up on — so each week shows only its own dates. It settles off your opening balance; week 1 opens at its result.</div>` : ""}`;
    // expand/collapse + view-toggle (by vendor/project or project/type). Detail
    // rows carry data-view; only the current view shows when a group is expanded.
    const expanded = new Set(), viewOf = {};
    const applyDetail = (g) => {
      const open = expanded.has(g), view = viewOf[g] || "a";
      grid.querySelectorAll(`.cf-detail[data-group="${g}"]`).forEach(r => {
        r.style.display = (open && (!r.dataset.view || r.dataset.view === view)) ? "table-row" : "none";
      });
    };
    grid.querySelectorAll("[data-toggle]").forEach(btn => btn.addEventListener("click", () => {
      const g = btn.getAttribute("data-toggle");
      if (expanded.has(g)) expanded.delete(g); else expanded.add(g);
      btn.textContent = expanded.has(g) ? "▾" : "▸";
      applyDetail(g);
    }));
    grid.querySelectorAll("[data-view-toggle]").forEach(btn => btn.addEventListener("click", () => {
      const g = btn.getAttribute("data-view-toggle");
      viewOf[g] = (viewOf[g] === "b") ? "a" : "b";
      btn.textContent = (viewOf[g] === "b" ? btn.dataset.vb : btn.dataset.va) + " ⇄";
      applyDetail(g);
    }));
    const rb = grid.querySelector("[data-cf-refresh]");
    if (rb) rb.addEventListener("click", refreshSchedules);
    const bb = grid.querySelector("[data-cf-backlog]");
    if (bb) bb.addEventListener("click", openBacklog);
    // clicking a project row → open its Billing & Schedule tab
    grid.querySelectorAll("a[data-cf-proj]").forEach(a =>
      a.addEventListener("click", () => { try { sessionStorage.setItem("opi_entity_tab", "billing"); } catch (_) {} }));
  }

  // ── Backlog drill-down (undated projects: what flows if they all get dates) ──
  const backlogModal = document.getElementById("cfBacklogModal");
  const backlogSummary = document.getElementById("cfBacklogSummary");
  const backlogBody = document.getElementById("cfBacklogBody");
  const closeBacklog = () => { backlogModal.classList.add("hidden"); backlogModal.classList.remove("flex"); };
  document.getElementById("cfBacklogClose").addEventListener("click", closeBacklog);
  backlogModal.addEventListener("click", (e) => { if (e.target === backlogModal) closeBacklog(); });

  function openBacklog() {
    const bk = lastBacklog || {};
    const projs = bk.projects || [];
    const netPos = (bk.net || 0) >= 0;
    const stat = (label, val, cls = "") => `
      <div class="rounded-xl border border-black/10 p-3">
        <div class="text-[11px] font-semibold text-black/50">${label}</div>
        <div class="text-lg font-extrabold ${cls}">${val}</div>
      </div>`;
    backlogSummary.innerHTML =
      stat("New inflow (to bill)", fmtMoney(bk.in || 0), "text-emerald-700") +
      stat("New outflow (est.)", fmtMoney(bk.out || 0), "text-red-600") +
      stat("Net added to forecast", `${netPos ? "+" : ""}${fmtMoney(bk.net || 0)}`, netPos ? "text-emerald-700" : "text-red-600") +
      stat("Already counted (A/R + banked)", fmtMoney((bk.ar || 0) + (bk.paid || 0)), "text-black/60");
    const num = (v, cls = "text-black/60") => v > 0.5
      ? `<span class="tabular-nums ${cls}">${fmtMoney(v)}</span>` : `<span class="text-black/20">–</span>`;
    const netCell = (v) => `<span class="tabular-nums font-bold ${v >= 0 ? "text-emerald-700" : "text-red-600"}">${v >= 0 ? "+" : ""}${fmtMoney(v || 0)}</span>`;
    const totalsRow = `
      <tr class="border-b-2 border-black/20 font-bold" style="background:#f8fafc">
        <td class="py-2 pr-3">All ${bk.count || 0} project${bk.count === 1 ? "" : "s"}</td>
        <td class="py-2 px-2 text-right">${num(bk.paid, "text-black/70")}</td>
        <td class="py-2 px-2 text-right">${num(bk.ar, "text-black/70")}</td>
        <td class="py-2 px-2 text-right">${num(bk.in, "text-emerald-700")}</td>
        <td class="py-2 px-2 text-right">${num(bk.out, "text-red-600")}</td>
        <td class="py-2 pl-2 text-right">${netCell(bk.net || 0)}</td>
      </tr>`;
    const rows = projs.map((p) => `
      <tr class="border-b border-black/5">
        <td class="py-1.5 pr-3"><div class="font-semibold text-ink-900">${escapeHtml(p.name)}</div><div class="text-[10px] text-black/40">${escapeHtml(p.status)}</div></td>
        <td class="py-1.5 px-2 text-right">${num(p.paid)}</td>
        <td class="py-1.5 px-2 text-right">${num(p.ar, "text-black/70")}</td>
        <td class="py-1.5 px-2 text-right">${num(p.to_bill, "font-semibold text-emerald-700")}</td>
        <td class="py-1.5 px-2 text-right">${num(p.out, "text-red-600")}</td>
        <td class="py-1.5 pl-2 text-right">${netCell(p.net || 0)}</td>
      </tr>`).join("");
    backlogBody.innerHTML = `
      <table class="w-full text-[12.5px]">
        <thead><tr class="text-[10px] font-bold uppercase tracking-wide text-black/40 border-b border-black/10">
          <th class="py-2 pr-3 text-left">Project</th>
          <th class="py-2 px-2 text-right">Paid (banked)</th>
          <th class="py-2 px-2 text-right">A/R (on forecast)</th>
          <th class="py-2 px-2 text-right">To bill (new in)</th>
          <th class="py-2 px-2 text-right">Est. out (new)</th>
          <th class="py-2 pl-2 text-right">Net added</th>
        </tr></thead>
        <tbody>${totalsRow}${rows || `<tr><td colspan="6" class="py-4 text-black/40">No undated projects.</td></tr>`}</tbody>
      </table>
      <div class="text-[11px] text-black/45 mt-3"><b>Net added</b> = “To bill” − “Est. out” — what each project would <span class="font-semibold">add to the forecast</span> once it's scheduled. <b>Paid</b> is already in your bank balance and <b>A/R</b> is already on the weekly grid by its due date, so neither is in “Net added” (no double-counting). Est. out = crew + expenses from the estimate, net of any spend so far.</div>`;
    backlogModal.classList.remove("hidden"); backlogModal.classList.add("flex");
  }

  // ── Actuals renderer (historical; unchanged shape) ─────────────────────────
  function renderActuals(d) {
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

          ${sectionHeader(d.outflow.label.toUpperCase(), d.weeks)}
          ${dataRow(d.outflow.label, d.outflow.weekly_totals, { bold: true, bg: "#fff7f7" })}
          ${outSections}

          <tr><td colspan="${1 + d.weeks}" class="pt-2"></td></tr>
          ${dataRow("Total Surplus / (Deficit)", d.summary.surplus, { bold: true, bg: "#f8fafc" })}
          ${dataRow("Ending Cash Balance", d.summary.ending, { bold: true, bg: "#eef2ff" })}
        </tbody>
      </table>`;
    wireToggles();
  }

  // ── Forecast renderer (Committed + toggleable Projected + Beyond column) ───
  const BEYOND_BORDER = "border-left:1px solid rgba(0,0,0,.10)";
  const fCells = (weekly, beyond, extraCls = "") =>
    weekly.map(v => `<td class="px-2 py-1 text-right whitespace-nowrap ${extraCls}" style="font-variant-numeric:tabular-nums">${cell(v)}</td>`).join("")
    + `<td class="px-2 py-1 text-right whitespace-nowrap ${extraCls}" style="font-variant-numeric:tabular-nums;${BEYOND_BORDER}">${beyond ? cell(beyond) : `<span class="text-black/20">–</span>`}</td>`;

  function fRow(label, weekly, beyond, opts = {}) {
    const { bold = false, bg = "#ffffff", indent = false, toggleGroup = null, checkbox = null, on = false, muted = false } = opts;
    const chev = toggleGroup ? `<button data-toggle="${toggleGroup}" class="mr-1 text-black/40 hover:text-black" style="font-size:11px">▸</button>` : "";
    const cb = checkbox ? `<input type="checkbox" data-inc="${checkbox}" ${on ? "checked" : ""} class="mr-1.5 h-3.5 w-3.5 align-middle rounded border-black/30" title="Include in totals & balance">` : "";
    const pad = indent ? "padding-left:1.5rem" : "padding-left:0.75rem";
    return `<tr class="${muted ? "opacity-50" : ""}">
        <td class="py-1 pr-3 ${bold ? "font-bold" : ""} whitespace-nowrap" style="${STICKY}background:${bg};${pad}">${cb}${chev}${escapeHtml(label)}</td>
        ${fCells(weekly, beyond, bold ? "font-semibold" : "")}</tr>`;
  }
  const fDetail = (rows, group, bg = "#ffffff") => rows.map(r => `
      <tr class="cf-detail" data-group="${group}" style="display:none">
        <td class="py-1 pr-3 text-black/60 whitespace-nowrap" style="${STICKY}background:${bg};padding-left:2.25rem">${escapeHtml(r.label)}</td>
        ${fCells(r.weekly, r.beyond || 0, "text-black/60")}</tr>`).join("");
  const fHeader = (txt, cols) => `<tr><td colspan="${2 + cols}" class="pt-3 pb-1 font-bold text-brand-700" style="${STICKY}background:#fff;padding-left:0.75rem">${txt}</td></tr>`;
  const paramFor = (key) => key === "jobcost" ? "inc_jobcost" : "inc_" + key.replace("proj_", "");

  function renderForecast(d) {
    const weekCols = d.week_ends.map((w, i) => {
      const [, m, day] = w.split("-");
      return `<th class="px-2 py-2 text-right whitespace-nowrap font-semibold"><div>${m}/${day}</div><div class="text-[10px] font-normal text-black/40">Wk ${i + 1}</div></th>`;
    }).join("");
    const beyondHead = `<th class="px-2 py-2 text-right whitespace-nowrap font-semibold" style="${BEYOND_BORDER}"><div>Beyond</div><div class="text-[10px] font-normal text-black/40">13 wk +</div></th>`;
    const z = new Array(d.weeks).fill(0);
    const inf = d.inflow, out = d.outflow;

    const projRows = (sections, prefix, bg) => sections.map(s =>
      fRow(s.label, s.weekly_totals, s.beyond, { indent: true, bg, toggleGroup: `${prefix}_${s.key}`, checkbox: paramFor(s.key), on: s.included, muted: !s.included }) +
      fDetail(s.rows, `${prefix}_${s.key}`, "#fbfbfb")
    ).join("");
    const commRows = (sections, prefix, bg) => sections.map(s =>
      fRow(s.label, s.weekly_totals, s.beyond, { indent: true, bg, toggleGroup: `${prefix}_${s.key}` }) +
      fDetail(s.rows, `${prefix}_${s.key}`, "#fbfbfb")
    ).join("");

    grid.innerHTML = `
      <table class="text-sm" style="border-collapse:separate;border-spacing:0;min-width:${300 + (d.weeks + 1) * 70}px">
        <thead>
          <tr class="border-b border-black/10 text-black/60">
            <th class="py-2 pr-3 text-left whitespace-nowrap" style="${STICKY}background:#fff">Week ending →</th>
            ${weekCols}${beyondHead}
          </tr>
        </thead>
        <tbody>
          ${fRow("Opening Cash Balance", d.summary.opening, 0, { bold: true, bg: "#f8fafc" })}

          ${fHeader("CASH INFLOW", d.weeks)}
          ${fRow(inf.label, inf.weekly_totals, inf.beyond_total, { bold: true, toggleGroup: "inflow", bg: "#f4f7f5" })}
          ${commRows([inf.committed], "inf", "#fbfdfb")}
          ${projRows(inf.projected, "inf", "#fbfdfb")}

          ${fHeader("CASH OUTFLOW", d.weeks)}
          ${fRow(out.label, out.weekly_totals, out.beyond_total, { bold: true, bg: "#fff7f7" })}
          ${commRows(out.committed, "out", "#fffafa")}
          ${projRows(out.projected, "out", "#fffafa")}

          <tr><td colspan="${2 + d.weeks}" class="pt-2"></td></tr>
          ${fRow("Total Surplus / (Deficit)", d.summary.surplus, 0, { bold: true, bg: "#f8fafc" })}
          ${fRow("Ending Cash Balance", d.summary.ending, 0, { bold: true, bg: "#eef2ff" })}
        </tbody>
      </table>`;
    wireToggles();
    grid.querySelectorAll("[data-inc]").forEach(cb =>
      cb.addEventListener("change", () => { proj[cb.getAttribute("data-inc")] = cb.checked; load(); }));
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
    btnV2.className = `px-3 py-1.5 rounded-xl text-sm font-bold border ${mode === "forecast_v2" ? active : "border-black/15"}`;
    btnForecast.className = `px-3 py-1.5 rounded-xl text-sm font-bold border ${mode === "forecast" ? active : "border-black/15"}`;
    btnActuals.className = `px-3 py-1.5 rounded-xl text-sm font-bold border ${mode === "actuals" ? active : "border-black/15"}`;
    weeksWrap.classList.toggle("hidden", mode !== "actuals");
    horizonWrap.classList.toggle("hidden", mode !== "forecast_v2");
    document.getElementById("cfOverhead").classList.toggle("hidden", mode !== "forecast_v2");
    modeDesc.textContent = mode === "forecast_v2"
      ? "Forward cash from your real bank balance — committed (open invoices/bills) + recurring overhead + the scheduled crew/invoice/expense plans on every project. Extend the horizon as far as you like."
      : mode === "forecast"
      ? "Forward 13 weeks — committed (open invoices/bills + overhead run-rate) plus toggleable projected layers. “Beyond 13 wk” holds amounts past the window. Tap ⓘ for details."
      : "Historical realized cash for the chosen range — actual payments in, bill payments + card/check spend out.";
  }

  async function load() {
    grid.innerHTML = `<div class="p-4 text-sm text-black/50">Loading…</div>`;
    const params = new URLSearchParams();
    const ob = parseFloat(openingEl.value);
    if (!Number.isNaN(ob)) params.set("opening_balance", String(ob));
    if (startEl.value) params.set("start_date", startEl.value);
    if (mode === "actuals") params.set("weeks", String(parseInt(weeksEl.value, 10) || 13));
    if (mode === "forecast_v2") params.set("weeks", String(Math.max(4, Math.min(520, parseInt(horizonWeeks.value, 10) || 26))));
    if (mode === "forecast") {
      params.set("inc_active", proj.inc_active ? "1" : "0");
      params.set("inc_awarded", proj.inc_awarded ? "1" : "0");
      params.set("inc_jobcost", proj.inc_jobcost ? "1" : "0");
    }
    const endpoint = mode === "actuals" ? "actuals" : mode === "forecast_v2" ? "forecast-v2" : "forecast";
    try {
      const d = await api(`/cashflow/${endpoint}?${params.toString()}`);
      renderKpis(d);
      render(d);
      if (mode === "forecast_v2") { schedulePoll(d.cache); loadCreditCards(); }
      else cardsEl.innerHTML = "";
    } catch (e) {
      kpis.innerHTML = "";
      grid.innerHTML = `<div class="p-4 text-sm text-red-700">Failed to load: ${escapeHtml(e.message || e)}</div>`;
    }
  }

  // ── Credit cards: parked/informational panel (Forecast+ only). The balances are
  //    tracked but NOT in the forecast math yet — pending how payoffs are scheduled.
  const cardsEl = document.getElementById("cfCards");
  let ccData = null;
  async function loadCreditCards() {
    if (!ccData) {
      try { ccData = await api("/cashflow/credit-cards"); }
      catch (e) { ccData = { available: false }; }
    }
    if (mode !== "forecast_v2" || !ccData.available) { cardsEl.innerHTML = ""; return; }
    const accts = (ccData.accounts || []).filter(a => Math.abs(a.balance) > 0.5);
    const rows = accts.map(a => `
      <tr class="border-b border-black/[0.04]">
        <td class="py-1 pr-3 text-black/70">${escapeHtml(a.name)}</td>
        <td class="py-1 pl-2 text-right tabular-nums ${a.credit_balance ? "text-emerald-700" : "text-black/70"}">${a.credit_balance ? "credit " + fmtMoney(-a.owed) : fmtMoney(a.owed)}</td>
      </tr>`).join("");
    cardsEl.innerHTML = `
      <details class="group/cc card p-0 overflow-hidden">
        <summary class="flex items-center gap-2 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-black/[0.015]">
          <svg class="w-3.5 h-3.5 text-black/30 transition-transform group-open/cc:rotate-90" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
          <span class="text-sm font-bold text-ink-900">Credit cards</span>
          <span class="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">Tracked · not in forecast yet</span>
          <span class="ml-auto text-[13px] tabular-nums"><span class="text-black/45">owed</span> <b class="text-ink-900">${fmtMoney(ccData.total_owed || 0)}</b></span>
        </summary>
        <div class="px-4 pb-4 border-t border-black/[0.06]">
          <div class="text-[12px] text-black/50 py-2">Card balances from QuickBooks. Not folded into the forecast until we set how the cards are paid off — card charges aren't cash out of the bank until the card is paid.</div>
          <div class="overflow-x-auto"><table class="w-full text-[12.5px]"><thead><tr class="text-[10px] font-bold uppercase tracking-wide text-black/40 border-b border-black/10"><th class="py-1.5 pr-3 text-left">Card</th><th class="py-1.5 pl-2 text-right">Owed</th></tr></thead><tbody>${rows || `<tr><td colspan="2" class="py-3 text-black/40">No card balances.</td></tr>`}</tbody></table></div>
        </div>
      </details>`;
  }

  // While the scheduled-cash cache is still computing (background recompute),
  // reload every few seconds until it lands — self-perpetuating via load().
  let pollTimer = null;
  function schedulePoll(cache) {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (mode === "forecast_v2" && cache && (cache.stale || cache.computing)) {
      pollTimer = setTimeout(load, 6000);
    }
  }

  // ── Recurring overhead editor (Forecast+) ─────────────────────────────────
  const ovModal = document.getElementById("cfOverheadModal");
  const ovBody = document.getElementById("cfOverheadBody");
  let ovCadences = ["weekly", "biweekly", "monthly", "quarterly", "annual"];
  let ovDirty = false; // did anything change → reload forecast on close
  const closeOverhead = () => {
    ovModal.classList.add("hidden"); ovModal.classList.remove("flex");
    if (ovDirty) { ovDirty = false; load(); }  // recurring is live → reflect edits
  };
  document.getElementById("cfOverhead").addEventListener("click", openOverhead);
  document.getElementById("cfOverheadClose").addEventListener("click", closeOverhead);
  document.getElementById("cfOverheadDone").addEventListener("click", closeOverhead);
  ovModal.addEventListener("click", (e) => { if (e.target === ovModal) closeOverhead(); });
  document.getElementById("cfOverheadAdd").addEventListener("click", async () => {
    await api("/cashflow/overhead", { method: "POST", body: JSON.stringify({ name: "New item", amount: 0, cadence: "monthly", anchor_date: (startEl.value || new Date().toISOString().slice(0, 10)) }) });
    ovDirty = true; renderOverhead();
  });

  const OV_IN = "bg-transparent border border-black/15 rounded px-1.5 py-1 text-[12.5px] outline-none focus:border-blue-500 focus:bg-white";
  async function renderOverhead() {
    let items = [];
    try { const r = await api("/cashflow/overhead"); items = r.items || []; ovCadences = r.cadences || ovCadences; }
    catch (e) { ovBody.innerHTML = `<div class="py-4 text-sm text-red-700">Failed to load: ${escapeHtml(e.message || e)}</div>`; return; }
    const cadOpts = (sel) => ovCadences.map(c => `<option value="${c}" ${c === sel ? "selected" : ""}>${c}</option>`).join("");
    const rows = items.map(i => `
      <tr class="border-b border-black/5" data-ov="${i.id}">
        <td class="py-1 pr-2"><input data-f="name" value="${escapeHtml(i.name || "")}" class="${OV_IN} w-full"></td>
        <td class="py-1 px-1"><input data-f="amount" type="number" step="1" value="${Math.round(i.amount || 0)}" class="${OV_IN} w-24 text-right tabular-nums"></td>
        <td class="py-1 px-1"><select data-f="cadence" class="${OV_IN}">${cadOpts(i.cadence)}</select></td>
        <td class="py-1 px-1"><input data-f="anchor_date" type="date" value="${(i.anchor_date || "").slice(0, 10)}" class="${OV_IN} w-32 tabular-nums"></td>
        <td class="py-1 px-1"><input data-f="end_date" type="date" value="${(i.end_date || "").slice(0, 10)}" class="${OV_IN} w-32 tabular-nums"></td>
        <td class="py-1 pl-1 text-right"><button data-ov-del="${i.id}" class="text-black/30 hover:text-red-600 text-[13px]" title="Remove">✕</button></td>
      </tr>`).join("");
    ovBody.innerHTML = `
      <table class="w-full text-[12.5px]">
        <thead><tr class="text-[10px] font-bold uppercase tracking-wide text-black/40 border-b border-black/10">
          <th class="py-1.5 pr-2 text-left">Item</th><th class="py-1.5 px-1 text-right">Amount</th>
          <th class="py-1.5 px-1 text-left">Cadence</th><th class="py-1.5 px-1 text-left">Starting</th>
          <th class="py-1.5 px-1 text-left">Ends (optional)</th><th class="py-1.5"></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="py-4 text-black/40">No overhead items.</td></tr>`}</tbody>
      </table>`;
    ovBody.querySelectorAll("[data-ov] [data-f]").forEach(el => {
      el.addEventListener("change", async () => {
        const id = el.closest("[data-ov]").getAttribute("data-ov");
        const field = el.getAttribute("data-f");
        let val = el.value;
        if (field === "amount") val = parseFloat(val) || 0;
        if ((field === "anchor_date" || field === "end_date") && !val) val = null;
        try { await api(`/cashflow/overhead/${id}`, { method: "PATCH", body: JSON.stringify({ [field]: val }) }); ovDirty = true; }
        catch (e) { alert("Failed to save: " + (e.message || e)); }
      });
    });
    ovBody.querySelectorAll("[data-ov-del]").forEach(b => b.addEventListener("click", async () => {
      await api(`/cashflow/overhead/${b.getAttribute("data-ov-del")}`, { method: "DELETE" });
      ovDirty = true; renderOverhead();
    }));
  }
  function openOverhead() {
    ovBody.innerHTML = `<div class="py-4 text-sm text-black/40">Loading…</div>`;
    ovModal.classList.remove("hidden"); ovModal.classList.add("flex");
    renderOverhead();
  }

  // Force a recompute of the scheduled-cash cache; the poll picks up the result.
  async function refreshSchedules() {
    try { await api("/cashflow/forecast-v2/refresh", { method: "POST" }); } catch (e) { /* ignore */ }
    load();
  }

  function setMode(m) {
    if (mode === m) return;
    mode = m;
    startEl.value = ""; // reset to mode-appropriate default
    applyModeUi();
    load();
  }

  btnV2.addEventListener("click", () => setMode("forecast_v2"));
  btnForecast.addEventListener("click", () => setMode("forecast"));
  btnActuals.addEventListener("click", () => setMode("actuals"));
  document.getElementById("cfGenerate").addEventListener("click", load);
  document.querySelectorAll(".cf-wk").forEach(b =>
    b.addEventListener("click", () => { horizonWeeks.value = b.getAttribute("data-wk"); if (mode === "forecast_v2") load(); }));
  horizonWeeks.addEventListener("change", () => { if (mode === "forecast_v2") load(); });

  // ---- Info modal ----
  const infoModal = document.getElementById("cfInfoModal");
  const openInfo = () => { infoModal.classList.remove("hidden"); infoModal.classList.add("flex"); };
  const closeInfo = () => { infoModal.classList.add("hidden"); infoModal.classList.remove("flex"); };
  document.getElementById("cfInfo").addEventListener("click", openInfo);
  document.getElementById("cfInfoClose").addEventListener("click", closeInfo);
  infoModal.addEventListener("click", (e) => { if (e.target === infoModal) closeInfo(); });

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
