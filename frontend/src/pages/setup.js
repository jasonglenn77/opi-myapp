// Project Setup: every won job from "PO received" until it's ready to start, in one
// place. Left: the queue, with how far along each job is and what needs attention.
// Right: the selected job, worked top to bottom:
//
//   QuickBooks   PO on file, project + first estimate created (with a drafted
//                estimate to copy from), first invoice sent
//   Assignment   PM (with each PM's workload), crew offer (availability, send,
//                record the answer), dates and job details (the assignment editor)
//   Schedules    the invoice, crew pay and expense schedules the app builds once
//                dates are set, each reviewed and confirmed by staff
//
// Every step is a card (utils/stepcards.js) that opens in place to the tools for
// that step. Steps the data can answer complete themselves; the rest are marked
// here (backend/app/setup/routes.py).
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import { openDocViewer, DOC_ICON } from "../utils/doc-viewer.js";
import { openProjectDrawer } from "../utils/project-drawer.js";
import { mountAssignmentPanel } from "./assignment-panel.js";
import { mountBillingPanel } from "./billing.js";
import { stepCardHtml, bindStepCards } from "../utils/stepcards.js";
import { projectLink } from "../utils/ui.js";

const day = (s) => s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" }) : "—";
const money0 = (n) => `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n || 0)).toLocaleString()}`;
const money2 = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const chip = (txt, cls, title = "") => `<span class="inline-flex items-center text-[10px] font-bold rounded px-1.5 py-0.5 border whitespace-nowrap ${cls}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(txt)}</span>`;
const C = {
  bad: "text-rose-700 bg-rose-50 border-rose-200",
  warn: "text-amber-700 bg-amber-50 border-amber-200",
  good: "text-emerald-700 bg-emerald-50 border-emerald-200",
  info: "text-sky-700 bg-sky-50 border-sky-200",
  quiet: "text-slate-600 bg-slate-100 border-black/10",
};
const STATE = {
  done: ["Done", C.good], not_needed: ["Not needed", C.quiet], todo: ["To do", C.warn],
  waiting: ["Waiting", C.info], locked: ["Later", C.quiet],
};
const ICON = {
  done: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#059669"/><path d="M6 10.5l2.5 2.5L14 7.5" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  not_needed: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#f1f5f9" stroke="#94a3b8"/><path d="M6.5 10h7" stroke="#64748b" stroke-width="2" stroke-linecap="round"/></svg>`,
  todo: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#fff" stroke="#d97706" stroke-width="2"/></svg>`,
  waiting: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#e0f2fe" stroke="#0284c7" stroke-width="1.5"/><path d="M10 6v4l2.5 1.5" stroke="#0284c7" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`,
  locked: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#f8fafc" stroke="#cbd5e1" stroke-dasharray="2 2"/></svg>`,
};
const VIEWS = [
  ["all", "All new jobs"], ["action", "Urgent"], ["QuickBooks", "QuickBooks"], ["Assignment", "Assignment"],
  ["Schedules", "Schedules"],
];
const MANUAL = { details: "Mark checked", invoice_schedule: "Mark reviewed", crew_schedule: "Mark reviewed", expense_schedule: "Mark reviewed" };

