import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

export async function dashboardPage(routeFn) {
  // Single source of truth for this page — one fetch, two views of the data.
  //   rows       : per-schedule-item (feeds the Projects table)
  //   basicRows  : collapsed to one-per-project (feeds the Timeline + side cards)
  const scheduleData = await api("/projects/schedule-list");
  const rows = (scheduleData.rows || []).slice();   // mutable — file uploads bump file_count

  // Collapse schedule-list into one-row-per-project with latest end_date and
  // a primary status. Mirrors the shape /projects/basic used to return.
  // Primary status = MIN(status) alphabetically (matches the old SQL).
  const basicRows = (() => {
    const m = new Map();
    for (const r of rows) {
      const id = r.qbo_customer_id;
      if (id == null) continue;
      let agg = m.get(id);
      if (!agg) {
        agg = {
          qbo_customer_id: id,
          project_name:    r.project_name,
          project_status:  null,
          end_date:        null,
          needs_assignment: 1,       // flipped to 0 if any schedule item is found
        };
        m.set(id, agg);
      }
      if (r.schedule_item_id) {
        agg.needs_assignment = 0;
        if (r.project_status && (agg.project_status == null || r.project_status < agg.project_status)) {
          agg.project_status = r.project_status;
        }
        const ed = r.end_date ? String(r.end_date).slice(0, 10) : null;
        if (ed && (!agg.end_date || ed > agg.end_date)) {
          agg.end_date = ed;
        }
      }
    }
    for (const agg of m.values()) {
      if (agg.project_status == null) agg.project_status = "not_started";
    }
    return [...m.values()];
  })();

  // ── helpers ────────────────────────────────────────────────────────────────
  const normalize = (v) => (v ?? "").toString().toLowerCase();
  const ea = (v) => escapeHtml(String(v ?? ""));

  function parseYmd(v) {
    if (!v) return null;
    const s = String(v).slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return Number.isFinite(d.getTime()) ? d : null;
  }

  function statusLabel(s) {
    return s === "not_started" ? "Not Started"
         : s === "in_progress" ? "In Progress"
         : s === "completed"   ? "Completed"
         : s === "canceled"    ? "Canceled"
         : (s || "");
  }

  function statusBadge(s) {
    if (!s) return '<span class="text-black/30">—</span>';
    const cls =
      s === "in_progress" ? "bg-kpi-inProgress-bg border-kpi-inProgress-bd text-kpi-inProgress-text" :
      s === "completed"   ? "bg-kpi-completed-bg  border-kpi-completed-bd  text-kpi-completed-text" :
      s === "canceled"    ? "bg-red-50 border-red-200 text-red-700" :
                            "bg-kpi-notStarted-bg border-kpi-notStarted-bd text-kpi-notStarted-text";
    return `<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${cls}">${escapeHtml(statusLabel(s))}</span>`;
  }

  function fmtNum(v) {
    if (v == null || v === "") return '<span class="text-black/30">—</span>';
    const n = Number(v);
    if (Number.isNaN(n)) return '<span class="text-black/30">—</span>';
    return String(n);
  }

  // ── side-card counts (from basic rows) ─────────────────────────────────────
  const needsAttentionCount = basicRows.filter(r => Number(r.needs_assignment) === 1).length;
  const canceledCount       = basicRows.filter(r => normalize(r.project_status) === "canceled").length;

  // ── projects-table state ───────────────────────────────────────────────────
  const state = {
    q:          "",
    sortKey:    "project_name",
    sortDir:    "asc",
    openFilter: null,
    filters: {
      project_name:             "",
      project_status:           [],
      primary_project_manager:  [],
      primary_work_crew:        [],
      start_date:               { from: "", to: "" },
      end_date:                 { from: "", to: "" },
      wire_guidance:            [],    // ["yes"] / ["no"] / []
      travel_days:              { min: "", max: "" },
      overage_days:             { min: "", max: "" },
      equipment_type:           [],
      notes:                    "",
      file_count:               { min: "", max: "" },
    },
  };

  const NUMERIC_COLS     = ["travel_days", "overage_days", "file_count"];
  const DATE_COLS        = ["start_date", "end_date"];
  const MULTISELECT_COLS = ["project_status", "primary_project_manager", "primary_work_crew", "wire_guidance", "equipment_type"];

  // ── page HTML ──────────────────────────────────────────────────────────────
  const bodyHtml = `
    <div class="grid grid-cols-1 gap-4">

      <!-- Project Timeline — stacked bars by end-date month & status -->
      <div class="card p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">Project Timeline</div>
            <div class="text-sm text-black/60">Project counts by end-date month (2026), stacked by status</div>
          </div>
          <div class="text-xs text-black/50 whitespace-nowrap" id="timelineRange">—</div>
        </div>

        <div class="mt-4 flex flex-col lg:flex-row gap-3">
          <div class="flex-1 border border-black/10 bg-black/5 rounded-2xl p-3">
            <div class="flex flex-wrap items-center justify-between gap-2 px-1 pb-2">
              <div class="text-xs font-bold text-black/60">Legend</div>
              <div class="flex flex-wrap items-center gap-3 text-xs font-semibold text-black/70">
                <span class="inline-flex items-center gap-2">
                  <span class="inline-block h-2.5 w-2.5 rounded-sm border border-black/10" style="background:#64748b"></span>
                  Not Started
                </span>
                <span class="inline-flex items-center gap-2">
                  <span class="inline-block h-2.5 w-2.5 rounded-sm border border-black/10" style="background:#3b82f6"></span>
                  In Progress
                </span>
                <span class="inline-flex items-center gap-2">
                  <span class="inline-block h-2.5 w-2.5 rounded-sm border border-black/10" style="background:#4f7f61"></span>
                  Completed
                </span>
              </div>
            </div>
            <div id="timelineChart" class="w-full"></div>
          </div>

          <div class="flex flex-col gap-3 lg:w-44">
            <div class="rounded-2xl border bg-kpi-attention-bg border-kpi-attention-bd p-4 flex-1 flex flex-col justify-center items-center">
              <div class="text-xs font-bold text-kpi-attention-text uppercase tracking-wide">Needs Attention</div>
              <div class="mt-1 text-3xl font-extrabold text-kpi-attention-num leading-tight">${needsAttentionCount}</div>
            </div>
            <div class="rounded-2xl border bg-red-50 border-red-200 p-4 flex-1 flex flex-col justify-center items-center">
              <div class="text-xs font-bold text-red-700 uppercase tracking-wide">Canceled</div>
              <div class="mt-1 text-3xl font-extrabold text-red-900 leading-tight">${canceledCount}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Projects table (read-only, multi-row per project) -->
      <div id="projTableCard" class="card flex flex-col overflow-hidden" style="min-height:280px;">
        <div class="shrink-0 px-5 pt-4 pb-3 border-b border-black/10">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-1.5">
            <div>
              <div class="text-base font-extrabold">Projects</div>
              <div class="text-xs text-black/50">Sort columns · filter with the funnel · search by name.</div>
            </div>
            <div class="flex items-center gap-2">
              <div class="text-xs font-semibold text-black/50 whitespace-nowrap">Search</div>
              <input id="projSearchInput" class="input text-xs py-1 w-full sm:w-56" placeholder="Project name" />
              <button id="projClearFiltersBtn" type="button"
                class="inline-flex items-center rounded-xl border border-black/10 bg-gray-200 px-3 py-1.5 text-xs font-semibold hover:bg-black/5 whitespace-nowrap">
                Clear Filters
              </button>
            </div>
          </div>
          <div id="projRowCount" class="text-xs font-semibold text-black/50">Showing 0 projects · 0 rows</div>
        </div>

        <div class="flex-1 overflow-auto">
          <table class="text-xs border-collapse w-full" style="min-width:1100px;">
            <thead id="projTableThead" class="text-left text-black/60 border-b border-black/10 sticky top-0 z-20 bg-white"></thead>
            <tbody id="projTableBody"></tbody>
          </table>
        </div>
      </div>

    </div>

    <!-- File modal (same shape as the Financials page's) -->
    <div id="projFileModal" class="fixed inset-0 z-50 hidden">
      <div class="absolute inset-0 bg-black/50 backdrop-blur-[2px]" data-close-proj-file-modal="1"></div>
      <div class="absolute inset-x-4 top-6 bottom-6 mx-auto max-w-6xl">
        <div class="h-full rounded-3xl border border-black/10 bg-white shadow-2xl overflow-hidden flex flex-col">
          <div class="flex items-center justify-between px-5 py-4 border-b border-black/10">
            <div>
              <div id="projFileModalTitle" class="text-lg font-extrabold">Project Files</div>
              <div id="projFileModalSubtitle" class="text-sm text-black/60"></div>
            </div>
            <button type="button" id="projFileModalClose"
              class="inline-flex items-center rounded-xl border border-black/10 px-3 py-2 text-sm text-black/60 font-semibold hover:bg-black/5">
              Close
            </button>
          </div>
          <div class="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
            <div class="border-r border-black/10 overflow-y-auto bg-black/[0.02]">
              <div id="projFileList" class="p-3 space-y-2"></div>
            </div>
            <div class="min-w-0 flex flex-col">
              <div class="flex-1 min-h-0 bg-black/[0.03] flex items-center justify-center p-4">
                <div id="projFilePreview" class="w-full h-full flex items-center justify-center"></div>
              </div>
              <div class="border-t border-black/10 p-4">
                <div class="grid grid-cols-2 gap-3 text-sm">
                  <div><div class="text-black/50 text-xs">Filename</div><div id="projMetaFilename" class="font-semibold break-all"></div></div>
                  <div><div class="text-black/50 text-xs">Uploaded</div><div id="projMetaCreatedAt" class="font-semibold"></div></div>
                  <div><div class="text-black/50 text-xs">Type</div><div id="projMetaContentType" class="font-semibold"></div></div>
                  <div><div class="text-black/50 text-xs">Size</div><div id="projMetaSize" class="font-semibold"></div></div>
                </div>
                <div class="mt-4">
                  <a id="projOpenFileLink" href="#" target="_blank" rel="noopener noreferrer"
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
    title:    "",     // hide page-level title; card headers carry the context
    subtitle: "",
    bodyHtml,
    showLogout: true,
    routeFn,
  });

  // Ensure the shared timeline-tooltip element exists (chart hover handlers read it)
  if (!document.getElementById("dashChartTooltip")) {
    const tip = document.createElement("div");
    tip.id = "dashChartTooltip";
    tip.className = "pointer-events-none absolute z-50 hidden rounded-xl border border-black/10 bg-white/95 px-3 py-2 text-xs shadow-sm";
    tip.style.transform = "translate(-50%, -110%)";
    document.body.appendChild(tip);
  }

  // ── Viewport layout: no page scrollbar, table fills remaining height ──────
  // 1. Lock body scroll so the browser never shows a page-level scrollbar
  document.body.style.overflowY = "hidden";

  // 2. Hide the shell's page-title block (empty title/subtitle still renders the mb-5 spacer div)
  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock) pageTitleBlock.style.display = "none";

  // 3. Size the table card to fill whatever viewport remains below the timeline card
  function fitTableCardHeight() {
    const card = document.getElementById("projTableCard");
    if (!card) return;
    const rect      = card.getBoundingClientRect();
    const available = window.innerHeight - rect.top - 12;
    card.style.height = Math.max(280, available) + "px";
  }

  // 4. Restore on navigation (any hash change = leaving this page)
  function onNavigateAway() {
    document.body.style.overflowY = "";
    if (pageTitleBlock) pageTitleBlock.style.display = "";
    window.removeEventListener("resize", fitTableCardHeight);
    window.removeEventListener("hashchange", onNavigateAway);
  }
  window.addEventListener("hashchange", onNavigateAway);
  window.addEventListener("resize", fitTableCardHeight);

  // ── Project Timeline chart ─────────────────────────────────────────────────
  function renderTimeline() {
    const host = document.getElementById("timelineChart");
    const d3 = window.d3;
    if (!host || !d3) return;
    host.innerHTML = "";

    const MONTH_LABELS  = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const STATUS_KEYS   = ["not_started", "in_progress", "completed"];
    const STATUS_COLORS = { not_started: "#64748b", in_progress: "#3b82f6", completed: "#4f7f61" };
    const STATUS_LABELS = { not_started: "Not Started", in_progress: "In Progress", completed: "Completed" };

    const buckets = MONTH_LABELS.map((label, idx) => ({
      month: idx + 1, label,
      not_started: 0, in_progress: 0, completed: 0, total: 0,
    }));

    // Collapse the CURRENTLY-FILTERED table rows into one-per-project, then
    // bucket by 2026 end-date month × status. This is what makes the chart
    // react to table filters (step 1 of bidirectional linking).
    const projectAgg = new Map();
    for (const r of filtered()) {
      const id = r.qbo_customer_id;
      if (id == null) continue;
      let p = projectAgg.get(id);
      if (!p) { p = { project_status: null, end_date: null }; projectAgg.set(id, p); }
      if (r.project_status && (p.project_status == null || r.project_status < p.project_status)) {
        p.project_status = r.project_status;
      }
      const ed = r.end_date ? String(r.end_date).slice(0, 10) : null;
      if (ed && (!p.end_date || ed > p.end_date)) p.end_date = ed;
    }
    for (const p of projectAgg.values()) {
      const d = parseYmd(p.end_date);
      if (!d) continue;
      if (d.getUTCFullYear() !== 2026) continue;
      const s = (p.project_status || "").toLowerCase();
      if (!STATUS_KEYS.includes(s)) continue;
      const b = buckets[d.getUTCMonth()];
      b[s] += 1;
      b.total += 1;
    }

    const totalProjects = buckets.reduce((s, b) => s + b.total, 0);
    const rangeEl = document.getElementById("timelineRange");
    if (rangeEl) rangeEl.textContent = `${totalProjects} project${totalProjects === 1 ? "" : "s"} ending in 2026`;

    const w = host.clientWidth || 800;
    const h = 200;
    const margin = { top: 22, right: 24, bottom: 28, left: 40 };
    const innerW = Math.max(320, w) - margin.left - margin.right;
    const innerH = h - margin.top - margin.bottom;

    const svg = d3.select(host).append("svg")
      .attr("width", w).attr("height", h).style("display", "block");
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const x = d3.scaleBand().domain(buckets.map(b => b.label)).range([0, innerW]).padding(0.22);
    const yMax = Math.max(1, d3.max(buckets, b => b.total) || 0);
    const y = d3.scaleLinear().domain([0, yMax]).nice().range([innerH, 0]);

    g.append("g")
      .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(""))
      .call(gg => gg.selectAll("line").attr("stroke", "rgba(0,0,0,.06)"))
      .call(gg => gg.select(".domain").remove());

    const topmostKey = b => {
      for (let i = STATUS_KEYS.length - 1; i >= 0; i--) {
        if (b[STATUS_KEYS[i]] > 0) return STATUS_KEYS[i];
      }
      return null;
    };
    const segPath = (x0, y0, w2, hh, topRounded, r) => {
      if (hh <= 0) return "";
      if (!topRounded) return `M${x0},${y0}h${w2}v${hh}h${-w2}Z`;
      const rr = Math.min(r, w2 / 2, hh);
      return `M${x0},${y0 + rr}Q${x0},${y0} ${x0 + rr},${y0}`
           + `L${x0 + w2 - rr},${y0}Q${x0 + w2},${y0} ${x0 + w2},${y0 + rr}`
           + `V${y0 + hh}H${x0}Z`;
    };

    const stacked = d3.stack().keys(STATUS_KEYS)(buckets);
    g.append("g").selectAll("g")
      .data(stacked)
      .enter().append("g")
        .attr("fill", s => STATUS_COLORS[s.key])
      .selectAll("path")
      .data(s => s.map(d => ({ ...d, key: s.key })))
      .enter().append("path")
        .attr("d", d => {
          const x0  = x(d.data.label);
          const y0  = y(d[1]);
          const w2  = x.bandwidth();
          const hh  = Math.max(0, y(d[0]) - y(d[1]));
          const top = topmostKey(d.data) === d.key;
          return segPath(x0, y0, w2, hh, top, 6);
        })
        .attr("stroke", "rgba(0,0,0,0.06)")
        .style("pointer-events", "none");   // hover + click are handled by the overlay below

    g.append("g").selectAll("text")
      .data(buckets)
      .enter().append("text")
        .attr("x", d => x(d.label) + x.bandwidth() / 2)
        .attr("y", d => y(d.total) - 6)
        .attr("text-anchor", "middle")
        .attr("font-size", 10)
        .attr("font-weight", 700)
        .attr("fill", "rgba(0,0,0,.7)")
        .text(d => d.total > 0 ? d.total : "");

    g.append("g")
      .call(d3.axisLeft(y).ticks(5).tickFormat(d3.format("d")))
      .call(gg => gg.selectAll("text").attr("fill", "rgba(0,0,0,.55)"))
      .call(gg => gg.selectAll("line").attr("stroke", "rgba(0,0,0,.10)"))
      .call(gg => gg.select(".domain").attr("stroke", "rgba(0,0,0,.12)"));

    g.append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x))
      .call(gg => gg.selectAll("text").attr("fill", "rgba(0,0,0,.55)"))
      .call(gg => gg.selectAll("line").attr("stroke", "rgba(0,0,0,.10)"))
      .call(gg => gg.select(".domain").attr("stroke", "rgba(0,0,0,.12)"));

    // Map a mouse y-coordinate inside a month column to the status segment
    // underneath. The stack runs bottom-up: not_started → in_progress → completed.
    // Returns null if the click was above the bar or on an empty segment.
    function segmentAtY(d, mouseY) {
      if (d.total <= 0) return null;
      const dataValue = y.invert(mouseY);
      if (dataValue < 0 || dataValue > d.total) return null;
      const runningSum = [0, d.not_started, d.not_started + d.in_progress, d.total];
      for (let i = 0; i < STATUS_KEYS.length; i++) {
        const k = STATUS_KEYS[i];
        if (d[k] > 0 && dataValue >= runningSum[i] && dataValue <= runningSum[i + 1]) return k;
      }
      return null;
    }

    g.append("g").selectAll("rect")
      .data(buckets)
      .enter().append("rect")
        .attr("x", d => x(d.label))
        .attr("y", 0)
        .attr("width", x.bandwidth())
        .attr("height", innerH)
        .attr("fill", "transparent")
        .style("cursor", d => d.total > 0 ? "pointer" : "default")
        .on("mouseenter", (evt, d) => {
          const tip = document.getElementById("dashChartTooltip");
          if (!tip) return;
          tip.innerHTML = `
            <div class="font-bold text-ink-800">${d.label} 2026</div>
            <div class="mt-1 text-black/70">${STATUS_LABELS.not_started}: <span class="font-semibold text-black/80">${d.not_started}</span></div>
            <div class="text-black/70">${STATUS_LABELS.in_progress}: <span class="font-semibold text-black/80">${d.in_progress}</span></div>
            <div class="text-black/70">${STATUS_LABELS.completed}: <span class="font-semibold text-black/80">${d.completed}</span></div>
            <div class="mt-1 text-black/50">${d.total} total${d.total > 0 ? " — click a segment to filter" : ""}</div>`;
          tip.classList.remove("hidden");
          tip.style.left = `${evt.clientX}px`;
          tip.style.top  = `${evt.clientY}px`;
        })
        .on("mousemove", (evt) => {
          const tip = document.getElementById("dashChartTooltip");
          if (!tip) return;
          tip.style.left = `${evt.clientX}px`;
          tip.style.top  = `${evt.clientY}px`;
        })
        .on("mouseleave", () => {
          const tip = document.getElementById("dashChartTooltip");
          if (tip) tip.classList.add("hidden");
        })
        .on("click", function (evt, d) {
          if (d.total <= 0) return;
          const [, mouseY] = d3.pointer(evt, this);
          const status = segmentAtY(d, mouseY);
          if (status) handleTimelineClick(d.month, status);
        });
  }

  // ── Projects table: rendering + filtering + sorting ────────────────────────

  function getOptions(field) {
    const set = new Set();
    rows.forEach(r => {
      const v = r[field];
      if (v != null && v !== "") set.add(String(v));
    });
    return [...set].sort((a, b) => a.localeCompare(b));
  }

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
    if (Array.isArray(f)) return f.length > 0;
    if (typeof f === "object") {
      if ("from" in f) return !!(f.from || f.to);
      return !!(f.min || f.max);
    }
    return !!f;
  }

  function th(key, label, alignRight = false) {
    const active = isFilterActive(key);
    return `
      <th class="py-1.5 px-2 ${alignRight ? "text-right" : "text-left"} align-middle overflow-visible">
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

  function renderThead() {
    document.getElementById("projTableThead").innerHTML = `
      <tr>
        ${th("project_name",            "Project")}
        ${th("project_status",          "Status")}
        ${th("primary_project_manager", "PM")}
        ${th("primary_work_crew",       "Crew")}
        ${th("start_date",              "Start")}
        ${th("end_date",                "End")}
        ${th("wire_guidance",           "Wire",    true)}
        ${th("travel_days",             "Travel",  true)}
        ${th("overage_days",            "Overage", true)}
        ${th("equipment_type",          "Equip")}
        ${th("notes",                   "Notes")}
        <th class="py-1.5 px-2 text-left align-middle font-bold text-xs whitespace-nowrap">Files</th>
      </tr>`;
  }

  function renderBody(list) {
    const uniq = new Set(list.map(r => r.qbo_customer_id)).size;
    document.getElementById("projRowCount").textContent =
      `Showing ${uniq} project${uniq === 1 ? "" : "s"} · ${list.length} row${list.length === 1 ? "" : "s"}`;

    document.getElementById("projTableBody").innerHTML =
      list.map(r => `
        <tr class="border-b border-black/5 hover:bg-black/[0.02] transition-colors">
          <td class="py-1.5 px-2 font-semibold"
              style="max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
              title="${ea(r.project_name || "")}">${ea(r.project_name || "—")}</td>
          <td class="py-1.5 px-2">${statusBadge(r.project_status)}</td>
          <td class="py-1.5 px-2 whitespace-nowrap"
              style="max-width:140px; overflow:hidden; text-overflow:ellipsis;"
              title="${ea(r.primary_project_manager || "")}">${ea(r.primary_project_manager || "—")}</td>
          <td class="py-1.5 px-2 whitespace-nowrap"
              style="max-width:120px; overflow:hidden; text-overflow:ellipsis;"
              title="${ea(r.primary_work_crew || "")}">${ea(r.primary_work_crew || "—")}</td>
          <td class="py-1.5 px-2 whitespace-nowrap">${r.start_date ? ea(String(r.start_date).slice(0,10)) : "—"}</td>
          <td class="py-1.5 px-2 whitespace-nowrap">${r.end_date   ? ea(String(r.end_date).slice(0,10))   : "—"}</td>
          <td class="py-1.5 px-2 text-right tabular-nums ${Number(r.wire_guidance) ? "font-semibold" : "text-black/50"}">${Number(r.wire_guidance) ? "Yes" : "No"}</td>
          <td class="py-1.5 px-2 text-right tabular-nums">${fmtNum(r.travel_days)}</td>
          <td class="py-1.5 px-2 text-right tabular-nums">${fmtNum(r.overage_days)}</td>
          <td class="py-1.5 px-2 whitespace-nowrap"
              style="max-width:140px; overflow:hidden; text-overflow:ellipsis;"
              title="${ea(r.equipment_type || "")}">${ea(r.equipment_type || "—")}</td>
          <td class="py-1.5 px-2"
              style="max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
              title="${ea(r.notes || "")}">${ea(r.notes || "—")}</td>
          <td class="py-1.5 px-2 whitespace-nowrap">
            <div class="flex items-center gap-1.5">
              <button type="button"
                class="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-100 transition"
                data-upload-project="${ea(String(r.qbo_customer_id || ""))}"
                data-project-name="${ea(r.project_name || "")}">
                Upload
              </button>
              <button type="button"
                class="inline-flex items-center rounded-full border border-black/10 bg-white px-2.5 py-0.5 text-[10px] font-semibold text-black/70 hover:bg-black/5 transition ${Number(r.file_count || 0) > 0 ? "" : "opacity-50"}"
                data-view-files="${ea(String(r.qbo_customer_id || ""))}"
                data-project-name="${ea(r.project_name || "")}">
                View (${Number(r.file_count || 0)})
              </button>
            </div>
          </td>
        </tr>
      `).join("") ||
      `<tr><td class="py-8 text-center text-black/40 text-xs" colspan="12">No projects match these filters.</td></tr>`;
  }

  // ── filter portal — fixed position, escapes the table's overflow ───────────
  function openFilterMenu(key, anchorEl) {
    document.getElementById("projFilterMenuPortal")?.remove();
    if (!key || !anchorEl) return;

    const rect  = anchorEl.getBoundingClientRect();
    const menuW = 230;
    const winW  = window.innerWidth;
    let   left  = rect.left;
    if (left + menuW > winW - 8) left = Math.max(8, winW - menuW - 8);
    const top = rect.bottom + 4;

    const footer = `
      <div class="mt-2.5 flex justify-end gap-1.5">
        <button type="button"
          class="inline-flex items-center rounded-lg border border-black/10 bg-white px-2.5 py-1 text-xs font-semibold hover:bg-black/5"
          data-proj-portal-clear="${key}">Clear</button>
        <button type="button" class="btn-primary text-xs px-2.5 py-1" data-proj-portal-close="1">Done</button>
      </div>`;

    let content = "";

    if (key === "project_name" || key === "notes") {
      const label = key === "project_name" ? "Project" : "Notes";
      content = `
        <div class="text-[10px] font-bold text-black/40 mb-1.5">Filter ${label}</div>
        <input type="text" class="input text-xs py-1" data-proj-portal-input="${key}"
          value="${escapeHtml(state.filters[key] || "")}" placeholder="Type to filter…" />
        ${footer}`;

    } else if (MULTISELECT_COLS.includes(key)) {
      const titleMap = {
        project_status: "Filter Status",
        primary_project_manager: "Filter PM",
        primary_work_crew: "Filter Crew",
        wire_guidance: "Filter Wire",
        equipment_type: "Filter Equipment",
      };
      const rawOpts =
        key === "project_status" ? [
          { value: "not_started", label: "Not Started" },
          { value: "in_progress", label: "In Progress" },
          { value: "completed",   label: "Completed" },
          { value: "canceled",    label: "Canceled" },
        ]
        : key === "wire_guidance" ? [
          { value: "yes", label: "Yes" },
          { value: "no",  label: "No" },
        ]
        : getOptions(key).map(x => ({ value: x, label: x }));

      const selected = state.filters[key] || [];
      const optRows = rawOpts.map(({ value, label }) => {
        const checked = selected.includes(value);
        return `
          <label class="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-black/[0.04] cursor-pointer select-none">
            <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? "bg-black border-black" : "bg-white border-black/30"}">
              ${checked ? `<svg class="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>` : ""}
            </span>
            <input type="checkbox" class="sr-only"
              data-proj-multicheck="${key}"
              data-proj-multicheck-value="${escapeHtml(value)}"
              ${checked ? "checked" : ""}
            />
            <span class="text-xs">${escapeHtml(label)}</span>
          </label>`;
      }).join("");
      content = `
        <div class="text-[10px] font-bold text-black/40 mb-1.5">${escapeHtml(titleMap[key] || "Filter")}</div>
        <div class="flex flex-col gap-0 max-h-[220px] overflow-auto">
          ${optRows || '<div class="text-xs text-black/40 px-2 py-1.5">No values</div>'}
        </div>
        ${footer}`;

    } else if (DATE_COLS.includes(key)) {
      const lbl = key === "start_date" ? "Start Date" : "End Date";
      const f   = state.filters[key] || { from: "", to: "" };
      content = `
        <div class="text-[10px] font-bold text-black/40 mb-1.5">Filter ${lbl}</div>
        <div class="flex flex-col gap-2">
          <div>
            <div class="text-[10px] text-black/40 mb-0.5">From</div>
            <input type="date" class="input text-xs py-1"
              data-proj-portal-date="${key}" data-proj-portal-bound="from"
              value="${escapeHtml(f.from || "")}" />
          </div>
          <div>
            <div class="text-[10px] text-black/40 mb-0.5">To</div>
            <input type="date" class="input text-xs py-1"
              data-proj-portal-date="${key}" data-proj-portal-bound="to"
              value="${escapeHtml(f.to || "")}" />
          </div>
        </div>
        ${footer}`;

    } else if (NUMERIC_COLS.includes(key)) {
      const f = state.filters[key] || { min: "", max: "" };
      content = `
        <div class="text-[10px] font-bold text-black/40 mb-1.5">Filter range</div>
        <div class="flex flex-col gap-2">
          <div>
            <div class="text-[10px] text-black/40 mb-0.5">Min</div>
            <input type="number" step="1" class="input text-xs py-1"
              data-proj-portal-range="${key}" data-proj-portal-bound="min"
              value="${escapeHtml(f.min || "")}" />
          </div>
          <div>
            <div class="text-[10px] text-black/40 mb-0.5">Max</div>
            <input type="number" step="1" class="input text-xs py-1"
              data-proj-portal-range="${key}" data-proj-portal-bound="max"
              value="${escapeHtml(f.max || "")}" />
          </div>
        </div>
        ${footer}`;

    } else {
      return;
    }

    const portal = document.createElement("div");
    portal.id        = "projFilterMenuPortal";
    portal.className = "fixed z-[200] rounded-xl border border-black/10 bg-white p-3 shadow-xl text-ink-900";
    portal.style.cssText = `top:${top}px; left:${left}px; width:${menuW}px;`;
    portal.innerHTML = content;
    document.body.appendChild(portal);
    portal.querySelector("input, select")?.focus();
  }

  // ── filtering + sorting ────────────────────────────────────────────────────
  function dateInRange(dateStr, from, to) {
    if (!from && !to) return true;
    if (!dateStr) return false;
    const s = String(dateStr).slice(0, 10);
    if (from && s < from) return false;
    if (to   && s > to)   return false;
    return true;
  }

  function filtered() {
    const q = normalize(state.q);
    return rows.filter(r => {
      if (state.filters.project_name &&
          !normalize(r.project_name).includes(normalize(state.filters.project_name))) return false;

      if (state.filters.project_status.length > 0 &&
          !state.filters.project_status.includes(r.project_status || "not_started")) return false;

      if (state.filters.primary_project_manager.length > 0 &&
          !state.filters.primary_project_manager.includes(r.primary_project_manager || "")) return false;

      if (state.filters.primary_work_crew.length > 0 &&
          !state.filters.primary_work_crew.includes(r.primary_work_crew || "")) return false;

      if (!dateInRange(r.start_date, state.filters.start_date.from, state.filters.start_date.to)) return false;
      if (!dateInRange(r.end_date,   state.filters.end_date.from,   state.filters.end_date.to))   return false;

      if (state.filters.wire_guidance.length > 0) {
        const v = Number(r.wire_guidance) ? "yes" : "no";
        if (!state.filters.wire_guidance.includes(v)) return false;
      }

      for (const col of NUMERIC_COLS) {
        const f = state.filters[col];
        if (!f) continue;
        const val = Number(r[col] ?? 0);
        if (f.min !== "" && !Number.isNaN(Number(f.min)) && val < Number(f.min)) return false;
        if (f.max !== "" && !Number.isNaN(Number(f.max)) && val > Number(f.max)) return false;
      }

      if (state.filters.equipment_type.length > 0 &&
          !state.filters.equipment_type.includes(r.equipment_type || "")) return false;

      if (state.filters.notes &&
          !normalize(r.notes).includes(normalize(state.filters.notes))) return false;

      if (q && !normalize(r.project_name).includes(q)) return false;

      return true;
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

  function renderAll() {
    const list = sorted(filtered());
    renderThead();
    renderBody(list);
    renderTimeline();  // keep chart in sync with current filter state
  }

  // Click a stacked-bar segment → drive the table filters.
  // Clicking the same segment again clears those filters (toggle).
  function handleTimelineClick(month, status) {
    const mm      = String(month).padStart(2, "0");
    const lastDay = new Date(Date.UTC(2026, month, 0)).getUTCDate();
    const from    = `2026-${mm}-01`;
    const to      = `2026-${mm}-${String(lastDay).padStart(2, "0")}`;

    const f = state.filters;
    const alreadySelected =
      f.end_date.from === from &&
      f.end_date.to   === to   &&
      f.project_status.length === 1 &&
      f.project_status[0] === status;

    if (alreadySelected) {
      state.filters.end_date       = { from: "", to: "" };
      state.filters.project_status = [];
    } else {
      state.filters.end_date       = { from, to };
      state.filters.project_status = [status];
    }
    renderAll();
  }

  // ── events: search + clear ─────────────────────────────────────────────────
  document.getElementById("projSearchInput").addEventListener("input", e => {
    state.q = e.target.value;
    renderAll();
  });

  document.getElementById("projClearFiltersBtn").addEventListener("click", () => {
    state.q = "";
    state.openFilter = null;
    document.getElementById("projFilterMenuPortal")?.remove();
    Object.keys(state.filters).forEach(k => {
      if      (DATE_COLS.includes(k))        state.filters[k] = { from: "", to: "" };
      else if (NUMERIC_COLS.includes(k))     state.filters[k] = { min: "", max: "" };
      else if (MULTISELECT_COLS.includes(k)) state.filters[k] = [];
      else                                   state.filters[k] = "";
    });
    document.getElementById("projSearchInput").value = "";
    renderAll();
  });

  // ── events: thead clicks (sort / open filter) ──────────────────────────────
  document.getElementById("projTableThead").addEventListener("click", e => {
    const filterBtn = e.target.closest("[data-open-filter]");
    if (filterBtn) {
      e.stopPropagation();
      const key = filterBtn.getAttribute("data-open-filter");
      if (state.openFilter === key) {
        state.openFilter = null;
        document.getElementById("projFilterMenuPortal")?.remove();
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
      document.getElementById("projFilterMenuPortal")?.remove();
      state.openFilter = null;
      renderAll();
    }
  });

  // ── events: portal interactions (click outside, close, clear) ──────────────
  document.addEventListener("click", e => {
    const portal = document.getElementById("projFilterMenuPortal");
    if (!portal) return;

    if (e.target.closest("[data-proj-portal-close]")) {
      state.openFilter = null;
      portal.remove();
      renderAll();
      return;
    }

    const clearBtn = e.target.closest("[data-proj-portal-clear]");
    if (clearBtn) {
      const key = clearBtn.getAttribute("data-proj-portal-clear");
      if      (DATE_COLS.includes(key))        state.filters[key] = { from: "", to: "" };
      else if (NUMERIC_COLS.includes(key))     state.filters[key] = { min: "", max: "" };
      else if (MULTISELECT_COLS.includes(key)) state.filters[key] = [];
      else if (key in state.filters)           state.filters[key] = "";
      state.openFilter = null;
      portal.remove();
      renderAll();
      return;
    }

    const inPortal = portal.contains(e.target);
    const inThead  = e.target.closest("#projTableThead");
    if (!inPortal && !inThead) {
      state.openFilter = null;
      portal.remove();
      renderAll();
    }
  });

  // ── events: portal inputs ──────────────────────────────────────────────────
  document.addEventListener("change", e => {
    const multiCheck = e.target.closest("[data-proj-multicheck]");
    if (!multiCheck) return;
    const key   = multiCheck.getAttribute("data-proj-multicheck");
    const value = multiCheck.getAttribute("data-proj-multicheck-value");
    const current = state.filters[key] || [];
    state.filters[key] = multiCheck.checked
      ? [...current, value]
      : current.filter(v => v !== value);

    const indicator = multiCheck.previousElementSibling;
    const isChecked = state.filters[key].includes(value);
    if (indicator) {
      indicator.className = `flex h-4 w-4 shrink-0 items-center justify-center rounded border ${isChecked ? "bg-black border-black" : "bg-white border-black/30"}`;
      indicator.innerHTML = isChecked
        ? `<svg class="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`
        : "";
    }
    renderAll();
  });

  document.addEventListener("input", e => {
    const inp = e.target.closest("[data-proj-portal-input]");
    if (inp) {
      const key = inp.getAttribute("data-proj-portal-input");
      if (key in state.filters) state.filters[key] = inp.value;
      renderAll();
      return;
    }
    const rangeInp = e.target.closest("[data-proj-portal-range]");
    if (rangeInp) {
      const key   = rangeInp.getAttribute("data-proj-portal-range");
      const bound = rangeInp.getAttribute("data-proj-portal-bound");
      if (NUMERIC_COLS.includes(key)) {
        if (typeof state.filters[key] !== "object") state.filters[key] = { min: "", max: "" };
        state.filters[key][bound] = rangeInp.value;
        renderAll();
      }
      return;
    }
    const dateInp = e.target.closest("[data-proj-portal-date]");
    if (dateInp) {
      const key   = dateInp.getAttribute("data-proj-portal-date");
      const bound = dateInp.getAttribute("data-proj-portal-bound");
      if (DATE_COLS.includes(key)) {
        if (typeof state.filters[key] !== "object") state.filters[key] = { from: "", to: "" };
        state.filters[key][bound] = dateInp.value;
        renderAll();
      }
    }
  });

  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    const portal = document.getElementById("projFilterMenuPortal");
    if (portal) { state.openFilter = null; portal.remove(); renderAll(); }
    if (!document.getElementById("projFileModal").classList.contains("hidden")) {
      closeFileModal();
    }
  });

  // ── events: row actions (Upload + View) ────────────────────────────────────
  document.getElementById("projTableBody").addEventListener("click", async e => {
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
          // Increment file_count on every schedule-item row of this project
          rows.forEach(r => {
            if (String(r.qbo_customer_id) === String(id)) {
              r.file_count = Number(r.file_count || 0) + 1;
            }
          });
          renderAll();
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
  const fileModalState = { projectName: "", files: [], activeIndex: 0 };

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

  function openFileModal(name, files, startIndex = 0) {
    fileModalState.projectName = name || "Project Files";
    fileModalState.files       = files;
    fileModalState.activeIndex = startIndex;
    document.getElementById("projFileModalTitle").textContent    = fileModalState.projectName;
    document.getElementById("projFileModalSubtitle").textContent = `${files.length} file${files.length === 1 ? "" : "s"}`;
    document.getElementById("projFileModal").classList.remove("hidden");
    renderFileModal();
  }

  function closeFileModal() {
    document.getElementById("projFileModal").classList.add("hidden");
    document.getElementById("projFilePreview").innerHTML = "";
    document.getElementById("projFileList").innerHTML    = "";
  }

  function renderFileModal() {
    const files  = fileModalState.files;
    const active = files[fileModalState.activeIndex];
    if (!active) { closeFileModal(); return; }

    document.getElementById("projFileList").innerHTML = files.map((f, idx) => {
      const sel   = idx === fileModalState.activeIndex;
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

    const prev = document.getElementById("projFilePreview");
    if (isImg(active)) {
      prev.innerHTML = `<img src="${ea(active.url)}" class="max-w-full max-h-full object-contain rounded-2xl shadow-sm" />`;
    } else if (active.content_type === "application/pdf") {
      prev.innerHTML = `<iframe src="${ea(active.url)}" class="w-full h-full rounded-2xl bg-white" title="${ea(active.original_filename || "PDF")}"></iframe>`;
    } else {
      prev.innerHTML = `<div class="text-center text-black/60"><div class="font-bold">Preview unavailable</div><div class="mt-1 text-sm">Open in new tab.</div></div>`;
    }

    document.getElementById("projMetaFilename").textContent    = active.original_filename || "";
    document.getElementById("projMetaCreatedAt").textContent   = fmtDateTime(active.created_at);
    document.getElementById("projMetaContentType").textContent = active.content_type || "";
    document.getElementById("projMetaSize").textContent        = fmtBytes(active.size_bytes);
    document.getElementById("projOpenFileLink").href           = active.url;
  }

  document.getElementById("projFileModalClose").addEventListener("click", closeFileModal);
  document.getElementById("projFileModal").addEventListener("click", e => {
    if (e.target.closest("[data-close-proj-file-modal='1']")) { closeFileModal(); return; }
    const fb = e.target.closest("[data-file-index]");
    if (fb) {
      fileModalState.activeIndex = Number(fb.getAttribute("data-file-index"));
      renderFileModal();
    }
  });

  // ── initial render ─────────────────────────────────────────────────────────
  renderAll();   // also renders the timeline (they're linked)

  // Double-rAF so the timeline + card header are fully laid out before we
  // measure the table card's top position and compute its available height.
  requestAnimationFrame(() => requestAnimationFrame(fitTableCardHeight));

  const timelineHost = document.getElementById("timelineChart");
  if (timelineHost) {
    const roT = new ResizeObserver(() => {
      renderTimeline();
      // Timeline re-render may shift layout (e.g., y-axis label width change)
      fitTableCardHeight();
    });
    roT.observe(timelineHost);
  }
}
