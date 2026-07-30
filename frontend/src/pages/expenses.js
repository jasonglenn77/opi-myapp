// Project expense schedule panel (Projects hub Phase 2, Billing & Schedule).
// Planned non-labor outflows (materials, rentals, lodging, propane, travel),
// each dated so they feed the cashflow. "Seed from estimate" pre-populates from
// the estimate's per-item cost lines.
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";

const money = (n) => (n == null || n === "" ? "—" : "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const STATUS = [["planned", "Planned"], ["ordered", "Ordered"], ["paid", "Paid"]];

export async function mountExpensePanel(container, entityId) {
  container.innerHTML = `<div class="text-sm text-black/40 py-3">Loading expenses…</div>`;
  let data;
  try {
    data = await api(`/expenses/project/${encodeURIComponent(entityId)}`);
  } catch (e) {
    container.innerHTML = `<div class="text-sm text-red-600 py-3">Failed to load expenses: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }
  const remount = () => mountExpensePanel(container, entityId);
  const items = data.items || [];
  const cats = data.categories || [];
  const catOpts = (sel) => cats.map((c) => `<option value="${escapeHtml(c)}" ${sel === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
  const seedTotal = data.suggested_total || 0;

  const row = (it) => `
    <tr class="border-b border-black/5" data-eid="${it.id}">
      <td class="py-1.5 pr-2"><select data-f="category" class="input text-xs py-1 w-28">${catOpts(it.category)}</select></td>
      <td class="py-1.5 pr-2"><input data-f="description" value="${escapeHtml(it.description || "")}" placeholder="—" class="input text-xs py-1 w-48"></td>
      <td class="py-1.5 pr-2 text-right"><input data-f="amount" type="number" step="0.01" value="${it.amount ?? ""}" class="input text-xs py-1 w-28 text-right tabular-nums"></td>
      <td class="py-1.5 pr-2"><input data-f="expense_date" type="date" value="${it.expense_date || ""}" class="input text-xs py-1"></td>
      <td class="py-1.5 pr-2"><select data-f="status" class="input text-xs py-1">${STATUS.map(([v, l]) => `<option value="${v}" ${it.status === v ? "selected" : ""}>${l}</option>`).join("")}</select></td>
      <td class="py-1.5 pr-2"><input data-f="note" value="${escapeHtml(it.note || "")}" placeholder="—" class="input text-xs py-1 w-32"></td>
      <td class="py-1.5 text-right"><button data-del class="text-black/30 hover:text-red-600 text-sm" title="Delete">✕</button></td>
    </tr>`;

  const tableOrEmpty = items.length
    ? `<div class="overflow-x-auto"><table class="w-full text-sm" style="min-width:820px;">
        <thead><tr class="text-left text-black/45 border-b border-black/10 text-[11px] uppercase tracking-wide">
          <th class="py-2 pr-2 w-28">Category</th><th class="py-2 pr-2">Description</th><th class="py-2 pr-2 w-28 text-right">Amount</th><th class="py-2 pr-2 w-32">Date</th><th class="py-2 pr-2 w-24">Status</th><th class="py-2 pr-2">Note</th><th class="py-2 w-8"></th>
        </tr></thead><tbody data-rows>${items.map(row).join("")}</tbody></table></div>`
    : `<div class="text-sm text-black/45 px-3 py-3">No expenses yet — add one, or seed from the estimate.</div>`;

  const seedBtn = seedTotal > 0
    ? `<button data-seed class="text-xs font-semibold text-blue-600 hover:underline">Seed from estimate (${money(seedTotal)})</button>` : "";

  container.innerHTML = `
    <div class="rounded-xl border border-black/10 overflow-hidden">
      <div class="px-3 py-2 bg-black/[0.02] border-b border-black/10 flex items-center justify-between gap-3 flex-wrap text-xs">
        <span class="text-black/50">Planned non-labor outflows — materials, rentals, lodging, propane, travel</span>
        <span class="tabular-nums">Total <b>${money(data.total)}</b></span>
      </div>
      ${tableOrEmpty}
      <div class="px-3 py-2 flex items-center justify-between gap-2 border-t border-black/5">
        <button data-add class="text-xs font-semibold text-emerald-700 hover:underline">+ Add expense</button>
        ${seedBtn}
      </div>
    </div>`;

  const rows = container.querySelector("[data-rows]");
  rows?.addEventListener("change", async (e) => {
    const f = e.target.closest("[data-f]"); if (!f) return;
    const eid = f.closest("[data-eid]").getAttribute("data-eid");
    const field = f.getAttribute("data-f");
    const val = f.value;
    const body = { [field]: field === "amount" ? (val === "" ? null : Number(val)) : (val === "" ? null : val) };
    try { await api(`/expenses/item/${eid}`, { method: "PATCH", body: JSON.stringify(body) }); remount(); }
    catch (err) { alert("Save failed: " + (err?.message || err)); }
  });
  rows?.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del]"); if (!del) return;
    const eid = del.closest("[data-eid]").getAttribute("data-eid");
    if (!confirm("Delete this expense?")) return;
    try { await api(`/expenses/item/${eid}`, { method: "DELETE" }); remount(); }
    catch (err) { alert("Delete failed: " + (err?.message || err)); }
  });
  container.querySelector("[data-add]").addEventListener("click", async () => {
    try { await api(`/expenses/project/${encodeURIComponent(entityId)}/item`, { method: "POST" }); remount(); }
    catch (e) { alert(e?.message || e); }
  });
  container.querySelector("[data-seed]")?.addEventListener("click", async () => {
    try { await api(`/expenses/project/${encodeURIComponent(entityId)}/seed`, { method: "POST" }); remount(); }
    catch (e) { alert(e?.message || e); }
  });
}