export async function setupPage(routeFn) {
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem("opi_setup") || "{}"); } catch (_) {}
  const isPhone = () => window.matchMedia("(max-width: 1023px)").matches;
  // Phones show the list or one job, not both: `open` = a job is open full width.
  // KPI tiles filter the list exactly (st.kpi), on top of the tab
  const KPI = {
    noqbo: ["Not in QuickBooks", (j) => stepOf(j, "qbo_project").state !== "done"],
    firstinv: ["First invoice to send", (j) => stepOf(j, "first_invoice").state === "todo"],
    soon: ["Starting soon with gaps", (j) => j.flags.some((f) => f.text.startsWith("Starts in"))],
    offers: ["Crew offers waiting", (j) => stepOf(j, "crew").state === "waiting"],
    sched: ["Schedules to review", (j) => openIn(j, "Schedules")],
  };
  const st = { kpi: null, jobs: [], view: VIEWS.some(([k]) => k === saved.view) ? saved.view : "all", q: "", pm: "", sel: saved.sel || null, open: false, cache: {} };
  const remember = () => { try { sessionStorage.setItem("opi_setup", JSON.stringify({ view: st.view, sel: st.sel })); } catch (_) {} };

  setShell({
    title: "Project Setup",
    subtitle: "New jobs (100% won) that still have setup steps to finish: QuickBooks, assignment and schedules. A job leaves this list once every step is done.",
    bodyHtml: `<div id="suRoot"><div class="card p-6 text-sm text-black/45">Loading won jobs…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("suRoot");

  async function load(keepDetail = false) {
    try {
      const d = await api("/setup/queue");
      st.jobs = d.jobs;
      if (!st.sel || !st.jobs.some((j) => j.key === st.sel)) st.sel = visible()[0]?.key || st.jobs[0]?.key || null;
      render(keepDetail);
    } catch (e) {
      root.innerHTML = `<div class="card p-6 text-sm text-red-700">Couldn't load won jobs: ${escapeHtml(e?.message || String(e))}</div>`;
    }
  }

  const stepOf = (j, k) => j.steps.find((s) => s.key === k) || {};
  // a job shows under every stage that still has an open step (not just its first one)
  const openIn = (j, stage) => j.steps.some((x) => x.stage === stage && (x.state === "todo" || x.state === "waiting"));
  const needsAction = (j) => j.flags.some((f) => f.tone === "bad" || f.tone === "warn");
  function visible() {
    const q = st.q.trim().toLowerCase();
    return st.jobs.filter((j) => {
      if (st.kpi && KPI[st.kpi] && !KPI[st.kpi][1](j)) return false;
      if (st.view === "action" && !needsAction(j)) return false;
      if (["QuickBooks", "Assignment", "Schedules"].includes(st.view) && !openIn(j, st.view)) return false;
      if (st.pm && !(j.pms || []).includes(st.pm)) return false;
      if (q && !`${j.project_name || ""} ${j.title || ""} ${j.quote_number || ""} ${j.dealer || ""} ${j.customer || ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function kpis() {
    const n = (k) => st.jobs.filter(KPI[k][1]).length;
    const tile = (k, caption, bad) => `<button type="button" class="card p-4 text-left su-kpi${st.kpi === k ? " on" : ""}" data-kpi="${k}" aria-pressed="${st.kpi === k}">
        <div class="text-[10px] uppercase tracking-wide font-bold text-black/45">${KPI[k][0]}</div>
        <div class="text-2xl font-extrabold tabular-nums ${bad && n(k) ? "text-rose-700" : ""}">${n(k)}</div>
        <div class="text-xs text-black/50">${caption}</div></button>`;
    return `<div class="su-kpis">
      ${tile("noqbo", "Won, project still to create", true)}
      ${tile("firstinv", "In QuickBooks, nothing invoiced")}
      ${tile("soon", "Within 14 days, no PM, crew or dates", true)}
      ${tile("offers", "Sent, no answer yet")}
      ${tile("sched", "Dates set, schedules not confirmed")}
    </div>`;
  }

  function listHtml() {
    const rows = visible();
    if (!rows.length) return `<div class="p-4 text-sm text-black/50">No jobs here.</div>`;
    return rows.map((j) => {
      const pct = Math.round((100 * j.done) / j.total);
      return `<button type="button" class="su-job${j.key === st.sel ? " on" : ""}" data-key="${escapeHtml(j.key)}" aria-current="${j.key === st.sel}">
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <div class="font-bold text-sm truncate">${escapeHtml(j.project_name || `${j.quote_number} · ${j.title}`)}</div>
            <div class="text-[11.5px] text-black/50 truncate">${escapeHtml([j.dealer, money0(j.value), j.start ? `starts ${day(j.start)}` : (j.won ? `won ${day(j.won)}` : "")].filter(Boolean).join(" · "))}</div>
          </div>
          <span class="text-[11px] font-bold tabular-nums text-black/55">${j.done}/${j.total}</span>
        </div>
        <div class="su-bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
        <div class="flex flex-wrap gap-1 mt-1.5">${chip(j.stage === "Ready" ? "Ready" : `Next: ${j.stage}`, j.stage === "Ready" ? C.good : C.quiet)}${j.flags.map((f) => chip(f.text, C[f.tone])).join("")}</div>
      </button>`;
    }).join("");
  }

  function render(keepDetail) {
    const pms = [...new Set(st.jobs.flatMap((j) => j.pms || []))].sort();
    const counts = Object.fromEntries(VIEWS.map(([k]) => [k, null]));
    const prev = st.view; for (const [k] of VIEWS) { st.view = k; counts[k] = visible().length; } st.view = prev;
    const detailEl = keepDetail ? document.getElementById("suDetail") : null;
    root.classList.toggle("su-open", st.open);
    root.innerHTML = `
      ${kpis()}
      <div class="su-bar-row">
        <div class="tabs" role="tablist">${VIEWS.map(([k, l]) => `<button role="tab" class="tab" data-view="${k}" aria-selected="${st.view === k}">${l} <span class="tab-n">${counts[k]}</span></button>`).join("")}</div>
        <input id="suQ" class="input text-sm su-q" placeholder="Search job, quote # or dealer" value="${escapeHtml(st.q)}">
        ${st.kpi ? `<button type="button" class="su-filter" data-clearkpi>Showing: ${escapeHtml(KPI[st.kpi][0])} <span aria-hidden="true">✕</span></button>` : ""}
        <select id="suPm" class="input text-sm su-pm"><option value="">All PMs</option>${pms.map((p) => `<option${p === st.pm ? " selected" : ""}>${escapeHtml(p)}</option>`).join("")}</select>
      </div>
      <div class="su-grid" id="suGrid">
        <div class="card su-list" id="suList">${listHtml()}</div>
        <div id="suDetail" class="grid gap-3 min-w-0" style="grid-template-columns:minmax(0,1fr)"></div>
      </div>`;
    if (detailEl && st.sel) document.getElementById("suDetail").replaceWith(detailEl);
    else renderDetail();
  }

  function refreshList() {
    const el = document.getElementById("suList");
    if (el) el.innerHTML = listHtml();
  }

  // ── Detail ───────────────────────────────────────────────────────────────
  // The job at a glance (header: every step, ticked or not), then one card per
  // stage with a step card per step. A step card opens in place to the tools for
  // that step: the PO, linking the project, the estimate next to the app's draft,
  // the PM workload, crew availability and offers, the PM / crew / dates editor,
  // and the schedules. The first step still to do opens on its own.
  const STAGES = ["QuickBooks", "Assignment", "Schedules"];
  const EDITOR_STEPS = ["pm", "crew", "dates", "details"];
  const SCHED_STEPS = ["invoice_schedule", "crew_schedule", "expense_schedule"];
  let D = null;   // the open job's detail state: { j, cards, editor, billing }

  function headParts(j, s) {
    const btns = [];
    if (s.mark) btns.push(`<button class="pd-btn" data-mark="${s.key}" data-status="">Undo</button>`);
    else if (MANUAL[s.key] && s.state === "todo") btns.push(`<button class="pd-btn" data-mark="${s.key}" data-status="${s.key === "details" ? "done" : "confirmed"}">${MANUAL[s.key]}</button>`);
    else if (s.state === "todo" && ["first_invoice", "po"].includes(s.key)) {
      btns.push(`<button class="pd-btn" data-mark="${s.key}" data-status="done" title="Done outside what the app can see">Mark done</button>`);
      if (s.key === "first_invoice") btns.push(`<button class="pd-btn" data-mark="${s.key}" data-status="not_needed">Not needed</button>`);
    }
    const hint = s.state === "locked" ? (j.project_qbo_id ? "after the dates are set" : "after the project is in QuickBooks") : "";
    return { key: s.key, state: s.state, label: s.label, detail: s.detail, actions: btns.join(""), hint };
  }

  const stageCount = (j, sg) => {
    const ss = j.steps.filter((s) => s.stage === sg);
    return `${ss.filter((s) => s.state === "done" || s.state === "not_needed").length}/${ss.length}`;
  };
  const stepLink = (s) => `<a href="#" class="su-step" data-jump="${s.key}">${ICON[s.state] || ICON.todo}<span>${escapeHtml(s.label)}</span></a>`;

  function renderDetail() {
    let box = document.getElementById("suDetail");
    const j = st.jobs.find((x) => x.key === st.sel);
    if (!box) return;
    // a fresh element per job, so listeners from the last job don't pile up
    const fresh = box.cloneNode(false); box.replaceWith(fresh); box = fresh;
    if (!j) { box.innerHTML = `<div class="card p-6 text-sm text-black/50">Pick a job on the left.</div>`; D = null; return; }
    D = { j, editor: null, billing: null };
    const intro = {
      QuickBooks: "",
      Assignment: j.project_qbo_id ? "" : "Opens once the project is in QuickBooks and the nightly sync brings it in. The PM, crew and dates are saved on the project.",
      Schedules: "Built by the app from the estimates and the job's dates: invoices on the payment terms, crew pay from the estimates' contract labor on payroll Fridays, and expenses by category on the usual timing (Assumptions page). Open each one, check it and confirm it.",
    };
    box.innerHTML = `
      <button type="button" class="su-back" data-back>← All jobs</button>
      <section class="card p-4" data-head>
        <div class="flex flex-wrap items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-lg font-extrabold leading-tight">${escapeHtml(j.project_name || j.title)}</div>
            <div class="text-xs text-black/55 mt-0.5">${escapeHtml([j.title !== j.project_name ? j.title : null, j.dealer ? `Dealer: ${j.dealer}` : null, `Quote #${j.quote_number}`, j.won ? `Won ${day(j.won)}` : null, j.pipeline_status].filter(Boolean).join(" · "))}</div>
          </div>
          <div class="text-right"><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">Order value</div><div class="font-extrabold tabular-nums">${money0(j.value)}</div></div>
        </div>
        <div class="flex flex-wrap gap-2 mt-3" data-flags>
          ${j.project_qbo_id ? `<button class="pd-btn" data-act="workspace">Open project workspace</button>` : ""}
          <a class="pd-btn" href="#/pipeline">Pipeline</a>
          ${j.flags.map((f) => chip(f.text, C[f.tone])).join(" ")}
        </div>
        <div class="su-stages mt-3">${STAGES.map((sg) => `<div class="su-stage" data-stage="${sg}">
          <div class="flex items-center justify-between"><a href="#" class="text-[11px] uppercase tracking-wide font-bold text-black/50 hover:underline" data-jumpsec="${sg}">${sg}</a><div class="text-[11px] font-bold tabular-nums text-black/45" data-n>${stageCount(j, sg)}</div></div>
          <div class="grid gap-1 mt-1.5" data-links>${j.steps.filter((s) => s.stage === sg).map(stepLink).join("")}</div></div>`).join("")}</div>
        <div class="text-[11px] text-black/45 mt-2">Click a step to open it below.</div>
      </section>
      <section class="card p-4" id="su-Docs"><h3 class="su-h">Documents to work from</h3><div data-docs class="text-sm text-black/45 mt-2">Loading…</div></section>
      ${STAGES.map((sg) => `<section class="card p-4 su-sec" id="su-${sg}">
        <div class="flex flex-wrap items-center gap-2"><h3 class="su-h flex-1">${sg} <span class="text-xs font-bold text-black/40 tabular-nums" data-n>${stageCount(j, sg)}</span></h3>
          <button type="button" class="su-linkbtn" data-openall="${sg}">Open all</button></div>
        ${intro[sg] ? `<div class="text-xs text-black/55 mt-1">${intro[sg]}</div>` : ""}
        <div class="grid gap-2 mt-2">${j.steps.filter((s) => s.stage === sg).map((s) => stepCardHtml(headParts(j, s))).join("")}</div>
      </section>`).join("")}`;

    box.querySelector("[data-back]")?.addEventListener("click", () => {
      st.open = false;
      root.classList.remove("su-open");
      document.querySelector(`.su-job[data-key="${CSS.escape(j.key)}"]`)?.scrollIntoView({ block: "center" });
    });
    box.querySelector("[data-act=workspace]")?.addEventListener("click", () =>
      openProjectDrawer({ entityId: j.project_qbo_id, name: j.project_name, onChange: () => reloadJob(j.key), backLabel: "Project Setup", backHash: "#/setup" }));
    D.cards = bindStepCards(box, { onOpen: (key, body) => buildBody(j, key, body) });
    box.addEventListener("sc:reopen", (e) => {
      if (EDITOR_STEPS.includes(e.detail.key)) placeEditor(j, e.detail.body.querySelector("[data-editor-slot]"));
      if (SCHED_STEPS.includes(e.detail.key)) placeBilling(j, e.detail.body.querySelector("[data-billing-slot]"));
    });
    box.addEventListener("click", (e) => {
      const a = e.target.closest("[data-jump]");
      if (a) { e.preventDefault(); D.cards.open(a.dataset.jump); return; }
      const sec = e.target.closest("[data-jumpsec]");
      if (sec) { e.preventDefault(); document.getElementById(`su-${sec.dataset.jumpsec}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      const all = e.target.closest("[data-openall]");
      if (all) {
        const sg = all.dataset.openall;
        const keys = j.steps.filter((s) => s.stage === sg).map((s) => s.key);
        const anyClosed = keys.some((k) => !D.cards.isOpen(k));
        keys.forEach((k) => { const c = box.querySelector(`.sc[data-sc="${k}"]`); if (c && c.classList.contains("open") !== anyClosed) c.querySelector(".sc-head").click(); });
        all.textContent = anyClosed ? "Close all" : "Open all";
      }
    });
    wireMarks(j, box);
    renderDocs(j);
    // open the first step still to do (without jumping the page there)
    const next = j.steps.find((s) => s.state === "todo" || s.state === "waiting");
    if (next) D.cards.open(next.key, { scroll: false });
  }

  async function reloadJob(key) {
    try {
      const row = await api(`/setup/job/${encodeURIComponent(key)}`);
      const i = st.jobs.findIndex((x) => x.key === key);
      if (i >= 0) st.jobs[i] = row;
      refreshList();
      if (st.sel === key && D && D.j.key === key) {
        D.j = row;
        // refresh the ticks and the card heads only, so open cards keep their state
        const box = document.getElementById("suDetail");
        for (const sg of STAGES) {
          box.querySelector(`[data-stage="${sg}"] [data-n]`).textContent = stageCount(row, sg);
          box.querySelector(`[data-stage="${sg}"] [data-links]`).innerHTML = row.steps.filter((s) => s.stage === sg).map(stepLink).join("");
          box.querySelector(`#su-${sg} [data-n]`).textContent = stageCount(row, sg);
        }
        for (const s of row.steps) D.cards.setHead(s.key, headParts(row, s));
        wireMarks(row, box);
      }
    } catch (_) { /* the next full load catches up */ }
  }

  function wireMarks(j, sec) {
    sec.querySelectorAll("[data-mark]").forEach((b) => {
      if (b.dataset.wired) return;
      b.dataset.wired = "1";
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await api(`/setup/job/${encodeURIComponent(j.key)}/step/${b.dataset.mark}`, { method: "POST", body: JSON.stringify({ status: b.dataset.status || null }) });
          await reloadJob(j.key);
        } catch (e) { b.disabled = false; alert(`Couldn't save: ${e?.message || e}`); }
      });
    });
  }

  // ── Shared loaders (cached per job) ─────────────────────────────────────
  function getDocs(j) {
    const k = `docs:${j.key}`;
    if (!st.cache[k]) {
      st.cache[k] = (j.project_qbo_id ? api(`/documents/project/${encodeURIComponent(j.project_qbo_id)}`) : api(`/documents/opportunity/${j.opportunity_id}`))
        .then((d) => d.files || {}).catch((e) => { delete st.cache[k]; throw e; });
    }
    return st.cache[k];
  }
  function getDraft(j) {
    const k = `draft:${j.key}`;
    if (!st.cache[k]) st.cache[k] = api(`/setup/job/${encodeURIComponent(j.key)}/estimate-draft`).catch((e) => { delete st.cache[k]; throw e; });
    return st.cache[k];
  }
  const docBtn = (f) => `<button class="pd-btn su-doc" data-doc="${f.id}" data-fn="${escapeHtml(f.filename)}" title="${escapeHtml(f.filename)}">${DOC_ICON}<span class="truncate">${escapeHtml(f.filename)}</span></button>`;
  const wireDocs = (el) => el.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => openDocViewer({ id: Number(b.dataset.doc), filename: b.dataset.fn })));
  const copyBtn = (v, label = "Copy") => `<button class="su-copy" data-copy="${escapeHtml(String(v))}" title="Copy ${escapeHtml(String(v))}">${label}</button>`;
  const wireCopy = (el) => el.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); const t = b.textContent; b.textContent = "Copied"; setTimeout(() => { b.textContent = t; }, 1200); }
    catch (_) { alert(b.dataset.copy); }
  }));

  // ── Documents (top card) ────────────────────────────────────────────────
  async function renderDocs(j) {
    const el = document.querySelector("#su-Docs [data-docs]");
    let files;
    try { files = await getDocs(j); } catch (e) { el.textContent = `Couldn't load documents: ${e?.message || e}`; return; }
    const pick = (k) => (files[k] || []).filter((f) => !f.link_only);
    const group = (label, list, empty) => `<div><div class="text-[10px] uppercase tracking-wide font-bold text-black/45 mb-1">${label}</div>
      ${list.length ? list.slice(0, 6).map(docBtn).join("") : `<div class="text-xs text-black/45">${empty}</div>`}</div>`;
    const wb = (j.workbook_url || "").match(/\/d\/([\w-]+)/)?.[1];
    el.className = "su-docs mt-2";
    el.innerHTML = group("Purchase order", pick("5_purchase_orders"), "No PO in Drive yet (5 Purchase Orders).")
      + group("Estimator's quote", pick("4_quotes"), "No quote PDF (4 Quotes).")
      + `<div><div class="text-[10px] uppercase tracking-wide font-bold text-black/45 mb-1">Quoting metrics</div>
          ${wb ? `<button class="pd-btn" data-sheet="${wb}">${DOC_ICON}<span>Roll-up sheet</span></button> <a class="pd-btn" href="${escapeHtml(j.workbook_url)}" target="_blank" rel="noopener">Open in Google Sheets</a>` : `<div class="text-xs text-black/45">No workbook linked on the pipeline row.</div>`}
          <div class="text-xs text-black/55 mt-1.5">${escapeHtml([j.labor_days ? `${j.labor_days} labor days` : null, j.travel_days ? `${j.travel_days} travel days` : null, j.target_start ? `target ${day(j.target_start)} to ${day(j.target_end)}` : null].filter(Boolean).join(" · "))}</div></div>`;
    wireDocs(el);
    el.querySelector("[data-sheet]")?.addEventListener("click", (e) => openDocViewer({ drive: e.currentTarget.dataset.sheet, sheet: "0. ROLL UP Quoting Metrics", filename: "Quoting metrics" }));
  }

  // ── Step bodies ─────────────────────────────────────────────────────────
  async function buildBody(j, key, body) {
    const fn = BODY[key];
    if (!fn) { body.innerHTML = ""; return; }
    await fn(j, body);
  }
  const BODY = {
    po: bodyPo, qbo_project: bodyProject, qbo_estimate: bodyEstimate, first_invoice: bodyFirstInvoice,
    pm: bodyPm, crew: bodyCrew, dates: bodyDates, details: bodyDetails,
    invoice_schedule: bodySchedule, crew_schedule: bodySchedule, expense_schedule: bodySchedule,
  };

  async function bodyPo(j, body) {
    const [files, d] = await Promise.all([getDocs(j), getDraft(j).catch(() => null)]);
    const pos = (files["5_purchase_orders"] || []).filter((f) => !f.link_only);
    const po = d?.po;
    body.innerHTML = `
      <div class="text-[10px] uppercase tracking-wide font-bold text-black/45 mb-1">Purchase order files</div>
      ${pos.length ? pos.map(docBtn).join("") : `<div class="text-xs text-black/55">No PO in the job's Drive folder (5 Purchase Orders) yet. Drop it there; the nightly Drive sync picks it up.</div>`}
      ${po ? `<div class="su-facts mt-2">
          <div><span>PO number</span><b>${escapeHtml(po.po_number || "not read")}</b></div>
          <div><span>PO total</span><b>${po.total != null ? money2(po.total) : "not read"}</b></div>
          <div><span>Order value on the pipeline</span><b>${money2(j.value)}</b></div>
        </div>
        ${po.total != null && Math.abs(po.total - (j.value || 0)) > 1 ? `<div class="su-warn mt-2">The PO total and the pipeline's order value differ by ${money2(po.total - (j.value || 0))}.</div>` : ""}
        ${po.snippet ? `<details class="mt-2"><summary class="text-xs font-semibold text-black/60 cursor-pointer">What the app read from the PO</summary><pre class="su-snippet">${escapeHtml(po.snippet)}</pre></details>` : ""}` : ""}`;
    wireDocs(body);
  }

  async function bodyProject(j, body) {
    if (j.project_qbo_id) {
      body.innerHTML = `<div class="text-sm">Linked to QuickBooks project <b>${escapeHtml(j.project_name || j.project_qbo_id)}</b>${j.customer ? ` under <b>${escapeHtml(j.customer)}</b>` : ""}.</div>
        <div class="flex flex-wrap gap-2 mt-2"><button class="pd-btn" data-ws>Open project workspace</button></div>`;
      body.querySelector("[data-ws]").addEventListener("click", () =>
        openProjectDrawer({ entityId: j.project_qbo_id, name: j.project_name, onChange: () => reloadJob(j.key), backLabel: "Project Setup", backHash: "#/setup" }));
      return;
    }
    const d = await getDraft(j).catch(() => null);
    const name = `${j.quote_number} - ${j.title}`;
    const sib = j.same_site?.sibling_quote;
    body.innerHTML = `
      <ol class="su-howto"><li>In QuickBooks, add a project under <b>${escapeHtml(d?.source?.customer || j.dealer || "the dealer")}</b> named like <b>${escapeHtml(name)}</b> ${copyBtn(name)} (the office's usual form is "number - company - city, ST").</li>
        <li>The nightly sync links it here by its number. To link it now, search for it below.</li></ol>
      ${j.same_site ? `<div class="su-sub mt-2"><div class="text-sm">${sib ? `Quote <b>${escapeHtml(sib)}</b> has the same title and is already in QuickBooks as` : "Same site already in QuickBooks:"} <b>${escapeHtml(j.same_site.name)}</b>.</div>
          <div class="text-xs text-black/55 mt-0.5">${sib ? "If this quote is a revision or an option of that job, link it there and it leaves this list as its own job." : "If this is added scope on that job (a change order), link it there."}</div>
          <button class="pd-btn mt-2" data-link="${escapeHtml(j.same_site.qbo_id)}">Link to ${escapeHtml(j.same_site.name)}</button></div>` : ""}
      <div class="flex flex-wrap gap-2 mt-2 items-center"><input data-findproj class="input text-sm" style="max-width:280px" placeholder="Search QuickBooks projects"><div data-projhits class="flex flex-wrap gap-1.5"></div></div>`;
    wireCopy(body);
    const linkTo = async (qboId, nm) => {
      if (!confirm(`Link "${j.title}" (quote ${j.quote_number}) to ${nm}?`)) return;
      try {
        await api(`/opportunities/${j.opportunity_id}`, { method: "PATCH", body: JSON.stringify({ project_qbo_id: String(qboId) }) });
        st.sel = String(qboId); remember(); delete st.cache[`draft:${j.key}`]; delete st.cache[`docs:${j.key}`];
        await load();
      } catch (e) { alert(`Couldn't link: ${e?.message || e}`); }
    };
    body.querySelector("[data-link]")?.addEventListener("click", (e) => linkTo(e.currentTarget.dataset.link, j.same_site.name));
    const find = body.querySelector("[data-findproj]");
    let t;
    find.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const hits = body.querySelector("[data-projhits]");
        const q = find.value.trim();
        if (q.length < 2) { hits.innerHTML = ""; return; }
        try {
          const r = await api(`/opportunities/project-options?q=${encodeURIComponent(q)}&limit=8`);
          hits.innerHTML = r.projects.map((p) => `<button class="pd-btn" data-pick="${escapeHtml(p.qbo_id)}" data-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>`).join("") || `<span class="text-xs text-black/45">No match.</span>`;
          hits.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => linkTo(b.dataset.pick, b.dataset.name)));
        } catch (_) { /* typing on: the next search retries */ }
      }, 250);
    });
  }

  // The app's draft of the first estimate (copy-ready). Once the project has its
  // estimate in QuickBooks, the card shows that estimate next to the draft instead,
  // with the office's checks, and the draft folds away under "The app's draft".
  async function bodyEstimate(j, body) {
    const d = await getDraft(j);
    const act = d.actual?.estimate;
    if (act) {
      const cmp = d.compare || { groups: [], checks: [] };
      const diff = (a, b) => a != null && b != null && Math.abs(a - b) > 0.5;
      body.innerHTML = `
        <div class="text-sm">In QuickBooks: estimate <b>#${escapeHtml(act.doc_number || "")}</b> on the project, ${escapeHtml(act.status || "")}, <b>${money2(act.total)}</b>, dated ${day(act.date)}${d.actual.estimates_on_project > 1 ? ` <span class="text-black/50">(${d.actual.estimates_on_project} estimates on the project; this is the first)</span>` : ""}.</div>
        <div class="grid gap-1 mt-2">${cmp.checks.map((c) => `<div class="flex items-start gap-2 text-sm">${c.ok ? ICON.done : ICON.todo}<span>${escapeHtml(c.text)}</span></div>`).join("")}</div>
        ${cmp.groups.length ? `<details class="mt-3"${cmp.groups.some((g) => g.lines.some((l) => diff(l.draft, l.actual) || l.draft == null || l.actual == null)) ? " open" : ""}>
          <summary class="text-xs font-semibold text-black/60 cursor-pointer">Line by line: QuickBooks next to the app's draft</summary>
          <div class="overflow-x-auto mt-2"><table class="w-full text-xs su-table">
            <thead><tr><th class="text-left">Group / line</th><th class="text-right">In QuickBooks</th><th class="text-right">App's draft</th><th class="text-right">Difference</th></tr></thead>
            <tbody>${cmp.groups.map((g) => `
              <tr class="su-grp"><td>${escapeHtml(g.name)}</td><td class="text-right tabular-nums">${g.actual != null ? money2(g.actual) : "—"}</td><td class="text-right tabular-nums">${g.draft != null ? money2(g.draft) : "—"}</td><td class="text-right tabular-nums">${g.actual != null && g.draft != null && diff(g.actual, g.draft) ? money2(g.actual - g.draft) : ""}</td></tr>
              ${g.lines.map((l) => `<tr${diff(l.draft, l.actual) || l.draft == null || l.actual == null ? ' class="su-diff"' : ""}><td class="pl-4">${escapeHtml(l.item || "")}</td>
                <td class="text-right tabular-nums">${l.actual != null ? money2(l.actual) : "not on it"}</td><td class="text-right tabular-nums text-black/55">${l.draft != null ? money2(l.draft) : "—"}</td>
                <td class="text-right tabular-nums">${l.actual != null && l.draft != null && diff(l.actual, l.draft) ? money2(l.actual - l.draft) : ""}</td></tr>`).join("")}`).join("")}
            </tbody></table></div>
          <div class="text-[11px] text-black/45 mt-1">Small differences inside a group are usually how the office rounded the OH&amp;P spread; the group totals are what matter.</div>
        </details>` : ""}
        ${act.po_line ? `<details class="mt-2"><summary class="text-xs font-semibold text-black/60 cursor-pointer">PO line on the estimate</summary><pre class="su-snippet">${escapeHtml(act.po_line)}</pre></details>` : ""}
        <details class="mt-2"><summary class="text-xs font-semibold text-black/60 cursor-pointer">The app's draft (copy-ready)</summary><div data-draft class="mt-2"></div></details>`;
      draftHtml(j, d, body.querySelector("[data-draft]"));
      return;
    }
    body.innerHTML = `<div class="flex flex-wrap items-center gap-2"><div class="text-xs text-black/55 flex-1">Not in QuickBooks yet. The app drafted it from the estimator's estimate and the PO: copy it in, then this step ticks itself after the next sync.</div>
        <button class="pd-btn" disabled title="Pushing to QuickBooks needs write access to be switched on. For now, copy the lines in.">Send to QuickBooks (coming)</button></div>
      <div data-draft class="mt-2"></div>`;
    draftHtml(j, d, body.querySelector("[data-draft]"));
  }

  function draftHtml(j, d, el) {
    if (!d.groups) {
      el.innerHTML = `${(d.warnings || []).map((w) => `<div class="su-warn">${escapeHtml(w)}</div>`).join("")}`;
      return;
    }
    const site = (j.project_name || "").split(" - ").slice(1).join(" - ");
    const steps = [
      j.project_qbo_id ? null : `In QuickBooks, add a project under <b>${escapeHtml(d.source?.customer || j.dealer || "the dealer")}</b> named <b>${escapeHtml(`${j.quote_number} - ${site || j.title}`)}</b>.`,
      `Copy estimate <b>#${escapeHtml(d.source?.doc_number || j.quote_number)}</b> onto the project with the PO line at the top and the line amounts below (OH&amp;P spread into the other lines).`,
      d.first_invoice?.amount ? `Send the first invoice: <b>${d.first_invoice.percent}% = ${money2(d.first_invoice.amount)}</b> (per the payment terms).` : null,
    ].filter(Boolean);
    el.innerHTML = `
      ${(d.warnings || []).map((w) => `<div class="su-warn">${escapeHtml(w)}</div>`).join("")}
      <ol class="su-howto">${steps.map((x) => `<li>${x}</li>`).join("")}</ol>
      <div class="text-xs mt-2 flex flex-wrap gap-x-6 gap-y-1"><span><span class="text-black/45">From:</span> estimate #${escapeHtml(d.source?.doc_number || "")} on ${escapeHtml(d.source?.customer || "")} (${escapeHtml(d.source?.status || "")}, ${money2(d.source?.total)})</span>
        ${d.po ? `<span><span class="text-black/45">PO:</span> ${escapeHtml(d.po.po_number || "number not read")} · ${d.po.total != null ? money2(d.po.total) : "total not read"}</span>` : ""}</div>
      <div class="su-poline mt-2"><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">PO line (top of the estimate)</div>
        <pre>${escapeHtml(d.po_line || "")}</pre>${copyBtn(d.po_line || "", "Copy line")}</div>
      <div class="overflow-x-auto mt-2"><table class="w-full text-xs su-table">
        <thead><tr><th class="text-left">Group / line</th><th class="text-right">Quote</th><th class="text-right">Project estimate</th><th></th></tr></thead>
        <tbody>${d.groups.map((g) => `
          <tr class="su-grp"><td>${escapeHtml(g.name)}${g.ohp_spread ? ` <span class="text-black/45 font-normal">· OH&amp;P ${money0(g.ohp_spread)} spread</span>` : ""}</td><td></td><td class="text-right tabular-nums">${money2(g.total)}</td><td></td></tr>
          ${g.lines.filter((l) => Math.abs(l.amount) > 0.004 || Math.abs(l.was) > 0.004).map((l) => `<tr><td class="pl-4">${escapeHtml(l.item || "")}</td>
            <td class="text-right tabular-nums text-black/50">${money2(l.was)}</td><td class="text-right tabular-nums font-semibold${l.amount !== l.was ? " text-sky-800" : ""}">${money2(l.amount)}</td>
            <td class="text-right">${copyBtn(l.amount.toFixed(2))}</td></tr>`).join("")}`).join("")}
          <tr class="su-total"><td>Total</td><td class="text-right tabular-nums text-black/50">${money2(d.groups.reduce((t, g) => t + g.lines.reduce((u, l) => u + l.was, 0), 0))}</td><td class="text-right tabular-nums">${money2(d.total)}</td><td></td></tr>
        </tbody></table></div>
      ${d.terms ? `<div class="text-xs text-black/55 mt-2"><span class="font-semibold text-black/70">Payment terms:</span> ${escapeHtml(d.terms.replace(/\s+/g, " ").slice(0, 220))}</div>` : ""}`;
    wireCopy(el);
  }

  async function bodyFirstInvoice(j, body) {
    const d = await getDraft(j).catch(() => ({}));
    const inv = d.actual?.invoice, fi = d.first_invoice || {};
    const base = d.actual?.estimate?.total ?? d.total;
    const check = (d.compare?.checks || []).find((c) => c.text.startsWith("First invoice"));
    body.innerHTML = `
      ${inv ? `<div class="su-facts">
          <div><span>First invoice</span><b>#${escapeHtml(inv.doc_number || "")} · ${day(inv.date)}</b></div>
          <div><span>Amount</span><b>${money2(inv.amount)}${base ? ` (${(100 * inv.amount / base).toFixed(1)}%)` : ""}</b></div>
          <div><span>Still open</span><b class="${inv.balance > 0 ? "" : "text-emerald-700"}">${inv.balance > 0 ? `${money2(inv.balance)}${inv.due ? `, due ${day(inv.due)}` : ""}` : "Paid"}</b></div>
        </div>` : `<div class="text-sm">${fi.amount ? `Send the first invoice: <b>${fi.percent}% = ${money2(fi.amount)}</b> ${copyBtn(fi.amount.toFixed(2))}` : "No percentage payment terms on the quote: check the PO for how to invoice."}</div>`}
      ${check ? `<div class="flex items-start gap-2 text-sm mt-2">${check.ok ? ICON.done : ICON.todo}<span>${escapeHtml(check.text)}</span></div>` : ""}
      ${d.terms ? `<div class="text-xs text-black/55 mt-2"><span class="font-semibold text-black/70">Payment terms:</span> ${escapeHtml(d.terms.replace(/\s+/g, " ").slice(0, 260))}</div>` : ""}
      ${j.project_qbo_id ? `<div class="text-xs text-black/50 mt-2">The whole invoice schedule is under Schedules below.</div>` : ""}`;
    wireCopy(body);
  }

  // PM, crew, dates and details share one editor (the Assignments-page editor),
  // shown inside whichever of those cards was opened last.
  const editorSlot = (what) => `<div class="su-sub mt-3"><div class="flex items-center gap-2"><h4 class="font-bold text-sm flex-1">${what}</h4><span class="text-xs text-black/45">Saves as you go · same editor as the Assignments page</span></div><div data-editor-slot class="mt-2"></div></div>`;
  function placeEditor(j, slot) {
    if (!slot) return;
    if (!j.project_internal_id) { slot.innerHTML = `<div class="text-xs text-black/50">Opens once the project is in QuickBooks.</div>`; return; }
    if (!D.editor) {
      const el = document.createElement("div");
      el.className = "su-embed";
      D.editor = el;
      mountAssignmentPanel(el, j.project_internal_id, () => onAssignChange(j));
    }
    document.querySelectorAll("#suDetail [data-editor-slot]").forEach((s) => {
      if (s !== slot && s.contains(D.editor)) s.innerHTML = `<button type="button" class="pd-btn" data-move-editor>Show the editor here</button>`;
    });
    slot.innerHTML = "";
    slot.appendChild(D.editor);
  }
  function onAssignChange(j) {
    clearTimeout(st.assignTimer);
    st.assignTimer = setTimeout(async () => {
      const before = D?.j;
      await reloadJob(j.key);
      const fresh = D?.j;
      if (fresh && before && (fresh.start !== before.start || fresh.end !== before.end)) {
        const av = document.querySelector('#suDetail .sc[data-sc="crew"] [data-avail]');
        if (av) loadAvailability(fresh, av);
        const pm = document.querySelector('#suDetail .sc[data-sc="pm"] [data-pms]');
        if (pm) loadPmWorkload(fresh, pm);
      }
    }, 600);
  }
  function remountEditor(j) {
    if (D?.editor) mountAssignmentPanel(D.editor, j.project_internal_id, () => onAssignChange(j));
  }
  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-move-editor]");
    if (b && D) placeEditor(D.j, b.closest("[data-editor-slot]"));
    const m = e.target.closest("[data-move-billing]");
    if (m && D) placeBilling(D.j, m.closest("[data-billing-slot]"));
  });

  async function bodyPm(j, body) {
    body.innerHTML = `<div class="text-xs text-black/55">Who's free: each PM's running and upcoming jobs, and how many overlap this one. Click a PM to see their jobs on a timeline. Pick the PM in the editor below (Project manager).</div>
      <div data-pms class="text-xs text-black/45 mt-2">Loading…</div>${editorSlot("Assign the PM")}`;
    loadPmWorkload(j, body.querySelector("[data-pms]"));
    placeEditor(j, body.querySelector("[data-editor-slot]"));
  }
  async function bodyCrew(j, body) {
    body.innerHTML = `
      <div class="su-sub"><h4 class="font-bold text-sm">Crew offer</h4><div data-offers class="text-xs text-black/45 mt-1.5">${j.project_qbo_id ? "Loading…" : "Opens once the project is in QuickBooks."}</div></div>
      <div class="su-sub mt-3"><h4 class="font-bold text-sm">Crew availability${j.start ? ` · ${day(j.start)} to ${day(j.end)}` : ""}</h4>
        <div class="text-xs text-black/55 mt-0.5">${j.start ? "Click a crew to see each day and what they're booked on." : ""}</div>
        <div data-avail class="text-xs text-black/45 mt-1.5">${j.start ? "Loading…" : "Set the dates (Start and end dates step) to see which crews are free."}</div></div>
      ${editorSlot("Assign the crew")}`;
    if (j.project_qbo_id) loadOffers(j, body.querySelector("[data-offers]"));
    if (j.start) loadAvailability(j, body.querySelector("[data-avail]"));
    placeEditor(j, body.querySelector("[data-editor-slot]"));
  }
  async function bodyDates(j, body) {
    body.innerHTML = `<div class="text-xs text-black/55">${j.target_start ? `The quote targeted ${day(j.target_start)} to ${day(j.target_end)}${j.labor_days ? ` (${j.labor_days} labor days${j.travel_days ? `, ${j.travel_days} travel` : ""})` : ""}. ` : ""}Set Start and End in the editor; the schedules below are built from them.</div>${editorSlot("Set the dates")}`;
    placeEditor(j, body.querySelector("[data-editor-slot]"));
  }
  async function bodyDetails(j, body) {
    body.innerHTML = `<div class="text-xs text-black/55">Check wire guidance, travel days, days off and equipment in the editor, then press "Mark checked" on this step.</div>${editorSlot("Job details")}`;
    placeEditor(j, body.querySelector("[data-editor-slot]"));
  }

  // The three schedules share one billing panel, shown in the card opened last.
  function placeBilling(j, slot) {
    if (!slot) return;
    if (!j.project_qbo_id || !j.start) { slot.innerHTML = `<div class="text-xs text-black/50">${j.project_qbo_id ? "Set the start and end dates first. The schedules are built from them." : "Opens once the project is in QuickBooks and has dates."}</div>`; return; }
    if (!D.billing) {
      const el = document.createElement("div");
      el.className = "su-embed";
      D.billing = el;
      mountBillingPanel(el, j.project_qbo_id);
    }
    document.querySelectorAll("#suDetail [data-billing-slot]").forEach((s) => {
      if (s !== slot && s.contains(D.billing)) s.innerHTML = `<button type="button" class="pd-btn" data-move-billing>Show the schedules here</button>`;
    });
    slot.innerHTML = "";
    slot.appendChild(D.billing);
  }
  async function bodySchedule(j, body) {
    body.innerHTML = `<div class="text-xs text-black/55">Invoices, crew pay and expenses for this job (the same panel as the project's Billing tab). Check the rows, fix any date or amount, then press "Mark reviewed" on this step.</div><div data-billing-slot class="mt-2"></div>`;
    placeBilling(j, body.querySelector("[data-billing-slot]"));
  }

  // ── PM workload (click a PM for their jobs on a timeline) ───────────────
  async function loadPmWorkload(j, el) {
    let d = st.cache.pms;
    try { d = st.cache.pms = d || await api("/tracker/pm-schedule"); }
    catch (e) { el.textContent = "PM workload needs access to the Tracker."; return; }
    const today = d.today, s = j.start, e = j.end;
    const rows = d.pms.map((p) => {
      const live = p.items.filter((i) => i.status !== "completed" && i.status !== "canceled" && (!i.end || i.end >= today));
      const now = live.filter((i) => i.start && i.start <= today);
      const overlap = s && e ? live.filter((i) => i.start && i.end && i.start <= e && i.end >= s && i.entity_id !== j.project_qbo_id) : [];
      const next = live.filter((i) => i.start && i.start > today).length;
      return { p, live, now: now.length, next, overlap };
    }).sort((a, b) => (a.overlap.length - b.overlap.length) || (a.now - b.now));
    el.className = "overflow-x-auto mt-2";
    el.innerHTML = `<table class="w-full text-xs su-table su-clicktable"><thead><tr><th class="text-left">PM</th><th class="text-right">Running now</th><th class="text-right">Coming up</th><th class="text-left">${s ? "Busy during this job" : "During this job"}</th><th></th></tr></thead>
      <tbody>${rows.map(({ p, now, next, overlap }, i) => `<tr data-pmrow="${i}" class="su-rowbtn${(j.pms || []).includes(p.name) ? " su-mine" : ""}" tabindex="0" aria-expanded="false"><td class="font-semibold">${escapeHtml(p.name)}${(j.pms || []).includes(p.name) ? " (assigned)" : ""}</td>
        <td class="text-right tabular-nums">${now}</td><td class="text-right tabular-nums">${next}</td>
        <td>${s ? (overlap.length ? `${overlap.length} job${overlap.length > 1 ? "s" : ""}` : chip("Free", C.good)) : '<span class="text-black/40">Set dates first</span>'}</td>
        <td class="text-right text-black/40">▸</td></tr>`).join("")}</tbody></table>`;
    el.querySelectorAll("[data-pmrow]").forEach((tr) => {
      const toggle = () => {
        const nx = tr.nextElementSibling;
        if (nx?.classList.contains("su-drill")) { nx.remove(); tr.setAttribute("aria-expanded", "false"); tr.lastElementChild.textContent = "▸"; return; }
        const r = rows[Number(tr.dataset.pmrow)];
        const drill = document.createElement("tr");
        drill.className = "su-drill";
        drill.innerHTML = `<td colspan="5">${pmTimeline(r, j, today)}</td>`;
        tr.after(drill);
        tr.setAttribute("aria-expanded", "true"); tr.lastElementChild.textContent = "▾";
      };
      tr.addEventListener("click", (ev) => { if (!ev.target.closest("a")) toggle(); });
      tr.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } });
    });
  }

  const addDays = (iso, n) => { const t = new Date(`${iso}T00:00:00`); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); };
  const dayDiff = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
  function pmTimeline({ p, live }, j, today) {
    const dated = live.filter((i) => i.start && i.end).sort((a, b) => a.start.localeCompare(b.start));
    const undated = live.filter((i) => !i.start || !i.end);
    let ws = addDays([today, j.start].filter(Boolean).sort()[0], -7);
    let we = addDays([today, j.end].filter(Boolean).sort().pop(), 28);
    if (dayDiff(ws, we) < 60) we = addDays(ws, 60);
    if (dayDiff(ws, we) > 180) we = addDays(ws, 180);
    const span = dayDiff(ws, we);
    const pos = (d) => Math.max(0, Math.min(100, (100 * dayDiff(ws, d)) / span));
    const shown = dated.filter((i) => i.end >= ws && i.start <= we);
    const band = j.start && j.end ? `<span class="su-tl-band" style="left:${pos(j.start)}%;width:${Math.max(0.8, pos(j.end) - pos(j.start))}%"></span>` : "";
    const todayLine = `<span class="su-tl-today" style="left:${pos(today)}%"></span>`;
    const months = [];
    for (let m = new Date(`${ws.slice(0, 7)}-01T00:00:00`); m.toISOString().slice(0, 10) <= we; m.setMonth(m.getMonth() + 1)) {
      const iso = m.toISOString().slice(0, 10);
      if (iso >= ws) months.push(`<span class="su-tl-month" style="left:${pos(iso)}%">${m.toLocaleDateString([], { month: "short" })}</span>`);
    }
    return `<div class="su-tl">
      <div class="su-tl-row su-tl-axis"><div></div><div class="su-tl-track">${months.join("")}</div></div>
      ${shown.map((i) => {
        const mine = i.entity_id === j.project_qbo_id;
        const over = !mine && j.start && j.end && i.start <= j.end && i.end >= j.start;
        return `<div class="su-tl-row"><div class="su-tl-name"><a href="${projectLink(i.entity_id)}" title="${escapeHtml(i.name)}">${escapeHtml(i.name)}</a><span>${day(i.start)} to ${day(i.end)}${i.primary ? "" : " · backup PM"}</span></div>
          <div class="su-tl-track">${band}${todayLine}<span class="su-tl-bar${mine ? " mine" : over ? " over" : ""}" style="left:${pos(i.start < ws ? ws : i.start)}%;width:${Math.max(0.8, pos(i.end > we ? we : i.end) - pos(i.start < ws ? ws : i.start))}%" title="${escapeHtml(`${i.name}: ${i.start} to ${i.end}`)}"></span></div></div>`;
      }).join("") || `<div class="text-xs text-black/50 py-1">No dated jobs in this window.</div>`}
      <div class="su-tl-legend"><span><i class="su-tl-key band"></i>This job's dates</span><span><i class="su-tl-key over"></i>Overlaps this job</span><span><i class="su-tl-key"></i>Other jobs</span><span><i class="su-tl-key today"></i>Today</span></div>
      ${undated.length ? `<div class="text-xs text-black/55 mt-1">${undated.length} more assigned job${undated.length > 1 ? "s" : ""} without dates: ${undated.slice(0, 6).map((i) => `<a class="underline" href="${projectLink(i.entity_id)}">${escapeHtml(i.name)}</a>`).join(", ")}${undated.length > 6 ? "…" : ""}</div>` : ""}
    </div>`;
  }

  // ── Crew availability (click a crew for each day and its bookings) ─────
  async function loadAvailability(j, el) {
    if (!el) return;
    el.textContent = "Loading…";
    let d;
    try { d = await api(`/offers/crew-availability?start=${j.start}&end=${j.end}`); }
    catch (e) { el.textContent = `Couldn't load availability: ${e?.message || e}`; return; }
    const rows = [...d.companies].sort((a, b) => b.min_free_weekdays - a.min_free_weekdays);
    el.className = "overflow-x-auto mt-1.5";
    el.innerHTML = `<table class="w-full text-xs su-table su-clicktable"><thead><tr><th class="text-left">Crew company</th><th class="text-left">Boss</th><th class="text-right">Free the whole time</th><th class="text-left">Booked on</th><th></th></tr></thead>
      <tbody>${rows.map((c, i) => `<tr data-crow="${i}" class="su-rowbtn" tabindex="0" aria-expanded="false"><td class="font-semibold">${escapeHtml(c.name)}</td><td>${escapeHtml(c.boss_name || "")}</td>
        <td class="text-right">${chip(`${c.min_free_weekdays} of ${c.capacity}`, c.min_free_weekdays > 0 ? C.good : C.bad)}</td>
        <td class="text-black/55 su-avail-booked">${escapeHtml([...new Set((c.bookings || []).map((b) => b.project))].filter((p) => p).slice(0, 2).join("; "))}${(c.time_off || []).length ? ` ${chip("time off", C.warn)}` : ""}</td>
        <td class="text-right text-black/40">▸</td></tr>`).join("")}</tbody></table>`;
    el.querySelectorAll("[data-crow]").forEach((tr) => {
      const toggle = () => {
        const nx = tr.nextElementSibling;
        if (nx?.classList.contains("su-drill")) { nx.remove(); tr.setAttribute("aria-expanded", "false"); tr.lastElementChild.textContent = "▸"; return; }
        const c = rows[Number(tr.dataset.crow)];
        const drill = document.createElement("tr");
        drill.className = "su-drill";
        drill.innerHTML = `<td colspan="5">${crewDays(c)}</td>`;
        tr.after(drill);
        tr.setAttribute("aria-expanded", "true"); tr.lastElementChild.textContent = "▾";
        drill.querySelector("[data-offer-crew]")?.addEventListener("click", () => {
          const sel = document.querySelector('#suDetail .sc[data-sc="crew"] form[data-new] select[name="crew"]');
          if (sel) { sel.value = String(c.id); sel.closest("form").scrollIntoView({ behavior: "smooth", block: "center" }); sel.focus(); }
        });
      };
      tr.addEventListener("click", (ev) => { if (!ev.target.closest("a")) toggle(); });
      tr.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } });
    });
  }
  function crewDays(c) {
    const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const byProj = {};
    for (const b of c.bookings || []) (byProj[b.project || "—"] ||= { entity_id: b.entity_id, rows: [] }).rows.push(b);
    const canOffer = !!document.querySelector('#suDetail .sc[data-sc="crew"] form[data-new]:not([hidden])');
    return `<div class="su-days">${(c.days || []).map((x) => `<div class="su-day${x.weekday >= 5 ? " wkend" : ""}${x.free <= 0 ? " full" : ""}${x.off ? " off" : ""}" title="${escapeHtml(`${x.date}: ${x.booked} booked, ${x.off} off, ${x.free} free of ${c.capacity}`)}">
        <span>${wd[x.weekday]}</span><b>${x.free}</b><span>${new Date(`${x.date}T00:00:00`).getDate()}</span></div>`).join("")}</div>
      <div class="text-[11px] text-black/50 mt-1">Crews free each day, out of ${c.capacity}. Red = fully booked.</div>
      ${Object.keys(byProj).length ? `<div class="grid gap-0.5 mt-2">${Object.entries(byProj).map(([name, g]) => `<div class="text-xs"><a class="font-semibold underline" href="${g.entity_id ? projectLink(g.entity_id) : "#"}">${escapeHtml(name)}</a>
          <span class="text-black/55">${g.rows.map((b) => `${escapeHtml(b.slot || "")}${b.lead ? ` ${escapeHtml(b.lead)}` : ""} ${day(b.from)} to ${day(b.thru)}`).join("; ")}</span></div>`).join("")}</div>` : `<div class="text-xs text-black/55 mt-2">Not booked on anything during this job.</div>`}
      ${(c.time_off || []).length ? `<div class="text-xs text-amber-800 mt-1">Time off: ${(c.time_off || []).map((t) => escapeHtml(`${t.lead || "whole company"} ${t.start || t.from || ""} to ${t.end || t.thru || ""}`)).join("; ")}</div>` : ""}
      ${canOffer ? `<button type="button" class="pd-btn mt-2" data-offer-crew>Offer the job to ${escapeHtml(c.name)}</button>` : ""}`;
  }

  async function loadOffers(j, el) {
    let d;
    try { d = await api(`/offers/project/${encodeURIComponent(j.project_qbo_id)}`); }
    catch (e) { el.textContent = `Couldn't load offers: ${e?.message || e}`; return; }
    const status = { sent: ["Sent, waiting", C.info], accepted: ["Accepted", C.good], declined: ["Declined", C.bad], withdrawn: ["Withdrawn", C.quiet] };
    const offerText = (crew, amount, scope) => [
      `Job offer: ${j.project_name || j.title}`,
      j.start ? `Dates: ${day(j.start)} to ${day(j.end)}` : null,
      `Labor: ${money2(amount)}`,
      scope ? `Scope:\n${scope}` : null,
      `Please reply to accept or decline.`,
    ].filter(Boolean).join("\n");
    el.className = "mt-1.5";
    el.innerHTML = `
      ${d.offers.length ? `<div class="grid gap-1.5">${d.offers.map((o) => `<div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="font-semibold">${escapeHtml(o.crew_name || "Crew")}</span><span class="tabular-nums">${money2(o.labor_amount)}</span>
          ${chip(...(status[o.status] || [o.status, C.quiet]))}<span class="text-xs text-black/45">sent ${day(o.sent_at)}${o.responded_at ? `, answered ${day(o.responded_at)}` : ""}</span>
          ${o.status === "sent" ? `<span class="flex gap-1.5 ml-auto"><button class="pd-btn" data-resp="${o.id}" data-st="accepted">Accepted</button><button class="pd-btn" data-resp="${o.id}" data-st="declined">Declined</button><button class="pd-btn" data-wd="${o.id}">Withdraw</button></span>` : ""}
        </div>`).join("")}</div>` : `<div class="text-xs text-black/50">No offer sent yet.</div>`}
      ${!d.accepted && !d.offers.length && stepOf(D?.j || j, "crew").state === "done" ? `<div class="text-xs text-black/55 mt-1">The crew was assigned in the editor without an offer on record. <button type="button" class="su-linkbtn" data-showoffer>Record an offer anyway</button></div>` : ""}
      ${d.accepted ? "" : `<form data-new class="grid gap-2 mt-3 su-offer"${!d.offers.length && stepOf(D?.j || j, "crew").state === "done" ? " hidden" : ""}>
        <div class="flex flex-wrap gap-2">
          <label class="text-xs grid gap-1" style="flex:1;min-width:180px"><span class="text-black/55">Crew company</span><select name="crew" class="input text-sm" required><option value="">Choose a crew…</option>${d.crews.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${c.boss_name ? ` (${escapeHtml(c.boss_name)})` : ""}</option>`).join("")}</select></label>
          <label class="text-xs grid gap-1" style="width:150px"><span class="text-black/55">Labor amount</span><input name="amount" type="number" step="0.01" min="0" class="input text-sm tabular-nums" value="${d.suggested_labor || ""}"></label>
        </div>
        <label class="text-xs grid gap-1"><span class="text-black/55">Scope (from the accepted estimates' labor lines; edit as needed)</span><textarea name="scope" rows="3" class="input text-sm">${escapeHtml(d.suggested_scope || "")}</textarea></label>
        <div class="flex flex-wrap gap-2 items-center"><button type="button" class="pd-btn" data-copytext>Copy offer text</button><button type="submit" class="btn-primary text-sm">Record offer as sent</button>
          <span class="text-xs text-black/50">The app doesn't email crews yet: copy the text to the crew boss, then record it here.</span></div>
      </form>`}`;
    el.querySelectorAll("[data-resp]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try { await api(`/offers/${b.dataset.resp}/respond`, { method: "POST", body: JSON.stringify({ status: b.dataset.st }) }); await reloadJob(j.key); loadOffers(j, el); remountEditor(j); }
      catch (e) { b.disabled = false; alert(`Couldn't save: ${e?.message || e}`); }
    }));
    el.querySelectorAll("[data-wd]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Withdraw this offer?")) return;
      try { await api(`/offers/${b.dataset.wd}/withdraw`, { method: "POST" }); await reloadJob(j.key); loadOffers(j, el); }
      catch (e) { alert(`Couldn't withdraw: ${e?.message || e}`); }
    }));
    const form = el.querySelector("[data-new]");
    el.querySelector("[data-showoffer]")?.addEventListener("click", (ev) => { form.hidden = false; ev.target.parentElement.remove(); });
    form?.querySelector("[data-copytext]").addEventListener("click", async (ev) => {
      const f = new FormData(form);
      const crew = d.crews.find((c) => String(c.id) === f.get("crew"));
      const txt = offerText(crew?.name, Number(f.get("amount") || 0), f.get("scope"));
      try { await navigator.clipboard.writeText(txt); ev.target.textContent = "Copied"; setTimeout(() => { ev.target.textContent = "Copy offer text"; }, 1200); }
      catch (_) { alert(txt); }
    });
    form?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(form);
      if (!f.get("crew")) return;
      try {
        await api(`/offers/project/${encodeURIComponent(j.project_qbo_id)}`, { method: "POST", body: JSON.stringify({ crew_id: Number(f.get("crew")), labor_amount: Number(f.get("amount") || 0), scope: f.get("scope") || null }) });
        await reloadJob(j.key);
        loadOffers(j, el);
      } catch (e) { alert(`Couldn't record the offer: ${e?.message || e}`); }
    });
  }

  // ── Events ──────────────────────────────────────────────────────────────
  root.addEventListener("click", (e) => {
    const kp = e.target.closest("[data-kpi]");
    if (kp) { st.kpi = st.kpi === kp.dataset.kpi ? null : kp.dataset.kpi; st.view = "all"; st.open = false; if (!visible().some((j) => j.key === st.sel)) st.sel = visible()[0]?.key || st.sel; render(); return; }
    if (e.target.closest("[data-clearkpi]")) { st.kpi = null; render(true); return; }
    const v = e.target.closest("[data-view]");
    if (v && root.contains(v) && !v.closest("#suDetail")) { st.view = v.dataset.view; st.kpi = null; st.open = false; remember(); render(); return; }
    const job = e.target.closest(".su-job");
    if (job) {
      st.sel = job.dataset.key; remember();
      root.querySelectorAll(".su-job").forEach((b) => { b.classList.toggle("on", b === job); b.setAttribute("aria-current", String(b === job)); });
      st.open = true;
      root.classList.add("su-open");
      renderDetail();
      if (isPhone()) window.scrollTo(0, 0);
    }
  });
  root.addEventListener("input", (e) => {
    if (e.target.id === "suQ") { st.q = e.target.value; refreshList(); }
  });
  root.addEventListener("change", (e) => {
    if (e.target.id === "suPm") { st.pm = e.target.value; refreshList(); }
  });

  load();
}
