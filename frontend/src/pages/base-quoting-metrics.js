// Base Quoting Metrics page — sheet-parity layout (plan step 4).
// Mirrors the workbook tab "1.0 BASE Quoting Metrics":
//   - GENERAL INFORMATION block (sheet r7-30): per-set inputs (the old Tab
//     Settings) + read-only estimate mirrors + computed Tab Days cells, laid
//     out as the sheet's 4-column grid with verbatim labels + the Day Type
//     override mini-table (J13:M23).
//   - Left pane: TRAVEL COSTS + the input sections in exact sheet row order,
//     each a spreadsheet table (hairline borders, blue editable cells, green
//     computed cells) under black banner rows.
//   - Right pane (sticky): FULL COSTING TABLE (sheet cols R/S rows 2-47),
//     live from computeSetBundles, + the Cost Checker.
// Line shapes: 'productivity' (item dropdown + qty -> std/agg days),
// 'rental' (equipment dropdown + qty -> ext), 'free_form' (label/qty/price),
// 'other_rental' (label/qty/mobs/price with auto-derived smart rows).

import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import { api } from "../api.js";
import { computeSetRollup, computeSetBundles, applyLineOverrides } from "../utils/qm-rollup.js";

// ── Cell-override client (#1 sheet parity, plan step 3) ─────────────────────
// Tiny shared persistence helper for /api/estimates/{id}/cell-overrides:
// optimistic local update, 300ms debounced PATCH per key, alert + value
// rollback on failure. `overrides` is the live {key: number} map the caller
// renders from; value null reverts (deletes the key). Also used by the
// Estimate page (ROLL UP results + QBO Lines tab).
export function createCellOverrideClient({ estimateId, overrides, onError }) {
  const timers = new Map();
  return {
    overrides,
    set(key, value) {
      const prev = (key in overrides) ? overrides[key] : undefined;
      if (value == null) {
        if (prev === undefined) return;      // nothing to revert
        delete overrides[key];
      } else {
        overrides[key] = Number(value);
      }
      if (timers.has(key)) clearTimeout(timers.get(key));
      timers.set(key, setTimeout(async () => {
        timers.delete(key);
        try {
          await api(`/estimates/${estimateId}/cell-overrides`, {
            method: "PATCH",
            body:   JSON.stringify({ key, value: value == null ? null : Number(value) }),
          });
        } catch (err) {
          // Roll the optimistic update back so the UI matches the server.
          if (prev === undefined) delete overrides[key];
          else overrides[key] = prev;
          alert("Failed to save cell override: " + (err?.message || err));
          if (onError) onError(key);
        }
      }, 300));
    },
  };
}

// Estimate id is passed in by the caller. Used in every /api/quoting call
// to scope sets + lines to the right estimate. We still allow a default of
// 1 so the standalone wrapper / older tests don't break — but the consolidated
// Estimate page always provides one explicitly now.
const DEFAULT_ESTIMATE_ID = 1;

