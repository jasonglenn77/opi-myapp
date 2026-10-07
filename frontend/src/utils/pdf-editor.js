// Shared Estimate-PDF model + editor core (2026-10-06, Jason item #5 phase 1).
// Extracted from estimate.js renderPdfTab so the Pipeline's Estimate PDF tab
// and the Change Orders "Fill out an estimate — PDF" flow consume the SAME
// editor (shared, NOT forked — same rule as form-render.js / crew-editor.js).
//
// Model shape (what the /pdf render endpoints consume):
//   { bill_to: "line\nline", sales_rep, preparer, quote_date (YYYY-MM-DD),
//     footer_title, lines: [{ label, description, qty, rate, amount }] }
import { escapeHtml } from "./html.js";

export const pdfNum = (v) => { const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : 0; };
export const pdfModelTotal = (model) => (model.lines || []).reduce((s, l) => s + pdfNum(l.amount), 0);
export const pdfMoney = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");

// The exact payload shape POST /api/estimates/{id}/pdf (and the change-order
// project-context variant) expects. One builder, every caller.
export function buildPdfPayload(model, saveMode) {
  return {
    lines: (model.lines || []).map(l => ({ label: l.label, description: l.description, qty: pdfNum(l.qty), rate: pdfNum(l.rate), amount: pdfNum(l.amount) })),
    total: pdfModelTotal(model), sales_rep: model.sales_rep, footer_title: model.footer_title,
    preparer: model.preparer, quote_date: model.quote_date,
    bill_to: String(model.bill_to || "").split("\n").map(s => s.trim()).filter(Boolean),
    save: !!saveMode,
  };
}

// Mount the editor UI (header card + item/description/qty/rate/amount rows +
// total + Preview) into `container`. The host owns persistence (onChange) and
// the render endpoint (onPreview). Slots let each host keep its own chrome:
//   hintHtml          left-side helper text (html)
//   toolbar           { html, wire(root, api) } — right of the hint (e.g. Rebuild)
//   actions           { html, wire(root, api) } — buttons BEFORE Preview (e.g. Save)
//   footHtml          note under the action row
// Returns { render, getModel, setModel, setMessage }.
export function mountPdfEditor(container, {
  model, onChange = () => {}, onPreview = null,
  hintHtml = "", toolbar = null, actions = null, footHtml = "",
  previewLabel = "Preview PDF",
} = {}) {
  let msg = "";
  const totalOf = () => pdfModelTotal(model);

  const apiObj = {
    render,
    getModel: () => model,
    setModel: (m) => { model = m; render(); },
    setMessage: (t) => { msg = t || ""; render(); },
  };

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
          <div class="text-[11px] text-black/50">${hintHtml} ${msg ? `<span class="text-emerald-700 font-semibold ml-2">${escapeHtml(msg)}</span>` : ""}</div>
          ${toolbar?.html || ""}
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
            <div class="text-sm">Total <span data-total class="font-extrabold text-ink-900 tabular-nums">${pdfMoney(totalOf())}</span></div>
          </div>
        </div>
        <div class="flex items-center justify-end gap-3 px-1">
          ${actions?.html || ""}
          ${onPreview ? `<button data-preview class="rounded-lg border border-black/15 text-sm font-semibold px-4 py-2 hover:bg-black/5">${escapeHtml(previewLabel)}</button>` : ""}
        </div>
        ${footHtml}
      </div>`;

    container.querySelectorAll("[data-h]").forEach(el => el.addEventListener("input", () => { model[el.getAttribute("data-h")] = el.value; onChange(model); }));
    container.querySelectorAll("[data-l]").forEach(el => el.addEventListener("input", () => {
      const i = Number(el.getAttribute("data-l")), f = el.getAttribute("data-f");
      model.lines[i][f] = el.value; onChange(model);
      if (f === "amount") { const t = container.querySelector("[data-total]"); if (t) t.textContent = pdfMoney(totalOf()); }
    }));
    container.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => { model.lines.splice(Number(b.getAttribute("data-del")), 1); onChange(model); render(); }));
    container.querySelector("[data-add]")?.addEventListener("click", () => { model.lines.push({ label: "", description: "", qty: 1, rate: 0, amount: 0 }); onChange(model); render(); });
    container.querySelector("[data-preview]")?.addEventListener("click", () => onPreview && onPreview(model, apiObj));
    if (toolbar?.wire) toolbar.wire(container, apiObj);
    if (actions?.wire) actions.wire(container, apiObj);
  }

  render();
  return apiObj;
}
