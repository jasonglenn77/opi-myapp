// Project Closeout: every finished job until it's closed. Left: the queue (oldest
// finish first). Right: the selected job at a glance, then its steps grouped Job /
// Money in / Money out / Review as step cards (utils/stepcards.js) that open to
// the invoices, crew payments, bills, paperwork and margin behind each step.
// Steps the data can answer tick themselves (backend/app/closeout/routes.py);
// the rest are marked here.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml as esc } from "../utils/html.js";
import { openProjectDrawer } from "../utils/project-drawer.js";
import { chip, C, day, money0, money2, projectLink } from "../utils/ui.js";
import { openDocViewer, DOC_ICON } from "../utils/doc-viewer.js";
import { stepCardHtml, bindStepCards, STATE_ICON } from "../utils/stepcards.js";
import { modal, closeModal, toast } from "../utils/help.js";
import { mountBillingPanel } from "./billing.js";

// Tabs: which finished jobs (by when they ended and what's open). The KPI tiles
// filter further (to bill, to collect, crew owed, forms, ready to close).
const TABS = [["all", "All not closed"], ["recent", "Ended since Oct 1"], ["open", "Older: open items"], ["paperwork", "Older: paperwork only"], ["closed", "Closed"]];
const TILES = { bill: "To bill", collect: "To collect", crew: "Crew owed", paper: "Forms & status", review: "Ready to close" };
const VIEWS = [...TABS, ...Object.entries(TILES)];
const GROUPS = ["Job", "Money in", "Money out", "Review"];
// Money steps a reviewer can close even when the money is short (books closed), or note as not ready.
const REVIEW_STEPS = ["final_invoice", "paid", "retainage", "crew_paid", "expenses"];
// Where to go to fix each step.
const FIX = {
  marked_complete: ["Open project", "workspace"], completion_form: ["Documents", "documents"], change_orders: ["Change orders", "changeorders"],
  final_invoice: ["Billing", "billing"], paid: ["Billing", "billing"], retainage: ["Billing", "billing"],
  crew_paid: ["Contractor Payments", "#/crew-payments"], expenses: ["Financials", "financials"], signoff: ["Progress Checks", "#/progress"],
};

