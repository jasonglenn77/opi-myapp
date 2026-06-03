// Estimate page — Phase 1
// Mirrors cells A1:H36 of the "0. ROLL UP Quoting Metrics" Excel tab.
// Inputs are interactive (live local state). The Start Date / Quote Submittal
// Date calculations are wired now; remaining calc logic + persistence land in
// later phases. Reference-table dropdowns (Estimate Type, Equipment, Rack
// Height, Yes/No, Crew Size) are pulled from /api/quoting/lookup-values and
// fall back to static defaults if the fetch fails.

import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import { api } from "../api.js";

export async function estimatePage(routeFn) {
  // Local state — input fields start blank; the Output Variables / Results
  // sections keep Excel example values until their calc logic lands.
  const state = {
    // General Information — start blank; the user fills these in
    quote_number:          "",
    quote_description:     "",
    contact_first:         "",
    contact_last:          "",
    customer:              "",
    end_user:              "",
    quoted_by:             "",
    quote_notes:           "",
    date_of_request:       "",
    start_date:            "",   // calc — Date of Request + 90 days (blank if no request date)
    quote_submittal_date:  "",   // calc — today's date, mm/dd/yyyy
    project_city:          "",
    project_state:         "",
    end_date:              "",   // calc — lands in a later phase
    revision_count:        "",
    latest_revision_date:  "",

    // Key Estimating Inputs (left column) — profit/budget % are percentage points
    one_way_travel_hrs:    "",
    equipment_requirement: "",
    rack_height:           "",
    project_time_budget_adder:  "",
    project_time_budget_pct:    "",
    rack_install_profit_target: "",
    rental_rack_profit_target:  "",
    mobilization_profit_target: "",   // calc — wired in a later phase

    // Key Estimating Inputs (right column)
    estimate_type:                 "",
    breaking_out_mobilization:     "",
    rent_wire_guidance_equipment:  "",
    crew_count:                    "",
    crew_size:                     "",
    wire_guidance_profit_target:   "",
    rental_wire_profit_target:     "",
    downtime_day_price_target:     "",   // calc — derived from One-Way Travel time

    // Output Variables (read-only — computed downstream in later phases)
    labor_cost_per_day:            "",   // calc — base_rate (Local or Out of Town) / 5 × crew_size value_num
    labor_cost_per_travel_day:     "",   // calc — mirrors labor_cost_per_day
    lodging_cost_per_day:          "",         // TBD — left blank for now
    mgmt_travel_multiplier:        3.56559,    // pct points (3.56559 = 3.56559%); user-editable
    travel_days_per_crew_per_mob:  "",   // calc — step-lookup on One-Way Travel hrs × 2; ">38 hrs" => error label
    expected_mob_count_rack:       0,
    expected_mob_count_wire:       0,
    project_travel_days_cost:      0,
    project_labor_days_cost:       0,
    project_downtime_days_cost:    0,

    // Estimating Results — read-only placeholders until calculation lands
    price_to_customer:           0,
    projected_profit:            0,
    projected_cost:              0,
    projected_buffer:            0,
    projected_profit_margin:     null,
    projected_duration_days:     0,
    projected_duration_weeks:    0,
    downtime_day_price:          "NO DOWNTIME INCLUDED",
    wire_guidance_price_per_lf:  "NO WIRE GUIDANCE QUOTED",
    wire_guidance_margin:        "N/A",
  };

  // Reference-table dropdowns — fetched from /api/quoting/lookup-values
  // (table: lookup_values, grouped by category). Static arrays below act as
  // fallbacks so the page still renders if the API call fails.
  let lookups = {};
  try {
    lookups = await api("/quoting/lookup-values");
  } catch (err) {
    console.warn("Failed to load quoting lookup values; using static defaults.", err);
  }
  const lookupKeys = (category, fallback) => {
    const rows = lookups[category];
    return Array.isArray(rows) && rows.length ? rows.map(r => r.key) : fallback;
  };

  const ESTIMATE_TYPES   = lookupKeys("estimate_type", ["Standard", "Aggressive"]);
  const EQUIPMENT_REQS   = lookupKeys("energy_type",   ["Electric", "LP (Liquid Propane)"]);
  const RACK_HEIGHTS     = lookupKeys("rack_height",   ["Shorter than 25' (300\")", "Taller than 25' (300\")"]);
  const YES_NO           = lookupKeys("yes_no",        ["Yes", "No"]);
  const CREW_SIZES       = lookupKeys("crew_size",     ["Full", "4 Men", "2 Men", "1 Man"]);
  const CREW_COUNTS      = [1, 2, 3, 4, 5, 6];
  const US_STATES        = [
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME",
    "MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA",
    "RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
  ];

  // ── formatting helpers ─────────────────────────────────────────────────────
  const fmtMoney = (n) => {
    const v = Number(n);
    if (Number.isNaN(v)) return "—";
    return "$" + Math.round(v).toLocaleString("en-US");
  };
  const fmtPct = (n) => {
    if (n == null) return "—";
    const v = Number(n);
    if (Number.isNaN(v)) return "—";
    return (v * 100).toFixed(1) + "%";
  };
  const fmtDate = (s) => s || "—";

  // ── date helpers ───────────────────────────────────────────────────────────
  const pad2 = (n) => String(n).padStart(2, "0");

  // A Date, or an ISO "yyyy-mm-dd" string, → "mm/dd/yyyy"; falsy/invalid → "".
  function toUSDate(d) {
    const dt = d instanceof Date ? d : (d ? new Date(`${d}T00:00:00`) : null);
    if (!dt || Number.isNaN(dt.getTime())) return "";
    return `${pad2(dt.getMonth() + 1)}/${pad2(dt.getDate())}/${dt.getFullYear()}`;
  }

  // Start Date = Date of Request — Original + 90 days. Returns ISO yyyy-mm-dd
  // so <input type="date"> can render it directly. Blank until a request date
  // is entered (matches the Excel "blank unless ..." behaviour).
  function computeStartDate(requestIso) {
    if (!requestIso) return "";
    const dt = new Date(`${requestIso}T00:00:00`);
    if (Number.isNaN(dt.getTime())) return "";
    dt.setDate(dt.getDate() + 90);
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }

  // Tracks whether the user has manually overridden Start Date. Once true,
  // changes to Date of Request stop auto-filling Start Date. Clearing the
  // Start Date field resets the flag so auto-fill resumes.
  let startDateManual = false;

  // Downtime Day Price — blank until One-Way Travel time is entered, then
  // $3,500 when travel exceeds 1 hour, $3,000 at or under 1 hour.
  function computeDowntimePrice(travelHrs) {
    if (travelHrs === "" || travelHrs == null) return "";
    const h = Number(travelHrs);
    if (Number.isNaN(h)) return "";
    return h > 1 ? 3500 : 3000;
  }
  // The Downtime Day Price readout markup (money, or an em dash when blank).
  function downtimePriceHtml() {
    const v = state.downtime_day_price_target;
    return (v === "" || v == null)
      ? '<span class="text-black/30">—</span>'
      : fmtMoney(v);
  }

  // Pick a value_num out of `lookups` for a given category + key. Returns
  // null when the category, row, or value_num is missing (e.g. API fetch
  // failed and the page is running on static fallbacks).
  function lookupValueNum(category, key) {
    const rows = lookups[category];
    if (!Array.isArray(rows)) return null;
    const row = rows.find(r => r.key === key);
    if (!row || row.value_num == null) return null;
    return row.value_num;
  }

  // Labor Cost Per Day:
  //   base_rate = (One-Way Travel > 1 ? labor_crew_cost.Out of Town
  //                                   : labor_crew_cost.Local) / 5
  //   Labor Cost / Day = base_rate × crew_size.<selected key>.value_num
  // Returns "" until both One-Way Travel time and Crew Size are populated
  // and the required lookup rows are available.
  function computeLaborCostPerDay() {
    const hrs = state.one_way_travel_hrs;
    if (hrs === "" || hrs == null) return "";
    const h = Number(hrs);
    if (Number.isNaN(h)) return "";

    const crewKey = state.crew_size;
    if (!crewKey) return "";

    const baseRate = lookupValueNum("labor_crew_cost", h > 1 ? "Out of Town" : "Local");
    const crewNum  = lookupValueNum("crew_size", crewKey);
    if (baseRate == null || crewNum == null) return "";

    return (baseRate / 5) * crewNum;
  }
  function laborCostPerDayHtml() {
    const v = state.labor_cost_per_day;
    return (v === "" || v == null)
      ? '<span class="text-black/30">—</span>'
      : fmtMoney(v);
  }

  // Travel Days Per Crew, Per Mobilization — Excel:
  //   =IF(travel_hrs <= 38, VLOOKUP(travel_hrs, step_table, 2, TRUE) * 2,
  //       "WHAT COUNTRY IS THIS JOB IN?")
  // The step table is lookup_values.category = 'project_travel_day_calculator',
  // with lookup_key = numeric threshold (stored as text). VLOOKUP TRUE = pick
  // the largest threshold <= travel_hrs. Result is multiplied by 2.
  function computeTravelDaysPerCrewPerMob() {
    const hrs = state.one_way_travel_hrs;
    if (hrs === "" || hrs == null) return "";
    const h = Number(hrs);
    if (Number.isNaN(h)) return "";
    if (h > 38) return "WHAT COUNTRY IS THIS JOB IN?";

    const rows = lookups.project_travel_day_calculator;
    if (!Array.isArray(rows) || rows.length === 0) return "";

    const eligible = rows
      .map(r => ({ threshold: Number(r.key), value: r.value_num }))
      .filter(r => !Number.isNaN(r.threshold) && r.value != null && r.threshold <= h)
      .sort((a, b) => b.threshold - a.threshold);
    if (eligible.length === 0) return "";

    return eligible[0].value * 2;
  }
  function travelDaysPerCrewPerMobHtml() {
    const v = state.travel_days_per_crew_per_mob;
    if (v === "" || v == null) return '<span class="text-black/30">—</span>';
    if (typeof v === "string") {
      // Out-of-range error label from the Excel formula.
      return `<span class="text-red-600 text-xs">${escapeHtml(v)}</span>`;
    }
    return String(v);
  }

  // ── General Information helpers ────────────────────────────────────────────
  // Each helper emits TWO grid cells — a label cell + a value cell — so the
  // section's per-column grid lays them out as name | value pairs.
  function giLabel(text) {
    return `<div class="text-[11px] font-semibold text-black/60 leading-tight">${escapeHtml(text)}</div>`;
  }

  function giText(label, key, opts = {}) {
    return giLabel(label) + `
      <input type="text" class="input text-sm py-1.5"
             data-est-input="${key}"
             value="${escapeHtml(state[key] ?? "")}"
             placeholder="${escapeHtml(opts.placeholder || "")}"/>`;
  }

  function giNumber(label, key, opts = {}) {
    const step = opts.step || "any";
    return giLabel(label) + `
      <input type="number" step="${step}" class="input text-sm py-1.5"
             data-est-input="${key}" data-est-type="number"
             placeholder="${escapeHtml(opts.placeholder || "")}"
             value="${escapeHtml(String(state[key] ?? ""))}"/>`;
  }

  // Native <input type="date"> ignores `placeholder`, so an empty field is
  // rendered as a text input (which shows the placeholder) and swapped to a
  // real date picker on focus — see the focusin/focusout handlers below.
  function giDate(label, key, opts = {}) {
    const placeholder = opts.placeholder || "Select Date";
    const hasVal = !!state[key];
    return giLabel(label) + `
      <input type="${hasVal ? "date" : "text"}" class="input text-sm py-1.5"
             data-est-input="${key}" data-est-date
             placeholder="${escapeHtml(placeholder)}"
             value="${escapeHtml(state[key] ?? "")}"/>`;
  }

  // Compound value cell: contact first + last on the same line.
  function giContact(label) {
    return giLabel(label) + `
      <div class="flex items-center gap-2">
        <input type="text" class="input text-sm py-1.5 flex-1 min-w-0"
               data-est-input="contact_first"
               value="${escapeHtml(state.contact_first)}" placeholder="First Name"/>
        <input type="text" class="input text-sm py-1.5 flex-1 min-w-0"
               data-est-input="contact_last"
               value="${escapeHtml(state.contact_last)}" placeholder="Last Name"/>
      </div>`;
  }

  // Compound value cell: city + state select on the same line. The select
  // leads with a blank "State" option so nothing is pre-selected.
  function giCityState(label) {
    const stateOptions =
      `<option value="" ${!state.project_state ? "selected" : ""}>State</option>` +
      US_STATES.map(s => `<option value="${s}" ${state.project_state === s ? "selected" : ""}>${s}</option>`).join("");
    return giLabel(label) + `
      <div class="flex items-center gap-2">
        <input type="text" class="input text-sm py-1.5 flex-1 min-w-0"
               data-est-input="project_city"
               value="${escapeHtml(state.project_city)}" placeholder="Enter City Name"/>
        <select class="input text-sm py-1.5 w-20" data-est-input="project_state">
          ${stateOptions}
        </select>
      </div>`;
  }

  // Read-only calculated value cell (Start Date, Quote Submittal Date, End
  // Date). Tagged with data-est-calc so it can be refreshed live.
  function giCalc(label, key) {
    const v = state[key];
    return giLabel(label) + `
      <div data-est-calc="${key}"
           class="text-sm tabular-nums bg-black/[0.03] border border-black/10 rounded-xl px-3 py-1.5 text-black/70">
        ${v ? escapeHtml(v) : '<span class="text-black/30">—</span>'}
      </div>`;
  }

  // ── form helpers (other sections — vertical label/control stacks) ──────────
  function rowNumber(label, key, opts = {}) {
    const step = opts.step || "any";
    const suffix = opts.suffix ? `<span class="text-xs text-black/40">${escapeHtml(opts.suffix)}</span>` : "";
    return `
      <div class="flex flex-col gap-1">
        <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
        <div class="flex items-center gap-2">
          <input type="number" step="${step}" class="input text-sm py-1.5 flex-1"
                 data-est-input="${key}" data-est-type="number"
                 placeholder="${escapeHtml(opts.placeholder || "")}"
                 value="${escapeHtml(String(state[key] ?? ""))}"/>
          ${suffix}
        </div>
      </div>`;
  }

  function rowSelect(label, key, options, opts = {}) {
    const renderOption = (o) => {
      const val = typeof o === "object" ? o.value : o;
      const lab = typeof o === "object" ? o.label : o;
      const sel = String(state[key]) === String(val) ? "selected" : "";
      return `<option value="${escapeHtml(String(val))}" ${sel}>${escapeHtml(String(lab))}</option>`;
    };
    const placeholderOpt = opts.placeholder
      ? `<option value="" ${!state[key] ? "selected" : ""}>${escapeHtml(opts.placeholder)}</option>`
      : "";
    return `
      <div class="flex flex-col gap-1">
        <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
        <select class="input text-sm py-1.5"
                data-est-input="${key}"${opts.numeric ? ' data-est-type="number"' : ""}>
          ${placeholderOpt}
          ${options.map(renderOption).join("")}
        </select>
      </div>`;
  }

  // Compound row: a Yes/No selector plus a tied percent input — used for
  // "Project Time Budget Adder? - Yes/No & Percent". The percent is held in
  // percentage points (e.g. 5 for 5%).
  function rowYesNoPct(label, keyYesNo, keyPct) {
    return `
      <div class="flex flex-col gap-1">
        <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
        <div class="flex items-center gap-2">
          <select class="input text-sm py-1.5 flex-1" data-est-input="${keyYesNo}">
            <option value="" ${!state[keyYesNo] ? "selected" : ""}>Select</option>
            ${YES_NO.map(o => `<option value="${o}" ${state[keyYesNo] === o ? "selected" : ""}>${o}</option>`).join("")}
          </select>
          <input type="number" step="0.1" class="input text-sm py-1.5 w-24"
                 data-est-input="${keyPct}" data-est-type="number"
                 placeholder="Enter %"
                 value="${escapeHtml(String(state[keyPct] ?? ""))}"/>
          <span class="text-xs text-black/40">%</span>
        </div>
      </div>`;
  }

  // Compound row: "Crew Count" select + crew-size select on the same line.
  function rowCrew(label) {
    return `
      <div class="flex flex-col gap-1">
        <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
        <div class="flex items-center gap-2">
          <select class="input text-sm py-1.5 flex-1" data-est-input="crew_count" data-est-type="number">
            <option value="" ${!state.crew_count ? "selected" : ""}>Select</option>
            ${CREW_COUNTS.map(n => `<option value="${n}" ${state.crew_count === n ? "selected" : ""}>${n}</option>`).join("")}
          </select>
          <select class="input text-sm py-1.5 flex-1" data-est-input="crew_size">
            <option value="" ${!state.crew_size ? "selected" : ""}>Select</option>
            ${CREW_SIZES.map(o => `<option value="${o}" ${state.crew_size === o ? "selected" : ""}>${o}</option>`).join("")}
          </select>
        </div>
      </div>`;
  }

  // Read-only display row — used for the calculated Output Variables and
  // Results sections (rows 25-36 of the Excel) until calc logic lands.
  function rowReadout(label, value, opts = {}) {
    const colorClass = opts.color || "text-ink-900";
    const valueClass = `text-sm font-semibold tabular-nums ${colorClass}`;
    const calcAttr = opts.calcKey ? ` data-est-calc="${opts.calcKey}"` : "";
    return `
      <div class="flex flex-col gap-1">
        <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
        <div class="${valueClass} bg-black/[0.03] border border-black/10 rounded-lg px-3 py-1.5"${calcAttr}>
          ${value}
        </div>
      </div>`;
  }

  // ── section card ───────────────────────────────────────────────────────────
  // A collapsible card: clicking the header toggles its body open/closed.
  function section(title, contentHtml, opts = {}) {
    const note = opts.note
      ? `<span class="text-[11px] italic text-black/40">${escapeHtml(opts.note)}</span>`
      : "";
    return `
      <div class="card px-5 py-4" data-section>
        <button type="button" data-section-toggle
                class="w-full flex items-center justify-between gap-3 pb-2 border-b border-black/10 text-left cursor-pointer select-none">
          <span class="flex items-baseline gap-3">
            <span class="text-sm font-extrabold uppercase tracking-wide text-black/70">${escapeHtml(title)}</span>
            ${note}
          </span>
          <svg class="w-4 h-4 text-black/40 shrink-0 transition-transform" data-section-chevron
               fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </button>
        <div class="pt-3" data-section-body>
          ${contentHtml}
        </div>
      </div>`;
  }

  // ── derived values ─────────────────────────────────────────────────────────
  // Computed here on first render and kept live as their inputs change
  // (see syncFromEl below).
  state.quote_submittal_date      = toUSDate(new Date());       // today, mm/dd/yyyy
  state.start_date                = computeStartDate(state.date_of_request);
  state.downtime_day_price_target = computeDowntimePrice(state.one_way_travel_hrs);
  state.labor_cost_per_day        = computeLaborCostPerDay();
  state.labor_cost_per_travel_day = state.labor_cost_per_day;
  state.travel_days_per_crew_per_mob = computeTravelDaysPerCrewPerMob();

  // ── Estimate state bridge to other pages ──────────────────────────────────
  // TEMP: until we add an `estimates` table + real persistence, publish the
  // inputs the Quoting Metrics page needs (Travel Costs computation) via
  // localStorage. Re-emitted on every input change. Move to /api/estimates
  // when that table lands.
  const ESTIMATE_BRIDGE_KEY = "opi_estimate_state_v1";
  function publishEstimateState() {
    try {
      const subset = {
        one_way_travel_hrs:           state.one_way_travel_hrs,
        crew_count:                   state.crew_count,
        crew_size:                    state.crew_size,
        lodging_cost_per_day:         state.lodging_cost_per_day,
        mgmt_travel_multiplier:       state.mgmt_travel_multiplier,
        estimate_type:                state.estimate_type,
        breaking_out_mobilization:    state.breaking_out_mobilization,
        rack_install_profit_target:   state.rack_install_profit_target,
        rental_rack_profit_target:    state.rental_rack_profit_target,
        mobilization_profit_target:   state.mobilization_profit_target,
        wire_guidance_profit_target:  state.wire_guidance_profit_target,
        rental_wire_profit_target:    state.rental_wire_profit_target,
      };
      localStorage.setItem(ESTIMATE_BRIDGE_KEY, JSON.stringify(subset));
    } catch (err) {
      console.warn("Estimate state bridge: localStorage write failed", err);
    }
  }
  publishEstimateState();   // initial publish on mount

  // ── page HTML ──────────────────────────────────────────────────────────────
  const generalInfoHtml = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-2.5">

      <!-- Left column — name | value pairs -->
      <div class="grid grid-cols-[42%_1fr] gap-x-3 gap-y-2.5 items-center content-start">
        ${giText("Quote #", "quote_number", { placeholder: "Enter quote number" })}
        ${giContact("Contact (First, Last)")}
        ${giText("Customer", "customer", { placeholder: "Enter customer name" })}
        ${giText("Quoted By (First and Last Initials)", "quoted_by", { placeholder: "Enter First and Last Initials" })}
        ${giDate("Date of Request — Original", "date_of_request", { placeholder: "Select Date" })}
        ${giDate("Start Date", "start_date", { placeholder: "Select Date" })}
        ${giCalc("Quote Submittal Date", "quote_submittal_date")}
        ${giCityState("Project Location")}
        ${giCalc("End Date (7-Days a week)", "end_date")}
      </div>

      <!-- Right column — name | value pairs -->
      <div class="grid grid-cols-[42%_1fr] gap-x-3 gap-y-2.5 items-center content-start">
        ${giText("Quote Description (Short)", "quote_description", { placeholder: "Enter Short Description" })}
        ${giText("End User", "end_user", { placeholder: "Enter End User" })}
        ${giText("Quote Notes", "quote_notes", { placeholder: "<Enter text>" })}
        ${giNumber("Revision Count", "revision_count", { step: "1", placeholder: "Enter revision count" })}
        ${giDate("Latest Revision Date", "latest_revision_date", { placeholder: "Select Date" })}
      </div>
    </div>`;

  const keyInputsHtml = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3">

      <!-- Left column -->
      <div class="flex flex-col gap-3">
        ${rowNumber("One-Way Travel time from Houston or Dallas, TX to Job Site", "one_way_travel_hrs", { step: "0.5", suffix: "hrs", placeholder: "Enter Hours" })}
        ${rowSelect("Equipment Requirement (Electric vs. LP)", "equipment_requirement", EQUIPMENT_REQS, { placeholder: "Select Equipment" })}
        ${rowSelect("Rack Height (Tall vs Short Equipment)", "rack_height", RACK_HEIGHTS, { placeholder: "Select Rack Height" })}
        ${rowYesNoPct("Project Time Budget Adder? — Yes/No & Percent", "project_time_budget_adder", "project_time_budget_pct")}
        ${rowNumber("Rack Install Profit % (TARGET)", "rack_install_profit_target", { step: "0.1", suffix: "%", placeholder: "Enter %" })}
        ${rowNumber("Rental Equipment RACK Profit % (TARGET)", "rental_rack_profit_target", { step: "0.1", suffix: "%", placeholder: "Enter %" })}
        ${rowReadout("Mobilization Profit % (TARGET)", '<span class="text-black/30">—</span>', { calcKey: "mobilization_profit_target", color: "text-black/60" })}
      </div>

      <!-- Right column -->
      <div class="flex flex-col gap-3">
        ${rowSelect("Estimate Type", "estimate_type", ESTIMATE_TYPES, { placeholder: "Select Type" })}
        ${rowSelect("Breaking Out Mobilization?", "breaking_out_mobilization", YES_NO, { placeholder: "Select" })}
        ${rowSelect("Rent Wire Guidance Equipment?", "rent_wire_guidance_equipment", YES_NO, { placeholder: "Select" })}
        ${rowCrew("Crew Count — Size")}
        ${rowNumber("Wire Guidance Profit % (TARGET)", "wire_guidance_profit_target", { step: "0.1", suffix: "%", placeholder: "Enter %" })}
        ${rowNumber("Rental Equipment WIRE Profit % (TARGET)", "rental_wire_profit_target", { step: "0.1", suffix: "%", placeholder: "Enter %" })}
        ${rowReadout("Downtime Day Price (TARGET)", downtimePriceHtml(), { calcKey: "downtime_day_price_target", color: "text-black/60" })}
      </div>
    </div>`;

  const outputVarsHtml = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3">

      <div class="flex flex-col gap-3">
        ${rowReadout("Labor Cost Per Day (Local or Out of Town)", laborCostPerDayHtml(), { calcKey: "labor_cost_per_day" })}
        ${rowReadout("Labor Cost Per TRAVEL Day", laborCostPerDayHtml(), { calcKey: "labor_cost_per_travel_day" })}
        ${rowReadout("Lodging Cost Per Day (<6 Days Hotel, >6 AB&B)", '<span class="text-black/30">—</span>')}
        ${rowNumber("Mgmt Travel Multiplier", "mgmt_travel_multiplier", { step: "0.00001", suffix: "%", placeholder: "Enter %" })}
        ${rowReadout("Travel Days Per Crew, Per Mobilization", travelDaysPerCrewPerMobHtml(), { calcKey: "travel_days_per_crew_per_mob" })}
      </div>

      <div class="flex flex-col gap-3">
        ${rowReadout("Expected / Estimated Mobilization Count (RACK)", String(state.expected_mob_count_rack))}
        ${rowReadout("Expected / Estimated Mobilization Count (WIRE GUIDE)", String(state.expected_mob_count_wire))}
        ${rowReadout("Project Travel Days — Cost", fmtMoney(state.project_travel_days_cost))}
        ${rowReadout("Project Labor Days — Cost", fmtMoney(state.project_labor_days_cost))}
        ${rowReadout("Project Downtime Days — Cost", fmtMoney(state.project_downtime_days_cost))}
      </div>
    </div>`;

  const resultsHtml = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3">

      <div class="flex flex-col gap-3">
        ${rowReadout("Price to Customer", fmtMoney(state.price_to_customer))}
        ${rowReadout("Projected Profit", fmtMoney(state.projected_profit), { color: "text-emerald-700" })}
        ${rowReadout("Projected Cost", fmtMoney(state.projected_cost))}
        ${rowReadout("Projected Buffer", fmtMoney(state.projected_buffer))}
        ${rowReadout("Projected Profit Margin", fmtPct(state.projected_profit_margin))}
      </div>

      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-1">
          <label class="text-[11px] font-semibold text-black/60">Projected Project Duration</label>
          <div class="flex items-center gap-2">
            <div class="text-sm font-semibold tabular-nums bg-black/[0.03] border border-black/10 rounded-lg px-3 py-1.5 flex-1">
              ${state.projected_duration_days} <span class="text-xs text-black/40">days</span>
            </div>
            <div class="text-sm font-semibold tabular-nums bg-black/[0.03] border border-black/10 rounded-lg px-3 py-1.5 flex-1">
              ${state.projected_duration_weeks} <span class="text-xs text-black/40">weeks</span>
            </div>
          </div>
        </div>
        ${rowReadout("Downtime Day Price", typeof state.downtime_day_price === "number" ? fmtMoney(state.downtime_day_price) : escapeHtml(state.downtime_day_price), { color: "text-black/60" })}
        ${rowReadout("Wire Guidance Price / LF (RESULT)", typeof state.wire_guidance_price_per_lf === "number" ? fmtMoney(state.wire_guidance_price_per_lf) : escapeHtml(state.wire_guidance_price_per_lf), { color: "text-black/60" })}
        ${rowReadout("Wire Guidance Margin", typeof state.wire_guidance_margin === "number" ? fmtPct(state.wire_guidance_margin) : escapeHtml(state.wire_guidance_margin), { color: "text-black/60" })}
      </div>
    </div>`;

  const bodyHtml = `
    <div class="grid grid-cols-1 gap-3 pb-3">

      <!-- Page header card -->
      <div class="card px-5 py-3">
        <div class="flex items-baseline justify-between gap-3">
          <div>
            <div class="text-base font-extrabold">Estimate</div>
            <div class="text-xs text-black/50">Quoting Metrics — based on the "0. ROLL UP Quoting Metrics" tab</div>
          </div>
          <div class="text-[11px] text-black/40 whitespace-nowrap">B155.1 · Phase 1 (display)</div>
        </div>
      </div>

      ${section("General Information", generalInfoHtml)}
      ${section("Key Estimating Inputs", keyInputsHtml)}
      ${section("Key Estimating Output Variables", outputVarsHtml, { note: "Calculated in a later phase" })}
      ${section("Estimating Results — Pricing & Schedule", resultsHtml, { note: "Calculated in a later phase" })}

    </div>
  `;

  setShell({
    title:    "",
    subtitle: "",
    bodyHtml,
    showLogout: true,
    routeFn,
  });

  // Hide the empty page-title block; restore on navigate-away
  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => {
      if (pageTitleBlock) pageTitleBlock.style.display = "";
    }, { once: true });
  }

  // ── input wiring ───────────────────────────────────────────────────────────
  // Mirror form values into state. For Phase 1 nothing reads most of these —
  // no save yet — but they are kept in sync so a future phase can hook into the
  // same state object. The Date of Request additionally drives Start Date.
  // Update a read-only calc cell (tagged data-est-calc) with new HTML.
  function setCalcCell(key, html) {
    const cell = document.querySelector(`[data-est-calc="${key}"]`);
    if (cell) cell.innerHTML = html;
  }

  // Write a value into the Start Date input + state. Skips the date/text
  // type swap while the field is focused so the open date picker isn't
  // disrupted; the focusout handler will normalise the type on blur.
  function setStartDateInput(value) {
    state.start_date = value;
    const el = document.querySelector('[data-est-input="start_date"]');
    if (!el) return;
    el.value = value;
    if (el.hasAttribute("data-est-date") && el !== document.activeElement) {
      el.type = value ? "date" : "text";
    }
  }

  function syncFromEl(el) {
    const key = el.getAttribute("data-est-input");
    if (!(key in state)) return;
    const wantNumber = el.getAttribute("data-est-type") === "number";
    // Empty number fields stay "" (not 0) so calculations can tell the
    // difference between "blank" and a real zero.
    state[key] = wantNumber ? (el.value === "" ? "" : Number(el.value)) : el.value;

    // Date of Request — Original auto-fills Start Date with +90 days, unless
    // the user has manually overridden Start Date.
    if (key === "date_of_request" && !startDateManual) {
      setStartDateInput(computeStartDate(state.date_of_request));
    }

    // Start Date — manual edits set the override flag so subsequent Date of
    // Request changes don't clobber the user's value. Clearing the field
    // resets the flag and re-syncs to date_of_request + 90 days.
    if (key === "start_date") {
      if (state.start_date === "") {
        startDateManual = false;
        setStartDateInput(computeStartDate(state.date_of_request));
      } else {
        startDateManual = true;
      }
    }

    // One-Way Travel time drives the Downtime Day Price + Travel Days/Crew/Mob.
    if (key === "one_way_travel_hrs") {
      state.downtime_day_price_target = computeDowntimePrice(state.one_way_travel_hrs);
      setCalcCell("downtime_day_price_target", downtimePriceHtml());

      state.travel_days_per_crew_per_mob = computeTravelDaysPerCrewPerMob();
      setCalcCell("travel_days_per_crew_per_mob", travelDaysPerCrewPerMobHtml());
    }

    // One-Way Travel time + Crew Size drive Labor Cost Per Day. Labor Cost
    // Per TRAVEL Day mirrors the same value.
    if (key === "one_way_travel_hrs" || key === "crew_size") {
      state.labor_cost_per_day = computeLaborCostPerDay();
      state.labor_cost_per_travel_day = state.labor_cost_per_day;
      setCalcCell("labor_cost_per_day", laborCostPerDayHtml());
      setCalcCell("labor_cost_per_travel_day", laborCostPerDayHtml());
    }

    // Bridge any state change relevant to the Quoting Metrics page.
    publishEstimateState();
  }

  document.addEventListener("input", (e) => {
    const el = e.target.closest("[data-est-input]");
    if (el) syncFromEl(el);
  });
  document.addEventListener("change", (e) => {
    const el = e.target.closest("[data-est-input]");
    if (el) syncFromEl(el);
  });

  // Date placeholder swap: blank date fields render as text (so the
  // "Select Date" placeholder shows), become a real date picker on focus,
  // and revert to text on blur if still empty.
  document.addEventListener("focusin", (e) => {
    const el = e.target.closest("[data-est-date]");
    if (el && el.type !== "date") el.type = "date";
  });
  document.addEventListener("focusout", (e) => {
    const el = e.target.closest("[data-est-date]");
    if (el && !el.value) el.type = "text";
  });

  // Collapsible sections: clicking a section header toggles its body.
  document.addEventListener("click", (e) => {
    const toggle = e.target.closest("[data-section-toggle]");
    if (!toggle) return;
    const card = toggle.closest("[data-section]");
    const body = card?.querySelector("[data-section-body]");
    if (!body) return;
    const collapsed = body.classList.toggle("hidden");
    const chevron = toggle.querySelector("[data-section-chevron]");
    if (chevron) chevron.classList.toggle("-rotate-90", collapsed);
  });
}