const SECTIONS = [
  // ── Rack Installation ───────────────────────────────────────────────────
  { code: "materials_rack_install",       kind: "free_form",    title: "MATERIAL COSTS" },

  // Rack Installation Contract Labor (productivity shape)
  { code: "teardrop_racking",             kind: "productivity", title: "Teardrop Racking - Typ Roll Formed",                  category: "Teardrop Racking" },
  { code: "bolted_racking",               kind: "productivity", title: "Bolted Racking - Typ Structural",                    category: "Bolted Racking" },
  { code: "wire_decking",                 kind: "productivity", title: "Wire Decking",                      category: "Wire Decking" },
  { code: "anchors",                      kind: "productivity", title: "Anchors",                           category: "Anchors" },
  { code: "cantilever_racking",           kind: "productivity", title: "Cantilever Racking",                category: "Cantilever Racking" },
  { code: "high_density_storage",         kind: "productivity", title: "High Density Storage Rack",         category: "High Density Storage" },
  { code: "mezz_pick_modules",            kind: "productivity", title: "Mezz and Pick Modules",             category: "Mezz and Pick Modules" },
  { code: "rack_protection",              kind: "productivity", title: "Rack Protection",                   category: "Rack Protection" },
  { code: "safety_netting",               kind: "productivity", title: "Safety Netting / Fall Protection",  category: "Safety Netting" },
  { code: "shelving",                     kind: "productivity", title: "Shelving",                          category: "Shelving" },
  { code: "miscellaneous",                kind: "productivity", title: "Miscellaneous",                     category: "Miscellaneous" },

  { code: "rentals_rack_install",         kind: "rental",       title: "RENTALS - RACK INSTALL" },
  { code: "other_rentals_rack_install",   kind: "other_rental", title: "OTHER RENTALS (RACK INSTALL)",
    hint: 'For the QuickBooks bundle, rows are split by label keyword: "Dumpster" → Dumpsters/Site Rentals, "Propane" → Propane. Anything else falls into Equipment - Lifts.' },

  // ── Wire Guidance Install ───────────────────────────────────────────────
  { code: "materials_wire_guidance",      kind: "free_form",    title: "MATERIAL COSTS (WIRE GUIDANCE)" },
  { code: "wire_guidance_contract_labor", kind: "productivity", title: "CONTRACT LABOR COSTS (WIRE GUIDANCE)",      category: "Wire Guidance" },
  { code: "rentals_wire_guidance",        kind: "rental",       title: "RENTALS - WIRE GUIDANCE INSTALL" },
  { code: "other_rentals_wire_guidance",  kind: "other_rental", title: "OTHER RENTALS (WIRE GUIDANCE INSTALL)",
    hint: 'For the QuickBooks bundle, rows whose label contains "Propane" are split out; everything else feeds Floor Scrubber.' },

  // ── Additional Items ────────────────────────────────────────────────────
  { code: "wire_guidance_additional",     kind: "free_form",    title: "WIRE GUIDANCE ADDITIONAL ITEMS",
    hint: 'For the QuickBooks bundle, rows are bucketed by label keyword: "Slurry", "Line Driver", "Magnet", "RFID". Other labels are ignored by the bundle math.' },

  // ── Labor blocks ────────────────────────────────────────────────────────
  // Template row labels are auto-seeded by the backend on the Base metric
  // set; they render as ordinary free-form rows here. OH&P and Profit %
  // rows are out of scope for now — they belong with the rollup work.
  { code: "downtime_labor",         kind: "free_form", title: "DOWNTIME (LABOR)" },
  { code: "remobilization_labor",   kind: "free_form", title: "REMOBILIZATION (LABOR)" },
  { code: "dismantle_labor",        kind: "free_form", title: "DISMANTLE (LABOR)" },
  { code: "mobilization_labor",     kind: "free_form", title: "MOBILIZATION (LABOR)" },
  { code: "upright_assembly_labor", kind: "free_form", title: "UPRIGHT ASSEMBLY (LABOR)" },
  { code: "anchor_holes_labor",     kind: "free_form", title: "ANCHOR HOLES (LABOR)" },
  { code: "wedge_anchors",          kind: "free_form", title: "WEDGE ANCHORS" },
  { code: "miscellaneous_labor",    kind: "free_form", title: "MISCELLANEOUS" },
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
  let estimateRow = null;   // read-only header fields for the GENERAL INFORMATION block
  let cellOverrides = {};   // typed-over cells (server map, shared across tabs)
  try {
    // Rates + lookups come from THIS estimate's frozen snapshot (#2 packaging),
    // so an open quote never silently reprices when the live tables change.
    const [sets, prodItems, rentItems, lk, estRow, ovResp] = await Promise.all([
      api(`/quoting/metric-sets?estimate_id=${ESTIMATE_ID}`),
      api(`/quoting/productivity-rates?estimate_id=${ESTIMATE_ID}`),
      api(`/quoting/rental-rates?estimate_id=${ESTIMATE_ID}`),
      api(`/quoting/lookup-values?estimate_id=${ESTIMATE_ID}`),
      api(`/estimates/${ESTIMATE_ID}`).catch(() => null),
      api(`/estimates/${ESTIMATE_ID}/cell-overrides`).catch(() => ({ overrides: {} })),
    ]);
    estimateRow = estRow;
    cellOverrides = (ovResp && ovResp.overrides) || {};
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

  // ── Override-any-cell (typed-over green cells) ─────────────────────────────
  // Key namespace on this page:
  //   s{setId}:S3..S47   — FULL COSTING TABLE pane rows
  //   s{setId}:D13..G23  — GENERAL INFORMATION computed cells (sheet refs)
  //   l{lineId}:std_total|agg_total|ext_cost — per-line computed cells
  // Overridden cells render indigo (#c7d2fe / #1e1b4b) with a leading ✎ and a
  // ↺ revert button; the value FLOWS DOWNSTREAM via qm-rollup's ov() hook and
  // applyLineOverrides, exactly like typing over a sheet formula.
  const setPrefix = `s${baseSet.id}:`;
  const ovClient = createCellOverrideClient({
    estimateId: ESTIMATE_ID,
    overrides:  cellOverrides,
    onError:    (key) => repaintAfterOverride(key),
  });
  const hasMapOverrides = () =>
    Object.keys(cellOverrides).some(k => k.startsWith(setPrefix));

  const OVR_FMTS = {
    money: fmtMoney,
    num3:  (v) => fmt(v, 3),
    num2:  (v) => fmt(v, 2),
    num1:  (v) => fmt(v, 1),
    int:   (v) => fmt(v, 0),
    pct5:  (v) => (v == null || v === "" ? "—" : fmt(v, 5) + "%"),
  };

  // Effective (override-aware) value of a line's computed field.
  function effLineVal(row, field) {
    if (row && row.id != null) {
      const k = `l${row.id}:${field}`;
      if (k in cellOverrides) return Number(cellOverrides[k]);
    }
    return row ? row[field] : null;
  }

  // Build the attrs + inner HTML for an override-enabled cell.
  //   key         full override key (or null → plain computed cell)
  //   calcNum     the calculated (formula) numeric value — tooltip + reference
  //   fmtName     OVR_FMTS formatter for the override value
  //   displayText preformatted text shown when NOT overridden (defaults to
  //               the formatted calcNum)
  //   effNum      effective numeric (flow-aware) — prefill for the editor
  function ovrCellParts(key, calcNum, fmtName, displayText = null, effNum = undefined) {
    const f = OVR_FMTS[fmtName] || ((v) => String(v));
    const calcOk = calcNum != null && calcNum !== "" && Number.isFinite(Number(calcNum));
    const calcText = calcOk ? f(Number(calcNum)) : (displayText ?? "—");
    const disp = displayText != null ? displayText : calcText;
    if (!key) return { attrs: "", inner: disp };
    const over = key in cellOverrides;
    const eff = effNum !== undefined ? effNum : calcNum;
    const effOk = eff != null && eff !== "" && Number.isFinite(Number(eff));
    let attrs = ` data-ovr-key="${escapeHtml(key)}" data-ovr-fmt="${fmtName}"` +
      ` data-ovr-computed="${calcOk ? Number(calcNum) : ""}"` +
      ` data-ovr-eff="${effOk ? Number(eff) : ""}"`;
    let inner;
    if (over) {
      attrs += ` style="background:#c7d2fe;color:#1e1b4b"` +
        ` title="${escapeHtml(`Calculated: ${calcText} — typed-over`)}"`;
      const rb = locked ? "" :
        `<button type="button" data-ovr-revert="${escapeHtml(key)}" title="Revert to calculated value"
                 style="border:0;background:transparent;cursor:pointer;color:#1e1b4b;font-weight:700;font-size:11px;line-height:1;padding:0 2px">↺</button>`;
      inner = `<span style="display:inline-flex;align-items:center;justify-content:flex-end;gap:3px">` +
        `<span aria-hidden="true" style="font-size:10px">✎</span><span>${f(Number(cellOverrides[key]))}</span>${rb}</span>`;
    } else {
      if (!locked) attrs += ` title="Click to type over the calculated value"`;
      inner = disp;
    }
    return { attrs, inner };
  }

  // In-place repaint of an existing override-enabled element (td or div).
  // `restore` = the element's normal colors when NOT overridden ("" lets the
  // class styling win — used for qmx-out tds; the GI divs carry inline #111).
  function paintOvrEl(el, key, calcNum, fmtName, displayText = null, effNum = undefined,
                      restore = { bg: "", color: "" }) {
    if (!el) return;
    const p = ovrCellParts(key, calcNum, fmtName, displayText, effNum);
    if (key) {
      el.setAttribute("data-ovr-key", key);
      el.setAttribute("data-ovr-fmt", fmtName);
      const calcOk = calcNum != null && calcNum !== "" && Number.isFinite(Number(calcNum));
      const eff = effNum !== undefined ? effNum : calcNum;
      const effOk = eff != null && eff !== "" && Number.isFinite(Number(eff));
      el.setAttribute("data-ovr-computed", calcOk ? String(Number(calcNum)) : "");
      el.setAttribute("data-ovr-eff", effOk ? String(Number(eff)) : "");
    }
    el.innerHTML = p.inner;
    if (key && key in cellOverrides) {
      el.style.background = "#c7d2fe";
      el.style.color = "#1e1b4b";
      const f = OVR_FMTS[fmtName] || ((v) => String(v));
      const calcOk = calcNum != null && calcNum !== "" && Number.isFinite(Number(calcNum));
      el.title = `Calculated: ${calcOk ? f(Number(calcNum)) : (displayText ?? "—")} — typed-over`;
    } else {
      el.style.background = restore.bg;
      el.style.color = restore.color;
      el.title = (key && !locked) ? "Click to type over the calculated value" : "";
    }
  }

  // Commit / revert an override, then repaint everything the cell feeds.
  function setOverride(key, value) {
    if (locked) return;
    if (value == null && !(key in cellOverrides)) return;
    ovClient.set(key, value);
  }

  function repaintAfterOverride(key) {
    if (key && key.startsWith("l")) {
      const m = key.match(/^l(\d+):/);
      const lineId = m ? Number(m[1]) : null;
      for (const code of Object.keys(sections)) {
        const idx = sections[code].rows.findIndex(r => r.id === lineId);
        if (idx >= 0) {
          renderRowComputed(code, idx);   // repaints row + totals + panes
          return;
        }
      }
    }
    renderTravelCosts();
    renderCostSummary();
    renderBundleOutput();
  }

  // Click-to-edit: swap the cell content for a number input. Enter/blur
  // commits (empty commit = revert to the formula), Escape cancels.
  function beginOverrideEdit(el) {
    if (locked || !el) return;
    const key = el.getAttribute("data-ovr-key");
    if (!key) return;
    if (el.querySelector("input[data-ovr-input]")) return;   // already editing
    const effAttr = el.getAttribute("data-ovr-eff");
    const cur = (key in cellOverrides)
      ? cellOverrides[key]
      : (effAttr === "" || effAttr == null ? "" : Number(effAttr));
    el.innerHTML = `<input type="number" step="any" data-ovr-input
        value="${cur === "" || cur == null ? "" : cur}"
        style="width:100%;min-width:56px;border:0;background:#fff;outline:2px solid #4f46e5;outline-offset:-2px;padding:1px 4px;font-size:12px;text-align:right;color:#111;box-sizing:border-box">`;
    const inp = el.querySelector("input[data-ovr-input]");
    inp.focus();
    inp.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) {
        const raw = String(inp.value).trim();
        if (raw === "") setOverride(key, null);
        else {
          const n = Number(raw);
          if (Number.isFinite(n)) setOverride(key, n);
        }
      }
      repaintAfterOverride(key);
    };
    inp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      ev.stopPropagation();
    });
    inp.addEventListener("blur", () => finish(true));
  }

  function rentalOptionLabel(r) {
    const parts = [];
    if (r.power_source) parts.push(r.power_source);
    if (r.size_class)   parts.push(r.size_class);
    parts.push(r.duration);
    return `${parts.join(" / ")} — ${fmtMoney(r.price)}`;
  }

  function sectionTotals(code) {
    // Sums use the OVERRIDE-AWARE per-line values, so a typed-over line cell
    // flows into its section TOTAL exactly like the sheet.
    const section = sections[code];
    if (section.config.kind === "productivity") {
      let std = 0, agg = 0;
      for (const r of section.rows) {
        const s = effLineVal(r, "std_total");
        const a = effLineVal(r, "agg_total");
        if (s != null) std += Number(s);
        if (a != null) agg += Number(a);
      }
      return { std, agg };
    }
    // rental + free_form + other_rental all sum ext_cost
    let ext = 0;
    for (const r of section.rows) {
      const e = effLineVal(r, "ext_cost");
      if (e != null) ext += Number(e);
    }
    return { ext };
  }

  // ── rendering ──────────────────────────────────────────────────────────────
  // Sheet-parity re-skin (plan step 4): every section renders as a spreadsheet
  // table — hairline #b7b7b7 borders, compact 12px rows, blue #cfe2f3 editable
  // cells, green #d9ead3 computed cells. The qmx-* classes are defined in the
  // page-local <style> block below (output.css is prebuilt — new Tailwind
  // utilities silently no-op, so this is real CSS). Cell ORDER and data-*
  // attributes are unchanged — renderRowComputed still updates by td index.
  const delBtnHtml = `
          <button type="button" data-row-delete
                  class="text-xs text-black/40 hover:text-red-600 px-1 rounded"
                  title="Delete row">✕</button>`;

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
      <tr data-row-idx="${idx}">
        <td class="qmx-in">
          <select data-row-field="productivity_rate_id">${itemOptions}</select>
        </td>
        <td class="qmx-in">
          <input type="number" step="any" min="0" data-row-field="qty"
                 value="${row.qty != null ? Number(row.qty) : ""}" placeholder="0"/>
        </td>
        <td class="qmx-out">${fmt(stdPerDay, 0)}</td>
        <td class="qmx-out">${fmt(aggPerDay, 0)}</td>
        ${(() => {
          const kS = row.id != null ? `l${row.id}:std_total` : null;
          const kA = row.id != null ? `l${row.id}:agg_total` : null;
          const pS = ovrCellParts(kS, row.std_total, "num3", fmt(row.std_total, 3));
          const pA = ovrCellParts(kA, row.agg_total, "num3", fmt(row.agg_total, 3));
          return `<td class="qmx-out qmx-strong" data-row-cell="std_total"${pS.attrs}>${pS.inner}</td>
        <td class="qmx-out qmx-strong" data-row-cell="agg_total"${pA.attrs}>${pA.inner}</td>`;
        })()}
        <td class="qmx-del">${delBtnHtml}</td>
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
      <tr data-row-idx="${idx}">
        <td class="qmx-in">
          <select data-row-field="rental_rate_id">
            <option value="" ${placeholderSelected}>< Select ></option>
            ${optGroupsHtml}
          </select>
        </td>
        <td class="qmx-in">
          <input type="number" step="any" min="0" data-row-field="qty"
                 value="${row.qty != null ? Number(row.qty) : ""}" placeholder="0"/>
        </td>
        <td class="qmx-out">${fmtMoney(unitPrice)}</td>
        ${(() => {
          const k = row.id != null ? `l${row.id}:ext_cost` : null;
          const p = ovrCellParts(k, row.ext_cost, "money", fmtMoney(row.ext_cost));
          return `<td class="qmx-out qmx-strong" data-row-cell="ext_cost"${p.attrs}>${p.inner}</td>`;
        })()}
        <td class="qmx-del">${delBtnHtml}</td>
      </tr>`;
  }

  // Badge shown under a smart (auto-derived) Other-Rentals row label. Grey
  // "auto" pill when the app owns the value; amber "manual" pill + a one-click
  // "reset to $X" when the estimator has overridden it.
  function smartRowBadgeHtml(code, row) {
    const kind = smartRowKind(code, row);
    if (!kind) return "";
    const suggest = row._autoSuggest;
    const suggestTxt = (suggest == null || suggest.ext == null) ? "—" : fmtMoney(suggest.ext);
    const autoDesc = kind === "env"     ? "1.9% of lift rentals"
                   : kind === "hauling" ? "round-trips × mobs × $175"
                   :                      "workbook formula (0 if electric)";
    if (autoState(row) === "auto") {
      return `<div class="mt-0.5 flex items-center gap-1">
        <span class="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">auto</span>
        <span class="text-[10px] text-black/40">= ${escapeHtml(autoDesc)}</span>
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
      <tr data-row-idx="${idx}">
        <td class="qmx-in">
          <input type="text" data-row-field="label" style="text-align:left"
                 value="${escapeHtml(row.label ?? "")}" placeholder="Enter description"/>
          <div data-smart-badge style="padding:0 6px 3px">${smartRowBadgeHtml(code, row)}</div>
        </td>
        <td class="qmx-in">
          <input type="number" step="any" min="0" data-row-field="qty"
                 value="${qty ?? ""}" placeholder="0"/>
        </td>
        <td class="qmx-in">
          <input type="number" step="0.5" min="0" data-row-field="mobilizations"
                 value="${mobs ?? ""}" placeholder="1"/>
        </td>
        <td class="qmx-out" data-row-cell="ext_qty">${fmt(extQty, 2)}</td>
        <td class="qmx-in">
          <input type="number" step="0.01" min="0" data-row-field="unit_price"
                 value="${row.unit_price != null ? Number(row.unit_price) : ""}" placeholder="0.00"/>
        </td>
        ${(() => {
          const k = row.id != null ? `l${row.id}:ext_cost` : null;
          const p = ovrCellParts(k, row.ext_cost, "money", fmtMoney(row.ext_cost));
          return `<td class="qmx-out qmx-strong" data-row-cell="ext_cost"${p.attrs}>${p.inner}</td>`;
        })()}
        <td class="qmx-del">${delBtnHtml}</td>
      </tr>`;
  }

  function lineRowHtmlFreeForm(code, row, idx) {
    return `
      <tr data-row-idx="${idx}">
        <td class="qmx-in">
          <input type="text" data-row-field="label" style="text-align:left"
                 value="${escapeHtml(row.label ?? "")}" placeholder="Enter description"/>
        </td>
        <td class="qmx-in">
          <input type="number" step="any" min="0" data-row-field="qty"
                 value="${row.qty != null ? Number(row.qty) : ""}" placeholder="0"/>
        </td>
        <td class="qmx-in">
          <input type="number" step="0.01" min="0" data-row-field="unit_price"
                 value="${row.unit_price != null ? Number(row.unit_price) : ""}" placeholder="0.00"/>
        </td>
        ${(() => {
          const k = row.id != null ? `l${row.id}:ext_cost` : null;
          const p = ovrCellParts(k, row.ext_cost, "money", fmtMoney(row.ext_cost));
          return `<td class="qmx-out qmx-strong" data-row-cell="ext_cost"${p.attrs}>${p.inner}</td>`;
        })()}
        <td class="qmx-del">${delBtnHtml}</td>
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
    const delTh = `<th style="width:26px"></th>`;

    if (kind === "rental") {
      headerCols = `
        <th>Type</th>
        <th style="width:72px">QTY</th>
        <th style="width:110px">Unit Cost</th>
        <th style="width:110px">Ext. Cost</th>${delTh}`;
      colCount = 5;
      footerHtml = `
        <tr>
          <td colspan="3" class="qmx-lbl qmx-strong" style="text-align:right">TOTAL:</td>
          <td class="qmx-out qmx-strong" data-section-total="ext">${fmtMoney(totals.ext)}</td>
          <td class="qmx-del"></td>
        </tr>`;
    } else if (kind === "free_form") {
      // Sheet parity: MATERIAL COSTS blocks head "Description/QTY/Cost/Total";
      // the labor blocks head "Item/QTY/Price/Extended".
      const isMat = code.startsWith("materials_");
      headerCols = `
        <th>${isMat ? "Description" : "Item"}</th>
        <th style="width:72px">QTY</th>
        <th style="width:110px">${isMat ? "Cost" : "Price"}</th>
        <th style="width:110px">${isMat ? "Total" : "Extended"}</th>${delTh}`;
      colCount = 5;
      footerHtml = `
        <tr>
          <td colspan="3" class="qmx-lbl qmx-strong" style="text-align:right">TOTAL:</td>
          <td class="qmx-out qmx-strong" data-section-total="ext">${fmtMoney(totals.ext)}</td>
          <td class="qmx-del"></td>
        </tr>`;
    } else if (kind === "other_rental") {
      headerCols = `
        <th>Item</th>
        <th style="width:60px">QTY</th>
        <th style="width:60px"># Mobs</th>
        <th style="width:70px">EXT QTY</th>
        <th style="width:96px">Cost</th>
        <th style="width:100px">Extended</th>${delTh}`;
      colCount = 7;
      footerHtml = `
        <tr>
          <td colspan="5" class="qmx-lbl qmx-strong" style="text-align:right">TOTAL:</td>
          <td class="qmx-out qmx-strong" data-section-total="ext">${fmtMoney(totals.ext)}</td>
          <td class="qmx-del"></td>
        </tr>`;
    } else {
      // productivity
      headerCols = `
        <th>Item</th>
        <th style="width:72px">QTY</th>
        <th style="width:92px">Standard Daily Production</th>
        <th style="width:92px">Aggressive Daily Production</th>
        <th style="width:92px">Standard Day Total</th>
        <th style="width:92px">Aggressive Day Total</th>${delTh}`;
      colCount = 7;
      footerHtml = `
        <tr>
          <td colspan="4" class="qmx-lbl qmx-strong" style="text-align:right">TOTAL:</td>
          <td class="qmx-out qmx-strong" data-section-total="std">${fmt(totals.std, 3)}</td>
          <td class="qmx-out qmx-strong" data-section-total="agg">${fmt(totals.agg, 3)}</td>
          <td class="qmx-del"></td>
        </tr>`;
    }

    const rowsHtml = rows.length
      ? rows.map((r, i) => lineRowHtml(code, r, i)).join("")
      : `<tr><td colspan="${colCount}" style="text-align:center;color:rgba(17,17,17,.4);padding:8px">No lines yet — click "+ Add line" below.</td></tr>`;

    return `
      <table class="qmx-table" data-section-table>
        <thead>
          <tr>${headerCols}</tr>
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
    const bodyClass = hasData ? "" : "hidden";
    const chevronClass = hasData ? "" : "-rotate-90";
    return `
      <div class="qm-sheet qmx-box" data-qm-section data-section-host data-section-code="${cfg.code}" data-section-kind="${cfg.kind}">
        <button type="button" data-qm-section-toggle class="qmx-sec-head select-none">
          <span style="font-size:12px;font-weight:800;color:#111">${escapeHtml(cfg.title)}</span>
          <span data-header-total
                style="margin-left:auto;font-size:11px;font-weight:700;color:#111;font-variant-numeric:tabular-nums;white-space:nowrap">${headerTotalText(code)}</span>
          <svg class="transition-transform ${chevronClass}" data-qm-section-chevron
               style="width:14px;height:14px;flex:none;color:rgba(17,17,17,.5)"
               fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </button>

        <div class="${bodyClass}" data-qm-section-body>
          ${cfg.hint ? `
            <div class="text-[11px] italic text-blue-700/80 bg-blue-50/60 border border-blue-100 px-3 py-1.5"
                 style="border-bottom:1px solid #b7b7b7">
              ${escapeHtml(cfg.hint)}
            </div>` : ""}
          <div data-section-host-table>${tableHtml(code)}</div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 4px;background:#fff">
            <button type="button" data-add-row
                    class="text-xs font-semibold text-blue-600 hover:text-blue-800 px-2 py-0.5 rounded hover:bg-blue-50">
              + Add line
            </button>
            <button type="button" data-clear-section
                    class="text-xs font-semibold text-red-600 hover:text-red-800 px-2 py-0.5 rounded hover:bg-red-50"
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
    const h = document.querySelector(`[data-section-code="${code}"] [data-header-total]`);
    if (h) h.textContent = headerTotalText(code);
  }

  // Sheet parity: each banner row carries its running "TOTAL:" like the
  // workbook's B-column section headers do.
  function headerTotalText(code) {
    const totals = sectionTotals(code);
    const kind = sections[code].config.kind;
    if (kind === "rental" || kind === "free_form" || kind === "other_rental")
      return `TOTAL: ${fmtMoney(totals.ext)}`;
    return `${fmt(totals.std, 3)} std · ${fmt(totals.agg, 3)} agg days`;
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
    const h = root.querySelector("[data-header-total]");
    if (h) h.textContent = headerTotalText(code);
    // Sheet parity: the FULL COSTING TABLE pane + Travel Costs + Cost Checker
    // + General Info computed cells track section totals keystroke-live.
    schedulePaneRefresh();
  }

  // Debounced refresh of the computed panes (right-hand FULL COSTING TABLE,
  // Cost Checker, TRAVEL COSTS block, General Info green cells). Coalesces
  // the bursts renderTotalsOnly emits while the user types.
  let _paneTimer = null;
  function schedulePaneRefresh() {
    if (_paneTimer) clearTimeout(_paneTimer);
    _paneTimer = setTimeout(() => {
      _paneTimer = null;
      renderTravelCosts();
      renderCostSummary();
      renderBundleOutput();
    }, 80);
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

    const lk = (field) => (row.id != null ? `l${row.id}:${field}` : null);
    if (kind === "rental") {
      const item = row.rental_rate_id ? section.itemById.get(row.rental_rate_id) : null;
      if (cells.length >= 4) {
        cells[2].textContent = fmtMoney(item ? item.price : null);
        paintOvrEl(cells[3], lk("ext_cost"), row.ext_cost, "money", fmtMoney(row.ext_cost));
      }
    } else if (kind === "free_form") {
      // For free-form rows the only computed cell is ext_cost (cell index 3).
      // qty/unit_price are bound inputs and update themselves on user edit.
      if (cells.length >= 4) {
        paintOvrEl(cells[3], lk("ext_cost"), row.ext_cost, "money", fmtMoney(row.ext_cost));
      }
    } else if (kind === "other_rental") {
      // Cells: 0=label, 1=qty, 2=mobs, 3=ext_qty (computed), 4=unit_price,
      //        5=ext_cost (computed), 6=delete
      const qty  = row.qty != null && row.qty !== "" ? Number(row.qty) : null;
      const mobs = row.mobilizations != null && row.mobilizations !== "" ? Number(row.mobilizations) : null;
      const extQty = (qty != null && mobs != null) ? qty * mobs : null;
      if (cells.length >= 6) {
        cells[3].textContent = fmt(extQty, 2);
        paintOvrEl(cells[5], lk("ext_cost"), row.ext_cost, "money", fmtMoney(row.ext_cost));
      }
    } else {
      const item = row.productivity_rate_id ? section.itemById.get(row.productivity_rate_id) : null;
      if (cells.length >= 6) {
        cells[2].textContent = fmt(item ? item.standard_per_day : null, 0);
        cells[3].textContent = fmt(item ? item.aggressive_per_day : null, 0);
        paintOvrEl(cells[4], lk("std_total"), row.std_total, "num3", fmt(row.std_total, 3));
        paintOvrEl(cells[5], lk("agg_total"), row.agg_total, "num3", fmt(row.agg_total, 3));
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
      // Clean up any typed-over cells that belonged to the deleted line.
      for (const f of ["std_total", "agg_total", "ext_cost"]) {
        const k = `l${row.id}:${f}`;
        if (k in cellOverrides) setOverride(k, null);
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

  // Small "i" info bubble with a native tooltip — accessible, zero-JS, no
  // popover z-index headaches. Used to explain what each field/calc does.
  function infoTip(text) {
    if (!text) return "";
    return `<span class="inline-flex items-center justify-center w-3.5 h-3.5 ml-1 rounded-full bg-black/15 text-black/60 text-[9px] font-bold leading-none cursor-help align-middle select-none"
                  title="${escapeHtml(text)}">i</span>`;
  }

  function dayOverrideRow(dayType, label, hasAdder, hasBuffer) {
    const overrideKey = `${dayType}_labor_day_override`;
    const adderKey    = `${dayType}_project_time_adder`;
    const bufferKey   = `${dayType}_buffer_day_counter`;
    const naCell = `<td class="qmx-lbl" style="text-align:center;color:rgba(17,17,17,.35);font-weight:400">n/a</td>`;
    return `
      <tr>
        <td class="qmx-lbl">${escapeHtml(label)}</td>
        <td class="qmx-in">${numAttrHtml(overrideKey, { step: "0.5", placeholder: "—" })}</td>
        ${hasAdder  ? `<td class="qmx-in">${numAttrHtml(adderKey,    { step: "0.5", placeholder: "—" })}</td>` : naCell}
        ${hasBuffer ? `<td class="qmx-in">${numAttrHtml(bufferKey,   { step: "0.5", placeholder: "—" })}</td>` : naCell}
      </tr>`;
  }

  // ── GENERAL INFORMATION sheet block (BASE tab rows 7-30) ──────────────────
  // Replaces the old "Tab Settings" card: same per-set inputs (same
  // data-attr-field bindings → same PATCH save path), re-laid-out as the
  // sheet's 4-column C/D ¦ F/G grid with verbatim labels from
  // base-tab-spec.txt. Estimate-level fields the sheet mirrors from the ROLL
  // UP (Quote #, Contact, Customer, dates, …) render read-only from the
  // estimate row / estimate-state bridge.
  const fmtDate = (v) => {
    if (!v) return "—";
    const s = String(v);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[2]}/${m[3]}/${m[1]}` : escapeHtml(s);
  };

  const giLabelCell = (text, tip) =>
    `<div class="qm-cell-label"><span>${escapeHtml(text)}${infoTip(tip)}</span></div>`;
  // Read-only mirror of an estimate-level value (white cell, like the sheet's
  // cross-tab reference cells).
  const giRO = (label, html, tip) => giLabelCell(label, tip) +
    `<div class="qm-cell-value" style="background:#fff;padding:3px 8px;font-size:12px;color:#111">${html}</div>`;
  // Computed (green) cell — data-gi-calc keys are refreshed live by
  // refreshGeneralInfoCalcs().
  const giCalcCell = (label, key, html, tip) => giLabelCell(label, tip) +
    `<div class="qm-cell-value qm-calc" style="padding:3px 8px;font-size:12px;color:#111;font-variant-numeric:tabular-nums" data-gi-calc="${key}">${html ?? "—"}</div>`;
  // Editable (blue) cell hosting one of the existing attr inputs.
  const giInputCell = (label, inputHtml, tip) => giLabelCell(label, tip) +
    `<div class="qm-cell-value">${inputHtml}</div>`;
  const GI_EMPTY = `<div class="qm-cell-label"></div><div class="qm-cell-value" style="background:#fff"></div>`;

  // Live values for the block's computed/bridge-fed cells. Bridge fields are
  // included so a 'storage' event (Roll Up edited in another tab) refreshes
  // them too.
  function generalInfoCalcValues() {
    const tc  = computeTravelCosts();
    const est = readEstimateBridge();
    const crew = Number(est.crew_count ?? 0) || 0;
    const g23  = crew > 0 ? Math.ceil(tc.D23 / crew) : 0;
    const wgLf = Number(attrs.wire_guidance_linear_footage ?? 0) || 0;
    // D25/E25 — Tab Rental Duration (Rack Install), sheet formulas verbatim.
    let d25;
    if (g23 < 1)       d25 = "0";
    else if (g23 === 1) d25 = "1 day";
    else if (g23 < 8)   d25 = "1 week";
    else                d25 = `${Math.ceil(g23 / 28)} month(s)`;
    // D26/E26 — Tab Rental Duration (Wire Guidance Install).
    let d26;
    if (wgLf === 0) d26 = "0";
    else {
      const n = wgLf < 1501 ? 1 : wgLf < 3001 ? 2 : wgLf < 10501 ? 1
              : wgLf < 21001 ? 2 : Math.ceil(wgLf / 1500 / 28);
      const u = wgLf < 3001 ? "day" : wgLf < 21001 ? "week" : "month(s)";
      d26 = `${n} ${u}`;
    }
    const mobs = Number(attrs.mobilizations ?? 0) || 0;
    // Effective (override-aware) D16 for display; the raw estimate input is
    // the "calculated" reference for the override tooltip.
    const d16raw = (est.mgmt_travel_multiplier != null && est.mgmt_travel_multiplier !== "")
      ? Number(est.mgmt_travel_multiplier) : null;
    const d16key = `${setPrefix}D16`;
    const d16eff = (d16key in cellOverrides) ? Number(cellOverrides[d16key]) : d16raw;
    const mgmtMult = d16eff != null ? `${fmt(d16eff, 5)}%` : "—";
    // Raw (formula) numerics for the override-enabled cells — the tooltip /
    // editor reference values. Cheap second rollup pass, only when a typed-
    // over cell exists on this set.
    const tcRaw = hasMapOverrides() ? computeTravelCosts(false) : tc;
    const _raw = {
      d13: tcRaw.labor_cost_per_day,
      d14: tcRaw.labor_cost_per_travel_day,
      d15: tcRaw.lodging_per_day,
      d16: d16raw,
      d22: tcRaw.D22,
      d23: tcRaw.D23,
      d24: tcRaw.D24,
      g18: crew > 0 ? tcRaw.D22 / crew : null,
      g23: crew > 0 ? Math.ceil(tcRaw.D23 / crew) : null,
    };
    return {
      _raw,
      d13:      fmtMoney(tc.labor_cost_per_day),
      d14:      fmtMoney(tc.labor_cost_per_travel_day),
      d15:      fmtMoney(tc.lodging_per_day),
      d16:      mgmtMult,
      equip:    escapeHtml(est.equipment_requirement || "—"),
      breakout: escapeHtml(est.breaking_out_mobilization || "—"),
      mobwire:  fmt(mobs, 1),
      hrs:      fmt(est.one_way_travel_hrs ?? null, 1),
      crew:     escapeHtml([est.crew_count, est.crew_size]
                  .filter(v => v !== "" && v != null).join(" - ") || "—"),
      g18:      crew > 0 ? fmt(tc.D22 / crew, 1) : "—",
      d22:      fmt(tc.D22, 1),
      d23:      fmt(tc.D23, 1),
      d24:      fmt(tc.D24, 1),
      g23:      crew > 0 ? String(g23) : "—",
      d25:      escapeHtml(d25),
      d26:      escapeHtml(d26),
    };
  }

  // GENERAL INFORMATION cells that are override-enabled — data-gi-calc key →
  // sheet ref (namespaced as s{setId}:<ref>) + override display format.
  // (D25/D26 render duration TEXT and the equip/breakout/crew/hrs mirrors are
  // inputs elsewhere — those stay display-only.)
  const GI_OVR = {
    d13: { ref: "D13", fmt: "money" },
    d14: { ref: "D14", fmt: "money" },
    d15: { ref: "D15", fmt: "money" },
    d16: { ref: "D16", fmt: "pct5" },
    d22: { ref: "D22", fmt: "num1" },
    d23: { ref: "D23", fmt: "num1" },
    d24: { ref: "D24", fmt: "num1" },
    g18: { ref: "G18", fmt: "num1" },
    g23: { ref: "G23", fmt: "int" },
  };
  const GI_RESTORE = { bg: "", color: "#111" };   // the giCalcCell inline color

  function refreshGeneralInfoCalcs() {
    let vals;
    try { vals = generalInfoCalcValues(); } catch { return; }
    const raw = vals._raw || {};
    for (const [k, html] of Object.entries(vals)) {
      if (k === "_raw") continue;
      const el = container.querySelector(`[data-gi-calc="${k}"]`);
      if (!el) continue;
      const cfg = GI_OVR[k];
      if (cfg) paintOvrEl(el, `${setPrefix}${cfg.ref}`, raw[k], cfg.fmt, html, undefined, GI_RESTORE);
      else el.innerHTML = html;
    }
  }

  function generalInfoBlockHtml() {
    const er = estimateRow || {};
    const v  = generalInfoCalcValues();
    const factor = currentEnvFactor();
    const inheritedEst = (readEstimateBridge().estimate_type || "Standard");
    const estPlaceholder = `Inherit from Roll Up (${inheritedEst})`;
    const roTxt = (x) => (x == null || x === "") ? "—" : escapeHtml(String(x));
    const contact = [er.contact_first, er.contact_last].filter(Boolean).join(" ");

    const envInput = `
      <div style="display:flex;align-items:center;gap:6px">
        ${selectAttrHtml("installation_environment", ENV_FACTOR_OPTS)}
        <span style="font-size:10px;color:rgba(17,17,17,.45);white-space:nowrap;padding-right:6px" data-env-factor>
          factor ${factor != null ? Number(factor).toFixed(1) : "—"}
        </span>
      </div>`;

    const gridCells = `
      ${giRO("Quote #: ", roTxt(er.quote_number))}
      ${giRO("Quote Description (Short)", roTxt(er.quote_description))}
      ${giRO("Contact", roTxt(contact))}
      ${GI_EMPTY}
      ${giRO("Customer", roTxt(er.customer_display_name))}
      ${giRO("End User", roTxt(er.end_user))}
      ${giRO("Quoted By (First and Last Initials)", roTxt(er.quoted_by))}
      ${giRO("Quote Notes", roTxt(er.quote_notes))}
      ${giRO("Date of Request - ORIGINAL", fmtDate(er.date_of_request))}
      ${GI_EMPTY}
      ${giCalcCell("Labor Cost Per Day (Local or Out of Town)", "d13", v.d13,
        "Derived from One-Way Travel + Crew Size on the ROLL UP tab.")}
      ${GI_EMPTY}
      ${giCalcCell("Labor Cost Per TRAVEL Day", "d14", v.d14)}
      ${GI_EMPTY}
      ${giCalcCell("Lodging Cost Per Day (<6 Days Hotel, >6 AB&B)", "d15", v.d15)}
      ${GI_EMPTY}
      ${giCalcCell("Mgmt Travel Multiplier", "d16", v.d16)}
      ${giRO("Start Date", fmtDate(er.start_date))}
      ${giCalcCell("Equipment Requirement (Electric vs. LP)", "equip", v.equip)}
      ${giRO("End Date (7-Days a week)", fmtDate(er.end_date))}
      ${giRO("Rack Height (Tall Equipment vs Short Equipment)", roTxt(er.rack_height))}
      ${giCalcCell("Tab Travel Days Per Crew", "g18", v.g18)}
      ${giInputCell("Expected / Estimated Mobilization Count (RACK)",
          numAttrHtml("mobilizations", { step: "0.5", placeholder: "0" }),
          "Mobilizations for this tab. Multiplies travel days, hauling trips, and the Mobilization / Remobilization bundles.")}
      ${giCalcCell("Breaking Out Mobilization?", "breakout", v.breakout)}
      ${giCalcCell("Expected / Estimated Mobilization Count (WIRE GUIDE)", "mobwire", v.mobwire,
          "Mirrors the RACK mobilization count (sheet D20 = D19).")}
      ${giRO("Rent Wire Guidance Equipment?", roTxt(er.rent_wire_guidance_equipment))}
      ${giCalcCell("One-Way Travel time from Houston or Dallas, TX to Job Site (Hrs.)", "hrs", v.hrs)}
      ${giInputCell("Estimate Type",
          selectAttrHtml("estimate_type_override", ESTIMATE_TYPE_OPTS, { placeholder: estPlaceholder }),
          "defaults to ROLL UP - Can Be Overwritten")}
      ${giCalcCell("TAB Travel Days", "d22", v.d22)}
      ${giCalcCell("Crew Count - Size", "crew", v.crew)}
      ${giCalcCell("Tab Labor Days (Rack)", "d23", v.d23)}
      ${giCalcCell("Tab Labor Days (Rack) Per Crew", "g23", v.g23)}
      ${giCalcCell("Tab Labor Days (Wire Guidance)", "d24", v.d24)}
      ${giInputCell("Scissor Lifts Per Crew",
          numAttrHtml("scissor_lifts_per_crew", { step: "1", placeholder: "0" }),
          "defaults to 2 - Can Be Overwritten")}
      ${giCalcCell("Tab Rental Duration (Rack Install)", "d25", v.d25)}
      ${giInputCell("Forklifts Per Crew",
          numAttrHtml("forklifts_per_crew", { step: "1", placeholder: "0" }))}
      ${giCalcCell("Tab Rental Duration (Wire Guidance Install)", "d26", v.d26)}
      ${giInputCell("Scrubbers Per Wire Scope",
          numAttrHtml("scrubbers_per_wire_scope", { step: "1", placeholder: "0" }),
          "defaults to 1 - Can Be Overwritten")}
      ${GI_EMPTY}
      ${giInputCell("Saws Per Wire Scope",
          numAttrHtml("saws_per_wire_scope", { step: "1", placeholder: "0" }))}
      ${GI_EMPTY}
      ${giInputCell("Installation Environment", envInput,
          "Environment day-factor applied to labor days: Ambient ×1.0, Freezer 20–32° ×1.5, Blast Freezer −20–20° ×2.0.")}
      ${GI_EMPTY}
      ${giInputCell("Wire Guidance Linear Footage",
          numAttrHtml("wire_guidance_linear_footage", { step: "1", placeholder: "0" }),
          "enter linear footage here")}
    `;

    // Partial Crew Warning (sheet J7:M11, merged banner above the Day Type
    // table): partial crews break the per-day production math, so the sheet
    // tells the estimator to use the manual day counts below instead.
    const _crewSize = readEstimateBridge().crew_size || "";
    const _partial = _crewSize && String(_crewSize).toLowerCase() !== "full";
    const partialCrewWarn = `
      <div style="display:flex;border-top:1px solid #b7b7b7">
        <div style="flex:0 0 160px;background:#efefef;color:#111;font-size:11px;font-weight:700;padding:4px 8px;border-right:1px solid #b7b7b7">Partial Crew Warning</div>
        <div style="flex:1;padding:4px 8px;font-size:11px;font-weight:700;${_partial
          ? "background:#ffe599;color:#7f6000"
          : "background:#fff;color:rgba(0,0,0,.35)"}">${_partial
          ? "SHOULD ONLY USE MANUAL DAY COUNTS"
          : `Crew size is ${escapeHtml(_crewSize || "Full")} — no warning`}</div>
      </div>`;

    // Day Type mini-table (sheet J13:M23) — verbatim column headers.
    const dayTypeTable = `
      ${partialCrewWarn}
      <table class="qmx-table" style="border-top:1px solid #b7b7b7">
        <thead>
          <tr>
            <th style="width:120px">Day Type</th>
            <th>Labor Day Override for Simple Quotes${infoTip("RAW simple-quote day estimate (workbook K20). Replaces the line-item production days as the calc base; environment factor + half-day rounding still apply. Blank = use the line items.")}</th>
            <th>Project Time Adder${infoTip("Extra days added on top of the base for schedule buffer. Creates the Buffer bundle line (marked up at the rack profit target) — NOT extra on-site labor cost.")}</th>
            <th>Buffer Day Counter${infoTip("Buffer days = ceilHalf((base + adder) × env) − ceilHalf(base × env).")}</th>
          </tr>
        </thead>
        <tbody>
          ${dayOverrideRow("rack_install",  "Rack Install",  true,  true)}
          ${dayOverrideRow("wire_guidance", "Wire Guidance", true,  true)}
          ${dayOverrideRow("downtime",      "Downtime",      false, false)}
          ${dayOverrideRow("travel",        "Travel",        false, false)}
        </tbody>
      </table>`;

    return `
      <div class="qm-sheet qmx-box" data-tab-settings style="border-color:#000">
        <div class="qm-banner">
          <span>GENERAL INFORMATION</span>
          <button type="button" data-reset-tab-settings
                  class="text-[10px] font-semibold uppercase tracking-wide text-white/70 hover:text-white px-1.5 py-0.5 rounded hover:bg-white/10 whitespace-nowrap"
                  title="Clear every override on this tab">Reset Tab Settings</button>
        </div>
        <div class="qm-grid4">${gridCells}</div>
        ${dayTypeTable}
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
  // `useOverrides = false` gives the pure formula values (typed-over map
  // cells ignored; per-line overrides still apply — they transform the line
  // data itself). Used for the "Calculated: …" tooltips on overridden cells.
  function computeTravelCosts(useOverrides = true) {
    const est = readEstimateBridge();
    const allLines = [];
    for (const code of Object.keys(sections)) {
      for (const row of sections[code].rows) {
        allLines.push({ ...row, section_code: row.section_code || code });
      }
    }
    const rollup = computeSetRollup({
      set:           { ...baseSet, ...attrs },
      lines:         applyLineOverrides(allLines, cellOverrides),
      lookups,
      estimateState: est,
      overrides:     useOverrides ? cellOverrides : null,
      keyPrefix:     setPrefix,
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

  // ── Auto-derived Other-Rentals (Environmental Fees / Propane / Hauling) ───────
  // The BASE sheet computes these "Other Rentals" line items by formula; the app
  // historically left them as manual entry, which drifts from the workbook. We
  // now auto-derive them (with a manual-override escape hatch), mirroring the
  // live Google-Drive RELEASE-template formulas confirmed by the 2026-07 audit:
  //   Environmental Fees  G203/G240 = 1.9% × (lift equipment ext-cost)
  //   Liquid Propane rack H205       = 0 if Electric, else
  //                                    MIN( crew × (scissor+forklift per crew)
  //                                         × rackLaborDays × $40 ,
  //                                         liftQty × periodRate )
  //                       periodRate  day $40 / week $200 / month $500 (ref AB4:AC7),
  //                                   chosen by roundup(rackLaborDays / crew).
  //   Liquid Propane wire H242       = ceilHalf(WG_LF / 1500) × $40 when WG in scope.
  //   Hauling rack  D204/H204        = roundup((scissor+forklift per crew)×crew / 3)
  //                                    × 2 (round trip) trips × mobs × $175, when
  //                                    rack lifts exist.
  //   Hauling wire  D241/H241        = 2 trips × mobs × $175, when WG in scope.
  // Each suggestion is a {qty, mobilizations, unit_price, ext} shape so Hauling
  // reads naturally as "trips × mobs × $175" in the row. A row's `notes` carries
  // the override state: "auto:<kind>" (keep in sync) vs "manual:<kind>" (user
  // owns the value). Untouched seed rows adopt as auto.
  const ceilHalf2 = (x) => Math.ceil(Number(x) * 2) / 2;
  const round2    = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
  const SMART_RENTAL_SECTIONS = ["other_rentals_rack_install", "other_rentals_wire_guidance"];
  const ENV_FEE_PCT            = 0.019;                    // G203 / G240
  const PROPANE_RATE_BY_PERIOD = { day: 40, week: 200, month: 500 };  // reference AB4:AC7
  const PROPANE_WG_RATE        = 40;                       // G242
  const PROPANE_WG_LF_PER_UNIT = 1500;                     // F242 = ceiling(G29/1500, 0.5)
  const HAUL_RATE              = 175;                      // G204 / G241

  // A suggested value expressed in the other_rental row shape (qty × mobs × unit).
  const suggestion = (qty, mobs, unit) => ({
    qty, mobilizations: mobs, unit_price: unit,
    ext: round2((Number(qty) || 0) * (Number(mobs) || 0) * (Number(unit) || 0)),
  });

  function smartRowKind(code, row) {
    if (!SMART_RENTAL_SECTIONS.includes(code)) return null;
    const lbl = String(row.label || "").toLowerCase();
    if (lbl.includes("environmental")) return "env";
    if (lbl.includes("propane"))       return "propane";
    if (lbl.includes("hauling"))       return "hauling";
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
    const scissor = Number(attrs.scissor_lifts_per_crew ?? 0) || 0;
    const fork    = Number(attrs.forklifts_per_crew ?? 0) || 0;
    const mobs    = (Number(attrs.mobilizations ?? 0) || 0) > 0
                      ? Number(attrs.mobilizations) : 1;    // E204/E241: min 1
    const rackLiftExt = sumSectionExt("rentals_rack_install");
    const wireLiftExt = sumSectionExt("rentals_wire_guidance");
    const wgLf = Number(attrs.wire_guidance_linear_footage ?? 0) || 0;
    const wgInScope = wgLf > 0 || wireLiftExt > 0;

    // Environmental Fees — 1.9% of lift ext-cost, carried as unit_price.
    const envRack = suggestion(1, 1, round2(ENV_FEE_PCT * rackLiftExt));
    const envWire = suggestion(1, 1, round2(ENV_FEE_PCT * wireLiftExt));

    // Rack propane — MIN(labor-day cap, lift × period rate); 0 when electric.
    let propRackVal = 0;
    if (!electric) {
      const rackLaborDays = Number(tc.D23 ?? 0) || 0;
      const rate    = propanePeriodRate(rackLaborDays, crew);
      const liftQty = sumLiftQty("rentals_rack_install", ["scissor", "forklift"]);
      const liftTerm = liftQty * rate;
      const cap     = crew * (scissor + fork) * rackLaborDays * 40;
      propRackVal = liftTerm > 0 ? round2(cap > 0 ? Math.min(cap, liftTerm) : liftTerm) : 0;
    }
    // Wire-guidance propane — footage-based, only when WG is in scope.
    const propWireVal = wgLf > 0
      ? round2(ceilHalf2(wgLf / PROPANE_WG_LF_PER_UNIT) * PROPANE_WG_RATE) : 0;

    // Hauling — round-trip trips × mobilizations × $175, when equipment exists.
    const rackTrips = rackLiftExt > 0
      ? Math.ceil((scissor + fork) * crew / 3) * 2 : 0;
    const haulRack = suggestion(rackTrips, mobs, HAUL_RATE);
    const haulWire = suggestion(wgInScope ? 2 : 0, mobs, HAUL_RATE);

    return {
      other_rentals_rack_install:  {
        env: envRack, propane: suggestion(1, 1, propRackVal), hauling: haulRack,
      },
      other_rentals_wire_guidance: {
        env: envWire, propane: suggestion(1, 1, propWireVal), hauling: haulWire,
      },
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
          const target = sugg[code][kind];               // {qty, mobilizations, unit_price, ext}
          row._autoSuggest = target;                    // renderer reads this for the hint
          if (locked) return;                            // read-only estimate — show, never write
          if (autoState(row) !== "auto") return;
          const cur = row.ext_cost == null ? null : Number(row.ext_cost);
          // Don't write a 0 onto a still-pristine seed row — only when a real
          // value applies, or when a previously-auto value must fall back to 0.
          const pristineZero = target.ext === 0 && row.ext_cost == null;
          const needsWrite = !pristineZero &&
            (cur !== target.ext ||
             Number(row.qty) !== target.qty ||
             Number(row.mobilizations) !== target.mobilizations ||
             Number(row.unit_price) !== target.unit_price ||
             !String(row.notes || "").startsWith("auto:"));
          if (needsWrite) {
            row.qty = target.qty; row.mobilizations = target.mobilizations;
            row.unit_price = target.unit_price; row.ext_cost = target.ext;
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
        <span class="text-sm ${opts.bold ? "font-bold" : "text-black/70"}">${escapeHtml(label)}${infoTip(opts.tip)}</span>
        <span class="text-sm tabular-nums ${opts.bold ? "font-bold" : "font-semibold"}">${fmtMoney(value)}</span>
      </div>`;
    return `
      <div class="text-[11px] italic text-black/40 pb-2">Cost checker · ${escapeHtml(tc.estimate_type)} estimate${infoTip("Internal cost basis (before OH&P markup) across the 6 top-level sections. The customer price comes from the QuickBooks Bundle Output card, which adds OH&P.")}</div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-8">
        <div>
          ${row("Travel Costs (H32)", tc.section_total, { tip: "Lodging + Mgmt Travel + Travel-Day labor. Zero for local jobs (≤1 hr one-way)." })}
          ${row("Rack Installation (H38)", tc.H38, { tip: "Materials + Contract Labor for the rack install." })}
          <div class="pl-6 text-xs">
            ${row("Materials (H39)", tc.H39)}
            ${row("Contract Labor (H44)", tc.H44, { tip: "Tab Labor Days (Rack) × labor cost/day. Tab Labor Days = ceilHalf((base + time-adder) × env)." })}
          </div>
          ${row("Rentals - Rack Install (H187)", tc.H187, { tip: "Lift rentals + Other Rentals (Environmental Fees, Hauling, Propane, Dumpster)." })}
        </div>
        <div>
          ${row("Wire Guidance Labor (H213)", tc.H213, { tip: "WG Materials + WG Contract Labor (Tab Labor Days (Wire) × labor cost/day)." })}
          <div class="pl-6 text-xs">
            ${row("Materials (H214)", tc.H214)}
            ${row("Contract Labor (H220)", tc.H220)}
          </div>
          ${row("Rentals - Wire Guidance (H226)", tc.H226)}
          ${row("Wire Guidance Add'l Items (H248)", tc.H248, { tip: "Slurry Tank, Line Drivers, Magnets, RFID Tags." })}
          ${row("PROJECT COST TOTAL", tc.grand_total, { bold: true, divider: true, tip: "Sum of the 6 sections — the internal cost basis, not the customer price." })}
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
  function computeAllBundles(useOverrides = true) {
    const allLines = [];
    for (const code of Object.keys(sections)) {
      for (const row of sections[code].rows) {
        allLines.push({ ...row, section_code: row.section_code || code });
      }
    }
    return computeSetBundles({
      set:           { ...baseSet, ...attrs },
      lines:         applyLineOverrides(allLines, cellOverrides),
      lookups,
      estimateState: readEstimateBridge(),
      overrides:     useOverrides ? cellOverrides : null,
      keyPrefix:     setPrefix,
    });
  }

  // FULL COSTING TABLE (BASE sheet cols R/S, rows 2-47) — the priced rollup
  // shown as a sticky right pane. Row labels are VERBATIM from
  // base-tab-spec.txt (including the sheet's "(hidden)" markers, which the
  // sheet keeps visible on this tab). Values come LIVE from computeSetBundles
  // — the exact math the Review tab already validates; children map 1:1 onto
  // each bundle's lines array (same order as the sheet rows).
  // NOTE: the BASE tab spec ends at S47 — it has NO Dismantle bundle and NO
  // "TOTAL PRICE TO CUSTOMER" cell (that lives on the ROLL UP tab). The
  // closing total row here is the app's sum of the 7 bundle totals so the
  // pane reads complete; it is labeled as such.
  const COSTING_LAYOUT = [
    { key: "installation",   children: ["Contract Labor (hidden)", "Materials (hidden)", "Mgmt Travel (hidden)", "Buffer", "Lodging (hidden)", "OH&P (hidden)"] },
    { key: "rentals",        children: ["Equipment - Lifts", "Dumpsters / Site Rentals", "Propane", "OH&P (hidden)"] },
    { key: "wg_labor",       children: ["Contract Labor (hidden)", "Materials (hidden)", "Mgmt Travel (hidden)", "Lodging (hidden)", "Buffer", "Floor Scrubber", "Propane", "OH&P (hidden)"] },
    { key: "wg_additional",  children: ["Slurry Tank - NOT OPTIONAL", "Line Drivers - OPTIONAL - Usually by Customer", "Magnets - OPTIONAL", "RFID Tags - OPTIONAL", "OH&P (hidden)"] },
    { key: "mobilization",   children: ["Materials (hidden)", "Contract Labor - Travel (hidden)", "Mgmt Travel (hidden)", "Lodging (hidden)", "OH&P (hidden)"] },
    { key: "remobilization", children: ["Materials (hidden)", "Contract Labor (hidden)", "Mgmt Travel (hidden)", "Lodging (hidden)", "OH&P (hidden)"] },
    { key: "downtime",       children: ["Materials (hidden)", "Contract Labor (hidden)", "Mgmt Travel (hidden)", "Lodging (hidden)", "OH&P (hidden)"] },
  ];

  // Sheet S-row of each bundle's total row; children follow sequentially
  // (installation total = S3, its children S4..S9, etc.).
  const S_START = {
    installation: 3, rentals: 10, wg_labor: 15, wg_additional: 24,
    mobilization: 30, remobilization: 36, downtime: 42,
  };

  function costingTableHtml() {
    let b, bRaw;
    try {
      b = computeAllBundles();
      // Pure formula values for the "Calculated: …" tooltips of typed-over
      // cells; identical object when nothing is typed over.
      bRaw = hasMapOverrides() ? computeAllBundles(false) : b;
    }
    catch (err) {
      return `<div class="px-3 py-2 text-xs text-red-600">Costing table failed: ${escapeHtml(err?.message || String(err))}</div>`;
    }
    let grand = 0;
    const rowsHtml = COSTING_LAYOUT.map(({ key, children }) => {
      const bundle = b[key];
      if (!bundle) return "";
      const bundleRaw = bRaw[key] || bundle;
      const sRow = S_START[key];
      grand += Number(bundle.total) || 0;
      const pTot = ovrCellParts(`${setPrefix}S${sRow}`, bundleRaw.total, "money",
                                fmtMoney(bundle.total), bundle.total);
      const parent = `
        <tr>
          <td class="qmx-lbl qmx-strong">${escapeHtml(bundle.title)}</td>
          <td class="qmx-out qmx-strong"${pTot.attrs}>${pTot.inner}</td>
        </tr>`;
      const kids = bundle.lines.map((ln, i) => {
        const p = ovrCellParts(`${setPrefix}S${sRow + 1 + i}`,
                               Number(bundleRaw.lines?.[i]?.[1]) || 0, "money",
                               fmtMoney(ln[1]), ln[1]);
        return `
        <tr>
          <td class="qmx-lbl" style="padding-left:22px;font-weight:400;color:rgba(17,17,17,.75)">${escapeHtml(children[i] ?? ln[0])}</td>
          <td class="qmx-out"${p.attrs}>${p.inner}</td>
        </tr>`;
      }).join("");
      return parent + kids;
    }).join("");
    return `
      <table class="qmx-table">
        <tbody>
          ${rowsHtml}
          <tr>
            <td class="qmx-strong" style="background:#000;color:#fff;padding:4px 6px;font-size:12px"
                title="Sum of the 7 bundle totals above (the sheet's TOTAL PRICE TO CUSTOMER lives on the ROLL UP tab)">TOTAL PRICE TO CUSTOMER</td>
            <td class="qmx-strong" style="background:#000;color:#fff;text-align:right;padding:4px 6px;font-size:12px;font-variant-numeric:tabular-nums">${fmtMoney(grand)}</td>
          </tr>
        </tbody>
      </table>`;
  }

  function renderBundleOutput() {
    const body = document.querySelector("[data-bundle-output] [data-qm-section-body]");
    if (body) body.innerHTML = costingTableHtml();
  }

  // TRAVEL COSTS (BASE sheet rows 32-35) — sheet-styled rows Lodging / Mgmt
  // Travel / Travel Day Costs (labels + "Total" column verbatim) + the H32
  // section total. Same computeTravelCosts() feed as before.
  function travelCostsCardHtml() {
    const tc = computeTravelCosts();
    const warn = tc.labor_cost_per_day === 0
      ? `<div class="m-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
           Labor Cost / Day is 0 — set <strong>One-Way Travel time</strong> + <strong>Crew Size</strong> on the ROLL UP tab to populate Travel Costs.
         </div>`
      : "";
    const oorWarn = tc.hrs_out_of_range
      ? `<div class="m-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
           One-Way Travel exceeds 38 hours — Travel Days fall back to 0. Verify the value on the ROLL UP tab.
         </div>`
      : "";
    const r = (label, value) => `
      <tr>
        <td class="qmx-lbl">${escapeHtml(label)}</td>
        <td class="qmx-lbl" style="text-align:right;color:rgba(17,17,17,.55);width:70px">Total</td>
        <td class="qmx-out" style="width:130px">${fmtMoney(value)}</td>
      </tr>`;
    return `
      <table class="qmx-table">
        <tbody>
          ${r("Lodging",          tc.lodging)}
          ${r("Mgmt Travel",      tc.mgmt_travel)}
          ${r("Travel Day Costs", tc.travel_day_costs)}
          <tr>
            <td class="qmx-lbl qmx-strong" colspan="2" style="text-align:right">TOTAL:</td>
            <td class="qmx-out qmx-strong">${fmtMoney(tc.section_total)}</td>
          </tr>
        </tbody>
      </table>
      ${warn}
      ${oorWarn}`;
  }

  function renderTravelCosts() {
    const body = document.querySelector("[data-travel-costs] [data-qm-section-body]");
    if (body) body.innerHTML = travelCostsCardHtml();
    // The General Info block's green cells share the same inputs — keep them
    // in lockstep with every Travel Costs refresh.
    refreshGeneralInfoCalcs();
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
  // Sheet-parity layout (plan step 4): two panes on wide screens — sections in
  // exact sheet row order on the left (~2/3), the sticky FULL COSTING TABLE on
  // the right (~1/3); the right pane stacks ABOVE the sections on narrow
  // screens. Group banners = the sheet's black col-B section banners.
  // Real CSS in a page-local <style> block (output.css is prebuilt — new
  // Tailwind utilities silently no-op).
  const groupBanner = (title) => `
    <div class="qm-banner" style="border-radius:2px"><span>${escapeHtml(title)}</span></div>`;

  const pageStyle = `
    <style>
      [data-qm-layout]{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(300px,1fr);gap:12px;align-items:start;color:#111}
      [data-qm-main]{display:grid;gap:8px;min-width:0}
      [data-qm-side]{position:sticky;top:12px;max-height:calc(100vh - 24px);overflow-y:auto;display:grid;gap:12px;min-width:0}
      @media (max-width:1150px){
        [data-qm-layout]{grid-template-columns:minmax(0,1fr)}
        [data-qm-side]{position:static;max-height:none;order:-1}
      }
      .qmx-box{background:#fff;border:1px solid #666;border-radius:2px;overflow:hidden}
      .qmx-table{border-collapse:collapse;width:100%;background:#fff;table-layout:auto}
      .qmx-table th{background:#efefef;color:#111;font-size:11px;font-weight:700;text-align:right;padding:3px 6px;border:1px solid #b7b7b7}
      .qmx-table th:first-child{text-align:left}
      .qmx-table td{border:1px solid #b7b7b7;font-size:12px;color:#111;padding:3px 6px;background:#fff}
      .qmx-table td.qmx-lbl{background:#fff;font-weight:600;font-size:11.5px}
      .qmx-table td.qmx-in{background:#cfe2f3;padding:0;vertical-align:middle}
      .qmx-table td.qmx-in input,.qmx-table td.qmx-in select{background:#cfe2f3;border:0;border-radius:0;box-shadow:none;width:100%;padding:3px 6px;font-size:12px;color:#111;min-height:0;margin:0}
      .qmx-table td.qmx-in input[type=number]{text-align:right;font-variant-numeric:tabular-nums}
      .qmx-table td.qmx-in input::placeholder{color:rgba(17,17,17,.45)}
      .qmx-table td.qmx-in input:focus,.qmx-table td.qmx-in select:focus{outline:2px solid #1a73e8;outline-offset:-2px;background:#fff}
      .qmx-table td.qmx-out{background:#d9ead3;text-align:right;font-variant-numeric:tabular-nums}
      .qmx-table td.qmx-del{background:#fff;text-align:center;padding:0 2px;width:26px}
      .qmx-strong{font-weight:700}
      .qmx-sec-head{width:100%;display:flex;align-items:center;gap:10px;background:#efefef;border-bottom:1px solid #b7b7b7;padding:4px 8px;cursor:pointer;text-align:left}
    </style>`;

  // Mirrors the workbook's B-column banner order on tab "1.0 BASE Quoting
  // Metrics" (sheet parity — OPI feedback #1). `sub` renders an inner divider
  // before a code (the sheet's CONTRACT LABOR COSTS header inside RACK
  // INSTALLATION).
  const SECTION_GROUPS = [
    { title: "RACK INSTALLATION", codes: [
      "materials_rack_install",
      "teardrop_racking", "bolted_racking", "wire_decking", "anchors",
      "cantilever_racking", "high_density_storage", "mezz_pick_modules",
      "rack_protection", "safety_netting", "shelving", "miscellaneous",
    ], sub: { before: "teardrop_racking", title: "CONTRACT LABOR COSTS (RACK INSTALLATION)" }},
    { title: "RENTALS - RACK INSTALL", codes: [
      "rentals_rack_install", "other_rentals_rack_install",
    ]},
    { title: "WIRE GUIDANCE (LABOR)", codes: [
      "materials_wire_guidance", "wire_guidance_contract_labor",
    ]},
    { title: "RENTALS - WIRE GUIDANCE INSTALL", codes: [
      "rentals_wire_guidance", "other_rentals_wire_guidance",
    ]},
    { title: "WIRE GUIDANCE ADDITIONAL ITEMS", codes: [
      "wire_guidance_additional",
    ]},
    { title: "LABOR BLOCKS", codes: [
      "downtime_labor", "remobilization_labor", "dismantle_labor",
      "mobilization_labor", "upright_assembly_labor", "anchor_holes_labor",
      "wedge_anchors", "miscellaneous_labor",
    ]},
  ];

  const groupedSectionsHtml = SECTION_GROUPS.map(g => `
    ${groupBanner(g.title)}
    ${g.codes.map(c => `${g.sub && g.sub.before === c ? groupBanner(g.sub.title) : ""}${sectionCardHtml(c)}`).join("")}
  `).join("");

  const bodyHtml = `
    ${pageStyle}
    <div data-qm-layout class="qm-sheet pb-3">

      <div data-qm-main>
        ${generalInfoBlockHtml()}

        ${groupBanner("BUNDLES")}
        <div class="qm-sheet qmx-box" data-travel-costs>
          <div class="qm-banner"><span>TRAVEL COSTS</span></div>
          <div data-qm-section-body>${travelCostsCardHtml()}</div>
        </div>

        ${groupedSectionsHtml}
      </div>

      <div data-qm-side>
        <div class="qm-sheet qmx-box" data-bundle-output style="border-color:#000">
          <div class="qm-banner"><span>FULL COSTING TABLE</span></div>
          <div data-qm-section-body>${costingTableHtml()}</div>
        </div>
        <div class="qm-sheet qmx-box" data-cost-summary>
          <div class="qm-banner"><span>Cost Checker</span></div>
          <div data-qm-section-body style="padding:6px 10px">${costSummaryCardHtml()}</div>
        </div>
      </div>

    </div>`;

  container.innerHTML = bodyHtml;

  // Populate the auto-derived Env-Fee / Propane rows on first paint (and adopt
  // any untouched seed rows into auto-management), then re-sync the computed
  // panes (their first paint ran before the auto rows were written).
  refreshAutoRentalRows();
  renderTravelCosts();
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
      // These per-crew / footage / mobilization inputs feed the auto
      // Env-Fee / Propane / Hauling math.
      if (["scissor_lifts_per_crew", "forklifts_per_crew", "wire_guidance_linear_footage", "mobilizations"].includes(attrField)) {
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
    // Override cells: ↺ revert first (it sits inside the cell), then
    // click-to-type-over on any override-enabled green cell.
    const rvBtn = e.target.closest("[data-ovr-revert]");
    if (rvBtn) {
      e.preventDefault();
      e.stopPropagation();
      const key = rvBtn.getAttribute("data-ovr-revert");
      setOverride(key, null);
      repaintAfterOverride(key);
      return;
    }
    const ovrCell = e.target.closest("[data-ovr-key]");
    if (ovrCell) {
      if (!locked) beginOverrideEdit(ovrCell);
      return;
    }

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
    if (_paneTimer) { clearTimeout(_paneTimer); _paneTimer = null; }
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
