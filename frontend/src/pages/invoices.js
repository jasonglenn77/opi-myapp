// Customer invoice schedule panel (Projects hub Phase 2, Billing & Schedule).
// Milestone billing on the estimate terms (default 35% PO / 35% start / 30% end,
// net-30). Generate from contract value + dates, then edit each milestone.
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";

const money = (n) => (n == null || n === "" ? "—" : "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const STATUS = [["pending", "Pending"], ["sent", "Sent"], ["paid", "Paid"]];

export async function mountInvoicePanel(container, entityId) {
  container.innerHTML = `<div class="text-sm text-black/40 py-3">Loading invoices…</div>`;
  let data;
  try {
    data = await api(`/invoices/project/${encodeURIComponent(entityId)}`);
  } catch (e) {
    container.innerHTML = `<div class="text-sm text-red-600 py-3">Failed to load invoices: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }
  const remount = () => mountInvoicePanel(container, entityId);
  const t = data.totals || {};
  const ms = data.milestones || [];
  const sched = data.schedule;
  const sugg = data.suggested || {};

  if (!sched) {
    container.innerHTML = `
      <div class="rounded-xl border border-black/10 p-3">
        <div class="text-xs text-black/50 mb-2">No invoice schedule yet. Generate the default terms — 35% at PO / 35% at start / 30% at completion, net-30.</div>
        <div class="flex flex-wrap items-end gap-2">
          <label class="text-[11px] font-semibold text-black/60">Contract value<br><input data-c type="number" step="0.01" value="${sugg.contract_value ?? ""}" class="input text-sm py-1.5 w-36"></label>
          <label class="text-[11px] font-semibold text-black/60">Start<br><input data-s type="date" value="${sugg.start_date || ""}" class="input text-sm py-1.5"></label>
          <label class="text-[11px] font-semibold text-black/60">End<br><input data-e type="date" value="${sugg.end_date || ""}" class="input text-sm py-1.5"></label>
          <label class="text-[11px] font-semibold text-black/60">Net days<br><input data-n type="number" value="30" class="input text-sm py-1.5 w-20"></label>
          <button data-gen class="btn-primary text-xs px-3 py-1.5">Generate schedule</button>
        </div>
      </div>`;
    container.querySelector("[data-gen]").addEventListener("click", async () => {
      const body = {
        contract_value: Number(container.querySelector("[data-c]").value || 0),
        start_date: container.querySelector("[data-s]").value || null,
        end_date: container.querySelector("[data-e]").value || null,
        net_days: Number(container.querySelector("[data-n]").value) || 30,
      };
      try { await api(`/invoices/project/${encodeURIComponent(entityId)}/generate`, { method: "POST", body: JSON.stringify(body) }); remount(); }
      catch (e) { alert("Generate failed: " + (e?.message || e)); }
    });
    return;
  }

  const reconciled = Math.abs((t.scheduled || 0) - (t.contract_value || 0)) < 0.5;
  const row = (m) => `
    <tr class="border-b border-black/5" data-mid="${m.id}">
      <td class="py-1.5 pr-2 text-black/50 tabular-nums">${m.seq}</td>
      <td class="py-1.5 pr-2"><input data-f="label" value="${escapeHtml(m.label || "")}" class="input text-xs py-1 w-44"></td>
      <td class="py-1.5 pr-2"><input data-f="invoice_date" type="date" value="${m.invoice_date || ""}" class="input text-xs py-1"></td>
      <td class="py-1.5 pr-2"><input data-f="due_date" type="date" value="${m.due_date || ""}" class="input text-xs py-1"></td>
      <td class="py-1.5 pr-2 text-right"><input data-f="amount" type="number" step="0.01" value="${m.amount ?? ""}" class="input text-xs py-1 w-28 text-right tabular-nums"></td>
      <td class="py-1.5 pr-2"><select data-f="status" class="input text-xs py-1">${STATUS.map(([v, l]) => `<option value="${v}" ${m.status === v ? "selected" : ""}>${l}</option>`).join("")}</select></td>
      <td class="py-1.5 pr-2"><input data-f="note" value="${escapeHtml(m.note || "")}" placeholder="—" class="input text-xs py-1 w-32"></td>
      <td class="py-1.5 text-right"><button data-del class="text-black/30 hover:text-red-600 text-sm" title="Delete">✕</button></td>
    </tr>`;

  container.innerHTML = `
    <div class="rounded-xl border border-black/10 overflow-hidden">
      <div class="px-3 py-2 bg-black/[0.02] border-b border-black/10 flex items-center justify-between gap-3 flex-wrap text-xs">
        <span class="text-black/50">${escapeHtml(sched.terms_note || "")}</span>
        <span class="tabular-nums">Contract <b>${money(t.contract_value)}</b> · Scheduled <b class="${reconciled ? "text-emerald-700" : "text-amber-700"}">${money(t.scheduled)}</b> · Invoiced <b>${money(t.invoiced)}</b></span>
      </div>
      <div class="overflow-x-auto"><table class="w-full text-sm" style="min-width:820px;">
        <thead><tr class="text-left text-black/45 border-b border-black/10 text-[11px] uppercase tracking-wide">
          <th class="py-2 pr-2 w-6">#</th><th class="py-2 pr-2">Invoice</th><th class="py-2 pr-2 w-32">Invoice date</th><th class="py-2 pr-2 w-32">Due (net)</th><th class="py-2 pr-2 w-28 text-right">Amount</th><th class="py-2 pr-2 w-24">Status</th><th class="py-2 pr-2">Note</th><th class="py-2 w-8"></th>
        </tr></thead>
        <tbody data-rows>${ms.map(row).join("")}</tbody>
      </table></div>
      <div class="px-3 py-2 flex items-center justify-between gap-2 border-t border-black/5">
        <button data-add class="text-xs font-semibold text-emerald-700 hover:underline">+ Add invoice</button>
        <button data-regen class="text-xs font-semibold text-blue-600 hover:underline">Regenerate from terms</button>
      </div>
    </div>`;

  const rows = container.querySelector("[data-rows]");
  rows.addEventListener("change", async (e) => {
    const f = e.target.closest("[data-f]"); if (!f) return;
    const mid = f.closest("[data-mid]").getAttribute("data-mid");
    const field = f.getAttribute("data-f");
    const val = f.value;
    const body = { [field]: field === "amount" ? (val === "" ? null : Number(val)) : (val === "" ? null : val) };
    try { await api(`/invoices/milestone/${mid}`, { method: "PATCH", body: JSON.stringify(body) }); remount(); }
    catch (err) { alert("Save failed: " + (err?.message || err)); }
  });
  rows.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del]"); if (!del) return;
    const mid = del.closest("[data-mid]").getAttribute("data-mid");
    if (!confirm("Delete this invoice milestone?")) return;
    try { await api(`/invoices/milestone/${mid}`, { method: "DELETE" }); remount(); }
    catch (err) { alert("Delete failed: " + (err?.message || err)); }
  });
  container.querySelector("[data-add]").addEventListener("click", async () => {
    try { await api(`/invoices/schedule/${sched.id}/milestone`, { method: "POST" }); remount(); }
    catch (e) { alert(e?.message || e); }
  });
  container.querySelector("[data-regen]").addEventListener("click", async () => {
    if (!confirm("Regenerate from the default terms? This replaces the current milestones.")) return;
    const body = { contract_value: Number(t.contract_value || sched.contract_value || 0), start_date: sugg.start_date || null, end_date: sugg.end_date || null, net_days: sched.net_days || 30 };
    try { await api(`/invoices/project/${encodeURIComponent(entityId)}/generate`, { method: "POST", body: JSON.stringify(body) }); remount(); }
    catch (e) { alert(e?.message || e); }
  });
}
