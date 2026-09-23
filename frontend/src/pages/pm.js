// PM Portal (Phase 1) — the project manager's own workspace. Mobile-first:
// PMs use this on phones in the field.
//   home    (#/pm)                    My Active / Upcoming projects (scoped to
//                                     the logged-in user's PM link, expandable
//                                     to all) + Procedures & Resources pills
//   detail  (#/pm/project/<qboId>)    compact read-only header + tabs hosting
//                                     Kickoff & Process, Daily Log, Documents —
//                                     the SAME panels/endpoints the office
//                                     workspace used (office is read-only now).
// No project profitability anywhere on these pages (crew/PM surface).
import { api, hasCapability } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import { createFormRenderer } from "../utils/form-render.js";
import { mountKickoffPanel } from "./kickoff.js";
import { mountDailyPanel } from "./daily.js";

const ALL_KEY = "opi_pm_all";  // remembered "All projects" toggle
const FILTER_KEY = "opi_pm_filters"; // remembered search/status/pm filters

function loadFilters() {
  try { return JSON.parse(sessionStorage.getItem(FILTER_KEY)) || {}; } catch (_) { return {}; }
}
function saveFilters(f) {
  try { sessionStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch (_) {}
}
function applyFilters(items, f) {
  return (items || []).filter((p) => {
    if (f.q) {
      const q = f.q.toLowerCase();
      if (!(`${p.name || ""} ${p.customer || ""}`.toLowerCase().includes(q))) return false;
    }
    if (f.status && p.status !== f.status) return false;
    if (f.pm && !(String(p.pm_names || "").toLowerCase().includes(f.pm.toLowerCase()))) return false;
    return true;
  });
}
let _listCache = {};           // {scope: response} — reused for detail headers

const fmtDate = (v) => (v ? String(v).slice(0, 10) : "");
const STATUS = {
  needs_attention: { label: "Needs attention", cls: "bg-amber-100 text-amber-800" },
  pending:         { label: "Pending",         cls: "bg-amber-100 text-amber-800" },
  not_started:     { label: "Not started",     cls: "bg-violet-100 text-violet-700" },
  in_progress:     { label: "In progress",     cls: "bg-blue-100 text-blue-700" },
  completed:       { label: "Complete",        cls: "bg-emerald-100 text-emerald-800" },
  canceled:        { label: "Canceled",        cls: "bg-black/10 text-black/50" },
};
const statusBadge = (s) => {
  const m = STATUS[s] || { label: s || "—", cls: "bg-black/10 text-black/50" };
  return `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${m.cls}">${escapeHtml(m.label)}</span>`;
};
const windowText = (p) => {
  if (!p.start_date && !p.end_date) return "Dates TBD";
  return `${fmtDate(p.start_date) || "—"} → ${fmtDate(p.end_date) || "—"}`;
};

async function loadList(showAll) {
  const scope = showAll ? "all" : "mine";
  const d = await api(`/pm/projects${showAll ? "?all=1" : ""}`);
  _listCache[scope] = d;
  return d;
}

function findProject(qboId) {
  for (const scope of ["mine", "all"]) {
    const d = _listCache[scope];
    if (!d) continue;
    const hit = [...(d.active || []), ...(d.upcoming || [])]
      .find((p) => String(p.qbo_id) === String(qboId));
    if (hit) return hit;
  }
  return null;
}

export async function pmPage(routeFn, params = null) {
  if (params && params.projectId) return pmProjectDetail(routeFn, params.projectId);
  return pmHome(routeFn);
}

// ── PM home ──────────────────────────────────────────────────────────────────
async function pmHome(routeFn) {
  let showAll = false;
  try { showAll = sessionStorage.getItem(ALL_KEY) === "1"; } catch (_) {}

  let data;
  try { data = await loadList(showAll); }
  catch (e) {
    mount(routeFn, `<div class="card p-5 text-sm text-red-700">Failed to load your projects: ${escapeHtml(e?.message || String(e))}</div>`);
    return;
  }

  // Per-project unreviewed-form counts, filled in from the review queue we
  // already fetch for this page (no extra calls). null until it loads.
  let formCounts = null;

  const projCard = (p) => {
    const fc = formCounts && formCounts[String(p.qbo_id)];
    const formChips = fc
      ? `${fc.flags ? `<span class="pm-chip pm-chip-flag">⚑ ${fc.flags}</span>` : ""}
         <span class="pm-chip pm-chip-review">${fc.n} to review</span>`
      : "";
    return `
    <a href="#/pm/project/${encodeURIComponent(p.qbo_id)}" class="pm-card">
      <div class="min-w-0 flex-1">
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-bold text-ink-900 truncate">${escapeHtml(p.name || "(unnamed)")}</div>
            <div class="text-[11px] text-black/50 truncate">${escapeHtml(p.customer || "")}</div>
          </div>
          <div class="flex items-center gap-1 shrink-0">${formChips}</div>
        </div>
        <div class="mt-1.5 flex items-center gap-2 flex-wrap">
          ${statusBadge(p.status)}
          <span class="text-[11px] text-black/45 tabular-nums">${escapeHtml(windowText(p))}</span>
        </div>
        ${data.scope === "all" && p.pm_names ? `<div class="mt-1 text-[10px] text-black/40 truncate">PM: ${escapeHtml(p.pm_names)}${p.is_mine ? " · yours" : ""}</div>` : ""}
      </div>
      <span class="text-black/25 text-lg shrink-0">›</span>
    </a>`;
  };

  const section = (title, items, emptyText) => `
    <div class="mb-5">
      <div class="flex items-center gap-2 mb-2">
        <div class="text-sm font-extrabold text-white">${title}</div>
        <span class="text-[11px] font-semibold text-white/50 tabular-nums">${items.length}</span>
      </div>
      ${items.length
        ? `<div class="pm-grid">${items.map(projCard).join("")}</div>`
        : `<div class="rounded-xl border border-dashed border-white/20 px-4 py-5 text-center text-xs text-white/50">${emptyText}</div>`}
    </div>`;

  const mineLabel = data.scope === "all" ? "Active Projects (all)" : "My Active Projects";
  const upLabel = data.scope === "all" ? "Upcoming Projects (all)" : "Upcoming Projects";
  const notLinked = !data.pm;
  const notice = notLinked && data.scope !== "all"
    ? `<div class="pm-ro-note mb-4">Your login isn't linked to a Project Manager yet, so no projects are listed as yours. Ask the office to link your account on the Users page — or use "All projects" below.</div>`
    : "";

  const filters = loadFilters();
  // Distinct PM names for the PM filter (only meaningful in "all" scope).
  const pmNames = [...new Set([...(data.active || []), ...(data.upcoming || [])]
    .flatMap((p) => String(p.pm_names || "").split(",").map((s) => s.trim()).filter(Boolean)))].sort();
  const statusesPresent = [...new Set([...(data.active || []), ...(data.upcoming || [])].map((p) => p.status).filter(Boolean))];
  // Sticky at every width: sits just under the app's top bar on an OPAQUE
  // shell-colored strip (translucent would go black over scrolled content).
  const filterBar = `
    <div class="pm-filterbar">
      <input id="pmSearch" type="search" placeholder="Search project or customer…" value="${escapeHtml(filters.q || "")}"
             class="pm-filter" style="flex:1 1 200px" />
      <select id="pmStatusFilter" class="pm-filter">
        <option value="">All statuses</option>
        ${statusesPresent.map((s) => `<option value="${escapeHtml(s)}" ${filters.status === s ? "selected" : ""}>${escapeHtml((STATUS[s] || { label: s }).label)}</option>`).join("")}
      </select>
      ${data.scope === "all" ? `
      <select id="pmPmFilter" class="pm-filter">
        <option value="">All PMs</option>
        ${pmNames.map((n) => `<option value="${escapeHtml(n)}" ${filters.pm === n ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}
      </select>` : ""}
      <button type="button" id="pmAllToggle" class="pm-btn">
        <span class="inline-flex h-3.5 w-3.5 items-center justify-center rounded border ${data.scope === "all" ? "bg-blue-600 border-blue-600 text-white" : "border-black/30 text-transparent"}"><svg style="width:10px;height:10px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><polyline points="20 6 9 17 4 12"/></svg></span>
        All projects
      </button>
    </div>`;

  mount(routeFn, `
    <div class="w-full">
      ${data.pm && data.pm.name ? `<div class="text-xs text-white/60 mb-3">Signed in as PM ${escapeHtml(data.pm.name)}</div>` : ""}
      ${notice}
      <div id="pmFormsQueue" class="mb-5"></div>
      ${filterBar}
      <div id="pmSections">
      ${section(mineLabel, applyFilters(data.active, filters), data.scope === "all" ? "No active projects." : "No active projects assigned to you right now.")}
      ${section(upLabel, applyFilters(data.upcoming, filters), data.scope === "all" ? "No upcoming projects." : "No upcoming projects assigned to you.")}
      </div>

      <div class="mb-5">
        <div class="text-sm font-extrabold text-white mb-2">Procedures &amp; Resources</div>
        <div class="card p-4">
          <div class="flex gap-2 flex-wrap mb-2">
            <span class="pm-pill pm-pill-muted">Procedures</span>
            <span class="pm-pill pm-pill-muted">Resources</span>
          </div>
          <div class="text-xs text-black/45">Procedure documents land here — upload coming in Phase 2.</div>
        </div>
      </div>
    </div>`);

  // Form-submissions review queue (crew field forms, Phase 2) — non-blocking.
  // The same fetch feeds the per-card "N to review" hints (no extra calls).
  mountFormsQueue(document.getElementById("pmFormsQueue"), data.scope === "all", (items) => {
    const map = {};
    for (const s of items || []) {
      const k = String(s.project_qbo_id);
      map[k] = map[k] || { n: 0, flags: 0 };
      map[k].n += 1;
      if (s.red_flag) map[k].flags += 1;
    }
    formCounts = map;
    rerenderSections();
  });

  document.getElementById("pmAllToggle")?.addEventListener("click", () => {
    try { sessionStorage.setItem(ALL_KEY, data.scope === "all" ? "0" : "1"); } catch (_) {}
    pmHome(routeFn);
  });

  // Filters: re-render only the section lists so the search box keeps focus.
  const rerenderSections = () => {
    const f = loadFilters();
    const host = document.getElementById("pmSections");
    if (!host) return;
    host.innerHTML =
      section(mineLabel, applyFilters(data.active, f), data.scope === "all" ? "No active projects." : "No active projects assigned to you right now.") +
      section(upLabel, applyFilters(data.upcoming, f), data.scope === "all" ? "No upcoming projects." : "No upcoming projects assigned to you.");
  };
  let _ft;
  document.getElementById("pmSearch")?.addEventListener("input", (e) => {
    clearTimeout(_ft);
    _ft = setTimeout(() => { saveFilters({ ...loadFilters(), q: e.target.value.trim() }); rerenderSections(); }, 200);
  });
  document.getElementById("pmStatusFilter")?.addEventListener("change", (e) => {
    saveFilters({ ...loadFilters(), status: e.target.value }); rerenderSections();
  });
  document.getElementById("pmPmFilter")?.addEventListener("change", (e) => {
    saveFilters({ ...loadFilters(), pm: e.target.value }); rerenderSections();
  });
}

// ── PM project detail ────────────────────────────────────────────────────────
async function pmProjectDetail(routeFn, qboId) {
  // Header meta comes from the same list endpoint (cached from the home page;
  // fetched fresh on deep links). Falls back to name-only if not found.
  let proj = findProject(qboId);
  if (!proj) {
    try { await loadList(true); proj = findProject(qboId); } catch (_) {}
  }

  let activeTab = "overview";

  mount(routeFn, `
    <div class="w-full max-w-4xl">
      <div class="mb-3"><a href="#/pm" class="inline-flex items-center gap-1 text-xs font-semibold text-white/60 hover:text-white">← PM Portal</a></div>
      <div class="card flex flex-col overflow-hidden" style="min-height:420px">
        <div class="shrink-0 px-4 sm:px-5 pt-4 border-b border-black/10">
          <div class="text-base font-extrabold text-ink-900">${escapeHtml(proj?.name || "Project")}</div>
          <div class="text-xs text-black/50 mt-0.5">${escapeHtml(proj?.customer || "")}</div>
          <div class="mt-1.5 mb-2 flex items-center gap-2 flex-wrap">
            ${proj ? statusBadge(proj.status) : ""}
            ${proj ? `<span class="text-[11px] text-black/45 tabular-nums">${escapeHtml(windowText(proj))}</span>` : ""}
          </div>
          <div id="pmTabBar" class="flex gap-1 -mb-px overflow-x-auto"></div>
        </div>
        <div id="pmTabBody" class="flex-1 overflow-auto"></div>
      </div>
    </div>`);

  const body = () => document.getElementById("pmTabBody");

  function renderTabs() {
    const bar = document.getElementById("pmTabBar");
    if (!bar) return;
    const btn = (key, label) => `<button type="button" data-tab="${key}" class="px-3 py-2 text-xs font-bold border-b-2 whitespace-nowrap ${activeTab === key ? "border-blue-600 text-ink-900" : "border-transparent text-black/40 hover:text-black/70"}">${label}</button>`;
    bar.innerHTML = btn("overview", "Overview") + btn("kickoff", "Kickoff &amp; Process") + btn("daily", "Daily Log") + btn("forms", "Forms") + btn("documents", "Documents") + btn("financials", "Financials") + btn("receipts", "Receipts") + btn("crew", "Crew");
    bar.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
      const t = b.getAttribute("data-tab");
      if (t === activeTab) return;
      activeTab = t; renderTabs(); showTab();
    }));
  }

  const switchTab = (t) => { activeTab = t; renderTabs(); showTab(); };

  function showTab() {
    const el = body();
    if (!el) return;
    el.innerHTML = "";
    if (activeTab === "overview") mountPmOverview(el, qboId, switchTab);
    else if (activeTab === "kickoff") mountKickoffPanel(el, qboId);
    else if (activeTab === "daily") mountDailyPanel(el, qboId);
    else if (activeTab === "forms") mountPmFormsTab(el, qboId);
    else if (activeTab === "financials") mountPmFinancialsTab(el, qboId, switchTab);
    else if (activeTab === "receipts") mountPmReceiptsTab(el, qboId);
    else if (activeTab === "crew") mountPmCrewTab(el, qboId);
    else mountPmDocuments(el, qboId);
  }

  renderTabs();
  showTab();
}

// ── Overview tab (Design v3 Milestone B): assignment facts + financial
// burndowns (same numbers as the office Billing & Schedule tab) + a two-lane
// tracking list. Read & track only — settings live in the Forms tab.
const fmtMoney = (v) => {
  const n = Number(v || 0);
  return "$" + Math.round(n).toLocaleString("en-US");
};

// Section anchor a Financials-tab open should scroll to (set by the Overview's
// clickable financial rows, consumed once by mountPmFinancialsTab).
let _pmFinAnchor = null;
const finAnchorFor = (cat) => `pmfin-exp-${String(cat || "other").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

// Signed over/under line after a burndown bar — TEXT always, color is
// reinforcement only. over_under = actual − scheduled (backend-signed).
function overUnderHtml(ou, scheduled) {
  const v = Number(ou || 0);
  if (v > 0.5) return `<div class="text-[11px] font-bold mt-0.5" style="color:#b91c1c">▲ ${fmtMoney(v)} over${Number(scheduled || 0) > 0 ? "" : " — unscheduled"}</div>`;
  if (v < -0.5) return `<div class="text-[11px] font-bold mt-0.5" style="color:#047857">▼ ${fmtMoney(-v)} under</div>`;
  if (Number(scheduled || 0) > 0) return `<div class="text-[11px] font-semibold mt-0.5 text-black/45">— on budget</div>`;
  return "";
}

async function mountPmOverview(container, qboId, switchTab) {
  container.innerHTML = `<div class="p-4 text-sm text-black/40">Loading overview…</div>`;
  let d, rc = null;
  try {
    // Receipts feed the SOFT overlay on the expense burndown (pending = not
    // yet allocated in QBO). Best-effort: the overview renders without it.
    [d, rc] = await Promise.all([
      api(`/pm/project/${encodeURIComponent(qboId)}/overview`),
      api(`/receipts?project_qbo_id=${encodeURIComponent(qboId)}`).catch(() => null),
    ]);
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-sm text-red-700">Failed to load overview: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }

  const a = d.assignment || {};
  const fin = d.financials || {};
  const trk = d.tracking || {};

  // ── assignment block ────────────────────────────────────────────────────
  const person = (p) => `<div>${escapeHtml(p.name || "—")}${p.is_primary ? ` <span class="text-[10px] font-bold text-blue-700">primary</span>` : ""}${p.assigned_at ? ` <span class="text-black/40">· assigned ${escapeHtml(fmtDate(p.assigned_at))}</span>` : ""}</div>`;
  const ovRow = (label, valueHtml) => `
    <div class="pm-ov-row">
      <div class="pm-ov-label">${label}</div>
      <div class="pm-ov-value">${valueHtml}</div>
    </div>`;
  const dash = `<span class="text-black/35">—</span>`;
  const assignmentHtml = `
    <div class="pm-ov-grid">
      ${ovRow("Project manager", (a.pms || []).length ? a.pms.map(person).join("") : dash)}
      ${ovRow("Work crew", (a.crews || []).length ? a.crews.map(person).join("") : dash)}
      ${ovRow("Schedule", (a.start_date || a.end_date)
        ? `<span class="tabular-nums">${escapeHtml(fmtDate(a.start_date) || "—")} → ${escapeHtml(fmtDate(a.end_date) || "—")}</span>` : "Dates TBD")}
      ${ovRow("Wire guidance", a.wire_guidance ? `<span class="font-bold">Yes</span>` : "No")}
      ${ovRow("Travel days", a.travel_days ? `${a.travel_days} days` : "None")}
      ${ovRow("Overage days", a.overage_days ? `${a.overage_days} days` : "None")}
      ${ovRow("Equipment", a.equipment ? escapeHtml(a.equipment) : dash)}
      ${ovRow("Notes", a.notes ? `<span class="whitespace-pre-wrap">${escapeHtml(a.notes)}</span>` : dash)}
    </div>`;

  // ── financial burndown bars ─────────────────────────────────────────────
  // Soft receipts overlay: per expense category, the $ of receipts still
  // PENDING (uploaded/reconciled — not yet allocated in QBO). Clearly
  // unofficial; clicking jumps to the Receipts tab.
  const rcPendingByExp = {};
  let rcPendingTotal = 0;
  for (const c of (rc && rc.totals && rc.totals.by_category) || []) {
    const p = Number(c.pending || 0);
    if (p <= 0.5) continue;
    const exp = RECEIPT_TO_EXPENSE_CAT[c.category] || "Other";
    rcPendingByExp[exp] = (rcPendingByExp[exp] || 0) + p;
    rcPendingTotal += p;
  }
  const softNote = (amt) => `
    <button type="button" class="pm-softnote" data-goto="receipts"
            title="Unofficial early signal from field receipts — not yet allocated in QBO. Opens the Receipts tab.">
      + ${fmtMoney(amt)} in receipts pending · unofficial ›
    </button>`;

  // Each financial row is CLICKABLE → the Financials tab, scrolled to its
  // section. Not a <button> (the soft receipts note nests its own button).
  const bar = (label, actual, scheduled, verb, overUnder, anchor, extraHtml) => {
    const act = Number(actual || 0), sch = Number(scheduled || 0);
    const pct = sch > 0 ? Math.min(100, (act / sch) * 100) : (act > 0 ? 100 : 0);
    const right = sch > 0
      ? `<span class="tabular-nums">${fmtMoney(act)}</span> <span class="text-black/45">${verb} of</span> <span class="tabular-nums">${fmtMoney(sch)}</span>`
      : `<span class="tabular-nums">${fmtMoney(act)}</span> <span class="text-black/45">${verb} · nothing scheduled</span>`;
    return `
      <div class="pm-finlink mb-2" data-finjump="${escapeHtml(anchor)}" role="link" tabindex="0"
           title="Open the ${escapeHtml(label)} deep dive in the Financials tab">
        <div class="flex items-baseline justify-between gap-3 mb-1">
          <div class="text-xs font-bold text-ink-900 truncate">${escapeHtml(label)} <span class="text-black/30 font-semibold">›</span></div>
          <div class="text-[11px] text-ink-900 shrink-0">${right}</div>
        </div>
        <div class="pm-bar"><div class="${pct >= 100 ? "full" : ""}" style="width:${pct.toFixed(1)}%"></div></div>
        ${overUnderHtml(overUnder, sch)}
        ${extraHtml || ""}
      </div>`;
  };
  const crewFin = fin.crew || {};
  const expRows = (fin.expenses || []);
  // Pending-receipt categories with no expense bar of their own still surface.
  const barCats = new Set(expRows.map((c) => c.category || "Other"));
  const rcLeftover = Object.entries(rcPendingByExp).filter(([cat]) => !barCats.has(cat));
  const profitChip = fin.est_profit != null ? `
      <div>
        <div class="text-[10px] font-bold uppercase tracking-wide text-black/40">Estimated profit</div>
        <div class="text-sm font-extrabold tabular-nums" style="color:${Number(fin.est_profit) >= 0 ? "#047857" : "#b91c1c"}">
          ${fmtMoney(fin.est_profit)}${fin.est_margin_pct != null ? ` <span class="text-[11px] font-bold">· ${escapeHtml(String(fin.est_margin_pct))}% margin</span>` : ""}
        </div>
      </div>` : "";
  const financialHtml = `
    <div class="pm-finlink mb-3" data-finjump="pmfin-invoices" role="link" tabindex="0"
         title="Open the invoices &amp; billing deep dive in the Financials tab">
      <div class="flex items-baseline gap-4 flex-wrap">
        <div>
          <div class="text-[10px] font-bold uppercase tracking-wide text-black/40">Project value (contract) <span class="text-black/30">›</span></div>
          <div class="text-2xl font-extrabold text-ink-900 tabular-nums">${fmtMoney(fin.project_value)}</div>
        </div>
        ${profitChip}
        ${fin.books_closed ? `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-emerald-100 text-emerald-800">Books closed</span>` : ""}
      </div>
      ${fin.value_source === "billing_schedule" ? `<div class="text-[11px] text-black/45 mt-0.5">From the billing schedule — no QBO estimate rollup for this project yet.</div>` : `<div class="text-[11px] text-black/45 mt-0.5">Same contract value as the All Projects page (QBO accepted estimates incl. change orders).</div>`}
    </div>
    ${bar("Crew payments", crewFin.paid_total, crewFin.scheduled_total, "paid", crewFin.over_under, "pmfin-crew")}
    ${expRows.length
      ? expRows.map((c) => {
          const cat = c.category || "Other";
          const soft = rcPendingByExp[cat];
          return bar(cat, c.actual_total, c.scheduled_total, "spent", c.over_under, finAnchorFor(cat), soft ? softNote(soft) : "");
        }).join("")
      : `<div class="text-[11px] text-black/40 mb-2">No expense schedule yet.</div>`}
    ${rcLeftover.map(([cat, amt]) => `
      <div class="mb-2"><span class="text-xs font-bold text-ink-900">${escapeHtml(cat)}</span> ${softNote(amt)}</div>`).join("")}
    ${rcPendingTotal > 0.5 ? `<div class="text-[11px] text-black/45 mt-1">Receipt overlays are a soft, unofficial signal from field receipts awaiting reconciliation/QBO — actuals above come from QBO only.</div>` : ""}
    <div class="text-[11px] text-black/45 mt-2">Schedules &amp; actuals mirror the office Billing &amp; Schedule tab — tap any row for the deep dive in the <span class="font-bold">Financials</span> tab.</div>`;

  // ── tracking list (PM lane + Crew lane) ─────────────────────────────────
  const lane = (kind) => kind === "pm"
    ? `<span class="pm-chip pm-chip-lane-pm">PM</span>`
    : `<span class="pm-chip pm-chip-lane-crew">Crew</span>`;
  const trackRow = ({ laneKind, title, sub, chips, goto }) => `
    <button type="button" class="pm-track-row" data-goto="${goto}">
      ${lane(laneKind)}
      <div class="min-w-0 flex-1">
        <div class="text-xs font-bold text-ink-900 truncate">${escapeHtml(title)}</div>
        ${sub ? `<div class="text-[11px] text-black/50 truncate">${sub}</div>` : ""}
      </div>
      <div class="flex items-center gap-1 shrink-0 flex-wrap justify-end">${chips || ""}</div>
      <span class="text-black/25 text-lg shrink-0">›</span>
    </button>`;

  const kick = trk.kickoff || {};
  const kickChip = kick.status === "complete"
    ? `<span class="pm-chip pm-chip-ok">Complete</span>`
    : kick.status === "in_progress"
      ? `<span class="pm-chip pm-chip-lane-pm">In progress</span>`
      : `<span class="pm-chip pm-chip-muted">Not started</span>`;
  const daily = trk.daily_log || {};
  const dailyChip = daily.logged_today
    ? `<span class="pm-chip pm-chip-ok">Logged today</span>`
    : daily.last_date
      ? `<span class="pm-chip pm-chip-review">Not logged today</span>`
      : `<span class="pm-chip pm-chip-muted">No logs yet</span>`;

  const rows = [
    trackRow({
      laneKind: "pm", title: "Kickoff & Process", goto: "kickoff",
      sub: `${kick.items_done ?? 0}/${kick.items_total ?? 0} checklist items done`,
      chips: kickChip,
    }),
    trackRow({
      laneKind: "pm", title: "Daily Log", goto: "daily",
      sub: daily.last_date ? `Last log ${escapeHtml(fmtDate(daily.last_date))}` : "No daily logs recorded",
      chips: dailyChip,
    }),
    ...(trk.crew_forms || []).map((f) => trackRow({
      laneKind: "crew", title: f.title || f.form_code, goto: "forms",
      sub: f.cadence === "as_needed"
        ? `As needed · ${f.submissions_count} submitted${f.last_submitted_at ? ` · last ${escapeHtml(fmtDate(f.last_submitted_at))}` : ""}`
        : `${escapeHtml(CADENCE_LABEL[f.cadence] || "")}${f.submissions_count
            ? ` · ${f.submissions_count} submission${f.submissions_count === 1 ? "" : "s"} · last ${escapeHtml(fmtDate(f.last_submitted_at))}`
            : " · no submissions yet"}`,
      chips: `${f.red_flags ? `<span class="pm-chip pm-chip-flag">⚑ ${f.red_flags}</span>` : ""}
              ${f.needs_review_count ? `<span class="pm-chip pm-chip-review">${f.needs_review_count} to review</span>` : ""}
              ${formProgressHtml(f)}
              ${formStatusChip(f)}`,
    })),
  ];

  container.innerHTML = `
    <div class="p-4 sm:p-5">
      <div class="text-sm font-extrabold text-ink-900 mb-2">Assignment</div>
      ${assignmentHtml}

      <div class="text-sm font-extrabold text-ink-900 mt-5 mb-2">Financial summary</div>
      ${financialHtml}

      <div class="text-sm font-extrabold text-ink-900 mt-5 mb-2">Tracking</div>
      <div class="grid grid-cols-1 gap-2">${rows.join("")}</div>
    </div>`;

  container.querySelectorAll("[data-goto]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); switchTab(b.getAttribute("data-goto")); }));
  // Financial rows → Financials tab, scrolled to that row's section. The soft
  // receipts note nested inside a row keeps its own [data-goto] behavior.
  container.querySelectorAll("[data-finjump]").forEach((el) => {
    const jump = () => { _pmFinAnchor = el.getAttribute("data-finjump"); switchTab("financials"); };
    el.addEventListener("click", (e) => { if (e.target.closest("[data-goto]")) return; jump(); });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jump(); } });
  });
}

// ── Financials tab (Design v3 item 4 — UNPARKED 2026-09-22) ─────────────────
// Read-only deep dive mirroring the office Billing & Schedule content for THIS
// project, from GET /api/pm/project/{id}/financials (the same billing
// composers the office tab uses — no math re-implemented client-side).
// Section anchors match the Overview's clickable rows.
const FIN_PILL = {
  "Paid":        "bg-emerald-100 text-emerald-800",
  "Sent · A/R":  "bg-black/10 text-black/60",
  "Bill · A/P":  "bg-black/10 text-black/60",
  "Scheduled":   "bg-blue-100 text-blue-700",
  "Not paid":    "bg-red-100 text-red-800",
  "Not spent":   "bg-red-100 text-red-800",
  "Allocated":   "bg-black/10 text-black/50",
};
function finPill(label) {
  const cls = FIN_PILL[label] || (String(label || "").startsWith("Partial") ? "bg-amber-100 text-amber-800" : "bg-black/10 text-black/50");
  return `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold whitespace-nowrap ${cls}">${escapeHtml(label || "—")}</span>`;
}

async function mountPmFinancialsTab(container, qboId, switchTab) {
  container.innerHTML = `<div class="p-4 text-sm text-black/40">Loading financials…</div>`;
  let d, rc = null;
  try {
    [d, rc] = await Promise.all([
      api(`/pm/project/${encodeURIComponent(qboId)}/financials`),
      api(`/receipts?project_qbo_id=${encodeURIComponent(qboId)}`).catch(() => null),
    ]);
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-sm text-red-700">Failed to load financials: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }
  const con = d.contract || {};
  const inv = d.invoices || { milestones: [], actuals: [], summary: {} };
  const crew = d.crew || { installments: [], actuals: [], summary: {} };
  const exp = d.expenses || { by_category: [] };

  // Receipts still pending (uploaded/reconciled — not allocated in QBO yet),
  // keyed by the expense category they overlay. Soft signal only.
  const rcPendingByExp = {};
  for (const c of (rc && rc.totals && rc.totals.by_category) || []) {
    const p = Number(c.pending || 0);
    if (p > 0.5) {
      const cat = RECEIPT_TO_EXPENSE_CAT[c.category] || "Other";
      rcPendingByExp[cat] = (rcPendingByExp[cat] || 0) + p;
    }
  }

  const secHead = (title, sub) => `
    <div class="text-sm font-extrabold text-ink-900 mb-1">${title}</div>
    ${sub ? `<div class="text-[11px] text-black/45 mb-2">${sub}</div>` : ""}`;
  const burn = (actual, scheduled) => {
    const act = Number(actual || 0), sch = Number(scheduled || 0);
    const pct = sch > 0 ? Math.min(100, (act / sch) * 100) : (act > 0 ? 100 : 0);
    return `<div class="pm-bar"><div class="${pct >= 100 ? "full" : ""}" style="width:${pct.toFixed(1)}%"></div></div>`;
  };
  const lineRow = (left, mid, amount, statusLabel, extra) => `
    <div class="pm-fin-row">
      <div class="min-w-0 flex-1">
        <div class="text-xs font-semibold text-ink-900 truncate">${left}</div>
        ${mid ? `<div class="text-[11px] text-black/45 truncate">${mid}</div>` : ""}
      </div>
      <div class="text-xs font-bold text-ink-900 tabular-nums shrink-0">${fmtMoney(amount)}</div>
      <div class="shrink-0">${finPill(statusLabel)}</div>
      ${extra || ""}
    </div>`;

  // ── (a) Invoices / billing ────────────────────────────────────────────────
  const contract = Number(con.project_value || 0);
  const schedTotal = Number(con.billing_schedule_total || 0);
  const coverageNote = con.value_source === "qbo_estimate" && Math.abs(schedTotal - contract) > 0.5
    ? `<div class="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 mb-2 text-[12px] text-amber-900">
         Billing schedule covers <b class="tabular-nums">${fmtMoney(schedTotal)}</b> of the
         <b class="tabular-nums">${fmtMoney(contract)}</b> contract — the office sets up the
         remaining milestones on Billing &amp; Schedule.</div>`
    : "";
  const invoicedToDate = Number(inv.invoiced_qbo || 0);
  const collected = Number(inv.paid_qbo || 0);
  const invKpis = `
    <div class="pm-fin-kpis mb-2">
      <div><div class="pm-fin-kpi-l">Contract (All Projects)</div><div class="pm-fin-kpi-v">${fmtMoney(contract)}</div></div>
      <div><div class="pm-fin-kpi-l">Billing schedule</div><div class="pm-fin-kpi-v">${fmtMoney(schedTotal)}</div></div>
      <div><div class="pm-fin-kpi-l">Invoiced to date</div><div class="pm-fin-kpi-v">${fmtMoney(invoicedToDate)}</div></div>
      <div><div class="pm-fin-kpi-l">Collected</div><div class="pm-fin-kpi-v" style="color:#047857">${fmtMoney(collected)}</div></div>
      <div><div class="pm-fin-kpi-l">Open A/R</div><div class="pm-fin-kpi-v">${fmtMoney(Math.max(0, invoicedToDate - collected))}</div></div>
      ${con.est_profit != null ? `<div><div class="pm-fin-kpi-l">Est. profit</div><div class="pm-fin-kpi-v" style="color:${Number(con.est_profit) >= 0 ? "#047857" : "#b91c1c"}">${fmtMoney(con.est_profit)}${con.est_margin_pct != null ? ` · ${escapeHtml(String(con.est_margin_pct))}%` : ""}</div></div>` : ""}
    </div>`;
  const msRows = (inv.milestones || []).map((m) => lineRow(
    escapeHtml(m.label || "Milestone"),
    `${escapeHtml(fmtDate(m.invoice_date) || "no date")}${m.due_date ? ` · due ${escapeHtml(fmtDate(m.due_date))}` : ""}${m.pct ? ` · ${Math.round(m.pct)}%` : ""}`,
    m.amount, m.status_label)).join("");
  const invActuals = (inv.actuals || []);
  const invActualsHtml = invActuals.length ? `
    <details class="mt-2">
      <summary class="text-[11px] font-bold text-black/50 cursor-pointer select-none">Actual invoices in QuickBooks (${invActuals.length})</summary>
      <div class="mt-1">${invActuals.map((x) => lineRow(
        `Invoice ${escapeHtml(x.doc_number ? "#" + x.doc_number : "—")}`,
        `${escapeHtml(fmtDate(x.txn_date) || "")}${x.due_date ? ` · due ${escapeHtml(fmtDate(x.due_date))}` : ""}`,
        x.amount, x.status === "Paid" ? "Paid" : (x.status === "Partial" ? `Partial · ${fmtMoney(x.balance)} A/R` : "Sent · A/R"))).join("")}</div>
    </details>` : "";

  // ── (b) Crew payments ─────────────────────────────────────────────────────
  const crewSched = Number((crew.summary || {}).total || 0);
  const crewPaid = Number(crew.paid_qbo || 0);
  const crewInsts = (crew.installments || []);
  const crewActs = (crew.actuals || []);
  const crewByVendor = {};
  for (const a of crewActs) (crewByVendor[a.vendor || "—"] = crewByVendor[a.vendor || "—"] || []).push(a);
  const crewActualsHtml = crewActs.length ? `
    <details class="mt-2">
      <summary class="text-[11px] font-bold text-black/50 cursor-pointer select-none">Actual crew bills in QuickBooks — Contract Labor (${crewActs.length})</summary>
      <div class="mt-1">${Object.keys(crewByVendor).sort().map((v) => {
        const rows = crewByVendor[v];
        const sub = rows.reduce((s, a) => s + Number(a.amount || 0), 0);
        return `<div class="text-[11px] font-bold text-ink-900 mt-2 flex justify-between"><span>${escapeHtml(v)}</span><span class="tabular-nums">${fmtMoney(sub)}</span></div>
          ${rows.map((a) => lineRow(`${escapeHtml(a.doc ? "#" + a.doc : "Bill")}`, escapeHtml(fmtDate(a.date) || ""), a.amount, "Paid")).join("")}`;
      }).join("")}</div>
    </details>` : "";

  // ── (c) Expenses per category ─────────────────────────────────────────────
  const catCard = (c) => {
    const cat = c.category || "Other";
    const soft = rcPendingByExp[cat];
    const weekly = (c.weekly || []).map((w) => lineRow(
      `Week of ${escapeHtml(fmtDate(w.week_of) || "—")}`, "", w.amount, w.status_label)).join("");
    const acts = (c.actuals || []);
    const actsHtml = acts.length ? `
      <details class="mt-1">
        <summary class="text-[11px] font-bold text-black/50 cursor-pointer select-none">Actual QBO spend (${acts.length})</summary>
        <div class="mt-1">${acts.map((a) => lineRow(escapeHtml(a.vendor || "—"),
          `${escapeHtml(a.source_item || "")}${a.date ? ` · ${escapeHtml(fmtDate(a.date))}` : ""}`, a.amount, "Paid")).join("")}</div>
      </details>` : "";
    return `
      <div id="${finAnchorFor(cat)}" class="pm-fin-card">
        <div class="flex items-baseline gap-2 flex-wrap mb-1">
          <span class="text-xs font-extrabold text-ink-900">${escapeHtml(cat)}</span>
          <span class="text-[11px] text-black/55 tabular-nums ml-auto">${fmtMoney(c.actual)} spent of ${fmtMoney(c.estimated)}</span>
        </div>
        ${burn(c.actual, c.estimated)}
        ${overUnderHtml(Number(c.actual || 0) - Number(c.estimated || 0), c.estimated)}
        ${soft ? `<button type="button" class="pm-softnote" data-goto="receipts" title="Unofficial early signal from field receipts — not yet allocated in QBO. Opens the Receipts tab.">+ ${fmtMoney(soft)} in receipts pending · unofficial ›</button>` : ""}
        ${weekly ? `<div class="mt-1.5">${weekly}</div>` : `<div class="text-[11px] text-black/40 mt-1">No weekly schedule for this category.</div>`}
        ${actsHtml}
      </div>`;
  };

  container.innerHTML = `
    <div class="p-4 sm:p-5">
      <div class="text-[11px] text-black/45 mb-3">Read-only — the same numbers and schedules as the office Billing &amp; Schedule tab. The office edits schedules there.</div>

      <div id="pmfin-invoices" class="pm-fin-sec">
        ${secHead("Invoices &amp; billing", "Contract vs the invoice milestone schedule, and what QuickBooks has actually invoiced.")}
        ${invKpis}
        ${coverageNote}
        ${burn(invoicedToDate, contract || schedTotal)}
        <div class="mt-2">${msRows || `<div class="text-[11px] text-black/40">No invoice milestones scheduled yet.</div>`}</div>
        ${invActualsHtml}
      </div>

      <div id="pmfin-crew" class="pm-fin-sec">
        ${secHead("Crew payments", "Installment schedule vs actual Contract-Labor bills paid in QuickBooks.")}
        <div class="flex items-baseline justify-between gap-3 mb-1">
          <div class="text-xs font-bold text-ink-900">Burndown</div>
          <div class="text-[11px] text-ink-900 tabular-nums">${fmtMoney(crewPaid)} paid of ${fmtMoney(crewSched)} scheduled</div>
        </div>
        ${burn(crewPaid, crewSched)}
        ${overUnderHtml(crewPaid - crewSched, crewSched)}
        <div class="mt-2">${crewInsts.length
          ? crewInsts.map((i) => lineRow(`Pay date ${escapeHtml(fmtDate(i.pay_date) || "TBD")}`, i.note ? escapeHtml(i.note) : "", i.amount, i.status_label)).join("")
          : `<div class="text-[11px] text-black/40">No crew payment schedule yet — the office adds assignment dates first.</div>`}</div>
        ${crewActualsHtml}
      </div>

      <div id="pmfin-expenses" class="pm-fin-sec">
        ${secHead("Expenses by category", "Weekly cash-out schedule vs actual QBO spend per category. Receipts pending reconciliation show as a soft, unofficial note.")}
        ${(exp.by_category || []).length
          ? exp.by_category.map(catCard).join("")
          : `<div class="text-[11px] text-black/40">No expense schedule yet.</div>`}
      </div>
    </div>`;

  container.querySelectorAll("[data-goto]").forEach((b) =>
    b.addEventListener("click", () => switchTab && switchTab(b.getAttribute("data-goto"))));

  // Arriving from an Overview row: scroll to (and briefly highlight) its section.
  if (_pmFinAnchor) {
    const el = container.querySelector(`#${CSS.escape(_pmFinAnchor)}`);
    _pmFinAnchor = null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      el.classList.add("pm-fin-hilite");
      setTimeout(() => el.classList.remove("pm-fin-hilite"), 1800);
    }
  }
}

// ── documents tab (same /api/documents tree as the office workspace) ─────────
const CHEV = `<svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>`;
const FOLDER_ICON = `<svg class="size-4 text-amber-500" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>`;
const FILE_ICON = `<svg class="size-4 text-black/40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;
const UPLOAD_ICON = `<svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
const DOWNLOAD_ICON = `<svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;

function fmtBytes(bytes) {
  const n = Number(bytes || 0);
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"]; let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Drag & drop into a documents folder row: validate, upload each file through
// the SAME POST the Upload button uses, per-file progress in a corner toast.
function createDocToast() {
  const t = document.createElement("div");
  t.className = "doc-toast";
  document.body.appendChild(t);
  return {
    set(html) { t.innerHTML = html; },
    done(ms) { setTimeout(() => t.remove(), ms || 2600); },
  };
}

async function handleDocDrop(fileList, folderLabel, uploadOne, refetch) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const bad = [], good = [];
  for (const f of files) {
    if (f.size > 100 * 1024 * 1024) bad.push(`${f.name} — over the 100 MB limit`);
    else if (f.size === 0 && !f.type) bad.push(`${f.name} — empty file (folders can't be dropped)`);
    else good.push(f);
  }
  const toast = createDocToast();
  let ok = 0; const fail = [];
  for (let i = 0; i < good.length; i++) {
    toast.set(`<b>Uploading to ${escapeHtml(folderLabel)}…</b><br>${escapeHtml(good[i].name)} · file ${i + 1} of ${good.length}`);
    try { await uploadOne(good[i]); ok++; }
    catch (err) { fail.push(`${good[i].name} — ${err?.message || "upload failed"}`); }
  }
  const bits = [];
  if (ok) bits.push(`✓ ${ok} file${ok === 1 ? "" : "s"} uploaded to ${escapeHtml(folderLabel)}`);
  for (const b of [...fail, ...bad]) bits.push(`✕ ${escapeHtml(b)}`);
  toast.set(bits.join("<br>") || "Nothing to upload.");
  toast.done(bad.length || fail.length ? 7000 : 2600);
  if (ok && refetch) { try { await refetch(); } catch (_) {} }
}

// Wires a documents tree host so every folder row ([data-drop]) is a drop
// target with a dragover highlight. uploadTo(folderKey) -> (file) => Promise.
// PROPERTY assignments (not addEventListener): the PM tab body element
// survives tab switches, so re-mounting Documents must REPLACE the handlers —
// stacked listeners would upload every dropped file more than once.
function wireDocDropTargets(host, uploadTo, afterUpload) {
  let hover = null;
  const clear = () => { if (hover) { hover.classList.remove("doc-drop-hover"); hover = null; } };
  host.ondragover = (e) => {
    const row = e.target.closest("[data-drop]");
    if (!row) { clear(); return; }
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    if (hover !== row) { clear(); row.classList.add("doc-drop-hover"); hover = row; }
  };
  host.ondragleave = (e) => {
    if (hover && !hover.contains(e.relatedTarget)) clear();
  };
  host.ondrop = (e) => {
    const row = e.target.closest("[data-drop]");
    clear();
    if (!row) return;
    e.preventDefault();
    const folder = row.getAttribute("data-drop");
    const label = row.getAttribute("data-drop-label") || folder;
    handleDocDrop(e.dataTransfer && e.dataTransfer.files, label, uploadTo(folder),
                  () => afterUpload(folder));
  };
}

async function mountPmDocuments(container, qboId) {
  container.innerHTML = `<div class="p-4 text-sm text-black/40">Loading documents…</div>`;
  let data;
  try { data = await api(`/documents/project/${encodeURIComponent(qboId)}`); }
  catch (e) {
    container.innerHTML = `<div class="p-4 text-sm text-red-700">Failed to load documents: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }
  const tree = data.tree || [];
  let files = data.files || {};
  const expanded = new Set();

  const countDeep = (node) => {
    let n = (files[node.key] || []).length;
    (node.children || []).forEach((c) => { n += countDeep(c); });
    return n;
  };

  const fileRow = (f) => `
    <div class="flex items-center gap-2 py-1.5 pr-2">
      ${FILE_ICON}
      <div class="min-w-0 flex-1">
        <div class="truncate text-xs font-medium text-ink-900" title="${escapeHtml(f.filename || "")}">${escapeHtml(f.filename || "(unnamed)")}</div>
        <div class="text-[10px] text-black/45">${fmtBytes(f.size_bytes)}${f.created_at ? " · " + fmtDate(f.created_at) : ""}${f.uploaded_by ? " · " + escapeHtml(f.uploaded_by) : ""}</div>
      </div>
      <button type="button" data-dl="${f.id}" title="Open" class="inline-flex h-7 w-7 items-center justify-center rounded-lg text-black/45 hover:bg-black/5 hover:text-blue-600">${DOWNLOAD_ICON}</button>
    </div>`;

  const renderNode = (node, depth) => {
    const open = expanded.has(node.key);
    const fls = files[node.key] || [];
    const deep = countDeep(node);
    const hasKids = (node.children || []).length > 0;
    const pad = 8 + depth * 16;
    const fileBadge = deep ? `<span class="ml-1.5 inline-flex rounded-full bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-black/55">${deep}</span>` : "";
    return `
      <div>
        <div class="flex items-center gap-2 border-b border-black/5 py-2" data-drop="${escapeHtml(node.key)}" data-drop-label="${escapeHtml(node.label)}" style="padding-left:${pad}px;padding-right:8px">
          <button type="button" data-toggle="${escapeHtml(node.key)}" class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-black/40 hover:bg-black/5">
            <span class="inline-flex transition-transform ${open ? "rotate-90" : ""}">${CHEV}</span>
          </button>
          ${FOLDER_ICON}
          <button type="button" data-toggle="${escapeHtml(node.key)}" class="min-w-0 flex-1 text-left">
            <span class="text-xs font-bold text-ink-900">${escapeHtml(node.label)}</span>${fileBadge}
          </button>
          <button type="button" data-up="${escapeHtml(node.key)}" class="inline-flex items-center gap-1 rounded-lg border border-black/10 bg-white px-2 py-1 text-[11px] font-semibold text-black/70 hover:bg-black/5">${UPLOAD_ICON} Upload</button>
        </div>
        <div class="${open ? "" : "hidden"}">
          ${fls.length ? `<div style="padding-left:${pad + 24}px">${fls.map(fileRow).join("")}</div>`
            : (!hasKids ? `<div class="text-[11px] text-black/35 py-1.5" style="padding-left:${pad + 24}px">No files yet.</div>` : "")}
          ${(node.children || []).map((c) => renderNode(c, depth + 1)).join("")}
        </div>
      </div>`;
  };

  const render = () => {
    container.innerHTML = `<div class="pb-2">${tree.map((n) => renderNode(n, 0)).join("")}</div>`;
  };

  const refetch = async () => {
    const d = await api(`/documents/project/${encodeURIComponent(qboId)}`);
    files = d.files || {};
    render();
  };

  // onclick (not addEventListener): the tab body element survives tab
  // switches, so a re-mount must replace — not stack — this handler
  // (stacked handlers made a toggle fire twice = folders never opened).
  container.onclick = async (e) => {
    const tog = e.target.closest("[data-toggle]");
    if (tog) {
      const k = tog.getAttribute("data-toggle");
      expanded.has(k) ? expanded.delete(k) : expanded.add(k);
      render();
      return;
    }
    const up = e.target.closest("[data-up]");
    if (up) {
      const folder = up.getAttribute("data-up");
      const input = document.createElement("input");
      input.type = "file";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const fd = new FormData();
        fd.append("file", file);
        up.disabled = true; up.textContent = "Uploading…";
        try {
          await api(`/documents/project/${encodeURIComponent(qboId)}?folder=${encodeURIComponent(folder)}`, { method: "POST", body: fd });
          expanded.add(folder);
          await refetch();
        } catch (err) { alert(`Upload failed: ${err.message}`); render(); }
      };
      input.click();
      return;
    }
    const dl = e.target.closest("[data-dl]");
    if (dl) {
      try {
        const res = await api(`/documents/file/${dl.getAttribute("data-dl")}/url`);
        if (res.url) window.open(res.url, "_blank");
      } catch (err) { alert(`Could not open file: ${err.message}`); }
      return;
    }
  };

  // Folder rows accept drag & drop (multi-file) — same POST as the Upload button.
  wireDocDropTargets(container, (folder) => (file) => {
    const fd = new FormData();
    fd.append("file", file);
    return api(`/documents/project/${encodeURIComponent(qboId)}?folder=${encodeURIComponent(folder)}`, { method: "POST", body: fd });
  }, async (folder) => { expanded.add(folder); await refetch(); });

  render();
}

// ── crew form submissions: review queue, detail modal, per-project settings ──
// (Phase 2 — backed by /api/forms/*; the crew fills these at #/field.)
const FORM_TITLES = {
  kickoff_update: "Kickoff Update",
  daily_update: "Daily Update",
  completion: "Completion",
  truck_unloading: "Truck Unloading",
  truck_loading: "Truck Loading",
  wire_guidance_trailer: "WG Trailer",
  gear_request: "Gear Request",
};
const CADENCE_LABEL = {
  one_time: "One-time",
  daily: "Daily",
  every_other_day: "Every other day",
  weekly: "Weekly",
  as_needed: "As needed",
};
const RECURRING = new Set(["daily", "every_other_day", "weekly"]);
// Weekday chip labels indexed by PYTHON weekday() numbers (0=Mon..6=Sun) —
// the same numbering exclude_weekdays uses on the backend.
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Cadence status chip (status engine, forms/status.py). Text labels always
// present — color is reinforcement only (overdue red, due amber, done green,
// not required gray).
function formStatusChip(f) {
  switch (f?.status) {
    case "overdue":      return `<span class="pm-chip pm-chip-flag">Overdue${f.overdue_days ? " " + f.overdue_days : ""}</span>`;
    case "due_today":    return `<span class="pm-chip pm-chip-review">Due today</span>`;
    case "due":          return `<span class="pm-chip pm-chip-review">Due</span>`;
    case "done_today":   return `<span class="pm-chip pm-chip-ok">Done today</span>`;
    case "done":         return `<span class="pm-chip pm-chip-ok">Done</span>`;
    case "not_required": return `<span class="pm-chip pm-chip-muted">Not required</span>`;
    case "pending":      return `<span class="pm-chip pm-chip-muted">Pending</span>`;
    case "upcoming":     return `<span class="pm-chip pm-chip-muted">Upcoming</span>`;
    case "as_needed":    return `<span class="pm-chip pm-chip-muted">As needed</span>`;
    default:             return "";
  }
}

// Mini progress bar "filled of expected" for recurring forms (C2 item 3).
function formProgressHtml(f) {
  if (f?.expected_so_far == null || f.expected_so_far <= 0) return "";
  const pct = Math.min(100, (Number(f.filled || 0) / f.expected_so_far) * 100);
  return `<span class="pm-progress" title="${f.filled} of ${f.expected_so_far} expected days covered">
    <span class="pm-minibar"><i style="width:${pct.toFixed(1)}%"></i></span>
    <span class="text-[10px] font-bold text-black/55 tabular-nums">${f.filled} of ${f.expected_so_far}</span>
  </span>`;
}

const fmtWhen = (v) => {
  if (!v) return "";
  const d = new Date(String(v).replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 16) : d.toLocaleString();
};
const crewLabelOf = (ctx) => {
  if (!ctx) return "—";
  if (ctx.kind === "user") {
    const who = ctx.user || ctx.email || "office user";
    // Crew Portal step 3: a user-token submission is recorded ON BEHALF of the
    // project's crew (PM view / office).
    return ctx.on_behalf ? `${who} · on behalf of ${ctx.crew || "crew"}` : who;
  }
  const bits = [ctx.label, ctx.crew_name].filter(Boolean);
  return bits.join(" · ") || "crew";
};
const flagChip = `<span class="pm-flagchip">⚑ red flag</span>`;

function submissionRowHtml(s, { showStatus = false } = {}) {
  const statusBit = !showStatus ? "" : (s.status === "reviewed"
    ? `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-emerald-100 text-emerald-800">Reviewed</span>`
    : `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-800">Needs review</span>`);
  return `
    <button type="button" data-sub="${s.id}" class="pm-card w-full text-left">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-sm font-bold text-ink-900">${escapeHtml(FORM_TITLES[s.form_code] || s.form_code)}</span>
          ${s.red_flag ? flagChip : ""}
          ${statusBit}
        </div>
        <div class="text-[11px] text-black/50 truncate">${escapeHtml(s.project_name || ("Project #" + s.project_qbo_id))}</div>
        <div class="text-[11px] text-black/45 mt-0.5">${escapeHtml(crewLabelOf(s.crew_context))} · ${escapeHtml(fmtWhen(s.submitted_at))}${s.report_date && s.report_date !== String(s.submitted_at || "").slice(0, 10) ? ` · <span class="font-bold">for ${escapeHtml(fmtDate(s.report_date))}</span>` : ""}</div>
      </div>
      <span class="text-black/25 text-lg shrink-0">›</span>
    </button>`;
}

async function mountFormsQueue(host, showAll, onItems) {
  if (!host) return;
  host.innerHTML = `<div class="card p-4 text-sm text-black/40">Loading form submissions…</div>`;
  let q;
  try { q = await api(`/forms/queue${showAll ? "?all=1" : ""}`); }
  catch (e) {
    host.innerHTML = `<div class="card p-4 text-sm text-red-700">Failed to load form submissions: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }
  const items = q.items || [];
  if (onItems) { try { onItems(items); } catch (_) {} }
  const counts = q.counts || { unreviewed: items.length, red_flags: 0 };
  const LIMIT = 12;
  let expanded = false;

  const render = () => {
    const shown = expanded ? items : items.slice(0, LIMIT);
    host.innerHTML = `
      <div class="flex items-center gap-2 mb-2 flex-wrap">
        <div class="text-sm font-extrabold text-white">Form submissions${q.scope === "all" ? " (all projects)" : ""}</div>
        <span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-800">${counts.unreviewed} to review</span>
        ${counts.red_flags ? `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-red-100 text-red-800">⚑ ${counts.red_flags} red flag${counts.red_flags === 1 ? "" : "s"}</span>` : ""}
      </div>
      ${items.length
        ? `<div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">${shown.map((s) => submissionRowHtml(s)).join("")}</div>`
        : `<div class="rounded-xl border border-dashed border-white/20 px-4 py-4 text-center text-xs text-white/50">No unreviewed submissions. Crews submit from their #/field link.</div>`}
      ${items.length > LIMIT && !expanded ? `<button type="button" id="pmQueueMore" class="pm-btn mt-2">Show all ${items.length}</button>` : ""}`;
    host.querySelectorAll("[data-sub]").forEach((b) => b.addEventListener("click", () =>
      openSubmissionModal(b.getAttribute("data-sub"), () => mountFormsQueue(host, showAll, onItems))));
    host.querySelector("#pmQueueMore")?.addEventListener("click", () => { expanded = true; render(); });
  };
  render();
}

// Detail modal: answers grouped by the template's sections, media as open-able
// document links, "Mark reviewed" for unreviewed submissions.
async function openSubmissionModal(subId, onChange) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4";
  overlay.innerHTML = `<div class="pm-modal-card"><div class="pm-modal-body"><div class="text-sm text-black/40 py-4">Loading submission…</div></div></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  let sub, tpl = null;
  try {
    sub = await api(`/forms/submissions/${subId}`);
    try {
      const t = await api(`/forms/templates?project_qbo_id=${encodeURIComponent(sub.project_qbo_id)}`);
      tpl = (t.templates || []).find((x) => x.code === sub.form_code) || null;
    } catch (_) { /* template merge is best-effort; raw answers still render */ }
  } catch (e) {
    overlay.querySelector(".pm-modal-body").innerHTML =
      `<div class="text-sm text-red-700 py-4">Failed to load submission: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }

  const answers = sub.answers || {};
  const used = new Set();
  const looksLikeDocs = (v) => Array.isArray(v) && v.length > 0 &&
    v.every((x) => (x && typeof x === "object" && x.document_id != null) || typeof x === "number");
  const docChips = (v) => v.map((x) => {
    const id = typeof x === "number" ? x : x.document_id;
    const name = typeof x === "object" && x.filename ? x.filename : `file #${id}`;
    return `<button type="button" data-doc="${id}" class="inline-flex items-center gap-1 rounded-lg border border-black/10 bg-white px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 mr-1 mb-1">📎 ${escapeHtml(name)}</button>`;
  }).join("");
  const valueHtml = (q, v) => {
    if (looksLikeDocs(v)) return `<div class="mt-0.5">${docChips(v)}</div>`;
    const sv = String(v ?? "");
    if (q && q.type === "yes_no") {
      const flagged = q.red_flag_on && sv.trim().toLowerCase() === q.red_flag_on;
      return `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${flagged ? "bg-red-100 text-red-800" : "bg-black/10 text-black/50"}">${escapeHtml(sv.toUpperCase())}</span>`;
    }
    return `<div class="text-xs text-ink-900 whitespace-pre-wrap">${escapeHtml(sv)}</div>`;
  };
  const answerRow = (q, v, depth) => `
    <div class="py-1.5 border-b border-black/5" style="padding-left:${depth * 14}px">
      <div class="text-[11px] font-semibold text-black/55">${escapeHtml(q.label || q.key)}${q.custom ? ` <span class="text-[9px] font-bold uppercase text-violet-700">custom</span>` : ""}</div>
      ${valueHtml(q, v)}
    </div>`;

  let grouped = "";
  for (const sec of tpl?.definition?.sections || []) {
    let secRows = "";
    const walk = (qs, depth) => {
      for (const q of qs || []) {
        if (q.key in answers) { secRows += answerRow(q, answers[q.key], depth); used.add(q.key); }
        if (q.branches) { walk(q.branches.yes, depth + 1); walk(q.branches.no, depth + 1); }
      }
    };
    walk(sec.questions, 0);
    if (secRows) grouped += `<div class="mt-3"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">${escapeHtml(sec.title)}</div>${secRows}</div>`;
  }
  const leftovers = Object.keys(answers).filter((k) => !used.has(k));
  if (leftovers.length) {
    grouped += `<div class="mt-3"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Other answers</div>
      ${leftovers.map((k) => answerRow({ key: k, label: k }, answers[k], 0)).join("")}</div>`;
  }
  if (!grouped) grouped = `<div class="text-xs text-black/40 py-3">No answers recorded.</div>`;

  const flagBanner = sub.red_flag ? `
    <div class="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2">
      <div class="text-xs font-bold text-red-700">⚑ Red flag</div>
      ${sub.red_flag_reason ? `<div class="text-[11px] text-red-700 mt-0.5">${escapeHtml(sub.red_flag_reason)}</div>` : ""}
    </div>` : "";

  const reviewedBit = sub.status === "reviewed"
    ? `<span class="text-[11px] text-black/45">Reviewed${sub.reviewed_by ? " by " + escapeHtml(sub.reviewed_by) : ""}${sub.reviewed_at ? " · " + escapeHtml(fmtWhen(sub.reviewed_at)) : ""}</span>`
    : `<button type="button" id="pmMarkReviewed" class="btn-primary text-xs px-3 py-1.5">Mark reviewed</button>`;

  overlay.querySelector(".pm-modal-card").innerHTML = `
    <div class="shrink-0 px-5 pt-4 pb-3 border-b border-black/10 flex items-start gap-3">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-base font-extrabold text-ink-900">${escapeHtml(FORM_TITLES[sub.form_code] || sub.form_code)}</span>
          ${sub.red_flag ? flagChip : ""}
        </div>
        <div class="text-xs text-black/50 truncate">${escapeHtml(sub.project_name || ("Project #" + sub.project_qbo_id))}</div>
        <div class="text-[11px] text-black/45 mt-0.5">${escapeHtml(crewLabelOf(sub.crew_context))} · ${escapeHtml(fmtWhen(sub.submitted_at))}</div>
      </div>
      <button type="button" id="pmSubClose" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5 shrink-0">Close</button>
    </div>
    <div class="pm-modal-body">
      ${flagBanner}
      ${grouped}
      <div class="mt-4 flex items-center justify-end gap-2">${reviewedBit}</div>
      <div id="pmSubMsg" class="text-xs text-red-700 min-h-[1rem] text-right"></div>
    </div>`;

  overlay.querySelector("#pmSubClose").addEventListener("click", close);
  overlay.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", async () => {
    try {
      const res = await api(`/documents/file/${b.getAttribute("data-doc")}/url`);
      if (res.url) window.open(res.url, "_blank");
    } catch (err) { alert(`Could not open file: ${err.message}`); }
  }));
  overlay.querySelector("#pmMarkReviewed")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      await api(`/forms/submissions/${sub.id}/review`, { method: "PATCH" });
      close();
      if (onChange) onChange();
    } catch (err) {
      e.target.disabled = false;
      overlay.querySelector("#pmSubMsg").textContent = `Failed: ${err.message || err}`;
    }
  });
}

