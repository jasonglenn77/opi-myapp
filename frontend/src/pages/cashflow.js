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
        <label id="cfCountPlansWrap" class="cfx-chk hidden" title="Planned invoices / crew payments / expenses whose dates already passed without being invoiced, paid or spent. Off: listed for follow-up but not counted. On: counted in week 1.">
          <input id="cfCountPlans" type="checkbox"> Count overdue plans in week 1
        </label>
        <button id="cfGenerate" class="btn-primary py-2">Generate</button>
        <button id="cfOverhead" class="hidden px-3 py-2 rounded-xl text-sm font-semibold border border-black/15 hover:bg-black/5">Overhead</button>
        <button id="cfRecon" type="button" title="Why this forecast differs from OPI's B250 cash-flow sheet, and what needs fixing" class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl border border-black/15 px-3 text-sm font-semibold text-black/70 hover:bg-black/5">
          <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 4v16M17 4v16M3 8h8M13 16h8" stroke-linecap="round"/></svg>Compare with B250
        </button>
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
          <p>This page shows cash two ways, switched at the top left: <span class="font-semibold text-ink-900">Forecast</span> (what's coming) and <span class="font-semibold text-ink-900">Actuals</span> (what already happened). <span class="font-semibold text-ink-900">Compare with B250</span> lines the forecast up against OPI's own 13-week cash sheet and explains every difference.</p>

          <div>
            <div class="font-bold text-ink-900">How the Forecast builds each week</div>
            <p class="text-black/60">It starts from the opening cash balance, then each week: <span class="font-semibold">opening + cash in − cash out = ending</span>, and the next week opens where the last one ended. Pick 13, 26 or 52 weeks, or type any number.</p>
          </div>

          <div>
            <div class="font-bold text-ink-900">Opening balance</div>
            <p class="text-black/60">Chosen under <span class="font-semibold">Opening balance source</span> (saved for everyone): the <span class="font-semibold">bank balance typed on OPI's B250</span> (the default for now), or the <span class="font-semibold">QuickBooks books</span> for the ticked bank accounts. QuickBooks shows the bank's own balance on its screen but doesn't share it with outside apps, and its books are currently higher than the bank, mainly because customer payments were never matched to deposits. Once the books are reconciled, switch to the books. Typing an opening number at the top overrides either, for a scenario.</p>
          </div>

          <div>
            <div class="font-bold text-ink-900">What the lines mean, and where each number comes from</div>
            <ul class="list-disc ml-5 mt-1 space-y-1.5 text-black/60">
              <li><span class="font-semibold text-ink-900">Committed</span> (in QuickBooks): <em>in</em> = open customer invoices, on the expected-paid date if someone set one, otherwise the QuickBooks due date; <em>out</em> = open bills, on their due date.</li>
              <li><span class="font-semibold text-ink-900">Scheduled</span> (planned on each project's <span class="font-semibold">Billing &amp; Schedule</span> tab, not yet in QuickBooks):
                <ul class="ml-5 mt-1 space-y-1" style="list-style:circle">
                  <li>Invoices to send: each estimate's billing terms placed on the Job Schedule dates.</li>
                  <li>Crew pay: the job's Payment Schedule sheet from Google Drive (updated nightly), or an even split of the estimate's labor when there's no sheet. Paid on the every-other-Friday payroll calendar.</li>
                  <li>Project expenses: each estimate cost category (rentals, lodging, materials…) spread the way those bills have actually landed on past jobs, and paid after the usual bill-to-payment time. The numbers behind this are on the <a href="#/assumptions" class="text-brand-700 font-semibold hover:underline">Assumptions</a> page.</li>
                </ul>
                Each project's plan burns down as QuickBooks invoices, bills and payments arrive, so only what's left shows here. Fix a project's schedule and the forecast follows.</li>
              <li><span class="font-semibold text-ink-900">Recurring</span> (estimated): overhead and payroll. Most lines are each account's trailing 12-month QuickBooks spend at the cadence it posts, refreshed on every sync. A few lines have no QuickBooks source and keep the value typed on OPI's B250 (W-2 wages, bonus/commission, Hotel Engine, Chase card); they're tagged <span class="text-[9px] font-bold uppercase tracking-wide text-rose-700 bg-rose-50 border border-rose-200 rounded px-1 py-px">B250 · no source</span> and listed on Data Review.</li>
            </ul>
          </div>

          <div>
            <div class="font-bold text-ink-900">Reading the grid</div>
            <ul class="list-disc ml-5 mt-1 space-y-1.5 text-black/60">
              <li><span class="font-semibold text-ink-900">Confidence dots</span>: committed (in QuickBooks), scheduled (planned), estimated (run-rate).</li>
              <li><span class="font-semibold text-ink-900">Overdue — expected date passed</span>: open invoices and bills whose date passed are counted in <span class="font-semibold">week 1</span> on a flagged row. Crew payments whose date passed are checked against the crew's QuickBooks payments and dropped when paid. Planned invoices, crew payments and expenses whose date passed are listed but <span class="font-semibold">not counted</span> until they get a new date (tick "Count overdue plans in week 1" to count them). The list above the grid says where each date comes from.</li>
              <li><span class="font-semibold text-ink-900">Won — not scheduled</span>: won projects with no Job Schedule dates. Their cash stays out of the weekly balance until they're dated.</li>
              <li><span class="font-semibold text-ink-900">Drill in</span>: expand any section; use <span class="font-semibold">⇄</span> to switch views (by vendor / project / type / item); click a project to open its Billing &amp; Schedule tab. Sections you open stay open when the page refreshes in the background.</li>
              <li><span class="font-semibold text-ink-900">What-if</span>: expand Recurring and type into a weekly cell to see the balance change. Nothing is saved; <span class="font-semibold">Reset to actual</span> undoes it.</li>
              <li>For crew pay and project expenses across every project by week, see <a href="#/money" class="text-brand-700 font-semibold hover:underline">Project Money</a>.</li>
            </ul>
          </div>

          <div>
            <div class="font-bold text-ink-900">The Overhead editor</div>
            <p class="text-black/60">The <span class="font-semibold">Overhead</span> button lists every recurring line by category with a per-week figure and totals. Add, edit or delete lines; changes show in the forecast right away. Each line is tagged by where its number comes from:</p>
            <ul class="list-disc ml-5 mt-1 space-y-1.5 text-black/60">
              <li><span class="text-[10px] font-bold uppercase tracking-wide text-black/40 border border-black/15 rounded px-1 py-px">auto</span>: from QuickBooks (trailing 12 months), refreshed on every sync.</li>
              <li><span class="text-[10px] font-bold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-px">edited</span>: a QuickBooks line someone adjusted; <span class="font-semibold">↺</span> goes back to the QuickBooks figure.</li>
              <li><span class="text-[9px] font-bold uppercase tracking-wide text-rose-700 bg-rose-50 border border-rose-200 rounded px-1 py-px">B250 · no source</span>: copied from OPI's B250 because no system of record has it yet.</li>
              <li><span class="text-[10px] font-bold uppercase tracking-wide text-indigo-700 bg-indigo-100 border border-indigo-200 rounded px-1 py-px">manual</span>: entered in the app by hand.</li>
            </ul>
            <p class="text-black/60 mt-1.5">Deleted lines stay deleted until restored, and <span class="font-semibold">history</span> shows every change.</p>
          </div>

          <div>
            <div class="font-bold text-ink-900">Actuals</div>
            <p class="text-black/60">Same layout for a past date range: customer payments received <em>in</em>; bill payments and card/check spend <em>out</em>, by the week the cash moved. Lines with no QuickBooks source (W-2 wages, bonus) have no actuals to show.</p>
          </div>

          <div>
            <div class="font-bold text-ink-900">Where the numbers come from</div>
            <p class="text-black/60">QuickBooks data synced into the app every night (invoices, bills, payments, deposits, bank and card accounts), plus OPI's Google Drive sheets read the same night (Job Schedule, crew Payment Schedules, B250). Opening this page never calls QuickBooks. To pull the latest, run <span class="font-semibold">Sync transactions now</span> on the QuickBooks page.</p>
          </div>
        </div>
      </div>
    </div>

    <div id="cfReconModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 flex flex-col" style="width:100%;max-width:64rem;max-height:90vh;overflow:hidden;">
        <div class="flex items-start justify-between gap-3 mb-2">
          <div>
            <div class="text-lg font-extrabold">Why the app's cash flow differs from OPI's B250</div>
            <div id="cfReconSub" class="text-xs text-black/50"></div>
          </div>
          <button id="cfReconClose" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>
        <div id="cfReconBody" class="overflow-y-auto pr-1 text-sm" style="min-height:0;">Loading…</div>
      </div>
    </div>

    <div id="cfBacklogModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 flex flex-col" style="width:100%;max-width:56rem;max-height:85vh;overflow:hidden;">
        <div class="flex items-center justify-between mb-1">
          <div class="text-lg font-extrabold">Won — not scheduled (needs dates on the Job Schedule)</div>
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

    <div id="cfBank" class="mb-4"></div>

    <div id="cfKpis" class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4"></div>

    <div id="cfAlerts" class="cfx-alerts"></div>

    <div class="card p-0" style="overflow:clip">
      <div id="cfHead" class="hidden" style="position:sticky;top:0;z-index:6;overflow:hidden;background:#fff;border-bottom:1px solid rgba(0,0,0,.1);box-shadow:0 2px 4px -2px rgba(0,0,0,.08)"></div>
      <div id="cfScroll" class="overflow-x-auto" style="overflow-y:visible">
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
  // The grid shows at full height (the page scrolls, not the card); it only
  // scrolls sideways for long horizons. A sideways-scrolling box can't pin its
  // own header to the page, so the week-date row is copied into #cfHead, which
  // sticks to the top of the window while the page scrolls and follows the
  // grid's sideways scroll. Its column widths are measured from the grid.
  const headEl = document.getElementById("cfHead");
  const scrollEl = document.getElementById("cfScroll");
  scrollEl.addEventListener("scroll", () => { headEl.scrollLeft = scrollEl.scrollLeft; }, { passive: true });
  function syncHead() {
    const table = grid.querySelector("table");
    const head = table && table.tHead && table.tHead.rows[0];
    if (!head) { headEl.classList.add("hidden"); headEl.innerHTML = ""; return; }
    const widths = [...head.cells].map((c) => c.getBoundingClientRect().width);
    const clone = head.cloneNode(true);
    [...clone.cells].forEach((c, i) => {
      c.style.width = c.style.minWidth = c.style.maxWidth = `${widths[i]}px`;
      c.style.position = i === 0 ? "sticky" : "static";
      c.style.top = "";
    });
    // same left offset as the grid's table (the grid has padding around it)
    const offset = table.getBoundingClientRect().left - scrollEl.getBoundingClientRect().left + scrollEl.scrollLeft;
    headEl.innerHTML = `<table class="text-sm" style="border-collapse:separate;border-spacing:0;table-layout:fixed;margin-left:${offset}px;width:${table.getBoundingClientRect().width}px"><thead></thead></table>`;
    headEl.querySelector("thead").appendChild(clone);
    head.style.visibility = "collapse";          // the pinned copy replaces it
    headEl.classList.remove("hidden");
    headEl.style.top = `${document.getElementById("topBar")?.getBoundingClientRect().height || 0}px`;  // pin below the app's top bar
    headEl.scrollLeft = scrollEl.scrollLeft;
  }
  window.addEventListener("resize", () => { const h = grid.querySelector("table")?.tHead?.rows[0]; if (h) h.style.visibility = ""; syncHead(); });
  const kpis = document.getElementById("cfKpis");
  const modeDesc = document.getElementById("cfModeDesc");
  const btnV2 = document.getElementById("cfModeV2");
  const btnActuals = document.getElementById("cfModeActuals");
  const horizonWrap = document.getElementById("cfHorizon");
  const horizonWeeks = document.getElementById("cfHorizonWeeks");

  let lastBacklog = null; // most recent Forecast backlog, for the drill-down modal
  // Which grid sections are expanded / which view (⇄) each shows — kept across
  // re-renders so a background refresh doesn't collapse what you opened.
  const expanded = new Set(), viewOf = {};

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
    const flagRow = (r, view = "", group = "") => {
      const memo = r.flag === "memo";
      return `<tr class="cfx-flagrow ${memo ? "cfx-memo" : ""}"${view ? ` data-flagview="${view}" data-flaggroup="${group}"` : ""}${view === "b" ? ` style="display:none"` : ""}>
        <td class="py-1 pr-3 whitespace-nowrap" style="${STICKY}padding-left:2.25rem"><button type="button" data-cf-overdue class="cfx-flaglink" title="${memo ? "Not counted in the totals — open the follow-up list" : "Counted in week 1 — open the follow-up list"}">${escapeHtml(r.label)}</button></td>
        ${pdCell(0)}${r.weekly.map((v) => `<td class="px-2 py-1 text-right whitespace-nowrap" style="font-variant-numeric:tabular-nums">${v ? (memo ? `<span class="cfx-memo-amt">(${Math.round(v).toLocaleString("en-US")})</span>` : cell(v)) : `<span class="text-black/20">–</span>`}</td>`).join("")}</tr>`;
    };
    const detailV2 = (rows, group, view = "", editable = false) => rows.filter(r => !r.flag).map(r => {
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
      // flagged overdue rows stay visible (not hidden behind the chevron)
      const flagsA = (s.rows || []).filter(r => r.flag).map(r => flagRow(r, hasAlt ? "a" : "", group)).join("");
      const flagsB = hasAlt ? (s.alt_rows || []).filter(r => r.flag).map(r => flagRow(r, "b", group)).join("") : "";
      return `<tr>${label}${pdCell(s.pastdue || 0)}${totalCells}</tr>` + flagsA + flagsB + detA + detB;
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
           <b class="text-amber-800">Won — not scheduled</b> · ${bk.count || 0} project${bk.count === 1 ? "" : "s"}
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
      ${hasPD ? `<div class="text-[11px] text-black/45 mt-2 px-1">The <b>Past due</b> column holds cash dated before the current week — overdue invoices to collect and bills/crew/expenses to catch up on — so each week shows only its own dates. It settles off your opening balance; week 1 opens at its result.</div>` : ""}
      ${!isActuals ? `<div class="text-[11px] text-black/45 mt-2 px-1">Week 1 opens at your bank balance — nothing is settled into it. <span class="cfx-legend-od"></span> rows are overdue items (expected date passed) counted in week 1; <span class="cfx-memo-amt">(amounts)</span> are overdue plans shown for follow-up but <b>not counted</b>.</div>` : ""}`;
    // expand/collapse + view-toggle (by vendor/project or project/type). Detail
    // rows carry data-view; only the current view shows when a group is expanded.
    // expanding can widen the label column: re-measure the pinned header
    const resyncHead = () => { const h = grid.querySelector("table")?.tHead?.rows[0]; if (h) h.style.visibility = ""; requestAnimationFrame(syncHead); };
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
      resyncHead();
    }));
    grid.querySelectorAll("[data-view-toggle]").forEach(btn => btn.addEventListener("click", () => {
      const g = btn.getAttribute("data-view-toggle");
      viewOf[g] = (viewOf[g] === "b") ? "a" : "b";
      btn.textContent = (viewOf[g] === "b" ? btn.dataset.vb : btn.dataset.va) + " ⇄";
      applyDetail(g);
      resyncHead();
      grid.querySelectorAll(`[data-flaggroup="${g}"]`).forEach(r => { r.style.display = r.dataset.flagview === (viewOf[g] || "a") ? "table-row" : "none"; });
      if (g === recGroup) recomputeWhatIf();  // what-if follows the visible recurring view
    }));
    const rb = grid.querySelector("[data-cf-refresh]");
    if (rb) rb.addEventListener("click", refreshSchedules);
    const bb = grid.querySelector("[data-cf-backlog]");
    if (bb) bb.addEventListener("click", openBacklog);
    grid.querySelectorAll("[data-cf-overdue]").forEach(b => b.addEventListener("click", () => {
      const od = document.getElementById("cfOverdueBox");
      if (od) { od.open = true; od.scrollIntoView({ behavior: "smooth", block: "start" }); }
    }));
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
    // re-open what was expanded before this render (background refreshes re-render)
    [...expanded].forEach((g) => {
      const btn = grid.querySelector(`[data-toggle="${g}"]`);
      if (!btn) { expanded.delete(g); return; }
      btn.textContent = "▾";
      if (viewOf[g] === "b") {
        const vt = grid.querySelector(`[data-view-toggle="${g}"]`);
        if (vt) vt.textContent = vt.dataset.vb + " ⇄";
        grid.querySelectorAll(`[data-flaggroup="${g}"]`).forEach(r => { r.style.display = r.dataset.flagview === "b" ? "table-row" : "none"; });
      }
      applyDetail(g);
    });
    requestAnimationFrame(syncHead);
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

  // ── Opening balance source: QBO Bank accounts, include/exclude (persisted) ──
  const bankEl = document.getElementById("cfBank");
  const countPlansEl = document.getElementById("cfCountPlans");
  countPlansEl.addEventListener("change", () => load());
  const fmtWhen = (iso, utc = false) => {
    if (!iso) return "—";
    const d = new Date(utc && !/Z|[+-]\d\d:?\d\d$/.test(iso) ? iso + "Z" : iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: "numeric", day: "numeric", year: "2-digit", hour: "numeric", minute: "2-digit" });
  };
  const mdY = (iso) => { if (!iso) return "—"; const [y, m, dd] = String(iso).slice(0, 10).split("-"); return `${+m}/${+dd}/${y.slice(2)}`; };
  let bankOpen = null;  // remember the panel's open state across re-renders
  function renderBank(b) {
    if (!b || !b.available) {
      bankEl.innerHTML = `<div class="card px-4 py-3 text-[12px] text-black/50">Opening balance: sync the QuickBooks chart of accounts to see your bank accounts.</div>`;
      return;
    }
    const dups = b.duplicate_warnings || [];
    if (bankOpen === null) bankOpen = dups.length > 0;
    const dupBadge = dups.map(w => `<span class="cfx-dup" title="${escapeHtml(w.accounts.join(" and "))} share bank number ${escapeHtml(w.key)} — ${w.included.length > 1 ? "BOTH are counted; untick the one that isn't real cash" : "only one is counted"}">⚠ ${w.accounts.length} accounts share ${escapeHtml(w.key)}${w.included.length > 1 ? " · both counted" : ""}</span>`).join(" ");
    const rows = (b.accounts || []).map(a => `
      <tr class="${a.included ? "" : "cfx-bank-off"}">
        <td class="cfx-bank-chk"><input type="checkbox" data-bank="${escapeHtml(a.qbo_id)}" ${a.included ? "checked" : ""} aria-label="Include ${escapeHtml(a.name)}"></td>
        <td><div class="font-semibold text-ink-900">${escapeHtml(a.name)} ${a.duplicate_of ? `<span class="cfx-dup cfx-dup-sm" title="Same bank number as ${escapeHtml(a.duplicate_of.join(", "))}">⚠ same #</span>` : ""}${a.active ? "" : ` <span class="text-[10px] text-black/40">(inactive in QBO)</span>`}</div>
            <div class="text-[10.5px] text-black/45">${escapeHtml(a.sub_type || "Bank")}${a.created_in_qbo ? ` · created in QBO ${mdY(a.created_in_qbo)}` : ""}${a.chosen ? "" : " · default"}</div></td>
        <td class="text-right tabular-nums font-semibold">${fmtMoney(a.balance)}</td>
        <td class="text-right text-black/55 whitespace-nowrap">${fmtWhen(a.balance_as_of)}</td>
      </tr>`).join("");
    bankEl.innerHTML = `
      <details class="card p-0 overflow-hidden cfx-bank" ${bankOpen ? "open" : ""}>
        <summary class="cfx-bank-sum">
          <svg class="cfx-chev" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
          <span class="text-sm font-bold text-ink-900">Opening balance source</span>
          <span class="text-[12px] text-black/55">${b.source === "b250"
            ? `Bank balance from the B250 · <b class="text-ink-900">${fmtMoney(b.balance)}</b> <span class="text-black/40">(QuickBooks books ${fmtMoney(b.books_balance)})</span>`
            : `${b.included_count} of ${(b.accounts || []).length} QuickBooks bank accounts (books) · <b class="text-ink-900">${fmtMoney(b.balance)}</b>`}</span>
          ${dupBadge}
          <span class="cfx-bank-sync">Last synced ${fmtWhen(b.last_synced, true)}</span>
        </summary>
        <div class="cfx-bank-body">
          <div class="flex flex-wrap items-center gap-2 mb-3 text-[12.5px]">
            <span class="font-semibold text-black/70">Start week 1 from:</span>
            <label class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border ${b.source === "b250" ? "border-ink-900 bg-black/[0.04]" : "border-black/15"} ${b.b250 ? "cursor-pointer" : "opacity-50"}">
              <input type="radio" name="cfOpenSrc" value="b250" ${b.source === "b250" ? "checked" : ""} ${b.b250 ? "" : "disabled"}>
              Bank balance from the B250 <b>${b.b250 ? fmtMoney(b.b250.balance) : "—"}</b>${b.b250 ? ` <span class="text-black/40">tab "${escapeHtml(b.b250.tab || "")}", ${fmtWhen(b.b250.as_of)}</span>` : ""}
            </label>
            <label class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border ${b.source === "qbo" ? "border-ink-900 bg-black/[0.04]" : "border-black/15"} cursor-pointer">
              <input type="radio" name="cfOpenSrc" value="qbo" ${b.source === "qbo" ? "checked" : ""}>
              QuickBooks books <b>${fmtMoney(b.books_balance)}</b> <span class="text-black/40">(accounts ticked below)</span>
            </label>
          </div>
          ${b.b250 && Math.abs(b.books_balance - b.b250.balance) > 1 ? `<div class="text-[11.5px] text-black/55 mb-3">The books are <b>${fmtMoney(b.books_balance - b.b250.balance)}</b> ${b.books_balance > b.b250.balance ? "above" : "below"} the bank. QuickBooks doesn't share the bank's own balance with outside apps, so the B250's typed bank balance is used until the books are reconciled (Compare with B250 explains the gap). Typing an opening balance above still overrides either.</div>` : ""}
          <div class="overflow-x-auto"><table class="cfx-bank-tbl">
            <thead><tr><th></th><th>QuickBooks bank account</th><th class="text-right">Balance</th><th class="text-right">Balance as of</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
          <div class="text-[11px] text-black/45 mt-2">Opening cash = the ticked accounts (QuickBooks balances, pulled nightly with transactions). Your choice is saved for everyone. “Balance as of” = when QuickBooks last changed the account.</div>
        </div>
      </details>`;
    bankEl.querySelector("details").addEventListener("toggle", (e) => { bankOpen = e.target.open; });
    bankEl.querySelectorAll('input[name="cfOpenSrc"]').forEach((r) => r.addEventListener("change", async () => {
      try {
        const nb = await api("/cashflow/opening-source", { method: "PUT", body: JSON.stringify({ source: r.value }) });
        openingEl.value = Math.round(nb.balance);
        balSource.textContent = "";
        renderBank(nb);
        load();
      } catch (err) { alert("Save failed: " + (err?.message || "error")); }
    }));
    bankEl.querySelectorAll("[data-bank]").forEach(cb => cb.addEventListener("change", async () => {
      cb.disabled = true;
      try {
        const nb = await api("/cashflow/bank-accounts", { method: "PUT", body: JSON.stringify({ included: { [cb.getAttribute("data-bank")]: cb.checked } }) });
        openingEl.value = Math.round(nb.balance);
        balSource.textContent = "";
        renderBank(nb);
        load();
      } catch (err) { cb.disabled = false; cb.checked = !cb.checked; alert("Save failed: " + (err?.message || "error")); }
    }));
  }

  // ── Alerts above the grid: Won — not scheduled + Overdue follow-up ──
  const alertsEl = document.getElementById("cfAlerts");
  let odOpen = false, unOpen = false;
  function renderAlerts(d) {
    const bk = d.backlog || {};
    const projs = bk.projects || [];
    const od = d.overdue || { items: [] };
    const projLink = (id, name) => id
      ? `<a href="#/entity/project/${escapeHtml(String(id))}" data-cf-proj class="text-blue-700 hover:underline font-semibold">${escapeHtml(name || id)}</a>`
      : escapeHtml(name || "—");
    let html = "";
    if (projs.length) {
      const rows = projs.map(p => `<tr>
          <td>${projLink(p.entity_id, p.name)}<div class="text-[10px] text-black/40">${escapeHtml(p.status || "")}${p.start_date ? ` · start ${mdY(p.start_date)}, no end` : " · no dates"}</div></td>
          <td class="text-right tabular-nums font-semibold text-emerald-700">${fmtMoney(p.to_bill)}</td>
          <td class="text-right tabular-nums text-black/60">${p.ar > 0.5 ? fmtMoney(p.ar) : "–"}</td>
          <td class="text-right tabular-nums text-red-600">${p.out > 0.5 ? fmtMoney(p.out) : "–"}</td>
        </tr>`).join("");
      html += `<details class="cfx-alert cfx-alert-amber" id="cfUnschedBox" ${unOpen ? "open" : ""}>
        <summary><svg class="cfx-chev" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
          <span class="cfx-alert-ico">!</span>
          <span><b>Won — not scheduled</b> (needs dates on the Job Schedule) · ${projs.length} project${projs.length === 1 ? "" : "s"} · <b>${fmtMoney(bk.in || 0)}</b> unbilled <span class="cfx-alert-sub">— not in the weekly balance until dated</span></span>
        </summary>
        <div class="cfx-alert-body"><div class="overflow-x-auto"><table class="cfx-tbl">
          <thead><tr><th>Project</th><th class="text-right">Unbilled (to bill)</th><th class="text-right">Sent A/R</th><th class="text-right">Est. cost out</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
          <div class="text-[11px] text-black/45 mt-2">Add start + end dates on the project's Assignment / Job Schedule and its invoice, crew and expense schedules generate and join the forecast. Sent A/R is already on the grid by its expected-paid date.</div>
        </div></details>`;
    }
    const items = od.items || [];
    const cm = od.crew_matched_paid || { count: 0, amount: 0, items: [] };
    if (items.length || cm.count) {
      const counted = items.filter(i => i.counted), memo = items.filter(i => !i.counted);
      const sum = (a) => a.reduce((s, i) => s + (i.amount || 0), 0);
      const row = (i) => `<tr class="${i.counted ? "" : "cfx-memo-row"}">
          <td><div class="font-semibold">${escapeHtml(i.type)}</div>${i.detail ? `<div class="text-[10.5px] text-black/45">${escapeHtml(i.detail)}</div>` : ""}</td>
          <td>${i.is_project && i.link_id ? projLink(i.link_id, i.label) : escapeHtml(i.label || "—")}${i.project && i.kind === "ap" ? `<div class="text-[10.5px] text-black/45">${escapeHtml(i.project)}</div>` : ""}</td>
          <td class="tabular-nums">${escapeHtml(i.doc || "")}</td>
          <td class="tabular-nums">${mdY(i.sent)}</td>
          <td class="tabular-nums">${mdY(i.due)}</td>
          <td class="tabular-nums">${i.kind === "ar" && i.qbo_id
            ? `<input type="date" class="cfx-date" data-qinv="${escapeHtml(i.qbo_id)}" value="${escapeHtml(i.expected || "")}" title="Expected paid date — saved on the invoice (app only, never written to QuickBooks)">`
            : mdY(i.expected || (i.kind !== "ar" && i.kind !== "ap" ? i.date : null))}</td>
          <td class="text-right tabular-nums">${i.days_late != null ? i.days_late : ""}</td>
          <td class="text-right tabular-nums font-semibold">${fmtMoney(i.amount)}</td>
          <td class="text-right"><span class="cfx-pill ${i.counted ? "cfx-pill-on" : "cfx-pill-off"}" title="${i.counted ? "Counted as cash in/out in week 1 of the forecast" : "Shown for follow-up only; not in the totals until it gets a new date"}">${i.counted ? "counted in week 1" : "not counted"}</span></td>
        </tr>`;
      const crewRows = (cm.items || []).slice(0, 400).map(c => `<tr>
          <td>${projLink(c.link_id, c.project)}</td><td>${escapeHtml(c.crew || "—")}</td>
          <td class="tabular-nums">${mdY(c.send_invoice_date)}</td><td class="tabular-nums">${mdY(c.pay_date)}</td>
          <td class="text-right tabular-nums">${fmtMoney(c.amount)}</td>
          <td class="tabular-nums text-black/55">${(c.matched || []).map(m => `${mdY(m.date)} ${fmtMoney(m.amount)}`).join(", ")}</td></tr>`).join("");
      html += `<details class="cfx-alert cfx-alert-red" id="cfOverdueBox" ${odOpen ? "open" : ""}>
        <summary><svg class="cfx-chev" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
          <span class="cfx-alert-ico">!</span>
          <span><b>Overdue — expected date passed</b> · follow up ·
            <b>${fmtMoney(sum(counted))}</b> counted in week 1 (${counted.length})
            ${memo.length ? ` · <b>${fmtMoney(sum(memo))}</b> plans not counted (${memo.length})` : ""}
            ${cm.count ? ` <span class="cfx-alert-sub">· ${cm.count} crew payments (${fmtMoney(cm.amount)}) matched to QuickBooks as paid</span>` : ""}</span>
        </summary>
        <div class="cfx-alert-body">
          <ul class="text-[11.5px] text-black/55 mb-2 space-y-0.5 list-disc ml-4">
            <li><b>Invoice sent — not paid</b>: a real QuickBooks invoice. Sent and Due are the invoice's own dates in QuickBooks; Expected is a date someone set (blank = the due date). Counted as cash in, in week 1.</li>
            <li><b>Bill past due — pay now</b>: a real QuickBooks bill. Bill date and Due are from QuickBooks. Counted as cash out, in week 1.</li>
            <li><b>Planned invoice — date passed, not invoiced</b> (grey): a milestone on the project's billing schedule (Billing &amp; Schedule tab, built from the estimate's terms and the Job Schedule dates) with no matching QuickBooks invoice yet. Either it was billed under an invoice the app couldn't match, the job's dates or terms changed, or it really hasn't been sent. Fix the milestone date or link the invoice on the project.</li>
            <li><b>Crew payment / planned expense — date passed</b> (grey): planned on the project but no matching QuickBooks payment or bill yet.</li>
          </ul>
          <div class="text-[11.5px] text-black/55 mb-2">Nothing here is settled into the opening balance. Open invoices and bills (already in QuickBooks) are counted in week 1; set an invoice's <b>expected paid</b> date to move it. Planned items whose dates passed need a new date on the project's Billing &amp; Schedule tab${od.count_plans ? " — currently <b>counted in week 1</b> (toggle at the top)" : " — they're <b>not counted</b> until re-dated (toggle at the top to count them)"}.</div>
          <div class="overflow-x-auto cfx-scroll"><table class="cfx-tbl">
            <thead><tr><th>What</th><th>Project / customer</th><th>Ref</th><th title="Invoices and bills: the QuickBooks document date. Planned items: the date the project's schedule planned">Sent / bill date</th><th title="Invoices and bills: the QuickBooks due date. Planned invoices: planned send date + payment terms">Due</th><th title="When the cash is expected: a date someone set (on the invoice or its milestone), else the due date">Expected</th><th class="text-right">Days late</th><th class="text-right">Amount</th><th class="text-right">In forecast</th></tr></thead>
            <tbody>${items.map(row).join("") || `<tr><td colspan="9" class="text-black/40">Nothing overdue.</td></tr>`}</tbody>
          </table></div>
          ${cm.count ? `<details class="mt-3"><summary class="cursor-pointer text-[12px] font-semibold text-black/60">Crew installments treated as paid — ${cm.count} matched to the crew's QuickBooks payments (${fmtMoney(cm.amount)})</summary>
            <div class="text-[11px] text-black/45 my-1">Date passed, not tagged to the project in QuickBooks, but the crew vendor was paid on/after the pay date (bi-weekly run) for at least the amount (within $250 / 5%).</div>
            <div class="overflow-x-auto cfx-scroll"><table class="cfx-tbl"><thead><tr><th>Project</th><th>Crew</th><th>Send invoice</th><th>Pay date</th><th class="text-right">Amount</th><th>Matched QBO payment(s)</th></tr></thead><tbody>${crewRows}</tbody></table></div></details>` : ""}
        </div></details>`;
    }
    alertsEl.innerHTML = html;
    const ub = document.getElementById("cfUnschedBox"); if (ub) ub.addEventListener("toggle", () => { unOpen = ub.open; });
    const ob = document.getElementById("cfOverdueBox"); if (ob) ob.addEventListener("toggle", () => { odOpen = ob.open; });
    alertsEl.querySelectorAll("a[data-cf-proj]").forEach(a => a.addEventListener("click", () => {
      try {
        sessionStorage.setItem("opi_entity_tab", "billing");
        const pid = (a.getAttribute("href") || "").split("/").pop();
        if (pid) sessionStorage.setItem("opi_entity_back", JSON.stringify({ entity: "project/" + pid, label: "Cash Flow", hash: "#/cashflow" }));
      } catch (_) {}
    }));
    alertsEl.querySelectorAll("[data-qinv]").forEach(inp => inp.addEventListener("change", async () => {
      inp.disabled = true;
      try {
        await api(`/invoices/qbo-invoice/${encodeURIComponent(inp.getAttribute("data-qinv"))}/expected`, { method: "PATCH", body: JSON.stringify({ expected_paid_date: inp.value || null, via: "cashflow" }) });
        load(true);
      } catch (err) { alert("Save failed: " + (err?.message || "error")); }
      inp.disabled = false;
    }));
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
    btnActuals.className = `px-3 py-1.5 rounded-xl text-sm font-bold border ${mode === "actuals" ? active : "border-black/15"}`;
    weeksWrap.classList.toggle("hidden", mode !== "actuals");
    horizonWrap.classList.toggle("hidden", mode !== "forecast_v2");
    document.getElementById("cfOverhead").classList.toggle("hidden", mode !== "forecast_v2");
    document.getElementById("cfCountPlansWrap").classList.toggle("hidden", mode !== "forecast_v2");
    modeDesc.textContent = mode === "forecast_v2"
      ? "Forward cash from the opening balance: committed (open invoices and bills) + recurring overhead + the scheduled crew, invoice and expense plans on every project. Compare with B250 explains how it differs from OPI's sheet; ⓘ explains how it's built."
      : "Historical realized cash for the chosen range — actual payments in, bill payments + card/check spend out. Tap ⓘ for details.";
  }

  let lastSig = null;  // signature of the last-rendered numbers (skip no-op re-renders)
  async function load(silent = false) {
    // `silent` = a background poll while the cache recomputes: don't blank the
    // grid, and only re-render if the numbers actually changed (no flash).
    if (!silent) grid.innerHTML = `<div class="p-4 text-sm text-black/50">Loading…</div>`;
    if (!silent) syncHead();
    const params = new URLSearchParams();
    const ob = parseFloat(openingEl.value);
    if (!Number.isNaN(ob)) params.set("opening_balance", String(ob));
    if (startEl.value) params.set("start_date", startEl.value);
    if (mode === "actuals") params.set("weeks", String(parseInt(weeksEl.value, 10) || 13));
    if (mode === "forecast_v2") params.set("weeks", String(Math.max(4, Math.min(520, parseInt(horizonWeeks.value, 10) || 26))));
    if (mode === "forecast_v2" && countPlansEl.checked) params.set("count_overdue_plans", "true");
    const endpoint = mode === "actuals" ? "actuals" : "forecast-v2";
    try {
      const d = await api(`/cashflow/${endpoint}?${params.toString()}`);
      const sig = JSON.stringify([d.summary, d.inflow.weekly_totals, d.outflow.weekly_totals,
                                  d.inflow.grand_total, d.outflow.grand_total, d.backlog, d.past_due, d.overdue, d.bank]);
      if (silent && sig === lastSig) {            // nothing changed — no flash
        if (mode === "forecast_v2") schedulePoll(d.cache);
        return;
      }
      lastSig = sig;
      const keepY = window.scrollY;
      renderKpis(d);
      render(d);
      if (mode === "forecast_v2") { schedulePoll(d.cache); renderAlerts(d); if (d.bank) renderBank(d.bank); }
      else { alertsEl.innerHTML = ""; bankEl.innerHTML = ""; }
      if (silent) window.scrollTo(0, keepY);
    } catch (e) {
      kpis.innerHTML = "";
      if (!silent) grid.innerHTML = `<div class="p-4 text-sm text-red-700">Failed to load: ${escapeHtml(e.message || e)}</div>`;
    }
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
      if (i.source === "b250") {
        return `<div class="flex items-center gap-2 justify-end whitespace-nowrap">
          <span class="text-[9px] font-bold uppercase tracking-wide text-rose-700 bg-rose-50 border border-rose-200 rounded px-1 py-px" title="${escapeHtml(i.source_note || "Copied from OPI's B250 cash-flow sheet. No system of record found yet; listed on Data Review → Cash flow sources.")}">B250 · no source</span>
          <button data-ov-hist="${i.id}" class="text-[11px] font-semibold text-black/40 hover:text-black/70">history</button>
        </div>`;
      }
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
    expanded.clear(); Object.keys(viewOf).forEach((k) => delete viewOf[k]);
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

  // ---- Compare with B250: OPI's 13-week cash sheet vs this forecast ----
  // Same weeks on both sides, split into the same groups. The bridge explains
  // the ending-balance gap group by group; each line carries why and the fix.
  const reconModal = document.getElementById("cfReconModal");
  const reconBody = document.getElementById("cfReconBody");
  const reconSub = document.getElementById("cfReconSub");
  const closeRecon = () => { reconModal.classList.add("hidden"); reconModal.classList.remove("flex"); };
  document.getElementById("cfReconClose").addEventListener("click", closeRecon);
  reconModal.addEventListener("click", (e) => { if (e.target === reconModal) closeRecon(); });
  // whole dollars in this panel: it's read in meetings, cents only add noise
  const usd = (v) => `$${Math.round(Math.abs(v || 0)).toLocaleString("en-US")}`;
  const signed = (v) => `${v > 0.5 ? "+" : v < -0.5 ? "−" : ""}${usd(v)}`;

  function balanceChart(r) {
    const W = 860, H = 220, L = 70, R = 16, T = 14, B = 30;
    const a = r.ending.app, b = r.ending.b250.map((v) => v ?? null);
    const vals = [...a, ...b.filter((v) => v != null)];
    let lo = Math.min(0, ...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    const x = (i) => L + (i * (W - L - R)) / Math.max(1, a.length - 1);
    const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
    const path = (arr) => arr.map((v, i) => v == null ? "" : `${i === 0 || arr[i - 1] == null ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const ticks = 4, grid = [];
    for (let t = 0; t <= ticks; t++) {
      const v = lo + ((hi - lo) * t) / ticks;
      grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="rgba(0,0,0,.07)"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="rgba(0,0,0,.45)">${(v / 1e6).toFixed(1)}M</text>`);
    }
    const labels = r.week_ends.map((w, i) => i % 2 === 0 ? `<text x="${x(i)}" y="${H - 10}" text-anchor="middle" font-size="11" fill="rgba(0,0,0,.45)">${+w.slice(5, 7)}/${+w.slice(8)}</text>` : "").join("");
    const end = (arr, color, name) => { const i = arr.length - 1; return arr[i] == null ? "" : `<circle cx="${x(i)}" cy="${y(arr[i])}" r="4" fill="${color}"/><text x="${x(i) - 8}" y="${y(arr[i]) - 9}" text-anchor="end" font-size="12" font-weight="700" fill="${color}">${name} ${usd(arr[i])}</text>`; };
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Ending cash by week, app vs B250">
      ${grid.join("")}${lo < 0 ? `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(0,0,0,.35)"/>` : ""}${labels}
      <path d="${path(b)}" fill="none" stroke="#b45309" stroke-width="2.5" stroke-dasharray="6 4"/>
      <path d="${path(a)}" fill="none" stroke="#1d4ed8" stroke-width="2.5"/>
      ${end(a, "#1d4ed8", "App")}${end(b, "#b45309", "B250")}
    </svg>`;
  }

  function renderRecon(r) {
    if (!r.available) {
      reconBody.innerHTML = `<div class="text-black/55">No copy of the B250 yet. It's read from Google Drive every night, or upload a copy on Data Review → Cash flow sources.</div>`;
      return;
    }
    const wk = r.week_ends;
    reconSub.textContent = `Weeks ending ${mdY(wk[0])} to ${mdY(wk[wk.length - 1])} (${wk.length} weeks) · B250 tab "${r.b250.tab}", ${r.b250.source === "upload" ? "uploaded copy" : "read from Drive"} ${fmtWhen(r.b250.loaded_at)}${r.b250.weeks_skipped ? ` · the B250's first ${r.b250.weeks_skipped === 1 ? "week has" : r.b250.weeks_skipped + " weeks have"} already passed, so the comparison starts at the app's week 1` : ""}`;
    const t = r.totals;
    const head = (label, bv, av, sub = "") => `<div class="rounded-xl border border-black/10 p-3">
      <div class="text-[11px] font-semibold uppercase tracking-wide text-black/45">${label}</div>
      <div class="grid grid-cols-2 gap-2 mt-1 tabular-nums"><div><div class="text-[10px] text-black/40">B250</div><div class="font-bold">${bv == null ? "—" : usd(bv)}</div></div>
        <div><div class="text-[10px] text-black/40">App</div><div class="font-bold">${usd(av)}</div></div></div>
      <div class="text-[11px] mt-1 ${Math.abs(av - (bv || 0)) > 0.5 ? "text-black/60" : "text-emerald-700"}">Difference ${signed(av - (bv || 0))}${sub}</div></div>`;
    const bridge = [
      { label: "Opening cash", b250: r.opening.b250, app: r.opening.app, effect: r.opening.difference, why: r.opening.why, fix: r.opening.fix, key: "opening" },
      ...r.groups.map((g) => ({ ...g, effect: g.cash_effect })),
    ].sort((p, q) => Math.abs(q.effect) - Math.abs(p.effect));
    const row = (g, i) => `<tr class="border-t border-black/[0.06] align-top">
        <td class="py-2 pr-3"><details><summary class="cursor-pointer font-semibold text-ink-900">${escapeHtml(g.label)}${g.direction ? ` <span class="text-[10px] font-normal text-black/40">${g.direction === "in" ? "cash in" : "cash out"}</span>` : ""}</summary>
          <div class="mt-1.5 text-[12.5px] text-black/65"><b class="text-black/75">Why:</b> ${escapeHtml(g.why)}</div>
          <div class="mt-1 text-[12.5px] text-black/65"><b class="text-black/75">Fix:</b> ${escapeHtml(g.fix)}</div></details></td>
        <td class="py-2 px-2 text-right tabular-nums whitespace-nowrap">${g.b250 == null ? "—" : usd(g.b250)}</td>
        <td class="py-2 px-2 text-right tabular-nums whitespace-nowrap">${usd(g.app)}</td>
        <td class="py-2 pl-2 text-right tabular-nums whitespace-nowrap font-bold ${g.effect > 0.5 ? "text-emerald-700" : g.effect < -0.5 ? "text-red-600" : "text-black/40"}">${signed(g.effect)}</td></tr>`;
    const fixes = bridge.filter((g) => Math.abs(g.effect) > 1000 || g.key === "cards");
    reconBody.innerHTML = `
      <p class="text-black/70" style="max-width:52rem">By week ${wk.length} the app ends <b>${signed(r.gap)}</b> ${r.gap >= 0 ? "above" : "below"} the B250. The opening balance accounts for <b>${signed(r.opening.difference)}</b> of that; the rest comes from the lines below. ${Math.abs(r.b250_formula_gap) > 0.5 ? `The last <b>${usd(Math.abs(r.b250_formula_gap))}</b> is a formula error inside the B250: its totals don't add up to its own lines.` : ""}</p>
      <div class="grid gap-2 mt-3" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
        ${head("Opening cash", r.opening.b250, r.opening.app)}
        ${head(`Cash in, ${wk.length} weeks`, t.b250_in, t.app_in)}
        ${head(`Cash out, ${wk.length} weeks`, t.b250_out, t.app_out)}
        ${head(`Ending cash, week ${wk.length}`, t.b250_end, t.app_end)}
      </div>
      <div class="mt-4">
        <div class="flex flex-wrap items-center gap-4 text-[11px] text-black/55"><b class="text-black/70 text-xs">Ending cash by week</b>
          <span class="inline-flex items-center gap-1.5"><span class="inline-block" style="width:18px;height:3px;background:#1d4ed8"></span>App</span>
          <span class="inline-flex items-center gap-1.5"><span class="inline-block" style="width:18px;height:0;border-top:3px dashed #b45309"></span>B250</span></div>
        ${balanceChart(r)}
      </div>
      <h3 class="text-sm font-bold mt-4">What makes up the ${usd(Math.abs(r.gap))} difference</h3>
      <div class="text-[11.5px] text-black/50">Largest first. "Effect" is how each line moves the app's ending cash compared with the B250: more cash in or less cash out shows as +. Click a line for why it differs and what fixes it.</div>
      <div class="overflow-x-auto mt-1"><table class="w-full text-sm">
        <thead><tr class="text-[10px] font-bold uppercase tracking-wide text-black/40 border-b border-black/10">
          <th class="py-2 pr-3 text-left">Line</th><th class="py-2 px-2 text-right">B250</th><th class="py-2 px-2 text-right">App</th><th class="py-2 pl-2 text-right">Effect on ending cash</th></tr></thead>
        <tbody>${bridge.map(row).join("")}
          ${Math.abs(r.b250_formula_gap) > 0.5 ? `<tr class="border-t border-black/[0.06]"><td class="py-2 pr-3"><details><summary class="cursor-pointer font-semibold text-ink-900">B250 formula error</summary><div class="mt-1.5 text-[12.5px] text-black/65">The B250's weekly "Cash Inflow" total (row 10) starts at row 13 and skips the AARS row 12, so its ending balance is lower than its own lines add up to. Fix: start the SUM at row 12 (S1).</div></details></td>
            <td></td><td></td><td class="py-2 pl-2 text-right tabular-nums font-bold ${r.b250_formula_gap > 0 ? "text-emerald-700" : "text-red-600"}">${signed(r.b250_formula_gap)}</td></tr>` : ""}
          <tr class="border-t-2 border-black/15 font-bold"><td class="py-2 pr-3">Total difference in week-${wk.length} ending cash</td><td></td><td></td>
            <td class="py-2 pl-2 text-right tabular-nums">${signed(r.gap)}</td></tr>
        </tbody></table></div>
      <h3 class="text-sm font-bold mt-5">What needs to be addressed</h3>
      <ol class="ml-5 mt-1 space-y-1.5 text-[13px] text-black/70" style="list-style:decimal">
        ${fixes.map((g) => `<li><b class="text-ink-900">${escapeHtml(g.label)}</b> (${signed(g.effect)}): ${escapeHtml(g.fix)}</li>`).join("")}
        <li><b class="text-ink-900">B250 formula</b>: start the inflow SUM on row 10 at row 12 (S1).</li>
      </ol>
      <div class="text-[12px] text-black/55 mt-2">${r.data_review_open != null ? `<b>${r.data_review_open}</b> open items on <a href="#/review" class="text-brand-700 font-semibold hover:underline">Data Review → Cash flow sources</a> list each difference line by line (invoice, crew, payday). ` : ""}The codes in brackets (B1, I4, C2…) match the "OPI Records Review" questions doc.</div>
      <h3 class="text-sm font-bold mt-5">About the B151</h3>
      <p class="text-[13px] text-black/70 mt-1" style="max-width:52rem">${escapeHtml(r.b151.summary)}</p>
      <ul class="ml-5 mt-1 space-y-1 text-[13px] text-black/65" style="list-style:disc">${r.b151.differences.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`;
  }

  document.getElementById("cfRecon").addEventListener("click", async () => {
    reconModal.classList.remove("hidden"); reconModal.classList.add("flex");
    reconSub.textContent = "";
    reconBody.innerHTML = `<div class="text-black/50">Comparing the B250 with the forecast…</div>`;
    try { renderRecon(await api("/cashflow/reconcile")); }
    catch (e) { reconBody.innerHTML = `<div class="text-red-700">Couldn't build the comparison: ${escapeHtml(e?.message || String(e))}</div>`; }
  });

  // (The old "Categories" exclusion modal was removed — the Overhead editor and
  //  the editable Recurring cash-outflow rows cover that need now.)

  // Auto-fill the opening balance from QuickBooks bank accounts (if synced).
  const balSource = document.getElementById("cfBalSource");
  try {
    const ob = await api("/cashflow/opening-balance");
    if (ob.available) {
      if (!openingEl.value) openingEl.value = Math.round(ob.balance);
      balSource.textContent = ob.source === "b250"
        ? "Auto-filled from the bank balance on the B250 (see Opening balance source). Edit to override."
        : `Auto-filled from ${ob.included_count} QuickBooks bank account${ob.included_count === 1 ? "" : "s"} (see Opening balance source). Edit to override.`;
      renderBank(ob);
    } else {
      balSource.textContent = "Sync the chart of accounts to auto-fill from your bank balance.";
    }
  } catch (e) { /* leave manual */ }

  applyModeUi();
  load();
}
