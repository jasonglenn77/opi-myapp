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
import { computeSetRollup, computeSetBundles } from "../utils/qm-rollup.js";

// Estimate id is passed in by the caller. Used in every /api/quoting call
// to scope sets + lines to the right estimate. We still allow a default of
// 1 so the standalone wrapper / older tests don't break — but the consolidated
// Estimate page always provides one explicitly now.
const DEFAULT_ESTIMATE_ID = 1;

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
  { code: "other_rentals_rack_install",   kind: "other_rental", title: "Other Rentals (Rack Install)",
    hint: 'For the QuickBooks bundle, rows are split by label keyword: "Dumpster" → Dumpsters/Site Rentals, "Propane" → Propane. Anything else falls into Equipment - Lifts.' },

  // ── Wire Guidance Install ───────────────────────────────────────────────
  { code: "materials_wire_guidance",      kind: "free_form",    title: "Material Costs (Wire Guidance Install)" },
  { code: "wire_guidance_contract_labor", kind: "productivity", title: "Wire Guidance Contract Labor",      category: "Wire Guidance" },
  { code: "rentals_wire_guidance",        kind: "rental",       title: "Rentals - Wire Guidance Install" },
  { code: "other_rentals_wire_guidance",  kind: "other_rental", title: "Other Rentals (Wire Guidance Install)",
    hint: 'For the QuickBooks bundle, rows whose label contains "Propane" are split out; everything else feeds Floor Scrubber.' },

  // ── Additional Items ────────────────────────────────────────────────────
  { code: "wire_guidance_additional",     kind: "free_form",    title: "Wire Guidance Additional Items",
    hint: 'For the QuickBooks bundle, rows are bucketed by label keyword: "Slurry", "Line Driver", "Magnet", "RFID". Other labels are ignored by the bundle math.' },

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

/**
 * Mount the Base Quoting Metrics UI into a given container. Used by:
 *   - the standalone #/base-quoting-metrics page (via the wrapper below), and
 *   - the consolidated Estimate page, which embeds these cards below its
 *     existing Estimate / Key Inputs / Output / Results cards.
 *
 * Returns a cleanup function that removes the global ('storage') listener
 * and clears the container; the container-scoped change/input/click
 * listeners are auto-cleaned when the container is wiped or removed.
 */
