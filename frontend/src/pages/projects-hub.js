// Projects hub — the operational system of record for every QuickBooks project.
// One row per project (status, team, schedule, value, profit) with a glanceable
// FLAGS column summarising what needs attention. Click a row to expand a detail
// panel (loaded lazily) whose cards echo the row's flags. Absorbs the old
// Projects dashboard + Assignment landing; Financials + Schedule remain focused
// deep-dive views inside a project.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

const dash = (s) => (s == null || s === "" ? "—" : s);
const money = (n) => (n == null || n === "" ? "—" : "$" + Math.round(Number(n)).toLocaleString());
const csvList = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function shortDate(s) {
  if (!s) return "—";
  const p = String(s).slice(0, 10).split("-");
  if (p.length !== 3) return String(s);
  return `${MONTHS[+p[1] - 1] || p[1]} ${+p[2]}, ${p[0]}`;
}
function rangeShort(a, b) {
  if (!a) return "—";
  const pa = String(a).slice(0, 10).split("-"), pb = String(b || "").slice(0, 10).split("-");
  const l = `${MONTHS[+pa[1] - 1] || pa[1]} ${+pa[2]}`;
  if (!b) return `${l}, ${pa[0]}`;
  const r = (pa[0] === pb[0] && pa[1] === pb[1]) ? `${+pb[2]}` : `${MONTHS[+pb[1] - 1] || pb[1]} ${+pb[2]}`;
  return `${l} – ${r}, ${pb[0]}`;
}

// Operational status → label + pill styling. Order drives the filter pills.
// Status = the project's final assignment-row status (set on the Assignment
// page). Order drives the filter pills.
const OP_STATUS = {
  needs_attention: { label: "Needs attention", cls: "bg-rose-100 text-rose-800" },
  pending:         { label: "Pending",         cls: "bg-amber-100 text-amber-800" },
  not_started:     { label: "Not started",     cls: "bg-slate-200 text-slate-700" },
  in_progress:     { label: "In progress",     cls: "bg-indigo-100 text-indigo-800" },
  completed:       { label: "Complete",        cls: "bg-emerald-100 text-emerald-800" },
  canceled:        { label: "Canceled",        cls: "bg-black/10 text-black/50" },
};
const statusBadge = (s) => {
  const m = OP_STATUS[s] || { label: s || "—", cls: "bg-black/10 text-black/50" };
  return `<span class="inline-flex items-center gap-1 text-[10.5px] font-bold rounded-full px-2 py-0.5 whitespace-nowrap ${m.cls}">${escapeHtml(m.label)}</span>`;
};

// Which project-workspace tab each detail card opens.
const CARD_TAB = {
  schedule: "assignment", team: "assignment", estimates: "changeorders", expenses: "billing",
  offer: "billing", financial: "financials", process: "kickoff", notes: "assignment", upcoming: "billing",
};

// Flag legend — icon + meaning, for the collapsible header legend.
const FLAG_LEGEND = [
  ["bad", "!", "Needs attention — nothing assigned"],
  ["warn", "◔", "Pending — partially set up"],
  ["warn", "✎", "Estimate(s) pending review"],
  ["warn", "◷", "Crew offer awaiting response / no crew sourced"],
  ["good", "✓", "Crew offer accepted"],
  ["bad", "$", "Margin negative or below plan"],
  ["warn", "▦", "No schedule dates set"],
  ["mut", "⑂", "Multiple separate date ranges"],
  ["mut", "☑", "Kick-off & process incomplete"],
];

// Flag severity → chip classes (row) and card left-accent (detail).
const FLAG_CLS = {
  bad:  "bg-rose-50 text-rose-700 border-rose-200",
  warn: "bg-amber-50 text-amber-700 border-amber-200",
  good: "bg-emerald-50 text-emerald-700 border-emerald-200",
  mut:  "bg-black/[0.03] text-black/45 border-black/10",
};
const ACCENT = { bad: "border-l-rose-400", warn: "border-l-amber-400", good: "border-l-emerald-400", mut: "border-l-slate-300" };

// Profit shown follows the project's stage:
//  • not started            → ESTIMATED profit (contract − estimated cost)
//  • in progress, on budget  → ESTIMATED profit
//  • in progress, over cost  → actual costs so far vs the full contract (the
//                              overrun reality: contract − actual cost)
//  • completed / canceled    → ACTUAL profit (invoiced − actual cost)
function profitInfo(fin, status) {
  if (!fin) return { pct: null };
  const contract = Number(fin.estimate_line_amt) || 0;   // header contract value
  const estCost = Number(fin.estimate_cost_amt) || 0;    // estimated cost (labor + expenses)
  const actCost = Number(fin.expense_line_amt) || 0;     // actual cost so far (incl. crew)
  const invoiced = Number(fin.invoice_line_amt) || 0;
  const estProfit = contract - estCost;
  const done = status === "completed" || status === "canceled";
  const started = status === "in_progress";
  let amount, base, kind;
  if (done) {
    amount = invoiced - actCost; base = invoiced || contract; kind = "actual";
  } else if (started && actCost > estCost + 0.5) {
    amount = contract - actCost; base = contract; kind = "actual";   // over the estimated cost
  } else {
    amount = estProfit; base = contract; kind = "estimated";
  }
  const pct = base > 0 ? (amount / base) * 100 : null;
  return { pct, amount, kind };
}

