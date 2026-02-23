import { api } from "../api.js";
import { setShell } from "../shell.js";
import { fmtDate, fmtMoney, fmtPct } from "../utils/format.js";
import { escapeHtml } from "../utils/html.js";

export async function projectsPage(routeFn) {
  const data = await api("/projects");
  const rows = data.projects || [];

  const state = {
    q: "",
    sortKey: "project_name",
    sortDir: "asc",
    kpiFilter: "all", // default shows everything
  };

  // Date-only helper (no time)
  function fmtDateOnly(v) {
    if (!v) return "";
    // Supports "YYYY-MM-DD", ISO strings, or Date-like values.
    // If your backend sends ISO with time, take first 10 chars.
    const s = String(v);
    if (s.length >= 10) return s.slice(0, 10);
    // fallback to existing formatter if needed
    return fmtDate(v);
  }

  const bodyHtml = `
    <div class="h-full flex flex-col min-h-0 gap-4">
      <!-- KPI card (fixed height) -->
      <div class="card p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">Projects</div>
            <div class="text-sm text-black/60">Status and totals</div>
          </div>

          <div class="flex items-center gap-2">
            <div class="text-sm font-semibold text-black/60 whitespace-nowrap">Search</div>
            <input id="searchInput" class="input w-64" placeholder="Name, status, PM, crew" />
          </div>
        </div>

        <div class="mt-3 kpi-grid" id="kpiGrid"></div>
      </div>

      <!-- TABLE card must fill remaining height -->
      <div class="card p-5 flex flex-col min-h-0 flex-1">
        <div class="flex items-end justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">Projects</div>
            <div class="text-sm text-black/60">Scroll + sort by column</div>
          </div>
          <div class="text-sm text-black/60" id="rowCount">—</div>
        </div>

        <!-- table frame fills remaining height inside this card -->
        <div class="mt-4 border border-black/5 bg-white/40 rounded-2xl overflow-hidden flex-1 min-h-0">
          <!-- Column layout so we can pin a horizontal scrollbar at the bottom -->
          <div class="flex flex-col h-full min-h-0">
            <!-- Main scroller: vertical scroll lives here. Hide horizontal so we don't get 2 bars. -->
            <div id="tableScroller" class="table-scroll flex-1 min-h-0 overflow-auto overflow-x-hidden">
              <table id="projectsTable" class="text-sm border-collapse w-full min-w-[1500px]">
                <thead class="sticky top-0 z-20 bg-white shadow-sm text-left text-black/60 border-b border-black/10">
                  <tr>
                    ${th("project_name", "Project")}
                    ${th("project_status", "Status")}
                    ${th("start_date", "Start")}
                    ${th("end_date", "End")}
                    ${th("primary_project_manager", "Project Manager")}
                    ${th("primary_work_crew", "Work Crew")}
                    ${th("project_balance", "Balance")}
                    ${th("total_income", "Income")}
                    ${th("total_cost", "Cost")}
                    ${th("total_profit", "Profit")}
                    ${th("profit_margin", "Margin")}
                    ${th("project_create_dttm", "Created")}
                    ${th("project_lastupdate_dttm", "Last updated")}
                    ${th("total_transaction_ct", "Txns")}
                  </tr>
                </thead>
                <tbody id="projectsBody"></tbody>
              </table>
            </div>

            <!-- Sticky horizontal scrollbar (always visible) -->
            <div id="hScroll" class="hscrollbar">
              <div id="hScrollInner" class="hscrollbar-inner"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  setShell({
    title: "Projects",
    subtitle: "Compact project overview + sortable table.",
    bodyHtml,
    showLogout: true,
    routeFn,
  });

  function th(key, label) {
    return `
      <th class="py-2 px-3 whitespace-nowrap text-left align-middle">
        <button
          class="block w-full text-left font-bold rounded-xl hover:bg-black/5 px-0 py-0"
          data-sort="${key}"
        >
          ${label}
        </button>
      </th>`;
  }

  function normalize(v) {
    return (v ?? "").toString().toLowerCase();
  }

  function bucketOf(r) {
    if (Number(r.needs_assignment) === 1) return "needs_assignment";
    const st = (r.project_status || "").toLowerCase();
    if (st === "not_started") return "not_started";
    if (st === "in_progress") return "in_progress";
    if (st === "completed") return "completed";
    return "not_started";
  }

  function statusLabelOf(r) {
    if (Number(r.needs_assignment) === 1) return "Needs Attention";
    const st = (r.project_status || "").toLowerCase();
    if (st === "not_started") return "Not Started";
    if (st === "in_progress") return "In Progress";
    if (st === "completed") return "Completed";
    return st ? st : "";
  }

  function filtered() {
    const q = normalize(state.q);
    return rows.filter((r) => {
      // KPI filter
      if (state.kpiFilter && state.kpiFilter !== "all") {
        if (bucketOf(r) !== state.kpiFilter) return false;
      }

      // Search filter
      if (!q) return true;

      return (
        normalize(r.project_name).includes(q) ||
        normalize(r.project_qbo_id).includes(q) ||
        normalize(statusLabelOf(r)).includes(q) ||
        normalize(r.primary_project_manager).includes(q) ||
        normalize(r.primary_work_crew).includes(q)
      );
    });
  }

  function sorted(list) {
    const dir = state.sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = a[state.sortKey];
      const vb = b[state.sortKey];

      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;

      const na = Number(va),
        nb = Number(vb);
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return (na - nb) * dir;

      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  function renderKpis(list) {
    const total = rows.length;

    const counts = {
      needs_assignment: 0,
      not_started: 0,
      in_progress: 0,
      completed: 0,
    };

    for (const r of rows) counts[bucketOf(r)] += 1;

    const grid = document.getElementById("kpiGrid");
    grid.innerHTML = `
      ${kpi("Needs Attention", counts.needs_assignment, "needs_assignment")}
      ${kpi("Not Started", counts.not_started, "not_started")}
      ${kpi("In Progress", counts.in_progress, "in_progress")}
      ${kpi("Completed", counts.completed, "completed")}
      ${kpi("Total", total, "all")}
      ${kpi("Showing", list.length, "showing")}
    `;

    function kpi(label, value, key) {
      const selected =
        (key === "all" && state.kpiFilter === "all") ||
        (key !== "all" && key !== "showing" && state.kpiFilter === key);

      const clickable = key !== "showing";

      return `
        <button
          type="button"
          class="rounded-xl border border-black/10 px-4 py-3 text-center ${
            selected ? "bg-black/10" : "bg-black/5"
          } ${clickable ? "hover:bg-black/10 cursor-pointer" : "cursor-default"}"
          ${clickable ? `data-kpi="${key}"` : ""}
          ${clickable ? `aria-pressed="${selected ? "true" : "false"}"` : ""}
        >
          <div class="text-xs font-bold text-black/60">${label}</div>
          <div class="pt-1 text-2xl font-extrabold leading-tight">${value}</div>
        </button>
      `;
    }
  }

  function renderTable() {
    const list = sorted(filtered());
    renderKpis(list);
    document.getElementById("rowCount").textContent = `${list.length} projects`;

    const tbody = document.getElementById("projectsBody");
    tbody.innerHTML =
      list
        .map((r) => {
          const statusLabel = statusLabelOf(r);

          return `
        <tr class="border-b border-black/5">
          <td class="py-2 px-3 text-left font-semibold truncate min-w-[220px]" title="${escapeHtml(
            r.project_name || ""
          )}">
            ${escapeHtml(r.project_name || "")}
          </td>

          <td class="py-2 px-3 text-left whitespace-nowrap">${escapeHtml(statusLabel)}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${escapeHtml(fmtDateOnly(r.start_date))}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${escapeHtml(fmtDateOnly(r.end_date))}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${escapeHtml(r.primary_project_manager || "")}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${escapeHtml(r.primary_work_crew || "")}</td>

          <td class="py-2 px-3 text-left whitespace-nowrap">${fmtMoney(r.project_balance)}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${fmtMoney(r.total_income)}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${fmtMoney(r.total_cost)}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${fmtMoney(r.total_profit)}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${fmtPct(r.profit_margin)}</td>

          <td class="py-2 px-3 text-left whitespace-nowrap">${escapeHtml(fmtDateOnly(r.project_create_dttm))}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${escapeHtml(fmtDateOnly(r.project_lastupdate_dttm))}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${r.total_transaction_ct ?? ""}</td>
        </tr>
      `;
        })
        .join("") ||
      `
      <tr><td class="py-6 text-center text-black/50" colspan="14">No projects match these filters.</td></tr>
    `;
  }

  document.getElementById("kpiGrid").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-kpi]");
    if (!btn) return;

    const key = btn.getAttribute("data-kpi");
    state.kpiFilter = state.kpiFilter === key ? "all" : key;
    renderTable();
  });

  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.q = e.target.value;
    renderTable();
  });

  document.querySelector("#projectsTable thead").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sort]");
    if (!btn) return;
    const key = btn.getAttribute("data-sort");
    if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else {
      state.sortKey = key;
      state.sortDir = "asc";
    }
    renderTable();
  });

  renderTable();
}