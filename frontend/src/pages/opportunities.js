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
// OPI win-probability status colors — mirror the Estimates (tracking) page.
const OPI_STATUS_COLORS = {
  "": "bg-sky-100 text-sky-800",
  "0% Lost": "bg-red-100 text-red-700",
  "0% Inactive": "bg-orange-100 text-orange-700",
  "20% Budgetary, Project Uncertain": "bg-yellow-100 text-yellow-800",
  "40% Competitive, Multiple Bidders": "bg-sky-100 text-sky-800",
  "60% Project Confirmed, Customer Well-Positioned": "bg-blue-700 text-white",
  "80% Verbal Approval, Very likely to Receive Order": "bg-purple-100 text-purple-800",
  "80% Red Flag > Goes to Ops Tab": "bg-red-700 text-white",
  "100% Won > Goes to Ops Tab": "bg-green-700 text-white",
};
const FUNNEL = (active) => `<svg class="size-3 ${active ? "text-blue-600" : "text-black/30"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>`;
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
      <div id="pMetrics" class="grid grid-cols-3 lg:grid-cols-6 gap-2 mb-2"></div>
      <div class="card p-3 flex flex-col overflow-hidden" id="pCard" style="min-height: 340px;">
        <div class="flex items-center gap-2 mb-2 flex-wrap shrink-0" id="pFilters"></div>
        <div id="pList" class="flex-1 overflow-auto text-sm text-black/40">Loading…</div>
        <div id="pPager" class="shrink-0"></div>
      </div>
    </div>`;
  setShell({
    title: "Pipeline",
    subtitle: "RFQ → quote → sent → won / lost. New quotes are built in-app via Start quote; the metrics workbook opens in Drive.",
    bodyHtml: body, showLogout: true, routeFn,
  });

  // Size the table card to fill exactly the space left in the viewport so the
  // whole page fits (no page-level vertical scroll) and the table's own
  // horizontal scrollbar stays visible at the card's bottom edge.
  const sizeCard = () => {
    const card = document.getElementById("pCard");
    if (!card) return;
    const top = card.getBoundingClientRect().top;
    // Leave room for the shell's bottom padding (pb-6 ≈ 24px) + a small gap so
    // the page itself never gains a vertical scrollbar.
    card.style.height = Math.max(340, window.innerHeight - top - 30) + "px";
  };
  window.addEventListener("resize", sizeCard);

  // Client-side model: fetch all rows once, then filter/sort/paginate in JS
  // (same pattern as the Contacts/Assignment tables). ~3k rows is fine in memory
  // and makes sorting + column filtering instant.
  let allRows = [];
  let statusFilter = "open";   // lifecycle bucket; historical rows default hidden
  let stageFilter = "";        // granular win-probability stage (pipeline_status)
  let searchQ = "";
  let unlinkedOnly = false;    // rows whose customer didn't resolve to a QBO customer
  let showInactive = false;    // archived rows are hidden until asked for
  let sortKey = "rfq_received_date";
  let sortDir = "desc";
  let page = 0;
  const PAGE = 100;
  const expanded = new Set();      // opp ids whose revision sub-rows are open
  const revCache = new Map();      // opp id → revisions[] (lazy-loaded)
  const metricsEl = document.getElementById("pMetrics");
  const listEl = document.getElementById("pList");
  const pagerEl = document.getElementById("pPager");
  const filtersEl = document.getElementById("pFilters");

  const chip = (label, val, sub = "") =>
    `<div class="rounded-xl border border-black/5 bg-white shadow-sm px-3 py-1.5 flex items-baseline justify-between gap-2">
       <div class="min-w-0"><div class="text-[9px] font-bold uppercase tracking-wide text-black/35 truncate">${label}</div>
       ${sub ? `<div class="text-[9px] text-black/40 truncate">${sub}</div>` : ""}</div>
       <div class="text-base font-extrabold text-ink-900 shrink-0">${val}</div></div>`;

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
    sizeCard();   // chip heights settled → recompute the card height
  };

  // The Quote cell = the quoting-metrics estimate. Priority: in-app estimate →
  // the Google-Drive workbook (historical) → start/link. The quote PDF lives in the
  // Docs "4 Quotes" folder, so there's no separate QBO-estimate pointer here.
  const quoteCell = (o) => {
    if (o.app_estimate_id)
      return `<a href="#/estimate/${o.app_estimate_id}" class="font-semibold text-blue-700 hover:underline whitespace-nowrap" title="In-app quoting-metrics estimate">Open quote →</a>`;
    if (o.workbook_url)
      return `<div class="whitespace-nowrap"><a href="${escapeHtml(o.workbook_url)}" target="_blank" rel="noopener" class="font-semibold text-indigo-700 hover:underline" title="Quoting-metrics workbook in Google Drive">Workbook ↗</a>
        <button data-editlink="${o.id}" class="text-[10px] text-black/30 hover:text-black/60 ml-1" title="Edit workbook link">✎</button>
        <button data-clearlink="${o.id}" class="text-[10px] text-black/30 hover:text-red-600 ml-0.5" title="Remove workbook link">✕</button></div>
        ${o.customer_qbo_id ? `<button data-startq="${o.id}" class="text-[11px] font-semibold text-emerald-700 hover:underline" title="Build an in-app quote (e.g. a revision)">+ Start quote</button>` : ""}`;
    const start = o.customer_qbo_id ? `<button data-startq="${o.id}" class="font-semibold text-emerald-700 hover:underline whitespace-nowrap">Start quote</button>` : "";
    const link = `<button data-editlink="${o.id}" class="text-[11px] text-black/40 hover:text-indigo-700 hover:underline whitespace-nowrap ${start ? "ml-2" : ""}" title="Link the Google-Drive quoting-metrics workbook">+ link workbook</button>`;
    return start + link;
  };

  // Expander caret in the Quote cell — present when this opportunity has an in-app
  // quote (so it has ≥1 revision). Shows the revision count when > 1.
  const caret = (o) => {
    if (!o.app_estimate_id) return "";
    const n = o.revision_count || 1;
    return `<button data-exp="${o.id}" class="mr-1 align-middle inline-flex items-center gap-0.5 text-black/40 hover:text-blue-700" title="${n} revision${n > 1 ? "s" : ""}">
      <svg class="size-3 transition-transform ${expanded.has(o.id) ? "rotate-90" : ""}" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
      ${n > 1 ? `<span class="text-[10px] font-bold">${n}</span>` : ""}
    </button>`;
  };
  // One revision line inside the expanded sub-row. The badge conveys the
  // revision's state (current / locked / draft), so the raw lifecycle status is
  // not repeated here — instead each revision shows its own Labor / Travel /
  // OH&P (last synced on that revision's Save & Send), matching the main row.
  const revRow = (o, r) => {
    const badge = r.is_current
      ? `<span class="text-[9px] font-bold uppercase rounded px-1 py-0.5 bg-emerald-100 text-emerald-700" title="The revision the pipeline currently uses">current</span>`
      : r.locked ? `<span class="text-[9px] font-bold uppercase rounded px-1 py-0.5 bg-slate-200 text-slate-600" title="Sent/finalized — read-only unless unlocked">🔒 locked</span>`
      : `<span class="text-[9px] font-bold uppercase rounded px-1 py-0.5 bg-amber-100 text-amber-700" title="Not yet sent — editable draft">draft</span>`;
    const n = (v) => (v == null ? "—" : Number(v).toLocaleString());
    const val = (v) => (v == null ? "—" : "$" + Math.round(Number(v)).toLocaleString());
    // Figures live at the END of the row (after the actions), per OPI's preferred order.
    const metrics = `<div class="text-black/45 tabular-nums shrink-0 whitespace-nowrap ml-auto" title="This revision's last-synced figures: Labor days · Travel days · OH&P% · Value">
        Labor ${n(r.labor_days)} · Travel ${n(r.travel_days)} · ${r.ohp_pct == null ? "OH&P —" : "OH&P " + Math.round(r.ohp_pct) + "%"} · ${val(r.contract_value)}
      </div>`;
    const useBtn = r.is_current
      ? ""
      : `<button data-usecur="${r.id}" data-opp="${o.id}" class="font-semibold text-emerald-700 hover:underline shrink-0" title="Make this the revision the pipeline uses (its figures + Open quote)">Use this</button>`;
    return `<div class="flex items-center gap-3 py-1.5 text-xs">
      <div class="font-bold text-ink-900 w-14 shrink-0">Rev ${r.revision_no}</div>
      <div class="w-20 shrink-0">${badge}</div>
      <div class="text-black/55 flex-1 min-w-0 truncate">${escapeHtml(r.quote_description || "—")}</div>
      <div class="text-black/40 tabular-nums w-24 shrink-0">${r.created_at ? escapeHtml(r.created_at.slice(0, 10)) : ""}</div>
      <a href="#/estimate/${r.id}" class="font-semibold text-blue-700 hover:underline shrink-0">Open →</a>
      ${useBtn}
      <div class="w-14 shrink-0 text-right">${r.locked ? `<button data-unlockrev="${r.id}" data-opp="${o.id}" class="font-semibold text-amber-700 hover:underline">Unlock</button>` : ""}</div>
      ${metrics}
    </div>`;
  };
  // The expanded sub-row (spans the whole table) listing this opportunity's revisions.
  const subRowHtml = (o) => {
    if (!expanded.has(o.id)) return "";
    const revs = revCache.get(o.id);
    const inner = revs == null
      ? `<div class="text-xs text-black/40 py-2">Loading revisions…</div>`
      : `<div class="pl-6 max-w-6xl">
           <div class="flex items-center justify-between mb-1">
             <div class="text-[10px] font-bold uppercase tracking-wide text-black/40">Revisions · Quote #${escapeHtml(o.quote_number || "—")}</div>
             <button data-newrev="${o.id}" class="text-[11px] font-semibold text-emerald-700 hover:underline">+ New revision</button>
           </div>
           <div class="divide-y divide-black/5">${revs.map(r => revRow(o, r)).join("") || `<div class="text-xs text-black/40 py-2">No revisions.</div>`}</div>
         </div>`;
    return `<tr class="bg-slate-50/70 border-b border-black/5"><td colspan="${COLS.length + 1}" class="px-3 py-2">${inner}</td></tr>`;
  };

  // Lazy-load a row's revisions into the cache.
  const loadRevs = async (oppId) => {
    const o = allRows.find(x => x.id === oppId);
    if (!o || !o.app_estimate_id) { revCache.set(oppId, []); return; }
    try { const d = await api(`/estimates/${o.app_estimate_id}/quote-revisions`); revCache.set(oppId, d.revisions || []); }
    catch (_) { revCache.set(oppId, []); }
  };

  // Lifecycle stage (received/quoting/sent/won/lost/declined). Normally set by
  // actions (new→received, start quote→quoting, save & send→sent) or a terminal
  // status; this dropdown lets a user manually override it when needed.
  const STAGE_KEYS = Object.keys(STATUS_META);
  const stageBadge = (o) => {
    const m = STATUS_META[o.status] || { label: o.status, cls: "bg-black/10" };
    const opts = STAGE_KEYS.map(k => `<option value="${k}" ${k === o.status ? "selected" : ""}>${STATUS_META[k]?.label || k}</option>`).join("");
    return `<select data-stageset="${o.id}" title="Lifecycle stage — set automatically by actions; change here to override manually" class="text-[10px] font-bold uppercase tracking-wide rounded px-1.5 py-0.5 border-0 cursor-pointer ${m.cls}">${opts}</select>`;
  };
  // OPI win-probability status (the 20/80% system) — editable, mirrors the
  // Estimates page's status column (same values + colors).
  const opiStatusCell = (o) => {
    const selCls = OPI_STATUS_COLORS[o.pipeline_status || ""] || "bg-sky-100 text-sky-800";
    const opts = `<option value=""></option>` + pipelineStatuses.map(s =>
      `<option value="${escapeHtml(s)}" ${s === o.pipeline_status ? "selected" : ""}>${escapeHtml(s.replace(/\s*>.*$/, ""))}</option>`).join("");
    return `<select data-pstatus="${o.id}" title="OPI status" class="text-[10px] font-semibold rounded px-1 py-0.5 border-0 max-w-[9rem] ${selCls} cursor-pointer">${opts}</select>`;
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
  // Stale = an OPEN opportunity gone quiet: last follow-up (or, if never contacted,
  // the RFQ date) is more than 30 days old. Flags rows that need a follow-up.
  const daysSince = (d) => (d ? Math.floor((Date.now() - new Date(String(d).slice(0, 10)).getTime()) / 86400000) : null);
  const OPEN_STATUSES = new Set(["received", "quoting", "sent"]);
  const isStale = (o) => {
    if (!OPEN_STATUSES.has(o.status)) return false;
    const ref = o.last_contact_date || o.rfq_received_date;
    const n = daysSince(ref);
    return n != null && n > 30;
  };
  const followupCell = (o) => {
    const stale = isStale(o);
    const flag = stale ? `<div class="text-[9px] font-bold uppercase tracking-wide text-red-600">⏰ follow up</div>` : "";
    if (o.last_contact_date || o.follow_up_count)
      return `<button data-log="${o.id}" class="text-left group">
        <div class="tabular-nums ${stale ? "text-red-600 font-semibold" : "text-black/70"} group-hover:underline">${ymd(o.last_contact_date)}</div>
        <div class="text-[10px] text-black/40">${o.follow_up_count || 0}× ${escapeHtml(o.last_comm_type || "")}</div>${flag}
      </button>`;
    return `<button data-log="${o.id}" class="text-left"><span class="text-[11px] ${stale ? "text-red-600" : "text-blue-600"} font-semibold hover:underline">+ log</span>${flag}</button>`;
  };
  // Column order per OPI: stage, status, follow-up, quote, By, RFQ, quote#,
  // Customer, Contact, job, then the rest. Each sortable unless nosort.
  const COLS = [
    { key: "stage", label: "Stage", td: (o) => stageBadge(o) },
    { key: "pipeline_status", label: "Status", td: (o) => opiStatusCell(o) },
    { key: "last_contact_date", label: "Follow-up", cls: "whitespace-nowrap", td: (o) => followupCell(o) },
    { key: "quote", label: "Quote", nosort: true, td: (o) => caret(o) + quoteCell(o) },
    { key: "quoted_by", label: "By", cls: "text-black/60", td: (o) => escapeHtml(dash(o.quoted_by || o.estimator_name)) },
    { key: "rfq_received_date", label: "RFQ", cls: "tabular-nums text-black/60", td: (o) => ymd(o.rfq_received_date) },
    { key: "quote_number", label: "Quote #", cls: "tabular-nums font-semibold text-ink-900", td: (o) => escapeHtml(dash(o.quote_number)) },
    { key: "customer_name", label: "Customer", td: (o) => `<span class="font-semibold text-ink-900">${escapeHtml(dash(o.customer_name))}</span>${!o.customer_qbo_id && o.customer_name ? ` <button data-linkcust="${o.id}" class="align-middle text-[9px] font-bold uppercase tracking-wide rounded px-1 py-0.5 bg-amber-100 text-amber-700 hover:bg-amber-200" title="Click to link this to a QuickBooks customer">unlinked</button>` : ""}` },
    { key: "contact_name", label: "Contact", cls: "text-black/60", td: (o) => escapeHtml(dash(o.contact_name)) },
    { key: "title", label: "Job", cls: "text-black/70 max-w-[16rem] truncate", td: (o) => `${escapeHtml(dash(o.title))}${o.notes ? ` <span class="align-middle cursor-help text-black/30 hover:text-black/60" title="${escapeHtml(o.notes)}">🗒</span>` : ""}${o.project_name ? `<div class="text-[10px] text-emerald-700">→ <a href="#/entity/project/${escapeHtml(o.project_qbo_id)}" data-goproject="${escapeHtml(o.project_qbo_id)}" class="hover:underline font-semibold">${escapeHtml(o.project_name)}</a> <button data-linkproj="${o.id}" class="text-black/30 hover:text-black/60" title="Change or unlink project">✎</button></div>` : (o.status === "won" ? `<div><button data-linkproj="${o.id}" class="text-[9px] font-bold uppercase tracking-wide rounded px-1 py-0.5 bg-amber-100 text-amber-700 hover:bg-amber-200" title="Won but not linked to a QuickBooks project yet — click to link">⚠ link project</button></div>` : "")}` },
    { key: "labor_days", label: "Labor", align: "right", cls: "tabular-nums text-black/60", td: (o) => num(o.labor_days) },
    { key: "travel_days", label: "Travel", align: "right", cls: "tabular-nums text-black/60", td: (o) => num(o.travel_days) },
    { key: "ohp_pct", label: "OH&P %", align: "right", cls: "tabular-nums text-black/60", td: (o) => o.ohp_pct == null ? "—" : Math.round(o.ohp_pct) + "%" },
    { key: "contract_value", label: "Value", align: "right", cls: "tabular-nums text-black/70", td: (o) => valueCell(o) },
    { key: "target_start_date", label: "Start", cls: "tabular-nums text-black/60", td: (o) => ymd(o.target_start_date) },
    { key: "target_end_date", label: "End", cls: "tabular-nums text-black/60", td: (o) => ymd(o.target_end_date) },
    { key: "doc_count", label: "Docs", align: "center", td: (o) => `<button data-docs="${o.id}" class="inline-flex items-center gap-0.5 font-semibold ${o.doc_count ? "text-blue-700" : "text-black/40"} hover:underline" title="Attachments (RFQ, drawings, quote, PO)">📎${o.doc_count || 0}</button>` },
  ];

  const NUMERIC = new Set(["labor_days", "travel_days", "ohp_pct", "ohp_amount", "contract_value", "order_value", "total_revisions"]);
  const sortVal = (o, key) => {
    if (key === "stage") return (o.status || "").toLowerCase();
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
      if (!showInactive && o.active === false) return false;   // archived rows hidden by default
      if (unlinkedOnly && o.customer_qbo_id) return false;
      if (q && !(`${o.customer_name || ""} ${o.title || ""} ${o.quote_number || ""} ${o.contact_name || ""} ${o.quoted_by || ""}`).toLowerCase().includes(q)) return false;
      if (!passColFilters(o)) return false;
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

  // ── Per-column header filters (mirrors the Customers table's funnel filters) ─
  let colFilters = {};
  const DATE_KEYS = new Set(["rfq_received_date", "target_start_date", "target_end_date", "last_contact_date"]);
  const MULTI_KEYS = new Set(["stage", "pipeline_status", "quoted_by"]);
  const NOFILTER = new Set(["quote", "workbook_url"]);
  const filterType = (key) => NUMERIC.has(key) ? "num" : DATE_KEYS.has(key) ? "date" : MULTI_KEYS.has(key) ? "multi" : "text";
  const filterVal = (o, key) => key === "stage" ? (STATUS_META[o.status]?.label || o.status || "") : (o[key] ?? "");
  const filterOptions = (key) => [...new Set(allRows.map(o => filterVal(o, key)).filter(v => v !== "" && v != null).map(String))].sort();
  const filterActive = (key) => { const f = colFilters[key]; if (f == null) return false; if (Array.isArray(f)) return f.length > 0; if (typeof f === "object") return !!(f.from || f.to || f.min || f.max); return !!f; };
  const passColFilters = (o) => {
    for (const c of COLS) {
      if (NOFILTER.has(c.key)) continue;
      const f = colFilters[c.key]; if (f == null) continue;
      const t = filterType(c.key);
      if (t === "text") { if (f && !String(filterVal(o, c.key)).toLowerCase().includes(String(f).toLowerCase())) return false; }
      else if (t === "multi") { if (f.length && !f.includes(String(filterVal(o, c.key)))) return false; }
      else if (t === "num") { const v = Number(o[c.key]); if (f.min !== "" && f.min != null && !(v >= +f.min)) return false; if (f.max !== "" && f.max != null && !(v <= +f.max)) return false; }
      else if (t === "date") { const v = String(o[c.key] || "").slice(0, 10); if (f.from && (!v || v < f.from)) return false; if (f.to && (!v || v > f.to)) return false; }
    }
    return true;
  };
  const closeFilterPortal = () => document.getElementById("oppFilterPortal")?.remove();
  function openFilterPortal(key, anchor) {
    closeFilterPortal();
    const col = COLS.find(c => c.key === key); if (!col) return;
    const t = filterType(key);
    const footer = `<div class="mt-2.5 flex justify-end gap-1.5"><button data-fclear class="rounded-lg border border-black/10 px-2.5 py-1 text-xs font-semibold hover:bg-black/5">Clear</button><button data-fdone class="btn-primary text-xs px-2.5 py-1">Done</button></div>`;
    let content = `<div class="text-[10px] font-bold text-black/40 mb-1.5">Filter ${escapeHtml(col.label)}</div>`;
    if (t === "text") content += `<input data-finput class="input text-xs py-1 w-full" value="${escapeHtml(colFilters[key] || "")}" placeholder="Type to filter…">${footer}`;
    else if (t === "multi") { const sel = colFilters[key] || []; content += `<div class="flex flex-col max-h-[220px] overflow-auto">${filterOptions(key).map(v => `<label class="flex items-center gap-2 px-1.5 py-1 rounded-lg hover:bg-black/[0.04] cursor-pointer text-xs"><input type="checkbox" data-fcheck value="${escapeHtml(v)}" ${sel.includes(String(v)) ? "checked" : ""} class="h-3.5 w-3.5"><span class="truncate">${escapeHtml(v)}</span></label>`).join("") || `<div class="text-xs text-black/40 px-1.5 py-1">No values</div>`}</div>${footer}`; }
    else if (t === "num") { const f = colFilters[key] || { min: "", max: "" }; content += `<div class="flex flex-col gap-2"><input type="number" data-frange="min" class="input text-xs py-1" value="${escapeHtml(f.min || "")}" placeholder="Min"><input type="number" data-frange="max" class="input text-xs py-1" value="${escapeHtml(f.max || "")}" placeholder="Max"></div>${footer}`; }
    else if (t === "date") { const f = colFilters[key] || { from: "", to: "" }; content += `<div class="flex flex-col gap-2"><div><div class="text-[10px] text-black/40 mb-0.5">From</div><input type="date" data-fdate="from" class="input text-xs py-1" value="${escapeHtml(f.from || "")}"></div><div><div class="text-[10px] text-black/40 mb-0.5">To</div><input type="date" data-fdate="to" class="input text-xs py-1" value="${escapeHtml(f.to || "")}"></div></div>${footer}`; }
    const rect = anchor.getBoundingClientRect(), w = 230;
    let left = rect.left; if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    const portal = document.createElement("div");
    portal.id = "oppFilterPortal"; portal.className = "fixed z-[200] rounded-xl border border-black/10 bg-white p-3 shadow-xl text-ink-900";
    portal.style.cssText = `top:${rect.bottom + 4}px; left:${left}px; width:${w}px;`;
    portal.innerHTML = content;
    document.body.appendChild(portal);
    const reflow = () => render();  // re-filter; portal lives on <body>, survives listEl re-render
    portal.querySelector("[data-finput]")?.addEventListener("input", (e) => { colFilters[key] = e.target.value; page = 0; reflow(); });
    portal.querySelectorAll("[data-fcheck]").forEach(cb => cb.addEventListener("change", () => { const arr = colFilters[key] || []; colFilters[key] = cb.checked ? [...arr, cb.value] : arr.filter(v => v !== cb.value); page = 0; reflow(); }));
    portal.querySelectorAll("[data-frange]").forEach(i => i.addEventListener("input", () => { colFilters[key] = colFilters[key] || { min: "", max: "" }; colFilters[key][i.dataset.frange] = i.value; page = 0; reflow(); }));
    portal.querySelectorAll("[data-fdate]").forEach(i => i.addEventListener("change", () => { colFilters[key] = colFilters[key] || { from: "", to: "" }; colFilters[key][i.dataset.fdate] = i.value; page = 0; reflow(); }));
    portal.querySelector("[data-fclear]")?.addEventListener("click", () => { delete colFilters[key]; closeFilterPortal(); page = 0; render(); });
    portal.querySelector("[data-fdone]")?.addEventListener("click", () => { closeFilterPortal(); render(); });
    portal.querySelector("input")?.focus();
  }

  const renderFilters = () => {
    const stages = [...new Set(allRows.map(o => o.pipeline_status).filter(Boolean))].sort();
    const pills = [["open", "Open"], ...Object.entries(STATUS_META).map(([k, v]) => [k, v.label]), ["", "All"]];
    filtersEl.innerHTML =
      pills.map(([k, label]) =>
        `<button data-sf="${k}" class="rounded-full px-2.5 py-1 text-xs font-semibold border ${statusFilter === k ? "bg-ink-900 text-white border-ink-900" : "border-black/15 text-black/60 hover:bg-black/5"}">${label}</button>`).join("") +
      `<select data-stage class="input text-xs py-1 px-2 max-w-[16rem]"><option value="">All statuses</option>${stages.map(s => `<option value="${escapeHtml(s)}" ${stageFilter === s ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}</select>` +
      `<button data-unlinked class="rounded-full px-2.5 py-1 text-xs font-semibold border ${unlinkedOnly ? "bg-amber-500 text-white border-amber-500" : "border-amber-300 text-amber-700 hover:bg-amber-50"}" title="Rows with no matching QuickBooks customer">⚠ No customer</button>` +
      `<button data-showinactive class="rounded-full px-2.5 py-1 text-xs font-semibold border ${showInactive ? "bg-slate-600 text-white border-slate-600" : "border-black/15 text-black/50 hover:bg-black/5"}" title="Include archived (inactive) opportunities">Inactive</button>` +
      `<input data-search value="${escapeHtml(searchQ)}" placeholder="Search…" class="input text-xs py-1 px-2 ml-auto w-52">` +
      `<span data-count class="text-xs text-black/40 whitespace-nowrap"></span>` +
      `<button data-new class="btn-primary text-xs px-3 py-1.5 whitespace-nowrap">+ New</button>`;
    filtersEl.querySelectorAll("[data-sf]").forEach(b => b.addEventListener("click", () => {
      const k = b.getAttribute("data-sf");
      statusFilter = (k && k === statusFilter) ? "" : k;  // click the active pill → back to All
      page = 0; renderFilters(); render();
    }));
    filtersEl.querySelector("[data-stage]").addEventListener("change", (e) => { stageFilter = e.target.value; page = 0; render(); });
    filtersEl.querySelector("[data-unlinked]").addEventListener("click", () => { unlinkedOnly = !unlinkedOnly; page = 0; renderFilters(); render(); });
    filtersEl.querySelector("[data-showinactive]").addEventListener("click", () => { showInactive = !showInactive; page = 0; renderFilters(); render(); });
    filtersEl.querySelector("[data-new]").addEventListener("click", () =>
      newOpportunityModal({ estimators, onSaved: () => { loadMetrics(); load(); } }));
    const sb = filtersEl.querySelector("[data-search]");
    let t = null;
    sb.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { searchQ = sb.value.trim(); page = 0; render(); }, 200); });
    if (document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-search") != null) sb.focus();
  };

  // ── View-state persistence ──────────────────────────────────────────────────
  // Remember the pipeline's filters/sort/search/expanded rows + scroll so that
  // opening a quote and clicking "← Back to pipeline" (or any re-nav) returns to
  // the exact view the user left, not a fresh default. Session-scoped.
  const VIEW_KEY = "opi_pipeline_view";
  let mounting = true;         // suppress scroll clobber during the initial restore
  let pendingScroll = 0;
  const saveView = () => {
    try {
      const prev = JSON.parse(sessionStorage.getItem(VIEW_KEY) || "null") || {};
      sessionStorage.setItem(VIEW_KEY, JSON.stringify({
        statusFilter, stageFilter, searchQ, unlinkedOnly, showInactive,
        sortKey, sortDir, page, colFilters, expanded: [...expanded],
        // While mounting, keep the stored scroll (the list is still at 0).
        scroll: mounting ? (prev.scroll || 0) : (listEl ? listEl.scrollTop : 0),
      }));
    } catch (_) {}
  };
  const restoreView = () => {
    try {
      const v = JSON.parse(sessionStorage.getItem(VIEW_KEY) || "null");
      if (!v) return;
      if (typeof v.statusFilter === "string") statusFilter = v.statusFilter;
      if (typeof v.stageFilter  === "string") stageFilter  = v.stageFilter;
      if (typeof v.searchQ      === "string") searchQ      = v.searchQ;
      if (typeof v.unlinkedOnly === "boolean") unlinkedOnly = v.unlinkedOnly;
      if (typeof v.showInactive === "boolean") showInactive = v.showInactive;
      if (typeof v.sortKey      === "string") sortKey      = v.sortKey;
      if (v.sortDir === "asc" || v.sortDir === "desc") sortDir = v.sortDir;
      if (Number.isInteger(v.page)) page = v.page;
      if (v.colFilters && typeof v.colFilters === "object") colFilters = v.colFilters;
      if (Array.isArray(v.expanded)) v.expanded.forEach(id => expanded.add(Number(id)));
      pendingScroll = Number(v.scroll) || 0;
    } catch (_) {}
  };

  const render = () => {
    saveView();   // persist filters/sort/search/expanded (+ current scroll) on every change
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
          ${COLS.map(c => `<th class="py-2 pr-3 font-bold whitespace-nowrap bg-white ${c.align === "right" ? "text-right" : ""}">
            <span class="inline-flex items-center gap-0.5 ${c.align === "right" ? "flex-row-reverse" : ""}">
              <button ${c.nosort ? "" : `data-sort="${c.key}"`} class="${c.nosort ? "cursor-default" : "cursor-pointer select-none hover:text-black/70"} font-bold">${c.label}${c.nosort ? "" : arrow(c.key)}</button>
              ${NOFILTER.has(c.key) ? "" : `<button data-filter="${c.key}" title="Filter" class="inline-flex h-4 w-4 items-center justify-center rounded hover:bg-black/10 ${filterActive(c.key) ? "bg-blue-50" : ""}">${FUNNEL(filterActive(c.key))}</button>`}
            </span></th>`).join("")}
          <th class="py-2 font-bold text-right bg-white"></th></tr></thead>
        <tbody>${slice.map(o => `
          <tr class="border-b border-black/5 hover:bg-black/[0.02] align-top ${o.active === false ? "opacity-50" : ""}">
            ${COLS.map(c => `<td class="py-1.5 pr-3 ${c.align === "right" ? "text-right" : ""} ${c.cls || ""}">${c.td(o)}</td>`).join("")}
            <td class="py-1.5 text-right whitespace-nowrap">
              <button data-edit="${o.id}" class="text-blue-600 font-semibold hover:underline">Edit</button>
              <button data-inactive="${o.id}" data-act="${o.active === false ? 0 : 1}" class="ml-2 font-semibold hover:underline ${o.active === false ? "text-emerald-700" : "text-amber-700"}">${o.active === false ? "Reactivate" : "Deactivate"}</button>
            </td>
          </tr>${subRowHtml(o)}`).join("")}
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
    listEl.querySelectorAll("[data-filter]").forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); openFilterPortal(b.getAttribute("data-filter"), b); }));
    // Opening a linked project: remember to send "← Back to Pipeline" (with the
    // pipeline's saved view already persisted) instead of the default Customers.
    listEl.querySelectorAll("[data-goproject]").forEach(a => a.addEventListener("click", () => {
      const pid = a.getAttribute("data-goproject");
      try { sessionStorage.setItem("opi_entity_back", JSON.stringify({ entity: "project/" + pid, label: "Pipeline", hash: "#/pipeline" })); } catch (_) {}
    }));
    // Revision expander: toggle the sub-row; lazy-load revisions on first open.
    listEl.querySelectorAll("[data-exp]").forEach(b => b.addEventListener("click", async () => {
      const id = Number(b.getAttribute("data-exp"));
      if (expanded.has(id)) { expanded.delete(id); render(); return; }
      expanded.add(id); render();               // shows "Loading…"
      if (!revCache.has(id)) { await loadRevs(id); render(); }
    }));
    // + New revision from the pipeline: duplicate current quote → open the new draft.
    listEl.querySelectorAll("[data-newrev]").forEach(b => b.addEventListener("click", async () => {
      const id = Number(b.getAttribute("data-newrev"));
      const o = allRows.find(x => x.id === id);
      if (!o || !o.app_estimate_id) return;
      if (!confirm("Create a new revision? This duplicates the current quote, locks the current revision, and opens the new draft.")) return;
      try {
        const r = await api(`/estimates/${o.app_estimate_id}/revise`, { method: "POST" });
        location.hash = `#/estimate/${r.estimate_id}`;
      } catch (err) { alert(err.message || "Failed to create revision"); }
    }));
    // Unlock a superseded revision so it can be edited directly.
    listEl.querySelectorAll("[data-unlockrev]").forEach(b => b.addEventListener("click", async () => {
      const rid = b.getAttribute("data-unlockrev");
      const oppId = Number(b.getAttribute("data-opp"));
      try { await api(`/estimates/${rid}/unlock`, { method: "POST" }); revCache.delete(oppId); await loadRevs(oppId); render(); }
      catch (err) { alert(err.message || "Failed to unlock"); }
    }));
    // "Use this" — point the pipeline row at a chosen revision (its figures + Open quote).
    listEl.querySelectorAll("[data-usecur]").forEach(b => b.addEventListener("click", async () => {
      const rid = Number(b.getAttribute("data-usecur"));
      const oppId = Number(b.getAttribute("data-opp"));
      if (!confirm("Use this revision for the pipeline? The row will show this revision's figures, and “Open quote” will open it.")) return;
      try {
        const d = await api(`/opportunities/${oppId}/set-current-revision`, {
          method: "POST", body: JSON.stringify({ estimate_id: rid }),
        });
        const o = allRows.find(x => x.id === oppId);
        if (o && d.opportunity) Object.assign(o, d.opportunity);   // refresh main-row figures + app_estimate_id
        revCache.delete(oppId); await loadRevs(oppId);             // is_current moved
        render();
      } catch (err) { alert(err.message || "Failed to set current revision"); }
    }));
    pagerEl.querySelectorAll("[data-pg]").forEach(b => b.addEventListener("click", () => {
      page = b.getAttribute("data-pg") === "next" ? page + 1 : Math.max(0, page - 1);
      render(); listEl.scrollTop = 0;
    }));
    listEl.querySelectorAll("[data-pstatus]").forEach(sel => sel.addEventListener("change", async () => {
      const id = sel.getAttribute("data-pstatus");
      const opp = allRows.find(o => String(o.id) === id);
      const pv = sel.value || null;
      // Only "100% Won" is the won handoff (link the QBO project). "80% Red Flag" is
      // NOT won — it's a flagged-but-in-play status, so no modal.
      if (pv && /won/i.test(pv) && !/red flag/i.test(pv)) {
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
    listEl.querySelectorAll("[data-stageset]").forEach(sel => sel.addEventListener("change", async () => {
      const id = sel.getAttribute("data-stageset");
      const opp = allRows.find(o => String(o.id) === id);
      try {
        const r = await api(`/opportunities/${id}`, { method: "PATCH", body: JSON.stringify({ status: sel.value }) });
        if (opp && r.opportunity) { opp.status = r.opportunity.status; }
        loadMetrics(); render();
      } catch (err) { alert(err.message); }
    }));
    listEl.querySelectorAll("[data-inactive]").forEach(b => b.addEventListener("click", async () => {
      const id = b.getAttribute("data-inactive");
      const makeActive = b.getAttribute("data-act") === "0";   // currently inactive → reactivate
      const opp = allRows.find(o => String(o.id) === id);
      if (!makeActive && !confirm("Mark this opportunity inactive? It stays available under the “Inactive” filter.")) return;
      try {
        await api(`/opportunities/${id}`, { method: "PATCH", body: JSON.stringify({ active: makeActive }) });
        if (opp) opp.active = makeActive;
        loadMetrics(); render();
      } catch (err) { alert(err.message); }
    }));
    listEl.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => {
      const opp = allRows.find(o => String(o.id) === b.getAttribute("data-edit"));
      editOpportunityModal(opp, (updated) => {
        if (updated) { const i = allRows.findIndex(o => o.id === updated.id); if (i >= 0) allRows[i] = updated; }
        render();
      });
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
    listEl.querySelectorAll("[data-clearlink]").forEach(b => b.addEventListener("click", async () => {
      const opp = allRows.find(o => String(o.id) === b.getAttribute("data-clearlink"));
      if (!confirm("Remove the workbook link from this row?")) return;
      try { await api(`/opportunities/${opp.id}`, { method: "PATCH", body: JSON.stringify({ workbook_url: null }) }); opp.workbook_url = null; render(); }
      catch (err) { alert(err.message); }
    }));
    listEl.querySelectorAll("[data-linkproj]").forEach(b => b.addEventListener("click", () => {
      const opp = allRows.find(o => String(o.id) === b.getAttribute("data-linkproj"));
      openLinkProjectModal(opp, () => { loadMetrics(); load(); }, () => render());
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
    if (mounting) {
      // First load of this page instance: restore the saved view + pre-load the
      // revisions of any rows that were left expanded so they render populated.
      restoreView();
      await Promise.all([...expanded].map(id => revCache.has(id) ? null : loadRevs(id)));
    } else {
      expanded.clear(); revCache.clear();   // stale after a reload
    }
    renderFilters(); render(); sizeCard();
    if (mounting) {
      if (pendingScroll) listEl.scrollTop = pendingScroll;
      pendingScroll = 0;
      mounting = false;
    }
  };

  // Persist scroll position as the user scrolls (debounced) so leaving mid-scroll is remembered.
  let scrollSaveT = null;
  listEl.addEventListener("scroll", () => { clearTimeout(scrollSaveT); scrollSaveT = setTimeout(saveView, 300); });
  listEl.addEventListener("scroll", closeFilterPortal);
  document.addEventListener("mousedown", (e) => {
    const p = document.getElementById("oppFilterPortal");
    if (p && !p.contains(e.target) && !e.target.closest("[data-filter]")) closeFilterPortal();
  });

  loadMetrics();
  load();
  requestAnimationFrame(sizeCard);   // after first paint, once layout settles
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
        <div data-pmenu class="absolute z-20 mt-1 w-full bg-white border border-black/10 rounded-xl shadow-lg max-h-44 overflow-auto hidden"></div>
      </div>
      <div data-picked class="text-xs text-emerald-700 font-semibold mb-2 min-h-[1rem]"></div>
      <div class="mb-3">
        <div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Purchase Order <span class="normal-case font-normal text-black/30">— optional, files to “5 Purchase Orders”</span></div>
        <div data-podrop class="border border-dashed border-black/20 rounded-xl px-3 py-3 text-center text-[11px] text-black/45 cursor-pointer hover:bg-black/[0.02]" style="transition:border-color .12s">
          <span data-postatus>Drag the PO here, or click to upload</span>
          <input type="file" multiple class="hidden" data-poinput>
        </div>
      </div>
      <div class="flex items-center justify-end gap-2">
        <span data-msg class="text-xs font-semibold mr-auto"></span>
        ${opp.project_qbo_id ? `<button data-unlink class="rounded-lg border border-red-200 text-red-600 px-3 py-1.5 text-sm font-semibold hover:bg-red-50">Unlink project</button>` : `<button data-skip class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Won, link later</button>`}
        <button data-cancel class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Cancel</button>
        <button data-save class="btn-primary text-sm px-4 py-1.5">${opp.project_qbo_id ? "Change project" : "Link &amp; mark won"}</button>
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
    if (!q) { menu.classList.add("hidden"); return; }   // empty field → hide menu, don't cover the buttons
    try {
      const list = (await api(`/opportunities/project-options?q=${encodeURIComponent(q)}&limit=40`)).projects || [];
      menu.innerHTML = list.length
        ? list.map(pj => `<div class="px-3 py-1.5 text-sm text-ink-900 hover:bg-blue-50 cursor-pointer" data-pq="${escapeHtml(pj.qbo_id)}">${escapeHtml(pj.name)}</div>`).join("")
        : `<div class="px-3 py-1.5 text-xs text-black/40">No matching projects</div>`;
      menu.classList.remove("hidden");
      menu.querySelectorAll("[data-pq]").forEach(el => el.addEventListener("mousedown", (e) => {
        e.preventDefault(); picked = { qbo_id: el.getAttribute("data-pq"), name: el.textContent };
        input.value = picked.name; pickedEl.textContent = "→ " + picked.name; menu.classList.add("hidden");
      }));
    } catch (_) { /* ignore */ }
  };
  input.addEventListener("input", () => { picked = null; pickedEl.textContent = ""; clearTimeout(timer); timer = setTimeout(() => search(input.value.trim()), 180); });
  input.addEventListener("focus", () => search(input.value.trim()));
  input.addEventListener("blur", () => setTimeout(() => menu.classList.add("hidden"), 150));   // dismiss on blur (after click registers)

  // Attach the PO to folder 5 as part of the won handoff (step 13).
  const poDrop = overlay.querySelector("[data-podrop]");
  const poInput = overlay.querySelector("[data-poinput]");
  const poStatus = overlay.querySelector("[data-postatus]");
  const uploadPO = async (files) => {
    const arr = [...(files || [])]; if (!arr.length) return;
    poStatus.textContent = "Uploading…";
    try {
      for (const f of arr) { const fd = new FormData(); fd.append("file", f); await api(`/documents/opportunity/${opp.id}?folder=5_purchase_orders`, { method: "POST", body: fd }); }
      poStatus.textContent = `✓ ${arr.length} file${arr.length > 1 ? "s" : ""} attached to “5 Purchase Orders”`;
      if (opp) opp.doc_count = (opp.doc_count || 0) + arr.length;
    } catch (_) { poStatus.textContent = "Upload failed — try again"; }
  };
  poDrop.addEventListener("click", () => poInput.click());
  poInput.addEventListener("change", () => uploadPO(poInput.files));
  poDrop.addEventListener("dragover", (e) => { e.preventDefault(); poDrop.style.borderColor = "#4f7f61"; });
  poDrop.addEventListener("dragleave", () => { poDrop.style.borderColor = ""; });
  poDrop.addEventListener("drop", (e) => { e.preventDefault(); poDrop.style.borderColor = ""; uploadPO(e.dataTransfer?.files); });
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) { close(); onCancel && onCancel(); } });
  overlay.querySelector("[data-cancel]").addEventListener("click", () => { close(); onCancel && onCancel(); });
  overlay.querySelector("[data-skip]")?.addEventListener("click", async () => {
    try { await api(`/opportunities/${opp.id}`, { method: "PATCH", body: JSON.stringify({ status: "won" }) }); close(); onDone && onDone(); }
    catch (err) { setMsg(err.message, false); }
  });
  overlay.querySelector("[data-unlink]")?.addEventListener("click", async () => {
    if (!confirm("Unlink this project from the opportunity? The opportunity stays won.")) return;
    try { await api(`/opportunities/${opp.id}`, { method: "PATCH", body: JSON.stringify({ project_qbo_id: null }) }); close(); onDone && onDone(); }
    catch (err) { setMsg(err.message, false); }
  });
  overlay.querySelector("[data-save]").addEventListener("click", async () => {
    if (!picked) return setMsg("Pick a project, or cancel.", false);
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
      <button data-create class="w-full text-left rounded-xl border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 px-4 py-3">
        <div class="text-sm font-bold text-emerald-800">Create a new estimate →</div>
        <div class="text-xs text-emerald-700/80">Prefills customer, contact, description, dates, and quote # from this RFQ.</div>
      </button>
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

  overlay.querySelector("[data-create]").addEventListener("click", async () => {
    setMsg("Creating…", true);
    try {
      const r = await api(`/opportunities/${opp.id}/start-quote`, { method: "POST" });
      close(); onDone && onDone();
      location.hash = `#/estimate/${r.estimate_id}`;
    } catch (err) { let d = err?.message || "Failed"; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch (_) {} setMsg(d, false); }
  });
}

// ── Edit an opportunity (job / contact / notes / dates) ──────────────────────
function editOpportunityModal(opp, onDone) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4";
  overlay.innerHTML = `
    <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg p-5 max-h-[90vh] overflow-auto">
      <div class="text-base font-bold text-ink-900 mb-0.5">Edit opportunity</div>
      <div class="text-xs text-black/50 mb-3">${escapeHtml(opp.customer_name || "")}${opp.quote_number ? ` · Quote #${escapeHtml(opp.quote_number)}` : ""}</div>
      <div class="space-y-3">
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Job / description</div>
          <input data-f="title" class="input text-sm py-1.5 w-full" value="${escapeHtml(opp.title || "")}"></label>
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Contact</div>
          <select data-f="contact_id" class="input text-sm py-1.5 w-full"><option value="">— loading —</option></select>
          <div class="text-[10px] text-black/40 mt-0.5">${opp.contact_name ? "Current: " + escapeHtml(opp.contact_name) : "No contact set"}</div></label>
        <div class="grid grid-cols-2 gap-2">
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Target start</div>
            <input data-f="target_start_date" type="date" class="input text-sm py-1.5 w-full" value="${escapeHtml((opp.target_start_date || "").slice(0,10))}"></label>
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Target end</div>
            <input data-f="target_end_date" type="date" class="input text-sm py-1.5 w-full" value="${escapeHtml((opp.target_end_date || "").slice(0,10))}"></label>
        </div>
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Notes</div>
          <textarea data-f="notes" rows="3" class="input text-sm py-1.5 w-full">${escapeHtml(opp.notes || "")}</textarea></label>
      </div>
      <div class="mt-4 flex items-center justify-end gap-2">
        <span data-msg class="text-xs font-semibold mr-auto"></span>
        <button data-cancel class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Cancel</button>
        <button data-save class="btn-primary text-sm px-4 py-1.5">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("[data-cancel]").addEventListener("click", close);
  const val = (f) => overlay.querySelector(`[data-f="${f}"]`);
  const setMsg = (t, ok) => { const m = overlay.querySelector("[data-msg]"); m.textContent = t; m.className = "text-xs font-semibold mr-auto " + (ok ? "text-emerald-700" : "text-red-600"); };

  // contacts for this customer
  (async () => {
    const sel = val("contact_id");
    if (!opp.customer_qbo_id) { sel.innerHTML = `<option value="">— link a customer first —</option>`; sel.disabled = true; return; }
    try {
      const list = (await api(`/contacts/customer/${encodeURIComponent(opp.customer_qbo_id)}`)).contacts || [];
      sel.innerHTML = `<option value="">— none —</option>` + list.map(c =>
        `<option value="${c.id}" ${String(c.id) === String(opp.contact_id || "") ? "selected" : ""}>${escapeHtml(c.full_name || "contact")}</option>`).join("");
    } catch (_) { sel.innerHTML = `<option value="">Couldn't load contacts</option>`; }
  })();

  overlay.querySelector("[data-save]").addEventListener("click", async () => {
    const payload = {
      title: val("title").value.trim() || null,
      contact_id: val("contact_id").value ? Number(val("contact_id").value) : null,
      target_start_date: val("target_start_date").value || null,
      target_end_date: val("target_end_date").value || null,
      notes: val("notes").value.trim() || null,
    };
    setMsg("Saving…", true);
    try {
      const r = await api(`/opportunities/${opp.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      close(); onDone && onDone(r.opportunity);
    } catch (err) { let d = err?.message || "Failed"; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch {} setMsg(d, false); }
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
        <div data-drop="${escapeHtml(node.key)}" class="border border-black/10 rounded-xl mb-2 border-dashed border-transparent" style="border-color:rgba(0,0,0,0.1)">
          <div class="flex items-center justify-between px-3 py-2 bg-black/[0.02]">
            <span class="text-xs font-bold text-ink-900">${escapeHtml(node.label)}${list.length ? ` <span class="text-black/40 font-normal">(${list.length})</span>` : ""}</span>
            <label class="inline-flex items-center gap-1 rounded-lg border border-black/10 bg-white px-2 py-1 text-[11px] font-semibold text-black/70 hover:bg-black/5 cursor-pointer">
              Upload<input type="file" multiple class="hidden" data-up="${escapeHtml(node.key)}"></label>
          </div>
          ${list.length ? `<div class="divide-y divide-black/5">${list.map(f => `
            <div class="flex items-center justify-between px-3 py-1.5">
              <button data-dl="${f.id}" class="text-left text-blue-700 hover:underline truncate mr-2">${escapeHtml(f.filename)}</button>
              <div class="flex items-center gap-2 shrink-0">
                <span class="text-[10px] text-black/40">${fmtBytes(f.size_bytes)}</span>
                <button data-rm="${f.id}" class="text-[10px] text-black/35 hover:text-red-600 hover:underline">remove</button>
              </div>
            </div>`).join("")}</div>` : `<div class="px-3 py-3 text-[11px] text-black/35 text-center">Drag files here, or use <b class="font-semibold">Upload</b>.</div>`}
        </div>`;
    }).join("");

    // Shared uploader (used by the file picker AND drag-and-drop). Uploads each
    // file sequentially to the folder, then refreshes.
    const uploadFiles = async (folder, files) => {
      const arr = [...(files || [])]; if (!arr.length) return;
      try {
        for (const file of arr) {
          const fd = new FormData(); fd.append("file", file);
          await api(`/documents/opportunity/${opp.id}?folder=${encodeURIComponent(folder)}`, { method: "POST", body: fd });
        }
        load();
      } catch (err) { alert(err?.message || "Upload failed"); }
    };

    bodyEl.querySelectorAll("[data-up]").forEach(inp => inp.addEventListener("change", () => {
      const label = inp.closest("label"); const orig = label.innerHTML; label.innerHTML = "Uploading…";
      uploadFiles(inp.getAttribute("data-up"), inp.files).finally(() => { label.innerHTML = orig; });
    }));

    // Drag-and-drop: highlight the folder card on dragover, upload on drop.
    bodyEl.querySelectorAll("[data-drop]").forEach(zone => {
      const on = () => { zone.style.borderColor = "#4f7f61"; zone.classList.add("bg-brand-50"); };
      const off = () => { zone.style.borderColor = "rgba(0,0,0,0.1)"; zone.classList.remove("bg-brand-50"); };
      zone.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; on(); });
      zone.addEventListener("dragleave", (e) => { if (!zone.contains(e.relatedTarget)) off(); });
      zone.addEventListener("drop", (e) => {
        e.preventDefault(); off();
        const files = e.dataTransfer?.files;
        if (files && files.length) uploadFiles(zone.getAttribute("data-drop"), files);
      });
    });
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
        <div class="grid grid-cols-3 gap-2">
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">RFQ received</div><input data-f="rfq_received_date" type="date" class="input text-sm py-1.5 w-full"></label>
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Target start</div><input data-f="target_start_date" type="date" class="input text-sm py-1.5 w-full"></label>
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Target end</div><input data-f="target_end_date" type="date" class="input text-sm py-1.5 w-full"></label>
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
      target_end_date: val("target_end_date").value || null,
      estimator_user_id: val("estimator_user_id").value ? Number(val("estimator_user_id").value) : null,
    };
    try { await api(`/opportunities`, { method: "POST", body: JSON.stringify(payload) }); close(); onSaved && onSaved(); }
    catch (err) { let d = err?.message || "Could not save"; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch (_) {} setMsg(d, false); }
  });
}
