// Quoting Metrics rollup math — pure compute, no DOM, no closures.
//
// Mirrors the per-set math currently embedded in base-quoting-metrics.js
// (computeBufferDays / computeTravelCosts). Lives here so the Review tab
// can call it once per metric set + aggregate across enabled sets.
//
// Eventually base-quoting-metrics.js should be refactored to consume this
// same module (single source of truth). For now there is some duplication
// — keep the formulas in sync if either changes.

const ceil10   = (x) => Math.ceil(Number(x) / 10) * 10;
const ceilHalf = (x) => Math.ceil(Number(x) * 2) / 2;
const isYes    = (s) => String(s ?? "").toLowerCase() === "yes";
const isNo     = (s) => String(s ?? "").toLowerCase() === "no";

function lookupValueNum(lookups, category, key) {
  const rows = lookups?.[category];
  if (!Array.isArray(rows) || !key) return null;
  const row = rows.find(r => r.key === key);
  return (row && row.value_num != null) ? Number(row.value_num) : null;
}

function travelDaysFromHrs(lookups, hrs) {
  if (hrs == null || hrs === "") return 0;
  const h = Number(hrs);
  if (Number.isNaN(h) || h > 38) return 0;
  const rows = lookups?.project_travel_day_calculator;
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const eligible = rows
    .map(r => ({ threshold: Number(r.key), value: r.value_num }))
    .filter(r => !Number.isNaN(r.threshold) && r.value != null && r.threshold <= h)
    .sort((a, b) => b.threshold - a.threshold);
  return eligible.length ? Number(eligible[0].value) * 2 : 0;
}

function computeBufferDays(override, adder, baseDays, envFactor) {
  const ovr  = (override != null && Number(override) > 0) ? Number(override) : null;
  const base = ovr != null ? ovr : Number(baseDays || 0);
  const a    = Number(adder || 0);
  const env  = Number(envFactor || 1);
  return ceilHalf((base + a) * env) - ceilHalf(base * env);
}

// Section codes that contribute to "Rack Contract Labor" totals.
const RACK_LABOR_SECTIONS = [
  "teardrop_racking", "bolted_racking", "wire_decking", "anchors",
  "cantilever_racking", "high_density_storage", "mezz_pick_modules",
  "rack_protection", "safety_netting", "shelving", "miscellaneous",
];

/**
 * Compute the per-set rollup totals for a single metric set.
 *
 * @param {Object}   args
 * @param {Object}   args.set                Metric set row (includes per-set attrs).
 * @param {Array}    args.lines              All metric lines belonging to this set.
 * @param {Object}   args.lookups            lookup_values response (grouped by category).
 * @param {Object}   args.estimateState      Estimate inputs used by the per-set math
 *                                            (one_way_travel_hrs, crew_count, crew_size,
 *                                             lodging_cost_per_day, mgmt_travel_multiplier,
 *                                             estimate_type, breaking_out_mobilization,
 *                                             rack_install_profit_target,
 *                                             mobilization_profit_target).
 *
 * @returns {Object} {
 *    labor_cost_per_day, env_factor, mobilizations,
 *    D22, D23, D24,
 *    H39, H44, H38, H214, H220, H213, H187, H226, H248,
 *    lodging, mgmt_travel, travel_day_costs,
 *    travel_costs_total,        // H32
 *    grand_total,               // sum of the 6 top-level sections
 * }
 */
