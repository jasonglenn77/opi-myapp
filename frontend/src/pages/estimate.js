// Estimate page — Phase 1
// Mirrors cells A1:H36 of the "0. ROLL UP Quoting Metrics" Excel tab.
// Inputs are interactive (live local state). The Start Date / Quote Submittal
// Date calculations are wired now; remaining calc logic + persistence land in
// later phases. Reference-table dropdowns (Estimate Type, Equipment, Rack
// Height, Yes/No, Crew Size) are pulled from /api/quoting/lookup-values and
// fall back to static defaults if the fetch fails.

import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import { api, hasCapability } from "../api.js";
import { mountBaseQuotingMetrics } from "./base-quoting-metrics.js";
import { contactFormModal } from "./contacts.js";
import { computeSetRollup, computeSetBundles } from "../utils/qm-rollup.js";

// Top-level dispatcher for #/estimate. URL shapes:
//   #/estimate                          -> customer picker
//   #/estimate/{id}                     -> defaults to General Info tab
//   #/estimate/{id}/general             -> General Info tab
//   #/estimate/{id}/base                -> Base Quoting Metrics tab
//   #/estimate/{id}/option/{n}          -> Option N tab (option metric set)
//   #/estimate/{id}/project-rentals     -> Project Rentals tab (project_rentals set)
//   #/estimate/{id}/review              -> Review / Rollup tab
//   #/base-quoting-metrics              -> legacy URL; redirected to the picker
export async function estimatePage(routeFn) {
  const m = location.hash.match(/^#\/estimate\/(\d+)(?:\/(general|base|review|project-rentals|option\/(\d+)))?\/?$/);
  if (!m) return renderEstimateList(routeFn);
  const estimateId = Number(m[1]);
  const tabPath    = m[2] || "general";
  const tab        = tabPath.split("/")[0];   // "general" | "base" | "review" | "project-rentals" | "option"
  const optionN    = m[3] ? Number(m[3]) : null;
  return renderEstimateWorkspace(routeFn, estimateId, tab, optionN);
}

// ── Estimate-list landing (Phase 0b) ────────────────────────────────────────
// Lists all quoting-metrics estimates (one per opportunity) with their
// create -> ready-for-QBO -> linked lifecycle. The workbook (#/estimate/{id})
// is the calculator; this is the control center around it.
const Q_STATUS = {
  draft:         { label: "Draft", cls: "bg-black/10 text-black/60" },
  ready_for_qbo: { label: "Ready", cls: "bg-amber-100 text-amber-700" },
};

async function renderEstimateList(routeFn) {
  let estimates = [], customers = [];
  try {
    [estimates, customers] = await Promise.all([
      api("/estimates/quoting-list"),
      api("/estimates/customers").catch(() => []),
    ]);
  } catch (e) {
    setShell({ title: "", bodyHtml: `<div class="mx-auto w-full max-w-4xl"><div class="card p-5 text-sm text-red-700">Failed to load estimates: ${escapeHtml(e?.message || String(e))}</div></div>`, showLogout: true, routeFn });
    return;
  }
  customers = customers.slice().sort((a, b) => (a.display_name || "").localeCompare(b.display_name || ""));  // alphabetical
  const ymd = (s) => (s ? String(s).slice(0, 10) : "—");
  const badge = (st) => { const m = Q_STATUS[st] || Q_STATUS.draft; return `<span class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${m.cls}">${m.label}</span>`; };

  // ---- table state (3-state sort: asc -> desc -> off) ----
  let search = "", sort = { key: null, dir: null };
  const statusFilter = new Set();
  const STATUS_ORDER = { draft: 0, ready_for_qbo: 1, in_qbo: 2 };
  const SORT_COLS = [
    { key: "customer_name", label: "Customer" },
    { key: "quote_description", label: "Description" },
    { key: "status", label: "Status" },
    { key: "updated_at", label: "Last edited" },
  ];
  const visible = () => {
    let out = estimates.slice();
    const q = search.trim().toLowerCase();
    if (q) out = out.filter(e => (`${e.customer_name || ""} ${e.quote_description || ""}`).toLowerCase().includes(q));
    if (statusFilter.size) out = out.filter(e => {
      for (const f of statusFilter) { if (f === "linked" ? e.qbo_estimate_id : e.status === f) return true; }
      return false;
    });
    if (sort.key) {
      const d = sort.dir === "asc" ? 1 : -1;
      out.sort((a, b) => {
        let av, bv;
        if (sort.key === "status") { av = STATUS_ORDER[a.status] ?? 9; bv = STATUS_ORDER[b.status] ?? 9; }
        else { av = (a[sort.key] || "").toString().toLowerCase(); bv = (b[sort.key] || "").toString().toLowerCase(); }
        return av < bv ? -d : av > bv ? d : 0;
      });
    }
    return out;
  };
  const cycleSort = (key) => {
    if (sort.key !== key) sort = { key, dir: "asc" };
    else if (sort.dir === "asc") sort.dir = "desc";
    else sort = { key: null, dir: null };   // third click resets
    renderHead(); renderRows();
  };
  const sortMark = (key) => sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "";

  // Link and ready are independent; the status cell shows both states.
  const statusCell = (e) => `${badge(e.status)}${e.qbo_estimate_id
    ? `<a href="#/estimates" class="ml-1.5 inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-emerald-50 text-emerald-700 hover:bg-emerald-100" title="Linked — track on Estimates">#${escapeHtml(e.quote_number || "")} ↗</a>` : ""}`;
  // Visible action buttons (ghost/outline) — always show what's available.
  const ACTBTN = "inline-flex items-center rounded-lg border border-black/10 bg-white px-2.5 py-1 text-xs font-semibold hover:bg-black/5 whitespace-nowrap";
  const actionCell = (e) => {
    const ready = e.status === "ready_for_qbo"
      ? `<button class="${ACTBTN} text-black/50" data-revert="${e.id}">Unmark ready</button>`
      : `<button class="${ACTBTN} text-amber-700" data-ready="${e.id}">Mark ready</button>`;
    const link = e.qbo_estimate_id
      ? `<button class="${ACTBTN} text-emerald-700" data-link="${e.id}">Change link</button>`
      : `<button class="${ACTBTN} text-blue-600" data-link="${e.id}">Link to QBO</button>`;
    return `<div class="inline-flex items-center gap-1.5">
      <a href="#/estimate/${e.id}" class="${ACTBTN} text-ink-800">Open</a>${ready}${link}</div>`;
  };

  const renderHead = () => {
    const head = document.getElementById("qmHead");
    if (head) head.innerHTML = `<tr class="bg-black/[0.02] border-b border-black/10 text-black/50">
      ${SORT_COLS.map(c => `<th class="px-3 py-2.5"><button type="button" data-sort="${c.key}" class="font-semibold text-xs uppercase tracking-wide hover:text-black/80">${c.label}${sortMark(c.key)}</button></th>`).join("")}
      <th class="px-3 py-2.5"></th></tr>`;
    head?.querySelectorAll("[data-sort]").forEach(b => b.addEventListener("click", () => cycleSort(b.dataset.sort)));
  };
  const renderRows = () => {
    const list = visible();
    const tb = document.getElementById("qmRows");
    if (tb) tb.innerHTML = list.map(e => `<tr class="border-b border-black/5 hover:bg-black/[0.02]">
      <td class="px-3 py-2.5 font-semibold text-ink-900"><a class="hover:underline" href="#/estimate/${e.id}">${escapeHtml(e.customer_name || "—")}</a></td>
      <td class="px-3 py-2.5 text-black/60 max-w-[22rem] truncate" title="${escapeHtml(e.quote_description || "")}">${escapeHtml(e.quote_description || "(no description)")}</td>
      <td class="px-3 py-2.5">${statusCell(e)}</td>
      <td class="px-3 py-2.5 text-xs text-black/50 tabular-nums">${e.revision_count || 0} rev · ${ymd(e.updated_at)}</td>
      <td class="px-3 py-2.5 text-right">${actionCell(e)}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="py-8 text-center text-black/40">No estimates match.</td></tr>`;
    const cnt = document.getElementById("qmCount"); if (cnt) cnt.textContent = `${list.length} estimate${list.length === 1 ? "" : "s"}`;
    tb?.querySelectorAll("[data-ready]").forEach(b => b.addEventListener("click", async () => { try { await api(`/estimates/${b.dataset.ready}/status`, { method: "PATCH", body: JSON.stringify({ status: "ready_for_qbo" }) }); routeFn(); } catch (_) {} }));
    tb?.querySelectorAll("[data-revert]").forEach(b => b.addEventListener("click", async () => { try { await api(`/estimates/${b.dataset.revert}/status`, { method: "PATCH", body: JSON.stringify({ status: "draft" }) }); routeFn(); } catch (_) {} }));
    tb?.querySelectorAll("[data-link]").forEach(b => b.addEventListener("click", () => openLink(b.dataset.link)));
  };

  const chip = (key, label) => `<button type="button" data-statuschip="${key}" class="rounded-full px-3 py-1 text-xs font-semibold border ${statusFilter.has(key) ? "bg-ink-900 text-white border-ink-900" : "border-black/15 text-black/60 hover:bg-black/5"}">${label}</button>`;

  setShell({
    title: "", showLogout: true, routeFn,
    bodyHtml: `
    <div class="mx-auto w-full max-w-5xl grid grid-cols-1 gap-3 pb-3">
      <div class="card p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold text-ink-900">Quoting Metrics</div>
            <div class="text-xs text-black/50">Build an estimate, mark it ready, then link it to its QuickBooks Est # — it then tracks on the <a href="#/estimates" class="text-blue-600 font-semibold hover:underline">Estimates</a> page.</div>
          </div>
          <button id="newEstBtn" class="btn-primary shrink-0">New estimate</button>
        </div>
        <div class="mt-3 flex items-center gap-2 flex-wrap">
          <input id="qmSearch" class="input text-sm py-2 w-full sm:w-64" placeholder="Search customer or description…">
          <div class="flex items-center gap-1.5" id="qmChips">${chip("draft", "Draft")}${chip("ready_for_qbo", "Ready")}${chip("linked", "Linked")}</div>
          <span id="qmCount" class="text-xs text-black/40 ml-auto"></span>
        </div>
      </div>
      <div class="card p-0 overflow-hidden">
        <div class="overflow-x-auto"><table class="w-full text-sm">
          <thead id="qmHead" class="text-left text-black/50"></thead>
          <tbody id="qmRows"></tbody>
        </table></div>
      </div>
    </div>

    <div id="newEstModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-5 w-full max-w-md">
        <div class="text-lg font-extrabold mb-3">New estimate</div>
        <form id="newEstForm" class="space-y-3">
          <div>
            <div class="label mb-1">Customer</div>
            <div class="relative">
              <input id="neCustInput" class="input" placeholder="Type to search customer…" autocomplete="off">
              <div id="neCustList" class="hidden absolute z-10 mt-1 w-full max-h-56 overflow-auto rounded-xl border border-black/10 bg-white shadow-lg text-ink-900"></div>
            </div>
          </div>
          <div>
            <div class="label mb-1">Contact <span class="text-black/40">(optional)</span></div>
            <div class="flex gap-2">
              <select id="neContact" class="input flex-1" disabled><option value="">Pick a customer first</option></select>
              <button type="button" id="neNewContact" class="rounded-xl border border-black/15 px-2.5 text-xs font-semibold hover:bg-black/5 whitespace-nowrap" disabled>+ New</button>
            </div>
          </div>
          <div><div class="label mb-1">Description <span class="text-black/40">(optional)</span></div><input id="neDesc" class="input" placeholder="e.g. Rack install — Katy, TX"></div>
          <div><div class="label mb-1">QBO Estimate No. <span class="text-black/40">(optional — link now if you have it)</span></div><input id="neEstNo" class="input" placeholder="e.g. 7147"></div>
          <div class="text-sm text-red-700 min-h-[1.25rem]" id="neMsg"></div>
          <div class="flex justify-end gap-2"><button type="button" id="neCancel" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold hover:bg-black/5">Cancel</button><button type="submit" class="btn-primary">Create &amp; open</button></div>
        </form>
      </div>
    </div>

    <div id="linkModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-5 w-full max-w-md">
        <div class="text-lg font-extrabold">Link to QuickBooks</div>
        <div class="text-xs text-black/50 mb-3 mt-0.5">Once it's created in QuickBooks, enter its Estimate No. (or pick a recent one) to link &amp; start tracking.</div>
        <form id="linkForm" class="space-y-3">
          <div><div class="label mb-1">Recent QBO estimates for this customer</div><select id="lkCandidate" class="input"><option value="">— choose, or type below —</option></select></div>
          <div class="flex items-center justify-between gap-2 -mt-1">
            <span class="text-[11px] text-black/40">Not listed? It may not be synced from QBO yet.</span>
            ${hasCapability("qbo.sync") ? `<button type="button" id="lkSync" class="text-xs font-semibold text-blue-600 hover:underline whitespace-nowrap">↻ Sync from QBO</button>` : ""}
          </div>
          <div><div class="label mb-1">Estimate No.</div><input id="lkEstNo" class="input" placeholder="e.g. 7147"></div>
          <div class="text-sm text-red-700 min-h-[1.25rem]" id="lkMsg"></div>
          <div class="flex justify-between gap-2">
            <button type="button" id="lkUnlink" class="hidden rounded-xl border border-red-200 text-red-600 px-3 py-1.5 text-sm font-semibold hover:bg-red-50">Unlink</button>
            <div class="flex gap-2 ml-auto"><button type="button" id="lkCancel" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold hover:bg-black/5">Cancel</button><button type="submit" class="btn-primary">Link estimate</button></div>
          </div>
        </form>
      </div>
    </div>`,
  });

  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") { pageTitleBlock.style.display = "none"; window.addEventListener("hashchange", () => { if (pageTitleBlock) pageTitleBlock.style.display = ""; }, { once: true }); }

  renderHead(); renderRows();
  document.getElementById("qmSearch").addEventListener("input", (e) => { search = e.target.value; renderRows(); });
  function wireChips() {
    document.querySelectorAll("[data-statuschip]").forEach(b => b.addEventListener("click", () => {
      const k = b.dataset.statuschip; statusFilter.has(k) ? statusFilter.delete(k) : statusFilter.add(k);
      document.getElementById("qmChips").innerHTML = chip("draft", "Draft") + chip("ready_for_qbo", "Ready") + chip("linked", "Linked");
      wireChips(); renderRows();
    }));
  }
  wireChips();

  // ---- New estimate (searchable customer combobox) ----
  const neModal = document.getElementById("newEstModal");
  let selectedCustomerId = null;
  let selectedCustomerQbo = null;   // {qbo_id, name} for loading contacts
  const custInput = document.getElementById("neCustInput");
  const custList = document.getElementById("neCustList");
  const neContact = document.getElementById("neContact");
  const neNewContact = document.getElementById("neNewContact");
  const resetNeContacts = () => { neContact.innerHTML = `<option value="">Pick a customer first</option>`; neContact.disabled = true; neNewContact.disabled = true; };
  const loadNeContacts = async (selectId) => {
    if (!selectedCustomerQbo) return resetNeContacts();
    try {
      const d = await api(`/contacts/customer/${encodeURIComponent(selectedCustomerQbo.qbo_id)}`);
      const list = (d.contacts || []).filter(c => c.active);
      neContact.innerHTML = `<option value="">— none —</option>` +
        list.map(c => `<option value="${c.id}" ${String(c.id) === String(selectId || "") ? "selected" : ""}>${escapeHtml(c.full_name || "contact")}</option>`).join("");
      neContact.disabled = false; neNewContact.disabled = false;
    } catch (_) { resetNeContacts(); }
  };
  neNewContact.addEventListener("click", () => {
    if (!selectedCustomerQbo) return;
    contactFormModal({ customer: selectedCustomerQbo, contact: null, onSaved: (saved) => loadNeContacts(saved?.id) });
  });
  const renderCustList = () => {
    const q = custInput.value.trim().toLowerCase();
    const matches = customers.filter(c => (c.display_name || "").toLowerCase().includes(q)).slice(0, 50);
    custList.innerHTML = matches.map(c => `<button type="button" data-cid="${c.qbo_customer_id}" class="block w-full text-left px-3 py-1.5 text-sm hover:bg-black/5">${escapeHtml(c.display_name || ("#" + c.qbo_customer_id))}</button>`).join("") || `<div class="px-3 py-2 text-sm text-black/40">No matches</div>`;
    custList.classList.remove("hidden");
    custList.querySelectorAll("[data-cid]").forEach(b => b.addEventListener("mousedown", (e) => {
      e.preventDefault(); selectedCustomerId = parseInt(b.dataset.cid, 10); custInput.value = b.textContent; custList.classList.add("hidden");
      const cust = customers.find(c => String(c.qbo_customer_id) === String(selectedCustomerId));
      selectedCustomerQbo = cust ? { qbo_id: cust.qbo_id, name: cust.display_name } : null;
      loadNeContacts();
    }));
  };
  custInput.addEventListener("focus", renderCustList);
  custInput.addEventListener("input", () => { selectedCustomerId = null; selectedCustomerQbo = null; resetNeContacts(); renderCustList(); });
  custInput.addEventListener("blur", () => setTimeout(() => custList.classList.add("hidden"), 150));

  const openNe = () => { document.getElementById("neMsg").textContent = ""; selectedCustomerId = null; selectedCustomerQbo = null; resetNeContacts(); custInput.value = ""; document.getElementById("neDesc").value = ""; document.getElementById("neEstNo").value = ""; neModal.classList.remove("hidden"); neModal.classList.add("flex"); custInput.focus(); };
  const closeNe = () => { neModal.classList.add("hidden"); neModal.classList.remove("flex"); };
  document.getElementById("newEstBtn").addEventListener("click", openNe);
  document.getElementById("neCancel").addEventListener("click", closeNe);
  neModal.addEventListener("click", (e) => { if (e.target === neModal) closeNe(); });
  document.getElementById("newEstForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selectedCustomerId) { document.getElementById("neMsg").textContent = "Pick a customer from the list."; return; }
    try {
      const created = await api("/estimates", { method: "POST", body: JSON.stringify({ qbo_customer_id: selectedCustomerId, contact_id: neContact.value ? Number(neContact.value) : null, quote_description: document.getElementById("neDesc").value.trim() || null }) });
      const estNo = document.getElementById("neEstNo").value.trim();
      if (estNo) { try { await api(`/estimates/${created.id}/link-qbo`, { method: "POST", body: JSON.stringify({ est_no: estNo }) }); } catch (err) { let d = err?.message || ""; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch (_) {} document.getElementById("neMsg").textContent = "Created, but link failed: " + d; return; } }
      location.hash = `#/estimate/${created.id}`;
    } catch (err) { document.getElementById("neMsg").textContent = "Could not create estimate."; }
  });

  // ---- Link to QBO ----
  const linkModal = document.getElementById("linkModal");
  let linkId = null;
  const closeLink = () => { linkModal.classList.add("hidden"); linkModal.classList.remove("flex"); };
  document.getElementById("lkCancel").addEventListener("click", closeLink);
  linkModal.addEventListener("click", (e) => { if (e.target === linkModal) closeLink(); });
  document.getElementById("lkCandidate").addEventListener("change", (e) => { if (e.target.value) document.getElementById("lkEstNo").value = e.target.value; });
  async function openLink(id) {
    linkId = id;
    const est = estimates.find(x => String(x.id) === String(id));
    document.getElementById("lkMsg").textContent = "";
    document.getElementById("lkEstNo").value = est?.quote_number || "";
    document.getElementById("lkUnlink").classList.toggle("hidden", !est?.qbo_estimate_id);
    const sel = document.getElementById("lkCandidate"); sel.innerHTML = `<option value="">— choose, or type below —</option>`;
    linkModal.classList.remove("hidden"); linkModal.classList.add("flex");
    try { (await api(`/estimates/${linkId}/qbo-candidates`)).forEach(c => { const o = document.createElement("option"); o.value = c.est_no; o.textContent = `#${c.est_no} · ${c.txn_date || ""} · $${Math.round(c.amount).toLocaleString()}`; sel.appendChild(o); }); } catch (_) {}
  }
  document.getElementById("lkUnlink").addEventListener("click", async () => {
    try { await api(`/estimates/${linkId}/unlink-qbo`, { method: "POST" }); closeLink(); routeFn(); } catch (_) {}
  });
  document.getElementById("lkSync")?.addEventListener("click", async () => {
    const btn = document.getElementById("lkSync"), orig = btn.textContent, msg = document.getElementById("lkMsg");
    btn.textContent = "Syncing…"; btn.disabled = true; msg.textContent = "";
    try {
      await api("/qbo/sync/transactions", { method: "POST" });
      if (linkId) {
        const sel = document.getElementById("lkCandidate"); sel.innerHTML = `<option value="">— choose, or type below —</option>`;
        (await api(`/estimates/${linkId}/qbo-candidates`)).forEach(c => { const o = document.createElement("option"); o.value = c.est_no; o.textContent = `#${c.est_no} · ${c.txn_date || ""} · $${Math.round(c.amount).toLocaleString()}`; sel.appendChild(o); });
      }
      msg.className = "text-sm text-emerald-700 min-h-[1.25rem]"; msg.textContent = "Synced — candidates refreshed.";
    } catch (err) {
      msg.className = "text-sm text-red-700 min-h-[1.25rem]";
      let d = err?.message || "Sync failed."; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch (_) {}
      msg.textContent = d;
    } finally { btn.textContent = orig; btn.disabled = false; }
  });
  document.getElementById("linkForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const estNo = document.getElementById("lkEstNo").value.trim();
    if (!estNo) { document.getElementById("lkMsg").textContent = "Enter an Estimate No."; return; }
    try { await api(`/estimates/${linkId}/link-qbo`, { method: "POST", body: JSON.stringify({ est_no: estNo }) }); closeLink(); routeFn(); }
    catch (err) { let d = err?.message || "Could not link."; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch (_) {} document.getElementById("lkMsg").textContent = d; }
  });
}

