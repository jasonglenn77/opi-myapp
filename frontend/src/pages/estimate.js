// Estimate page — Phase 1
// Mirrors cells A1:H36 of the "0. ROLL UP Quoting Metrics" Excel tab.
// Inputs are interactive (live local state); calculation logic + persistence
// land in later phases. Dropdown options are static for now and will be
// driven by the quoting reference table in Phase 2.

import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

export async function estimatePage(routeFn) {
  // Local state — placeholder values pulled from the Excel example so the
  // layout has something realistic to look at on first render.
  const state = {
    // General Information
    quote_number:          "5954",
    quote_description:     "PF Dismantle & RadioShuttle Install",
    contact_first:         "Justen",
    contact_last:          "Woods",
    customer:              "Carolina Handling",
    end_user:              "Callaway BSW",
    quoted_by:             "MT",
    quote_notes:           "",
    date_of_request:       "2025-11-21",
    start_date:            "2026-02-19",
    quote_submittal_date:  "2026-04-26",
    project_city:          "Columbus",
    project_state:         "GA",
    end_date:              "2026-02-19",
    revision_count:        0,
    latest_revision_date:  "2025-11-21",

    // Key Estimating Inputs (left column)
    one_way_travel_hrs:    11,
    equipment_requirement: "LP (Liquid Propane)",
    rack_height:           "Shorter than 25' (300\")",
    project_time_budget_adder:  "Yes",
    project_time_budget_pct:    0.05,
    rack_install_profit_target: 0.42,
    rental_rack_profit_target:  0.30,
    mobilization_profit_target: -0.015,

    // Key Estimating Inputs (right column)
    estimate_type:                 "Standard",
    breaking_out_mobilization:     "Yes",
    rent_wire_guidance_equipment:  "Yes",
    crew_count:                    1,
    crew_size:                     "Full",
    wire_guidance_profit_target:   0.42,
    rental_wire_profit_target:     0,
    downtime_day_price_target:     3500,

    // Output Variables (read-only — computed downstream in later phases)
    labor_cost_per_day:            1600,
    labor_cost_per_travel_day:     1600,
    lodging_cost_per_day:          425,
    mgmt_travel_multiplier:        0.0356559,
    travel_days_per_crew_per_mob:  2,
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

  // Static dropdown options — Phase 2 will pull these from the quoting-reference DB
  const ESTIMATE_TYPES   = ["Standard", "Aggressive"];
  const EQUIPMENT_REQS   = ["LP (Liquid Propane)", "Electric"];
  const RACK_HEIGHTS     = ["Shorter than 25' (300\")", "Taller than 25' (300\")"];
  const YES_NO           = ["Yes", "No"];
  const CREW_COUNTS      = [1, 2, 3, 4, 5, 6];
  const CREW_SIZES       = ["Full", "Half"];
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

  // ── form helpers ──────────────────────────────────────────────────────────
  // Each helper renders a label + control in a tidy two-column row.
  function rowText(label, key, opts = {}) {
    const placeholder = opts.placeholder || "";
    return `
      <div class="flex flex-col gap-1">
        <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
        <input type="text" class="input text-sm py-1.5"
               data-est-input="${key}"
               value="${escapeHtml(state[key] ?? "")}"
               placeholder="${escapeHtml(placeholder)}"/>
      </div>`;
  }

  function rowNumber(label, key, opts = {}) {
    const step = opts.step || "any";
    const suffix = opts.suffix ? `<span class="text-xs text-black/40">${escapeHtml(opts.suffix)}</span>` : "";
    return `
      <div class="flex flex-col gap-1">
        <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
        <div class="flex items-center gap-2">
          <input type="number" step="${step}" class="input text-sm py-1.5 flex-1"
                 data-est-input="${key}" data-est-type="number"
                 value="${state[key] ?? 0}"/>
          ${suffix}
        </div>
      </div>`;
  }

  function rowDate(label, key) {
    return `
      <div class="flex flex-col gap-1">
        <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
        <input type="date" class="input text-sm py-1.5"
               data-est-input="${key}"
               value="${escapeHtml(state[key] ?? "")}"/>
      </div>`;
  }

  function rowSelect(label, key, options, opts = {}) {
    const renderOption = (o) => {
      const val = typeof o === "object" ? o.value : o;
      const lab = typeof o === "object" ? o.label : o;
      const sel = String(state[key]) === String(val) ? "selected" : "";
      return `<option value="${escapeHtml(String(val))}" ${sel}>${escapeHtml(String(lab))}</option>`;
    };
    return `
      <div class="flex flex-col gap-1">
        <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
        <select class="input text-sm py-1.5"
                data-est-input="${key}"${opts.numeric ? ' data-est-type="number"' : ""}>
          ${options.map(renderOption).join("")}
        </select>
      </div>`;
  }

  // Compound row: a Yes/No selector plus a tied percent input — used for
  // "Project Time Budget Adder? - Yes/No & Percent".
  function rowYesNoPct(label, keyYesNo, keyPct) {
    return `
      <div class="flex flex-col gap-1">
        <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
        <div class="flex items-center gap-2">
          <select class="input text-sm py-1.5 flex-1" data-est-input="${keyYesNo}">
            ${YES_NO.map(o => `<option value="${o}" ${state[keyYesNo] === o ? "selected" : ""}>${o}</option>`).join("")}
          </select>
          <input type="number" step="0.01" class="input text-sm py-1.5 w-24"
                 data-est-input="${keyPct}" data-est-type="number"
                 value="${state[keyPct] ?? 0}"/>
          <span class="text-xs text-black/40">×</span>
        </div>
      </div>`;
  }

  // Compound row: "Crew Count" select + "Full/Half" select on the same line.
  function rowCrew(label) {
    return `
      <div class="flex flex-col gap-1">
        <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
        <div class="flex items-center gap-2">
          <select class="input text-sm py-1.5 flex-1" data-est-input="crew_count" data-est-type="number">
            ${CREW_COUNTS.map(n => `<option value="${n}" ${state.crew_count === n ? "selected" : ""}>${n}</option>`).join("")}
          </select>
          <select class="input text-sm py-1.5 flex-1" data-est-input="crew_size">
            ${CREW_SIZES.map(o => `<option value="${o}" ${state.crew_size === o ? "selected" : ""}>${o}</option>`).join("")}
          </select>
        </div>
      </div>`;
  }

  // Compound row: city + state select on the same line ("Project Location").
  function rowCityState(label) {
    return `
      <div class="flex flex-col gap-1">
        <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
        <div class="flex items-center gap-2">
          <input type="text" class="input text-sm py-1.5 flex-1"
                 data-est-input="project_city"
                 value="${escapeHtml(state.project_city)}" placeholder="City" />
          <select class="input text-sm py-1.5 w-20" data-est-input="project_state">
            ${US_STATES.map(s => `<option value="${s}" ${state.project_state === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
      </div>`;
  }

  // Compound row: contact first + last on the same line.
  function rowContact(label) {
    return `
      <div class="flex flex-col gap-1">
        <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
        <div class="flex items-center gap-2">
          <input type="text" class="input text-sm py-1.5 flex-1"
                 data-est-input="contact_first"
                 value="${escapeHtml(state.contact_first)}" placeholder="First" />
          <input type="text" class="input text-sm py-1.5 flex-1"
                 data-est-input="contact_last"
                 value="${escapeHtml(state.contact_last)}" placeholder="Last" />
        </div>
      </div>`;
  }

  // Read-only display row — used for the calculated Output Variables and
  // Results sections (rows 25-36 of the Excel) until calc logic lands.
  function rowReadout(label, value, opts = {}) {
    const colorClass = opts.color || "text-ink-900";
    const valueClass = `text-sm font-semibold tabular-nums ${colorClass}`;
    return `
      <div class="flex flex-col gap-1">
        <label class="text-[11px] font-semibold text-black/60">${escapeHtml(label)}</label>
        <div class="${valueClass} bg-black/[0.03] border border-black/10 rounded-lg px-3 py-1.5">
          ${value}
        </div>
      </div>`;
  }

  // ── page HTML ──────────────────────────────────────────────────────────────
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

      <!-- General Information -->
      <div class="card px-5 py-4">
        <div class="text-sm font-extrabold uppercase tracking-wide text-black/70 mb-3 pb-2 border-b border-black/10">
          General Information
        </div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3">

          <!-- Left column -->
          <div class="flex flex-col gap-3">
            ${rowText("Quote #", "quote_number")}
            ${rowContact("Contact (First, Last)")}
            ${rowText("Customer", "customer")}
            ${rowText("Quoted By (First and Last Initials)", "quoted_by", { placeholder: "e.g. MT" })}
            ${rowDate("Date of Request — Original", "date_of_request")}
            ${rowDate("Start Date", "start_date")}
            ${rowDate("Quote Submittal Date", "quote_submittal_date")}
            ${rowCityState("Project Location")}
            ${rowDate("End Date (7-Days a week)", "end_date")}
          </div>

          <!-- Right column -->
          <div class="flex flex-col gap-3">
            ${rowText("Quote Description (Short)", "quote_description")}
            ${rowText("End User", "end_user")}
            ${rowText("Quote Notes", "quote_notes", { placeholder: "<Enter text>" })}
            ${rowNumber("Revision Count", "revision_count", { step: "1" })}
            ${rowDate("Latest Revision Date", "latest_revision_date")}
          </div>
        </div>
      </div>

      <!-- Key Estimating Inputs -->
      <div class="card px-5 py-4">
        <div class="text-sm font-extrabold uppercase tracking-wide text-black/70 mb-3 pb-2 border-b border-black/10">
          Key Estimating Inputs
        </div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3">

          <!-- Left column -->
          <div class="flex flex-col gap-3">
            ${rowNumber("One-Way Travel time from Houston or Dallas, TX to Job Site", "one_way_travel_hrs", { step: "0.5", suffix: "hrs" })}
            ${rowSelect("Equipment Requirement (Electric vs. LP)", "equipment_requirement", EQUIPMENT_REQS)}
            ${rowSelect("Rack Height (Tall vs Short Equipment)", "rack_height", RACK_HEIGHTS)}
            ${rowYesNoPct("Project Time Budget Adder? — Yes/No & Percent", "project_time_budget_adder", "project_time_budget_pct")}
            ${rowNumber("Rack Install Profit % (TARGET)", "rack_install_profit_target", { step: "0.01" })}
            ${rowNumber("Rental Equipment RACK Profit % (TARGET)", "rental_rack_profit_target", { step: "0.01" })}
            ${rowNumber("Mobilization Profit % (TARGET)", "mobilization_profit_target", { step: "0.005" })}
          </div>

          <!-- Right column -->
          <div class="flex flex-col gap-3">
            ${rowSelect("Estimate Type", "estimate_type", ESTIMATE_TYPES)}
            ${rowSelect("Breaking Out Mobilization?", "breaking_out_mobilization", YES_NO)}
            ${rowSelect("Rent Wire Guidance Equipment?", "rent_wire_guidance_equipment", YES_NO)}
            ${rowCrew("Crew Count — Size")}
            ${rowNumber("Wire Guidance Profit % (TARGET)", "wire_guidance_profit_target", { step: "0.01" })}
            ${rowNumber("Rental Equipment WIRE Profit % (TARGET)", "rental_wire_profit_target", { step: "0.01" })}
            ${rowNumber("Downtime Day Price (TARGET)", "downtime_day_price_target", { step: "50", suffix: "$" })}
          </div>
        </div>
      </div>

      <!-- Key Estimating Output Variables -->
      <div class="card px-5 py-4">
        <div class="flex items-baseline justify-between mb-3 pb-2 border-b border-black/10">
          <div class="text-sm font-extrabold uppercase tracking-wide text-black/70">
            Key Estimating Output Variables
          </div>
          <div class="text-[11px] italic text-black/40">Calculated in a later phase</div>
        </div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3">

          <div class="flex flex-col gap-3">
            ${rowReadout("Labor Cost Per Day (Local or Out of Town)", fmtMoney(state.labor_cost_per_day))}
            ${rowReadout("Labor Cost Per TRAVEL Day", fmtMoney(state.labor_cost_per_travel_day))}
            ${rowReadout("Lodging Cost Per Day (<6 Days Hotel, >6 AB&B)", fmtMoney(state.lodging_cost_per_day))}
            ${rowReadout("Mgmt Travel Multiplier", state.mgmt_travel_multiplier.toFixed(7))}
            ${rowReadout("Travel Days Per Crew, Per Mobilization", String(state.travel_days_per_crew_per_mob))}
          </div>

          <div class="flex flex-col gap-3">
            ${rowReadout("Expected / Estimated Mobilization Count (RACK)", String(state.expected_mob_count_rack))}
            ${rowReadout("Expected / Estimated Mobilization Count (WIRE GUIDE)", String(state.expected_mob_count_wire))}
            ${rowReadout("Project Travel Days — Cost", fmtMoney(state.project_travel_days_cost))}
            ${rowReadout("Project Labor Days — Cost", fmtMoney(state.project_labor_days_cost))}
            ${rowReadout("Project Downtime Days — Cost", fmtMoney(state.project_downtime_days_cost))}
          </div>
        </div>
      </div>

      <!-- Estimating Results - Pricing & Schedule -->
      <div class="card px-5 py-4">
        <div class="flex items-baseline justify-between mb-3 pb-2 border-b border-black/10">
          <div class="text-sm font-extrabold uppercase tracking-wide text-black/70">
            Estimating Results — Pricing &amp; Schedule
          </div>
          <div class="text-[11px] italic text-black/40">Calculated in a later phase</div>
        </div>
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
        </div>
      </div>

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
  // Single delegated change/input listener that mirrors form values into state.
  // For Phase 1 nothing reads these — no calculations, no save — but the values
  // are kept in sync so a future phase can hook into the same state object.
  document.addEventListener("input", (e) => {
    const el = e.target.closest("[data-est-input]");
    if (!el) return;
    const key = el.getAttribute("data-est-input");
    if (!(key in state)) return;
    const wantNumber = el.getAttribute("data-est-type") === "number";
    state[key] = wantNumber ? (Number(el.value) || 0) : el.value;
  });
  document.addEventListener("change", (e) => {
    const el = e.target.closest("[data-est-input]");
    if (!el) return;
    const key = el.getAttribute("data-est-input");
    if (!(key in state)) return;
    const wantNumber = el.getAttribute("data-est-type") === "number";
    state[key] = wantNumber ? (Number(el.value) || 0) : el.value;
  });
}
