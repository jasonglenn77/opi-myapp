// Customers — one table of every estimate / job / project, resolved to its
// customer. Sort/filter/search across everything (flat), or group by customer
// (default, collapsed → expand to see a customer's entities). Read-only;
// reuses the Estimates-table patterns (fixed-portal filters, 3-state sort).
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

const TYPE_STYLE = {
  estimate: "bg-blue-100 text-blue-700",
  job: "bg-violet-100 text-violet-700",
  project: "bg-emerald-100 text-emerald-700",
};
const FUNNEL = (a) => `<svg class="size-3.5 ${a ? "text-blue-600" : "text-black/30"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>`;
const CHEV = `<svg class="size-4 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>`;

// Persisted UI state — so returning from an entity's document page restores the
// user's sort / filters / grouping / expanded customers / scroll position.
const custUi = { sortKey: "last_activity", sortDir: -1, search: "", groupBy: true, filters: {}, expanded: new Set(), scrollTop: 0 };

// Project/job status pills reuse the Assignments-page KPI palette; estimate
// rows keep the pipeline-status colors from the Quoting page.
const KPI_STYLES = {
  needs_assignment: "bg-kpi-attention-bg border-kpi-attention-bd text-kpi-attention-text",
  not_started:      "bg-kpi-notStarted-bg border-kpi-notStarted-bd text-kpi-notStarted-text",
  in_progress:      "bg-kpi-inProgress-bg border-kpi-inProgress-bd text-kpi-inProgress-text",
  completed:        "bg-kpi-completed-bg border-kpi-completed-bd text-kpi-completed-text",
  canceled:         "bg-red-50 border-red-200 text-red-700",
  scheduled:        "bg-kpi-showing-bg border-kpi-showing-bd text-kpi-showing-text",
  all:              "bg-kpi-total-bg border-kpi-total-bd text-kpi-total-text",
};
const EST_STATUS_COLORS = {
  "0% Lost":                                          "bg-red-100 text-red-700",
  "0% Inactive":                                      "bg-orange-100 text-orange-700",
  "20% Verbal - Budgetary, Project Uncertain":        "bg-yellow-100 text-yellow-800",
  "40% Competitive, Multiple Bidders":                "bg-sky-100 text-sky-800",
  "60% Project Confirmed, Customer Well-Positioned":  "bg-blue-700 text-white",
  "80% Verbal Approval, Very likely to Receive Order":"bg-purple-100 text-purple-800",
  "80% Red Flag > Goes to Ops Tab":                   "bg-red-700 text-white",
  "100% Won > Goes to Ops Tab":                       "bg-green-700 text-white",
};
function projBucket(v) {
  const s = (v || "").toString().trim().toLowerCase();
  if (!s) return "all";
  if (s === "needs_attention" || s === "needs attention") return "needs_assignment";
  if (s === "not_started" || s === "not started" || s === "inactive") return "not_started";
  if (s === "in_progress" || s === "in progress" || s === "active") return "in_progress";
  if (s === "scheduled") return "scheduled";
  if (s === "completed") return "completed";
  if (s === "canceled" || s === "cancelled") return "canceled";
  return "all";
}
const humanizeStatus = (v) => (v || "").toString().trim().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export async function customersPage(routeFn) {
  let data;
  try { data = await api("/customers/entities"); }
  catch (e) {
    mount(`<div class="w-full"><div class="card p-5 text-sm text-red-700">Failed to load customers: ${escapeHtml(e?.message || String(e))}</div></div>`, routeFn);
    return;
  }
  const entities = data.entities || [];
  const customers = data.customers || [];
  const custById = {}; customers.forEach(c => { custById[c.customer_qbo_id] = c; });

  let sortKey = custUi.sortKey, sortDir = custUi.sortDir, search = custUi.search, groupBy = custUi.groupBy;
  const filters = custUi.filters;     // shared reference → mutations persist automatically
  const expanded = custUi.expanded;   // shared reference → expansions persist automatically
  const saveUi = () => { Object.assign(custUi, { sortKey, sortDir, search, groupBy }); };

  const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
  const ymd = (s) => (s ? String(s).slice(0, 10) : "—");
  const typeBadge = (t) => `<span class="inline-flex rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${TYPE_STYLE[t] || "bg-black/10 text-black/50"}">${t}</span>`;
  const statusBadge = (r) => {
    const s = r.status;
    if (!s) return `<span class="text-black/25">—</span>`;
    if (r.type === "estimate") {
      const cls = EST_STATUS_COLORS[s] || "bg-sky-100 text-sky-800";
      return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap truncate max-w-full ${cls}">${escapeHtml(s)}</span>`;
    }
    const cls = KPI_STYLES[projBucket(s)] || KPI_STYLES.all;
    return `<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap truncate max-w-full ${cls}">${escapeHtml(humanizeStatus(s))}</span>`;
  };

  const COLS = [
    { key: "customer_name", label: "Customer", type: "text", w: 190, trunc: true, td: (r) => `<span class="font-semibold text-ink-900">${escapeHtml(r.customer_name || "—")}</span>` },
    { key: "type", label: "Type", type: "multi", w: 90, td: (r) => typeBadge(r.type) },
    { key: "name", label: "Name", type: "text", w: 250, trunc: true, td: (r) => `<span class="text-black/70">${escapeHtml(r.name || "—")}</span>` },
    { key: "status", label: "Status", type: "multi", w: 150, td: (r) => statusBadge(r) },
    { key: "value", label: "Value", type: "num", w: 110, align: "right", td: (r) => `<span class="tabular-nums ${r.type === "estimate" ? "text-black/55" : "font-semibold text-ink-900"}">${money(r.value)}</span>` },
    { key: "open_ar", label: "Open AR", type: "num", w: 100, align: "right", td: (r) => r.open_ar > 0 ? `<span class="tabular-nums font-semibold text-amber-700">${money(r.open_ar)}</span>` : `<span class="text-black/25">—</span>` },
    { key: "last_activity", label: "Last activity", type: "date", w: 110, td: (r) => `<span class="text-xs text-black/50 tabular-nums">${ymd(r.last_activity)}</span>` },
  ];
  const dispVal = (r, key) => key === "type" ? r.type : key === "status" ? (r.status || "—") : (r[key] || "");
  const multiOptions = (key) => {
    if (key === "type") return ["estimate", "job", "project"];
    const set = new Set(); entities.forEach(r => { const v = dispVal(r, key); if (v) set.add(v); });
    return [...set].sort();
  };

  // ---- filter portal (fixed, escapes scroll clipping) ----
  const closePortals = () => document.getElementById("filterPortal")?.remove();
  function openFilterPortal(key, anchor) {
    closePortals();
    const col = COLS.find(c => c.key === key); if (!col) return;
    const footer = `<div class="mt-2.5 flex justify-end gap-1.5"><button type="button" data-fclear class="rounded-lg border border-black/10 px-2.5 py-1 text-xs font-semibold hover:bg-black/5">Clear</button><button type="button" data-fdone class="btn-primary text-xs px-2.5 py-1">Done</button></div>`;
    let content = "";
    if (col.type === "text") content = `<div class="text-[10px] font-bold text-black/40 mb-1.5">Filter ${escapeHtml(col.label)}</div><input type="text" data-finput class="input text-xs py-1 w-full" value="${escapeHtml(filters[key] || "")}" placeholder="Type to filter…">${footer}`;
    else if (col.type === "multi") { const sel = filters[key] || []; content = `<div class="text-[10px] font-bold text-black/40 mb-1.5">Filter ${escapeHtml(col.label)}</div><div class="flex flex-col gap-0 max-h-[220px] overflow-auto">${multiOptions(key).map(v => `<label class="flex items-center gap-2 px-1.5 py-1 rounded-lg hover:bg-black/[0.04] cursor-pointer text-xs"><input type="checkbox" data-fcheck value="${escapeHtml(v)}" ${sel.includes(v) ? "checked" : ""} class="h-3.5 w-3.5 rounded border-black/25"><span class="truncate">${escapeHtml(v)}</span></label>`).join("") || `<div class="text-xs text-black/40 px-1.5 py-1">No values</div>`}</div>${footer}`; }
    else if (col.type === "num") { const f = filters[key] || { min: "", max: "" }; content = `<div class="text-[10px] font-bold text-black/40 mb-1.5">Filter range</div><div class="flex flex-col gap-2"><input type="number" data-frange="min" class="input text-xs py-1" value="${escapeHtml(f.min || "")}" placeholder="Min"><input type="number" data-frange="max" class="input text-xs py-1" value="${escapeHtml(f.max || "")}" placeholder="Max"></div>${footer}`; }
    else if (col.type === "date") { const f = filters[key] || { from: "", to: "" }; content = `<div class="text-[10px] font-bold text-black/40 mb-1.5">Filter ${escapeHtml(col.label)}</div><div class="flex flex-col gap-2"><div><div class="text-[10px] text-black/40 mb-0.5">From</div><input type="date" data-fdate="from" class="input text-xs py-1" value="${escapeHtml(f.from || "")}"></div><div><div class="text-[10px] text-black/40 mb-0.5">To</div><input type="date" data-fdate="to" class="input text-xs py-1" value="${escapeHtml(f.to || "")}"></div></div>${footer}`; }
    const rect = anchor.getBoundingClientRect(), w = 240;
    let left = rect.left; if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    const portal = document.createElement("div");
    portal.id = "filterPortal"; portal.className = "fixed z-[200] rounded-xl border border-black/10 bg-white p-3 shadow-xl text-ink-900";
    portal.style.cssText = `top:${rect.bottom + 4}px; left:${left}px; width:${w}px;`;
    portal.innerHTML = content;
    document.body.appendChild(portal);
    portal.querySelector("[data-finput]")?.addEventListener("input", (e) => { filters[key] = e.target.value; renderRows(); });
    portal.querySelectorAll("[data-fcheck]").forEach(cb => cb.addEventListener("change", () => { const arr = filters[key] || []; filters[key] = cb.checked ? [...arr, cb.value] : arr.filter(v => v !== cb.value); renderRows(); }));
    portal.querySelectorAll("[data-frange]").forEach(i => i.addEventListener("input", () => { filters[key] = filters[key] || { min: "", max: "" }; filters[key][i.dataset.frange] = i.value; renderRows(); }));
    portal.querySelectorAll("[data-fdate]").forEach(i => i.addEventListener("change", () => { filters[key] = filters[key] || { from: "", to: "" }; filters[key][i.dataset.fdate] = i.value; renderRows(); }));
    portal.querySelector("[data-fclear]")?.addEventListener("click", () => { delete filters[key]; closePortals(); renderAll(); });
    portal.querySelector("[data-fdone]")?.addEventListener("click", () => { closePortals(); renderHeader(); });
    portal.querySelector("input")?.focus();
  }

  const filterActive = (key) => { const f = filters[key]; if (f == null) return false; if (Array.isArray(f)) return f.length > 0; if (typeof f === "object") return !!(f.from || f.to || f.min || f.max); return !!f; };
  const passFilters = (r) => {
    for (const c of COLS) {
      const f = filters[c.key]; if (f == null) continue;
      if (c.type === "text") { if (f && !String(r[c.key] || "").toLowerCase().includes(f.toLowerCase())) return false; }
      else if (c.type === "multi") { if (f.length && !f.includes(dispVal(r, c.key))) return false; }
      else if (c.type === "num") { const v = +r[c.key] || 0; if (f.min !== "" && f.min != null && v < +f.min) return false; if (f.max !== "" && f.max != null && v > +f.max) return false; }
      else if (c.type === "date") { const v = (r[c.key] || "").slice(0, 10); if (f.from && (!v || v < f.from)) return false; if (f.to && (!v || v > f.to)) return false; }
    }
    return true;
  };
  const visible = () => {
    let out = entities.slice();
    const q = search.trim().toLowerCase();
    if (q) out = out.filter(r => (`${r.customer_name || ""} ${r.name || ""} ${r.status || ""}`).toLowerCase().includes(q));
    out = out.filter(passFilters);
    if (sortKey) out.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (sortKey === "value" || sortKey === "open_ar") return ((+av || 0) - (+bv || 0)) * sortDir;
      av = (av ?? "").toString().toLowerCase(); bv = (bv ?? "").toString().toLowerCase();
      return av < bv ? -sortDir : av > bv ? sortDir : 0;
    });
    return out;
  };

  const sortMark = (k) => sortKey === k ? (sortDir === 1 ? " ▲" : " ▼") : "";
  const colgroupHTML = () => `<colgroup>${groupBy ? `<col style="width:34px">` : ""}${COLS.map(c => `<col style="width:${c.w}px">`).join("")}</colgroup>`;
  const renderHeader = () => {
    const head = document.getElementById("custHead"); if (!head) return;
    head.innerHTML = `<tr class="bg-white border-b border-black/10 text-black/60">
      ${groupBy ? `<th class="px-2 py-2.5"></th>` : ""}
      ${COLS.map(c => `<th class="px-3 py-2.5 align-middle ${c.align === "right" ? "text-right" : "text-left"}"><div class="inline-flex items-center gap-1 max-w-full">
        <button type="button" data-sort="${c.key}" class="font-bold text-xs uppercase tracking-wide truncate hover:text-black/80">${escapeHtml(c.label)}${sortMark(c.key)}</button>
        <button type="button" data-filter="${c.key}" class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg hover:bg-black/5 ${filterActive(c.key) ? "bg-black/5" : ""}">${FUNNEL(filterActive(c.key))}</button></div></th>`).join("")}</tr>`;
    head.querySelectorAll("[data-sort]").forEach(b => b.addEventListener("click", () => {
      const k = b.dataset.sort;
      if (sortKey !== k) { sortKey = k; sortDir = 1; } else if (sortDir === 1) sortDir = -1; else { sortKey = null; sortDir = 1; }
      saveUi();
      renderAll();
    }));
    head.querySelectorAll("[data-filter]").forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); openFilterPortal(b.dataset.filter, b); }));
  };

  const cell = (r, c) => `<td class="px-3 py-2 ${c.trunc ? "truncate" : "whitespace-nowrap"} ${c.align === "right" ? "text-right" : ""}" ${c.trunc ? `title="${escapeHtml(r[c.key] || "")}"` : ""}>${c.td(r)}</td>`;
  const COLSPAN = COLS.length + (groupBy ? 1 : 0);

  const renderRows = () => {
    const list = visible();
    const tbody = document.getElementById("custRows");
    if (!tbody) return;
    if (!groupBy) {
      tbody.innerHTML = list.map(r => `<tr class="border-b border-black/5 hover:bg-blue-50/60 cursor-pointer" data-entity="${escapeHtml(r.type)}|${escapeHtml(String(r.entity_id))}">${COLS.map(c => cell(r, c)).join("")}</tr>`).join("")
        || `<tr><td colspan="${COLSPAN}" class="py-8 text-center text-black/40">No matches.</td></tr>`;
    } else {
      // group visible entities by customer; order customers by invoiced desc
      const byCust = new Map();
      list.forEach(r => { if (!byCust.has(r.customer_qbo_id)) byCust.set(r.customer_qbo_id, []); byCust.get(r.customer_qbo_id).push(r); });
      const order = [...byCust.keys()].sort((a, b) => (custById[b]?.invoiced || 0) - (custById[a]?.invoiced || 0));
      tbody.innerHTML = order.map(cid => {
        const c = custById[cid] || { name: "(unknown)", invoiced: 0, open_ar: 0, pipeline_value: 0 };
        const kids = byCust.get(cid);
        const open = expanded.has(cid);
        const chips = `<span class="text-[10px] text-black/45">${c.project_count || 0} proj · ${c.job_count || 0} job · ${c.estimate_count || 0} est</span>`;
        const header = `<tr class="border-b border-black/10 bg-black/[0.025] cursor-pointer" data-cust="${escapeHtml(String(cid))}">
          <td class="px-2 py-2 text-center"><span class="inline-flex text-black/40 ${open ? "rotate-90" : ""}" style="transition:transform .12s">${CHEV}</span></td>
          <td class="px-3 py-2 font-extrabold text-ink-900 truncate" colspan="3">${escapeHtml(c.name)} <span class="ml-1">${chips}</span></td>
          <td class="px-3 py-2 text-right text-[11px] text-black/50">${c.pipeline_value > 0 ? money(c.pipeline_value) + " pipeline" : ""}</td>
          <td class="px-3 py-2 text-right font-bold text-ink-900 tabular-nums">${money(c.invoiced)}</td>
          <td class="px-3 py-2 text-right tabular-nums ${c.open_ar > 0 ? "font-semibold text-amber-700" : "text-black/25"}">${c.open_ar > 0 ? money(c.open_ar) : "—"}</td>
          <td class="px-3 py-2"></td></tr>`;
        const rows = open ? kids.map(r => `<tr class="border-b border-black/5 hover:bg-blue-50/60 cursor-pointer" data-entity="${escapeHtml(r.type)}|${escapeHtml(String(r.entity_id))}"><td class="px-2"></td>${COLS.map(c2 => c2.key === "customer_name" ? `<td></td>` : cell(r, c2)).join("")}</tr>`).join("") : "";
        return header + rows;
      }).join("") || `<tr><td colspan="${COLSPAN}" class="py-8 text-center text-black/40">No matches.</td></tr>`;
      tbody.querySelectorAll("[data-cust]").forEach(tr => tr.addEventListener("click", () => {
        const id = tr.dataset.cust; expanded.has(id) ? expanded.delete(id) : expanded.add(id); renderRows();
      }));
    }
    const cnt = document.getElementById("custCount");
    if (cnt) cnt.textContent = `${list.length} item${list.length === 1 ? "" : "s"}${groupBy ? ` · ${new Set(list.map(r => r.customer_qbo_id)).size} customers` : ""}`;
  };
  const renderAll = () => { renderHeader(); renderRows(); };

  mount(`
    <div class="w-full">
      <div class="card flex flex-col overflow-hidden" style="height: calc(100vh - 130px); min-height: 420px;">
        <div class="shrink-0 px-4 sm:px-5 pt-4 pb-3 border-b border-black/10">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <div class="text-base font-extrabold text-ink-900">Customers</div>
              <div class="text-xs text-black/50">Every estimate, job &amp; project by customer. Sort &amp; filter columns · search · toggle grouping.</div>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
              <input id="custSearch" class="input text-xs py-1.5 w-full sm:w-56" placeholder="Search customer, name, status…" value="${escapeHtml(search)}" />
              <label class="flex items-center gap-1.5 text-xs text-black/60 whitespace-nowrap"><input type="checkbox" id="groupBy" class="h-4 w-4 rounded border-black/25" ${groupBy ? "checked" : ""}> Group by customer</label>
              <button id="clearFilters" type="button" class="rounded-xl border border-black/10 bg-gray-100 px-3 py-1.5 text-xs font-semibold hover:bg-black/5 whitespace-nowrap">Clear filters</button>
            </div>
          </div>
          <div id="custCount" class="text-xs font-semibold text-black/50 mt-1.5"></div>
        </div>
        <div id="custScroll" class="flex-1 overflow-auto">
          <table class="text-xs w-full table-fixed" id="custTable" style="min-width:1000px;">
            ${colgroupHTML()}
            <thead id="custHead" class="text-left sticky top-0 z-20 bg-white"></thead>
            <tbody id="custRows"></tbody>
          </table>
        </div>
      </div>
    </div>`, routeFn);

  // colgroup must be re-stamped when groupBy toggles (column count changes)
  const restampColgroup = () => { const t = document.getElementById("custTable"); if (t) { const cg = t.querySelector("colgroup"); if (cg) cg.outerHTML = colgroupHTML(); } };

  document.getElementById("custSearch").addEventListener("input", (e) => { search = e.target.value; saveUi(); renderRows(); });
  document.getElementById("groupBy").addEventListener("change", (e) => { groupBy = e.target.checked; saveUi(); restampColgroup(); renderAll(); });
  document.getElementById("clearFilters").addEventListener("click", () => { for (const k of Object.keys(filters)) delete filters[k]; closePortals(); renderAll(); });
  document.getElementById("custRows").addEventListener("click", (e) => {
    const tr = e.target.closest("[data-entity]");
    if (!tr) return;
    const [type, id] = tr.dataset.entity.split("|");
    if (type && id) location.hash = `#/entity/${type}/${encodeURIComponent(id)}`;
  });
  const scrollEl = document.getElementById("custScroll");
  scrollEl.addEventListener("scroll", (e) => { custUi.scrollTop = e.target.scrollTop; closePortals(); });
  document.addEventListener("click", (e) => { if (document.getElementById("filterPortal") && !e.target.closest("#filterPortal") && !e.target.closest("[data-filter]")) closePortals(); });

  renderAll();
  // restore scroll position after rows are in the DOM (returning from a detail page)
  if (custUi.scrollTop) scrollEl.scrollTop = custUi.scrollTop;
}

function mount(bodyHtml, routeFn) {
  setShell({ title: "", subtitle: "", bodyHtml, showLogout: true, routeFn });
  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => { if (pageTitleBlock) pageTitleBlock.style.display = ""; }, { once: true });
  }
}