// ── Estimate workspace shell (tab strip + body container) ───────────────────
// Loads the estimate + its metric sets, paints the persistent header bar
// and tab strip, then hands the tab-body container off to the appropriate
// tab renderer.
async function renderEstimateWorkspace(routeFn, estimateId, tab, optionN) {
  let estimate, metricSets;
  try {
    [estimate, metricSets] = await Promise.all([
      api(`/estimates/${estimateId}`),
      api(`/quoting/metric-sets?estimate_id=${estimateId}`),
    ]);
  } catch (err) {
    setShell({
      title: "",
      bodyHtml: `<div class="card px-5 py-4 text-sm text-red-600">
        Failed to load estimate #${estimateId}: ${escapeHtml(err?.message || String(err))}
        <div class="pt-2"><a href="#/estimate" class="text-blue-600 underline">← Back to customers</a></div>
      </div>`,
      showLogout: true,
      routeFn,
    });
    return;
  }

  const options = metricSets
    .filter(s => s.kind === "option")
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const projectRentalsSet = metricSets.find(s => s.kind === "project_rentals") || null;

  const headerHtml = `
    <div class="card px-5 py-3">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-baseline gap-4 min-w-0">
          <a href="#/estimate" class="text-xs font-semibold text-blue-600 hover:text-blue-800 whitespace-nowrap">← Back to customers</a>
          <div class="min-w-0">
            <div class="text-base font-extrabold truncate">${escapeHtml(estimate.customer_display_name || "(Unknown customer)")}</div>
            <div class="text-xs text-black/50 truncate">
              Estimate #${estimateId}${estimate.customer_email ? " · " + escapeHtml(estimate.customer_email) : ""}
              · Rev ${estimate.revision_count ?? 0}
            </div>
          </div>
        </div>
        <div class="text-[11px] text-black/40 whitespace-nowrap">B155.1</div>
      </div>
    </div>`;

  const baseUrl = `#/estimate/${estimateId}`;
  const tabBtn = (href, label, active) => `
    <a href="${href}"
       class="px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition
              ${active ? "bg-ink-900 text-white" : "text-black/70 hover:bg-black/5"}">
      ${escapeHtml(label)}
    </a>`;
  // Deletable tab (Option/PR): tab link + trailing × button, grouped so the
  // pair reads as one chip but each half is independently clickable.
  const deletableTabBtn = (href, label, active, setId, deleteLabel) => `
    <span class="inline-flex items-center rounded-lg overflow-hidden transition
                 ${active ? "bg-ink-900" : "hover:bg-black/5"}">
      <a href="${href}"
         class="pl-3 pr-2 py-2 text-xs font-semibold whitespace-nowrap
                ${active ? "text-white" : "text-black/70"}">
        ${escapeHtml(label)}
      </a>
      <button type="button"
              class="pl-1 pr-2 py-2 text-sm leading-none
                     ${active ? "text-white/60 hover:text-white" : "text-black/35 hover:text-red-600"}"
              data-delete-set="${setId}"
              data-delete-label="${escapeHtml(deleteLabel)}"
              title="Delete ${escapeHtml(deleteLabel)}">×</button>
    </span>`;

  const tabsHtml = `
    <div class="card px-3 py-2" data-workspace-tabs>
      <div class="flex items-center gap-1 overflow-x-auto">
        ${tabBtn(`${baseUrl}/general`, "General Info", tab === "general")}
        ${tabBtn(`${baseUrl}/base`,    "Base",         tab === "base")}
        ${options.map(opt => deletableTabBtn(
          `${baseUrl}/option/${opt.sort_order}`,
          opt.label || `Option ${opt.sort_order}`,
          tab === "option" && optionN === opt.sort_order,
          opt.id,
          opt.label || `Option ${opt.sort_order}`
        )).join("")}
        ${projectRentalsSet ? deletableTabBtn(
          `${baseUrl}/project-rentals`,
          projectRentalsSet.label || "Project Rentals",
          tab === "project-rentals",
          projectRentalsSet.id,
          projectRentalsSet.label || "Project Rentals"
        ) : ""}
        <button type="button"
                class="px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap text-blue-600 hover:bg-blue-50 border border-dashed border-blue-200"
                data-add-option>
          + Add Option
        </button>
        ${!projectRentalsSet ? `
          <button type="button"
                  class="px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap text-blue-600 hover:bg-blue-50 border border-dashed border-blue-200"
                  data-add-project-rentals>
            + Project Rentals
          </button>` : ""}
        <div class="flex-1"></div>
        ${tabBtn(`${baseUrl}/review`, "Review", tab === "review")}
      </div>
    </div>`;

  const bodyHtml = `
    <div class="grid grid-cols-1 gap-3 pb-3">
      ${headerHtml}
      ${tabsHtml}
      <div data-tab-body></div>
    </div>`;

  setShell({ title: "", subtitle: "", bodyHtml, showLogout: true, routeFn });

  // Hide the empty page-title block; restore on navigate-away.
  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => {
      if (pageTitleBlock) pageTitleBlock.style.display = "";
    }, { once: true });
  }

  // Wire +Add Option / +Project Rentals / × delete-set. POST creates a new
  // metric set and jumps to it; DELETE removes it (cascades to lines) and
  // sends the user back to Base.
  async function onShellClick(e) {
    const addOpt = e.target.closest("[data-add-option]");
    const addPR  = e.target.closest("[data-add-project-rentals]");
    const delSet = e.target.closest("[data-delete-set]");

    if (delSet) {
      e.preventDefault();
      e.stopPropagation();
      // Disable BEFORE the confirm dialog so a stray double-click can't queue
      // a second delete during the await.
      if (delSet.disabled) return;
      delSet.disabled = true;
      delSet.setAttribute("disabled", "true");
      const setId = Number(delSet.getAttribute("data-delete-set"));
      const label = delSet.getAttribute("data-delete-label") || "this tab";
      if (!confirm(`Delete "${label}"? All of its rows will be removed. This cannot be undone.`)) {
        delSet.disabled = false;
        delSet.removeAttribute("disabled");
        return;
      }
      try {
        await api(`/quoting/metric-sets/${setId}`, { method: "DELETE" });
        // If the deleted tab is the one currently shown, redirect to Base
        // (hashchange does the re-mount). Otherwise just re-render the
        // workspace — the tab strip listener is scoped to the strip itself
        // so the old listener dies with the old DOM node.
        const onDeletedTab =
          location.hash === `${baseUrl}/option/${optionN}` ||
          location.hash === `${baseUrl}/project-rentals`;
        if (onDeletedTab) {
          location.hash = `${baseUrl}/base`;
        } else {
          renderEstimateWorkspace(routeFn, estimateId, tab, optionN);
        }
      } catch (err) {
        alert("Failed to delete: " + (err?.message || err));
        delSet.disabled = false;
        delSet.removeAttribute("disabled");
      }
      return;
    }

    const btn = addOpt || addPR;
    if (!btn || btn.hasAttribute("disabled")) return;

    btn.setAttribute("disabled", "true");
    const origText = btn.textContent;
    btn.textContent = "Adding…";
    try {
      const kind = addOpt ? "option" : "project_rentals";
      const created = await api(`/quoting/metric-sets`, {
        method: "POST",
        body:   JSON.stringify({ estimate_id: estimateId, kind }),
      });
      if (addOpt) {
        location.hash = `#/estimate/${estimateId}/option/${created.sort_order}`;
      } else {
        location.hash = `#/estimate/${estimateId}/project-rentals`;
      }
    } catch (err) {
      alert("Failed to add: " + (err?.message || err));
      btn.removeAttribute("disabled");
      btn.textContent = origText;
    }
  }
  // Scope the listener to the tab-strip element so re-rendering the workspace
  // (e.g. after deleting an option from another tab) doesn't leak listeners
  // on document. When the old tab-strip node is removed from the DOM, its
  // listeners are garbage-collected with it.
  const tabsHost = document.querySelector("[data-workspace-tabs]");
  if (tabsHost) tabsHost.addEventListener("click", onShellClick);

  // Dispatch to the active tab's body renderer.
  const tabBody = document.querySelector("[data-tab-body]");
  if (!tabBody) return;
  if (tab === "general") {
    return renderGeneralInfoTab(tabBody, estimate, estimateId, routeFn);
  }
  if (tab === "base") {
    return renderBaseTab(tabBody, estimateId);
  }
  if (tab === "option") {
    const optionSet = options.find(s => s.sort_order === optionN);
    if (!optionSet) {
      tabBody.innerHTML = `
        <div class="card px-5 py-4 text-sm text-red-600">
          Option ${escapeHtml(String(optionN))} not found.
          <div class="pt-2">
            <a href="#/estimate/${estimateId}/base" class="text-blue-600 underline">← Back to Base</a>
          </div>
        </div>`;
      return;
    }
    return renderOptionTab(tabBody, estimateId, optionSet.id);
  }
  if (tab === "project-rentals") {
    if (!projectRentalsSet) {
      tabBody.innerHTML = `
        <div class="card px-5 py-4 text-sm text-red-600">
          No Project Rentals set exists yet.
          <div class="pt-2">
            <a href="#/estimate/${estimateId}/base" class="text-blue-600 underline">← Back to Base</a>
          </div>
        </div>`;
      return;
    }
    return renderOptionTab(tabBody, estimateId, projectRentalsSet.id);
  }
  if (tab === "review") {
    return renderReviewTab(tabBody, estimateId, metricSets, estimate);
  }
}

function renderBaseTab(container, estimateId) {
  // Mount the existing Base Quoting Metrics UI directly into the tab body
  // container. Cleanup returns a function we chain to hashchange.
  mountBaseQuotingMetrics({ container, estimateId })
    .then(cleanup => {
      window.addEventListener("hashchange", cleanup, { once: true });
    })
    .catch(err => {
      container.innerHTML = `<div class="card px-5 py-4 text-sm text-red-600">
        Failed to load Base Quoting Metrics: ${escapeHtml(err?.message || String(err))}
      </div>`;
    });
}

function renderOptionTab(container, estimateId, metricSetId) {
  // Same UI as renderBaseTab — just scoped to a specific (non-Base) metric set.
  mountBaseQuotingMetrics({ container, estimateId, metricSetId })
    .then(cleanup => {
      window.addEventListener("hashchange", cleanup, { once: true });
    })
    .catch(err => {
      container.innerHTML = `<div class="card px-5 py-4 text-sm text-red-600">
        Failed to load Option (metric set ${metricSetId}): ${escapeHtml(err?.message || String(err))}
      </div>`;
    });
}