// Project detail → Forms tab (Design v3 Milestone C2): ONE unified list —
// per form: required switch · cadence select (incl. As needed) · day
// exclusions (weekday chips + skipped-day editor, recurring cadences only) ·
// status chip + progress · Preview / Edit (the form editor modal). Below it:
// this project's submissions GROUPED BY FORM (collapsible, newest first).
async function mountPmFormsTab(container, qboId) {
  container.innerHTML = `<div class="p-4 text-sm text-black/40">Loading forms…</div>`;
  let subs = [], settings = null, statusRows = [], loadErr = null;
  try {
    const [sRes, cfg, st] = await Promise.all([
      api(`/forms/submissions?project_qbo_id=${encodeURIComponent(qboId)}`),
      api(`/forms/project-settings/${encodeURIComponent(qboId)}`),
      api(`/forms/status?project_qbo_id=${encodeURIComponent(qboId)}`),
    ]);
    subs = sRes.submissions || [];
    settings = cfg;
    statusRows = st.forms || [];
  } catch (e) { loadErr = e; }
  if (loadErr) {
    container.innerHTML = `<div class="p-4 text-sm text-red-700">Failed to load forms: ${escapeHtml(loadErr?.message || String(loadErr))}</div>`;
    return;
  }

  let forms = settings.forms || {};   // complete map incl. day-exclusion fields
  const expandedGroups = new Set();   // collapsible submission groups

  const formRow = (f) => {
    const cfg = forms[f.form_code] || f;
    const required = cfg.required !== false;
    const recurring = required && RECURRING.has(cfg.cadence);
    const excl = cfg.exclude_weekdays || [];
    const skips = cfg.skipped_dates || [];
    const statusBit = f.status === "as_needed"
      ? `<span class="pm-chip pm-chip-muted">As needed · ${f.submissions_count} submitted</span>`
      : formStatusChip(f);
    const dayControls = !recurring ? "" : `
      <div class="mt-2 flex items-center gap-x-3 gap-y-2 flex-wrap">
        <span class="flex items-center gap-1.5">
          <span class="text-[10px] font-bold uppercase tracking-wide text-black/40">Days</span>
          <span class="pm-wd">${WEEKDAYS.map((lbl, i) =>
            `<button type="button" data-wd="${escapeHtml(f.form_code)}:${i}" class="${excl.includes(i) ? "off" : ""}" title="${lbl}${excl.includes(i) ? " — excluded (never expected)" : " — expected"}" aria-pressed="${excl.includes(i) ? "false" : "true"}">${lbl[0]}</button>`).join("")}</span>
          <span class="text-[10px] text-black/40">tap to exclude</span>
        </span>
        <span class="flex items-center gap-1.5 flex-wrap">
          <span class="text-[10px] font-bold uppercase tracking-wide text-black/40">Skipped days</span>
          ${skips.map((d) => `<span class="pm-skip">${escapeHtml(fmtDate(d))}<button type="button" data-rmskip="${escapeHtml(f.form_code)}:${escapeHtml(d)}" title="Un-skip ${escapeHtml(d)}">✕</button></span>`).join("")}
          <input type="date" data-skipdate="${escapeHtml(f.form_code)}" class="pm-filter" style="font-size:11px;padding:3px 6px" aria-label="Day to skip" />
          <button type="button" data-addskip="${escapeHtml(f.form_code)}" class="pm-btn" style="font-size:11px;padding:4px 9px">Skip</button>
        </span>
      </div>`;
    return `
      <div class="px-3 py-2.5">
        <div class="flex items-center gap-2 flex-wrap mb-1.5">
          <span class="text-xs font-bold text-ink-900">${escapeHtml(FORM_TITLES[f.form_code] || f.title || f.form_code)}</span>
          ${statusBit}
          ${formProgressHtml(f)}
          ${f.red_flags ? `<span class="pm-chip pm-chip-flag">⚑ ${f.red_flags}</span>` : ""}
          ${f.needs_review_count ? `<span class="pm-chip pm-chip-review">${f.needs_review_count} to review</span>` : ""}
        </div>
        <div class="flex items-center gap-3 flex-wrap">
          <span class="flex items-center gap-2">
            <button type="button" class="pm-switch ${required ? "on" : ""}" data-req="${escapeHtml(f.form_code)}" role="switch" aria-checked="${required ? "true" : "false"}" aria-label="Required for this project"></button>
            <span class="text-[11px] font-semibold text-black/55">Required</span>
          </span>
          <select data-cad="${escapeHtml(f.form_code)}" class="pm-filter" style="font-size:12px" ${required ? "" : "disabled"} aria-label="Cadence">
            ${Object.entries(CADENCE_LABEL).map(([v, l]) =>
              `<option value="${v}" ${cfg.cadence === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
          <button type="button" data-editform="${escapeHtml(f.form_code)}" class="rounded-lg border border-black/15 px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-50">Preview / Edit</button>
        </div>
        ${dayControls}
      </div>`;
  };

  const submissionGroups = () => {
    const by = new Map();
    for (const s of subs) {
      if (!by.has(s.form_code)) by.set(s.form_code, []);
      by.get(s.form_code).push(s);   // API order = newest first
    }
    // Groups ordered by their newest submission, newest first.
    const groups = [...by.entries()].sort((a, b) =>
      String(b[1][0]?.submitted_at || "").localeCompare(String(a[1][0]?.submitted_at || "")));
    return groups.map(([code, list]) => {
      const open = expandedGroups.has(code);
      const unrev = list.filter((s) => s.status !== "reviewed").length;
      const flags = list.filter((s) => s.red_flag).length;
      return `
        <div>
          <button type="button" class="pm-group-head" data-group="${escapeHtml(code)}" aria-expanded="${open ? "true" : "false"}">
            <span class="inline-flex transition-transform text-black/40 ${open ? "rotate-90" : ""}">${CHEV}</span>
            <span class="text-xs font-bold text-ink-900">${escapeHtml(FORM_TITLES[code] || code)}</span>
            <span class="text-[11px] font-semibold text-black/45 tabular-nums">${list.length}</span>
            <span class="flex items-center gap-1 ml-auto">
              ${flags ? `<span class="pm-chip pm-chip-flag">⚑ ${flags}</span>` : ""}
              ${unrev ? `<span class="pm-chip pm-chip-review">${unrev} to review</span>` : ""}
            </span>
          </button>
          ${open ? `<div class="grid grid-cols-1 gap-2 mt-2 mb-1">${list.map((s) => submissionRowHtml(s, { showStatus: true })).join("")}</div>` : ""}
        </div>`;
    }).join("");
  };

  const render = () => {
    container.innerHTML = `
      <div class="p-4 sm:p-5">
        <div class="text-sm font-extrabold text-ink-900 mb-1">Forms</div>
        <div class="text-[11px] text-black/45 mb-2">Which forms this project's crew must submit, how often, and on which days. Preview / Edit shows the form as the crew sees it and lets you remove standard questions, add project questions, and toggle the Daily Update sections. Changes apply the next time a crew opens a form.</div>
        <div class="rounded-xl border border-black/10 divide-y divide-black/5 mb-2">
          ${statusRows.map(formRow).join("")}
        </div>
        <div id="pmFormsMsg" class="text-xs min-h-[1rem]"></div>

        <div class="text-sm font-extrabold text-ink-900 mt-4 mb-2">Submissions</div>
        ${subs.length
          ? `<div class="grid grid-cols-1 gap-2">${submissionGroups()}</div>`
          : `<div class="rounded-xl border border-dashed border-black/15 px-4 py-4 text-center text-xs text-black/40">No form submissions for this project yet. Crews submit from their #/field link.</div>`}
      </div>`;
    bind();
  };

  const msg = (text, ok) => {
    const el = container.querySelector("#pmFormsMsg");
    if (!el) return;
    el.textContent = text;
    el.className = `text-xs min-h-[1rem] ${ok ? "text-emerald-700" : "text-red-700"}`;
    if (ok) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 2000);
  };

  const refreshStatus = async () => {
    try {
      const st = await api(`/forms/status?project_qbo_id=${encodeURIComponent(qboId)}`);
      statusRows = st.forms || statusRows;
    } catch (_) { /* chips refresh is best-effort */ }
  };

  const save = async (body, okText) => {
    try {
      const res = await api(`/forms/project-settings/${encodeURIComponent(qboId)}`, {
        method: "PUT", body: JSON.stringify(body),
      });
      forms = res.forms || forms;
      await refreshStatus();     // settings changes move the chips + progress
      render();
      msg(okText, true);
    } catch (e) {
      render();
      msg(`Save failed: ${e.message || e}`, false);
    }
  };

  function bind() {
    container.querySelectorAll("[data-sub]").forEach((b) => b.addEventListener("click", () =>
      openSubmissionModal(b.getAttribute("data-sub"), () => mountPmFormsTab(container, qboId))));
    container.querySelectorAll("[data-group]").forEach((b) => b.addEventListener("click", () => {
      const code = b.getAttribute("data-group");
      expandedGroups.has(code) ? expandedGroups.delete(code) : expandedGroups.add(code);
      render();
    }));
    container.querySelectorAll("[data-req]").forEach((b) => b.addEventListener("click", () => {
      const code = b.getAttribute("data-req");
      const cur = forms[code] || {};
      save({ forms: { [code]: { required: cur.required === false } } },
           cur.required !== false ? "Form marked not required." : "Form marked required.");
    }));
    container.querySelectorAll("[data-cad]").forEach((sel) => sel.addEventListener("change", () => {
      save({ forms: { [sel.getAttribute("data-cad")]: { cadence: sel.value } } }, "Cadence saved.");
    }));
    container.querySelectorAll("[data-wd]").forEach((b) => b.addEventListener("click", () => {
      const [code, iStr] = b.getAttribute("data-wd").split(":");
      const i = Number(iStr);
      const cur = (forms[code]?.exclude_weekdays || []).slice();
      const next = cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort();
      save({ forms: { [code]: { exclude_weekdays: next } } },
           cur.includes(i) ? `${WEEKDAYS[i]} expected again.` : `${WEEKDAYS[i]}s excluded.`);
    }));
    container.querySelectorAll("[data-addskip]").forEach((b) => b.addEventListener("click", () => {
      const code = b.getAttribute("data-addskip");
      const inp = container.querySelector(`[data-skipdate="${CSS.escape(code)}"]`);
      const v = (inp?.value || "").trim();
      if (!v) { msg("Pick the day to skip first.", false); return; }
      const cur = forms[code]?.skipped_dates || [];
      if (cur.includes(v)) { msg("That day is already skipped.", false); return; }
      save({ forms: { [code]: { skipped_dates: [...cur, v] } } }, `Skipped ${v}.`);
    }));
    container.querySelectorAll("[data-rmskip]").forEach((b) => b.addEventListener("click", () => {
      const attr = b.getAttribute("data-rmskip");
      const idx = attr.indexOf(":");
      const code = attr.slice(0, idx), d = attr.slice(idx + 1);
      const cur = forms[code]?.skipped_dates || [];
      save({ forms: { [code]: { skipped_dates: cur.filter((x) => x !== d) } } }, `Un-skipped ${d}.`);
    }));
    container.querySelectorAll("[data-editform]").forEach((b) => b.addEventListener("click", () =>
      openFormEditor(qboId, b.getAttribute("data-editform"), () => mountPmFormsTab(container, qboId))));
  }

  render();
}

// FORM EDITOR modal (C2 item 5, replaces the preview-only modal): the SAME
// shared renderer the crew page uses (utils/form-render.js) in editor mode —
// every standard question gets a remove ✕ (struck-through + Restore, staged
// into removed_questions), "+ Add question" at each section's end (staged
// into custom_questions with that section's key), and the JHA/Anchoring/WG
// switches INLINE at their Daily Update section headers. Red-flag questions
// show ⚑ with the remove disabled. Save = ONE PUT; the caller re-fetches.
async function openFormEditor(qboId, formCode, onSaved) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4";
  overlay.innerHTML = `<div class="pm-modal-card"><div class="pm-modal-body"><div class="text-sm text-black/40 py-4">Loading form…</div></div></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  let rawTpl = null, settings = null;
  try {
    const [t, cfg] = await Promise.all([
      api(`/forms/templates`),   // RAW templates: no removals, no custom Qs
      api(`/forms/project-settings/${encodeURIComponent(qboId)}`),
    ]);
    rawTpl = (t.templates || []).find((x) => x.code === formCode) || null;
    settings = cfg;
    if (!rawTpl) throw new Error("Form not found");
  } catch (e) {
    overlay.querySelector(".pm-modal-body").innerHTML =
      `<div class="text-sm text-red-700 py-4">Failed to load form: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }

  // Staged state — nothing saves until "Save changes" (one PUT).
  const toggles = { ...(settings.toggles || {}) };
  const customAll = (settings.custom_questions || []).map((c) => ({ ...c }));
  const removed = new Set(settings.forms?.[formCode]?.removed_questions || []);
  const answers = {};              // persists Yes/No branch exploration
  let customKeyToIdx = {};

  // Mirror of the server merge (_merged_templates): clone the raw definition,
  // stamp section enabled from the STAGED toggles, append the STAGED custom
  // questions (global custom_N numbering, section_key placement).
  const buildTpl = () => {
    const def = JSON.parse(JSON.stringify(rawTpl.definition || { sections: [] }));
    customKeyToIdx = {};
    customAll.forEach((entry, idx) => {
      if (entry.form_code !== formCode) return;
      let q = entry.question;
      q = typeof q === "string" ? { label: q, type: "text" } : { ...(q || {}) };
      q.type = q.type || "text";
      q.key = q.key || `custom_${idx + 1}`;
      q.custom = true;
      customKeyToIdx[q.key] = idx;
      const secs = def.sections || [];
      if (!secs.length) return;
      const target = secs.find((s) => s.key === entry.section_key) || secs[secs.length - 1];
      (target.questions = target.questions || []).push(q);
    });
    for (const sec of def.sections || []) {
      const tg = sec.toggle || "always";
      sec.enabled = tg === "always" ? true : !!toggles[tg];
    }
    return { ...rawTpl, definition: def };
  };

  overlay.querySelector(".pm-modal-card").innerHTML = `
    <div class="shrink-0 px-5 pt-4 pb-3 border-b border-black/10 flex items-start gap-3">
      <div class="min-w-0 flex-1">
        <div class="text-base font-extrabold text-ink-900">${escapeHtml(rawTpl.title)}</div>
        <div class="text-[11px] text-black/45 mt-0.5">This is what the crew sees at #/field. Remove standard questions (✕), add project questions at a section's end, and flip section toggles inline. ⚑ questions raise red flags and can't be removed. Nothing saves until you hit Save.</div>
      </div>
      <button type="button" id="pmEdClose" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5 shrink-0">Close</button>
    </div>
    <div class="pm-modal-body">
      <div class="ff-preview" id="pmEdBody"></div>
    </div>
    <div class="shrink-0 px-5 py-3 border-t border-black/10 flex items-center gap-2">
      <div id="pmEdMsg" class="text-xs text-red-700 min-w-0 flex-1"></div>
      <button type="button" id="pmEdCancel" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Cancel</button>
      <button type="button" id="pmEdSave" class="btn-primary text-xs px-3 py-2">Save changes</button>
    </div>`;

  const host = overlay.querySelector("#pmEdBody");
  const edMsg = (t) => { const el = overlay.querySelector("#pmEdMsg"); if (el) el.textContent = t; };

  const renderBody = () => {
    const renderer = createFormRenderer(buildTpl(), {
      editor: true, removedKeys: [...removed], answers,
    });
    host.innerHTML = renderer.html() || `<div class="ff-note">This form has no sections.</div>`;
    renderer.attach(host);
  };

  // One delegated handler — the renderer re-renders on every staged change.
  host.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rmq]");
    if (rm) { removed.add(rm.getAttribute("data-rmq")); renderBody(); return; }
    const rs = e.target.closest("[data-restoreq]");
    if (rs) { removed.delete(rs.getAttribute("data-restoreq")); renderBody(); return; }
    const rc = e.target.closest("[data-rmq-custom]");
    if (rc) {
      const idx = customKeyToIdx[rc.getAttribute("data-rmq-custom")];
      if (idx != null) { customAll.splice(idx, 1); renderBody(); }
      return;
    }
    const tg = e.target.closest("[data-sec-toggle]");
    if (tg) {
      const k = tg.getAttribute("data-sec-toggle");
      toggles[k] = !toggles[k]; renderBody(); return;
    }
    const add = e.target.closest("[data-addq]");
    if (add && !add.dataset.openEditor) {
      // Swap the affordance for an inline input + Add / Cancel.
      add.dataset.openEditor = "1";
      const secKey = add.getAttribute("data-addq");
      const wrap = document.createElement("div");
      wrap.className = "ff-addq-form";
      wrap.innerHTML = `
        <input type="text" class="ff-input" style="font-size:14px;padding:9px" placeholder="New question for this project (free text answer)…" />
        <button type="button" class="pm-btn" data-addq-ok="${escapeHtml(secKey)}">Add</button>
        <button type="button" class="pm-btn" data-addq-cancel>Cancel</button>`;
      add.replaceWith(wrap);
      wrap.querySelector("input").focus();
      return;
    }
    const ok = e.target.closest("[data-addq-ok]");
    if (ok) {
      const wrap = ok.closest(".ff-addq-form");
      const text = (wrap?.querySelector("input")?.value || "").trim();
      if (!text) { edMsg("Type the question first."); return; }
      customAll.push({ form_code: formCode, question: text,
                       section_key: ok.getAttribute("data-addq-ok") });
      edMsg(""); renderBody(); return;
    }
    if (e.target.closest("[data-addq-cancel]")) { renderBody(); return; }
  });

  overlay.querySelector("#pmEdClose").addEventListener("click", close);
  overlay.querySelector("#pmEdCancel").addEventListener("click", close);
  overlay.querySelector("#pmEdSave").addEventListener("click", async (e) => {
    e.target.disabled = true;
    edMsg("");
    try {
      await api(`/forms/project-settings/${encodeURIComponent(qboId)}`, {
        method: "PUT",
        body: JSON.stringify({
          toggles,
          custom_questions: customAll,
          forms: { [formCode]: { removed_questions: [...removed] } },
        }),
      });
      close();
      if (onSaved) onSaved();
    } catch (err) {
      e.target.disabled = false;
      edMsg(`Save failed: ${err.message || err}`);
    }
  });

  renderBody();
}

// ── Crew tab (Crew Portal step 3): the crew setup surface for this project ──
// Crew assignment block + per-crew passcode control (the same /crew-auth
// endpoints Teams uses — now also open to page.pm_portal, scoped server-side
// to the PM's own projects' crews) + copy-invite + "Open crew view" (pmview).
async function mountPmCrewTab(container, qboId) {
  container.innerHTML = `<div class="p-4 text-sm text-black/40">Loading crew setup…</div>`;
  let ov = null, pcs = null, pcErr = null;
  try {
    [ov, pcs] = await Promise.all([
      api(`/pm/project/${encodeURIComponent(qboId)}/overview`),
      api(`/crew-auth/passcodes`).catch((e) => { pcErr = e; return null; }),
    ]);
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-sm text-red-700">Failed to load crew setup: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }

  const proj = ov.project || {};
  const a = ov.assignment || {};
  const crews = a.crews || [];
  const passcodes = (pcs && pcs.passcodes) || [];
  const activeLeadCode = (crewId) =>
    passcodes.find((p) => p.active && p.role === "lead" && String(p.crew_id) === String(crewId)) || null;

  // Invite text is built CLIENT-SIDE and NEVER contains the code — the PM
  // texts it themselves and reads the code aloud separately.
  const fieldLink = `${location.origin}${location.pathname}#/field?p=${encodeURIComponent(qboId)}`;
  const inviteText = [
    `OPI field forms — ${proj.name || "your project"}`,
    `Dates: ${fmtDate(a.start_date) || "TBD"} → ${fmtDate(a.end_date) || "TBD"}`,
    `Open your project here: ${fieldLink}`,
    `Your passcode: (your PM will give it to you)`,
  ].join("\n");

  const crewRow = (c) => {
    const code = activeLeadCode(c.id);
    const codeBit = code
      ? `<div class="text-[11px] text-black/55">
           <span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-emerald-100 text-emerald-800">Active code</span>
           <span class="font-semibold">${escapeHtml(code.label || "")}</span>
           ${code.last_used_at ? ` · last used ${escapeHtml(fmtWhen(code.last_used_at))}` : " · never used yet"}
         </div>`
      : `<div class="text-[11px] text-black/45">
           <span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-800">No active code</span>
           This crew can't sign in until a code is set.
         </div>`;
    return `
      <div class="px-3 py-2.5">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-xs font-bold text-ink-900">${escapeHtml(c.name || "Crew")}</span>
          ${c.is_primary ? `<span class="pm-chip pm-chip-lane-pm">primary</span>` : ""}
          ${c.assigned_at ? `<span class="text-[11px] text-black/45">assigned ${escapeHtml(fmtDate(c.assigned_at))}</span>` : ""}
        </div>
        <div class="mt-1">${codeBit}</div>
        <div class="mt-2 flex items-center gap-2 flex-wrap">
          <button type="button" class="pm-btn" data-pc-set="${c.id}" data-pc-name="${escapeHtml(c.name || "")}"
                  data-pc-label="${escapeHtml(code?.label || "")}">${code ? "Rotate code" : "Set code"}</button>
          ${code ? `<button type="button" class="pm-btn" style="color:#b91c1c" data-pc-deact="${code.id}" data-pc-name="${escapeHtml(c.name || "")}">Deactivate</button>` : ""}
        </div>
      </div>`;
  };

  container.innerHTML = `
    <div class="p-4 sm:p-5">
      <div class="text-sm font-extrabold text-ink-900 mb-2">Crew assignment</div>
      ${crews.length
        ? `<div class="pm-ov-grid">${crews.map((c) => `
            <div class="pm-ov-row">
              <div class="pm-ov-label">Work crew</div>
              <div class="pm-ov-value">${escapeHtml(c.name || "—")}${c.is_primary ? ` <span class="text-[10px] font-bold text-blue-700">primary</span>` : ""}${c.assigned_at ? ` <span class="text-black/40">· assigned ${escapeHtml(fmtDate(c.assigned_at))}</span>` : ""}</div>
            </div>`).join("")}
           </div>`
        : `<div class="rounded-xl border border-dashed border-black/15 px-4 py-4 text-center text-xs text-black/40">No crew assigned yet — the office assigns crews on the Assignment page.</div>`}

      <div class="text-sm font-extrabold text-ink-900 mt-5 mb-1">Field passcodes</div>
      <div class="text-[11px] text-black/45 mb-2">One 4-6 digit code per crew opens #/field on their phones. The code is typed once and can never be shown again — read it aloud to the lead. Setting a new code rotates (kills) the old one everywhere.</div>
      ${pcErr
        ? `<div class="text-xs text-red-700 mb-2">Couldn't load passcodes: ${escapeHtml(pcErr.message || String(pcErr))}</div>`
        : crews.length
          ? `<div class="rounded-xl border border-black/10 divide-y divide-black/5 mb-2">${crews.map(crewRow).join("")}</div>`
          : `<div class="text-[11px] text-black/40 mb-2">Passcodes appear here once a crew is assigned.</div>`}
      <div id="pmCrewMsg" class="text-xs min-h-[1rem]"></div>

      <div class="text-sm font-extrabold text-ink-900 mt-4 mb-1">Invite the crew</div>
      <div class="text-[11px] text-black/45 mb-2">Copies the project link + dates to paste into a text. The passcode is NEVER in the invite — give it by voice.</div>
      <div class="rounded-xl border border-black/10 bg-white px-3 py-2 mb-2">
        <div class="text-[11px] text-black/60 whitespace-pre-wrap" id="pmInvitePreview">${escapeHtml(inviteText)}</div>
      </div>
      <div class="flex items-center gap-2 flex-wrap">
        <button type="button" id="pmCopyInvite" class="btn-primary text-xs px-3 py-2">Copy invite text</button>
        <button type="button" id="pmOpenCrewView" class="pm-btn">Open crew view →</button>
      </div>
      <div class="text-[11px] text-black/45 mt-2">"Open crew view" shows this project exactly as the crew sees it (your login, no passcode). Anything you submit there is recorded under your name on behalf of the crew.</div>
    </div>`;

  const msg = (t, ok) => {
    const el = container.querySelector("#pmCrewMsg");
    if (!el) return;
    el.textContent = t;
    el.className = `text-xs min-h-[1rem] ${ok ? "text-emerald-700" : "text-red-700"}`;
  };

  container.querySelectorAll("[data-pc-set]").forEach((b) => b.addEventListener("click", async () => {
    const crewId = Number(b.getAttribute("data-pc-set"));
    const crewName = b.getAttribute("data-pc-name") || "";
    const label = prompt("Name for this code (who carries it — the crew lead)?",
                         b.getAttribute("data-pc-label") || crewName);
    if (label === null) return;
    const lbl = label.trim();
    if (!lbl) { msg("A name/label is required.", false); return; }
    const code = prompt(`New 4-6 digit code for ${lbl}:`);
    if (code === null) return;
    const c = code.trim();
    if (!/^\d{4,6}$/.test(c)) { msg("The code must be 4-6 digits.", false); return; }
    try {
      await api("/crew-auth/passcodes", {
        method: "POST",
        body: JSON.stringify({ crew_id: crewId, role: "lead", label: lbl, code: c }),
      });
      alert(`Code set for ${lbl}.\n\nRead it aloud to them now — it cannot be shown again later.\nThey sign in at ${location.origin}${location.pathname}#/field`);
      mountPmCrewTab(container, qboId);
    } catch (err) {
      let detail = err?.message || "Failed to set the code.";
      try { const o = JSON.parse(detail); if (o && o.detail) detail = o.detail; } catch (_) {}
      msg(`Failed to set the code: ${detail}`, false);
    }
  }));
  container.querySelectorAll("[data-pc-deact]").forEach((b) => b.addEventListener("click", async () => {
    const who = b.getAttribute("data-pc-name") || "this crew";
    if (!confirm(`Deactivate the field code for ${who}? Their signed-in phones stop working immediately.`)) return;
    try {
      await api(`/crew-auth/passcodes/${b.getAttribute("data-pc-deact")}/deactivate`, { method: "POST" });
      mountPmCrewTab(container, qboId);
    } catch (err) {
      let detail = err?.message || String(err);
      try { const o = JSON.parse(detail); if (o && o.detail) detail = o.detail; } catch (_) {}
      msg(`Failed to deactivate: ${detail}`, false);
    }
  }));
  container.querySelector("#pmCopyInvite")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    let ok = false;
    try { await navigator.clipboard.writeText(inviteText); ok = true; }
    catch (_) {
      // Fallback for older/no-permission browsers.
      try {
        const ta = document.createElement("textarea");
        ta.value = inviteText;
        ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch (_) { ok = false; }
    }
    if (ok) {
      const orig = btn.textContent;
      btn.textContent = "Copied ✓";
      setTimeout(() => { btn.textContent = orig; }, 2000);
    } else {
      msg("Couldn't copy — select the preview text above and copy it manually.", false);
    }
  });
  container.querySelector("#pmOpenCrewView")?.addEventListener("click", () => {
    location.hash = `#/field?p=${encodeURIComponent(qboId)}&pmview=1`;
  });
}