// Derive the collapsed-row flags from the merged data (basic + financials +
// attention). Each flag carries the detail card it points to.
function deriveFlags(p, fin, att) {
  const flags = [];
  const est = att && att.estimates, offer = att && att.offer;
  if (p.operational_status === "needs_attention")
    flags.push({ c: "bad", i: "!", card: "team", t: "Needs attention — assign PM, crew, and dates" });
  else if (p.operational_status === "pending")
    flags.push({ c: "warn", i: "◔", card: "team", t: "Pending — partially set up (crew and/or dates unknown)" });

  if (est && est.pending > 0)
    flags.push({ c: "warn", i: "✎", card: "estimates", t: `${est.pending} estimate${est.pending > 1 ? "s" : ""} pending review` });

  if (offer && offer.state === "sent")
    flags.push({ c: offer.age_days > 7 ? "bad" : "warn", i: "◷", card: "offer",
      t: `Crew offer sent${offer.age_days != null ? ` ${offer.age_days}d ago` : ""} — awaiting response` });
  else if (offer && offer.state === "accepted")
    flags.push({ c: "good", i: "✓", card: "offer",
      t: `Crew offer accepted${offer.age_days != null ? ` ${offer.age_days}d ago` : ""}` });

  if (fin) {
    const inv = Number(fin.invoice_line_amt) || 0;
    const ap = fin.actual_profit_pct, pp = fin.projected_profit_pct;
    if (ap != null && inv > 0 && ap < 0)
      flags.push({ c: "bad", i: "$", card: "financial", t: `Project margin negative (${(ap * 100).toFixed(1)}%)` });
    else if (ap != null && pp != null && inv > 0 && ap < pp - 0.03)
      flags.push({ c: "warn", i: "$", card: "financial", t: `Margin ${((pp - ap) * 100).toFixed(1)} pts below plan` });
  }

  const starts = csvList(p.all_start_dates), crews = csvList(p.all_work_crews);
  const settled = ["canceled", "completed"].includes(p.operational_status);
  const dcount = starts.length;
  if (dcount > 1)
    flags.push({ c: "mut", i: "⑂", card: "schedule", t: `${dcount} separate date ranges` });
  if (!dcount && !settled)
    flags.push({ c: "warn", i: "▦", card: "schedule", t: "No schedule dates set" });

  // No crew and no live offer — the crew still needs to be sourced. Highlights
  // the Crew offer card (where you'd send the offer).
  const offerLive = offer && (offer.state === "accepted" || offer.state === "sent");
  if (!settled && !crews.length && !offerLive)
    flags.push({ c: "warn", i: "◷", card: "offer", t: "No crew assigned and no offer sent" });

  // Overdue A/R — a sent invoice past its due date.
  const aro = att && att.ar_overdue;
  if (aro && aro.days > 0)
    flags.push({ c: "bad", i: "◵", card: "upcoming", t: `Invoice ${aro.days}d overdue · ${money(aro.total)} A/R` });

  // kick-off & process — only surface once a project is active (scheduled or
  // in progress); a neutral flag, not an alarm. Daily-log status stays in the
  // card (its workflow is still being finalized), not the flag row.
  const kick = att && att.kickoff;
  if (["not_started", "in_progress"].includes(p.operational_status)) {
    const done = kick ? kick.done : 0, total = (kick && kick.total) || 13;
    if (done < total)
      flags.push({ c: "mut", i: "☑", card: "process", t: `Kick-off & process: ${done} of ${total} steps done` });
  }

  return flags;
}