// ── Review tab ──────────────────────────────────────────────────────────────
// Cross-set rollup: per-set totals from computeSetRollup, plus a "Project
// Total" that sums only enabled (is_enabled=1) sets. Includes is_enabled
// toggles (PATCH /metric-sets/{id}) and a Save Revision button (POST
// /estimates/{id}/revisions).
async function renderReviewTab(container, estimateId, initialMetricSets, estimateRow) {
  container.innerHTML = `<div class="card px-5 py-4 text-sm text-black/50">Loading review…</div>`;

  let metricSets = [...(initialMetricSets || [])];
  // Tracks which aggregate rollup rows are expanded (showing per-set
  // contributions). Persists across re-renders so toggling a different row
  // doesn't collapse the others.
  const expandedRows = new Set();
  let lookups, allLines;
  try {
    [lookups, allLines] = await Promise.all([
      api("/quoting/lookup-values"),
      api(`/quoting/metric-lines?estimate_id=${estimateId}`),
    ]);
  } catch (err) {
    container.innerHTML = `<div class="card px-5 py-4 text-sm text-red-600">
      Failed to load review data: ${escapeHtml(err?.message || String(err))}
    </div>`;
    return;
  }

  // Estimate inputs needed by computeSetRollup. Until we persist these on
  // the estimates row, the General Info tab publishes them to localStorage
  // via opi_estimate_state_v1.
  let estimateState = {};
  try {
    const raw = localStorage.getItem("opi_estimate_state_v1");
    if (raw) estimateState = JSON.parse(raw) || {};
  } catch {}

  const fmtMoney = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "$0";
    return "$" + Math.round(v).toLocaleString("en-US");
  };
  const fmtDays = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "0";
    return v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  };

  // Group all lines by metric_set_id once.
  function groupLines(lines) {
    const out = new Map();
    for (const l of lines) {
      const sid = l.metric_set_id;
      if (!out.has(sid)) out.set(sid, []);
      out.get(sid).push(l);
    }
    return out;
  }

  // Order sets: Base, Options (by sort_order), Project Rentals last.
  function orderedSets(sets) {
    const base = sets.filter(s => s.kind === "base");
    const opts = sets.filter(s => s.kind === "option")
                     .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const pr   = sets.filter(s => s.kind === "project_rentals");
    return [...base, ...opts, ...pr];
  }

  function kindLabel(kind) {
    if (kind === "base") return "Base";
    if (kind === "option") return "Option";
    if (kind === "project_rentals") return "Project Rentals";
    return kind || "—";
  }

  // Compute per-set rollups + cross-set rollup.
  function computeAll() {
    const linesBySet = groupLines(allLines);
    const sets       = orderedSets(metricSets);
    const perSet     = sets.map(set => {
      const lines   = linesBySet.get(set.id) || [];
      const rollup  = computeSetRollup({ set, lines, lookups, estimateState });
      const bundles = computeSetBundles({ set, lines, lookups, estimateState });
      return { set, rollup, bundles };
    });
    const enabled = perSet.filter(({ set }) => Number(set.is_enabled) === 1);
    const sumOf = (k) => enabled.reduce((s, r) => s + (Number(r.rollup[k]) || 0), 0);
    const cross = {
      travel_costs_total: sumOf("travel_costs_total"),
      H38:                sumOf("H38"),
      H39:                sumOf("H39"),    // Materials (Rack)
      H44:                sumOf("H44"),    // Contract Labor (Rack)
      H187:               sumOf("H187"),
      H213:               sumOf("H213"),
      H214:               sumOf("H214"),   // Materials (WG)
      H220:               sumOf("H220"),   // Contract Labor (WG)
      H226:               sumOf("H226"),
      H248:               sumOf("H248"),
      lodging:            sumOf("lodging"),
      mgmt_travel:        sumOf("mgmt_travel"),
      travel_day_costs:   sumOf("travel_day_costs"),
      grand_total:        sumOf("grand_total"),
      // Cells migrated from the General Info "Output Variables" / "Results"
      // cards. Need data from the metric sets, so they live here.
      project_travel_days_cost: sumOf("travel_day_costs"),  // sum of G35
      project_labor_days_cost:  enabled.reduce((s, r) => s + (Number(r.rollup.H44) || 0) + (Number(r.rollup.H220) || 0), 0),
      project_duration_days:    enabled.reduce((s, r) => s + (Number(r.rollup.D22) || 0) + (Number(r.rollup.D23) || 0) + (Number(r.rollup.D24) || 0), 0),
      buffer_days:              enabled.reduce((s, r) => s + (Number(r.rollup.M20) || 0) + (Number(r.rollup.M21) || 0), 0),
      // Mobilizations split by which kind of work the set actually contains.
      mob_count_rack:           enabled.reduce((s, r) => s + ((Number(r.rollup.rack_days) || 0) > 0 ? (Number(r.rollup.mobilizations) || 0) : 0), 0),
      mob_count_wire:           enabled.reduce((s, r) => s + ((Number(r.rollup.wire_days) || 0) > 0 ? (Number(r.rollup.mobilizations) || 0) : 0), 0),
    };

    // Pricing: apply per-category profit targets to the bundled cost
    // sections (price = cost / (1 - profit_pct)). Travel & WG add'l items
    // pass through at cost — adjust if the workbook says otherwise.
    const pct = (v) => {
      const n = Number(v ?? 0);
      return Number.isFinite(n) ? n / 100 : 0;
    };
    const r  = pct(estimateState.rack_install_profit_target);
    const w  = pct(estimateState.wire_guidance_profit_target);
    const rr = pct(estimateState.rental_rack_profit_target);
    const rw = pct(estimateState.rental_wire_profit_target);
    const markUp = (cost, p) => (p > 0 && p < 1 ? cost / (1 - p) : cost);
    const price =
        markUp(cross.H38,  r)
      + markUp(cross.H213, w)
      + markUp(cross.H187, rr)
      + markUp(cross.H226, rw)
      + cross.travel_costs_total
      + cross.H248;
    const projected_cost   = cross.grand_total;
    const projected_profit = price - projected_cost;
    const margin           = price > 0 ? projected_profit / price : 0;
    // labor_cost_per_day is the same across sets (it's derived from
    // estimate-level inputs), so pull from any rollup. Falls back to 0 when
    // no sets exist or the estimate inputs aren't filled in.
    const labor_per_day    = Number(perSet[0]?.rollup?.labor_cost_per_day ?? 0);
    cross.price_to_customer    = price;
    cross.projected_cost       = projected_cost;
    cross.projected_profit     = projected_profit;
    cross.projected_margin     = margin;
    cross.projected_buffer     = cross.buffer_days * labor_per_day;
    cross.project_duration_wks = cross.project_duration_days / 7;

    return { perSet, cross, enabledCount: enabled.length };
  }

  // Build the inner HTML — re-called on every toggle/save.
  function render() {
    const { perSet, cross, enabledCount } = computeAll();
    const rev = Number(estimateRow?.revision_count ?? 0);

    const lastRevDate = estimateRow?.latest_revision_date
      ? String(estimateRow.latest_revision_date)
      : null;
    const revLine = rev > 0
      ? `Revision ${rev}${lastRevDate ? ` · saved ${escapeHtml(lastRevDate)}` : ""}`
      : "No revision saved yet";

    const headerHtml = `
      <div class="card px-5 py-4">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div class="text-xs font-extrabold uppercase tracking-wide text-black/60">Project Total</div>
            <div class="text-2xl font-extrabold text-ink-900">${fmtMoney(cross.grand_total)}</div>
            <div class="text-[11px] text-black/40">
              ${enabledCount} of ${perSet.length} set${perSet.length === 1 ? "" : "s"} enabled · ${revLine}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[11px] text-emerald-700" data-rev-saved-at></span>
            ${rev > 0 ? `<button type="button" data-rev-history class="rounded-lg bg-slate-100 text-slate-700 text-sm px-3 py-2 font-semibold hover:bg-slate-200">History</button>` : ""}
            <button type="button" data-save-revision
                    class="btn-primary text-sm px-4 py-2">
              Save Revision
            </button>
          </div>
        </div>
      </div>`;

    const perSetRowsHtml = perSet.map(({ set, rollup }) => {
      const enabled = Number(set.is_enabled) === 1;
      const label   = set.label || kindLabel(set.kind);
      const sub     = `${kindLabel(set.kind)}${set.kind === "option" ? ` · #${set.sort_order}` : ""}`;
      return `
        <tr class="border-t border-black/10 ${enabled ? "" : "opacity-50"}" data-set-row data-set-id="${set.id}">
          <td class="py-2 px-3 align-middle">
            <label class="inline-flex items-center cursor-pointer select-none">
              <input type="checkbox" class="sr-only peer" data-set-toggle ${enabled ? "checked" : ""}/>
              <span class="w-9 h-5 bg-black/20 rounded-full relative transition
                           peer-checked:bg-emerald-500
                           after:content-[''] after:absolute after:top-0.5 after:left-0.5
                           after:bg-white after:rounded-full after:h-4 after:w-4 after:transition
                           peer-checked:after:translate-x-4"></span>
            </label>
          </td>
          <td class="py-2 px-3 align-middle">
            <div class="text-sm font-semibold">${escapeHtml(label)}</div>
            <div class="text-[11px] text-black/50">${escapeHtml(sub)}</div>
          </td>
          <td class="py-2 px-3 align-middle text-right tabular-nums text-sm">${fmtDays(rollup.D22)}</td>
          <td class="py-2 px-3 align-middle text-right tabular-nums text-sm">${fmtDays(rollup.D23)}</td>
          <td class="py-2 px-3 align-middle text-right tabular-nums text-sm">${fmtDays(rollup.D24)}</td>
          <td class="py-2 px-3 align-middle text-right tabular-nums text-sm">${fmtMoney(rollup.travel_costs_total)}</td>
          <td class="py-2 px-3 align-middle text-right tabular-nums text-sm font-semibold">${fmtMoney(rollup.grand_total)}</td>
        </tr>`;
    }).join("");

    const perSetHtml = `
      <div class="card px-5 py-4">
        <div class="text-sm font-extrabold uppercase tracking-wide text-black/70 pb-2 border-b border-black/10">
          Sets
        </div>
        <div class="pt-3 overflow-x-auto">
          <table class="min-w-full text-sm">
            <thead>
              <tr class="text-[11px] uppercase tracking-wide text-black/50">
                <th class="py-1 px-3 text-left w-14">On</th>
                <th class="py-1 px-3 text-left">Set</th>
                <th class="py-1 px-3 text-right">Travel Days</th>
                <th class="py-1 px-3 text-right">Rack Days</th>
                <th class="py-1 px-3 text-right">WG Days</th>
                <th class="py-1 px-3 text-right">Travel $</th>
                <th class="py-1 px-3 text-right">Set Total</th>
              </tr>
            </thead>
            <tbody>
              ${perSetRowsHtml || `<tr><td colspan="7" class="py-4 px-3 text-center text-black/40 text-sm">No metric sets.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>`;

    // Only enabled sets contribute to the rollup. We use their labels in the
    // per-row breakdowns when an aggregate row is expanded.
    const enabledSets = perSet.filter(({ set }) => Number(set.is_enabled) === 1);
    const setLabel = (set) => set.label || kindLabel(set.kind);

    // Aggregate row with optional per-set expansion. `valueOf(rollup)` picks
    // the per-set contribution to this row's total. `subRows` are an optional
    // nested breakdown (e.g. Materials + Contract Labor under Rack Install).
    const rollupRow = (label, amount, opts = {}) => {
      const isBold     = opts.bold === true;
      const isSubRow   = opts.sub === true;
      const expandKey  = opts.expandKey;
      const expanded   = expandKey ? expandedRows.has(expandKey) : false;
      const valueOf    = opts.valueOf;
      const subRows    = opts.subRows || [];

      const chevron = expandKey
        ? `<svg class="w-3 h-3 text-black/40 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
             <path d="M9 6l6 6-6 6"/>
           </svg>`
        : `<span class="w-3 h-3 inline-block"></span>`;

      const labelClass = isBold
        ? "font-extrabold uppercase tracking-wide text-black/70"
        : (isSubRow ? "text-black/55" : "text-black/70");
      const valueClass = isBold ? "font-extrabold text-ink-900" : "";
      const rowClass = [
        "flex items-baseline justify-between py-1.5",
        isBold ? "border-t border-black/20 pt-2 mt-1" : "",
        isSubRow ? "pl-6 text-xs" : "text-sm",
        expandKey ? "cursor-pointer hover:bg-black/[0.02] -mx-2 px-2 rounded" : "",
      ].filter(Boolean).join(" ");

      const headerHtml = `
        <div class="${rowClass}" ${expandKey ? `data-rollup-toggle="${escapeHtml(expandKey)}"` : ""}>
          <span class="flex items-baseline gap-1.5">
            ${expandKey ? chevron : ""}
            <span class="${labelClass}">${escapeHtml(label)}</span>
          </span>
          <span class="tabular-nums ${valueClass}">${fmtMoney(amount)}</span>
        </div>`;

      // Sub-rows (always shown when present, e.g. Materials/Contract Labor)
      const subRowsHtml = subRows.map(sr =>
        rollupRow(sr.label, sr.amount, { sub: true, expandKey: sr.expandKey, valueOf: sr.valueOf })
      ).join("");

      // Per-set expansion panel — only present if expandKey + valueOf were
      // provided. Hidden until the user toggles the row.
      const expansionHtml = (expandKey && valueOf)
        ? `<div class="${expanded ? "" : "hidden"} pl-6 pb-1" data-rollup-detail="${escapeHtml(expandKey)}">
             ${enabledSets.length === 0
               ? `<div class="text-[11px] italic text-black/40 py-1">No enabled sets contribute.</div>`
               : enabledSets.map(({ set, rollup }) => `
                   <div class="flex items-baseline justify-between py-0.5 text-[11px] text-black/55">
                     <span>${escapeHtml(setLabel(set))}</span>
                     <span class="tabular-nums">${fmtMoney(valueOf(rollup))}</span>
                   </div>`).join("")}
           </div>`
        : "";

      return headerHtml + subRowsHtml + expansionHtml;
    };

    const crossHtml = `
      <div class="card px-5 py-4">
        <div class="text-sm font-extrabold uppercase tracking-wide text-black/70 pb-2 border-b border-black/10">
          Cost Summary
          <span class="text-[11px] italic text-black/40 font-normal normal-case tracking-normal">
            (sum across enabled sets · click a row for per-set breakdown)
          </span>
        </div>
        <div class="pt-3">
          ${rollupRow("Travel Costs",          cross.travel_costs_total, {
            expandKey: "travel_costs_total",
            valueOf: (r) => r.travel_costs_total,
          })}
          ${rollupRow("Rack Install (Mat + Labor)", cross.H38, {
            expandKey: "H38",
            valueOf: (r) => r.H38,
            subRows: [
              { label: "Materials",       amount: cross.H39, expandKey: "H39", valueOf: (r) => r.H39 },
              { label: "Contract Labor",  amount: cross.H44, expandKey: "H44", valueOf: (r) => r.H44 },
            ],
          })}
          ${rollupRow("Rentals — Rack Install",  cross.H187, {
            expandKey: "H187", valueOf: (r) => r.H187,
          })}
          ${rollupRow("Wire Guidance (Mat + Labor)", cross.H213, {
            expandKey: "H213",
            valueOf: (r) => r.H213,
            subRows: [
              { label: "Materials",      amount: cross.H214, expandKey: "H214", valueOf: (r) => r.H214 },
              { label: "Contract Labor", amount: cross.H220, expandKey: "H220", valueOf: (r) => r.H220 },
            ],
          })}
          ${rollupRow("Rentals — Wire Guidance", cross.H226, {
            expandKey: "H226", valueOf: (r) => r.H226,
          })}
          ${rollupRow("Wire Guidance Add'l Items", cross.H248, {
            expandKey: "H248", valueOf: (r) => r.H248,
          })}
          ${rollupRow("Project Total",           cross.grand_total, { bold: true })}
        </div>
      </div>`;

    // Travel Costs aggregate card — mirrors the per-set Travel Costs card
    // that lives on Base/Option/PR tabs, but summed across enabled sets and
    // expandable to show each set's contribution.
    const travelCostsHtml = `
      <div class="card px-5 py-4">
        <div class="text-sm font-extrabold uppercase tracking-wide text-black/70 pb-2 border-b border-black/10">
          Travel Costs
          <span class="text-[11px] italic text-black/40 font-normal normal-case tracking-normal">
            (sum across enabled sets · click a row for per-set breakdown)
          </span>
        </div>
        <div class="pt-3">
          ${rollupRow("Lodging",          cross.lodging, {
            expandKey: "lodging", valueOf: (r) => r.lodging,
          })}
          ${rollupRow("Mgmt Travel",      cross.mgmt_travel, {
            expandKey: "mgmt_travel", valueOf: (r) => r.mgmt_travel,
          })}
          ${rollupRow("Travel Day Costs", cross.travel_day_costs, {
            expandKey: "travel_day_costs", valueOf: (r) => r.travel_day_costs,
          })}
          ${rollupRow("Travel Costs Total", cross.travel_costs_total, { bold: true })}
        </div>
      </div>`;

    // Cells migrated from the General Info "Output Variables" / "Results"
    // cards. Pricing/profit uses a simple "price = cost / (1 - profit%)"
    // markup model — refine as the workbook's blended logic gets pinned down.
    const fmtPct = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return "—";
      return (n * 100).toFixed(1) + "%";
    };
    // `opts.formula` shows the formula being used as a small italic tip below
    // the value cell. Use for cells whose calc is an approximation we want
    // documented while it's being verified against the workbook.
    const readout = (label, valueHtml, opts = {}) => {
      const formula = opts.formula
        ? `<div class="text-[10px] italic text-black/45 leading-tight pt-0.5 px-0.5">
             <span class="font-semibold not-italic text-black/55">ƒ</span> ${escapeHtml(opts.formula)}
           </div>`
        : "";
      return `
        <div class="flex flex-col gap-1">
          <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
          <div class="text-sm font-semibold tabular-nums ${opts.color || "text-ink-900"} bg-black/[0.03] border border-black/10 rounded-lg px-3 py-1.5">
            ${valueHtml}
          </div>
          ${formula}
        </div>`;
    };

    const resultsHtml = `
      <div class="card px-5 py-4">
        <div class="text-sm font-extrabold uppercase tracking-wide text-black/70 pb-2 border-b border-black/10">
          Estimating Results
          <span class="text-[11px] italic text-black/40 font-normal normal-case tracking-normal">
            (cross-tab calcs — uses enabled sets + General Info inputs)
          </span>
        </div>
        <div class="pt-3 grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3">
          <div class="flex flex-col gap-3">
            ${readout("Price to Customer", fmtMoney(cross.price_to_customer), {
              formula: "Σ section_cost / (1 − profit% per category) — pending workbook verification",
            })}
            ${readout("Projected Profit", fmtMoney(cross.projected_profit), {
              color: "text-emerald-700",
              formula: "Price to Customer − Projected Cost",
            })}
            ${readout("Projected Cost", fmtMoney(cross.projected_cost), {
              formula: "Project Total (sum of 6 sections across enabled sets)",
            })}
            ${readout("Projected Buffer", fmtMoney(cross.projected_buffer), {
              formula: "(M20 + M21) buffer days × Labor Cost/Day — verify against workbook",
            })}
            ${readout("Projected Profit Margin", fmtPct(cross.projected_margin), {
              formula: "Projected Profit ÷ Price to Customer",
            })}
          </div>
          <div class="flex flex-col gap-3">
            <div class="flex flex-col gap-1">
              <label class="text-[11px] font-semibold text-black/60">Projected Project Duration</label>
              <div class="flex items-center gap-2">
                <div class="text-sm font-semibold tabular-nums bg-black/[0.03] border border-black/10 rounded-lg px-3 py-1.5 flex-1">
                  ${fmtDays(cross.project_duration_days)} <span class="text-xs text-black/40">days</span>
                </div>
                <div class="text-sm font-semibold tabular-nums bg-black/[0.03] border border-black/10 rounded-lg px-3 py-1.5 flex-1">
                  ${fmtDays(cross.project_duration_wks)} <span class="text-xs text-black/40">weeks</span>
                </div>
              </div>
              <div class="text-[10px] italic text-black/45 leading-tight pt-0.5 px-0.5">
                <span class="font-semibold not-italic text-black/55">ƒ</span> Σ (D22 + D23 + D24) across enabled sets · weeks = days ÷ 7 — workbook may use max() for parallel crews
              </div>
            </div>
            ${readout("Expected Mobilization Count (Rack)", fmtDays(cross.mob_count_rack), {
              formula: "Σ mobilizations from enabled sets where rack_days > 0",
            })}
            ${readout("Expected Mobilization Count (Wire)", fmtDays(cross.mob_count_wire), {
              formula: "Σ mobilizations from enabled sets where wire_days > 0",
            })}
            ${readout("Project Travel Days — Cost", fmtMoney(cross.project_travel_days_cost), {
              formula: "Σ travel_day_costs (G35 = labor_cost_per_travel_day × D22) across enabled sets",
            })}
            ${readout("Project Labor Days — Cost", fmtMoney(cross.project_labor_days_cost), {
              formula: "Σ (H44 + H220) across enabled sets",
            })}
          </div>
        </div>
      </div>`;

    // QuickBooks Bundle Output — aggregate across enabled sets, with per-set
    // expansion per bundle. Each bundle's lines (Contract Labor, Materials,
    // OH&P, etc.) are summed across enabled sets; clicking a bundle expands
    // to show each set's total.
    const BUNDLE_KINDS = [
      { key: "installation",   title: "Installation (Labor Bundle)" },
      { key: "rentals",        title: "Rentals (Bundle)" },
      { key: "wg_labor",       title: "Wire Guidance (Labor Bundle)" },
      { key: "wg_additional",  title: "Wire Guidance (Additional Items)" },
      { key: "mobilization",   title: "Mobilization" },
      { key: "remobilization", title: "Remobilization" },
      { key: "downtime",       title: "Downtime" },
    ];

    // Build aggregate bundle = sum of corresponding lines across enabled sets.
    function aggregateBundle(bundleKey) {
      const sample = enabledSets[0]?.bundles?.[bundleKey];
      if (!sample) return { title: BUNDLE_KINDS.find(b => b.key === bundleKey)?.title || bundleKey, total: 0, lines: [] };
      // Sum lines element-wise. Preserve labels + opts from the first set.
      const aggLines = sample.lines.map((entry, idx) => {
        const [label, , opts] = entry;
        let sum = 0;
        for (const { bundles } of enabledSets) {
          const line = bundles?.[bundleKey]?.lines?.[idx];
          if (line && Number.isFinite(Number(line[1]))) sum += Number(line[1]);
        }
        return [label, sum, opts];
      });
      let total = 0;
      for (const { bundles } of enabledSets) {
        total += Number(bundles?.[bundleKey]?.total) || 0;
      }
      return { title: sample.title, total, lines: aggLines };
    }

    const renderBundle = (bundleKey) => {
      const agg = aggregateBundle(bundleKey);
      const expandKey = `bundle_${bundleKey}`;
      const expanded  = expandedRows.has(expandKey);
      const lineRows  = agg.lines.map(([label, value, opts = {}]) => `
        <div class="grid grid-cols-[1fr_auto] gap-x-3 py-0.5 pl-5">
          <span class="text-xs ${opts.stub ? "text-black/30 italic" : "text-black/60"}">${escapeHtml(label)}${opts.stub ? " *" : ""}</span>
          <span class="text-xs tabular-nums ${opts.stub ? "text-black/30" : ""}">${fmtMoney(value)}</span>
        </div>`).join("");
      const perSetRows = enabledSets.length === 0
        ? `<div class="text-[11px] italic text-black/40 pl-5 py-1">No enabled sets contribute.</div>`
        : enabledSets.map(({ set, bundles }) => `
            <div class="grid grid-cols-[1fr_auto] gap-x-3 py-0.5 pl-5 text-[11px] text-black/55">
              <span>${escapeHtml(setLabel(set))}</span>
              <span class="tabular-nums">${fmtMoney(bundles?.[bundleKey]?.total ?? 0)}</span>
            </div>`).join("");
      return `
        <div class="pb-3">
          <div class="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-2 py-1.5 border-b border-black/10 mb-1 cursor-pointer hover:bg-black/[0.02] -mx-2 px-2 rounded"
               data-rollup-toggle="${expandKey}">
            <svg class="w-3 h-3 text-black/40 transition-transform ${expanded ? "rotate-90" : ""}" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
              <path d="M9 6l6 6-6 6"/>
            </svg>
            <span class="text-sm font-bold text-black/80">${escapeHtml(agg.title)}</span>
            <span class="text-sm tabular-nums font-bold">${fmtMoney(agg.total)}</span>
          </div>
          ${lineRows}
          <div class="${expanded ? "" : "hidden"} mt-1 pt-1 border-t border-dashed border-black/10">
            <div class="text-[10px] uppercase tracking-wider text-black/40 pl-5 pb-1">By Set</div>
            ${perSetRows}
          </div>
        </div>`;
    };

    const bundleHtml = `
      <div class="card px-5 py-4">
        <div class="text-sm font-extrabold uppercase tracking-wide text-black/70 pb-2 border-b border-black/10">
          QuickBooks Bundle Output
          <span class="text-[11px] italic text-black/40 font-normal normal-case tracking-normal">
            (aggregate across enabled sets · click a bundle for per-set totals · * = not yet modeled)
          </span>
        </div>
        <div class="pt-3 grid grid-cols-1 lg:grid-cols-2 gap-x-8">
          <div>
            ${renderBundle("installation")}
            ${renderBundle("rentals")}
            ${renderBundle("wg_labor")}
            ${renderBundle("wg_additional")}
          </div>
          <div>
            ${renderBundle("mobilization")}
            ${renderBundle("remobilization")}
            ${renderBundle("downtime")}
          </div>
        </div>
      </div>`;

    container.innerHTML = `
      <div class="grid grid-cols-1 gap-3">
        ${headerHtml}
        ${perSetHtml}
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
          ${crossHtml}
          ${travelCostsHtml}
        </div>
        ${bundleHtml}
        ${resultsHtml}
      </div>`;
  }

  render();

  // Toggle clicks → PATCH is_enabled → recompute.
  async function onToggleChange(e) {
    const cb = e.target.closest("[data-set-toggle]");
    if (!cb) return;
    const row = cb.closest("[data-set-row]");
    const sid = Number(row?.dataset?.setId);
    const set = metricSets.find(s => s.id === sid);
    if (!set) return;
    const newVal = cb.checked ? 1 : 0;
    cb.disabled = true;
    try {
      await api(`/quoting/metric-sets/${sid}`, {
        method: "PATCH",
        body:   JSON.stringify({ is_enabled: newVal }),
      });
      set.is_enabled = newVal;
      render();
    } catch (err) {
      cb.checked = !cb.checked;
      alert("Failed to toggle: " + (err?.message || err));
    } finally {
      cb.disabled = false;
    }
  }

  // Reasons a customer-driven revision happens (fixed list → clean analytics).
  const REVISION_REASONS = ["Initial estimate", "Price / budget", "Scope change",
    "Added items", "Removed items", "Material / spec change", "Timeline change",
    "Clarification / correction", "Other"];

  // Ask WHY before snapshotting, so we can report who revises + why.
  function openRevisionSaveModal(currentTotal, onConfirm) {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4";
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
        <div class="text-base font-bold text-ink-900 mb-1">Save revision</div>
        <div class="text-xs text-black/50 mb-3">Snapshots the current numbers (${fmtMoney(currentTotal)}) and logs why, for revision analytics.</div>
        <label class="block mb-3"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Reason</div>
          <select data-reason class="input text-sm py-1.5 w-full">${REVISION_REASONS.map(r => `<option>${r}</option>`).join("")}</select></label>
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Note (optional)</div>
          <textarea data-note rows="2" class="input text-sm py-1.5 w-full" placeholder="Detail, e.g. which items changed"></textarea></label>
        <div class="mt-4 flex items-center justify-end gap-2">
          <button data-cancel class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Cancel</button>
          <button data-save class="btn-primary text-sm px-4 py-1.5">Save revision</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector("[data-cancel]").addEventListener("click", close);
    overlay.querySelector("[data-save]").addEventListener("click", () => {
      const reason = overlay.querySelector("[data-reason]").value;
      const note = overlay.querySelector("[data-note]").value.trim() || null;
      close(); onConfirm({ reason, note });
    });
  }

  async function openRevisionHistoryModal() {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4";
    overlay.innerHTML = `<div class="bg-white rounded-2xl shadow-xl w-full max-w-lg p-5 max-h-[85vh] overflow-auto" data-card><div class="text-sm text-black/40">Loading…</div></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) overlay.remove(); });
    const card = overlay.querySelector("[data-card]");
    try {
      const revs = (await api(`/estimates/${estimateId}/revisions`)).revisions || [];
      card.innerHTML = `
        <div class="flex items-center justify-between mb-3"><div class="text-base font-bold text-ink-900">Revision history</div>
          <button data-close class="text-black/40 hover:text-black/70 text-xl leading-none">&times;</button></div>
        ${revs.length ? `<div class="space-y-2">${revs.map(r => `
          <div class="rounded-xl border border-black/10 px-3 py-2">
            <div class="flex items-center justify-between gap-2">
              <div class="text-sm font-semibold text-ink-900">Rev ${r.revision_number} <span class="text-black/40 font-normal">· ${escapeHtml(r.reason || "—")}</span></div>
              <div class="text-xs tabular-nums text-black/60">${r.total_amount != null ? fmtMoney(r.total_amount) : ""}</div></div>
            <div class="text-[11px] text-black/45">${escapeHtml((r.saved_at || "").slice(0, 10))}${r.saved_by ? " · " + escapeHtml(r.saved_by) : ""}${r.note ? " · " + escapeHtml(r.note) : ""}</div>
          </div>`).join("")}</div>` : `<div class="text-sm text-black/45 py-4">No revisions saved yet.</div>`}`;
      card.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    } catch (e) { card.innerHTML = `<div class="text-sm text-red-700">Failed to load history.</div>`; }
  }

  // Save Revision button → capture reason → POST snapshot → bump header rev count.
  async function onSaveRevisionClick(e) {
    const btn = e.target.closest("[data-save-revision]");
    if (!btn || btn.hasAttribute("disabled")) return;
    const { cross } = computeAll();
    openRevisionSaveModal(cross.grand_total, async ({ reason, note }) => {
      btn.setAttribute("disabled", "true");
      const origText = btn.textContent;
      btn.textContent = "Saving…";
      try {
        const resp = await api(`/estimates/${estimateId}/revisions`, {
          method: "POST", body: JSON.stringify({ reason, note, total_amount: cross.grand_total }),
        });
        const newRev = Number(resp?.revision_number ?? 0);
        if (estimateRow) {
          estimateRow.revision_count       = newRev;
          estimateRow.latest_revision_date = resp?.latest_revision_date ?? estimateRow.latest_revision_date;
        }
        render();
        const stamp = container.querySelector("[data-rev-saved-at]");
        if (stamp) stamp.textContent = `Saved rev ${newRev}`;
      } catch (err) {
        alert("Save failed: " + (err?.message || err));
      } finally {
        btn.removeAttribute("disabled");
        btn.textContent = origText;
      }
    });
  }

  function onRevHistoryClick(e) { if (e.target.closest("[data-rev-history]")) openRevisionHistoryModal(); }

  // Rollup-row chevron clicks → toggle the per-set expansion panel.
  function onRollupToggleClick(e) {
    const row = e.target.closest("[data-rollup-toggle]");
    if (!row) return;
    const key = row.getAttribute("data-rollup-toggle");
    if (!key) return;
    if (expandedRows.has(key)) expandedRows.delete(key);
    else                       expandedRows.add(key);
    render();
  }

  container.addEventListener("change", onToggleChange);
  container.addEventListener("click", onSaveRevisionClick);
  container.addEventListener("click", onRevHistoryClick);
  container.addEventListener("click", onRollupToggleClick);
  window.addEventListener("hashchange", () => {
    container.removeEventListener("change", onToggleChange);
    container.removeEventListener("click", onSaveRevisionClick);
    container.removeEventListener("click", onRevHistoryClick);
    container.removeEventListener("click", onRollupToggleClick);
  }, { once: true });
}

