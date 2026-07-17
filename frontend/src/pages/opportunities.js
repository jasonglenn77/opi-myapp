// Pipeline (Opportunities) — the RFQ front-door + pre-award pipeline analytics.
// Intake starts a tracked opportunity (customer + contact + RFQ date + target start);
// stage timestamps power the turn-time / win-rate metrics. QBO still mints the quote
// number + PDF, so those are captured later on the opportunity, not here.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import { customerCombobox, contactFormModal } from "./contacts.js";

const SOURCES = ["Email", "Referral", "Repeat customer", "Website", "Phone", "Other"];
const STATUS_META = {
  received:  { label: "Received",  cls: "bg-slate-100 text-slate-700" },
  quoting:   { label: "Quoting",   cls: "bg-amber-100 text-amber-800" },
  sent:      { label: "Sent",      cls: "bg-blue-100 text-blue-800" },
  won:       { label: "Won",       cls: "bg-emerald-100 text-emerald-800" },
  lost:      { label: "Lost",      cls: "bg-rose-100 text-rose-700" },
  declined:  { label: "Declined",  cls: "bg-black/10 text-black/50" },
};
const ymd = (s) => (s ? String(s).slice(0, 10) : "—");
const dash = (s) => (s == null || s === "" ? "—" : s);
const humanRole = (r) => (r || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const days = (n) => (n == null ? "—" : `${n}d`);
const pct = (n) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString());

// Colour the granular pipeline stage by its leading win-probability. Falls back
// to the lifecycle status label when no stage was captured (app-native RFQs).
function stageChip(o) {
  const ps = o.pipeline_status;
  if (!ps) {
    const m = STATUS_META[o.status] || { label: o.status, cls: "bg-black/10" };
    return `<span class="text-[10px] font-semibold rounded px-1.5 py-0.5 ${m.cls}">${m.label}</span>`;
  }
  const m = /^(\d+)%/.exec(ps);
  const p = m ? Number(m[1]) : null;
  const cls = p == null ? "bg-slate-100 text-slate-700"
    : p >= 100 ? "bg-emerald-100 text-emerald-800"
    : p >= 60 ? "bg-blue-100 text-blue-800"
    : p >= 40 ? "bg-indigo-100 text-indigo-800"
    : p >= 20 ? "bg-amber-100 text-amber-800"
    : "bg-black/10 text-black/50";
  const short = ps.replace(/\s*>.*$/, "").replace(/,.*$/, "");
  return `<span class="text-[10px] font-semibold rounded px-1.5 py-0.5 ${cls}" title="${escapeHtml(ps)}">${escapeHtml(short)}</span>`;
}

