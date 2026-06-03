// Base Quoting Metrics page — Steps 2 through 5.
// Three line shapes are now wired:
//   'productivity' — item dropdown (category-filtered) + Qty -> Std/Agg day totals
//   'rental'       — equipment dropdown (optgroup by equipment_type) + Qty
//                    -> Ext cost
//   'free_form'    — Description (text) + Qty + Unit Cost -> Ext cost
// Section order mirrors the workbook flow (Materials -> Contract Labor ->
// Rentals, repeated for Rack Install then Wire Guidance Install, then the
// Wire Guidance Additional Items list).
//
// Labor blocks (Downtime, Mobilization, etc.), Travel Costs, per-set
// attributes, and the Full Costing roll-up land in later steps.
//
// Until the Estimate page persists, this page hardcodes estimate_id = 1.

import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import { api } from "../api.js";

const ESTIMATE_ID = 1;   // TODO: derive from estimate persistence

const SECTIONS = [
  // ── Rack Installation ───────────────────────────────────────────────────
  { code: "materials_rack_install",       kind: "free_form",    title: "Material Costs (Rack Install)" },

  // Rack Installation Contract Labor (productivity shape)
  { code: "teardrop_racking",             kind: "productivity", title: "Teardrop Racking",                  category: "Teardrop Racking" },
  { code: "bolted_racking",               kind: "productivity", title: "Bolted Racking",                    category: "Bolted Racking" },
  { code: "wire_decking",                 kind: "productivity", title: "Wire Decking",                      category: "Wire Decking" },
  { code: "anchors",                      kind: "productivity", title: "Anchors",                           category: "Anchors" },
  { code: "cantilever_racking",           kind: "productivity", title: "Cantilever Racking",                category: "Cantilever Racking" },
  { code: "high_density_storage",         kind: "productivity", title: "High Density Storage Rack",         category: "High Density Storage" },
  { code: "mezz_pick_modules",            kind: "productivity", title: "Mezz and Pick Modules",             category: "Mezz and Pick Modules" },
  { code: "rack_protection",              kind: "productivity", title: "Rack Protection",                   category: "Rack Protection" },
  { code: "safety_netting",               kind: "productivity", title: "Safety Netting / Fall Protection",  category: "Safety Netting" },
  { code: "shelving",                     kind: "productivity", title: "Shelving",                          category: "Shelving" },
  { code: "miscellaneous",                kind: "productivity", title: "Miscellaneous",                     category: "Miscellaneous" },

  { code: "rentals_rack_install",         kind: "rental",       title: "Rentals - Rack Install" },
  { code: "other_rentals_rack_install",   kind: "other_rental", title: "Other Rentals (Rack Install)" },

  // ── Wire Guidance Install ───────────────────────────────────────────────
  { code: "materials_wire_guidance",      kind: "free_form",    title: "Material Costs (Wire Guidance Install)" },
  { code: "wire_guidance_contract_labor", kind: "productivity", title: "Wire Guidance Contract Labor",      category: "Wire Guidance" },
  { code: "rentals_wire_guidance",        kind: "rental",       title: "Rentals - Wire Guidance Install" },
  { code: "other_rentals_wire_guidance",  kind: "other_rental", title: "Other Rentals (Wire Guidance Install)" },

  // ── Additional Items ────────────────────────────────────────────────────
  { code: "wire_guidance_additional",     kind: "free_form",    title: "Wire Guidance Additional Items" },

  // ── Labor blocks ────────────────────────────────────────────────────────
  // Template row labels are auto-seeded by the backend on the Base metric
  // set; they render as ordinary free-form rows here. OH&P and Profit %
  // rows are out of scope for now — they belong with the rollup work.
  { code: "downtime_labor",         kind: "free_form", title: "Downtime (Labor)" },
  { code: "remobilization_labor",   kind: "free_form", title: "Remobilization (Labor)" },
  { code: "dismantle_labor",        kind: "free_form", title: "Dismantle (Labor)" },
  { code: "mobilization_labor",     kind: "free_form", title: "Mobilization (Labor)" },
  { code: "upright_assembly_labor", kind: "free_form", title: "Upright Assembly (Labor)" },
  { code: "anchor_holes_labor",     kind: "free_form", title: "Anchor Holes (Labor)" },
  { code: "wedge_anchors",          kind: "free_form", title: "Wedge Anchors" },
  { code: "miscellaneous_labor",    kind: "free_form", title: "Miscellaneous (Labor)" },
];