// ── Customer picker ─────────────────────────────────────────────────────────
// Matches the look of the Assignments page: sortable + filterable column
// headers, btn-primary CTAs, consistent text-xs uppercase headers, neutral
// inline secondary buttons.
async function renderCustomerPicker(routeFn) {
  let customers, lookups;
  try {
    [customers, lookups] = await Promise.all([
      api("/estimates/customers"),
      api("/quoting/lookup-values"),
    ]);
  } catch (err) {
    setShell({
      title: "",
      bodyHtml: `<div class="card px-5 py-4 text-sm text-red-600">
        Failed to load customers: ${escapeHtml(err?.message || String(err))}
      </div>`,
      showLogout: true,
      routeFn,
    });
    return;
  }

  const STATUS_OPTS = (lookups && lookups.estimate_pipeline_status) || [];
  const COMM_OPTS   = (lookups && lookups.communication_type)       || [];

  // ── table state ───────────────────────────────────────────────────────────
  const tableState = {
    sortKey: "meta_create_time",
    sortDir: "desc",
    filters: {
      pipeline_status:           [],
      last_communication_type:   [],
      estimate_action:           [],   // multi: ["open", "create"]
      display_name:              "",
      email:                     "",
      last_contact_from:         "",
      last_contact_to:           "",
      created_from:              "",
      created_to:                "",
    },
    openFilter: null,      // column key whose filter dropdown is open
    openStatusFor: null,   // customer id whose status pill menu is open
  };

  // Format mm-dd-yy hh:mi am/pm in local time. Naive DB strings are treated
  // as UTC (matches QBO source).
  const fmtLocal = (s) => {
    if (!s) return "—";
    const d = new Date(typeof s === "string" && !s.endsWith("Z") ? s + "Z" : s);
    if (Number.isNaN(d.getTime())) return escapeHtml(String(s));
    const pad = (n) => String(n).padStart(2, "0");
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const yy = pad(d.getFullYear() % 100);
    let hour = d.getHours();
    const ampm = hour >= 12 ? "PM" : "AM";
    hour = hour % 12 || 12;
    return `${mm}-${dd}-${yy} ${pad(hour)}:${pad(d.getMinutes())} ${ampm}`;
  };

  // Format an ISO date (yyyy-mm-dd) as mm-dd-yyyy. "—" when blank.
  const fmtDateOnly = (s) => {
    if (!s) return "—";
    const str = String(s).slice(0, 10);
    const parts = str.split("-");
    if (parts.length !== 3) return escapeHtml(str);
    return `${parts[1]}-${parts[2]}-${parts[0]}`;
  };

  // ── sort + filter helpers (mirror Assignments page conventions) ───────────
  function sortArrow(key) {
    return tableState.sortKey === key
      ? (tableState.sortDir === "asc" ? " ▲" : " ▼")
      : "";
  }
  function filterIcon(active = false) {
    return `<svg class="shrink-0 size-3.5 ${active ? "text-black" : "text-black/40"}"
      xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
    </svg>`;
  }
  // Map a customer row to its action state ("open" if an estimate exists,
  // "create" otherwise). Used by both sort and filter on the action column.
  const estimateActionKey = (c) => (c.estimate_id != null ? "open" : "create");

  function isFilterActive(key) {
    const f = tableState.filters;
    if (key === "pipeline_status")         return f.pipeline_status.length > 0;
    if (key === "last_communication_type") return f.last_communication_type.length > 0;
    if (key === "estimate_action")         return f.estimate_action.length > 0;
    if (key === "display_name")            return !!f.display_name;
    if (key === "email")                   return !!f.email;
    if (key === "last_contact_date")       return !!(f.last_contact_from || f.last_contact_to);
    if (key === "meta_create_time")        return !!(f.created_from || f.created_to);
    return false;
  }
  function sortValue(c, key) {
    switch (key) {
      case "pipeline_status":         return c.pipeline_status || "";
      case "last_contact_date":       return c.last_contact_date || "";
      case "follow_up_qty":           return Number(c.follow_up_qty ?? 0);
      case "last_communication_type": return c.last_communication_type || "";
      case "estimate_action":         return estimateActionKey(c);
      case "estimate_revision_count": return Number(c.estimate_revision_count ?? 0);
      case "display_name":            return c.display_name || "";
      case "email":                   return c.email || "";
      case "meta_create_time":        return c.meta_create_time || "";
      default:                        return "";
    }
  }
  function compareValues(a, b, key) {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (key === "last_contact_date" || key === "meta_create_time") {
      const aDate = av ? new Date(av) : null;
      const bDate = bv ? new Date(bv) : null;
      if (!aDate && !bDate) return 0;
      if (!aDate) return 1;
      if (!bDate) return -1;
      return aDate.getTime() - bDate.getTime();
    }
    if (key === "follow_up_qty" || key === "estimate_revision_count") return Number(av) - Number(bv);
    return String(av).localeCompare(String(bv));
  }
  function sortRows(list) {
    return [...list].sort((a, b) => {
      const cmp = compareValues(a, b, tableState.sortKey);
      if (cmp !== 0) return tableState.sortDir === "asc" ? cmp : -cmp;
      return String(a.display_name || "").localeCompare(String(b.display_name || ""));
    });
  }
  function filterRows(list) {
    const f = tableState.filters;
    return list.filter(c => {
      if (f.pipeline_status.length && !f.pipeline_status.includes(c.pipeline_status || "")) return false;
      if (f.last_communication_type.length && !f.last_communication_type.includes(c.last_communication_type || "")) return false;
      if (f.estimate_action.length && !f.estimate_action.includes(estimateActionKey(c))) return false;
      if (f.display_name && !String(c.display_name || "").toLowerCase().includes(f.display_name.toLowerCase())) return false;
      if (f.email && !String(c.email || "").toLowerCase().includes(f.email.toLowerCase())) return false;
      const lc = String(c.last_contact_date || "").slice(0, 10);
      if (f.last_contact_from && (!lc || lc < f.last_contact_from)) return false;
      if (f.last_contact_to   && (!lc || lc > f.last_contact_to))   return false;
      const cr = String(c.meta_create_time || "").slice(0, 10);
      if (f.created_from && (!cr || cr < f.created_from)) return false;
      if (f.created_to   && (!cr || cr > f.created_to))   return false;
      return true;
    });
  }

  function renderMultiSelectMenu(key, title, options) {
    if (tableState.openFilter !== key) return "";
    const selected = tableState.filters[key] || [];
    const rows = options.map(({ value, label }) => {
      const checked = selected.includes(value);
      return `
        <label class="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-black/[0.04] cursor-pointer select-none">
          <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? "bg-black border-black" : "bg-white border-black/30"}">
            ${checked ? `<svg class="h-2.5 w-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>` : ""}
          </span>
          <input type="checkbox" class="sr-only"
                 data-multiselect-check="${key}"
                 data-multiselect-value="${escapeHtml(value)}"
                 ${checked ? "checked" : ""}/>
          <span class="text-xs">${escapeHtml(label)}</span>
        </label>`;
    }).join("");
    return `
      <div class="absolute left-0 top-8 z-50 w-72 rounded-xl border border-black/10 bg-white p-3 shadow-xl" data-filter-menu="1">
        <div class="text-xs font-bold text-black/50 mb-2">${escapeHtml(title)}</div>
        <div class="flex flex-col gap-0 max-h-[260px] overflow-auto">${rows}</div>
        <div class="mt-3 flex justify-end gap-2">
          <button type="button" class="inline-flex items-center rounded-xl border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-black/5" data-clear-filter="${key}">Clear</button>
          <button type="button" class="btn-primary text-xs !px-3 !py-1.5" data-close-filter="1">Done</button>
        </div>
      </div>`;
  }
  function renderTextFilterMenu(key, title, placeholder) {
    if (tableState.openFilter !== key) return "";
    return `
      <div class="absolute left-0 top-8 z-50 w-72 rounded-xl border border-black/10 bg-white p-3 shadow-xl" data-filter-menu="1">
        <div class="text-xs font-bold text-black/50 mb-2">${escapeHtml(title)}</div>
        <input class="input text-xs py-1.5"
               placeholder="${escapeHtml(placeholder)}"
               data-filter-input="${key}"
               value="${escapeHtml(tableState.filters[key] || "")}"/>
        <div class="mt-3 flex justify-end gap-2">
          <button type="button" class="inline-flex items-center rounded-xl border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-black/5" data-clear-filter="${key}">Clear</button>
          <button type="button" class="btn-primary text-xs !px-3 !py-1.5" data-close-filter="1">Done</button>
        </div>
      </div>`;
  }
  function renderDateRangeMenu(colKey, keyBase, title) {
    if (tableState.openFilter !== colKey) return "";
    const fromVal = tableState.filters[`${keyBase}_from`] || "";
    const toVal   = tableState.filters[`${keyBase}_to`]   || "";
    return `
      <div class="absolute left-0 top-8 z-50 w-72 rounded-xl border border-black/10 bg-white p-3 shadow-xl" data-filter-menu="1">
        <div class="text-xs font-bold text-black/50 mb-2">${escapeHtml(title)}</div>
        <div class="grid grid-cols-1 gap-2">
          <label class="text-[11px] text-black/60">From</label>
          <input type="date" class="input text-xs py-1.5"
                 data-filter-input="${keyBase}_from"
                 value="${escapeHtml(fromVal)}"/>
          <label class="text-[11px] text-black/60">To</label>
          <input type="date" class="input text-xs py-1.5"
                 data-filter-input="${keyBase}_to"
                 value="${escapeHtml(toVal)}"/>
        </div>
        <div class="mt-3 flex justify-end gap-2">
          <button type="button" class="inline-flex items-center rounded-xl border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-black/5" data-clear-filter="${colKey}">Clear</button>
          <button type="button" class="btn-primary text-xs !px-3 !py-1.5" data-close-filter="1">Done</button>
        </div>
      </div>`;
  }
  function renderFilterMenu(key) {
    if (tableState.openFilter !== key) return "";
    if (key === "pipeline_status")
      return renderMultiSelectMenu(key, "Filter Status", STATUS_OPTS.map(o => ({ value: o.key, label: o.key })));
    if (key === "last_communication_type")
      return renderMultiSelectMenu(key, "Filter Last Comm", COMM_OPTS.map(o => ({ value: o.key, label: o.key })));
    if (key === "estimate_action")
      return renderMultiSelectMenu(key, "Filter Estimate", [
        { value: "open",   label: "Open Estimate"   },
        { value: "create", label: "Create Estimate" },
      ]);
    if (key === "display_name")      return renderTextFilterMenu(key, "Filter Customer", "Search customer name");
    if (key === "email")             return renderTextFilterMenu(key, "Filter Email", "Search email");
    if (key === "last_contact_date") return renderDateRangeMenu(key, "last_contact", "Filter Last Contact");
    if (key === "meta_create_time")  return renderDateRangeMenu(key, "created",      "Filter Created");
    return "";
  }
  function th(key, label, opts = {}) {
    const sortable   = opts.sortable !== false;
    const filterable = opts.filterable === true;
    const align      = opts.align || "left";
    return `
      <th class="py-2 px-2 align-middle overflow-visible text-${align}" style="min-width:fit-content;">
        <div class="relative inline-flex items-center gap-1.5">
          ${sortable
            ? `<button type="button"
                  class="text-${align} font-bold text-[11px] uppercase tracking-wide rounded hover:bg-black/5 leading-none px-1 py-1 whitespace-nowrap"
                  data-sort="${key}">${escapeHtml(label)}${sortArrow(key)}</button>`
            : `<span class="font-bold text-[11px] uppercase tracking-wide leading-none px-1 py-1 whitespace-nowrap text-black/50">${escapeHtml(label)}</span>`}
          ${filterable
            ? `<button type="button"
                  class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded ${isFilterActive(key) ? "border border-black/15 bg-black/5" : "border border-transparent"} hover:border-black/10 hover:bg-black/5"
                  data-open-filter="${key}"
                  aria-label="Filter ${escapeHtml(label)}">${filterIcon(isFilterActive(key))}</button>`
            : ""}
          ${renderFilterMenu(key)}
        </div>
      </th>`;
  }

  // Color mapping for the pipeline status pill. Keys are the lookup_values
  // entries; falsy / unknown -> the "< Select >" placeholder color.
  const STATUS_COLORS = {
    "":                                                            "bg-sky-100 text-sky-800",
    "0% Lost":                                                     "bg-red-100 text-red-700",
    "0% Inactive":                                                 "bg-orange-100 text-orange-700",
    "20% Verbal - Budgetary, Project Uncertain":                   "bg-yellow-100 text-yellow-800",
    "40% Competitive, Multiple Bidders":                           "bg-sky-100 text-sky-800",
    "60% Project Confirmed, Customer Well-Positioned":             "bg-blue-700 text-white",
    "80% Verbal Approval, Very likely to Receive Order":           "bg-purple-100 text-purple-800",
    "80% Red Flag > Goes to Ops Tab":                              "bg-red-700 text-white",
    "100% Won > Goes to Ops Tab":                                  "bg-green-700 text-white",
  };
  const statusColorClasses = (key) =>
    STATUS_COLORS[key || ""] || "bg-sky-100 text-sky-800";

  function statusPillHtml(c) {
    const status  = c.pipeline_status || "";
    const display = status || "< Select >";
    const colors  = statusColorClasses(status);
    return `
      <button type="button"
              class="${colors} inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold leading-snug whitespace-normal text-left hover:opacity-85 max-w-full"
              data-status-pill
              data-customer-id="${c.qbo_customer_id}"
              title="${escapeHtml(display)}">
        ${escapeHtml(display)}
      </button>`;
  }

  function statusDropdownHtml(c) {
    if (String(tableState.openStatusFor || "") !== String(c.qbo_customer_id)) return "";
    const options = [
      { key: "", label: "< Select >" },
      ...STATUS_OPTS.map(o => ({ key: o.key, label: o.key })),
    ];
    return `
      <div class="absolute left-0 top-full mt-1 z-50 w-72 rounded-xl border border-black/10 bg-white p-2 shadow-xl"
           data-status-menu data-customer-id="${c.qbo_customer_id}">
        ${options.map(o => {
          const colors = statusColorClasses(o.key);
          return `
            <button type="button"
                    class="${colors} block w-full text-left rounded-full px-3 py-1.5 text-xs font-semibold whitespace-normal mb-1 hover:opacity-85"
                    data-status-option="${escapeHtml(o.key)}"
                    data-customer-id="${c.qbo_customer_id}">
              ${escapeHtml(o.label)}
            </button>`;
        }).join("")}
      </div>`;
  }

  function commTypeSelectHtml(prefix, customerId, current = "") {
    return `
      <select class="input text-xs py-1.5 w-full"
              data-${prefix}
              data-customer-id="${customerId}">
        <option value="" ${!current ? "selected" : ""}>—</option>
        ${COMM_OPTS.map(o => {
          const t = o.value_text ? ` title="${escapeHtml(o.value_text)}"` : "";
          return `<option value="${escapeHtml(o.key)}" ${current === o.key ? "selected" : ""}${t}>${escapeHtml(o.key)}</option>`;
        }).join("")}
      </select>`;
  }

  function actionBtnHtml(c) {
    const hasEstimate = c.estimate_id != null;
    return hasEstimate
      ? `<button type="button" data-open-estimate="${c.estimate_id}"
            class="inline-flex items-center rounded-xl border border-black/10 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-black/5 whitespace-nowrap">Open Estimate</button>`
      : `<button type="button" data-create-estimate="${c.qbo_customer_id}"
            class="btn-primary text-xs !px-3 !py-1.5 whitespace-nowrap">Create Estimate</button>`;
  }

  function customerRowHtml(c) {
    return `
      <tr class="border-b border-black/5" data-customer-row="${c.qbo_customer_id}">
        <td class="py-2 pr-2 align-middle">
          <button type="button" class="text-black/40 hover:text-black/80 px-1"
                  data-expand-toggle="${c.qbo_customer_id}" aria-label="Toggle history">
            <svg class="w-4 h-4 transition-transform" data-expand-chevron="${c.qbo_customer_id}"
                 fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
              <path d="M9 6l6 6-6 6"/>
            </svg>
          </button>
        </td>
        <td class="py-2 px-2 text-sm font-semibold text-ink-900 whitespace-nowrap">${escapeHtml(c.display_name || "")}</td>
        <td class="py-2 px-2 whitespace-nowrap">${actionBtnHtml(c)}</td>
        <td class="py-2 px-2 relative align-middle" style="width:200px; min-width:200px; max-width:200px;">
          ${statusPillHtml(c)}
          ${statusDropdownHtml(c)}
        </td>
        <td class="py-2 px-2 w-28 text-black/60 tabular-nums text-xs"
            data-last-contact="${c.qbo_customer_id}">${fmtDateOnly(c.last_contact_date)}</td>
        <td class="py-2 px-2 w-20 text-right text-black/60 tabular-nums text-xs"
            data-follow-up="${c.qbo_customer_id}">${c.follow_up_qty ?? 0}</td>
        <td class="py-2 px-2 w-20 text-black/60 text-xs"
            data-last-comm="${c.qbo_customer_id}">${escapeHtml(c.last_communication_type || "—")}</td>
        <td class="py-2 px-2 w-20 text-right text-black/60 tabular-nums text-xs">${c.estimate_id != null ? (c.estimate_revision_count ?? 0) : "—"}</td>
        <td class="py-2 px-2 text-xs text-black/60">${escapeHtml(c.email || "—")}</td>
        <td class="py-2 px-2 text-black/60 tabular-nums text-xs whitespace-nowrap">${fmtLocal(c.meta_create_time)}</td>
      </tr>
      <tr class="hidden border-b border-black/5 bg-black/[0.02]"
          data-customer-expand="${c.qbo_customer_id}">
        <td></td>
        <td colspan="9" class="py-3 pr-3" data-expand-body="${c.qbo_customer_id}">
          <div class="text-xs text-black/40 italic">Loading contact history…</div>
        </td>
      </tr>`;
  }

  function headerRowHtml() {
    return `
      <tr class="border-b border-black/10">
        <th class="py-2 pr-2 w-6"></th>
        ${th("display_name",             "Customer",       { sortable: true, filterable: true })}
        ${th("estimate_action",          "Estimate",       { sortable: true, filterable: true })}
        ${th("pipeline_status",          "Status",         { sortable: true, filterable: true })}
        ${th("last_contact_date",        "Last Contact",   { sortable: true, filterable: true })}
        ${th("follow_up_qty",            "Follow Up Qty",  { sortable: true, align: "right" })}
        ${th("last_communication_type",  "Last Comm",      { sortable: true, filterable: true })}
        ${th("estimate_revision_count",  "Revisions",      { sortable: true, align: "right" })}
        ${th("email",                    "Email",          { sortable: true, filterable: true })}
        ${th("meta_create_time",         "Created",        { sortable: true, filterable: true })}
      </tr>`;
  }

  function emptyRowHtml(colspan = 10) {
    return `<tr><td colspan="${colspan}" class="py-6 text-center text-sm text-black/40">
        No matching customers. Adjust filters or click <strong>Sync Customers</strong> above.
      </td></tr>`;
  }

  function renderHeader() {
    const thead = document.querySelector("[data-customer-thead]");
    if (thead) thead.innerHTML = headerRowHtml();
  }

  function renderTableBody() {
    const tbody = document.querySelector("[data-customer-tbody]");
    if (!tbody) return;
    const filtered = filterRows(customers);
    const sorted = sortRows(filtered);
    tbody.innerHTML = sorted.length
      ? sorted.map(customerRowHtml).join("")
      : emptyRowHtml(10);

    // Restore expanded rows after a re-render of the body.
    for (const cid of expanded.keys()) {
      const row = document.querySelector(`[data-customer-expand="${cid}"]`);
      if (!row) continue;
      row.classList.remove("hidden");
      const chev = document.querySelector(`[data-expand-chevron="${cid}"]`);
      if (chev) chev.classList.add("rotate-90");
      renderExpandBody(cid);
    }
  }

  const bodyHtml = `
    <div class="grid grid-cols-1 gap-3 pb-3">

      <div class="card px-5 py-3">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div class="text-base font-extrabold">Estimate</div>
            <div class="text-xs text-black/50">
              Pick a customer to create or open their estimate. Click the
              chevron on any row to log + view contact attempts.
            </div>
          </div>
          <div class="flex items-center gap-3 whitespace-nowrap">
            <span class="text-[11px] text-emerald-700" data-sync-msg></span>
            <span class="text-[11px] text-black/40" data-customer-count>${customers.length} customer${customers.length === 1 ? "" : "s"}</span>
            <button type="button" data-sync-customers
                    class="inline-flex items-center rounded-xl border border-black/15 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-black/5"
                    title="Pull the latest customer list from QuickBooks">
              Sync Customers
            </button>
          </div>
        </div>
      </div>

      <!-- Table card fills the rest of the viewport; both axes scroll inside
           the [data-picker-scroll] container so the horizontal scrollbar is
           always visible at the bottom edge of the visible area, not 155
           rows down. Thead stays pinned during vertical scroll. -->
      <div class="card px-5 py-4 flex flex-col" data-picker-card>
        <div class="flex-1 overflow-auto" data-picker-scroll>
          <table class="w-full text-sm" style="min-width:1120px;">
            <thead class="text-black/50 sticky top-0 z-20 bg-white" data-customer-thead></thead>
            <tbody data-customer-tbody></tbody>
          </table>
        </div>
      </div>

    </div>`;

  // ── interactions state ────────────────────────────────────────────────────
  // Declared before the first renderTableBody() call so the body renderer
  // can safely consult `expanded` when restoring open rows after a sort or
  // filter re-render.
  const expanded = new Map();   // customerId(str) -> { contacts, draft }
  const todayIso = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  };
  const findCustomer = (cid) =>
    customers.find(c => String(c.qbo_customer_id) === String(cid));

  setShell({ title: "", subtitle: "", bodyHtml, showLogout: true, routeFn });
  renderHeader();
  renderTableBody();

  // Size the table card to fill the remaining viewport. Both axes scroll
  // inside it, so the horizontal scrollbar lives at the bottom edge of the
  // visible card — no more hunting at the bottom of 155 data rows.
  function fitTableHeight() {
    const card = document.querySelector("[data-picker-card]");
    if (!card) return;
    const top = card.getBoundingClientRect().top;
    const available = window.innerHeight - top - 24;
    card.style.height = Math.max(360, available) + "px";
  }
  fitTableHeight();
  // Fire twice on first paint to settle after any late layout shifts
  // (e.g. fonts loading, the brand header rendering, etc.).
  window.setTimeout(fitTableHeight, 0);
  window.addEventListener("resize", fitTableHeight);

  function refreshSummaryCells(cid) {
    const c = findCustomer(cid);
    const state = expanded.get(String(cid));
    if (!c || !state) return;
    const contacts = state.contacts || [];
    const latest = contacts[0] || null;     // contacts ordered DESC
    c.last_contact_date       = latest ? latest.contact_date         : null;
    c.follow_up_qty           = contacts.length;
    c.last_communication_type = latest ? latest.communication_type   : null;
    const dEl = document.querySelector(`[data-last-contact="${cid}"]`);
    const nEl = document.querySelector(`[data-follow-up="${cid}"]`);
    const tEl = document.querySelector(`[data-last-comm="${cid}"]`);
    if (dEl) dEl.textContent = fmtDateOnly(c.last_contact_date);
    if (nEl) nEl.textContent = c.follow_up_qty;
    if (tEl) tEl.textContent = c.last_communication_type || "—";
  }

  function renderExpandBody(cid) {
    const state = expanded.get(String(cid));
    const body  = document.querySelector(`[data-expand-body="${cid}"]`);
    if (!body || !state) return;

    const contactsHtml = (state.contacts && state.contacts.length)
      ? `
        <table class="w-full text-xs">
          <thead>
            <tr class="text-[10px] uppercase tracking-wide text-black/50 border-b border-black/10">
              <th class="text-left  font-semibold py-1.5 pr-2">Date</th>
              <th class="text-left  font-semibold py-1.5 px-2">Type</th>
              <th class="text-left  font-semibold py-1.5 px-2">Notes</th>
              <th class="py-1.5 pl-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            ${state.contacts.map(ct => `
              <tr class="border-b border-black/5 last:border-b-0">
                <td class="py-1.5 pr-2 tabular-nums whitespace-nowrap">${fmtDateOnly(ct.contact_date)}</td>
                <td class="py-1.5 px-2">${escapeHtml(ct.communication_type || "—")}</td>
                <td class="py-1.5 px-2 text-black/60">${escapeHtml(ct.notes || "")}</td>
                <td class="py-1.5 pl-2 text-right">
                  <button type="button"
                          class="text-xs text-black/40 hover:text-red-600 px-1"
                          data-contact-delete="${ct.id}"
                          data-customer-id="${cid}"
                          title="Delete contact">✕</button>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>`
      : `<div class="text-xs text-black/40 italic py-1">No contacts logged yet.</div>`;

    body.innerHTML = `
      <div class="grid grid-cols-1 gap-3">
        ${contactsHtml}
        <div class="flex items-end gap-2 pt-2 border-t border-black/10">
          <div class="flex flex-col gap-1">
            <label class="text-[10px] font-semibold text-black/60 uppercase">Date</label>
            <input type="date" class="input text-xs py-1.5"
                   data-new-contact-date data-customer-id="${cid}"
                   value="${escapeHtml(state.draft.contact_date || todayIso())}"/>
          </div>
          <div class="flex flex-col gap-1 w-24">
            <label class="text-[10px] font-semibold text-black/60 uppercase">Type</label>
            ${commTypeSelectHtml("new-contact-type", cid, state.draft.communication_type || "")}
          </div>
          <div class="flex flex-col gap-1 flex-1">
            <label class="text-[10px] font-semibold text-black/60 uppercase">Notes (optional)</label>
            <input type="text" class="input text-xs py-1.5"
                   data-new-contact-notes data-customer-id="${cid}"
                   value="${escapeHtml(state.draft.notes || "")}"
                   placeholder="What happened on this contact"/>
          </div>
          <button type="button"
                  class="btn-primary text-xs !px-3 !py-1.5"
                  data-log-contact="${cid}">
            + Log Contact
          </button>
        </div>
      </div>`;
  }

  async function toggleExpand(cid) {
    const expandRow = document.querySelector(`[data-customer-expand="${cid}"]`);
    const chev     = document.querySelector(`[data-expand-chevron="${cid}"]`);
    if (!expandRow) return;
    const isOpen = !expandRow.classList.contains("hidden");
    if (isOpen) {
      expandRow.classList.add("hidden");
      if (chev) chev.classList.remove("rotate-90");
      // Drop the expand state so the next sort/filter/sync re-render
      // doesn't re-open this row. Re-opening will refetch contacts —
      // a single-customer call, negligible cost.
      expanded.delete(String(cid));
      return;
    }
    expandRow.classList.remove("hidden");
    if (chev) chev.classList.add("rotate-90");

    if (!expanded.has(String(cid))) {
      expanded.set(String(cid), { contacts: null, draft: {} });
      try {
        const contacts = await api(`/estimates/customers/${cid}/contacts`);
        const state = expanded.get(String(cid)) || { contacts: null, draft: {} };
        state.contacts = contacts;
        expanded.set(String(cid), state);
        renderExpandBody(cid);
        refreshSummaryCells(cid);
      } catch (err) {
        const body = document.querySelector(`[data-expand-body="${cid}"]`);
        if (body) body.innerHTML =
          `<div class="text-xs text-red-600">Failed to load contacts: ${escapeHtml(err?.message || String(err))}</div>`;
      }
    } else {
      renderExpandBody(cid);
    }
  }

  async function logContact(cid) {
    const dateEl  = document.querySelector(`[data-new-contact-date][data-customer-id="${cid}"]`);
    const typeEl  = document.querySelector(`[data-new-contact-type][data-customer-id="${cid}"]`);
    const notesEl = document.querySelector(`[data-new-contact-notes][data-customer-id="${cid}"]`);
    const contact_date       = dateEl ? dateEl.value : "";
    const communication_type = typeEl ? typeEl.value : "";
    const notes              = notesEl ? notesEl.value : "";
    if (!contact_date) { alert("Pick a date for the contact."); return; }

    try {
      const created = await api(`/estimates/customers/${cid}/contacts`, {
        method: "POST",
        body:   JSON.stringify({ contact_date, communication_type, notes }),
      });
      const state = expanded.get(String(cid)) || { contacts: [], draft: {} };
      state.contacts = [created, ...(state.contacts || [])];
      // Keep DESC by date, then id (defensive in case of backdated entries).
      state.contacts.sort((a, b) => {
        if (a.contact_date !== b.contact_date) {
          return a.contact_date < b.contact_date ? 1 : -1;
        }
        return Number(b.id) - Number(a.id);
      });
      state.draft = {};
      expanded.set(String(cid), state);
      renderExpandBody(cid);
      refreshSummaryCells(cid);
    } catch (err) {
      alert("Failed to log contact: " + (err?.message || err));
    }
  }

  async function deleteContact(contactId, cid) {
    if (!confirm("Delete this contact entry?")) return;
    try {
      await api(`/estimates/contacts/${contactId}`, { method: "DELETE" });
      const state = expanded.get(String(cid));
      if (state) {
        state.contacts = (state.contacts || []).filter(c => Number(c.id) !== Number(contactId));
        renderExpandBody(cid);
        refreshSummaryCells(cid);
      }
    } catch (err) {
      alert("Failed to delete contact: " + (err?.message || err));
    }
  }

  // Sync Customers: pull the latest customer list from QuickBooks (same
  // endpoint the QuickBooks page calls). Updates the picker in place without
  // requiring a route change.
  async function syncCustomers() {
    const btn = document.querySelector("[data-sync-customers]");
    const msg = document.querySelector("[data-sync-msg]");
    if (!btn) return;
    btn.setAttribute("disabled", "true");
    const orig = btn.textContent;
    btn.textContent = "Syncing…";
    if (msg) { msg.textContent = ""; msg.className = "text-[11px] text-black/40"; }
    try {
      const r = await api("/qbo/sync/customers", { method: "POST" });
      // Refetch the picker list — sync doesn't return our joined shape.
      customers = await api("/estimates/customers");
      const count = document.querySelector("[data-customer-count]");
      if (count) count.textContent = `${customers.length} customer${customers.length === 1 ? "" : "s"}`;
      // Drop any expand state for customers that no longer exist.
      for (const cid of [...expanded.keys()]) {
        if (!customers.some(c => String(c.qbo_customer_id) === String(cid))) {
          expanded.delete(cid);
        }
      }
      renderTableBody();
      if (msg) {
        msg.textContent = `Synced · fetched ${r.customers_fetched ?? "?"}, upserted ${r.customers_upserted ?? "?"}`;
        msg.className = "text-[11px] text-emerald-700";
        setTimeout(() => { if (msg) msg.textContent = ""; }, 6000);
      }
    } catch (err) {
      if (msg) {
        msg.textContent = "Sync failed: " + (err?.message || err);
        msg.className = "text-[11px] text-red-700";
      } else {
        alert("Sync failed: " + (err?.message || err));
      }
    } finally {
      btn.removeAttribute("disabled");
      btn.textContent = orig;
    }
  }

  // ── event wiring ──────────────────────────────────────────────────────────
  async function onPickerClick(e) {
    if (e.target.closest("[data-sync-customers]")) {
      syncCustomers();
      return;
    }
    // Sort: toggle direction on second click of same column.
    const sortBtn = e.target.closest("[data-sort]");
    if (sortBtn) {
      const k = sortBtn.getAttribute("data-sort");
      if (tableState.sortKey === k) {
        tableState.sortDir = tableState.sortDir === "asc" ? "desc" : "asc";
      } else {
        tableState.sortKey = k;
        tableState.sortDir = (k === "meta_create_time" || k === "last_contact_date") ? "desc" : "asc";
      }
      renderHeader();
      renderTableBody();
      return;
    }
    // Filter dropdown: toggle.
    const openBtn = e.target.closest("[data-open-filter]");
    if (openBtn) {
      const k = openBtn.getAttribute("data-open-filter");
      tableState.openFilter = (tableState.openFilter === k) ? null : k;
      renderHeader();
      return;
    }
    // Close filter (Done).
    if (e.target.closest("[data-close-filter]")) {
      tableState.openFilter = null;
      renderHeader();
      renderTableBody();
      return;
    }
    // Clear filter — reset values for the targeted column.
    const clearBtn = e.target.closest("[data-clear-filter]");
    if (clearBtn) {
      const k = clearBtn.getAttribute("data-clear-filter");
      const f = tableState.filters;
      if (k === "pipeline_status")          f.pipeline_status = [];
      else if (k === "last_communication_type") f.last_communication_type = [];
      else if (k === "estimate_action")     f.estimate_action = [];
      else if (k === "display_name")        f.display_name = "";
      else if (k === "email")               f.email = "";
      else if (k === "last_contact_date")   { f.last_contact_from = ""; f.last_contact_to = ""; }
      else if (k === "meta_create_time")    { f.created_from = "";      f.created_to = ""; }
      renderHeader();
      renderTableBody();
      return;
    }
    // Multi-select toggle.
    const msCheck = e.target.closest("[data-multiselect-check]");
    if (msCheck) {
      const k = msCheck.getAttribute("data-multiselect-check");
      const v = msCheck.getAttribute("data-multiselect-value");
      const arr = tableState.filters[k];
      const i = arr.indexOf(v);
      if (i >= 0) arr.splice(i, 1); else arr.push(v);
      renderHeader();
      renderTableBody();
      return;
    }
    // Status pill: toggle dropdown for this row.
    const statusPill = e.target.closest("[data-status-pill]");
    if (statusPill) {
      const cid = statusPill.getAttribute("data-customer-id");
      tableState.openStatusFor =
        String(tableState.openStatusFor || "") === String(cid) ? null : String(cid);
      renderTableBody();
      return;
    }
    // Status option click → save + close menu.
    const statusOpt = e.target.closest("[data-status-option]");
    if (statusOpt) {
      const cid = statusOpt.getAttribute("data-customer-id");
      const newStatus = statusOpt.getAttribute("data-status-option") || null;
      try {
        await api(`/estimates/customers/${cid}/meta`, {
          method: "PATCH",
          body:   JSON.stringify({ status: newStatus }),
        });
        const c = findCustomer(cid);
        if (c) c.pipeline_status = newStatus;
      } catch (err) {
        alert("Failed to save status: " + (err?.message || err));
      }
      tableState.openStatusFor = null;
      renderTableBody();
      return;
    }
    // Outside-click closes any open filter menu.
    if (tableState.openFilter && !e.target.closest("[data-filter-menu]") && !e.target.closest("[data-open-filter]")) {
      tableState.openFilter = null;
      renderHeader();
    }
    // Outside-click closes any open status menu.
    if (tableState.openStatusFor && !e.target.closest("[data-status-menu]") && !e.target.closest("[data-status-pill]")) {
      tableState.openStatusFor = null;
      renderTableBody();
    }

    const create = e.target.closest("[data-create-estimate]");
    if (create) {
      const cid = Number(create.getAttribute("data-create-estimate"));
      create.setAttribute("disabled", "true");
      create.textContent = "Creating…";
      try {
        const est = await api("/estimates", {
          method: "POST",
          body:   JSON.stringify({ qbo_customer_id: cid }),
        });
        location.hash = `#/estimate/${est.id}`;
      } catch (err) {
        alert("Failed to create estimate: " + (err?.message || err));
        create.removeAttribute("disabled");
        create.textContent = "Create Estimate";
      }
      return;
    }
    const open = e.target.closest("[data-open-estimate]");
    if (open) {
      location.hash = `#/estimate/${Number(open.getAttribute("data-open-estimate"))}`;
      return;
    }
    const expandBtn = e.target.closest("[data-expand-toggle]");
    if (expandBtn) {
      toggleExpand(expandBtn.getAttribute("data-expand-toggle"));
      return;
    }
    const logBtn = e.target.closest("[data-log-contact]");
    if (logBtn) {
      logContact(logBtn.getAttribute("data-log-contact"));
      return;
    }
    const delBtn = e.target.closest("[data-contact-delete]");
    if (delBtn) {
      deleteContact(delBtn.getAttribute("data-contact-delete"),
                    delBtn.getAttribute("data-customer-id"));
      return;
    }
  }

  async function onPickerChange(e) {
    // Filter inputs (text + date range).
    const filterInput = e.target.closest("[data-filter-input]");
    if (filterInput) {
      const k = filterInput.getAttribute("data-filter-input");
      tableState.filters[k] = filterInput.value || "";
      renderTableBody();
      return;
    }

    // Preserve unsaved "Log Contact" form input across re-renders.
    const draftDate  = e.target.closest("[data-new-contact-date]");
    const draftType  = e.target.closest("[data-new-contact-type]");
    const draftNotes = e.target.closest("[data-new-contact-notes]");
    const dEl = draftDate || draftType || draftNotes;
    if (dEl) {
      const cid = dEl.getAttribute("data-customer-id");
      const state = expanded.get(String(cid));
      if (state) {
        if (draftDate)  state.draft.contact_date       = draftDate.value;
        if (draftType)  state.draft.communication_type = draftType.value;
        if (draftNotes) state.draft.notes              = draftNotes.value;
      }
    }
  }

  document.addEventListener("click",  onPickerClick);
  document.addEventListener("change", onPickerChange);
  document.addEventListener("input",  onPickerChange);
  window.addEventListener("hashchange", () => {
    document.removeEventListener("click",  onPickerClick);
    document.removeEventListener("change", onPickerChange);
    document.removeEventListener("input",  onPickerChange);
    window.removeEventListener("resize", fitTableHeight);
  }, { once: true });
}