export async function pipelinePage(routeFn) {
  let estimators = [], commTypes = [], pipelineStatuses = [];
  try { estimators = await api(`/estimates/estimators`); } catch (_) { estimators = []; }
  try {
    const lv = await api(`/quoting/lookup-values`);
    commTypes = lv.communication_type || [];
    pipelineStatuses = (lv.estimate_pipeline_status || []).map(o => o.key);
  } catch (_) {}

  const body = `
    <div class="w-full">
      <div class="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div><h1 class="text-xl font-extrabold text-ink-900">Pipeline</h1>
          <p class="text-xs text-black/50">RFQ → quote → sent → won/lost. Historical rows carry their Rolling-Revenue summary + a link to the QuickBooks estimate; the detailed quoting-metrics <b>workbook lives in Google Drive</b> (the “Metrics ↗” link). New quotes are built in-app via <b>Start quote</b> and feed the row live.</p></div>
        <button id="pNew" class="btn-primary text-sm px-4 py-2">+ New opportunity</button>
      </div>
      <div id="pMetrics" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-3"></div>
      <div class="card p-3 sm:p-4 flex flex-col overflow-hidden" style="height: calc(100vh - 235px); min-height: 420px;">
        <div class="flex items-center gap-2 mb-3 flex-wrap shrink-0" id="pFilters"></div>
        <div id="pList" class="flex-1 overflow-auto text-sm text-black/40">Loading…</div>
        <div id="pPager" class="shrink-0"></div>
      </div>
    </div>`;
  setShell({ title: "", subtitle: "", bodyHtml: body, showLogout: true, routeFn });

  // Client-side model: fetch all rows once, then filter/sort/paginate in JS
  // (same pattern as the Contacts/Assignment tables). ~3k rows is fine in memory
  // and makes sorting + column filtering instant.
  let allRows = [];
  let statusFilter = "open";   // lifecycle bucket; historical rows default hidden
  let stageFilter = "";        // granular win-probability stage (pipeline_status)
  let searchQ = "";
  let unlinkedOnly = false;    // rows whose customer didn't resolve to a QBO customer
  let sortKey = "rfq_received_date";
  let sortDir = "desc";
  let page = 0;
  const PAGE = 100;
  const metricsEl = document.getElementById("pMetrics");
  const listEl = document.getElementById("pList");
  const pagerEl = document.getElementById("pPager");
  const filtersEl = document.getElementById("pFilters");

  const chip = (label, val, sub = "") =>
    `<div class="rounded-xl border border-black/5 bg-white shadow-sm px-3 py-2">
       <div class="text-[10px] font-bold uppercase tracking-wide text-black/35">${label}</div>
       <div class="text-lg font-extrabold text-ink-900">${val}</div>${sub ? `<div class="text-[10px] text-black/40">${sub}</div>` : ""}</div>`;

  const loadMetrics = async () => {
    try {
      const m = await api(`/opportunities/metrics?days=365`);
      metricsEl.innerHTML =
        chip("Opportunities", m.total, "last 12 mo") +
        chip("Open", m.open, "in progress") +
        chip("Win rate", pct(m.win_rate), "of decided") +
        chip("RFQ→quote", days(m.avg_days_received_to_quoting), "avg start") +
        chip("Quote→sent", days(m.avg_days_received_to_sent), "avg prep") +
        chip("Sent→decision", days(m.avg_days_sent_to_decided), "sales cycle");
    } catch (_) { metricsEl.innerHTML = ""; }
  };

  const quoteCell = (o) => {
    if (o.app_estimate_id)
      return `<a href="#/estimate/${o.app_estimate_id}" class="font-semibold text-blue-700 hover:underline whitespace-nowrap" title="In-app quoting-metrics estimate">Open quote →</a>`;
    if (o.qbo_estimate_id)
      return `<a href="#/entity/estimate/${escapeHtml(o.qbo_estimate_id)}" class="font-semibold text-indigo-700 hover:underline whitespace-nowrap" title="Open the QuickBooks estimate (the sent quote)">QBO estimate →</a>`;
    if (!o.customer_qbo_id)
      return `<span class="text-black/25" title="Link a QuickBooks customer first">—</span>`;
    return `<button data-startq="${o.id}" class="font-semibold text-emerald-700 hover:underline whitespace-nowrap">Start quote</button>`;
  };

  // Stage cell: the editable win-probability status (OPI's 20/80% system) drives
  // the row; the lifecycle stage (received/quoting/sent/won/lost) is derived and
  // shown as a small badge below.
  const stageCell = (o) => {
    const p = /^(\d+)%/.exec(o.pipeline_status || "");
    const pn = p ? Number(p[1]) : null;
    const selCls = pn == null ? "bg-slate-100 text-slate-700"
      : pn >= 100 ? "bg-emerald-100 text-emerald-800" : pn >= 60 ? "bg-blue-100 text-blue-800"
      : pn >= 40 ? "bg-indigo-100 text-indigo-800" : pn >= 20 ? "bg-amber-100 text-amber-800"
      : "bg-black/10 text-black/50";
    const opts = `<option value=""></option>` + pipelineStatuses.map(s =>
      `<option value="${escapeHtml(s)}" ${s === o.pipeline_status ? "selected" : ""}>${escapeHtml(s.replace(/\s*>.*$/, ""))}</option>`).join("");
    const m = STATUS_META[o.status] || { label: o.status, cls: "bg-black/10" };
    return `<select data-pstatus="${o.id}" title="Win-probability status" class="text-[10px] font-semibold rounded px-1 py-0.5 border-0 max-w-[8.5rem] ${selCls} cursor-pointer">${opts}</select>
      <div class="mt-0.5"><span class="text-[9px] font-bold uppercase tracking-wide rounded px-1 py-0.5 ${m.cls}" title="Lifecycle stage (derived)">${m.label}</span></div>`;
  };

  const num = (v) => (v == null || v === "" ? "—" : Number(v).toLocaleString());
  const commLabel = (k) => (commTypes.find(c => c.key === k)?.value_text) || k || "";
  // Value cell: contract value + a discounted sub-line, + an "app" badge when the
  // figures came live from the in-app quoting-metrics estimate (vs seeded RR).
  const valueCell = (o) => {
    const app = o.metrics_source === "app"
      ? ` <span class="align-middle text-[8px] font-bold uppercase rounded px-1 bg-blue-100 text-blue-700" title="Figures from the in-app quoting-metrics estimate">app</span>` : "";
    // "Discounted Contract Value" in RR is actually the probability-WEIGHTED value
    // (contract × win-probability) — expected pipeline revenue, not a sale discount.
    const wtd = (o.discounted_contract_value != null && o.discounted_contract_value !== o.contract_value)
      ? `<div class="text-[10px] text-black/45" title="Weighted value = contract × win probability (expected pipeline revenue)">${money(o.discounted_contract_value)} wtd</div>` : "";
    return `${money(o.contract_value)}${app}${wtd}`;
  };
  // The RR "Link" column: an external Google-Drive link to the detailed
  // quoting-metrics workbook (we don't import it). Click to open or set/change.
  const linkCell = (o) => o.workbook_url
    ? `<a href="${escapeHtml(o.workbook_url)}" target="_blank" rel="noopener" class="text-indigo-700 font-semibold hover:underline" title="Open the quoting-metrics workbook in Google Drive">Metrics ↗</a>
       <button data-editlink="${o.id}" class="text-[10px] text-black/30 hover:text-black/60 ml-1" title="Edit link">✎</button>`
    : `<button data-editlink="${o.id}" class="text-[11px] text-black/35 hover:text-indigo-700 hover:underline" title="Paste the Google-Drive workbook link">+ link</button>`;
  const followupCell = (o) => {
    if (o.last_contact_date || o.follow_up_count)
      return `<button data-log="${o.id}" class="text-left group">
        <div class="tabular-nums text-black/70 group-hover:underline">${ymd(o.last_contact_date)}</div>
        <div class="text-[10px] text-black/40">${o.follow_up_count || 0}× ${escapeHtml(o.last_comm_type || "")}</div>
      </button>`;
    return `<button data-log="${o.id}" class="text-[11px] text-blue-600 font-semibold hover:underline">+ log</button>`;
  };
  // Columns mirror the "2. Rolling Revenue" sheet. Each is sortable unless nosort.
  const COLS = [
    { key: "stage", label: "Stage", td: (o) => stageCell(o) },
    { key: "quote_number", label: "Quote #", cls: "tabular-nums font-semibold text-ink-900", td: (o) => escapeHtml(dash(o.quote_number)) },
    { key: "customer_name", label: "Customer", td: (o) => `<span class="font-semibold text-ink-900">${escapeHtml(dash(o.customer_name))}</span>${!o.customer_qbo_id && o.customer_name ? ` <button data-linkcust="${o.id}" class="align-middle text-[9px] font-bold uppercase tracking-wide rounded px-1 py-0.5 bg-amber-100 text-amber-700 hover:bg-amber-200" title="Click to link this to a QuickBooks customer">unlinked</button>` : ""}${o.contact_name ? `<div class="text-[10px] text-black/40">${escapeHtml(o.contact_name)}</div>` : ""}` },
    { key: "title", label: "Job", cls: "text-black/70 max-w-[16rem] truncate", td: (o) => `${escapeHtml(dash(o.title))}${o.project_name ? `<div class="text-[10px] text-emerald-700">→ <a href="#/entity/project/${escapeHtml(o.project_qbo_id)}" class="hover:underline font-semibold">${escapeHtml(o.project_name)}</a></div>` : ""}` },
    { key: "quoted_by", label: "By", cls: "text-black/60", td: (o) => escapeHtml(dash(o.quoted_by || o.estimator_name)) },
    { key: "labor_days", label: "Labor", align: "right", cls: "tabular-nums text-black/60", td: (o) => num(o.labor_days) },
    { key: "travel_days", label: "Travel", align: "right", cls: "tabular-nums text-black/60", td: (o) => num(o.travel_days) },
    { key: "ohp_pct", label: "OH&P %", align: "right", cls: "tabular-nums text-black/60", td: (o) => o.ohp_pct == null ? "—" : Math.round(o.ohp_pct) + "%" },
    { key: "contract_value", label: "Value", align: "right", cls: "tabular-nums text-black/70", td: (o) => valueCell(o) },
    { key: "rfq_received_date", label: "RFQ", cls: "tabular-nums text-black/60", td: (o) => ymd(o.rfq_received_date) },
    { key: "target_start_date", label: "Start", cls: "tabular-nums text-black/60", td: (o) => ymd(o.target_start_date) },
    { key: "target_end_date", label: "End", cls: "tabular-nums text-black/60", td: (o) => ymd(o.target_end_date) },
    { key: "last_contact_date", label: "Follow-up", cls: "whitespace-nowrap", td: (o) => followupCell(o) },
    { key: "quote", label: "Quote", nosort: true, td: (o) => quoteCell(o) },
    { key: "workbook_url", label: "Metrics", nosort: true, cls: "whitespace-nowrap", td: (o) => linkCell(o) },
    { key: "doc_count", label: "Docs", align: "center", td: (o) => `<button data-docs="${o.id}" class="inline-flex items-center gap-0.5 font-semibold ${o.doc_count ? "text-blue-700" : "text-black/40"} hover:underline" title="Attachments (RFQ, drawings, quote, PO)">📎${o.doc_count || 0}</button>` },
  ];

  const NUMERIC = new Set(["labor_days", "travel_days", "ohp_pct", "ohp_amount", "contract_value", "order_value", "total_revisions"]);
  const sortVal = (o, key) => {
    if (key === "stage") return (o.pipeline_status || o.status || "").toLowerCase();
    if (NUMERIC.has(key)) { const n = Number(o[key]); return Number.isFinite(n) ? n : -Infinity; }
    return (o[key] ?? "").toString().toLowerCase();
  };
  const OPEN = new Set(["received", "quoting", "sent"]);
  const visible = () => {
    const q = searchQ.toLowerCase();
    let out = allRows.filter(o => {
      if (statusFilter === "open") { if (!OPEN.has(o.status)) return false; }
      else if (statusFilter && o.status !== statusFilter) return false;
      if (stageFilter && o.pipeline_status !== stageFilter) return false;
      if (unlinkedOnly && o.customer_qbo_id) return false;
      if (q && !(`${o.customer_name || ""} ${o.title || ""} ${o.quote_number || ""} ${o.contact_name || ""} ${o.quoted_by || ""}`).toLowerCase().includes(q)) return false;
      return true;
    });
    out.sort((a, b) => { const av = sortVal(a, sortKey), bv = sortVal(b, sortKey); return (av < bv ? -1 : av > bv ? 1 : 0) * (sortDir === "asc" ? 1 : -1); });
    return out;
  };

  const arrow = (k) => sortKey !== k ? "" : (sortDir === "asc" ? " ▲" : " ▼");
  const onHeaderClick = (k) => {
    if (sortKey !== k) { sortKey = k; sortDir = "asc"; }
    else if (sortDir === "asc") sortDir = "desc";
    else { sortKey = "rfq_received_date"; sortDir = "desc"; }   // 3rd click resets
    page = 0; render();
  };

  const renderFilters = () => {
    const stages = [...new Set(allRows.map(o => o.pipeline_status).filter(Boolean))].sort();
    const pills = [["open", "Open"], ...Object.entries(STATUS_META).map(([k, v]) => [k, v.label]), ["", "All"]];
    filtersEl.innerHTML =
      pills.map(([k, label]) =>
        `<button data-sf="${k}" class="rounded-full px-2.5 py-1 text-xs font-semibold border ${statusFilter === k ? "bg-ink-900 text-white border-ink-900" : "border-black/15 text-black/60 hover:bg-black/5"}">${label}</button>`).join("") +
      `<select data-stage class="input text-xs py-1 px-2 max-w-[16rem]"><option value="">All stages</option>${stages.map(s => `<option value="${escapeHtml(s)}" ${stageFilter === s ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}</select>` +
      `<button data-unlinked class="rounded-full px-2.5 py-1 text-xs font-semibold border ${unlinkedOnly ? "bg-amber-500 text-white border-amber-500" : "border-amber-300 text-amber-700 hover:bg-amber-50"}" title="Rows with no matching QuickBooks customer">⚠ Unlinked</button>` +
      `<input data-search value="${escapeHtml(searchQ)}" placeholder="Search…" class="input text-xs py-1 px-2 ml-auto w-52">` +
      `<span data-count class="text-xs text-black/40 whitespace-nowrap"></span>`;
    filtersEl.querySelectorAll("[data-sf]").forEach(b => b.addEventListener("click", () => {
      const k = b.getAttribute("data-sf");
      statusFilter = (k && k === statusFilter) ? "" : k;  // click the active pill → back to All
      page = 0; renderFilters(); render();
    }));
    filtersEl.querySelector("[data-stage]").addEventListener("change", (e) => { stageFilter = e.target.value; page = 0; render(); });
    filtersEl.querySelector("[data-unlinked]").addEventListener("click", () => { unlinkedOnly = !unlinkedOnly; page = 0; renderFilters(); render(); });
    const sb = filtersEl.querySelector("[data-search]");
    let t = null;
    sb.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { searchQ = sb.value.trim(); page = 0; render(); }, 200); });
    if (document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-search") != null) sb.focus();
  };

  const render = () => {
    const rows = visible();
    const total = rows.length;
    const countEl = filtersEl.querySelector("[data-count]");
    if (countEl) countEl.textContent = `${total.toLocaleString()} of ${allRows.length.toLocaleString()}`;
    if (!total) { listEl.innerHTML = `<div class="text-black/45 py-4 text-sm">No opportunities match. ${searchQ || stageFilter || unlinkedOnly ? "Adjust the filters." : "Click “New opportunity” to log an RFQ."}</div>`; pagerEl.innerHTML = ""; return; }
    const pages = Math.ceil(total / PAGE);
    if (page >= pages) page = pages - 1;
    const slice = rows.slice(page * PAGE, page * PAGE + PAGE);
    const from = page * PAGE + 1, to = page * PAGE + slice.length;
    // Table fills the card; header sticks, body scrolls vertically, min-width
    // drives the horizontal scrollbar (mirrors the Customers table).
    listEl.innerHTML = `
      <table class="w-full text-xs" style="min-width:1180px;">
        <thead class="sticky top-0 z-10 bg-white text-left text-black/45"><tr class="border-b border-black/10">
          ${COLS.map(c => `<th class="py-2 pr-3 font-bold whitespace-nowrap bg-white ${c.align === "right" ? "text-right" : ""} ${c.nosort ? "" : "cursor-pointer select-none hover:text-black/70"}" ${c.nosort ? "" : `data-sort="${c.key}"`}>${c.label}${c.nosort ? "" : arrow(c.key)}</th>`).join("")}
          <th class="py-2 font-bold text-right bg-white"></th></tr></thead>
        <tbody>${slice.map(o => `
          <tr class="border-b border-black/5 hover:bg-black/[0.02] align-top">
            ${COLS.map(c => `<td class="py-1.5 pr-3 ${c.align === "right" ? "text-right" : ""} ${c.cls || ""}">${c.td(o)}</td>`).join("")}
            <td class="py-1.5 text-right"><button data-del="${o.id}" title="Delete" class="text-red-600 font-semibold hover:underline">Delete</button></td>
          </tr>`).join("")}
        </tbody></table>`;
    pagerEl.innerHTML = total > PAGE ? `
      <div class="flex items-center justify-between pt-2 mt-1 border-t border-black/5 text-xs text-black/50">
        <span>Showing <b>${from.toLocaleString()}–${to.toLocaleString()}</b> of <b>${total.toLocaleString()}</b></span>
        <div class="flex gap-2 items-center">
          <button data-pg="prev" class="rounded-lg border border-black/15 px-2.5 py-1 font-semibold ${page <= 0 ? "opacity-40 pointer-events-none" : "hover:bg-black/5"}">← Prev</button>
          <span class="px-1 py-1">Page ${page + 1} / ${pages}</span>
          <button data-pg="next" class="rounded-lg border border-black/15 px-2.5 py-1 font-semibold ${page >= pages - 1 ? "opacity-40 pointer-events-none" : "hover:bg-black/5"}">Next →</button>
        </div></div>` : `<div class="pt-2 mt-1 border-t border-black/5 text-[11px] text-black/40">${total.toLocaleString()} rows</div>`;
    listEl.querySelectorAll("[data-sort]").forEach(th => th.addEventListener("click", () => onHeaderClick(th.getAttribute("data-sort"))));
    pagerEl.querySelectorAll("[data-pg]").forEach(b => b.addEventListener("click", () => {
      page = b.getAttribute("data-pg") === "next" ? page + 1 : Math.max(0, page - 1);
      render(); listEl.scrollTop = 0;
    }));
    listEl.querySelectorAll("[data-pstatus]").forEach(sel => sel.addEventListener("change", async () => {
      const id = sel.getAttribute("data-pstatus");
      const opp = allRows.find(o => String(o.id) === id);
      const pv = sel.value || null;
      // "Won"/"Red Flag" → the won handoff (link the QBO project)
      if (pv && (/won/i.test(pv) || /red flag/i.test(pv))) {
        try { await api(`/opportunities/${id}`, { method: "PATCH", body: JSON.stringify({ pipeline_status: pv }) }); if (opp) { opp.pipeline_status = pv; opp.status = "won"; } } catch (err) { alert(err.message); return; }
        openLinkProjectModal(opp, () => { loadMetrics(); load(); }, () => { loadMetrics(); render(); });
        return;
      }
      try {
        const r = await api(`/opportunities/${id}`, { method: "PATCH", body: JSON.stringify({ pipeline_status: pv }) });
        if (opp && r.opportunity) { opp.pipeline_status = r.opportunity.pipeline_status; opp.status = r.opportunity.status; }
        loadMetrics(); render();
      } catch (err) { alert(err.message); }
    }));
    listEl.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this opportunity?")) return;
      const id = b.getAttribute("data-del");
      try { await api(`/opportunities/${id}`, { method: "DELETE" }); allRows = allRows.filter(o => String(o.id) !== id); loadMetrics(); render(); }
      catch (err) { alert(err.message); }
    }));
    listEl.querySelectorAll("[data-startq]").forEach(b => b.addEventListener("click", () => {
      const opp = allRows.find(o => String(o.id) === b.getAttribute("data-startq"));
      startQuoteModal(opp, () => { loadMetrics(); load(); });
    }));
    listEl.querySelectorAll("[data-log]").forEach(b => b.addEventListener("click", () => {
      const opp = allRows.find(o => String(o.id) === b.getAttribute("data-log"));
      contactLogModal(opp, commTypes, (updated) => {
        if (updated) { const i = allRows.findIndex(o => o.id === updated.id); if (i >= 0) allRows[i] = updated; }
        render();
      });
    }));
    listEl.querySelectorAll("[data-docs]").forEach(b => b.addEventListener("click", () => {
      const opp = allRows.find(o => String(o.id) === b.getAttribute("data-docs"));
      opportunityDocsModal(opp, (count) => { if (count != null) opp.doc_count = count; render(); });
    }));
    listEl.querySelectorAll("[data-editlink]").forEach(b => b.addEventListener("click", async () => {
      const opp = allRows.find(o => String(o.id) === b.getAttribute("data-editlink"));
      const url = prompt("Google-Drive link to the quoting-metrics workbook:", opp.workbook_url || "");
      if (url === null) return;   // cancelled
      const v = url.trim() || null;
      try { await api(`/opportunities/${opp.id}`, { method: "PATCH", body: JSON.stringify({ workbook_url: v }) }); opp.workbook_url = v; render(); }
      catch (err) { alert(err.message); }
    }));
    listEl.querySelectorAll("[data-linkcust]").forEach(b => b.addEventListener("click", () => {
      const opp = allRows.find(o => String(o.id) === b.getAttribute("data-linkcust"));
      linkCustomerModal(opp, (updated) => {
        if (updated) { const i = allRows.findIndex(o => o.id === updated.id); if (i >= 0) allRows[i] = updated; }
        render();
      });
    }));
  };

  const load = async () => {
    try { const d = await api(`/opportunities?limit=5000`); allRows = d.opportunities || []; }
    catch (e) { listEl.innerHTML = `<div class="text-red-700 text-sm">Failed to load pipeline.</div>`; return; }
    renderFilters(); render();
  };

  document.getElementById("pNew").addEventListener("click", () =>
    newOpportunityModal({ estimators, onSaved: () => { loadMetrics(); load(); } }));

  loadMetrics();
  load();
}

// ── Won → link to QBO project (the handoff) ─────────────────────────────────
function openLinkProjectModal(opp, onDone, onCancel) {
  let picked = null;
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4";
  overlay.innerHTML = `
    <div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
      <div class="text-base font-bold text-ink-900 mb-1">Mark won — link to project</div>
      <div class="text-xs text-black/50 mb-3">Once the office creates the project in QuickBooks (named with the quote # prefix), link it here so the quote flows through to the project.</div>
      <div class="relative mb-1">
        <input data-psearch class="input text-sm py-1.5 w-full" placeholder="Search project…" value="${escapeHtml(opp.quote_number || opp.title || "")}" autocomplete="off">
        <div data-pmenu class="absolute z-20 mt-1 w-full bg-white border border-black/10 rounded-xl shadow-lg max-h-56 overflow-auto hidden"></div>
      </div>
      <div data-picked class="text-xs text-emerald-700 font-semibold mb-2 min-h-[1rem]"></div>
      <div class="flex items-center justify-end gap-2">
        <span data-msg class="text-xs font-semibold mr-auto"></span>
        <button data-skip class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Won, link later</button>
        <button data-cancel class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Cancel</button>
        <button data-save class="btn-primary text-sm px-4 py-1.5">Link &amp; mark won</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  const input = overlay.querySelector("[data-psearch]");
  const menu = overlay.querySelector("[data-pmenu]");
  const pickedEl = overlay.querySelector("[data-picked]");
  const setMsg = (t, ok) => { const m = overlay.querySelector("[data-msg]"); m.textContent = t; m.className = "text-xs font-semibold mr-auto " + (ok ? "text-emerald-700" : "text-red-600"); };
  let timer = null;
  const search = async (q) => {
    try {
      const list = (await api(`/opportunities/project-options?q=${encodeURIComponent(q)}&limit=40`)).projects || [];
      menu.innerHTML = list.length
        ? list.map(pj => `<div class="px-3 py-1.5 text-sm hover:bg-blue-50 cursor-pointer" data-pq="${escapeHtml(pj.qbo_id)}">${escapeHtml(pj.name)}</div>`).join("")
        : `<div class="px-3 py-1.5 text-xs text-black/40">No projects</div>`;
      menu.classList.remove("hidden");
      menu.querySelectorAll("[data-pq]").forEach(el => el.addEventListener("mousedown", (e) => {
        e.preventDefault(); picked = { qbo_id: el.getAttribute("data-pq"), name: el.textContent };
        input.value = picked.name; pickedEl.textContent = "→ " + picked.name; menu.classList.add("hidden");
      }));
    } catch (_) { /* ignore */ }
  };
  input.addEventListener("input", () => { picked = null; pickedEl.textContent = ""; clearTimeout(timer); timer = setTimeout(() => search(input.value.trim()), 180); });
  input.addEventListener("focus", () => search(input.value.trim()));
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) { close(); onCancel && onCancel(); } });
  overlay.querySelector("[data-cancel]").addEventListener("click", () => { close(); onCancel && onCancel(); });
  overlay.querySelector("[data-skip]").addEventListener("click", async () => {
    try { await api(`/opportunities/${opp.id}`, { method: "PATCH", body: JSON.stringify({ status: "won" }) }); close(); onDone && onDone(); }
    catch (err) { setMsg(err.message, false); }
  });
  overlay.querySelector("[data-save]").addEventListener("click", async () => {
    if (!picked) return setMsg("Pick a project, or use “Won, link later”.", false);
    try { await api(`/opportunities/${opp.id}`, { method: "PATCH", body: JSON.stringify({ status: "won", project_qbo_id: picked.qbo_id }) }); close(); onDone && onDone(); }
    catch (err) { let d = err?.message || "Failed"; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch (_) {} setMsg(d, false); }
  });
}

