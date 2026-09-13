// Estimate page — Phase 1
// Mirrors cells A1:H36 of the "0. ROLL UP Quoting Metrics" Excel tab.
// Inputs are interactive (live local state). The Start Date / Quote Submittal
// Date calculations are wired now; remaining calc logic + persistence land in
// later phases. Reference-table dropdowns (Estimate Type, Equipment, Rack
// Height, Yes/No, Crew Size) are pulled from /api/quoting/lookup-values and
// fall back to static defaults if the fetch fails.

import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import { api, hasCapability, getToken } from "../api.js";
import { mountBaseQuotingMetrics, createCellOverrideClient } from "./base-quoting-metrics.js";
import { contactFormModal } from "./contacts.js";
import { computeSetRollup, computeSetBundles, applyLineOverrides } from "../utils/qm-rollup.js";

// The blank quoting-metrics workbook's defaults (mirrors ESTIMATE_DEFAULTS on the
// backend, which pre-fills them on a new quote). Any General Info field changed
// away from these gets highlighted, so estimators can see at a glance what they
// tuned for this job vs. what's still standard.
const GI_DEFAULTS = {
  equipment_requirement:        "LP (Liquid Propane)",
  rack_height:                  "Shorter than 25' (300\")",
  crew_count:                   1,
  crew_size:                    "Full",
  estimate_type:                "Standard",
  breaking_out_mobilization:    "No",
  rent_wire_guidance_equipment: "Yes",
  project_time_budget_adder:    "Yes",
  project_time_budget_pct:      5,
  rack_install_profit_target:   42,
  wire_guidance_profit_target:  42,
  rental_rack_profit_target:    30,
  rental_wire_profit_target:    0,
  mobilization_profit_target:   -1.5,
  mgmt_travel_multiplier:       3.57,
};
const CHANGED_CLS = ["ring-2", "ring-amber-300", "bg-amber-50/60"];

// Flag every General Info input whose value differs from the workbook default.
function markChangedFields(root) {
  root.querySelectorAll("[data-est-input]").forEach((el) => {
    const key = el.getAttribute("data-est-input");
    if (!(key in GI_DEFAULTS)) return;
    const def = GI_DEFAULTS[key];
    const cur = el.value;
    let changed;
    if (cur === "" || cur == null) {
      changed = false;                               // blank = not yet touched
    } else if (typeof def === "number") {
      const n = Number(String(cur).replace(/[^0-9.\-]/g, ""));
      changed = !Number.isFinite(n) || Math.abs(n - def) > 1e-9;
    } else {
      changed = String(cur).trim() !== String(def).trim();
    }
    el.classList.toggle("ring-2", changed);
    el.classList.toggle("ring-amber-300", changed);
    el.classList.toggle("bg-amber-50/60", changed);
    if (changed) el.title = `Changed from default (${def})`;
    else if (el.title && el.title.startsWith("Changed from default")) el.title = "";
  });
}

// Top-level dispatcher for #/estimate. URL shapes:
//   #/estimate                          -> customer picker
//   #/estimate/{id}                     -> defaults to General Info tab
//   #/estimate/{id}/general             -> General Info tab
//   #/estimate/{id}/base                -> Base Quoting Metrics tab
//   #/estimate/{id}/option/{n}          -> Option N tab (option metric set)
//   #/estimate/{id}/project-rentals     -> Project Rentals tab (project_rentals set)
//   #/estimate/{id}/review              -> retired tab; redirects to /general
//   #/base-quoting-metrics              -> legacy URL; redirected to the picker
export async function estimatePage(routeFn) {
  const m = location.hash.match(/^#\/estimate\/(\d+)(?:\/(general|base|review|pdf|send-qbo|project-rentals|option\/(\d+)))?\/?$/);
  // The standalone quoting-metrics list is retired — the pipeline is the single
  // front door for quotes. Only the workbook editor (#/estimate/{id}) lives here;
  // a bare #/estimate redirects to the pipeline.
  if (!m) { location.hash = "#/pipeline"; return; }
  const estimateId = Number(m[1]);
  const tabPath    = m[2] || "general";
  const tab        = tabPath.split("/")[0];   // "general" | "base" | "project-rentals" | "option" | …
  const optionN    = m[3] ? Number(m[3]) : null;
  // The Review tab is retired — Save & Send lives in the workspace header and
  // the ROLL UP tab computes the results. Old /review links land on ROLL UP.
  if (tab === "review") { location.hash = `#/estimate/${estimateId}/general`; return; }
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
        <div class="pt-2"><a href="#/pipeline" class="text-blue-600 underline">← Back to pipeline</a></div>
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

  const isLocked = !!estimate.locked;
  // Context-aware back link: quotes that belong to a pipeline opportunity return
  // to the pipeline (their real origin); orphan quotes fall back to the list.
  // The standalone list is retired, so every quote returns to the pipeline.
  const backHref = "#/pipeline";
  const backLabel = "pipeline";
  const headerHtml = `
    <div class="card px-5 py-3">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-baseline gap-4 min-w-0">
          <a href="${backHref}" class="text-xs font-semibold text-blue-600 hover:text-blue-800 whitespace-nowrap">← Back to ${backLabel}</a>
          <div class="min-w-0">
            <div class="text-base font-extrabold truncate">${escapeHtml(estimate.customer_display_name || "(Unknown customer)")}</div>
            <div class="text-xs text-black/50 truncate">
              Quote #${escapeHtml(estimate.quote_number || "—")} · <b>Revision ${estimate.revision_no ?? 1}</b>${estimate.customer_email ? " · " + escapeHtml(estimate.customer_email) : ""}
            </div>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          ${isLocked
            ? `<span class="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 text-[11px] font-bold px-2 py-1">🔒 Locked</span>
               <button data-unlock class="rounded-lg border border-amber-300 text-amber-800 text-xs font-semibold px-3 py-1.5 hover:bg-amber-50">Unlock to edit</button>`
            : `<button data-savesend class="btn-primary text-xs font-semibold px-4 py-1.5">Save &amp; Send</button>`}
          <button data-new-revision class="rounded-lg bg-blue-50 text-blue-700 border border-blue-200 text-xs font-semibold px-3 py-1.5 hover:bg-blue-100">+ New revision</button>
          <button data-revisions class="rounded-lg border border-black/15 text-black/60 text-xs font-semibold px-3 py-1.5 hover:bg-black/5">Revisions</button>
        </div>
      </div>
      ${isLocked ? `<div class="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">This is a superseded revision — read-only. Use <b>Unlock to edit</b> to reopen it, or <b>+ New revision</b> to duplicate the current quote.</div>` : ""}
      <div data-savesend-msg hidden class="mt-2 text-[11px] font-semibold rounded-lg px-3 py-1.5" style="display:none"></div>
      <div data-snapshot-bar></div>
    </div>`;

  const baseUrl = `#/estimate/${estimateId}`;
  const tabBtn = (href, label, active) => `
    <a href="${href}"
       class="shrink-0 px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition
              ${active ? "bg-ink-900 text-white" : "text-black/70 hover:bg-black/5"}">
      ${escapeHtml(label)}
    </a>`;
  // Deletable tab (Option/PR): tab link + trailing × button, grouped so the
  // pair reads as one chip but each half is independently clickable.
  const deletableTabBtn = (href, label, active, setId, deleteLabel) => `
    <span class="shrink-0 inline-flex items-center rounded-lg overflow-hidden transition
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
        ${tabBtn(`${baseUrl}/general`, "0. ROLL UP Quoting Metrics", tab === "general")}
        ${tabBtn(`${baseUrl}/base`,    "1.0 BASE Quoting Metrics",  tab === "base")}
        ${options.map(opt => deletableTabBtn(
          `${baseUrl}/option/${opt.sort_order}`,
          `1.${opt.sort_order} ${opt.label || `Option ${opt.sort_order}`} - Quoting Metrics`,
          tab === "option" && optionN === opt.sort_order,
          opt.id,
          opt.label || `Option ${opt.sort_order}`
        )).join("")}
        ${projectRentalsSet ? deletableTabBtn(
          `${baseUrl}/project-rentals`,
          "1.10 PROJECT RENTALS",
          tab === "project-rentals",
          projectRentalsSet.id,
          projectRentalsSet.label || "Project Rentals"
        ) : ""}
        <button type="button"
                class="shrink-0 px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap text-blue-600 hover:bg-blue-50 border border-dashed border-blue-200"
                data-add-option>
          + Add Option
        </button>
        ${!projectRentalsSet ? `
          <button type="button"
                  class="shrink-0 px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap text-blue-600 hover:bg-blue-50 border border-dashed border-blue-200"
                  data-add-project-rentals>
            + Project Rentals
          </button>` : ""}
        <div class="flex-1"></div>
        ${tabBtn(`${baseUrl}/pdf`, "Estimate PDF", tab === "pdf")}
        ${tabBtn(`${baseUrl}/send-qbo`, "QBO Lines", tab === "send-qbo")}
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

  // ── Save & Send (workspace header) ─────────────────────────────────────────
  // Step 9 — one action from anywhere in the workspace: file the PDF into
  // "4 Quotes", update the pipeline row, lock the quote. Same behavior the
  // Estimate PDF tab's button had; saveAndSendEstimate() is the shared engine.
  document.querySelector("[data-savesend]")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (!confirm("Save & Send this estimate?\n\nThis files the PDF into the “4 Quotes” folder, updates the pipeline row, and locks this quote (start a New revision or Unlock to edit later).")) return;
    const msgEl = document.querySelector("[data-savesend-msg]");
    const say = (text, ok) => {
      if (!msgEl) return;
      msgEl.textContent = text;
      msgEl.hidden = false;
      msgEl.style.display = "";
      msgEl.className = `mt-2 text-[11px] font-semibold rounded-lg px-3 py-1.5 border ${ok
        ? "text-emerald-700 bg-emerald-50 border-emerald-200"
        : "text-red-600 bg-red-50 border-red-200"}`;
    };
    btn.setAttribute("disabled", "true");
    btn.textContent = "Saving…";
    try {
      const j = await saveAndSendEstimate(estimateId, metricSets, estimate);
      say(`Saved ✓ filed to “4 Quotes” (${j.filename}), pipeline updated, quote locked.`, true);
      setTimeout(() => location.reload(), 1000);   // reflect the locked read-only state
    } catch (err) {
      say("Save failed: " + (err?.message || err), false);
      btn.removeAttribute("disabled");
      btn.textContent = "Save & Send";
    }
  });

  // ── Revision controls (feedback #1) ────────────────────────────────────────
  document.querySelector("[data-new-revision]")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (!confirm("Create a new revision? This duplicates the current quote (same quote #, next revision number) and locks this one.")) return;
    btn.disabled = true; btn.textContent = "Creating…";
    try {
      const r = await api(`/estimates/${estimateId}/revise`, { method: "POST" });
      location.hash = `#/estimate/${r.estimate_id}`;
    } catch (err) { alert(err?.message || "Failed to create revision"); btn.disabled = false; btn.textContent = "+ New revision"; }
  });
  document.querySelector("[data-unlock]")?.addEventListener("click", async (e) => {
    if (!confirm("Unlock this superseded revision so it can be edited directly? (This does not create a new revision.)")) return;
    try { await api(`/estimates/${estimateId}/unlock`, { method: "POST" }); location.reload(); }
    catch (err) { alert(err?.message || "Failed to unlock"); }
  });
  document.querySelector("[data-revisions]")?.addEventListener("click", () => openRevisionsModal(estimateId));

  // ── Frozen reference data (#2 packaging) ───────────────────────────────────
  // This quote prices from the rates/lookups captured when it was started (or
  // last refreshed). Show the freeze date; when the live tables have moved on,
  // offer an EXPLICIT "Update to current rates" — never reprice silently.
  (async () => {
    const bar = document.querySelector("[data-snapshot-bar]");
    if (!bar) return;
    let info;
    try { info = await api(`/estimates/${estimateId}/snapshot-info`); } catch (_) { return; }
    const asOf = (info.captured_at || info.snapshot_at || "").slice(0, 10);
    if (!asOf) return;
    const n = info.change_count || 0;
    bar.innerHTML = `
      <div class="mt-2 flex items-center gap-2 text-[11px] ${n ? "text-indigo-800 bg-indigo-50 border border-indigo-200" : "text-black/45 bg-black/[0.02] border border-black/10"} rounded-lg px-3 py-1.5">
        <span>📌 Priced from rates &amp; lookup values frozen <b>${escapeHtml(asOf)}</b>${n ? ` — <b>${n}</b> reference change${n > 1 ? "s" : ""} since` : " · up to date with today's tables"}</span>
        ${n && !isLocked ? `<button data-refresh-rates class="ml-auto rounded-lg border border-indigo-300 text-indigo-800 font-semibold px-2.5 py-1 hover:bg-indigo-100 whitespace-nowrap">Update to current rates…</button>` : ""}
      </div>`;
    bar.querySelector("[data-refresh-rates]")?.addEventListener("click", async () => {
      const list = (info.changes || []).slice(0, 15).map(c =>
        c.change ? `• ${c.item} — ${c.change}`
                 : `• ${c.item}: ${c.field} ${c.old ?? "—"} → ${c.new ?? "—"}`).join("\n");
      const more = (info.changes || []).length > 15 ? `\n…and ${info.changes.length - 15} more` : "";
      if (!confirm(`Re-freeze this quote at TODAY'S rates and reprice its lines?\n\nChanges since ${asOf}:\n${list}${more}\n\nThis cannot be undone (create a new revision first if you want to keep the old pricing).`)) return;
      const reason = prompt("Why update the rates? (recorded in the audit log — OK to leave blank)", "");
      if (reason === null) return;
      try {
        await api(`/estimates/${estimateId}/refresh-snapshot`, {
          method: "POST", body: JSON.stringify({ reason: reason.trim() || null }) });
        location.reload();
      } catch (err) { alert(err?.message || "Failed to update rates"); }
    });
  })();

  // Locked revisions are read-only: disable data-entry controls in the tab body
  // (tabs re-render on navigation, so observe and re-apply).
  if (isLocked) {
    const tb = document.querySelector("[data-tab-body]");
    const lockInputs = () => tb?.querySelectorAll("input, select, textarea").forEach(el => { el.disabled = true; });
    lockInputs();
    const mo = new MutationObserver(lockInputs);
    if (tb) mo.observe(tb, { childList: true, subtree: true });
    window.addEventListener("hashchange", () => mo.disconnect(), { once: true });
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
  // The ROLL UP's Option Selector rows carry data-delete-set buttons too —
  // same handler, so an option squeezed out of the tab strip is still
  // deletable from the selector table. (tab body node is recreated per
  // workspace render, so this never double-binds.)
  tabBody.addEventListener("click", onShellClick);
  if (tab === "general") {
    return renderGeneralInfoTab(tabBody, estimate, estimateId, routeFn);
  }
  if (tab === "base") {
    return renderBaseTab(tabBody, estimateId, !!estimate.locked);
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
    return renderOptionTab(tabBody, estimateId, optionSet.id, !!estimate.locked);
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
    return renderOptionTab(tabBody, estimateId, projectRentalsSet.id, !!estimate.locked);
  }
  if (tab === "pdf") {
    return renderPdfTab(tabBody, estimateId, metricSets, estimate);
  }
  if (tab === "send-qbo") {
    return renderSendToQboTab(tabBody, estimateId, metricSets, estimate);
  }
}

