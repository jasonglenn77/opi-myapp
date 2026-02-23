import { api } from "../api.js";
import { setShell } from "../shell.js";
import { fmtDate, fmtMoney, fmtPct } from "../utils/format.js";
import { escapeHtml } from "../utils/html.js";

export async function dashboardPage(routeFn) {
  const data = await api("/dashboard");
  const rows = data.projects || [];
  const summary = data.summary || null;

  const state = {
    q: "",
    sortKey: "project_name",
    sortDir: "asc",
  };

  const bodyHtml = `
    <div class="card p-5">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-lg font-extrabold">Projects</div>
          <div class="text-sm text-black/60">Snapshot from QBO rollups</div>
        </div>

        <div class="text-sm text-black/60 font-semibold">
          Avg age <span id="avgAgePill" class="inline-flex rounded-full px-2 py-0.5 bg-black/5 text-ink-800 font-bold">— days</span>
        </div>
      </div>

      <div class="mt-3 kpi-grid" id="kpiGrid"></div>
    </div>

    <div class="mt-4 card p-5">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-2">
          <div class="text-sm font-semibold text-black/60">Search</div>
          <input id="searchInput" class="input w-64" placeholder="Project name or QBO id" />
        </div>
      </div>
    </div>

    <div class="mt-4 card p-5">
      <div class="flex items-end justify-between gap-3">
        <div>
          <div class="text-lg font-extrabold">Projects</div>
          <div class="text-sm text-black/60">Scroll + sort by column</div>
        </div>
        <div class="text-sm text-black/60" id="rowCount">—</div>
      </div>

      <div class="mt-4 border border-black/5 bg-white/40 rounded-2xl overflow-hidden">
        <div class="table-scroll">
          <table id="projectsTable" class="text-sm border-collapse w-full min-w-[980px]">
            <thead class="sticky top-0 z-20 bg-white shadow-sm text-left text-black/60 border-b border-black/10">
              <tr>
                ${th("project_name", "Project")}
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
      </div>
    </div>
  `;

  setShell({
    title: "Dashboard",
    subtitle: "Compact project overview + sortable table.",
    bodyHtml,
    showLogout: true,
    routeFn
  });

  function th(key, label) {
    return `
      <th class="py-2 px-3 whitespace-nowrap">
        <button class="font-bold hover:bg-black/5 rounded-xl px-2 py-1" data-sort="${key}">
          ${label}
        </button>
      </th>`;
  }

  function normalize(v) {
    return (v ?? "").toString().toLowerCase();
  }

  function filtered() {
    const q = normalize(state.q);
    return rows.filter(r => {
      if (!q) return true;
      return normalize(r.project_name).includes(q) || normalize(r.project_qbo_id).includes(q);
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

      const na = Number(va), nb = Number(vb);
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return (na - nb) * dir;

      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  function renderKpis(list) {
    const counts = { ALL: rows.length };

    // Prefer backend avg if present
    const avg = (summary && typeof summary.avg_age_days === "number")
      ? summary.avg_age_days
      : null;

    document.getElementById("avgAgePill").textContent =
      avg != null ? `${avg.toFixed(1)} days` : "— days";

    const grid = document.getElementById("kpiGrid");
    grid.innerHTML = `
      ${kpi("Total", counts.ALL || 0)}
      ${kpi("Showing", list.length)}
    `;

    function kpi(label, value) {
      return `
        <div class="rounded-xl border border-black/10 bg-black/5 px-4 py-3">
          <div class="text-xs font-bold text-black/60">${label}</div>
          <div class="text-2xl font-extrabold leading-tight">${value}</div>
        </div>
      `;
    }
  }

  function renderTable() {
    const list = sorted(filtered());
    renderKpis(list);
    document.getElementById("rowCount").textContent = `${list.length} projects`;

    const tbody = document.getElementById("projectsBody");
    tbody.innerHTML = list.map(r => {
      return `
        <tr class="border-b border-black/5">
          <td class="py-2 px-2 font-semibold truncate min-w-[100px]" title="${escapeHtml(r.project_name || "")}">${escapeHtml(r.project_name || "")}</td>
          <td class="py-2 px-2 whitespace-nowrap">${fmtMoney(r.project_balance)}</td>
          <td class="py-2 px-2 whitespace-nowrap">${fmtMoney(r.total_income)}</td>
          <td class="py-2 px-2 whitespace-nowrap">${fmtMoney(r.total_cost)}</td>
          <td class="py-2 px-2 whitespace-nowrap">${fmtMoney(r.total_profit)}</td>
          <td class="py-2 px-2 whitespace-nowrap">${fmtPct(r.profit_margin)}</td>
          <td class="py-2 px-2 whitespace-nowrap">${fmtDate(r.project_create_dttm)}</td>
          <td class="py-2 px-2 whitespace-nowrap">${fmtDate(r.project_lastupdate_dttm)}</td>
          <td class="py-2 px-2 whitespace-nowrap">${r.total_transaction_ct ?? ""}</td>
        </tr>
      `;
    }).join("") || `
      <tr><td class="py-6 text-center text-black/50" colspan="9">No projects match these filters.</td></tr>
    `;
  }

  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.q = e.target.value;
    renderTable();
  });

  document.querySelector("#projectsTable thead").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sort]");
    if (!btn) return;
    const key = btn.getAttribute("data-sort");
    if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else { state.sortKey = key; state.sortDir = "asc"; }
    renderTable();
  });

  renderTable();
}