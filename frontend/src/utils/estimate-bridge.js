// The ROLL UP inputs the BASE/OPTION tabs, Estimate PDF, Send-to-QBO summary
// and Save & Send all price from. Built from THIS quote's saved row; a
// same-quote copy published by its ROLL UP in the last few minutes wins so an
// edit whose debounced save hasn't landed yet is still honored. Never shared
// across quotes — one browser-wide slot leaked one quote's inputs into another.

const KEY_PREFIX = "opi_estimate_state_v2:";
const FRESH_MS = 5 * 60 * 1000;

export const BRIDGE_FIELDS = [
  "one_way_travel_hrs", "equipment_requirement", "rack_height", "crew_count", "crew_size",
  "lodging_cost_per_day", "mgmt_travel_multiplier", "estimate_type",
  "breaking_out_mobilization", "rack_install_profit_target", "rental_rack_profit_target",
  "mobilization_profit_target", "wire_guidance_profit_target", "rental_wire_profit_target",
  "price_adjustment",
];

export const bridgeKey = (estimateId) => KEY_PREFIX + estimateId;

function lookupNum(lookups, category, key) {
  const row = (lookups?.[category] || []).find(r => r.key === key);
  return row && row.value_num != null ? row.value_num : null;
}

// Mirrors the ROLL UP's computeLodgingCostPerDay (derived, not stored).
export function lodgingPerDay(lookups, travelHrs, crewSize) {
  if (travelHrs === "" || travelHrs == null) return "";
  const h = Number(travelHrs);
  if (Number.isNaN(h) || !crewSize) return "";
  const crewNum = lookupNum(lookups, "crew_size", crewSize);
  if (crewNum == null) return "";
  if (h <= 1) return 0;
  const base = lookupNum(lookups, "lodging", "Hotel");
  return base == null ? "" : (base / 5) * crewNum;
}

export function estimateStateFromRow(row, lookups) {
  const s = {};
  for (const k of BRIDGE_FIELDS) {
    const v = row ? row[k] : null;
    s[k] = (v === null || v === undefined) ? "" : v;
  }
  if (s.mgmt_travel_multiplier === "") s.mgmt_travel_multiplier = 3.56559;
  s.lodging_cost_per_day = lodgingPerDay(lookups, s.one_way_travel_hrs, s.crew_size);
  return s;
}

export function publishEstimateBridge(estimateId, state) {
  try {
    const subset = {};
    for (const k of BRIDGE_FIELDS) subset[k] = state[k];
    localStorage.setItem(bridgeKey(estimateId), JSON.stringify({ ts: Date.now(), state: subset }));
  } catch (_) { /* storage unavailable — the row is still the source */ }
}

export function readEstimateBridge(estimateId, row, lookups) {
  const fromRow = estimateStateFromRow(row, lookups);
  try {
    const raw = JSON.parse(localStorage.getItem(bridgeKey(estimateId)) || "null");
    if (raw && raw.state && Date.now() - (raw.ts || 0) < FRESH_MS) return { ...fromRow, ...raw.state };
  } catch (_) { /* ignore */ }
  return fromRow;
}

// The Estimate PDF tab's edited model (scope/BOM, bill-to, descriptions) is
// kept per quote id on this device; a new revision starts from its parent's.
export function copyPdfModel(fromId, toId) {
  try {
    const raw = localStorage.getItem(`opi_pdf_model_${fromId}`);
    if (raw && !localStorage.getItem(`opi_pdf_model_${toId}`)) localStorage.setItem(`opi_pdf_model_${toId}`, raw);
  } catch (_) { /* ignore */ }
}
