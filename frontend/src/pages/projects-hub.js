// Projects hub — the operational system of record for every QuickBooks project.
// Project-grain list (one row per project) with operational status, PM/crew,
// schedule window, the originating quote, a value snapshot, and docs. Each row
// opens the project detail workspace. Absorbs the old Projects dashboard +
// Assignment landing; Financials + Schedule remain focused deep-dive views.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

const dash = (s) => (s == null || s === "" ? "—" : s);
const ymd = (s) => (s ? String(s).slice(0, 10) : "—");
const money = (n) => (n == null || n === "" ? "—" : "$" + Math.round(Number(n)).toLocaleString());

// Operational status → label + pill styling. Order drives the filter pills.
const OP_STATUS = {
  needs_assignment: { label: "Needs assignment", cls: "bg-rose-100 text-rose-800" },
  pending:          { label: "Pending",          cls: "bg-amber-100 text-amber-800" },
  assigned:         { label: "Assigned",         cls: "bg-slate-200 text-slate-700" },
  scheduled:        { label: "Scheduled",        cls: "bg-sky-100 text-sky-800" },
  in_progress:      { label: "In progress",      cls: "bg-indigo-100 text-indigo-800" },
  complete:         { label: "Complete",         cls: "bg-emerald-100 text-emerald-800" },
  canceled:         { label: "Canceled",         cls: "bg-black/10 text-black/50" },
};
const statusBadge = (s) => {
  const m = OP_STATUS[s] || { label: s || "—", cls: "bg-black/10 text-black/50" };
  return `<span class="text-[10px] font-semibold rounded px-1.5 py-0.5 whitespace-nowrap ${m.cls}">${escapeHtml(m.label)}</span>`;
};

