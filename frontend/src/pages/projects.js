import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

export async function projectsPage(routeFn) {
  const data = await api("/projects");
  const rows = data.projects || [];

  // Date filters are { from:"", to:"" }; text/dropdown filters are strings;
  // numeric range filters are { min:"", max:"" }.
  const state = {
    q:          "",
    sortKey:    "project_name",
    sortDir:    "asc",
    openFilter: null,
    filters: {
      project_name:         "",
      all_statuses:         "",   // raw DB value
      all_project_managers: "",
      all_work_crews:       "",
      all_start_dates:      { from: "", to: "" },
      all_end_dates:        { from: "", to: "" },
      estimate_cost_amt:    { min: "", max: "" },
      estimate_line_amt:    { min: "", max: "" },
      invoice_line_amt:     { min: "", max: "" },
      invoice_balance_amt:  { min: "", max: "" },
      expense_line_amt:     { min: "", max: "" },
      actual_profit:        { min: "", max: "" },
      actual_profit_pct:    { min: "", max: "" },
      projected_profit:     { min: "", max: "" },
      projected_profit_pct: { min: "", max: "" },
    },
  };

  const NUMERIC_COLS = [
    "estimate_cost_amt","estimate_line_amt","invoice_line_amt","invoice_balance_amt",
    "expense_line_amt","actual_profit","actual_profit_pct","projected_profit","projected_profit_pct",
  ];
  const DATE_COLS  = ["all_start_dates","all_end_dates"];
  const PCT_COLS   = ["actual_profit_pct","projected_profit_pct"];

  // ── formatting ─────────────────────────────────────────────────────────────

  function normalize(v) { return (v ?? "").toString().trim().toLowerCase(); }

  function $$(v) {
    const n = Math.round(Number(v) || 0);
    return "$" + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function fmtAmt(v) {
    if (v == null || v === "") return '<span class="text-black/30">—</span>';
    const n = Number(v);
    if (Number.isNaN(n) || n === 0) return '<span class="text-black/30">$0</span>';
    return $$(n);
  }

  function fmtSigned(v) {
    if (v == null || v === "") return '<span class="text-black/30">—</span>';
    const n = Number(v);
    if (Number.isNaN(n)) return '<span class="text-black/30">—</span>';
    return `${n < 0 ? "-" : "+"}${$$(Math.abs(n))}`;
  }

  function fmtPctSigned(v) {
    if (v == null || v === "") return '<span class="text-black/30">—</span>';
    const n = Number(v);
    if (Number.isNaN(n)) return '<span class="text-black/30">—</span>';
    return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
  }

  function colorClass(v) {
    const n = Number(v);
    if (v == null || v === "" || Number.isNaN(n)) return "text-black/50";
    if (n > 0) return "text-emerald-700";
    if (n < 0) return "text-red-600";
    return "text-black/60";
  }

  function statusLabel(s) {
    return s === "not_started" ? "Not Started" :
           s === "in_progress" ? "In Progress" :
           s === "completed"   ? "Completed"   :
           s === "canceled"    ? "Canceled"    : s;
  }

  function statusBadges(statusStr) {
    if (!statusStr) return '<span class="text-black/30">—</span>';
    return statusStr.split(",").map(s => s.trim()).filter(Boolean).map(s => {
      const cls =
        s === "in_progress" ? "bg-kpi-inProgress-bg border-kpi-inProgress-bd text-kpi-inProgress-text" :
        s === "completed"   ? "bg-kpi-completed-bg  border-kpi-completed-bd  text-kpi-completed-text"   :
        s === "canceled"    ? "bg-red-50 border-red-200 text-red-700"                                   :
                              "bg-kpi-notStarted-bg border-kpi-notStarted-bd text-kpi-notStarted-text";
      return `<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${cls}">${escapeHtml(statusLabel(s))}</span>`;
    }).join(" ");
  }

  // ── KPI strip ─────────────────────────────────────────────────────────────
  // All colours are explicit — never rely on inheritance from body (text-white).

  function renderKpiStrip(list) {
    const ec  = list.reduce((s, r) => s + Number(r.estimate_cost_amt    || 0), 0);
    const el  = list.reduce((s, r) => s + Number(r.estimate_line_amt    || 0), 0);
    const inv = list.reduce((s, r) => s + Number(r.invoice_line_amt     || 0), 0);
    const exp = list.reduce((s, r) => s + Number(r.expense_line_amt     || 0), 0);
    const bal = list.reduce((s, r) => s + Number(r.invoice_balance_amt  || 0), 0);
    const ap  = inv - exp;
    const apP = inv !== 0 ? ap / inv : null;
    const pp  = inv - ec;
    const ppP = inv !== 0 ? pp / inv : null;
    const invVsEst   = inv - el;
    const estVsExp   = ec - exp;   // Est.Cost − Expense (budget vs actual spend)

    function pct(p) {
      if (p == null) return "";
      const col = p > 0 ? "text-emerald-700" : p < 0 ? "text-red-600" : "text-black/50";
      return `<span class="${col} text-sm font-semibold ml-1">${p >= 0 ? "+" : ""}${(p * 100).toFixed(1)}%</span>`;
    }
    function sa(n) {
      const col = n > 0 ? "text-emerald-700" : n < 0 ? "text-red-600" : "text-black/50";
      return `<span class="${col} text-sm font-bold">${n >= 0 ? "+" : "-"}${$$(Math.abs(n))}</span>`;
    }

    const card = "rounded-2xl border border-black/10 bg-white px-4 py-3 flex flex-col gap-1 text-ink-900";
    const lbl  = "text-[10px] font-bold text-black/40 uppercase tracking-wide";
    const main = "text-lg font-extrabold leading-tight text-ink-900";
    const sub  = "text-[10px] text-black/40";
    const hr   = "mt-1.5 pt-1.5 border-t border-black/5";

    document.getElementById("kpiStrip").innerHTML = `
      <div class="${card}">
        <div class="${lbl}">Estimate</div>
        <div class="${main}">${$$(el)}</div>
        <div class="${sub}">Contract amount</div>
        <div class="${hr}">
          <div class="${sub}">Cost basis</div>
          <div class="text-sm font-bold text-black/70">${$$(ec)}</div>
        </div>
      </div>

      <div class="${card}">
        <div class="${lbl}">Invoice</div>
        <div class="${main}">${$$(inv)}</div>
        <div class="${sub}">Billed to date</div>
        <div class="${hr}">
          <div class="flex items-baseline justify-between gap-3">
            <div>
              <div class="${sub}">vs Est. amount</div>
              ${sa(invVsEst)}
            </div>
            <div class="text-right">
              <div class="${sub}">AR Balance</div>
              <div class="text-sm font-bold ${bal > 0 ? "text-amber-600" : "text-black/50"}">${$$(bal)}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="${card}">
        <div class="${lbl}">Expense</div>
        <div class="${main}">${$$(exp)}</div>
        <div class="${sub}">Costs posted</div>
        <div class="${hr}">
          <div class="${sub}">Est. Cost − Expense</div>
          ${sa(estVsExp)}
        </div>
      </div>

      <div class="${card}">
        <div class="${lbl}">Profit</div>
        <div class="flex items-baseline gap-1">
          <div class="text-lg font-extrabold leading-tight ${ap > 0 ? "text-emerald-700" : ap < 0 ? "text-red-600" : "text-ink-900"}">${$$(ap)}</div>
          ${pct(apP)}
        </div>
        <div class="${sub}">Actual (Invoice − Expense)</div>
        <div class="${hr}">
          <div class="${sub}">Projected (Invoice − Est. Cost)</div>
          <div class="flex items-baseline gap-1">
            <div class="text-sm font-bold ${pp > 0 ? "text-emerald-700" : pp < 0 ? "text-red-600" : "text-black/70"}">${$$(pp)}</div>
            ${pct(ppP)}
          </div>
        </div>
      </div>`;
  }

  // ── filter helpers ─────────────────────────────────────────────────────────

  function sortArrow(key) {
    return state.sortKey === key ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
  }

  function filterIcon(active = false) {
    return `
      <svg class="shrink-0 size-3.5 ${active ? "text-black" : ""}"
        xmlns="http://www.w3.org/2000/svg" width="24" height="24"
        viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round">
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
      </svg>`;
  }

  function isFilterActive(key) {
    const f = state.filters[key];
    if (f == null) return false;
    if (typeof f === "object") {
      // date range
      if ("from" in f) return !!(f.from || f.to);
      // numeric range
      return !!(f.min || f.max);
    }
    return !!f;
  }

  function getOptions(field) {
    const set = new Set();
    rows.forEach(r =>
      (r[field] || "").split(",").map(x => x.trim()).filter(Boolean).forEach(x => set.add(x))
    );
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  // ── filter portal — position:fixed so it escapes overflow clipping ─────────

  function openFilterMenu(key, anchorEl) {
    document.getElementById("filterMenuPortal")?.remove();
    if (!key || !anchorEl) return;

    const rect   = anchorEl.getBoundingClientRect();
    const menuW  = 230;
    const winW   = window.innerWidth;
    let   left   = rect.left;
    if (left + menuW > winW - 8) left = Math.max(8, winW - menuW - 8);
    const top = rect.bottom + 4;

    const footer = `
      <div class="mt-2.5 flex justify-end gap-1.5">
        <button type="button"
          class="inline-flex items-center rounded-lg border border-black/10 bg-white px-2.5 py-1 text-xs font-semibold hover:bg-black/5"
          data-portal-clear="${key}">Clear</button>
        <button type="button" class="btn-primary text-xs px-2.5 py-1" data-portal-close="1">Done</button>
      </div>`;

    let content = "";

    if (key === "project_name") {
      content = `
        <div class="text-[10px] font-bold text-black/40 mb-1.5">Filter Project</div>
        <input type="text" class="input text-xs py-1" data-portal-input="${key}"
          value="${escapeHtml(state.filters[key] || "")}" placeholder="Type to filter…" />
        ${footer}`;

    } else if (key === "all_statuses") {
      const opts = [
        { val: "not_started", lbl: "Not Started" },
        { val: "in_progress", lbl: "In Progress" },
        { val: "completed",   lbl: "Completed"   },
        { val: "canceled",    lbl: "Canceled"    },
      ];
      content = `
        <div class="text-[10px] font-bold text-black/40 mb-1.5">Filter Status</div>
        <select class="input text-xs py-1" data-portal-select="${key}">
          <option value="">All</option>
          ${opts.map(o => `<option value="${o.val}" ${state.filters[key] === o.val ? "selected" : ""}>${o.lbl}</option>`).join("")}
        </select>
        ${footer}`;

    } else if (key === "all_project_managers") {
      const opts = getOptions("all_project_managers");
      content = `
        <div class="text-[10px] font-bold text-black/40 mb-1.5">Filter PM</div>
        <select class="input text-xs py-1" data-portal-select="${key}">
          <option value="">All</option>
          ${opts.map(o => `<option value="${escapeHtml(o)}" ${state.filters[key] === o ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}
        </select>
        ${footer}`;

    } else if (key === "all_work_crews") {
      const opts = getOptions("all_work_crews");
      content = `
        <div class="text-[10px] font-bold text-black/40 mb-1.5">Filter Crew</div>
        <select class="input text-xs py-1" data-portal-select="${key}">
          <option value="">All</option>
          ${opts.map(o => `<option value="${escapeHtml(o)}" ${state.filters[key] === o ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}
        </select>
        ${footer}`;

    } else if (DATE_COLS.includes(key)) {
      // FIX #3: date range with two native date pickers
      const lbl = key === "all_start_dates" ? "Start Date" : "End Date";
      const f   = state.filters[key] || { from: "", to: "" };
      content = `
        <div class="text-[10px] font-bold text-black/40 mb-1.5">Filter ${lbl}</div>
        <div class="flex flex-col gap-2">
          <div>
            <div class="text-[10px] text-black/40 mb-0.5">From</div>
            <input type="date" class="input text-xs py-1"
              data-portal-date="${key}" data-portal-bound="from"
              value="${escapeHtml(f.from || "")}" />
          </div>
          <div>
            <div class="text-[10px] text-black/40 mb-0.5">To</div>
            <input type="date" class="input text-xs py-1"
              data-portal-date="${key}" data-portal-bound="to"
              value="${escapeHtml(f.to || "")}" />
          </div>
        </div>
        ${footer}`;

    } else if (NUMERIC_COLS.includes(key)) {
      const isPct = PCT_COLS.includes(key);
      const f     = state.filters[key] || { min: "", max: "" };
      const hint  = isPct ? "e.g. 0.25" : "e.g. 50000";
      const step  = isPct ? "0.01" : "1";
      content = `
        <div class="text-[10px] font-bold text-black/40 mb-1.5">Filter range${isPct ? " (0.25 = 25%)" : ""}</div>
        <div class="flex flex-col gap-2">
          <div>
            <div class="text-[10px] text-black/40 mb-0.5">Min</div>
            <input type="number" step="${step}" class="input text-xs py-1"
              data-portal-range="${key}" data-portal-bound="min"
              value="${escapeHtml(f.min || "")}" placeholder="${hint}" />
          </div>
          <div>
            <div class="text-[10px] text-black/40 mb-0.5">Max</div>
            <input type="number" step="${step}" class="input text-xs py-1"
              data-portal-range="${key}" data-portal-bound="max"
              value="${escapeHtml(f.max || "")}" placeholder="${hint}" />
          </div>
        </div>
        ${footer}`;

    } else {
      return;
    }

    const portal = document.createElement("div");
    portal.id        = "filterMenuPortal";
    portal.className = "fixed z-[200] rounded-xl border border-black/10 bg-white p-3 shadow-xl text-ink-900";
    portal.style.cssText = `top:${top}px; left:${left}px; width:${menuW}px;`;
    portal.innerHTML = content;
    document.body.appendChild(portal);

    const first = portal.querySelector("input, select");
    if (first) first.focus();
  }

  // ── th() ──────────────────────────────────────────────────────────────────
  // FIX #2: removed flex-row-reverse. Label is always first, funnel always
  // second regardless of alignment. text-right on the <th> handles alignment.

  function th(key, label, alignRight = false) {
    const active = isFilterActive(key);
    return `
      <th class="py-1.5 px-2 ${alignRight ? "text-right" : "text-left"} align-middle overflow-visible" style="min-width:fit-content;">
        <div class="relative inline-flex items-center gap-1.5">
          <button type="button"
            class="text-left font-bold rounded-lg hover:bg-black/5 leading-none whitespace-nowrap text-xs"
            data-sort="${key}">
            ${escapeHtml(label)}${sortArrow(key)}
          </button>
          <button type="button"
            class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border
                   ${active ? "border-black/15 bg-black/5" : "border-transparent"}
                   hover:border-black/10 hover:bg-black/5"
            data-open-filter="${key}"
            aria-label="Filter ${escapeHtml(label)}">
            ${filterIcon(active)}
          </button>
        </div>
      </th>`;
  }

  // Sticky first-column header — same as th() but pinned left with a solid
  // white background so scrolling rows don't bleed through behind it.
  function thSticky(key, label) {
    const active = isFilterActive(key);
    return `
      <th class="py-1.5 px-2 text-left align-middle overflow-visible bg-white"
          style="position:sticky; left:0; z-index:30; min-width:fit-content; box-shadow:2px 0 4px -2px rgba(0,0,0,0.08);">
        <div class="relative inline-flex items-center gap-1.5">
          <button type="button"
            class="text-left font-bold rounded-lg hover:bg-black/5 leading-none whitespace-nowrap text-xs"
            data-sort="${key}">
            ${escapeHtml(label)}${sortArrow(key)}
          </button>
          <button type="button"
            class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border
                   ${active ? "border-black/15 bg-black/5" : "border-transparent"}
                   hover:border-black/10 hover:bg-black/5"
            data-open-filter="${key}"
            aria-label="Filter ${escapeHtml(label)}">
            ${filterIcon(active)}
          </button>
        </div>
      </th>`;
  }

  // ── page HTML ──────────────────────────────────────────────────────────────

  const bodyHtml = `
    <div id="projectsPageRoot" class="flex flex-col gap-3">

      <!-- KPI strip — explicit text-ink-900 so it never inherits text-white -->
      <div id="kpiStrip" class="grid grid-cols-2 lg:grid-cols-4 gap-3 text-ink-900"></div>

      <!-- Table card -->
      <div id="projectsCard" class="card flex flex-col overflow-hidden" style="min-height:380px;">

        <div class="shrink-0 px-5 pt-4 pb-3 border-b border-black/10">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-1.5">
            <div>
              <div class="text-base font-extrabold">Projects</div>
              <div class="text-xs text-black/50">Sort columns · filter with the funnel · search by name.</div>
            </div>
            <div class="flex items-center gap-2">
              <div class="text-xs font-semibold text-black/50 whitespace-nowrap">Search</div>
              <input id="searchInput" class="input text-xs py-1 w-full sm:w-56" placeholder="Project name" />
              <button id="clearFiltersBtn" type="button"
                class="inline-flex items-center rounded-xl border border-black/10 bg-gray-200 px-3 py-1.5 text-xs font-semibold hover:bg-black/5 whitespace-nowrap">
                Clear Filters
              </button>
            </div>
          </div>
          <div id="rowCount" class="text-xs font-semibold text-black/50">Showing 0 projects</div>
        </div>

        <!-- Single scroll container — both axes; thead sticky to top of THIS div -->
        <div id="projectsTableScroll" class="flex-1 overflow-auto">
          <table id="projectsTable" class="text-xs border-collapse w-full" style="min-width:1380px;">
            <thead id="projectsThead" class="text-left text-black/60 border-b border-black/10 sticky top-0 z-20 bg-white"></thead>
            <tbody id="projectsBody"></tbody>
          </table>
        </div>

      </div>
    </div>

    <!-- File modal -->
    <div id="fileModal" class="fixed inset-0 z-50 hidden">
      <div class="absolute inset-0 bg-black/50 backdrop-blur-[2px]" data-close-file-modal="1"></div>
      <div class="absolute inset-x-4 top-6 bottom-6 mx-auto max-w-6xl">
        <div class="h-full rounded-3xl border border-black/10 bg-white shadow-2xl overflow-hidden flex flex-col">
          <div class="flex items-center justify-between px-5 py-4 border-b border-black/10">
            <div>
              <div id="fileModalTitle" class="text-lg font-extrabold">Project Files</div>
              <div id="fileModalSubtitle" class="text-sm text-black/60"></div>
            </div>
            <button type="button" id="fileModalClose"
              class="inline-flex items-center rounded-xl border border-black/10 px-3 py-2 text-sm text-black/60 font-semibold hover:bg-black/5">
              Close
            </button>
          </div>
          <div class="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
            <div class="border-r border-black/10 overflow-y-auto bg-black/[0.02]">
              <div id="fileList" class="p-3 space-y-2"></div>
            </div>
            <div class="min-w-0 flex flex-col">
              <div class="flex-1 min-h-0 bg-black/[0.03] flex items-center justify-center p-4">
                <div id="filePreview" class="w-full h-full flex items-center justify-center"></div>
              </div>
              <div class="border-t border-black/10 p-4">
                <div class="grid grid-cols-2 gap-3 text-sm">
                  <div><div class="text-black/50 text-xs">Filename</div><div id="metaFilename" class="font-semibold break-all"></div></div>
                  <div><div class="text-black/50 text-xs">Uploaded</div><div id="metaCreatedAt" class="font-semibold"></div></div>
                  <div><div class="text-black/50 text-xs">Type</div><div id="metaContentType" class="font-semibold"></div></div>
                  <div><div class="text-black/50 text-xs">Size</div><div id="metaSize" class="font-semibold"></div></div>
                </div>
                <div class="mt-4">
                  <a id="openFileLink" href="#" target="_blank" rel="noopener noreferrer"
                    class="inline-flex items-center rounded-xl bg-black text-white px-4 py-2 text-sm font-semibold hover:opacity-90">
                    Open full file
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  setShell({
    title:      "",        // hide title — card header already shows "Projects"
    subtitle:   "",        // hide subtitle — saves ~56px of chrome
    bodyHtml,
    showLogout: true,
    routeFn,
  });

  // ── Concrete no-scroll fix ────────────────────────────────────────────────
  // The shell's body has overflow-y:auto which allows page-level scrolling
  // whenever content exceeds 100vh. We eliminate that entirely for this page:
  //   1. Lock body scroll so the browser never shows a page scrollbar.
  //   2. Also hide the mb-5 page-title block (empty title still takes space).
  //   3. Size the card to fill the remaining viewport height precisely via JS.
  //   4. Restore everything when the user navigates away.

  // 1. Lock body scroll
  document.body.style.overflowY = "hidden";

  // 2. Hide the page title/subtitle block (empty strings still render the mb-5 div)
  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock) pageTitleBlock.style.display = "none";

  // 3. Size card to fill remaining space
  function fitCardHeight() {
    const card = document.getElementById("projectsCard");
    if (!card) return;
    const rect      = card.getBoundingClientRect();
    const available = window.innerHeight - rect.top - 12;
    card.style.height = Math.max(300, available) + "px";
  }

  // 4. Restore on navigation (any hash change = leaving this page)
  function onNavigateAway() {
    document.body.style.overflowY = "";
    if (pageTitleBlock) pageTitleBlock.style.display = "";
    window.removeEventListener("resize", fitCardHeight);
    window.removeEventListener("hashchange", onNavigateAway);
  }
  window.addEventListener("hashchange", onNavigateAway);
  window.addEventListener("resize", fitCardHeight);

  // ── render ─────────────────────────────────────────────────────────────────

  function renderThead() {
    document.getElementById("projectsThead").innerHTML = `
      <tr>
        ${thSticky("project_name",       "Project")}
        ${th("all_statuses",         "Status")}
        ${th("all_project_managers", "PM")}
        ${th("all_work_crews",       "Crew")}
        ${th("all_start_dates",      "Start")}
        ${th("all_end_dates",        "End")}
        ${th("estimate_cost_amt",    "Est.Cost",    true)}
        ${th("estimate_line_amt",    "Est.Amt",     true)}
        ${th("invoice_line_amt",     "Invoice",     true)}
        ${th("invoice_balance_amt",  "AR Bal.",      true)}
        ${th("expense_line_amt",     "Expense",     true)}
        ${th("actual_profit",        "Act.Profit",  true)}
        ${th("actual_profit_pct",    "Act.%",       true)}
        ${th("projected_profit",     "Proj.Profit", true)}
        ${th("projected_profit_pct", "Proj.%",      true)}
        <th class="py-1.5 px-2 text-left align-middle font-bold text-xs whitespace-nowrap">Files</th>
      </tr>`;
  }

  function renderBody(list) {
    document.getElementById("rowCount").textContent =
      `Showing ${list.length} project${list.length === 1 ? "" : "s"}`;

    // FIX #4: text-xs on table, py-1.5 px-2 on all tds
    document.getElementById("projectsBody").innerHTML =
      list.map(r => `
        <tr class="border-b border-black/5 hover:bg-black/[0.015] transition-colors">

          <td class="py-1.5 px-2 font-semibold text-xs bg-white"
              style="position:sticky; left:0; z-index:10; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; box-shadow:2px 0 4px -2px rgba(0,0,0,0.08);"
              title="${escapeHtml(r.project_name || "")}">
            ${escapeHtml(r.project_name || "")}
          </td>

          <td class="py-1.5 px-2 text-xs">
            ${r.needs_assignment === 1
              ? '<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold bg-kpi-attention-bg border-kpi-attention-bd text-kpi-attention-text whitespace-nowrap">Needs Attn</span>'
              : statusBadges(r.all_statuses)}
          </td>

          <td class="py-1.5 px-2 text-xs whitespace-nowrap"
              style="max-width:130px;overflow:hidden;text-overflow:ellipsis;"
              title="${escapeHtml(r.all_project_managers || "")}">
            ${escapeHtml(r.all_project_managers || "—")}
          </td>

          <td class="py-1.5 px-2 text-xs whitespace-nowrap"
              style="max-width:110px;overflow:hidden;text-overflow:ellipsis;"
              title="${escapeHtml(r.all_work_crews || "")}">
            ${escapeHtml(r.all_work_crews || "—")}
          </td>

          <td class="py-1.5 px-2 text-xs whitespace-nowrap">${escapeHtml(r.all_start_dates || "—")}</td>
          <td class="py-1.5 px-2 text-xs whitespace-nowrap">${escapeHtml(r.all_end_dates   || "—")}</td>

          <td class="py-1.5 px-2 text-xs text-right whitespace-nowrap tabular-nums">${fmtAmt(r.estimate_cost_amt)}</td>
          <td class="py-1.5 px-2 text-xs text-right whitespace-nowrap tabular-nums text-black/60">${fmtAmt(r.estimate_line_amt)}</td>
          <td class="py-1.5 px-2 text-xs text-right whitespace-nowrap tabular-nums font-semibold">${fmtAmt(r.invoice_line_amt)}</td>
          <td class="py-1.5 px-2 text-xs text-right whitespace-nowrap tabular-nums ${Number(r.invoice_balance_amt||0) > 0 ? "text-amber-600 font-semibold" : "text-black/40"}">${fmtAmt(r.invoice_balance_amt)}</td>
          <td class="py-1.5 px-2 text-xs text-right whitespace-nowrap tabular-nums">${fmtAmt(r.expense_line_amt)}</td>

          <td class="py-1.5 px-2 text-xs text-right whitespace-nowrap tabular-nums font-semibold ${colorClass(r.actual_profit)}">${fmtSigned(r.actual_profit)}</td>
          <td class="py-1.5 px-2 text-xs text-right whitespace-nowrap tabular-nums ${colorClass(r.actual_profit_pct)}">${fmtPctSigned(r.actual_profit_pct)}</td>
          <td class="py-1.5 px-2 text-xs text-right whitespace-nowrap tabular-nums font-semibold ${colorClass(r.projected_profit)}">${fmtSigned(r.projected_profit)}</td>
          <td class="py-1.5 px-2 text-xs text-right whitespace-nowrap tabular-nums ${colorClass(r.projected_profit_pct)}">${fmtPctSigned(r.projected_profit_pct)}</td>

          <td class="py-1.5 px-2 text-xs whitespace-nowrap">
            <div class="flex items-center gap-1.5">
              <button type="button"
                class="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-100 transition"
                data-upload-project="${escapeHtml(String(r.qbo_customer_id || ""))}"
                data-project-name="${escapeHtml(r.project_name || "")}">
                Upload
              </button>
              <button type="button"
                class="inline-flex items-center rounded-full border border-black/10 bg-white px-2.5 py-0.5 text-[10px] font-semibold text-black/70 hover:bg-black/5 transition ${Number(r.file_count || 0) > 0 ? "" : "opacity-50"}"
                data-view-files="${escapeHtml(String(r.qbo_customer_id || ""))}"
                data-project-name="${escapeHtml(r.project_name || "")}">
                View (${Number(r.file_count || 0)})
              </button>
            </div>
          </td>
        </tr>
      `).join("") ||
      `<tr><td class="py-8 text-center text-black/40 text-xs" colspan="16">No projects match these filters.</td></tr>`;
  }

  // ── filtering + sorting ────────────────────────────────────────────────────

  // Helper: check if a date string (YYYY-MM-DD or partial) falls within [from, to]
  // Each row's date field may contain multiple comma-separated dates (one per schedule item).
  // We check if ANY of the row's dates falls within the range.
  function dateInRange(dateStr, from, to) {
    if (!from && !to) return true;
    const dates = (dateStr || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!dates.length) return false;
    return dates.some(d => {
      if (from && d < from) return false;
      if (to   && d > to)   return false;
      return true;
    });
  }

  function filtered() {
    const q = normalize(state.q);
    return rows.filter(r => {
      if (state.filters.project_name &&
          !normalize(r.project_name).includes(normalize(state.filters.project_name))) return false;

      if (state.filters.all_statuses &&
          !normalize(r.all_statuses || "").includes(state.filters.all_statuses)) return false;

      if (state.filters.all_project_managers &&
          !normalize(r.all_project_managers || "").includes(normalize(state.filters.all_project_managers))) return false;

      if (state.filters.all_work_crews &&
          !normalize(r.all_work_crews || "").includes(normalize(state.filters.all_work_crews))) return false;

      // Date range filters
      const sf = state.filters.all_start_dates;
      if ((sf.from || sf.to) && !dateInRange(r.all_start_dates, sf.from, sf.to)) return false;

      const ef = state.filters.all_end_dates;
      if ((ef.from || ef.to) && !dateInRange(r.all_end_dates, ef.from, ef.to)) return false;

      // Numeric range filters
      for (const col of NUMERIC_COLS) {
        const f = state.filters[col];
        if (!f) continue;
        const val = Number(r[col] ?? 0);
        if (f.min !== "" && !Number.isNaN(Number(f.min)) && val < Number(f.min)) return false;
        if (f.max !== "" && !Number.isNaN(Number(f.max)) && val > Number(f.max)) return false;
      }

      if (!q) return true;
      return normalize(r.project_name).includes(q);
    });
  }

  function sorted(list) {
    const dir = state.sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = a[state.sortKey], vb = b[state.sortKey];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const na = Number(va), nb = Number(vb);
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return (na - nb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  function renderAll(skipThead = false) {
    const list = sorted(filtered());
    renderKpiStrip(list);
    if (!skipThead) renderThead();
    renderBody(list);
  }

  // ── events: thead clicks ───────────────────────────────────────────────────

  document.getElementById("projectsThead").addEventListener("click", e => {
    const filterBtn = e.target.closest("[data-open-filter]");
    if (filterBtn) {
      e.stopPropagation();
      const key = filterBtn.getAttribute("data-open-filter");
      if (state.openFilter === key) {
        state.openFilter = null;
        document.getElementById("filterMenuPortal")?.remove();
      } else {
        state.openFilter = key;
        openFilterMenu(key, filterBtn);
      }
      return;
    }

    const sortBtn = e.target.closest("[data-sort]");
    if (sortBtn) {
      const key = sortBtn.getAttribute("data-sort");
      if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      else { state.sortKey = key; state.sortDir = "asc"; }
      document.getElementById("filterMenuPortal")?.remove();
      state.openFilter = null;
      renderAll();
    }
  });

  // ── events: portal interactions ────────────────────────────────────────────

  document.addEventListener("click", e => {
    const portal = document.getElementById("filterMenuPortal");
    if (!portal) return;

    if (e.target.closest("[data-portal-close]")) {
      state.openFilter = null;
      portal.remove();
      renderAll();
      return;
    }

    const clearBtn = e.target.closest("[data-portal-clear]");
    if (clearBtn) {
      const key = clearBtn.getAttribute("data-portal-clear");
      if (DATE_COLS.includes(key))    state.filters[key] = { from: "", to: "" };
      else if (NUMERIC_COLS.includes(key)) state.filters[key] = { min: "", max: "" };
      else if (key in state.filters)       state.filters[key] = "";
      state.openFilter = null;
      portal.remove();
      renderAll();
      return;
    }

    const inPortal = portal.contains(e.target);
    const inThead  = e.target.closest("#projectsThead");
    if (!inPortal && !inThead) {
      state.openFilter = null;
      portal.remove();
      renderAll();
    }
  });

  // Dropdown selects
  document.addEventListener("change", e => {
    const sel = e.target.closest("[data-portal-select]");
    if (sel) {
      const key = sel.getAttribute("data-portal-select");
      if (key in state.filters) state.filters[key] = sel.value;
      const list = sorted(filtered());
      renderKpiStrip(list);
      renderBody(list);
      renderThead();
    }
  });

  // Text + number inputs
  document.addEventListener("input", e => {
    const inp = e.target.closest("[data-portal-input]");
    if (inp) {
      const key = inp.getAttribute("data-portal-input");
      if (key in state.filters) state.filters[key] = inp.value;
      const list = sorted(filtered());
      renderKpiStrip(list); renderBody(list); renderThead();
      return;
    }

    // Numeric range
    const rangeInp = e.target.closest("[data-portal-range]");
    if (rangeInp) {
      const key   = rangeInp.getAttribute("data-portal-range");
      const bound = rangeInp.getAttribute("data-portal-bound");
      if (NUMERIC_COLS.includes(key)) {
        if (typeof state.filters[key] !== "object") state.filters[key] = { min: "", max: "" };
        state.filters[key][bound] = rangeInp.value;
        const list = sorted(filtered());
        renderKpiStrip(list); renderBody(list); renderThead();
      }
      return;
    }

    // Date range — FIX #3: handle the two date picker inputs
    const dateInp = e.target.closest("[data-portal-date]");
    if (dateInp) {
      const key   = dateInp.getAttribute("data-portal-date");
      const bound = dateInp.getAttribute("data-portal-bound"); // "from" | "to"
      if (DATE_COLS.includes(key)) {
        if (typeof state.filters[key] !== "object") state.filters[key] = { from: "", to: "" };
        state.filters[key][bound] = dateInp.value;
        const list = sorted(filtered());
        renderKpiStrip(list); renderBody(list); renderThead();
      }
    }
  });

  // ── events: search + clear ─────────────────────────────────────────────────

  document.getElementById("searchInput").addEventListener("input", e => {
    state.q = e.target.value;
    const list = sorted(filtered());
    renderKpiStrip(list); renderBody(list); renderThead();
  });

  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    state.q = "";
    state.openFilter = null;
    document.getElementById("filterMenuPortal")?.remove();
    Object.keys(state.filters).forEach(k => {
      if (DATE_COLS.includes(k))         state.filters[k] = { from: "", to: "" };
      else if (NUMERIC_COLS.includes(k)) state.filters[k] = { min: "", max: "" };
      else                               state.filters[k] = "";
    });
    document.getElementById("searchInput").value = "";
    renderAll();
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      const portal = document.getElementById("filterMenuPortal");
      if (portal) { state.openFilter = null; portal.remove(); renderAll(); }
    }
  });

  // ── events: file upload / view ─────────────────────────────────────────────

  document.getElementById("projectsBody").addEventListener("click", async e => {
    const uploadBtn = e.target.closest("[data-upload-project]");
    if (uploadBtn) {
      const id = uploadBtn.getAttribute("data-upload-project");
      if (!id) { alert("Missing qbo_customer_id."); return; }
      const input = document.createElement("input");
      input.type   = "file";
      input.accept = "image/jpeg,image/png,image/webp,application/pdf";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const fd = new FormData();
        fd.append("file", file);
        try {
          await api(`/projects/${id}/files`, { method: "POST", body: fd });
          const row = rows.find(x => String(x.qbo_customer_id) === String(id));
          if (row) row.file_count = Number(row.file_count || 0) + 1;
          renderAll(true);
        } catch (err) { alert(`Upload failed: ${err.message}`); }
      };
      input.click();
      return;
    }

    const viewBtn = e.target.closest("[data-view-files]");
    if (viewBtn) {
      const id   = viewBtn.getAttribute("data-view-files");
      const name = viewBtn.getAttribute("data-project-name") || "Project Files";
      if (!id) { alert("Missing qbo_customer_id."); return; }
      try {
        const res   = await api(`/projects/${id}/files`);
        const files = res.files || [];
        if (!files.length) { alert("No files uploaded for this project yet."); return; }
        openFileModal(name, files, 0);
      } catch (err) { alert(`Could not load files: ${err.message}`); }
    }
  });

  // ── file modal ─────────────────────────────────────────────────────────────

  const modalState = { projectName: "", files: [], activeIndex: 0 };

  function fmtDateTime(v) {
    if (!v) return "";
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
  }

  function fmtBytes(bytes) {
    const n = Number(bytes || 0);
    if (!n) return "0 B";
    const units = ["B","KB","MB","GB"];
    let value = n, i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function isImg(f) { return (f.content_type || "").startsWith("image/"); }
  function ea(v)    { return escapeHtml(String(v ?? "")); }

  function openFileModal(name, files, startIndex = 0) {
    modalState.projectName = name || "Project Files";
    modalState.files       = files;
    modalState.activeIndex = startIndex;
    document.getElementById("fileModalTitle").textContent    = modalState.projectName;
    document.getElementById("fileModalSubtitle").textContent = `${files.length} file${files.length === 1 ? "" : "s"}`;
    document.getElementById("fileModal").classList.remove("hidden");
    renderFileModal();
  }

  function closeFileModal() {
    document.getElementById("fileModal").classList.add("hidden");
    document.getElementById("filePreview").innerHTML = "";
    document.getElementById("fileList").innerHTML    = "";
  }

  function renderFileModal() {
    const files  = modalState.files;
    const active = files[modalState.activeIndex];
    if (!active) { closeFileModal(); return; }

    document.getElementById("fileList").innerHTML = files.map((f, idx) => {
      const sel   = idx === modalState.activeIndex;
      const thumb = isImg(f)
        ? `<img src="${ea(f.url)}" class="h-12 w-12 rounded-xl object-cover border border-black/10 bg-white" />`
        : `<div class="h-12 w-12 rounded-xl border border-black/10 bg-white flex items-center justify-center text-xs font-bold text-black/50">FILE</div>`;
      return `
        <button type="button" data-file-index="${idx}"
          class="w-full text-left rounded-2xl border px-3 py-3 transition hover:bg-white
                 ${sel ? "bg-white border-black/15 shadow-sm" : "border-transparent"}">
          <div class="flex items-center gap-3">
            ${thumb}
            <div class="min-w-0">
              <div class="font-semibold truncate text-sm">${escapeHtml(f.original_filename || "Untitled")}</div>
              <div class="text-xs text-black/50">${escapeHtml(fmtDateTime(f.created_at))}</div>
            </div>
          </div>
        </button>`;
    }).join("");

    const prev = document.getElementById("filePreview");
    if (isImg(active)) {
      prev.innerHTML = `<img src="${ea(active.url)}" class="max-w-full max-h-full object-contain rounded-2xl shadow-sm" />`;
    } else if (active.content_type === "application/pdf") {
      prev.innerHTML = `<iframe src="${ea(active.url)}" class="w-full h-full rounded-2xl bg-white" title="${ea(active.original_filename || "PDF")}"></iframe>`;
    } else {
      prev.innerHTML = `<div class="text-center text-black/60"><div class="font-bold">Preview unavailable</div><div class="mt-1 text-sm">Open in new tab.</div></div>`;
    }

    document.getElementById("metaFilename").textContent    = active.original_filename || "";
    document.getElementById("metaCreatedAt").textContent   = fmtDateTime(active.created_at);
    document.getElementById("metaContentType").textContent = active.content_type || "";
    document.getElementById("metaSize").textContent        = fmtBytes(active.size_bytes);
    document.getElementById("openFileLink").href           = active.url;
  }

  document.getElementById("fileModalClose").addEventListener("click", closeFileModal);
  document.getElementById("fileModal").addEventListener("click", e => {
    if (e.target.closest("[data-close-file-modal='1']")) { closeFileModal(); return; }
    const fb = e.target.closest("[data-file-index]");
    if (fb) {
      modalState.activeIndex = Number(fb.getAttribute("data-file-index"));
      renderFileModal();
    }
  });

  document.addEventListener("keydown", e => {
    if (document.getElementById("fileModal").classList.contains("hidden")) return;
    if (e.key === "Escape") { closeFileModal(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      modalState.activeIndex = Math.min(modalState.activeIndex + 1, modalState.files.length - 1);
      renderFileModal();
    }
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      modalState.activeIndex = Math.max(modalState.activeIndex - 1, 0);
      renderFileModal();
    }
  });

  // ── initial render ─────────────────────────────────────────────────────────
  renderAll();
  // Double rAF ensures KPI strip + card header are laid out before measuring.
  requestAnimationFrame(() => requestAnimationFrame(fitCardHeight));
}