// ── Start / link a quoting-metrics estimate from an opportunity ──────────────
function startQuoteModal(opp, onDone) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4";
  overlay.innerHTML = `
    <div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
      <div class="text-base font-bold text-ink-900 mb-1">Start a quote</div>
      <div class="text-xs text-black/50 mb-4">${escapeHtml(opp.customer_name || "")}${opp.title ? " — " + escapeHtml(opp.title) : ""}</div>
      <button data-create class="w-full text-left rounded-xl border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 px-4 py-3 mb-2">
        <div class="text-sm font-bold text-emerald-800">Create a new estimate</div>
        <div class="text-xs text-emerald-700/80">Prefills customer, contact, description, dates, quote # from this RFQ.</div>
      </button>
      <div class="rounded-xl border border-black/10 px-4 py-3">
        <div class="text-sm font-bold text-ink-900 mb-1">Link an existing estimate</div>
        <select data-existing class="input text-sm py-1.5 w-full mb-2"><option value="">Loading…</option></select>
        <button data-link class="btn-primary text-xs px-3 py-1.5 disabled:opacity-40" disabled>Link selected</button>
      </div>
      <div class="mt-4 flex items-center justify-end gap-2">
        <span data-msg class="text-xs font-semibold mr-auto"></span>
        <button data-cancel class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("[data-cancel]").addEventListener("click", close);
  const setMsg = (t, ok) => { const m = overlay.querySelector("[data-msg]"); m.textContent = t; m.className = "text-xs font-semibold mr-auto " + (ok ? "text-emerald-700" : "text-red-600"); };
  const sel = overlay.querySelector("[data-existing]");
  const linkBtn = overlay.querySelector("[data-link]");

  overlay.querySelector("[data-create]").addEventListener("click", async () => {
    setMsg("Creating…", true);
    try {
      const r = await api(`/opportunities/${opp.id}/start-quote`, { method: "POST" });
      close(); onDone && onDone();
      location.hash = `#/estimate/${r.estimate_id}`;
    } catch (err) { let d = err?.message || "Failed"; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch (_) {} setMsg(d, false); }
  });

  (async () => {
    try {
      const list = (await api(`/opportunities/${opp.id}/quote-options`)).estimates || [];
      sel.innerHTML = list.length
        ? `<option value="">— pick an estimate —</option>` + list.map(e =>
            `<option value="${e.id}">#${e.id}${e.quote_number ? ` · ${escapeHtml(e.quote_number)}` : ""} — ${escapeHtml(e.quote_description || "untitled")} (${e.status})</option>`).join("")
        : `<option value="">No existing estimates for this customer</option>`;
    } catch (_) { sel.innerHTML = `<option value="">Couldn't load estimates</option>`; }
  })();
  sel.addEventListener("change", () => { linkBtn.disabled = !sel.value; });
  linkBtn.addEventListener("click", async () => {
    if (!sel.value) return;
    setMsg("Linking…", true);
    try {
      await api(`/opportunities/${opp.id}/link-quote`, { method: "POST", body: JSON.stringify({ app_estimate_id: Number(sel.value) }) });
      close(); onDone && onDone();
      location.hash = `#/estimate/${sel.value}`;
    } catch (err) { let d = err?.message || "Failed"; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch (_) {} setMsg(d, false); }
  });
}