// ── Receipts tab (Crew Portal step 4): real-time spend + reconciliation ─────
// PM or crew uploads a receipt (photo/PDF into Documents "8 Receipts") with
// amount / category / vendor / date; charged-back ⚑ = needs a change order.
// Status flow uploaded → reconciled (PM) → allocated in QBO (office —
// "Mark allocated" only renders with page.financials).
const RECEIPT_CATS = [
  ["travel", "Travel"],
  ["materials", "Materials"],
  ["propane_fuel", "Propane / Fuel"],
  ["other", "Other"],
];
const RECEIPT_CAT_LABEL = Object.fromEntries(RECEIPT_CATS);
// Receipt category → the Overview expense-burndown category it overlays.
const RECEIPT_TO_EXPENSE_CAT = {
  travel: "Travel", materials: "Materials", propane_fuel: "Propane", other: "Other",
};
const RECEIPT_STATUS_CHIP = {
  uploaded:   `<span class="pm-chip pm-chip-review">Uploaded</span>`,
  reconciled: `<span class="pm-chip pm-chip-lane-pm">Reconciled</span>`,
  allocated:  `<span class="pm-chip pm-chip-ok">Allocated in QBO</span>`,
};
const CHARGEBACK_CHIP = `<span class="pm-chip pm-chip-flag" title="Should be charged back to the customer — needs a change order">⚑ charge back / CO</span>`;

