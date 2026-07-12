// Estimates (tracking) — full-width table (Projects-style: dual-axis scroll,
// sticky header, per-column fixed-portal filters) on desktop, card list on
// mobile. Inline editing throughout (status + owner via menus, contact log via
// an expandable row) — no modal. Create tool stays at #/estimate.
import { api, getMe } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

const STATUS_COLORS = {
  "": "bg-sky-100 text-sky-800",
  "0% Lost": "bg-red-100 text-red-700",
  "0% Inactive": "bg-orange-100 text-orange-700",
  "20% Verbal - Budgetary, Project Uncertain": "bg-yellow-100 text-yellow-800",
  "40% Competitive, Multiple Bidders": "bg-sky-100 text-sky-800",
  "60% Project Confirmed, Customer Well-Positioned": "bg-blue-700 text-white",
  "80% Verbal Approval, Very likely to Receive Order": "bg-purple-100 text-purple-800",
  "80% Red Flag > Goes to Ops Tab": "bg-red-700 text-white",
  "100% Won > Goes to Ops Tab": "bg-green-700 text-white",
};
const statusColors = (k) => STATUS_COLORS[k || ""] || "bg-sky-100 text-sky-800";
const FUNNEL = (a) => `<svg class="size-3.5 ${a ? "text-blue-600" : "text-black/30"}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>`;
const CHEV = `<svg class="size-4 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>`;

