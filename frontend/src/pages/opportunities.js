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
const days = (n) => (n == null ? "—" : `${n}d`);
const pct = (n) => (n == null ? "—" : `${Math.round(n * 100)}%`);

export async function pipelinePage(routeFn) {
  let estimators = [];
  try { estimators = await api(`/estimates/estimators`); } catch (_) { estimators = []; }

  const body = `
    <div class="w-full">
      <div class="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div><h1 class="text-xl font-extrabold text-ink-900">Pipeline</h1>
          <p class="text-xs text-black/50">RFQ intake → quoting → sent → won/lost. Turn-times start the moment an RFQ is logged.</p></div>
        <button id="pNew" class="btn-primary text-sm px-4 py-2">+ New opportunity</button>
      </div>
      <div id="pMetrics" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4"></div>
      <div class="card p-3 sm:p-4">
        <div class="flex items-center gap-2 mb-3 flex-wrap" id="pFilters"></div>
        <div id="pList" class="text-sm text-black/40 py-6">Loading…</div>
      </div>
    </div>`;
  setShell({ title: "", subtitle: "", bodyHtml: body, showLogout: true, routeFn });

  let statusFilter = "";
  const metricsEl = document.getElementById("pMetrics");
  const listEl = document.getElementById("pList");
  const filtersEl = document.getElementById("pFilters");

  const chip = (label, val, sub = "") =>
    `<div class="rounded-xl border border-black/10 bg-black/[0.015] px-3 py-2">
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

  const renderFilters = () => {
    const opts = [["", "All"], ["open", "Open"], ...Object.entries(STATUS_META).map(([k, v]) => [k, v.label])];
    filtersEl.innerHTML = opts.map(([k, label]) =>
      `<button data-sf="${k}" class="rounded-full px-2.5 py-1 text-xs font-semibold border ${statusFilter === k ? "bg-ink-900 text-white border-ink-900" : "border-black/15 text-black/60 hover:bg-black/5"}">${label}</button>`).join("");
    filtersEl.querySelectorAll("[data-sf]").forEach(b => b.addEventListener("click", () => {
      statusFilter = b.getAttribute("data-sf"); renderFilters(); loadList();
    }));
  };

  const statusCell = (o) => {
    const cur = STATUS_META[o.status] || { label: o.status, cls: "bg-black/10" };
    const opts = Object.entries(STATUS_META).map(([k, v]) =>
      `<option value="${k}" ${k === o.status ? "selected" : ""}>${v.label}</option>`).join("");
    return `<select data-status="${o.id}" class="text-[11px] font-semibold rounded-full px-2 py-0.5 border-0 ${cur.cls} cursor-pointer">${opts}</select>`;
  };

  const loadList = async () => {
    let d;
    try { d = await api(`/opportunities${statusFilter ? `?status=${statusFilter}` : ""}`); }
    catch (e) { listEl.innerHTML = `<div class="text-red-700">Failed to load pipeline.</div>`; return; }
    const rows = d.opportunities || [];
    if (!rows.length) { listEl.innerHTML = `<div class="text-black/45 py-4">No opportunities${statusFilter ? " in this stage" : " yet"}. Click “New opportunity” to log an RFQ.</div>`; return; }
    listEl.innerHTML = `
      <div class="overflow-x-auto"><table class="w-full text-sm">
        <thead><tr class="text-left text-black/45 border-b border-black/10">
          <th class="py-2 pr-3 font-bold">Customer</th><th class="py-2 pr-3 font-bold">Contact</th>
          <th class="py-2 pr-3 font-bold">Job</th><th class="py-2 pr-3 font-bold">Stage</th>
          <th class="py-2 pr-3 font-bold">RFQ</th><th class="py-2 pr-3 font-bold">Target start</th>
          <th class="py-2 pr-3 font-bold">Estimator</th><th class="py-2 font-bold text-right"></th></tr></thead>
        <tbody>${rows.map(o => `
          <tr class="border-b border-black/5 hover:bg-black/[0.015]">
            <td class="py-1.5 pr-3 font-semibold text-ink-900">${escapeHtml(dash(o.customer_name))}</td>
            <td class="py-1.5 pr-3 text-black/70">${escapeHtml(dash(o.contact_name))}</td>
            <td class="py-1.5 pr-3 text-black/70">${escapeHtml(dash(o.title))}${o.project_name ? `<div class="text-[10px] text-emerald-700">→ <a href="#/entity/project/${escapeHtml(o.project_qbo_id)}" class="hover:underline font-semibold">${escapeHtml(o.project_name)}</a></div>` : ""}</td>
            <td class="py-1.5 pr-3">${statusCell(o)}</td>
            <td class="py-1.5 pr-3 text-black/60 tabular-nums">${ymd(o.rfq_received_date)}</td>
            <td class="py-1.5 pr-3 text-black/60 tabular-nums">${ymd(o.target_start_date)}</td>
            <td class="py-1.5 pr-3 text-black/60">${escapeHtml(dash(o.estimator_name))}</td>
            <td class="py-1.5 text-right"><button data-del="${o.id}" title="Delete" class="text-xs text-red-600 font-semibold hover:underline">Delete</button></td>
          </tr>`).join("")}
        </tbody></table></div>`;
    listEl.querySelectorAll("[data-status]").forEach(sel => sel.addEventListener("change", async () => {
      const id = sel.getAttribute("data-status");
      if (sel.value === "won") {
        // Won → prompt to link the QBO project (the handoff), or mark won to link later.
        const opp = rows.find(o => String(o.id) === id);
        openLinkProjectModal(opp, () => { loadMetrics(); loadList(); }, () => loadList());
        return;
      }
      try { await api(`/opportunities/${id}`, { method: "PATCH", body: JSON.stringify({ status: sel.value }) }); loadMetrics(); loadList(); }
      catch (err) { alert(err.message); }
    }));
    listEl.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this opportunity?")) return;
      try { await api(`/opportunities/${b.getAttribute("data-del")}`, { method: "DELETE" }); loadMetrics(); loadList(); }
      catch (err) { alert(err.message); }
    }));
  };

  document.getElementById("pNew").addEventListener("click", () =>
    newOpportunityModal({ estimators, onSaved: () => { loadMetrics(); loadList(); } }));

  renderFilters();
  loadMetrics();
  loadList();
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
            <button data-newcontact class="rounded-lg border border-black/15 px-2.5 py-1 text-xs font-semibold hover:bg-black/5 whitespace-nowrap" disabled>+ New</button>
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
            <select data-f="estimator_user_id" class="input text-sm py-1.5 w-full"><option value="">—</option>${estimators.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join("")}</select></label>
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