// ── General Info tab body — the 4 cards (Quoting Metrics now lives on the Base tab).
// Called by renderEstimateWorkspace; receives the pre-loaded estimate row
// + the container to fill, so the persistent shell (header bar + tabs)
// stays untouched as the user switches tabs.
async function renderGeneralInfoTab(container, estimateRow, estimateId, routeFn) {

  // Local state. Only fields that are EITHER user-input on this tab OR
  // calculated from inputs on this tab. Cross-tab results (per-set rollups,
  // pricing, profit, duration) live on the Review tab where they have the
  // metric set data needed to compute them.
  const state = {
    // General Information — start blank; the user fills these in
    quote_number:          "",
    quote_description:     "",
    contact_first:         "",
    contact_last:          "",
    customer:              "",
    end_user:              "",
    quoted_by:             "",
    quote_notes:           "",
    date_of_request:       "",
    start_date:            "",   // calc — Date of Request + 90 days (blank if no request date)
    quote_submittal_date:  "",   // calc — today's date, mm/dd/yyyy
    project_city:          "",
    project_state:         "",
    end_date:              "",   // calc — lands in a later phase
    // revision_count + latest_revision_date are server-managed by the
    // Save Revision button on the Review tab — not editable here.

    // Key Estimating Inputs — what the user fills in to drive the rollup
    one_way_travel_hrs:    "",
    equipment_requirement: "",
    rack_height:           "",
    estimate_type:                 "",
    breaking_out_mobilization:     "",
    rent_wire_guidance_equipment:  "",
    crew_count:                    "",
    crew_size:                     "",
    project_time_budget_adder:  "",
    project_time_budget_pct:    "",
    lodging_cost_per_day:          "",
    mgmt_travel_multiplier:        3.56559,    // pct points (3.56559%); user-editable
    rack_install_profit_target: "",
    rental_rack_profit_target:  "",
    wire_guidance_profit_target:   "",
    rental_wire_profit_target:     "",
    mobilization_profit_target:    "",    // pct points; feeds Mobilization OH&P bundle (S35)

    // Self-contained derived values (rendered as inline chips, not stored)
    labor_cost_per_day:            "",   // (OOT or Local rate)/5 × crew_size value_num
    labor_cost_per_travel_day:     "",   // mirrors labor_cost_per_day
    travel_days_per_crew_per_mob:  "",   // step-lookup on One-Way Travel hrs × 2
    downtime_day_price_target:     "",   // $3,500 if travel >1hr, else $3,000
  };

  // Hydrate state from the persisted estimate row (server -> client). Null
  // columns translate to "" so the existing input rendering works unchanged.
  for (const key of Object.keys(state)) {
    if (estimateRow && Object.prototype.hasOwnProperty.call(estimateRow, key)) {
      const v = estimateRow[key];
      state[key] = (v === null || v === undefined) ? "" : v;
    }
  }
  // Customer is sourced from the QBO record, not the estimate row.
  state.customer = estimateRow.customer_display_name || "";

  // Fields the estimates table actually has columns for — only these get
  // PATCHed. Anything else (computed cells, customer name from QBO) stays
  // local. Mirror of EstimatePatch in backend/app/estimates/routes.py.
  const PATCHABLE_KEYS = new Set([
    "quote_number", "quote_description",
    "contact_first", "contact_last",
    "end_user", "quoted_by", "quote_notes",
    "date_of_request", "start_date",
    "project_city", "project_state",
    "end_date", "latest_revision_date",
    "one_way_travel_hrs",
    "equipment_requirement", "rack_height",
    "project_time_budget_adder", "project_time_budget_pct",
    "rack_install_profit_target", "rental_rack_profit_target",
    "mobilization_profit_target",
    "estimate_type", "breaking_out_mobilization",
    "rent_wire_guidance_equipment",
    "crew_count", "crew_size",
    "wire_guidance_profit_target", "rental_wire_profit_target",
    "lodging_cost_per_day", "mgmt_travel_multiplier",
    // revision_count + latest_revision_date are NOT patchable — they are
    // server-managed by the Save Revision button on the Review tab.
  ]);

  // Debounced PATCH — one timer per field so fast typing on different
  // fields doesn't blow away each other's pending saves.
  const _patchTimers = new Map();
  function patchEstimateField(key, value) {
    if (!PATCHABLE_KEYS.has(key)) return;
    if (_patchTimers.has(key)) clearTimeout(_patchTimers.get(key));
    _patchTimers.set(key, setTimeout(async () => {
      _patchTimers.delete(key);
      try {
        await api(`/estimates/${estimateId}`, {
          method: "PATCH",
          body:   JSON.stringify({ [key]: value === "" ? null : value }),
        });
      } catch (err) {
        console.error("Failed to save estimate field", key, err);
      }
    }, 250));
  }

  // Reference-table dropdowns — fetched from /api/quoting/lookup-values
  // (table: lookup_values, grouped by category). Static arrays below act as
  // fallbacks so the page still renders if the API call fails.
  let lookups = {};
  try {
    lookups = await api("/quoting/lookup-values");
  } catch (err) {
    console.warn("Failed to load quoting lookup values; using static defaults.", err);
  }
  const lookupKeys = (category, fallback) => {
    const rows = lookups[category];
    return Array.isArray(rows) && rows.length ? rows.map(r => r.key) : fallback;
  };

  const ESTIMATE_TYPES   = lookupKeys("estimate_type", ["Standard", "Aggressive"]);
  const EQUIPMENT_REQS   = lookupKeys("energy_type",   ["Electric", "LP (Liquid Propane)"]);
  const RACK_HEIGHTS     = lookupKeys("rack_height",   ["Shorter than 25' (300\")", "Taller than 25' (300\")"]);
  const YES_NO           = lookupKeys("yes_no",        ["Yes", "No"]);
  const CREW_SIZES       = lookupKeys("crew_size",     ["Full", "4 Men", "2 Men", "1 Man"]);
  const CREW_COUNTS      = [1, 2, 3, 4, 5, 6];
  const US_STATES        = [
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME",
    "MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA",
    "RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
  ];

  // ── formatting helpers ─────────────────────────────────────────────────────
  const fmtMoney = (n) => {
    const v = Number(n);
    if (Number.isNaN(v)) return "—";
    return "$" + Math.round(v).toLocaleString("en-US");
  };

  // ── date helpers ───────────────────────────────────────────────────────────
  const pad2 = (n) => String(n).padStart(2, "0");

  // A Date, or an ISO "yyyy-mm-dd" string, → "mm/dd/yyyy"; falsy/invalid → "".
  function toUSDate(d) {
    const dt = d instanceof Date ? d : (d ? new Date(`${d}T00:00:00`) : null);
    if (!dt || Number.isNaN(dt.getTime())) return "";
    return `${pad2(dt.getMonth() + 1)}/${pad2(dt.getDate())}/${dt.getFullYear()}`;
  }

  // Start Date = Date of Request — Original + 90 days. Returns ISO yyyy-mm-dd
  // so <input type="date"> can render it directly. Blank until a request date
  // is entered (matches the Excel "blank unless ..." behaviour).
  function computeStartDate(requestIso) {
    if (!requestIso) return "";
    const dt = new Date(`${requestIso}T00:00:00`);
    if (Number.isNaN(dt.getTime())) return "";
    dt.setDate(dt.getDate() + 90);
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }

  // Tracks whether the user has manually overridden Start Date. Once true,
  // changes to Date of Request stop auto-filling Start Date. Clearing the
  // Start Date field resets the flag so auto-fill resumes.
  let startDateManual = false;

  // Downtime Day Price — blank until One-Way Travel time is entered, then
  // $3,500 when travel exceeds 1 hour, $3,000 at or under 1 hour.
  function computeDowntimePrice(travelHrs) {
    if (travelHrs === "" || travelHrs == null) return "";
    const h = Number(travelHrs);
    if (Number.isNaN(h)) return "";
    return h > 1 ? 3500 : 3000;
  }
  // The Downtime Day Price readout markup (money, or an em dash when blank).
  function downtimePriceHtml() {
    const v = state.downtime_day_price_target;
    return (v === "" || v == null)
      ? '<span class="text-black/30">—</span>'
      : fmtMoney(v);
  }

  // Pick a value_num out of `lookups` for a given category + key. Returns
  // null when the category, row, or value_num is missing (e.g. API fetch
  // failed and the page is running on static fallbacks).
  function lookupValueNum(category, key) {
    const rows = lookups[category];
    if (!Array.isArray(rows)) return null;
    const row = rows.find(r => r.key === key);
    if (!row || row.value_num == null) return null;
    return row.value_num;
  }

  // Labor Cost Per Day:
  //   base_rate = (One-Way Travel > 1 ? labor_crew_cost.Out of Town
  //                                   : labor_crew_cost.Local) / 5
  //   Labor Cost / Day = base_rate × crew_size.<selected key>.value_num
  // Returns "" until both One-Way Travel time and Crew Size are populated
  // and the required lookup rows are available.
  function computeLaborCostPerDay() {
    const hrs = state.one_way_travel_hrs;
    if (hrs === "" || hrs == null) return "";
    const h = Number(hrs);
    if (Number.isNaN(h)) return "";

    const crewKey = state.crew_size;
    if (!crewKey) return "";

    const baseRate = lookupValueNum("labor_crew_cost", h > 1 ? "Out of Town" : "Local");
    const crewNum  = lookupValueNum("crew_size", crewKey);
    if (baseRate == null || crewNum == null) return "";

    return (baseRate / 5) * crewNum;
  }
  function laborCostPerDayHtml() {
    const v = state.labor_cost_per_day;
    return (v === "" || v == null)
      ? '<span class="text-black/30">—</span>'
      : fmtMoney(v);
  }

  // Travel Days Per Crew, Per Mobilization — Excel:
  //   =IF(travel_hrs <= 38, VLOOKUP(travel_hrs, step_table, 2, TRUE) * 2,
  //       "WHAT COUNTRY IS THIS JOB IN?")
  // The step table is lookup_values.category = 'project_travel_day_calculator',
  // with lookup_key = numeric threshold (stored as text). VLOOKUP TRUE = pick
  // the largest threshold <= travel_hrs. Result is multiplied by 2.
  function computeTravelDaysPerCrewPerMob() {
    const hrs = state.one_way_travel_hrs;
    if (hrs === "" || hrs == null) return "";
    const h = Number(hrs);
    if (Number.isNaN(h)) return "";
    if (h > 38) return "WHAT COUNTRY IS THIS JOB IN?";

    const rows = lookups.project_travel_day_calculator;
    if (!Array.isArray(rows) || rows.length === 0) return "";

    const eligible = rows
      .map(r => ({ threshold: Number(r.key), value: r.value_num }))
      .filter(r => !Number.isNaN(r.threshold) && r.value != null && r.threshold <= h)
      .sort((a, b) => b.threshold - a.threshold);
    if (eligible.length === 0) return "";

    return eligible[0].value * 2;
  }
  function travelDaysPerCrewPerMobHtml() {
    const v = state.travel_days_per_crew_per_mob;
    if (v === "" || v == null) return '<span class="text-black/30">—</span>';
    if (typeof v === "string") {
      // Out-of-range error label from the Excel formula.
      return `<span class="text-red-600 text-xs">${escapeHtml(v)}</span>`;
    }
    return String(v);
  }

  // ── General Information helpers ────────────────────────────────────────────
  // Each helper emits TWO grid cells — a label cell + a value cell — so the
  // section's per-column grid lays them out as name | value pairs. The value
  // cell can optionally include a row of inline "chips" beneath the input to
  // surface self-contained derived values (e.g. Labor Cost/Day under Crew
  // Size). Chips use data-est-calc so the existing setCalcCell() helper
  // updates them on input change.
  function giLabel(text) {
    return `<div class="text-[11px] font-semibold text-black/60 leading-tight pt-1.5">${escapeHtml(text)}</div>`;
  }

  // A single chip — { label, calcKey, initialHtml }. Rendered as a small
  // colored pill that shows a label + a live value.
  function chip(label, calcKey, initialHtml) {
    return `
      <span class="inline-flex items-baseline gap-1.5 text-[11px] px-2 py-0.5 rounded-md bg-blue-50 text-blue-800 border border-blue-100">
        <span class="font-bold uppercase tracking-wider text-[10px] text-blue-700/80">${escapeHtml(label)}</span>
        <span class="tabular-nums font-semibold" data-est-calc="${calcKey}">${initialHtml}</span>
      </span>`;
  }
  // Wraps a list of chips in a flex row that sits below an input.
  function chipsRow(chips) {
    if (!chips || !chips.length) return "";
    return `<div class="flex flex-wrap gap-1.5 mt-1.5">${chips.join("")}</div>`;
  }
  // Wraps a value cell so chips appear below the input.
  function withChips(inputHtml, chips) {
    const cr = chipsRow(chips);
    return cr ? `<div class="flex flex-col">${inputHtml}${cr}</div>` : inputHtml;
  }
  // Sub-heading inside a card body — spans both columns of the label|value grid.
  function subHead(text) {
    return `<div class="col-span-2 text-[10px] font-bold uppercase tracking-widest text-black/45 pt-3 first:pt-0 pb-1 border-b border-black/10">${escapeHtml(text)}</div>`;
  }

  function giText(label, key, opts = {}) {
    const input = `
      <input type="text" class="input text-sm py-1.5"
             data-est-input="${key}"
             value="${escapeHtml(state[key] ?? "")}"
             placeholder="${escapeHtml(opts.placeholder || "")}"/>`;
    return giLabel(label) + withChips(input, opts.chips);
  }

  function giNumber(label, key, opts = {}) {
    const step = opts.step || "any";
    const suffix = opts.suffix
      ? `<span class="text-xs text-black/40 whitespace-nowrap">${escapeHtml(opts.suffix)}</span>`
      : "";
    const input = `
      <div class="flex items-center gap-2">
        <input type="number" step="${step}" class="input text-sm py-1.5 flex-1 min-w-0"
               data-est-input="${key}" data-est-type="number"
               placeholder="${escapeHtml(opts.placeholder || "")}"
               value="${escapeHtml(String(state[key] ?? ""))}"/>
        ${suffix}
      </div>`;
    return giLabel(label) + withChips(input, opts.chips);
  }

  function giSelect(label, key, options, opts = {}) {
    const renderOption = (o) => {
      const val = typeof o === "object" ? o.value : o;
      const lab = typeof o === "object" ? o.label : o;
      const sel = String(state[key]) === String(val) ? "selected" : "";
      return `<option value="${escapeHtml(String(val))}" ${sel}>${escapeHtml(String(lab))}</option>`;
    };
    const placeholderOpt = opts.placeholder
      ? `<option value="" ${!state[key] ? "selected" : ""}>${escapeHtml(opts.placeholder)}</option>`
      : "";
    const input = `
      <select class="input text-sm py-1.5"
              data-est-input="${key}"${opts.numeric ? ' data-est-type="number"' : ""}>
        ${placeholderOpt}
        ${options.map(renderOption).join("")}
      </select>`;
    return giLabel(label) + withChips(input, opts.chips);
  }

  // Compound: Yes/No + tied percent input. Percent is in points (5 = 5%).
  function giYesNoPct(label, keyYesNo, keyPct) {
    const input = `
      <div class="flex items-center gap-2">
        <select class="input text-sm py-1.5 flex-1" data-est-input="${keyYesNo}">
          <option value="" ${!state[keyYesNo] ? "selected" : ""}>Select</option>
          ${YES_NO.map(o => `<option value="${o}" ${state[keyYesNo] === o ? "selected" : ""}>${o}</option>`).join("")}
        </select>
        <input type="number" step="0.1" class="input text-sm py-1.5 w-20"
               data-est-input="${keyPct}" data-est-type="number"
               placeholder="%"
               value="${escapeHtml(String(state[keyPct] ?? ""))}"/>
        <span class="text-xs text-black/40">%</span>
      </div>`;
    return giLabel(label) + input;
  }

  // Compound: Crew Count + Crew Size on the same line. Drives Labor Cost/Day.
  function giCrew(label, chips) {
    const input = `
      <div class="flex items-center gap-2">
        <select class="input text-sm py-1.5 flex-1" data-est-input="crew_count" data-est-type="number">
          <option value="" ${!state.crew_count ? "selected" : ""}>Count</option>
          ${CREW_COUNTS.map(n => `<option value="${n}" ${state.crew_count === n ? "selected" : ""}>${n}</option>`).join("")}
        </select>
        <select class="input text-sm py-1.5 flex-1" data-est-input="crew_size">
          <option value="" ${!state.crew_size ? "selected" : ""}>Size</option>
          ${CREW_SIZES.map(o => `<option value="${o}" ${state.crew_size === o ? "selected" : ""}>${o}</option>`).join("")}
        </select>
      </div>`;
    return giLabel(label) + withChips(input, chips);
  }

  // Native <input type="date"> ignores `placeholder`, so an empty field is
  // rendered as a text input (which shows the placeholder) and swapped to a
  // real date picker on focus — see the focusin/focusout handlers below.
  function giDate(label, key, opts = {}) {
    const placeholder = opts.placeholder || "Select Date";
    const hasVal = !!state[key];
    return giLabel(label) + `
      <input type="${hasVal ? "date" : "text"}" class="input text-sm py-1.5"
             data-est-input="${key}" data-est-date
             placeholder="${escapeHtml(placeholder)}"
             value="${escapeHtml(state[key] ?? "")}"/>`;
  }

  // Compound value cell: contact first + last on the same line.
  function giContact(label) {
    return giLabel(label) + `
      <div class="flex items-center gap-2">
        <input type="text" class="input text-sm py-1.5 flex-1 min-w-0"
               data-est-input="contact_first"
               value="${escapeHtml(state.contact_first)}" placeholder="First Name"/>
        <input type="text" class="input text-sm py-1.5 flex-1 min-w-0"
               data-est-input="contact_last"
               value="${escapeHtml(state.contact_last)}" placeholder="Last Name"/>
      </div>`;
  }

  // Compound value cell: city + state select on the same line. The select
  // leads with a blank "State" option so nothing is pre-selected.
  function giCityState(label) {
    const stateOptions =
      `<option value="" ${!state.project_state ? "selected" : ""}>State</option>` +
      US_STATES.map(s => `<option value="${s}" ${state.project_state === s ? "selected" : ""}>${s}</option>`).join("");
    return giLabel(label) + `
      <div class="flex items-center gap-2">
        <input type="text" class="input text-sm py-1.5 flex-1 min-w-0"
               data-est-input="project_city"
               value="${escapeHtml(state.project_city)}" placeholder="Enter City Name"/>
        <select class="input text-sm py-1.5 w-20" data-est-input="project_state">
          ${stateOptions}
        </select>
      </div>`;
  }

  // Read-only calculated value cell (Start Date, Quote Submittal Date, End
  // Date). Tagged with data-est-calc so it can be refreshed live.
  function giCalc(label, key) {
    const v = state[key];
    return giLabel(label) + `
      <div data-est-calc="${key}"
           class="text-sm tabular-nums bg-black/[0.03] border border-black/10 rounded-xl px-3 py-1.5 text-black/70">
        ${v ? escapeHtml(v) : '<span class="text-black/30">—</span>'}
      </div>`;
  }

  // ── section card ───────────────────────────────────────────────────────────
  // A collapsible card: clicking the header toggles its body open/closed.
  // `opts.resetKey` adds a small "Reset" button next to the chevron that fires
  // a data-reset-card="<key>" click — wired below to clear that card's fields.
  function section(title, contentHtml, opts = {}) {
    const note = opts.note
      ? `<span class="text-[11px] italic text-black/40">${escapeHtml(opts.note)}</span>`
      : "";
    const resetBtn = opts.resetKey
      ? `<button type="button" data-reset-card="${escapeHtml(opts.resetKey)}"
                 class="text-[11px] font-semibold text-red-600 hover:text-red-800 px-2 py-0.5 rounded hover:bg-red-50 whitespace-nowrap"
                 title="Clear every input in this card">
           Reset
         </button>`
      : "";
    return `
      <div class="card px-5 py-4" data-section>
        <div class="w-full flex items-center justify-between gap-3 pb-2 border-b border-black/10">
          <button type="button" data-section-toggle
                  class="flex-1 flex items-center justify-between gap-3 text-left cursor-pointer select-none">
            <span class="flex items-baseline gap-3">
              <span class="text-sm font-extrabold uppercase tracking-wide text-black/70">${escapeHtml(title)}</span>
              ${note}
            </span>
            <svg class="w-4 h-4 text-black/40 shrink-0 transition-transform" data-section-chevron
                 fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
              <path d="M6 9l6 6 6-6"/>
            </svg>
          </button>
          ${resetBtn}
        </div>
        <div class="pt-3" data-section-body>
          ${contentHtml}
        </div>
      </div>`;
  }

  // ── derived values ─────────────────────────────────────────────────────────
  // Computed here on first render and kept live as their inputs change
  // (see syncFromEl below).
  state.quote_submittal_date      = toUSDate(new Date());       // today, mm/dd/yyyy
  state.start_date                = computeStartDate(state.date_of_request);
  state.downtime_day_price_target = computeDowntimePrice(state.one_way_travel_hrs);
  state.labor_cost_per_day        = computeLaborCostPerDay();
  state.labor_cost_per_travel_day = state.labor_cost_per_day;
  state.travel_days_per_crew_per_mob = computeTravelDaysPerCrewPerMob();

  // ── Estimate state bridge to other pages ──────────────────────────────────
  // TEMP: until we add an `estimates` table + real persistence, publish the
  // inputs the Quoting Metrics page needs (Travel Costs computation) via
  // localStorage. Re-emitted on every input change. Move to /api/estimates
  // when that table lands.
  const ESTIMATE_BRIDGE_KEY = "opi_estimate_state_v1";
  function publishEstimateState() {
    try {
      const subset = {
        one_way_travel_hrs:           state.one_way_travel_hrs,
        crew_count:                   state.crew_count,
        crew_size:                    state.crew_size,
        lodging_cost_per_day:         state.lodging_cost_per_day,
        mgmt_travel_multiplier:       state.mgmt_travel_multiplier,
        estimate_type:                state.estimate_type,
        breaking_out_mobilization:    state.breaking_out_mobilization,
        rack_install_profit_target:   state.rack_install_profit_target,
        rental_rack_profit_target:    state.rental_rack_profit_target,
        mobilization_profit_target:   state.mobilization_profit_target,
        wire_guidance_profit_target:  state.wire_guidance_profit_target,
        rental_wire_profit_target:    state.rental_wire_profit_target,
      };
      localStorage.setItem(ESTIMATE_BRIDGE_KEY, JSON.stringify(subset));
    } catch (err) {
      console.warn("Estimate state bridge: localStorage write failed", err);
    }
  }
  publishEstimateState();   // initial publish on mount

  // ── page HTML ──────────────────────────────────────────────────────────────
  // Pure data-entry tab: 2 cards side-by-side on wide screens. Self-contained
  // calcs (Labor Cost/Day, Travel Days/Mob, Downtime Target) appear as small
  // inline chips under the input that drives them. Cross-tab results
  // (per-set rollups, pricing, profit, duration) live on the Review tab.

  const generalCols = "grid grid-cols-[44%_1fr] gap-x-3 gap-y-1.5 items-start content-start";
  const inputsCols  = "grid grid-cols-[44%_1fr] gap-x-3 gap-y-1.5 items-start content-start";

  const generalInfoHtml = `
    <div class="${generalCols}">
      ${subHead("Project")}
      ${giText("Quote #", "quote_number", { placeholder: "Enter quote number" })}
      ${giText("Quote Description (Short)", "quote_description", { placeholder: "Enter short description" })}
      ${giCalc("Customer", "customer")}
      ${giText("End User", "end_user", { placeholder: "Enter end user" })}

      ${subHead("Contact")}
      ${giContact("Contact (First, Last)")}
      ${giText("Quoted By (Initials)", "quoted_by", { placeholder: "First and Last Initials" })}

      ${subHead("Dates")}
      ${giDate("Date of Request — Original", "date_of_request", { placeholder: "Select Date" })}
      ${giDate("Start Date", "start_date", { placeholder: "Select Date" })}
      ${giCalc("Quote Submittal Date", "quote_submittal_date")}

      ${subHead("Location & Notes")}
      ${giCityState("Project Location")}
      ${giText("Quote Notes", "quote_notes", { placeholder: "<Enter text>" })}
    </div>`;

  const keyInputsHtml = `
    <div class="${inputsCols}">
      ${subHead("Travel & Crew")}
      ${giNumber("One-Way Travel (Houston/Dallas → Site)", "one_way_travel_hrs", {
        step: "0.5", suffix: "hrs", placeholder: "Enter hours",
        chips: [
          chip("Travel Days/Mob", "travel_days_per_crew_per_mob", travelDaysPerCrewPerMobHtml()),
          chip("Downtime Target", "downtime_day_price_target",   downtimePriceHtml()),
        ],
      })}
      ${giSelect("Equipment Requirement", "equipment_requirement", EQUIPMENT_REQS, { placeholder: "Select Equipment" })}
      ${giSelect("Rack Height", "rack_height", RACK_HEIGHTS, { placeholder: "Select Rack Height" })}
      ${giCrew("Crew Count & Size", [
        chip("Labor Cost/Day", "labor_cost_per_day", laborCostPerDayHtml()),
      ])}

      ${subHead("Project Setup")}
      ${giSelect("Estimate Type", "estimate_type", ESTIMATE_TYPES, { placeholder: "Select Type" })}
      ${giSelect("Breaking Out Mobilization?", "breaking_out_mobilization", YES_NO, { placeholder: "Select" })}
      ${giSelect("Rent Wire Guidance Equipment?", "rent_wire_guidance_equipment", YES_NO, { placeholder: "Select" })}
      ${giYesNoPct("Project Time Budget Adder?", "project_time_budget_adder", "project_time_budget_pct")}

      ${subHead("Operating Costs")}
      ${giNumber("Lodging Cost / Day", "lodging_cost_per_day", { step: "1", suffix: "$/day", placeholder: "Enter $" })}
      ${giNumber("Mgmt Travel Multiplier", "mgmt_travel_multiplier", { step: "0.00001", suffix: "%", placeholder: "Enter %" })}

      ${subHead("Profit Targets")}
      ${giNumber("Rack Install %", "rack_install_profit_target", { step: "0.1", suffix: "%", placeholder: "%" })}
      ${giNumber("Rental Equipment — Rack %", "rental_rack_profit_target", { step: "0.1", suffix: "%", placeholder: "%" })}
      ${giNumber("Wire Guidance %", "wire_guidance_profit_target", { step: "0.1", suffix: "%", placeholder: "%" })}
      ${giNumber("Rental Equipment — Wire %", "rental_wire_profit_target", { step: "0.1", suffix: "%", placeholder: "%" })}
      ${giNumber("Mobilization %", "mobilization_profit_target", { step: "0.1", suffix: "%", placeholder: "%" })}
    </div>`;

  const bodyHtml = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-3 pb-3 items-start">
      ${section("General Information", generalInfoHtml, { resetKey: "general_info" })}
      ${section("Key Estimating Inputs", keyInputsHtml, { note: "Drives calculations across all tabs", resetKey: "key_inputs" })}
    </div>
  `;

  // Render this tab body into the container the workspace shell prepared.
  // (No setShell here — the shell + tab strip + page-title hiding are
  // already in place from renderEstimateWorkspace.)
  container.innerHTML = bodyHtml;

  // ── input wiring ───────────────────────────────────────────────────────────
  // Mirror form values into state. For Phase 1 nothing reads most of these —
  // no save yet — but they are kept in sync so a future phase can hook into the
  // same state object. The Date of Request additionally drives Start Date.
  // Update a read-only calc cell (tagged data-est-calc) with new HTML.
  function setCalcCell(key, html) {
    const cell = document.querySelector(`[data-est-calc="${key}"]`);
    if (cell) cell.innerHTML = html;
  }

  // Write a value into the Start Date input + state. Skips the date/text
  // type swap while the field is focused so the open date picker isn't
  // disrupted; the focusout handler will normalise the type on blur.
  function setStartDateInput(value) {
    state.start_date = value;
    const el = document.querySelector('[data-est-input="start_date"]');
    if (!el) return;
    el.value = value;
    if (el.hasAttribute("data-est-date") && el !== document.activeElement) {
      el.type = value ? "date" : "text";
    }
  }

  function syncFromEl(el) {
    const key = el.getAttribute("data-est-input");
    if (!(key in state)) return;
    const wantNumber = el.getAttribute("data-est-type") === "number";
    // Empty number fields stay "" (not 0) so calculations can tell the
    // difference between "blank" and a real zero.
    state[key] = wantNumber ? (el.value === "" ? "" : Number(el.value)) : el.value;

    // Date of Request — Original auto-fills Start Date with +90 days, unless
    // the user has manually overridden Start Date.
    if (key === "date_of_request" && !startDateManual) {
      setStartDateInput(computeStartDate(state.date_of_request));
    }

    // Start Date — manual edits set the override flag so subsequent Date of
    // Request changes don't clobber the user's value. Clearing the field
    // resets the flag and re-syncs to date_of_request + 90 days.
    if (key === "start_date") {
      if (state.start_date === "") {
        startDateManual = false;
        setStartDateInput(computeStartDate(state.date_of_request));
      } else {
        startDateManual = true;
      }
    }

    // One-Way Travel time drives the Downtime Day Price + Travel Days/Crew/Mob.
    if (key === "one_way_travel_hrs") {
      state.downtime_day_price_target = computeDowntimePrice(state.one_way_travel_hrs);
      setCalcCell("downtime_day_price_target", downtimePriceHtml());

      state.travel_days_per_crew_per_mob = computeTravelDaysPerCrewPerMob();
      setCalcCell("travel_days_per_crew_per_mob", travelDaysPerCrewPerMobHtml());
    }

    // One-Way Travel time + Crew Size drive Labor Cost Per Day. Labor Cost
    // Per TRAVEL Day mirrors the same value.
    if (key === "one_way_travel_hrs" || key === "crew_size") {
      state.labor_cost_per_day = computeLaborCostPerDay();
      state.labor_cost_per_travel_day = state.labor_cost_per_day;
      setCalcCell("labor_cost_per_day", laborCostPerDayHtml());
      setCalcCell("labor_cost_per_travel_day", laborCostPerDayHtml());
    }

    // Bridge any state change relevant to the Quoting Metrics page.
    publishEstimateState();
    // Persist to /api/estimates (debounced per field).
    patchEstimateField(key, state[key]);
  }

  // All listeners below are scoped to the tab body container so they die with
  // the old DOM when the workspace re-renders (e.g. switching to Base and
  // back). Document-scoping would stack a fresh listener every time the user
  // revisits General Info — after a few visits, each section-toggle click
  // fires N times and the chevron appears "stuck."
  container.addEventListener("input", (e) => {
    const el = e.target.closest("[data-est-input]");
    if (el) syncFromEl(el);
  });
  container.addEventListener("change", (e) => {
    const el = e.target.closest("[data-est-input]");
    if (el) syncFromEl(el);
  });

  // Date placeholder swap: blank date fields render as text (so the
  // "Select Date" placeholder shows), become a real date picker on focus,
  // and revert to text on blur if still empty.
  container.addEventListener("focusin", (e) => {
    const el = e.target.closest("[data-est-date]");
    if (el && el.type !== "date") el.type = "date";
  });
  container.addEventListener("focusout", (e) => {
    const el = e.target.closest("[data-est-date]");
    if (el && !el.value) el.type = "text";
  });

  // Collapsible sections: clicking a section header toggles its body.
  container.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-section-toggle]");
    if (!toggle) return;
    const card = toggle.closest("[data-section]");
    const body = card?.querySelector("[data-section-body]");
    if (!body) return;
    const collapsed = body.classList.toggle("hidden");
    const chevron = toggle.querySelector("[data-section-chevron]");
    if (chevron) chevron.classList.toggle("-rotate-90", collapsed);
  });

  // ── Reset card ─────────────────────────────────────────────────────────────
  // Clears every user-editable input in a card by setting each element's value
  // to "" and dispatching an input event — that runs syncFromEl which updates
  // state, refreshes chips, and PATCHes the backend. Auto-calc cells
  // (Customer, Quote Submittal Date) and read-only readouts are skipped.
  const RESET_KEYS = {
    general_info: [
      "quote_number", "quote_description",
      "contact_first", "contact_last",
      "end_user", "quoted_by", "quote_notes",
      "date_of_request", "start_date",
      "project_city", "project_state",
    ],
    key_inputs: [
      "one_way_travel_hrs", "equipment_requirement", "rack_height",
      "estimate_type", "breaking_out_mobilization", "rent_wire_guidance_equipment",
      "crew_count", "crew_size",
      "project_time_budget_adder", "project_time_budget_pct",
      "lodging_cost_per_day", "mgmt_travel_multiplier",
      "rack_install_profit_target", "rental_rack_profit_target",
      "wire_guidance_profit_target", "rental_wire_profit_target",
      "mobilization_profit_target",
    ],
  };
  const RESET_LABELS = {
    general_info: "General Information",
    key_inputs:   "Key Estimating Inputs",
  };

  function onResetCardClick(e) {
    const btn = e.target.closest("[data-reset-card]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const key = btn.getAttribute("data-reset-card");
    const fields = RESET_KEYS[key];
    if (!fields) return;
    if (!confirm(`Clear all inputs in "${RESET_LABELS[key]}"? This cannot be undone.`)) return;

    // Reset the manual override so Start Date follows Date of Request again.
    if (key === "general_info") startDateManual = false;

    for (const field of fields) {
      const el = document.querySelector(`[data-est-input="${field}"]`);
      if (!el) continue;
      el.value = "";
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  container.addEventListener("click", onResetCardClick);

  // (Base Quoting Metrics moved to its own tab — see renderBaseTab.)
}
