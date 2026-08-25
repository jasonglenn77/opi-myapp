import { api } from "../api.js";
import { setShell } from "../shell.js";
import { fmtMoney } from "../utils/format.js";

export async function cashflowPage(routeFn) {
  let mode = "forecast_v2"; // "forecast_v2" | "forecast" | "actuals"

  const bodyHtml = `
    <div class="card px-4 py-3 mb-4">
      <div class="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div class="flex items-center gap-1.5">
          <button id="cfModeV2" class="px-3 py-1.5 rounded-xl text-sm font-bold border border-black/15">Forecast</button>
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

    <div id="cfInfoModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 flex flex-col" style="width:100%;max-width:42rem;max-height:85vh;overflow:hidden;">
        <div class="flex items-center justify-between mb-3">
          <div class="text-lg font-extrabold">How the Cash Flow page works</div>
          <button id="cfInfoClose" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>
        <div class="text-sm text-black/70 space-y-4 overflow-y-auto pr-1" style="min-height:0;">
          <p>This page shows your cash two ways, switched at the top left: <span class="font-semibold text-ink-900">Forecast</span> (what's coming) and <span class="font-semibold text-ink-900">Actuals</span> (what already happened).</p>

          <div>
            <div class="font-bold text-ink-900">How the Forecast builds each week</div>
            <p class="text-black/60">It starts at your <span class="font-semibold">real QuickBooks bank balance</span>, then each week: <span class="font-semibold">opening → + cash in − cash out → ending</span>, and the next week opens where the last one ended. You can extend the horizon as far out as you want (13 / 26 / 52 or any number of weeks).</p>
          </div>

          <div>
            <div class="font-bold text-ink-900">What the lines mean — and where each number comes from</div>
            <ul class="list-disc ml-5 mt-1 space-y-1.5 text-black/60">
              <li><span class="font-semibold text-ink-900">Committed</span> — the firmest money, because it's already in QuickBooks. <em>In</em> = customer invoices you've already sent, placed on their due date. <em>Out</em> = bills you've already entered, on their due date.</li>
              <li><span class="font-semibold text-ink-900">Scheduled</span> — the plans from each project's <span class="font-semibold">Billing &amp; Schedule</span> tab that aren't in QuickBooks yet: invoices you're set to send, crew payments, and project expenses, each on its planned date. The forecast is the sum of every project's tab, so if you fix a project's schedule it updates here.</li>
              <li><span class="font-semibold text-ink-900">Recurring</span> — your steady overhead: rent, insurance, payroll, loan payments. Most lines are auto-generated from your trailing-12-month spending and refresh with every QuickBooks sync; a few (payroll wages, bonus, payroll taxes) are kept by hand because they aren't in QuickBooks. Open the <span class="font-semibold">Overhead</span> button to view, add, or adjust any line — see <span class="font-semibold">The Overhead editor</span> below.</li>
            </ul>
          </div>

          <div>
            <div class="font-bold text-ink-900">Reading the grid</div>
            <ul class="list-disc ml-5 mt-1 space-y-1.5 text-black/60">
              <li><span class="font-semibold text-ink-900">Confidence dots</span> next to each line show how firm it is: <span class="font-semibold">committed</span> (in QuickBooks) → <span class="font-semibold">scheduled</span> (planned) → <span class="font-semibold">estimated</span> (run-rate).</li>
              <li><span class="font-semibold text-ink-900">Past due</span> column — anything dated before this week (overdue invoices to collect, bills/plans to catch up on) sits in its own column, so each week shows only its true Sat–Fri dates.</li>
              <li><span class="font-semibold text-ink-900">Committed, not yet scheduled</span> — won projects that don't have start dates yet. Their cash is held out of the weekly balance until dates are set; click it to see those projects and what they'd add.</li>
              <li><span class="font-semibold text-ink-900">Drill in</span> — expand any section to see the detail; use the <span class="font-semibold">⇄</span> toggle to switch views (by vendor / project / category / item); and <span class="font-semibold">click a project name</span> to open its Billing &amp; Schedule tab.</li>
              <li><span class="font-semibold text-ink-900">What-if</span> — expand Recurring and type a new amount into a weekly cell to see the balance change live. It's a scenario only — nothing is saved; <span class="font-semibold">Reset to actual</span> restores it.</li>
            </ul>
          </div>

          <div>
            <div class="font-bold text-ink-900">Actuals — what already happened</div>
            <p class="text-black/60">Same layout, for a date range you choose: real customer payments received <em>in</em>, and bill payments + card/check spend <em>out</em>, by the week the cash actually moved. Expand, toggle, and click through to projects the same way.</p>
            <p class="text-black/60 mt-1.5">Your <span class="font-semibold">recurring overhead shows here too</span> — as the real posted spend, under <span class="font-semibold">Direct expenses</span> (by category — occupancy, owner draws, insurance…) and <span class="font-semibold">Bill payments</span> (by vendor). The only things you won't see are the hand-entered lines (wages, bonus, payroll taxes, miscellaneous): they never post to QuickBooks, so there's no actual to show.</p>
          </div>

          <div>
            <div class="font-bold text-ink-900">Where the numbers come from</div>
            <p class="text-black/60">Everything reads from your QuickBooks data that we've already synced into the app — invoices, bills, payments, purchases, and bank balances. <span class="font-semibold text-ink-900">Opening this page never calls QuickBooks</span>, so it never uses your Intuit API limits. To pull the latest, run <span class="font-semibold">"Sync transactions now"</span> on the QuickBooks page.</p>
          </div>

          <div>
            <div class="font-bold text-ink-900">Opening balance</div>
            <p class="text-black/60">Auto-fills from your QuickBooks bank balance and is editable — override it to model a different starting point.</p>
          </div>

          <div>
            <div class="font-bold text-ink-900">The Overhead editor — your recurring schedule</div>
            <p class="text-black/60">The <span class="font-semibold">Overhead</span> button opens every recurring cash-out line, <span class="font-semibold">grouped by category</span> (Occupancy, Payroll, Travel…) with a weekly subtotal per group and a <span class="font-semibold">grand total</span> ($/wk and $/yr) at the top. A <span class="font-semibold">Per week</span> column normalizes each line, so a monthly rent and a weekly payroll are comparable at a glance. The column header stays pinned as you scroll, and you can <span class="font-semibold">collapse any category</span> by clicking its header. Add a line with the <span class="font-semibold">+ add</span> on a category header (files it there) or <span class="font-semibold">+ Add item</span> at the bottom, pick its <span class="font-semibold">Category</span> from the dropdown, and edit amount / cadence / dates inline. You can also edit Recurring cells right in the Cash Outflow grid for a live what-if.</p>
            <p class="text-black/60 mt-2">Each line is tagged by <span class="font-semibold">where its number comes from</span>:</p>
            <ul class="list-disc ml-5 mt-1 space-y-1.5 text-black/60">
              <li><span class="text-[10px] font-bold uppercase tracking-wide text-black/40 border border-black/15 rounded px-1 py-px">auto</span> — derived from your trailing-12-month QuickBooks spending, at the cadence detected from how often it posts. <span class="font-semibold">Refreshes on every sync.</span></li>
              <li><span class="text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-px">edited</span> — a QuickBooks line you've hand-adjusted (e.g. rent cleaned of one-off charges). It holds your value and shows <span class="font-semibold">↺ revert</span> back to the live auto figure.</li>
              <li><span class="text-[10px] font-bold uppercase tracking-wide text-indigo-700 bg-indigo-100 border border-indigo-200 rounded px-1 py-px">manual</span> — <span class="font-semibold">not in QuickBooks</span>, so you maintain it by hand. These rows are <span class="text-indigo-700">shaded</span> so they stand out — W-2 wages, bonus / commission, employer payroll taxes, and miscellaneous, since payroll runs through an outside provider.</li>
            </ul>
            <p class="text-black/60 mt-1.5">Deleted lines stay deleted (they won't come back on a sync) until you restore them, and <span class="font-semibold">history</span> shows every change to a line.</p>
          </div>
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
      <div class="card p-6 flex flex-col" style="width:100%;max-width:88rem;max-height:85vh;overflow:hidden;">
        <div class="flex items-center justify-between mb-1">
          <div class="text-lg font-extrabold">Recurring overhead</div>
          <button id="cfOverheadClose" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>
        <div class="text-xs text-black/50 mb-3">The recurring cash going out — rent, insurance, payroll, loan payments. Each item lands in the forecast by its cadence from the reference date. Seeded from your trailing spend; edit into real items. Changes show in the forecast right away.</div>
        <div id="cfOverheadBody" class="overflow-y-auto overflow-x-auto" style="flex:1 1 auto;min-height:0;">Loading…</div>
        <div class="flex items-center justify-between gap-2 pt-3 border-t border-black/10 mt-2">
          <button id="cfOverheadAdd" class="text-sm font-semibold text-brand-700 hover:underline">+ Add item</button>
          <button id="cfOverheadDone" class="btn-primary">Done</button>
        </div>
      </div>
    </div>

    <div id="cfKpis" class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4"></div>

    <div class="card p-0 overflow-hidden">
      <div id="cfScroll" class="overflow-auto">
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
  // Bound the forecast table to the remaining viewport so it scrolls INTERNALLY —
  // that's what keeps the sticky "Week ending" header row visible while you scroll
  // through expanded inflow/outflow sections.
  function sizeCfScroll() {
    const el = document.getElementById("cfScroll");
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    el.style.maxHeight = Math.max(320, window.innerHeight - top - 16) + "px";
  }
  window.addEventListener("resize", sizeCfScroll);
  const kpis = document.getElementById("cfKpis");
  const modeDesc = document.getElementById("cfModeDesc");
  const btnV2 = document.getElementById("cfModeV2");
  const btnActuals = document.getElementById("cfModeActuals");
  const horizonWrap = document.getElementById("cfHorizon");
  const horizonWeeks = document.getElementById("cfHorizonWeeks");

  let lastBacklog = null; // most recent Forecast backlog, for the drill-down modal

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
    return renderForecastV2(d);  // Forecast and Actuals both use the unified renderer
  }

  // ── Forecast+ renderer (Phase 3b: committed QBO + scheduled project layer,
  //    unbounded weekly horizon, real bank anchor, option-a backlog) ──────────
  function renderForecastV2(d) {
    const isActuals = d.mode === "actuals";
    // Past-due column: everything dated before the current week, in its own
    // leading column so week 1 shows only its true Sat–Fri items. (Actuals are
    // all historical — no past-due.)
    const pd = d.past_due || { opening: d.opening_balance, ending: d.opening_balance, inflow: 0, outflow: 0, surplus: 0 };
    const hasPD = Math.abs(pd.inflow) > 0.5 || Math.abs(pd.outflow) > 0.5;
    const PD_BG = "#fbf6ea", PD_SEP = "border-right:2px solid rgba(0,0,0,.18)";
    const pdCell = (v, extraCls = "") => hasPD
      ? `<td class="px-2 py-1 text-right whitespace-nowrap ${extraCls}" style="font-variant-numeric:tabular-nums;${PD_SEP};background:${PD_BG}">${cell(v)}</td>` : "";
    const extra = hasPD ? 1 : 0;

    const pdHead = hasPD
      ? `<th class="px-2 py-2 text-right whitespace-nowrap font-semibold" style="position:sticky;top:0;z-index:4;${PD_SEP};background:${PD_BG}"><div>Past due</div><div class="text-[10px] font-normal text-black/40">overdue</div></th>` : "";
    const weekCols = d.week_ends.map((w, i) => {
      const [, m, day] = w.split("-");
      return `<th class="px-2 py-2 text-right whitespace-nowrap font-semibold" style="position:sticky;top:0;z-index:4;background:#fff"><div>${m}/${day}</div><div class="text-[10px] font-normal text-black/40">Wk ${i + 1}</div></th>`;
    }).join("");

    // numeric cells tagged with week (+ row id) so the live what-if can update them
    const numCellsR = (arr, rowId, cls = "") => arr.map((v, w) =>
      `<td class="px-2 py-1 text-right whitespace-nowrap ${cls}" data-w="${w}"${rowId ? ` data-r="${rowId}"` : ""} style="font-variant-numeric:tabular-nums">${cell(v)}</td>`).join("");
    // editable recurring cells — type a number to see the cash impact (what-if)
    const editCellsR = (arr) => arr.map((v, w) =>
      `<td class="px-2 py-1 text-right whitespace-nowrap cf-recedit" data-w="${w}" contenteditable="true" spellcheck="false" style="font-variant-numeric:tabular-nums;outline:none;cursor:text;background:#fffdf0;border:1px dashed rgba(0,0,0,.12)">${Math.round(v)}</td>`).join("");

    const rowV2 = (label, pdv, weekly, { bold = false, bg = "#ffffff", rowId = "" } = {}) => `<tr>
        <td class="py-1 pr-3 ${bold ? "font-bold" : ""} whitespace-nowrap" style="${STICKY}background:${bg};padding-left:0.75rem">${escapeHtml(label)}</td>
        ${pdCell(pdv, bold ? "font-semibold" : "")}${numCellsR(weekly, rowId, bold ? "font-semibold" : "")}</tr>`;

    // confidence tiers: how firm a section's cash is (committed QBO > scheduled
    // app plans > estimated run-rate). Shades the section row + a dot.
    const TIER = {
      committed: { dot: "bg-ink-900", bg: "#eef1f4", name: "Committed" },
      scheduled: { dot: "bg-emerald-500", bg: "#f0f8f2", name: "Scheduled" },
      estimated: { dot: "border-[1.5px] border-black/40", bg: "#f7f7f8", name: "Estimated" },
    };
    const detailV2 = (rows, group, view = "", editable = false) => rows.map(r => {
      const lbl = (r.link_id && r.is_project)
        ? `<a href="#/entity/project/${escapeHtml(String(r.link_id))}" data-cf-proj class="text-blue-700 hover:underline">${escapeHtml(r.label)}</a>`
        : escapeHtml(r.label);
      const cells = editable ? editCellsR(r.weekly) : numCells(r.weekly, "text-black/60");
      return `<tr class="cf-detail" data-group="${group}"${view ? ` data-view="${view}"` : ""} style="display:none">
        <td class="py-1 pr-3 text-black/60 whitespace-nowrap" style="${STICKY}background:#fbfbfb;padding-left:2.25rem">${lbl}</td>
        ${pdCell(r.pastdue || 0, "text-black/60")}${cells}</tr>`;
    }).join("");
    const secRow = (s, group) => {
      const t = TIER[s.tier] || TIER.scheduled;
      const hasRows = s.rows && s.rows.length;
      const hasAlt = s.alt_rows && s.alt_rows.length;
      const isRec = s.key === "recurring";  // recurring category cells are editable (what-if)
      const chev = (hasRows || hasAlt) ? `<button data-toggle="${group}" class="mr-1 text-black/40 hover:text-black" style="font-size:11px">▸</button>` : "";
      const dot = `<span class="inline-block w-2 h-2 rounded-full align-middle mr-1.5 ${t.dot}"></span>`;
      const vt = hasAlt ? ` <button data-view-toggle="${group}" data-va="${escapeHtml(s.view_a || "A")}" data-vb="${escapeHtml(s.view_b || "B")}" class="ml-1 align-middle text-[10px] font-bold text-blue-600 border border-blue-200 rounded px-1.5 py-0.5 hover:bg-blue-50">${escapeHtml(s.view_a || "A")} ⇄</button>` : "";
      const editHint = isRec ? ` <span class="text-[10px] font-semibold text-amber-700">✎ edit cells for what-if</span>` : "";
      const label = `<td class="py-1 pr-3 whitespace-nowrap" style="${STICKY}background:${t.bg};padding-left:1.5rem">${chev}${dot}${escapeHtml(s.label)}${vt}${editHint}</td>`;
      const detA = hasRows ? detailV2(s.rows, group, hasAlt ? "a" : "", isRec) : "";
      const detB = hasAlt ? detailV2(s.alt_rows, group, "b", isRec) : "";  // recurring: both views editable
      const totalCells = isRec ? numCellsR(s.weekly_totals, "recTotal") : numCells(s.weekly_totals);
      return `<tr>${label}${pdCell(s.pastdue || 0)}${totalCells}</tr>` + detA + detB;
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
           <span class="text-black/55"> — need to bill ${fmtMoney(bk.in || 0)} · est. out ${fmtMoney(bk.out || 0)} · </span><b class="${netPos ? "text-emerald-700" : "text-red-600"}">net ${netPos ? "+" : ""}${fmtMoney(bk.net || 0)}</b>
           <span class="text-brand-700 font-semibold ml-1">view →</span>
         </button>`
      : "";

    const strip = isActuals
      ? `<div class="px-1 pb-3 text-[12px] text-black/50">Realized cash — actual customer payments in, bill payments &amp; card/check spend out, by the week they cleared. Click a project to open it.</div>`
      : `<div class="flex flex-wrap items-center justify-between gap-3 px-1 pb-3">
        <div class="text-[12px]">${fresh} <button data-cf-refresh class="ml-2 font-semibold text-brand-700 hover:underline">↻ Refresh schedules</button></div>
        <div class="flex items-center gap-3">${legend}</div>
        ${backlogChip}
      </div>`;
    grid.innerHTML = `
      ${strip}
      <div data-cf-whatif class="hidden items-center gap-2 mb-2 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-300 text-[12px] text-amber-900">
        <b>What-if mode</b> — showing a hypothetical balance from your recurring edits (not saved).
        <button data-cf-whatif-reset class="ml-auto font-bold text-brand-700 hover:underline">Reset to actual</button>
      </div>
      <table class="text-sm" style="border-collapse:separate;border-spacing:0;min-width:${300 + (d.weeks + extra) * 68}px">
        <thead>
          <tr class="border-b border-black/10 text-black/60">
            <th class="py-2 pr-3 text-left whitespace-nowrap" style="position:sticky;top:0;left:0;z-index:5;background:#fff">Week ending →</th>
            ${pdHead}${weekCols}
          </tr>
        </thead>
        <tbody>
          ${rowV2("Opening Cash Balance", pd.opening, d.summary.opening, { bold: true, bg: "#f8fafc", rowId: "opening" })}

          ${sectionHeader("CASH INFLOW", d.weeks + extra)}
          ${rowV2(d.inflow.label, d.inflow.pastdue_total, d.inflow.weekly_totals, { bold: true, bg: "#f4f7f5" })}
          ${inSecs}

          ${sectionHeader("CASH OUTFLOW", d.weeks + extra)}
          ${rowV2(d.outflow.label, d.outflow.pastdue_total, d.outflow.weekly_totals, { bold: true, bg: "#fff7f7", rowId: "outTotal" })}
          ${outSecs}

          <tr><td colspan="${1 + extra + d.weeks}" class="pt-2"></td></tr>
          ${rowV2("Total Surplus / (Deficit)", pd.surplus, d.summary.surplus, { bold: true, bg: "#f8fafc", rowId: "surplus" })}
          ${rowV2("Ending Cash Balance", pd.ending, d.summary.ending, { bold: true, bg: "#eef2ff", rowId: "ending" })}
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
      if (g === recGroup) recomputeWhatIf();  // what-if follows the visible recurring view
    }));
    const rb = grid.querySelector("[data-cf-refresh]");
    if (rb) rb.addEventListener("click", refreshSchedules);
    const bb = grid.querySelector("[data-cf-backlog]");
    if (bb) bb.addEventListener("click", openBacklog);
    // clicking a project row → open its Billing & Schedule tab, and remember to
    // send "← Back to Cash Flow" (scoped to this exact project).
    grid.querySelectorAll("a[data-cf-proj]").forEach(a =>
      a.addEventListener("click", () => {
        try {
          sessionStorage.setItem("opi_entity_tab", "billing");
          const pid = (a.getAttribute("href") || "").split("/").pop();
          if (pid) sessionStorage.setItem("opi_entity_back", JSON.stringify({ entity: "project/" + pid, label: "Cash Flow", hash: "#/cashflow" }));
        } catch (_) {}
      }));

    // ── live what-if: edit a recurring cell → re-roll the balance (not saved) ──
    const wWeeks = d.weeks;
    const inflowTotal = d.inflow.weekly_totals;
    const recIdx = d.outflow.sections.findIndex(s => s.key === "recurring");
    const recGroup = recIdx >= 0 ? `outv2_${recIdx}` : null;
    const recSec = recIdx >= 0 ? d.outflow.sections[recIdx] : null;
    const baseRecurring = (recSec && recSec.weekly_totals) || new Array(wWeeks).fill(0);
    const baseOutOther = d.outflow.weekly_totals.map((v, w) => v - (baseRecurring[w] || 0));
    const opening0 = (d.summary.opening[0] != null) ? d.summary.opening[0] : 0;
    const whatifBar = grid.querySelector("[data-cf-whatif]");
    const setRow = (rowId, arr) => grid.querySelectorAll(`td[data-r="${rowId}"]`).forEach(td => {
      td.innerHTML = cell(arr[+td.getAttribute("data-w")]);
    });
    function recomputeWhatIf() {
      // sum only the CURRENTLY SHOWN recurring view's cells (both views are
      // editable but each reconciles to the same total — never sum both).
      const view = recGroup ? (viewOf[recGroup] || "a") : "a";
      const newRec = new Array(wWeeks).fill(0);
      grid.querySelectorAll(`.cf-detail[data-group="${recGroup}"][data-view="${view}"] td.cf-recedit`).forEach(td => {
        newRec[+td.getAttribute("data-w")] += parseFloat((td.textContent || "").replace(/[^0-9.\-]/g, "")) || 0;
      });
      const outTotal = [], surplus = [], opening = [], ending = [];
      let bal = opening0;
      for (let w = 0; w < wWeeks; w++) {
        const ot = baseOutOther[w] + newRec[w];
        const su = inflowTotal[w] - ot;
        opening[w] = bal; ending[w] = bal + su; bal = ending[w];
        outTotal[w] = ot; surplus[w] = su;
      }
      setRow("recTotal", newRec); setRow("outTotal", outTotal);
      setRow("surplus", surplus); setRow("opening", opening); setRow("ending", ending);
      const changed = newRec.some((v, w) => Math.abs(v - (baseRecurring[w] || 0)) > 0.5);
      if (whatifBar) { whatifBar.classList.toggle("hidden", !changed); whatifBar.classList.toggle("flex", changed); }
    }
    grid.querySelectorAll("td.cf-recedit").forEach(td => td.addEventListener("input", recomputeWhatIf));
    const wreset = grid.querySelector("[data-cf-whatif-reset]");
    if (wreset) wreset.addEventListener("click", () => renderForecastV2(d));
    requestAnimationFrame(sizeCfScroll);  // bound the scroll area so the header stays sticky
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
      stat("New inflow (need to bill)", fmtMoney(bk.in || 0), "text-emerald-700") +
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

  // (old Forecast/Actuals renderers removed — both views now use renderForecastV2)

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
    btnActuals.className = `px-3 py-1.5 rounded-xl text-sm font-bold border ${mode === "actuals" ? active : "border-black/15"}`;
    weeksWrap.classList.toggle("hidden", mode !== "actuals");
    horizonWrap.classList.toggle("hidden", mode !== "forecast_v2");
    document.getElementById("cfOverhead").classList.toggle("hidden", mode !== "forecast_v2");
    modeDesc.textContent = mode === "forecast_v2"
      ? "Forward cash from your real bank balance — committed (open invoices/bills) + recurring overhead + the scheduled crew/invoice/expense plans on every project. Extend the horizon as far as you like. Tap ⓘ for how it's built."
      : "Historical realized cash for the chosen range — actual payments in, bill payments + card/check spend out. Tap ⓘ for details.";
  }

  let lastSig = null;  // signature of the last-rendered numbers (skip no-op re-renders)
  async function load(silent = false) {
    // `silent` = a background poll while the cache recomputes: don't blank the
    // grid, and only re-render if the numbers actually changed (no flash).
    if (!silent) grid.innerHTML = `<div class="p-4 text-sm text-black/50">Loading…</div>`;
    const params = new URLSearchParams();
    const ob = parseFloat(openingEl.value);
    if (!Number.isNaN(ob)) params.set("opening_balance", String(ob));
    if (startEl.value) params.set("start_date", startEl.value);
    if (mode === "actuals") params.set("weeks", String(parseInt(weeksEl.value, 10) || 13));
    if (mode === "forecast_v2") params.set("weeks", String(Math.max(4, Math.min(520, parseInt(horizonWeeks.value, 10) || 26))));
    const endpoint = mode === "actuals" ? "actuals" : "forecast-v2";
    try {
      const d = await api(`/cashflow/${endpoint}?${params.toString()}`);
      const sig = JSON.stringify([d.summary, d.inflow.weekly_totals, d.outflow.weekly_totals,
                                  d.inflow.grand_total, d.outflow.grand_total, d.backlog, d.past_due]);
      if (silent && sig === lastSig) {            // nothing changed — no flash
        if (mode === "forecast_v2") schedulePoll(d.cache);
        return;
      }
      lastSig = sig;
      renderKpis(d);
      render(d);
      if (mode === "forecast_v2") { schedulePoll(d.cache); loadCreditCards(); }
      else cardsEl.innerHTML = "";
    } catch (e) {
      kpis.innerHTML = "";
      if (!silent) grid.innerHTML = `<div class="p-4 text-sm text-red-700">Failed to load: ${escapeHtml(e.message || e)}</div>`;
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
      pollTimer = setTimeout(() => load(true), 6000);
    }
  }

  // ── Recurring overhead editor (Forecast+) ─────────────────────────────────
  const ovModal = document.getElementById("cfOverheadModal");
  const ovBody = document.getElementById("cfOverheadBody");
  let ovCadences = ["weekly", "biweekly", "monthly", "quarterly", "annual"];
  let ovDirty = false; // did anything change → reload forecast on close
  const ovCollapsed = new Set(); // category names collapsed in the editor (persists across re-renders)
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
    let items = [], deleted = [];
    try { const r = await api("/cashflow/overhead"); items = r.items || []; ovCadences = r.cadences || ovCadences; }
    catch (e) { ovBody.innerHTML = `<div class="py-4 text-sm text-red-700">Failed to load: ${escapeHtml(e.message || e)}</div>`; return; }
    try { const dr = await api("/cashflow/overhead-deleted"); deleted = dr.items || []; } catch (_) {}
    const cadOpts = (sel) => ovCadences.map(c => `<option value="${c}" ${c === sel ? "selected" : ""}>${c}</option>`).join("");
    const CAD_SHORT = { weekly: "wk", biweekly: "bi-wk", monthly: "mo", quarterly: "qtr", annual: "yr" };
    const money0 = (v) => "$" + Math.round(Number(v) || 0).toLocaleString();
    const seedLabel = (i) => i.seed_amount != null ? `${money0(i.seed_amount)}/${CAD_SHORT[i.seed_cadence] || i.seed_cadence}` : "—";
    const isEdited = (i) => i.seed_amount == null ? !!i.edited
      : (Math.round(i.amount || 0) !== Math.round(i.seed_amount || 0)
         || (i.cadence || "") !== (i.seed_cadence || "")
         || (i.anchor_date || "").slice(0, 10) !== (i.seed_anchor_date || "").slice(0, 10));
    const sourceCell = (i) => {
      if (i.from_qbo === 0) {
        return `<div class="flex items-center gap-2 justify-end whitespace-nowrap">
          <span class="text-[9px] font-bold uppercase tracking-wide text-indigo-700 bg-indigo-100 border border-indigo-200 rounded px-1 py-px" title="Entered by hand — not from QuickBooks. You maintain this line.">manual</span>
          <button data-ov-hist="${i.id}" class="text-[11px] font-semibold text-black/40 hover:text-black/70">history</button>
        </div>`;
      }
      if (isEdited(i)) {
        const canRevert = i.seed_amount != null;
        return `<div class="flex items-center gap-2 justify-end whitespace-nowrap">
          <span class="text-[9px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-px">edited</span>
          ${canRevert ? `<button data-ov-revert="${i.id}" title="Revert to the auto-generated ${seedLabel(i)}" class="text-[11px] font-semibold text-blue-600 hover:underline">↺ ${seedLabel(i)}</button>` : ""}
          <button data-ov-hist="${i.id}" class="text-[11px] font-semibold text-black/40 hover:text-black/70">history</button>
        </div>`;
      }
      return `<div class="flex items-center gap-2 justify-end whitespace-nowrap">
        <span class="text-[10px] text-black/30" title="Auto-generated from your trailing-12-month spending — refreshes on each QuickBooks sync">auto</span>
        <button data-ov-hist="${i.id}" class="text-[11px] font-semibold text-black/35 hover:text-black/70">history</button>
      </div>`;
    };
    const PPY = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, annual: 1 };
    const perWeek = (i) => (Number(i.amount) || 0) * (PPY[i.cadence] || 0) / 52;
    const catList = Array.from(new Set(items.map(i => i.category).filter(Boolean))).sort();
    const rowHtml = (i, cat, collapsed) => `
      <tr class="border-b border-black/5 ${i.from_qbo === 0 ? "bg-indigo-50/60" : ""}" data-ov="${i.id}" data-ovcat="${escapeHtml(cat)}"${collapsed ? " hidden" : ""}>
        <td class="py-1 pr-2 pl-3"><input data-f="name" value="${escapeHtml(i.name || "")}" title="${escapeHtml(i.name || "")}" class="${OV_IN} w-full min-w-[15rem]"></td>
        <td class="py-1 px-1"><input data-f="category" list="ovCatList" value="${escapeHtml(i.category || "")}" placeholder="—" class="${OV_IN} w-40"></td>
        <td class="py-1 px-1"><input data-f="amount" type="number" step="1" value="${Math.round(i.amount || 0)}" class="${OV_IN} w-24 text-right tabular-nums"></td>
        <td class="py-1 px-1"><select data-f="cadence" class="${OV_IN}">${cadOpts(i.cadence)}</select></td>
        <td class="py-1 px-1 text-right tabular-nums text-black/45 whitespace-nowrap" title="Weekly-equivalent — the amount spread over its cadence">${money0(perWeek(i))}</td>
        <td class="py-1 px-1"><input data-f="anchor_date" type="date" value="${(i.anchor_date || "").slice(0, 10)}" class="${OV_IN} w-32 tabular-nums"></td>
        <td class="py-1 px-1"><input data-f="end_date" type="date" value="${(i.end_date || "").slice(0, 10)}" class="${OV_IN} w-32 tabular-nums"></td>
        <td class="py-1 px-1">${sourceCell(i)}</td>
        <td class="py-1 pl-1 text-right"><button data-ov-del="${i.id}" class="text-black/30 hover:text-red-600 text-[13px]" title="Remove">✕</button></td>
      </tr>
      <tr class="ov-hist-row" data-ov-hist-row="${i.id}" data-ovcat="${escapeHtml(cat)}" data-histrow="1" hidden><td colspan="9" class="px-3 py-2 bg-black/[0.015] border-b border-black/10"></td></tr>`;
    const groups = {};
    items.forEach(i => { const c = i.category || "Other"; (groups[c] = groups[c] || []).push(i); });
    const subOf = (c) => groups[c].reduce((s, i) => s + perWeek(i), 0);
    const catOrder = Object.keys(groups).sort((a, b) => subOf(b) - subOf(a));
    let grandWk = 0;
    const rows = catOrder.map(c => {
      const sub = subOf(c); grandWk += sub;
      const collapsed = ovCollapsed.has(c);
      const head = `<tr class="bg-black/[0.03] cursor-pointer select-none hover:bg-black/5" data-ovcat-head="${escapeHtml(c)}">
        <td colspan="9" class="pt-3 pb-1 px-2">
          <div class="flex items-center justify-between gap-3">
            <span class="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-black/55">
              <span data-chev class="inline-block w-3 text-black/40 text-[11px]">${collapsed ? "▸" : "▾"}</span>${escapeHtml(c)}
              <button data-ov-catadd="${escapeHtml(c)}" title="Add a line to ${escapeHtml(c)}" class="ml-1 normal-case font-semibold text-brand-700 hover:underline text-[11px]">+ add</button>
            </span>
            <span class="tabular-nums font-bold text-black/60 whitespace-nowrap">${money0(sub)}<span class="text-black/40 font-normal">/wk</span></span>
          </div>
        </td></tr>`;
      return head + groups[c].map(i => rowHtml(i, c, collapsed)).join("");
    }).join("");
    const delSection = deleted.length ? `
      <div class="mt-4 pt-3 border-t border-black/10">
        <div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1.5">Deleted items (${deleted.length}) — restorable</div>
        <table class="w-full text-[12.5px]"><tbody>
          ${deleted.map(d => `<tr class="border-b border-black/5" data-ovd="${d.id}">
            <td class="py-1 pr-2 text-black/50 line-through">${escapeHtml(d.name || "")}</td>
            <td class="py-1 px-1 text-right tabular-nums text-black/45 whitespace-nowrap">${money0(d.amount)}/${CAD_SHORT[d.cadence] || d.cadence}</td>
            <td class="py-1 px-1 text-[11px] text-black/40 whitespace-nowrap">deleted ${d.deleted_at ? new Date(d.deleted_at + "Z").toLocaleDateString() : ""}${d.deleted_by ? " · " + escapeHtml(d.deleted_by) : ""}</td>
            <td class="py-1 pl-1 text-right whitespace-nowrap">
              <button data-ov-hist="${d.id}" class="text-[11px] font-semibold text-black/40 hover:text-black/70 mr-2">history</button>
              <button data-ov-restore="${d.id}" class="text-[11px] font-semibold text-blue-600 hover:underline">Restore</button>
            </td>
          </tr>
          <tr class="ov-hist-row" data-ov-hist-row="${d.id}" hidden><td colspan="4" class="px-3 py-2 bg-black/[0.015] border-b border-black/10"></td></tr>`).join("")}
        </tbody></table>
      </div>` : "";
    ovBody.innerHTML = `
      <div class="flex items-baseline justify-between gap-3 mb-2 pb-2 border-b border-black/10">
        <div class="text-[11px] font-semibold uppercase tracking-wide text-black/45">Total recurring cash-out</div>
        <div class="tabular-nums whitespace-nowrap"><span class="text-base font-extrabold text-ink-900">${money0(grandWk)}</span><span class="text-black/40 text-[12px]">/wk</span><span class="mx-2 text-black/20">·</span><span class="font-bold text-black/60">${money0(grandWk * 52)}</span><span class="text-black/40 text-[12px]">/yr</span></div>
      </div>
      <table class="w-full text-[12.5px]">
        <thead><tr class="text-[10px] font-bold uppercase tracking-wide text-black/40">
          <th class="sticky top-0 z-10 bg-white py-1.5 pr-2 pl-2 text-left border-b border-black/10">Item</th>
          <th class="sticky top-0 z-10 bg-white py-1.5 px-1 text-left border-b border-black/10">Category</th>
          <th class="sticky top-0 z-10 bg-white py-1.5 px-1 text-right border-b border-black/10">Amount</th>
          <th class="sticky top-0 z-10 bg-white py-1.5 px-1 text-left border-b border-black/10">Cadence</th>
          <th class="sticky top-0 z-10 bg-white py-1.5 px-1 text-right border-b border-black/10">Per week</th>
          <th class="sticky top-0 z-10 bg-white py-1.5 px-1 text-left border-b border-black/10">Starting</th>
          <th class="sticky top-0 z-10 bg-white py-1.5 px-1 text-left border-b border-black/10">Ends (optional)</th>
          <th class="sticky top-0 z-10 bg-white py-1.5 px-1 text-right border-b border-black/10">Source</th>
          <th class="sticky top-0 z-10 bg-white py-1.5 border-b border-black/10"></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="9" class="py-4 text-black/40">No overhead items.</td></tr>`}</tbody>
      </table>
      <datalist id="ovCatList">${catList.map(c => `<option value="${escapeHtml(c)}"></option>`).join("")}</datalist>
      ${delSection}`;
    ovBody.querySelectorAll("[data-ov] [data-f]").forEach(el => {
      el.addEventListener("change", async () => {
        const id = el.closest("[data-ov]").getAttribute("data-ov");
        const field = el.getAttribute("data-f");
        let val = el.value;
        if (field === "amount") val = parseFloat(val) || 0;
        if ((field === "anchor_date" || field === "end_date") && !val) val = null;
        try { await api(`/cashflow/overhead/${id}`, { method: "PATCH", body: JSON.stringify({ [field]: val }) }); ovDirty = true; renderOverhead(); }
        catch (e) { alert("Failed to save: " + (e.message || e)); }
      });
    });
    ovBody.querySelectorAll("[data-ov-del]").forEach(b => b.addEventListener("click", async () => {
      await api(`/cashflow/overhead/${b.getAttribute("data-ov-del")}`, { method: "DELETE" });
      ovDirty = true; renderOverhead();
    }));
    ovBody.querySelectorAll("[data-ov-revert]").forEach(b => b.addEventListener("click", async () => {
      try { await api(`/cashflow/overhead/${b.getAttribute("data-ov-revert")}/revert`, { method: "POST" }); ovDirty = true; renderOverhead(); }
      catch (e) { alert("Failed to revert: " + (e.message || e)); }
    }));
    ovBody.querySelectorAll("[data-ov-restore]").forEach(b => b.addEventListener("click", async () => {
      try { await api(`/cashflow/overhead/${b.getAttribute("data-ov-restore")}/restore`, { method: "POST" }); ovDirty = true; renderOverhead(); }
      catch (e) { alert("Failed to restore: " + (e.message || e)); }
    }));
    ovBody.querySelectorAll("[data-ovcat-head]").forEach(h => h.addEventListener("click", (e) => {
      if (e.target.closest("[data-ov-catadd]")) return;   // the "+ add" button handles its own click
      const c = h.getAttribute("data-ovcat-head");
      const willCollapse = !ovCollapsed.has(c);
      if (willCollapse) ovCollapsed.add(c); else ovCollapsed.delete(c);
      const chev = h.querySelector("[data-chev]"); if (chev) chev.textContent = willCollapse ? "▸" : "▾";
      ovBody.querySelectorAll(`[data-ovcat="${c}"]`).forEach(r => {
        if (r.hasAttribute("data-histrow")) r.hidden = true;   // history sub-rows stay closed
        else r.hidden = willCollapse;
      });
    }));
    ovBody.querySelectorAll("[data-ov-catadd]").forEach(b => b.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await api("/cashflow/overhead", { method: "POST", body: JSON.stringify({ name: "New item", category: b.getAttribute("data-ov-catadd"), amount: 0, cadence: "monthly", anchor_date: (startEl.value || new Date().toISOString().slice(0, 10)) }) });
        ovDirty = true; renderOverhead();
      } catch (err) { alert("Failed to add: " + (err.message || err)); }
    }));
    const fmtChange = (h) => {
      const parts = [];
      if (h.old_amount != null || h.new_amount != null) {
        const a = money0(h.old_amount), b = money0(h.new_amount);
        if (a !== b) parts.push(`${a} → ${b}`);
      }
      if (h.old_cadence !== h.new_cadence && (h.old_cadence || h.new_cadence)) parts.push(`${h.old_cadence || "—"} → ${h.new_cadence || "—"}`);
      const od = (h.old_anchor_date || "").slice(0, 10), nd = (h.new_anchor_date || "").slice(0, 10);
      if (od !== nd && (od || nd)) parts.push(`starts ${od || "—"} → ${nd || "—"}`);
      return parts.join(" · ") || "(no field change)";
    };
    ovBody.querySelectorAll("[data-ov-hist]").forEach(b => b.addEventListener("click", async () => {
      const id = b.getAttribute("data-ov-hist");
      const row = ovBody.querySelector(`[data-ov-hist-row="${id}"]`);
      if (!row) return;
      if (!row.hidden) { row.hidden = true; return; }
      const cell = row.querySelector("td");
      cell.innerHTML = `<div class="text-[11px] text-black/40">Loading history…</div>`;
      row.hidden = false;
      try {
        const { history } = await api(`/cashflow/overhead/${id}/history`);
        if (!history || !history.length) { cell.innerHTML = `<div class="text-[11px] text-black/40">No changes yet — still the auto-generated value.</div>`; return; }
        cell.innerHTML = `<div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Change history</div>` +
          history.map(h => `<div class="flex items-baseline gap-2 text-[11.5px] py-0.5 border-b border-black/[0.05] last:border-0">
            <span class="text-[9px] font-bold uppercase tracking-wide px-1 py-px rounded ${h.action === "revert" ? "bg-blue-50 text-blue-700" : h.action === "delete" ? "bg-red-50 text-red-700" : h.action === "create" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}">${escapeHtml(h.action)}</span>
            <span class="text-black/70">${escapeHtml(fmtChange(h))}</span>
            <span class="ml-auto text-black/40 whitespace-nowrap">${escapeHtml(h.actor || "—")} · ${h.created_at ? new Date(h.created_at + "Z").toLocaleString() : ""}</span>
          </div>`).join("");
      } catch (e) { cell.innerHTML = `<div class="text-[11px] text-red-700">Failed to load history: ${escapeHtml(e.message || e)}</div>`; }
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

  // (The old "Categories" exclusion modal was removed — the Overhead editor and
  //  the editable Recurring cash-outflow rows cover that need now.)

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
