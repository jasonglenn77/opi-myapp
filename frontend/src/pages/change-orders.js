// Change Orders — supplemental / additional project estimates. Lists the project's
// QBO estimates (original cost-basis + change orders) plus quick app-side drafts,
// classifies/annotates them, and rolls up the revised contract value. Ties to the
// Payments tab (same QBO estimates drive the crew payment schedules).
import { api, getToken } from "../api.js";
import { escapeHtml } from "../utils/html.js";

const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const ymd = (s) => (s ? String(s).slice(0, 10) : "—");
const REASONS = ["Scope change", "Added items", "Removed items", "Material / spec change",
  "Pricing correction", "Customer request", "Timeline change", "Other"];
// OPI standard estimate line items (QBO-style dropdown for the estimate form).
const CO_ITEMS = ["Contract Labor", "Materials", "Lifts", "Lodging", "Mgmt Travel", "Propane",
  "Dumpsters", "Floor Scrubber", "Floor Saw", "Slurry Pan", "GC Licensing", "Permit Running",
  "Shipping/Freight", "Buffer", "OH&P"];
const STATUSES = [["draft", "Draft"], ["sent", "Sent"], ["approved", "Approved"], ["rejected", "Rejected"]];
const STATUS_CLS = { draft: "bg-slate-100 text-slate-700", sent: "bg-blue-100 text-blue-800",
  approved: "bg-emerald-100 text-emerald-800", rejected: "bg-rose-100 text-rose-700" };
const CANCEL = "rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200";

