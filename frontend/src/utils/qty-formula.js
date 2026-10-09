// Excel-style QTY formulas for quoting-metrics lines ("=500*10" → 5000).
// Arithmetic only: numbers, + - * / ^ ( ) and %, so nothing else can run.

import { escapeHtml } from "./html.js";

const ALLOWED = /^[0-9+\-*/^().%\s,]*$/;

// Returns { value } for a valid expression, or { error } explaining why not.
export function evalQtyFormula(input) {
  let expr = String(input ?? "").trim();
  if (expr.startsWith("=")) expr = expr.slice(1).trim();
  if (!expr) return { error: "Enter a formula, e.g. =500*10" };
  if (!ALLOWED.test(expr)) return { error: "Use numbers and + − × ÷ ( ) only" };
  const js = expr.replace(/,/g, "").replace(/(\d+(?:\.\d+)?)%/g, "($1/100)").replace(/\^/g, "**");
  let v;
  try { v = Function(`"use strict"; return (${js});`)(); } catch (_) { return { error: "That formula isn't complete" }; }
  if (typeof v !== "number" || !Number.isFinite(v)) return { error: "Result isn't a number" };
  return { value: Math.round(v * 1000) / 1000, expr };
}

// The QTY cell: a plain text box (no spinner) + the fx button, and the formula
// shown as a note under the number when one was used.
export function qtyCellHtml(qty, formula) {
  const val = qty != null && qty !== "" ? Number(qty) : "";
  return `
    <div class="qm-qty">
      <input type="text" inputmode="decimal" data-row-field="qty" value="${val}" placeholder="0"
             ${formula ? `title="Formula: =${escapeHtml(formula)}"` : ""}/>
      <button type="button" class="qm-fx${formula ? " qm-fx-on" : ""}" data-qty-fx
              title="${formula ? `Formula: =${escapeHtml(formula)} — click to edit` : "Calculate the quantity with a formula, like Excel (=500*10)"}">fx</button>
    </div>
    ${formula ? `<div class="qm-fx-note" title="=${escapeHtml(formula)}">=${escapeHtml(formula)}</div>` : ""}`;
}

// Small modal: type a formula, see the result live, Apply / Remove formula.
export function openQtyFormulaModal({ formula, qty, onApply }) {
  const overlay = document.createElement("div");
  overlay.className = "qm-fx-overlay";
  const start = formula ? `=${formula}` : (qty != null && qty !== "" ? `=${Number(qty)}` : "=");
  overlay.innerHTML = `
    <div class="qm-fx-modal" role="dialog" aria-label="Quantity formula">
      <div class="qm-fx-title">Quantity formula</div>
      <div class="qm-fx-help">Type a formula like Excel — for example <b>=500*10</b> or <b>=(120+80)*2</b>.</div>
      <input type="text" class="qm-fx-input" data-fx-input value="${escapeHtml(start)}" autocomplete="off"/>
      <div class="qm-fx-result" data-fx-result></div>
      <div class="qm-fx-actions">
        ${formula ? `<button type="button" class="qm-fx-btn" data-fx-clear>Remove formula</button>` : ""}
        <span style="flex:1"></span>
        <button type="button" class="qm-fx-btn" data-fx-cancel>Cancel</button>
        <button type="button" class="qm-fx-btn qm-fx-primary" data-fx-apply>Apply</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector("[data-fx-input]");
  const out = overlay.querySelector("[data-fx-result]");
  const close = () => overlay.remove();
  const preview = () => {
    const r = evalQtyFormula(input.value);
    out.textContent = r.error ? r.error : `QTY = ${r.value.toLocaleString("en-US")}`;
    out.style.color = r.error ? "#b91c1c" : "#065f46";
    return r;
  };
  const apply = () => {
    const r = preview();
    if (r.error) return;
    close();
    onApply({ value: r.value, formula: r.expr });
  };
  input.addEventListener("input", preview);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); apply(); }
    if (e.key === "Escape") close();
  });
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("[data-fx-cancel]").addEventListener("click", close);
  overlay.querySelector("[data-fx-apply]").addEventListener("click", apply);
  overlay.querySelector("[data-fx-clear]")?.addEventListener("click", () => {
    close();
    onApply({ value: qty != null && qty !== "" ? Number(qty) : null, formula: null });
  });
  preview();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