async function mountPmReceiptsTab(container, qboId) {
  container.innerHTML = `<div class="p-4 text-sm text-black/40">Loading receipts…</div>`;
  let d;
  try { d = await api(`/receipts?project_qbo_id=${encodeURIComponent(qboId)}`); }
  catch (e) {
    container.innerHTML = `<div class="p-4 text-sm text-red-700">Failed to load receipts: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }
  const items = d.receipts || [];
  const totals = d.totals || { by_category: [], pending: 0, allocated: 0 };
  const canOffice = hasCapability("page.financials");

  const totalsStrip = `
    <div class="pm-rc-tot mb-3">
      ${(totals.by_category || []).filter((c) => c.pending || c.allocated).map((c) => `
        <div class="pm-rc-tot-card">
          <div class="text-[10px] font-bold uppercase tracking-wide text-black/40">${escapeHtml(RECEIPT_CAT_LABEL[c.category] || c.category)}</div>
          <div class="text-sm font-extrabold text-ink-900 tabular-nums">${fmtMoney(c.pending)} <span class="text-[10px] font-bold text-black/45">pending</span></div>
          <div class="text-[11px] text-black/55 tabular-nums">${fmtMoney(c.allocated)} allocated</div>
        </div>`).join("")}
      <div class="pm-rc-tot-card">
        <div class="text-[10px] font-bold uppercase tracking-wide text-black/40">All receipts</div>
        <div class="text-sm font-extrabold text-ink-900 tabular-nums">${fmtMoney(totals.pending)} <span class="text-[10px] font-bold text-black/45">pending</span></div>
        <div class="text-[11px] text-black/55 tabular-nums">${fmtMoney(totals.allocated)} allocated</div>
      </div>
    </div>`;

  const rcActions = (r) => {
    const btns = [];
    if (r.status === "uploaded")
      btns.push(`<button type="button" class="pm-btn" data-rc-status="${r.id}:reconciled">Mark reconciled</button>`);
    if (r.status === "reconciled") {
      if (canOffice) btns.push(`<button type="button" class="pm-btn" data-rc-status="${r.id}:allocated">Mark allocated</button>`);
      btns.push(`<button type="button" class="pm-btn" data-rc-status="${r.id}:uploaded" title="Undo — back to uploaded">Undo</button>`);
    }
    if (r.status === "allocated" && canOffice)
      btns.push(`<button type="button" class="pm-btn" data-rc-status="${r.id}:reconciled" title="Undo — back to reconciled">Undo</button>`);
    return btns.join("");
  };

  const rcRow = (r) => {
    const isImg = (r.content_type || "").startsWith("image/");
    const thumb = r.file_url
      ? (isImg
        ? `<img class="pm-rc-thumb" src="${escapeHtml(r.file_url)}" alt="" loading="lazy" />`
        : `<span class="pm-rc-thumb" style="display:inline-flex;align-items:center;justify-content:center;font-size:20px">📄</span>`)
      : `<span class="pm-rc-thumb" style="display:inline-flex;align-items:center;justify-content:center;font-size:20px">🧾</span>`;
    const sub = crewLabelOf(r.submitted_by);
    const stamp = r.status === "allocated" && r.allocated_by
      ? ` · allocated by ${escapeHtml(r.allocated_by)}`
      : r.status === "reconciled" && r.reconciled_by
        ? ` · reconciled by ${escapeHtml(r.reconciled_by)}`
        : "";
    return `
      <div class="pm-rc-row">
        ${r.file_url ? `<a href="${escapeHtml(r.file_url)}" target="_blank" rel="noopener" title="Open receipt file">${thumb}</a>` : thumb}
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-sm font-extrabold text-ink-900 tabular-nums">${r.amount != null ? fmtMoney(r.amount) : "no amount"}</span>
            <span class="text-xs font-bold text-black/60">${escapeHtml(RECEIPT_CAT_LABEL[r.category] || r.category)}</span>
            ${r.charged_back ? CHARGEBACK_CHIP : ""}
            ${RECEIPT_STATUS_CHIP[r.status] || ""}
          </div>
          <div class="text-[11px] text-black/50 truncate">${escapeHtml(r.vendor || "Vendor —")}${r.receipt_date ? ` · ${escapeHtml(fmtDate(r.receipt_date))}` : ""}${r.filename ? ` · ${escapeHtml(r.filename)}` : ""}</div>
          <div class="text-[11px] text-black/45">${escapeHtml(sub)}${stamp}</div>
          ${r.notes ? `<div class="text-[11px] text-black/55 mt-0.5 whitespace-pre-wrap">${escapeHtml(r.notes)}</div>` : ""}
        </div>
        <div class="flex flex-col items-end gap-1 shrink-0">${rcActions(r)}</div>
      </div>`;
  };

  container.innerHTML = `
    <div class="p-4 sm:p-5">
      <div class="flex items-center gap-2 flex-wrap mb-1">
        <div class="text-sm font-extrabold text-ink-900">Receipts</div>
        <button type="button" id="pmRcAdd" class="btn-primary text-xs px-3 py-1.5 ml-auto">＋ Add receipt</button>
      </div>
      <div class="text-[11px] text-black/45 mb-3">Crews add receipts from their #/field page; you can add your own here. Flow: uploaded → reconciled (you, against the card statement) → allocated in QBO (office). Pending = not yet allocated — it overlays the Overview burndown as an unofficial early signal.</div>
      ${totalsStrip}
      ${items.length
        ? `<div class="grid grid-cols-1 gap-2">${items.map(rcRow).join("")}</div>`
        : `<div class="rounded-xl border border-dashed border-black/15 px-4 py-5 text-center text-xs text-black/40">No receipts yet. Crews add them from their #/field page — or add one with the button above.</div>`}
      <div id="pmRcMsg" class="text-xs text-red-700 min-h-[1rem] mt-2"></div>
    </div>`;

  const msg = (t) => { const el = container.querySelector("#pmRcMsg"); if (el) el.textContent = t; };

  container.querySelectorAll("[data-rc-status]").forEach((b) => b.addEventListener("click", async () => {
    const [id, status] = b.getAttribute("data-rc-status").split(":");
    b.disabled = true;
    try {
      await api(`/receipts/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      mountPmReceiptsTab(container, qboId);
    } catch (err) {
      b.disabled = false;
      let detail = err?.message || String(err);
      try { const o = JSON.parse(detail); if (o && o.detail) detail = o.detail; } catch (_) {}
      msg(`Failed: ${detail}`);
    }
  }));
  container.querySelector("#pmRcAdd")?.addEventListener("click", () =>
    openPmReceiptModal(qboId, () => mountPmReceiptsTab(container, qboId)));
}

