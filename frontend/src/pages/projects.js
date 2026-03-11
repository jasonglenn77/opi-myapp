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

  const bodyHtml = `
    <div class="h-full min-h-0 flex flex-col gap-4">
      <!-- KPI card (fixed height) -->
      <div class="card p-5 shrink-0">
        <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">Projects</div>
            <div class="text-sm text-black/60">Status and totals</div>
          </div>

          <div class="flex items-center gap-2">
            <div class="text-sm font-semibold text-black/60 whitespace-nowrap">Search</div>
            <input id="searchInput" class="input w-full sm:w-64" placeholder="Name, status, PM, crew" />
          </div>
        </div>

        <div class="mt-3 kpi-grid" id="kpiGrid"></div>
      </div>

      <!-- TABLE card fills remaining height (and is height-bounded) -->
      <div class="card p-5 flex flex-col flex-1 min-h-0 overflow-hidden">
        <div class="flex items-end justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">Projects</div>
            <div class="text-sm text-black/60">Scroll + sort by column</div>
          </div>
          <div class="text-sm text-black/60" id="rowCount">—</div>
        </div>

        <!-- Table frame consumes remaining height in this card -->
        <div class="mt-4 border border-black/5 bg-white/40 rounded-2xl flex-1 min-h-0 overflow-hidden">
          <div class="flex flex-col h-full min-h-0">
            <!-- Vertical scroll lives here -->
            <div
              id="tableScroller"
              class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain [-webkit-overflow-scrolling:touch]"
            >
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
                    ${th("actions", "Files")}
                    ${th("total_transaction_ct", "trans_ct")}
                    <!-- ${th("project_create_dttm", "Created")}
                    ${th("project_lastupdate_dttm", "Last updated")} -->

                  </tr>
                </thead>
                <tbody id="projectsBody"></tbody>
              </table>
            </div>

            <!-- Sticky horizontal scrollbar pinned to bottom -->
            <div id="hScroll" class="hscrollbar">
              <div id="hScrollInner" class="hscrollbar-inner"></div>
            </div>
          </div>
        </div>
      </div>

      <div id="fileModal" class="fixed inset-0 z-50 hidden">
        <div class="absolute inset-0 bg-black/50 backdrop-blur-[2px]" data-close-file-modal="1"></div>

        <div class="absolute inset-x-4 top-6 bottom-6 mx-auto max-w-6xl">
          <div class="h-full rounded-3xl border border-black/10 bg-white shadow-2xl overflow-hidden flex flex-col">
            <div class="flex items-center justify-between px-5 py-4 border-b border-black/10">
              <div>
                <div id="fileModalTitle" class="text-lg font-extrabold">Project Files</div>
                <div id="fileModalSubtitle" class="text-sm text-black/60">Preview and file details</div>
              </div>
              <button
                type="button"
                id="fileModalClose"
                class="inline-flex items-center rounded-xl border border-black/10 px-3 py-2 text-sm text-black/60 font-semibold hover:bg-black/5"
              >
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
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                    <div>
                      <div class="text-black/50">Filename</div>
                      <div id="metaFilename" class="font-semibold break-all"></div>
                    </div>
                    <div>
                      <div class="text-black/50">Uploaded</div>
                      <div id="metaCreatedAt" class="font-semibold"></div>
                    </div>
                    <div>
                      <div class="text-black/50">Type</div>
                      <div id="metaContentType" class="font-semibold"></div>
                    </div>
                    <div>
                      <div class="text-black/50">Size</div>
                      <div id="metaSize" class="font-semibold"></div>
                    </div>
                  </div>

                  <div class="mt-4">
                    <a
                      id="openFileLink"
                      href="#"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex items-center rounded-xl bg-black text-white px-4 py-2 text-sm font-semibold hover:opacity-90"
                    >
                      Open full file
                    </a>
                  </div>
                </div>
              </div>
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
    scrollMode: "viewport", // this page has an inner scroll region, so keep page scroll disabled
  });

  function syncStickyHScroll() {
    const scroller = document.getElementById("tableScroller");
    const hScroll = document.getElementById("hScroll");
    const hInner = document.getElementById("hScrollInner");
    const table = document.getElementById("projectsTable");

    if (!scroller || !hScroll || !hInner || !table) return;

    // set the "fake" scroll width to match the real table width
    const w = table.scrollWidth;
    hInner.style.width = `${w}px`;

    // sync positions once (important after refresh / filter / sort)
    hScroll.scrollLeft = scroller.scrollLeft;
  }

  // keep them synced while scrolling
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

    window.addEventListener("resize", () => {
      syncStickyHScroll();
    });
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

  // Shared KPI color classes (used by KPI buttons + status pills)
  const KPI_STYLES = {
    needs_assignment: {
      wrap: "bg-kpi-attention-bg border-kpi-attention-bd",
      label: "text-kpi-attention-text",
      num: "text-kpi-attention-num",
    },
    not_started: {
      wrap: "bg-kpi-notStarted-bg border-kpi-notStarted-bd",
      label: "text-kpi-notStarted-text",
      num: "text-kpi-notStarted-num",
    },
    in_progress: {
      wrap: "bg-kpi-inProgress-bg border-kpi-inProgress-bd",
      label: "text-kpi-inProgress-text",
      num: "text-kpi-inProgress-num",
    },
    completed: {
      wrap: "bg-kpi-completed-bg border-kpi-completed-bd",
      label: "text-kpi-completed-text",
      num: "text-kpi-completed-num",
    },
    all: {
      wrap: "bg-kpi-total-bg border-kpi-total-bd",
      label: "text-kpi-total-text",
      num: "text-kpi-total-num",
    },
    showing: {
      wrap: "bg-kpi-showing-bg border-kpi-showing-bd",
      label: "text-kpi-showing-text",
      num: "text-kpi-showing-num",
    },
  };

  function statusPill(r) {
    const key = bucketOf(r);              // maps to needs_assignment/not_started/etc
    const label = statusLabelOf(r);
    const s = KPI_STYLES[key] || KPI_STYLES.all;

    // pill: subtle, professional, matches KPI tints
    return `
      <span class="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${s.wrap} ${s.label}">
        ${escapeHtml(label || "—")}
      </span>
    `;
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
      const s = KPI_STYLES[key] || KPI_STYLES.all;

      return `
        <button
          type="button"
          class="rounded-xl border px-4 py-3 text-center transition
                 hover:brightness-95
                 ${s.wrap}
                 ${clickable ? "cursor-pointer" : "cursor-default"}
                 ${selected ? "ring-2 ring-ink-800/10" : ""}"
          ${clickable ? `data-kpi="${key}"` : ""}
          ${clickable ? `aria-pressed="${selected ? "true" : "false"}"` : ""}
        >
          <div class="text-xs font-semibold tracking-wide ${s.label}">${label}</div>
          <div class="pt-1 text-2xl font-extrabold leading-tight ${s.num}">${value}</div>
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

          <td class="py-2 px-3 text-left whitespace-nowrap">${statusPill(r)}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${escapeHtml(fmtDateOnly(r.start_date))}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${escapeHtml(fmtDateOnly(r.end_date))}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${escapeHtml(r.primary_project_manager || "")}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${escapeHtml(r.primary_work_crew || "")}</td>

          <td class="py-2 px-3 text-left whitespace-nowrap">${fmtMoney(r.project_balance)}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${fmtMoney(r.total_income)}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${fmtMoney(r.total_cost)}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${fmtMoney(r.total_profit)}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${fmtPct(r.profit_margin)}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition"
                data-upload-project="${escapeHtml(String(r.qbo_customer_id || ""))}"
                data-project-name="${escapeHtml(r.project_name || "")}"
              >
                Upload
              </button>

              <button
                type="button"
                class="inline-flex items-center rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold text-black/75 hover:bg-black/5 transition ${Number(r.file_count || 0) > 0 ? "" : "opacity-60"}"
                data-view-files="${escapeHtml(String(r.qbo_customer_id || ""))}"
                data-project-name="${escapeHtml(r.project_name || "")}"
              >
                View
                <span class="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-black/5 px-1.5 py-0.5 text-[11px] font-bold">
                  ${Number(r.file_count || 0)}
                </span>
              </button>
            </div>
          </td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${r.total_transaction_ct ?? ""}</td>

          <!-- <td class="py-2 px-3 text-left whitespace-nowrap">${escapeHtml(fmtDateOnly(r.project_create_dttm))}</td>
          <td class="py-2 px-3 text-left whitespace-nowrap">${escapeHtml(fmtDateOnly(r.project_lastupdate_dttm))}</td>-->
        </tr>
      `;
        })
        .join("") ||
      `
      <tr><td class="py-6 text-center text-black/50" colspan="15">No projects match these filters.</td></tr>
    `;
    syncStickyHScroll();
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

  document.getElementById("projectsBody").addEventListener("click", async (e) => {
    const uploadBtn = e.target.closest("[data-upload-project]");
    if (uploadBtn) {
      const qboCustomerId = uploadBtn.getAttribute("data-upload-project");
      if (!qboCustomerId) {
        alert("This project is missing qbo_customer_id.");
        return;
      }

      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/jpeg,image/png,image/webp,application/pdf";

      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;

        const fd = new FormData();
        fd.append("file", file);

        try {
          await api(`/projects/${qboCustomerId}/files`, {
            method: "POST",
            body: fd,
          });

          const row = rows.find(x => String(x.qbo_customer_id) === String(qboCustomerId));
          if (row) row.file_count = Number(row.file_count || 0) + 1;

          renderTable();
        } catch (err) {
          alert(`Upload failed: ${err.message}`);
        }
      };

      input.click();
      return;
    }

    const viewBtn = e.target.closest("[data-view-files]");
    if (viewBtn) {
      const qboCustomerId = viewBtn.getAttribute("data-view-files");
      const projectName = viewBtn.getAttribute("data-project-name") || "Project Files";

      if (!qboCustomerId) {
        alert("This project is missing qbo_customer_id.");
        return;
      }

      try {
        const res = await api(`/projects/${qboCustomerId}/files`);
        const files = res.files || [];

        if (!files.length) {
          alert("No files uploaded for this project yet.");
          return;
        }

        openFileModal(projectName, files, 0);
      } catch (err) {
        alert(`Could not load files: ${err.message}`);
      }
    }
  });

  const modalState = {
    projectName: "",
    files: [],
    activeIndex: 0,
  };

  function fmtDateTime(v) {
    if (!v) return "";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString();
  }

  function fmtBytes(bytes) {
    const n = Number(bytes || 0);
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = n;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function isImageFile(file) {
    return (file.content_type || "").startsWith("image/");
  }

  function escapeAttr(v) {
    return escapeHtml(String(v ?? ""));
  }

  function openFileModal(projectName, files, startIndex = 0) {
    modalState.projectName = projectName || "Project Files";
    modalState.files = files || [];
    modalState.activeIndex = startIndex;

    document.getElementById("fileModalTitle").textContent = modalState.projectName;
    document.getElementById("fileModalSubtitle").textContent = `${modalState.files.length} file${modalState.files.length === 1 ? "" : "s"}`;
    document.getElementById("fileModal").classList.remove("hidden");

    renderFileModal();
  }

  function closeFileModal() {
    document.getElementById("fileModal").classList.add("hidden");
    document.getElementById("filePreview").innerHTML = "";
    document.getElementById("fileList").innerHTML = "";
  }

  function renderFileModal() {
    const files = modalState.files;
    const active = files[modalState.activeIndex];
    if (!active) {
      closeFileModal();
      return;
    }

    const listEl = document.getElementById("fileList");
    listEl.innerHTML = files.map((f, idx) => {
      const selected = idx === modalState.activeIndex;
      const thumb = isImageFile(f)
        ? `<img src="${escapeAttr(f.url)}" alt="${escapeAttr(f.original_filename || "")}" class="h-12 w-12 rounded-xl object-cover border border-black/10 bg-white" />`
        : `<div class="h-12 w-12 rounded-xl border border-black/10 bg-white flex items-center justify-center text-xs font-bold text-black/50">FILE</div>`;

      return `
        <button
          type="button"
          data-file-index="${idx}"
          class="w-full text-left rounded-2xl border px-3 py-3 transition hover:bg-white ${selected ? "bg-white border-black/15 shadow-sm" : "border-transparent"}"
        >
          <div class="flex items-center gap-3">
            ${thumb}
            <div class="min-w-0">
              <div class="font-semibold truncate">${escapeHtml(f.original_filename || "Untitled")}</div>
              <div class="text-xs text-black/50">${escapeHtml(fmtDateTime(f.created_at))}</div>
            </div>
          </div>
        </button>
      `;
    }).join("");

    const previewEl = document.getElementById("filePreview");
    if (isImageFile(active)) {
      previewEl.innerHTML = `
        <img
          src="${escapeAttr(active.url)}"
          alt="${escapeAttr(active.original_filename || "")}"
          class="max-w-full max-h-full object-contain rounded-2xl shadow-sm"
        />
      `;
    } else if ((active.content_type || "") === "application/pdf") {
      previewEl.innerHTML = `
        <iframe
          src="${escapeAttr(active.url)}"
          class="w-full h-full rounded-2xl bg-white"
          title="${escapeAttr(active.original_filename || "PDF")}"
        ></iframe>
      `;
    } else {
      previewEl.innerHTML = `
        <div class="text-center text-black/60">
          <div class="text-lg font-bold">Preview unavailable</div>
          <div class="mt-1 text-sm">Open the file in a new tab.</div>
        </div>
      `;
    }

    document.getElementById("metaFilename").textContent = active.original_filename || "";
    document.getElementById("metaCreatedAt").textContent = fmtDateTime(active.created_at);
    document.getElementById("metaContentType").textContent = active.content_type || "";
    document.getElementById("metaSize").textContent = fmtBytes(active.size_bytes);

    const openLink = document.getElementById("openFileLink");
    openLink.href = active.url;
  }

  document.getElementById("fileModalClose").addEventListener("click", closeFileModal);

  document.getElementById("fileModal").addEventListener("click", (e) => {
    if (e.target.closest("[data-close-file-modal='1']")) {
      closeFileModal();
      return;
    }

    const fileBtn = e.target.closest("[data-file-index]");
    if (fileBtn) {
      modalState.activeIndex = Number(fileBtn.getAttribute("data-file-index"));
      renderFileModal();
    }
  });

  document.addEventListener("keydown", (e) => {
    const modal = document.getElementById("fileModal");
    if (modal.classList.contains("hidden")) return;

    if (e.key === "Escape") {
      closeFileModal();
      return;
    }

    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      modalState.activeIndex = Math.min(modalState.activeIndex + 1, modalState.files.length - 1);
      renderFileModal();
    }

    if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      modalState.activeIndex = Math.max(modalState.activeIndex - 1, 0);
      renderFileModal();
    }
  });

  renderTable();
  bindStickyHScroll();
  // after first paint so scrollWidth is correct
  setTimeout(syncStickyHScroll, 0);
}