// ── Link an unlinked opportunity to a QBO customer ───────────────────────────
function linkCustomerModal(opp, onDone) {
  let customer = null;
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4";
  overlay.innerHTML = `
    <div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
      <div class="text-base font-bold text-ink-900 mb-1">Link to a customer</div>
      <div class="text-xs text-black/50 mb-3">Rolling-Revenue name: <b>${escapeHtml(opp.customer_name || "—")}</b>. Pick the matching QuickBooks customer.</div>
      <div data-cust class="mb-3"></div>
      <div class="flex items-center justify-end gap-2">
        <span data-msg class="text-xs font-semibold mr-auto"></span>
        <button data-cancel class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Cancel</button>
        <button data-save class="btn-primary text-sm px-4 py-1.5">Link</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("[data-cancel]").addEventListener("click", close);
  const setMsg = (t, ok) => { const m = overlay.querySelector("[data-msg]"); m.textContent = t; m.className = "text-xs font-semibold mr-auto " + (ok ? "text-emerald-700" : "text-red-600"); };
  customerCombobox(overlay.querySelector("[data-cust]"), { onPick: (c) => { customer = c; } });
  overlay.querySelector("[data-save]").addEventListener("click", async () => {
    if (!customer) return setMsg("Pick a customer.", false);
    try {
      const r = await api(`/opportunities/${opp.id}/link-customer`, { method: "POST", body: JSON.stringify({ customer_qbo_id: customer.qbo_id }) });
      close(); onDone && onDone(r.opportunity);
    } catch (err) { let d = err?.message || "Failed"; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch {} setMsg(d, false); }
  });
}

// ── Contact log (follow-up workflow) modal ───────────────────────────────────
function contactLogModal(opp, commTypes, onDone) {
  const ymd2 = (s) => (s ? String(s).slice(0, 10) : "—");
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4";
  overlay.innerHTML = `
    <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg p-5 max-h-[90vh] overflow-auto">
      <div class="text-base font-bold text-ink-900 mb-0.5">Follow-up log</div>
      <div class="text-xs text-black/50 mb-3">${escapeHtml(opp.customer_name || "")}${opp.title ? " — " + escapeHtml(opp.title) : ""}</div>
      <div class="rounded-xl border border-black/10 p-3 mb-3">
        <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-2">Log a contact</div>
        <div class="grid grid-cols-2 gap-2 mb-2">
          <label class="block"><div class="text-[10px] text-black/40 mb-0.5">Date</div><input data-f="date" type="date" class="input text-sm py-1.5 w-full"></label>
          <label class="block"><div class="text-[10px] text-black/40 mb-0.5">Type</div>
            <select data-f="ct" class="input text-sm py-1.5 w-full"><option value="">—</option>${commTypes.map(c => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.key)} — ${escapeHtml(c.value_text || "")}</option>`).join("")}</select></label>
        </div>
        <input data-f="notes" class="input text-sm py-1.5 w-full mb-2" placeholder="Notes (optional)">
        <div class="flex items-center justify-end gap-2">
          <span data-msg class="text-xs font-semibold mr-auto"></span>
          <button data-add class="btn-primary text-sm px-4 py-1.5">Add entry</button>
        </div>
      </div>
      <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">History</div>
      <div data-history class="text-sm text-black/50">Loading…</div>
      <div class="mt-4 flex justify-end">
        <button data-close class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  let changed = false;
  const close = () => { overlay.remove(); };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("[data-close]").addEventListener("click", close);
  const setMsg = (t, ok) => { const m = overlay.querySelector("[data-msg]"); m.textContent = t; m.className = "text-xs font-semibold mr-auto " + (ok ? "text-emerald-700" : "text-red-600"); };
  const val = (f) => overlay.querySelector(`[data-f="${f}"]`);
  const histEl = overlay.querySelector("[data-history]");

  const loadHistory = async () => {
    try {
      const log = (await api(`/opportunities/${opp.id}/contact-log`)).log || [];
      histEl.innerHTML = log.length
        ? `<div class="divide-y divide-black/5">${log.map(e => `
            <div class="py-1.5 flex items-baseline gap-2">
              <span class="tabular-nums text-black/60 w-24 shrink-0">${ymd2(e.contact_date)}</span>
              <span class="font-semibold text-ink-900 w-10 shrink-0">${escapeHtml(e.communication_type || "—")}</span>
              <span class="text-black/60">${escapeHtml(e.notes || "")}</span>
            </div>`).join("")}</div>`
        : `<div class="text-black/40 py-2">No entries logged yet.</div>`;
    } catch (_) { histEl.innerHTML = `<div class="text-red-600 py-2">Couldn't load history.</div>`; }
  };

  overlay.querySelector("[data-add]").addEventListener("click", async () => {
    const payload = { contact_date: val("date").value || null, communication_type: val("ct").value || null, notes: val("notes").value.trim() || null };
    if (!payload.communication_type && !payload.notes) return setMsg("Pick a type or add a note.", false);
    setMsg("Saving…", true);
    try {
      const r = await api(`/opportunities/${opp.id}/contact-log`, { method: "POST", body: JSON.stringify(payload) });
      changed = true;
      Object.assign(opp, r.opportunity || {});
      onDone && onDone(r.opportunity);
      val("notes").value = ""; setMsg("Logged ✓", true);
      loadHistory();
    } catch (err) { let d = err?.message || "Failed"; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch (_) {} setMsg(d, false); }
  });

  loadHistory();
}

