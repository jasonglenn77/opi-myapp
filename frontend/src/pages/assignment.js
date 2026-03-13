import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

export async function assignmentPage(routeFn) {
  const res = await api("/assignment/table");
  const rows = (res.projects || []).map((r) => ({
    ...r,
    _bundle: null,
    _loadingBundle: false,
  }));

  const state = {
    q: "",
    sortKey: "project_name",
    sortDir: "asc",
    openFilter: null, // column key
    editing: { rowId: null, field: null },
    flashKey: null,
    filters: {
      project_name: "",
      project_status: "",
      start_date_from: "",
      start_date_to: "",
      end_date_from: "",
      end_date_to: "",
      project_create_date_from: "",
      project_create_date_to: "",
      primary_project_manager: "",
      primary_work_crew: "",
    },
  };

  const STATUS_OPTIONS = [
    { value: "not_started", label: "Not Started" },
    { value: "in_progress", label: "In Progress" },
    { value: "completed", label: "Completed" },
  ];

  const KPI_STYLES = {
    needs_assignment: {
      wrap: "bg-kpi-attention-bg border-kpi-attention-bd",
      label: "text-kpi-attention-text",
    },
    not_started: {
      wrap: "bg-kpi-notStarted-bg border-kpi-notStarted-bd",
      label: "text-kpi-notStarted-text",
    },
    in_progress: {
      wrap: "bg-kpi-inProgress-bg border-kpi-inProgress-bd",
      label: "text-kpi-inProgress-text",
    },
    completed: {
      wrap: "bg-kpi-completed-bg border-kpi-completed-bd",
      label: "text-kpi-completed-text",
    },
    all: {
      wrap: "bg-kpi-total-bg border-kpi-total-bd",
      label: "text-kpi-total-text",
    },
  };

  function normalize(v) {
    return (v ?? "").toString().trim().toLowerCase();
  }

  function parseIsoDate(v) {
    if (!v) return null;
    const s = String(v).slice(0, 10);
    const [y, m, d] = s.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }

  function formatMmDdYyyy(v) {
    const dt = parseIsoDate(v);
    if (!dt) return "";
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    const yyyy = dt.getFullYear();
    return `${mm}-${dd}-${yyyy}`;
  }

  function isoToInput(v) {
    if (!v) return "";
    return String(v).slice(0, 10);
  }

  function mmddyyyyToIso(v) {
    const s = String(v || "").trim();
    if (!s) return "";
    const m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!m) return "";
    const mm = Number(m[1]);
    const dd = Number(m[2]);
    const yyyy = Number(m[3]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || yyyy < 1900) return "";
    return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }

  function statusLabel(v) {
    if (v == null || String(v).trim() === "") return "Needs Attention";
    if (v === "not_started") return "Not Started";
    if (v === "in_progress") return "In Progress";
    if (v === "completed") return "Completed";
    return String(v);
  }

  function statusBucket(v) {
    if (v == null || String(v).trim() === "") return "needs_assignment";
    if (v === "not_started") return "not_started";
    if (v === "in_progress") return "in_progress";
    if (v === "completed") return "completed";
    return "all";
  }

  function statusPill(v) {
    const s = KPI_STYLES[statusBucket(v)] || KPI_STYLES.all;
    return `
      <span class="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${s.wrap} ${s.label}">
        ${escapeHtml(statusLabel(v))}
      </span>
    `;
  }

  function setMsg(text, ok = false) {
    const el = document.getElementById("assignPageMsg");
    el.textContent = text || "";
    el.className = ok
      ? "mt-1 text-sm text-green-700 min-h-[1rem]"
      : "mt-1 text-sm text-red-700 min-h-[1rem]";
  }

  function clearEditing() {
    state.editing.rowId = null;
    state.editing.field = null;
  }

  function isEditing(rowId, field) {
    return String(state.editing.rowId || "") === String(rowId || "") && state.editing.field === field;
  }

  function flashCell(rowId, field) {
    state.flashKey = `${rowId}:${field}`;
    renderAll();
    window.setTimeout(() => {
      if (state.flashKey === `${rowId}:${field}`) {
        state.flashKey = null;
        renderAll();
      }
    }, 1200);
  }

  function isFlashed(rowId, field) {
    return state.flashKey === `${rowId}:${field}`;
  }

  async function ensureBundle(row) {
    if (row._bundle) return row._bundle;
    row._loadingBundle = true;
    renderAll();
    try {
      row._bundle = await api(`/assignment/bundle?qbo_customer_id=${encodeURIComponent(row.qbo_customer_id)}`);
      return row._bundle;
    } finally {
      row._loadingBundle = false;
      renderAll();
    }
  }

  function getPmOptions() {
    const set = new Set();
    rows.forEach((r) => {
      (r.all_project_managers || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .forEach((x) => set.add(x));
    });
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  function getCrewOptions() {
    const set = new Set();
    rows.forEach((r) => {
      (r.all_work_crews || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .forEach((x) => set.add(x));
    });
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  function filterIcon(active = false) {
    return `
      <svg class="shrink-0 size-3.5 ${active ? "text-black" : ""}" xmlns="http://www.w3.org/2000/svg" width="24" height="24"
        viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round">
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
      </svg>
    `;
  }

  function isFilterActive(key) {
    if (key === "project_name") return !!state.filters.project_name;
    if (key === "project_status") return !!state.filters.project_status;
    if (key === "start_date") return !!(state.filters.start_date_from || state.filters.start_date_to);
    if (key === "end_date") return !!(state.filters.end_date_from || state.filters.end_date_to);
    if (key === "project_create_date") return !!(state.filters.project_create_date_from || state.filters.project_create_date_to);
    if (key === "primary_project_manager") return !!state.filters.primary_project_manager;
    if (key === "primary_work_crew") return !!state.filters.primary_work_crew;
    return false;
  }

  function sortArrow(key) {
    return state.sortKey === key ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
  }

  function renderFilterMenu(key) {
    if (state.openFilter !== key) return "";

    if (key === "project_name") {
      return `
        <div class="absolute left-0 top-8 z-50 w-72 rounded-xl border border-black/10 bg-white p-3 shadow-xl">
          <div class="text-xs font-bold text-black/50 mb-2">Filter Project Name</div>
          <input
            class="input"
            placeholder="Search project name"
            data-filter-input="project_name"
            value="${escapeHtml(state.filters.project_name || "")}"
          />
          <div class="mt-3 flex justify-end gap-2">
            <button type="button" class="inline-flex items-center rounded-xl border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-black/5" data-clear-filter="project_name">Clear</button>
            <button type="button" class="btn-primary" data-close-filter="1">Done</button>
          </div>
        </div>
      `;
    }

    if (key === "project_status") {
      return `
        <div class="absolute right-0 top-8 z-50 w-64 rounded-xl border border-black/10 bg-white p-3 shadow-xl">
          <div class="text-xs font-bold text-black/50 mb-2">Filter Status</div>
          <select class="input" data-filter-select="project_status">
            <option value="">All statuses</option>
            <option value="Needs Attention" ${state.filters.project_status === "Needs Attention" ? "selected" : ""}>Needs Attention</option>
            <option value="Not Started" ${state.filters.project_status === "Not Started" ? "selected" : ""}>Not Started</option>
            <option value="In Progress" ${state.filters.project_status === "In Progress" ? "selected" : ""}>In Progress</option>
            <option value="Completed" ${state.filters.project_status === "Completed" ? "selected" : ""}>Completed</option>
          </select>
          <div class="mt-3 flex justify-end gap-2">
            <button type="button" class="inline-flex items-center rounded-xl border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-black/5" data-clear-filter="project_status">Clear</button>
            <button type="button" class="btn-primary" data-close-filter="1">Done</button>
          </div>
        </div>
      `;
    }

    if (key === "primary_project_manager") {
      const options = getPmOptions();
      return `
        <div class="absolute right-0 top-8 z-50 w-72 rounded-xl border border-black/10 bg-white p-3 shadow-xl">
          <div class="text-xs font-bold text-black/50 mb-2">Filter Project Manager</div>
          <select class="input" data-filter-select="primary_project_manager">
            <option value="">All project managers</option>
            ${options.map((x) => `<option value="${escapeHtml(x)}" ${state.filters.primary_project_manager === x ? "selected" : ""}>${escapeHtml(x)}</option>`).join("")}
          </select>
          <div class="mt-3 flex justify-end gap-2">
            <button type="button" class="inline-flex items-center rounded-xl border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-black/5" data-clear-filter="primary_project_manager">Clear</button>
            <button type="button" class="btn-primary" data-close-filter="1">Done</button>
          </div>
        </div>
      `;
    }

    if (key === "primary_work_crew") {
      const options = getCrewOptions();
      return `
        <div class="absolute right-0 top-8 z-50 w-72 rounded-xl border border-black/10 bg-white p-3 shadow-xl">
          <div class="text-xs font-bold text-black/50 mb-2">Filter Work Crew</div>
          <select class="input" data-filter-select="primary_work_crew">
            <option value="">All work crews</option>
            ${options.map((x) => `<option value="${escapeHtml(x)}" ${state.filters.primary_work_crew === x ? "selected" : ""}>${escapeHtml(x)}</option>`).join("")}
          </select>
          <div class="mt-3 flex justify-end gap-2">
            <button type="button" class="inline-flex items-center rounded-xl border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-black/5" data-clear-filter="primary_work_crew">Clear</button>
            <button type="button" class="btn-primary" data-close-filter="1">Done</button>
          </div>
        </div>
      `;
    }

    if (key === "start_date" || key === "end_date" || key === "project_create_date") {
      const fromKey = `${key}_from`;
      const toKey = `${key}_to`;

      return `
        <div class="absolute right-0 top-8 z-50 w-72 rounded-xl border border-black/10 bg-white p-3 shadow-xl">
          <div class="text-xs font-bold text-black/50 mb-2">Filter ${escapeHtml(key.replaceAll("_", " "))}</div>
          <div class="space-y-2">
            <div>
              <div class="text-[11px] text-black/50 mb-1">From</div>
              <input type="date" class="input" data-filter-input="${fromKey}" value="${escapeHtml(state.filters[fromKey] || "")}" />
            </div>
            <div>
              <div class="text-[11px] text-black/50 mb-1">To</div>
              <input type="date" class="input" data-filter-input="${toKey}" value="${escapeHtml(state.filters[toKey] || "")}" />
            </div>
          </div>
          <div class="mt-3 flex justify-end gap-2">
            <button type="button" class="inline-flex items-center rounded-xl border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-black/5" data-clear-filter="${key}">Clear</button>
            <button type="button" class="btn-primary" data-close-filter="1">Done</button>
          </div>
        </div>
      `;
    }

    return "";
  }

  function th(key, label) {
    return `
      <th class="py-2 px-3 whitespace-nowrap text-left align-middle">
        <div class="relative inline-flex items-center gap-2">
          <button
            type="button"
            class="text-left font-bold rounded-xl hover:bg-black/5 leading-none"
            data-sort="${key}"
          >
            ${label}${sortArrow(key)}
          </button>

          <button
            type="button"
            class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${isFilterActive(key) ? "border-black/15 bg-black/5" : "border-transparent"} hover:border-black/10 hover:bg-black/5"
            data-open-filter="${key}"
            aria-label="Filter ${label}"
          >
            ${filterIcon(isFilterActive(key))}
          </button>

          ${renderFilterMenu(key)}
        </div>
      </th>
    `;
  }
  
  const bodyHtml = `
    <div class="h-full min-h-0 flex flex-col gap-4">
      <div class="card p-5 flex flex-col flex-1 min-h-0 overflow-hidden">
        <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">Assignments</div>
            <div class="text-sm text-black/60">Sort columns, filter from the funnel button, and edit directly in the row.</div>
          </div>

          <div class="flex items-center gap-2">
            <div class="text-sm font-semibold text-black/60 whitespace-nowrap">Search</div>
            <input id="searchInput" class="input w-full sm:w-72" placeholder="Project, status, PM, crew" />
          </div>
        </div>

        <div id="assignPageMsg" class="mt-1 text-sm min-h-[1rem]"></div>

        <div class="mt-4 border border-black/5 bg-white/40 rounded-2xl flex-1 min-h-0 overflow-hidden">
          <div class="flex flex-col h-full min-h-0">
            <div
              id="tableScroller"
              class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain [-webkit-overflow-scrolling:touch]"
            >
              <table id="assignmentTable" class="text-sm border-collapse w-full min-w-[1500px]">
                <thead class="sticky top-0 z-40 bg-white shadow-sm text-left text-black/60 border-b border-black/10">
                  <tr>
                    ${th("project_name", "Project Name")}
                    ${th("project_status", "Project Status")}
                    ${th("start_date", "Start Date")}
                    ${th("end_date", "End Date")}
                    ${th("primary_project_manager", "Project Manager")}
                    ${th("primary_work_crew", "Work Crew")}
                    ${th("project_create_date", "QB Create Dt")}
                  </tr>
                </thead>
                <tbody id="assignmentBody"></tbody>
              </table>
            </div>

            <div id="hScroll" class="hscrollbar">
              <div id="hScrollInner" class="hscrollbar-inner"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  setShell({
    title: "Assignment",
    subtitle: "Manage assignments inline.",
    bodyHtml,
    showLogout: true,
    routeFn,
    scrollMode: "viewport",
  });

  function syncStickyHScroll() {
    const scroller = document.getElementById("tableScroller");
    const hScroll = document.getElementById("hScroll");
    const hInner = document.getElementById("hScrollInner");
    const table = document.getElementById("assignmentTable");
    if (!scroller || !hScroll || !hInner || !table) return;
    hInner.style.width = `${table.scrollWidth}px`;
    hScroll.scrollLeft = scroller.scrollLeft;
  }

  function bindStickyHScroll() {
    const scroller = document.getElementById("tableScroller");
    const hScroll = document.getElementById("hScroll");
    if (!scroller || !hScroll) return;

    let lock = false;
    scroller.addEventListener("scroll", () => {
      if (lock) return;
      lock = true;
      hScroll.scrollLeft = scroller.scrollLeft;
      lock = false;
    });

    hScroll.addEventListener("scroll", () => {
      if (lock) return;
      lock = true;
      scroller.scrollLeft = hScroll.scrollLeft;
      lock = false;
    });

    window.addEventListener("resize", syncStickyHScroll);
  }

  function inDateRange(isoValue, fromValue, toValue) {
    if (!fromValue && !toValue) return true;
    if (!isoValue) return false;
    const v = String(isoValue).slice(0, 10);
    if (fromValue && v < fromValue) return false;
    if (toValue && v > toValue) return false;
    return true;
  }

  function filtered() {
    const q = normalize(state.q);

    return rows.filter((r) => {
      if (state.filters.project_name && !normalize(r.project_name).includes(normalize(state.filters.project_name))) return false;

      if (state.filters.project_status && normalize(statusLabel(r.project_status)) !== normalize(state.filters.project_status)) return false;

      if (!inDateRange(r.start_date, state.filters.start_date_from, state.filters.start_date_to)) return false;
      if (!inDateRange(r.end_date, state.filters.end_date_from, state.filters.end_date_to)) return false;
      if (!inDateRange(r.project_create_date, state.filters.project_create_date_from, state.filters.project_create_date_to)) return false;

      if (state.filters.primary_project_manager) {
        const all = normalize(r.all_project_managers || "");
        if (!all.includes(normalize(state.filters.primary_project_manager))) return false;
      }

      if (state.filters.primary_work_crew) {
        const all = normalize(r.all_work_crews || "");
        if (!all.includes(normalize(state.filters.primary_work_crew))) return false;
      }

      if (!q) return true;

      return (
        normalize(r.project_name).includes(q) ||
        normalize(statusLabel(r.project_status)).includes(q) ||
        normalize(r.all_project_managers).includes(q) ||
        normalize(r.all_work_crews).includes(q) ||
        normalize(formatMmDdYyyy(r.start_date)).includes(q) ||
        normalize(formatMmDdYyyy(r.end_date)).includes(q) ||
        normalize(formatMmDdYyyy(r.project_create_date)).includes(q)
      );
    });
  }

  function sortValue(r, key) {
    if (key === "project_status") return statusLabel(r.project_status);
    if (key === "start_date") return isoToInput(r.start_date);
    if (key === "end_date") return isoToInput(r.end_date);
    if (key === "project_create_date") return isoToInput(r.project_create_date);
    if (key === "primary_project_manager") return r.all_project_managers || "";
    if (key === "primary_work_crew") return r.all_work_crews || "";
    return r[key] ?? "";
  }

  function sorted(list) {
    const dir = state.sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = sortValue(a, state.sortKey);
      const vb = sortValue(b, state.sortKey);

      if (va == null && vb == null) return 0;
      if (va == null || va === "") return 1;
      if (vb == null || vb === "") return -1;

      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  function cellClass(row, field, extra = "") {
    const flashed = isFlashed(row.qbo_customer_id, field);
    return `${extra} ${flashed ? "bg-emerald-50 ring-1 ring-emerald-200" : ""}`.trim();
  }

  function renderStatusEditor(row) {
    return `
      <div class="relative inline-block">
        <button
          type="button"
          class="inline-flex items-center"
          data-close-editor="0"
        >
          ${statusPill(row.project_status)}
        </button>

        <div class="absolute left-0 top-9 z-50 w-60 rounded-xl border border-black/10 bg-white p-2 shadow-xl">
          <div class="flex flex-col gap-1">
            ${STATUS_OPTIONS.map((opt) => `
              <button
                type="button"
                class="block w-full rounded-lg px-2 py-2 text-left hover:bg-black/[0.04]"
                data-pick-status="${row.qbo_customer_id}"
                data-status-value="${opt.value}"
              >
                <span class="block">
                  ${statusPill(opt.value)}
                </span>
              </button>
            `).join("")}
          </div>
        </div>
      </div>
    `;
  }

  function renderDateEditor(row, field) {
    const currentIso = isoToInput(row[field]);
    const displayVal = formatMmDdYyyy(row[field]);

    return `
      <div class="inline-flex items-center gap-2">
        <input
          type="text"
          class="input w-[120px]"
          data-date-text="${row.qbo_customer_id}"
          data-date-field="${field}"
          placeholder="mm-dd-yyyy"
          value="${escapeHtml(displayVal)}"
        />
        <button
          type="button"
          class="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-black/10 bg-white hover:bg-black/5"
          data-open-date-picker="${row.qbo_customer_id}"
          data-date-field="${field}"
          aria-label="Open calendar"
        >
          <svg class="size-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10m-12 9h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v11a2 2 0 002 2z"/>
          </svg>
        </button>
        <input
          type="date"
          class="sr-only"
          data-date-picker="${row.qbo_customer_id}"
          data-date-field="${field}"
          value="${escapeHtml(currentIso)}"
        />
      </div>
    `;
  }

  function renderAssignmentEditor(row, field) {
    const isPm = field === "primary_project_manager";
    const bundle = row._bundle;

    if (!bundle) {
      return `<div class="text-sm text-black/50">Loading…</div>`;
    }

    const items = isPm ? (bundle.project_managers || []) : (bundle.work_crews || []);
    const activeItems = isPm ? (bundle.active_project_managers || []) : (bundle.active_work_crews || []);
    const activeIdSet = new Set(
      activeItems.map((x) => String(isPm ? x.project_manager_id : x.work_crew_id))
    );
    const primaryId =
      activeItems.find((x) => x.is_primary)?.[isPm ? "project_manager_id" : "work_crew_id"] || null;

    const rowsHtml = items.map((it) => {
      const id = it.id;
      const label = isPm
        ? (`${(it.first_name || "")} ${(it.last_name || "")}`.trim() || it.email || `PM #${id}`)
        : `${it.name}${it.code ? ` (${it.code})` : ""}`;

      return `
        <label class="flex items-center justify-between gap-2 py-1">
          <span class="flex items-center gap-2 min-w-0">
            <input
              type="checkbox"
              class="h-4 w-4"
              data-assign-check="${row.qbo_customer_id}"
              data-assign-field="${field}"
              data-id="${id}"
              ${activeIdSet.has(String(id)) ? "checked" : ""}
            />
            <span class="truncate">${escapeHtml(label)}</span>
          </span>
          <span class="flex items-center gap-2 text-xs text-black/60 shrink-0">
            <span>Primary</span>
            <input
              type="radio"
              name="primary-${field}-${row.qbo_customer_id}"
              class="h-4 w-4"
              data-assign-primary="${row.qbo_customer_id}"
              data-assign-field="${field}"
              data-id="${id}"
              ${String(primaryId || "") === String(id) ? "checked" : ""}
            />
          </span>
        </label>
      `;
    }).join("");

    return `
      <div class="relative inline-block">
        <div class="absolute left-0 top-7 z-50 w-[340px] rounded-xl border border-black/10 bg-white p-3 shadow-xl">
          <div class="text-xs font-bold text-black/50 mb-2">${isPm ? "Project Managers" : "Work Crews"}</div>
          <div class="max-h-[240px] overflow-auto pr-1">
            ${rowsHtml || `<div class="text-sm text-black/50">None found.</div>`}
          </div>
          <div class="mt-3 flex justify-end gap-2">
            <button
              type="button"
              class="inline-flex items-center rounded-xl border border-black/10 bg-white px-3 py-2 text-sm font-semibold hover:bg-black/5"
              data-cancel-editor="1"
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn-primary"
              data-save-assignment="${row.qbo_customer_id}"
              data-assign-field="${field}"
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function renderHeader() {
    const theadRow = document.querySelector("#assignmentTable thead tr");
    if (!theadRow) return;

    theadRow.innerHTML = `
      ${th("project_name", "Project Name")}
      ${th("project_status", "Project Status")}
      ${th("start_date", "Start Date")}
      ${th("end_date", "End Date")}
      ${th("primary_project_manager", "Project Manager")}
      ${th("primary_work_crew", "Work Crew")}
      ${th("project_create_date", "QB Create Dt")}
    `;
  }

  function renderAll() {
    renderHeader();
    renderTable();
  }

  function renderTable() {
    const list = sorted(filtered());

    const rowCountEl = document.getElementById("rowCount");
    if (rowCountEl) {
      rowCountEl.textContent = `${list.length} projects`;
    }

    const tbody = document.getElementById("assignmentBody");
    tbody.innerHTML =
      list.map((row) => {
        const pmDisplay = row.all_project_managers || "";
        const crewDisplay = row.all_work_crews || "";

        return `
          <tr class="border-b border-black/5">
            <td class="py-2 px-3 font-semibold whitespace-nowrap">
              ${escapeHtml(row.project_name || "")}
            </td>

            <td class="py-2 px-3 whitespace-nowrap ${cellClass(row, "project_status")}"
                data-cell="${row.qbo_customer_id}"
                data-field="project_status">
              ${isEditing(row.qbo_customer_id, "project_status") ? renderStatusEditor(row) : `
                <button type="button" class="inline-flex items-center" data-edit-cell="${row.qbo_customer_id}" data-field="project_status">
                  ${statusPill(row.project_status)}
                </button>
              `}
            </td>

            <td class="py-2 px-3 whitespace-nowrap ${cellClass(row, "start_date")}"
                data-cell="${row.qbo_customer_id}"
                data-field="start_date">
              ${isEditing(row.qbo_customer_id, "start_date")
                ? renderDateEditor(row, "start_date")
                : `<button
                    type="button"
                    class="inline-flex min-h-[32px] min-w-[120px] items-center rounded px-1 py-0.5 hover:bg-black/[0.03] text-left"
                    data-edit-cell="${row.qbo_customer_id}"
                    data-field="start_date"
                  >
                    ${row.start_date
                      ? escapeHtml(formatMmDdYyyy(row.start_date))
                      : `<span class="text-black/35">—</span>`}
                  </button>`}
            </td>

            <td class="py-2 px-3 whitespace-nowrap ${cellClass(row, "end_date")}"
                data-cell="${row.qbo_customer_id}"
                data-field="end_date">
              ${isEditing(row.qbo_customer_id, "end_date")
                ? renderDateEditor(row, "end_date")
                : `<button
                    type="button"
                    class="inline-flex min-h-[32px] min-w-[120px] items-center rounded px-1 py-0.5 hover:bg-black/[0.03] text-left"
                    data-edit-cell="${row.qbo_customer_id}"
                    data-field="end_date"
                  >
                    ${row.end_date
                      ? escapeHtml(formatMmDdYyyy(row.end_date))
                      : `<span class="text-black/35">—</span>`}
                  </button>`}
            </td>

            <td class="py-2 px-3 whitespace-nowrap ${cellClass(row, "primary_project_manager")}"
                data-cell="${row.qbo_customer_id}"
                data-field="primary_project_manager">
              <div class="relative">
                ${isEditing(row.qbo_customer_id, "primary_project_manager")
                  ? renderAssignmentEditor(row, "primary_project_manager")
                  : `<button
                      type="button"
                      class="inline-flex min-h-[32px] min-w-[180px] items-center rounded px-1 py-0.5 hover:bg-black/[0.03] text-left"
                      data-edit-cell="${row.qbo_customer_id}"
                      data-field="primary_project_manager"
                    >
                      ${pmDisplay
                        ? escapeHtml(pmDisplay)
                        : `<span class="text-black/35">—</span>`}
                    </button>`}
              </div>
            </td>

            <td class="py-2 px-3 whitespace-nowrap ${cellClass(row, "primary_work_crew")}"
                data-cell="${row.qbo_customer_id}"
                data-field="primary_work_crew">
              <div class="relative">
                ${isEditing(row.qbo_customer_id, "primary_work_crew")
                  ? renderAssignmentEditor(row, "primary_work_crew")
                  : `<button
                      type="button"
                      class="inline-flex min-h-[32px] min-w-[180px] items-center rounded px-1 py-0.5 hover:bg-black/[0.03] text-left"
                      data-edit-cell="${row.qbo_customer_id}"
                      data-field="primary_work_crew"
                    >
                      ${crewDisplay
                        ? escapeHtml(crewDisplay)
                        : `<span class="text-black/35">—</span>`}
                    </button>`}
              </div>
            </td>

            <td class="py-2 px-3 whitespace-nowrap">
              ${escapeHtml(formatMmDdYyyy(row.project_create_date))}
            </td>
          </tr>
        `;
      }).join("") || `
        <tr>
          <td class="py-6 text-center text-black/50" colspan="7">No projects match these filters.</td>
        </tr>
      `;

    syncStickyHScroll();
  }

  async function beginEdit(rowId, field) {
    const row = rows.find((x) => String(x.qbo_customer_id) === String(rowId));
    if (!row) return;

    state.openFilter = null;
    state.editing.rowId = rowId;
    state.editing.field = field;
    setMsg("");

    if (field === "primary_project_manager" || field === "primary_work_crew") {
      try {
        await ensureBundle(row);
      } catch (e) {
        console.error(e);
        clearEditing();
        setMsg("Failed to load assignment options.");
      }
    }

    renderAll();

    if (field === "start_date" || field === "end_date") {
      window.setTimeout(() => {
        const input = document.querySelector(`[data-date-text="${rowId}"][data-date-field="${field}"]`);
        if (input) input.focus();
      }, 0);
    }
  }

  async function savePayload(row, payload, flashField) {
    await api("/assignment/save", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    row.project_status = payload.status || null;
    row.start_date = payload.start_date || null;
    row.end_date = payload.end_date || null;

    if (row._bundle) {
      const pmMap = new Map(
        (row._bundle.project_managers || []).map((x) => [
          String(x.id),
          `${(x.first_name || "")} ${(x.last_name || "")}`.trim() || x.email || `PM #${x.id}`,
        ])
      );

      const crewMap = new Map(
        (row._bundle.work_crews || []).map((x) => [
          String(x.id),
          `${x.name}${x.code ? ` (${x.code})` : ""}`,
        ])
      );

      row.all_project_managers = (payload.project_manager_ids || [])
        .map((id) => pmMap.get(String(id)) || "")
        .filter(Boolean)
        .join(", ");

      row.all_work_crews = (payload.work_crew_ids || [])
        .map((id) => crewMap.get(String(id)) || "")
        .filter(Boolean)
        .join(", ");

      row.primary_project_manager = payload.primary_project_manager_id
        ? (pmMap.get(String(payload.primary_project_manager_id)) || "")
        : "";

      row.primary_work_crew = payload.primary_work_crew_id
        ? (crewMap.get(String(payload.primary_work_crew_id)) || "")
        : "";

      row._bundle = {
        ...row._bundle,
        project: {
          ...(row._bundle.project || {}),
          status: payload.status,
          start_date: payload.start_date,
          end_date: payload.end_date,
        },
        active_project_managers: (payload.project_manager_ids || []).map((id) => ({
          project_manager_id: id,
          is_primary: Number(id) === Number(payload.primary_project_manager_id) ? 1 : 0,
        })),
        active_work_crews: (payload.work_crew_ids || []).map((id) => ({
          work_crew_id: id,
          is_primary: Number(id) === Number(payload.primary_work_crew_id) ? 1 : 0,
        })),
      };
    }

    clearEditing();
    renderAll();
    flashCell(row.qbo_customer_id, flashField);
  }

  async function saveStatus(rowId, newStatus) {
    const row = rows.find((x) => String(x.qbo_customer_id) === String(rowId));
    if (!row) return;

    await ensureBundle(row);

    const bundle = row._bundle;
    const payload = {
      qbo_customer_id: Number(row.qbo_customer_id),
      status: newStatus,
      start_date: bundle.project.start_date || null,
      end_date: bundle.project.end_date || null,
      project_manager_ids: (bundle.active_project_managers || []).map((x) => Number(x.project_manager_id)),
      primary_project_manager_id: (bundle.active_project_managers || []).find((x) => x.is_primary)?.project_manager_id || null,
      work_crew_ids: (bundle.active_work_crews || []).map((x) => Number(x.work_crew_id)),
      primary_work_crew_id: (bundle.active_work_crews || []).find((x) => x.is_primary)?.work_crew_id || null,
    };

    try {
      await savePayload(row, payload, "project_status");
      setMsg(`Saved ${row.project_name}.`, true);
    } catch (e) {
      console.error(e);
      setMsg("Could not update project status.");
    }
  }

  async function saveDateField(rowId, field, isoValue) {
    const row = rows.find((x) => String(x.qbo_customer_id) === String(rowId));
    if (!row) return;

    await ensureBundle(row);

    const bundle = row._bundle;
    const payload = {
      qbo_customer_id: Number(row.qbo_customer_id),
      status: bundle.project.status || "not_started",
      start_date: field === "start_date" ? (isoValue || null) : (bundle.project.start_date || null),
      end_date: field === "end_date" ? (isoValue || null) : (bundle.project.end_date || null),
      project_manager_ids: (bundle.active_project_managers || []).map((x) => Number(x.project_manager_id)),
      primary_project_manager_id: (bundle.active_project_managers || []).find((x) => x.is_primary)?.project_manager_id || null,
      work_crew_ids: (bundle.active_work_crews || []).map((x) => Number(x.work_crew_id)),
      primary_work_crew_id: (bundle.active_work_crews || []).find((x) => x.is_primary)?.work_crew_id || null,
    };

    try {
      await savePayload(row, payload, field);
      setMsg(`Saved ${row.project_name}.`, true);
    } catch (e) {
      console.error(e);
      setMsg(`Could not update ${field.replace("_", " ")}.`);
    }
  }

  async function saveAssignmentField(rowId, field) {
    const row = rows.find((x) => String(x.qbo_customer_id) === String(rowId));
    if (!row) return;

    await ensureBundle(row);

    const bundle = row._bundle;
    const isPm = field === "primary_project_manager";

    const checkedSelector = `[data-assign-check="${rowId}"][data-assign-field="${field}"]`;
    const primarySelector = `[data-assign-primary="${rowId}"][data-assign-field="${field}"]:checked`;

    const ids = Array.from(document.querySelectorAll(checkedSelector))
      .filter((x) => x.checked)
      .map((x) => Number(x.getAttribute("data-id")));

    const primaryEl = document.querySelector(primarySelector);
    const primaryId = primaryEl ? Number(primaryEl.getAttribute("data-id")) : null;

    const payload = {
      qbo_customer_id: Number(row.qbo_customer_id),
      status: bundle.project.status || "not_started",
      start_date: bundle.project.start_date || null,
      end_date: bundle.project.end_date || null,
      project_manager_ids: isPm ? ids : (bundle.active_project_managers || []).map((x) => Number(x.project_manager_id)),
      primary_project_manager_id: isPm ? primaryId : ((bundle.active_project_managers || []).find((x) => x.is_primary)?.project_manager_id || null),
      work_crew_ids: isPm ? (bundle.active_work_crews || []).map((x) => Number(x.work_crew_id)) : ids,
      primary_work_crew_id: isPm ? ((bundle.active_work_crews || []).find((x) => x.is_primary)?.work_crew_id || null) : primaryId,
    };

    try {
      await savePayload(row, payload, field);
      setMsg(`Saved ${row.project_name}.`, true);
    } catch (e) {
      console.error(e);
      setMsg("Could not update assignments. Make sure any selected primary is also checked.");
    }
  }

  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.q = e.target.value || "";
    renderAll();
  });

  document.querySelector("#assignmentTable thead").addEventListener("input", (e) => {
    const input = e.target.closest("[data-filter-input]");
    if (!input || input.type === "date") return;

    const key = input.getAttribute("data-filter-input");
    state.filters[key] = input.value || "";
    renderAll();

    window.setTimeout(() => {
      const el = document.querySelector(`#assignmentTable thead [data-filter-input="${key}"]`);
      if (el && typeof el.focus === "function") {
        el.focus();
        if (el.setSelectionRange) {
          const len = (state.filters[key] || "").length;
          el.setSelectionRange(len, len);
        }
      }
    }, 0);
  });

  document.querySelector("#assignmentTable thead").addEventListener("change", (e) => {
    const select = e.target.closest("[data-filter-select]");
    if (select) {
      const key = select.getAttribute("data-filter-select");
      state.filters[key] = select.value || "";
      renderAll();
      return;
    }

    const input = e.target.closest("[data-filter-input]");
    if (input && input.type === "date") {
      const key = input.getAttribute("data-filter-input");
      state.filters[key] = input.value || "";
      renderAll();
    }
  });

  document.getElementById("assignmentBody").addEventListener("click", async (e) => {
    const cancelEditor = e.target.closest("[data-cancel-editor]");
    if (cancelEditor) {
      clearEditing();
      renderAll();
      return;
    }

    const editBtn = e.target.closest("[data-edit-cell]");
    if (editBtn) {
      await beginEdit(editBtn.getAttribute("data-edit-cell"), editBtn.getAttribute("data-field"));
      return;
    }

    const pickStatus = e.target.closest("[data-pick-status]");
    if (pickStatus) {
      await saveStatus(
        pickStatus.getAttribute("data-pick-status"),
        pickStatus.getAttribute("data-status-value")
      );
      return;
    }

    const openDatePicker = e.target.closest("[data-open-date-picker]");
    if (openDatePicker) {
      const rowId = openDatePicker.getAttribute("data-open-date-picker");
      const field = openDatePicker.getAttribute("data-date-field");
      const input = document.querySelector(`[data-date-picker="${rowId}"][data-date-field="${field}"]`);
      if (input?.showPicker) input.showPicker();
      else if (input) input.click();
      return;
    }

    const saveAssignment = e.target.closest("[data-save-assignment]");
    if (saveAssignment) {
      await saveAssignmentField(
        saveAssignment.getAttribute("data-save-assignment"),
        saveAssignment.getAttribute("data-assign-field")
      );
      return;
    }
  });

  document.getElementById("assignmentBody").addEventListener("change", async (e) => {
    const picker = e.target.closest("[data-date-picker]");
    if (picker) {
      const rowId = picker.getAttribute("data-date-picker");
      const field = picker.getAttribute("data-date-field");
      const iso = picker.value || "";

      const text = document.querySelector(`[data-date-text="${rowId}"][data-date-field="${field}"]`);
      if (text) text.value = formatMmDdYyyy(iso);

      await saveDateField(rowId, field, iso);
      return;
    }
  });

  document.getElementById("assignmentBody").addEventListener("keydown", async (e) => {
    const textInput = e.target.closest("[data-date-text]");
    if (textInput && e.key === "Enter") {
      e.preventDefault();
      const rowId = textInput.getAttribute("data-date-text");
      const field = textInput.getAttribute("data-date-field");
      const iso = mmddyyyyToIso(textInput.value);

      if (!textInput.value.trim()) {
        await saveDateField(rowId, field, "");
        return;
      }

      if (!iso) {
        setMsg("Please enter the date as mm-dd-yyyy.");
        return;
      }

      await saveDateField(rowId, field, iso);
    }

    if (e.key === "Escape") {
      clearEditing();
      state.openFilter = null;
      renderAll();
    }
  });

  document.getElementById("assignmentBody").addEventListener("focusout", async (e) => {
    const textInput = e.target.closest("[data-date-text]");
    if (!textInput) return;

    const nextFocused = e.relatedTarget;
    if (nextFocused && nextFocused.closest?.("[data-cell]")) return;

    const rowId = textInput.getAttribute("data-date-text");
    const field = textInput.getAttribute("data-date-field");
    const raw = textInput.value.trim();

    if (!isEditing(rowId, field)) return;

    if (!raw) {
      await saveDateField(rowId, field, "");
      return;
    }

    const iso = mmddyyyyToIso(raw);
    if (!iso) {
      setMsg("Please enter the date as mm-dd-yyyy.");
      return;
    }

    await saveDateField(rowId, field, iso);
  });

  document.querySelector("#assignmentTable thead").addEventListener("click", (e) => {
    const filterBtn = e.target.closest("[data-open-filter]");
    if (filterBtn) {
      e.stopPropagation();
      const key = filterBtn.getAttribute("data-open-filter");
      state.openFilter = state.openFilter === key ? null : key;
      renderAll();
      return;
    }

    if (e.target.closest("[data-close-filter]")) {
      e.stopPropagation();
      state.openFilter = null;
      renderAll();
      return;
    }

    const clearBtn = e.target.closest("[data-clear-filter]");
    if (clearBtn) {
      e.stopPropagation();
      const key = clearBtn.getAttribute("data-clear-filter");

      if (key === "project_name") state.filters.project_name = "";
      else if (key === "project_status") state.filters.project_status = "";
      else if (key === "primary_project_manager") state.filters.primary_project_manager = "";
      else if (key === "primary_work_crew") state.filters.primary_work_crew = "";
      else if (key === "start_date") {
        state.filters.start_date_from = "";
        state.filters.start_date_to = "";
      } else if (key === "end_date") {
        state.filters.end_date_from = "";
        state.filters.end_date_to = "";
      } else if (key === "project_create_date") {
        state.filters.project_create_date_from = "";
        state.filters.project_create_date_to = "";
      }

      renderAll();
      return;
    }

    const sortBtn = e.target.closest("[data-sort]");
    if (sortBtn) {
      const key = sortBtn.getAttribute("data-sort");
      if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      else {
        state.sortKey = key;
        state.sortDir = "asc";
      }
      renderAll();
    }
  });

  document.addEventListener("click", (e) => {
    const inHeader = e.target.closest("#assignmentTable thead");
    const inBody = e.target.closest("#assignmentBody");
    const clickedEditCell = e.target.closest("[data-edit-cell]");
    const clickedStatusChoice = e.target.closest("[data-pick-status]");
    const clickedFilterButton = e.target.closest("[data-open-filter]");
    const clickedFilterMenu = e.target.closest("[data-close-filter], [data-clear-filter], [data-filter-input], [data-filter-select]");
    const clickedAssignmentSave = e.target.closest("[data-save-assignment]");
    const clickedAssignmentCancel = e.target.closest("[data-cancel-editor]");

    // close header filter menus when clicking outside header/filter UI
    if (state.openFilter && !inHeader && !clickedFilterButton && !clickedFilterMenu) {
      state.openFilter = null;
      renderAll();
      return;
    }

    const activeEditorCell = state.editing.field
      ? document.querySelector(
          `[data-cell="${state.editing.rowId}"][data-field="${state.editing.field}"]`
        )
      : null;

    const clickedInsideActiveEditor = activeEditorCell?.contains(e.target);

    // close open cell editors when clicking outside the active editor
    if (
      state.editing.field &&
      !clickedInsideActiveEditor &&
      !clickedEditCell &&
      !clickedStatusChoice &&
      !clickedAssignmentSave &&
      !clickedAssignmentCancel
    ) {
      clearEditing();
      renderAll();
    }
  });

  renderAll();
  bindStickyHScroll();
  setTimeout(syncStickyHScroll, 0);
}