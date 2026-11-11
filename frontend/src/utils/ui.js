// Small shared helpers for pages (dates, money, status chips, tabs, KPI tiles).
// Follows UI-STYLE.md: chips are semantic, tiles are white cards, tabs use .tabs/.tab.
import { escapeHtml as esc } from "./html.js";

export const day = (s) => s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" }) : "—";
export const money0 = (n) => `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n || 0)).toLocaleString()}`;
export const money2 = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const C = {
  bad: "text-rose-700 bg-rose-50 border-rose-200",
  warn: "text-amber-700 bg-amber-50 border-amber-200",
  good: "text-emerald-700 bg-emerald-50 border-emerald-200",
  info: "text-sky-700 bg-sky-50 border-sky-200",
  quiet: "text-slate-600 bg-slate-50 border-slate-200",
};
export const chip = (txt, cls = C.quiet, title = "") =>
  `<span class="inline-flex items-center text-[10px] font-bold rounded px-1.5 py-0.5 border whitespace-nowrap ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(txt)}</span>`;

export const tabs = (items, current, attr = "data-tab", card = false) =>
  `<div class="tabs${card ? " card" : ""}" role="tablist">${items.map(([k, l, n]) =>
    `<button type="button" role="tab" class="tab" ${attr}="${k}" aria-selected="${current === k}">${esc(l)}${n != null ? ` <span class="tab-n">${n}</span>` : ""}</button>`).join("")}</div>`;

// tiles: [{label, value, caption, bad}]  -> a row of white KPI cards
export const kpis = (tiles, cls = "su-kpis") =>
  `<div class="${cls}">${tiles.map((t) => `
    <div class="card su-kpi px-4 py-3"${t.key ? ` data-kpi="${t.key}"` : ""}>
      <div class="text-[11px] font-bold uppercase tracking-wide text-black/55">${esc(t.label)}</div>
      <div class="text-2xl font-extrabold tabular-nums ${t.bad ? "text-rose-600" : "text-ink-900"}">${t.value}</div>
      ${t.caption ? `<div class="text-xs text-black/50">${esc(t.caption)}</div>` : ""}
    </div>`).join("")}</div>`;

export const daysFrom = (s, today = new Date()) => {
  if (!s) return null;
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((d - t) / 86400000);
};

export const projectLink = (qboId, tab) => `#/entity/project/${encodeURIComponent(qboId)}${tab ? `?tab=${tab}` : ""}`;

export function bindTabs(root, attr, fn) {
  root.querySelectorAll(`[${attr}]`).forEach((b) => b.addEventListener("click", () => fn(b.getAttribute(attr))));
}

export const empty = (text) => `<div class="px-4 py-10 text-center text-sm text-black/50">${esc(text)}</div>`;