export async function projectsHubPage(routeFn) {
  let all = [];
  let finById = new Map();     // qbo_customer_id -> financial row
  let attById = new Map();     // project_qbo_id (string) -> attention row
  const cardCache = new Map(); // project_qbo_id -> card detail (lazy)
  const openSet = new Set();   // project_qbo_id currently expanded
  let statusFilter = "all", search = "", sortKey = "project_name", sortDir = "asc";
  // Per-column filters (schedule/pm/crew/value/profit/outstanding/flags). Status
  // stays on the pill row; project/pm/crew text stays on the global search.
  let colFilters = { schedule: "", pm: "", crew: "", valueMin: "", profit: "", outstanding: "", flags: "" };

  // Restore the table's state (open rows / filter / sort / scroll) so returning
  // from a project workspace lands you exactly where you left off.
  // One-shot: restore only when returning straight from a project workspace
  // (which just saved the state). Any other navigation to Projects starts fresh
  // — default filter "All", nothing expanded.
  let restore = null;
  try {
    restore = JSON.parse(sessionStorage.getItem("opi_hub_state") || "null");
    sessionStorage.removeItem("opi_hub_state");
  } catch (_) {}
  if (restore) {
    statusFilter = restore.statusFilter || "all"; search = restore.search || "";
    sortKey = restore.sortKey || sortKey; sortDir = restore.sortDir || sortDir;
    if (restore.colFilters) colFilters = { ...colFilters, ...restore.colFilters };
    (restore.open || []).forEach((q) => openSet.add(String(q)));
  }
  const saveHubState = () => {
    try {
      const le = document.getElementById("phList");
      sessionStorage.setItem("opi_hub_state", JSON.stringify({
        open: [...openSet], statusFilter, search, sortKey, sortDir, colFilters, scroll: le ? le.scrollTop : 0,
      }));
    } catch (_) {}
  };

  const body = `
    <div class="w-full">
      <div class="card p-3 flex flex-col overflow-hidden" id="phCard" style="min-height:340px;">
        <div class="flex items-center gap-2 mb-2 flex-wrap shrink-0" id="phFilters"></div>
        <div id="phList" class="flex-1 overflow-auto text-sm text-black/40">Loading…</div>
      </div>
    </div>`;
  setShell({
    title: "Projects",
    subtitle: "Every project — status, team, schedule, financials, and what needs attention. Click a row for the full picture.",
    bodyHtml: body, showLogout: true, routeFn,
  });

  const listEl = document.getElementById("phList");
  const filtersEl = document.getElementById("phFilters");

  const setBack = (qid) => {
    try { sessionStorage.setItem("opi_entity_back", JSON.stringify({ entity: "project/" + qid, label: "Projects", hash: "#/projects" })); } catch (_) {}
  };

  const sizeCard = () => {
    const card = document.getElementById("phCard");
    if (!card) return;
    const top = card.getBoundingClientRect().top;
    card.style.height = Math.max(340, window.innerHeight - top - 30) + "px";
  };
  window.addEventListener("resize", sizeCard);

  // "Value" = the contract (accepted-estimate) amount, falling back to invoiced
  // for legacy projects with no estimate. (Previously showed invoiced-to-date,
  // which understated the contract on part-billed projects.)
  const finVal = (p) => {
    const f = finById.get(p.qbo_customer_id);
    return f ? (Number(f.estimate_line_amt) || Number(f.invoice_line_amt) || 0) : 0;
  };
  const searchKey = (p) => `${p.project_name || ""} ${p.all_project_managers || ""} ${p.all_work_crews || ""} ${p.linked_quote_number || ""}`.toLowerCase();
  // ── shared classifiers (used by both sorting and per-column filters) ──
  const outstandingTotal = (p) => {
    const f = finById.get(p.qbo_customer_id);
    const os = (attById.get(String(p.project_qbo_id)) || {}).outstanding || {};
    const toBill = f ? Math.max(0, (Number(f.estimate_line_amt) || 0) - (Number(f.invoice_line_amt) || 0)) : 0;
    const ar = f ? Number(f.open_invoice_total_amt) || 0 : 0;
    return toBill + ar + (os.crew_due || 0) + (os.exp_to_spend || 0);
  };
  const flagScore = (p) => deriveFlags(p, finById.get(p.qbo_customer_id), attById.get(String(p.project_qbo_id)))
    .reduce((s, f) => s + (f.c === "bad" ? 2 : f.c === "warn" ? 1 : 0), 0);
  const scheduleClass = (p) => csvList(p.all_start_dates).length ? "scheduled" : (p.operational_status === "pending" ? "tbd" : "unscheduled");
  const wrapNames = (csv) => { const l = csvList(csv).map((s) => s.toLowerCase()); return l.length ? "||" + l.join("||") + "||" : ""; };
  const profitClass = (p) => { const pi = profitInfo(finById.get(p.qbo_customer_id), p.operational_status); return pi.pct == null ? "na" : pi.pct < 0 ? "neg" : "pos"; };
  const sortVal = (p, key) => {
    if (key === "value") return finVal(p);
    if (key === "profit") { const pi = profitInfo(finById.get(p.qbo_customer_id), p.operational_status); return pi.pct == null ? -Infinity : pi.pct; }
    if (key === "pm") return (csvList(p.all_project_managers)[0] || "").toLowerCase();
    if (key === "crew") return (csvList(p.all_work_crews)[0] || "").toLowerCase();
    if (key === "outstanding") return outstandingTotal(p);
    if (key === "flags") return flagScore(p);
    return (p[key] ?? "").toString().toLowerCase();
  };
  const sortedAll = () => {
    const out = [...all];
    out.sort((a, b) => { const av = sortVal(a, sortKey), bv = sortVal(b, sortKey); return (av < bv ? -1 : av > bv ? 1 : 0) * (sortDir === "asc" ? 1 : -1); });
    return out;
  };

  const HEADERS = [
    { key: "operational_status", label: "Status", col: "status" },
    { key: "project_name", label: "Project", col: "project" },
    { key: "start_date", label: "Schedule", col: "schedule" },
    { key: "pm", label: "PM", col: "pm" },
    { key: "crew", label: "Work crew", col: "crew" },
    { key: "project_create_dttm", label: "Created", align: "right", col: "created" },
    { key: "value", label: "Value", align: "right", col: "value" },
    { key: "profit", label: "Profit", align: "right", col: "profit" },
    { key: "outstanding", label: "Outstanding", col: "outstanding" },
    { key: "flags", label: "Flags", align: "right", col: "flags" },
  ];
  const arrow = (k) => (sortKey !== k ? "" : sortDir === "asc" ? " ▲" : " ▼");
  const onHeaderClick = (k) => {
    if (!k) return;
    if (sortKey !== k) { sortKey = k; sortDir = "asc"; }
    else if (sortDir === "asc") sortDir = "desc";
    else { sortKey = "project_name"; sortDir = "asc"; }
    renderList();
  };

  const renderFilters = () => {
    const counts = all.reduce((m, p) => { m[p.operational_status] = (m[p.operational_status] || 0) + 1; return m; }, {});
    const pills = [["all", "All"], ...Object.keys(OP_STATUS).map((k) => [k, OP_STATUS[k].label])];
    filtersEl.innerHTML =
      pills.map(([k, label]) => {
        const n = k === "all" ? all.length : (counts[k] || 0);
        return `<button data-sf="${k}" class="rounded-full px-2.5 py-1 text-xs font-semibold border ${statusFilter === k ? "bg-ink-900 text-white border-ink-900" : "border-black/15 text-black/60 hover:bg-black/5"}">${escapeHtml(label)} <span class="opacity-60">${n}</span></button>`;
      }).join("") +
      `<input data-search value="${escapeHtml(search)}" placeholder="Search project, PM, crew, quote…" class="input text-xs py-1.5 w-full sm:max-w-xs ml-auto">` +
      `<button data-legend-toggle class="rounded-full px-2.5 py-1 text-xs font-semibold border border-black/15 text-black/55 hover:bg-black/5" title="What do the flags mean?">Flags ⓘ</button>` +
      `<span data-count class="text-xs text-black/40 whitespace-nowrap"></span>` +
      `<div data-legend style="display:none" class="w-full mt-1 rounded-lg border border-black/10 bg-black/[0.015] p-2.5 flex flex-wrap gap-x-4 gap-y-1.5">` +
        FLAG_LEGEND.map(([c, i, t]) => `<span class="inline-flex items-center gap-1.5 text-[11.5px] text-black/60"><span class="inline-flex items-center justify-center w-[20px] h-[20px] rounded-md border text-[11px] ${FLAG_CLS[c]}">${i}</span>${escapeHtml(t)}</span>`).join("") +
        `<span class="inline-flex items-center gap-1.5 text-[11.5px] text-black/45 w-full mt-0.5 pt-1.5 border-t border-black/[0.06]">Amber left-edge on a row = it has an open item. Setup letters under a schedule: <span class="inline-flex items-center justify-center w-[15px] h-[15px] rounded text-[9px] font-bold bg-indigo-100 text-indigo-700">W</span>ire · <span class="inline-flex items-center justify-center w-[15px] h-[15px] rounded text-[9px] font-bold bg-indigo-100 text-indigo-700">T</span>ravel · <span class="inline-flex items-center justify-center w-[15px] h-[15px] rounded text-[9px] font-bold bg-indigo-100 text-indigo-700">O</span>verage · <span class="inline-flex items-center justify-center w-[15px] h-[15px] rounded text-[9px] font-bold bg-indigo-100 text-indigo-700">E</span>quipment.</span>` +
      `</div>`;
    filtersEl.querySelectorAll("[data-sf]").forEach((b) => b.addEventListener("click", () => { statusFilter = b.getAttribute("data-sf"); renderFilters(); applyFilter(); }));
    const legendBtn = filtersEl.querySelector("[data-legend-toggle]"), legendEl = filtersEl.querySelector("[data-legend]");
    legendBtn?.addEventListener("click", () => { legendEl.style.display = legendEl.style.display === "none" ? "flex" : "none"; });
    const sb = filtersEl.querySelector("[data-search]");
    let t = null;
    sb.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { search = sb.value.trim(); applyFilter(); }, 60); });
    if (document.activeElement?.getAttribute?.("data-search") != null) sb.focus();
  };

  const applyFilter = () => {
    const q = search.toLowerCase();
    const cf = colFilters;
    const valueMin = parseFloat(cf.valueMin);
    let shown = 0;
    listEl.querySelectorAll("tr.ph-row").forEach((tr) => {
      const g = (a) => tr.getAttribute(a) || "";
      let ok = (statusFilter === "all" || g("data-status") === statusFilter)
        && (!q || g("data-key").includes(q));
      if (ok && cf.schedule) ok = g("data-schedule") === cf.schedule;
      if (ok && cf.pm) ok = cf.pm === "__none__" ? g("data-pm") === "" : g("data-pm").includes("||" + cf.pm.toLowerCase() + "||");
      if (ok && cf.crew) ok = cf.crew === "__none__" ? g("data-crew") === "" : g("data-crew").includes("||" + cf.crew.toLowerCase() + "||");
      if (ok && !Number.isNaN(valueMin)) ok = (parseFloat(g("data-value")) || 0) >= valueMin;
      if (ok && cf.profit) ok = g("data-profit") === cf.profit;
      if (ok && cf.outstanding) ok = cf.outstanding === "has" ? g("data-outstanding") === "1" : g("data-outstanding") === "0";
      if (ok && cf.flags) ok = cf.flags === "has" ? g("data-flags") === "1" : g("data-flags") === "0";
      tr.hidden = !ok;
      const det = tr.nextElementSibling;
      if (det && det.classList.contains("ph-detail")) det.hidden = !ok || !tr.classList.contains("open");
      if (ok) shown++;
    });
    const countEl = filtersEl.querySelector("[data-count]");
    if (countEl) countEl.textContent = `${shown.toLocaleString()} of ${all.length.toLocaleString()}`;
    const empty = listEl.querySelector("[data-empty]");
    if (empty) empty.hidden = shown > 0;
  };

  // ── collapsed row cells ──
  const scheduleCell = (p) => {
    const starts = csvList(p.all_start_dates);
    if (!starts.length) return `<span class="text-black/35">${p.operational_status === "pending" ? "Dates TBD" : "Not scheduled"}</span>`;
    const label = rangeShort(p.start_date, p.end_date);
    const more = starts.length > 1 ? `<span class="ml-1.5 inline-flex items-center text-[10px] font-bold text-blue-700 bg-blue-50 rounded px-1 py-px align-middle">+${starts.length - 1} dates</span>` : "";
    return `<span class="text-ink-900 font-medium">${escapeHtml(label)}</span>${more}`;
  };
  const _teamChip = (n) => n > 1 ? `<span class="ml-1 inline-flex items-center text-[10px] font-bold text-blue-700 bg-blue-50 rounded px-1 py-px align-middle">+${n - 1}</span>` : "";
  const pmCell = (p) => {
    const pms = csvList(p.all_project_managers);
    return pms.length ? `<span class="text-ink-900">${escapeHtml(pms[0])}${_teamChip(pms.length)}</span>` : `<span class="text-black/35">No PM</span>`;
  };
  const crewCell = (p) => {
    const crews = csvList(p.all_work_crews);
    return crews.length ? `<span class="text-ink-900">${escapeHtml(crews[0])}${_teamChip(crews.length)}</span>` : `<span class="text-black/35">No crew</span>`;
  };
  // Outstanding cash: invoices still to bill, A/R (sent + overdue days), crew
  // payments due, and estimated expenses left to spend. Only non-zero rows show.
  const outstandingCell = (p) => {
    const f = finById.get(p.qbo_customer_id);
    const att = attById.get(String(p.project_qbo_id)) || {};
    const os = att.outstanding || {}, aro = att.ar_overdue;
    // Show outstandings for EVERY status on purpose: a completed project that
    // still has to-bill / crew / expense outstanding is a signal something's off
    // (e.g. closed too early, or books not actually closed) — the office should
    // see it and reopen if needed. Contract value now comes from the estimate
    // header total, so it's the real quoted amount (fixes #1069's phantom to-bill).
    const toBill = f ? Math.max(0, (Number(f.estimate_line_amt) || 0) - (Number(f.invoice_line_amt) || 0)) : 0;
    const ar = f ? Number(f.open_invoice_total_amt) || 0 : 0;  // true open A/R (unpaid invoices)
    const crewDue = os.crew_due || 0, expLeft = os.exp_to_spend || 0;
    const line = (label, val, extra = "") => `<div><span class="text-black/40">${label}</span> <b class="tabular-nums text-ink-900">${money(val)}</b>${extra}</div>`;
    const rows = [];
    if (toBill > 0.5) rows.push(line("Bill", toBill));
    if (ar > 0.5) rows.push(line("A/R", ar, aro && aro.days > 0 ? ` <span class="text-red-600 font-semibold">${aro.days}d</span>` : ""));
    if (crewDue > 0.5) rows.push(line("Crew", crewDue));
    if (expLeft > 0.5) rows.push(line("Exp", expLeft));
    return rows.length ? `<div class="text-[11px] leading-snug">${rows.join("")}</div>` : `<span class="text-black/25">—</span>`;
  };
  const profitCell = (p) => {
    const pi = profitInfo(finById.get(p.qbo_customer_id), p.operational_status);
    if (pi.pct == null) return `<span class="text-black/30">—</span>`;
    const neg = pi.pct < 0;
    const cls = neg ? "text-rose-600" : "text-emerald-700";
    const tag = pi.kind === "actual" ? "" : ` <span class="text-black/35 text-[9px] font-normal align-middle">est</span>`;
    const amt = pi.amount != null ? `<div class="text-[11px] tabular-nums text-black/50">${money(pi.amount)}</div>` : "";
    return `<div class="leading-tight"><div class="${cls} font-semibold tabular-nums"><span class="text-[9px] align-middle">${neg ? "▾" : "▴"}</span> ${pi.pct.toFixed(1)}%${tag}</div>${amt}</div>`;
  };
  const flagsCell = (p) => {
    const flags = deriveFlags(p, finById.get(p.qbo_customer_id), attById.get(String(p.project_qbo_id)));
    const chips = flags.map((f) => `<span class="ph-flag inline-flex items-center justify-center w-[22px] h-[22px] rounded-md border text-[12px] cursor-pointer ${FLAG_CLS[f.c]}" data-card="${f.card}" title="${escapeHtml(f.t)} — click to jump to the card">${f.i}</span>`).join("");
    return `<div class="flex gap-1 justify-end items-center flex-wrap">${chips}<span class="ph-caret text-black/35 text-[11px] ml-0.5">▸</span></div>`;
  };
  // On-site setup presence (wire / travel / overage / equipment), from the estimate.
  // Assignment setup values (wire / travel days / overage days / equipment),
  // sourced from the Assignment page. Only shows what's set.
  const setupChips = (p) => {
    const s = (attById.get(String(p.project_qbo_id)) || {}).setup;
    if (!s) return "";
    const bits = [];
    if (s.wire) bits.push("Wire");
    if (s.travel_days) bits.push(`${s.travel_days}d travel`);
    if (s.overage_days) bits.push(`${s.overage_days}d overage`);
    if (s.equipment) bits.push(escapeHtml(s.equipment));
    if (!bits.length) return "";
    return `<div class="mt-1 flex flex-wrap gap-1">${bits.map((b) => `<span class="inline-flex items-center text-[10px] font-semibold px-1.5 py-px rounded bg-indigo-50 text-indigo-700 border border-indigo-100">${b}</span>`).join("")}</div>`;
  };
  // Status is read-only here — it's the final assignment row's status, set on the
  // Assignment page (Projects hub reflects it, doesn't edit it).
  const statusCell = (p) => statusBadge(p.operational_status);

  const rowHtml = (p) => {
    const att = attById.get(String(p.project_qbo_id));
    const hasAtt = deriveFlags(p, finById.get(p.qbo_customer_id), att).some((f) => f.c === "bad" || f.c === "warn");
    const open = openSet.has(String(p.project_qbo_id));
    return `
      <tr class="ph-row border-b border-black/5 hover:bg-black/[0.02] cursor-pointer ${open ? "open bg-black/[0.02]" : ""} ${hasAtt ? "ph-att" : ""}"
          data-qid="${escapeHtml(String(p.project_qbo_id))}" data-status="${escapeHtml(p.operational_status || "")}" data-key="${escapeHtml(searchKey(p))}"
          data-schedule="${scheduleClass(p)}" data-pm="${escapeHtml(wrapNames(p.all_project_managers))}" data-crew="${escapeHtml(wrapNames(p.all_work_crews))}"
          data-value="${finVal(p)}" data-profit="${profitClass(p)}" data-outstanding="${outstandingTotal(p) > 0.5 ? 1 : 0}" data-flags="${flagScore(p) > 0 ? 1 : 0}">
        <td class="py-2 pl-3 pr-3 align-top">${statusCell(p)}</td>
        <td class="py-2 pr-3 align-top">
          <div class="font-semibold text-ink-900 leading-tight">${escapeHtml(dash(p.project_name))}</div>
          <div class="text-[11.5px] text-black/40 mt-0.5">Quote <span class="text-blue-700 font-semibold">${p.linked_quote_number ? "#" + escapeHtml(String(p.linked_quote_number)) : "—"}</span> · 📎 ${p.file_count || 0}</div>
        </td>
        <td class="py-2 pr-3 align-top text-[12.5px]">${scheduleCell(p)}${setupChips(p)}</td>
        <td class="py-2 pr-3 align-top text-[12.5px]">${pmCell(p)}</td>
        <td class="py-2 pr-3 align-top text-[12.5px]">${crewCell(p)}</td>
        <td class="py-2 pr-3 align-top text-right text-[11.5px] tabular-nums text-black/50 whitespace-nowrap">${p.project_create_dttm ? escapeHtml(shortDate(p.project_create_dttm)) : "—"}</td>
        <td class="py-2 pr-3 align-top text-right tabular-nums font-semibold text-black/75">${money(finVal(p) || null)}</td>
        <td class="py-2 pr-3 align-top text-right">${profitCell(p)}</td>
        <td class="py-2 pr-3 align-top">${outstandingCell(p)}</td>
        <td class="py-2 pr-3 align-top">${flagsCell(p)}</td>
      </tr>
      <tr class="ph-detail" data-qid="${escapeHtml(String(p.project_qbo_id))}" ${open ? "" : "hidden"}>
        <td colspan="10" class="bg-black/[0.015] border-b border-black/10 px-3 py-3">
          <div class="ph-detail-body" data-qid="${escapeHtml(String(p.project_qbo_id))}">${open && cardCache.has(String(p.project_qbo_id)) ? detailHtml(p, cardCache.get(String(p.project_qbo_id))) : `<div class="text-black/40 text-xs py-4">Loading…</div>`}</div>
        </td>
      </tr>`;
  };

  // ── expanded detail cards ──
  const box = (pid, key, title, srcTag, inner, flag) => {
    const badge = srcTag ? `<span class="text-[9px] font-bold tracking-wide px-1.5 py-px rounded ${srcTag === "NEW" ? "text-violet-700 bg-violet-50" : "text-emerald-700 bg-emerald-50"}">${srcTag}</span>` : "";
    const cf = flag ? `<span class="inline-flex items-center justify-center w-[18px] h-[18px] rounded text-[11px] border ${FLAG_CLS[flag.c]}" title="${escapeHtml(flag.t)}">${flag.i}</span>` : "";
    const acc = flag ? `border-l-2 ${ACCENT[flag.c]}` : "";
    const tab = CARD_TAB[key];
    // The whole card opens the project workspace at the relevant tab.
    return `<div class="ph-card bg-white border border-black/10 rounded-lg p-3 ${acc} ${tab ? "cursor-pointer hover:border-black/25 hover:shadow-sm transition" : ""}" data-card="${key}" ${tab ? `data-open-tab="${tab}"` : ""} id="phc-${pid}-${key}">
      <div class="flex items-center gap-1.5 mb-2 text-[10px] font-bold uppercase tracking-wide text-black/40">${cf}<span>${title}</span>${badge}${tab ? `<span class="ml-auto text-black/30 text-[11px]">↗</span>` : ""}</div>${inner}</div>`;
  };
  const kv = (k, v) => `<div class="flex justify-between gap-3 py-0.5 text-[12.5px] border-b border-black/[0.05] last:border-0"><span class="text-black/55">${k}</span><span class="font-semibold text-ink-900 text-right">${v}</span></div>`;

  const detailHtml = (p, c) => {
    if (!c) return `<div class="text-black/40 text-xs py-4">Loading…</div>`;
    const flags = deriveFlags(p, finById.get(p.qbo_customer_id), attById.get(String(p.project_qbo_id)));
    const fb = {}; flags.forEach((f) => { if (f.card && !fb[f.card]) fb[f.card] = f; });

    const dates = (c.date_ranges && c.date_ranges.length)
      ? `<div class="flex flex-wrap gap-1.5">${c.date_ranges.map((d) => `<span class="text-[11.5px] font-semibold px-2 py-0.5 rounded border border-black/10 bg-black/[0.02] text-black/60">${escapeHtml(rangeShort(d.start, d.end))}</span>`).join("")}</div>`
      : `<div class="text-black/35 text-[12.5px]">No dates assigned yet</div>`;
    const cp = c.crew_paid || { total: 0, vendors: 0, crews: [] };
    const paidList = (cp.crews || []).map((x) => `${escapeHtml(x.name)} <span class="text-black/40">${money(x.amount)}</span>`).join(", ");
    const crewsVal = c.crews.length
      ? c.crews.map(escapeHtml).join(", ")
      : (cp.total > 0
          ? `<span class="text-amber-700">None assigned</span>`
          : "—");
    const team = kv("Project managers", c.pms.length ? c.pms.map(escapeHtml).join(", ") : "—")
               + kv("Work crews", crewsVal)
               + (cp.total > 0 ? kv("Paid (QBO)", `<span class="text-[11.5px]">${paidList}</span>`) : "");
    // Expenses by category — estimated vs spent, with what's left to spend + totals.
    const ec = c.expense_categories || [];
    const eTot = ec.reduce((a, x) => { a.est += x.estimated; a.act += x.actual; a.rem += x.remaining; return a; }, { est: 0, act: 0, rem: 0 });
    const eOver = eTot.rem < -0.5;
    const expensesByCat = ec.length ? `<table class="w-full text-[12px]"><thead><tr class="text-[10px] text-black/40 text-left"><th class="pb-1 font-bold">Category</th><th class="text-right font-bold">Est</th><th class="text-right font-bold">Spent</th><th class="text-right font-bold">Left</th></tr></thead>
      <tbody>${ec.map((x) => { const over = x.remaining < -0.5; return `<tr class="border-t border-black/[0.05]"><td class="py-1 font-semibold">${escapeHtml(x.category)}</td><td class="py-1 text-right tabular-nums text-black/55">${money(x.estimated)}</td><td class="py-1 text-right tabular-nums font-semibold ${over ? "text-red-600" : ""}">${money(x.actual)}</td><td class="py-1 text-right tabular-nums font-semibold ${over ? "text-red-600" : "text-emerald-700"}">${over ? "−" + money(-x.remaining) : money(x.remaining)}</td></tr>`; }).join("")}</tbody>
      <tfoot><tr class="border-t-2 border-black/15 font-bold text-ink-900"><td class="py-1">Total</td><td class="py-1 text-right tabular-nums">${money(eTot.est)}</td><td class="py-1 text-right tabular-nums ${eOver ? "text-red-600" : ""}">${money(eTot.act)}</td><td class="py-1 text-right tabular-nums ${eOver ? "text-red-600" : "text-emerald-700"}">${eOver ? "−" + money(-eTot.rem) : money(eTot.rem)}</td></tr></tfoot></table>` : `<div class="text-black/35 text-[12.5px]">No expense lines.</div>`;
    const estPill = (n, label, cls) => n ? `<span class="text-[11.5px] font-semibold px-2 py-0.5 rounded border ${cls}">${n} ${label}</span>` : "";
    const eb = c.estimates.reduce((m, e) => { m[e.status] = (m[e.status] || 0) + 1; return m; }, {});
    const ests = `<div class="flex flex-wrap gap-1.5 mb-2">
        ${estPill(c.estimates.length, "total", "bg-sky-50 text-sky-700 border-sky-200")}
        ${estPill(eb.pending, "pending", "bg-amber-50 text-amber-700 border-amber-200")}
        ${estPill(eb.accepted, "accepted", "bg-emerald-50 text-emerald-700 border-emerald-200")}
        ${estPill(eb.declined, "declined", "bg-black/[0.03] text-black/45 border-black/10")}</div>
      ${c.estimates.slice(0, 8).map((e) => `<div class="flex justify-between items-baseline text-[12px] py-0.5 border-b border-black/[0.05] last:border-0"><span class="text-black/55">#${escapeHtml(String(e.doc || "—"))} <span class="text-black/35">· ${escapeHtml(e.status)}${e.status === "pending" && e.date ? " · sent " + escapeHtml(shortDate(e.date)) : ""}</span></span><span class="tabular-nums font-semibold">${money(e.amount)}</span></div>`).join("")}`;
    const o = c.offer;
    const offerInner = o.state === "none"
      ? (cp.total > 0
          ? kv("Crew offer", `<span class="text-black/45">n/a — crews already paid</span>`) + kv("Paid", `<span class="text-[11.5px]">${paidList}</span>`)
          : kv("Crew offer", `<span class="text-black/40">Not sent</span>`))
      : kv("Crew offer", `<span class="${o.state === "accepted" ? "text-emerald-700" : "text-amber-700"}">${escapeHtml(o.state)}</span>`)
        + (o.crew_name ? kv("Crew", escapeHtml(o.crew_name)) : "")
        + (o.age_days != null ? kv("Age", `${o.age_days} day${o.age_days === 1 ? "" : "s"} ago`) : "")
        + (o.labor ? kv("Labor", money(o.labor)) : "");
    const f = c.financial || {};
    const expOver = f.expense_actual != null && f.expense_estimated != null && f.expense_actual > f.expense_estimated + 0.5;
    const expLine = f.expense_estimated != null
      ? `<span class="${expOver ? "text-red-600" : "text-emerald-700"} font-semibold">${money(f.expense_actual)}</span> <span class="text-black/40">/ ${money(f.expense_estimated)} est</span>`
      : money(f.expense_line_amt);
    // Sent A/R (open, unpaid invoices) is already part of the Invoiced total, so
    // show it as a sub-line under Invoiced rather than a separate row (#3a).
    const arSent = Number(f.open_invoice_total_amt) || 0;
    const invoicedVal = `${money(f.invoice_line_amt)}${arSent > 0.5
      ? `<div class="text-black/40 text-[11px] font-normal">(${money(arSent)} sent A/R)</div>` : ""}`;
    // Profit follows the project's stage (see profitInfo): estimated until the
    // project starts, contract-minus-actual-cost once it's over the estimate,
    // and true actual profit once complete/canceled (#3b).
    const pi = profitInfo(f, p.operational_status);
    const profitVal = pi.pct == null ? "—"
      : `<span class="${pi.pct < 0 ? "text-rose-600" : "text-emerald-700"}">${money(pi.amount)} · ${pi.pct.toFixed(1)}%</span>`
        + ` <span class="text-black/35 text-[10px] font-normal">${pi.kind === "actual" ? "actual" : "est"}</span>`;
    const financial = kv("Estimate", money(f.estimate_line_amt)) + kv("Invoiced", invoicedVal)
                    + kv("Expenses", expLine)
                    + kv("Profit", profitVal);
    const notes = c.notes && c.notes.length
      ? `<div class="text-[12.5px] text-black/55 italic leading-relaxed space-y-1">${c.notes.map((n) => `<div>“${escapeHtml(n)}”</div>`).join("")}</div>`
      : `<div class="text-black/35 text-[12.5px]">No notes</div>`;

    const up = c.upcoming || {};
    const ar = up.ar || { total: 0, count: 0 };
    // Sent A/R — always relevant. Overdue days if past due.
    const arDue = ar.next_due
      ? (ar.overdue_days > 0 ? `<span class="text-red-600 font-semibold">${ar.overdue_days}d overdue</span>` : `due ${escapeHtml(shortDate(ar.next_due))}`)
      : "";
    const arRow = kv(`Sent · A/R${ar.count ? " (" + ar.count + ")" : ""}`,
      ar.total > 0 ? `<span class="tabular-nums font-semibold">${money(ar.total)}</span>${arDue ? ` <span class="text-black/45 text-[11px]">· ${arDue}</span>` : ""}` : `<span class="text-black/30">none</span>`);
    let upcoming;
    if (up.complete) {
      upcoming = arRow + `<div class="text-[11px] text-emerald-700 mt-1.5">🔒 Books closed — nothing else outstanding.</div>`;
    } else {
      const line = (label, amt, extra = "") => kv(label, amt > 0
        ? `<span class="tabular-nums font-semibold">${money(amt)}</span>${extra}` : `<span class="text-black/30">—</span>`);
      upcoming = arRow
        + line("Invoices to send", up.invoices?.total, up.invoices?.next_date ? ` <span class="text-black/45 text-[11px]">· next ${escapeHtml(shortDate(up.invoices.next_date))}</span>` : "")
        + line("Crew payments due", up.crew?.total)
        + line("Expenses to spend", up.expenses?.total);
    }

    const kk = c.kickoff || { done: 0, total: 13 };
    const kpct = kk.total ? Math.round((kk.done / kk.total) * 100) : 0;
    const dl = c.daily || {};
    const dailyLine = dl.today_touched
      ? `<span class="text-emerald-700 font-semibold">${dl.today_done}/${dl.today_touched} done today</span>`
      : (dl.last_date ? `<span class="text-black/45">last log ${escapeHtml(shortDate(dl.last_date))}</span>` : `<span class="text-black/40">no log today</span>`);
    const process = `
      <div class="flex items-baseline justify-between mb-1"><span class="text-[12.5px] text-black/60">Kick-off &amp; process</span><span class="text-[12.5px] font-bold text-ink-900">${kk.done}/${kk.total}</span></div>
      <div class="h-1.5 rounded bg-black/10 overflow-hidden mb-1.5"><div class="h-full ${kpct >= 100 ? "bg-emerald-500" : "bg-indigo-400"}" style="width:${kpct}%"></div></div>
      ${kk.next ? `<div class="text-[11.5px] text-black/45 mb-1.5">Next: ${escapeHtml(kk.next)}</div>` : `<div class="text-[11.5px] text-emerald-700 mb-1.5">All steps complete</div>`}
      <div class="flex items-center justify-between text-[12px] border-t border-black/[0.06] pt-1.5">
        <span class="text-black/55">Daily log · ${dailyLine}</span>
      </div>
      <div class="flex gap-1.5 mt-2">
        <a href="#/entity/project/${escapeHtml(String(p.project_qbo_id))}" data-tab="kickoff" class="ph-tablink text-[11px] font-semibold text-blue-700 border border-blue-200 bg-blue-50 rounded px-2 py-1 hover:bg-blue-100">Kick-off →</a>
        <a href="#/entity/project/${escapeHtml(String(p.project_qbo_id))}" data-tab="daily" class="ph-tablink text-[11px] font-semibold text-blue-700 border border-blue-200 bg-blue-50 rounded px-2 py-1 hover:bg-blue-100">Daily log →</a>
      </div>`;

    return `
      <div class="flex items-center gap-2 mb-2">
        <a href="#/entity/project/${escapeHtml(String(p.project_qbo_id))}" class="ph-open text-[12px] font-bold text-white bg-ink-900 hover:bg-black rounded-lg px-3 py-1.5">Open project workspace →</a>
        <span class="text-[11.5px] text-black/40">quote #${escapeHtml(String(p.linked_quote_number || "—"))}</span>
      </div>
      <div class="grid gap-2.5" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));">
        ${box(p.project_qbo_id, "schedule", "Schedule — all ranges", "LIVE", dates, fb.schedule)}
        ${box(p.project_qbo_id, "team", "Team", "LIVE", team, fb.team)}
        ${box(p.project_qbo_id, "offer", "Crew offer", "LIVE", offerInner, fb.offer)}
        ${box(p.project_qbo_id, "estimates", "Estimates", "LIVE", ests, fb.estimates)}
        ${box(p.project_qbo_id, "financial", "Financials", "LIVE", financial, fb.financial)}
        ${box(p.project_qbo_id, "upcoming", "Upcoming", "LIVE", upcoming, fb.upcoming)}
        ${box(p.project_qbo_id, "expenses", "Expenses by category", "LIVE", expensesByCat, fb.expenses)}
        ${box(p.project_qbo_id, "process", "Kick-off &amp; process", "LIVE", process, fb.process)}
        ${box(p.project_qbo_id, "notes", "Notes", "LIVE", notes, fb.notes)}
      </div>`;
  };

  // ── per-column filters, consolidated into a funnel in each column header ──
  const FILTER_COLS = new Set(["schedule", "pm", "crew", "value", "profit", "outstanding", "flags"]);
  const filterKeyOf = (col) => (col === "value" ? "valueMin" : col);
  const distinctNames = (accessor) => {
    const set = new Set();
    all.forEach((p) => csvList(accessor(p)).forEach((n) => n && set.add(n)));
    return [...set].sort((a, b) => a.localeCompare(b));
  };
  const sel = (col, cur, opts) => `<select data-colf="${col}" class="w-full text-[12px] border border-black/15 rounded px-1.5 py-1 bg-white text-black/70">`
    + opts.map(([v, l]) => `<option value="${escapeHtml(v)}"${v === cur ? " selected" : ""}>${escapeHtml(l)}</option>`).join("") + `</select>`;
  const filterControlHtml = (col) => {
    if (col === "schedule") return sel("schedule", colFilters.schedule, [["", "All"], ["scheduled", "Scheduled"], ["unscheduled", "Not scheduled"], ["tbd", "Dates TBD"]]);
    if (col === "pm") return sel("pm", colFilters.pm, [["", "All"], ["__none__", "No PM"], ...distinctNames((p) => p.all_project_managers).map((n) => [n, n])]);
    if (col === "crew") return sel("crew", colFilters.crew, [["", "All"], ["__none__", "No crew"], ...distinctNames((p) => p.all_work_crews).map((n) => [n, n])]);
    if (col === "value") return `<input data-colf="valueMin" value="${escapeHtml(colFilters.valueMin)}" inputmode="numeric" placeholder="Min $" class="w-full text-[12px] border border-black/15 rounded px-2 py-1 bg-white text-black/70 text-right">`;
    if (col === "profit") return sel("profit", colFilters.profit, [["", "All"], ["pos", "Positive"], ["neg", "Negative"], ["na", "No data"]]);
    if (col === "outstanding") return sel("outstanding", colFilters.outstanding, [["", "All"], ["has", "Has outstanding"], ["none", "None"]]);
    if (col === "flags") return sel("flags", colFilters.flags, [["", "All"], ["has", "Flagged"], ["none", "Clear"]]);
    return "";
  };
  const funnelBtn = (col) => {
    const active = !!colFilters[filterKeyOf(col)];
    return `<button type="button" data-filter-btn="${col}" title="Filter" class="shrink-0 p-0.5 rounded align-middle ${active ? "text-blue-600" : "text-black/25 hover:text-black/55"}">`
      + `<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="${active ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M3 4h18l-7 8v6l-4 2v-8z"/></svg></button>`;
  };
  const headerCell = (h) => {
    const sortSpan = h.key
      ? `<span data-sort="${h.key}" class="cursor-pointer select-none hover:text-black/70">${h.label}${arrow(h.key)}</span>`
      : `<span>${h.label}</span>`;
    const inner = `<span class="inline-flex items-center gap-1">${sortSpan}${FILTER_COLS.has(h.col) ? funnelBtn(h.col) : ""}</span>`;
    return `<th class="py-2 px-3 font-bold bg-white whitespace-nowrap ${h.align === "right" ? "text-right" : ""}">${inner}</th>`;
  };

  // Funnel dropdown — a floating popover anchored to the clicked column funnel.
  let popEl = null, popCol = null;
  const updateFunnel = (col) => {
    const btn = listEl.querySelector(`[data-filter-btn="${col}"]`);
    if (!btn) return;
    const active = !!colFilters[filterKeyOf(col)];
    btn.classList.toggle("text-blue-600", active);
    btn.classList.toggle("text-black/25", !active);
    btn.querySelector("svg")?.setAttribute("fill", active ? "currentColor" : "none");
  };
  const onPopDocClick = (e) => { if (popEl && !popEl.contains(e.target) && !e.target.closest("[data-filter-btn]")) closeFilterPopover(); };
  function closeFilterPopover() {
    if (!popEl) return;
    popEl.remove(); popEl = null; popCol = null;
    document.removeEventListener("mousedown", onPopDocClick, true);
    window.removeEventListener("resize", closeFilterPopover);
    listEl.removeEventListener("scroll", closeFilterPopover);
  }
  const openFilterPopover = (btn, col) => {
    if (popCol === col) { closeFilterPopover(); return; }
    closeFilterPopover();
    popCol = col;
    const hasVal = !!colFilters[filterKeyOf(col)];
    popEl = document.createElement("div");
    popEl.className = "fixed z-[70] bg-white rounded-lg shadow-soft border border-black/10 p-2 w-[190px]";
    popEl.innerHTML = `<div class="flex items-center justify-between mb-1"><span class="text-[10px] font-bold uppercase tracking-wide text-black/40">Filter</span>${hasVal ? `<button data-filter-clear class="text-[11px] font-semibold text-blue-600 hover:underline">Clear</button>` : ""}</div>${filterControlHtml(col)}`;
    document.body.appendChild(popEl);
    const r = btn.getBoundingClientRect();
    const pw = popEl.offsetWidth;
    let left = r.left;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
    popEl.style.left = Math.max(8, left) + "px";
    popEl.style.top = (r.bottom + 4) + "px";
    const ctrl = popEl.querySelector("[data-colf]");
    if (ctrl) {
      const evt = ctrl.tagName === "SELECT" ? "change" : "input";
      ctrl.addEventListener(evt, () => { colFilters[ctrl.getAttribute("data-colf")] = ctrl.value.trim(); applyFilter(); updateFunnel(col); if (ctrl.tagName === "SELECT") closeFilterPopover(); });
      ctrl.focus?.();
    }
    popEl.querySelector("[data-filter-clear]")?.addEventListener("click", () => { colFilters[filterKeyOf(col)] = ""; applyFilter(); updateFunnel(col); closeFilterPopover(); });
    setTimeout(() => {
      document.addEventListener("mousedown", onPopDocClick, true);
      window.addEventListener("resize", closeFilterPopover);
      listEl.addEventListener("scroll", closeFilterPopover);
    }, 0);
  };

  const renderList = () => {
    if (!all.length) { listEl.innerHTML = `<div class="text-black/45 py-4">No projects found.</div>`; return; }
    closeFilterPopover();
    const rows = sortedAll();
    listEl.innerHTML = `
      <table class="w-full text-sm" style="min-width:1280px;">
        <thead class="sticky top-0 z-10 bg-white text-left text-black/45">
          <tr class="border-b border-black/10">${HEADERS.map(headerCell).join("")}</tr>
        </thead>
        <tbody>${rows.map(rowHtml).join("")}</tbody>
      </table>
      <div data-empty hidden class="text-black/45 py-4">No projects match.</div>`;
    listEl.querySelectorAll("[data-sort]").forEach((el) => el.addEventListener("click", () => onHeaderClick(el.getAttribute("data-sort"))));
    listEl.querySelectorAll("[data-filter-btn]").forEach((btn) => btn.addEventListener("click", (e) => { e.stopPropagation(); openFilterPopover(btn, btn.getAttribute("data-filter-btn")); }));
    applyFilter();
  };

  // ── expand / collapse + flag→card jump ──
  const byQid = (qid) => all.find((p) => String(p.project_qbo_id) === String(qid));
  const loadCard = async (qid) => {
    if (cardCache.has(qid)) return cardCache.get(qid);
    const c = await api(`/projects/${encodeURIComponent(qid)}/card`);
    cardCache.set(qid, c);
    return c;
  };
  const renderDetailInto = (qid) => {
    const bodyEl = listEl.querySelector(`.ph-detail-body[data-qid="${CSS.escape(qid)}"]`);
    if (bodyEl) bodyEl.innerHTML = detailHtml(byQid(qid), cardCache.get(qid));
  };
  const pulseCard = (qid, key) => {
    const el = document.getElementById(`phc-${qid}-${key}`);
    if (!el) return;
    el.classList.remove("ring-2", "ring-indigo-400");
    void el.offsetWidth;
    el.classList.add("ring-2", "ring-indigo-400");
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => el.classList.remove("ring-2", "ring-indigo-400"), 1100);
  };
  const expand = async (row, qid, jumpCard) => {
    row.classList.add("open"); row.classList.add("bg-black/[0.02]");
    openSet.add(qid);
    const det = row.nextElementSibling;
    if (det && det.classList.contains("ph-detail")) det.hidden = false;
    if (!cardCache.has(qid)) {
      try { await loadCard(qid); } catch (_) { const b = det && det.querySelector(".ph-detail-body"); if (b) b.innerHTML = `<div class="text-rose-600 text-xs py-3">Couldn't load project detail.</div>`; return; }
    }
    renderDetailInto(qid);
    if (jumpCard) requestAnimationFrame(() => pulseCard(qid, jumpCard));
  };
  const collapse = (row, qid) => {
    row.classList.remove("open"); row.classList.remove("bg-black/[0.02]");
    openSet.delete(qid);
    const det = row.nextElementSibling;
    if (det && det.classList.contains("ph-detail")) det.hidden = true;
  };

  listEl.addEventListener("click", (e) => {
    // keep the "Open project workspace" / tab links behaving as navigation
    const open = e.target.closest("a.ph-open, a.ph-tablink, a[href^='#/entity/project/']");
    if (open) {
      setBack(decodeURIComponent(open.getAttribute("href").split("/").pop()));
      saveHubState();
      const tab = open.getAttribute("data-tab");
      if (tab) { try { sessionStorage.setItem("opi_entity_tab", tab); } catch (_) {} }
      return;
    }
    // clicking a detail card opens the project workspace at that card's tab
    const card = e.target.closest(".ph-card[data-open-tab]");
    if (card) {
      saveHubState();
      const detRow = card.closest("tr.ph-detail");
      const qid = detRow && detRow.getAttribute("data-qid");
      const tab = card.getAttribute("data-open-tab");
      if (qid) { setBack(qid); try { sessionStorage.setItem("opi_entity_tab", tab); } catch (_) {} location.hash = `#/entity/project/${qid}`; }
      return;
    }
    const row = e.target.closest("tr.ph-row");
    if (!row) return;
    const qid = row.getAttribute("data-qid");
    const flag = e.target.closest(".ph-flag");
    if (flag) { // always open + jump; never collapse
      if (!row.classList.contains("open")) expand(row, qid, flag.getAttribute("data-card"));
      else { if (cardCache.has(qid)) requestAnimationFrame(() => pulseCard(qid, flag.getAttribute("data-card"))); }
      return;
    }
    if (row.classList.contains("open")) collapse(row, qid);
    else expand(row, qid);
  });

  // Load the project list first (fast); merge financials + attention when ready.
  try {
    const d = await api("/projects/basic");
    all = d.projects || [];
  } catch (e) {
    listEl.innerHTML = `<div class="text-red-700 text-sm">Failed to load projects.</div>`;
    return;
  }
  renderFilters();
  renderList();
  sizeCard();
  requestAnimationFrame(sizeCard);

  // Restore expanded rows (load their cards) from a prior visit; keep the target
  // scroll around so it survives the financials/attention re-renders below.
  let pendingScroll = (restore && restore.scroll) || 0;
  const applyScroll = () => { if (pendingScroll) { try { listEl.scrollTop = pendingScroll; } catch (_) {} } };
  if (openSet.size) {
    for (const qid of openSet) {
      try { await loadCard(qid); renderDetailInto(qid); } catch (_) {}
    }
  }
  applyScroll();
  listEl.addEventListener("wheel", () => { pendingScroll = 0; }, { once: true, passive: true });

  api("/projects/financials")
    .then((d) => { finById = new Map((d.financials || []).map((f) => [f.qbo_customer_id, f])); renderList(); applyScroll(); })
    .catch(() => {});
  api("/projects/attention")
    .then((d) => { attById = new Map(Object.entries(d.attention || {})); renderList(); applyScroll(); })
    .catch(() => {});
}