export async function closeoutPage(routeFn) {
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem("opi_closeout") || "{}"); } catch (_) {}
  const isPhone = () => window.matchMedia("(max-width: 1023px)").matches;
  const st = { jobs: [], closedJobs: null, view: VIEWS.some(([k]) => k === saved.view) ? saved.view : "all", q: "", pm: "", sel: saved.sel || null, open: false, meta: {} };
  const remember = () => { try { sessionStorage.setItem("opi_closeout", JSON.stringify({ view: st.view, sel: st.sel })); } catch (_) {} };

  setShell({
    title: "Project Closeout",
    subtitle: "Every finished job until it's closed out: the final invoice, getting paid, paying the crew in full, bills, change orders, the completion paperwork, then the Review (100% sign-off and margin). A job leaves once it's closed out.",
    bodyHtml: `<div id="coRoot" class="qpage"><div class="card p-6 text-sm text-black/45">Loading finished jobs…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("coRoot");

  const stepOf = (j, k) => j.steps.find((s) => s.key === k) || {};
  const open = (j, k) => stepOf(j, k).state === "todo";
  const moneyOpen = (j) => j.money.unbilled > 1 || j.money.open_ar > 1 || j.money.crew_deal_owed > 1 || j.money.retainage > 1 || j.money.bills_open > 1;
  const TEST = {
    all: () => true, recent: (j) => j.bucket === "recent", open: (j) => j.bucket === "open", paperwork: (j) => j.bucket === "paperwork",
    closed: () => true, money: moneyOpen, bill: (j) => open(j, "final_invoice"), collect: (j) => open(j, "paid") || open(j, "retainage"),
    crew: (j) => open(j, "crew_paid"), paper: (j) => open(j, "completion_form") || open(j, "marked_complete") || open(j, "change_orders"),
    review: (j) => j.steps.every((s) => s.key === "margin" || s.state !== "todo"),
  };
  const pool = () => (st.view === "closed" ? st.closedJobs || [] : st.jobs);
  function visible() {
    const q = st.q.trim().toLowerCase();
    return pool().filter((j) => TEST[st.view](j)
      && (!st.pm || (j.pms || []).includes(st.pm))
      && (!q || `${j.name} ${j.dealer || ""} ${(j.pms || []).join(" ")}`.toLowerCase().includes(q)));
  }

  async function loadClosed() {
    if (st.closedJobs) return;
    try { st.closedJobs = (await api("/closeout/queue?closed=1")).jobs; } catch (_) { st.closedJobs = []; }
  }
  async function load() {
    try {
      const d = await api("/closeout/queue");
      st.jobs = d.jobs; st.meta = d;
      if (st.view === "closed") await loadClosed();
      if (!st.sel || !st.jobs.some((j) => j.entity_id === st.sel)) st.sel = visible()[0]?.entity_id || null;
      render();
    } catch (e) {
      root.innerHTML = `<div class="card p-6 text-sm text-rose-700">Couldn't load finished jobs: ${esc(e?.message || String(e))}</div>`;
    }
  }

  function kpis() {
    const sum = (f) => st.jobs.reduce((a, j) => a + f(j), 0);
    const n = (f) => st.jobs.filter(f).length;
    const tile = (label, value, caption, bad, view) => `<button type="button" class="card p-4 text-left su-kpi" data-view="${view}">
        <div class="text-[10px] uppercase tracking-wide font-bold text-black/45">${label}</div>
        <div class="text-2xl font-extrabold tabular-nums ${bad ? "text-rose-700" : ""}">${value}</div>
        <div class="text-xs text-black/50">${caption}</div></button>`;
    const unb = sum((j) => j.money.unbilled), ar = sum((j) => j.money.open_ar);
    const crew = sum((j) => (open(j, "crew_paid") ? Math.max(0, j.money.labor_left) : 0));
    return `<div class="su-kpis">
      ${tile("Still to bill", money0(unb), `${n((j) => open(j, "final_invoice"))} jobs: final invoice not sent`, unb > 0, "bill")}
      ${tile("Owed to OPI", money0(ar), `${n((j) => open(j, "paid"))} jobs with unpaid invoices`, false, "collect")}
      ${tile("Contract labor to review", money0(crew), `${n((j) => open(j, "crew_paid"))} jobs: paid less than the estimates`, false, "crew")}
      ${tile("Forms & status", n(TEST.paper), "Completion form, status or change orders", false, "paper")}
      ${tile("Ready to close", n(TEST.review), "Everything in; review the margin", false, "review")}
    </div>`;
  }

  function listHtml() {
    const rows = visible();
    if (!rows.length) return `<div class="p-4 text-sm text-black/50">No jobs here.</div>`;
    return rows.map((j) => {
      const pct = Math.round((100 * j.done) / j.total);
      return `<button type="button" class="su-job${j.entity_id === st.sel ? " on" : ""}" data-key="${esc(j.entity_id)}" aria-current="${j.entity_id === st.sel}">
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <div class="font-bold text-sm truncate">${esc(j.name)}</div>
            <div class="text-[11.5px] text-black/50 truncate">${esc([j.dealer, (j.pms || [])[0], j.end ? `ended ${day(j.end)}` : null].filter(Boolean).join(" · "))}</div>
          </div>
          <span class="text-[11px] font-bold tabular-nums text-black/55">${j.done}/${j.total}</span>
        </div>
        <div class="su-bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
        ${j.flags.length || j.forecast === "included" ? `<div class="flex flex-wrap gap-1 mt-1.5">${j.forecast === "included" ? chip("In cash forecast", C.info) : ""}${j.flags.map((f) => chip(f.text, C[f.tone])).join("")}</div>` : ""}
      </button>`;
    }).join("");
  }

  function render() {
    remember();
    const pms = [...new Set(st.jobs.flatMap((j) => j.pms || []))].sort();
    const counts = Object.fromEntries(VIEWS.map(([k]) => [k, k === "closed" ? (st.closedJobs ? st.closedJobs.length : "") : st.jobs.filter(TEST[k]).length]));
    const shown = visible();
    const canBulk = st.meta.can_sign && st.view !== "closed" && shown.length > 0;
    root.classList.toggle("su-open", st.open);
    root.innerHTML = `
      ${kpis()}
      <div class="su-bar-row">
        <div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" class="tab" data-view="${k}" aria-selected="${st.view === k}">${l} <span class="tab-n">${counts[k]}</span></button>`).join("")}</div>
        <input id="coQ" class="input text-sm su-q" placeholder="Search job, dealer or PM" value="${esc(st.q)}">
        <select id="coPm" class="input text-sm su-pm"><option value="">All PMs</option>${pms.map((p) => `<option${p === st.pm ? " selected" : ""}>${esc(p)}</option>`).join("")}</select>
        ${TILES[st.view] ? `<button type="button" class="pd-btn" data-view="all" title="Show all jobs again">Showing: ${esc(TILES[st.view])} ✕</button>` : ""}
        ${canBulk ? `<button type="button" class="pd-btn" id="coBulk" title="Close out every job in this list at once, with one note">Close out these ${shown.length}…</button>` : ""}
      </div>
      <div class="su-grid">
        <div class="card su-list" id="coList">${listHtml()}</div>
        <div id="coDetail" class="q-detail"></div>
      </div>
      <div class="text-xs text-white/50 mt-3">Every finished job stays here until it's closed out, whatever its age. Jobs that ended before ${day(st.meta.cutover || "2026-10-01")} are split into those with money or a change order still open and those with only paperwork gaps. ${st.meta.closed_recent ? `${st.meta.closed_recent} job${st.meta.closed_recent === 1 ? "" : "s"} closed in the last 60 days.` : ""}</div>`;
    bind();
    renderDetail();
  }

  function bind() {
    root.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", async () => {
      st.view = b.dataset.view;
      if (st.view === "closed") await loadClosed();
      if (!visible().some((j) => j.entity_id === st.sel)) st.sel = visible()[0]?.entity_id || null;
      render();
    }));
    root.querySelector("#coBulk")?.addEventListener("click", bulkClose);
    const q = root.querySelector("#coQ");
    q.addEventListener("input", () => { st.q = q.value; root.querySelector("#coList").innerHTML = listHtml(); bindList(); });
    root.querySelector("#coPm").addEventListener("change", (e) => { st.pm = e.target.value; render(); });
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

  function fixLink(j, key) {
    const f = FIX[key];
    if (!f) return "";
    const href = f[1].startsWith("#") ? f[1] : projectLink(j.entity_id, f[1] === "workspace" ? null : f[1]);
    return `<a class="pd-btn" href="${href}">${f[0]}</a>`;
  }

  // ── Detail: the job at a glance, then one step card per step ────────────
  // Each card opens in place to what's behind the step (the invoices, the crew
  // payments, the unpaid bills, the completion paperwork, the margin by
  // category), from GET /closeout/job/{id}/detail, loaded once per job.
  let D = null;
  const cache = {};
  const getDetail = (eid) => cache[eid] ||= api(`/closeout/job/${encodeURIComponent(eid)}/detail`).catch((e) => { delete cache[eid]; throw e; });

  function headParts(j, s) {
    const acts = [];
    if (s.state === "todo") {
      acts.push(fixLink(j, s.key));
      if (s.key === "signoff") {
        if (st.meta.can_sign) acts.push(`<button type="button" class="pd-btn" data-mark="done" data-step="signoff">Sign off</button>`);
      } else if (REVIEW_STEPS.includes(s.key)) {
        acts.push(`<button type="button" class="pd-btn" data-mark="reviewed" data-step="${s.key}" title="Reviewed: close this area, even if the money is short (books closed)">Close (reviewed)</button>`);
        acts.push(`<button type="button" class="pd-btn" data-mark="noted" data-step="${s.key}" title="Reviewed, but not ready to close: leave a note; the step stays open">Not ready…</button>`);
      } else {
        acts.push(`<button type="button" class="pd-btn" data-mark="${s.how === "manual" ? "done" : "not_needed"}" data-step="${s.key}">${s.how === "manual" ? "Close out" : "Not needed"}</button>`);
      }
    }
    if (s.mark) acts.push(`<button type="button" class="pd-btn" data-mark="" data-step="${s.key}">Undo</button>`);
    const markTxt = s.mark ? `<div class="text-[11px] ${s.mark.status === "noted" ? "text-amber-700" : "text-black/45"} mt-0.5">${s.mark.status === "noted" ? "Not ready yet, noted" : s.mark.status === "reviewed" ? "Closed as reviewed" : "Marked"} by ${esc(s.mark.by_email || "")} ${s.mark.at ? day(s.mark.at) : ""}${s.mark.note ? `: ${esc(s.mark.note)}` : ""}</div>` : "";
    return { key: s.key, state: s.state, label: s.label, detail: s.why, actions: acts.join(""), extra: markTxt };
  }
  const groupCount = (j, g) => { const ss = j.steps.filter((s) => s.group === g); return `${ss.filter((s) => s.state !== "todo").length}/${ss.length}`; };
  const stepLink = (s) => `<a href="#" class="su-step" data-jump="${s.key}">${STATE_ICON[s.state] || STATE_ICON.todo}<span>${esc(s.label)}</span></a>`;
  const moneyTiles = (m) => {
    const tile = (k, v, bad) => `<div><div class="k">${k}</div><div class="v${bad ? " bad" : ""}">${v}</div></div>`;
    return `${tile("Contract", money0(m.contract))}${tile("Invoiced", money0(m.invoiced))}${tile("Still to bill", money0(m.unbilled), m.unbilled > 1)}
      ${tile("Owed to OPI", money0(m.open_ar), m.open_ar > 1)}${m.retainage > 1 ? tile("Retainage held", money0(m.retainage)) : ""}
      ${tile("Labor on estimates", money0(m.labor_budget))}${tile("Labor paid", money0(m.labor_paid))}${tile(m.labor_left < -1 ? "Labor over" : "Labor left", money0(Math.abs(m.labor_left)), m.labor_left > 1)}
      ${tile("Expenses on estimates", money0(m.exp_budget))}${tile("Expenses spent", money0(m.exp_spent))}${m.bills_open > 1 ? tile("Unpaid bills", money0(m.bills_open), true) : ""}`;
  };

  function renderDetail() {
    let box = root.querySelector("#coDetail");
    const j = pool().find((x) => x.entity_id === st.sel);
    if (!box) return;
    const fresh = box.cloneNode(false); box.replaceWith(fresh); box = fresh;   // drop the last job's listeners
    if (!j) { box.innerHTML = `<div class="card p-6 text-sm text-black/50">Pick a job on the left.</div>`; D = null; return; }
    D = { j };
    box.innerHTML = `
      <button type="button" class="su-back" data-back>← All finished jobs</button>
      <section class="card p-4">
        <div class="flex flex-wrap items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-lg font-extrabold leading-tight">${esc(j.name)}</div>
            <div class="text-xs text-black/55 mt-0.5">${esc([j.dealer ? `Dealer: ${j.dealer}` : null, (j.pms || []).length ? `PM: ${j.pms.join(", ")}` : null, `${day(j.start)} to ${day(j.end)}`, j.days_since_end != null && j.days_since_end >= 0 ? `ended ${j.days_since_end} days ago` : null].filter(Boolean).join(" · "))}</div>
          </div>
          <div class="text-right"><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">Margin so far</div>
            <div class="font-extrabold tabular-nums ${j.margin_pct != null && j.margin_pct < 0 ? "text-rose-700" : ""}">${j.margin_pct != null ? `${j.margin_pct.toFixed(1)}%` : "—"}</div>
            ${j.profit != null ? `<div class="text-[11px] text-black/50">${money0(j.profit)} profit</div>` : ""}</div>
        </div>
        <div class="flex flex-wrap gap-2 mt-3">
          <button type="button" class="pd-btn" data-act="drawer">Quick view</button>
          <a class="pd-btn" href="${projectLink(j.entity_id)}">Open project workspace</a>
          <span data-flags class="contents">${j.flags.map((f) => chip(f.text, C[f.tone])).join(" ")}</span>
        </div>
        <div class="co-money mt-3" data-money>${moneyTiles(j.money)}</div>
        <div class="co-fc mt-3" data-fc><span class="text-xs text-black/40">Cash forecast…</span></div>
        <div class="su-stages co-stages mt-3">${GROUPS.map((g) => `<div class="su-stage" data-group="${g}">
          <div class="flex items-center justify-between"><div class="text-[11px] uppercase tracking-wide font-bold text-black/50">${g}</div><div class="text-[11px] font-bold tabular-nums text-black/45" data-n>${groupCount(j, g)}</div></div>
          <div class="grid gap-1 mt-1.5" data-links>${j.steps.filter((s) => s.group === g).map(stepLink).join("")}</div></div>`).join("")}</div>
        <div class="text-[11px] text-black/45 mt-2">Click a step to open it below.</div>
      </section>
      <section class="card p-4 su-sec" data-planned>
        <div class="su-h">Still planned</div>
        <div class="text-xs text-black/55 mt-1">What the job's schedules still plan to bill or pay. Cash Flow counts it until the job is closed out, and closing out drops whatever is left. Fix or clear stale rows here first.</div>
        <div class="grid gap-2 mt-2" data-planned-body><span class="text-xs text-black/40">Loading…</span></div>
      </section>
      ${GROUPS.map((g) => `<section class="card p-4 su-sec">
        <div class="su-h">${g} <span class="text-xs font-bold text-black/40 tabular-nums" data-gn="${g}">${groupCount(j, g)}</span></div>
        <div class="grid gap-2 mt-2">${j.steps.filter((s) => s.group === g).map((s) => stepCardHtml(headParts(j, s))).join("")}</div>
      </section>`).join("")}`;

    box.querySelector("[data-back]").addEventListener("click", () => { st.open = false; root.classList.remove("su-open"); });
    box.querySelector('[data-act="drawer"]').addEventListener("click", () =>
      openProjectDrawer({ entityId: j.entity_id, name: j.name, onChange: () => reload(j.entity_id), backLabel: "Project Closeout", backHash: "#/closeout" }));
    D.cards = bindStepCards(box, { onOpen: async (key, body) => { const d = await getDetail(j.entity_id); if (BODY[key]) BODY[key](j, d, body); else body.innerHTML = ""; } });
    box.addEventListener("click", async (e) => {
      const a = e.target.closest("[data-jump]");
      if (a) { e.preventDefault(); D.cards.open(a.dataset.jump); return; }
      const b = e.target.closest("[data-mark]");
      if (!b) return;
      const step = b.dataset.step;
      const status = b.dataset.mark || null;
      let note = null, closeAll = false;
      if (status) {
        const others = j.steps.filter((x) => x.state === "todo" && x.key !== "margin");
        if (step === "margin" && others.length) {
          if (!confirm(`${others.length} step${others.length === 1 ? " is" : "s are"} still open:\n• ${others.map((x) => x.label).join("\n• ")}\n\nClose this job out anyway? ${others.length === 1 ? "It" : "They"} will be marked Reviewed with your note.`)) return;
          closeAll = true;
        }
        note = prompt(step === "signoff" ? "Sign-off note (optional): e.g. numbers reviewed, OK to close"
          : status === "done" ? (closeAll ? "Why is this job being closed with steps open? (kept with the job)" : "Note for the record (optional): e.g. margin reviewed with Luke")
          : status === "reviewed" ? "Note for the record (optional): e.g. books closed, crew paid in full per Luke"
          : status === "noted" ? "What's still open? (kept with the job; the step stays open)"
          : "Why isn't this needed? (kept with the job)");
        if (note === null) return;
        if (status === "noted" && !note.trim()) { alert("Say what's still open."); return; }
        if (closeAll && !note.trim()) { alert("Add a short note saying why the open steps are OK."); return; }
      }
      b.disabled = true;
      try {
        const row = await api(`/closeout/job/${encodeURIComponent(j.entity_id)}/step/${step}`, { method: "POST", body: JSON.stringify({ status, note, close_all: closeAll }) });
        Object.assign(j, row);
        if (row.closed && st.view !== "closed") {
          st.jobs = st.jobs.filter((x) => x.entity_id !== j.entity_id);
          st.closedJobs = null;
          toast(`${j.name} closed out.`);
          st.sel = visible()[0]?.entity_id || null;
          render();
          return;
        }
        if (!row.closed && st.view === "closed") { st.closedJobs = (st.closedJobs || []).filter((x) => x.entity_id !== j.entity_id); load(); return; }
        refreshHeads(j);
        root.querySelector("#coList").innerHTML = listHtml(); bindList();
      } catch (er) { b.disabled = false; alert(`Couldn't save: ${er?.message || er}`); }
    });
    const next = j.steps.find((s) => s.state === "todo");
    if (next) D.cards.open(next.key, { scroll: false });
    loadForecast(j, box.querySelector("[data-fc]"));
    loadPlanned(j, box.querySelector("[data-planned-body]"));
  }

  // ── Still planned (2026-11-22): the schedules' leftover plans, by kind, with
  // the same Invoice / Crew / Expense panels Project Setup shows to fix them.
  const PLAN_KINDS = [
    ["invoice", "Invoices still to bill", "invoice", "to bill"],
    ["crew", "Crew payments still to pay", "crew", "to pay"],
    ["expense", "Expenses still to pay", "expense", "to pay"],
  ];
  const mdy = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${m}/${d}/${y.slice(2)}`; };
  const planHead = (x, verb) => x.n
    ? `<b class="tabular-nums">${money0(x.total)}</b> <span class="text-black/55">${verb}, ${x.n} planned row${x.n === 1 ? "" : "s"}</span>
       ${x.n_past ? chip(`${money0(x.past)} dated in the past`, C.warn, "These dates have passed: re-date them, or clear them if the money already moved") : ""}`
    : `<span class="text-black/45">Nothing planned</span>`;
  const planList = (x) => {
    if (!x.n) return "";
    const list = x.items.slice(0, 40).map((i) => `<tr class="border-t border-black/5">
        <td class="py-1 pr-3 tabular-nums whitespace-nowrap">${mdy(i.date)}</td>
        <td class="py-1 pr-3 min-w-0">${esc(i.what)}</td>
        <td class="py-1 pr-2 text-right tabular-nums whitespace-nowrap">${money0(i.amount)}</td>
        <td class="py-1 text-right">${i.past ? chip("Past", C.warn) : ""}</td></tr>`).join("");
    const more = x.items.length > 40 ? `<div class="text-[11px] text-black/45 mt-1">+${x.items.length - 40} more in the schedule below.</div>` : "";
    return `<div class="overflow-x-auto"><table class="w-full text-xs"><tbody>${list}</tbody></table></div>${more}`;
  };
  async function loadPlanned(j, el) {
    if (!el) return;
    const openKinds = new Set([...el.querySelectorAll("details[open][data-kind]")].map((x) => x.dataset.kind));
    let p;
    try { p = await api(`/closeout/job/${encodeURIComponent(j.entity_id)}/planned`); }
    catch (e) { if (el.isConnected) el.innerHTML = `<span class="text-xs text-rose-700">Couldn't load the plans: ${esc(e?.message || e)}</span>`; return; }
    if (!el.isConnected) return;
    const rows = PLAN_KINDS.map(([k, label, only, verb]) => {
      const x = p.kinds[k] || { total: 0, n: 0, items: [] };
      return `<details class="rounded-lg border border-black/10" data-kind="${k}" ${openKinds.has(k) ? "open" : ""}>
        <summary class="cursor-pointer px-3 py-2 flex flex-wrap items-center gap-2 text-xs"><span class="font-bold">${label}</span><span class="flex flex-wrap items-center gap-2" data-plan-head>${planHead(x, verb)}</span></summary>
        <div class="px-3 pb-3">
          <div data-plan-list>${planList(x)}</div>
          <button type="button" class="pd-btn mt-2" data-plan-edit="${only}">Edit the ${only === "invoice" ? "invoice" : only === "crew" ? "crew payment" : "expense"} schedule</button>
          <div class="mt-2" data-plan-slot="${only}"></div>
        </div></details>`;
    });
    const undated = (p.undated_in > 0.5 || p.undated_out > 0.5)
      ? `<div class="text-[11.5px] text-black/55">${[p.undated_in > 0.5 ? `${money0(p.undated_in)} to bill` : "", p.undated_out > 0.5 ? `${money0(p.undated_out)} to pay` : ""].filter(Boolean).join(" and ")} has no date yet, so Cash Flow lists it apart.</div>` : "";
    el.innerHTML = rows.join("") + undated;
    el.querySelectorAll("[data-plan-edit]").forEach((b) => b.addEventListener("click", () => {
      const slot = el.querySelector(`[data-plan-slot="${b.dataset.planEdit}"]`);
      if (slot.dataset.mounted) return;
      slot.dataset.mounted = "1";
      slot.classList.add("su-embed");
      b.remove();
      // opening the panel lines its plans up with QuickBooks first: re-read the totals after
      mountBillingPanel(slot, j.entity_id, { only: b.dataset.planEdit }).then(() => refreshPlannedTotals(j, el));
    }));
  }
  // a save in any embedded schedule refreshes the totals (the panels stay mounted)
  if (window.__coPlanListener) window.removeEventListener("opi:billing-changed", window.__coPlanListener);
  window.__coPlanListener = (ev) => {
    const box = root.querySelector("#coDetail");
    if (!box?.isConnected || !D || String(ev.detail?.entityId) !== String(D.j.entity_id)) return;
    clearTimeout(window.__coPlanTimer);
    window.__coPlanTimer = setTimeout(() => {
      refreshPlannedTotals(D.j, box.querySelector("[data-planned-body]"));
      loadForecast(D.j, box.querySelector("[data-fc]"));
    }, 400);
  };
  window.addEventListener("opi:billing-changed", window.__coPlanListener);
  // re-read the totals without tearing down an open schedule panel
  async function refreshPlannedTotals(j, el) {
    if (!el) return;
    const mounted = [...el.querySelectorAll("[data-plan-slot][data-mounted]")];
    if (!mounted.length) return loadPlanned(j, el);
    let p;
    try { p = await api(`/closeout/job/${encodeURIComponent(j.entity_id)}/planned`); } catch (_) { return; }
    for (const [k, , , verb] of PLAN_KINDS) {
      const x = p.kinds[k] || { total: 0, n: 0, items: [] };
      const det = el.querySelector(`details[data-kind="${k}"]`);
      if (!det) continue;
      det.querySelector("[data-plan-head]").innerHTML = planHead(x, verb);
      det.querySelector("[data-plan-list]").innerHTML = planList(x);
    }
  }

  // ── Cash forecast (backend projects/books.py): a job that ended on/after Oct 1
  // counts until it's closed out; an older one only when someone includes it.
  async function loadForecast(j, el) {
    if (!el) return;
    let f;
    try { f = await api(`/closeout/job/${encodeURIComponent(j.entity_id)}/forecast`); }
    catch (e) { el.innerHTML = `<span class="text-xs text-rose-700">Couldn't load the cash forecast: ${esc(e?.message || e)}</span>`; return; }
    if (!el.isConnected) return;
    const p = f.plans || { in: {}, out: {} };
    // "$X to bill and $Y to pay", leaving out the zero side
    const pair = (i, o) => [i > 0.5 ? `${money0(i)} to bill` : "", o > 0.5 ? `${money0(o)} to pay` : ""].filter(Boolean).join(" and ");
    const parts = [
      pair(p.in.weeks || 0, p.out.weeks || 0) && `${pair(p.in.weeks || 0, p.out.weeks || 0)} in the next ${p.weeks || 13} weeks`,
      pair(p.in.past_due || 0, p.out.past_due || 0) && `${pair(p.in.past_due || 0, p.out.past_due || 0)} with dates already past (listed under Overdue on Cash Flow, counted once re-dated)`,
      pair(p.in.later || 0, p.out.later || 0) && `${pair(p.in.later || 0, p.out.later || 0)} after that`,
    ].filter(Boolean);
    const wk = parts.join("; ");
    const pd = "", later = "";
    const none = parts.length === 0 && !(p.backlog_in > 0.5);
    const s = f.state || {};
    const cut = f.cutover ? new Date(f.cutover + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "Oct 1, 2026";
    let tone = C.quiet, title = "", body = "", btn = "";
    if (s.why === "closed_out") {
      title = "Not in the cash forecast"; body = "Closed out: its books are closed.";
    } else if (s.why === "open_until_closed_out" || s.why === "not_finished") {
      tone = C.info; title = "In the cash forecast until it's closed out";
      body = none ? "Nothing planned is left to bill or pay." : `Its plans add ${wk}${pd}${later}.`;
    } else if (s.why === "included") {
      tone = C.info; title = "Included in the cash forecast";
      const inc = s.included || {};
      body = `${none ? "Nothing planned is left to bill or pay." : `Its plans add ${wk}${pd}${later}.`} Included by ${esc(inc.by_email || "someone")}${inc.at ? ` on ${day(inc.at)}` : ""}${inc.note ? `: “${esc(inc.note)}”` : ""}.`;
      btn = `<button type="button" class="pd-btn" data-fc-set="0">Take it out of the forecast</button>`;
    } else {
      title = `Not in the cash forecast (ended before ${cut})`;
      body = none ? "Its plans have nothing left to bill or pay."
        : `If included, its plans would add ${wk}${pd}${later}. Older plans are often stale (crew paid outside what the app matched), so include it only if money really is still to come or go.`;
      btn = `<button type="button" class="pd-btn" data-fc-set="1">Include in the cash forecast…</button>`;
    }
    el.innerHTML = `<div class="flex flex-wrap items-start gap-2 rounded-lg border border-black/10 px-3 py-2">
        <div class="min-w-0 flex-1"><div class="text-xs font-bold">${chip("Cash forecast", tone)} ${esc(title)}</div>
          <div class="text-[11.5px] text-black/60 mt-1">${body} Open QuickBooks invoices and bills count either way.</div></div>${btn}</div>`;
    el.querySelector("[data-fc-set]")?.addEventListener("click", async (ev) => {
      const include = ev.currentTarget.dataset.fcSet === "1";
      let note = null;
      if (include) {
        note = prompt(`Include ${j.name} in the cash forecast until it's closed out?\n\nWhy is money still to come or go? (kept with the job)`);
        if (note === null) return;
        if (!note.trim()) { alert("Say why (for example: final invoice still to send)."); return; }
      } else if (!confirm("Take this job's plans out of the cash forecast?")) return;
      ev.currentTarget.disabled = true;
      try {
        await api(`/closeout/job/${encodeURIComponent(j.entity_id)}/forecast`, { method: "POST", body: JSON.stringify({ include, note }) });
        j.forecast = include ? "included" : "off";
        toast(include ? "Included in the cash forecast." : "Taken out of the cash forecast.");
        root.querySelector("#coList").innerHTML = listHtml(); bindList();
        loadForecast(j, el);
      } catch (e) { ev.currentTarget.disabled = false; alert(`Couldn't save: ${e?.message || e}`); }
    });
  }

  // after a mark or a reload: ticks, counts, money and card heads, open cards kept
  function refreshHeads(j) {
    const box = root.querySelector("#coDetail");
    if (!box || !D || D.j.entity_id !== j.entity_id) return;
    for (const g of GROUPS) {
      box.querySelector(`[data-group="${g}"] [data-n]`).textContent = groupCount(j, g);
      box.querySelector(`[data-group="${g}"] [data-links]`).innerHTML = j.steps.filter((s) => s.group === g).map(stepLink).join("");
      box.querySelector(`[data-gn="${g}"]`).textContent = groupCount(j, g);
    }
    box.querySelector("[data-money]").innerHTML = moneyTiles(j.money);
    box.querySelector("[data-flags]").innerHTML = j.flags.map((f) => chip(f.text, C[f.tone])).join(" ");
    for (const s of j.steps) D.cards.setHead(s.key, headParts(j, s));
  }

  // ── Step bodies ─────────────────────────────────────────────────────────
  const err = (x) => (x && x.error ? `<div class="text-xs text-rose-700">Couldn't load this: ${esc(x.error)}</div>` : "");
  const facts = (list) => `<div class="su-facts">${list.filter(Boolean).map(([k, v, cls]) => `<div><span>${k}</span><b class="${cls || ""}">${v}</b></div>`).join("")}</div>`;
  const table = (heads, rows, empty) => (rows.length ? `<div class="overflow-x-auto"><table class="w-full text-xs su-table"><thead><tr>${heads.map((h) => `<th class="${h.startsWith(">") ? "text-right" : "text-left"}">${esc(h.replace(/^>/, ""))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` : `<div class="text-xs text-black/55">${empty}</div>`);
  const r = (v, cls = "") => `<td class="text-right tabular-nums ${cls}">${v}</td>`;
  const isImg = (f) => /\.(jpe?g|png|heic|gif|webp)$/i.test(f.filename || "");
  const docBtn = (f) => `<button type="button" class="pd-btn su-doc" data-doc="${f.id}" data-fn="${esc(f.filename)}" title="${esc(f.filename)}">${DOC_ICON}<span class="truncate">${esc(f.filename)}</span></button>`;
  const wireDocs = (el) => el.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => openDocViewer({ id: Number(b.dataset.doc), filename: b.dataset.fn })));
  const statusTxt = { completed: "Completed", in_progress: "In progress", not_started: "Not started", needs_attention: "Needs attention", pending: "Pending", on_hold: "On hold", canceled: "Canceled" };
  const pct1 = (v) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);
  const pc = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);

  const BODY = {
    marked_complete(j, d, body) {
      const x = d.marked_complete || {};
      body.innerHTML = err(x) || `${table(["Schedule line", "Start", "End", ">Overage", "Status"], (x.items || []).map((i, n) => `<tr><td>#${n + 1}</td><td>${day(i.start)}</td><td>${day(i.end)}</td>${r(i.overage_days || 0)}<td>${esc(statusTxt[i.status] || i.status || "")}</td></tr>`), "No schedule lines.")}
        <div class="text-xs text-black/55 mt-2">${(x.pms || []).length ? `PM: ${esc(x.pms.join(", "))}. ` : ""}The status follows the dates: if the work is done, set the real last day on the project's Assignment (Open project workspace).</div>`;
    },
    completion_form(j, d, body) {
      const x = d.completion_form || {};
      if (x.error) { body.innerHTML = err(x); return; }
      const docs = x.documents || [];
      const pdfs = docs.filter((f) => !isImg(f));
      const imgs = docs.filter(isImg);
      body.innerHTML = `${(x.submissions || []).length ? `<div class="text-[10px] uppercase tracking-wide font-bold text-black/45 mb-1">Completion forms from the crew portal</div>
          ${table(["Submitted", "By", "Signed by", "Status"], x.submissions.map((s) => `<tr><td>${day(s.submitted_at)}</td><td>${esc(s.by || "")}</td><td>${esc(s.signer || "")}</td><td>${esc(s.status || "")}</td></tr>`), "")}` : ""}
        <div class="text-[10px] uppercase tracking-wide font-bold text-black/45 mt-2 mb-1">Completion paperwork in Drive</div>
        ${pdfs.length ? pdfs.map(docBtn).join("") : `<div class="text-xs text-black/55">No completion form in the job's folders.</div>`}
        ${imgs.length ? `<details class="mt-2"><summary class="text-xs font-semibold text-black/60 cursor-pointer">${imgs.length} completion photo${imgs.length === 1 ? "" : "s"}</summary><div class="mt-2">${imgs.map(docBtn).join("")}</div></details>` : ""}`;
      wireDocs(body);
    },
    change_orders(j, d, body) {
      const x = d.change_orders || {};
      if (x.error) { body.innerHTML = err(x); return; }
      const rows = [
        ...(x.estimates || []).map((e) => `<tr><td>#${esc(e.number || "")}${e.original ? ` ${chip("Contract", C.quiet)}` : ""}</td><td>QuickBooks</td><td>${day(e.date)}</td>${r(money0(e.amount))}<td>${esc(e.status || "")}</td><td>${e.invoiced ? chip("Invoiced", C.good) : e.original ? "" : chip("Not invoiced", C.warn)}</td></tr>`),
        ...(x.app_change_orders || []).map((c) => `<tr><td>${esc(c.number || c.title || "")}</td><td>App</td><td>${day(c.date)}</td>${r(money0(c.amount))}<td>${esc(c.status || "")}</td><td>${c.qbo_estimate_id ? chip("In QuickBooks", C.good) : chip("Not in QuickBooks", C.warn)}</td></tr>`),
      ];
      body.innerHTML = `${table(["Estimate / CO", "Where", "Date", ">Amount", "Status", "Billing"], rows, "No change orders on this job.")}
        ${x.pending ? `<div class="su-warn mt-2">${x.pending} change order${x.pending === 1 ? " is" : "s are"} still pending.</div>` : ""}`;
    },
    final_invoice(j, d, body) { invoicesBody(d.final_invoice, body, "bill"); },
    paid(j, d, body) { invoicesBody(d.paid, body, "paid"); },
    retainage(j, d, body) { invoicesBody(d.retainage, body, "ret"); },
    crew_paid(j, d, body) {
      const x = d.crew_paid || {};
      if (x.error) { body.innerHTML = err(x); return; }
      const left = x.left || 0;
      body.innerHTML = `${facts([["Contract labor on the estimates", money0(x.budget)], ["Paid (QuickBooks)", money0(x.paid)],
          [left < -1 ? "Over the estimate" : "Left on the estimate", money0(Math.abs(left)), left > 1 ? "text-amber-700" : "text-emerald-700"]])}
        <div class="mt-2">${table(["Crew", ">Paid", ">Payment Schedule (reference)"], (x.crews || []).map((c) => `<tr><td class="font-semibold">${esc(c.crew || "")}</td>${r(money0(c.paid))}<td class="text-right tabular-nums text-black/55">${c.deal != null ? `${money0(c.deal)}${c.deal_owed > 1 ? ` · ${money0(c.deal_owed)} unpaid` : ""}` : "none"}</td></tr>`), "No contract labor paid on this job.")}</div>
        ${(x.payments || []).length ? `<details class="mt-2"><summary class="text-xs font-semibold text-black/60 cursor-pointer">${x.payments.length} payment${x.payments.length === 1 ? "" : "s"} to crews</summary><div class="mt-2">${table(["Date", "Type", "Crew", "Description", ">Amount"], x.payments.map((p) => `<tr><td>${day(p.date)}</td><td>${esc(p.type || "")}</td><td>${esc(p.crew || "")}</td><td class="text-black/55">${esc((p.description || "").slice(0, 80))}</td>${r(money0(p.amount))}</tr>`), "")}</div></details>` : ""}
        <div class="text-xs text-black/50 mt-2">"Left on the estimate" is the estimate not used up, not money owed: crew deals are often below the estimate's labor line. When the crew is paid in full, press Close (reviewed).</div>`;
    },
    expenses(j, d, body) {
      const x = d.expenses || {};
      if (x.error) { body.innerHTML = err(x); return; }
      const cats = x.categories || [];
      const tot = (k) => cats.reduce((a, c) => a + (c[k] || 0), 0);
      body.innerHTML = `${table(["Expense item", ">On the estimates", ">Spent", ">Left"], cats.map((c) => `<tr><td class="font-semibold">${esc(c.category)}</td>${r(money0(c.estimate))}${r(money0(c.spent))}${r(c.left < -1 ? `${money0(-c.left)} over` : money0(c.left), c.left > 1 ? "text-amber-700" : c.left < -1 ? "text-rose-700" : "")}</tr>`)
          .concat(cats.length > 1 ? [`<tr class="font-bold"><td>Total</td>${r(money0(tot("estimate")))}${r(money0(tot("spent")))}${r(money0(tot("estimate") - tot("spent")))}</tr>`] : []), "No expense items on the estimates or in QuickBooks.")}
        <div class="text-[10px] uppercase tracking-wide font-bold text-black/45 mt-3 mb-1">Unpaid bills on this job</div>
        ${table(["Vendor", "Bill", "Date", "Due", ">On this job", ">Open"], (x.bills || []).map((b) => `<tr><td class="font-semibold">${esc(b.vendor || "")}</td><td>${esc(b.doc_number || "")}</td><td>${day(b.date)}</td><td>${day(b.due_date)} ${b.past_due ? chip("Past due", C.bad) : ""}</td>${r(money2(b.job_amount))}${r(money2(b.balance))}</tr>`), "None: every bill on the job is paid.")}
        <div class="text-xs text-black/50 mt-2">Spent = bills and card charges on the job in QuickBooks. When nothing more is coming, press Close (reviewed), even if it's under the estimate.</div>`;
    },
    signoff(j, d, body) {
      const x = d.signoff || {};
      if (x.error) { body.innerHTML = err(x); return; }
      const p = x.progress;
      body.innerHTML = `<div class="text-sm">Every job gets a 100% sign-off at close-out, whatever its size. ${st.meta.can_sign ? "Sign off here (Sign off above) or on Progress Checks." : "Someone with sign-off access (owners) signs it off here or on Progress Checks."}</div>
        ${p ? `<div class="mt-2">${facts([["Progress check", esc(p.status || "—")], ["Time used", pc(p.pct_time)], ["Invoiced", pc(p.pct_invoiced)], ["Labor paid", pc(p.pct_labor)], ["Cost spent", pc(p.pct_cost)], p.last_checkpoint != null ? ["Last checkpoint", `${p.last_checkpoint}%${p.last_checkpoint_date ? ` · ${day(p.last_checkpoint_date)}` : ""}`] : null])}</div>` : ""}
        ${(x.signoffs || []).length ? `<div class="mt-2">${table(["Milestone", "Decision", "By", "When", "Note"], x.signoffs.map((s) => `<tr><td>${esc(String(s.milestone))}%</td><td>${esc(s.decision || "")}</td><td>${esc(s.by || "")}</td><td>${day(s.at)}</td><td>${esc(s.note || "")}</td></tr>`), "")}</div>` : ""}`;
    },
    margin(j, d, body) {
      const x = d.margin || {};
      if (x.error) { body.innerHTML = err(x); return; }
      body.innerHTML = `${facts([["Revenue", money0(x.revenue)], ["Cost", money0(x.cost)], ["Profit", money0(x.profit), x.profit < 0 ? "text-rose-700" : ""], ["Margin", pct1(x.margin_pct), x.margin_pct != null && x.margin_pct < 10 ? "text-rose-700" : ""], ["Planned margin", pct1(x.planned_margin_pct)]])}
        <div class="mt-2">${table(["Cost category", ">Estimate", ">Actual", ">Over"], (x.categories || []).map((c) => `<tr${c.over > 0 ? ' class="su-diff"' : ""}><td>${esc(c.category || "")}</td>${r(money0(c.estimate))}${r(money0(c.actual))}${r(c.over > 0 ? money0(c.over) : "", c.over > 0 ? "font-bold text-rose-700" : "")}</tr>`), "No cost categories on record.")}</div>
        <div class="text-xs text-black/50 mt-2">When the numbers are right, press "Close out" on this step. Any step still open is marked Reviewed with your note, and the job leaves the list (find it under Closed; Undo there reopens it).</div>`;
    },
  };

  function invoicesBody(x, body, focus) {
    x = x || {};
    if (x.error) { body.innerHTML = err(x); return; }
    const rows = (x.invoices || []).filter((i) => focus !== "ret" || i.retainage).map((i) => `<tr${focus === "paid" && i.balance > 0.5 ? ' class="su-diff"' : ""}><td class="font-semibold">#${esc(i.doc_number || "")}${i.retainage ? ` ${chip("Retainage", C.info)}` : ""}</td><td>${day(i.date)}</td><td>${day(i.due_date)}</td>${r(money2(i.total))}${r(i.balance > 0.5 ? money2(i.balance) : "Paid", i.balance > 0.5 ? "font-bold" : "text-emerald-700")}</tr>`);
    body.innerHTML = `${facts([["Contract", money0(x.contract)], ["Invoiced", money0(x.invoiced)], ["Still to bill", money0(x.unbilled), x.unbilled > 1 ? "text-rose-700" : ""], ["Owed to OPI", money0(x.open_ar), x.open_ar > 1 ? "text-amber-700" : ""], x.retainage > 1 ? ["Retainage held", money0(x.retainage)] : null])}
      <div class="mt-2">${table(["Invoice", "Date", "Due", ">Amount", ">Open"], rows, focus === "ret" ? "No retainage invoices." : "No invoices yet.")}</div>
      ${focus === "bill" && (x.schedule_to_bill || []).length ? `<div class="text-[10px] uppercase tracking-wide font-bold text-black/45 mt-3 mb-1">Still on the invoice schedule, not invoiced</div>
        ${table(["Line", ">%", "Invoice date", ">Amount"], x.schedule_to_bill.map((s) => `<tr><td>${esc(s.label || "")}${s.estimate ? ` <span class="text-black/45">· est ${esc(String(s.estimate))}</span>` : ""}</td>${r(s.pct != null ? `${Math.round(s.pct)}%` : "")}<td>${day(s.invoice_date)}</td>${r(money2(s.amount))}</tr>`), "")}` : ""}`;
  }

  // Close out every job in the current list at once (owners): one note, kept on each job.
  function bulkClose() {
    const jobs = visible();
    if (!jobs.length) return;
    const label = (TABS.find(([k]) => k === st.view) || [null, TILES[st.view]])[1];
    const m = modal(`
      <div class="text-lg font-extrabold">Close out ${jobs.length} job${jobs.length === 1 ? "" : "s"}</div>
      <div class="text-sm text-black/60 mt-1">${esc(label || "")}${st.q || st.pm ? " (with your search and PM filter)" : ""}. On each job, every step still open is marked <b>Reviewed</b> with this note, the 100% sign-off included, and the job is closed out. Each one is kept in its history with your name.</div>
      <div class="text-xs text-black/55 mt-2 max-h-40 overflow-y-auto border border-black/10 rounded-lg p-2">${jobs.slice(0, 60).map((j) => `<div class="truncate">${esc(j.name)}${j.end ? ` <span class="text-black/40">· ended ${day(j.end)}</span>` : ""}</div>`).join("")}${jobs.length > 60 ? `<div class="text-black/45">and ${jobs.length - 60} more</div>` : ""}</div>
      <label class="grid gap-1 mt-3 text-sm"><span class="font-semibold">Note (required)</span>
        <textarea data-note class="input" rows="2" placeholder="e.g. Finished before the app tracked crew pay and completion forms; reviewed with Luke 11/12"></textarea></label>
      <div class="flex justify-end gap-2 mt-4">
        <button type="button" class="pd-btn" data-cancel>Cancel</button>
        <button type="button" class="btn-primary" data-go>Close out ${jobs.length}</button>
      </div>`, { wide: true });
    m.querySelector("[data-cancel]").addEventListener("click", () => closeModal(m));
    m.querySelector("[data-go]").addEventListener("click", async (e) => {
      const note = m.querySelector("[data-note]").value.trim();
      if (!note) { m.querySelector("[data-note]").focus(); return; }
      e.target.disabled = true; e.target.textContent = "Closing…";
      try {
        const r = await api("/closeout/bulk-close", { method: "POST", body: JSON.stringify({ entity_ids: jobs.map((j) => j.entity_id), note }) });
        closeModal(m);
        toast(`${r.closed} job${r.closed === 1 ? "" : "s"} closed out.`);
        st.closedJobs = null; st.sel = null;
        load();
      } catch (er) { e.target.disabled = false; e.target.textContent = `Close out ${jobs.length}`; alert(`Couldn't close them: ${er?.message || er}`); }
    });
  }

  async function reload(eid) {
    try {
      const row = await api(`/closeout/job/${encodeURIComponent(eid)}`);
      const j = pool().find((x) => x.entity_id === eid);
      if (j) Object.assign(j, row);
      delete cache[eid];
      root.querySelector("#coList").innerHTML = listHtml(); bindList();
      if (j) refreshHeads(j);
    } catch (_) { /* the next load catches up */ }
  }

  load();
}
