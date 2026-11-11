// Running Jobs (#/running): every job under way, and the ones starting in the next
// 30 days, in one place. It takes over Progress Checks (same numbers and sign-offs)
// and puts next to them what the person watching a job needs:
//
//   left    the jobs: day X of Y, and how far along the time, the billing and the
//           costs are, with chips for what needs attention
//   right   one job at a glance (dates, crew, money, projected margin, the three
//           progress bars), then step cards that open in place:
//             Progress & costs   costs vs plan, checkpoints & sign-offs, schedules
//             Problems           the job's open items from Issues, by area
//             Customer & crew updates   Leo's Project Lifecycle emails, filled in
//                                       from the job; "Open in email" hands them to
//                                       the PM's email app, "Mark sent" records them
//
// Backend: backend/app/running/routes.py (+ app/progress for the numbers).
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml as esc } from "../utils/html.js";
import { openProjectDrawer } from "../utils/project-drawer.js";
import { chip, C, day, money0, projectLink } from "../utils/ui.js";
import { stepCardHtml, bindStepCards } from "../utils/stepcards.js";
import { mountBillingPanel } from "./billing.js";

const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const STATUS = {
  over: ["Over budget", C.bad, "Known cost is above the estimate plus pending estimates."],
  ahead: ["Spending ahead of plan", C.warn, "More has been spent than planned by now."],
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
const SHORT = { over: "Over", ahead: "Ahead", behind: "Behind", ok: "On plan" };
const stMini = (s) => { const [, c, t] = STATUS[s] || STATUS.ok; return chip(SHORT[s] || "On plan", c, t); };
const AREA = { invoices: "Invoices", change_orders: "Change orders", crew: "Crew pay", expenses: "Expenses", progress: "Progress", schedules: "Schedules", data: "Data" };
const VIEWS = [["now", "Running now"], ["soon", "Starting soon"], ["late", "Past end date"], ["all", "All"]];

export async function runningPage(routeFn) {
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem("opi_running") || "{}"); } catch (_) {}
  const isPhone = () => window.matchMedia("(max-width: 1023px)").matches;
  const st = { jobs: [], meta: {}, view: VIEWS.some(([k]) => k === saved.view) ? saved.view : "now", kpi: null, q: "", pm: "", sel: saved.sel || null, open: false };
  const remember = () => { try { sessionStorage.setItem("opi_running", JSON.stringify({ view: st.view, sel: st.sel })); } catch (_) {} };

  setShell({
    title: "Running Jobs",
    subtitle: "Every job under way and starting soon: progress against time, costs against plan, checkpoints and sign-offs, problems, and the PM's customer and crew updates.",
    bodyHtml: `<div id="rjRoot" class="qpage"><div class="card p-6 text-sm text-black/45">Loading running jobs… (the first load of the day takes a few seconds)</div></div>`,
    routeFn,
  });
  const root = document.getElementById("rjRoot");

  const KPI = {
    now: ["Running now", (j) => j.phase === "now" || j.phase === "late"],
    soon: ["Starting in 30 days", (j) => j.phase === "soon"],
    off: ["Costs off plan", (j) => j.status === "over" || j.status === "ahead"],
    sign: ["Sign-offs due", (j) => j.signoffs_due > 0],
    prob: ["Jobs with problems", (j) => j.problems.bad > 0],
    upd: ["Updates due", (j) => j.updates_due.length > 0 && j.phase !== "soon" || j.updates_due.some((k) => k !== "daily" && k !== "day1" && k !== "completion")],
  };
  const inView = (j, v) => v === "all" || (v === "now" ? j.phase === "now" : j.phase === v);
  function visible() {
    const q = st.q.trim().toLowerCase();
    return st.jobs.filter((j) => (st.kpi ? KPI[st.kpi][1](j) : inView(j, st.view))
      && (!st.pm || j.pm === st.pm)
      && (!q || `${j.name} ${j.pm || ""} ${j.crews.map((c) => c.name).join(" ")}`.toLowerCase().includes(q)));
  }

  async function load(fresh = false) {
    try {
      const d = await api(`/running${fresh ? "?fresh=1" : ""}`);
      st.jobs = d.jobs; st.meta = d;
      if (!st.sel || !st.jobs.some((j) => j.id === st.sel)) st.sel = visible()[0]?.id || st.jobs[0]?.id || null;
      render();
    } catch (e) {
      root.innerHTML = `<div class="card p-6 text-sm text-rose-700">Couldn't load running jobs: ${esc(e?.message || String(e))}</div>`;
    }
  }

  function kpis() {
    const n = (k) => st.jobs.filter(KPI[k][1]).length;
    const caption = { now: "Started and not finished", soon: "Dates set, not started", off: "Over budget or spending ahead", sign: `Checkpoints waiting (jobs ${money0(st.meta.rules?.signoff_min || 500000)}+)`, prob: "Red items on Issues", upd: "Customer / crew emails not sent" };
    const bad = { off: 1, sign: 1, prob: 1 };
    return `<div class="su-kpis rj-kpis">${Object.keys(KPI).map((k) => `<button type="button" class="card p-4 text-left su-kpi${st.kpi === k ? " on" : ""}" data-kpi="${k}" aria-pressed="${st.kpi === k}">
      <div class="text-[10px] uppercase tracking-wide font-bold text-black/45">${KPI[k][0]}</div>
      <div class="text-2xl font-extrabold tabular-nums ${bad[k] && n(k) ? "text-rose-700" : ""}">${n(k)}</div>
      <div class="text-xs text-black/50">${caption[k]}</div></button>`).join("")}</div>`;
  }

  const bar = (label, v, time, cls) => `<div class="rj-bar" title="${label}: ${pct(v)}"><span class="rj-bl">${label}</span><span class="rj-track">${time != null ? `<i class="rj-time" style="left:${Math.min(100, time * 100)}%"></i>` : ""}<b class="${cls}" style="width:${Math.min(100, (v || 0) * 100)}%"></b></span><span class="rj-bv">${pct(v)}</span></div>`;
  const costCls = (j) => (j.pct_cost != null && j.pct_cost > 1 ? "bad" : j.pct_cost != null && j.pct_time != null && j.pct_cost - j.pct_time > 0.2 ? "warn" : "");
  const billCls = (j) => (j.pct_invoiced != null && j.pct_time != null && j.pct_time - j.pct_invoiced > 0.25 ? "warn" : "");
  const dayTxt = (j) => j.phase === "soon" ? `starts in ${j.days_to_start} day${j.days_to_start === 1 ? "" : "s"}` : j.phase === "late" ? `past end date ${day(j.end)}` : `day ${j.day_n} of ${j.days_total}`;

  function listHtml() {
    const rows = visible();
    if (!rows.length) return `<div class="p-4 text-sm text-black/50">No jobs here.</div>`;
    return rows.map((j) => `<button type="button" class="su-job${j.id === st.sel ? " on" : ""}" data-key="${esc(j.id)}" aria-current="${j.id === st.sel}">
      <div class="font-bold text-sm truncate">${esc(j.name)}</div>
      <div class="text-[11.5px] text-black/50 truncate">${esc([j.pm, dayTxt(j), j.crews[0]?.name].filter(Boolean).join(" · "))}</div>
      ${j.phase === "soon" ? "" : `<div class="rj-bars mt-1.5">${bar("Time", j.pct_time, null, "time")}${bar("Billed", j.pct_invoiced, j.pct_time, billCls(j))}${bar("Cost", j.pct_cost, j.pct_time, costCls(j))}</div>`}
      <div class="flex flex-wrap gap-1 mt-1.5">${j.status !== "ok" && j.phase !== "soon" ? stChip(j.status) : ""}${j.signoffs_due ? chip("Sign-off due", C.warn) : ""}${j.problems.bad ? chip(`${j.problems.bad} problem${j.problems.bad === 1 ? "" : "s"}`, C.bad) : ""}${j.updates_due.length ? chip(`${j.updates_due.length} update${j.updates_due.length === 1 ? "" : "s"} due`, C.info) : ""}</div>
    </button>`).join("");
  }

  function render() {
    remember();
    const pms = [...new Set(st.jobs.map((j) => j.pm).filter(Boolean))].sort();
    const counts = Object.fromEntries(VIEWS.map(([k]) => [k, st.jobs.filter((j) => inView(j, k)).length]));
    root.classList.toggle("su-open", st.open);
    root.innerHTML = `
      ${kpis()}
      <div class="su-bar-row">
        <div class="tabs" role="tablist">${VIEWS.map(([k, l]) => `<button role="tab" class="tab" data-view="${k}" aria-selected="${!st.kpi && st.view === k}">${l} <span class="tab-n">${counts[k]}</span></button>`).join("")}</div>
        ${st.kpi ? `<button type="button" class="su-filter" data-clearkpi>Showing: ${esc(KPI[st.kpi][0])} <span aria-hidden="true">✕</span></button>` : ""}
        <input id="rjQ" class="input text-sm su-q" placeholder="Search job, PM or crew" value="${esc(st.q)}">
        <select id="rjPm" class="input text-sm su-pm"><option value="">All PMs</option>${pms.map((p) => `<option${p === st.pm ? " selected" : ""}>${esc(p)}</option>`).join("")}</select>
      </div>
      <div class="su-grid">
        <div class="card su-list" id="rjList">${listHtml()}</div>
        <div id="rjDetail" class="q-detail"></div>
      </div>
      <div class="text-xs text-white/50 mt-3">Bars: Time = share of the job's days gone; Billed = invoiced ÷ contract; Cost = known cost ÷ cost budget. The thin line marks where time is: a bar well past it (cost) or well short of it (billing) is worth a look. The old Progress Checks page is still under <a class="underline" href="#/progress">Progress Checks</a>.</div>`;
    bind();
    renderDetail();
  }

  function bind() {
    root.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => { st.view = b.dataset.view; st.kpi = null; st.open = false; render(); }));
    root.querySelectorAll("[data-kpi]").forEach((b) => b.addEventListener("click", () => {
      st.kpi = st.kpi === b.dataset.kpi ? null : b.dataset.kpi; st.open = false;
      if (!visible().some((j) => j.id === st.sel)) st.sel = visible()[0]?.id || st.sel;
      render();
    }));
    root.querySelector("[data-clearkpi]")?.addEventListener("click", () => { st.kpi = null; render(); });
    root.querySelector("#rjQ").addEventListener("input", (e) => { st.q = e.target.value; root.querySelector("#rjList").innerHTML = listHtml(); bindList(); });
    root.querySelector("#rjPm").addEventListener("change", (e) => { st.pm = e.target.value; root.querySelector("#rjList").innerHTML = listHtml(); bindList(); });
    bindList();
  }
  function bindList() {
    root.querySelectorAll(".su-job").forEach((b) => b.addEventListener("click", () => {
      st.sel = b.dataset.key; st.open = true; remember();
      root.querySelectorAll(".su-job").forEach((x) => x.classList.toggle("on", x === b));
      root.classList.add("su-open");
      renderDetail();
      if (isPhone()) window.scrollTo(0, 0);
    }));
  }

  // ── Detail ───────────────────────────────────────────────────────────────
  let D = null;
  async function renderDetail() {
    let box = root.querySelector("#rjDetail");
    if (!box) return;
    const fresh = box.cloneNode(false); box.replaceWith(fresh); box = fresh;
    const row = st.jobs.find((x) => x.id === st.sel);
    if (!row) { box.innerHTML = `<div class="card p-6 text-sm text-black/50">Pick a job on the left.</div>`; return; }
    box.innerHTML = `<button type="button" class="su-back" data-back>← All running jobs</button><div class="card p-6 text-sm text-black/45">Loading ${esc(row.name)}…</div>`;
    box.querySelector("[data-back]").addEventListener("click", () => { st.open = false; root.classList.remove("su-open"); });
    let d;
    try { d = await api(`/running/job/${encodeURIComponent(row.id)}`); }
    catch (e) { box.lastElementChild.outerHTML = `<div class="card p-6 text-sm text-rose-700">Couldn't load this job: ${esc(e?.message || e)}</div>`; return; }
    if (st.sel !== row.id) return;   // clicked on while loading
    D = { d, row };
    drawDetail(box, d, row);
  }

  function drawDetail(box, d, row) {
    const j = d.job;
    const prob = d.problems;
    const byArea = {};
    for (const i of prob) (byArea[i.area] ||= []).push(i);
    const areas = Object.keys(byArea).sort((a, b) => byArea[b].filter((i) => i.sev === "bad").length - byArea[a].filter((i) => i.sev === "bad").length);
    const signState = j.signoffs_due ? "todo" : j.signoff_required ? "done" : "not_needed";
    const costState = j.status === "ok" ? "done" : j.status === "behind" ? "waiting" : "todo";
    const tile = (k, v, cls = "") => `<div><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
    const progressCards = [
      { key: "costs", state: costState, label: "Costs against the plan", detail: `${STATUS[j.status]?.[0] || ""} · known cost ${money0(j.cost_known)} of a ${money0(j.cost_budget)} budget` },
      { key: "checkpoints", state: signState, label: "Checkpoints and sign-offs (25 / 50 / 75 / 100%)", detail: j.signoff_required ? (j.signoffs_due ? `${j.signoffs_due} sign-off due` : "Sign-offs up to date") : "No sign-off needed on this job (checkpoints still shown)" },
      { key: "billing", state: "done", label: "Invoices, crew pay and expenses", detail: `Invoiced ${money0(j.invoiced)} of ${money0(j.contract)}${j.open_ar ? ` · ${money0(j.open_ar)} not collected` : ""}` },
    ];
    const probCards = areas.map((a) => {
      const list = byArea[a], bad = list.filter((i) => i.sev === "bad").length;
      return { key: `p:${a}`, state: bad ? "todo" : "waiting", label: `${AREA[a] || a}: ${list.length} item${list.length === 1 ? "" : "s"}`, detail: list.slice(0, 2).map((i) => i.title).join(" · ") };
    });
    const updCards = d.updates.map((u) => ({ key: `u:${u.key}`, state: u.state, label: u.label, detail: u.detail + (u.key === "daily" && u.count ? ` · ${u.count} sent so far` : "") }));
    box.innerHTML = `
      <button type="button" class="su-back" data-back>← All running jobs</button>
      <section class="card p-4">
        <div class="flex flex-wrap items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-lg font-extrabold leading-tight">${esc(j.name)}</div>
            <div class="text-xs text-black/55 mt-0.5">${esc([j.customer ? `Dealer: ${j.customer}` : null, j.pm ? `PM: ${j.pm}` : null, j.crews.length ? `Crew: ${j.crews.map((c) => c.name).join(", ")}` : "No crew assigned"].filter(Boolean).join(" · "))}</div>
            <div class="text-sm font-semibold text-ink-900 mt-1">${day(j.start)} to ${day(j.end)} · <span class="rj-day">${row.phase === "soon" ? `starts in ${row.days_to_start} days` : `Day ${j.day_n} of ${j.days_total}`}</span> <span class="text-xs font-normal text-black/45">(working days, Mon–Fri)</span></div>
          </div>
          <div class="text-right"><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">Projected margin</div>
            <div class="font-extrabold tabular-nums ${j.projected_margin != null && j.projected_margin < 15 ? "text-rose-700" : ""}">${j.projected_margin != null ? `${j.projected_margin.toFixed(1)}%` : "—"}</div>
            <div class="text-[11px] text-black/50" title="Contract plus pending estimates, less the larger of the cost budget and the cost known so far">if the rest goes to plan</div></div>
        </div>
        <div class="flex flex-wrap gap-2 mt-3">
          <button type="button" class="pd-btn" data-act="drawer">Quick view</button>
          <a class="pd-btn" href="${projectLink(j.id)}">Open project workspace</a>
          ${d.folders.root ? `<a class="pd-btn" href="${esc(d.folders.root)}" target="_blank" rel="noopener">Drive folder</a>` : ""}
          ${row.phase !== "soon" && j.status !== "ok" ? stChip(j.status) : ""}${prob.filter((i) => i.sev === "bad").length ? chip(`${prob.filter((i) => i.sev === "bad").length} problems`, C.bad) : ""}
        </div>
        <div class="rj-big mt-3">${bar("Time", j.pct_time, null, "time")}${bar("Billed", j.pct_invoiced, j.pct_time, billCls(j))}${bar("Cost", j.pct_cost, j.pct_time, costCls(j))}${bar("Crew paid", j.pct_labor, j.pct_time, j.pct_labor > 1 ? "bad" : "")}</div>
        <div class="co-money mt-3">
          ${tile("Contract", money0(j.contract))}${j.pending_contract ? tile("Pending estimates", money0(j.pending_contract)) : ""}${tile("Invoiced", money0(j.invoiced))}${tile("Not collected", money0(j.open_ar), j.open_ar > 1 ? "" : "")}
          ${tile("Cost so far", money0(j.cost_known))}${tile("Cost budget", money0(j.cost_budget))}
        </div>
        <div class="su-stages rj-stages mt-3">
          <div class="su-stage"><div class="text-[11px] uppercase tracking-wide font-bold text-black/50">Progress &amp; costs</div><div class="grid gap-1 mt-1.5">${progressCards.map(link).join("")}</div></div>
          <div class="su-stage"><div class="text-[11px] uppercase tracking-wide font-bold text-black/50">Problems</div><div class="grid gap-1 mt-1.5">${probCards.map(link).join("") || `<div class="text-xs text-black/50">Nothing open on Issues.</div>`}</div></div>
          <div class="su-stage"><div class="text-[11px] uppercase tracking-wide font-bold text-black/50">Customer &amp; crew updates</div><div class="grid gap-1 mt-1.5">${updCards.map(link).join("")}</div></div>
        </div>
        <div class="text-[11px] text-black/45 mt-2">Click anything to open it below.</div>
      </section>
      <section class="card p-4 su-sec"><div class="su-h">Progress &amp; costs</div><div class="grid gap-2 mt-2">${progressCards.map(stepCardHtml).join("")}</div></section>
      <section class="card p-4 su-sec"><div class="su-h">Problems <span class="text-xs font-bold text-black/40">${prob.length}</span></div>
        <div class="text-xs text-black/55 mt-1">This job's open items from Issues. Fix each one on the page it comes from (the link on each item).</div>
        <div class="grid gap-2 mt-2">${probCards.map(stepCardHtml).join("") || `<div class="text-sm text-black/55">Nothing open.</div>`}</div></section>
      <section class="card p-4 su-sec"><div class="su-h">Customer &amp; crew updates</div>
        <div class="text-xs text-black/55 mt-1">The PM's emails from kickoff to completion, filled in from the job. "Open in email" starts it in your email app (attach files there); "Mark sent" records it here. The app can't send email or texts itself yet.</div>
        <div class="grid gap-2 mt-2">${updCards.map(stepCardHtml).join("")}</div></section>`;

    box.querySelector("[data-back]").addEventListener("click", () => { st.open = false; root.classList.remove("su-open"); });
    box.querySelector('[data-act="drawer"]').addEventListener("click", () =>
      openProjectDrawer({ entityId: j.id, name: j.name, onChange: () => refresh(), backLabel: "Running Jobs", backHash: "#/running" }));
    D.cards = bindStepCards(box, { onOpen: (key, body) => buildBody(key, body, d, row) });
    box.addEventListener("click", (e) => {
      const a = e.target.closest("[data-jump]");
      if (a) { e.preventDefault(); D.cards.open(a.dataset.jump); }
    });
    // open what needs attention first
    const first = [...progressCards, ...probCards, ...updCards].find((c) => c.state === "todo");
    if (first) D.cards.open(first.key, { scroll: false });
  }
  const ICONS = { done: "#059669", todo: "#d97706", waiting: "#0284c7", not_needed: "#94a3b8", locked: "#cbd5e1" };
  function link(c) {
    return `<a href="#" class="su-step" data-jump="${esc(c.key)}"><svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="${c.state === "done" ? ICONS.done : "#fff"}" stroke="${ICONS[c.state] || ICONS.todo}" stroke-width="2"/></svg><span>${esc(c.label)}</span></a>`;
  }

  async function refresh() {
    await load(true);
  }

  // ── Card bodies ─────────────────────────────────────────────────────────
  function buildBody(key, body, d, row) {
    const j = d.job;
    if (key === "costs") return costsBody(j, d, body);
    if (key === "checkpoints") return checkpointsBody(j, d, body);
    if (key === "billing") { body.innerHTML = `<div class="text-xs text-black/55 mb-2">The same panel as the project's Billing tab: change a date or amount here and every page follows.</div><div class="su-embed"></div>`; mountBillingPanel(body.lastElementChild, j.id); return; }
    if (key.startsWith("p:")) return problemsBody(d.problems.filter((i) => i.area === key.slice(2)), body);
    if (key.startsWith("u:")) return updateBody(key.slice(2), d, body, row);
    body.innerHTML = "";
  }

  function costsBody(j, d, body) {
    body.innerHTML = `<div class="text-xs text-black/55 mb-2">Each cost type against the job's own plan: crew pay on its payment schedule, other costs on the expense schedule, allowing for how long each takes to reach QuickBooks. "Behind" often means a bill isn't entered yet, not money saved.</div>
      <div class="overflow-x-auto"><table class="w-full text-xs su-table">
      <thead><tr><th class="text-left">Cost</th><th class="text-right">Budget</th><th class="text-right">Pending</th><th class="text-right">Planned by now</th><th class="text-right">In QuickBooks</th><th class="text-right">Not in QB yet</th><th class="text-left">Status</th><th class="text-left">Data</th></tr></thead>
      <tbody>${j.buckets.map((b) => `<tr><td class="font-semibold">${esc(b.bucket)}</td><td class="text-right tabular-nums">${money0(b.budget)}</td><td class="text-right tabular-nums text-black/55">${b.pending ? money0(b.pending) : ""}</td>
        <td class="text-right tabular-nums">${money0(b.planned)}</td><td class="text-right tabular-nums font-semibold">${money0(b.actual)}</td><td class="text-right tabular-nums">${b.entries ? money0(b.entries) : ""}</td>
        <td>${stChip(b.status)}</td><td class="text-black/55" title="${esc(CONF[b.confidence]?.[1] || "")}">${CONF[b.confidence]?.[0] || ""}</td></tr>`).join("")}
        <tr class="su-total"><td>Invoiced</td><td class="text-right tabular-nums">${money0(j.contract)}</td><td class="text-right tabular-nums text-black/55">${j.pending_contract ? money0(j.pending_contract) : ""}</td><td class="text-right tabular-nums">${money0(j.invoice_planned)}</td><td class="text-right tabular-nums">${money0(j.invoiced)}</td><td></td><td colspan="2" class="text-black/55">${j.open_ar ? `${money0(j.open_ar)} not collected` : ""}</td></tr>
      </tbody></table></div>`;
  }

  function checkpointsBody(j, d, body) {
    const can = d.can_sign;
    const sw = j.signoff_switch;
    body.innerHTML = `<div class="flex flex-wrap items-center gap-2 mb-2"><div class="text-xs text-black/55 flex-1">At 25, 50, 75 and 100% of the job's days the app compares planned and actual costs and invoices. Jobs of ${money0(d.rules.signoff_min)} or more (or switched on) need someone with sign-off access to sign off each checkpoint; signing the newest covers the ones before it.</div>
        ${can ? `<label class="text-xs text-black/55">Sign-offs <select class="input text-xs" style="width:auto" data-switch>
          <option value=""${sw == null ? " selected" : ""}>By size (${j.by_size ? "on" : "off"})</option><option value="1"${sw === true ? " selected" : ""}>On</option><option value="0"${sw === false ? " selected" : ""}>Off</option></select></label>` : ""}</div>
      <div class="rj-points">${j.points.map((p) => {
        const s = p.signoff;
        const rows = p.checks.map((c) => `<tr><td>${esc(c.bucket)}</td><td class="text-right tabular-nums">${money0(c.planned)}</td><td class="text-right tabular-nums">${money0(c.actual)}</td><td class="text-right">${c.status ? stMini(c.status) : ""}</td></tr>`).join("");
        return `<div class="rj-point${p.due ? " due" : ""}">
          <div class="flex items-center justify-between"><b>${p.milestone}%</b><span class="text-xs text-black/50">${day(p.date)}</span></div>
          ${p.reached ? "" : `<div class="text-xs text-black/45">Not reached yet</div>`}${p.settling ? `<div class="text-[11px] text-sky-700">Bills from this period are still arriving.</div>` : ""}
          ${rows ? `<table class="w-full text-[11px] su-table mt-1"><thead><tr><th></th><th class="text-right">Planned</th><th class="text-right">Actual</th><th></th></tr></thead><tbody>${rows}<tr><td>Invoiced</td><td class="text-right tabular-nums">${money0(p.invoice_planned)}</td><td class="text-right tabular-nums">${money0(p.invoiced)}</td><td></td></tr></tbody></table>` : ""}
          ${s ? `<div class="text-xs mt-1">${chip(s.decision === "hold" ? "On hold" : "Signed off", s.decision === "hold" ? C.bad : C.good)} <span class="text-black/50">${esc(s.by || "")} ${day(s.at)}${s.note ? ` · ${esc(s.note)}` : ""}</span>${can ? ` <button class="su-linkbtn" data-sign="" data-m="${p.milestone}">Undo</button>` : ""}</div>`
            : p.reached && j.signoff_required ? (can ? `<div class="flex gap-2 mt-2"><button class="btn-primary text-xs" data-sign="approved" data-m="${p.milestone}">Sign off</button><button class="pd-btn" data-sign="hold" data-m="${p.milestone}">Hold</button></div>` : `<div class="mt-1">${chip("Sign-off due", C.warn)}</div>`) : ""}
        </div>`;
      }).join("")}</div>`;
    body.querySelector("[data-switch]")?.addEventListener("change", async (e) => {
      const v = e.target.value === "" ? null : e.target.value === "1";
      try { await api(`/progress/${encodeURIComponent(j.id)}/settings`, { method: "POST", body: JSON.stringify({ signoff: v }) }); await refresh(); }
      catch (er) { alert(`Couldn't save: ${er?.message || er}`); }
    });
    body.querySelectorAll("[data-sign]").forEach((b) => b.addEventListener("click", async () => {
      const decision = b.dataset.sign || null;
      let note = null;
      if (decision === "hold") { note = prompt("Why is this on hold?"); if (!note) return; }
      else if (decision) note = prompt("Add a note (optional)") ?? null;
      try { await api(`/progress/${encodeURIComponent(j.id)}/signoff`, { method: "POST", body: JSON.stringify({ milestone: Number(b.dataset.m), decision, note }) }); await refresh(); }
      catch (er) { alert(`Couldn't save: ${er?.message || er}`); }
    }));
  }

  function problemsBody(list, body) {
    body.innerHTML = `<div class="grid gap-1.5">${list.map((i) => `<div class="rj-prob ${i.sev}">
      <div class="flex flex-wrap items-start gap-2"><div class="min-w-0 flex-1"><div class="text-sm font-semibold">${esc(i.title)}</div>${i.detail ? `<div class="text-xs text-black/60">${esc(i.detail)}</div>` : ""}</div>
        ${i.amount ? `<div class="text-sm font-bold tabular-nums">${money0(i.amount)}</div>` : ""}
        ${i.link ? `<a class="pd-btn" href="${esc(i.link)}">${esc(i.source || "Open")}</a>` : ""}</div></div>`).join("")}</div>`;
  }

  function updateBody(kind, d, body, row) {
    const u = d.updates.find((x) => x.key === kind);
    const t = d.templates[kind];
    const hist = d.history.filter((h) => h.kind === kind);
    const isText = kind === "client_thread" || kind === "crew_thread";
    const histHtml = hist.length ? `<details class="mt-2"${kind === "daily" ? "" : ""}><summary class="text-xs font-semibold text-black/60 cursor-pointer">${hist.length} recorded</summary>
      <div class="grid gap-1 mt-1">${hist.map((h) => `<div class="text-xs text-black/60 flex flex-wrap gap-2 items-center"><span>${h.status === "sent" ? "Sent" : "Not needed"} ${esc(h.at.slice(0, 16))} by ${esc(h.by_email || "")}${h.subject ? ` · ${esc(h.subject)}` : ""}${h.note ? ` · ${esc(h.note)}` : ""}</span><button class="su-linkbtn" data-undo="${h.id}">Undo</button></div>`).join("")}</div></details>` : "";
    if (isText) {
      body.innerHTML = `<div class="text-xs text-black/55">Group texts with the ${kind === "client_thread" ? "customer" : "crew"} aren't in the app yet (that needs a texting service OPI hasn't picked). Start the group text on your phone, then record it here.</div>
        <div class="flex flex-wrap gap-2 mt-2"><button class="btn-primary text-sm" data-rec="sent">Mark started</button><button class="pd-btn" data-rec="not_needed">Not needed</button></div>${histHtml}`;
    } else {
      body.innerHTML = `
        ${kind === "daily" && t.from_last ? `<div class="text-xs text-sky-800 mb-1">Started from your last update: change what's new and send.</div>` : ""}
        <div class="grid gap-2">
          <label class="text-xs grid gap-1"><span class="text-black/55">To</span><input class="input text-sm" data-f="to" value="${esc(t.to || "")}" placeholder="${kind === "crew_kickoff" ? "Crew boss email" : "Customer email (no contact email on the pipeline row)"}"></label>
          <label class="text-xs grid gap-1"><span class="text-black/55">Subject</span><input class="input text-sm" data-f="subject" value="${esc(t.subject)}"></label>
          <label class="text-xs grid gap-1"><span class="text-black/55">Email</span><textarea class="input text-sm rj-mail" rows="${kind === "daily" ? 16 : 11}" data-f="body">${esc(t.body)}</textarea></label>
          ${t.attach ? `<div class="text-xs text-amber-800">Attach in your email app: ${esc(t.attach)}${d.folders.kickoff ? ` (<a class="underline" href="${esc(d.folders.kickoff)}" target="_blank" rel="noopener">Kickoff folder</a>)` : ""}.</div>` : ""}
          <div class="flex flex-wrap gap-2 items-center">
            <button class="pd-btn" data-mailto>Open in email</button><button class="pd-btn" data-copy>Copy email</button>
            <button class="btn-primary text-sm" data-rec="sent">Mark sent</button>${kind === "daily" ? "" : `<button class="pd-btn" data-rec="not_needed">Not needed</button>`}
            <span class="text-xs text-black/45">${esc(u?.detail || "")}</span>
          </div>
        </div>${histHtml}`;
    }
    const val = (f) => body.querySelector(`[data-f="${f}"]`)?.value || "";
    body.querySelector("[data-mailto]")?.addEventListener("click", () => {
      location.href = `mailto:${encodeURIComponent(val("to")).replace(/%40/g, "@").replace(/%2C/g, ",")}?subject=${encodeURIComponent(val("subject"))}&body=${encodeURIComponent(val("body"))}`;
    });
    body.querySelector("[data-copy]")?.addEventListener("click", async (e) => {
      const txt = `Subject: ${val("subject")}\n\n${val("body")}`;
      try { await navigator.clipboard.writeText(txt); e.target.textContent = "Copied"; setTimeout(() => { e.target.textContent = "Copy email"; }, 1200); } catch (_) { alert(txt); }
    });
    body.querySelectorAll("[data-rec]").forEach((b) => b.addEventListener("click", async () => {
      let note = null;
      if (b.dataset.rec === "not_needed") { note = prompt("Why isn't it needed? (kept with the job)"); if (note === null) return; }
      b.disabled = true;
      try {
        await api(`/running/job/${encodeURIComponent(d.job.id)}/comms`, { method: "POST", body: JSON.stringify({ kind, status: b.dataset.rec, to: val("to"), subject: val("subject"), body: val("body"), note }) });
        await reloadOne(row.id);
      } catch (er) { b.disabled = false; alert(`Couldn't save: ${er?.message || er}`); }
    }));
    body.querySelectorAll("[data-undo]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Remove this record?")) return;
      try { await api(`/running/comms/${b.dataset.undo}`, { method: "DELETE" }); await reloadOne(row.id); }
      catch (er) { alert(`Couldn't undo: ${er?.message || er}`); }
    }));
  }

  // after recording an update: refresh the list row and the job, keep the place
  async function reloadOne(id) {
    const y = window.scrollY;
    try {
      const d = await api("/running");
      st.jobs = d.jobs; st.meta = d;
      root.querySelector("#rjList").innerHTML = listHtml(); bindList();
      root.querySelector("[data-kpi]") && root.querySelectorAll(".su-kpis")[0].replaceWith(Object.assign(document.createElement("div"), { innerHTML: kpis() }).firstElementChild);
      root.querySelectorAll("[data-kpi]").forEach((b) => b.addEventListener("click", () => { st.kpi = st.kpi === b.dataset.kpi ? null : b.dataset.kpi; render(); }));
    } catch (_) { /* list catches up on next load */ }
    if (st.sel === id) { await renderDetail(); window.scrollTo(0, y); }
  }

  load();
}
