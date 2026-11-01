// Progress Checks: are a job's financials moving with the job? Every project gets
// checkpoints at 25, 50, 75 and 100 percent of its scheduled days. Large jobs (or any
// job switched on) also need a sign-off at each one.
//
// The second tab holds costs the app knows about before QuickBooks does: receipts,
// typed entries, and bills or card charges with no job. They count toward the job
// until the real line reaches QuickBooks, then clear by themselves.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { fmtMoney } from "../utils/format.js";
import { escapeHtml } from "../utils/html.js";
import { openDocViewer } from "../utils/doc-viewer.js";
import { openFinancialExport } from "../utils/financial-export.js";
import { openProjectDrawer } from "../utils/project-drawer.js";

const day = (s) => s ? new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" }) : "—";
const money0 = (n) => `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n || 0)).toLocaleString()}`;
const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const chip = (txt, cls, title = "") => `<span class="inline-flex items-center text-[10px] font-bold rounded px-1.5 py-0.5 border whitespace-nowrap ${cls}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(txt)}</span>`;
const C = {
  bad: "text-rose-700 bg-rose-50 border-rose-200",
  warn: "text-amber-700 bg-amber-50 border-amber-200",
  good: "text-emerald-700 bg-emerald-50 border-emerald-200",
  info: "text-sky-700 bg-sky-50 border-sky-200",
  quiet: "text-slate-600 bg-slate-100 border-black/10",
};
const STATUS = {
  over: ["Over budget", C.bad, "Known cost is above the estimate plus pending estimates."],
  ahead: ["Ahead of plan", C.warn, "More has been spent than planned by now."],
  behind: ["Behind plan", C.info, "Less is recorded than planned by now. Often it just isn't in QuickBooks yet."],
  ok: ["On plan", C.good, ""],
};
const CONF = {
  high: ["Reliable", "Most of this cost reaches the job in QuickBooks."],
  medium: ["Fair", "Some of this cost never gets a job tag."],
  low: ["Weak", "Much of this cost never gets a job tag, so a low number proves little."],
  unknown: ["Unknown", "Not measured yet."],
};
const stChip = (s) => { const [l, c, t] = STATUS[s] || STATUS.ok; return chip(l, c, t); };