export async function baseQuotingMetricsPage(routeFn) {
  // ── data load ──────────────────────────────────────────────────────────────
  let baseSet, productivityItems, rentalItems, allLines, lookups;
  try {
    const [sets, prodItems, rentItems, lk] = await Promise.all([
      api(`/quoting/metric-sets?estimate_id=${ESTIMATE_ID}`),
      api(`/quoting/productivity-rates`),
      api(`/quoting/rental-rates`),
      api(`/quoting/lookup-values`),
    ]);
    baseSet = sets.find(s => s.kind === "base");
    if (!baseSet) throw new Error("Base metric set missing and auto-create failed.");
    productivityItems = prodItems;
    rentalItems       = rentItems;
    lookups           = lk || {};
    allLines = await api(`/quoting/metric-lines?metric_set_id=${baseSet.id}`);
  } catch (err) {
    setShell({
      title: "Base Quoting Metrics",
      bodyHtml: `<div class="card px-5 py-4 text-sm text-red-600">
        Failed to load: ${escapeHtml(err?.message || String(err))}
      </div>`,
      showLogout: true,
      routeFn,
    });
    return;
  }

  // ── per-section state ──────────────────────────────────────────────────────
  // sections[code] = { config, items, itemById, groupedItems?, rows }
  //   - productivity sections: items filtered by category
  //   - rental sections:       items = ALL rental rates; groupedItems = items
  //                            grouped by equipment_type for the optgroup UI
  //   - free_form sections:    no items catalog — user types everything
  // Unsaved rows have id === null until the row is saveable + saves succeed.
  const sections = {};
  const linesByCode = allLines.reduce((acc, l) => {
    (acc[l.section_code] ||= []).push(l);
    return acc;
  }, {});

  for (const cfg of SECTIONS) {
    let items = [];
    let groupedItems = null;
    if (cfg.kind === "productivity") {
      items = productivityItems
        .filter(p => p.category === cfg.category)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    } else if (cfg.kind === "rental") {
      items = rentalItems.slice();
      groupedItems = items.reduce((acc, r) => {
        (acc[r.equipment_type] ||= []).push(r);
        return acc;
      }, {});
    }
    // free_form sections have no catalog.
    sections[cfg.code] = {
      config:   cfg,
      items,
      itemById: new Map(items.map(p => [p.id, p])),
      groupedItems,
      rows:     (linesByCode[cfg.code] || []).map(l => ({ ...l, _saving: false })),
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  const fmt = (n, digits = 2) => {
    if (n === null || n === undefined || n === "") return "—";
    const v = Number(n);
    if (Number.isNaN(v)) return "—";
    return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };
  const fmtMoney = (n) => {
    if (n === null || n === undefined || n === "") return "—";
    const v = Number(n);
    if (Number.isNaN(v)) return "—";
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  function rentalOptionLabel(r) {
    const parts = [];
    if (r.power_source) parts.push(r.power_source);
    if (r.size_class)   parts.push(r.size_class);
    parts.push(r.duration);
    return `${parts.join(" / ")} — ${fmtMoney(r.price)}`;
  }

  function sectionTotals(code) {
    const section = sections[code];
    if (section.config.kind === "productivity") {
      let std = 0, agg = 0;
      for (const r of section.rows) {
        if (r.std_total != null) std += Number(r.std_total);
        if (r.agg_total != null) agg += Number(r.agg_total);
      }
      return { std, agg };
    }
    // rental + free_form + other_rental all sum ext_cost
    let ext = 0;
    for (const r of section.rows) {
      if (r.ext_cost != null) ext += Number(r.ext_cost);
    }
    return { ext };
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  function lineRowHtmlProductivity(code, row, idx) {
    const section = sections[code];
    const item = row.productivity_rate_id ? section.itemById.get(row.productivity_rate_id) : null;
    const stdPerDay = item ? item.standard_per_day : (row.productivity_std_per_day ?? null);
    const aggPerDay = item ? item.aggressive_per_day : (row.productivity_agg_per_day ?? null);

    const itemOptions =
      `<option value="" ${!row.productivity_rate_id ? "selected" : ""}>< Select ></option>` +
      section.items.map(p =>
        `<option value="${p.id}" ${row.productivity_rate_id === p.id ? "selected" : ""}>${escapeHtml(p.item_name)}</option>`
      ).join("");

    return `
      <tr data-row-idx="${idx}" class="border-b border-black/5 last:border-b-0">
        <td class="py-1 pr-2">
          <select class="input text-sm py-1.5 w-full" data-row-field="productivity_rate_id">
            ${itemOptions}
          </select>
        </td>
        <td class="py-1 px-2 w-24">
          <input type="number" step="any" min="0" class="input text-sm py-1.5 w-full text-right tabular-nums"
                 data-row-field="qty"
                 value="${row.qty != null ? Number(row.qty) : ""}"
                 placeholder="0"/>
        </td>
        <td class="py-1 px-2 w-28 text-right tabular-nums text-black/60">${fmt(stdPerDay, 0)}</td>
        <td class="py-1 px-2 w-28 text-right tabular-nums text-black/60">${fmt(aggPerDay, 0)}</td>
        <td class="py-1 px-2 w-28 text-right tabular-nums font-semibold" data-row-cell="std_total">${fmt(row.std_total, 3)}</td>
        <td class="py-1 px-2 w-28 text-right tabular-nums font-semibold" data-row-cell="agg_total">${fmt(row.agg_total, 3)}</td>
        <td class="py-1 pl-2 w-10 text-right">
          <button type="button" data-row-delete
                  class="text-xs text-black/40 hover:text-red-600 px-1.5 py-0.5 rounded"
                  title="Delete row">✕</button>
        </td>
      </tr>`;
  }

  function lineRowHtmlRental(code, row, idx) {
    const section = sections[code];
    const item = row.rental_rate_id ? section.itemById.get(row.rental_rate_id) : null;
    const unitPrice = item ? item.price : (row.rental_price ?? null);

    const groups = section.groupedItems || {};
    const optGroupsHtml = Object.keys(groups).map(eq => {
      const opts = groups[eq].map(r =>
        `<option value="${r.id}" ${row.rental_rate_id === r.id ? "selected" : ""}>${escapeHtml(rentalOptionLabel(r))}</option>`
      ).join("");
      return `<optgroup label="${escapeHtml(eq)}">${opts}</optgroup>`;
    }).join("");

    const placeholderSelected = !row.rental_rate_id ? "selected" : "";

    return `
      <tr data-row-idx="${idx}" class="border-b border-black/5 last:border-b-0">
        <td class="py-1 pr-2">
          <select class="input text-sm py-1.5 w-full" data-row-field="rental_rate_id">
            <option value="" ${placeholderSelected}>< Select ></option>
            ${optGroupsHtml}
          </select>
        </td>
        <td class="py-1 px-2 w-24">
          <input type="number" step="any" min="0" class="input text-sm py-1.5 w-full text-right tabular-nums"
                 data-row-field="qty"
                 value="${row.qty != null ? Number(row.qty) : ""}"
                 placeholder="0"/>
        </td>
        <td class="py-1 px-2 w-32 text-right tabular-nums text-black/60">${fmtMoney(unitPrice)}</td>
        <td class="py-1 px-2 w-32 text-right tabular-nums font-semibold" data-row-cell="ext_cost">${fmtMoney(row.ext_cost)}</td>
        <td class="py-1 pl-2 w-10 text-right">
          <button type="button" data-row-delete
                  class="text-xs text-black/40 hover:text-red-600 px-1.5 py-0.5 rounded"
                  title="Delete row">✕</button>
        </td>
      </tr>`;
  }

  function lineRowHtmlOtherRental(code, row, idx) {
    const qty = row.qty != null && row.qty !== "" ? Number(row.qty) : null;
    const mobs = row.mobilizations != null && row.mobilizations !== "" ? Number(row.mobilizations) : null;
    const extQty = (qty != null && mobs != null) ? qty * mobs : null;
    return `
      <tr data-row-idx="${idx}" class="border-b border-black/5 last:border-b-0">
        <td class="py-1 pr-2">
          <input type="text" class="input text-sm py-1.5 w-full"
                 data-row-field="label"
                 value="${escapeHtml(row.label ?? "")}"
                 placeholder="Enter description"/>
        </td>
        <td class="py-1 px-2 w-20">
          <input type="number" step="any" min="0" class="input text-sm py-1.5 w-full text-right tabular-nums"
                 data-row-field="qty"
                 value="${qty ?? ""}"
                 placeholder="0"/>
        </td>
        <td class="py-1 px-2 w-20">
          <input type="number" step="0.5" min="0" class="input text-sm py-1.5 w-full text-right tabular-nums"
                 data-row-field="mobilizations"
                 value="${mobs ?? ""}"
                 placeholder="1"/>
        </td>
        <td class="py-1 px-2 w-20 text-right tabular-nums text-black/60" data-row-cell="ext_qty">${fmt(extQty, 2)}</td>
        <td class="py-1 px-2 w-28">
          <input type="number" step="0.01" min="0" class="input text-sm py-1.5 w-full text-right tabular-nums"
                 data-row-field="unit_price"
                 value="${row.unit_price != null ? Number(row.unit_price) : ""}"
                 placeholder="0.00"/>
        </td>
        <td class="py-1 px-2 w-28 text-right tabular-nums font-semibold" data-row-cell="ext_cost">${fmtMoney(row.ext_cost)}</td>
        <td class="py-1 pl-2 w-10 text-right">
          <button type="button" data-row-delete
                  class="text-xs text-black/40 hover:text-red-600 px-1.5 py-0.5 rounded"
                  title="Delete row">✕</button>
        </td>
      </tr>`;
  }

  function lineRowHtmlFreeForm(code, row, idx) {
    return `
      <tr data-row-idx="${idx}" class="border-b border-black/5 last:border-b-0">
        <td class="py-1 pr-2">
          <input type="text" class="input text-sm py-1.5 w-full"
                 data-row-field="label"
                 value="${escapeHtml(row.label ?? "")}"
                 placeholder="Enter description"/>
        </td>
        <td class="py-1 px-2 w-24">
          <input type="number" step="any" min="0" class="input text-sm py-1.5 w-full text-right tabular-nums"
                 data-row-field="qty"
                 value="${row.qty != null ? Number(row.qty) : ""}"
                 placeholder="0"/>
        </td>
        <td class="py-1 px-2 w-32">
          <input type="number" step="0.01" min="0" class="input text-sm py-1.5 w-full text-right tabular-nums"
                 data-row-field="unit_price"
                 value="${row.unit_price != null ? Number(row.unit_price) : ""}"
                 placeholder="0.00"/>
        </td>
        <td class="py-1 px-2 w-32 text-right tabular-nums font-semibold" data-row-cell="ext_cost">${fmtMoney(row.ext_cost)}</td>
        <td class="py-1 pl-2 w-10 text-right">
          <button type="button" data-row-delete
                  class="text-xs text-black/40 hover:text-red-600 px-1.5 py-0.5 rounded"
                  title="Delete row">✕</button>
        </td>
      </tr>`;
  }

  function lineRowHtml(code, row, idx) {
    const kind = sections[code].config.kind;
    if (kind === "rental")       return lineRowHtmlRental(code, row, idx);
    if (kind === "free_form")    return lineRowHtmlFreeForm(code, row, idx);
    if (kind === "other_rental") return lineRowHtmlOtherRental(code, row, idx);
    return lineRowHtmlProductivity(code, row, idx);
  }

  function tableHtml(code) {
    const section = sections[code];
    const rows = section.rows;
    const kind = section.config.kind;

    let headerCols, colCount, footerHtml;
    const totals = sectionTotals(code);

    if (kind === "rental") {
      headerCols = `
        <th class="text-left  font-semibold py-2 pr-2">Equipment / Tier</th>
        <th class="text-right font-semibold py-2 px-2 w-24">Qty</th>
        <th class="text-right font-semibold py-2 px-2 w-32">Unit Price</th>
        <th class="text-right font-semibold py-2 px-2 w-32">Ext Cost</th>
        <th class="py-2 pl-2 w-10"></th>`;
      colCount = 5;
      footerHtml = `
        <tr class="border-t border-black/10 bg-black/[0.02]">
          <td class="py-2 pr-2 text-right text-xs font-semibold text-black/60" colspan="3">Section Total</td>
          <td class="py-2 px-2 text-right tabular-nums font-bold" data-section-total="ext">${fmtMoney(totals.ext)}</td>
          <td></td>
        </tr>`;
    } else if (kind === "free_form") {
      headerCols = `
        <th class="text-left  font-semibold py-2 pr-2">Description</th>
        <th class="text-right font-semibold py-2 px-2 w-24">Qty</th>
        <th class="text-right font-semibold py-2 px-2 w-32">Unit Cost</th>
        <th class="text-right font-semibold py-2 px-2 w-32">Ext Cost</th>
        <th class="py-2 pl-2 w-10"></th>`;
      colCount = 5;
      footerHtml = `
        <tr class="border-t border-black/10 bg-black/[0.02]">
          <td class="py-2 pr-2 text-right text-xs font-semibold text-black/60" colspan="3">Section Total</td>
          <td class="py-2 px-2 text-right tabular-nums font-bold" data-section-total="ext">${fmtMoney(totals.ext)}</td>
          <td></td>
        </tr>`;
    } else if (kind === "other_rental") {
      headerCols = `
        <th class="text-left  font-semibold py-2 pr-2">Item</th>
        <th class="text-right font-semibold py-2 px-2 w-20">Qty</th>
        <th class="text-right font-semibold py-2 px-2 w-20"># Mobs</th>
        <th class="text-right font-semibold py-2 px-2 w-20">Ext Qty</th>
        <th class="text-right font-semibold py-2 px-2 w-28">Cost</th>
        <th class="text-right font-semibold py-2 px-2 w-28">Extended</th>
        <th class="py-2 pl-2 w-10"></th>`;
      colCount = 7;
      footerHtml = `
        <tr class="border-t border-black/10 bg-black/[0.02]">
          <td class="py-2 pr-2 text-right text-xs font-semibold text-black/60" colspan="5">Section Total</td>
          <td class="py-2 px-2 text-right tabular-nums font-bold" data-section-total="ext">${fmtMoney(totals.ext)}</td>
          <td></td>
        </tr>`;
    } else {
      // productivity
      headerCols = `
        <th class="text-left  font-semibold py-2 pr-2">Item</th>
        <th class="text-right font-semibold py-2 px-2 w-24">Qty</th>
        <th class="text-right font-semibold py-2 px-2 w-28">Std Daily Prod</th>
        <th class="text-right font-semibold py-2 px-2 w-28">Agg Daily Prod</th>
        <th class="text-right font-semibold py-2 px-2 w-28">Std Day Total</th>
        <th class="text-right font-semibold py-2 px-2 w-28">Agg Day Total</th>
        <th class="py-2 pl-2 w-10"></th>`;
      colCount = 7;
      footerHtml = `
        <tr class="border-t border-black/10 bg-black/[0.02]">
          <td class="py-2 pr-2 text-right text-xs font-semibold text-black/60" colspan="4">Section Total (days)</td>
          <td class="py-2 px-2 text-right tabular-nums font-bold" data-section-total="std">${fmt(totals.std, 3)}</td>
          <td class="py-2 px-2 text-right tabular-nums font-bold" data-section-total="agg">${fmt(totals.agg, 3)}</td>
          <td></td>
        </tr>`;
    }

    const rowsHtml = rows.length
      ? rows.map((r, i) => lineRowHtml(code, r, i)).join("")
      : `<tr><td colspan="${colCount}" class="py-3 text-center text-sm text-black/40">No lines yet — click "+ Add line" below.</td></tr>`;

    return `
      <table class="w-full text-sm" data-section-table>
        <thead>
          <tr class="text-[11px] uppercase tracking-wide text-black/50 border-b border-black/10">${headerCols}</tr>
        </thead>
        <tbody data-section-body-rows>${rowsHtml}</tbody>
        <tfoot>${footerHtml}</tfoot>
      </table>`;
  }

  function sectionCardHtml(code) {
    const cfg = sections[code].config;
    // Default-expand only if the user has *meaningful* data in the section.
    // Labor blocks come pre-seeded with template labels (label-only rows) —
    // those shouldn't force the card open. Real data = a picked item, a qty,
    // or a unit price.
    const hasData = sections[code].rows.some(r =>
      r.productivity_rate_id != null ||
      r.rental_rate_id != null ||
      (r.qty        != null && r.qty        !== "") ||
      (r.unit_price != null && r.unit_price !== "")
    );
    const bodyClass = hasData ? "pt-3" : "pt-3 hidden";
    const chevronClass = hasData ? "" : "-rotate-90";
    let sub;
    if      (cfg.kind === "rental")    sub = "Qty × unit price = ext cost";
    else if (cfg.kind === "free_form") sub = "Qty × unit cost = ext cost";
    else                               sub = "Qty ÷ daily production = days";
    return `
      <div class="card px-5 py-4" data-section data-section-host data-section-code="${cfg.code}" data-section-kind="${cfg.kind}">
        <button type="button" data-section-toggle
                class="w-full flex items-center justify-between gap-3 pb-2 border-b border-black/10 text-left cursor-pointer select-none">
          <span class="flex items-baseline gap-3">
            <span class="text-sm font-extrabold uppercase tracking-wide text-black/70">${escapeHtml(cfg.title)}</span>
            <span class="text-[11px] italic text-black/40">${sub}</span>
          </span>
          <svg class="w-4 h-4 text-black/40 shrink-0 transition-transform ${chevronClass}" data-section-chevron
               fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </button>

        <div class="${bodyClass}" data-section-body>
          <div data-section-host-table>${tableHtml(code)}</div>
          <div class="pt-3">
            <button type="button" data-add-row
                    class="text-xs font-semibold text-blue-600 hover:text-blue-800 px-2 py-1 rounded hover:bg-blue-50">
              + Add line
            </button>
          </div>
        </div>
      </div>`;
  }

  function renderTable(code) {
    const host = document.querySelector(`[data-section-code="${code}"] [data-section-host-table]`);
    if (host) host.innerHTML = tableHtml(code);
  }

  function renderTotalsOnly(code) {
    const root = document.querySelector(`[data-section-code="${code}"]`);
    if (!root) return;
    const totals = sectionTotals(code);
    const kind = sections[code].config.kind;
    if (kind === "rental" || kind === "free_form" || kind === "other_rental") {
      const e = root.querySelector('[data-section-total="ext"]');
      if (e) e.textContent = fmtMoney(totals.ext);
    } else {
      const s = root.querySelector('[data-section-total="std"]');
      const a = root.querySelector('[data-section-total="agg"]');
      if (s) s.textContent = fmt(totals.std, 3);
      if (a) a.textContent = fmt(totals.agg, 3);
    }
  }

  function renderRowComputed(code, idx) {
    const root = document.querySelector(`[data-section-code="${code}"]`);
    if (!root) return;
    const tr = root.querySelector(`tr[data-row-idx="${idx}"]`);
    if (!tr) return;
    const section = sections[code];
    const row = section.rows[idx];
    const cells = tr.querySelectorAll("td");
    const kind = section.config.kind;

    if (kind === "rental") {
      const item = row.rental_rate_id ? section.itemById.get(row.rental_rate_id) : null;
      if (cells.length >= 4) {
        cells[2].textContent = fmtMoney(item ? item.price : null);
        cells[3].textContent = fmtMoney(row.ext_cost);
      }
    } else if (kind === "free_form") {
      // For free-form rows the only computed cell is ext_cost (cell index 3).
      // qty/unit_price are bound inputs and update themselves on user edit.
      if (cells.length >= 4) {
        cells[3].textContent = fmtMoney(row.ext_cost);
      }
    } else if (kind === "other_rental") {
      // Cells: 0=label, 1=qty, 2=mobs, 3=ext_qty (computed), 4=unit_price,
      //        5=ext_cost (computed), 6=delete
      const qty  = row.qty != null && row.qty !== "" ? Number(row.qty) : null;
      const mobs = row.mobilizations != null && row.mobilizations !== "" ? Number(row.mobilizations) : null;
      const extQty = (qty != null && mobs != null) ? qty * mobs : null;
      if (cells.length >= 6) {
        cells[3].textContent = fmt(extQty, 2);
        cells[5].textContent = fmtMoney(row.ext_cost);
      }
    } else {
      const item = row.productivity_rate_id ? section.itemById.get(row.productivity_rate_id) : null;
      if (cells.length >= 6) {
        cells[2].textContent = fmt(item ? item.standard_per_day : null, 0);
        cells[3].textContent = fmt(item ? item.aggressive_per_day : null, 0);
        cells[4].textContent = fmt(row.std_total, 3);
        cells[5].textContent = fmt(row.agg_total, 3);
      }
    }
    renderTotalsOnly(code);
  }

  // ── persistence ────────────────────────────────────────────────────────────
  function localComputeTotals(code, row) {
    const section = sections[code];
    const kind = section.config.kind;

    if (kind === "rental") {
      const item = row.rental_rate_id ? section.itemById.get(row.rental_rate_id) : null;
      if (!item || row.qty == null || row.qty === "") { row.ext_cost = null; return; }
      const q = Number(row.qty);
      if (Number.isNaN(q)) { row.ext_cost = null; return; }
      row.ext_cost = +(q * Number(item.price)).toFixed(2);
      return;
    }

    if (kind === "free_form") {
      if (row.qty == null || row.qty === "" || row.unit_price == null || row.unit_price === "") {
        row.ext_cost = null;
        return;
      }
      const q = Number(row.qty);
      const u = Number(row.unit_price);
      if (Number.isNaN(q) || Number.isNaN(u)) { row.ext_cost = null; return; }
      row.ext_cost = +(q * u).toFixed(2);
      return;
    }

    if (kind === "other_rental") {
      if (row.qty == null || row.qty === "" || row.unit_price == null || row.unit_price === "") {
        row.ext_cost = null;
        return;
      }
      const q = Number(row.qty);
      const u = Number(row.unit_price);
      const m = (row.mobilizations != null && row.mobilizations !== "") ? Number(row.mobilizations) : 1;
      if (Number.isNaN(q) || Number.isNaN(u) || Number.isNaN(m)) { row.ext_cost = null; return; }
      row.ext_cost = +(q * m * u).toFixed(2);
      return;
    }

    // productivity
    const item = row.productivity_rate_id ? section.itemById.get(row.productivity_rate_id) : null;
    if (!item || row.qty == null || row.qty === "") {
      row.std_total = null;
      row.agg_total = null;
      return;
    }
    const q = Number(row.qty);
    if (Number.isNaN(q)) { row.std_total = null; row.agg_total = null; return; }
    row.std_total = item.standard_per_day   ? +(q / Number(item.standard_per_day)).toFixed(3)   : null;
    row.agg_total = item.aggressive_per_day ? +(q / Number(item.aggressive_per_day)).toFixed(3) : null;
  }

  function rowIsSaveable(code, row) {
    const kind = sections[code].config.kind;
    if (kind === "rental")       return row.rental_rate_id != null && row.qty != null && row.qty !== "";
    if (kind === "free_form" || kind === "other_rental")
                                 return row.label != null && String(row.label).trim() !== "";
    return row.productivity_rate_id != null && row.qty != null && row.qty !== "";
  }

  function buildPayload(code, row, sortOrder) {
    const kind = sections[code].config.kind;
    const labelKinds = (kind === "free_form" || kind === "other_rental");
    const priceKinds = (kind === "free_form" || kind === "other_rental");
    return {
      metric_set_id:        baseSet.id,
      section_code:         code,
      line_kind:            kind,
      sort_order:           sortOrder,
      productivity_rate_id: kind === "productivity" ? row.productivity_rate_id : null,
      rental_rate_id:       kind === "rental"       ? row.rental_rate_id       : null,
      label:                labelKinds              ? (row.label ?? null)      : null,
      qty:                  row.qty != null && row.qty !== "" ? Number(row.qty) : null,
      mobilizations:        kind === "other_rental" && row.mobilizations != null && row.mobilizations !== ""
                              ? Number(row.mobilizations) : null,
      unit_price:           priceKinds && row.unit_price != null && row.unit_price !== ""
                              ? Number(row.unit_price) : null,
      notes:                null,
    };
  }

  async function persistRow(code, idx) {
    const row = sections[code].rows[idx];
    if (!rowIsSaveable(code, row)) return;
    if (row._saving) return;
    row._saving = true;
    try {
      if (row.id == null) {
        const created = await api("/quoting/metric-lines", {
          method: "POST",
          body:   JSON.stringify(buildPayload(code, row, idx)),
        });
        sections[code].rows[idx] = { ...created, _saving: false };
      } else {
        const updated = await api(`/quoting/metric-lines/${row.id}`, {
          method: "PUT",
          body:   JSON.stringify(buildPayload(code, row, idx)),
        });
        sections[code].rows[idx] = { ...updated, _saving: false };
      }
      renderRowComputed(code, idx);
      renderTravelCosts();
      renderCostSummary();
      renderBundleOutput();
    } catch (err) {
      console.error("Failed to save line", err);
      row._saving = false;
      alert("Failed to save: " + (err?.message || err));
    }
  }

  async function deleteRow(code, idx) {
    const row = sections[code].rows[idx];
    if (row.id != null) {
      try {
        await api(`/quoting/metric-lines/${row.id}`, { method: "DELETE" });
      } catch (err) {
        alert("Failed to delete: " + (err?.message || err));
        return;
      }
    }
    sections[code].rows.splice(idx, 1);
    renderTable(code);
    renderTravelCosts();
    renderCostSummary();
    renderBundleOutput();
  }

  function addEmptyRow(code) {
    const kind = sections[code].config.kind;
    sections[code].rows.push({
      id:                   null,
      productivity_rate_id: null,
      rental_rate_id:       null,
      label:                null,
      qty:                  null,
      mobilizations:        kind === "other_rental" ? 1 : null,
      unit_price:           null,
      std_total:            null,
      agg_total:            null,
      ext_cost:             null,
      _saving:              false,
    });
    renderTable(code);
    const root = document.querySelector(`[data-section-code="${code}"]`);
    const idx = sections[code].rows.length - 1;
    const focusField =
      kind === "rental"       ? "rental_rate_id" :
      kind === "free_form"    ? "label" :
      kind === "other_rental" ? "label" :
                                "productivity_rate_id";
    root?.querySelector(`tr[data-row-idx="${idx}"] [data-row-field="${focusField}"]`)?.focus();
  }

  // ── Tab Settings (per-set attributes) ──────────────────────────────────────
  // Mirror of the BASE sheet's top input cluster (rows 17-29) + Day Type
  // Override mini-table (rows 20-23, cols J-M). Saved via PATCH on every
  // change. The values feed Step 7b (Travel Costs computation) and the
  // bundle roll-up later.
  const attrs = {
    estimate_type_override:           baseSet.estimate_type_override ?? "",
    installation_environment:         baseSet.installation_environment ?? "Ambient",
    wire_guidance_linear_footage:     baseSet.wire_guidance_linear_footage ?? 0,
    scissor_lifts_per_crew:           baseSet.scissor_lifts_per_crew ?? 0,
    forklifts_per_crew:               baseSet.forklifts_per_crew ?? 0,
    scrubbers_per_wire_scope:         baseSet.scrubbers_per_wire_scope ?? 1,
    saws_per_wire_scope:              baseSet.saws_per_wire_scope ?? 0,
    rack_install_labor_day_override:  baseSet.rack_install_labor_day_override,
    rack_install_project_time_adder:  baseSet.rack_install_project_time_adder,
    rack_install_buffer_day_counter:  baseSet.rack_install_buffer_day_counter,
    wire_guidance_labor_day_override: baseSet.wire_guidance_labor_day_override,
    wire_guidance_project_time_adder: baseSet.wire_guidance_project_time_adder,
    wire_guidance_buffer_day_counter: baseSet.wire_guidance_buffer_day_counter,
    downtime_labor_day_override:      baseSet.downtime_labor_day_override,
    travel_labor_day_override:        baseSet.travel_labor_day_override,
  };

  const ESTIMATE_TYPE_OPTS = (lookups.estimate_type      || []).map(r => r.key);
  const ENV_FACTOR_OPTS    = (lookups.environment_factor || []);   // {key, value_num}

  // Environment factor (1.0 / 1.5 / 2.0) for the currently-selected env.
  function currentEnvFactor() {
    const row = ENV_FACTOR_OPTS.find(o => o.key === attrs.installation_environment);
    return row ? row.value_num : null;
  }

  // Number-or-blank helper for nullable day-override inputs.
  const numVal = (v) => (v === null || v === undefined || v === "" ? "" : Number(v));

  function selectAttrHtml(key, options, opts = {}) {
    const placeholder = opts.placeholder || "";
    const placeholderOpt = placeholder
      ? `<option value="" ${!attrs[key] ? "selected" : ""}>${escapeHtml(placeholder)}</option>`
      : "";
    return `
      <select class="input text-sm py-1.5 w-full" data-attr-field="${key}">
        ${placeholderOpt}
        ${options.map(o => {
          const val = typeof o === "object" ? o.key : o;
          const lab = typeof o === "object" ? o.key : o;
          const sel = String(attrs[key] ?? "") === String(val) ? "selected" : "";
          return `<option value="${escapeHtml(val)}" ${sel}>${escapeHtml(lab)}</option>`;
        }).join("")}
      </select>`;
  }

  function numAttrHtml(key, opts = {}) {
    const step = opts.step || "any";
    const placeholder = opts.placeholder || "";
    return `
      <input type="number" step="${step}" class="input text-sm py-1.5 w-full text-right tabular-nums"
             data-attr-field="${key}"
             value="${numVal(attrs[key])}"
             placeholder="${escapeHtml(placeholder)}"/>`;
  }

  function attrLabel(text) {
    return `<label class="text-[11px] font-semibold text-black/60">${escapeHtml(text)}</label>`;
  }

  function dayOverrideRow(dayType, label, hasAdder, hasBuffer) {
    const overrideKey = `${dayType}_labor_day_override`;
    const adderKey    = `${dayType}_project_time_adder`;
    const bufferKey   = `${dayType}_buffer_day_counter`;
    const naCell = `<td class="py-1 px-2 text-center text-xs text-black/30">n/a</td>`;
    return `
      <tr>
        <td class="py-1 px-2 text-xs font-semibold text-black/70">${escapeHtml(label)}</td>
        <td class="py-1 px-2 w-28">${numAttrHtml(overrideKey, { step: "0.5", placeholder: "—" })}</td>
        ${hasAdder  ? `<td class="py-1 px-2 w-28">${numAttrHtml(adderKey,    { step: "0.5", placeholder: "—" })}</td>` : naCell}
        ${hasBuffer ? `<td class="py-1 px-2 w-28">${numAttrHtml(bufferKey,   { step: "0.5", placeholder: "—" })}</td>` : naCell}
      </tr>`;
  }

  function tabSettingsHtml() {
    const factor = currentEnvFactor();
    return `
      <div class="card px-5 py-4" data-tab-settings>
        <div class="flex items-baseline justify-between gap-3 pb-2 border-b border-black/10">
          <span class="text-sm font-extrabold uppercase tracking-wide text-black/70">Tab Settings</span>
          <span class="text-[11px] italic text-black/40">Per-set overrides + day type adjustments</span>
        </div>

        <div class="pt-4 grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3">

          <!-- Left column -->
          <div class="flex flex-col gap-3">
            <div class="grid grid-cols-[1fr_1fr] gap-x-3 gap-y-3 items-center">
              ${attrLabel("Estimate Type Override")}
              ${selectAttrHtml("estimate_type_override", ESTIMATE_TYPE_OPTS, { placeholder: "Inherit from Roll Up" })}

              ${attrLabel("Installation Environment")}
              <div class="flex items-center gap-2">
                ${selectAttrHtml("installation_environment", ENV_FACTOR_OPTS)}
                <span class="text-[11px] text-black/40 whitespace-nowrap" data-env-factor>
                  factor ${factor != null ? Number(factor).toFixed(1) : "—"}
                </span>
              </div>

              ${attrLabel("Wire Guidance Linear Footage")}
              ${numAttrHtml("wire_guidance_linear_footage", { step: "1", placeholder: "0" })}

              ${attrLabel("Mobilizations Per Option")}
              ${numAttrHtml("mobilizations", { step: "0.5", placeholder: "0" })}
            </div>
          </div>

          <!-- Right column: per-crew counts -->
          <div class="flex flex-col gap-3">
            <div class="text-[11px] font-semibold uppercase tracking-wide text-black/40">Per-Crew Equipment</div>
            <div class="grid grid-cols-[1fr_1fr] gap-x-3 gap-y-3 items-center">
              ${attrLabel("Scissor Lifts Per Crew")}
              ${numAttrHtml("scissor_lifts_per_crew", { step: "1", placeholder: "0" })}

              ${attrLabel("Forklifts Per Crew")}
              ${numAttrHtml("forklifts_per_crew", { step: "1", placeholder: "0" })}

              ${attrLabel("Scrubbers Per Wire Scope")}
              ${numAttrHtml("scrubbers_per_wire_scope", { step: "1", placeholder: "0" })}

              ${attrLabel("Saws Per Wire Scope")}
              ${numAttrHtml("saws_per_wire_scope", { step: "1", placeholder: "0" })}
            </div>
          </div>
        </div>

        <div class="pt-5">
          <div class="text-[11px] font-semibold uppercase tracking-wide text-black/40 pb-2">Day Type Override</div>
          <table class="w-full text-sm">
            <thead>
              <tr class="text-[11px] uppercase tracking-wide text-black/50 border-b border-black/10">
                <th class="text-left  font-semibold py-2 px-2">Day Type</th>
                <th class="text-left  font-semibold py-2 px-2 w-28">Labor Day Override</th>
                <th class="text-left  font-semibold py-2 px-2 w-28">Project Time Adder</th>
                <th class="text-left  font-semibold py-2 px-2 w-28">Buffer Day Counter</th>
              </tr>
            </thead>
            <tbody>
              ${dayOverrideRow("rack_install",  "Rack Install",  true,  true)}
              ${dayOverrideRow("wire_guidance", "Wire Guidance", true,  true)}
              ${dayOverrideRow("downtime",      "Downtime",      false, false)}
              ${dayOverrideRow("travel",        "Travel",        false, false)}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  // The mobilizations field lives on the parent set, not in `attrs`, but we
  // surface it in the Tab Settings UI for convenience. Sync it into `attrs`
  // so the change handler treats it uniformly.
  attrs.mobilizations = baseSet.mobilizations ?? 0;

  // ── Travel Costs (computed) ────────────────────────────────────────────────
  // Replicates the BASE sheet's row 32-35 formulas. Pulls Estimate inputs
  // from localStorage (temporary bridge — see estimate.js publishEstimateState).
  const ESTIMATE_BRIDGE_KEY = "opi_estimate_state_v1";
  function readEstimateBridge() {
    try {
      const raw = localStorage.getItem(ESTIMATE_BRIDGE_KEY);
      return raw ? JSON.parse(raw) || {} : {};
    } catch { return {}; }
  }

  function lookupValueNum(category, key) {
    const rows = lookups[category];
    if (!Array.isArray(rows) || !key) return null;
    const row = rows.find(r => r.key === key);
    return (row && row.value_num != null) ? Number(row.value_num) : null;
  }

  // Mirrors the Estimate page's step-function lookup (Travel Days Per Crew,
  // Per Mobilization). >38 hrs = error; we return 0 for the computation.
  function travelDaysFromHrs(hrs) {
    if (hrs == null || hrs === "") return 0;
    const h = Number(hrs);
    if (Number.isNaN(h) || h > 38) return 0;
    const rows = lookups.project_travel_day_calculator;
    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const eligible = rows
      .map(r => ({ threshold: Number(r.key), value: r.value_num }))
      .filter(r => !Number.isNaN(r.threshold) && r.value != null && r.threshold <= h)
      .sort((a, b) => b.threshold - a.threshold);
    return eligible.length ? Number(eligible[0].value) * 2 : 0;
  }

  // Section codes that feed the "Rack Contract Labor" rollup (H44).
  const RACK_LABOR_SECTIONS = [
    "teardrop_racking", "bolted_racking", "wire_decking", "anchors",
    "cantilever_racking", "high_density_storage", "mezz_pick_modules",
    "rack_protection", "safety_netting", "shelving", "miscellaneous",
  ];

  function sumProductivityDays(sectionCodes, useAgg) {
    let sum = 0;
    for (const code of sectionCodes) {
      const section = sections[code];
      if (!section) continue;
      for (const row of section.rows) {
        const val = useAgg ? row.agg_total : row.std_total;
        if (val != null) sum += Number(val);
      }
    }
    return sum;
  }

  function sumSectionExtCosts(sectionCode) {
    const section = sections[sectionCode];
    if (!section) return 0;
    let sum = 0;
    for (const row of section.rows) {
      if (row.ext_cost != null) sum += Number(row.ext_cost);
    }
    return sum;
  }

  const ceilingHalf = (x) => Math.ceil(Number(x) * 2) / 2;

  function computeTravelCosts() {
    const est = readEstimateBridge();
    const travel_hrs = Number(est.one_way_travel_hrs ?? 0) || 0;
    const crew_count = Number(est.crew_count ?? 0) || 0;
    const crew_size_key = est.crew_size || "";
    const lodging_cost_per_day = Number(est.lodging_cost_per_day ?? 0) || 0;
    const mgmt_pct_pts = Number(est.mgmt_travel_multiplier ?? 0) || 0;  // percentage points
    const mgmt_pct = mgmt_pct_pts / 100;

    // Labor Cost / Day formula = (OOT or Local) / 5 × crew_size value_num.
    // Same logic as estimate.js. Returns 0 if any input is missing.
    const oot   = lookupValueNum("labor_crew_cost", "Out of Town");
    const local = lookupValueNum("labor_crew_cost", "Local");
    const crew_size_num = lookupValueNum("crew_size", crew_size_key);
    let labor_cost_per_day = 0;
    if (travel_hrs > 0 && crew_size_num != null && oot != null && local != null) {
      labor_cost_per_day = ((travel_hrs > 1 ? oot : local) / 5) * crew_size_num;
    }
    const labor_cost_per_travel_day = labor_cost_per_day;
    const travel_days_per_crew = travelDaysFromHrs(travel_hrs);

    // Per-set override of estimate type takes priority over the Roll Up's.
    const estimate_type = attrs.estimate_type_override || est.estimate_type || "Standard";
    const useAgg = estimate_type === "Aggressive";

    // Section rollups
    const rack_days  = sumProductivityDays(RACK_LABOR_SECTIONS, useAgg);
    const wire_days  = sumProductivityDays(["wire_guidance_contract_labor"], useAgg);
    const mat_rack   = sumSectionExtCosts("materials_rack_install");
    const mat_wire   = sumSectionExtCosts("materials_wire_guidance");

    // Per-set attributes
    const mobilizations = Number(attrs.mobilizations ?? 0) || 0;
    const env_factor    = Number(currentEnvFactor() ?? 1) || 1;

    const overrideOrNull = (v) => (v != null && v !== "" && Number(v) > 0) ? Number(v) : null;
    const numOr0         = (v) => Number(v ?? 0) || 0;

    const travel_override = overrideOrNull(attrs.travel_labor_day_override);
    const rack_override   = overrideOrNull(attrs.rack_install_labor_day_override);
    const rack_adder      = numOr0(attrs.rack_install_project_time_adder);
    const wire_override   = overrideOrNull(attrs.wire_guidance_labor_day_override);
    const wire_adder      = numOr0(attrs.wire_guidance_project_time_adder);

    // D22 TAB Travel Days
    const D22 = travel_override != null
      ? travel_override
      : travel_days_per_crew * crew_count * mobilizations;

    // D23/D24 Tab Labor Days (Rack / Wire), each ceilinged to 0.5
    const D23_input = (rack_override != null ? rack_override + rack_adder : rack_days + rack_adder);
    const D24_input = (wire_override != null ? wire_override + wire_adder : wire_days + wire_adder);
    const D23 = ceilingHalf(D23_input * env_factor);
    const D24 = ceilingHalf(D24_input * env_factor);

    // G33 Lodging
    const lodging = D22 > 0 ? (D22 + D23 + D24) * lodging_cost_per_day : 0;

    // Section dollar rollups
    const H44 = rack_days * labor_cost_per_day;            // Rack Contract Labor $
    const H39 = mat_rack;                                  // Materials, Rack Install $
    const H214 = mat_wire;                                 // Materials, Wire Guidance $
    const H220 = wire_days * labor_cost_per_day;           // Wire Guidance Contract Labor $

    // Other top-level section dollar totals (workbook L5 sum components).
    const H187 = sumSectionExtCosts("rentals_rack_install");   // Rentals - Rack Install $
    const H226 = sumSectionExtCosts("rentals_wire_guidance");  // Rentals - Wire Guidance $
    const H248 = sumSectionExtCosts("wire_guidance_additional"); // WG Additional Items $

    // G35 Travel Day Costs
    const G35 = labor_cost_per_travel_day * D22;

    // G34 Mgmt Travel — the workbook's IF(D13=1400,0,...) collapses to "no
    // mgmt travel when Labor Cost / Day is exactly $1,400" (Local rate ×
    // Full crew: 1400/5*5 = 1400). Anything else pays mgmt travel.
    const no_mgmt_travel = labor_cost_per_day === 1400;
    const mgmt_travel = no_mgmt_travel
      ? 0
      : (H44 + H39 + lodging + H214 + H220 + G35) * mgmt_pct;

    // H32 section total (Travel Costs)
    const section_total = lodging + mgmt_travel + G35;

    // Top-level bundle totals that feed the workbook's cost-checker.
    //   H38  = Rack Installation bundle (materials + contract labor)
    //   H213 = Wire Guidance Labor bundle (materials + contract labor)
    //   H32 / H187 / H226 / H248 are already standalone totals
    //   L5   = grand total (sum of the 6 top-level section totals)
    const H38  = H39 + H44;
    const H213 = H214 + H220;
    const grand_total = section_total + H38 + H187 + H213 + H226 + H248;

    return {
      estimate_type, useAgg,
      labor_cost_per_day, labor_cost_per_travel_day, travel_days_per_crew,
      rack_days, wire_days, mat_rack, mat_wire,
      mobilizations, env_factor,
      D22, D23, D24,
      H44, H39, H214, H220, H187, H226, H248,
      H38, H213,
      lodging, mgmt_travel, travel_day_costs: G35,
      section_total,
      grand_total,
      // surface the inputs back to the UI for the "Inputs" column
      lodging_cost_per_day, mgmt_pct_pts, crew_count,
      hrs_out_of_range: Number(travel_hrs) > 38,
    };
  }

  // ── Cost Summary card ──────────────────────────────────────────────────────
  // Mirrors the workbook's "Cost Checker" (BASE sheet L4:N5) — a sanity-check
  // total across the 6 top-level sections that feed the project cost.
  function costSummaryCardHtml() {
    const tc = computeTravelCosts();
    const row = (label, value, opts = {}) => `
      <div class="grid grid-cols-[1fr_auto] gap-x-3 py-1.5 ${opts.divider ? "border-t border-black/10 mt-1 pt-2" : ""}">
        <span class="text-sm ${opts.bold ? "font-bold" : "text-black/70"}">${escapeHtml(label)}</span>
        <span class="text-sm tabular-nums ${opts.bold ? "font-bold" : "font-semibold"}">${fmtMoney(value)}</span>
      </div>`;
    return `
      <div class="flex items-baseline justify-between gap-3 pb-2 border-b border-black/10">
        <span class="text-sm font-extrabold uppercase tracking-wide text-black/70">Cost Summary</span>
        <span class="text-[11px] italic text-black/40">Cost checker · ${escapeHtml(tc.estimate_type)} estimate</span>
      </div>
      <div class="pt-3 grid grid-cols-1 lg:grid-cols-2 gap-x-8">
        <div>
          ${row("Travel Costs (H32)", tc.section_total)}
          ${row("Rack Installation (H38)", tc.H38)}
          <div class="pl-6 text-xs">
            ${row("Materials (H39)", tc.H39)}
            ${row("Contract Labor (H44)", tc.H44)}
          </div>
          ${row("Rentals - Rack Install (H187)", tc.H187)}
        </div>
        <div>
          ${row("Wire Guidance Labor (H213)", tc.H213)}
          <div class="pl-6 text-xs">
            ${row("Materials (H214)", tc.H214)}
            ${row("Contract Labor (H220)", tc.H220)}
          </div>
          ${row("Rentals - Wire Guidance (H226)", tc.H226)}
          ${row("Wire Guidance Add'l Items (H248)", tc.H248)}
          ${row("PROJECT COST TOTAL", tc.grand_total, { bold: true, divider: true })}
        </div>
      </div>
    `;
  }

  function renderCostSummary() {
    const card = document.querySelector("[data-cost-summary]");
    if (card) card.innerHTML = costSummaryCardHtml();
  }

  // ── QuickBooks Bundle Output ───────────────────────────────────────────────
  // Decodes the BASE sheet's S-column bundle formulas. Each sub-line is
  // ceiling'd to the nearest $10 (matches workbook).
  //
  // Key intermediate: M20 / M21 — "buffer days" added by the Project Time
  // Adder on the day-type override. The workbook computes them as:
  //   M20 = ceil_half((override>0 ? override : rack_days) + adder) × env)
  //       − ceil_half((override>0 ? override : rack_days)            × env)
  // i.e., the extra days the Project Time Adder introduces. Defaults to 0
  // when no adder is set. Same shape for M21 (Wire Guidance).
  const ceil10   = (x) => Math.ceil(Number(x) / 10) * 10;
  const ceilHalf = (x) => Math.ceil(Number(x) * 2) / 2;
  const isYes    = (s) => String(s ?? "").toLowerCase() === "yes";
  const isNo     = (s) => String(s ?? "").toLowerCase() === "no";

  function computeBufferDays(override, adder, baseDays, envFactor) {
    const ovr   = (override != null && Number(override) > 0) ? Number(override) : null;
    const base  = ovr != null ? ovr : Number(baseDays || 0);
    const a     = Number(adder || 0);
    const env   = Number(envFactor || 1);
    return ceilHalf((base + a) * env) - ceilHalf(base * env);
  }

  // Markup helper: a/(1-p) - a   (i.e., "what you add on top to hit margin p").
  const markup = (amount, pct) => {
    const denom = 1 - pct;
    if (denom === 0) return 0;
    return amount / denom - amount;
  };

  // WG Additional Items: map free-form rows to the 4 known categories by
  // case-insensitive substring match on the user-entered label.
  function wgAdditionalLine(needle) {
    const section = sections["wire_guidance_additional"];
    if (!section) return 0;
    const n = needle.toLowerCase();
    let sum = 0;
    for (const row of section.rows) {
      const lbl = String(row.label || "").toLowerCase();
      if (lbl.includes(n) && row.ext_cost != null) sum += Number(row.ext_cost);
    }
    return sum;
  }

  // Sum Other Rentals rows whose label contains a given keyword. Used to
  // split the section total into the workbook's S11/S12/S13/S22 buckets.
  function sumOtherRentalsByLabel(sectionCode, needle) {
    const section = sections[sectionCode];
    if (!section) return 0;
    const n = needle.toLowerCase();
    let sum = 0;
    for (const row of section.rows) {
      const lbl = String(row.label || "").toLowerCase();
      if (lbl.includes(n) && row.ext_cost != null) sum += Number(row.ext_cost);
    }
    return sum;
  }

  function computeAllBundles() {
    const tc  = computeTravelCosts();
    const est = readEstimateBridge();

    // Section dollar totals (existing)
    const H44 = tc.H44;
    const H39 = tc.H39;
    const H214 = tc.H214;
    const H220 = tc.H220;
    const H187 = tc.H187;
    const H226 = tc.H226;
    const H248 = tc.H248;

    // Other intermediates
    const G34 = tc.mgmt_travel;
    const G35 = tc.travel_day_costs;
    const D13 = tc.labor_cost_per_day;
    const D15 = tc.lodging_cost_per_day;
    const D21 = Number(est.one_way_travel_hrs ?? 0) || 0;
    const D22 = tc.D22;
    const D23 = tc.D23;
    const D24 = tc.D24;
    const mobs = tc.mobilizations;
    const env  = tc.env_factor;
    const rack_days = tc.rack_days;
    const wire_days = tc.wire_days;

    // M20 / M21 buffer days (computed from per-set day-type overrides).
    const rack_override = attrs.rack_install_labor_day_override;
    const rack_adder    = attrs.rack_install_project_time_adder;
    const wire_override = attrs.wire_guidance_labor_day_override;
    const wire_adder    = attrs.wire_guidance_project_time_adder;
    const M20 = computeBufferDays(rack_override, rack_adder, rack_days, env);
    const M21 = computeBufferDays(wire_override, wire_adder, wire_days, env);

    // Estimate inputs
    const breakOutMob = est.breaking_out_mobilization;
    const rack_profit_pct  = (Number(est.rack_install_profit_target  ?? 0) || 0) / 100;
    const rent_rack_pct    = (Number(est.rental_rack_profit_target   ?? 0) || 0) / 100;
    const mob_profit_pct   = (Number(est.mobilization_profit_target  ?? 0) || 0) / 100;
    const wg_profit_pct    = (Number(est.wire_guidance_profit_target ?? 0) || 0) / 100;
    const rent_wire_pct    = (Number(est.rental_wire_profit_target   ?? 0) || 0) / 100;
    const downtime_target  = D21 > 1 ? 3500 : 3000;   // Roll Up G24

    // ── Installation Labor Bundle (S3–S9) ───────────────────────────────────
    let S4_raw = 0;
    if (H44 > 0) {
      S4_raw = isYes(breakOutMob) ? (H44 - M20 * D13) : (H44 - M20 * D13 + G35);
    }
    const S4 = ceil10(S4_raw);
    const S5 = ceil10(H39);
    const S6 = ceil10(S4 === 0 ? 0 : G34);
    const S7 = ceil10(M20 * D13 / (1 - rack_profit_pct || 1));
    const S8 = ceil10(
      S4 !== 0 && D21 > 1
        ? (isNo(breakOutMob) ? (D22 + D23) * D15 : D23 * D15)
        : 0
    );
    const U4 = ceil10(D23 * D13 - M20 * D13);
    const T4 = ceil10(U4 === 0 ? 0 : G35);
    const U8 = ceil10(D23 * D15);
    const T8 = ceil10(U8 === 0 ? 0 : ((D22 + D23) * D15 - U8));
    const ilb_sub = S4 + S5 + S6 + S8;
    let S9;
    if (isYes(breakOutMob)) {
      S9 = ceil10(markup(ilb_sub, rack_profit_pct));
    } else {
      S9 = ceil10(
        ((ilb_sub - T4 - T8) / (1 - rack_profit_pct || 1))
          + ((T4 + T8) / (1 - mob_profit_pct || 1))
          - ilb_sub
      );
    }
    const ilb_total = S4 + S5 + S6 + S7 + S8 + S9;

    // ── Rentals Bundle (S10–S14) ────────────────────────────────────────────
    // S11 = regular rack rentals + "Other Rentals (Rack Install)" rows
    //       EXCEPT Dumpster (→ S12) and Liquid Propane (→ S13).
    // S12 = Dumpster row(s) from Other Rentals (Rack)
    // S13 = Liquid Propane row(s) from Other Rentals (Rack)
    const otherRackDumpster = sumOtherRentalsByLabel("other_rentals_rack_install", "dumpster");
    const otherRackPropane  = sumOtherRentalsByLabel("other_rentals_rack_install", "propane");
    const otherRackRest     = sumSectionExtCosts("other_rentals_rack_install") - otherRackDumpster - otherRackPropane;
    const S11 = ceil10(H187 + otherRackRest);
    const S12 = ceil10(otherRackDumpster);
    const S13 = ceil10(otherRackPropane);
    const S14 = ceil10((S11 + S12) / (1 - rent_rack_pct || 1) + S13 - (S11 + S12 + S13));
    const rentals_total = S11 + S12 + S13 + S14;

    // ── Wire Guidance Labor Bundle (S15–S23) ────────────────────────────────
    // S16 Contract Labor:
    //   IF(BreakOutMob=NO, G35 + H220 - M21*D13 - IF(S4>0, G35, 0),
    //                       H220 - M21*D13)
    let S16_raw;
    if (isNo(breakOutMob)) {
      S16_raw = G35 + H220 - M21 * D13 - (S4 > 0 ? G35 : 0);
    } else {
      S16_raw = H220 - M21 * D13;
    }
    const S16 = ceil10(S16_raw);
    const S17 = ceil10(H214);
    // S18 Mgmt Travel: workbook uses IF(S4=0, IF(S16=0,0,G34))
    // — IF without false branch defaults to 0 when S4 != 0.
    let S18_raw = 0;
    if (S4 === 0 && S16 !== 0) S18_raw = G34;
    const S18 = ceil10(S18_raw);
    // S19 Lodging = CEIL10(T19 + U19)  where:
    //   T16 = IF(BreakOutMob=No AND D23=0, G35, 0)
    //   T19 = IF(T16>0, (D22+D23)*D15 - U8, 0)
    //   U19 = CEIL10(D24 * D15)
    const T16 = (isNo(breakOutMob) && D23 === 0) ? G35 : 0;
    const T19 = T16 > 0 ? ((D22 + D23) * D15 - U8) : 0;
    const U19 = ceil10(D24 * D15);
    const S19 = ceil10(T19 + U19);
    const S20 = ceil10(M21 * D13 / (1 - rack_profit_pct || 1));
    // S21 = WG rentals + "Other Rentals (WG)" rows EXCEPT Liquid Propane.
    // S22 = Liquid Propane row(s) from Other Rentals (WG).
    const otherWgPropane = sumOtherRentalsByLabel("other_rentals_wire_guidance", "propane");
    const otherWgRest    = sumSectionExtCosts("other_rentals_wire_guidance") - otherWgPropane;
    const S21 = ceil10(H226 + otherWgRest);
    const S22 = ceil10(otherWgPropane);
    // S23 OH&P: WG markup on (S16,S17,S18,S19) at WG profit %, plus S21 at
    // rental_wire profit %, less the subtotal. The split for non-breaking-out-
    // mob also moves (T16+T19) to mobilization profit.
    const wglb_sub = S16 + S17 + S18 + S19;
    let S23;
    if (isYes(breakOutMob)) {
      S23 = ceil10(
        markup(wglb_sub, wg_profit_pct) + markup(S21, rent_wire_pct)
      );
    } else {
      S23 = ceil10(
        ((wglb_sub - T16 - T19) / (1 - wg_profit_pct || 1))
          + ((T16 + T19) / (1 - mob_profit_pct || 1))
          - wglb_sub
          + markup(S21, rent_wire_pct)
      );
    }
    const wglb_total = S16 + S17 + S18 + S19 + S20 + S21 + S22 + S23;

    // ── Wire Guidance Additional Items (S24–S29) ────────────────────────────
    const slurry  = wgAdditionalLine("slurry");
    const lineDrv = wgAdditionalLine("line driver");
    const magnet  = wgAdditionalLine("magnet");
    const rfid    = wgAdditionalLine("rfid");
    const S25 = ceil10(slurry);
    const S26 = ceil10(lineDrv);
    const S27 = ceil10(magnet);
    const S28 = ceil10(rfid);
    const wga_sub = S25 + S26 + S27 + S28;
    // Workbook quirk: if the sub equals exactly 600 the OH&P is forced to 400;
    // otherwise standard 40% markup.
    const S29 = ceil10(
      wga_sub === 600 ? 400 : (wga_sub / (1 - 0.40) - wga_sub)
    );
    const wga_total = S25 + S26 + S27 + S28 + S29;

    // ── Mobilization (S30–S35) ──────────────────────────────────────────────
    // S31 (Materials) — workbook leaves this as a static 0; we mirror that.
    const avg_mobs = mobs > 0 ? mobs : 0;   // single-set view: rack==wire
    const has_mobs = avg_mobs > 0;
    const S31 = 0;
    const S32 = has_mobs && isYes(breakOutMob) ? ceil10(G35 / avg_mobs) : 0;
    const S33 = (S18 + S6 === 0) ? ceil10(G34) : 0;
    const S34 = has_mobs && isYes(breakOutMob) ? ceil10((D22 / avg_mobs) * D15) : 0;
    const mob_sub = S31 + S32 + S33 + S34;
    const S35 = ceil10(markup(mob_sub, mob_profit_pct));
    const mob_total = S31 + S32 + S33 + S34 + S35;

    // ── Remobilization (S36–S41) ────────────────────────────────────────────
    // Each line = Mobilization line × (mobs − 1). Zero when mobs ≤ 1.
    const extra = Math.max(0, avg_mobs - 1);
    const has_extra = extra > 0;
    const S37 = has_extra ? ceil10(S31 * extra) : 0;
    const S38 = has_extra ? ceil10(S32 * extra) : 0;
    const S39 = has_extra ? ceil10(S33 * extra) : 0;
    const S40 = has_extra ? ceil10(S34 * extra) : 0;
    const S41 = has_extra ? ceil10(S35 * extra) : 0;
    const remob_total = S37 + S38 + S39 + S40 + S41;

    // ── Downtime (S42–S47) ──────────────────────────────────────────────────
    // Per-set Downtime Day Override K22 drives the bundle. Materials (S43)
    // and Mgmt Travel (S45) are static 0 in the workbook.
    const K22 = Number(attrs.downtime_labor_day_override ?? 0) || 0;
    const S43 = 0;   // Materials (static in workbook)
    const S44 = ceil10(ceilHalf(K22) * D13);
    const S45 = 0;   // Mgmt Travel (static in workbook)
    const S46 = S44 > 0 ? ceil10(Math.ceil(K22) * D15) : 0;
    const S47 = S44 > 0
      ? ceil10(ceilHalf(K22) * downtime_target - (S43 + S44 + S45 + S46))
      : 0;
    const downtime_total = S43 + S44 + S45 + S46 + S47;

    return {
      installation: {
        title: "Installation (Labor Bundle)",
        total: ilb_total,
        lines: [
          ["Contract Labor", S4],
          ["Materials",      S5],
          ["Mgmt Travel",    S6],
          ["Buffer",         S7],
          ["Lodging",        S8],
          ["OH&P",           S9],
        ],
      },
      rentals: {
        title: "Rentals (Bundle)",
        total: rentals_total,
        lines: [
          ["Equipment - Lifts",        S11],
          ["Dumpsters / Site Rentals", S12],
          ["Propane",                  S13],
          ["OH&P",                     S14],
        ],
      },
      wg_labor: {
        title: "Wire Guidance (Labor Bundle)",
        total: wglb_total,
        lines: [
          ["Contract Labor", S16],
          ["Materials",      S17],
          ["Mgmt Travel",    S18],
          ["Lodging",        S19],
          ["Buffer",         S20],
          ["Floor Scrubber", S21],
          ["Propane",        S22],
          ["OH&P",           S23],
        ],
      },
      wg_additional: {
        title: "Wire Guidance (Additional Items)",
        total: wga_total,
        lines: [
          ["Slurry Tank",  S25],
          ["Line Drivers", S26],
          ["Magnets",      S27],
          ["RFID Tags",    S28],
          ["OH&P",         S29],
        ],
      },
      mobilization: {
        title: "Mobilization",
        total: mob_total,
        lines: [
          ["Materials",              S31, { stub: true }],
          ["Contract Labor - Travel", S32],
          ["Mgmt Travel",            S33],
          ["Lodging",                S34],
          ["OH&P",                   S35],
        ],
      },
      remobilization: {
        title: "Remobilization",
        total: remob_total,
        note: `× ${extra} extra mobilization${extra === 1 ? "" : "s"}`,
        lines: [
          ["Materials",              S37, { stub: true }],
          ["Contract Labor - Travel", S38],
          ["Mgmt Travel",            S39],
          ["Lodging",                S40],
          ["OH&P",                   S41],
        ],
      },
      downtime: {
        title: "Downtime",
        total: downtime_total,
        lines: [
          ["Materials",      S43, { stub: true }],
          ["Contract Labor", S44],
          ["Mgmt Travel",    S45, { stub: true }],
          ["Lodging",        S46],
          ["OH&P",           S47],
        ],
      },
    };
  }

  function bundleOutputCardHtml() {
    const b = computeAllBundles();
    const renderBundle = (bundle) => {
      const subRow = ([label, value, opts = {}]) => `
        <div class="grid grid-cols-[1fr_auto] gap-x-3 py-0.5 pl-4">
          <span class="text-xs ${opts.stub ? "text-black/30 italic" : "text-black/60"}">${escapeHtml(label)}${opts.stub ? " *" : ""}</span>
          <span class="text-xs tabular-nums ${opts.stub ? "text-black/30" : ""}">${fmtMoney(value)}</span>
        </div>`;
      const note = bundle.note
        ? `<span class="text-[10px] text-black/40 italic">${escapeHtml(bundle.note)}</span>`
        : "";
      return `
        <div class="pb-3">
          <div class="grid grid-cols-[1fr_auto] gap-x-3 py-1.5 border-b border-black/10 mb-1">
            <span class="text-sm font-bold text-black/80 flex items-baseline gap-2">
              ${escapeHtml(bundle.title)} ${note}
            </span>
            <span class="text-sm tabular-nums font-bold">${fmtMoney(bundle.total)}</span>
          </div>
          ${bundle.lines.map(subRow).join("")}
        </div>`;
    };
    return `
      <div class="flex items-baseline justify-between gap-3 pb-2 border-b border-black/10">
        <span class="text-sm font-extrabold uppercase tracking-wide text-black/70">QuickBooks Bundle Output</span>
        <span class="text-[11px] italic text-black/40">Per-bundle line items · ceilings to $10 · * = not yet modeled (0)</span>
      </div>
      <div class="pt-3 grid grid-cols-1 lg:grid-cols-2 gap-x-8">
        <div>
          ${renderBundle(b.installation)}
          ${renderBundle(b.rentals)}
          ${renderBundle(b.wg_labor)}
          ${renderBundle(b.wg_additional)}
        </div>
        <div>
          ${renderBundle(b.mobilization)}
          ${renderBundle(b.remobilization)}
          ${renderBundle(b.downtime)}
        </div>
      </div>
    `;
  }

  function renderBundleOutput() {
    const card = document.querySelector("[data-bundle-output]");
    if (card) card.innerHTML = bundleOutputCardHtml();
  }

  function travelCostsCardHtml() {
    const tc = computeTravelCosts();
    const warn = tc.labor_cost_per_day === 0
      ? `<div class="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
           Labor Cost / Day is 0 — set <strong>One-Way Travel time</strong> + <strong>Crew Size</strong> on the Estimate page to populate Travel Costs.
         </div>`
      : "";
    const oorWarn = tc.hrs_out_of_range
      ? `<div class="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
           One-Way Travel exceeds 38 hours — Travel Days fall back to 0. Verify the value on the Estimate page.
         </div>`
      : "";
    return `
      <div class="flex items-baseline justify-between gap-3 pb-2 border-b border-black/10">
        <span class="text-sm font-extrabold uppercase tracking-wide text-black/70">Travel Costs</span>
        <span class="text-[11px] italic text-black/40">Computed · ${escapeHtml(tc.estimate_type)} estimate</span>
      </div>

      <div class="pt-4 grid grid-cols-1 lg:grid-cols-3 gap-x-6 gap-y-4 text-sm">

        <div>
          <div class="text-[11px] font-semibold uppercase tracking-wide text-black/40 pb-2">Tab Days (this set)</div>
          <div class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            <span class="text-black/60">Travel Days (D22)</span>      <span class="tabular-nums">${fmt(tc.D22, 1)}</span>
            <span class="text-black/60">Labor Days, Rack (D23)</span> <span class="tabular-nums">${fmt(tc.D23, 1)}</span>
            <span class="text-black/60">Labor Days, Wire (D24)</span> <span class="tabular-nums">${fmt(tc.D24, 1)}</span>
          </div>
        </div>

        <div>
          <div class="text-[11px] font-semibold uppercase tracking-wide text-black/40 pb-2">Estimate Inputs</div>
          <div class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            <span class="text-black/60">Labor Cost / Day</span>     <span class="tabular-nums">${fmtMoney(tc.labor_cost_per_day)}</span>
            <span class="text-black/60">Lodging / Day</span>        <span class="tabular-nums">${fmtMoney(tc.lodging_cost_per_day)}</span>
            <span class="text-black/60">Mgmt Travel Mult.</span>    <span class="tabular-nums">${fmt(tc.mgmt_pct_pts, 5)}%</span>
            <span class="text-black/60">Crew Count</span>           <span class="tabular-nums">${tc.crew_count}</span>
            <span class="text-black/60">Mobilizations</span>        <span class="tabular-nums">${fmt(tc.mobilizations, 1)}</span>
            <span class="text-black/60">Env Factor</span>           <span class="tabular-nums">${fmt(tc.env_factor, 1)}</span>
          </div>
        </div>

        <div>
          <div class="text-[11px] font-semibold uppercase tracking-wide text-black/40 pb-2">Travel Costs (output)</div>
          <div class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            <span class="text-black/60">Lodging</span>           <span class="tabular-nums">${fmtMoney(tc.lodging)}</span>
            <span class="text-black/60">Mgmt Travel</span>       <span class="tabular-nums">${fmtMoney(tc.mgmt_travel)}</span>
            <span class="text-black/60">Travel Day Costs</span>  <span class="tabular-nums">${fmtMoney(tc.travel_day_costs)}</span>
            <span class="col-span-2 border-t border-black/10 my-1"></span>
            <span class="font-bold">Section Total</span>         <span class="tabular-nums font-bold">${fmtMoney(tc.section_total)}</span>
          </div>
        </div>
      </div>

      ${warn}
      ${oorWarn}
    `;
  }

  function renderTravelCosts() {
    const card = document.querySelector("[data-travel-costs]");
    if (card) card.innerHTML = travelCostsCardHtml();
  }

  async function persistAttr(field, value) {
    try {
      const updated = await api(`/quoting/metric-sets/${baseSet.id}`, {
        method: "PATCH",
        body:   JSON.stringify({ [field]: value }),
      });
      // Refresh the baseSet copy so re-renders use server-authoritative values.
      Object.assign(baseSet, updated);
      renderTravelCosts();
      renderCostSummary();
      renderBundleOutput();
    } catch (err) {
      console.error("Failed to save attribute", field, err);
      alert("Failed to save: " + (err?.message || err));
    }
  }

  // ── page HTML ──────────────────────────────────────────────────────────────
  const bodyHtml = `
    <div class="grid grid-cols-1 gap-3 pb-3">

      <div class="card px-5 py-3">
        <div class="flex items-baseline justify-between gap-3">
          <div>
            <div class="text-base font-extrabold">Base Quoting Metrics</div>
            <div class="text-xs text-black/50">
              Estimate #${ESTIMATE_ID} · Base set ID ${baseSet.id} · Tab Settings · Materials · Contract Labor · Rentals · Add-ons
            </div>
          </div>
          <div class="text-[11px] text-black/40 whitespace-nowrap">B155.1 · Step 7a</div>
        </div>
      </div>

      ${tabSettingsHtml()}

      <div class="card px-5 py-4" data-cost-summary>
        ${costSummaryCardHtml()}
      </div>

      <div class="card px-5 py-4" data-travel-costs>
        ${travelCostsCardHtml()}
      </div>

      <div class="card px-5 py-4" data-bundle-output>
        ${bundleOutputCardHtml()}
      </div>

      ${SECTIONS.map(s => sectionCardHtml(s.code)).join("")}

    </div>`;

  setShell({
    title:    "",
    subtitle: "",
    bodyHtml,
    showLogout: true,
    routeFn,
  });

  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => {
      if (pageTitleBlock) pageTitleBlock.style.display = "";
    }, { once: true });
  }

  // ── input wiring ───────────────────────────────────────────────────────────
  function ctxFromEvent(e) {
    const host = e.target.closest("[data-section-host]");
    if (!host) return null;
    const code = host.getAttribute("data-section-code");
    if (!code || !sections[code]) return null;
    const tr = e.target.closest("tr[data-row-idx]");
    if (!tr) return { code, idx: null };
    const idx = Number(tr.getAttribute("data-row-idx"));
    return { code, idx: Number.isNaN(idx) ? null : idx };
  }

  function onFieldChange(e) {
    // Per-set attribute selects (estimate_type_override, installation_environment).
    const attrField = e.target.getAttribute?.("data-attr-field");
    if (attrField) {
      const v = e.target.value;
      attrs[attrField] = v === "" ? null : v;
      // Live-update the env factor readout when the env selection changes.
      if (attrField === "installation_environment") {
        const factor = currentEnvFactor();
        const span = document.querySelector("[data-env-factor]");
        if (span) span.textContent = "factor " + (factor != null ? Number(factor).toFixed(1) : "—");
      }
      persistAttr(attrField, attrs[attrField]);
      return;
    }

    const field = e.target.getAttribute?.("data-row-field");
    if (!field) return;
    const ctx = ctxFromEvent(e);
    if (!ctx || ctx.idx == null) return;
    const row = sections[ctx.code].rows[ctx.idx];

    if (field === "productivity_rate_id" || field === "rental_rate_id") {
      const v = e.target.value;
      row[field] = v === "" ? null : Number(v);
      localComputeTotals(ctx.code, row);
      renderRowComputed(ctx.code, ctx.idx);
      persistRow(ctx.code, ctx.idx);
    }
  }

  function onFieldInput(e) {
    // Per-set attribute number inputs.
    const attrField = e.target.getAttribute?.("data-attr-field");
    if (attrField) {
      const raw = e.target.value;
      const v = raw === "" ? null : Number(raw);
      attrs[attrField] = v;
      persistAttr(attrField, v);
      return;
    }

    const field = e.target.getAttribute?.("data-row-field");
    if (!field) return;
    const ctx = ctxFromEvent(e);
    if (!ctx || ctx.idx == null) return;
    const row = sections[ctx.code].rows[ctx.idx];

    if (field === "qty") {
      row.qty = e.target.value === "" ? null : Number(e.target.value);
    } else if (field === "unit_price") {
      row.unit_price = e.target.value === "" ? null : Number(e.target.value);
    } else if (field === "mobilizations") {
      row.mobilizations = e.target.value === "" ? null : Number(e.target.value);
    } else if (field === "label") {
      row.label = e.target.value;
    } else {
      return;
    }

    localComputeTotals(ctx.code, row);
    renderRowComputed(ctx.code, ctx.idx);
    persistRow(ctx.code, ctx.idx);
  }

  function onClick(e) {
    const toggle = e.target.closest("[data-section-toggle]");
    if (toggle) {
      const card = toggle.closest("[data-section]");
      const body = card?.querySelector("[data-section-body]");
      if (body) {
        const collapsed = body.classList.toggle("hidden");
        const chevron = toggle.querySelector("[data-section-chevron]");
        if (chevron) chevron.classList.toggle("-rotate-90", collapsed);
      }
      return;
    }

    if (e.target.closest("[data-add-row]")) {
      const ctx = ctxFromEvent(e);
      if (ctx) addEmptyRow(ctx.code);
      return;
    }
    if (e.target.closest("[data-row-delete]")) {
      const ctx = ctxFromEvent(e);
      if (ctx && ctx.idx != null) deleteRow(ctx.code, ctx.idx);
    }
  }

  document.addEventListener("change", onFieldChange);
  document.addEventListener("input",  onFieldInput);
  document.addEventListener("click",  onClick);

  // Live-update Travel Costs when the Estimate page (potentially open in
  // another tab) writes to localStorage. The 'storage' event only fires in
  // OTHER tabs, not the writer — that's by design.
  function onStorage(e) {
    if (e.key === ESTIMATE_BRIDGE_KEY) {
      renderTravelCosts();
      renderCostSummary();
      renderBundleOutput();
    }
  }
  window.addEventListener("storage", onStorage);

  window.addEventListener("hashchange", () => {
    document.removeEventListener("change", onFieldChange);
    document.removeEventListener("input",  onFieldInput);
    document.removeEventListener("click",  onClick);
    window.removeEventListener("storage", onStorage);
  }, { once: true });
}