// ── Opportunity attachments (RFQ / drawings / quote PDF / PO) modal ──────────
function opportunityDocsModal(opp, onDone) {
  const fmtBytes = (n) => { n = Number(n) || 0; if (n < 1024) return n + " B"; if (n < 1048576) return (n / 1024).toFixed(0) + " KB"; return (n / 1048576).toFixed(1) + " MB"; };
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4";
  overlay.innerHTML = `
    <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg p-5 max-h-[90vh] overflow-auto">
      <div class="text-base font-bold text-ink-900 mb-0.5">Attachments</div>
      <div class="text-xs text-black/50 mb-3">${escapeHtml(opp.customer_name || "")}${opp.title ? " — " + escapeHtml(opp.title) : ""}</div>
      <div data-body class="text-sm text-black/50">Loading…</div>
      <div class="mt-4 flex justify-end">
        <button data-close class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const bodyEl = overlay.querySelector("[data-body]");
  let total = 0;
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("[data-close]").addEventListener("click", close);

  const load = async () => {
    let data;
    try { data = await api(`/documents/opportunity/${opp.id}`); }
    catch (e) { bodyEl.innerHTML = `<div class="text-red-600 py-2">Couldn't load attachments.</div>`; return; }
    const files = data.files || {};
    total = Object.values(files).reduce((s, arr) => s + arr.length, 0);
    onDone && onDone(total);
    bodyEl.innerHTML = (data.tree || []).map(node => {
      const list = files[node.key] || [];
      return `
        <div class="border border-black/10 rounded-xl mb-2">
          <div class="flex items-center justify-between px-3 py-2 bg-black/[0.02]">
            <span class="text-xs font-bold text-ink-900">${escapeHtml(node.label)}${list.length ? ` <span class="text-black/40 font-normal">(${list.length})</span>` : ""}</span>
            <label class="inline-flex items-center gap-1 rounded-lg border border-black/10 bg-white px-2 py-1 text-[11px] font-semibold text-black/70 hover:bg-black/5 cursor-pointer">
              Upload<input type="file" class="hidden" data-up="${escapeHtml(node.key)}"></label>
          </div>
          ${list.length ? `<div class="divide-y divide-black/5">${list.map(f => `
            <div class="flex items-center justify-between px-3 py-1.5">
              <button data-dl="${f.id}" class="text-left text-blue-700 hover:underline truncate mr-2">${escapeHtml(f.filename)}</button>
              <div class="flex items-center gap-2 shrink-0">
                <span class="text-[10px] text-black/40">${fmtBytes(f.size_bytes)}</span>
                <button data-rm="${f.id}" class="text-[10px] text-black/35 hover:text-red-600 hover:underline">remove</button>
              </div>
            </div>`).join("")}</div>` : `<div class="px-3 py-2 text-[11px] text-black/35">No files.</div>`}
        </div>`;
    }).join("");

    bodyEl.querySelectorAll("[data-up]").forEach(inp => inp.addEventListener("change", async () => {
      const folder = inp.getAttribute("data-up");
      const file = inp.files[0]; if (!file) return;
      const fd = new FormData(); fd.append("file", file);
      const label = inp.closest("label"); const orig = label.innerHTML;
      label.innerHTML = "Uploading…";
      try { await api(`/documents/opportunity/${opp.id}?folder=${encodeURIComponent(folder)}`, { method: "POST", body: fd }); load(); }
      catch (err) { alert(err?.message || "Upload failed"); label.innerHTML = orig; }
    }));
    bodyEl.querySelectorAll("[data-dl]").forEach(b => b.addEventListener("click", async () => {
      try { const r = await api(`/documents/file/${b.getAttribute("data-dl")}/url`); window.open(r.url, "_blank"); }
      catch (err) { alert(err?.message || "Couldn't open file"); }
    }));
    bodyEl.querySelectorAll("[data-rm]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Remove this file?")) return;
      try { await api(`/documents/file/${b.getAttribute("data-rm")}`, { method: "DELETE" }); load(); }
      catch (err) { alert(err?.message || "Delete failed"); }
    }));
  };
  load();
}