export async function mountBaseQuotingMetrics({
  container,
  estimateId = DEFAULT_ESTIMATE_ID,
  metricSetId = null,           // when set, scope to a specific (non-Base) set
  locked = false,               // read-only (sent/locked estimate) — never auto-write
}) {
  if (!container) return () => {};
  const ESTIMATE_ID = estimateId;

  // ── data load ──────────────────────────────────────────────────────────────
  // `baseSet` is the *active* set the page edits — it's the Base set by
  // default, but the caller can pin to a specific set id (e.g. an Option's
  // metric set) so the same UI hosts every Option tab.
  let baseSet, productivityItems, rentalItems, allLines, lookups;
  try {
    const [sets, prodItems, rentItems, lk] = await Promise.all([
      api(`/quoting/metric-sets?estimate_id=${ESTIMATE_ID}`),
      api(`/quoting/productivity-rates`),
      api(`/quoting/rental-rates`),
      api(`/quoting/lookup-values`),
    ]);
    if (metricSetId != null) {
      baseSet = sets.find(s => Number(s.id) === Number(metricSetId));
      if (!baseSet) throw new Error(`Metric set ${metricSetId} not found for estimate ${ESTIMATE_ID}.`);
    } else {
      baseSet = sets.find(s => s.kind === "base");
      if (!baseSet) throw new Error("Base metric set missing and auto-create failed.");
    }
    productivityItems = prodItems;
    rentalItems       = rentItems;
    lookups           = lk || {};
    allLines = await api(`/quoting/metric-lines?metric_set_id=${baseSet.id}`);
  } catch (err) {
    container.innerHTML = `<div class="card px-5 py-4 text-sm text-red-600">
      Failed to load Base Quoting Metrics: ${escapeHtml(err?.message || String(err))}
    </div>`;
    return () => {};
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

  // Badge shown under a smart (auto-derived) Other-Rentals row label. Grey
  // "auto" pill when the app owns the value; amber "manual" pill + a one-click
  // "reset to $X" when the estimator has overridden it.
  function smartRowBadgeHtml(code, row) {
    const kind = smartRowKind(code, row);
    if (!kind) return "";
    const suggest = row._autoSuggest;
    const suggestTxt = (suggest == null) ? "—" : fmtMoney(suggest);
    if (autoState(row) === "auto") {
      return `<div class="mt-0.5 flex items-center gap-1">
        <span class="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">auto</span>
        <span class="text-[10px] text-black/40">= ${escapeHtml(kind === "env" ? "1.9% of lifts" : "workbook formula")}</span>
      </div>`;
    }
    return `<div class="mt-0.5 flex items-center gap-1">
      <span class="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">manual</span>
      <button type="button" data-reset-auto
              class="text-[10px] font-semibold text-blue-600 hover:text-blue-800 underline decoration-dotted"
              title="Reset this line to the auto-calculated value">↺ reset to ${escapeHtml(suggestTxt)}</button>
    </div>`;
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
          <div data-smart-badge>${smartRowBadgeHtml(code, row)}</div>
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
      <div class="card px-5 py-4" data-qm-section data-section-host data-section-code="${cfg.code}" data-section-kind="${cfg.kind}">
        <button type="button" data-qm-section-toggle
                class="w-full flex items-center justify-between gap-3 pb-2 border-b border-black/10 text-left cursor-pointer select-none">
          <span class="flex items-baseline gap-3">
            <span class="text-sm font-extrabold uppercase tracking-wide text-black/70">${escapeHtml(cfg.title)}</span>
            <span class="text-[11px] italic text-black/40">${sub}</span>
          </span>
          <svg class="w-4 h-4 text-black/40 shrink-0 transition-transform ${chevronClass}" data-qm-section-chevron
               fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </button>

        <div class="${bodyClass}" data-qm-section-body>
          ${cfg.hint ? `
            <div class="text-[11px] italic text-blue-700/80 bg-blue-50/60 border border-blue-100 rounded px-3 py-2 mb-2">
              ${escapeHtml(cfg.hint)}
            </div>` : ""}
          <div data-section-host-table>${tableHtml(code)}</div>
          <div class="pt-3 flex items-center justify-between gap-2">
            <button type="button" data-add-row
                    class="text-xs font-semibold text-blue-600 hover:text-blue-800 px-2 py-1 rounded hover:bg-blue-50">
              + Add line
            </button>
            <button type="button" data-clear-section
                    class="text-xs font-semibold text-red-600 hover:text-red-800 px-2 py-1 rounded hover:bg-red-50"
                    title="Delete every row in this section">
              Clear all rows
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
      // Smart Other-Rentals rows stash their auto/manual override state here.
      notes:                row.notes ?? null,
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

  // Wraps a card body in the same collapsible toggle pattern used by the
  // input section cards. Anyone clicking the header (data-qm-section-toggle)
  // toggles the body's `hidden` class; the existing onClick handler picks
  // it up via data-qm-section-* attributes. Outer card gets the supplied
  // attrs so existing renderX() functions can still locate it.
  function qmCollapsibleCardHtml(title, subtitle, bodyHtml, opts = {}) {
    const cardAttrs = opts.cardAttrs || "";
    const collapsed = opts.collapsed === true;
    return `
      <div class="card px-5 py-4" data-qm-section ${cardAttrs}>
        <button type="button" data-qm-section-toggle
                class="w-full flex items-center justify-between gap-3 pb-2 border-b border-black/10 text-left cursor-pointer select-none">
          <span class="flex items-baseline gap-3">
            <span class="text-sm font-extrabold uppercase tracking-wide text-black/70">${escapeHtml(title)}</span>
            ${subtitle ? `<span class="text-[11px] italic text-black/40">${escapeHtml(subtitle)}</span>` : ""}
          </span>
          <svg class="w-4 h-4 text-black/40 shrink-0 transition-transform ${collapsed ? '-rotate-90' : ''}" data-qm-section-chevron
               fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </button>
        <div class="${collapsed ? 'pt-3 hidden' : 'pt-3'}" data-qm-section-body>
          ${bodyHtml}
        </div>
      </div>`;
  }

  function tabSettingsHtml() {
    const factor = currentEnvFactor();
    // Surface the General Info "Estimate Type" so the user can see WHAT
    // they're inheriting when this set's override is blank. Falls back to
    // "Standard" (the same default the rollup math uses).
    const inheritedEst = (readEstimateBridge().estimate_type || "Standard");
    const estPlaceholder = `Inherit from Roll Up (${inheritedEst})`;
    return `
        <div class="flex justify-end -mt-2 mb-1">
          <button type="button" data-reset-tab-settings
                  class="text-[11px] font-semibold text-red-600 hover:text-red-800 px-2 py-0.5 rounded hover:bg-red-50"
                  title="Clear every override on this tab">
            Reset Tab Settings
          </button>
        </div>
        <div class="pt-1 grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3">

          <!-- Left column -->
          <div class="flex flex-col gap-3">
            <div class="grid grid-cols-[1fr_1fr] gap-x-3 gap-y-3 items-center">
              ${attrLabel("Estimate Type Override")}
              ${selectAttrHtml("estimate_type_override", ESTIMATE_TYPE_OPTS, { placeholder: estPlaceholder })}

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


  // computeTravelCosts is now a thin wrapper around qm-rollup#computeSetRollup
  // so the per-tab Cost Summary / Travel Costs cards always agree with the
  // Review tab's rollup. The wrapper just gathers the page's live rows + the
  // current attrs + the estimate-state bridge, then adds the UI-only extras
  // the cards expect (Inputs column values + hrs_out_of_range flag + the
  // `section_total` alias for what the rollup calls `travel_costs_total`).
  function computeTravelCosts() {
    const est = readEstimateBridge();
    const allLines = [];
    for (const code of Object.keys(sections)) {
      for (const row of sections[code].rows) {
        allLines.push({ ...row, section_code: row.section_code || code });
      }
    }
    const rollup = computeSetRollup({
      set:           { ...baseSet, ...attrs },
      lines:         allLines,
      lookups,
      estimateState: est,
    });
    return {
      ...rollup,
      // Alias for legacy callers that read tc.section_total.
      section_total:       rollup.travel_costs_total,
      // Inputs surfaced to the Travel Costs card's "Estimate Inputs" column.
      lodging_cost_per_day: Number(est.lodging_cost_per_day   ?? 0) || 0,
      mgmt_pct_pts:         Number(est.mgmt_travel_multiplier ?? 0) || 0,
      crew_count:           Number(est.crew_count             ?? 0) || 0,
      hrs_out_of_range:     Number(est.one_way_travel_hrs     ?? 0) > 38,
    };
  }

  // ── Auto-derived Other-Rentals (Environmental Fees + Liquid Propane) ─────────
  // The BASE sheet computes these two "Other Rentals" line items by formula;
  // the app historically left them as manual entry, which drifts from the
  // workbook. We now auto-derive them (with a manual-override escape hatch),
  // mirroring the live Google-Drive RELEASE-template formulas confirmed by the
  // 2026-07 formula audit:
  //   Environmental Fees  G203/G240 = 1.9% × (lift equipment ext-cost)
  //   Liquid Propane rack H205       = 0 if Electric, else
  //                                    MIN( crew × (scissor+forklift per crew)
  //                                         × rackLaborDays × $40 ,
  //                                         liftQty × periodRate )
  //                       periodRate  day $40 / week $200 / month $500 (ref AB4:AC7),
  //                                   chosen by roundup(rackLaborDays / crew).
  //   Liquid Propane wire H242       = ceilHalf(WG_LF / 1500) × $40 when WG in scope.
  // A row's `notes` carries the override state: "auto:<kind>" (keep in sync) vs
  // "manual:<kind>" (user owns the value). Untouched seed rows adopt as auto.
  const ceilHalf2 = (x) => Math.ceil(Number(x) * 2) / 2;
  const round2    = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
  const SMART_RENTAL_SECTIONS = ["other_rentals_rack_install", "other_rentals_wire_guidance"];
  const ENV_FEE_PCT            = 0.019;                    // G203 / G240
  const PROPANE_RATE_BY_PERIOD = { day: 40, week: 200, month: 500 };  // reference AB4:AC7
  const PROPANE_WG_RATE        = 40;                       // G242
  const PROPANE_WG_LF_PER_UNIT = 1500;                     // F242 = ceiling(G29/1500, 0.5)

  function smartRowKind(code, row) {
    if (!SMART_RENTAL_SECTIONS.includes(code)) return null;
    const lbl = String(row.label || "").toLowerCase();
    if (lbl.includes("environmental")) return "env";
    if (lbl.includes("propane"))       return "propane";
    return null;
  }
  // "auto" = app keeps the value in sync; "manual" = user overrode it. A seed
  // row with no marker and no value yet adopts as auto; one that already holds
  // a hand-entered value is respected as manual.
  function autoState(row) {
    const n = String(row.notes || "");
    if (n.startsWith("auto:"))   return "auto";
    if (n.startsWith("manual:")) return "manual";
    return (row.unit_price == null && row.ext_cost == null) ? "auto" : "manual";
  }
  function isElectric() {
    return String(readEstimateBridge().equipment_requirement || "")
      .toLowerCase().startsWith("electric");
  }
  function sumSectionExt(code) {
    let s = 0;
    for (const r of (sections[code]?.rows || [])) if (r.ext_cost != null) s += Number(r.ext_cost);
    return s;
  }
  // Scissor + forklift qty in a base-rental section (workbook D192 + D196).
  function sumLiftQty(code, needles) {
    const sec = sections[code];
    if (!sec) return 0;
    let q = 0;
    for (const r of sec.rows) {
      if (r.qty == null || r.qty === "") continue;
      const item = r.rental_rate_id ? sec.itemById.get(r.rental_rate_id) : null;
      const et = String(item?.equipment_type || "").toLowerCase();
      if (needles.some(t => et.includes(t))) q += Number(r.qty);
    }
    return q;
  }
  // Propane period rate from roundup(rackLaborDays / crew) → day/week/month (E25/G205).
  function propanePeriodRate(rackLaborDays, crew) {
    const g23 = crew > 0 ? Math.ceil(Number(rackLaborDays) / crew) : 0;
    if (g23 < 1) return 0;
    if (g23 === 1) return PROPANE_RATE_BY_PERIOD.day;
    if (g23 < 8)   return PROPANE_RATE_BY_PERIOD.week;
    return PROPANE_RATE_BY_PERIOD.month;
  }
  function computeAutoRentalSuggestions() {
    const tc  = computeTravelCosts();               // rollup (D23 rack labor days, etc.)
    const est = readEstimateBridge();
    const crew = Number(est.crew_count ?? 0) || 0;
    const electric = isElectric();

    const envRack = round2(ENV_FEE_PCT * sumSectionExt("rentals_rack_install"));
    const envWire = round2(ENV_FEE_PCT * sumSectionExt("rentals_wire_guidance"));

    // Rack propane — MIN(labor-day cap, lift × period rate); 0 when electric.
    let propRack = 0;
    if (!electric) {
      const rackLaborDays = Number(tc.D23 ?? 0) || 0;
      const rate    = propanePeriodRate(rackLaborDays, crew);
      const liftQty = sumLiftQty("rentals_rack_install", ["scissor", "forklift"]);
      const liftTerm = liftQty * rate;
      const scissor = Number(attrs.scissor_lifts_per_crew ?? 0) || 0;
      const fork    = Number(attrs.forklifts_per_crew ?? 0) || 0;
      const cap     = crew * (scissor + fork) * rackLaborDays * 40;
      propRack = liftTerm > 0 ? round2(cap > 0 ? Math.min(cap, liftTerm) : liftTerm) : 0;
    }

    // Wire-guidance propane — footage-based, only when WG is in scope.
    const wgLf = Number(attrs.wire_guidance_linear_footage ?? 0) || 0;
    const propWire = wgLf > 0
      ? round2(ceilHalf2(wgLf / PROPANE_WG_LF_PER_UNIT) * PROPANE_WG_RATE)
      : 0;

    return {
      other_rentals_rack_install:  { env: envRack, propane: propRack },
      other_rentals_wire_guidance: { env: envWire, propane: propWire },
    };
  }

  // Sync in-memory rows to the suggested values (synchronous), then fire the
  // DB writes without blocking the render path. Guarded against re-entrancy.
  let _autoRefreshing = false;
  function refreshAutoRentalRows() {
    if (_autoRefreshing) return;
    _autoRefreshing = true;
    const toPersist = [];
    try {
      const sugg = computeAutoRentalSuggestions();
      for (const code of SMART_RENTAL_SECTIONS) {
        const sec = sections[code];
        if (!sec) continue;
        sec.rows.forEach((row, idx) => {
          const kind = smartRowKind(code, row);
          if (!kind) return;
          const target = kind === "env" ? sugg[code].env : sugg[code].propane;
          row._autoSuggest = target;                    // renderer reads this for the hint
          if (locked) return;                            // read-only estimate — show, never write
          if (autoState(row) !== "auto") return;
          const cur = row.ext_cost == null ? null : Number(row.ext_cost);
          // Don't write a 0 onto a still-pristine seed row — only when a real
          // value applies, or when a previously-auto value must fall back to 0.
          const pristineZero = target === 0 && row.ext_cost == null;
          const needsWrite = !pristineZero &&
            (cur !== target || Number(row.qty) !== 1 || Number(row.unit_price) !== target ||
             !String(row.notes || "").startsWith("auto:"));
          if (needsWrite) {
            row.qty = 1; row.mobilizations = 1; row.unit_price = target; row.ext_cost = target;
            row.notes = `auto:${kind}`;
            toPersist.push([code, idx]);
          }
        });
        renderTable(code);
      }
    } finally {
      _autoRefreshing = false;
    }
    toPersist.forEach(([code, idx]) => persistAutoRow(code, idx));
  }

  // Persist a smart row WITHOUT the render-trio side effects persistRow has
  // (refreshAutoRentalRows already re-rendered the table + the caller renders
  // the summary cards). Carries the `notes` override marker.
  async function persistAutoRow(code, idx) {
    const row = sections[code].rows[idx];
    if (!rowIsSaveable(code, row)) return;
    try {
      const payload = { ...buildPayload(code, row, idx), notes: row.notes ?? null };
      const suggest = row._autoSuggest;
      if (row.id == null) {
        const created = await api("/quoting/metric-lines", {
          method: "POST", body: JSON.stringify(payload),
        });
        sections[code].rows[idx] = { ...created, _saving: false, _autoSuggest: suggest };
      } else {
        const updated = await api(`/quoting/metric-lines/${row.id}`, {
          method: "PUT", body: JSON.stringify(payload),
        });
        sections[code].rows[idx] = { ...updated, _saving: false, _autoSuggest: suggest };
      }
    } catch (err) {
      console.error("Auto rental persist failed", code, idx, err);
    }
  }

  // Swap just the auto/manual badge for one row without touching its inputs
  // (so flipping to "manual" mid-keystroke doesn't steal caret focus).
  function renderSmartBadge(code, idx) {
    const root = document.querySelector(`[data-section-code="${code}"]`);
    const holder = root?.querySelector(`tr[data-row-idx="${idx}"] [data-smart-badge]`);
    if (holder) holder.innerHTML = smartRowBadgeHtml(code, sections[code].rows[idx]);
  }

  // Reset an overridden smart row back to auto-managed, then recompute.
  async function resetSmartRowToAuto(code, idx) {
    const row = sections[code].rows[idx];
    const kind = smartRowKind(code, row);
    if (!kind) return;
    row.notes = `auto:${kind}`;
    refreshAutoRentalRows();
    renderCostSummary();
    renderBundleOutput();
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
      <div class="text-[11px] italic text-black/40 pb-2">Cost checker · ${escapeHtml(tc.estimate_type)} estimate</div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-8">
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
    const body = document.querySelector("[data-cost-summary] [data-qm-section-body]");
    if (body) body.innerHTML = costSummaryCardHtml();
  }

  // ── QuickBooks Bundle Output ───────────────────────────────────────────────
  // The bundle math (BASE sheet's S-column formulas) lives in
  // utils/qm-rollup.js as `computeSetBundles` so the Review tab can call it
  // for cross-set aggregates. The local wrapper just gathers the page's
  // live state (rows + per-set attrs + estimate bridge) and delegates.
  function computeAllBundles() {
    const allLines = [];
    for (const code of Object.keys(sections)) {
      for (const row of sections[code].rows) {
        allLines.push({ ...row, section_code: row.section_code || code });
      }
    }
    return computeSetBundles({
      set:           { ...baseSet, ...attrs },
      lines:         allLines,
      lookups,
      estimateState: readEstimateBridge(),
    });
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
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-8">
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
    const body = document.querySelector("[data-bundle-output] [data-qm-section-body]");
    if (body) body.innerHTML = bundleOutputCardHtml();
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
      <div class="text-[11px] italic text-black/40 pb-2">Computed · ${escapeHtml(tc.estimate_type)} estimate</div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-x-6 gap-y-4 text-sm">

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
    const body = document.querySelector("[data-travel-costs] [data-qm-section-body]");
    if (body) body.innerHTML = travelCostsCardHtml();
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
  // Group dividers visually band the long list of input cards into the same
  // logical chunks the workbook uses (Rack Install / Wire Guidance / Additional
  // Items / Labor Blocks). Behavior is unchanged — each card is still
  // independently collapsible.
  // Page body is bg-ink-900 (dark), so dividers need light text + a light
  // rule to be visible in the gap between cards.
  const groupDivider = (title) => `
    <div class="flex items-center gap-3 pt-4 first:pt-1 px-1">
      <span class="text-[11px] font-extrabold uppercase tracking-widest text-white">${escapeHtml(title)}</span>
      <span class="flex-1 h-px bg-white/25"></span>
    </div>`;

  const SECTION_GROUPS = [
    { title: "Rack Installation", codes: [
      "materials_rack_install",
      "teardrop_racking", "bolted_racking", "wire_decking", "anchors",
      "cantilever_racking", "high_density_storage", "mezz_pick_modules",
      "rack_protection", "safety_netting", "shelving", "miscellaneous",
      "rentals_rack_install", "other_rentals_rack_install",
    ]},
    { title: "Wire Guidance Install", codes: [
      "materials_wire_guidance", "wire_guidance_contract_labor",
      "rentals_wire_guidance", "other_rentals_wire_guidance",
    ]},
    { title: "Additional Items", codes: [
      "wire_guidance_additional",
    ]},
    { title: "Labor Blocks", codes: [
      "downtime_labor", "remobilization_labor", "dismantle_labor",
      "mobilization_labor", "upright_assembly_labor", "anchor_holes_labor",
      "wedge_anchors", "miscellaneous_labor",
    ]},
  ];

  const groupedSectionsHtml = SECTION_GROUPS.map(g => `
    ${groupDivider(g.title)}
    ${g.codes.map(c => sectionCardHtml(c)).join("")}
  `).join("");

  const bodyHtml = `
    <div class="grid grid-cols-1 gap-3 pb-3">

      ${groupDivider("Configuration")}
      ${qmCollapsibleCardHtml("Tab Settings",
          "Per-set overrides + day type adjustments",
          tabSettingsHtml(),
          { cardAttrs: "data-tab-settings" })}

      ${groupDivider("Live Calculations")}
      ${qmCollapsibleCardHtml("Cost Summary",
          "Cost checker",
          costSummaryCardHtml(),
          { cardAttrs: "data-cost-summary" })}

      ${qmCollapsibleCardHtml("Travel Costs",
          "Computed",
          travelCostsCardHtml(),
          { cardAttrs: "data-travel-costs" })}

      ${qmCollapsibleCardHtml("QuickBooks Bundle Output",
          "Per-bundle line items · ceilings to $10 · * = not yet modeled (0)",
          bundleOutputCardHtml(),
          { cardAttrs: "data-bundle-output" })}

      ${groupedSectionsHtml}

    </div>`;

  container.innerHTML = bodyHtml;

  // Populate the auto-derived Env-Fee / Propane rows on first paint (and adopt
  // any untouched seed rows into auto-management).
  refreshAutoRentalRows();
  renderCostSummary();
  renderBundleOutput();

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
      // Picking a lift rental changes the Env-Fee / Propane inputs.
      if (ctx.code === "rentals_rack_install" || ctx.code === "rentals_wire_guidance") {
        refreshAutoRentalRows();
        renderCostSummary();
        renderBundleOutput();
      }
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
      // These per-crew / footage inputs feed the auto Env-Fee / Propane math.
      if (["scissor_lifts_per_crew", "forklifts_per_crew", "wire_guidance_linear_footage"].includes(attrField)) {
        refreshAutoRentalRows();
        renderCostSummary();
        renderBundleOutput();
      }
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

    // A hand edit to a smart row's value takes it off auto-management.
    const smartKind = smartRowKind(ctx.code, row);
    if (smartKind && field !== "label" && autoState(row) === "auto") {
      row.notes = `manual:${smartKind}`;
      renderSmartBadge(ctx.code, ctx.idx);
    }

    localComputeTotals(ctx.code, row);
    renderRowComputed(ctx.code, ctx.idx);
    persistRow(ctx.code, ctx.idx);

    // Editing base lift rentals changes the Env-Fee / Propane inputs.
    if (ctx.code === "rentals_rack_install" || ctx.code === "rentals_wire_guidance") {
      refreshAutoRentalRows();
      renderCostSummary();
      renderBundleOutput();
    }
  }

  function onClick(e) {
    const toggle = e.target.closest("[data-qm-section-toggle]");
    if (toggle) {
      const card = toggle.closest("[data-qm-section]");
      const body = card?.querySelector("[data-qm-section-body]");
      if (body) {
        const collapsed = body.classList.toggle("hidden");
        const chevron = toggle.querySelector("[data-qm-section-chevron]");
        if (chevron) chevron.classList.toggle("-rotate-90", collapsed);
      }
      return;
    }

    if (e.target.closest("[data-add-row]")) {
      const ctx = ctxFromEvent(e);
      if (ctx) addEmptyRow(ctx.code);
      return;
    }
    if (e.target.closest("[data-reset-auto]")) {
      const ctx = ctxFromEvent(e);
      if (ctx && ctx.idx != null) resetSmartRowToAuto(ctx.code, ctx.idx);
      return;
    }
    if (e.target.closest("[data-row-delete]")) {
      const ctx = ctxFromEvent(e);
      if (ctx && ctx.idx != null) deleteRow(ctx.code, ctx.idx);
      return;
    }
    if (e.target.closest("[data-clear-section]")) {
      const ctx = ctxFromEvent(e);
      if (ctx) clearSection(ctx.code);
      return;
    }
    if (e.target.closest("[data-reset-tab-settings]")) {
      resetTabSettings();
    }
  }

  // Clear every per-set attribute on this set. Iterates the live DOM so we
  // pick up whatever Tab Settings exposes, dispatches input + change events
  // so the existing onFieldChange / onFieldInput paths run normally (state
  // update + PATCH + re-render of the calc cards).
  async function resetTabSettings() {
    const card = container.querySelector("[data-tab-settings]");
    if (!card) return;
    const fields = card.querySelectorAll("[data-attr-field]");
    if (fields.length === 0) return;
    if (!confirm("Clear every Tab Settings value on this tab? This cannot be undone.")) return;
    for (const el of fields) {
      el.value = "";
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // Wipe every line in a section for the current metric set. Backend cascades
  // the delete; the frontend just refreshes the table + the calc cards.
  async function clearSection(code) {
    const section = sections[code];
    if (!section || section.rows.length === 0) return;
    const title = section.config.title || code;
    if (!confirm(`Delete all ${section.rows.length} row(s) in "${title}"? This cannot be undone.`)) return;
    try {
      await api(`/quoting/metric-lines?metric_set_id=${baseSet.id}&section_code=${encodeURIComponent(code)}`, {
        method: "DELETE",
      });
      section.rows = [];
      renderTable(code);
      renderTravelCosts();
      renderCostSummary();
      renderBundleOutput();
    } catch (err) {
      alert("Failed to clear section: " + (err?.message || err));
    }
  }

  // Container-scoped so we don't collide with the host page's listeners
  // (e.g. the Estimate page also listens for click/input on `document`).
  container.addEventListener("change", onFieldChange);
  container.addEventListener("input",  onFieldInput);
  container.addEventListener("click",  onClick);

  // Live-update Travel Costs when the Estimate page (potentially open in
  // another tab) writes to localStorage. The 'storage' event only fires in
  // OTHER tabs, not the writer — that's by design.
  function onStorage(e) {
    if (e.key === ESTIMATE_BRIDGE_KEY) {
      refreshAutoRentalRows();   // equipment (Electric/LP) + crew count feed propane
      renderTravelCosts();
      renderCostSummary();
      renderBundleOutput();
    }
  }
  window.addEventListener("storage", onStorage);

  return function cleanup() {
    container.removeEventListener("change", onFieldChange);
    container.removeEventListener("input",  onFieldInput);
    container.removeEventListener("click",  onClick);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Standalone page route — wraps the mount function in setShell. Kept so
 * #/base-quoting-metrics still works as a direct URL even after the page
 * is also embedded in #/estimate.
 */
export async function baseQuotingMetricsPage(routeFn) {
  setShell({
    title:    "",
    subtitle: "",
    bodyHtml: `<div data-qm-standalone-host></div>`,
    showLogout: true,
    routeFn,
  });

  // Hide the empty page-title block; restore on navigate-away.
  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => {
      if (pageTitleBlock) pageTitleBlock.style.display = "";
    }, { once: true });
  }

  const host = document.querySelector("[data-qm-standalone-host]");
  if (!host) return;
  const cleanup = await mountBaseQuotingMetrics({ container: host });
  window.addEventListener("hashchange", cleanup, { once: true });
}