export async function progressPage(routeFn) {
  const st = { tab: "jobs", data: null, costs: null, q: "", pm: "", state: "active", only: "", open: null };
  setShell({
    title: "Progress Checks",
    subtitle: "Whether each job's invoices, crew pay and costs are moving with the work, at 25, 50, 75 and 100 percent.",
    bodyHtml: `<div id="prRoot"><div class="card p-6 text-sm text-black/45">Loading progress checks…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("prRoot");

  async function load() {
    try {
      st.data = await api("/progress");
      render();
      if (st.data.snapshot?.refreshing) setTimeout(load, 8000);
    } catch (e) {
      root.innerHTML = `<div class="card p-6 text-sm text-red-700">Couldn't load progress checks: ${escapeHtml(e?.message || String(e))}</div>`;
    }
  }
  async function loadCosts() {
    try { st.costs = await api("/receipts/open"); render(); }
    catch (e) { st.costs = { error: e?.message || String(e) }; render(); }
  }

  const visible = () => st.data.jobs.filter((j) => {
    if (st.state && j.state !== st.state) return false;
    if (st.pm && (j.pm || "") !== st.pm) return false;
    if (st.only === "due" && !j.signoffs_due) return false;
    if (st.only === "signoff" && !j.signoff_required) return false;
    if (st.only === "flag" && j.status === "ok") return false;
    if (st.q && !j.name.toLowerCase().includes(st.q.toLowerCase())) return false;
    return true;
  });

  // The job's time bar, with a tick per checkpoint.
  function timeBar(j) {
    const ticks = j.points.map((p) => {
      const col = !p.reached ? "#94a3b8" : p.signoff ? (p.signoff.decision === "hold" ? "#be123c" : "#047857") : p.due ? "#b45309" : "#475569";
      return `<div title="${p.milestone}%: ${day(p.date)}${p.signoff ? ` · ${p.signoff.decision === "hold" ? "on hold" : "signed off"} by ${p.signoff.by}` : p.due ? " · sign-off due" : ""}" style="position:absolute;left:${p.milestone}%;top:-3px;bottom:-3px;width:3px;margin-left:-2px;background:${col};border-radius:1px"></div>`;
    }).join("");
    return `<div style="position:relative;height:8px;min-width:150px;background:rgba(0,0,0,.07);border-radius:4px" role="img" aria-label="${pct(j.pct_time)} of the scheduled days have passed">
      <div style="position:absolute;left:0;top:0;bottom:0;width:${(j.pct_time || 0) * 100}%;background:#0284c7;opacity:.7;border-radius:4px"></div>${ticks}</div>`;
  }

  function pctCell(v, time) {
    if (v == null) return `<span class="text-black/35">—</span>`;
    const off = time != null && Math.abs(v - time) > 0.25;
    return `<span class="${off ? "font-bold" : ""}" title="${off ? "More than 25 points away from the share of days passed" : ""}">${pct(v)}</span>`;
  }

  function bucketTable(j) {
    return `<div class="overflow-x-auto"><table class="w-full text-sm">
      <thead><tr class="text-[11px] uppercase tracking-wide text-black/45"><th class="py-1.5 pr-3 text-left">Cost</th>
        <th class="py-1.5 pr-3 text-right" title="Accepted estimates">Budget</th><th class="py-1.5 pr-3 text-right" title="Pending estimates, shown beside the budget">Pending</th>
        <th class="py-1.5 pr-3 text-right" title="Planned by now, allowing for how long this cost takes to reach QuickBooks">Planned by now</th>
        <th class="py-1.5 pr-3 text-right">QuickBooks</th><th class="py-1.5 pr-3 text-right" title="Receipts and entries not in QuickBooks yet">Not in QB yet</th>
        <th class="py-1.5 pr-3 text-left">Status</th><th class="py-1.5 text-left" title="How much of this cost type reaches a job in QuickBooks">Data</th></tr></thead>
      <tbody>${j.buckets.map((b) => `<tr class="border-t border-black/[0.06]">
        <td class="py-1.5 pr-3 font-semibold">${escapeHtml(b.bucket)}</td>
        <td class="py-1.5 pr-3 text-right tabular-nums">${money0(b.budget)}</td>
        <td class="py-1.5 pr-3 text-right tabular-nums text-black/55">${b.pending ? money0(b.pending) : ""}</td>
        <td class="py-1.5 pr-3 text-right tabular-nums">${money0(b.planned)}</td>
        <td class="py-1.5 pr-3 text-right tabular-nums font-semibold">${money0(b.actual)}</td>
        <td class="py-1.5 pr-3 text-right tabular-nums">${b.entries ? money0(b.entries) : ""}</td>
        <td class="py-1.5 pr-3">${stChip(b.status)}</td>
        <td class="py-1.5 text-xs text-black/55" title="${escapeHtml(`${CONF[b.confidence][1]}${b.tagged_share != null ? ` ${pct(b.tagged_share)} tagged to a job, about ${Math.round(b.entry_lag_days || 0)} days to entry.` : ""}`)}">${CONF[b.confidence][0]}</td></tr>`).join("")}
        <tr class="border-t border-black/[0.06]"><td class="py-1.5 pr-3 font-semibold">Invoiced</td><td class="py-1.5 pr-3 text-right tabular-nums">${money0(j.contract)}</td>
          <td class="py-1.5 pr-3 text-right tabular-nums text-black/55">${j.pending_contract ? money0(j.pending_contract) : ""}</td>
          <td class="py-1.5 pr-3 text-right tabular-nums">${money0(j.invoice_planned)}</td><td class="py-1.5 pr-3 text-right tabular-nums font-semibold">${money0(j.invoiced)}</td><td></td>
          <td class="py-1.5 pr-3" colspan="2">${j.open_ar ? `<span class="text-xs text-black/55">${money0(j.open_ar)} not collected</span>` : ""}</td></tr>
      </tbody></table></div>`;
  }

  function checkpoint(j, p) {
    const can = st.data.can_sign;
    const rows = p.checks.map((c) => `<tr class="border-t border-black/[0.05]"><td class="py-1 pr-2">${escapeHtml(c.bucket)}</td><td class="py-1 pr-2 text-right tabular-nums">${money0(c.planned)}</td><td class="py-1 pr-2 text-right tabular-nums">${money0(c.actual)}</td><td class="py-1 text-right">${c.status ? stChip(c.status) : ""}</td></tr>`).join("");
    const s = p.signoff;
    return `<div class="rounded-lg border border-black/10 p-3 bg-white" style="min-width:0">
      <div class="flex items-center justify-between gap-2"><div class="font-bold text-sm">${p.milestone}%</div><div class="text-xs text-black/50">${day(p.date)}</div></div>
      ${p.reached ? "" : `<div class="text-xs text-black/45 mt-1">Not reached yet</div>`}
      ${p.settling ? `<div class="text-[11px] text-sky-700 mt-1">Bills from this period are still arriving.</div>` : ""}
      ${rows ? `<div class="overflow-x-auto mt-1"><table class="w-full text-xs"><thead><tr class="text-[10px] uppercase tracking-wide text-black/40"><th class="py-1 pr-2 text-left"></th><th class="py-1 pr-2 text-right">Planned</th><th class="py-1 pr-2 text-right">Actual</th><th></th></tr></thead><tbody>${rows}
        <tr class="border-t border-black/[0.05]"><td class="py-1 pr-2">Invoiced</td><td class="py-1 pr-2 text-right tabular-nums">${money0(p.invoice_planned)}</td><td class="py-1 pr-2 text-right tabular-nums">${money0(p.invoiced)}</td><td></td></tr></tbody></table></div>` : ""}
      ${s ? `<div class="text-xs mt-2">${chip(s.decision === "hold" ? "On hold" : "Signed off", s.decision === "hold" ? C.bad : C.good)} <span class="text-black/50">${escapeHtml(s.by || "")} ${day(s.at)}${s.note ? ` · ${escapeHtml(s.note)}` : ""}</span>${can ? ` <button class="text-[11px] text-sky-700 hover:underline" data-sign="" data-m="${p.milestone}" data-id="${j.id}">Undo</button>` : ""}</div>`
        : p.reached && j.signoff_required ? (can ? `<div class="flex gap-2 mt-2"><button class="btn-primary text-xs" data-sign="approved" data-m="${p.milestone}" data-id="${j.id}">Sign off</button><button class="pd-btn" data-sign="hold" data-m="${p.milestone}" data-id="${j.id}">Hold</button></div>` : `<div class="mt-2">${chip("Sign-off due", C.warn)}</div>`) : ""}
    </div>`;
  }

  function detail(j) {
    const can = st.data.can_sign;
    const sw = j.signoff_switch;
    return `<div class="bg-slate-50 p-4 grid gap-3">
      <div class="flex flex-wrap items-center gap-2 justify-between">
        <div class="text-xs text-black/55">${day(j.start)} to ${day(j.end)} · Contract ${money0(j.contract)}${j.pending_contract ? ` · ${money0(j.pending_contract)} pending` : ""}</div>
        <div class="flex flex-wrap items-center gap-2">
          ${can ? `<label class="text-xs text-black/55">Sign-offs <select class="input text-xs" style="width:auto" data-switch="${j.id}">
            <option value=""${sw === null ? " selected" : ""}>By size (${j.by_size ? "on" : "off"})</option>
            <option value="1"${sw === true ? " selected" : ""}>On</option><option value="0"${sw === false ? " selected" : ""}>Off</option></select></label>`
            : `<span class="text-xs text-black/55">Sign-offs ${j.signoff_required ? "on" : "off"}</span>`}
          <button class="pd-btn" data-billing="${j.id}" data-name="${escapeHtml(j.name)}">Open Billing &amp; Schedule</button>
        </div>
      </div>
      ${bucketTable(j)}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px">${j.points.map((p) => checkpoint(j, p)).join("")}</div>
    </div>`;
  }

  function jobsTab() {
    const d = st.data, jobs = visible();
    const pms = [...new Set(d.jobs.map((j) => j.pm).filter(Boolean))].sort();
    const due = d.jobs.reduce((s, j) => s + j.signoffs_due, 0);
    const req = d.jobs.filter((j) => j.signoff_required && j.state === "active").length;
    const flagged = d.jobs.filter((j) => j.state === "active" && j.status !== "ok").length;
    const active = d.jobs.filter((j) => j.state === "active").length;
    const t = (l, v, n) => `<div class="card p-4"><div class="text-[11px] uppercase tracking-wide text-black/45 font-bold">${l}</div><div class="text-2xl font-extrabold tabular-nums mt-1">${v}</div><div class="text-xs text-black/50 mt-0.5">${n}</div></div>`;
    return `<div class="grid gap-3">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
        ${t("Jobs in progress", active, `${flagged} with something off plan`)}
        ${t("Sign-offs due", due, `Across ${d.jobs.filter((j) => j.signoffs_due).length} jobs`)}
        ${t("Jobs needing sign-off", req, `${money0(d.rules.signoff_min)} and up, plus any switched on`)}
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <input id="prQ" class="input text-sm" style="width:220px" placeholder="Search jobs" value="${escapeHtml(st.q)}">
        <select id="prState" class="input text-sm" style="width:auto">${[["active", "In progress"], ["upcoming", "Not started"], ["finished", "Finished (6 months)"], ["", "All"]].map(([k, l]) => `<option value="${k}"${st.state === k ? " selected" : ""}>${l}</option>`).join("")}</select>
        <select id="prPm" class="input text-sm" style="width:auto"><option value="">All PMs</option>${pms.map((p) => `<option${p === st.pm ? " selected" : ""}>${escapeHtml(p)}</option>`).join("")}</select>
        <select id="prOnly" class="input text-sm" style="width:auto">${[["", "All jobs"], ["due", "Sign-off due"], ["signoff", "Needs sign-off"], ["flag", "Off plan"]].map(([k, l]) => `<option value="${k}"${st.only === k ? " selected" : ""}>${l}</option>`).join("")}</select>
      </div>
      <section class="card overflow-hidden"><div class="overflow-x-auto"><table class="w-full text-sm">
        <thead><tr class="text-[11px] uppercase tracking-wide text-black/45"><th class="py-2 px-3 text-left">Job</th><th class="py-2 pr-3 text-right">Contract</th><th class="py-2 pr-3 text-left">Days passed</th>
          <th class="py-2 pr-3 text-right" title="Share of contract invoiced">Invoiced</th><th class="py-2 pr-3 text-right" title="Crew labor paid, share of estimate plus pending">Labor</th><th class="py-2 pr-3 text-right" title="All known cost, share of estimate plus pending">Cost</th><th class="py-2 pr-3 text-left">Status</th><th class="py-2 pr-3 text-left">Sign-off</th></tr></thead>
        <tbody>${jobs.map((j) => {
          const open = st.open === j.id;
          return `<tr class="border-t border-black/[0.06] cursor-pointer hover:bg-black/[0.02]${open ? " bg-sky-50" : ""}" data-row="${j.id}" tabindex="0" aria-expanded="${open}">
            <td class="py-2 px-3"><div class="font-semibold">${escapeHtml(j.name)}</div><div class="text-[11px] text-black/45">${escapeHtml(j.pm || "No PM")}</div></td>
            <td class="py-2 pr-3 text-right tabular-nums">${money0(j.contract)}</td>
            <td class="py-2 pr-3">${timeBar(j)}<div class="text-[10px] text-black/45 mt-1">${pct(j.pct_time)}</div></td>
            <td class="py-2 pr-3 text-right tabular-nums">${pctCell(j.pct_invoiced, j.pct_time)}</td>
            <td class="py-2 pr-3 text-right tabular-nums">${pctCell(j.pct_labor, j.pct_time)}</td>
            <td class="py-2 pr-3 text-right tabular-nums">${pctCell(j.pct_cost, j.pct_time)}</td>
            <td class="py-2 pr-3">${stChip(j.status)}</td>
            <td class="py-2 pr-3">${j.signoffs_due ? chip(`${j.signoffs_due} due`, C.warn) : j.signoff_required ? chip("Up to date", C.good) : `<span class="text-xs text-black/35">Off</span>`}</td></tr>
            ${open ? `<tr><td colspan="8" class="p-0">${detail(j)}</td></tr>` : ""}`;
        }).join("") || `<tr><td colspan="8" class="py-4 px-3 text-black/45">No jobs with these filters.</td></tr>`}</tbody></table></div></section>
      <p class="text-xs text-black/50" style="max-width:52rem">Each cost is compared to the job's own plan, not a straight line: crew labor to the Payment Schedule, other costs to the expense schedule, moved back by how long that cost takes to reach QuickBooks. Budget tolerances are on the <a class="text-sky-700 hover:underline" href="#/assumptions">Assumptions</a> page, with the table of how each cost reaches QuickBooks.</p>
    </div>`;
  }

  function costsTab() {
    const c = st.costs;
    if (!c) return `<div class="card p-6 text-sm text-black/45">Loading…</div>`;
    if (c.error) return `<div class="card p-6 text-sm text-red-700">Couldn't load costs: ${escapeHtml(c.error)}</div>`;
    const jobOpts = c.jobs.map((j) => `<option value="${escapeHtml(j.id)}">${escapeHtml(j.name)}</option>`).join("");
    const by = (r) => r.submitted_by?.crew_name || r.submitted_by?.user || r.submitted_by?.email || "";
    const SRC = { receipt: "Receipt", manual: "Typed in", card: "Card charge" };
    const today = new Date().toISOString().slice(0, 10);
    return `<div class="grid gap-3">
      <div class="card p-4 text-sm text-black/65" style="max-width:60rem">Anything here counts toward the job right away. When the matching bill or charge reaches QuickBooks, the entry clears by itself, so nothing is counted twice. ${c.cleared_30d ? `<b>${c.cleared_30d}</b> cleared in the last 30 days.` : ""}</div>
      <section class="card p-4">
        <h2 class="text-sm font-bold">Add a cost that isn't in QuickBooks yet</h2>
        <p class="text-xs text-black/55 mt-0.5">A lift booked, a hotel block, a material order. Crews and PMs add receipts with a photo from their portals.</p>
        <form id="prAdd" class="mt-2" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;align-items:end">
          <label class="text-xs grid gap-1" style="grid-column:span 2;min-width:0"><span class="text-black/55">Job</span><select name="project_qbo_id" required class="input text-sm"><option value="">Choose a job</option>${jobOpts}</select></label>
          <label class="text-xs grid gap-1"><span class="text-black/55">Type</span><select name="category" class="input text-sm">${c.categories.map(([k, l]) => `<option value="${k}">${escapeHtml(l)}</option>`).join("")}</select></label>
          <label class="text-xs grid gap-1"><span class="text-black/55">Amount</span><input name="amount" required type="number" min="0.01" step="0.01" class="input text-sm tabular-nums"></label>
          <label class="text-xs grid gap-1"><span class="text-black/55">Vendor</span><input name="vendor" maxlength="200" class="input text-sm"></label>
          <label class="text-xs grid gap-1"><span class="text-black/55">Date of charge</span><input name="entry_date" type="date" value="${today}" class="input text-sm"></label>
          <label class="text-xs grid gap-1" style="grid-column:span 2;min-width:0"><span class="text-black/55">Note</span><input name="notes" maxlength="500" class="input text-sm"></label>
          <button class="btn-primary text-sm" type="submit">Add cost</button>
        </form>
        <div id="prAddMsg" class="text-xs mt-2" aria-live="polite"></div>
      </section>
      <section class="card p-4">
        <div class="flex flex-wrap justify-between gap-2"><h2 class="text-sm font-bold">Waiting on QuickBooks</h2><div class="text-xs text-black/55 tabular-nums">${c.entries.length} entries · ${fmtMoney(c.total)}</div></div>
        <div class="overflow-x-auto mt-2"><table class="w-full text-sm"><thead><tr class="text-[11px] uppercase tracking-wide text-black/45"><th class="py-1.5 pr-3 text-left">Date</th><th class="py-1.5 pr-3 text-left">Job</th><th class="py-1.5 pr-3 text-left">Type</th><th class="py-1.5 pr-3 text-left">Vendor</th><th class="py-1.5 pr-3 text-left">From</th><th class="py-1.5 pr-3 text-right">Amount</th><th></th></tr></thead>
        <tbody>${c.entries.map((r) => `<tr class="border-t border-black/[0.06] align-top">
          <td class="py-1.5 pr-3 whitespace-nowrap tabular-nums">${day(r.receipt_date || r.created_at)}</td>
          <td class="py-1.5 pr-3">${escapeHtml(r.job || "")}${r.matched_how === "found" ? `<div class="mt-0.5">${chip("Found on a card or bill, needs its job tag", C.warn)}</div>` : ""}${r.charged_back ? `<div class="mt-0.5">${chip("Needs a change order", C.bad)}</div>` : ""}</td>
          <td class="py-1.5 pr-3">${escapeHtml(r.category_label)}</td><td class="py-1.5 pr-3">${escapeHtml(r.vendor || "")}</td>
          <td class="py-1.5 pr-3 text-xs text-black/55">${escapeHtml(SRC[r.source] || r.source || "")}${by(r) ? ` · ${escapeHtml(by(r))}` : ""}</td>
          <td class="py-1.5 pr-3 text-right tabular-nums font-semibold">${r.amount != null ? fmtMoney(r.amount) : ""}</td>
          <td class="py-1.5 text-right whitespace-nowrap">${r.document_id ? `<button class="pd-btn" data-doc="${r.document_id}" data-fn="${escapeHtml(r.filename || "Receipt")}">View</button>` : ""}${r.source !== "receipt" ? ` <button class="pd-btn" data-del="${r.id}">Remove</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="7" class="py-3 text-black/45">Nothing waiting. Costs added here, or from the crew and PM portals, show up until QuickBooks has them.</td></tr>`}</tbody></table></div>
      </section>
      <section class="card p-4">
        <div class="flex flex-wrap justify-between gap-2"><div><h2 class="text-sm font-bold">Charges with no job</h2><p class="text-xs text-black/55 mt-0.5">Bills and card charges from the last 90 days that look like job costs but have no job in QuickBooks. Pick the job here and it counts right away. QuickBooks isn't changed: it stays on this list for Ashley and Julie until the charge is tagged there.</p></div><div class="text-xs text-black/55 tabular-nums whitespace-nowrap">${c.charges.length} charges · ${fmtMoney(c.charges_total)}</div></div>
        <div class="overflow-x-auto mt-2"><table class="w-full text-sm"><thead><tr class="text-[11px] uppercase tracking-wide text-black/45"><th class="py-1.5 pr-3 text-left">Date</th><th class="py-1.5 pr-3 text-left">Vendor</th><th class="py-1.5 pr-3 text-left">Type</th><th class="py-1.5 pr-3 text-left">Description</th><th class="py-1.5 pr-3 text-right">Amount</th><th class="py-1.5 text-left">Job</th></tr></thead>
        <tbody>${c.charges.slice(0, 200).map((x) => `<tr class="border-t border-black/[0.06] align-top">
          <td class="py-1.5 pr-3 whitespace-nowrap tabular-nums">${day(x.date)}</td><td class="py-1.5 pr-3">${escapeHtml(x.vendor)}<div class="text-[11px] text-black/45">${escapeHtml(x.type)}${x.doc ? ` ${escapeHtml(x.doc)}` : ""}</div></td>
          <td class="py-1.5 pr-3">${escapeHtml(x.category)}</td><td class="py-1.5 pr-3 text-xs text-black/55">${escapeHtml(x.description || x.item || "")}</td>
          <td class="py-1.5 pr-3 text-right tabular-nums font-semibold">${fmtMoney(x.amount)}</td>
          <td class="py-1.5"><select class="input text-xs" style="max-width:220px" data-tag="${x.line_id}"><option value="">${x.suggested ? `Receipt says: ${escapeHtml(x.suggested.name)}` : "Choose a job"}</option>${x.suggested ? `<option value="${escapeHtml(x.suggested.entity_id)}">Confirm ${escapeHtml(x.suggested.name)}</option>` : ""}${jobOpts}</select></td></tr>`).join("") || `<tr><td colspan="6" class="py-3 text-black/45">No untagged charges in the last 90 days.</td></tr>`}</tbody></table></div>
        ${c.charges.length > 200 ? `<div class="text-xs text-black/50 mt-2">Showing the newest 200.</div>` : ""}
      </section></div>`;
  }

  function render() {
    root.innerHTML = `<div class="grid gap-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="inline-flex rounded-lg border border-black/10 overflow-hidden text-sm" role="tablist">
          ${[["jobs", "Jobs"], ["costs", "Costs not in QuickBooks yet"]].map(([k, l]) => `<button role="tab" aria-selected="${st.tab === k}" data-tab="${k}" class="px-3 py-2 font-semibold ${st.tab === k ? "bg-ink-900 text-white" : "bg-white text-black/60 hover:bg-slate-200 hover:text-ink-900"}">${l}</button>`).join("")}
        </div>
        <button class="pd-btn" id="prExport">Export to Excel</button>
      </div>
      ${st.tab === "jobs" ? jobsTab() : costsTab()}</div>`;
    if (st.focus) { const el = document.getElementById(st.focus); if (el) { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); } }
  }

  root.addEventListener("input", (ev) => {
    if (ev.target.id === "prQ") { st.q = ev.target.value; st.focus = "prQ"; render(); }
  });
  root.addEventListener("change", async (ev) => {
    const t = ev.target;
    st.focus = null;
    if (t.id === "prPm") st.pm = t.value; else if (t.id === "prState") st.state = t.value; else if (t.id === "prOnly") st.only = t.value;
    else if (t.dataset.switch) {
      const v = t.value === "" ? null : t.value === "1";
      try { await api(`/progress/${encodeURIComponent(t.dataset.switch)}/settings`, { method: "POST", body: JSON.stringify({ signoff: v }) }); await load(); }
      catch (e) { alert(`Couldn't save: ${e?.message || e}`); }
      return;
    } else if (t.dataset.tag) {
      if (!t.value) return;
      try { await api("/receipts/tag-charge", { method: "POST", body: JSON.stringify({ line_id: Number(t.dataset.tag), project_qbo_id: t.value }) }); await Promise.all([loadCosts(), load()]); }
      catch (e) { alert(`Couldn't save: ${e?.message || e}`); }
      return;
    } else return;
    render();
  });
  root.addEventListener("submit", async (ev) => {
    if (ev.target.id !== "prAdd") return;
    ev.preventDefault();
    const f = new FormData(ev.target);
    const body = Object.fromEntries(f.entries());
    body.amount = Number(body.amount);
    try {
      await api("/receipts/manual", { method: "POST", body: JSON.stringify(body) });
      await Promise.all([loadCosts(), load()]);
      const m = document.getElementById("prAddMsg");
      if (m) { m.className = "text-xs mt-2 text-emerald-700"; m.textContent = `Added ${fmtMoney(body.amount)}. It counts toward the job now.`; }
    } catch (e) {
      const m = document.getElementById("prAddMsg");
      if (m) { m.className = "text-xs mt-2 text-red-700"; m.textContent = `Couldn't add it: ${e?.message || e}`; }
    }
  });
  root.addEventListener("click", async (ev) => {
    const t = ev.target.closest("button,tr[data-row]");
    if (!t) return;
    st.focus = null;
    if (t.id === "prExport") { openFinancialExport({ pm: st.pm, status: st.state ? [st.state] : undefined }); return; }
    if (t.dataset.tab) { st.tab = t.dataset.tab; if (t.dataset.tab === "costs") loadCosts(); render(); return; }
    if (t.dataset.billing) { openProjectDrawer({ entityId: t.dataset.billing, name: t.dataset.name, onChange: () => load(), backLabel: "Progress Checks", backHash: "#/progress" }); return; }
    if (t.dataset.doc) { openDocViewer({ id: Number(t.dataset.doc), filename: t.dataset.fn }); return; }
    if (t.dataset.del) {
      if (!confirm("Remove this entry?")) return;
      await api(`/receipts/${t.dataset.del}`, { method: "DELETE" });
      await Promise.all([loadCosts(), load()]);
      return;
    }
    if ("sign" in t.dataset) {
      const decision = t.dataset.sign || null;
      let note = null;
      if (decision === "hold") { note = prompt("Why is this on hold?"); if (!note) return; }
      else if (decision) note = prompt("Add a note (optional)") ?? null;
      try { await api(`/progress/${encodeURIComponent(t.dataset.id)}/signoff`, { method: "POST", body: JSON.stringify({ milestone: Number(t.dataset.m), decision, note }) }); await load(); }
      catch (e) { alert(`Couldn't save: ${e?.message || e}`); }
      return;
    }
    if (t.dataset.row) { st.open = st.open === t.dataset.row ? null : t.dataset.row; render(); }
  });
  root.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && ev.target.dataset?.row) { st.open = st.open === ev.target.dataset.row ? null : ev.target.dataset.row; render(); }
  });

  await load();
}