// ── Revisions history modal ──────────────────────────────────────────────────
async function openRevisionsModal(estimateId) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4";
  overlay.innerHTML = `
    <div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 max-h-[85vh] overflow-auto">
      <div class="text-base font-bold text-ink-900 mb-0.5">Revisions</div>
      <div class="text-xs text-black/50 mb-3">Each revision is a separate quoting-metrics under the same quote number. The current revision drives the pipeline row.</div>
      <div data-body class="text-sm text-black/50">Loading…</div>
      <div class="mt-4 flex justify-end"><button data-close class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Close</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("[data-close]").addEventListener("click", close);
  const body = overlay.querySelector("[data-body]");
  try {
    const d = await api(`/estimates/${estimateId}/quote-revisions`);
    const rows = d.revisions || [];
    body.innerHTML = rows.map(r => `
      <a href="#/estimate/${r.id}" data-goto class="flex items-center justify-between py-2 px-2 -mx-2 rounded-lg hover:bg-black/[0.03] ${String(r.id) === String(estimateId) ? "bg-blue-50/60" : ""}">
        <div>
          <div class="font-semibold text-ink-900">Revision ${r.revision_no}${r.is_current ? ` <span class="text-[10px] font-bold uppercase text-emerald-700">current</span>` : ""}${r.locked ? ` <span class="text-[10px]">🔒</span>` : ""}</div>
          <div class="text-[10px] text-black/40">Quote #${escapeHtml(r.quote_number || "—")} · ${r.status}${r.created_at ? " · " + escapeHtml(r.created_at.slice(0,10)) : ""}</div>
        </div>
        <span class="text-[11px] font-semibold ${String(r.id) === String(estimateId) ? "text-black/40" : "text-blue-600"}">${String(r.id) === String(estimateId) ? "viewing" : "open →"}</span>
      </a>`).join("") || `<div class="text-black/40 py-2">No revisions.</div>`;
    body.querySelectorAll("[data-goto]").forEach(a => a.addEventListener("click", () => close()));
  } catch (e) { body.innerHTML = `<div class="text-red-600 py-2">Couldn't load revisions.</div>`; }
}

// ── Shared PDF / Save & Send engine ─────────────────────────────────────────
// The pieces the Estimate PDF tab AND the workspace-header Save & Send both
// need: the priced line-item model built from computeSetBundles (the validated
// engine, so the PDF ties out to the workbook), the per-estimate saved model,
// the /pdf endpoint call, and the pipeline sync-metrics computation. One
// implementation, two callers.
function createPdfEngine({ estimateId, estimateRow, metricSets, lookups, allLines, dfl, cellOverrides = {} }) {
  let estimateState = {};
  try { const raw = localStorage.getItem("opi_estimate_state_v1"); if (raw) estimateState = JSON.parse(raw) || {}; } catch {}

  // Typed-over cells (#1 sheet parity): per-line overrides transform the line
  // data itself; the map + per-set key prefix rides every rollup/bundle call
  // below so the PDF amounts + pipeline sync consume the SAME overridden
  // values as the metrics tabs.
  const ovLines = applyLineOverrides(allLines, cellOverrides);
  const linesBySet = new Map();
  for (const l of ovLines) { const s = l.metric_set_id; if (!linesBySet.has(s)) linesBySet.set(s, []); linesBySet.get(s).push(l); }
  const orderedSets = [
    ...(metricSets || []).filter(s => s.kind === "base"),
    ...(metricSets || []).filter(s => s.kind === "option").sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    ...(metricSets || []).filter(s => s.kind === "project_rentals"),
  ].filter(s => Number(s.is_enabled) === 1);

  const BUNDLE_ORDER = ["installation", "rentals", "wg_labor", "wg_additional", "mobilization", "remobilization", "downtime"];
  const BUNDLE_ITEM = {
    installation: "Installation (Labor)", rentals: "Rentals", wg_labor: "Wire Guidance (Labor)",
    wg_additional: "Wire Guidance - Additional", mobilization: "Mobilization",
    remobilization: "Remobilization", downtime: "Downtime",
  };
  const num = (v) => { const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : 0; };
  const initials = (name) => (name || "").trim().split(/\s+/).map(w => w[0] || "").join("").toUpperCase().slice(0, 4) || "";

  const defaultDesc = (label, loc, e) => {
    if (label === "Installation (Labor)")
      return `${e.quote_description || "Installation"}${loc ? " in " + loc : ""}\n\nScope of work (BOM):\n`;
    if (label === "Rentals")
      return `Forklift and Scissor Lift Rental\n\n${dfl.rentals_note || ""}`;
    if (label === "Wire Guidance (Labor)")
      return `Wire Guidance Installation${loc ? " in " + loc : ""}\n\n**Line driver to be provided by customer. Includes floor scrubber finish along wire guidance cut path.`;
    return "";
  };

  function buildDefaultModel() {
    const e = estimateRow || {};
    const loc = [e.project_city, e.project_state].filter(Boolean).join(", ");
    const contact = [e.contact_first, e.contact_last].filter(Boolean).join(" ");
    const agg = new Map(); const order = [];
    for (const set of orderedSets) {
      const bundles = computeSetBundles({ set, lines: linesBySet.get(set.id) || [], lookups, estimateState,
                                          overrides: cellOverrides, keyPrefix: `s${set.id}:` });
      for (const bk of BUNDLE_ORDER) {
        const b = bundles[bk]; if (!b) continue;
        const total = (b.lines || []).reduce((s, [, v]) => s + (Number(v) || 0), 0);
        if (total <= 0) continue;
        const label = BUNDLE_ITEM[bk] || b.title;
        if (!agg.has(label)) { agg.set(label, 0); order.push(label); }
        agg.set(label, agg.get(label) + total);
      }
    }
    const lines = order.map(label => ({
      label, description: defaultDesc(label, loc, e), qty: 1, rate: agg.get(label), amount: agg.get(label),
    }));
    lines.push({ label: "Dumpster & Porta Potty Rental", description: dfl.dumpster_note || "", qty: 0, rate: 1000, amount: 0 });
    lines.push({ label: "Payment Terms", description: dfl.payment_terms || "", qty: 1, rate: 0, amount: 0 });
    lines.push({ label: "Stipulations", description: dfl.stipulations || "", qty: 1, rate: 0, amount: 0 });
    return {
      bill_to: [e.customer_display_name, contact, loc].filter(Boolean).join("\n"),
      sales_rep: dfl.sales_rep || "", preparer: initials(e.quoted_by),
      footer_title: `${e.quote_description || ""}${loc ? " in " + loc : ""}`.trim(),
      quote_date: new Date().toISOString().slice(0, 10),
      lines,
    };
  }

  const MODEL_KEY = `opi_pdf_model_${estimateId}`;
  // Saved per-estimate model from this device, or the metrics-built default.
  function loadModel() {
    let model;
    try { model = JSON.parse(localStorage.getItem(MODEL_KEY) || "null"); } catch { model = null; }
    return (model && Array.isArray(model.lines)) ? model : buildDefaultModel();
  }
  const saveModel = (model) => localStorage.setItem(MODEL_KEY, JSON.stringify(model));
  const totalOf = (model) => model.lines.reduce((s, l) => s + num(l.amount), 0);

  async function callPdf(model, saveMode) {
    const payload = {
      lines: model.lines.map(l => ({ label: l.label, description: l.description, qty: num(l.qty), rate: num(l.rate), amount: num(l.amount) })),
      total: totalOf(model), sales_rep: model.sales_rep, footer_title: model.footer_title,
      preparer: model.preparer, quote_date: model.quote_date,
      bill_to: String(model.bill_to || "").split("\n").map(s => s.trim()).filter(Boolean),
      save: !!saveMode,
    };
    const resp = await fetch(`/api/estimates/${estimateId}/pdf`, {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + getToken() },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error((await resp.text()).slice(0, 160));
    if (saveMode) return resp.json();
    window.open(URL.createObjectURL(await resp.blob()), "_blank");
  }

  // Pipeline sync metrics — contract_value is the actual quoted PDF total
  // (includes edited/material lines); OH&P/day counts come from the per-set
  // rollup math across enabled sets.
  function computeSyncMetrics(model) {
    const perSet = orderedSets.map(set => ({ set, rollup: computeSetRollup({ set, lines: linesBySet.get(set.id) || [], lookups, estimateState,
                                                                             overrides: cellOverrides, keyPrefix: `s${set.id}:` }) }));
    const sumOf = (k) => perSet.reduce((s, r) => s + (Number(r.rollup[k]) || 0), 0);
    const pct = (v) => (Number(v ?? 0) || 0) / 100;
    const markUp = (cost, p) => (p > 0 && p < 1 ? cost / (1 - p) : cost);
    const price = markUp(sumOf("H38"), pct(estimateState.rack_install_profit_target))
      + markUp(sumOf("H213"), pct(estimateState.wire_guidance_profit_target))
      + markUp(sumOf("H187"), pct(estimateState.rental_rack_profit_target))
      + markUp(sumOf("H226"), pct(estimateState.rental_wire_profit_target))
      + sumOf("travel_costs_total") + sumOf("H248");
    const profit = price - sumOf("grand_total");
    // A typed-over ROLL UP Price to Customer (r:D32) IS the quoted price —
    // it wins over the PDF total so Save & Send pushes the overridden price
    // to the pipeline.
    const d32ovr = cellOverrides["r:D32"];
    return {
      contract_value: (d32ovr != null && Number.isFinite(Number(d32ovr))) ? Number(d32ovr) : totalOf(model),
      ohp_amount: profit,
      ohp_pct: Math.round((price > 0 ? profit / price : 0) * 1000) / 10,
      labor_days: perSet.reduce((s, r) => s + (Number(r.rollup.D23) || 0) + (Number(r.rollup.D24) || 0), 0),
      travel_days: perSet.reduce((s, r) => s + (Number(r.rollup.D22) || 0), 0),
    };
  }

  return { buildDefaultModel, loadModel, saveModel, totalOf, callPdf, computeSyncMetrics };
}

// ── Save & Send (shared handler) ─────────────────────────────────────────────
// Step 9 — one action: file the PDF into "4 Quotes", update the pipeline, lock
// the quote. Called from the workspace header button; self-sufficient (fetches
// its own data) so it works from any tab. Returns the /pdf save response
// ({ filename, … }) so the caller can surface the result message.
async function saveAndSendEstimate(estimateId, metricSets, estimateRow) {
  const [lookups, allLines, dfl, ovResp] = await Promise.all([
    api(`/quoting/lookup-values?estimate_id=${estimateId}`),
    api(`/quoting/metric-lines?estimate_id=${estimateId}`),
    api("/estimates/pdf-defaults").catch(() => ({})),
    api(`/estimates/${estimateId}/cell-overrides`).catch(() => ({ overrides: {} })),
  ]);
  const eng = createPdfEngine({ estimateId, estimateRow, metricSets, lookups, allLines, dfl,
                                cellOverrides: (ovResp && ovResp.overrides) || {} });
  const model = eng.loadModel();
  const j = await eng.callPdf(model, true);                          // 1) file the PDF
  if (estimateRow?.opportunity_id) {                                 // 2) update the pipeline
    try { await api(`/opportunities/by-estimate/${estimateId}/sync-metrics`, { method: "POST", body: JSON.stringify(eng.computeSyncMetrics(model)) }); } catch (_) {}
  }
  await api(`/estimates/${estimateId}/lock`, { method: "POST" });    // 3) lock
  return j;
}

// ── Estimate PDF tab ─────────────────────────────────────────────────────────
// The customer-facing quote (step 7). Priced line items come from computeSetBundles
// via the shared createPdfEngine (the same validated engine as Send-to-QBO, so the
// PDF ties out to the workbook); standard blocks (Payment Terms, Stipulations,
// Dumpster, notes) prefill from estimate_pdf_defaults. The estimator edits the
// customized areas (scope/BOM, bill-to, stipulations clause) and previews the PDF.
// The whole editable model is saved per estimate on the device; "Rebuild from
// metrics" re-pulls amounts. Save & Send lives in the workspace header bar.
async function renderPdfTab(container, estimateId, initialMetricSets, estimateRow) {
  container.innerHTML = `<div class="card px-5 py-4 text-sm text-black/50">Loading…</div>`;
  let lookups, allLines, dfl, cellOverrides;
  try {
    [lookups, allLines, dfl, cellOverrides] = await Promise.all([
      api(`/quoting/lookup-values?estimate_id=${estimateId}`),
      api(`/quoting/metric-lines?estimate_id=${estimateId}`),
      api("/estimates/pdf-defaults").catch(() => ({})),
      api(`/estimates/${estimateId}/cell-overrides`).then(r => (r && r.overrides) || {}).catch(() => ({})),
    ]);
  } catch (err) {
    container.innerHTML = `<div class="card px-5 py-4 text-sm text-red-600">Failed to load: ${escapeHtml(err?.message || String(err))}</div>`;
    return;
  }
  const eng = createPdfEngine({ estimateId, estimateRow, metricSets: initialMetricSets, lookups, allLines, dfl, cellOverrides });

  let model = eng.loadModel();
  const save = () => eng.saveModel(model);
  const totalOf = () => eng.totalOf(model);
  const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
  let msg = "";

  const preview = () => eng.callPdf(model, false).catch(e => { msg = "Preview failed: " + e.message; render(); });

  function render() {
    const inp = (val, attrs) => `<input value="${escapeHtml(val ?? "")}" ${attrs} class="w-full text-sm rounded border border-black/15 px-2 py-1">`;
    const headHtml = `
      <div class="card px-4 py-3 grid sm:grid-cols-2 gap-3">
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Bill To (one per line)</div>
          <textarea data-h="bill_to" rows="3" class="w-full text-sm rounded border border-black/15 px-2 py-1">${escapeHtml(model.bill_to || "")}</textarea></label>
        <div class="grid grid-cols-2 gap-2 content-start">
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Sales Rep</div>${inp(model.sales_rep, 'data-h="sales_rep"')}</label>
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Prepared By (initials)</div>${inp(model.preparer, 'data-h="preparer"')}</label>
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Quote Date</div>${inp(model.quote_date, 'data-h="quote_date" type="date"')}</label>
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Footer Title</div>${inp(model.footer_title, 'data-h="footer_title"')}</label>
        </div>
      </div>`;

    const rows = model.lines.map((l, i) => `
      <tr class="border-t border-black/5 align-top">
        <td class="px-2 py-2 w-40"><input value="${escapeHtml(l.label || "")}" data-l="${i}" data-f="label" class="w-full text-xs font-semibold rounded border border-black/10 px-1.5 py-1"></td>
        <td class="px-2 py-2"><textarea data-l="${i}" data-f="description" rows="2" class="w-full text-xs rounded border border-black/10 px-1.5 py-1">${escapeHtml(l.description || "")}</textarea></td>
        <td class="px-1 py-2 w-14"><input value="${escapeHtml(String(l.qty ?? ""))}" data-l="${i}" data-f="qty" inputmode="numeric" class="w-full text-xs text-right rounded border border-black/10 px-1 py-1"></td>
        <td class="px-1 py-2 w-20"><input value="${escapeHtml(String(l.rate ?? ""))}" data-l="${i}" data-f="rate" inputmode="numeric" class="w-full text-xs text-right rounded border border-black/10 px-1 py-1"></td>
        <td class="px-1 py-2 w-24"><input value="${escapeHtml(String(l.amount ?? ""))}" data-l="${i}" data-f="amount" inputmode="numeric" class="w-full text-xs text-right tabular-nums rounded border border-black/10 px-1 py-1"></td>
        <td class="px-1 py-2 w-6 text-right"><button data-del="${i}" title="Remove line" class="text-black/30 hover:text-red-600 text-sm">×</button></td>
      </tr>`).join("");

    container.innerHTML = `
      <div class="grid gap-3">
        <div class="flex items-center justify-between flex-wrap gap-2 px-1">
          <div class="text-[11px] text-black/50">Amounts come from the validated metrics. Edit the customized areas (scope/BOM, bill-to, stipulations); standard blocks prefill from app defaults. ${msg ? `<span class="text-emerald-700 font-semibold ml-2">${escapeHtml(msg)}</span>` : ""}</div>
          <button data-rebuild class="text-[11px] font-semibold text-blue-600 hover:underline">↺ Rebuild from metrics</button>
        </div>
        ${headHtml}
        <div class="card px-2 py-2 overflow-x-auto">
          <table class="w-full" style="min-width:680px;">
            <thead><tr class="text-left text-[10px] uppercase tracking-wide text-black/40">
              <th class="px-2 py-1">Item</th><th class="px-2 py-1">Description</th>
              <th class="px-1 py-1 text-right">Qty</th><th class="px-1 py-1 text-right">Rate</th>
              <th class="px-1 py-1 text-right">Amount</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="flex items-center justify-between px-2 pt-2 mt-1 border-t border-black/5">
            <button data-add class="text-[11px] font-semibold text-blue-600 hover:underline">+ Add line</button>
            <div class="text-sm">Total <span data-total class="font-extrabold text-ink-900 tabular-nums">${money(totalOf())}</span></div>
          </div>
        </div>
        <div class="flex items-center justify-end gap-3 px-1">
          ${estimateRow?.locked
            ? `<span class="text-[11px] text-amber-700 font-semibold">🔒 Locked — unlock or start a new revision to edit</span>` : ""}
          <button data-preview class="rounded-lg border border-black/15 text-sm font-semibold px-4 py-2 hover:bg-black/5">Preview PDF</button>
        </div>
        <div class="text-[11px] text-black/45 px-1 text-right">When it's ready, <b>Save &amp; Send</b> (in the header above) files the PDF into “4 Quotes”, updates the pipeline, and locks the quote.</div>
      </div>`;

    container.querySelectorAll("[data-h]").forEach(el => el.addEventListener("input", () => { model[el.getAttribute("data-h")] = el.value; save(); }));
    container.querySelectorAll("[data-l]").forEach(el => el.addEventListener("input", () => {
      const i = Number(el.getAttribute("data-l")), f = el.getAttribute("data-f");
      model.lines[i][f] = el.value; save();
      if (f === "amount") { const t = container.querySelector("[data-total]"); if (t) t.textContent = money(totalOf()); }
    }));
    container.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => { model.lines.splice(Number(b.getAttribute("data-del")), 1); save(); render(); }));
    container.querySelector("[data-add]")?.addEventListener("click", () => { model.lines.push({ label: "", description: "", qty: 1, rate: 0, amount: 0 }); save(); render(); });
    container.querySelector("[data-rebuild]")?.addEventListener("click", () => { if (confirm("Rebuild the line items + standard blocks from the current metrics? Your description edits on this quote will be replaced.")) { model = eng.buildDefaultModel(); save(); render(); } });
    container.querySelector("[data-preview]")?.addEventListener("click", () => preview());
  }

  render();
}