export async function estimateTrackingPage(routeFn) {
  const me = getMe();
  let data, lookups, estimators = [], showAll = false;
  const load = async () => { data = await api(`/estimates/tracking${showAll ? "?show_all=1" : ""}`); };
  try {
    [, lookups, estimators] = await Promise.all([
      load(), api("/quoting/lookup-values").catch(() => ({})), api("/estimates/estimators").catch(() => []),
    ]);
  } catch (e) {
    mount(`<div class="w-full"><div class="card p-5 text-sm text-red-700">Failed to load estimates: ${escapeHtml(e.message || e)}</div></div>`, routeFn);
    return;
  }

  const STATUS_OPTS = (lookups.estimate_pipeline_status || []).map(o => o.key);
  const COMM_OPTS = (lookups.communication_type || []).map(o => o.key);
  let rows = data.estimates || [];
  let sortKey = "txn_date", sortDir = -1, search = "", expandedRow = null, editingContact = null;
  const filters = {};
  const contactsCache = {};   // eid -> [contacts] | undefined (loading)

  const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
  const ymd = (s) => (s ? String(s).slice(0, 10) : "—");

  const COLS = [
    { key: "est_no", label: "Est #", type: "text", w: 92, td: (r) => `<span class="font-mono text-black/60 tabular-nums">${escapeHtml(r.est_no || "—")}</span>${r.app_estimate_id && !r.is_draft ? ` <a href="#/estimate/${r.app_estimate_id}" class="text-blue-600 hover:text-blue-800 align-middle" title="Open quote in Quoting Metrics">✎</a>` : ""}` },
    { key: "customer_name", label: "Customer", type: "text", w: 150, trunc: true, td: (r) => `<span class="font-semibold text-ink-900">${escapeHtml(r.customer_name || "—")}</span>` },
    { key: "description", label: "Description", type: "text", w: 230, trunc: true, td: (r) => `<span class="text-black/60">${escapeHtml(r.description || "")}</span>` },
    { key: "amount", label: "Amount", type: "num", w: 100, align: "right", td: (r) => `<span class="font-semibold text-ink-900 tabular-nums">${money(r.amount)}</span>` },
    { key: "opi_status", label: "OPI status", type: "multi", w: 188, td: (r) => statusPill(r) },
    { key: "qbo_status", label: "QBO", type: "multi", w: 82, td: (r) => `<span class="text-black/50">${escapeHtml(r.qbo_status || "—")}</span>` },
    { key: "last_contact_date", label: "Last contact", type: "date", w: 112, td: (r) => r.contact_count ? `<span class="tabular-nums text-black/60">${ymd(r.last_contact_date)} <span class="text-black/40">(${r.contact_count})</span></span>` : `<span class="text-black/30">none</span>` },
    { key: "owner_name", label: "Owner", type: "multi", w: 132, td: (r) => ownerBtn(r) },
    { key: "txn_date", label: "Date", type: "date", w: 96, td: (r) => `<span class="text-black/50 tabular-nums">${ymd(r.txn_date)}</span>` },
  ];
  const EXPAND_W = 52;
  const draftLabel = (r) => r.draft_status === "ready_for_qbo" ? "Ready for QBO" : "Draft";
  const dispVal = (r, key) => key === "opi_status" ? (r.is_draft ? draftLabel(r) : (r.opi_status || "— none —"))
    : key === "owner_name" ? (r.owner_name || "— Unassigned —") : (r[key] || "");
  const multiOptions = (key) => {
    if (key === "opi_status") return ["Draft", "Ready for QBO", "— none —", ...STATUS_OPTS];
    const set = new Set(); rows.forEach(r => { const v = dispVal(r, key); if (v) set.add(v); });
    return [...set].sort();
  };

  const draftBadge = (r) => `<span class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${r.draft_status === "ready_for_qbo" ? "bg-amber-100 text-amber-700" : "bg-black/10 text-black/60"}">${r.draft_status === "ready_for_qbo" ? "Ready for QBO" : "Draft"}</span>`;
  const statusPill = (r) => r.is_draft ? draftBadge(r) : `<button type="button" data-status-pill="${escapeHtml(r.qbo_estimate_id)}"
      class="${statusColors(r.opi_status)} inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold leading-snug text-left hover:opacity-85 max-w-full truncate ${r.opi_status ? "" : "opacity-70"}"
      title="${escapeHtml(r.opi_status || "Set status")}">${escapeHtml(r.opi_status || "Set status")}</button>`;
  const ownerBtn = (r) => r.is_draft ? `<span class="text-black/30">—</span>` : `<button type="button" data-owner="${escapeHtml(r.qbo_estimate_id)}"
      class="text-left text-black/70 hover:text-ink-900 hover:underline decoration-dotted underline-offset-2 truncate max-w-full"
      title="${escapeHtml(r.owner_name || "Unassigned")}">${escapeHtml(r.owner_name || "— assign —")}</button>`;

  // ---- portals (fixed, escape scroll clipping) ----
  const closePortals = () => { document.getElementById("filterPortal")?.remove(); document.getElementById("menuPortal")?.remove(); };
  function placePortal(portal, anchor, w) {
    const rect = anchor.getBoundingClientRect();
    let left = rect.left; if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    let top = rect.bottom + 4; const maxTop = window.innerHeight - 60; if (top > maxTop) top = Math.max(8, rect.top - 4 - 240);
    portal.style.cssText = `top:${top}px; left:${left}px; width:${w}px;`;
  }
  function openStatusPortal(eid, anchor) {
    closePortals();
    const r = rows.find(x => x.qbo_estimate_id === eid); if (!r) return;
    const portal = document.createElement("div");
    portal.id = "menuPortal"; portal.className = "fixed z-[200] rounded-xl border border-black/10 bg-white p-2 shadow-xl max-h-[60vh] overflow-auto text-ink-900";
    portal.innerHTML = ["", ...STATUS_OPTS].map(k => `<button type="button" data-opt="${escapeHtml(k)}" class="${statusColors(k)} block w-full text-left rounded-full px-3 py-1.5 text-xs font-semibold mb-1 hover:opacity-85">${escapeHtml(k || "— clear —")}</button>`).join("");
    document.body.appendChild(portal); placePortal(portal, anchor, 288);
    portal.querySelectorAll("[data-opt]").forEach(b => b.addEventListener("click", async () => {
      const val = b.dataset.opt; r.opi_status = val; r.is_tracked = true; closePortals(); renderRows();
      try { await api(`/estimates/tracking/${eid}`, { method: "PATCH", body: JSON.stringify({ status: val }) }); } catch (_) {}
    }));
  }
  function openOwnerPortal(eid, anchor) {
    closePortals();
    const r = rows.find(x => x.qbo_estimate_id === eid); if (!r) return;
    const portal = document.createElement("div");
    portal.id = "menuPortal"; portal.className = "fixed z-[200] rounded-xl border border-black/10 bg-white p-1 shadow-xl max-h-[60vh] overflow-auto text-ink-900";
    const opts = [{ id: "", name: "— Unassigned —" }, ...estimators];
    portal.innerHTML = opts.map(u => `<button type="button" data-owner-opt="${u.id}" class="block w-full text-left rounded-lg px-3 py-1.5 text-sm text-ink-900 hover:bg-black/5 ${String(r.owner_user_id ?? "") === String(u.id) ? "font-bold bg-black/5" : ""}">${escapeHtml(u.name)}</button>`).join("");
    document.body.appendChild(portal); placePortal(portal, anchor, 240);
    portal.querySelectorAll("[data-owner-opt]").forEach(b => b.addEventListener("click", async () => {
      const val = b.dataset.ownerOpt ? parseInt(b.dataset.ownerOpt, 10) : null;
      r.owner_user_id = val; r.owner_name = val ? b.textContent : null; closePortals(); renderRows();
      try { await api(`/estimates/tracking/${eid}`, { method: "PATCH", body: JSON.stringify({ owner_user_id: val }) }); } catch (_) {}
    }));
  }
  function openFilterPortal(key, anchor) {
    closePortals();
    const col = COLS.find(c => c.key === key); if (!col) return;
    const footer = `<div class="mt-2.5 flex justify-end gap-1.5"><button type="button" data-fclear class="rounded-lg border border-black/10 px-2.5 py-1 text-xs font-semibold hover:bg-black/5">Clear</button><button type="button" data-fdone class="btn-primary text-xs px-2.5 py-1">Done</button></div>`;
    let content = "";
    if (col.type === "text") content = `<div class="text-[10px] font-bold text-black/40 mb-1.5">Filter ${escapeHtml(col.label)}</div><input type="text" data-finput class="input text-xs py-1 w-full" value="${escapeHtml(filters[key] || "")}" placeholder="Type to filter…">${footer}`;
    else if (col.type === "multi") { const sel = filters[key] || []; content = `<div class="text-[10px] font-bold text-black/40 mb-1.5">Filter ${escapeHtml(col.label)}</div><div class="flex flex-col gap-0 max-h-[220px] overflow-auto">${multiOptions(key).map(v => `<label class="flex items-center gap-2 px-1.5 py-1 rounded-lg hover:bg-black/[0.04] cursor-pointer text-xs"><input type="checkbox" data-fcheck value="${escapeHtml(v)}" ${sel.includes(v) ? "checked" : ""} class="h-3.5 w-3.5 rounded border-black/25"><span class="truncate">${escapeHtml(v)}</span></label>`).join("") || `<div class="text-xs text-black/40 px-1.5 py-1">No values</div>`}</div>${footer}`; }
    else if (col.type === "num") { const f = filters[key] || { min: "", max: "" }; content = `<div class="text-[10px] font-bold text-black/40 mb-1.5">Filter range</div><div class="flex flex-col gap-2"><input type="number" data-frange="min" class="input text-xs py-1" value="${escapeHtml(f.min || "")}" placeholder="Min"><input type="number" data-frange="max" class="input text-xs py-1" value="${escapeHtml(f.max || "")}" placeholder="Max"></div>${footer}`; }
    else if (col.type === "date") { const f = filters[key] || { from: "", to: "" }; content = `<div class="text-[10px] font-bold text-black/40 mb-1.5">Filter ${escapeHtml(col.label)}</div><div class="flex flex-col gap-2"><div><div class="text-[10px] text-black/40 mb-0.5">From</div><input type="date" data-fdate="from" class="input text-xs py-1" value="${escapeHtml(f.from || "")}"></div><div><div class="text-[10px] text-black/40 mb-0.5">To</div><input type="date" data-fdate="to" class="input text-xs py-1" value="${escapeHtml(f.to || "")}"></div></div>${footer}`; }
    const portal = document.createElement("div");
    portal.id = "filterPortal"; portal.className = "fixed z-[200] rounded-xl border border-black/10 bg-white p-3 shadow-xl text-ink-900"; portal.innerHTML = content;
    document.body.appendChild(portal); placePortal(portal, anchor, 240);
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
    let out = rows.slice();
    const q = search.trim().toLowerCase();
    if (q) out = out.filter(r => (`${r.customer_name || ""} ${r.est_no || ""} ${r.description || ""}`).toLowerCase().includes(q));
    out = out.filter(passFilters);
    if (sortKey) out.sort((a, b) => { let av = a[sortKey], bv = b[sortKey]; if (sortKey === "amount") return ((+av || 0) - (+bv || 0)) * sortDir; av = (av ?? "").toString().toLowerCase(); bv = (bv ?? "").toString().toLowerCase(); return av < bv ? -sortDir : av > bv ? sortDir : 0; });
    return out;
  };

  // ---- contact log panel (shared by expanded row + mobile card) ----
  function contactPanelHtml(eid) {
    const list = contactsCache[eid];
    const inner = list === undefined ? `<div class="text-xs text-black/40 py-1">Loading…</div>`
      : !list.length ? `<div class="text-xs text-black/40 py-1">No contacts logged yet.</div>`
      : list.map(c => String(editingContact) === String(c.id) ? `
        <div class="border-b border-black/5 py-2 space-y-1.5" data-cedit="${c.id}">
          <div class="grid grid-cols-2 gap-2">
            <input type="date" value="${escapeHtml(ymd(c.contact_date))}" data-cf="contact_date" class="rounded border border-black/15 px-2 py-1 text-xs">
            <select data-cf="communication_type" class="rounded border border-black/15 px-2 py-1 text-xs bg-white"><option value="">Type…</option>${COMM_OPTS.map(k => `<option value="${escapeHtml(k)}" ${c.communication_type === k ? "selected" : ""}>${escapeHtml(k)}</option>`).join("")}</select>
          </div>
          <textarea data-cf="notes" rows="2" class="w-full rounded border border-black/15 px-2 py-1 text-xs">${escapeHtml(c.notes || "")}</textarea>
          <div class="flex justify-end gap-2"><button type="button" data-ccancel class="text-xs px-2 py-1 rounded border border-black/15 hover:bg-black/5">Cancel</button><button type="button" data-csave="${c.id}" class="text-xs px-2 py-1 rounded btn-primary">Save</button></div>
        </div>` : `
        <div class="border-b border-black/5 py-1.5">
          <div class="flex justify-between items-start gap-2 text-xs"><span class="font-semibold">${escapeHtml(c.communication_type || "contact")}</span>
            <span class="flex items-center gap-2 shrink-0"><span class="text-black/40">${ymd(c.contact_date)}</span><button type="button" data-cedit-btn="${c.id}" class="text-blue-600 hover:underline">edit</button><button type="button" data-cdel="${c.id}" class="text-red-500 hover:underline">delete</button></span></div>
          ${c.notes ? `<div class="text-xs text-black/60">${escapeHtml(c.notes)}</div>` : ""}
        </div>`).join("");
    return `<div class="bg-black/[0.02] rounded-lg p-3" data-cpanel="${eid}">
      <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">Contact log</div>
      <div class="max-h-56 overflow-y-auto">${inner}</div>
      <form data-cadd="${eid}" class="mt-2 flex flex-wrap items-center gap-2">
        <input type="date" data-cn="contact_date" class="rounded-lg border border-black/15 px-2 py-1 text-xs">
        <select data-cn="communication_type" class="rounded-lg border border-black/15 px-2 py-1 text-xs bg-white"><option value="">Type…</option>${COMM_OPTS.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join("")}</select>
        <input type="text" data-cn="notes" placeholder="Notes…" class="flex-1 min-w-[8rem] rounded-lg border border-black/15 px-2 py-1 text-xs">
        <button type="submit" class="btn-primary text-xs px-3 py-1">Log</button>
      </form></div>`;
  }
  async function toggleExpand(eid) {
    expandedRow = expandedRow === eid ? null : eid;
    if (expandedRow && contactsCache[eid] === undefined) {
      renderRows();
      try { contactsCache[eid] = await api(`/estimates/tracking/${eid}/contacts`); } catch (_) { contactsCache[eid] = []; }
    }
    renderRows();
  }
  function wireContactPanels() {
    document.querySelectorAll("[data-cadd]").forEach(form => form.addEventListener("submit", async (e) => {
      e.preventDefault(); const eid = form.dataset.cadd;
      const body = {}; form.querySelectorAll("[data-cn]").forEach(f => body[f.dataset.cn] = f.value || null);
      if (!body.contact_date) return;
      try { await api(`/estimates/tracking/${eid}/contacts`, { method: "POST", body: JSON.stringify(body) }); contactsCache[eid] = await api(`/estimates/tracking/${eid}/contacts`); syncContactCount(eid); renderRows(); } catch (_) {}
    }));
    document.querySelectorAll("[data-cedit-btn]").forEach(b => b.addEventListener("click", () => { editingContact = b.dataset.ceditBtn; renderRows(); }));
    document.querySelectorAll("[data-ccancel]").forEach(b => b.addEventListener("click", () => { editingContact = null; renderRows(); }));
    document.querySelectorAll("[data-cdel]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this contact?")) return; const eid = b.closest("[data-cpanel]").dataset.cpanel;
      try { await api(`/estimates/contacts/${b.dataset.cdel}`, { method: "DELETE" }); contactsCache[eid] = (contactsCache[eid] || []).filter(c => String(c.id) !== String(b.dataset.cdel)); syncContactCount(eid); renderRows(); } catch (_) {}
    }));
    document.querySelectorAll("[data-csave]").forEach(b => b.addEventListener("click", async () => {
      const wrap = b.closest("[data-cedit]"); const eid = b.closest("[data-cpanel]").dataset.cpanel;
      const body = {}; wrap.querySelectorAll("[data-cf]").forEach(f => body[f.dataset.cf] = f.value || null);
      if (!body.contact_date) return;
      try { await api(`/estimates/contacts/${b.dataset.csave}`, { method: "PATCH", body: JSON.stringify(body) }); const c = (contactsCache[eid] || []).find(x => String(x.id) === String(b.dataset.csave)); if (c) Object.assign(c, body); editingContact = null; renderRows(); } catch (_) {}
    }));
  }
  function syncContactCount(eid) { const r = rows.find(x => x.qbo_estimate_id === eid); const list = contactsCache[eid] || []; if (r) { r.contact_count = list.length; r.last_contact_date = list[0]?.contact_date || null; } }

  // ---- desktop header ----
  const sortMark = (k) => sortKey === k ? (sortDir === 1 ? " ▲" : " ▼") : "";
  const colgroup = `<colgroup><col style="width:${EXPAND_W}px">${COLS.map(c => `<col style="width:${c.w}px">`).join("")}</colgroup>`;
  const renderHeader = () => {
    const head = document.getElementById("estHead"); if (!head) return;
    head.innerHTML = `<tr class="bg-white border-b border-black/10 text-black/60">
      <th class="px-2 py-2.5"></th>
      ${COLS.map(c => `<th class="px-3 py-2.5 align-middle ${c.align === "right" ? "text-right" : "text-left"}"><div class="inline-flex items-center gap-1 max-w-full">
        <button type="button" data-sort="${c.key}" class="font-bold text-xs uppercase tracking-wide truncate hover:text-black/80">${escapeHtml(c.label)}${sortMark(c.key)}</button>
        <button type="button" data-filter="${c.key}" class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg hover:bg-black/5 ${filterActive(c.key) ? "bg-black/5" : ""}">${FUNNEL(filterActive(c.key))}</button></div></th>`).join("")}</tr>`;
    head.querySelectorAll("[data-sort]").forEach(b => b.addEventListener("click", () => {
      const k = b.dataset.sort;
      if (sortKey !== k) { sortKey = k; sortDir = 1; }      // 1st click: ascending
      else if (sortDir === 1) { sortDir = -1; }             // 2nd click: descending
      else { sortKey = null; sortDir = 1; }                 // 3rd click: reset
      renderAll();
    }));
    head.querySelectorAll("[data-filter]").forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); openFilterPortal(b.dataset.filter, b); }));
  };

  const renderRows = () => {
    const list = visible();
    // desktop table body
    const tbody = document.getElementById("estRows");
    if (tbody) tbody.innerHTML = list.map(r => {
      const open = !!expandedRow && !r.is_draft && expandedRow === r.qbo_estimate_id;
      const lead = r.is_draft
        ? `<a href="#/estimate/${r.app_estimate_id}" class="text-blue-600 hover:text-blue-800" title="Open in Quoting Metrics" style="display:inline-flex"><svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 3h7v7M21 3l-9 9M10 5H5a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-5"/></svg></a>`
        : `<button type="button" data-expand="${escapeHtml(r.qbo_estimate_id)}" class="text-black/40 hover:text-black/80 ${open ? "rotate-90" : ""}" style="display:inline-flex" title="Show contacts">${CHEV}</button>`;
      return `<tr class="border-b border-black/5 hover:bg-black/[0.02] ${r.is_draft ? "bg-amber-50/40" : ""}">
        <td class="px-2 py-2.5 text-center">${lead}</td>
        ${COLS.map(c => `<td class="px-3 py-2.5 ${c.trunc ? "truncate" : "whitespace-nowrap"} ${c.align === "right" ? "text-right" : ""}" ${c.trunc ? `title="${escapeHtml(r[c.key] || "")}"` : ""}>${c.td(r)}</td>`).join("")}
      </tr>${open ? `<tr class="bg-black/[0.015]"><td colspan="${COLS.length + 1}" class="px-3 pb-3">${contactPanelHtml(r.qbo_estimate_id)}</td></tr>` : ""}`;
    }).join("") || `<tr><td colspan="${COLS.length + 1}" class="py-8 text-center text-black/40">No estimates match.</td></tr>`;
    // mobile cards
    const cards = document.getElementById("estCards");
    if (cards) cards.innerHTML = list.map(r => {
      const open = !!expandedRow && !r.is_draft && expandedRow === r.qbo_estimate_id;
      return `<div class="rounded-xl border border-black/10 bg-white p-3">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0"><div class="text-[11px] font-mono text-black/40">#${escapeHtml(r.est_no || "—")}${r.app_estimate_id && !r.is_draft ? ` · <a href="#/estimate/${r.app_estimate_id}" class="text-blue-600">✎ edit quote</a>` : ""}</div><div class="font-bold text-ink-900 truncate">${escapeHtml(r.customer_name || "—")}</div></div>
          <div class="text-right shrink-0"><div class="font-bold tabular-nums text-ink-900">${money(r.amount)}</div><div class="text-[11px] text-black/40">${ymd(r.txn_date)} · ${escapeHtml(r.qbo_status || "—")}</div></div>
        </div>
        ${r.description ? `<div class="text-xs text-black/55 mt-1 line-clamp-2">${escapeHtml(r.description)}</div>` : ""}
        <div class="flex items-center justify-between gap-2 mt-2">${statusPill(r)}<div class="text-xs text-black/60 truncate">${ownerBtn(r)}</div></div>
        <div class="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-black/5 text-xs">
          ${r.is_draft
            ? `<span class="text-black/50">Not in QuickBooks yet</span><a href="#/estimate/${r.app_estimate_id}" class="font-semibold text-blue-600">Open in QM ↗</a>`
            : `<span class="text-black/50">${r.contact_count ? `Last contact ${ymd(r.last_contact_date)} (${r.contact_count})` : "No contacts"}</span><button type="button" data-expand="${escapeHtml(r.qbo_estimate_id)}" class="font-semibold text-blue-600">${open ? "Hide" : "Contacts ▸"}</button>`}
        </div>
        ${open && !r.is_draft ? `<div class="mt-2">${contactPanelHtml(r.qbo_estimate_id)}</div>` : ""}
      </div>`;
    }).join("") || `<div class="text-center text-sm text-black/40 py-6">No estimates match.</div>`;

    const cnt = document.getElementById("estCount");
    if (cnt) cnt.textContent = `Showing ${list.length}${rows.length >= 1000 ? " · first 1000 (refine to narrow)" : ""}`;
    // wire row controls (both layouts)
    document.querySelectorAll("[data-status-pill]").forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); openStatusPortal(b.dataset.statusPill, b); }));
    document.querySelectorAll("[data-owner]").forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); openOwnerPortal(b.dataset.owner, b); }));
    document.querySelectorAll("[data-expand]").forEach(b => b.addEventListener("click", () => toggleExpand(b.dataset.expand)));
    wireContactPanels();
  };
  const renderAll = () => { renderHeader(); renderRows(); };

  mount(`
    <div class="w-full">
      <div class="card flex flex-col overflow-hidden" style="height: calc(100vh - 130px); min-height: 420px;">
        <div class="shrink-0 px-4 sm:px-5 pt-4 pb-3 border-b border-black/10">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <div class="text-base font-extrabold text-ink-900">Estimates</div>
              <div class="text-xs text-black/50">Sort &amp; filter columns · edit status/owner inline · expand for contacts. New estimate? <a href="#/estimate" class="text-blue-600 font-semibold hover:underline">Quoting Metrics</a>.</div>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
              <input id="estSearch" class="input text-xs py-1.5 w-full sm:w-56" placeholder="Search customer, est #…" />
              <label class="flex items-center gap-1.5 text-xs text-black/60 whitespace-nowrap"><input type="checkbox" id="showAll" class="h-4 w-4 rounded border-black/25"> Show all</label>
              <button id="clearFilters" type="button" class="rounded-xl border border-black/10 bg-gray-100 px-3 py-1.5 text-xs font-semibold hover:bg-black/5 whitespace-nowrap">Clear filters</button>
              <button id="revAnalytics" type="button" class="rounded-xl border border-black/10 bg-gray-100 px-3 py-1.5 text-xs font-semibold hover:bg-black/5 whitespace-nowrap">Revision analytics</button>
            </div>
          </div>
          <div id="estCount" class="text-xs font-semibold text-black/50 mt-1.5"></div>
        </div>
        <!-- desktop table -->
        <div id="estScroll" class="hidden lg:block flex-1 overflow-auto">
          <table class="text-xs w-full table-fixed" style="min-width:1066px;">
            ${colgroup}
            <thead id="estHead" class="text-left sticky top-0 z-20 bg-white"></thead>
            <tbody id="estRows"></tbody>
          </table>
        </div>
        <!-- mobile cards -->
        <div id="estCards" class="lg:hidden flex-1 overflow-auto p-3 flex flex-col gap-2.5 bg-black/[0.015]"></div>
      </div>
    </div>`, routeFn);

  document.getElementById("revAnalytics").addEventListener("click", openRevisionAnalyticsModal);
  document.getElementById("estSearch").addEventListener("input", (e) => { search = e.target.value; renderRows(); });
  document.getElementById("showAll").addEventListener("change", async (e) => { showAll = e.target.checked; try { await load(); rows = data.estimates || []; renderAll(); } catch (_) {} });
  document.getElementById("clearFilters").addEventListener("click", () => { for (const k of Object.keys(filters)) delete filters[k]; closePortals(); renderAll(); });
  document.getElementById("estScroll").addEventListener("scroll", closePortals);
  document.addEventListener("click", (e) => {
    if ((document.getElementById("filterPortal") || document.getElementById("menuPortal"))
      && !e.target.closest("#filterPortal") && !e.target.closest("#menuPortal")
      && !e.target.closest("[data-filter]") && !e.target.closest("[data-status-pill]") && !e.target.closest("[data-owner]")) closePortals();
  });

  renderAll();
}

