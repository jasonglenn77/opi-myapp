// Change Orders — supplemental / additional project estimates. Lists the project's
// QBO estimates (original cost-basis + change orders) plus quick app-side drafts,
// classifies/annotates them, and rolls up the revised contract value. Ties to the
// Payments tab (same QBO estimates drive the crew payment schedules).
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";

const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const ymd = (s) => (s ? String(s).slice(0, 10) : "—");
const REASONS = ["Scope change", "Added items", "Removed items", "Material / spec change",
  "Pricing correction", "Customer request", "Timeline change", "Other"];
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
          <td class="py-1.5 pr-2">${kindBadge(i)}</td>
          <td class="py-1.5 pr-2 text-black/70">${i.doc_number ? `#${escapeHtml(i.doc_number)}<div class="text-[10px] text-black/40">${ymd(i.txn_date)}</div>` : `<span class="inline-flex rounded bg-black/10 text-black/50 px-1.5 py-0.5 text-[9px] font-bold">DRAFT</span>`}</td>
          <td class="py-1.5 pr-2 text-black/70 max-w-[240px]"><div class="font-semibold text-ink-900 truncate">${escapeHtml(i.title || i.reason || "—")}</div>${i.scope ? `<div class="text-[10px] text-black/45 truncate">${escapeHtml(i.scope)}</div>` : ""}</td>
          <td class="py-1.5 pr-2 text-right tabular-nums font-semibold">${money(i.amount)}</td>
          <td class="py-1.5 pr-2 text-right tabular-nums text-black/60">${i.contract_labor ? money(i.contract_labor) : "—"}</td>
          <td class="py-1.5 pr-2">${statusPill(i.status)}</td>
          <td class="py-1.5 text-right whitespace-nowrap"><button data-edit="${idx}" class="text-xs text-blue-600 font-semibold hover:underline">Edit</button>${i.source === "draft" ? `<button data-del="${i.co_id}" class="text-xs text-black/35 hover:text-red-600 hover:underline ml-2">Delete</button>` : ""}</td>
        </tr>`).join("")}
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

  function render() {
    container.innerHTML = `<div class="p-4 sm:p-5">
      ${originatingQuoteHtml()}
      <div class="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div class="text-[11px] font-bold uppercase tracking-wide text-black/40">Contract value &amp; change orders</div>
        <button id="coAdd" class="btn-primary text-xs px-3 py-1.5">+ Add change order</button>
      </div>
      ${rollupHtml(data.rollup)}
      ${tableHtml(data.items)}
      <div class="text-[11px] text-black/40 mt-3">The office creates change orders as new estimates in QuickBooks; they appear here automatically once synced. Use “Add change order” to log one before it’s in QuickBooks, then link it later.</div>
    </div>`;
    wire();
  }

  function wire() {
    document.getElementById("coAdd").addEventListener("click", () => openEditModal(null));
    container.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () =>
      openEditModal(data.items[Number(b.getAttribute("data-edit"))])));
    container.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this draft change order?")) return;
      try { data = await api(`/change-orders/${b.getAttribute("data-del")}`, { method: "DELETE" }); render(); }
      catch (err) { alert(err.message); }
    }));
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
      try { data = await api(`/change-orders/${item.co_id}/link-qbo`, { method: "POST", body: JSON.stringify({ doc_number: doc }) }); close(); render(); }
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
          data = await api(`/change-orders/project/${encodeURIComponent(entityId)}/draft`, { method: "POST", body: JSON.stringify(payload) });
        } else if (item.source === "draft") {
          payload.amount = parseFloat(val("amount").value) || null;
          payload.contract_labor = parseFloat(val("contract_labor").value) || null;
          data = await api(`/change-orders/${item.co_id}`, { method: "PATCH", body: JSON.stringify(payload) });
        } else {
          data = await api(`/change-orders/project/${encodeURIComponent(entityId)}/estimate/${encodeURIComponent(item.qbo_estimate_id)}`, { method: "PUT", body: JSON.stringify(payload) });
        }
        close(); render();
      } catch (err) { let d = err?.message || "Could not save"; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch (_) {} setMsg(d, false); }
    });
  }

  render();
}