// ── New Opportunity (RFQ intake) modal ──────────────────────────────────────
function newOpportunityModal({ estimators, onSaved }) {
  let customer = null;   // {qbo_id, name}
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4";
  overlay.innerHTML = `
    <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg p-5 max-h-[90vh] overflow-auto">
      <div class="text-base font-bold text-ink-900 mb-3">New opportunity (log an RFQ)</div>
      <div class="space-y-3">
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Customer</div><div data-cust></div></label>
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Contact</div>
          <div class="flex gap-2">
            <select data-contact class="input text-sm py-1.5 flex-1" disabled><option value="">Pick a customer first</option></select>
            <button data-newcontact class="rounded-lg border border-black/15 px-2.5 py-1 text-xs font-semibold text-ink-900 hover:bg-black/5 whitespace-nowrap disabled:text-black/30" disabled>+ New</button>
          </div></label>
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Job / description</div><input data-f="title" class="input text-sm py-1.5 w-full" placeholder="e.g. Rack install — Odessa TX"></label>
        <div class="grid grid-cols-2 gap-2">
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">RFQ received</div><input data-f="rfq_received_date" type="date" class="input text-sm py-1.5 w-full"></label>
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Target start (optional)</div><input data-f="target_start_date" type="date" class="input text-sm py-1.5 w-full"></label>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Source</div>
            <select data-f="source" class="input text-sm py-1.5 w-full"><option value="">—</option>${SOURCES.map(s => `<option>${s}</option>`).join("")}</select></label>
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Estimator</div>
            <select data-f="estimator_user_id" class="input text-sm py-1.5 w-full"><option value="">—</option>${estimators.map(u => `<option value="${u.id}">${escapeHtml(u.name)}${u.role ? ` — ${escapeHtml(humanRole(u.role))}` : ""}</option>`).join("")}</select></label>
        </div>
      </div>
      <div class="mt-4 flex items-center justify-end gap-2">
        <span data-msg class="text-xs font-semibold mr-auto"></span>
        <button data-cancel class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Cancel</button>
        <button data-save class="btn-primary text-sm px-4 py-1.5">Create</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("[data-cancel]").addEventListener("click", close);

  const contactSel = overlay.querySelector("[data-contact]");
  const newContactBtn = overlay.querySelector("[data-newcontact]");
  const val = (f) => overlay.querySelector(`[data-f="${f}"]`);
  const setMsg = (t, ok) => { const m = overlay.querySelector("[data-msg]"); m.textContent = t; m.className = "text-xs font-semibold mr-auto " + (ok ? "text-emerald-700" : "text-red-600"); };

  const loadContacts = async (selectId) => {
    if (!customer) return;
    try {
      const d = await api(`/contacts/customer/${encodeURIComponent(customer.qbo_id)}`);
      const list = d.contacts || [];
      contactSel.innerHTML = `<option value="">— none —</option>` +
        list.map(c => `<option value="${c.id}" ${String(c.id) === String(selectId || "") ? "selected" : ""}>${escapeHtml(c.full_name || "contact")}</option>`).join("");
      contactSel.disabled = false; newContactBtn.disabled = false;
    } catch (_) { /* ignore */ }
  };

  customerCombobox(overlay.querySelector("[data-cust]"), {
    onPick: (c) => { customer = c; if (c) loadContacts(); else { contactSel.innerHTML = `<option value="">Pick a customer first</option>`; contactSel.disabled = true; newContactBtn.disabled = true; } },
  });
  newContactBtn.addEventListener("click", () => {
    if (!customer) return;
    contactFormModal({ customer, contact: null, onSaved: (saved) => loadContacts(saved?.id) });
  });

  overlay.querySelector("[data-save]").addEventListener("click", async () => {
    if (!customer) return setMsg("Pick a customer.", false);
    const payload = {
      customer_qbo_id: customer.qbo_id,
      contact_id: contactSel.value ? Number(contactSel.value) : null,
      title: val("title").value.trim() || null,
      source: val("source").value || null,
      rfq_received_date: val("rfq_received_date").value || null,
      target_start_date: val("target_start_date").value || null,
      estimator_user_id: val("estimator_user_id").value ? Number(val("estimator_user_id").value) : null,
    };
    try { await api(`/opportunities`, { method: "POST", body: JSON.stringify(payload) }); close(); onSaved && onSaved(); }
    catch (err) { let d = err?.message || "Could not save"; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch (_) {} setMsg(d, false); }
  });
}
