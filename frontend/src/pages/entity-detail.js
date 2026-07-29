// Entity detail (Phase 2) — per estimate/job/project document workspace that
// mirrors OPI's Google Drive 9-folder structure. Reached by clicking a
// Customers-table row. Folders gated by stage (estimates: 1-5; jobs/projects:
// all). Upload / download / delete per folder. Backed by /api/documents.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import { mountKickoffPanel } from "./kickoff.js";
import { mountDailyPanel } from "./daily.js";
import { mountPaymentsPanel } from "./payments.js";
import { mountChangeOrdersPanel } from "./change-orders.js";

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

  function showPayments() {
    const body = document.getElementById("tabBody");
    body.innerHTML = "";
    mountPaymentsPanel(body, entityId);
  }

  function showChangeOrders() {
    const body = document.getElementById("tabBody");
    body.innerHTML = "";
    mountChangeOrdersPanel(body, entityId);
  }

  function renderTabs() {
    const bar = document.getElementById("tabBar");
    if (!bar) return;
    const btn = (key, label) => `<button type="button" data-tab="${key}" class="px-3 py-2 text-xs font-bold border-b-2 ${activeTab === key ? "border-blue-600 text-ink-900" : "border-transparent text-black/40 hover:text-black/70"}">${label}</button>`;
    bar.innerHTML = btn("documents", "Documents") + btn("kickoff", "Kickoff &amp; Process") + btn("daily", "Daily Log") + btn("changeorders", "Change Orders") + btn("payments", "Payments");
    bar.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => {
      const t = b.getAttribute("data-tab");
      if (t === activeTab) return;
      activeTab = t; renderTabs();
      if (t === "kickoff") showKickoff();
      else if (t === "daily") showDaily();
      else if (t === "changeorders") showChangeOrders();
      else if (t === "payments") showPayments();
      else showDocuments();
    }));
  }

  if (isProject) renderTabs();
  showDocuments();
}

function mount(bodyHtml, routeFn) {
  setShell({ title: "", subtitle: "", bodyHtml, showLogout: true, routeFn });
  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => { if (pageTitleBlock) pageTitleBlock.style.display = ""; }, { once: true });
  }
}
