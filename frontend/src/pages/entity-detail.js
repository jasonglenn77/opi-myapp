// Entity detail (Phase 2) — per estimate/job/project document workspace that
// mirrors OPI's Google Drive 9-folder structure. Reached by clicking a
// Customers-table row. Folders gated by stage (estimates: 1-5; jobs/projects:
// all). Upload / download / delete per folder. Backed by /api/documents.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import { mountKickoffPanel } from "./kickoff.js";
import { mountDailyPanel } from "./daily.js";
import { mountChangeOrdersPanel } from "./change-orders.js";
import { mountAssignmentPanel } from "./assignment-panel.js";
import { mountBillingPanel, prefetchBilling } from "./billing.js";

const TYPE_STYLE = {
  estimate: "bg-blue-100 text-blue-700",
  job: "bg-violet-100 text-violet-700",
  project: "bg-emerald-100 text-emerald-700",
};
const CHEV = `<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>`;
const FOLDER_ICON = `<svg class="size-4 text-amber-500" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>`;
const FILE_ICON = `<svg class="size-4 text-black/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;
const UPLOAD_ICON = `<svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
const TRASH_ICON = `<svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const DOWNLOAD_ICON = `<svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;

function fmtBytes(bytes) {
  const n = Number(bytes || 0);
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"]; let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
function fmtDate(v) { return v ? String(v).slice(0, 10) : ""; }
const fmtMoney = (n) => (n == null || n === "" ? "—" : "$" + Math.round(Number(n)).toLocaleString());
const fmtPct = (n) => (n == null || n === "" ? "—" : Math.round(Number(n) * 100) + "%");

// Operational status → label + pill (mirrors the Projects hub).
const OP_STATUS = {
  needs_assignment: { label: "Needs assignment", cls: "bg-amber-100 text-amber-800" },
  assigned:         { label: "Assigned",         cls: "bg-slate-200 text-slate-700" },
  scheduled:        { label: "Scheduled",        cls: "bg-sky-100 text-sky-800" },
  in_progress:      { label: "In progress",      cls: "bg-indigo-100 text-indigo-800" },
  complete:         { label: "Complete",         cls: "bg-emerald-100 text-emerald-800" },
  canceled:         { label: "Canceled",         cls: "bg-black/10 text-black/50" },
};
const opStatusBadge = (s) => {
  const m = OP_STATUS[s] || { label: s || "—", cls: "bg-black/10 text-black/50" };
  return `<span class="text-[11px] font-semibold rounded px-2 py-0.5 ${m.cls}">${escapeHtml(m.label)}</span>`;
};

// Where "← Back" should return to. Defaults to Customers, but a page that
// linked here (e.g. the Pipeline's project link) can set `opi_entity_back`
// scoped to this exact entity so we send the user back where they came from,
// preserving that page's remembered view.
function resolveBackLink(entityType, entityId) {
  try {
    const b = JSON.parse(sessionStorage.getItem("opi_entity_back") || "null");
    if (b && b.entity === `${entityType}/${entityId}` && b.hash && b.label) {
      return { hash: b.hash, label: b.label };
    }
  } catch (_) {}
  return { hash: "#/customers", label: "Customers" };
}

export async function entityDetailPage(routeFn, { entityType, entityId }) {
  const back = resolveBackLink(entityType, entityId);
  let data;
  try { data = await api(`/documents/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`); }
  catch (e) {
    mount(`<div class="w-full"><div class="card p-5 text-sm text-red-700">Failed to load documents: ${escapeHtml(e?.message || String(e))}</div><div class="mt-3"><a href="${back.hash}" class="text-sm font-semibold text-blue-600 hover:underline">← Back to ${escapeHtml(back.label)}</a></div></div>`, routeFn);
    return;
  }
  const entity = data.entity || {};
  const tree = data.tree || [];
  let files = data.files || {};                       // { folderKey: [ {id, filename, ...} ] }
  const expanded = new Set();                          // all folders collapsed by default

  // count files within a node, including descendants (so container folders show totals)
  const countDeep = (node) => {
    let n = (files[node.key] || []).length;
    (node.children || []).forEach(c => { n += countDeep(c); });
    return n;
  };

  const fileRow = (f) => `
    <div class="flex items-center gap-2 py-1.5 pr-2 group">
      ${FILE_ICON}
      <div class="min-w-0 flex-1">
        <div class="truncate text-xs font-medium text-ink-900" title="${escapeHtml(f.filename || "")}">${escapeHtml(f.filename || "(unnamed)")}</div>
        <div class="text-[10px] text-black/45">${fmtBytes(f.size_bytes)}${f.created_at ? " · " + fmtDate(f.created_at) : ""}${f.uploaded_by ? " · " + escapeHtml(f.uploaded_by) : ""}</div>
      </div>
      <button type="button" data-dl="${f.id}" title="Download" class="inline-flex h-7 w-7 items-center justify-center rounded-lg text-black/45 hover:bg-black/5 hover:text-blue-600">${DOWNLOAD_ICON}</button>
      <button type="button" data-del="${f.id}" data-dname="${escapeHtml(f.filename || "")}" title="Delete" class="inline-flex h-7 w-7 items-center justify-center rounded-lg text-black/40 hover:bg-red-50 hover:text-red-600">${TRASH_ICON}</button>
    </div>`;

  const renderNode = (node, depth) => {
    const open = expanded.has(node.key);
    const fls = files[node.key] || [];
    const deep = countDeep(node);
    const subCount = (node.children || []).length;
    const hasKids = subCount > 0;
    const pad = 8 + depth * 18;
    const folderBadge = subCount ? `<span class="ml-2 inline-flex rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">${subCount} folder${subCount === 1 ? "" : "s"}</span>` : "";
    const fileBadge = deep ? `<span class="ml-1.5 inline-flex rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-black/55">${deep} file${deep === 1 ? "" : "s"}</span>` : "";
    return `
      <div data-node="${escapeHtml(node.key)}">
        <div class="flex items-center gap-2 border-b border-black/5 py-2 hover:bg-black/[0.015]" style="padding-left:${pad}px;padding-right:8px">
          <button type="button" data-toggle="${escapeHtml(node.key)}" class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-black/40 hover:bg-black/5">
            <span class="inline-flex transition-transform ${open ? "rotate-90" : ""}">${CHEV}</span>
          </button>
          ${FOLDER_ICON}
          <button type="button" data-toggle="${escapeHtml(node.key)}" class="min-w-0 flex-1 text-left">
            <span class="text-xs font-bold text-ink-900">${escapeHtml(node.label)}</span>${folderBadge}${fileBadge}
          </button>
          <button type="button" data-up="${escapeHtml(node.key)}" class="inline-flex items-center gap-1 rounded-lg border border-black/10 bg-white px-2 py-1 text-[11px] font-semibold text-black/70 hover:bg-black/5">${UPLOAD_ICON} Upload</button>
        </div>
        <div data-body="${escapeHtml(node.key)}" class="${open ? "" : "hidden"}">
          ${fls.length ? `<div style="padding-left:${pad + 26}px">${fls.map(fileRow).join("")}</div>`
            : (!hasKids ? `<div class="text-[11px] text-black/35 py-1.5" style="padding-left:${pad + 26}px">No files yet.</div>` : "")}
          ${(node.children || []).map(c => renderNode(c, depth + 1)).join("")}
        </div>
      </div>`;
  };

  const renderTree = () => {
    const host = document.getElementById("docTree");
    if (host) host.innerHTML = tree.map(n => renderNode(n, 0)).join("");
  };

  const refetch = async () => {
    const d = await api(`/documents/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`);
    files = d.files || {};
    renderTree();
  };

  const typeBadge = `<span class="inline-flex rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TYPE_STYLE[entityType] || "bg-black/10 text-black/50"}">${escapeHtml(entityType)}</span>`;
  const isProject = entityType === "project";   // only projects get the Kickoff tab
  let activeTab = "documents";

  mount(`
    <div class="w-full">
      <div class="mb-3">
        <a href="${back.hash}" class="inline-flex items-center gap-1 text-xs font-semibold text-white/60 hover:text-white">← Back to ${escapeHtml(back.label)}</a>
      </div>
      <div class="card flex flex-col overflow-hidden" style="height: calc(100vh - 150px); min-height: 420px;">
        <div class="shrink-0 px-4 sm:px-5 pt-4 border-b border-black/10">
          <div class="flex items-center gap-2 flex-wrap">
            ${typeBadge}
            <div class="text-base font-extrabold text-ink-900">${escapeHtml(entity.name || "Entity")}</div>
          </div>
          <div class="text-xs text-black/50 mt-0.5 ${isProject ? "mb-2" : "pb-3"}">${escapeHtml(entity.customer_name || "")}</div>
          ${isProject ? `<div id="tabBar" class="flex gap-1 -mb-px"></div>` : ""}
        </div>
        <div id="tabBody" class="flex-1 overflow-auto"></div>
      </div>
    </div>`, routeFn);

  // ── documents tab ───────────────────────────────────────────────────────────
  function attachDocHandlers() {
    const host = document.getElementById("docTree");
    if (!host) return;
    host.addEventListener("click", async (e) => {
      const tog = e.target.closest("[data-toggle]");
      if (tog) {
        const k = tog.getAttribute("data-toggle");
        expanded.has(k) ? expanded.delete(k) : expanded.add(k);
        renderTree();
        return;
      }
      const up = e.target.closest("[data-up]");
      if (up) {
        const folder = up.getAttribute("data-up");
        const input = document.createElement("input");
        input.type = "file";
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return;
          const fd = new FormData();
          fd.append("file", file);
          up.disabled = true; up.textContent = "Uploading…";
          try {
            await api(`/documents/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}?folder=${encodeURIComponent(folder)}`, { method: "POST", body: fd });
            expanded.add(folder);
            await refetch();
          } catch (err) { alert(`Upload failed: ${err.message}`); renderTree(); }
        };
        input.click();
        return;
      }
      const dl = e.target.closest("[data-dl]");
      if (dl) {
        try {
          const res = await api(`/documents/file/${dl.getAttribute("data-dl")}/url`);
          if (res.url) window.open(res.url, "_blank");
        } catch (err) { alert(`Could not open file: ${err.message}`); }
        return;
      }
      const del = e.target.closest("[data-del]");
      if (del) {
        const name = del.getAttribute("data-dname") || "this file";
        if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
        try {
          await api(`/documents/file/${del.getAttribute("data-del")}`, { method: "DELETE" });
          await refetch();
        } catch (err) { alert(`Delete failed: ${err.message}`); }
        return;
      }
    });
  }

  function showDocuments() {
    const body = document.getElementById("tabBody");
    body.innerHTML = `<div id="docTree"></div>`;
    renderTree();
    attachDocHandlers();
  }

  function showKickoff() {
    const body = document.getElementById("tabBody");
    body.innerHTML = "";
    mountKickoffPanel(body, entityId);
  }

  function showDaily() {
    const body = document.getElementById("tabBody");
    body.innerHTML = "";
    mountDailyPanel(body, entityId);
  }

  function showBilling() {
    const body = document.getElementById("tabBody");
    body.innerHTML = "";
    mountBillingPanel(body, entityId);
  }

  function showChangeOrders() {
    const body = document.getElementById("tabBody");
    body.innerHTML = "";
    mountChangeOrdersPanel(body, entityId);
  }

  // ── overview tab (Projects-hub Phase 2: the project's operational snapshot) ──
  let _ovProj = null, _ovFin = null;   // cached across tab switches
  async function ensureProjectData() {
    if (_ovProj === null) {
      const [pb, ff] = await Promise.all([
        api("/projects/basic"),
        api("/projects/financials").catch(() => ({ financials: [] })),
      ]);
      _ovProj = (pb.projects || []).find(p => String(p.project_qbo_id) === String(entityId)) || {};
      _ovFin = (ff.financials || []).find(f => String(f.qbo_customer_id) === String(_ovProj.qbo_customer_id)) || {};
    }
    return _ovProj;
  }
  async function showOverview() {
    const body = document.getElementById("tabBody");
    body.innerHTML = `<div class="p-4 text-sm text-black/40">Loading…</div>`;
    try {
      await ensureProjectData();
      if (activeTab !== "overview") return; // user switched tabs while loading — don't clobber
      body.innerHTML = overviewHtml(_ovProj, _ovFin);
      wireOverview();
    } catch (e) {
      if (activeTab !== "overview") return;
      body.innerHTML = `<div class="p-4 text-sm text-red-600">Failed to load overview: ${escapeHtml(e?.message || String(e))}</div>`;
    }
  }
  async function showAssignment() {
    const body = document.getElementById("tabBody");
    body.innerHTML = `<div class="p-4 text-sm text-black/40">Loading…</div>`;
    try {
      const proj = await ensureProjectData();
      if (activeTab !== "assignment") return; // switched away while loading
      if (!proj || !proj.qbo_customer_id) {
        body.innerHTML = `<div class="p-4 text-sm text-black/50">This project isn't linked to an assignable record yet.</div>`;
        return;
      }
      body.innerHTML = "";
      // On any assignment change, invalidate the overview cache so its
      // operational status / PM / crew refresh when revisited.
      mountAssignmentPanel(body, proj.qbo_customer_id, () => { _ovProj = null; });
    } catch (e) {
      body.innerHTML = `<div class="p-4 text-sm text-red-600">Failed to load assignment: ${escapeHtml(e?.message || String(e))}</div>`;
    }
  }
  function overviewHtml(p, f) {
    const fact = (label, val, opts = {}) => `
      <div>
        <div class="text-[10px] font-bold uppercase tracking-wide text-black/40">${escapeHtml(label)}</div>
        <div class="text-sm font-semibold ${opts.color || "text-ink-900"} mt-0.5">${val}</div>
      </div>`;
    const dash = (s) => (s == null || s === "" ? "—" : escapeHtml(String(s)));
    const value = f ? (Number(f.invoice_line_amt) || Number(f.estimate_line_amt) || 0) : null;
    const quote = p.linked_quote_number
      ? `<button data-view-quote="${escapeHtml(String(p.linked_quote_number))}" class="text-blue-700 hover:underline font-semibold">#${escapeHtml(String(p.linked_quote_number))} →</button>`
      : `<span class="text-black/40">— not linked</span>`;
    return `
      <div class="p-4 sm:p-5 max-w-4xl">
        <div class="flex items-center gap-3 mb-4">
          ${opStatusBadge(p.operational_status)}
          <span class="text-xs text-black/45">Operational status (assignment lifecycle)</span>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
          ${fact("Start", dash(fmtDate(p.start_date)))}
          ${fact("End", dash(fmtDate(p.end_date)))}
          ${fact("Linked quote", quote)}
          ${fact("Project Manager", dash(p.all_project_managers || p.primary_project_manager))}
          ${fact("Work Crew", dash(p.all_work_crews || p.primary_work_crew))}
          ${fact("Documents", `${p.file_count || 0} file${(p.file_count || 0) === 1 ? "" : "s"}`)}
          ${fact("Contract / Value", fmtMoney(value))}
          ${fact("Actual profit", fmtMoney(f?.actual_profit), { color: (Number(f?.actual_profit) || 0) >= 0 ? "text-emerald-700" : "text-red-600" })}
          ${fact("Actual margin", fmtPct(f?.actual_profit_pct))}
        </div>
        <div class="mt-5 pt-4 border-t border-black/10 flex flex-wrap gap-2">
          <button type="button" data-goto="financials" class="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold text-ink-900 hover:bg-black/5">Financials →</button>
          <button type="button" data-goto="billing" class="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold text-ink-900 hover:bg-black/5">Schedule →</button>
        </div>
      </div>`;
  }
  // Financial Breakdown by Item Type — Contract / Cost / Profit per item, with
  // drill-down to the underlying transactions. Mirrors the Financials page modal.
  const ITEM_ORDER = ["Contract Labor", "Materials", "Mgmt Travel", "Lodging", "Buffer", "Rentals", "Propane"];
  function financialsBreakdownHtml(d, f) {
    const est = d.estimate_line || {}, cost = d.estimate_cost || {}, inv = d.invoice_line || {}, exp = d.expense_line || {};
    const names = d.items || [];
    if (!names.length) return `<div class="p-4 sm:p-5 text-sm text-black/50">No item-type financial data for this project yet.</div>`;
    const ordered = [...ITEM_ORDER.filter((i) => names.includes(i)), ...names.filter((i) => !ITEM_ORDER.includes(i))];
    const N = (o, k) => Number(o[k] || 0);
    const m = (v) => (Math.abs(v) < 0.5 ? "—" : "$" + Math.round(v).toLocaleString("en-US"));
    const signed = (v, goodPositive = true) => {
      if (Math.abs(v) < 0.5) return `<span class="text-black/25">—</span>`;
      const good = goodPositive ? v >= 0 : v <= 0;
      return `<span class="${good ? "text-emerald-700" : "text-red-600"} font-semibold">${v >= 0 ? "+" : "−"}$${Math.abs(Math.round(v)).toLocaleString("en-US")}</span>`;
    };
    const pctTxt = (v) => (v == null ? "" : ` <span class="text-[10px] text-black/40">(${v >= 0 ? "" : "-"}${Math.abs(v).toFixed(1)}%)</span>`);

    // per-item + running totals
    let tEst = 0, tInv = 0, tCost = 0, tExp = 0;
    const rowsHtml = ordered.map((it) => {
      const e = N(est, it), i = N(inv, it), c = N(cost, it), x = N(exp, it);
      tEst += e; tInv += i; tCost += c; tExp += x;
      const contractDiff = i - e, contractPct = e ? (contractDiff / e) * 100 : null;
      const costDiff = c - x, costPct = c ? ((x - c) / c) * 100 : null;
      const projP = e - c, projPct = e ? (projP / e) * 100 : null;
      const actP = i - x, actPct = i ? (actP / i) * 100 : null;
      const hasDetail = e || i || c || x;
      return `
        <tr class="border-b border-black/5 hover:bg-black/[0.015]">
          <td class="py-1.5 pl-3 pr-2 whitespace-nowrap">${hasDetail ? `<button data-fin-item="${escapeHtml(it)}" class="text-black/25 hover:text-black/60 mr-1 align-middle"><svg data-fin-chev class="w-3 h-3 inline transition-transform" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg></button>` : `<span class="inline-block w-4"></span>`}<span class="font-semibold text-ink-900">${escapeHtml(it)}</span></td>
          <td class="py-1.5 px-2 text-right tabular-nums bg-slate-50">${m(e)}</td>
          <td class="py-1.5 px-2 text-right tabular-nums bg-slate-50">${m(i)}</td>
          <td class="py-1.5 px-2 text-right tabular-nums bg-slate-50">${signed(contractDiff)}${pctTxt(contractPct)}</td>
          <td class="py-1.5 px-2 text-right tabular-nums bg-orange-50/60">${m(c)}</td>
          <td class="py-1.5 px-2 text-right tabular-nums bg-orange-50/60">${m(x)}</td>
          <td class="py-1.5 px-2 text-right tabular-nums bg-orange-50/60">${signed(costDiff)}${pctTxt(costPct)}</td>
          <td class="py-1.5 px-2 text-right tabular-nums bg-emerald-50/60">${signed(projP)}${pctTxt(projPct)}</td>
          <td class="py-1.5 pr-3 px-2 text-right tabular-nums bg-emerald-50/60">${signed(actP)}${pctTxt(actPct)}</td>
        </tr>
        <tr data-fin-lines="${escapeHtml(it)}" hidden><td colspan="9" class="bg-black/[0.02] px-4 py-2 border-b border-black/5"><div data-fin-lines-body class="text-[11px] text-black/50">Loading…</div></td></tr>`;
    }).join("");

    const tcDiff = tInv - tEst, tcostDiff = tCost - tExp, tproj = tEst - tCost, tact = tInv - tExp;
    const th = (t, cls = "") => `<th class="py-1.5 px-2 text-right text-[10px] font-bold text-black/50 ${cls}">${t}</th>`;
    return `
      <div class="p-4 sm:p-5">
        <div class="mb-3">
          <div class="text-base font-extrabold text-ink-900">Financial Breakdown by Item Type</div>
          <div class="text-xs text-black/50 mt-0.5">Estimate vs. invoice vs. actual cost, by line-item type. Click an item to drill into its transactions.</div>
        </div>
        <div class="card overflow-x-auto">
          <table class="w-full text-[12px]" style="min-width:900px">
            <thead>
              <tr class="border-b border-black/10">
                <th class="py-1.5 pl-3 text-left text-[10px] font-bold text-black/40">Item</th>
                <th colspan="3" class="py-1.5 text-center text-[10px] font-extrabold uppercase tracking-wide text-slate-500 bg-slate-100">Contract</th>
                <th colspan="3" class="py-1.5 text-center text-[10px] font-extrabold uppercase tracking-wide text-orange-700/70 bg-orange-100/70">Cost</th>
                <th colspan="2" class="py-1.5 text-center text-[10px] font-extrabold uppercase tracking-wide text-emerald-700/80 bg-emerald-100/70">Profit</th>
              </tr>
              <tr class="border-b border-black/10">
                <th></th>
                ${th("Estimate", "bg-slate-50")}${th("Invoice", "bg-slate-50")}${th("Difference", "bg-slate-50")}
                ${th("Est. Cost Basis", "bg-orange-50/60")}${th("Expense", "bg-orange-50/60")}${th("Difference", "bg-orange-50/60")}
                ${th("Projected Profit", "bg-emerald-50/60")}${th("Actual Profit", "bg-emerald-50/60 pr-3")}
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
            <tfoot>
              <tr class="border-t-2 border-black/15 font-bold">
                <td class="py-2 pl-3 text-ink-900">Total</td>
                <td class="py-2 px-2 text-right tabular-nums bg-slate-100">${m(tEst)}</td>
                <td class="py-2 px-2 text-right tabular-nums bg-slate-100">${m(tInv)}</td>
                <td class="py-2 px-2 text-right tabular-nums bg-slate-100">${signed(tcDiff)}${pctTxt(tEst ? (tcDiff / tEst) * 100 : null)}</td>
                <td class="py-2 px-2 text-right tabular-nums bg-orange-100/70">${m(tCost)}</td>
                <td class="py-2 px-2 text-right tabular-nums bg-orange-100/70">${m(tExp)}</td>
                <td class="py-2 px-2 text-right tabular-nums bg-orange-100/70">${signed(tcostDiff)}${pctTxt(tCost ? ((tExp - tCost) / tCost) * 100 : null)}</td>
                <td class="py-2 px-2 text-right tabular-nums bg-emerald-100/70">${signed(tproj)}${pctTxt(tEst ? (tproj / tEst) * 100 : null)}</td>
                <td class="py-2 pr-3 px-2 text-right tabular-nums bg-emerald-100/70">${signed(tact)}${pctTxt(tInv ? (tact / tInv) * 100 : null)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div class="text-[11px] text-black/40 mt-3">Contract Difference = invoiced − estimated · Cost Difference = estimated cost − actual expense (green = under) · same figures as the Financials page, scoped to this project.</div>
      </div>`;
  }

  function wireFinancials() {
    const body = document.getElementById("tabBody");
    const cache = {};
    body?.querySelectorAll("[data-fin-item]").forEach((btn) => btn.addEventListener("click", async () => {
      const it = btn.getAttribute("data-fin-item");
      const row = body.querySelector(`[data-fin-lines="${CSS.escape(it)}"]`);
      const chev = btn.querySelector("[data-fin-chev]");
      if (!row) return;
      const opening = row.hidden;
      row.hidden = !opening;
      if (chev) chev.style.transform = opening ? "rotate(90deg)" : "";
      if (!opening) return;
      const bodyEl = row.querySelector("[data-fin-lines-body]");
      if (cache[it]) { bodyEl.innerHTML = cache[it]; return; }
      try {
        const r = await api("/projects/financials/by-item/lines", { method: "POST", body: JSON.stringify({ project_qbo_ids: [String(entityId)], item_name: it, kind: "expense" }) });
        const lines = r.lines || [];
        cache[it] = lines.length
          ? `<table class="w-full text-[11px]"><thead><tr class="text-left text-black/40"><th class="py-1 pr-3 font-bold">Date</th><th class="py-1 pr-3 font-bold">Vendor / source</th><th class="py-1 pr-3 font-bold">Description</th><th class="py-1 text-right font-bold">Amount</th></tr></thead><tbody>${lines.map((l) => `<tr class="border-t border-black/5"><td class="py-1 pr-3 tabular-nums text-black/60">${escapeHtml(String(l.txn_date || l.date || "—").slice(0, 10))}</td><td class="py-1 pr-3">${escapeHtml(l.vendor || l.name || "—")}</td><td class="py-1 pr-3 text-black/55 max-w-[300px] truncate">${escapeHtml(l.description || "")}</td><td class="py-1 text-right tabular-nums font-semibold">$${Math.round(Number(l.amount || 0)).toLocaleString("en-US")}</td></tr>`).join("")}</tbody></table>`
          : `<span class="text-black/40">No actual-expense transactions for ${escapeHtml(it)} yet.</span>`;
        bodyEl.innerHTML = cache[it];
      } catch (e) { bodyEl.innerHTML = `<span class="text-red-600">Failed to load detail.</span>`; }
    }));
  }

  async function showFinancials() {
    const body = document.getElementById("tabBody");
    body.innerHTML = `<div class="p-4 text-sm text-black/40">Loading financials…</div>`;
    try {
      const d = await api("/projects/financials/by-item", { method: "POST", body: JSON.stringify({ project_qbo_ids: [String(entityId)] }) });
      if (activeTab !== "financials") return;
      body.innerHTML = financialsBreakdownHtml(d, _ovFin);
      wireFinancials();
    } catch (e) {
      if (activeTab !== "financials") return;
      body.innerHTML = `<div class="p-4 text-sm text-red-600">Failed to load financials: ${escapeHtml(e?.message || String(e))}</div>`;
    }
  }
  function wireOverview() {
    const body = document.getElementById("tabBody");
    body?.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => goTab(b.getAttribute("data-goto"))));
    body?.querySelector("[data-view-quote]")?.addEventListener("click", (e) => {
      const q = e.currentTarget.getAttribute("data-view-quote");
      // Focus the Pipeline on this quote (merge into its remembered view).
      try {
        const v = JSON.parse(sessionStorage.getItem("opi_pipeline_view") || "{}") || {};
        v.searchQ = q; v.statusFilter = ""; v.page = 0;
        sessionStorage.setItem("opi_pipeline_view", JSON.stringify(v));
      } catch (_) {}
      location.hash = "#/pipeline";
    });
  }

  function goTab(t) {
    if (t === activeTab) return;
    activeTab = t; renderTabs();
    if (t === "overview") showOverview();
    else if (t === "assignment") showAssignment();
    else if (t === "kickoff") showKickoff();
    else if (t === "daily") showDaily();
    else if (t === "changeorders") showChangeOrders();
    else if (t === "billing") showBilling();
    else if (t === "financials") showFinancials();
    else showDocuments();
  }

  function renderTabs() {
    const bar = document.getElementById("tabBar");
    if (!bar) return;
    const btn = (key, label) => `<button type="button" data-tab="${key}" class="px-3 py-2 text-xs font-bold border-b-2 ${activeTab === key ? "border-blue-600 text-ink-900" : "border-transparent text-black/40 hover:text-black/70"}">${label}</button>`;
    bar.innerHTML = btn("overview", "Overview") + btn("assignment", "Assignment") + btn("documents", "Documents") + btn("kickoff", "Kickoff &amp; Process") + btn("daily", "Daily Log") + btn("changeorders", "Change Orders") + btn("billing", "Billing &amp; Schedule") + btn("financials", "Financials");
    bar.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => goTab(b.getAttribute("data-tab"))));
  }

  // Projects land on Overview; other entity types keep the Documents view.
  if (isProject) {
    // A caller (e.g. the Projects hub's "Kick-off →" link) can request a
    // specific opening tab via a one-shot sessionStorage hint.
    let wantTab = null;
    try { wantTab = sessionStorage.getItem("opi_entity_tab"); sessionStorage.removeItem("opi_entity_tab"); } catch (_) {}
    const TABS = ["overview", "assignment", "documents", "kickoff", "daily", "changeorders", "billing", "financials"];
    activeTab = "overview";
    renderTabs();
    showOverview();
    prefetchBilling(entityId); // warm the Billing & Schedule bundle in the background
    if (wantTab && TABS.includes(wantTab) && wantTab !== "overview") goTab(wantTab);
  } else {
    showDocuments();
  }
}

function mount(bodyHtml, routeFn) {
  setShell({ title: "", subtitle: "", bodyHtml, showLogout: true, routeFn });
  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => { if (pageTitleBlock) pageTitleBlock.style.display = ""; }, { once: true });
  }
}