export function computeSetRollup({ set, lines, lookups, estimateState }) {
  const est = estimateState || {};

  // Estimate inputs
  const travel_hrs        = Number(est.one_way_travel_hrs ?? 0) || 0;
  const crew_count        = Number(est.crew_count ?? 0) || 0;
  const crew_size_key     = est.crew_size || "";
  const lodging_per_day   = Number(est.lodging_cost_per_day ?? 0) || 0;
  const mgmt_pct_pts      = Number(est.mgmt_travel_multiplier ?? 0) || 0;
  const mgmt_pct          = mgmt_pct_pts / 100;
  const rack_profit_pct   = (Number(est.rack_install_profit_target  ?? 0) || 0) / 100;
  const mob_profit_pct    = (Number(est.mobilization_profit_target  ?? 0) || 0) / 100;
  const breakOutMob       = est.breaking_out_mobilization;

  // Labor cost / day  (= (OOT or Local) / 5 × crew_size value_num)
  const oot   = lookupValueNum(lookups, "labor_crew_cost", "Out of Town");
  const local = lookupValueNum(lookups, "labor_crew_cost", "Local");
  const crew_size_num = lookupValueNum(lookups, "crew_size", crew_size_key);
  let labor_cost_per_day = 0;
  if (travel_hrs > 0 && crew_size_num != null && oot != null && local != null) {
    labor_cost_per_day = ((travel_hrs > 1 ? oot : local) / 5) * crew_size_num;
  }
  const labor_cost_per_travel_day = labor_cost_per_day;
  const travel_days_per_crew = travelDaysFromHrs(lookups, travel_hrs);

  // Per-set type override wins; else fall back to estimate-level setting.
  const estimate_type = (set?.estimate_type_override) || est.estimate_type || "Standard";
  const useAgg = estimate_type === "Aggressive";

  // Environment factor for this set
  const env_factor = (() => {
    const k = set?.installation_environment || "Ambient";
    const v = lookupValueNum(lookups, "environment_factor", k);
    return v == null ? 1 : Number(v);
  })();

  // Mobilizations (per-set)
  const mobilizations = Number(set?.mobilizations ?? 0) || 0;

  // Section dollar / day rollups
  const linesBySection = lines.reduce((acc, l) => {
    (acc[l.section_code] ||= []).push(l);
    return acc;
  }, {});

  const sumDays = (sectionCodes) => {
    let std = 0, agg = 0;
    for (const code of sectionCodes) {
      for (const r of (linesBySection[code] || [])) {
        if (r.std_total != null) std += Number(r.std_total);
        if (r.agg_total != null) agg += Number(r.agg_total);
      }
    }
    return { std, agg };
  };
  const sumExt = (code) => {
    let s = 0;
    for (const r of (linesBySection[code] || [])) {
      if (r.ext_cost != null) s += Number(r.ext_cost);
    }
    return s;
  };

  const rackTotals = sumDays(RACK_LABOR_SECTIONS);
  const wireTotals = sumDays(["wire_guidance_contract_labor"]);
  const rack_days = useAgg ? rackTotals.agg : rackTotals.std;
  const wire_days = useAgg ? wireTotals.agg : wireTotals.std;

  const mat_rack  = sumExt("materials_rack_install");
  const mat_wire  = sumExt("materials_wire_guidance");
  const rent_rack = sumExt("rentals_rack_install")
                  + sumExt("other_rentals_rack_install");
  const rent_wire = sumExt("rentals_wire_guidance")
                  + sumExt("other_rentals_wire_guidance");
  const wg_add    = sumExt("wire_guidance_additional");

  // Buffer days (per-set day-type overrides → adders → env-scaled "extra days")
  const rack_override = set?.rack_install_labor_day_override;
  const rack_adder    = set?.rack_install_project_time_adder;
  const wire_override = set?.wire_guidance_labor_day_override;
  const wire_adder    = set?.wire_guidance_project_time_adder;
  const M20 = computeBufferDays(rack_override, rack_adder, rack_days, env_factor);
  const M21 = computeBufferDays(wire_override, wire_adder, wire_days, env_factor);

  const overrideOrNull = (v) => (v != null && v !== "" && Number(v) > 0) ? Number(v) : null;
  const numOr0         = (v) => Number(v ?? 0) || 0;

  const travel_override = overrideOrNull(set?.travel_labor_day_override);
  const rack_override_n = overrideOrNull(set?.rack_install_labor_day_override);
  const rack_adder_n    = numOr0(set?.rack_install_project_time_adder);
  const wire_override_n = overrideOrNull(set?.wire_guidance_labor_day_override);
  const wire_adder_n    = numOr0(set?.wire_guidance_project_time_adder);

  // Contract-labor days honor the manual "Tab Labor Days" override when it's set,
  // matching the workbook — the override drives the contract-labor COST (H44/H220),
  // not just the buffer/lodging days. (Fix: previously H44/H220 always used the
  // production-computed line days, so any overridden estimate under-priced labor.)
  const rack_days_eff = rack_override_n != null ? rack_override_n : rack_days;
  const wire_days_eff = wire_override_n != null ? wire_override_n : wire_days;

  // D22 Travel Days, D23/D24 Tab Labor Days (the on-site "Project Labor Days —
  // Cost"). These are the BASE labor days only; the project-time-adder creates the
  // separate buffer line (M20/M21) and must NOT inflate the lodging/on-site days
  // (matches the workbook, whose "Project Labor Days - Cost" excludes the adder).
  const D22 = travel_override != null
    ? travel_override
    : travel_days_per_crew * crew_count * mobilizations;
  const D23 = ceilHalf((rack_override_n != null ? rack_override_n : rack_days) * env_factor);
  const D24 = ceilHalf((wire_override_n != null ? wire_override_n : wire_days) * env_factor);

  // Top-level section dollar totals
  const H44  = rack_days_eff * labor_cost_per_day;        // Rack Contract Labor $
  const H39  = mat_rack;                                  // Materials Rack $
  const H214 = mat_wire;                                  // Materials WG $
  const H220 = wire_days_eff * labor_cost_per_day;        // WG Contract Labor $
  const H187 = rent_rack;                                 // Rentals Rack $
  const H226 = rent_wire;                                 // Rentals WG $
  const H248 = wg_add;                                    // WG Add'l Items $
  const H38  = H39 + H44;                                 // Rack Install bundle
  const H213 = H214 + H220;                               // WG Labor bundle

  // Travel Costs section (H32)
  const lodging = D22 > 0 ? (D22 + D23 + D24) * lodging_per_day : 0;
  const G35     = labor_cost_per_travel_day * D22;        // Travel Day Costs
  const no_mgmt_travel = labor_cost_per_day === 1400;
  const mgmt_travel = no_mgmt_travel
    ? 0
    : (H44 + H39 + lodging + H214 + H220 + G35) * mgmt_pct;
  const travel_costs_total = lodging + mgmt_travel + G35; // H32

  // Grand total = 6 top-level sections summed
  const grand_total = travel_costs_total + H38 + H187 + H213 + H226 + H248;

  return {
    estimate_type, useAgg,
    labor_cost_per_day, labor_cost_per_travel_day, travel_days_per_crew,
    mobilizations, env_factor,
    rack_days, wire_days,
    mat_rack, mat_wire, rent_rack, rent_wire, wg_add,
    D22, D23, D24, M20, M21,
    H39, H44, H38, H214, H220, H213, H187, H226, H248,
    lodging, mgmt_travel, travel_day_costs: G35,
    travel_costs_total,
    grand_total,
  };
}

