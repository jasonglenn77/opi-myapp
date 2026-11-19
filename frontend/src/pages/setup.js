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
import { toast } from "../utils/help.js";
import { getMe } from "../api.js";

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
  waiting: ["Waiting", C.info], locked: ["Later", C.quiet], review: ["Re-review", C.bad],
};
const ICON = {
  done: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#059669"/><path d="M6 10.5l2.5 2.5L14 7.5" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  not_needed: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#f1f5f9" stroke="#94a3b8"/><path d="M6.5 10h7" stroke="#64748b" stroke-width="2" stroke-linecap="round"/></svg>`,
  todo: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#fff" stroke="#d97706" stroke-width="2"/></svg>`,
  waiting: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#e0f2fe" stroke="#0284c7" stroke-width="1.5"/><path d="M10 6v4l2.5 1.5" stroke="#0284c7" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`,
  locked: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#f8fafc" stroke="#cbd5e1" stroke-dasharray="2 2"/></svg>`,
  review: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#fff1f2" stroke="#e11d48" stroke-width="2"/><path d="M10 5.5v5.5M10 13.6v.4" stroke="#e11d48" stroke-width="2" stroke-linecap="round"/></svg>`,
};
// To do: new jobs being set up + projects a change sent back. All active: every
// live project (Setup, Ready, In progress), to edit in place.
const VIEWS = [["todo", "To do"], ["review", "Back for re-review"], ["action", "Urgent"], ["all", "All active"]];
const LIFE = { setup: C.warn, ready: C.info, in_progress: C.good, closing: C.warn, closed: C.quiet, on_hold: C.bad, canceled: C.quiet };
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
    review: ["Back for re-review", (j) => j.needs_review > 0 || j.unanswered_dates > 0],
  };
  const want = new URLSearchParams((location.hash.split("?")[1] || "")).get("job");
  const st = { kpi: null, jobs: [], view: VIEWS.some(([k]) => k === saved.view) ? saved.view : "todo", q: "", pm: "",
    sel: want || saved.sel || null, open: !!want, cache: {}, scope: null, meta: {} };
  if (want) st.view = "todo";
  const remember = () => { try { sessionStorage.setItem("opi_setup", JSON.stringify({ view: st.view, sel: st.sel })); } catch (_) {} };

  setShell({
    title: "Project Setup",
    subtitle: "To do: new jobs (100% won) still being set up, and any project a change sent back for re-review (dates moved, a change order, the crew or the contract changed). All active: every live project, to edit in place.",
    bodyHtml: `<div id="suRoot"><div class="card p-6 text-sm text-black/45">Loading won jobs…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("suRoot");

  // B151 → Pipeline mirror on demand (same as the Pipeline page's button): the
  // run happens server-side; poll the run log until it lands, then reload.
  const b151 = { run: null, busy: false };
  const ago = (iso) => {
    if (!iso) return "never";
    const m = Math.round((Date.now() - new Date(String(iso).replace(" ", "T") + "Z").getTime()) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };
  function b151Line() {
    const r = b151.run;
    if (!r) return "";
    return r.ok ? `B151 read ${ago(r.finished_at)}` : `<span class="su-b151-bad" title="${escapeHtml(r.error || "")}">B151 read failed ${ago(r.started_at)}</span>`;
  }
  const paintB151 = () => {
    const t = document.getElementById("suB151Txt"); if (t) t.innerHTML = b151Line();
    const b = document.getElementById("suB151");
    if (b) { b.disabled = b151.busy; b.textContent = b151.busy ? "Reading the B151…" : "↻ Refresh from B151"; }
  };
  (async () => { try { b151.run = (await api("/review/runs")).b151 || null; } catch (_) {} paintB151(); })();
  async function refreshB151() {
    const before = b151.run?.started_at;
    b151.busy = true; paintB151();
    try {
      await api("/review/refresh?source=b151", { method: "POST" });
      for (let n = 0; n < 72; n++) {            // up to ~6 min
        await new Promise((r) => setTimeout(r, 5000));
        if (!document.body.contains(root)) return;
        const r = (await api("/review/runs")).b151;
        if (r && r.started_at !== before && r.finished_at) { b151.run = r; break; }
      }
      if (b151.run && !b151.run.ok) alert("B151 refresh failed: " + (b151.run.error || "unknown error"));
      else toast("B151 read. Newly won jobs are on the list.");
    } catch (e) { alert("B151 refresh failed: " + (e?.message || e)); }
    b151.busy = false;
    await load(true);
    paintB151();
  }

  async function load(keepDetail = false) {
    try {
      const scope = st.view === "all" ? "all" : "todo";
      const d = await api(`/setup/queue?scope=${scope}`);
      st.jobs = d.jobs; st.scope = scope; st.meta = d;
      if (want && !st.jobs.some((j) => j.key === want) && scope === "todo") { st.view = "all"; return load(keepDetail); }
      const before = st.sel;
      fitSel();
      render(keepDetail && st.sel === before);
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
      if (st.view === "review" && !KPI.review[1](j)) return false;
      if (st.pm && !(j.pms || []).includes(st.pm)) return false;
      if (q && !`${j.project_name || ""} ${j.title || ""} ${j.quote_number || ""} ${j.dealer || ""} ${j.customer || ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  // 2026-11-16: the open job follows the list. Switching tab / tile / PM keeps
  // the open job when it's in the new list, else opens the list's first job
  // (none: an empty-tab note). Typing a search doesn't switch it.
  function fitSel() {
    const rows = visible();
    if (st.sel && rows.some((j) => j.key === st.sel)) return false;
    st.sel = rows[0]?.key || null;
    remember();
    return true;
  }

  function kpis() {
    const n = (k) => st.jobs.filter(KPI[k][1]).length;
    const tile = (k, caption, bad) => `<button type="button" class="card p-4 text-left su-kpi${st.kpi === k ? " on" : ""}" data-kpi="${k}" aria-pressed="${st.kpi === k}">
        <div class="text-[10px] uppercase tracking-wide font-bold text-black/45">${KPI[k][0]}</div>
        <div class="text-2xl font-extrabold tabular-nums ${bad && n(k) ? "text-rose-700" : ""}">${n(k)}</div>
        <div class="text-xs text-black/50">${caption}</div></button>`;
    return `<div class="su-kpis">
      ${tile("review", "Dates, change order, crew or contract changed", true)}
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
        <div class="flex flex-wrap gap-1 mt-1.5">${j.life ? chip(j.life.label, LIFE[j.life.status] || C.quiet, j.life.why || "") : ""}${chip(j.stage === "Ready" ? "Set up" : `Next: ${j.stage}`, j.stage === "Ready" ? C.good : C.quiet)}${j.flags.map((f) => chip(f.text, C[f.tone])).join("")}</div>
      </button>`;
    }).join("");
  }

  function render(keepDetail) {
    const pms = [...new Set(st.jobs.flatMap((j) => j.pms || []))].sort();
    const counts = Object.fromEntries(VIEWS.map(([k]) => [k, null]));
    const prev = st.view; for (const [k] of VIEWS) { st.view = k; counts[k] = (k === "all") === (st.scope === "all") ? visible().length : ""; } st.view = prev;
    const detailEl = keepDetail ? document.getElementById("suDetail") : null;
    root.classList.toggle("su-open", st.open);
    root.innerHTML = `
      ${kpis()}
      <div class="su-bar-row">
        <div class="tabs" role="tablist">${VIEWS.map(([k, l]) => `<button role="tab" class="tab" data-view="${k}" aria-selected="${st.view === k}">${l} <span class="tab-n">${counts[k]}</span></button>`).join("")}</div>
        <input id="suQ" class="input text-sm su-q" placeholder="Search job, quote # or dealer" value="${escapeHtml(st.q)}">
        ${st.kpi ? `<button type="button" class="su-filter" data-clearkpi>Showing: ${escapeHtml(KPI[st.kpi][0])} <span aria-hidden="true">✕</span></button>` : ""}
        <select id="suPm" class="input text-sm su-pm"><option value="">All PMs</option>${pms.map((p) => `<option${p === st.pm ? " selected" : ""}>${escapeHtml(p)}</option>`).join("")}</select>
        <span class="su-b151"><button type="button" class="pd-btn" id="suB151" ${b151.busy ? "disabled" : ""} title="Re-read the B151 Rolling Revenue tab from Google Drive now, so a job just marked 100% Won shows up here without waiting for tonight's update. (New QuickBooks projects still arrive with the nightly QuickBooks sync.)">${b151.busy ? "Reading the B151…" : "↻ Refresh from B151"}</button><span class="su-b151-txt" id="suB151Txt">${b151Line()}</span></span>
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

  // 2026-11-15: every step has a comment thread (opens under the step's head).
  const cmtBtn = (s) => `<button type="button" class="su-cmt-btn" data-cmt="${s.key}" title="Comments on this step">Comment${s.comments ? ` (${s.comments})` : ""}</button>`;
  function headParts(j, s) {
    const p = headParts0(j, s);
    return { ...p, actions: p.actions + cmtBtn(s) };
  }
  function headParts0(j, s) {
    const btns = [];
    if (s.state === "review") {
      const blocked = s.key === "dates" && j.unanswered_dates > 0;
      btns.push(`<button class="pd-btn" data-reviewed="${s.key}"${blocked ? ` disabled title="Answer the date changes below first"` : ""}>Reviewed</button>`);
      const hint = s.note ? `${noteLine(s.note)}` : "";
      return { key: s.key, state: s.state, label: s.label, detail: s.detail, actions: btns.join(""), hint };
    }
    if (s.mark) btns.push(`<button class="pd-btn" data-mark="${s.key}" data-status="">Undo</button>`);
    else if (MANUAL[s.key] && s.state === "todo") btns.push(`<button class="pd-btn" data-mark="${s.key}" data-status="${s.key === "details" ? "done" : "confirmed"}">${MANUAL[s.key]}</button>`);
    else if (s.state === "todo" && ["first_invoice", "po", "qbo_estimate"].includes(s.key)) {
      btns.push(`<button class="pd-btn" data-mark="${s.key}" data-status="done" title="Done outside what the app can see">Mark done</button>`);
      if (s.key === "first_invoice") btns.push(`<button class="pd-btn" data-mark="${s.key}" data-status="not_needed">Not needed</button>`);
    }
    const hint = s.state === "locked" ? (j.project_qbo_id ? "after the dates are set" : "after the project is in QuickBooks")
      : (s.note && s.state !== "done" ? noteLine(s.note) : "");
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
    if (!j) {
      const label = st.kpi && KPI[st.kpi] ? KPI[st.kpi][0] : (VIEWS.find(([k]) => k === st.view) || [])[1];
      box.innerHTML = `<div class="card p-6 text-sm text-black/50">${visible().length ? "Pick a job on the left." : `No jobs ${label ? `in ${escapeHtml(label)}` : "here"} right now.`}</div>`;
      D = null; return;
    }
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
          ${headMoney(j)}
        </div>
        <div class="flex flex-wrap gap-2 mt-3 items-center" data-flags>
          ${j.life ? chip(`Status: ${j.life.label}`, LIFE[j.life.status] || C.quiet, "Worked out from the job: set up, started, ended, closed out") : ""}
          ${j.project_qbo_id ? `<a class="pd-btn" href="${projectLink(j.project_qbo_id)}">Open workspace</a>` : ""}
          ${j.opportunity_id ? `<button class="pd-btn" data-act="pipeline">Open in Pipeline</button>` : `<span class="text-xs text-black/45">No pipeline row</span>`}
          ${j.flags.map((f) => chip(f.text, C[f.tone])).join(" ")}
        </div>
        <div class="su-stages mt-3">${STAGES.map((sg) => `<div class="su-stage" data-stage="${sg}">
          <div class="flex items-center justify-between"><a href="#" class="text-[11px] uppercase tracking-wide font-bold text-black/50 hover:underline" data-jumpsec="${sg}">${sg}</a><div class="text-[11px] font-bold tabular-nums text-black/45" data-n>${stageCount(j, sg)}</div></div>
          <div class="grid gap-1 mt-1.5" data-links>${j.steps.filter((s) => s.stage === sg).map(stepLink).join("")}</div></div>`).join("")}</div>
        <div class="text-[11px] text-black/45 mt-2">Click a step to open it below.</div>
        <details class="su-hcmt mt-3" data-pcomments>
          <summary><span class="su-hcmt-t">Comments <span data-pcount>${j.comments ? `(${j.comments})` : ""}</span></span><span class="su-hcmt-add">Add comment</span></summary>
          <div class="mt-2">${projectCommentsShell(j)}</div>
        </details>
      </section>
      <div data-why>${whyHtml(j)}</div>
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
    box.querySelector("[data-act=pipeline]")?.addEventListener("click", () => openPipelineDrawer(j));
    D.cards = bindStepCards(box, { onOpen: (key, body) => buildBody(j, key, body) });

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
    wireComments(j, box);
    // open the first step still to do (without jumping the page there)
    const next = j.steps.find((s) => s.state === "review") || j.steps.find((s) => s.state === "todo" || s.state === "waiting");
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
        const why = box.querySelector("[data-why]");
        if (why) why.innerHTML = whyHtml(row);
        const pn = box.querySelector("[data-pcomments] [data-pcount]");
        if (pn) pn.textContent = row.comments ? `(${row.comments})` : "";
        const fl = box.querySelector("[data-flags]");
        if (fl) {
          fl.querySelectorAll(".inline-flex").forEach((c) => c.remove());
          fl.insertAdjacentHTML("afterbegin", row.life ? chip(`Status: ${row.life.label}`, LIFE[row.life.status] || C.quiet) : "");
          fl.insertAdjacentHTML("beforeend", row.flags.map((f) => chip(f.text, C[f.tone])).join(" "));
        }
      }
    } catch (_) { /* the next full load catches up */ }
  }

  function wireMarks(j, sec) {
    sec.querySelectorAll("[data-reviewed]").forEach((b) => {
      if (b.dataset.wired) return;
      b.dataset.wired = "1";
      b.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const note = prompt("Re-checked after the change. A note for the record (optional):", "");
        if (note === null) return;
        b.disabled = true;
        try {
          await api(`/setup/job/${encodeURIComponent(j.key)}/review/${b.dataset.reviewed}`, { method: "POST", body: JSON.stringify({ note }) });
          await reloadJob(j.key);
        } catch (e) { b.disabled = false; alert(`Couldn't save: ${e?.message || e}`); }
      });
    });
    sec.querySelectorAll("[data-mark]").forEach((b) => {
      if (b.dataset.wired) return;
      b.dataset.wired = "1";
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          if (b.dataset.status && b.dataset.mark === "qbo_estimate" && !confirm("Mark the estimate done? It ticks itself once the next QuickBooks sync brings it in.")) { b.disabled = false; return; }
          await api(`/setup/job/${encodeURIComponent(j.key)}/step/${b.dataset.mark}`, { method: "POST", body: JSON.stringify({ status: b.dataset.status || null }) });
          await reloadJob(j.key);
        } catch (e) { b.disabled = false; alert(`Couldn't save: ${e?.message || e}`); }
      });
    });
  }

  // ── Why it came back (open re-reviews, grouped by the change) ───────────
  const KIND_LABEL = { dates: "Dates moved", change_order: "Change order", crew: "Crew changed", contract: "Contract value changed" };
  const shortWho = (t) => String(t || "").replace(/([\w.+-]+)@[\w.-]+/g, "$1");
  function whyHtml(j) {
    const by = new Map();   // change text -> { kind, at, by, steps: [] }
    for (const s of j.steps || []) {
      const rv = s.review;
      if (!rv) continue;
      for (const piece of String(rv.reason || "").split(" · ").map((x) => x.trim()).filter(Boolean)) {
        if (!by.has(piece)) by.set(piece, { kind: rv.kind, at: rv.at, by: rv.by, steps: [] });
        const g = by.get(piece);
        if (!g.steps.some((x) => x.key === s.key)) g.steps.push(s);
        if (rv.at && (!g.at || rv.at < g.at)) g.at = rv.at;
      }
    }
    const n = j.unanswered_dates || 0;
    if (!by.size && !n) return "";
    const items = [...by.entries()].map(([txt, g]) => {
      const hasWho = /\(.*\)\s*$/.test(txt);
      const md = g.at ? `${Number(String(g.at).slice(5, 7))}/${Number(String(g.at).slice(8, 10))}` : "";
      const who = hasWho ? "" : ` <span class="text-black/55">(${escapeHtml(shortWho(g.by || "the app"))}${md ? `, ${md}` : ""})</span>`;
      return `<li class="su-why-item">
        <div class="text-sm"><b>${escapeHtml(KIND_LABEL[g.kind] || "Changed")}:</b> ${escapeHtml(shortWho(txt))}${who}</div>
        <div class="flex flex-wrap items-center gap-1.5 mt-1"><span class="text-[11px] text-black/55">Reopened:</span>${g.steps.map((s) =>
          `<button type="button" class="su-why-step" data-jump="${s.key}">${escapeHtml(s.label)}</button>`).join("")}</div>
      </li>`;
    }).join("");
    return `<section class="card p-4 su-why" aria-label="Why it came back">
      <h3 class="su-h">Why it came back</h3>
      <div class="text-xs text-black/55 mt-0.5">A change after setup reopened these steps. Check each one, then press Reviewed on it.</div>
      ${items ? `<ul class="grid gap-2 mt-2">${items}</ul>` : ""}
      ${n ? `<div class="su-why-ask mt-2"><b>${n} date change${n === 1 ? "" : "s"}</b> still need${n === 1 ? "s" : ""} a reason (why it moved, change order?). <button type="button" class="su-linkbtn" data-jump="dates">Answer in Dates</button></div>` : ""}
    </section>`;
  }

  // ── Comments: the project's thread and one per step ─────────────────────
  const cmtWhen = (at) => { const d = new Date(String(at).replace(" ", "T")); return isNaN(d) ? "" : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  const cmtList = (rows, labels, showStep) => rows.length
    ? rows.map((c) => `<li class="su-cmt-item">
        <div class="text-[11px] text-black/55"><b class="text-ink-900">${escapeHtml(shortWho(c.by || "someone"))}</b> · ${escapeHtml(cmtWhen(c.at))}${showStep && c.step_key ? ` · on <i>${escapeHtml(labels[c.step_key] || c.step_key)}</i>` : ""}</div>
        <div class="text-sm whitespace-pre-line mt-0.5">${escapeHtml(c.body)}</div></li>`).join("")
    : `<li class="text-xs text-black/50">No comments yet.</li>`;
  const cmtForm = (ph) => `<form class="grid gap-1.5" data-cform>
      <textarea class="input text-sm" rows="2" maxlength="5000" placeholder="${escapeHtml(ph)}" data-cbody required></textarea>
      <div class="flex flex-wrap items-center gap-3">
        <label class="inline-flex items-center gap-1.5 text-xs text-black/70"><input type="checkbox" data-cnotify> Alert the office</label>
        <button type="submit" class="pd-btn ml-auto">Post comment</button>
      </div></form>`;
  // 2026-11-18: the project's contract is every accepted estimate (latest version),
  // with this quote's amount and the pending change orders under it.
  function headMoney(j) {
    const tip = "Every accepted estimate on the project in QuickBooks (latest version of each). Rejected ones are left out.";
    if (j.contract == null) {
      return `<div class="text-right"><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">Order value</div><div class="font-extrabold tabular-nums">${money0(j.value)}</div>
        <div class="text-[11px] text-black/45">Contract once the project is in QuickBooks</div></div>`;
    }
    const sub = [j.value && Math.abs(j.value - j.contract) > 0.5 ? `This quote ${money0(j.value)}` : null,
      j.pending_n ? `${j.pending_n} pending ${j.pending_n === 1 ? "estimate" : "estimates"} ${money0(j.pending_total)}` : null].filter(Boolean);
    return `<div class="text-right" title="${escapeHtml(tip)}"><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">Contract${j.estimates_n > 1 ? ` · ${j.estimates_n} estimates` : ""}</div>
      <div class="text-lg font-extrabold tabular-nums leading-tight">${money0(j.contract)}</div>
      ${sub.map((x) => `<div class="text-[11px] text-black/50 tabular-nums">${escapeHtml(x)}</div>`).join("")}</div>`;
  }

  function projectCommentsShell(j) {
    return `<div class="flex flex-wrap items-center gap-2"><div class="text-xs text-black/55 flex-1">Notes for everyone working the job. Kept with who wrote it and when.</div>
        <label class="inline-flex items-center gap-1.5 text-xs text-black/60"><input type="checkbox" data-pall> Include step comments</label></div>
      <div class="mt-2">${cmtForm("Comment on the project…")}</div>
      <ul class="su-cmt-list mt-2" data-clist><li class="text-xs text-black/50">Loading…</li></ul>`;
  }
  async function loadThread(j, host, step, all = false) {
    const list = host.querySelector("[data-clist]");
    try {
      const q = step ? `?step=${encodeURIComponent(step)}` : (all ? "?all=1" : "");
      const r = await api(`/setup/job/${encodeURIComponent(j.key)}/comments${q}`);
      st.meta.step_labels = r.labels || st.meta.step_labels || {};
      list.innerHTML = cmtList(r.comments || [], st.meta.step_labels, all);
    } catch (e) { list.innerHTML = `<li class="text-xs text-rose-700">Couldn't load the comments: ${escapeHtml(e?.message || String(e))}</li>`; }
  }
  function wireThread(j, host, step) {
    const form = host.querySelector("[data-cform]");
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const ta = form.querySelector("[data-cbody]");
      const body = ta.value.trim();
      if (!body) return;
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const nt = form.querySelector("[data-cnotify]").checked;
        await api(`/setup/job/${encodeURIComponent(j.key)}/comments`, { method: "POST",
          body: JSON.stringify({ step_key: step || null, body, notify: nt }) });
        ta.value = ""; form.querySelector("[data-cnotify]").checked = false;
        toast(nt ? "Comment posted. The office was alerted." : "Comment posted");
        const all = !step && host.querySelector("[data-pall]")?.checked;
        await loadThread(j, host, step, all);
        await reloadJob(j.key);
      } catch (err) { alert(`Couldn't post: ${err?.message || err}`); }
      finally { btn.disabled = false; }
    });
  }
  function wireComments(j, box) {
    const pc = box.querySelector("[data-pcomments]");
    if (pc) {
      wireThread(j, pc, null);
      let loaded = false;
      pc.addEventListener("toggle", () => { if (pc.open && !loaded) { loaded = true; loadThread(j, pc, null); } });
      pc.querySelector("[data-pall]")?.addEventListener("change", (e) => loadThread(j, pc, null, e.target.checked));
    }
    box.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cmt]");
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const card = b.closest(".sc");
      const key = b.dataset.cmt;
      let th = card.querySelector(":scope > [data-cthread]");
      if (th) { th.remove(); return; }
      th = document.createElement("div");
      th.className = "su-cthread";
      th.dataset.cthread = key;
      th.innerHTML = `${cmtForm(`Comment on “${(j.steps.find((s) => s.key === key) || {}).label || key}”…`)}<ul class="su-cmt-list mt-2" data-clist><li class="text-xs text-black/50">Loading…</li></ul>`;
      card.querySelector(".sc-head").after(th);
      wireThread(j, th, key);
      loadThread(j, th, key);
      th.querySelector("[data-cbody]")?.focus();
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

  // ── Step bodies ─────────────────────────────────────────────────────────
  async function buildBody(j, key, body) {
    const fn = BODY[key];
    if (!fn) { body.innerHTML = ""; return; }
    await fn(j, body);
  }
  const BODY = {
    po: bodyPo, qbo_project: bodyProject, qbo_estimate: bodyEstimate, first_invoice: bodyFirstInvoice,
    pm: bodyPm, crew: bodyCrew, dates: bodyDates, details: bodyDetails,
    invoice_schedule: (j, b) => bodySchedule(j, b, "invoice_schedule"), crew_schedule: (j, b) => bodySchedule(j, b, "crew_schedule"),
    expense_schedule: (j, b) => bodySchedule(j, b, "expense_schedule"),
  };

  // A note on a step that can't be done yet: a reason, an expected date (PO), a
  // note. Saving alerts the office (bell).
  const noteLine = (n) => `Note: ${[noteReason(n), n.expected_date ? `expected ${day(n.expected_date)}` : null, n.note].filter(Boolean).join(" · ")} (${(n.by || "").split("@")[0]}, ${day(n.at)})`;
  const noteReason = (n) => { for (const list of Object.values(st.meta.note_reasons || {})) { const hit = list.find(([k]) => k === n.reason_code); if (hit) return hit[1]; } return n.reason_code; };
  function noteForm(j, step, title) {
    const reasons = (st.meta.note_reasons || {})[step] || [];
    const cur = (j.steps.find((s) => s.key === step) || {}).note;
    return `<form class="su-sub mt-3 grid gap-2" data-noteform="${step}">
      <h4 class="font-bold text-sm">${title}</h4>
      ${cur ? `<div class="text-xs text-black/60">Last note: ${escapeHtml(noteLine(cur))}</div>` : ""}
      <div class="flex flex-wrap gap-2 items-end">
        <label class="text-xs grid gap-1"><span class="text-black/55">Why</span><select name="reason" class="input text-sm"><option value="">Pick one…</option>${reasons.map(([k, l]) => `<option value="${k}">${escapeHtml(l)}</option>`).join("")}</select></label>
        ${step === "po" ? `<label class="text-xs grid gap-1"><span class="text-black/55">Expected</span><input name="expected" type="date" class="input text-sm"></label>` : ""}
        <label class="text-xs grid gap-1" style="flex:1;min-width:200px"><span class="text-black/55">Note</span><input name="note" class="input text-sm" placeholder="Anything the office should know"></label>
        <button type="submit" class="btn-primary text-sm">Save and notify</button>
      </div></form>`;
  }
  function wireNoteForm(j, body) {
    body.querySelectorAll("[data-noteform]").forEach((f) => f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(f);
      if (!fd.get("reason") && !fd.get("note")) { alert("Pick a reason or write a note."); return; }
      try {
        await api(`/setup/job/${encodeURIComponent(j.key)}/note`, { method: "POST", body: JSON.stringify({ step: f.dataset.noteform, reason_code: fd.get("reason") || null, note: fd.get("note") || null, expected_date: fd.get("expected") || null }) });
        toast("Saved. The office was notified.");
        await reloadJob(j.key);
        f.reset();
      } catch (e) { alert(`Couldn't save: ${e?.message || e}`); }
    }));
  }

  async function bodyPo(j, body) {
    const [files, d] = await Promise.all([getDocs(j).catch(() => ({})), getDraft(j).catch(() => null)]);
    const pos = (files["5_purchase_orders"] || []).filter((f) => !f.link_only);
    const po = d?.po;
    const done = (j.steps.find((s) => s.key === "po") || {}).state === "done";
    body.innerHTML = `
      <div class="text-[10px] uppercase tracking-wide font-bold text-black/45 mb-1">Purchase order files</div>
      ${pos.length ? pos.map(docBtn).join("") : `<div class="text-xs text-black/55">No PO in the job's folder (5 Purchase Orders) yet.</div>`}
      <label class="su-drop mt-2" data-drop><input type="file" accept=".pdf,.png,.jpg,.jpeg,.heic,.doc,.docx,.xlsx,.msg,.eml" multiple hidden>
        <span><b>Drop the PO here</b> or click to upload. It's saved in the job's 5 Purchase Orders folder.</span></label>
      ${po ? `<div class="su-facts mt-2">
          <div><span>PO number</span><b>${escapeHtml(po.po_number || "not read")}</b></div>
          <div><span>PO total</span><b>${po.total != null ? money2(po.total) : "not read"}</b></div>
          <div><span>Order value on the pipeline</span><b>${money2(j.value)}</b></div>
        </div>
        ${po.total != null && Math.abs(po.total - (j.value || 0)) > 1 ? `<div class="su-warn mt-2">The PO total and the pipeline's order value differ by ${money2(po.total - (j.value || 0))}.</div>` : ""}
        ${po.snippet ? `<details class="mt-2"><summary class="text-xs font-semibold text-black/60 cursor-pointer">What the app read from the PO</summary><pre class="su-snippet">${escapeHtml(po.snippet)}</pre></details>` : ""}` : ""}
      ${done ? "" : noteForm(j, "po", "No PO yet?")}`;
    wireDocs(body);
    wireNoteForm(j, body);
    const drop = body.querySelector("[data-drop]");
    const input = drop.querySelector("input");
    const upload = async (fileList) => {
      const list = [...fileList];
      if (!list.length) return;
      drop.classList.add("busy"); drop.querySelector("span").textContent = `Uploading ${list.length} file${list.length === 1 ? "" : "s"}…`;
      try {
        for (const f of list) {
          const fd = new FormData(); fd.append("file", f);
          const where = j.opportunity_id ? `opportunity/${j.opportunity_id}` : `project/${encodeURIComponent(j.project_qbo_id)}`;
          await api(`/documents/${where}?folder=5_purchase_orders`, { method: "POST", body: fd });
        }
        delete st.cache[`docs:${j.key}`]; delete st.cache[`draft:${j.key}`];
        toast("PO uploaded.");
        await reloadJob(j.key);
        bodyPo(D?.j || j, body);
      } catch (e) { drop.classList.remove("busy"); alert(`Couldn't upload: ${e?.message || e}`); }
    };
    input.addEventListener("change", () => upload(input.files));
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); upload(e.dataTransfer.files); });
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
  // 2026-11-18: every estimate on the project, one line each (original first,
  // then change orders), expandable to how it ties to its PO. Before the project
  // has an estimate, the app's copy-ready draft of the first one shows instead.
  const EST_ST = { Accepted: C.good, Converted: C.good, Closed: C.good, Pending: C.warn, Rejected: C.quiet };
  function estimatesHtml(x) {
    const tie = (e) => e.ties === true ? chip("Ties to PO", C.good) : e.ties === false ? chip("PO differs", C.bad)
      : e.po_number ? chip("PO not on file", C.warn) : chip("No PO", C.quiet);
    const ico = (ok) => ok === true ? ICON.done : ok === false ? ICON.review || ICON.todo : ICON.todo;
    const rows = x.estimates.map((e) => {
      const off = !["Accepted", "Converted", "Closed", "Pending"].includes(e.status);
      return `<details class="su-est${off ? " su-est-off" : ""}">
        <summary>
          <span class="su-est-no">#${escapeHtml(e.doc_number || "")}</span>
          ${chip(e.original ? "Original" : "Change order", e.original ? C.info : C.quiet)}
          <span class="text-xs text-black/55">${day(e.date)}</span>
          ${chip(e.status || "?", EST_ST[e.status] || C.quiet)}
          ${e.reopened ? chip("Re-review", C.bad, "This estimate sent the job back for re-review") : ""}
          <span class="ml-auto flex items-center gap-2">${off ? "" : tie(e)}<b class="tabular-nums">${money2(e.total)}</b></span>
        </summary>
        <div class="su-est-body">
          <div class="text-xs text-black/55">${[e.accepted_date ? `Accepted ${day(e.accepted_date)}` : null, e.created ? `Created ${day(e.created)}` : null,
            e.po_number ? `PO # on the estimate: ${escapeHtml(e.po_number)}` : "No PO number on the estimate"].filter(Boolean).join(" · ")}</div>
          <div class="grid gap-1 mt-2">${e.checks.map((c) => `<div class="flex items-start gap-2 text-sm">${ico(c.ok)}<span>${escapeHtml(c.text)}</span></div>`).join("")}</div>
          <div class="su-est-terms mt-2">
            <div><span>Estimate terms</span>${escapeHtml(e.terms?.text || "Not on the estimate")}</div>
            <div><span>PO terms</span>${e.po ? escapeHtml(e.po.terms?.text || "Not found on the PO") : "No PO on file"}</div>
          </div>
          ${e.po ? `<button type="button" class="pd-btn mt-2" data-doc="${e.po.document_id}" data-fn="${escapeHtml(e.po.filename)}">${DOC_ICON || ""} Open the PO</button>` : ""}
        </div>
      </details>`;
    }).join("");
    return `<div class="su-est-tot">
        <div><span>Contract (accepted)</span><b>${money2(x.accepted_total)}</b><em>${x.accepted_n} estimate${x.accepted_n === 1 ? "" : "s"}</em></div>
        ${x.pending_n ? `<div><span>Pending</span><b>${money2(x.pending_total)}</b><em>${x.pending_n} not accepted yet</em></div>` : ""}
        ${x.other_n ? `<div><span>Rejected / other</span><b>${x.other_n}</b><em>not counted</em></div>` : ""}
      </div>
      <div class="grid gap-1.5 mt-3">${rows}</div>
      <div class="text-[11px] text-black/45 mt-2">Amounts are QuickBooks' bottom line, so discounts and deducts count. Open a line to see how it ties to its PO.</div>`;
  }

  async function bodyEstimate(j, body) {
    if (j.project_qbo_id) {
      const x = await api(`/setup/job/${encodeURIComponent(j.key)}/estimates`);
      if ((x.estimates || []).length) {
        body.innerHTML = estimatesHtml(x);
        wireDocs(body);
        return;
      }
    }
    const d = await getDraft(j);
    const isAdmin = (getMe()?.user?.role || getMe()?.role) === "admin";
    body.innerHTML = `<div class="flex flex-wrap items-center gap-2"><div class="text-xs text-black/55 flex-1">Not in QuickBooks yet. The app drafted it from the estimator's estimate and the PO: copy it in, then this step ticks itself after the next sync (or press Sync now).</div>
        ${isAdmin && j.project_qbo_id ? `<button class="pd-btn" data-qbosync title="Pull the latest estimates and invoices from QuickBooks now">Sync now</button>` : ""}</div>
      <div data-draft class="mt-2"></div>
      ${noteForm(j, "qbo_estimate", "Estimate not done yet?")}`;
    draftHtml(j, d, body.querySelector("[data-draft]"));
    wireNoteForm(j, body);
    body.querySelector("[data-qbosync]")?.addEventListener("click", async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = "Syncing…";
      try { await api("/qbo/sync/transactions", { method: "POST" }); delete st.cache[`draft:${j.key}`]; await reloadJob(j.key); toast("QuickBooks synced."); bodyEstimate(D?.j || j, body); }
      catch (er) { b.disabled = false; b.textContent = "Sync now"; alert(`Couldn't sync: ${er?.message || er}`); }
    });
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

  // 2026-11-18: one line per accepted estimate: its first invoice from QuickBooks
  // (number, amount, sent, due, expected, terms, status; expected editable while
  // unpaid), or, if none yet, whether one is needed (the app's default from the
  // billing rule, or the office's choice) and the planned first row.
  async function bodyFirstInvoice(j, body) {
    if (!j.project_qbo_id) {
      body.innerHTML = `<div class="text-sm text-black/55">Opens once the project is in QuickBooks.</div>${noteForm(j, "first_invoice", "First invoice not sent yet?")}`;
      wireNoteForm(j, body);
      return;
    }
    const fi = await api(`/setup/job/${encodeURIComponent(j.key)}/first-invoice`);
    const ests = fi.estimates || [];
    const dateIn = (name, v, label, hint) => `<label class="text-xs grid gap-1"><span class="text-black/55" title="${escapeHtml(hint || "")}">${label}</span><input type="date" name="${name}" value="${escapeHtml(v || "")}" class="input text-sm"></label>`;
    const stCls = (s) => s === "Paid" ? C.good : s === "Partly paid" ? C.info : C.warn;
    const rows = ests.map((e) => {
      const head = `<td><b>#${escapeHtml(e.doc_number || "")}</b> ${chip(e.change_order ? "Change order" : "Original", e.change_order ? C.quiet : C.info)}<div class="text-[11px] text-black/50 tabular-nums">${money0(e.total)}</div></td>`;
      if (e.invoice) {
        const i = e.invoice, open = i.balance > 0.01;
        return `<tr>${head}
          <td class="font-semibold">#${escapeHtml(i.doc_number || "")}</td>
          <td class="text-right tabular-nums">${money2(i.amount)}${i.pct != null ? `<div class="text-[11px] text-black/45">${i.pct}%</div>` : ""}</td>
          <td>${day(i.date)}</td><td>${day(i.due)}</td>
          <td>${open ? `<input type="date" class="input text-xs py-1" data-invexp="${escapeHtml(i.qbo_id)}" value="${escapeHtml(i.expected || "")}" title="When the money is expected to land (blank = the due date). Cash Flow follows.">${i.expected_set ? "" : `<div class="text-[10px] text-black/40">due date</div>`}` : `<span class="text-black/45">—</span>`}</td>
          <td>${escapeHtml(i.terms || "—")}</td>
          <td>${chip(i.status, stCls(i.status))}${i.balance > 0.01 && i.balance < i.amount - 0.01 ? `<div class="text-[11px] text-black/50">${money2(i.balance)} open</div>` : ""}</td></tr>`;
      }
      const sel = `<select class="input text-xs py-1" data-need="${escapeHtml(e.qbo_id)}" title="${escapeHtml(e.default_reason)}">
          <option value="needed"${e.need === "needed" ? " selected" : ""}>Needs a first invoice${!e.need_set && e.need === "needed" ? " (default)" : ""}</option>
          <option value="not_needed"${e.need === "not_needed" ? " selected" : ""}>No first invoice needed${!e.need_set && e.need === "not_needed" ? " (default)" : ""}</option>
        </select>${e.need_set ? ` <button type="button" class="su-linkbtn" data-needreset="${escapeHtml(e.qbo_id)}" title="Back to the app's default: ${escapeHtml(e.default_reason)}">reset</button>` : ""}`;
      const p = e.planned;
      return `<tr class="${e.need === "needed" ? "su-diff" : ""}">${head}
        <td colspan="7"><div class="flex flex-wrap items-center gap-2">${chip(e.need === "needed" ? "Not sent yet" : "Not needed", e.need === "needed" ? C.warn : C.quiet)} ${sel}
          <span class="text-[11px] text-black/50">${e.need_set ? `Set by ${escapeHtml(shortWho(e.need_by || ""))}` : escapeHtml(e.default_reason)}</span></div>
          ${e.need === "needed" && p ? `<form class="flex flex-wrap gap-2 items-end mt-2" data-msform="${p.id}">
            <div class="text-xs"><div class="text-black/55">Planned</div><b class="tabular-nums">${money2(p.amount)}</b>${p.pct != null ? ` <span class="text-black/45">(${p.pct}%)</span>` : ""}</div>
            ${dateIn("invoice_date", p.invoice_date, "Send date")}${dateIn("due_date", p.due_date, "Due date")}${dateIn("expected_paid_date", p.expected_paid_date, "Expected", "Blank = the due date")}
            <button type="submit" class="pd-btn">Save dates</button></form>` : ""}</td></tr>`;
    }).join("");
    body.innerHTML = ests.length ? `
      <div class="overflow-x-auto"><table class="w-full text-xs su-table">
        <thead><tr><th class="text-left">Estimate</th><th class="text-left">Invoice</th><th class="text-right">Amount</th><th class="text-left">Sent</th><th class="text-left">Due</th><th class="text-left">Expected</th><th class="text-left">Terms</th><th class="text-left">Status</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <div class="text-[11px] text-black/45 mt-1">Each accepted estimate's first invoice in QuickBooks. Change orders and small estimates are billed once, at completion, so they need no first invoice unless you say so. Expected dates feed Billing &amp; Schedule and Cash Flow.</div>
      ${noteForm(j, "first_invoice", "First invoice not sent yet?")}`
      : `<div class="text-sm text-black/55">No accepted estimate on the project yet.</div>${noteForm(j, "first_invoice", "First invoice not sent yet?")}`;
    wireNoteForm(j, body);
    const after = async (msg) => { toast(msg); await reloadJob(j.key); };
    body.querySelectorAll("[data-invexp]").forEach((inp) => inp.addEventListener("change", async () => {
      try {
        await api(`/invoices/qbo-invoice/${encodeURIComponent(inp.dataset.invexp)}/expected`, { method: "PATCH", body: JSON.stringify({ expected_paid_date: inp.value || null, via: "project_setup" }) });
        toast(inp.value ? "Expected date saved. Cash Flow follows." : "Expected date cleared: back to the due date.");
      } catch (e) { alert(`Couldn't save: ${e?.message || e}`); }
    }));
    body.querySelectorAll("[data-need]").forEach((sel) => sel.addEventListener("change", async () => {
      try {
        await api(`/setup/job/${encodeURIComponent(j.key)}/first-invoice/${encodeURIComponent(sel.dataset.need)}/need`, { method: "POST", body: JSON.stringify({ need: sel.value }) });
        await after(sel.value === "needed" ? "Marked: needs a first invoice." : "Marked: no first invoice needed.");
      } catch (e) { alert(`Couldn't save: ${e?.message || e}`); }
    }));
    body.querySelectorAll("[data-needreset]").forEach((b) => b.addEventListener("click", async () => {
      try {
        await api(`/setup/job/${encodeURIComponent(j.key)}/first-invoice/${encodeURIComponent(b.dataset.needreset)}/need`, { method: "POST", body: JSON.stringify({ need: null }) });
        await after("Back to the app's default.");
      } catch (e) { alert(`Couldn't save: ${e?.message || e}`); }
    }));
    body.querySelectorAll("[data-msform]").forEach((f) => f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(f), patch = {};
      for (const [k, v] of fd.entries()) patch[k] = v || null;
      try {
        const r = await api(`/invoices/milestone/${f.dataset.msform}`, { method: "PATCH", body: JSON.stringify({ ...patch, via: "project_setup" }) });
        for (const k of ["invoice_date", "due_date", "expected_paid_date"]) {
          const inp = f.querySelector(`[name="${k}"]`);
          if (inp && r && k in r) inp.value = r[k] || "";
        }
        toast(r && r.due_from_terms ? `Saved. Due date set from the terms (${r.due_from_terms.replace("due = ", "")}).` : "Saved. Billing & Schedule and Cash Flow follow.");
      } catch (e) { alert(`Couldn't save: ${e?.message || e}`); }
    }));
  }

  // ── Pipeline record in a side drawer ────────────────────────────────────
  async function openPipelineDrawer(j) {
    const wrap = document.createElement("div");
    wrap.className = "pd-backdrop";
    wrap.innerHTML = `<div class="pd-panel" role="dialog" aria-modal="true" aria-label="Pipeline record" style="width:min(720px,96vw)">
      <div class="pd-head"><div class="pd-title"><div class="pd-name">${escapeHtml(j.title || "")}</div><div class="pd-sub">Pipeline · quote #${escapeHtml(String(j.quote_number || ""))}</div></div>
        <a class="pd-btn" href="#/pipeline">Open the Pipeline page</a>
        <button class="pd-x" data-x aria-label="Close">×</button></div>
      <div class="pd-body"><div class="card p-4 text-sm" data-pbody>Loading…</div></div></div>`;
    document.body.appendChild(wrap);
    const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-x]")) close(); });
    const el = wrap.querySelector("[data-pbody]");
    try {
      const [{ opportunity: o }, files] = await Promise.all([api(`/opportunities/${j.opportunity_id}`), getDocs(j).catch(() => ({}))]);
      const f = (k, v) => (v == null || v === "" ? "" : `<div><span>${k}</span><b>${v}</b></div>`);
      const pct = (v) => (v == null ? null : `${(Number(v) * (Number(v) <= 1 ? 100 : 1)).toFixed(1)}%`);
      const docs = ["4_quotes", "5_purchase_orders", "1_request_for_quote", "2_drawings_calcs"].flatMap((k) => (files[k] || []).filter((x) => !x.link_only).slice(0, 4));
      el.innerHTML = `<div class="su-facts">
          ${f("Status", escapeHtml(o.pipeline_status || o.status || ""))}${f("Customer", escapeHtml(o.customer_name || ""))}${f("Contact", escapeHtml(o.contact_name || ""))}
          ${f("Estimator", escapeHtml(o.estimator_name || o.quoted_by || ""))}${f("RFQ received", day(o.rfq_received_date || o.received_at))}${f("Quote sent", day(o.quote_sent_date || o.sent_at))}
          ${f("Won", day(o.order_date || o.decided_at))}${f("Contract value", o.contract_value != null ? money2(o.contract_value) : null)}${f("Order value", o.order_value != null ? money2(o.order_value) : null)}
          ${f("OH&amp;P", o.ohp_pct != null ? `${pct(o.ohp_pct)}${o.ohp_amount ? ` · ${money0(o.ohp_amount)}` : ""}` : null)}${f("Labor days", o.labor_days)}${f("Travel days", o.travel_days)}
          ${f("Target dates", o.target_start_date ? `${day(o.target_start_date)} to ${day(o.target_end_date)}` : null)}${f("Revisions", o.total_revisions || o.revision_count)}
          ${f("Last contact", o.last_contact_date ? `${day(o.last_contact_date)}${o.last_comm_type ? ` · ${escapeHtml(o.last_comm_type)}` : ""}` : null)}${f("Follow-ups", o.follow_up_count)}
        </div>
        ${o.workbook_url ? `<div class="mt-3"><a class="pd-btn" href="${escapeHtml(o.workbook_url)}" target="_blank" rel="noopener">Quoting Metrics workbook ↗</a></div>` : ""}
        ${o.notes ? `<div class="mt-3 text-xs text-black/70 whitespace-pre-line">${escapeHtml(o.notes)}</div>` : ""}
        ${docs.length ? `<div class="text-[10px] uppercase tracking-wide font-bold text-black/45 mt-3 mb-1">Documents</div>${docs.map(docBtn).join("")}` : ""}`;
      wireDocs(el);
    } catch (e) { el.textContent = `Couldn't load the pipeline record: ${e?.message || e}`; }
  }

  // Each Assignment card shows only its part of the assignment editor (the same
  // editor as the project workspace), and each Schedules card only its part of
  // the Billing panel.
  function mountPart(j, slot, show, intro) {
    if (!slot) return;
    if (!j.project_internal_id) { slot.innerHTML = `<div class="text-xs text-black/50">Opens once the project is in QuickBooks.</div>`; return; }
    slot.classList.add("su-embed");
    mountAssignmentPanel(slot, j.project_internal_id, () => onAssignChange(j), { show, intro });
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
      const dc = document.querySelector('#suDetail .sc[data-sc="dates"] [data-dchanges]');
      if (dc) setTimeout(() => loadDateChanges(D?.j || j, dc), 1500);
    }, 600);
  }
  const partSlot = (title) => `<div class="su-sub mt-3"><h4 class="font-bold text-sm">${title}</h4><div data-part class="mt-2"></div></div>`;

  async function bodyPm(j, body) {
    body.innerHTML = `<div class="su-sub"><h4 class="font-bold text-sm">PM availability</h4>
        <div class="text-xs text-black/55 mt-0.5">Each PM's running and upcoming jobs and how many overlap this one. Click a PM for their jobs on a timeline.</div>
        <div data-pms class="text-xs text-black/45 mt-2">Loading…</div></div>${partSlot("Assign the PM(s)")}`;
    loadPmWorkload(j, body.querySelector("[data-pms]"));
    mountPart(j, body.querySelector("[data-part]"), ["pm"], "Pick one or more PMs for each set of dates (click the PM box). Saves as you go.");
  }
  async function bodyCrew(j, body) {
    body.innerHTML = `
      <div class="su-sub"><h4 class="font-bold text-sm">Crew availability${j.start ? ` · ${day(j.start)} to ${day(j.end)}` : ""}</h4>
        <div class="text-xs text-black/55 mt-0.5">${j.start ? "Click a crew to see each day (each week on long jobs) and what they're booked on." : ""}</div>
        <div data-avail class="text-xs text-black/45 mt-1.5">${j.start ? "Loading…" : "Set the dates first (Start and end dates) to see which crews are free."}</div></div>
      <div class="su-sub mt-3"><h4 class="font-bold text-sm">Crew offer</h4><div data-offers class="text-xs text-black/45 mt-1.5">${j.project_qbo_id ? "Loading…" : "Opens once the project is in QuickBooks."}</div></div>
      ${partSlot("Assign the crew to each set of dates")}`;
    if (j.start) loadAvailability(j, body.querySelector("[data-avail]"));
    if (j.project_qbo_id) loadOffers(j, body.querySelector("[data-offers]"));
    mountPart(j, body.querySelector("[data-part]"), ["crew"], "Pick the crew (company, lead, slot) for each set of dates, and any days off. Saves as you go.");
  }
  async function bodyDates(j, body) {
    body.innerHTML = `<div class="text-xs text-black/55">${j.target_start ? `The quote targeted ${day(j.target_start)} to ${day(j.target_end)}${j.labor_days ? ` (${j.labor_days} labor days${j.travel_days ? `, ${j.travel_days} travel` : ""})` : ""}. ` : ""}Quoted end = the end the price was built on (green on the Job Schedule). Overage days = calendar days worked past it (orange). Moving a date sends the job back here and asks why.</div>
      <div data-dchanges class="mt-2"></div>
      ${partSlot("Start, end and overage for each set of dates")}`;
    if (j.project_qbo_id) loadDateChanges(j, body.querySelector("[data-dchanges]"));
    mountPart(j, body.querySelector("[data-part]"), ["dates"], "Change a date and it saves; the change is kept in the history with why it moved. Put the job on hold with the bar above.");
  }
  async function bodyDetails(j, body) {
    body.innerHTML = `<div class="text-xs text-black/55">Wire guidance, travel days and equipment, then press "Mark checked". Hints below come from the PO and the estimate.</div>
      <div data-hints class="mt-2 text-xs text-black/45">${j.project_qbo_id || j.opportunity_id ? "Looking for hints…" : ""}</div>
      ${partSlot("Job details")}`;
    loadHints(j, body.querySelector("[data-hints]"));
    mountPart(j, body.querySelector("[data-part]"), ["details"], "Wire guidance, travel days and equipment for each set of dates.");
  }
  async function bodySchedule(j, body, key) {
    const only = { invoice_schedule: "invoice", crew_schedule: "crew", expense_schedule: "expense" }[key];
    const what = { invoice: "The customer invoices: contract value, dates, what's paid, sent and due, the invoice schedule (edit any row), the QuickBooks invoices and pending change orders.",
      crew: "The crew payment schedule: what each crew is paid and when (payroll Fridays). An offer sent from the app goes out with it.",
      expense: "The expense schedule: lodging, rentals and other costs by category and week." }[only];
    body.innerHTML = `<div class="text-xs text-black/55">${what} Check it, fix any date or amount, then press "Mark reviewed".</div><div data-billing-slot class="mt-2"></div>`;
    const slot = body.querySelector("[data-billing-slot]");
    if (!j.project_qbo_id || !j.start) { slot.innerHTML = `<div class="text-xs text-black/50">${j.project_qbo_id ? "Set the start and end dates first. The schedules are built from them." : "Opens once the project is in QuickBooks and has dates."}</div>`; return; }
    slot.classList.add("su-embed");
    mountBillingPanel(slot, j.project_qbo_id, { only });
  }

  // ── Date changes: why it moved, change order? (and the end-date history) ─
  async function loadDateChanges(j, el) {
    if (!el) return;
    let d;
    try { d = await api(`/setup/job/${encodeURIComponent(j.key)}/dates`); }
    catch (e) { el.textContent = `Couldn't load the date history: ${e?.message || e}`; return; }
    const reasons = d.reasons || [];
    const open = d.changes.filter((c) => !c.answered_at);
    const done = d.changes.filter((c) => c.answered_at);
    const rlabel = Object.fromEntries(reasons);
    const coTxt = { yes: "change order needed", no: "no change order", sent: "change order already sent" };
    el.innerHTML = `
      ${open.length ? `<div class="su-warn"><b>${open.length} date change${open.length === 1 ? "" : "s"} to answer.</b> Why did it move, and is a change order needed? Then press Reviewed on this step.</div>
        <div class="grid gap-2 mt-2">${open.map((c) => `<form class="su-sub grid gap-2" data-answer="${c.id}">
          <div class="text-sm"><b>${escapeHtml(c.summary)}</b> <span class="text-black/50 text-xs">· ${escapeHtml(c.source === "job_schedule" ? "from the Job Schedule" : c.changed_by || "")} ${day(c.changed_at)}</span></div>
          <div class="flex flex-wrap gap-2 items-end">
            <label class="text-xs grid gap-1"><span class="text-black/55">Why did it move?</span><select name="reason" class="input text-sm" required><option value="">Pick one…</option>${reasons.filter(([k]) => k !== "on_hold").map(([k, l]) => `<option value="${k}">${escapeHtml(l)}</option>`).join("")}</select></label>
            <label class="text-xs grid gap-1"><span class="text-black/55">Change order needed?</span><select name="co" class="input text-sm" required><option value="">Pick one…</option><option value="no">No</option><option value="yes">Yes (opens a to-do)</option><option value="sent">Already sent</option></select></label>
            <label class="text-xs grid gap-1" style="flex:1;min-width:180px"><span class="text-black/55">Note</span><input name="note" class="input text-sm" placeholder="What happened"></label>
            <button class="btn-primary text-sm" type="submit">Save</button>
          </div></form>`).join("")}</div>` : ""}
      ${done.length ? `<details class="mt-2"${open.length ? "" : " open"}><summary class="text-xs font-semibold text-black/60 cursor-pointer">Date history (${done.length})</summary>
        <div class="overflow-x-auto mt-1"><table class="w-full text-xs su-table"><thead><tr><th class="text-left">When</th><th class="text-left">Change</th><th class="text-left">Why</th><th class="text-left">By</th></tr></thead>
        <tbody>${done.map((c) => `<tr><td>${day(c.changed_at)}</td><td>${escapeHtml(c.summary)}</td><td>${escapeHtml([rlabel[c.reason_code] || c.reason_code, coTxt[c.co_needed], c.note].filter(Boolean).join(" · "))}</td><td class="text-black/55">${escapeHtml(c.source === "job_schedule" ? "Job Schedule" : c.changed_by || "")}</td></tr>`).join("")}</tbody></table></div></details>` : (open.length ? "" : `<div class="text-xs text-black/45">No date changes since setup.</div>`)}`;
    el.querySelectorAll("[data-answer]").forEach((f) => f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const fd = new FormData(f);
      try {
        await api(`/setup/date-change/${f.dataset.answer}`, { method: "POST", body: JSON.stringify({ reason_code: fd.get("reason"), co_needed: fd.get("co"), note: fd.get("note") || null }) });
        await reloadJob(j.key);
        loadDateChanges(D?.j || j, el);
      } catch (e) { alert(`Couldn't save: ${e?.message || e}`); }
    }));
  }

  // ── Job-detail hints from the PO and the estimate ───────────────────────
  async function loadHints(j, el) {
    if (!el || (!j.project_qbo_id && !j.opportunity_id)) return;
    let d;
    try { d = await api(`/setup/job/${encodeURIComponent(j.key)}/hints`); } catch (_) { el.textContent = ""; return; }
    const lab = { wire: "Wire guidance", travel: "Travel", equipment: "Equipment" };
    const any = Object.values(d).some((v) => v.length);
    el.className = "mt-2";
    el.innerHTML = any ? `<div class="su-facts">${Object.entries(lab).map(([k, l]) => `<div><span>${l}</span><b class="font-normal text-xs">${(d[k] || []).length ? d[k].slice(0, 3).map((h) => `<div class="mb-1"><span class="text-black/45">${escapeHtml(h.source)}:</span> ${escapeHtml(h.text)}</div>`).join("") : '<span class="text-black/40">nothing found</span>'}</b></div>`).join("")}</div>`
      : `<div class="text-xs text-black/45">No wire, travel or equipment words in the PO or the estimate.</div>`;
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
    st.availWeekly = (d.companies[0]?.days || []).length > 92;
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
    // long jobs (over ~3 months): one box per week = the fewest crews free on a weekday that week
    const weeks = [];
    if (st.availWeekly) {
      for (const x of c.days || []) {
        const t = new Date(`${x.date}T00:00:00`); const mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7));
        const k = mon.toISOString().slice(0, 10);
        let w = weeks[weeks.length - 1];
        if (!w || w.k !== k) { w = { k, free: null, off: 0 }; weeks.push(w); }
        if (x.weekday < 5) { w.free = w.free == null ? x.free : Math.min(w.free, x.free); w.off = Math.max(w.off, x.off); }
      }
    }
    const grid = st.availWeekly
      ? `<div class="su-days">${weeks.map((w) => `<div class="su-day${(w.free ?? 1) <= 0 ? " full" : ""}${w.off ? " off" : ""}" title="${escapeHtml(`Week of ${w.k}: at least ${w.free ?? "—"} free of ${c.capacity} every weekday`)}">
          <span>wk</span><b>${w.free ?? "—"}</b><span>${new Date(`${w.k}T00:00:00`).toLocaleDateString([], { month: "numeric", day: "numeric" })}</span></div>`).join("")}</div>
        <div class="text-[11px] text-black/50 mt-1">Long job: one box per week, the fewest crews free on any weekday that week, out of ${c.capacity}. Red = fully booked.</div>`
      : `<div class="su-days">${(c.days || []).map((x) => `<div class="su-day${x.weekday >= 5 ? " wkend" : ""}${x.free <= 0 ? " full" : ""}${x.off ? " off" : ""}" title="${escapeHtml(`${x.date}: ${x.booked} booked, ${x.off} off, ${x.free} free of ${c.capacity}`)}">
        <span>${wd[x.weekday]}</span><b>${x.free}</b><span>${new Date(`${x.date}T00:00:00`).getDate()}</span></div>`).join("")}</div>
      <div class="text-[11px] text-black/50 mt-1">Crews free each day, out of ${c.capacity}. Red = fully booked.</div>`;
    return `${grid}
      ${Object.keys(byProj).length ? `<div class="grid gap-0.5 mt-2">${Object.entries(byProj).map(([name, g]) => `<div class="text-xs"><a class="font-semibold underline" href="${g.entity_id ? projectLink(g.entity_id) : "#"}">${escapeHtml(name)}</a>
          <span class="text-black/55">${g.rows.map((b) => `${escapeHtml(b.slot || "")}${b.lead ? ` ${escapeHtml(b.lead)}` : ""} ${day(b.from)} to ${day(b.thru)}`).join("; ")}</span></div>`).join("")}</div>` : `<div class="text-xs text-black/55 mt-2">Not booked on anything during this job.</div>`}
      ${(c.time_off || []).length ? `<div class="text-xs text-amber-800 mt-1">Time off: ${(c.time_off || []).map((t) => escapeHtml(`${t.lead || "whole company"} ${t.start || t.from || ""} to ${t.end || t.thru || ""}`)).join("; ")}</div>` : ""}
      ${canOffer ? `<button type="button" class="pd-btn mt-2" data-offer-crew>Offer the job to ${escapeHtml(c.name)}</button>` : ""}`;
  }

  const remountEditor = (j) => {
    const slot = document.querySelector('#suDetail .sc[data-sc="crew"] [data-part]');
    if (slot) mountPart(j, slot, ["crew"], "Pick the crew (company, lead, slot) for each set of dates, and any days off. Saves as you go.");
  };
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
      ${!d.accepted && !d.offers.length && (D?.j || j).crews?.length ? `<div class="su-warn mt-1">A crew is assigned (${escapeHtml((D?.j || j).crews.join(", "))}) but no offer is on record. Was an offer sent outside the app? <button type="button" class="su-linkbtn" data-showoutside>Yes, record it</button> <button type="button" class="su-linkbtn" data-showoffer>No, send one from the app</button></div>` : ""}
      ${d.accepted ? "" : `<details class="su-sub mt-3" data-outside><summary class="text-xs font-semibold text-black/70 cursor-pointer">Offer sent outside the app (email, text, the Drive sheet)</summary>
        <form class="grid gap-2 mt-2" data-outform>
          <div class="flex flex-wrap gap-2">
            <label class="text-xs grid gap-1" style="flex:1;min-width:180px"><span class="text-black/55">Crew company</span><select name="crew" class="input text-sm" required><option value="">Choose a crew…</option>${d.crews.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</select></label>
            <label class="text-xs grid gap-1" style="width:140px"><span class="text-black/55">Labor amount</span><input name="amount" type="number" step="0.01" min="0" class="input text-sm tabular-nums" value="${d.suggested_labor || ""}"></label>
            <label class="text-xs grid gap-1"><span class="text-black/55">Sent</span><input name="sent" type="date" class="input text-sm" required></label>
            <label class="text-xs grid gap-1"><span class="text-black/55">Accepted (if yes)</span><input name="accepted" type="date" class="input text-sm"></label>
          </div>
          <label class="su-drop" data-odrop><input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.heic,.doc,.docx,.xlsx" hidden><span><b>Drop the signed offer here</b> or click to pick it (saved in the job's 7 Notes folder).</span></label>
          <div><button type="submit" class="btn-primary text-sm">Record the offer</button></div>
        </form></details>`}
      ${d.accepted ? "" : `<form data-new class="grid gap-2 mt-3 su-offer"${!d.offers.length && stepOf(D?.j || j, "crew").state === "done" ? " hidden" : ""}>
        <div class="flex flex-wrap gap-2">
          <label class="text-xs grid gap-1" style="flex:1;min-width:180px"><span class="text-black/55">Crew company</span><select name="crew" class="input text-sm" required><option value="">Choose a crew…</option>${d.crews.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${c.boss_name ? ` (${escapeHtml(c.boss_name)})` : ""}</option>`).join("")}</select></label>
          <label class="text-xs grid gap-1" style="width:150px"><span class="text-black/55">Labor amount</span><input name="amount" type="number" step="0.01" min="0" class="input text-sm tabular-nums" value="${d.suggested_labor || ""}"></label>
        </div>
        <label class="text-xs grid gap-1"><span class="text-black/55">Scope (from the accepted estimates' labor lines; edit as needed)</span><textarea name="scope" rows="3" class="input text-sm">${escapeHtml(d.suggested_scope || "")}</textarea></label>
        <div class="flex flex-wrap gap-2 items-center"><button type="button" class="pd-btn" data-copytext>Copy offer text</button><button type="submit" class="btn-primary text-sm">Record offer as sent</button>
          <span class="text-xs text-black/50">Needs the crew payment schedule first (Schedules below): the offer goes out with it. The app doesn't email crews yet: copy the text to the crew boss, then record it here.</span></div>
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
    el.querySelector("[data-showoffer]")?.addEventListener("click", (ev) => { if (form) form.hidden = false; ev.target.parentElement.remove(); });
    el.querySelector("[data-showoutside]")?.addEventListener("click", (ev) => { const o = el.querySelector("[data-outside]"); if (o) { o.open = true; o.scrollIntoView({ block: "center" }); } ev.target.parentElement.remove(); });
    const out = el.querySelector("[data-outform]");
    if (out) {
      const odrop = out.querySelector("[data-odrop]"), ofile = odrop.querySelector("input");
      const showName = () => { odrop.querySelector("span").innerHTML = ofile.files[0] ? `<b>${escapeHtml(ofile.files[0].name)}</b> (click to change)` : "<b>Drop the signed offer here</b> or click to pick it (saved in the job's 7 Notes folder)."; };
      ofile.addEventListener("change", showName);
      odrop.addEventListener("dragover", (e) => { e.preventDefault(); odrop.classList.add("over"); });
      odrop.addEventListener("dragleave", () => odrop.classList.remove("over"));
      odrop.addEventListener("drop", (e) => { e.preventDefault(); odrop.classList.remove("over"); if (e.dataTransfer.files.length) { ofile.files = e.dataTransfer.files; showName(); } });
      out.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const f = new FormData(out);
        try {
          if (ofile.files[0]) {
            const fd = new FormData(); fd.append("file", ofile.files[0]);
            await api(`/documents/project/${encodeURIComponent(j.project_qbo_id)}?folder=7_notes`, { method: "POST", body: fd });
          }
          const r = await api(`/offers/project/${encodeURIComponent(j.project_qbo_id)}/outside`, { method: "POST", body: JSON.stringify({ crew_id: Number(f.get("crew")), labor_amount: Number(f.get("amount") || 0) || null, sent_date: f.get("sent"), accepted_date: f.get("accepted") || null }) });
          toast(r.assign_error ? `Recorded. Couldn't put the crew on the schedule: ${r.assign_error}` : "Offer recorded.");
          await reloadJob(j.key); loadOffers(D?.j || j, el); remountEditor(j);
        } catch (e) { alert(`Couldn't record it: ${e?.message || e}`); }
      });
    }
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
    if (kp) { st.kpi = st.kpi === kp.dataset.kpi ? null : kp.dataset.kpi; st.view = "all"; st.open = false; fitSel(); render(); return; }
    if (e.target.closest("[data-clearkpi]")) { st.kpi = null; render(!fitSel()); return; }
    if (e.target.closest("#suB151")) { if (!b151.busy) refreshB151(); return; }
    const v = e.target.closest("[data-view]");
    if (v && root.contains(v) && !v.closest("#suDetail")) {
      st.view = v.dataset.view; st.kpi = null; st.open = false; remember();
      if ((st.view === "all") !== (st.scope === "all")) { root.querySelector("#suList").innerHTML = `<div class="p-4 text-sm text-black/45">Loading…</div>`; load(); } else { fitSel(); render(); }
      return;
    }
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
    if (e.target.id === "suPm") { st.pm = e.target.value; if (fitSel()) renderDetail(); refreshList(); }
  });

  load();
}