export async function projectsHubPage(routeFn) {
  let all = [];
  let finById = new Map();
  let statusFilter = "all", search = "", sortKey = "project_name", sortDir = "asc";

  const body = `
    <div class="w-full">
      <div class="card p-3 flex flex-col overflow-hidden" id="phCard" style="min-height:340px;">
        <div class="flex items-center gap-2 mb-2 flex-wrap shrink-0" id="phFilters"></div>
        <div id="phList" class="flex-1 overflow-auto text-sm text-black/40">Loading…</div>
      </div>
    </div>`;
  setShell({
    title: "Projects",
    subtitle: "Every QuickBooks project — status, crew, schedule, and financials in one place. Open a project for its full workspace.",
    bodyHtml: body, showLogout: true, routeFn,
  });

  const listEl = document.getElementById("phList");
  const filtersEl = document.getElementById("phFilters");

  // Opening a project from the hub should return "← Back to Projects" (not the
  // default Customers). Scoped to the exact project via opi_entity_back.
  listEl.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#/entity/project/"]');
    if (!a) return;
    const qid = decodeURIComponent(a.getAttribute("href").split("/").pop());
    try { sessionStorage.setItem("opi_entity_back", JSON.stringify({ entity: "project/" + qid, label: "Projects", hash: "#/projects" })); } catch (_) {}
  });

  const sizeCard = () => {
    const card = document.getElementById("phCard");
    if (!card) return;
    const top = card.getBoundingClientRect().top;
    card.style.height = Math.max(340, window.innerHeight - top - 30) + "px";
  };
  window.addEventListener("resize", sizeCard);

  const COLS = [
    { key: "project_name", label: "Project", td: (p) =>
      `<a href="#/entity/project/${escapeHtml(String(p.project_qbo_id))}" class="font-semibold text-blue-700 hover:underline">${escapeHtml(dash(p.project_name))}</a>` },
    { key: "operational_status", label: "Status", td: (p) => statusBadge(p.operational_status) },
    { key: "primary_project_manager", label: "PM", cls: "text-black/60", td: (p) => escapeHtml(dash(p.primary_project_manager)) },
    { key: "primary_work_crew", label: "Crew", cls: "text-black/60", td: (p) => escapeHtml(dash(p.primary_work_crew)) },
    { key: "start_date", label: "Start", cls: "tabular-nums text-black/60", td: (p) => ymd(p.start_date) },
    { key: "end_date", label: "End", cls: "tabular-nums text-black/60", td: (p) => ymd(p.end_date) },
    { key: "linked_quote_number", label: "Quote #", cls: "tabular-nums text-black/60", td: (p) => escapeHtml(dash(p.linked_quote_number)) },
    { key: "value", label: "Value", align: "right", cls: "tabular-nums text-black/70", td: (p) => {
        const f = finById.get(p.qbo_customer_id);
        const v = f ? (Number(f.invoice_line_amt) || Number(f.estimate_line_amt) || 0) : null;
        return money(v);
      } },
    { key: "file_count", label: "Docs", align: "center", td: (p) =>
      `<a href="#/entity/project/${escapeHtml(String(p.project_qbo_id))}" class="font-semibold ${p.file_count ? "text-blue-700" : "text-black/40"} hover:underline" title="Documents">📎${p.file_count || 0}</a>` },
  ];

  const finVal = (p) => {
    const f = finById.get(p.qbo_customer_id);
    return f ? (Number(f.invoice_line_amt) || Number(f.estimate_line_amt) || 0) : 0;
  };
  const sortVal = (p, key) => {
    if (key === "value") return finVal(p);
    if (key === "file_count") return Number(p.file_count) || 0;
    return (p[key] ?? "").toString().toLowerCase();
  };
  const searchKey = (p) => `${p.project_name || ""} ${p.primary_project_manager || ""} ${p.primary_work_crew || ""} ${p.linked_quote_number || ""}`.toLowerCase();
  const sortedAll = () => {
    const out = [...all];
    out.sort((a, b) => { const av = sortVal(a, sortKey), bv = sortVal(b, sortKey); return (av < bv ? -1 : av > bv ? 1 : 0) * (sortDir === "asc" ? 1 : -1); });
    return out;
  };

  const arrow = (k) => (sortKey !== k ? "" : sortDir === "asc" ? " ▲" : " ▼");
  const onHeaderClick = (k) => {
    if (sortKey !== k) { sortKey = k; sortDir = "asc"; }
    else if (sortDir === "asc") sortDir = "desc";
    else { sortKey = "project_name"; sortDir = "asc"; }
    renderList();
  };

  const renderFilters = () => {
    const counts = all.reduce((m, p) => { m[p.operational_status] = (m[p.operational_status] || 0) + 1; return m; }, {});
    const pills = [["all", "All"], ...Object.keys(OP_STATUS).map((k) => [k, OP_STATUS[k].label])];
    filtersEl.innerHTML =
      pills.map(([k, label]) => {
        const n = k === "all" ? all.length : (counts[k] || 0);
        return `<button data-sf="${k}" class="rounded-full px-2.5 py-1 text-xs font-semibold border ${statusFilter === k ? "bg-ink-900 text-white border-ink-900" : "border-black/15 text-black/60 hover:bg-black/5"}">${escapeHtml(label)} <span class="opacity-60">${n}</span></button>`;
      }).join("") +
      `<input data-search value="${escapeHtml(search)}" placeholder="Search project, PM, crew, quote…" class="input text-xs py-1.5 w-full sm:max-w-xs ml-auto">` +
      `<span data-count class="text-xs text-black/40 whitespace-nowrap"></span>`;
    filtersEl.querySelectorAll("[data-sf]").forEach((b) => b.addEventListener("click", () => { statusFilter = b.getAttribute("data-sf"); renderFilters(); applyFilter(); }));
    const sb = filtersEl.querySelector("[data-search]");
    let t = null;
    sb.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { search = sb.value.trim(); applyFilter(); }, 60); });
    if (document.activeElement?.getAttribute?.("data-search") != null) sb.focus();
  };

  // Filtering only toggles row visibility (cheap) — it never rebuilds the table,
  // so typing in the search box stays responsive even with hundreds of rows.
  const applyFilter = () => {
    const q = search.toLowerCase();
    let shown = 0;
    listEl.querySelectorAll("tbody tr").forEach((tr) => {
      const ok = (statusFilter === "all" || tr.getAttribute("data-status") === statusFilter)
        && (!q || (tr.getAttribute("data-key") || "").includes(q));
      tr.hidden = !ok;
      if (ok) shown++;
    });
    const countEl = filtersEl.querySelector("[data-count]");
    if (countEl) countEl.textContent = `${shown.toLocaleString()} of ${all.length.toLocaleString()}`;
    const empty = listEl.querySelector("[data-empty]");
    if (empty) empty.hidden = shown > 0;
  };

  // Full render — only on load, sort, or financials merge (not on keystroke).
  const renderList = () => {
    if (!all.length) { listEl.innerHTML = `<div class="text-black/45 py-4">No projects found.</div>`; return; }
    const rows = sortedAll();
    listEl.innerHTML = `
      <table class="w-full text-sm" style="min-width:900px;">
        <thead class="sticky top-0 z-10 bg-white text-left text-black/45"><tr class="border-b border-black/10">
          ${COLS.map((c) => `<th class="py-2 pr-3 font-bold cursor-pointer select-none hover:text-black/70 bg-white whitespace-nowrap ${c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : ""}" data-sort="${c.key}">${c.label}${arrow(c.key)}</th>`).join("")}
        </tr></thead>
        <tbody>${rows.map((p) => `
          <tr data-status="${escapeHtml(p.operational_status || "")}" data-key="${escapeHtml(searchKey(p))}" class="border-b border-black/5 hover:bg-black/[0.02]">
            ${COLS.map((c) => `<td class="py-1.5 pr-3 ${c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : ""} ${c.cls || ""}">${c.td(p)}</td>`).join("")}
          </tr>`).join("")}
        </tbody>
      </table>
      <div data-empty hidden class="text-black/45 py-4">No projects match.</div>`;
    listEl.querySelectorAll("[data-sort]").forEach((th) => th.addEventListener("click", () => onHeaderClick(th.getAttribute("data-sort"))));
    applyFilter();
  };

  // Load the project list first (fast); merge financials when they arrive.
  try {
    const d = await api("/projects/basic");
    all = d.projects || [];
  } catch (e) {
    listEl.innerHTML = `<div class="text-red-700 text-sm">Failed to load projects.</div>`;
    return;
  }
  renderFilters();
  renderList();
  sizeCard();
  requestAnimationFrame(sizeCard);

  // Progressive: fold in the value snapshot once financials load.
  api("/projects/financials")
    .then((d) => { finById = new Map((d.financials || []).map((f) => [f.qbo_customer_id, f])); renderList(); })
    .catch(() => {});
}