// ---------------------------------------------------------------------------
// Bundle Output (QuickBooks-shaped) — decodes the BASE sheet's S-column
// formulas. Returns 7 bundles (Installation Labor, Rentals, WG Labor, WG
// Additional, Mobilization, Remobilization, Downtime). Each bundle has a
// title, total, and an array of [label, value, opts] sub-lines.
//
// Mirrors the per-set math previously embedded in base-quoting-metrics.js
// (computeAllBundles). Pure function — same input → same output.
// ---------------------------------------------------------------------------
export function computeSetBundles({ set, lines, lookups, estimateState }) {
  const rollup = computeSetRollup({ set, lines, lookups, estimateState });
  const est = estimateState || {};

  // Group lines by section_code so the helpers can look them up cheaply.
  const linesBySection = lines.reduce((acc, l) => {
    (acc[l.section_code] ||= []).push(l);
    return acc;
  }, {});

  // WG Additional Items: map free-form rows to known categories by
  // case-insensitive substring match on the user-entered label.
  const wgAdditionalLine = (needle) => {
    const rows = linesBySection["wire_guidance_additional"] || [];
    const n = needle.toLowerCase();
    let sum = 0;
    for (const row of rows) {
      const lbl = String(row.label || "").toLowerCase();
      if (lbl.includes(n) && row.ext_cost != null) sum += Number(row.ext_cost);
    }
    return sum;
  };
  const sumOtherRentalsByLabel = (sectionCode, needle) => {
    const rows = linesBySection[sectionCode] || [];
    const n = needle.toLowerCase();
    let sum = 0;
    for (const row of rows) {
      const lbl = String(row.label || "").toLowerCase();
      if (lbl.includes(n) && row.ext_cost != null) sum += Number(row.ext_cost);
    }
    return sum;
  };
  const sumSectionExtCosts = (sectionCode) => {
    const rows = linesBySection[sectionCode] || [];
    let sum = 0;
    for (const row of rows) {
      if (row.ext_cost != null) sum += Number(row.ext_cost);
    }
    return sum;
  };
  // "What you add on top to hit margin p."
  const markup = (amount, pct) => {
    const denom = 1 - pct;
    if (denom === 0) return 0;
    return amount / denom - amount;
  };

  // Pull values from the rollup so the bundle formulas read exactly like the
  // workbook (H/D/G/S column references).
  const H44 = rollup.H44;
  const H39 = rollup.H39;
  const H214 = rollup.H214;
  const H220 = rollup.H220;
  const H187 = rollup.H187;
  const H226 = rollup.H226;
  const H248 = rollup.H248;
  const G34  = rollup.mgmt_travel;
  const G35  = rollup.travel_day_costs;
  const D13  = rollup.labor_cost_per_day;
  const D15  = Number(est.lodging_cost_per_day ?? 0) || 0;
  const D21  = Number(est.one_way_travel_hrs   ?? 0) || 0;
  const D22  = rollup.D22;
  const D23  = rollup.D23;
  const D24  = rollup.D24;
  const mobs = rollup.mobilizations;
  const M20  = rollup.M20;
  const M21  = rollup.M21;

  // Estimate-level inputs
  const breakOutMob      = est.breaking_out_mobilization;
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
  const otherRackDumpster = sumOtherRentalsByLabel("other_rentals_rack_install", "dumpster");
  const otherRackPropane  = sumOtherRentalsByLabel("other_rentals_rack_install", "propane");
  const otherRackRest     = sumSectionExtCosts("other_rentals_rack_install") - otherRackDumpster - otherRackPropane;
  // Equipment-Lifts = the base rack rentals + the "everything else" other-rentals.
  // (Fix: was H187, which already folds in propane/dumpster — those are split into
  // their own lines S12/S13, so using H187 double-counted them.)
  const S11 = ceil10(sumSectionExtCosts("rentals_rack_install") + otherRackRest);
  const S12 = ceil10(otherRackDumpster);
  const S13 = ceil10(otherRackPropane);
  const S14 = ceil10((S11 + S12) / (1 - rent_rack_pct || 1) + S13 - (S11 + S12 + S13));
  const rentals_total = S11 + S12 + S13 + S14;

  // ── Wire Guidance Labor Bundle (S15–S23) ────────────────────────────────
  let S16_raw;
  if (isNo(breakOutMob)) {
    S16_raw = G35 + H220 - M21 * D13 - (S4 > 0 ? G35 : 0);
  } else {
    S16_raw = H220 - M21 * D13;
  }
  const S16 = ceil10(S16_raw);
  const S17 = ceil10(H214);
  let S18_raw = 0;
  if (S4 === 0 && S16 !== 0) S18_raw = G34;
  const S18 = ceil10(S18_raw);
  const T16 = (isNo(breakOutMob) && D23 === 0) ? G35 : 0;
  const T19 = T16 > 0 ? ((D22 + D23) * D15 - U8) : 0;
  const U19 = ceil10(D24 * D15);
  const S19 = ceil10(T19 + U19);
  const S20 = ceil10(M21 * D13 / (1 - rack_profit_pct || 1));
  const otherWgPropane = sumOtherRentalsByLabel("other_rentals_wire_guidance", "propane");
  const otherWgRest    = sumSectionExtCosts("other_rentals_wire_guidance") - otherWgPropane;
  // Floor Scrubber = base WG rentals + "everything else" (propane split to S22).
  const S21 = ceil10(sumSectionExtCosts("rentals_wire_guidance") + otherWgRest);
  const S22 = ceil10(otherWgPropane);
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
  // Workbook quirk: if the sub equals exactly 600 the OH&P is forced to 400.
  const S29 = ceil10(
    wga_sub === 600 ? 400 : (wga_sub / (1 - 0.40) - wga_sub)
  );
  const wga_total = S25 + S26 + S27 + S28 + S29;

  // ── Mobilization (S30–S35) ──────────────────────────────────────────────
  const avg_mobs = mobs > 0 ? mobs : 0;
  const has_mobs = avg_mobs > 0;
  const S31 = 0;   // Materials — static 0 in workbook
  const S32 = has_mobs && isYes(breakOutMob) ? ceil10(G35 / avg_mobs) : 0;
  const S33 = (S18 + S6 === 0) ? ceil10(G34) : 0;
  const S34 = has_mobs && isYes(breakOutMob) ? ceil10((D22 / avg_mobs) * D15) : 0;
  const mob_sub = S31 + S32 + S33 + S34;
  const S35 = ceil10(markup(mob_sub, mob_profit_pct));
  const mob_total = S31 + S32 + S33 + S34 + S35;

  // ── Remobilization (S36–S41) ────────────────────────────────────────────
  const extra = Math.max(0, avg_mobs - 1);
  const has_extra = extra > 0;
  const S37 = has_extra ? ceil10(S31 * extra) : 0;
  const S38 = has_extra ? ceil10(S32 * extra) : 0;
  const S39 = has_extra ? ceil10(S33 * extra) : 0;
  const S40 = has_extra ? ceil10(S34 * extra) : 0;
  const S41 = has_extra ? ceil10(S35 * extra) : 0;
  const remob_total = S37 + S38 + S39 + S40 + S41;

  // ── Downtime (S42–S47) ──────────────────────────────────────────────────
  const K22 = Number(set?.downtime_labor_day_override ?? 0) || 0;
  const S43 = 0;   // Materials — static in workbook
  const S44 = ceil10(ceilHalf(K22) * D13);
  const S45 = 0;   // Mgmt Travel — static in workbook
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
        ["Materials",               S31, { stub: true }],
        ["Contract Labor - Travel", S32],
        ["Mgmt Travel",             S33],
        ["Lodging",                 S34],
        ["OH&P",                    S35],
      ],
    },
    remobilization: {
      title: "Remobilization",
      total: remob_total,
      note: `× ${extra} extra mobilization${extra === 1 ? "" : "s"}`,
      lines: [
        ["Materials",               S37, { stub: true }],
        ["Contract Labor - Travel", S38],
        ["Mgmt Travel",             S39],
        ["Lodging",                 S40],
        ["OH&P",                    S41],
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