// ── Send to QBO tab ──────────────────────────────────────────────────────────
// Lays out the QuickBooks-shaped bundle lines (from computeSetBundles — validated
// against OPI's workbooks) per enabled set, each line copy-to-clipboard, plus the
// QBO header fields. Each line has a manual-override input so an estimator can
// nudge a final number — the rare hand-typed one-off — without leaving the app;
// the override drives the copy value + totals. Overrides live in the estimate's
// server cell_overrides map under `qbo:` keys (they follow the estimate, not the
// device); legacy device-local overrides migrate to the server on first open.
async function renderSendToQboTab(container, estimateId, initialMetricSets, estimateRow) {
  container.innerHTML = `<div class="card px-5 py-4 text-sm text-black/50">Loading…</div>`;
  let lookups, allLines, cellOverrides;
  try {
    [lookups, allLines, cellOverrides] = await Promise.all([
      api(`/quoting/lookup-values?estimate_id=${estimateId}`),
      api(`/quoting/metric-lines?estimate_id=${estimateId}`),
      api(`/estimates/${estimateId}/cell-overrides`).then(r => (r && r.overrides) || {}).catch(() => ({})),
    ]);
  } catch (err) {
    container.innerHTML = `<div class="card px-5 py-4 text-sm text-red-600">Failed to load: ${escapeHtml(err?.message || String(err))}</div>`;
    return;
  }
  let estimateState = {};
  try { const raw = localStorage.getItem("opi_estimate_state_v1"); if (raw) estimateState = JSON.parse(raw) || {}; } catch {}

  const isLocked = !!(estimateRow && estimateRow.locked);
  const metricSets = [...(initialMetricSets || [])];
  const linesBySet = new Map();
  for (const l of applyLineOverrides(allLines, cellOverrides)) { const s = l.metric_set_id; if (!linesBySet.has(s)) linesBySet.set(s, []); linesBySet.get(s).push(l); }
  const ordered = [
    ...metricSets.filter(s => s.kind === "base"),
    ...metricSets.filter(s => s.kind === "option").sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    ...metricSets.filter(s => s.kind === "project_rentals"),
  ].filter(s => Number(s.is_enabled) === 1);
  const kindLabel = (k) => k === "base" ? "Base" : k === "option" ? "Option" : k === "project_rentals" ? "Project Rentals" : (k || "—");
  const BUNDLE_ORDER = ["installation", "rentals", "wg_labor", "wg_additional", "mobilization", "remobilization", "downtime"];
  const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");

  // Per-line manual overrides, SERVER-backed: cell_overrides key
  // "qbo:<setId>|<bundleKey>|<lineIdx>". Optimistic update + debounced PATCH
  // + rollback via the shared client; locked revisions render read-only.
  const ovClient = createCellOverrideClient({
    estimateId,
    overrides: cellOverrides,
    onError:   () => render(),
  });
  const qkey = (key) => `qbo:${key}`;
  const hasOvr = (key) => qkey(key) in cellOverrides;
  const eff = (key, computed) => (hasOvr(key) ? Number(cellOverrides[qkey(key)]) : Number(computed) || 0);

  // One-time migration: device-local overrides (the old store) move to the
  // server so they follow the estimate. Server-held keys win; the local copy
  // is deleted only once every key made it up. Locked revision → merge into
  // the in-memory view (read-only), keep the local copy untouched.
  const LEGACY_OVR_KEY = `opi_qbo_overrides_${estimateId}`;
  let legacyOvr = null;
  try { legacyOvr = JSON.parse(localStorage.getItem(LEGACY_OVR_KEY) || "null"); } catch {}
  if (legacyOvr && typeof legacyOvr === "object" && Object.keys(legacyOvr).length) {
    let allMigrated = true;
    for (const [k, v] of Object.entries(legacyOvr)) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      const sk = qkey(k);
      if (sk in cellOverrides) continue;               // server already has it
      if (isLocked) { cellOverrides[sk] = n; continue; }  // view-only merge
      try {
        await api(`/estimates/${estimateId}/cell-overrides`, {
          method: "PATCH", body: JSON.stringify({ key: sk, value: n }),
        });
        cellOverrides[sk] = n;
      } catch (err) {
        allMigrated = false;
        console.error("QBO override migration failed for", sk, err);
      }
    }
    if (!isLocked && allMigrated) {
      try { localStorage.removeItem(LEGACY_OVR_KEY); } catch {}
    }
  }

  let flash = null;
  const copy = (text, tag) => {
    navigator.clipboard?.writeText(String(text)).then(() => { flash = tag; render(); setTimeout(() => { flash = null; render(); }, 900); });
  };

  function hdrField(label, value) {
    const v = value == null || value === "" ? "" : String(value);
    return `<div class="flex items-center gap-2 py-1">
      <div class="text-[10px] font-bold uppercase tracking-wide text-black/40 w-28 shrink-0">${label}</div>
      <div class="text-sm text-ink-900 font-semibold flex-1 truncate">${escapeHtml(v || "—")}</div>
      ${v ? `<button data-copy="${escapeHtml(v)}" data-tag="h:${label}" class="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-black/10 hover:bg-black/5">${flash === "h:" + label ? "✓" : "copy"}</button>` : ""}
    </div>`;
  }

  function render() {
    const e = estimateRow || {};
    const contact = [e.contact_first, e.contact_last].filter(Boolean).join(" ");
    const header = `
      <div class="card px-4 py-3">
        <div class="flex items-center justify-between mb-2">
          <div class="text-sm font-extrabold text-ink-900">QuickBooks header</div>
          <div class="text-[11px] text-black/40">Type these into the QBO estimate, then copy each bundle line below.</div>
        </div>
        <div class="grid sm:grid-cols-2 gap-x-6">
          ${hdrField("Quote #", e.quote_number)}
          ${hdrField("Customer", e.customer_display_name)}
          ${hdrField("Description", e.quote_description)}
          ${hdrField("Contact", contact)}
          ${hdrField("End user", e.end_user)}
          ${hdrField("Quoted by", e.quoted_by)}
        </div>
      </div>`;

    const setCards = ordered.map(set => {
      const lines = linesBySet.get(set.id) || [];
      const bundles = computeSetBundles({ set, lines, lookups, estimateState,
                                          overrides: cellOverrides, keyPrefix: `s${set.id}:` });
      const label = `${kindLabel(set.kind)}${set.label && set.kind !== "base" ? " · " + set.label : ""}`;
      let setTotal = 0;
      const bundleBlocks = BUNDLE_ORDER.map(bk => {
        const b = bundles[bk];
        if (!b) return "";
        const rows = b.lines.map(([lbl, val], idx) => {
          const key = `${set.id}|${bk}|${idx}`;
          const v = eff(key, val);
          const overridden = hasOvr(key);
          return { lbl, key, v, overridden };
        });
        const btotal = rows.reduce((s, r) => s + r.v, 0);
        if (btotal === 0 && rows.every(r => r.v === 0)) return "";
        setTotal += btotal;
        const copyBlock = rows.map(r => `${r.lbl}\t${Math.round(r.v)}`).join("\n");
        return `
          <div class="border border-black/10 rounded-xl overflow-hidden">
            <div class="flex items-center justify-between bg-black/[0.03] px-3 py-1.5">
              <div class="text-xs font-bold text-ink-900">${escapeHtml(b.title)}</div>
              <div class="flex items-center gap-2">
                <div class="text-xs font-extrabold tabular-nums text-ink-900">${money(btotal)}</div>
                <button data-copyblock="${escapeHtml(copyBlock)}" data-tag="b:${set.id}:${bk}" class="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-black/10 hover:bg-black/5 bg-white">${flash === "b:" + set.id + ":" + bk ? "✓ copied" : "copy all"}</button>
              </div>
            </div>
            <table class="w-full text-xs">
              <tbody>${rows.map(r => `
                <tr class="border-t border-black/5">
                  <td class="px-3 py-1 text-black/70">${escapeHtml(r.lbl)}</td>
                  <td class="px-2 py-1 w-28">
                    <input data-ovr="${r.key}" value="${Math.round(r.v)}" inputmode="numeric" ${isLocked ? "disabled" : ""}
                      class="w-24 text-right tabular-nums text-xs rounded border px-1.5 py-0.5 ${r.overridden ? "border-amber-400 bg-amber-50 text-amber-800 font-semibold" : "border-black/10"}"
                      ${r.overridden ? `title="Typed-over — saved with the estimate"` : ""}>
                  </td>
                  <td class="px-2 py-1 w-8 text-right">
                    ${r.overridden && !isLocked ? `<button data-reset="${r.key}" title="Reset to computed" class="text-[10px] text-amber-600 hover:underline">↺</button>` : ""}
                  </td>
                  <td class="px-2 py-1 w-10 text-right">
                    <button data-copy="${Math.round(r.v)}" data-tag="l:${r.key}" class="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-black/10 hover:bg-black/5">${flash === "l:" + r.key ? "✓" : "copy"}</button>
                  </td>
                </tr>`).join("")}
              </tbody>
            </table>
          </div>`;
      }).filter(Boolean).join("");
      return `
        <div class="card px-4 py-3">
          <div class="flex items-center justify-between mb-2">
            <div class="text-sm font-extrabold text-ink-900">${escapeHtml(label)}</div>
            <div class="text-xs text-black/50">Set total <span class="font-extrabold text-ink-900">${money(setTotal)}</span></div>
          </div>
          <div class="grid gap-2">${bundleBlocks || `<div class="text-xs text-black/40 py-2">No priced bundles in this set.</div>`}</div>
        </div>`;
    }).join("");

    // Line descriptions the estimator wrote on the Estimate PDF tab — the office
    // copies these into the QBO estimate lines. (Persisted per estimate on the device.)
    let pdfModel = null;
    try { pdfModel = JSON.parse(localStorage.getItem(`opi_pdf_model_${estimateId}`) || "null"); } catch (_) {}
    const pdfPanel = (pdfModel && Array.isArray(pdfModel.lines) && pdfModel.lines.length)
      ? `<div class="card px-4 py-3">
           <div class="flex items-center justify-between mb-2">
             <div class="text-sm font-extrabold text-ink-900">Line descriptions (from the Estimate PDF)</div>
             <div class="text-[11px] text-black/40">Copy each into the matching QBO estimate line.</div>
           </div>
           <div class="divide-y divide-black/5">
             ${pdfModel.lines.map((l, i) => `
               <div class="py-2 flex items-start gap-2">
                 <div class="w-36 shrink-0 text-xs font-bold text-ink-900">${escapeHtml(l.label || "—")}</div>
                 <div class="flex-1 min-w-0 text-xs text-black/70" style="white-space:pre-wrap;">${escapeHtml(l.description || "")}</div>
                 <button data-copydesc="${i}" class="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded border border-black/10 hover:bg-black/5">${flash === "d:" + i ? "✓" : "copy"}</button>
               </div>`).join("")}
           </div>
         </div>`
      : `<div class="card px-4 py-3 text-xs text-black/50">No line descriptions yet — fill them in on the <b>Estimate PDF</b> tab and they'll show here to copy into QBO.</div>`;

    container.innerHTML = `<div class="grid gap-3">
      <div class="text-[11px] text-black/50 px-1">Amounts come from the validated bundle calc. Edit any cell to override the exact number you'll type into QBO (saved with the estimate — overrides follow it to any device); ↺ resets it.${isLocked ? ` <span class="text-amber-700 font-semibold">🔒 Locked revision — overrides shown read-only.</span>` : ""}</div>
      ${header}${pdfPanel}${setCards || `<div class="card px-5 py-4 text-sm text-black/50">No enabled metric sets.</div>`}
    </div>`;

    container.querySelectorAll("[data-copydesc]").forEach(b => b.addEventListener("click", () => copy((pdfModel.lines[Number(b.getAttribute("data-copydesc"))] || {}).description || "", "d:" + b.getAttribute("data-copydesc"))));
    container.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => copy(b.getAttribute("data-copy"), b.getAttribute("data-tag"))));
    container.querySelectorAll("[data-copyblock]").forEach(b => b.addEventListener("click", () => copy(b.getAttribute("data-copyblock"), b.getAttribute("data-tag"))));
    container.querySelectorAll("[data-reset]").forEach(b => b.addEventListener("click", () => {
      if (isLocked) return;
      ovClient.set(qkey(b.getAttribute("data-reset")), null);   // null = revert on the server
      render();
    }));
    container.querySelectorAll("[data-ovr]").forEach(inp => {
      inp.addEventListener("change", () => {
        if (isLocked) return;
        const key = inp.getAttribute("data-ovr");
        const n = Number(String(inp.value).replace(/[^0-9.\-]/g, ""));
        if (!Number.isFinite(n)) { render(); return; }
        ovClient.set(qkey(key), n);                             // optimistic + debounced PATCH
        render();
      });
    });
  }

  render();
}