export async function mountChangeOrdersPanel(container, entityId) {
  let data, opp = null;
  const load = async () => {
    data = await api(`/change-orders/project/${encodeURIComponent(entityId)}`);
    // the pre-award opportunity this project came from (may be none for old projects)
    try { opp = (await api(`/opportunities/by-project/${encodeURIComponent(entityId)}`)).opportunity; } catch (_) { opp = null; }
  };
  try { await load(); }
  catch (e) { container.innerHTML = `<div class="p-5 text-sm text-red-700">Failed to load change orders: ${escapeHtml(e?.message || String(e))}</div>`; return; }

  const chip = (label, val, cls = "text-ink-900", sub = "") =>
    `<div class="rounded-xl border border-black/10 bg-black/[0.015] px-3 py-2"><div class="text-[10px] font-bold uppercase tracking-wide text-black/35">${label}</div><div class="text-sm font-extrabold ${cls}">${money(val)}</div>${sub ? `<div class="text-[10px] text-black/40">${sub}</div>` : ""}</div>`;

  function rollupHtml(r) {
    return `<div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
      ${chip("Original contract", r.original_amount)}
      ${chip("Approved change orders", r.approved_co_amount, "text-emerald-700", `${r.approved_change_order_count} of ${r.change_order_count} CO${r.change_order_count === 1 ? "" : "s"}`)}
      ${chip("Revised contract", r.revised_contract, "text-ink-900")}
      ${chip("Contract labor (approved)", r.contract_labor_total, "text-black/70", "crew cost")}
    </div>${r.pending_co_amount > 0 ? `<div class="text-[11px] text-amber-700 -mt-2 mb-3">+ ${money(r.pending_co_amount)} in pending change orders (not yet approved)</div>` : ""}`;
  }

  const kindBadge = (i) => i.kind === "original"
    ? `<span class="inline-flex rounded-full bg-indigo-100 text-indigo-800 px-2 py-0.5 text-[10px] font-bold">ORIGINAL</span>`
    : `<span class="inline-flex rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-[10px] font-bold">CO #${i.co_number}</span>`;
  const statusPill = (s) => `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_CLS[s] || "bg-black/10"}">${(STATUSES.find(x => x[0] === s) || [s, s])[1]}</span>`;

  function linesHtml(lines) {
    if (!lines || !lines.length) return `<div class="text-[11px] text-black/40 py-1">No line items on this estimate.</div>`;
    return `<table class="w-full text-[11px]">
      <thead><tr class="text-left text-black/40"><th class="py-1 pr-3 font-bold">Item</th><th class="py-1 pr-3 font-bold">Description</th><th class="py-1 pr-3 font-bold text-right">Qty</th><th class="py-1 pr-3 font-bold text-right">Rate</th><th class="py-1 pr-3 font-bold text-right">Amount</th><th class="py-1 font-bold text-right">Cost</th></tr></thead>
      <tbody>${lines.map(l => `<tr class="border-t border-black/5">
        <td class="py-1 pr-3 font-semibold text-ink-900 whitespace-nowrap">${escapeHtml(l.item || "—")}</td>
        <td class="py-1 pr-3 text-black/60 max-w-[300px] truncate">${escapeHtml(l.description || "")}</td>
        <td class="py-1 pr-3 text-right tabular-nums">${l.qty != null ? l.qty : "—"}</td>
        <td class="py-1 pr-3 text-right tabular-nums">${l.unit_price != null ? money(l.unit_price) : "—"}</td>
        <td class="py-1 pr-3 text-right tabular-nums font-semibold">${money(l.amount)}</td>
        <td class="py-1 text-right tabular-nums text-black/50">${l.cost_amount != null ? money(l.cost_amount) : "—"}</td>
      </tr>`).join("")}</tbody></table>`;
  }

  function tableHtml(items) {
    if (!items.length) return `<div class="text-sm text-black/45 py-4">No estimates tagged to this project yet.</div>`;
    return `<div class="overflow-x-auto"><table class="w-full text-xs">
      <thead><tr class="text-left text-black/45 border-b border-black/10">
        <th class="py-2 pr-2 font-bold">Type</th><th class="py-2 pr-2 font-bold">Estimate</th>
        <th class="py-2 pr-2 font-bold">Scope / reason</th><th class="py-2 pr-2 font-bold text-right">Amount</th>
        <th class="py-2 pr-2 font-bold text-right">Labor</th><th class="py-2 pr-2 font-bold">Status</th>
        <th class="py-2 font-bold text-right"></th></tr></thead>
      <tbody>${items.map((i, idx) => `
        <tr class="border-b border-black/5 hover:bg-black/[0.015]">
          <td class="py-1.5 pr-2 whitespace-nowrap">${i.qbo_estimate_id
          ? `<button data-expand="${escapeHtml(String(i.qbo_estimate_id))}" class="text-black/30 hover:text-black/70 mr-1 align-middle" title="Show line items"><svg data-chev class="w-3 h-3 inline transition-transform" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg></button>`
          : (i.has_lines ? `<button data-co-expand="${i.co_id}" class="text-black/30 hover:text-black/70 mr-1 align-middle" title="Show line items"><svg data-chev class="w-3 h-3 inline transition-transform" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg></button>` : "")}${kindBadge(i)}</td>
          <td class="py-1.5 pr-2 text-black/70">${i.doc_number ? `#${escapeHtml(i.doc_number)}<div class="text-[10px] text-black/40">${ymd(i.txn_date)}</div>` : `<span class="inline-flex rounded bg-black/10 text-black/50 px-1.5 py-0.5 text-[9px] font-bold">DRAFT</span>`}</td>
          <td class="py-1.5 pr-2 text-black/70 max-w-[240px]"><div class="font-semibold text-ink-900 truncate">${escapeHtml(i.title || i.reason || "—")}</div>${i.scope ? `<div class="text-[10px] text-black/45 truncate">${escapeHtml(i.scope)}</div>` : ""}</td>
          <td class="py-1.5 pr-2 text-right tabular-nums font-semibold">${money(i.amount)}</td>
          <td class="py-1.5 pr-2 text-right tabular-nums text-black/60">${i.contract_labor ? money(i.contract_labor) : "—"}</td>
          <td class="py-1.5 pr-2">${statusPill(i.status)}</td>
          <td class="py-1.5 text-right whitespace-nowrap"><button data-edit="${idx}" class="text-xs text-blue-600 font-semibold hover:underline">Edit</button>${i.source === "draft" ? `<button data-del="${i.co_id}" class="text-xs text-black/35 hover:text-red-600 hover:underline ml-2">Delete</button>` : ""}</td>
        </tr>
        ${i.qbo_estimate_id ? `<tr data-lines-row="${escapeHtml(String(i.qbo_estimate_id))}" hidden><td colspan="7" class="bg-black/[0.02] px-4 py-2 border-b border-black/5"><div data-lines-body class="text-xs text-black/50">Loading…</div></td></tr>` : ""}`).join("")}
      </tbody></table></div>`;
  }

  function originatingQuoteHtml() {
    if (!opp) return "";
    let cycle = null;
    if (opp.rfq_received_date && opp.decided_at) {
      const d = Math.round((new Date(opp.decided_at) - new Date(opp.rfq_received_date)) / 86400000);
      if (d >= 0) cycle = d;
    }
    const meta = [
      opp.contact_name && "Contact: " + opp.contact_name,
      opp.estimator_name && "Estimator: " + opp.estimator_name,
      opp.rfq_received_date && "RFQ " + ymd(opp.rfq_received_date),
      cycle != null && `${cycle}d sales cycle`,
    ].filter(Boolean).map(escapeHtml).join(" · ");
    return `<div class="rounded-xl border border-indigo-200 bg-indigo-50/50 px-3 py-2.5 mb-4">
      <div class="text-[10px] font-bold uppercase tracking-wide text-indigo-700/70 mb-0.5">Originating quote</div>
      <div class="text-sm font-semibold text-ink-900">${opp.quote_number ? "#" + escapeHtml(opp.quote_number) + " · " : ""}${escapeHtml(opp.title || opp.customer_name || "—")}</div>
      ${meta ? `<div class="text-[11px] text-black/55 mt-0.5">${meta}</div>` : ""}
      <div class="text-[10px] text-black/40 mt-1">The estimator's estimate is the customer-facing PDF; the estimates below are the project cost-basis.</div>
    </div>`;
  }

  const phaseName = (p) => p.name || `Phase ${p.seq}`;

  function phaseSelect(eid, currentPid) {
    const phases = data.phases || [];
    return `<select data-move="${escapeHtml(String(eid))}" class="input text-[11px] py-0.5 pl-1.5 pr-5 w-auto">
      ${phases.map((p) => `<option value="${p.id}" ${p.id === currentPid ? "selected" : ""}>${escapeHtml(phaseName(p))}</option>`).join("")}
      <option value="__new">＋ New phase…</option></select>`;
  }

  // one estimate row (+ its lazily-loaded line-items detail row).
  function rowHtml(i, idx, opts = {}) {
    const asg = (data.assignments || {})[String(i.qbo_estimate_id)];
    const unconfirmed = opts.inPhase && asg && !asg.confirmed;
    return `
      <tr class="border-b border-black/5 hover:bg-black/[0.015] ${unconfirmed ? "bg-amber-50/60" : ""}">
        <td class="py-1.5 pr-2 whitespace-nowrap">${i.qbo_estimate_id
          ? `<button data-expand="${escapeHtml(String(i.qbo_estimate_id))}" class="text-black/30 hover:text-black/70 mr-1 align-middle" title="Show line items"><svg data-chev class="w-3 h-3 inline transition-transform" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg></button>`
          : (i.has_lines ? `<button data-co-expand="${i.co_id}" class="text-black/30 hover:text-black/70 mr-1 align-middle" title="Show line items"><svg data-chev class="w-3 h-3 inline transition-transform" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg></button>` : "")}${kindBadge(i)}</td>
        <td class="py-1.5 pr-2 text-black/70">${i.doc_number ? `#${escapeHtml(i.doc_number)}<div class="text-[10px] text-black/40">${ymd(i.txn_date)}</div>` : `<span class="inline-flex rounded bg-black/10 text-black/50 px-1.5 py-0.5 text-[9px] font-bold">DRAFT</span>`}</td>
        <td class="py-1.5 pr-2 text-black/70 max-w-[200px]"><div class="font-semibold text-ink-900 truncate">${escapeHtml(i.title || i.reason || "—")}</div>${i.scope ? `<div class="text-[10px] text-black/45 truncate">${escapeHtml(i.scope)}</div>` : ""}</td>
        <td class="py-1.5 pr-2 text-right tabular-nums font-semibold">${money(i.amount)}</td>
        <td class="py-1.5 pr-2 text-right tabular-nums text-black/60">${i.contract_labor ? money(i.contract_labor) : "—"}</td>
        <td class="py-1.5 pr-2">${statusPill(i.status)}</td>
        ${opts.inPhase ? `<td class="py-1.5 pr-2 whitespace-nowrap">${phaseSelect(i.qbo_estimate_id, asg ? asg.phase_id : null)}${unconfirmed ? `<button data-confirm="${escapeHtml(String(i.qbo_estimate_id))}" data-phase="${asg.phase_id}" class="ml-1 text-[10px] font-bold text-amber-700 hover:underline" title="Confirm this phase">⚑ confirm</button>` : ""}</td>` : ""}
        <td class="py-1.5 text-right whitespace-nowrap">${i.source === "draft"
          ? `${i.has_lines ? `<button data-co-pdf="${i.co_id}" class="text-xs text-emerald-700 font-semibold hover:underline mr-2" title="Generate PDF + file to 4 Quotes">PDF</button>` : ""}<button data-edit-draft="${idx}" class="text-xs text-blue-600 font-semibold hover:underline">Edit</button><button data-del="${i.co_id}" class="text-xs text-black/35 hover:text-red-600 hover:underline ml-2">Delete</button>`
          : `<button data-edit="${idx}" class="text-xs text-blue-600 font-semibold hover:underline">Edit</button>`}</td>
      </tr>
      ${i.qbo_estimate_id ? `<tr data-lines-row="${escapeHtml(String(i.qbo_estimate_id))}" hidden><td colspan="8" class="bg-black/[0.02] px-4 py-2 border-b border-black/5"><div data-lines-body class="text-xs text-black/50">Loading…</div></td></tr>` : ""}
      ${(!i.qbo_estimate_id && i.has_lines) ? `<tr data-co-lines-row="${i.co_id}" hidden><td colspan="8" class="bg-black/[0.02] px-4 py-2 border-b border-black/5"><div data-co-lines-body class="text-xs text-black/50">Loading…</div></td></tr>` : ""}`;
  }

  function rowsTable(items, opts = {}) {
    return `<div class="overflow-x-auto"><table class="w-full text-xs">
      <thead><tr class="text-left text-black/45 border-b border-black/10">
        <th class="py-2 pr-2 font-bold">Type</th><th class="py-2 pr-2 font-bold">Estimate</th>
        <th class="py-2 pr-2 font-bold">Scope / reason</th><th class="py-2 pr-2 font-bold text-right">Amount</th>
        <th class="py-2 pr-2 font-bold text-right">Labor</th><th class="py-2 pr-2 font-bold">Status</th>
        ${opts.inPhase ? `<th class="py-2 pr-2 font-bold">Phase</th>` : ""}
        <th class="py-2 font-bold text-right"></th></tr></thead>
      <tbody>${items.map((i) => rowHtml(i, data.items.indexOf(i), opts)).join("")}</tbody></table></div>`;
  }

  function phasesHtml() {
    const phases = data.phases || [];
    const asg = data.assignments || {};
    const accepted = data.items.filter((i) => i.qbo_estimate_id && i.status === "approved");
    const other = data.items.filter((i) => !(i.qbo_estimate_id && i.status === "approved"));
    if (!phases.length) return rowsTable(data.items);

    const byPhase = {};
    accepted.forEach((i) => { const pid = asg[String(i.qbo_estimate_id)]?.phase_id || phases[0].id; (byPhase[pid] ||= []).push(i); });

    const phaseCards = phases.map((p) => {
      const rows = byPhase[p.id] || [];
      const sub = rows.reduce((s, i) => s + i.amount, 0);
      return `<div class="rounded-xl border border-violet-200 bg-violet-50/40 p-3 mb-3">
        <div class="flex items-center gap-2 mb-2 flex-wrap">
          <span class="inline-flex rounded-full bg-violet-600 text-white px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">Phase ${p.seq}</span>
          <input data-phase-name="${p.id}" value="${escapeHtml(p.name || "")}" placeholder="name (optional)" class="bg-transparent border border-transparent hover:border-black/15 focus:border-violet-400 rounded px-1.5 py-0.5 text-[12px] font-semibold w-40">
          <span class="text-[11px] text-violet-700/70 tabular-nums ml-auto">${rows.length} estimate${rows.length === 1 ? "" : "s"} · ${money(sub)}</span>
          ${phases.length > 1 ? `<button data-phase-del="${p.id}" class="text-[11px] text-black/30 hover:text-red-600" title="Delete phase (estimates fall back to Phase 1)">✕</button>` : ""}
        </div>
        ${rows.length ? rowsTable(rows, { inPhase: true }) : `<div class="text-[12px] text-black/40 py-2 px-1">No estimates in this phase.</div>`}
      </div>`;
    }).join("");

    const otherCard = other.length ? `
      <div class="rounded-xl border border-black/10 bg-black/[0.015] p-3 mb-3">
        <div class="text-[11px] font-bold uppercase tracking-wide text-black/45 mb-2">Not scheduled — pending / declined / drafts</div>
        ${rowsTable(other)}
        <div class="text-[10px] text-black/40 mt-2">Only <b>accepted</b> estimates are grouped into phases &amp; drive schedules. These are tracked here until accepted.</div>
      </div>` : "";

    return phaseCards + otherCard;
  }

  function render() {
    container.innerHTML = `<div class="p-4 sm:p-5">
      ${originatingQuoteHtml()}
      <div class="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div class="text-[11px] font-bold uppercase tracking-wide text-black/40">Contract value &amp; change orders</div>
        <div class="flex gap-2">
          <button id="phaseAdd" class="rounded-lg border border-violet-300 text-violet-700 px-3 py-1.5 text-xs font-semibold hover:bg-violet-50">+ New phase</button>
          <button id="coAdd" class="btn-primary text-xs px-3 py-1.5">+ Add change order</button>
        </div>
      </div>
      ${rollupHtml(data.rollup)}
      ${phasesHtml()}
      <div class="text-[11px] text-black/40 mt-3">Estimates group into <b>work phases</b>. New accepted estimates are auto-suggested into Phase 1 (⚑ = confirm or move). Only accepted estimates drive schedules; the roll-up above is the revised contract.</div>
    </div>`;
    wire();
  }

  const lineCache = {};
  const coLineCache = {};
  async function reloadData() { try { await load(); render(); } catch (e) { alert(e?.message || "Failed"); } }

  function wire() {
    document.getElementById("coAdd").addEventListener("click", () => openAddCOModal());
    document.getElementById("phaseAdd")?.addEventListener("click", async () => {
      try { await api(`/phases/project/${encodeURIComponent(entityId)}`, { method: "POST" }); reloadData(); }
      catch (e) { alert(e?.message || "Could not add phase"); }
    });
    // move an estimate to a phase (or create a new one and move it there)
    container.querySelectorAll("[data-move]").forEach(sel => sel.addEventListener("change", async () => {
      const eid = sel.getAttribute("data-move");
      let phaseId = sel.value;
      try {
        if (phaseId === "__new") {
          const np = await api(`/phases/project/${encodeURIComponent(entityId)}`, { method: "POST" });
          phaseId = np.id;
        }
        await api(`/phases/project/${encodeURIComponent(entityId)}/assign`, { method: "POST", body: JSON.stringify({ estimate_qbo_id: eid, phase_id: Number(phaseId) }) });
        reloadData();
      } catch (e) { alert(e?.message || "Move failed"); }
    }));
    container.querySelectorAll("[data-confirm]").forEach(btn => btn.addEventListener("click", async () => {
      try {
        await api(`/phases/project/${encodeURIComponent(entityId)}/assign`, { method: "POST", body: JSON.stringify({ estimate_qbo_id: btn.getAttribute("data-confirm"), phase_id: Number(btn.getAttribute("data-phase")) }) });
        reloadData();
      } catch (e) { alert(e?.message || "Confirm failed"); }
    }));
    container.querySelectorAll("[data-phase-name]").forEach(inp => inp.addEventListener("change", async () => {
      try { await api(`/phases/${inp.getAttribute("data-phase-name")}`, { method: "PATCH", body: JSON.stringify({ name: inp.value.trim() || null }) }); }
      catch (e) { alert(e?.message || "Rename failed"); }
    }));
    container.querySelectorAll("[data-phase-del]").forEach(btn => btn.addEventListener("click", async () => {
      if (!confirm("Delete this phase? Its estimates fall back to Phase 1.")) return;
      try { await api(`/phases/${btn.getAttribute("data-phase-del")}`, { method: "DELETE" }); reloadData(); }
      catch (e) { alert(e?.message || "Delete failed"); }
    }));
    container.querySelectorAll("[data-expand]").forEach(btn => btn.addEventListener("click", async () => {
      const eid = btn.getAttribute("data-expand");
      const row = container.querySelector(`[data-lines-row="${CSS.escape(eid)}"]`);
      const chev = btn.querySelector("[data-chev]");
      if (!row) return;
      const opening = row.hidden;
      row.hidden = !opening;
      if (chev) chev.style.transform = opening ? "rotate(90deg)" : "";
      if (!opening) return;
      const body = row.querySelector("[data-lines-body]");
      if (lineCache[eid]) { body.innerHTML = lineCache[eid]; return; }
      try {
        const r = await api(`/change-orders/project/${encodeURIComponent(entityId)}/estimate/${encodeURIComponent(eid)}/lines`);
        lineCache[eid] = linesHtml(r.lines);
        body.innerHTML = lineCache[eid];
      } catch (e) { body.innerHTML = `<span class="text-red-600">Failed to load line items.</span>`; }
    }));
    container.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () =>
      openEditModal(data.items[Number(b.getAttribute("data-edit"))])));
    // draft change order: edit-as-estimate-form, expand stored lines, re-print PDF
    container.querySelectorAll("[data-edit-draft]").forEach(b => b.addEventListener("click", () =>
      openEstimateFormModal(data.items[Number(b.getAttribute("data-edit-draft"))])));
    container.querySelectorAll("[data-co-expand]").forEach(btn => btn.addEventListener("click", async () => {
      const cid = btn.getAttribute("data-co-expand");
      const row = container.querySelector(`[data-co-lines-row="${CSS.escape(cid)}"]`);
      const chev = btn.querySelector("[data-chev]");
      if (!row) return;
      const opening = row.hidden; row.hidden = !opening;
      if (chev) chev.style.transform = opening ? "rotate(90deg)" : "";
      if (!opening) return;
      const body = row.querySelector("[data-co-lines-body]");
      if (coLineCache[cid]) { body.innerHTML = coLineCache[cid]; return; }
      try {
        const r = await api(`/change-orders/co/${cid}/lines`);
        coLineCache[cid] = linesHtml((r.lines || []).map(l => ({ item: l.item, description: l.description, qty: l.qty, unit_price: l.rate, amount: l.amount, cost_amount: null })));
        body.innerHTML = coLineCache[cid];
      } catch (e) { body.innerHTML = `<span class="text-red-600">Failed to load line items.</span>`; }
    }));
    container.querySelectorAll("[data-co-pdf]").forEach(btn => btn.addEventListener("click", async () => {
      const cid = btn.getAttribute("data-co-pdf"); const orig = btn.textContent;
      btn.disabled = true; btn.textContent = "…";
      try {
        await api(`/change-orders/co/${cid}/pdf?save=true`, { method: "POST" });
        const pres = await fetch(`/api/change-orders/co/${cid}/pdf`, { method: "POST", headers: { "Authorization": "Bearer " + getToken() } });
        window.open(URL.createObjectURL(await pres.blob()), "_blank");
      } catch (e) { alert("PDF failed"); }
      btn.disabled = false; btn.textContent = orig;
    }));
    container.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this draft change order?")) return;
      try { await api(`/change-orders/${b.getAttribute("data-del")}`, { method: "DELETE" }); await reloadData(); }
      catch (err) { alert(err.message); }
    }));
  }

  // "+ Add change order" → choose how to create it (the new process).
  function openAddCOModal() {
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4";
    const card = (icon, title, desc, tag) => `<button data-choice="${tag}" class="text-left rounded-xl border border-black/12 hover:border-blue-400 hover:bg-blue-50/40 p-4 transition w-full">
      <div class="text-xl mb-1">${icon}</div><div class="font-bold text-ink-900 text-sm">${title}</div>
      <div class="text-[12px] text-black/55 mt-1 leading-snug">${desc}</div></button>`;
    overlay.innerHTML = `<div class="bg-white rounded-2xl shadow-xl w-full max-w-lg p-5">
      <div class="text-base font-bold text-ink-900 mb-1">New change order</div>
      <div class="text-[12px] text-black/50 mb-4">How do you want to create it?</div>
      <div class="grid gap-3">
        ${card("📝", "Fill out an estimate → PDF", "Enter the line items and generate an OPI-branded estimate PDF to send. The common path — no need to build it in QuickBooks first.", "form")}
        ${card("🧮", "Build a full quote (quoting metrics)", "Open the quoting workspace to price it with the full calc engine. For a real re-estimate (rare for change orders).", "quote")}
        ${card("📥", "Already created in QuickBooks", "Log it now to track it; it links to the QBO estimate automatically once synced.", "qbo")}
      </div>
      <div class="mt-4 flex justify-end"><button data-cancel class="${CANCEL}">Cancel</button></div></div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector("[data-cancel]").addEventListener("click", close);
    overlay.querySelectorAll("[data-choice]").forEach(b => b.addEventListener("click", () => {
      const c = b.getAttribute("data-choice"); close();
      if (c === "form") openEstimateFormModal();
      else if (c === "qbo") openEditModal(null);
      else if (c === "quote") location.hash = "#/pipeline";
    }));
  }

  // Editable change-order estimate form → OPI-branded PDF (persists line items).
  async function openEstimateFormModal(item = null) {
    let lines = [{ label: "", description: "", qty: 1, rate: 0 }];
    if (item && item.co_id) {
      try {
        const r = await api(`/change-orders/co/${item.co_id}/lines`);
        if (r.lines && r.lines.length) lines = r.lines.map(l => ({ label: l.item || "", description: l.description || "", qty: l.qty ?? 1, rate: l.rate ?? 0 }));
      } catch (_) {}
    }
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4";
    const money2 = (n) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const lineAmt = (l) => (Number(l.qty) || 0) * (Number(l.rate) || 0);
    const total = () => lines.reduce((s, l) => s + lineAmt(l), 0);
    const GRID = "grid grid-cols-[1.4fr_2fr_.6fr_.9fr_.9fr_auto] gap-1.5 items-center";
    const rowHtml = (l, idx) => `<div class="${GRID}">
      <input data-l="${idx}" data-k="label" value="${escapeHtml(l.label)}" placeholder="Item" list="coItemList" class="input text-xs py-1">
      <input data-l="${idx}" data-k="description" value="${escapeHtml(l.description)}" placeholder="Description" class="input text-xs py-1">
      <input data-l="${idx}" data-k="qty" type="number" step="1" value="${l.qty}" class="input text-xs py-1 text-right">
      <input data-l="${idx}" data-k="rate" type="number" step="1" value="${l.rate}" class="input text-xs py-1 text-right">
      <div data-amt="${idx}" class="text-right tabular-nums text-xs font-semibold">${money2(lineAmt(l))}</div>
      <button data-rm="${idx}" class="text-black/30 hover:text-red-600 text-sm">✕</button></div>`;
    overlay.innerHTML = `<div class="bg-white rounded-2xl shadow-xl w-full max-w-2xl p-5 max-h-[90vh] overflow-auto">
      <datalist id="coItemList">${CO_ITEMS.map((i) => `<option value="${escapeHtml(i)}">`).join("")}</datalist>
      <div class="text-base font-bold text-ink-900 mb-3">${item ? "Edit change order" : "Change order — estimate"}</div>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Title</div><input data-title value="${escapeHtml(item?.title || "")}" class="input text-sm py-1.5 w-full" placeholder="e.g. Added mezzanine railing"></label>
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Reason</div><select data-reason class="input text-sm py-1.5 w-full"><option value="">—</option>${REASONS.map((r) => `<option ${item?.reason === r ? "selected" : ""}>${r}</option>`).join("")}</select></label>
      </div>
      <div class="${GRID} text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1"><div>Item</div><div>Description</div><div class="text-right">Qty</div><div class="text-right">Rate</div><div class="text-right">Amount</div><div></div></div>
      <div data-lines class="space-y-1.5"></div>
      <button data-addline class="text-xs font-semibold text-blue-600 hover:underline mt-2">+ Add line</button>
      <div class="flex justify-end items-baseline gap-2 mt-3 pt-3 border-t border-black/10"><span class="text-xs text-black/50">Total</span><span data-total class="text-base font-extrabold tabular-nums">$0.00</span></div>
      <div class="mt-4 flex items-center justify-end gap-2">
        <span data-msg class="text-xs font-semibold mr-auto"></span>
        <button data-cancel class="${CANCEL}">Cancel</button>
        <button data-save class="rounded-lg border border-black/15 px-3 py-1.5 text-sm font-semibold hover:bg-black/5">Save</button>
        <button data-savepdf class="btn-primary text-sm px-4 py-1.5">Save &amp; PDF →</button>
      </div></div>`;
    document.body.appendChild(overlay);
    const linesEl = overlay.querySelector("[data-lines]");
    const redraw = () => { linesEl.innerHTML = lines.map(rowHtml).join(""); };
    const updTotal = () => { overlay.querySelector("[data-total]").textContent = money2(total()); };
    redraw(); updTotal();
    const close = () => overlay.remove();
    const setMsg = (t, ok) => { const m = overlay.querySelector("[data-msg]"); m.textContent = t; m.className = "text-xs font-semibold mr-auto " + (ok ? "text-emerald-700" : "text-red-600"); };
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector("[data-cancel]").addEventListener("click", close);
    linesEl.addEventListener("input", (e) => {
      const inp = e.target.closest("[data-l]"); if (!inp) return;
      const i = Number(inp.getAttribute("data-l")), k = inp.getAttribute("data-k");
      lines[i][k] = inp.type === "number" ? Number(inp.value) : inp.value;
      if (k === "qty" || k === "rate") { overlay.querySelector(`[data-amt="${i}"]`).textContent = money2(lineAmt(lines[i])); updTotal(); }
    });
    linesEl.addEventListener("click", (e) => { const rm = e.target.closest("[data-rm]"); if (!rm) return; lines.splice(Number(rm.getAttribute("data-rm")), 1); if (!lines.length) lines = [{ label: "", description: "", qty: 1, rate: 0 }]; redraw(); updTotal(); });
    overlay.querySelector("[data-addline]").addEventListener("click", () => { lines.push({ label: "", description: "", qty: 1, rate: 0 }); redraw(); });
    const payload = () => ({ title: overlay.querySelector("[data-title]").value.trim() || null, reason: overlay.querySelector("[data-reason]").value || null, total: total(),
      lines: lines.filter(l => l.label || lineAmt(l)).map(l => ({ label: l.label, description: l.description, qty: Number(l.qty) || null, rate: Number(l.rate) || null, amount: lineAmt(l) })) });
    // Persist the CO with its line items (create or edit), return its co_id.
    const persist = async () => {
      const p = payload();
      if (item && item.co_id) {
        await api(`/change-orders/${item.co_id}`, { method: "PATCH", body: JSON.stringify({ title: p.title, reason: p.reason, lines: p.lines }) });
        return item.co_id;
      }
      const res = await api(`/change-orders/project/${encodeURIComponent(entityId)}/draft`, { method: "POST", body: JSON.stringify({ kind: "change_order", title: p.title, reason: p.reason, status: "draft", lines: p.lines }) });
      return res.co_id;
    };
    overlay.querySelector("[data-save]").addEventListener("click", async () => {
      try { await persist(); close(); await reloadData(); }
      catch (e) { setMsg(e?.message || "Save failed", false); }
    });
    overlay.querySelector("[data-savepdf]").addEventListener("click", async (e) => {
      const btn = e.currentTarget; btn.disabled = true; setMsg("Saving…", true);
      try {
        const coId = await persist();
        // file into the project's "4 Quotes" folder, then open it in a new tab
        await api(`/change-orders/co/${coId}/pdf?save=true`, { method: "POST" });
        const pres = await fetch(`/api/change-orders/co/${coId}/pdf`, { method: "POST", headers: { "Authorization": "Bearer " + getToken() } });
        window.open(URL.createObjectURL(await pres.blob()), "_blank");
        close(); await reloadData();
      } catch (err) { btn.disabled = false; setMsg("Could not save / PDF.", false); }
    });
  }

  // item === null → add a new draft. Otherwise edit an existing item.
  function openEditModal(item) {
    const isDraft = !item || item.source === "draft";
    const overlay = document.createElement("div");
    overlay.className = "fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4";
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-5 max-h-[90vh] overflow-auto">
        <div class="text-base font-bold text-ink-900 mb-3">${!item ? "New change order" : item.kind === "original" ? "Edit original estimate" : "Edit change order"}</div>
        <div class="space-y-3">
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Type</div>
            <select data-f="kind" class="input text-sm py-1.5 w-full"><option value="change_order" ${item && item.kind === "change_order" || !item ? "selected" : ""}>Change order</option><option value="original" ${item && item.kind === "original" ? "selected" : ""}>Original cost-basis</option></select></label>
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Title</div><input data-f="title" class="input text-sm py-1.5 w-full" value="${escapeHtml(item?.title || "")}" placeholder="Short label"></label>
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Reason</div>
            <select data-f="reason" class="input text-sm py-1.5 w-full"><option value="">—</option>${REASONS.map(r => `<option ${item && item.reason === r ? "selected" : ""}>${r}</option>`).join("")}</select></label>
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Scope</div><textarea data-f="scope" rows="2" class="input text-sm py-1.5 w-full" placeholder="What changed">${escapeHtml(item?.scope || "")}</textarea></label>
          ${isDraft ? `<div class="grid grid-cols-2 gap-2">
            <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Amount ($)</div><input data-f="amount" type="number" step="100" class="input text-sm py-1.5 w-full" value="${item?.amount || ""}"></label>
            <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Contract labor ($)</div><input data-f="contract_labor" type="number" step="100" class="input text-sm py-1.5 w-full" value="${item?.contract_labor || ""}"></label>
          </div>` : `<div class="text-[11px] text-black/45">Amount ${money(item.amount)} · labor ${item.contract_labor ? money(item.contract_labor) : "—"} — from QuickBooks estimate #${escapeHtml(item.doc_number || "")}.</div>`}
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Status</div>
            <select data-f="status" class="input text-sm py-1.5 w-full">${STATUSES.map(([v, l]) => `<option value="${v}" ${(item?.status || "draft") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          ${item && item.source === "draft" ? `<div class="pt-1 border-t border-black/10">
            <div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1 mt-2">Link to QuickBooks estimate</div>
            <div class="flex gap-2"><input data-link class="input text-sm py-1.5 flex-1" placeholder="Estimate # (e.g. 6501)"><button data-linkbtn class="rounded-lg border border-black/15 px-2.5 py-1 text-xs font-semibold hover:bg-black/5 whitespace-nowrap">Link</button></div></div>` : ""}
        </div>
        <div class="mt-4 flex items-center justify-end gap-2">
          <span data-msg class="text-xs font-semibold mr-auto"></span>
          <button data-cancel class="${CANCEL}">Cancel</button>
          <button data-save class="btn-primary text-sm px-4 py-1.5">${!item ? "Create" : "Save"}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector("[data-cancel]").addEventListener("click", close);
    const val = (f) => overlay.querySelector(`[data-f="${f}"]`);
    const setMsg = (t, ok) => { const m = overlay.querySelector("[data-msg]"); m.textContent = t; m.className = "text-xs font-semibold mr-auto " + (ok ? "text-emerald-700" : "text-red-600"); };

    const linkBtn = overlay.querySelector("[data-linkbtn]");
    if (linkBtn) linkBtn.addEventListener("click", async () => {
      const doc = overlay.querySelector("[data-link]").value.trim();
      if (!doc) return;
      try { await api(`/change-orders/${item.co_id}/link-qbo`, { method: "POST", body: JSON.stringify({ doc_number: doc }) }); close(); await reloadData(); }
      catch (err) { let d = err?.message || "Link failed"; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch (_) {} setMsg(d, false); }
    });

    overlay.querySelector("[data-save]").addEventListener("click", async () => {
      const payload = {
        kind: val("kind").value, title: val("title").value.trim() || null,
        reason: val("reason").value || null, scope: val("scope").value.trim() || null,
        status: val("status").value,
      };
      try {
        if (!item) {
          payload.amount = parseFloat(val("amount").value) || null;
          payload.contract_labor = parseFloat(val("contract_labor").value) || null;
          await api(`/change-orders/project/${encodeURIComponent(entityId)}/draft`, { method: "POST", body: JSON.stringify(payload) });
        } else if (item.source === "draft") {
          payload.amount = parseFloat(val("amount").value) || null;
          payload.contract_labor = parseFloat(val("contract_labor").value) || null;
          await api(`/change-orders/${item.co_id}`, { method: "PATCH", body: JSON.stringify(payload) });
        } else {
          await api(`/change-orders/project/${encodeURIComponent(entityId)}/estimate/${encodeURIComponent(item.qbo_estimate_id)}`, { method: "PUT", body: JSON.stringify(payload) });
        }
        close(); await reloadData();
      } catch (err) { let d = err?.message || "Could not save"; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch (_) {} setMsg(d, false); }
    });
  }

  render();
}