async function openRevisionAnalyticsModal() {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4";
  overlay.innerHTML = `<div class="bg-white rounded-2xl shadow-xl w-full max-w-2xl p-5 max-h-[88vh] overflow-auto" data-card><div class="text-sm text-black/40">Loading…</div></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) overlay.remove(); });
  const card = overlay.querySelector("[data-card]");
  try {
    const d = await api("/estimates/analytics/revisions");
    const chip = (label, val) => `<div class="rounded-xl border border-black/10 bg-black/[0.015] px-3 py-2"><div class="text-[10px] font-bold uppercase tracking-wide text-black/35">${label}</div><div class="text-lg font-extrabold text-ink-900">${val}</div></div>`;
    const reasonMax = Math.max(1, ...d.by_reason.map((r) => r.n));
    card.innerHTML = `
      <div class="flex items-center justify-between mb-3"><div class="text-base font-bold text-ink-900">Revision analytics</div>
        <button data-close class="text-black/40 hover:text-black/70 text-xl leading-none">&times;</button></div>
      <div class="grid grid-cols-3 gap-2 mb-4">
        ${chip("Revision events", d.totals.revision_events)}
        ${chip("Estimates revised", d.totals.estimates_revised)}
        ${chip("Reasons tracked", d.by_reason.length)}
      </div>
      <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">By reason</div>
      <div class="space-y-1 mb-4">${d.by_reason.map((r) => `
        <div class="flex items-center gap-2 text-xs"><div class="w-40 truncate text-black/60">${escapeHtml(r.reason)}</div>
          <div class="flex-1 bg-black/5 rounded-full h-3 overflow-hidden"><div class="bg-blue-400 h-3" style="width:${Math.round(r.n / reasonMax * 100)}%"></div></div>
          <div class="w-8 text-right tabular-nums font-semibold">${r.n}</div></div>`).join("") || `<div class="text-xs text-black/40">No data yet.</div>`}</div>
      <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">Most-revised customers</div>
      <div class="overflow-x-auto ${d.by_contact && d.by_contact.length ? "mb-4" : ""}"><table class="w-full text-xs">
        <thead><tr class="text-left text-black/45 border-b border-black/10"><th class="py-1 pr-3 font-bold">Customer</th><th class="py-1 pr-3 font-bold text-right">Estimates</th><th class="py-1 pr-3 font-bold text-right">Revisions</th><th class="py-1 font-bold text-right">Avg/est</th></tr></thead>
        <tbody>${(d.by_customer || []).slice(0, 15).map((c) => `<tr class="border-b border-black/5"><td class="py-1 pr-3 font-semibold text-ink-900">${escapeHtml(c.name || "—")}</td><td class="py-1 pr-3 text-right tabular-nums">${c.estimates_revised}</td><td class="py-1 pr-3 text-right tabular-nums">${c.revision_events}</td><td class="py-1 text-right tabular-nums">${c.avg_per_estimate}</td></tr>`).join("") || `<tr><td colspan="4" class="py-3 text-center text-black/40">No revisions saved yet.</td></tr>`}</tbody></table></div>
      ${(d.by_contact && d.by_contact.length) ? `<div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">By contact</div>
      <div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr class="text-left text-black/45 border-b border-black/10"><th class="py-1 pr-3 font-bold">Contact</th><th class="py-1 pr-3 font-bold">Customer</th><th class="py-1 font-bold text-right">Revisions</th></tr></thead>
        <tbody>${d.by_contact.slice(0, 15).map((c) => `<tr class="border-b border-black/5"><td class="py-1 pr-3 font-semibold text-ink-900">${escapeHtml(c.contact_name || "—")}</td><td class="py-1 pr-3 text-black/60">${escapeHtml(c.customer_name || "—")}</td><td class="py-1 text-right tabular-nums">${c.revision_events}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
    card.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  } catch (e) { card.innerHTML = `<div class="text-sm text-red-700">Failed to load analytics.</div>`; }
}

function mount(bodyHtml, routeFn) {
  setShell({ title: "", subtitle: "", bodyHtml, showLogout: true, routeFn });
  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => { if (pageTitleBlock) pageTitleBlock.style.display = ""; }, { once: true });
  }
}