function renderBaseTab(container, estimateId, locked = false) {
  // Mount the existing Base Quoting Metrics UI directly into the tab body
  // container. Cleanup returns a function we chain to hashchange.
  mountBaseQuotingMetrics({ container, estimateId, locked })
    .then(cleanup => {
      window.addEventListener("hashchange", cleanup, { once: true });
    })
    .catch(err => {
      container.innerHTML = `<div class="card px-5 py-4 text-sm text-red-600">
        Failed to load Base Quoting Metrics: ${escapeHtml(err?.message || String(err))}
      </div>`;
    });
}

function renderOptionTab(container, estimateId, metricSetId, locked = false) {
  // Same UI as renderBaseTab — just scoped to a specific (non-Base) metric set.
  mountBaseQuotingMetrics({ container, estimateId, metricSetId, locked })
    .then(cleanup => {
      window.addEventListener("hashchange", cleanup, { once: true });
    })
    .catch(err => {
      container.innerHTML = `<div class="card px-5 py-4 text-sm text-red-600">
        Failed to load Option (metric set ${metricSetId}): ${escapeHtml(err?.message || String(err))}
      </div>`;
    });
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
    "20% Budgetary, Project Uncertain":                   "bg-yellow-100 text-yellow-800",
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
  // calculated from inputs on this tab. Cross-set results (pricing, profit,
  // duration) are computed further down from the metric sets fetched here
  // (computeRollupResults / updateResultsCells).
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
    // revision_count + latest_revision_date are server-managed — not
    // editable here.

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
    price_adjustment:              "",    // final +/- nudge to Price to Customer (round-up / discount)

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
    "price_adjustment",
    // revision_count + latest_revision_date are NOT patchable — they are
    // server-managed.
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
    lookups = await api(`/quoting/lookup-values?estimate_id=${estimateId}`);
  } catch (err) {
    console.warn("Failed to load quoting lookup values; using static defaults.", err);
  }

  // ── S3/S4/S5 data: metric sets + their lines ──────────────────────────────
  // The OPTION SELECTOR (S3), flags row (S4) and Quick Books Outputs matrix
  // (S5) are driven by the estimate's REAL metric sets. Forecast + bundle
  // values reuse the shared pure math (computeSetRollup / computeSetBundles,
  // utils/qm-rollup.js) with the data fetched here — no invented formulas.
  let metricSets  = [];
  let metricLines = [];
  let cellOverrides = {};   // typed-over cells (#1 sheet parity — server map)
  try {
    [metricSets, metricLines, cellOverrides] = await Promise.all([
      api(`/quoting/metric-sets?estimate_id=${estimateId}`),
      api(`/quoting/metric-lines?estimate_id=${estimateId}`),
      api(`/estimates/${estimateId}/cell-overrides`).then(r => (r && r.overrides) || {}).catch(() => ({})),
    ]);
  } catch (err) {
    console.warn("Failed to load metric sets/lines; Option Selector renders empty.", err);
  }
  // Locked revisions render the S3 inputs disabled (read-only parity view).
  const isLocked = !!(estimateRow && estimateRow.locked);

  // Cell-override client (shared with the metrics tabs): optimistic local
  // update, 300ms debounced PATCH, alert + rollback on failure. On this tab
  // the EDITABLE overrides are the Estimating Results green cells (r:D32..
  // r:D36, r:G32..r:G36); the S3 forecast columns + S5 matrix consume every
  // set's s{setId}:* / l{lineId}:* overrides read-only.
  const ovClient = createCellOverrideClient({
    estimateId,
    overrides: cellOverrides,
    onError:   () => updateResultsCells(),
  });
  const R_OVR_REFS = ["D32", "D33", "D34", "D35", "D36", "G32", "G33", "G34", "G35", "G36"];
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
  // Lodging/Day is DERIVED like Labor: (Hotel/AB&B base ÷ 5) × crew size, and $0
  // for local jobs (travel ≤ 1 hr). Mirrors the workbook's ROLL UP lodging formula.
  function computeLodgingCostPerDay() {
    const h = Number(state.one_way_travel_hrs);
    if (Number.isNaN(h)) return "";
    const crewKey = state.crew_size;
    if (!crewKey) return "";
    const crewNum = lookupValueNum("crew_size", crewKey);
    if (crewNum == null) return "";
    if (h <= 1) return 0;
    const base = lookupValueNum("lodging", "Hotel");   // Hotel = AB&B = $425 today
    if (base == null) return "";
    return (base / 5) * crewNum;
  }
  function lodgingCostPerDayHtml() {
    const v = state.lodging_cost_per_day;
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

  // ── ROLL UP grid helpers ───────────────────────────────────────────────────
  // The tab mirrors the sheet's "0. ROLL UP" grid: banner blocks in sheet row
  // order, each a 4-column spreadsheet grid (label | value | label | value)
  // matching sheet cols C/D-E (left half) and F/G-H (right half). Each helper
  // emits TWO grid cells — a label cell + a value cell. gap-px over a dark
  // grid background paints the spreadsheet cell borders, so every cell must
  // be opaque.
  const DASH       = '<span class="text-black/30">—</span>';
  const CELL_LABEL = "qm-cell-label";
  const CELL_VALUE = "qm-cell-value";
  // Filler for sheet rows whose left or right half is empty.
  const EMPTY_PAIR = '<div class="qm-cell-label"></div><div class="qm-cell-value" style="background:#fff"></div>';

  // Small "i" info bubble with a native tooltip — explains how a field feeds
  // the calc. Accessible, zero-JS.
  function infoTip(text) {
    if (!text) return "";
    return `<span class="inline-flex items-center justify-center w-3.5 h-3.5 ml-1 rounded-full bg-black/15 text-black/60 text-[9px] font-bold leading-none cursor-help align-middle select-none"
                  title="${escapeHtml(text)}">i</span>`;
  }

  function giLabel(text, tip) {
    return `<div class="${CELL_LABEL}"><span>${escapeHtml(text)}${infoTip(tip)}</span></div>`;
  }

  // Wraps input markup in an opaque value cell so the gap-px grid borders
  // render around it. (The old inline "chips" were replaced by dedicated
  // sheet rows in the "Key Estimating Output Variables" block — the same
  // data-est-calc keys keep them live via setCalcCell.)
  function withChips(inputHtml) {
    return `<div class="${CELL_VALUE}">${inputHtml}</div>`;
  }

  function giText(label, key, opts = {}) {
    const input = `
      <input type="text" class="input text-sm py-1.5"
             data-est-input="${key}"
             value="${escapeHtml(state[key] ?? "")}"
             placeholder="${escapeHtml(opts.placeholder || "")}"/>`;
    return giLabel(label, opts.tip) + withChips(input, opts.chips);
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
    return giLabel(label, opts.tip) + withChips(input, opts.chips);
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
    return giLabel(label, opts.tip) + withChips(input, opts.chips);
  }

  // Compound: Yes/No + tied percent input. Percent is in points (5 = 5%).
  function giYesNoPct(label, keyYesNo, keyPct, opts = {}) {
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
    return giLabel(label, opts.tip) + withChips(input);
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
    return giLabel(label) + withChips(`
      <input type="${hasVal ? "date" : "text"}" class="input text-sm py-1.5"
             data-est-input="${key}" data-est-date
             placeholder="${escapeHtml(placeholder)}"
             value="${escapeHtml(state[key] ?? "")}"/>`);
  }

  // Compound value cell: contact first + last on the same line.
  function giContact(label) {
    return giLabel(label) + withChips(`
      <div class="flex items-center gap-2">
        <input type="text" class="input text-sm py-1.5 flex-1 min-w-0"
               data-est-input="contact_first"
               value="${escapeHtml(state.contact_first)}" placeholder="First Name"/>
        <input type="text" class="input text-sm py-1.5 flex-1 min-w-0"
               data-est-input="contact_last"
               value="${escapeHtml(state.contact_last)}" placeholder="Last Name"/>
      </div>`);
  }

  // Compound value cell: city + state select on the same line. The select
  // leads with a blank "State" option so nothing is pre-selected.
  function giCityState(label) {
    const stateOptions =
      `<option value="" ${!state.project_state ? "selected" : ""}>State</option>` +
      US_STATES.map(s => `<option value="${s}" ${state.project_state === s ? "selected" : ""}>${s}</option>`).join("");
    return giLabel(label) + withChips(`
      <div class="flex items-center gap-2">
        <input type="text" class="input text-sm py-1.5 flex-1 min-w-0"
               data-est-input="project_city"
               value="${escapeHtml(state.project_city)}" placeholder="Enter City Name"/>
        <select class="input text-sm py-1.5 w-20" data-est-input="project_state">
          ${stateOptions}
        </select>
      </div>`);
  }

  // Read-only calculated value cell (Customer, Quote Submittal Date, Labor
  // Cost Per Day, …). Tagged with data-est-calc so it can be refreshed live.
  // `htmlOverride` supplies pre-formatted HTML (money, error labels) instead
  // of the raw state value.
  function giCalc(label, key, htmlOverride, opts = {}) {
    const v = state[key];
    const html = htmlOverride != null ? htmlOverride : (v ? escapeHtml(v) : DASH);
    return giLabel(label, opts.tip) + `
      <div data-est-calc="${key}"
           class="${CELL_VALUE} text-sm tabular-nums text-black/70">
        ${html}
      </div>`;
  }

  // Read-only display cell for values NOT tracked in this tab's state —
  // server-managed columns (Revision Count, Latest Revision Date). No
  // data-est-calc hook, so it never gets live-updated here.
  function giReadOnly(label, html, opts = {}) {
    return giLabel(label, opts.tip) +
      `<div class="${CELL_VALUE} text-sm tabular-nums text-black/70">${html}</div>`;
  }

  // Green computed result cell (the sheet's read-only green). Tagged with
  // data-result="<sheet cell>" and refreshed live by updateResultsCells()
  // whenever the per-set math changes. Inline colors per the prebuilt-CSS
  // constraint (green #d9ead3, explicit #111 text).
  const RESULT_STYLE = "background:#d9ead3;color:#111";
  function giResult(label, cellRef, opts = {}) {
    const extra = opts.extraHtml ? ` ${opts.extraHtml}` : "";
    return giLabel(label, opts.tip) + `
      <div class="${CELL_VALUE} text-sm tabular-nums" style="${RESULT_STYLE}"><span data-result="${cellRef}">${DASH}</span>${extra}</div>`;
  }

  // ── banner block ───────────────────────────────────────────────────────────
  // A sheet banner row (dark full-width header, white uppercase text — the
  // sheet's col-B section banners) + its 4-column label|value grid.
  const GRID4 = "qm-grid4";
  function resetBtn(key) {
    return `<button type="button" data-reset-card="${escapeHtml(key)}"
                    class="text-[10px] font-semibold uppercase tracking-wide text-white/70 hover:text-white px-1.5 py-0.5 rounded hover:bg-white/10 whitespace-nowrap"
                    title="Clear every input in this block">Reset</button>`;
  }
  function block(title, cellsHtml, opts = {}) {
    return `
      <div class="qm-sheet border border-black/25 rounded-sm overflow-hidden" style="background:#fff">
        <div class="qm-banner">
          <span class="text-xs font-extrabold uppercase tracking-wider">${escapeHtml(title)}</span>
          ${opts.bannerExtra || ""}
        </div>
        <div class="${GRID4}">${cellsHtml}</div>
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
  state.lodging_cost_per_day       = computeLodgingCostPerDay();
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
        equipment_requirement:        state.equipment_requirement,
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
        price_adjustment:             state.price_adjustment,
      };
      localStorage.setItem(ESTIMATE_BRIDGE_KEY, JSON.stringify(subset));
    } catch (err) {
      console.warn("Estimate state bridge: localStorage write failed", err);
    }
  }
  publishEstimateState();   // initial publish on mount

  // ── page HTML ──────────────────────────────────────────────────────────────
  // Sheet-parity layout: the ROLL UP tab's banner blocks in sheet row order
  // (GENERAL INFORMATION r8-16, Key Estimating Inputs r17-24, Key Estimating
  // Output Variables r25-30, Estimating Results r31-36, Forcasting Outputs
  // r37-39). Each block is a 4-column grid mirroring sheet cols C/D-E (left
  // half) and F/G-H (right half); labels are VERBATIM from the workbook.
  // Cross-set results (pricing, profit, duration, forecast columns) render
  // LIVE via computeRollupResults / updateResultsCells below.

  // Server-managed columns.
  const revisionCountHtml = (estimateRow && estimateRow.revision_count != null && estimateRow.revision_count !== "")
    ? escapeHtml(String(estimateRow.revision_count))
    : DASH;
  const latestRevisionHtml = (estimateRow && estimateRow.latest_revision_date)
    ? escapeHtml(toUSDate(estimateRow.latest_revision_date) || String(estimateRow.latest_revision_date))
    : DASH;
  const endDateHtml = state.end_date
    ? escapeHtml(toUSDate(state.end_date) || String(state.end_date))
    : DASH;

  // GENERAL INFORMATION — sheet rows 8-16.
  const generalInfoCells = `
    ${giText("Quote #:", "quote_number", { placeholder: "Enter quote number" })}
    ${giText("Quote Description (Short)", "quote_description", { placeholder: "Enter short description" })}
    ${giContact("Contact")}
    ${EMPTY_PAIR}
    ${giCalc("Customer", "customer")}
    ${giText("End User", "end_user", { placeholder: "<Enter text>" })}
    ${giText("Quoted By (First and Last Initials)", "quoted_by", { placeholder: "First and Last Initials" })}
    ${giText("Quote Notes", "quote_notes", { placeholder: "<Enter text>" })}
    ${giDate("Date of Request - ORIGINAL", "date_of_request")}
    ${EMPTY_PAIR}
    ${giDate("Start Date", "start_date")}
    ${EMPTY_PAIR}
    ${giCalc("Quote Submittal Date", "quote_submittal_date")}
    ${EMPTY_PAIR}
    ${giCityState("Project Location")}
    ${giReadOnly("Revision Count", revisionCountHtml, { tip: "Server-managed revision-history counter." })}
    ${giCalc("End Date (7-Days a week)", "end_date", endDateHtml)}
    ${giReadOnly("Latest Revision Date", latestRevisionHtml, { tip: "Server-managed — the date of the most recent saved revision." })}
  `;

  // Key Estimating Inputs — sheet rows 18-24.
  const keyInputsCells = `
    ${giNumber("One-Way Travel time from Houston or Dallas, TX to Job Site (Hrs.)", "one_way_travel_hrs", {
      step: "0.5", suffix: "(hrs)", placeholder: "Enter hours",
      tip: "One-way drive time. >1 hr flips the job to out-of-town (higher labor rate, lodging applies, Downtime target $3,500 vs $3,000) and sets the travel-day count. Local (≤1 hr) = no lodging/mgmt travel.",
    })}
    ${giSelect("Estimate Type", "estimate_type", ESTIMATE_TYPES, { placeholder: "Select Type", tip: "Standard vs Aggressive daily production. Aggressive assumes higher output → fewer labor days → lower price. Each metric set can override this." })}
    ${giSelect("Equipment Requirement (Electric vs. LP)", "equipment_requirement", EQUIPMENT_REQS, { placeholder: "Select Equipment", tip: "Electric vs LP (Liquid Propane). Electric forces Liquid Propane rental to $0 in the metrics; LP drives the propane charge by rental period." })}
    ${giSelect("Breaking Out Mobilization?", "breaking_out_mobilization", YES_NO, { placeholder: "Select", tip: 'Yes = mobilization/travel priced as its own line the customer sees. No = travel folded into the labor bundles (blended OH&P). Changes how S4/S16/S9 are built.' })}
    ${giSelect("Rack Height (Tall Equipment vs Short Equipment)", "rack_height", RACK_HEIGHTS, { placeholder: "Select Rack Height", tip: "Taller than 25' selects the taller-lift rental rates in the metrics." })}
    ${giSelect("Rent Wire Guidance Equipment?", "rent_wire_guidance_equipment", YES_NO, { placeholder: "Select" })}
    ${giYesNoPct("Project Time Budget Adder? - Yes/No & Percent", "project_time_budget_adder", "project_time_budget_pct", { tip: "Yes + % adds a schedule buffer = %×labor days. It creates the Buffer bundle line (marked up at the rack profit target), NOT extra on-site labor." })}
    ${giCrew("Crew Count - Size")}
    ${giNumber("Rack Install Profit % (TARGET)", "rack_install_profit_target", { step: "0.1", suffix: "%", placeholder: "%", tip: "Target profit MARGIN on rack install labor. OH&P = cost/(1−margin) − cost. Typically 42%." })}
    ${giNumber("Wire Guidance Profit % (TARGET)", "wire_guidance_profit_target", { step: "0.1", suffix: "%", placeholder: "%", tip: "Target margin on wire-guidance labor. Typically 42%." })}
    ${giNumber("Rental Equipment RACK Profit % (TARGET)", "rental_rack_profit_target", { step: "0.1", suffix: "%", placeholder: "%", tip: "Target margin on rack rental equipment (lifts, propane, dumpster). Typically 25–30%." })}
    ${giNumber("Rental Equipment WIRE Profit % (TARGET)", "rental_wire_profit_target", { step: "0.1", suffix: "%", placeholder: "%", tip: "Target margin on wire-guidance rental equipment (floor scrubber)." })}
    ${giNumber("Mobilization Profit % (TARGET)", "mobilization_profit_target", { step: "0.1", suffix: "%", placeholder: "%", tip: "Margin on the Mobilization bundle. Can be a small NEGATIVE value in the workbook (competitive travel pricing). Feeds S35/S9." })}
    ${giCalc("Downtime Day Price (TARGET)", "downtime_day_price_target", downtimePriceHtml())}
  `;

  // Key Estimating Output Variables — sheet rows 26-30. Left half = derived
  // values computed on this tab (live via data-est-calc) + the editable Mgmt
  // Travel Multiplier; right half = LIVE computed cells fed by the Option
  // Selector's per-set forecast totals (sheet: G26/G27 =L11, G28 =Q9,
  // G29 =sum(O9:P9), G30 =T9) via updateResultsCells().
  const outputVarsCells = `
    ${giCalc("Labor Cost Per Day (Local or Out of Town)", "labor_cost_per_day", laborCostPerDayHtml())}
    ${giResult("Expected / Estimated Mobilization Count (RACK)", "G26", { tip: "Sheet G26 = L11 — the Base row's Mobilizations Per Option in the Option Selector below." })}
    ${giCalc("Labor Cost Per TRAVEL Day", "labor_cost_per_travel_day", laborCostPerDayHtml())}
    ${giResult("Expected / Estimated Mobilization Count (WIRE GUIDE)", "G27", { tip: "Sheet G27 = L11 — the Base row's Mobilizations Per Option in the Option Selector below." })}
    ${giCalc("Lodging Cost Per Day (<6 Days Hotel, >6 AB&B)", "lodging_cost_per_day", lodgingCostPerDayHtml())}
    ${giResult("Project Travel Days - Cost", "G28", { tip: "Sheet G28 = Q9 — total Projected Travel Days across enabled Base/Option rows." })}
    ${giNumber("Mgmt Travel Multiplier", "mgmt_travel_multiplier", { step: "0.00001", suffix: "%", placeholder: "Enter %", tip: "Management travel/oversight as a % of (labor + materials + lodging + travel). Auto-zero for local jobs (labor $1,400/day). Feeds the Mgmt Travel bundle line." })}
    ${giResult("Project Labor Days - Cost", "G29", { tip: "Sheet G29 = sum(O9:P9) — total Projected Labor Days (rack + wire) across enabled Base/Option rows." })}
    ${giCalc("Travel Days Per Crew, Per Mobilization", "travel_days_per_crew_per_mob", travelDaysPerCrewPerMobHtml())}
    ${giResult("Project Downtime Days - Cost", "G30", { tip: "Sheet G30 = T9 — total Projected Downtime Days across enabled Base/Option rows." })}
  `;

  // Estimating Results - Pricing & Schedule — sheet rows 32-36, LIVE. The
  // values come from computeRollupResults() (sheet formulas verbatim over the
  // same per-set bundle math S5 renders) and refresh with every input /
  // selector change via updateResultsCells(). Sheet fallback texts verbatim.
  const unitHint = (u) => `<span class="text-xs" style="color:rgba(0,0,0,.45)">${u}</span>`;
  const resultsCells = `
    ${giResult("Price to Customer", "D32", { tip: "Sheet D32 = sum of the 7 bundle totals (B45,B52,B57,B66,B72,B78,B84) across enabled sets." })}
    ${giResult("Projected Project Duration", "G32", { extraHtml: unitHint("Days"), tip: "Sheet G32 = U9 — the Option Selector's Duration Calculator total." })}
    ${giResult("Projected Profit", "D33", { tip: "Sheet D33 = sum of the bundles' OH&P rows (B51,B56,B65,B71,B77,B83,B89)." })}
    ${giResult("", "G33", { extraHtml: unitHint("Weeks"), tip: "Sheet G33 = ceiling(G32/7, 0.5)." })}
    ${giResult("Projected Cost", "D34", { tip: "Sheet D34 = D32 − D33 − D35." })}
    ${giResult("Downtime Day Price", "G34", { tip: 'Sheet G34 = if(B86=0,"NO DOWNTIME INCLUDED",B86/T9) — Downtime contract labor ÷ total downtime days.' })}
    ${giResult("Projected Buffer", "D35", { tip: "Sheet D35 = sum of the Buffer rows (B49,B62)." })}
    ${giResult("Wire Guidance Price / LF (RESULT)", "G35", { tip: 'Sheet G35 = iferror(B57/N9,"NO WIRE GUIDANCE QUOTED") — WG bundle total ÷ total projected WG LF.' })}
    ${giResult("Projected Profit Margin", "D36", { tip: "Sheet D36 = D33 / sum(D33,D34)." })}
    ${giResult("Wire Guidance Margin", "G36", { tip: 'Sheet G36 = iferror(B65/(B57−B62−B63−B64),"N/A").' })}
  `;

  // Price Adjustment is not a ROLL UP grid row in the sheet (estimators type
  // over the price cell there); the existing input is preserved as its own
  // slim row so its save path keeps working until the override-any-cell phase
  // absorbs it. (The sheet's D32 formula does NOT include it, so the live
  // Price to Customer above follows the sheet and leaves it out.)
  const priceAdjHtml = `
    <div class="border border-black/25 rounded-sm overflow-hidden">
      <div class="${GRID4}">
        ${giNumber("Price Adjustment (+/−)", "price_adjustment", { step: "1", suffix: "$", placeholder: "0", tip: "Manual nudge to the final Price to Customer, the same override estimators make in the workbook (typed over the price cell). Positive rounds UP (e.g. +2,404 to a clean number); negative DISCOUNTS to win the job (e.g. −950). Not part of the sheet's D32 formula — the override-any-cell phase will absorb it. Leave blank for none." })}
        ${EMPTY_PAIR}
      </div>
    </div>`;

  // Forcasting Outputs for Pipeline Sheet — sheet rows 37-39 (sheet's
  // "Forcasting" typo kept verbatim). One readout line mirroring this tab's
  // fields; the computed columns (Labor/Travel Days, OH&P $/%, Total Price)
  // are LIVE — sheet H39 =sum(O9:P9), I39 =Q9, L39 =D33, M39 =L39/D32,
  // N39 =D32 — refreshed by updateResultsCells().
  function forecastValues() {
    const contact = `${state.contact_first || ""} ${state.contact_last || ""}`.trim();
    const loc = `${state.project_city || ""} ${state.project_state || ""}`.trim();
    const descBase = state.end_user || state.customer || "";
    const desc = [descBase, loc, state.quote_description].filter(Boolean).join("-");
    return {
      fc_quote_number: state.quote_number,
      fc_quoted_by:    state.quoted_by,
      fc_contact:      contact,
      fc_customer:     state.customer,
      fc_description:  desc,
      fc_start_date:   toUSDate(state.start_date),
      fc_end_date:     toUSDate(state.end_date),
    };
  }
  function refreshForecastLine() {
    const vals = forecastValues();
    for (const [key, v] of Object.entries(vals)) {
      setCalcCell(key, v ? escapeHtml(String(v)) : DASH);
    }
  }
  const FC_HEADERS = ["Quote #", "Quoted By", "Contact", "Customer", "Quote Description",
                      "Labor Days", "Travel Days", "Start Date", "End Date",
                      "OH&P $'s", "OH&P %", "Total Price"];
  const fv = forecastValues();
  const fcVal  = (key) => `<div class="bg-white px-2 py-1 text-xs text-black/70 tabular-nums whitespace-nowrap" data-est-calc="${key}">${fv[key] ? escapeHtml(String(fv[key])) : DASH}</div>`;
  const fcResult = (cellRef) => `<div style="${RESULT_STYLE}" class="px-2 py-1 text-xs tabular-nums whitespace-nowrap" data-result="${cellRef}">${DASH}</div>`;
  const forecastHtml = `
    <div class="border border-black/25 rounded-sm overflow-hidden">
      <div class="qm-banner">
        <span class="text-xs font-extrabold uppercase tracking-wider">Forcasting Outputs for Pipeline Sheet</span>
      </div>
      <div class="overflow-x-auto">
        <div style="display:grid;grid-template-columns:repeat(13,minmax(88px,1fr));gap:1px;background:#b7b7b7;min-width:1200px">
          <div class="${CELL_LABEL}">ROLL UP FORECAST LINE</div>
          ${FC_HEADERS.map(h => `<div class="${CELL_LABEL}">${escapeHtml(h)}</div>`).join("")}
          <div class="bg-white"></div>
          ${fcVal("fc_quote_number")}
          ${fcVal("fc_quoted_by")}
          ${fcVal("fc_contact")}
          ${fcVal("fc_customer")}
          ${fcVal("fc_description")}
          ${fcResult("H39")}
          ${fcResult("I39")}
          ${fcVal("fc_start_date")}
          ${fcVal("fc_end_date")}
          ${fcResult("L39")}
          ${fcResult("M39")}
          ${fcResult("N39")}
        </div>
      </div>
    </div>`;

  // ── S3 OPTION SELECTOR FOR FORECASTING / MOBILIZATION QTYS (sheet J7:Z26) ──
  // Rows = the estimate's REAL metric sets (Base + existing options + Project
  // Rentals). The sheet's remaining option slots render as dimmed empty rows
  // for visual parity only. Selector / Mobilizations / WG LF live-save via
  // PATCH /quoting/metric-sets/{id}; forecast columns O-W are computed live
  // with the shared per-set rollup math (utils/qm-rollup.js).
  const ceilHalfNum = (x) => Math.ceil((Number(x) || 0) * 2) / 2;

  const linesBySetId = (() => {
    const m = new Map();
    // Per-line typed-over cells (l{lineId}:*) transform the line data itself,
    // so every rollup/bundle consumer on this tab sees them.
    for (const l of applyLineOverrides(metricLines, cellOverrides)) {
      if (!m.has(l.metric_set_id)) m.set(l.metric_set_id, []);
      m.get(l.metric_set_id).push(l);
    }
    return m;
  })();

  function orderedMetricSets() {
    const base = metricSets.filter(s => s.kind === "base");
    const opts = metricSets.filter(s => s.kind === "option")
                           .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const pr   = metricSets.filter(s => s.kind === "project_rentals");
    return [...base, ...opts, ...pr];
  }
  function setScopeLabel(set) {
    if (set.kind === "base") return "Base";
    if (set.kind === "project_rentals") return "PROJECT RENTALS";
    return set.label || `Option ${set.sort_order}`;
  }
  // Tab (For Reference) — the sheet's tab-name column, matching our tab strip.
  function setTabName(set) {
    if (set.kind === "base") return "1.0 BASE Quoting Metrics";
    if (set.kind === "project_rentals") return "1.10 PROJECT RENTALS";
    return `1.${set.sort_order} ${set.label || `Option ${set.sort_order}`} - Quoting Metrics`;
  }
  const hasProjectRentalsSet = () => metricSets.some(s => s.kind === "project_rentals");

  // Per-set forecast values — the sheet's O-W columns (rows 11-21). Disabled
  // sets contribute 0, exactly like the sheet's =if($J..=TRUE, …, 0) gating;
  // the W column (WG Footage) is NOT gated (sheet W = plain INDIRECT).
  //   O = tab D23 (rack Tab Labor Days)     P = tab D24 (wire Tab Labor Days)
  //   Q = tab D22 (travel days)             R = O+P+Q
  //   S = tab G22 (crew count)              T = ceiling(tab K22, 0.5) (downtime)
  //   U = IFERROR((O+T)/S+P, 0)             V = tab G185 (rack production days)
  function setForecast(set) {
    const rollup = computeSetRollup({
      set, lines: linesBySetId.get(set.id) || [], lookups, estimateState: state,
      overrides: cellOverrides, keyPrefix: `s${set.id}:`,
    });
    const en = Number(set.is_enabled) === 1;
    const O = en ? (Number(rollup.D23) || 0) : 0;
    const P = en ? (Number(rollup.D24) || 0) : 0;
    const Q = en ? (Number(rollup.D22) || 0) : 0;
    const R = O + P + Q;
    const S = en ? (Number(state.crew_count) || 0) : 0;
    const T = en ? ceilHalfNum(set.downtime_labor_day_override) : 0;
    const U = S > 0 ? (O + T) / S + P : 0;
    const V = en ? (Number(rollup.rack_days) || 0) : 0;
    const W = Number(set.wire_guidance_linear_footage) || 0;
    return { O, P, Q, R, S, T, U, V, W };
  }
  const fmtFc = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "0";
    return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  };

  // Inline cell styles (hard rule: qm-* classes or inline style only — the
  // prebuilt output.css silently ignores new Tailwind utilities).
  const S3_TH  = "color:#111;background:#efefef;border:1px solid #b7b7b7;padding:3px 6px;font-size:10px;font-weight:700;text-align:center;min-width:84px;line-height:1.2";
  const S3_TD  = "color:#111;border:1px solid #b7b7b7;padding:3px 6px;font-size:12px;background:#fff;white-space:nowrap";
  const S3_GRN = "color:#111;border:1px solid #b7b7b7;padding:3px 6px;font-size:12px;background:#d9ead3;text-align:right;white-space:nowrap";
  const S3_BLU = "color:#111;border:1px solid #b7b7b7;padding:0;background:#cfe2f3";
  const S3_INP = "color:#111;background:transparent;border:0;width:100%;min-width:70px;padding:3px 6px;font-size:12px;text-align:right";

  const S3_FC_COLS  = ["O", "P", "Q", "R", "S", "T", "U", "V", "W"];
  const S3_HEADERS  = ["Selector", "Scope", "Mobilizations Per Option", "Tab (For Reference)",
                       "Total Projected Wire Guidance LF",
                       "Projected Labor Days", "Projected Labor Days Wire",
                       "Projected Travel Days PER CREW", "Projected Project Days", "Crew Count",
                       "Projected Downtime Days TOTAL", "Duration Calculator",
                       "Rack Labor Days Per Metrics", "Total Projected Wire Guidance LF"];
  const S3_SUBHEADS = ["", "", "", "", "Wire Guidance Footage",
                       "Labor Days Rack", "Labor Days Wire Guidance", "Travel Days",
                       "Project Days", "Crew Count Per Tab", "Downtime Days", "Duration Days",
                       "Rack Labor Days Per Metrics", "Wire Guidance Footage"];

  function s3RealRowHtml(set) {
    const dis     = isLocked ? "disabled" : "";
    const checked = Number(set.is_enabled) === 1 ? "checked" : "";
    const numVal  = (v) => (v == null ? "" : String(v));
    const fcCells = S3_FC_COLS.map(c =>
      `<td data-s3-cell="${set.id}:${c}" style="${S3_GRN}"></td>`).join("");
    return `
      <tr data-s3-row="${set.id}">
        <td style="${S3_TD};text-align:center">
          <input type="checkbox" data-ms-toggle="${set.id}" ${checked} ${dis}
                 style="width:14px;height:14px;accent-color:#1a73e8"/>
        </td>
        <td style="${S3_TD};font-weight:600">${escapeHtml(setScopeLabel(set))}${set.kind !== "base" && !isLocked
          ? `<button type="button" data-delete-set="${set.id}" data-delete-label="${escapeHtml(setTabName(set))}"
                     title="Delete ${escapeHtml(setTabName(set))} — removes the tab and all of its rows"
                     style="margin-left:6px;color:#b91c1c;background:none;border:0;cursor:pointer;font-size:12px;font-weight:700;padding:0 2px">✕</button>`
          : ""}</td>
        <td style="${S3_BLU}">
          <input type="number" step="1" min="0" data-ms-num="${set.id}:mobilizations" ${dis}
                 value="${escapeHtml(numVal(set.mobilizations))}" style="${S3_INP}"/>
        </td>
        <td style="${S3_TD};color:rgba(0,0,0,.6)">${escapeHtml(setTabName(set))}</td>
        <td style="${S3_BLU}">
          <input type="number" step="1" min="0" data-ms-num="${set.id}:wire_guidance_linear_footage" ${dis}
                 value="${escapeHtml(numVal(set.wire_guidance_linear_footage))}" style="${S3_INP}"/>
        </td>
        ${fcCells}
      </tr>`;
  }
  // Sheet option slot with no matching set — visual parity only, no wiring.
  function s3GhostRowHtml(scope, tabName) {
    const blank = `<td style="${S3_TD}"></td>`;
    return `
      <tr style="opacity:.4">
        <td style="${S3_TD};text-align:center">
          <input type="checkbox" disabled style="width:14px;height:14px"/>
        </td>
        <td style="${S3_TD};font-weight:600">${escapeHtml(scope)}</td>
        ${blank}
        <td style="${S3_TD};color:rgba(0,0,0,.6)">${escapeHtml(tabName)}</td>
        ${blank}${blank.repeat(9)}
      </tr>`;
  }

  function s3SectionHtml() {
    const sets     = orderedMetricSets();
    const baseRows = sets.filter(s => s.kind === "base").map(s3RealRowHtml).join("");
    const optRows  = sets.filter(s => s.kind === "option").map(s3RealRowHtml).join("");
    const maxOpt   = Math.max(0, ...metricSets.filter(s => s.kind === "option")
                                              .map(s => Number(s.sort_order) || 0));
    let ghostRows = "";
    for (let n = maxOpt + 1; n <= 9; n++) {
      ghostRows += s3GhostRowHtml(`Option ${n}`, `1.${n} Option ${n} - Quoting Metrics`);
    }
    const prSet = sets.find(s => s.kind === "project_rentals");
    const prRow = prSet ? s3RealRowHtml(prSet)
                        : s3GhostRowHtml("PROJECT RENTALS", "1.10 PROJECT RENTALS");
    // Sheet row 9 — TOTAL row above the sub-header row. J9-M9 are blank; the
    // Crew Count total is the sheet's literal "N/A".
    const totalCell = (c) => (c === "S"
      ? `<td style="${S3_GRN};text-align:center">N/A</td>`
      : `<td data-s3-total="${c}" style="${S3_GRN};font-weight:700"></td>`);
    const totalsRow = `
      <tr>
        <td style="${S3_TD}"></td><td style="${S3_TD};font-weight:700">TOTAL</td>
        <td style="${S3_TD}"></td><td style="${S3_TD}"></td>
        <td data-s3-total="N" style="${S3_GRN};font-weight:700"></td>
        ${S3_FC_COLS.map(totalCell).join("")}
      </tr>`;
    const subheadRow = `
      <tr>${S3_SUBHEADS.map(h => `<th style="${S3_TH};background:#f8f8f8;font-weight:600">${escapeHtml(h)}</th>`).join("")}</tr>`;
    return `
      <div class="qm-sheet border border-black/25 rounded-sm overflow-hidden" style="background:#fff">
        <div class="qm-banner">
          <span class="text-xs font-extrabold uppercase tracking-wider">OPTION SELECTOR FOR FORECASTING / MOBILIZATION QTYS</span>
          ${isLocked ? '<span class="text-[10px] italic font-normal normal-case text-white/60 whitespace-nowrap">locked revision — read-only</span>' : ""}
        </div>
        <div style="overflow-x:auto">
          <table class="qm-sheet" style="border-collapse:collapse;width:100%;min-width:1560px">
            <thead>
              <tr>${S3_HEADERS.map(h => `<th style="${S3_TH}">${escapeHtml(h)}</th>`).join("")}</tr>
              ${totalsRow}
              ${subheadRow}
            </thead>
            <tbody>
              ${baseRows}${optRows}${ghostRows}${prRow}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  // Refresh every computed S3 cell + the TOTAL row. Sheet sum ranges kept
  // verbatim: rows 11:20 (Base + Options, NOT Project Rentals) — except V9,
  // which sums through row 21 (includes PR) — and R9 = sum(R11:R20) + T9.
  function updateS3Computed() {
    const totals = { N: 0, O: 0, P: 0, Q: 0, R: 0, T: 0, U: 0, V: 0, W: 0 };
    for (const set of orderedMetricSets()) {
      const fc = setForecast(set);
      for (const c of S3_FC_COLS) {
        const cell = container.querySelector(`[data-s3-cell="${set.id}:${c}"]`);
        if (cell) cell.textContent = fmtFc(fc[c]);
      }
      if (set.kind !== "project_rentals") {
        totals.N += Number(set.wire_guidance_linear_footage) || 0;
        totals.O += fc.O; totals.P += fc.P; totals.Q += fc.Q;
        totals.T += fc.T; totals.U += fc.U; totals.W += fc.W;
      }
      totals.V += fc.V;
    }
    totals.R = totals.O + totals.P + totals.Q + totals.T;
    for (const [c, v] of Object.entries(totals)) {
      const cell = container.querySelector(`[data-s3-total="${c}"]`);
      if (cell) cell.textContent = fmtFc(v);
    }
  }

  // ── S4 Partial Crew Warning + "Use Project Rentals?" flag (sheet J29:M36) ──
  // Warning mirrors J30: =if(H21="Full","","SHOULD ONLY USE MANUAL DAY COUNTS")
  // — reuses this tab's crew_size state. "Use Project Rentals?" is the sheet's
  // K31 Yes/No dropdown: Yes creates the 1.10 PROJECT RENTALS set (or re-enables
  // it), No unchecks its Selector — data is never deleted from here.
  function s4SectionHtml() {
    const partial = state.crew_size !== "Full";
    const prSet   = metricSets.find(s => s.kind === "project_rentals") || null;
    const usePR   = !!(prSet && Number(prSet.is_enabled) === 1);
    const warnCell = partial
      ? `<div style="grid-column:span 3;background:#ffe599;color:#7f6000;padding:3px 8px;font-size:11.5px;font-weight:700;display:flex;align-items:center">SHOULD ONLY USE MANUAL DAY COUNTS</div>`
      : `<div style="grid-column:span 3;background:#fff"></div>`;
    const prWarnings = usePR ? [
      "MAKE SURE TO CHECK ALL BOXES ABOVE - J11-J21",
      "THIS ONLY WORKS FOR FORKLIFTS & SCISSOR LIFTS",
      "THIS FEATURE IS BEST USED FOR SINGLE MOBILIZATION PROJECTS WHERE CUSTOMER IS ASKING FOR PRICE BREAKOUTS",
      "TOGGLE THIS ON AND OFF TO CHECK FOR POTENTIAL ERRORS",
    ].map(t => `<div style="grid-column:span 4;background:#fff;color:#b45309;padding:2px 8px;font-size:10.5px;font-weight:600">${escapeHtml(t)}</div>`).join("") : "";
    return `
      <div class="qm-sheet border border-black/25 rounded-sm overflow-hidden" style="background:#fff">
        <div class="${GRID4}">
          <div class="${CELL_LABEL}"><span>Partial Crew Warning</span></div>
          ${warnCell}
          <div class="${CELL_LABEL}"><span>Use Project Rentals?${infoTip("Sheet K31. Yes creates the 1.10 PROJECT RENTALS tab (or re-enables it in the Option Selector); No unchecks its Selector so it's excluded from totals — its data is kept.")}</span></div>
          <div style="background:#cfe2f3;padding:0">
            <select data-use-pr ${isLocked ? "disabled" : ""}
                    style="color:#111;background:#cfe2f3;border:0;width:100%;padding:3px 8px;font-size:12px;font-weight:600">
              <option value="No"  ${usePR ? "" : "selected"}>No</option>
              <option value="Yes" ${usePR ? "selected" : ""}>Yes</option>
            </select>
          </div>
          <div class="${CELL_LABEL}"></div>
          <div style="background:#fff"></div>
          ${prWarnings}
        </div>
      </div>`;
  }

  // ── S5 Quick Books Outputs (Bundles) — FORECASTED TOTALS (sheet B41:N103) ──
  // Rows = the sheet's FULL COSTING TABLE bundle lines verbatim, incl. the
  // indented "(hidden)" children; columns = one per EXISTING set; first col =
  // the sheet's col-B total (sums ENABLED sets only, like B's gated P:Z sum).
  // Per-set cells show the set's computed value regardless of the selector
  // (like the sheet's ungated INDIRECT columns D-N). Values come straight
  // from computeSetBundles — the same validated math the PDF/QBO tabs use.
  // (The sheet's blank spare rows 90-103 are omitted — no labels, no values.)
  const S5_ROWS = [
    { label: "Installation (Labor Bundle)",      b: "installation",   i: null },
    { label: "     Contract Labor (hidden)",     b: "installation",   i: 0 },
    { label: "     Materials (hidden)",          b: "installation",   i: 1 },
    { label: "     Mgmt Travel (hidden)",        b: "installation",   i: 2 },
    { label: "     Buffer",                      b: "installation",   i: 3 },
    { label: "     Lodging (hidden)",            b: "installation",   i: 4 },
    { label: "     OH&P (hidden)",               b: "installation",   i: 5 },
    { label: "Rentals (Bundle)",                 b: "rentals",        i: null },
    { label: "     Equipment - Lifts",           b: "rentals",        i: 0 },
    { label: "     Dumpsters / Site Rentals",    b: "rentals",        i: 1 },
    { label: "     Propane",                     b: "rentals",        i: 2 },
    { label: "     OH&P (hidden)",               b: "rentals",        i: 3 },
    { label: "Wire Guidance (Labor Bundle)",     b: "wg_labor",       i: null },
    { label: "     Contract Labor (hidden)",     b: "wg_labor",       i: 0 },
    { label: "     Materials (hidden)",          b: "wg_labor",       i: 1 },
    { label: "     Mgmt Travel (hidden)",        b: "wg_labor",       i: 2 },
    { label: "     Lodging (hidden)",            b: "wg_labor",       i: 3 },
    { label: "     Buffer",                      b: "wg_labor",       i: 4 },
    { label: "     Floor Scrubber",              b: "wg_labor",       i: 5 },
    { label: "     Propane",                     b: "wg_labor",       i: 6 },
    { label: "     OH&P (hidden)",               b: "wg_labor",       i: 7 },
    { label: "Wire Guidance (Additional Items)", b: "wg_additional",  i: null },
    { label: "     Slurry Tank - NOT OPTIONAL",  b: "wg_additional",  i: 0 },
    { label: "     Line Drivers - OPTIONAL - Usually by Customer", b: "wg_additional", i: 1 },
    { label: "     Magnets - OPTIONAL",          b: "wg_additional",  i: 2 },
    { label: "     RFID Tags - OPTIONAL",        b: "wg_additional",  i: 3 },
    { label: "     OH&P (hidden)",               b: "wg_additional",  i: 4 },
    { label: "Mobilization",                     b: "mobilization",   i: null },
    { label: "     Materials (hidden)",          b: "mobilization",   i: 0 },
    { label: "     Contract Labor - Travel (hidden)", b: "mobilization", i: 1 },
    { label: "     Mgmt Travel (hidden)",        b: "mobilization",   i: 2 },
    { label: "     Lodging (hidden)",            b: "mobilization",   i: 3 },
    { label: "     OH&P (hidden)",               b: "mobilization",   i: 4 },
    { label: "Remobilization",                   b: "remobilization", i: null },
    { label: "     Materials (hidden)",          b: "remobilization", i: 0 },
    { label: "     Contract Labor (hidden)",     b: "remobilization", i: 1 },
    { label: "     Mgmt Travel (hidden)",        b: "remobilization", i: 2 },
    { label: "     Lodging (hidden)",            b: "remobilization", i: 3 },
    { label: "     OH&P (hidden)",               b: "remobilization", i: 4 },
    { label: "Downtime",                         b: "downtime",       i: null },
    { label: "     Materials (hidden)",          b: "downtime",       i: 0 },
    { label: "     Contract Labor (hidden)",     b: "downtime",       i: 1 },
    { label: "     Mgmt Travel (hidden)",        b: "downtime",       i: 2 },
    { label: "     Lodging (hidden)",            b: "downtime",       i: 3 },
    { label: "     OH&P (hidden)",               b: "downtime",       i: 4 },
  ];

  function s5BodyHtml() {
    const sets = orderedMetricSets();
    const perSet = sets.map(set => ({
      set,
      bundles: computeSetBundles({
        set, lines: linesBySetId.get(set.id) || [], lookups, estimateState: state,
        overrides: cellOverrides, keyPrefix: `s${set.id}:`,
      }),
    }));
    const val = (bundles, row) => {
      const bundle = bundles?.[row.b];
      if (!bundle) return 0;
      return row.i == null
        ? (Number(bundle.total) || 0)
        : (Number(bundle.lines?.[row.i]?.[1]) || 0);
    };
    const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
    const TH  = "color:#111;background:#efefef;border:1px solid #b7b7b7;padding:3px 8px;font-size:10.5px;font-weight:700;text-align:center;white-space:nowrap;min-width:110px";
    const LBL = "border:1px solid #b7b7b7;padding:3px 8px;font-size:11.5px;background:#fff;white-space:pre;text-align:left";
    const GRN = "border:1px solid #b7b7b7;padding:3px 8px;font-size:12px;background:#d9ead3;text-align:right;white-space:nowrap";
    const headTabs = `
      <tr>
        <th style="${TH}">FORECASTED TOTALS</th>
        <th style="${TH}">FULL COSTING TABLE</th>
        ${perSet.map(p => `<th style="${TH}">${escapeHtml(setTabName(p.set))}</th>`).join("")}
      </tr>`;
    const headFlags = `
      <tr>
        <th style="${TH};background:#f8f8f8"></th>
        <th style="${TH};background:#f8f8f8"></th>
        ${perSet.map(p => `<th style="${TH};background:#f8f8f8;font-weight:600">${Number(p.set.is_enabled) === 1 ? 1 : 0}</th>`).join("")}
      </tr>`;
    const headScopes = `
      <tr>
        <th style="${TH};background:#f8f8f8"></th>
        <th style="${TH};background:#f8f8f8"></th>
        ${perSet.map(p => `<th style="${TH};background:#f8f8f8;font-weight:600">${escapeHtml(setScopeLabel(p.set))}</th>`).join("")}
      </tr>`;
    const bodyRows = S5_ROWS.map(row => {
      const isParent = row.i == null;
      const total = perSet.reduce((s, p) =>
        s + (Number(p.set.is_enabled) === 1 ? val(p.bundles, row) : 0), 0);
      const setCells = perSet.map(p =>
        `<td style="${GRN}${isParent ? ";font-weight:700" : ""}">${money(val(p.bundles, row))}</td>`).join("");
      return `
        <tr>
          <td style="${GRN};font-weight:700">${money(total)}</td>
          <td style="${LBL}${isParent ? ";font-weight:700" : ";color:rgba(0,0,0,.65)"}">${escapeHtml(row.label)}</td>
          ${setCells}
        </tr>`;
    }).join("");
    return `
      <table class="qm-sheet" style="border-collapse:collapse;min-width:${360 + perSet.length * 120}px">
        <thead>${headTabs}${headFlags}${headScopes}</thead>
        <tbody>${bodyRows}</tbody>
      </table>`;
  }

  function s5SectionHtml() {
    return `
      <div class="qm-sheet border border-black/25 rounded-sm overflow-hidden" style="background:#fff">
        <div class="qm-banner">
          <span class="text-xs font-extrabold uppercase tracking-wider">Quick Books Outputs (Bundles)</span>
          <span class="text-[10px] italic font-normal normal-case text-white/60 whitespace-nowrap">first column sums ENABLED sets only</span>
        </div>
        <div style="overflow-x:auto">
          <div data-s5-body>${s5BodyHtml()}</div>
        </div>
      </div>`;
  }

  // ── Estimating Results (sheet r32-36) + Output Variables right half +
  //    forecast-line computed cells — LIVE ─────────────────────────────────
  // Sheet formulas verbatim (rollup-tab-spec.txt). The ROLL UP's col-B bundle
  // rows sum the flag-gated =sum(P..:Z..) — i.e. ENABLED sets only — over the
  // SAME per-set computeSetBundles math S5 renders; the forecast totals
  // (O9/P9/Q9/T9/U9/N9) sum rows 11:20 (Base + Options, NOT Project Rentals),
  // exactly like updateS3Computed's TOTAL row.
  // `useROverrides = false` skips the r:* typed-over cells (the per-set
  // s:/l: overrides still apply) — the pure formula values shown in the
  // "Calculated: …" tooltips of overridden result cells.
  function computeRollupResults(useROverrides = true) {
    const rv = (ref, computed) => {
      if (!useROverrides) return computed;
      const k = "r:" + ref;
      return (k in cellOverrides) ? Number(cellOverrides[k]) : computed;
    };
    const sets = orderedMetricSets();
    const perSet = sets.map(set => ({
      set,
      en: Number(set.is_enabled) === 1,
      bundles: computeSetBundles({
        set, lines: linesBySetId.get(set.id) || [], lookups, estimateState: state,
        overrides: cellOverrides, keyPrefix: `s${set.id}:`,
      }),
    }));
    // Sheet col-B rollup row: a bundle total (idx null) or one child line,
    // summed across ENABLED sets.
    const B = (bKey, idx) => perSet.reduce((s, p) => {
      if (!p.en) return s;
      const b = p.bundles?.[bKey];
      if (!b) return s;
      return s + (idx == null ? (Number(b.total) || 0) : (Number(b.lines?.[idx]?.[1]) || 0));
    }, 0);
    let O9 = 0, P9 = 0, Q9 = 0, T9 = 0, U9 = 0, N9 = 0;
    for (const p of perSet) {
      if (p.set.kind === "project_rentals") continue;   // sheet ranges 11:20
      const fc = setForecast(p.set);
      O9 += fc.O; P9 += fc.P; Q9 += fc.Q; T9 += fc.T; U9 += fc.U;
      N9 += Number(p.set.wire_guidance_linear_footage) || 0;
    }
    // B-row map (bundle lines are qm-rollup's fixed order — same as S5_ROWS):
    const B45 = B("installation", null),   B49 = B("installation", 3),  B51 = B("installation", 5);
    const B52 = B("rentals", null),        B56 = B("rentals", 3);
    const B57 = B("wg_labor", null),       B62 = B("wg_labor", 4);
    const B63 = B("wg_labor", 5),          B64 = B("wg_labor", 6),      B65 = B("wg_labor", 7);
    const B66 = B("wg_additional", null),  B71 = B("wg_additional", 4);
    const B72 = B("mobilization", null),   B77 = B("mobilization", 4);
    const B78 = B("remobilization", null), B83 = B("remobilization", 4);
    const B84 = B("downtime", null),       B86 = B("downtime", 1),      B89 = B("downtime", 4);

    // Each result cell runs through rv() — a typed-over cell replaces the
    // formula AND flows into the cells that reference it (e.g. r:D32 →
    // D34/D36/M39/N39), exactly like the sheet.
    const D32 = rv("D32", B45 + B52 + B57 + B66 + B72 + B78 + B84);   // =sum(B45,B52,B57,B66,B72,B78,B84)
    const D33 = rv("D33", B51 + B56 + B65 + B71 + B77 + B83 + B89);   // =sum(B51,B56,B65,B71,B77,B83,B89)
    const D35 = rv("D35", B49 + B62);                                  // =sum(B49,B62)
    const D34 = rv("D34", D32 - D33 - D35);                            // =D32-D33-D35
    const D36 = rv("D36", (D33 + D34) !== 0 ? D33 / (D33 + D34) : NaN);  // =D33/sum(D33,D34)
    const G32 = rv("G32", U9);                                         // =U9
    const G33 = rv("G33", Math.ceil((G32 / 7) * 2) / 2);               // =ceiling(G32/7,0.5)
    const G34 = rv("G34", B86 === 0 ? null : (T9 !== 0 ? B86 / T9 : NaN));  // =if(B86=0,"NO DOWNTIME INCLUDED",B86/T9)
    const G35 = rv("G35", N9 !== 0 ? B57 / N9 : null);                 // =iferror(B57/N9,"NO WIRE GUIDANCE QUOTED")
    const wgDen = B57 - B62 - B63 - B64;
    const G36 = rv("G36", wgDen !== 0 ? B65 / wgDen : null);           // =iferror(B65/(B57-B62-B63-B64),"N/A")
    const baseSet = sets.find(s => s.kind === "base");
    const L11 = Number(baseSet?.mobilizations) || 0;
    return {
      D32, D33, D34, D35, D36, G32, G33, G34, G35, G36,
      // Output Variables right half: G26/G27 =L11, G28 =Q9, G29 =sum(O9:P9), G30 =T9.
      G26: L11, G27: L11, G28: Q9, G29: O9 + P9, G30: T9,
      // Forecast line: H39 =sum(O9:P9), I39 =Q9 (L39/M39/N39 derive from D32/D33).
      H39: O9 + P9, I39: Q9,
    };
  }

  // Push computeRollupResults() into every data-result cell. NaN → "—";
  // null → the sheet's literal fallback text. The ten Estimating Results
  // cells (r:D32..r:D36, r:G32..r:G36) are override-enabled: typed-over
  // values render indigo with a ✎ marker + ↺ revert, the hover title shows
  // the calculated (formula) value, and clicking a cell types over it
  // (locked revisions are read-only).
  function updateResultsCells() {
    const r = computeRollupResults();
    const hasR = R_OVR_REFS.some(ref => ("r:" + ref) in cellOverrides);
    const raw = hasR ? computeRollupResults(false) : r;
    const put = (cellRef, html) => {
      const el = container.querySelector(`[data-result="${cellRef}"]`);
      if (el) el.innerHTML = html;
    };
    const pctHtml = (v) => (v == null || !Number.isFinite(v)) ? DASH : (v * 100).toFixed(1) + "%";
    const moneyFine = (v) => (v == null || !Number.isFinite(v))
      ? DASH
      : "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
    const stripTags = (h) => String(h ?? "").replace(/<[^>]*>/g, "");

    // Override-enabled result cell painter. effHtml/effNum come from the
    // override-aware pass, calcHtml from the raw (formula) pass.
    const putR = (cellRef, effHtml, effNum, calcHtml) => {
      const el = container.querySelector(`[data-result="${cellRef}"]`);
      if (!el) return;
      const box = el.closest("div");
      const key = "r:" + cellRef;
      const fmtOvr = R_OVR_FMT[cellRef] || String;
      if (box) box.setAttribute("data-r-ovr", cellRef);
      if (key in cellOverrides) {
        const rb = isLocked ? "" :
          `<button type="button" data-r-revert="${escapeHtml(key)}" title="Revert to calculated value"
                   style="border:0;background:transparent;cursor:pointer;color:#1e1b4b;font-weight:700;font-size:11px;line-height:1;padding:0 2px">↺</button>`;
        el.innerHTML = `<span style="display:inline-flex;align-items:center;gap:4px">` +
          `<span aria-hidden="true" style="font-size:10px">✎</span><span>${fmtOvr(Number(cellOverrides[key]))}</span>${rb}</span>`;
        if (box) {
          box.style.background = "#c7d2fe";
          box.style.color = "#1e1b4b";
          box.title = `Calculated: ${stripTags(calcHtml)} — typed-over`;
          box.setAttribute("data-r-num", "");
        }
      } else {
        el.innerHTML = effHtml;
        if (box) {
          // Restore the green computed look (RESULT_STYLE is inline).
          box.style.background = "#d9ead3";
          box.style.color = "#111";
          box.title = isLocked ? "" : "Click to type over the calculated value";
          box.setAttribute("data-r-num",
            (effNum == null || !Number.isFinite(Number(effNum))) ? "" : String(Number(effNum)));
        }
      }
    };
    // Formatter used for the typed-over value of each result cell (matches
    // the computed formatting; the % cells hold fractions, e.g. 0.42).
    const R_OVR_FMT = {
      D32: fmtMoney, D33: fmtMoney, D34: fmtMoney, D35: fmtMoney, D36: pctHtml,
      G32: fmtFc, G33: fmtFc, G34: fmtMoney, G35: moneyFine, G36: pctHtml,
    };

    putR("D32", fmtMoney(r.D32), r.D32, fmtMoney(raw.D32));
    putR("D33", fmtMoney(r.D33), r.D33, fmtMoney(raw.D33));
    putR("D34", fmtMoney(r.D34), r.D34, fmtMoney(raw.D34));
    putR("D35", fmtMoney(r.D35), r.D35, fmtMoney(raw.D35));
    putR("D36", pctHtml(r.D36), r.D36, pctHtml(raw.D36));
    putR("G32", fmtFc(r.G32), r.G32, fmtFc(raw.G32));
    putR("G33", fmtFc(r.G33), r.G33, fmtFc(raw.G33));
    putR("G34", r.G34 == null ? '<span class="text-xs">NO DOWNTIME INCLUDED</span>' : fmtMoney(r.G34), r.G34,
         raw.G34 == null ? "NO DOWNTIME INCLUDED" : fmtMoney(raw.G34));
    putR("G35", r.G35 == null ? '<span class="text-xs">NO WIRE GUIDANCE QUOTED</span>' : moneyFine(r.G35), r.G35,
         raw.G35 == null ? "NO WIRE GUIDANCE QUOTED" : moneyFine(raw.G35));
    putR("G36", r.G36 == null ? "N/A" : pctHtml(r.G36), r.G36,
         raw.G36 == null ? "N/A" : pctHtml(raw.G36));
    put("G26", fmtFc(r.G26));
    put("G27", fmtFc(r.G27));
    put("G28", fmtFc(r.G28));
    put("G29", fmtFc(r.G29));
    put("G30", fmtFc(r.G30));
    put("H39", fmtFc(r.H39));
    put("I39", fmtFc(r.I39));
    put("L39", fmtMoney(r.D33));                                   // =D33
    put("M39", r.D32 > 0 ? pctHtml(r.D33 / r.D32) : DASH);         // =L39/D32
    put("N39", fmtMoney(r.D32));                                   // =D32
  }

  // ── Estimating Results override editing (click-to-type-over) ─────────────
  function setResultOverride(key, value) {
    if (isLocked) return;
    if (value == null && !(key in cellOverrides)) { updateResultsCells(); return; }
    ovClient.set(key, value);
    updateResultsCells();
  }
  function beginResultEdit(box) {
    if (isLocked || !box) return;
    const ref = box.getAttribute("data-r-ovr");
    if (!ref) return;
    const key = "r:" + ref;
    const el = box.querySelector("[data-result]") || box;
    if (el.querySelector("input[data-r-input]")) return;   // already editing
    const numAttr = box.getAttribute("data-r-num");
    const cur = (key in cellOverrides)
      ? cellOverrides[key]
      : (numAttr === "" || numAttr == null ? "" : Number(numAttr));
    el.innerHTML = `<input type="number" step="any" data-r-input
        value="${cur === "" || cur == null ? "" : cur}"
        style="width:100%;min-width:90px;border:0;background:#fff;outline:2px solid #4f46e5;outline-offset:-2px;padding:1px 4px;font-size:13px;text-align:right;color:#111;box-sizing:border-box">`;
    const inp = el.querySelector("input[data-r-input]");
    inp.focus();
    inp.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) {
        const rawv = String(inp.value).trim();
        if (rawv === "") setResultOverride(key, null);      // empty commit = revert
        else {
          const n = Number(rawv);
          if (Number.isFinite(n)) setResultOverride(key, n);
          else updateResultsCells();
        }
      } else {
        updateResultsCells();
      }
    };
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      ev.stopPropagation();
    });
    inp.addEventListener("blur", () => finish(true));
  }

  // Re-render the metric-set-driven sections after any input that feeds the
  // per-set math (selector toggles, mobs, WG LF, or estimate-level inputs).
  // S3 keeps its input elements (only computed cells update, so typing focus
  // is never lost); S4/S5 are input-free and re-render wholesale. The
  // Estimating Results / Output Variables / forecast-line computed cells ride
  // the same refresh.
  function refreshMetricSections() {
    updateS3Computed();
    updateResultsCells();
    const s4slot = container.querySelector("[data-s4-slot]");
    if (s4slot) s4slot.innerHTML = s4SectionHtml();
    const s5body = container.querySelector("[data-s5-body]");
    if (s5body) s5body.innerHTML = s5BodyHtml();
  }

  const bodyHtml = `
    <div class="flex flex-col gap-3 pb-3">
      ${block("GENERAL INFORMATION", generalInfoCells, { bannerExtra: resetBtn("general_info") })}
      ${block("Key Estimating Inputs", keyInputsCells, { bannerExtra: resetBtn("key_inputs") })}
      ${block("Key Estimating Output Variables", outputVarsCells)}
      ${block("Estimating Results - Pricing & Schedule", resultsCells)}
      ${priceAdjHtml}
      ${forecastHtml}
      ${s3SectionHtml()}
      <div data-s4-slot>${s4SectionHtml()}</div>
      ${s5SectionHtml()}
    </div>
  `;

  // Render this tab body into the container the workspace shell prepared.
  // (No setShell here — the shell + tab strip + page-title hiding are
  // already in place from renderEstimateWorkspace.)
  container.innerHTML = bodyHtml;

  // Initial fill of the S3 computed forecast cells + TOTAL row, and the
  // Estimating Results / Output Variables / forecast-line computed cells.
  updateS3Computed();
  updateResultsCells();

  // Estimating Results override cells — ↺ revert + click-to-type-over.
  // Delegated on the container so repaints via updateResultsCells keep working.
  container.addEventListener("click", (e) => {
    const rvBtn = e.target.closest("[data-r-revert]");
    if (rvBtn) {
      e.preventDefault();
      e.stopPropagation();
      setResultOverride(rvBtn.getAttribute("data-r-revert"), null);
      return;
    }
    const box = e.target.closest("[data-r-ovr]");
    if (box) beginResultEdit(box);
  });

  // "Use Project Rentals?" (sheet K31) — delegated so it survives S4's
  // wholesale re-renders. Yes creates the 1.10 set (or re-enables it);
  // No unchecks its Selector. Never deletes data.
  container.addEventListener("change", async (e) => {
    const sel = e.target.closest && e.target.closest("[data-use-pr]");
    if (!sel) return;
    const wantYes = sel.value === "Yes";
    const prSet = metricSets.find(s => s.kind === "project_rentals") || null;
    try {
      if (wantYes && !prSet) {
        const created = await api(`/quoting/metric-sets`, {
          method: "POST",
          body:   JSON.stringify({ estimate_id: estimateId, kind: "project_rentals" }),
        });
        metricSets.push(created);
        // New set = new S3 row + new tab in the strip — re-render the page.
        if (typeof routeFn === "function") { routeFn(); return; }
      } else if (prSet) {
        await api(`/quoting/metric-sets/${prSet.id}`, {
          method: "PATCH",
          body:   JSON.stringify({ is_enabled: wantYes }),
        });
        prSet.is_enabled = wantYes ? 1 : 0;
        const cb = container.querySelector(`[data-ms-toggle="${prSet.id}"]`);
        if (cb) cb.checked = wantYes;
      }
    } catch (err) {
      alert(err?.message || "Failed to update Project Rentals");
    }
    refreshMetricSections();
  });

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
      state.lodging_cost_per_day = computeLodgingCostPerDay();
      setCalcCell("lodging_cost_per_day", lodgingCostPerDayHtml());
    }

    // Mirror this tab's fields into the ROLL UP FORECAST LINE readout.
    refreshForecastLine();
    // Bridge any state change relevant to the Quoting Metrics page.
    publishEstimateState();
    // Estimate-level inputs feed the per-set forecast/bundle math — keep the
    // Option Selector, flags row, and QB Outputs matrix live.
    refreshMetricSections();
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
    if (el) { syncFromEl(el); markChangedFields(container); }
  });
  container.addEventListener("change", (e) => {
    const el = e.target.closest("[data-est-input]");
    if (el) { syncFromEl(el); markChangedFields(container); }
  });
  markChangedFields(container);   // initial pass on the freshly-rendered form

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

  // ── S3 Option Selector wiring ──────────────────────────────────────────────
  // Selector checkbox → PATCH {is_enabled}; Mobilizations Per Option → PATCH
  // {mobilizations}; Total Projected WG LF → PATCH {wire_guidance_linear_footage}.
  // All three are accepted by the metric-sets PATCH endpoint. Local state
  // updates optimistically so the computed columns react instantly.
  const _msTimers = new Map();
  container.addEventListener("change", async (e) => {
    const cb = e.target.closest("[data-ms-toggle]");
    if (!cb || isLocked) return;
    const setId = Number(cb.getAttribute("data-ms-toggle"));
    const set = metricSets.find(s => s.id === setId);
    if (set) set.is_enabled = cb.checked ? 1 : 0;
    refreshMetricSections();
    try {
      await api(`/quoting/metric-sets/${setId}`, {
        method: "PATCH",
        body:   JSON.stringify({ is_enabled: cb.checked ? 1 : 0 }),
      });
    } catch (err) {
      console.error("Failed to save selector toggle", err);
    }
  });
  container.addEventListener("input", (e) => {
    const el = e.target.closest("[data-ms-num]");
    if (!el || isLocked) return;
    const [idStr, field] = el.getAttribute("data-ms-num").split(":");
    const setId = Number(idStr);
    const set = metricSets.find(s => s.id === setId);
    const v = el.value === "" ? 0 : Number(el.value);
    if (set) set[field] = v;
    refreshMetricSections();
    const tkey = `${setId}:${field}`;
    if (_msTimers.has(tkey)) clearTimeout(_msTimers.get(tkey));
    _msTimers.set(tkey, setTimeout(async () => {
      _msTimers.delete(tkey);
      try {
        await api(`/quoting/metric-sets/${setId}`, {
          method: "PATCH",
          body:   JSON.stringify({ [field]: v }),
        });
      } catch (err) {
        console.error("Failed to save metric set field", field, err);
      }
    }, 300));
  });

  // (Collapsible card sections removed — the ROLL UP blocks are plain
  //  spreadsheet-style grids like the sheet, no chevrons.)

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
      "mobilization_profit_target", "price_adjustment",
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