// "Add receipt" modal (PM's own upload — same fields as the crew flow).
function openPmReceiptModal(qboId, onSaved) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4";
  const _n = new Date();
  const todayIso = `${_n.getFullYear()}-${String(_n.getMonth() + 1).padStart(2, "0")}-${String(_n.getDate()).padStart(2, "0")}`;
  overlay.innerHTML = `
    <div class="pm-modal-card">
      <div class="shrink-0 px-5 pt-4 pb-3 border-b border-black/10 flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <div class="text-base font-extrabold text-ink-900">Add receipt</div>
          <div class="text-[11px] text-black/45 mt-0.5">The file lands in the project's "8 Receipts" documents folder; the details feed the reconciliation queue.</div>
        </div>
        <button type="button" id="pmRcClose" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5 shrink-0">Close</button>
      </div>
      <div class="pm-modal-body">
        <div class="mb-3">
          <div class="label mb-1">Receipt photo or PDF</div>
          <div class="pm-dropzone" id="pmRcDrop">
            <div class="text-[11px] text-black/55 mb-1.5">Drag &amp; drop the receipt here, or</div>
            <div class="flex gap-2 justify-center flex-wrap">
              <button type="button" class="pm-btn" id="pmRcCamBtn">📷 Take photo</button>
              <button type="button" class="pm-btn" id="pmRcPickBtn">📁 Choose file</button>
            </div>
            <input type="file" id="pmRcCam" accept="image/*" capture="environment" style="display:none" />
            <input type="file" id="pmRcFile" accept="image/*,application/pdf" style="display:none" />
            <div id="pmRcFileInfo" class="text-[11px] font-bold text-ink-900 mt-1.5"></div>
          </div>
        </div>
        <div class="mb-3">
          <div class="label mb-1">Amount ($)</div>
          <input type="number" id="pmRcAmount" class="input" inputmode="decimal" step="0.01" min="0" placeholder="0.00" />
        </div>
        <div class="mb-3">
          <div class="label mb-1">Category</div>
          <select id="pmRcCat" class="input">
            ${RECEIPT_CATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
          </select>
        </div>
        <div class="mb-3">
          <div class="label mb-1">Vendor</div>
          <input type="text" id="pmRcVendor" class="input" placeholder="Where it was bought" />
        </div>
        <div class="mb-3">
          <div class="label mb-1">Receipt date</div>
          <input type="date" id="pmRcDate" class="input" value="${todayIso}" />
        </div>
        <div class="mb-3">
          <div class="label mb-1">Should this be charged back to the customer?</div>
          <div class="text-[11px] text-black/45 mb-1.5">If yes, the PM is flagged for a change order.</div>
          <div class="flex gap-2">
            <button type="button" class="pm-btn" data-rc-cb="1">Yes</button>
            <button type="button" class="pm-btn" data-rc-cb="0">No</button>
          </div>
        </div>
        <div class="mb-3">
          <div class="label mb-1">Note (optional)</div>
          <textarea id="pmRcNote" class="input" rows="2" maxlength="500"></textarea>
        </div>
        <div id="pmRcModalMsg" class="text-xs text-red-700 min-h-[1rem]"></div>
        <div class="flex items-center justify-end gap-2 mt-2">
          <button type="button" id="pmRcSave" class="btn-primary text-xs px-4 py-2">Save receipt</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("#pmRcClose").addEventListener("click", close);

  // Receipt file: camera capture, file picker, or drag & drop — one slot.
  let pickedFile = null;
  const rcInfo = overlay.querySelector("#pmRcFileInfo");
  const rcMsgEl = () => overlay.querySelector("#pmRcModalMsg");
  const setPicked = (f) => {
    if (!f) return;
    const okType = (f.type || "").startsWith("image/") || f.type === "application/pdf";
    if (!okType) { rcMsgEl().textContent = `"${f.name}" isn't a photo or PDF — receipts must be an image or PDF file.`; return; }
    if (f.size > 100 * 1024 * 1024) { rcMsgEl().textContent = `"${f.name}" is over the 100 MB limit.`; return; }
    pickedFile = f;
    rcMsgEl().textContent = "";
    rcInfo.textContent = `${f.name} · ${(f.size / 1024 / 1024).toFixed(f.size > 1024 * 1024 ? 1 : 2)} MB`;
  };
  const camInput = overlay.querySelector("#pmRcCam");
  const fileInput = overlay.querySelector("#pmRcFile");
  overlay.querySelector("#pmRcCamBtn").addEventListener("click", () => camInput.click());
  overlay.querySelector("#pmRcPickBtn").addEventListener("click", () => fileInput.click());
  camInput.addEventListener("change", () => setPicked(camInput.files?.[0]));
  fileInput.addEventListener("change", () => setPicked(fileInput.files?.[0]));
  const drop = overlay.querySelector("#pmRcDrop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", (e) => { if (!drop.contains(e.relatedTarget)) drop.classList.remove("drag"); });
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    setPicked(e.dataTransfer?.files?.[0]);
  });

  let chargedBack = null;   // must be answered explicitly
  overlay.querySelectorAll("[data-rc-cb]").forEach((b) => b.addEventListener("click", () => {
    chargedBack = b.getAttribute("data-rc-cb") === "1";
    overlay.querySelectorAll("[data-rc-cb]").forEach((x) => {
      const on = x === b;
      x.style.background = on ? "#2563eb" : "";
      x.style.color = on ? "#fff" : "";
      x.style.borderColor = on ? "#2563eb" : "";
    });
  }));

  overlay.querySelector("#pmRcSave").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const em = overlay.querySelector("#pmRcModalMsg");
    em.textContent = "";
    const file = pickedFile;
    const amountRaw = overlay.querySelector("#pmRcAmount").value.trim();
    const amount = Number(amountRaw);
    const category = overlay.querySelector("#pmRcCat").value;
    if (!file) { em.textContent = "Add the receipt photo or PDF first (camera, file, or drag & drop)."; return; }
    if (!amountRaw || !(amount > 0)) { em.textContent = "Enter the receipt amount."; return; }
    if (chargedBack === null) { em.textContent = "Answer the charge-back question (Yes or No)."; return; }
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const fd = new FormData();
      fd.append("file", file);
      const up = await api(`/receipts/upload?project_qbo_id=${encodeURIComponent(qboId)}&category=${encodeURIComponent(category)}`,
                           { method: "POST", body: fd });
      await api(`/receipts`, {
        method: "POST",
        body: JSON.stringify({
          project_qbo_id: String(qboId),
          document_id: up.document_id,
          amount,
          category,
          vendor: overlay.querySelector("#pmRcVendor").value.trim() || null,
          receipt_date: overlay.querySelector("#pmRcDate").value || null,
          charged_back: chargedBack,
          notes: overlay.querySelector("#pmRcNote").value.trim() || null,
        }),
      });
      close();
      if (onSaved) onSaved();
    } catch (err) {
      btn.disabled = false; btn.textContent = "Save receipt";
      let detail = err?.message || String(err);
      try { const o = JSON.parse(detail); if (o && o.detail) detail = o.detail; } catch (_) {}
      em.textContent = `Save failed: ${detail}`;
    }
  });
}

// ── shell mount ──────────────────────────────────────────────────────────────
function mount(routeFn, bodyHtml) {
  setShell({
    title: "PM Portal",
    subtitle: "Your projects: kickoff, daily log & documents",
    bodyHtml,
    showLogout: true,
    routeFn,
  });
}
