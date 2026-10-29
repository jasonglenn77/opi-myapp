// Overview — the company-wide view for owners and the office.
//
//   Money tiles   crew pay and expenses coming due, what's past due (from the
//                 Project Money schedule), and open Data Review items.
//   Job cost vs estimate   per cost category (crew labor, lifts, materials,
//                 lodging, ...): estimated vs actual dollars, actual/estimate,
//                 the typical job, how many jobs ran over and by how much, jobs
//                 with no cost recorded, and cost with no estimate line.
//                 Click a category -> its jobs; click a job -> the estimate
//                 lines and QuickBooks bills behind the numbers.
// Definitions (finished job, "over") are on the Assumptions page.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { fmtMoney } from "../utils/format.js";
import { escapeHtml } from "../utils/html.js";

const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const k = (n) => Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : `$${Math.round(n)}`;
const day = (s) => s ? new Date(`${s}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" }) : "—";
const PREF = "opi_overview_prefs";
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF) || "{}"); } catch (_) { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch (_) {} };

export async function overviewPage(routeFn) {
  const pf = loadPrefs();
  const st = { scope: pf.scope || "finished", months: pf.months ?? 12, sum: null, money: null, review: null,
               openCat: null, catJobs: {}, filter: "all", showAll: false, openJob: null, jobDetail: {} };
  setShell({
    title: "Overview",
    subtitle: "Company-wide: money coming due, job cost against estimate, and records that need attention.",
    bodyHtml: `<div id="ovRoot" class="grid" style="grid-template-columns:minmax(0,1fr);gap:20px"><div class="card p-6 text-sm text-black/45">Loading…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("ovRoot");
  const qs = () => `scope=${st.scope}&months=${st.scope === "active" ? 0 : st.months}`;

  // ---- money + review tiles --------------------------------------------------
  function tiles() {
    const m = st.money;
    const tile = (href, label, val, sub, tone = "") => `<a href="${href}" class="card p-4 block hover:shadow-md transition-shadow">
      <div class="text-[11px] uppercase tracking-wide text-black/45">${label}</div>
      <div class="text-xl font-bold tabular-nums mt-1 ${tone}">${val}</div><div class="text-xs text-black/50 mt-0.5">${sub}</div></a>`;
    if (!m) return `<div class="card p-4 text-sm text-black/45">Loading money schedule…</div>`;
    const sum = (rows) => rows.reduce((a, r) => a + r.amount, 0);
    const addDays = (s, n) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const in4 = addDays(m.this_week_end, 21);
    const payday = m.planned.filter((r) => r.kind === "crew" && !r.overdue && r.date === m.next_payday);
    const crew4 = m.planned.filter((r) => r.kind === "crew" && !r.overdue && r.date <= in4);
    const exp4 = m.planned.filter((r) => r.kind === "expense" && !r.overdue && r.date <= in4);
    const late = m.planned.filter((r) => r.overdue);
    const rv = st.review;
    const openRv = rv ? rv.items.filter((i) => i.state === "open") : null;
    return `<div class="grid gap-3" style="grid-template-columns:repeat(auto-fit,minmax(190px,1fr))">
      ${tile("#/money", `Next payday · ${day(m.next_payday)}`, fmtMoney(sum(payday)), `${payday.length} crew payments`)}
      ${tile("#/money", "Crew pay, next 4 weeks", fmtMoney(sum(crew4)), `${new Set(crew4.map((r) => r.entity_id)).size} projects`)}
      ${tile("#/money", "Expenses, next 4 weeks", fmtMoney(sum(exp4)), "planned, not yet billed")}
      ${tile("#/money", "Past due", fmtMoney(sum(late)), `${late.length} planned payments or bills`, late.length ? "text-rose-700" : "")}
      ${tile("#/review", "Data Review", openRv ? openRv.length.toLocaleString() : "…", openRv ? "open items where records disagree" : "checking…", openRv?.length ? "text-amber-700" : "")}
    </div>`;
  }

  // ---- job cost --------------------------------------------------------------
  // Each bar is scaled to its own estimate (the dark tick = 100%, the bar runs
  // to 150%), so a small category reads as clearly as crew labor.
  function barCell(r) {
    const ratio = r.ratio ?? 0, CAP = 1.5;
    const over = ratio > 1;
    return `<div class="relative h-4 rounded bg-black/[0.05]" style="min-width:140px" title="Estimate ${fmtMoney(r.estimated)} · Actual ${fmtMoney(r.actual)} (${pct(r.ratio)})">
      <div class="absolute left-0 rounded" style="top:0;bottom:0;width:${(Math.min(ratio, CAP) / CAP) * 100}%;background:${over ? "#e11d48" : "#0284c7"};opacity:.75"></div>
      <div class="absolute" style="top:-2px;bottom:-2px;left:${100 / CAP}%;width:2px;margin-left:-1px;background:#0f172a"></div>
      ${ratio > CAP ? `<div class="absolute text-[9px] font-bold text-white" style="right:3px;top:0;line-height:16px">▶</div>` : ""}</div>`;
  }

  function costTable() {
    const s = st.sum;
    if (!s) return `<div class="text-sm text-black/45 py-4">Loading job cost…</div>`;
    const active = st.scope === "active";
    const th = (t, title = "") => `<th class="py-2 px-2 text-right whitespace-nowrap"${title ? ` title="${escapeHtml(title)}"` : ""}>${t}</th>`;
    return `<div class="overflow-x-auto"><table class="w-full text-sm">
      <thead><tr class="text-[11px] uppercase tracking-wide text-black/45">
        <th class="py-2 pr-3 text-left">Cost category</th>
        <th class="py-2 px-2 text-left">${active ? "Spent so far vs estimate" : "Actual vs estimate"}</th>
        ${th("Estimated")}${th(active ? "Spent so far" : "Actual")}${th(active ? "Spent / est." : "Actual / est.", "All jobs' actual dollars divided by all jobs' estimated dollars")}
        ${th("Typical job", "The median job's actual / estimate, so a few extreme jobs don't skew it")}
        ${th(`Jobs over ${Math.round(s.rules.over_pct * 100)}%`, "Jobs whose actual ran more than this above their estimate, and the dollars above estimate")}
        ${th("No cost recorded", "Jobs with an estimate for this category but no QuickBooks cost tagged to the job")}
        ${th("No estimate line", "Jobs with QuickBooks cost in this category but nothing estimated for it")}
      </tr></thead>
      <tbody>${s.categories.map((r) => {
        const open = st.openCat === r.category;
        const tone = r.ratio == null ? "" : r.ratio > 1 + s.rules.over_pct ? "text-rose-700" : (r.ratio > 1 || r.ratio < 0.8) ? "text-amber-700" : "text-emerald-700";
        return `<tr class="border-t border-black/[0.06] cursor-pointer hover:bg-black/[0.02]${open ? " bg-sky-50" : ""}" data-cat="${escapeHtml(r.category)}">
          <td class="py-2.5 pr-3 font-semibold whitespace-nowrap"><span class="text-black/35 mr-1">${open ? "▾" : "▸"}</span>${escapeHtml(r.category)}<div class="text-[11px] font-normal text-black/40 ml-4">${r.jobs} jobs</div></td>
          <td class="py-2.5 px-2">${barCell(r)}</td>
          <td class="py-2.5 px-2 text-right tabular-nums">${k(r.estimated)}</td>
          <td class="py-2.5 px-2 text-right tabular-nums">${k(r.actual)}</td>
          <td class="py-2.5 px-2 text-right tabular-nums font-bold ${active ? "" : tone}">${pct(r.ratio)}</td>
          <td class="py-2.5 px-2 text-right tabular-nums">${pct(r.typical)}</td>
          <td class="py-2.5 px-2 text-right tabular-nums whitespace-nowrap">${r.over_jobs ? `<span class="text-rose-700 font-semibold">${r.over_jobs}</span> <span class="text-black/45">· ${k(r.over_amount)}</span>` : "0"}</td>
          <td class="py-2.5 px-2 text-right tabular-nums">${r.zero_jobs ? `<span class="text-amber-700 font-semibold">${r.zero_jobs}</span>` : "0"}</td>
          <td class="py-2.5 px-2 text-right tabular-nums whitespace-nowrap">${r.unbudgeted_jobs ? `${r.unbudgeted_jobs} <span class="text-black/45">· ${k(r.unbudgeted_amount)}</span>` : "0"}</td>
        </tr>${open ? `<tr><td colspan="9" class="p-0">${catPanel(r)}</td></tr>` : ""}`;
      }).join("")}</tbody></table></div>`;
  }

  function catPanel(r) {
    const jobs = st.catJobs[`${qs()}|${r.category}`];
    if (!jobs) return `<div class="px-4 py-3 text-sm text-black/45">Loading jobs…</div>`;
    const active = st.scope === "active";
    const F = [["all", "All jobs", jobs.length], ["over", "Over estimate", jobs.filter((j) => j.flag === "over").length],
               ["zero", "No cost recorded", jobs.filter((j) => j.flag === "zero").length],
               ["unbudgeted", "No estimate line", jobs.filter((j) => j.flag === "unbudgeted").length]];
    const shown = jobs.filter((j) => st.filter === "all" || j.flag === st.filter);
    const list = st.showAll ? shown : shown.slice(0, 25);
    const flagChip = (f) => ({ over: `<span class="text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded px-1">Over</span>`,
      zero: `<span class="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1">No cost</span>`,
      unbudgeted: `<span class="text-[10px] font-bold text-slate-600 bg-slate-50 rounded px-1" style="border:1px solid #e2e8f0">No estimate</span>` }[f] || "");
    return `<div class="px-3 py-3" style="background:#f5fafe;border-top:1px solid #e0f2fe;border-bottom:1px solid #e0f2fe">
      <div class="flex flex-wrap items-center gap-2 mb-2">
        ${F.map(([v, l, n]) => `<button data-filter="${v}" class="text-xs px-2.5 py-1 rounded-full border ${st.filter === v ? "bg-ink-900 text-white border-ink-900" : "bg-white text-black/60 border-black/10"}">${l} · ${n}</button>`).join("")}
        <span class="text-xs text-black/45 ml-auto">Sorted by dollars over estimate. Click a job for the estimate lines and QuickBooks bills.</span>
      </div>
      <div class="overflow-x-auto"><table class="w-full text-sm bg-white rounded">
        <thead><tr class="text-[11px] uppercase tracking-wide text-black/45">
          <th class="py-1.5 px-2 text-left">Job</th><th class="py-1.5 px-2 text-left">PM</th><th class="py-1.5 px-2 text-left whitespace-nowrap">${active ? "Scheduled" : "Finished"}</th>
          <th class="py-1.5 px-2 text-right">Estimated</th><th class="py-1.5 px-2 text-right">${active ? "Spent" : "Actual"}</th>
          <th class="py-1.5 px-2 text-right">Difference</th><th class="py-1.5 px-2 text-right">%</th>
          ${active ? `<th class="py-1.5 px-2 text-right" title="Share of the scheduled days already past">Job done</th>` : ""}<th></th></tr></thead>
        <tbody>${list.map((j) => {
          const key = `${j.id}|${r.category}`, open = st.openJob === key;
          return `<tr class="border-t border-black/[0.05] cursor-pointer hover:bg-black/[0.02]" data-job="${escapeHtml(key)}">
            <td class="py-1.5 px-2"><span class="text-black/35 mr-1">${open ? "▾" : "▸"}</span><a href="#/entity/project/${encodeURIComponent(j.id)}" class="font-semibold hover:underline">${escapeHtml(j.name)}</a></td>
            <td class="py-1.5 px-2 text-black/55 whitespace-nowrap">${escapeHtml(j.pm || "—")}</td>
            <td class="py-1.5 px-2 text-black/55 tabular-nums whitespace-nowrap">${active ? `${day(j.start)} – ${day(j.end)}` : day(j.end)}</td>
            <td class="py-1.5 px-2 text-right tabular-nums">${fmtMoney(j.estimated)}</td>
            <td class="py-1.5 px-2 text-right tabular-nums">${fmtMoney(j.actual)}</td>
            <td class="py-1.5 px-2 text-right tabular-nums font-semibold ${j.variance > 0 ? "text-rose-700" : "text-black/50"}">${j.variance > 0 ? "+" : ""}${fmtMoney(j.variance)}</td>
            <td class="py-1.5 px-2 text-right tabular-nums">${pct(j.ratio)}</td>
            ${active ? `<td class="py-1.5 px-2 text-right tabular-nums text-black/55">${pct(j.elapsed)}</td>` : ""}
            <td class="py-1.5 px-2 text-right">${flagChip(j.flag)}</td></tr>
            ${open ? `<tr><td colspan="${active ? 9 : 8}" class="px-2 pb-3">${jobPanel(key)}</td></tr>` : ""}`;
        }).join("") || `<tr><td colspan="9" class="py-3 px-2 text-black/45">No jobs in this group.</td></tr>`}</tbody></table></div>
      ${shown.length > 25 ? `<button data-showall class="mt-2 text-xs font-semibold text-sky-700 hover:underline">${st.showAll ? "Show top 25" : `Show all ${shown.length}`}</button>` : ""}
    </div>`;
  }

  // Rental bills carry the vendor's contract number plus a billing-cycle suffix
  // (Equipment Share WIL-5668109-0003, United 252113723-003). Grouping by
  // contract shows how long each unit was out and whether billing ran past the
  // job's scheduled end, i.e. whether it was called off on time.
  function rentalContracts(lines, jobEnd) {
    const groups = new Map();
    for (const r of lines) {
      const m = (r.doc || "").match(/^(.*\d)-(\d{1,4})$/);
      const id = m ? `${r.vendor}|${m[1]}` : `${r.vendor}|${r.doc || r.date}`;
      const g = groups.get(id) || { vendor: r.vendor, contract: m ? m[1] : (r.doc || "—"), bills: 0, first: r.date, last: r.date, total: 0 };
      g.bills += 1; g.total += r.amount;
      if (r.date < g.first) g.first = r.date;
      if (r.date > g.last) g.last = r.date;
      groups.set(id, g);
    }
    const rows = [...groups.values()].sort((a, b) => b.total - a.total);
    const late = (g) => jobEnd && g.last > jobEnd;
    return `<div class="min-w-0" style="grid-column:1/-1"><div class="text-[11px] uppercase tracking-wide text-black/45 mb-1">By rental contract · job scheduled to end ${day(jobEnd)}</div>
      <table class="w-full text-xs"><thead><tr class="text-[10px] uppercase tracking-wide text-black/40"><th class="py-1 pr-2 text-left">Vendor · contract</th>
        <th class="py-1 pr-2 text-right">Bills</th><th class="py-1 pr-2 text-left">First bill</th><th class="py-1 pr-2 text-left">Last bill</th><th class="py-1 text-right">Total</th></tr></thead>
      <tbody>${rows.map((g) => `<tr class="border-t border-black/[0.05]">
        <td class="py-1 pr-2">${escapeHtml(g.vendor)} <span class="text-black/40">#${escapeHtml(g.contract)}</span></td>
        <td class="py-1 pr-2 text-right tabular-nums">${g.bills}</td>
        <td class="py-1 pr-2 tabular-nums">${day(g.first)}</td>
        <td class="py-1 pr-2 tabular-nums ${late(g) ? "text-rose-700 font-semibold" : ""}"${late(g) ? ` title="Billed after the job's scheduled end"` : ""}>${day(g.last)}${late(g) ? ` · ${Math.round((new Date(`${g.last}T00:00:00`) - new Date(`${jobEnd}T00:00:00`)) / 864e5)} days after end` : ""}</td>
        <td class="py-1 text-right tabular-nums">${fmtMoney(g.total)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function jobPanel(key) {
    const d = st.jobDetail[key];
    if (!d) return `<div class="text-xs text-black/45 py-2">Loading…</div>`;
    const [jid, jcat] = key.split("|");
    const job = (st.catJobs[`${qs()}|${jcat}`] || []).find((j) => j.id === jid);
    const tot = (rows) => rows.reduce((a, r) => a + r.amount, 0);
    const list = (title, rows, cols) => `<div class="min-w-0"><div class="text-[11px] uppercase tracking-wide text-black/45 mb-1">${title} · ${fmtMoney(tot(rows))}</div>
      ${rows.length ? `<table class="w-full text-xs"><tbody>${rows.map(cols).join("")}</tbody></table>` : `<div class="text-xs text-black/40">None</div>`}</div>`;
    return `<div class="grid gap-4 pt-2" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">
      ${(jcat === "Lifts" || jcat === "Other rentals") && d.actual_lines.length ? rentalContracts(d.actual_lines, job?.end) : ""}
      ${list("Estimate lines (QuickBooks estimate)", d.estimate_lines, (r) => `<tr class="border-t border-black/[0.05]">
        <td class="py-1 pr-2 text-black/50">#${escapeHtml(r.doc || "")}</td><td class="py-1 pr-2">${escapeHtml(r.item || "")}${r.qty ? ` <span class="text-black/40">× ${r.qty}</span>` : ""}</td>
        <td class="py-1 text-right tabular-nums">${fmtMoney(r.amount)}</td></tr>`)}
      ${list("Recorded in QuickBooks", d.actual_lines, (r) => `<tr class="border-t border-black/[0.05]">
        <td class="py-1 pr-2 text-black/50 tabular-nums whitespace-nowrap">${day(r.date)}</td><td class="py-1 pr-2">${escapeHtml(r.vendor)} <span class="text-black/40">${r.type}${r.doc ? ` #${escapeHtml(r.doc)}` : ""}</span></td>
        <td class="py-1 text-right tabular-nums">${fmtMoney(r.amount)}</td></tr>`)}
      ${pendingCos(d.pending_change_orders || [], jcat, jid)}
    </div>`;
  }

  // Change orders not approved yet (Change Orders tab): not in the estimate above
  // until accepted, so the job's budget may grow by this much.
  function pendingCos(rows, jcat, jid) {
    if (!rows.length) return "";
    const total = rows.reduce((a, r) => a + (r.amount || 0), 0);
    const catTotal = rows.reduce((a, r) => a + (r.category_cost || 0), 0);
    return `<div class="min-w-0 rounded-lg p-2" style="grid-column:1/-1;background:#fffbeb;border:1px dashed #fcd34d">
      <div class="text-[11px] uppercase tracking-wide text-amber-800 mb-1">Pending change orders · ${fmtMoney(total)} contract${catTotal ? ` · ${fmtMoney(catTotal)} ${escapeHtml(jcat.toLowerCase())} cost` : ""} · not in the estimate yet
        <a href="#/entity/project/${encodeURIComponent(jid)}?tab=changeorders" class="ml-2 normal-case tracking-normal font-semibold text-blue-600 hover:underline">Change Orders →</a></div>
      <table class="w-full text-xs"><tbody>${rows.map((r) => `<tr class="border-t border-black/[0.05]">
        <td class="py-1 pr-2 whitespace-nowrap"><span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${r.status === "draft" ? "bg-slate-100 text-slate-600" : "bg-amber-50 text-amber-700"}">${r.status === "draft" ? "Draft (app)" : "Sent"}</span></td>
        <td class="py-1 pr-2">${r.kind === "change_order" && r.co_number ? `CO ${r.co_number}` : "Estimate"}${r.doc_number ? ` <span class="text-black/50">#${escapeHtml(r.doc_number)}</span>` : ""}${r.title ? ` <span class="text-black/60">${escapeHtml(r.title)}</span>` : ""}</td>
        <td class="py-1 pr-2 text-right tabular-nums text-black/55">${r.category_cost != null ? `${fmtMoney(r.category_cost)} ${escapeHtml(jcat.toLowerCase())}` : ""}</td>
        <td class="py-1 text-right tabular-nums font-semibold">${fmtMoney(r.amount)}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function render() {
    const seg = (items) => `<div class="inline-flex rounded-lg border border-black/10 overflow-hidden text-xs">${items.map(([attr, v, l, on]) =>
      `<button ${attr}="${v}" class="px-3 py-1.5 font-semibold ${on ? "bg-ink-900 text-white" : "bg-white text-black/60 hover:bg-slate-200 hover:text-ink-900"}">${l}</button>`).join("")}</div>`;
    const s = st.sum;
    root.innerHTML = `
      ${tiles()}
      <section class="card p-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div style="max-width:48rem">
            <h2 class="text-base font-bold">Job cost vs estimate</h2>
            <p class="text-sm text-black/60 mt-1">${st.scope === "active"
              ? "Jobs in progress: what QuickBooks shows spent so far against each job's estimate. Compare with how far through the job it is."
              : "Finished jobs: QuickBooks bills and card purchases tagged to each job, against its estimate's cost lines."}
              ${s ? `${s.job_count} jobs.` : ""} QuickBooks Projects only (used since Dec 2024). <a href="#/assumptions" class="text-sky-700 hover:underline">How this is calculated</a></p>
          </div>
          <div class="flex flex-wrap gap-2">
            ${seg([["data-scope", "finished", "Finished jobs", st.scope === "finished"], ["data-scope", "active", "Active jobs", st.scope === "active"]])}
            ${st.scope === "finished" ? seg([["data-months", "12", "Last 12 months", st.months === 12], ["data-months", "24", "24 months", st.months === 24], ["data-months", "0", "All", st.months === 0]]) : ""}
          </div>
        </div>
        <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-black/50">
          <span class="inline-flex items-center gap-1.5"><span class="inline-block w-3 h-3 rounded-sm" style="background:#0284c7;opacity:.75"></span>Actual within estimate</span>
          <span class="inline-flex items-center gap-1.5"><span class="inline-block w-3 h-3 rounded-sm" style="background:#e11d48;opacity:.75"></span>Actual over estimate</span>
          <span class="inline-flex items-center gap-1.5"><span class="inline-block h-3" style="width:2px;background:#0f172a"></span>Estimate (bar runs to 150%)</span>
          <span>Click a category to see its jobs.</span>
        </div>
        <div class="mt-2">${costTable()}</div>
        ${s && st.scope === "finished" ? `<p class="text-xs text-black/50 mt-3" style="max-width:48rem">Lodging usually comes in under its estimate: Hotel Engine's monthly bill is split to jobs almost completely, so that mostly means estimates run high or crews didn't use hotels. Propane and travel often show no cost on a job because card purchases aren't always tagged to the job in QuickBooks.</p>` : ""}
      </section>`;
  }

  async function loadSummary() {
    st.sum = null; render();
    try { st.sum = await api(`/jobcost/summary?${qs()}`); } catch (e) { st.sum = { categories: [], rules: { over_pct: 0.1 }, job_count: 0 }; }
    render();
    if (st.openCat) loadCat(st.openCat);
  }
  async function loadCat(cat) {
    const key = `${qs()}|${cat}`;
    if (!st.catJobs[key]) {
      st.catJobs[key] = (await api(`/jobcost/category/${encodeURIComponent(cat)}?${qs()}`)).jobs;
    }
    render();
  }
  async function loadJob(key) {
    if (!st.jobDetail[key]) {
      const [id, cat] = key.split("|");
      st.jobDetail[key] = await api(`/jobcost/job/${encodeURIComponent(id)}/${encodeURIComponent(cat)}`);
    }
    render();
  }

  root.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) return;
    const b = ev.target.closest("button, tr[data-cat], tr[data-job]");
    if (!b) return;
    if (b.dataset.scope) { st.scope = b.dataset.scope; st.openCat = null; st.openJob = null; savePrefs({ scope: st.scope, months: st.months }); loadSummary(); return; }
    if (b.dataset.months != null) { st.months = Number(b.dataset.months); st.openCat = null; st.openJob = null; savePrefs({ scope: st.scope, months: st.months }); loadSummary(); return; }
    if (b.dataset.filter) { st.filter = b.dataset.filter; st.showAll = false; render(); return; }
    if (b.hasAttribute("data-showall")) { st.showAll = !st.showAll; render(); return; }
    if (b.dataset.cat) {
      st.openCat = st.openCat === b.dataset.cat ? null : b.dataset.cat;
      st.filter = "all"; st.showAll = false; st.openJob = null;
      render();
      if (st.openCat) loadCat(st.openCat);
      return;
    }
    if (b.dataset.job) {
      st.openJob = st.openJob === b.dataset.job ? null : b.dataset.job;
      render();
      if (st.openJob) loadJob(st.openJob);
    }
  });

  render();
  loadSummary();
  api("/money/schedule?weeks_back=0&weeks_ahead=5").then((m) => { st.money = m; render(); }).catch(() => {});
  api("/review").then((r) => { st.review = r; render(); }).catch(() => {});
}
