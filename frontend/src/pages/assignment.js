// Assignment page: table view of projects with inline editing, sorting, and filtering.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

// Statuses the backend accepts on /assignment/save (ALLOWED_STATUS in
// backend/app/projects/service.py). 'needs_attention' is included — a row
// stays in Needs Attention through partial-data saves (PM but no crew,
// dates but no PM, etc.) until the user explicitly picks a different
// status from the dropdown. Truly unknown / empty statuses still fall
// back to 'not_started' defensively.
const USER_STATUSES = new Set([
  "needs_attention", "not_started", "in_progress", "completed", "canceled",
]);

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
      project_status: [],
      start_date_from: "",
      start_date_to: "",
      end_date_from: "",
      end_date_to: "",
      project_create_date_from: "",
      project_create_date_to: "",
      primary_project_manager: [],
      primary_work_crew: [],
      wire_guidance: [],
      travel_days: [],
      overage_days: [],
      equipment_type: [],
    },
  };

  const STATUS_OPTIONS = [
    { value: "needs_attention", label: "Needs Attention" },
    { value: "not_started",     label: "Not Started" },
    { value: "in_progress",     label: "In Progress" },
    { value: "completed",       label: "Completed" },
    { value: "canceled",        label: "Canceled" },
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
    canceled: {
      wrap: "bg-red-50 border-red-200",
      label: "text-red-700",
    },
    all: {
      wrap: "bg-kpi-total-bg border-kpi-total-bd",
      label: "text-kpi-total-text",
    },
  };

  let nextTempId = 1;

  function rowKey(row) {
    if (row.schedule_item_id != null) return `si:${row.schedule_item_id}`;
    if (!row._tempRowId) row._tempRowId = `tmp:${nextTempId++}`;
    return row._tempRowId;
  }

  function getBundleItem(row) {
    const items = row._bundle?.schedule_items || [];
    return items.find(x => String(x.id) === String(row.schedule_item_id)) || null;
  }

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
    if (v === "needs_attention") return "Needs Attention";
    if (v === "not_started") return "Not Started";
    if (v === "in_progress") return "In Progress";
    if (v === "completed") return "Completed";
    if (v === "canceled") return "Canceled";
    return String(v);
  }

  function statusBucket(v) {
    if (v == null || String(v).trim() === "") return "needs_assignment";
    if (v === "needs_attention") return "needs_assignment";
    if (v === "not_started") return "not_started";
    if (v === "in_progress") return "in_progress";
    if (v === "completed") return "completed";
    if (v === "canceled") return "canceled";
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
      const item = getBundleItem(row);
      row._active_project_managers = item?.active_project_managers || [];
      row._active_work_crews = item?.active_work_crews || [];
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

  function addScheduleRow(baseRow) {
    const newRow = {
      qbo_customer_id: baseRow.qbo_customer_id,
      schedule_item_id: null,
      _tempRowId: `tmp:${nextTempId++}`,
      project_name: baseRow.project_name,
      project_create_date: baseRow.project_create_date,

      project_status: "",
      start_date: null,
      end_date: null,
      wire_guidance: 0,
      travel_days: 0,
      overage_days: 0,
      equipment_type: null,
      notes: "",
      is_extra_row: 1,

      primary_project_manager: "",
      primary_work_crew: "",
      all_project_managers: "",
      all_work_crews: "",

      _bundle: baseRow._bundle || null,
      _loadingBundle: false,
      _active_project_managers: [],
      _active_work_crews: [],
    };

    const idx = rows.indexOf(baseRow);
    if (idx >= 0) rows.splice(idx + 1, 0, newRow);
    else rows.push(newRow);

    renderAll();
  }

  function canDeleteRow(row) {
    return row.is_extra_row === 1 || (row.schedule_item_id == null && !!row._tempRowId);
  }

  async function saveMiscFields(row, flashField = null) {
    await ensureBundle(row);

    const payload = {
      schedule_item_id: row.schedule_item_id != null ? Number(row.schedule_item_id) : null,
      qbo_customer_id: Number(row.qbo_customer_id),
      status: USER_STATUSES.has(row.project_status) ? row.project_status : "not_started",
      start_date: row.start_date || null,
      end_date: row.end_date || null,
      wire_guidance: row.wire_guidance || 0,
      travel_days: row.travel_days || 0,
      overage_days: row.overage_days || 0,
      equipment_type: row.equipment_type || null,
      project_manager_ids: (row._active_project_managers || []).map(x => Number(x.project_manager_id)),
      primary_project_manager_id: (row._active_project_managers || []).find(x => x.is_primary)?.project_manager_id || null,
      work_crew_ids: (row._active_work_crews || []).map(x => Number(x.work_crew_id)),
      primary_work_crew_id: (row._active_work_crews || []).find(x => x.is_primary)?.work_crew_id || null,
      notes: row.notes || null,
    };

    await savePayload(row, payload, flashField || "project_status");
    setMsg(`Saved ${row.project_name}.`, true);
  }

  function syncDisplayFieldsFromActiveAssignments(row) {
    const bundle = row._bundle || {};

    const pmById = new Map((bundle.project_managers || []).map((x) => [String(x.id), x]));
    const crewById = new Map((bundle.work_crews || []).map((x) => [String(x.id), x]));

    const activePms = [...(row._active_project_managers || [])];
    const activeCrews = [...(row._active_work_crews || [])];

    activePms.sort((a, b) => (Number(b.is_primary) - Number(a.is_primary)) || (Number(a.project_manager_id) - Number(b.project_manager_id)));
    activeCrews.sort((a, b) => (Number(b.is_primary) - Number(a.is_primary)) || (Number(a.work_crew_id) - Number(b.work_crew_id)));

    row.all_project_managers = activePms.map((x) => {
      const pm = pmById.get(String(x.project_manager_id));
      if (!pm) return `PM #${x.project_manager_id}`;
      return `${pm.first_name || ""} ${pm.last_name || ""}`.trim() || pm.email || `PM #${x.project_manager_id}`;
    }).filter(Boolean).join(", ");

    row.all_work_crews = activeCrews.map((x) => {
      const crew = crewById.get(String(x.work_crew_id));
      return crew ? crew.name : `Crew #${x.work_crew_id}`;
    }).filter(Boolean).join(", ");

    const primaryPm = activePms.find((x) => x.is_primary);
    const primaryCrew = activeCrews.find((x) => x.is_primary);

    row.primary_project_manager = primaryPm
      ? (row.all_project_managers.split(",")[0] || "").trim()
      : "";
    row.primary_work_crew = primaryCrew
      ? (row.all_work_crews.split(",")[0] || "").trim()
      : "";
  }

  function upsertBundleItem(row, payload, projectId) {
    if (!row._bundle) return;

    if (!row._bundle.project) {
      row._bundle.project = {
        id: projectId || null,
        qbo_customer_id: Number(row.qbo_customer_id),
      };
    } else if (projectId != null) {
      row._bundle.project.id = Number(projectId);
    }

    if (!Array.isArray(row._bundle.schedule_items)) {
      row._bundle.schedule_items = [];
    }

    const updatedItem = {
      id: row.schedule_item_id,
      project_id: projectId || row._bundle?.project?.id || null,
      status: payload.status,
      start_date: payload.start_date,
      end_date: payload.end_date,
      wire_guidance: payload.wire_guidance || 0,
      travel_days: payload.travel_days || 0,
      overage_days: payload.overage_days || 0,
      equipment_type: payload.equipment_type || null,
      notes: payload.notes || null,
      is_extra_row: row.is_extra_row || 0,
      active_project_managers: row._active_project_managers || [],
      active_work_crews: row._active_work_crews || [],
    };

    const idx = row._bundle.schedule_items.findIndex(
      (item) => String(item.id) === String(row.schedule_item_id)
    );

    if (idx >= 0) {
      row._bundle.schedule_items[idx] = {
        ...row._bundle.schedule_items[idx],
        ...updatedItem,
      };
    } else {
      row._bundle.schedule_items.push(updatedItem);
    }
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
    if (key === "project_status") return state.filters.project_status.length > 0;
    if (key === "start_date") return !!(state.filters.start_date_from || state.filters.start_date_to);
    if (key === "end_date") return !!(state.filters.end_date_from || state.filters.end_date_to);
    if (key === "project_create_date") return !!(state.filters.project_create_date_from || state.filters.project_create_date_to);
    if (key === "primary_project_manager") return state.filters.primary_project_manager.length > 0;
    if (key === "primary_work_crew") return state.filters.primary_work_crew.length > 0;
    if (key === "wire_guidance") return state.filters.wire_guidance.length > 0;
    if (key === "travel_days") return state.filters.travel_days.length > 0;
    if (key === "overage_days") return state.filters.overage_days.length > 0;
    if (key === "equipment_type") return state.filters.equipment_type.length > 0;
    return false;
  }

  function sortArrow(key) {
    return state.sortKey === key ? (state.sortDir === "asc" ? " ▲" : " ▼") : "";
  }

  function compareValues(a, b, key) {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);

    const aDate = ["start_date", "end_date", "project_create_date"].includes(key) ? parseIsoDate(av) : null;
    const bDate = ["start_date", "end_date", "project_create_date"].includes(key) ? parseIsoDate(bv) : null;

    if (aDate || bDate) {
      if (!aDate && !bDate) return 0;
      if (!aDate) return 1;
      if (!bDate) return -1;
      return aDate.getTime() - bDate.getTime();
    }

    const aNumKeys = ["wire_guidance", "travel_days", "overage_days"];
    if (aNumKeys.includes(key)) {
      return Number(av || 0) - Number(bv || 0);
    }

    return String(av || "").localeCompare(String(bv || ""));
  }

  function sorted(list) {
    if (!state.sortKey) return [...list];
    const decorated = list.map((row, idx) => ({ row, idx }));

    decorated.sort((aWrap, bWrap) => {
      const cmp = compareValues(aWrap.row, bWrap.row, state.sortKey);
      if (cmp !== 0) {
        return state.sortDir === "asc" ? cmp : -cmp;
      }

      // stable fallback
      const projectCmp = String(aWrap.row.project_name || "").localeCompare(String(bWrap.row.project_name || ""));
      if (projectCmp !== 0) return projectCmp;

      return aWrap.idx - bWrap.idx;
    });

    return decorated.map((x) => x.row);
  }

  function renderMultiSelectMenu(key, title, options, align = "right-0") {
    if (state.openFilter !== key) return "";
    const selected = state.filters[key] || [];
    const optRows = options.map(({ value, label }) => {
      const checked = selected.includes(value);
      return `
        <label class="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-black/[0.04] cursor-pointer select-none">
          <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? "bg-black border-black" : "bg-white border-black/30"}">
            ${checked ? `<svg class="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>` : ""}
          </span>
          <input type="checkbox" class="sr-only"
            data-multiselect-check="${key}"
            data-multiselect-value="${escapeHtml(value)}"
            ${checked ? "checked" : ""}
          />
          <span class="text-xs">${escapeHtml(label)}</span>
        </label>
      `;
    }).join("");
    return `
      <div class="absolute ${align} top-8 z-50 w-64 rounded-xl border border-black/10 bg-white p-3 shadow-xl">
        <div class="text-xs font-bold text-black/50 mb-2">${escapeHtml(title)}</div>
        <div class="flex flex-col gap-0 max-h-[240px] overflow-auto">
          ${optRows}
        </div>
        <div class="mt-3 flex justify-end gap-2">
          <button type="button" class="inline-flex items-center rounded-xl border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-black/5" data-clear-filter="${key}">Clear</button>
          <button type="button" class="btn-primary" data-close-filter="1">Done</button>
        </div>
      </div>
    `;
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
            <button type="button" class="inline-flex items-center rounded-xl border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-black/5" data-clear-filter="project_name">Clear</button>
            <button type="button" class="btn-primary" data-close-filter="1">Done</button>
          </div>
        </div>
      `;
    }

    if (key === "project_status") {
      return renderMultiSelectMenu(key, "Filter Status", [
        { value: "Needs Attention", label: "Needs Attention" },
        { value: "Not Started",     label: "Not Started" },
        { value: "In Progress",     label: "In Progress" },
        { value: "Completed",       label: "Completed" },
        { value: "Canceled",        label: "Canceled" },
      ]);
    }

    if (key === "primary_project_manager") {
      return renderMultiSelectMenu(key, "Filter Project Manager",
        getPmOptions().map((x) => ({ value: x, label: x }))
      );
    }

    if (key === "primary_work_crew") {
      return renderMultiSelectMenu(key, "Filter Work Crew",
        getCrewOptions().map((x) => ({ value: x, label: x }))
      );
    }

    if (key === "wire_guidance") {
      return renderMultiSelectMenu(key, "Filter Wire", [
        { value: "yes", label: "Yes" },
        { value: "no",  label: "No" },
      ]);
    }

    if (key === "travel_days") {
      return renderMultiSelectMenu(key, "Filter Travel", [
        { value: "none", label: "None" },
        { value: "2",    label: "2 days" },
        { value: "3",    label: "3 days" },
        { value: "4",    label: "4 days" },
      ]);
    }

    if (key === "overage_days") {
      return renderMultiSelectMenu(key, "Filter Overage", [
        { value: "none", label: "None" },
        { value: "has",  label: "Has overage" },
      ]);
    }

    if (key === "equipment_type") {
      return renderMultiSelectMenu(key, "Filter Equip", [
        { value: "none",     label: "None" },
        { value: "Equip",    label: "Equip" },
        { value: "No Equip", label: "No Equip" },
        { value: "Electric", label: "Electric" },
      ]);
    }

    if (key === "start_date" || key === "end_date" || key === "project_create_date") {
      const fromKey = `${key}_from`;
      const toKey = `${key}_to`;
      return `
        <div class="absolute top-8 z-50 w-64 rounded-xl border border-black/10 bg-white p-3 shadow-xl" style="right:0; left:auto;">
          <div class="text-xs font-bold text-black/50 mb-2">Filter ${escapeHtml(key.replaceAll("_", " "))}</div>
          <div class="space-y-2">
            <div>
              <div class="text-[10px] text-black/50 mb-1">From</div>
              <input type="date" class="input" data-filter-input="${fromKey}" value="${escapeHtml(state.filters[fromKey] || "")}" />
            </div>
            <div>
              <div class="text-[10px] text-black/50 mb-1">To</div>
              <input type="date" class="input" data-filter-input="${toKey}" value="${escapeHtml(state.filters[toKey] || "")}" />
            </div>
          </div>
          <div class="mt-3 flex justify-end gap-2">
            <button type="button" class="inline-flex items-center rounded-xl border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-black/5" data-clear-filter="${key}">Clear</button>
            <button type="button" class="btn-primary" data-close-filter="1">Done</button>
          </div>
        </div>
      `;
    }

    return "";
  }

  function th(key, label) {
    return `
      <th class="py-2 px-3 text-left align-middle overflow-visible" style="min-width:fit-content;">
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
    <div class="card flex flex-col overflow-hidden" style="height:calc(100vh - 180px); min-height:400px;">

      <!-- Fixed card header: title, subtitle, search. Never scrolls. -->
      <div id="assignCardHeader" class="shrink-0 px-5 pt-4 pb-3 border-b border-black/10">
        <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-1.5">
          <div>
            <div class="text-xs text-black/50">Sort columns, filter from the funnel button, and edit directly in the row.</div>
          </div>
          <div class="flex items-center gap-2">
            <div class="text-xs font-semibold text-black/50 whitespace-nowrap">Search</div>
            <input id="searchInput" class="input text-xs py-1 w-full sm:w-56" placeholder="Project Name" />
            <button
              id="clearFiltersBtn"
              type="button"
              class="inline-flex items-center rounded-xl border border-black/10 bg-gray-200 px-3 py-1.5 text-xs font-semibold hover:bg-black/5 whitespace-nowrap"
            >
              Clear Filters
            </button>
          </div>
        </div>
        <div class="flex items-center justify-between gap-3">
          <div id="rowCount" class="text-xs font-semibold text-black/50">Showing 0 records</div>
          <div id="assignPageMsg" class="text-xs min-h-[1rem]"></div>
        </div>
      </div>

      <!-- Single scroll container: both axes scroll here, nothing else does.
           thead sticky top-0 works because this div is the scroll ancestor. -->
      <div id="assignTableScroll" class="flex-1 overflow-auto">
        <table id="assignmentTable" class="text-xs border-collapse w-full" style="min-width:900px;">
          <thead id="assignThead" class="text-left text-black/60 border-b border-black/10 sticky top-0 z-20 bg-white">
            <tr>
              ${th("project_name", "Project Name")}
              ${th("project_status", "Status")}
              ${th("primary_project_manager", "PM")}
              ${th("primary_work_crew", "Work Crew")}
              ${th("start_date", "Start Date")}
              ${th("end_date", "End Date")}
              ${th("wire_guidance", "Wire")}
              ${th("travel_days", "Travel")}
              ${th("overage_days", "Overage")}
              ${th("equipment_type", "Equip")}
              ${th("notes", "Notes")}
              ${th("project_create_date", "QB Created")}
            </tr>
          </thead>
          <tbody id="assignmentBody"></tbody>
        </table>
      </div>

    </div>
  `;

  setShell({
    title: "Assignment",
    subtitle: "Assign PMs, crews, dates, and status per schedule item across all projects.",
    bodyHtml,
    showLogout: true,
    routeFn,
  });

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

      if (state.filters.project_status.length > 0) {
        const label = normalize(statusLabel(r.project_status));
        if (!state.filters.project_status.some((v) => normalize(v) === label)) return false;
      }

      if (!inDateRange(r.start_date, state.filters.start_date_from, state.filters.start_date_to)) return false;
      if (!inDateRange(r.end_date, state.filters.end_date_from, state.filters.end_date_to)) return false;
      if (!inDateRange(r.project_create_date, state.filters.project_create_date_from, state.filters.project_create_date_to)) return false;

      if (state.filters.primary_project_manager.length > 0) {
        const all = normalize(r.all_project_managers || "");
        if (!state.filters.primary_project_manager.some((v) => all.includes(normalize(v)))) return false;
      }

      if (state.filters.primary_work_crew.length > 0) {
        const all = normalize(r.all_work_crews || "");
        if (!state.filters.primary_work_crew.some((v) => all.includes(normalize(v)))) return false;
      }

      if (state.filters.wire_guidance.length > 0) {
        const isYes = !!r.wire_guidance;
        const match = (state.filters.wire_guidance.includes("yes") && isYes) ||
                      (state.filters.wire_guidance.includes("no") && !isYes);
        if (!match) return false;
      }

      if (state.filters.travel_days.length > 0) {
        const match = state.filters.travel_days.some((v) =>
          v === "none" ? !r.travel_days : Number(r.travel_days) === Number(v)
        );
        if (!match) return false;
      }

      if (state.filters.overage_days.length > 0) {
        const match = state.filters.overage_days.some((v) =>
          v === "none" ? !r.overage_days : v === "has" ? !!r.overage_days : false
        );
        if (!match) return false;
      }

      if (state.filters.equipment_type.length > 0) {
        const match = state.filters.equipment_type.some((v) =>
          v === "none" ? !r.equipment_type : r.equipment_type === v
        );
        if (!match) return false;
      }
      
      if (!q) return true;

      return normalize(r.project_name).includes(q);
    });
  }

  function sortValue(r, key) {
    if (key === "project_status") return statusLabel(r.project_status);
    if (key === "start_date") return isoToInput(r.start_date);
    if (key === "end_date") return isoToInput(r.end_date);
    if (key === "project_create_date") return isoToInput(r.project_create_date);
    if (key === "primary_project_manager") return r.all_project_managers || "";
    if (key === "primary_work_crew") return r.all_work_crews || "";
    if (key === "equipment_type") return r.equipment_type || "";
    return r[key] ?? "";
  }

  function cellClass(row, field, extra = "") {
    const flashed = isFlashed(rowKey(row), field);
    return `${extra} ${flashed ? "bg-emerald-50 ring-1 ring-emerald-200" : ""}`.trim();
  }

  function renderStatusEditor(row) {
    return `
      <div class="relative inline-block">
        <button
          type="button"
          class="inline-flex items-center"
        >
          ${statusPill(row.project_status)}
        </button>

        <div class="absolute left-0 top-9 z-50 min-w-[170px] w-max max-w-[220px] rounded-xl border border-black/10 bg-white p-2 shadow-xl">
          <div class="flex flex-col gap-1">
            ${STATUS_OPTIONS.map((opt) => `
              <button
                type="button"
                class="inline-flex w-full rounded-lg px-2 py-2 text-left hover:bg-black/[0.04]"
                data-pick-status="${rowKey(row)}"
                data-status-value="${opt.value}"
              >
                <span class="inline-flex">
                  ${statusPill(opt.value)}
                </span>
              </button>
            `).join("")}
          </div>
        </div>
      </div>
    `;
  }

  function renderWireGuidanceCell(row) {
    return `
      <input
        type="checkbox"
        class="h-4 w-4 cursor-pointer"
        data-wire-check="${rowKey(row)}"
        ${row.wire_guidance ? "checked" : ""}
      />
    `;
  }

  function renderTravelDaysCell(row) {
    if (isEditing(rowKey(row), "travel_days")) {
      return `
        <select class="input w-24" data-travel-select="${rowKey(row)}" onchange="void(0)">
          <option value="0" ${!row.travel_days ? "selected" : ""}>None</option>
          <option value="2" ${row.travel_days == 2 ? "selected" : ""}>2 days</option>
          <option value="3" ${row.travel_days == 3 ? "selected" : ""}>3 days</option>
          <option value="4" ${row.travel_days == 4 ? "selected" : ""}>4 days</option>
        </select>
      `;
    }
    return `
      <button type="button" class="inline-flex min-h-[32px] min-w-[60px] items-center rounded px-1 py-0.5 hover:bg-black/[0.03]"
        data-edit-cell="${rowKey(row)}" data-field="travel_days">
        ${row.travel_days ? `${row.travel_days} days` : `<span class="text-black/35">—</span>`}
      </button>
    `;
  }

  function renderOverageDaysCell(row) {
    if (isEditing(rowKey(row), "overage_days")) {
      return `
        <input type="number" min="0" step="1" class="input w-24"
          data-overage-input="${rowKey(row)}"
          value="${row.overage_days || 0}" />
      `;
    }
    return `
      <button type="button" class="inline-flex min-h-[32px] min-w-[60px] items-center rounded px-1 py-0.5 hover:bg-black/[0.03]"
        data-edit-cell="${rowKey(row)}" data-field="overage_days">
        ${row.overage_days ? `${row.overage_days} days` : `<span class="text-black/35">—</span>`}
      </button>
    `;
  }

  function renderEquipmentTypeCell(row) {
    if (isEditing(rowKey(row), "equipment_type")) {
      return `
        <select class="input w-32" data-equipment-select="${rowKey(row)}">
          <option value="" ${!row.equipment_type ? "selected" : ""}>None</option>
          <option value="Equip" ${row.equipment_type === "Equip" ? "selected" : ""}>Equip</option>
          <option value="No Equip" ${row.equipment_type === "No Equip" ? "selected" : ""}>No Equip</option>
          <option value="Electric" ${row.equipment_type === "Electric" ? "selected" : ""}>Electric</option>
        </select>
      `;
    }

    return `
      <button
        type="button"
        class="inline-flex min-h-[32px] min-w-[80px] items-center rounded px-1 py-0.5 hover:bg-black/[0.03]"
        data-edit-cell="${rowKey(row)}"
        data-field="equipment_type"
      >
        ${row.equipment_type
          ? escapeHtml(row.equipment_type)
          : `<span class="text-black/35">—</span>`}
      </button>
    `;
  }

  function renderNotesCell(row) {
    if (isEditing(rowKey(row), "notes")) {
      return `
        <input
          type="text"
          class="input w-56"
          data-notes-input="${rowKey(row)}"
          value="${escapeHtml(row.notes || "")}"
          placeholder="Add note"
        />
      `;
    }

    return `
      <button
        type="button"
        class="inline-flex min-h-[32px] min-w-[120px] items-center rounded px-1 py-0.5 hover:bg-black/[0.03] text-left"
        data-edit-cell="${rowKey(row)}"
        data-field="notes"
      >
        ${row.notes ? escapeHtml(row.notes) : `<span class="text-black/35">—</span>`}
      </button>
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
          data-date-text="${rowKey(row)}"
          data-date-field="${field}"
          placeholder="mm-dd-yyyy"
          value="${escapeHtml(displayVal)}"
        />
        <button
          type="button"
          class="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-black/10 bg-white hover:bg-black/5"
          data-open-date-picker="${rowKey(row)}"
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
          data-date-picker="${rowKey(row)}"
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
    const bundleItem = getBundleItem(row);
    const activeItems = isPm
      ? ((row._active_project_managers && row._active_project_managers.length)
          ? row._active_project_managers
          : (bundleItem?.active_project_managers || []))
      : ((row._active_work_crews && row._active_work_crews.length)
          ? row._active_work_crews
          : (bundleItem?.active_work_crews || []));

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
              data-assign-check="${rowKey(row)}"
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
              name="primary-${field}-${rowKey(row)}"
              class="h-4 w-4"
              data-assign-primary="${rowKey(row)}"
              data-assign-field="${field}"
              data-id="${id}"
              ${String(primaryId || "") === String(id) ? "checked" : ""}
            />
          </span>
        </label>
      `;
    }).join("");

    return `
      <div class="relative inline-block w-full">
        <div class="absolute left-0 top-7 z-[100] w-[340px] max-w-[420px] rounded-xl border border-black/10 bg-white p-3 shadow-xl">
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
              data-save-assignment="${rowKey(row)}"
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
      ${th("project_status", "Status")}
      ${th("primary_project_manager", "PM")}
      ${th("primary_work_crew", "Work Crew")}
      ${th("start_date", "Start Date")}
      ${th("end_date", "End Date")}
      ${th("wire_guidance", "Wire")}
      ${th("travel_days", "Travel")}
      ${th("overage_days", "Overage")}
      ${th("equipment_type", "Equip")}
      ${th("notes", "Notes")}
      ${th("project_create_date", "QB Created")}
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
      const uniqueProjects = new Set(list.map((r) => r.qbo_customer_id)).size;
      rowCountEl.textContent = `Showing ${uniqueProjects} project${uniqueProjects !== 1 ? "s" : ""} · ${list.length} row${list.length !== 1 ? "s" : ""}`;
    }

    const tbody = document.getElementById("assignmentBody");
    tbody.innerHTML =
      list.map((row) => {
        const pmDisplay = row.all_project_managers || "";
        const crewDisplay = row.all_work_crews || "";

        return `
          <tr class="border-b border-black/5">
            <td class="py-2 px-2 font-semibold whitespace-nowrap">
              <div class="flex items-center gap-2">
                <span>${escapeHtml(row.project_name || "")}</span>
                <button
                  type="button"
                  class="inline-flex items-center rounded-lg border border-black/10 px-2 py-0.5 text-[11px] font-semibold hover:bg-black/5"
                  data-add-schedule-row="${rowKey(row)}"
                >
                  + Row
                </button>
                ${canDeleteRow(row) ? `
                  <button
                    type="button"
                    class="inline-flex items-center rounded-lg border border-red-200 px-2 py-0.5 text-[11px] font-semibold text-red-700 hover:bg-red-50"
                    data-remove-schedule-row="${rowKey(row)}"
                  >
                    - Row
                  </button>
                ` : ""}
              </div>
            </td>

            <td class="py-2 px-2 whitespace-nowrap ${cellClass(row, "project_status")}"
                data-cell="${rowKey(row)}"
                data-field="project_status">
              ${isEditing(rowKey(row), "project_status") ? renderStatusEditor(row) : `
                <button type="button" class="inline-flex items-center" data-edit-cell="${rowKey(row)}" data-field="project_status">
                  ${statusPill(row.project_status)}
                </button>
              `}
            </td>

            <td class="py-2 px-2 overflow-visible ${cellClass(row, "primary_project_manager")}"
                data-cell="${rowKey(row)}"
                data-field="primary_project_manager">
              <div class="relative z-100">
                ${isEditing(rowKey(row), "primary_project_manager")
                  ? renderAssignmentEditor(row, "primary_project_manager")
                  : `<button
                      type="button"
                      class="inline-flex min-h-[32px] items-center rounded px-1 py-0.5 hover:bg-black/[0.03] text-left whitespace-normal break-words"
                      data-edit-cell="${rowKey(row)}"
                      data-field="primary_project_manager"
                    >
                      ${pmDisplay
                        ? escapeHtml(pmDisplay)
                        : `<span class="text-black/35">—</span>`}
                    </button>`}
              </div>
            </td>

            <td class="py-2 px-2 overflow-visible ${cellClass(row, "primary_work_crew")}"
                data-cell="${rowKey(row)}"
                data-field="primary_work_crew">
              <div class="relative w-full z-100">
                ${isEditing(rowKey(row), "primary_work_crew")
                  ? renderAssignmentEditor(row, "primary_work_crew")
                  : `<button
                      type="button"
                      class="w-full min-h-[32px] items-center rounded px-1 py-0.5 hover:bg-black/[0.03] text-left whitespace-normal break-words"
                      data-edit-cell="${rowKey(row)}"
                      data-field="primary_work_crew"
                    >
                      ${crewDisplay
                        ? escapeHtml(crewDisplay)
                        : `<span class="text-black/35">—</span>`}
                    </button>`}
              </div>
            </td>

            <td class="py-2 px-2 whitespace-nowrap ${cellClass(row, "start_date")}"
                data-cell="${rowKey(row)}"
                data-field="start_date">
              ${isEditing(rowKey(row), "start_date")
                ? renderDateEditor(row, "start_date")
                : `<button
                    type="button"
                    class="inline-flex min-h-[32px] min-w-[100px] items-center rounded px-1 py-0.5 hover:bg-black/[0.03] text-left"
                    data-edit-cell="${rowKey(row)}"
                    data-field="start_date"
                  >
                    ${row.start_date
                      ? escapeHtml(formatMmDdYyyy(row.start_date))
                      : `<span class="text-black/35">—</span>`}
                  </button>`}
            </td>

            <td class="py-2 px-2 whitespace-nowrap ${cellClass(row, "end_date")}"
                data-cell="${rowKey(row)}"
                data-field="end_date">
              ${isEditing(rowKey(row), "end_date")
                ? renderDateEditor(row, "end_date")
                : `<button
                    type="button"
                    class="inline-flex min-h-[32px] min-w-[100px] items-center rounded px-1 py-0.5 hover:bg-black/[0.03] text-left"
                    data-edit-cell="${rowKey(row)}"
                    data-field="end_date"
                  >
                    ${row.end_date
                      ? escapeHtml(formatMmDdYyyy(row.end_date))
                      : `<span class="text-black/35">—</span>`}
                  </button>`}
            </td>

            <td class="py-2 px-2 text-center">
              ${renderWireGuidanceCell(row)}
            </td>

            <td class="py-2 px-2 whitespace-nowrap ${cellClass(row, "travel_days")}">
              ${renderTravelDaysCell(row)}
            </td>

            <td class="py-2 px-2 whitespace-nowrap ${cellClass(row, "overage_days")}">
              ${renderOverageDaysCell(row)}
            </td>

            <td class="py-2 px-2 whitespace-nowrap ${cellClass(row, "equipment_type")}"
                data-cell="${rowKey(row)}"
                data-field="equipment_type">
              ${renderEquipmentTypeCell(row)}
            </td>

            <td class="py-2 px-2 whitespace-nowrap ${cellClass(row, "notes")}"
                data-cell="${rowKey(row)}"
                data-field="notes">
              ${renderNotesCell(row)}
            </td>

            <td class="py-2 px-2 whitespace-nowrap">
              ${escapeHtml(formatMmDdYyyy(row.project_create_date))}
            </td>
          </tr>
        `;
      }).join("") || `
        <tr>
          <td class="py-6 text-center text-black/50" colspan="12">No projects match these filters.</td>
        </tr>
      `;
  }

  async function beginEdit(rowId, field) {
    const row = rows.find((x) => rowKey(x) === String(rowId));
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
    const result = await api("/assignment/save", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const oldRowKey = rowKey(row);

    if (result?.schedule_item_id != null) {
      row.schedule_item_id = Number(result.schedule_item_id);
    }

    row.project_status = payload.status || null;
    row.start_date = payload.start_date || null;
    row.end_date = payload.end_date || null;
    row.wire_guidance = payload.wire_guidance ? 1 : 0;
    row.travel_days = Number(payload.travel_days || 0);
    row.overage_days = Number(payload.overage_days || 0);
    row.equipment_type = payload.equipment_type || null;
    row.notes = payload.notes || null;

    row._active_project_managers = (payload.project_manager_ids || []).map((id) => ({
      project_manager_id: Number(id),
      is_primary: Number(id) === Number(payload.primary_project_manager_id) ? 1 : 0,
    }));

    row._active_work_crews = (payload.work_crew_ids || []).map((id) => ({
      work_crew_id: Number(id),
      is_primary: Number(id) === Number(payload.primary_work_crew_id) ? 1 : 0,
    }));

    syncDisplayFieldsFromActiveAssignments(row);
    upsertBundleItem(row, payload, result?.project_id || null);

    clearEditing();
    renderAll();
    flashCell(oldRowKey, flashField);
  }

  async function saveStatus(rowId, newStatus) {
    const row = rows.find((x) => rowKey(x) === String(rowId));
    if (!row) return;

    const oldStatus = row.project_status;

    // Immediately reflect the new status so the user doesn't need to refresh.
    row.project_status = newStatus;
    clearEditing();
    renderAll();

    try {
      await ensureBundle(row);

      const payload = {
        schedule_item_id: row.schedule_item_id != null ? Number(row.schedule_item_id) : null,
        qbo_customer_id: Number(row.qbo_customer_id),
        status: newStatus,
        start_date: row.start_date || null,
        end_date: row.end_date || null,
        wire_guidance: row.wire_guidance || 0,
        travel_days: row.travel_days || 0,
        overage_days: row.overage_days || 0,
        equipment_type: row.equipment_type || null,
        notes: row.notes || null,
        project_manager_ids: (row._active_project_managers || []).map(x => Number(x.project_manager_id)),
        primary_project_manager_id: (row._active_project_managers || []).find(x => x.is_primary)?.project_manager_id || null,
        work_crew_ids: (row._active_work_crews || []).map(x => Number(x.work_crew_id)),
        primary_work_crew_id: (row._active_work_crews || []).find(x => x.is_primary)?.work_crew_id || null,
      };

      await savePayload(row, payload, "project_status");
      setMsg(`Saved ${row.project_name}.`, true);
    } catch (e) {
      console.error(e);
      row.project_status = oldStatus;
      renderAll();
      setMsg("Could not update project status.");
    }
  }

  async function saveDateField(rowId, field, isoValue) {
    const row = rows.find((x) => rowKey(x) === String(rowId));
    if (!row) return;

    await ensureBundle(row);

    const payload = {
      schedule_item_id: row.schedule_item_id != null ? Number(row.schedule_item_id) : null,
      qbo_customer_id: Number(row.qbo_customer_id),
      status: USER_STATUSES.has(row.project_status) ? row.project_status : "not_started",
      start_date: field === "start_date" ? (isoValue || null) : (row.start_date || null),
      end_date: field === "end_date" ? (isoValue || null) : (row.end_date || null),
      wire_guidance: row.wire_guidance || 0,
      travel_days: row.travel_days || 0,
      overage_days: row.overage_days || 0,
      equipment_type: row.equipment_type || null,
      notes: row.notes || null,
      project_manager_ids: (row._active_project_managers || []).map(x => Number(x.project_manager_id)),
      primary_project_manager_id: (row._active_project_managers || []).find(x => x.is_primary)?.project_manager_id || null,
      work_crew_ids: (row._active_work_crews || []).map(x => Number(x.work_crew_id)),
      primary_work_crew_id: (row._active_work_crews || []).find(x => x.is_primary)?.work_crew_id || null,
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
    const row = rows.find((x) => rowKey(x) === String(rowId));
    if (!row) return;

    await ensureBundle(row);

    const isPm = field === "primary_project_manager";

    const checkedSelector = `[data-assign-check="${rowId}"][data-assign-field="${field}"]`;
    const primarySelector = `[data-assign-primary="${rowId}"][data-assign-field="${field}"]:checked`;

    const ids = Array.from(document.querySelectorAll(checkedSelector))
      .filter((x) => x.checked)
      .map((x) => Number(x.getAttribute("data-id")));

    const primaryEl = document.querySelector(primarySelector);
    const primaryId = primaryEl ? Number(primaryEl.getAttribute("data-id")) : null;

    const payload = {
      schedule_item_id: row.schedule_item_id != null ? Number(row.schedule_item_id) : null,
      qbo_customer_id: Number(row.qbo_customer_id),
      status: USER_STATUSES.has(row.project_status) ? row.project_status : "not_started",
      start_date: row.start_date || null,
      end_date: row.end_date || null,
      wire_guidance: row.wire_guidance || 0,
      travel_days: row.travel_days || 0,
      overage_days: row.overage_days || 0,
      equipment_type: row.equipment_type || null,
      notes: row.notes || null,
      project_manager_ids: isPm
        ? ids
        : (row._active_project_managers || []).map(x => Number(x.project_manager_id)),
      primary_project_manager_id: isPm
        ? primaryId
        : ((row._active_project_managers || []).find(x => x.is_primary)?.project_manager_id || null),
      work_crew_ids: isPm
        ? (row._active_work_crews || []).map(x => Number(x.work_crew_id))
        : ids,
      primary_work_crew_id: isPm
        ? ((row._active_work_crews || []).find(x => x.is_primary)?.work_crew_id || null)
        : primaryId,
    };

    try {
      await savePayload(row, payload, field);
      setMsg(`Saved ${row.project_name}.`, true);
    } catch (e) {
      console.error(e);
      const detail = e?.message || "";
      // Try to extract the FastAPI {"detail": "..."} payload for a useful
      // banner; fall back to a generic message otherwise.
      let friendly = detail;
      try {
        const parsed = JSON.parse(detail);
        if (parsed && parsed.detail) friendly = String(parsed.detail);
      } catch { /* not JSON */ }
      if (!friendly) friendly = "Could not update assignments.";
      setMsg(`Could not update assignments: ${friendly}`);
    }
  }

  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.q = e.target.value || "";
    renderAll();
  });

  document.getElementById("clearFiltersBtn").addEventListener("click", () => {
    state.q = "";
    state.filters.project_name = "";
    state.filters.project_status = [];
    state.filters.start_date_from = "";
    state.filters.start_date_to = "";
    state.filters.end_date_from = "";
    state.filters.end_date_to = "";
    state.filters.project_create_date_from = "";
    state.filters.project_create_date_to = "";
    state.filters.primary_project_manager = [];
    state.filters.primary_work_crew = [];
    state.filters.wire_guidance = [];
    state.filters.travel_days = [];
    state.filters.overage_days = [];
    state.filters.equipment_type = [];
    state.openFilter = null;
    document.getElementById("searchInput").value = "";
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
    const multiCheck = e.target.closest("[data-multiselect-check]");
    if (multiCheck) {
      e.stopPropagation();
      const key = multiCheck.getAttribute("data-multiselect-check");
      const value = multiCheck.getAttribute("data-multiselect-value");
      const current = state.filters[key] || [];
      state.filters[key] = multiCheck.checked
        ? [...current, value]
        : current.filter((v) => v !== value);
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
    const addRowBtn = e.target.closest("[data-add-schedule-row]");
    if (addRowBtn) {
      const rowId = addRowBtn.getAttribute("data-add-schedule-row");
      const row = rows.find((x) => rowKey(x) === String(rowId));
      if (row) {
        await ensureBundle(row);
        addScheduleRow(row);
      }
      return;
    }

    const removeRowBtn = e.target.closest("[data-remove-schedule-row]");
    if (removeRowBtn) {
      const rowId = removeRowBtn.getAttribute("data-remove-schedule-row");
      const idx = rows.findIndex((x) => rowKey(x) === String(rowId));
      if (idx < 0) return;

      const row = rows[idx];

      // Unsaved extra row: remove locally only
      if (row.schedule_item_id == null) {
        rows.splice(idx, 1);
        clearEditing();
        renderAll();
        return;
      }

      // Saved extra row: delete through backend
      try {
        await api(`/assignment/schedule-item/${row.schedule_item_id}`, {
          method: "DELETE",
        });

        rows.splice(idx, 1);
        clearEditing();
        renderAll();
        setMsg("Row deleted.", true);
      } catch (err) {
        console.error(err);
        setMsg("Could not delete row.");
      }

      return;
    }
    
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

    // Wire guidance checkbox — saves immediately on click
    const wireCheck = e.target.closest("[data-wire-check]");
    if (wireCheck) {
      const rowId = wireCheck.getAttribute("data-wire-check");
      const row = rows.find(x => rowKey(x) === String(rowId));
      if (row) {
        row.wire_guidance = wireCheck.checked ? 1 : 0;
        await saveMiscFields(row);
      }
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
      // Primary radio — auto-check the matching checkbox so the row's PM/crew
      // is included in the save payload. Without this, picking a primary
      // without first ticking the checkbox sends the backend a primary id
      // that isn't in project_manager_ids / work_crew_ids and it 400s.
      const primaryRadio = e.target.closest("[data-assign-primary]");
      if (primaryRadio && primaryRadio.checked) {
        const rowId = primaryRadio.getAttribute("data-assign-primary");
        const field = primaryRadio.getAttribute("data-assign-field");
        const id    = primaryRadio.getAttribute("data-id");
        const cb = document.querySelector(
          `[data-assign-check="${rowId}"][data-assign-field="${field}"][data-id="${id}"]`
        );
        if (cb && !cb.checked) cb.checked = true;
        return;
      }

      // Unchecking a row's checkbox while it's the primary — clear the primary
      // so we don't ship an orphan primary id to the backend.
      const assignCheck = e.target.closest("[data-assign-check]");
      if (assignCheck && !assignCheck.checked) {
        const rowId = assignCheck.getAttribute("data-assign-check");
        const field = assignCheck.getAttribute("data-assign-field");
        const id    = assignCheck.getAttribute("data-id");
        const radio = document.querySelector(
          `[data-assign-primary="${rowId}"][data-assign-field="${field}"][data-id="${id}"]`
        );
        if (radio && radio.checked) radio.checked = false;
        return;
      }

      // Travel days dropdown
      const travelSelect = e.target.closest("[data-travel-select]");
      if (travelSelect) {
        const rowId = travelSelect.getAttribute("data-travel-select");
        const row = rows.find(x => rowKey(x) === String(rowId));
        if (row) {
          row.travel_days = Number(travelSelect.value);
          await saveMiscFields(row);
          clearEditing();
        }
        return;
      }

      const equipmentSelect = e.target.closest("[data-equipment-select]");
      if (equipmentSelect) {
        const rowId = equipmentSelect.getAttribute("data-equipment-select");
        const row = rows.find(x => rowKey(x) === String(rowId));
        if (row) {
          row.equipment_type = equipmentSelect.value || null;
          await saveMiscFields(row);
          clearEditing();
        }
        return;
      }

    // Date picker (native calendar)
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
      // Overage days — save on Enter
      const overageInput = e.target.closest("[data-overage-input]");
      if (overageInput && e.key === "Enter") {
        e.preventDefault();
        const rowId = overageInput.getAttribute("data-overage-input");
        const row = rows.find(x => rowKey(x) === String(rowId));
        if (row) {
          row.overage_days = Math.max(0, parseInt(overageInput.value) || 0);
          try {
            await saveMiscFields(row);
          } catch (err) {
            setMsg("Could not update overage days.");
          }
          clearEditing();
        }
        return;
      }

      // Date text — save on Enter
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

  document.getElementById("assignmentBody").addEventListener("keydown", async (e) => {
    const notesInput = e.target.closest("[data-notes-input]");
    if (notesInput && e.key === "Enter") {
      e.preventDefault();
      const rowId = notesInput.getAttribute("data-notes-input");
      const row = rows.find(x => rowKey(x) === String(rowId));
      if (row) {
        row.notes = notesInput.value.trim() || null;
        try {
          await saveMiscFields(row, "notes");
        } catch (err) {
          setMsg("Could not update notes.");
        }
        clearEditing();
      }
      return;
    }
  });

  document.getElementById("assignmentBody").addEventListener("focusout", async (e) => {
    // Overage days — save when user clicks away
    const overageInput = e.target.closest("[data-overage-input]");
    if (overageInput) {
      const rowId = overageInput.getAttribute("data-overage-input");
      const row = rows.find(x => rowKey(x) === String(rowId));
      if (row) {
        row.overage_days = Math.max(0, parseInt(overageInput.value) || 0);
        try {
          await saveMiscFields(row);
        } catch (err) {
          setMsg("Could not update overage days.");
        }
        clearEditing();
      }
      return;
    }

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

  document.getElementById("assignmentBody").addEventListener("focusout", async (e) => {
    const notesInput = e.target.closest("[data-notes-input]");
    if (!notesInput) return;

    const rowId = notesInput.getAttribute("data-notes-input");
    const row = rows.find(x => rowKey(x) === String(rowId));
    if (row) {
      row.notes = notesInput.value.trim() || null;
      try {
        await saveMiscFields(row, "notes");
      } catch (err) {
        setMsg("Could not update notes.");
      }
      clearEditing();
    }
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
      else if (key === "project_status") state.filters.project_status = [];
      else if (key === "primary_project_manager") state.filters.primary_project_manager = [];
      else if (key === "primary_work_crew") state.filters.primary_work_crew = [];
      else if (key === "start_date") {
        state.filters.start_date_from = "";
        state.filters.start_date_to = "";
      } else if (key === "end_date") {
        state.filters.end_date_from = "";
        state.filters.end_date_to = "";
      } else if (key === "project_create_date") {
        state.filters.project_create_date_from = "";
        state.filters.project_create_date_to = "";
      } else if (key === "wire_guidance") {
        state.filters.wire_guidance = [];
      } else if (key === "travel_days") {
        state.filters.travel_days = [];
      } else if (key === "overage_days") {
        state.filters.overage_days = [];
      } else if (key === "equipment_type") {
        state.filters.equipment_type = [];
      }

      renderAll();
      return;
    }

    const sortBtn = e.target.closest("[data-sort]");
    if (sortBtn) {
      const key = sortBtn.getAttribute("data-sort");
      if (state.sortKey === key) {
        if (state.sortDir === "asc") state.sortDir = "desc";
        else { state.sortKey = null; state.sortDir = "asc"; }   // 3rd click resets
      } else {
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
    const clickedTravelSelect = e.target.closest("[data-travel-select]");
    const clickedOverageInput = e.target.closest("[data-overage-input]");
    const clickedEquipmentSelect = e.target.closest("[data-equipment-select]");
    
    if (
      state.editing.field &&
      !clickedInsideActiveEditor &&
      !clickedEditCell &&
      !clickedStatusChoice &&
      !clickedAssignmentSave &&
      !clickedAssignmentCancel &&
      !clickedTravelSelect &&
      !clickedOverageInput &&
      !clickedEquipmentSelect
    ) {
      clearEditing();
      renderAll();
    }
  });

  renderAll();
}