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
// Steps the data can answer complete themselves; the rest are marked here
// (backend/app/setup/routes.py).
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import { openDocViewer, DOC_ICON } from "../utils/doc-viewer.js";
import { openProjectDrawer } from "../utils/project-drawer.js";
import { mountAssignmentPanel } from "./assignment-panel.js";
import { mountBillingPanel } from "./billing.js";

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
  const st = { jobs: [], view: VIEWS.some(([k]) => k === saved.view) ? saved.view : "all", q: "", pm: "", sel: saved.sel || null, open: false, cache: {} };
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
      if (st.view === "action" && !needsAction(j)) return false;
      if (["QuickBooks", "Assignment", "Schedules"].includes(st.view) && !openIn(j, st.view)) return false;
      if (st.pm && !(j.pms || []).includes(st.pm)) return false;
      if (q && !`${j.project_name || ""} ${j.title || ""} ${j.quote_number || ""} ${j.dealer || ""} ${j.customer || ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function kpis() {
    const n = (f) => st.jobs.filter(f).length;
    const tile = (label, value, caption, tone, view) => `<button type="button" class="card p-4 text-left su-kpi" data-view="${view}">
        <div class="text-[10px] uppercase tracking-wide font-bold text-black/45">${label}</div>
        <div class="text-2xl font-extrabold tabular-nums ${tone}">${value}</div>
        <div class="text-xs text-black/50">${caption}</div></button>`;
    return `<div class="su-kpis">
      ${tile("Not in QuickBooks", n((j) => stepOf(j, "qbo_project").state !== "done"), "Won, project still to create", n((j) => stepOf(j, "qbo_project").state !== "done") ? "text-rose-700" : "", "QuickBooks")}
      ${tile("First invoice to send", n((j) => stepOf(j, "first_invoice").state === "todo"), "In QuickBooks, nothing invoiced", "", "QuickBooks")}
      ${tile("Starting soon with gaps", n((j) => j.flags.some((f) => f.text.startsWith("Starts in"))), "Within 14 days, no PM, crew or dates", n((j) => j.flags.some((f) => f.text.startsWith("Starts in"))) ? "text-rose-700" : "", "action")}
      ${tile("Crew offers waiting", n((j) => stepOf(j, "crew").state === "waiting"), "Sent, no answer yet", "", "Assignment")}
      ${tile("Schedules to review", n((j) => openIn(j, "Schedules")), "Dates set, schedules not confirmed", "", "Schedules")}
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
  async function renderDetail() {
    const box = document.getElementById("suDetail");
    const j = st.jobs.find((x) => x.key === st.sel);
    if (!box) return;
    if (!j) { box.innerHTML = `<div class="card p-6 text-sm text-black/50">Pick a job on the left.</div>`; return; }
    const stages = ["QuickBooks", "Assignment", "Schedules"];
    const stepRow = (s) => `<a href="#su-${s.stage}" class="su-step" data-jump="${s.stage}">${ICON[s.state] || ICON.todo}<span>${escapeHtml(s.label)}</span></a>`;
    box.innerHTML = `
      <button type="button" class="su-back" data-back>← All jobs</button>
      <section class="card p-4">
        <div class="flex flex-wrap items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-lg font-extrabold leading-tight">${escapeHtml(j.project_name || j.title)}</div>
            <div class="text-xs text-black/55 mt-0.5">${escapeHtml([j.title !== j.project_name ? j.title : null, j.dealer ? `Dealer: ${j.dealer}` : null, `Quote #${j.quote_number}`, j.won ? `Won ${day(j.won)}` : null, j.pipeline_status].filter(Boolean).join(" · "))}</div>
          </div>
          <div class="text-right"><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">Order value</div><div class="font-extrabold tabular-nums">${money0(j.value)}</div></div>
        </div>
        <div class="flex flex-wrap gap-2 mt-3">
          ${j.project_qbo_id ? `<button class="pd-btn" data-act="workspace">Open project workspace</button>` : ""}
          <a class="pd-btn" href="#/pipeline">Pipeline</a>
          ${j.flags.map((f) => chip(f.text, C[f.tone])).join(" ")}
        </div>
        <div class="su-stages mt-3">${stages.map((sg) => {
          const ss = j.steps.filter((s) => s.stage === sg);
          const done = ss.filter((s) => s.state === "done" || s.state === "not_needed").length;
          return `<div class="su-stage"><div class="flex items-center justify-between"><div class="text-[11px] uppercase tracking-wide font-bold text-black/50">${sg}</div><div class="text-[11px] font-bold tabular-nums text-black/45">${done}/${ss.length}</div></div><div class="grid gap-1 mt-1.5">${ss.map(stepRow).join("")}</div></div>`;
        }).join("")}</div>
      </section>
      <section class="card p-4" id="su-Docs"><h3 class="su-h">Documents to work from</h3><div data-docs class="text-sm text-black/45 mt-2">Loading…</div></section>
      <section class="card p-4" id="su-QuickBooks"></section>
      <section class="card p-4" id="su-Assignment"></section>
      <section class="card p-4" id="su-Schedules"></section>`;
    box.querySelector("[data-back]")?.addEventListener("click", () => {
      st.open = false;
      root.classList.remove("su-open");
      document.querySelector(`.su-job[data-key="${CSS.escape(j.key)}"]`)?.scrollIntoView({ block: "center" });
    });
    box.querySelector("[data-act=workspace]")?.addEventListener("click", () =>
      openProjectDrawer({ entityId: j.project_qbo_id, name: j.project_name, onChange: () => reloadJob(j.key), backLabel: "Project Setup", backHash: "#/setup" }));
    box.querySelectorAll("[data-jump]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById(`su-${a.dataset.jump}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    renderDocs(j);
    renderQuickBooks(j);
    renderAssignment(j);
    renderSchedules(j);
  }

  async function reloadJob(key) {
    try {
      const row = await api(`/setup/job/${encodeURIComponent(key)}`);
      const i = st.jobs.findIndex((x) => x.key === key);
      if (i >= 0) st.jobs[i] = row;
      refreshList();
      if (st.sel === key) {
        // refresh the step lists only, so the embedded editors keep their state
        const head = document.querySelector("#suDetail > section");
        if (head) renderHeaderOnly(row, head);
        for (const sg of ["QuickBooks", "Assignment", "Schedules"]) updateStepRows(row, sg);
      }
    } catch (_) { /* the next full load catches up */ }
  }

  function renderHeaderOnly(j, head) {
    head.querySelectorAll(".su-stage").forEach((el, i) => {
      const sg = ["QuickBooks", "Assignment", "Schedules"][i];
      const ss = j.steps.filter((s) => s.stage === sg);
      const done = ss.filter((s) => s.state === "done" || s.state === "not_needed").length;
      el.querySelector(".tabular-nums").textContent = `${done}/${ss.length}`;
      el.querySelector(".grid").innerHTML = ss.map((s) => `<a href="#su-${s.stage}" class="su-step" data-jump="${s.stage}">${ICON[s.state] || ICON.todo}<span>${escapeHtml(s.label)}</span></a>`).join("");
      el.querySelectorAll("[data-jump]").forEach((a) => a.addEventListener("click", (e) => {
        e.preventDefault();
        document.getElementById(`su-${a.dataset.jump}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }));
    });
  }

  // A step line inside a section: icon, label, detail, and the buttons that fit it.
  function stepLine(j, s, extra = "") {
    const btns = [];
    if (s.mark) btns.push(`<button class="pd-btn" data-mark="${s.key}" data-status="">Undo</button>`);
    else if (MANUAL[s.key] && s.state === "todo") btns.push(`<button class="pd-btn" data-mark="${s.key}" data-status="${s.key === "details" ? "done" : "confirmed"}">${MANUAL[s.key]}</button>`);
    else if (s.state === "todo" && ["first_invoice", "po"].includes(s.key)) {
      btns.push(`<button class="pd-btn" data-mark="${s.key}" data-status="done" title="Done outside what the app can see">Mark done</button>`);
      if (s.key === "first_invoice") btns.push(`<button class="pd-btn" data-mark="${s.key}" data-status="not_needed">Not needed</button>`);
    }
    return `<div class="su-line" data-step="${s.key}">
      <div class="flex items-start gap-2">${ICON[s.state] || ICON.todo}
        <div class="min-w-0 flex-1"><div class="text-sm font-semibold">${escapeHtml(s.label)} ${chip(STATE[s.state]?.[0] || s.state, STATE[s.state]?.[1] || C.quiet)}</div>
          ${s.detail ? `<div class="text-xs text-black/55 mt-0.5">${escapeHtml(s.detail)}</div>` : ""}${extra}</div>
        <div class="flex gap-1.5 shrink-0">${btns.join("")}</div>
      </div></div>`;
  }

  function updateStepRows(j, sg) {
    const sec = document.getElementById(`su-${sg}`);
    if (!sec) return;
    sec.querySelectorAll(".su-line[data-step]").forEach((el) => {
      const s = j.steps.find((x) => x.key === el.dataset.step);
      if (s) { const tmp = document.createElement("div"); tmp.innerHTML = stepLine(j, s); el.replaceWith(tmp.firstElementChild); }
    });
    wireMarks(j, sec);
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

  // ── Documents ───────────────────────────────────────────────────────────
  async function renderDocs(j) {
    const el = document.querySelector("#su-Docs [data-docs]");
    let files = {};
    try {
      const d = j.project_qbo_id ? await api(`/documents/project/${encodeURIComponent(j.project_qbo_id)}`) : await api(`/documents/opportunity/${j.opportunity_id}`);
      files = d.files || {};
    } catch (e) { el.textContent = `Couldn't load documents: ${e?.message || e}`; return; }
    const pick = (k) => (files[k] || []).filter((f) => !f.link_only);
    const group = (label, list, empty) => `<div><div class="text-[10px] uppercase tracking-wide font-bold text-black/45 mb-1">${label}</div>
      ${list.length ? list.slice(0, 6).map((f) => `<button class="pd-btn su-doc" data-doc="${f.id}" data-fn="${escapeHtml(f.filename)}" title="${escapeHtml(f.filename)}">${DOC_ICON}<span class="truncate">${escapeHtml(f.filename)}</span></button>`).join("") : `<div class="text-xs text-black/45">${empty}</div>`}</div>`;
    const wb = (j.workbook_url || "").match(/\/d\/([\w-]+)/)?.[1];
    el.className = "su-docs mt-2";
    el.innerHTML = group("Purchase order", pick("5_purchase_orders"), "No PO in Drive yet (5 Purchase Orders).")
      + group("Estimator's quote", pick("4_quotes"), "No quote PDF (4 Quotes).")
      + `<div><div class="text-[10px] uppercase tracking-wide font-bold text-black/45 mb-1">Quoting metrics</div>
          ${wb ? `<button class="pd-btn" data-sheet="${wb}">${DOC_ICON}<span>Roll-up sheet</span></button> <a class="pd-btn" href="${escapeHtml(j.workbook_url)}" target="_blank" rel="noopener">Open in Google Sheets</a>` : `<div class="text-xs text-black/45">No workbook linked on the pipeline row.</div>`}
          <div class="text-xs text-black/55 mt-1.5">${escapeHtml([j.labor_days ? `${j.labor_days} labor days` : null, j.travel_days ? `${j.travel_days} travel days` : null, j.target_start ? `target ${day(j.target_start)} to ${day(j.target_end)}` : null].filter(Boolean).join(" · "))}</div></div>`;
    el.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => openDocViewer({ id: Number(b.dataset.doc), filename: b.dataset.fn })));
    el.querySelector("[data-sheet]")?.addEventListener("click", (e) => openDocViewer({ drive: e.currentTarget.dataset.sheet, sheet: "0. ROLL UP Quoting Metrics", filename: "Quoting metrics" }));
  }

  // ── QuickBooks ──────────────────────────────────────────────────────────
  function renderQuickBooks(j) {
    const sec = document.getElementById("su-QuickBooks");
    const s = (k) => stepOf(j, k);
    const link = j.project_qbo_id ? "" : `<div class="su-sub mt-2"><h4 class="font-bold text-sm">Already in QuickBooks?</h4>
        <div class="text-xs text-black/55 mt-0.5">If the project exists (or this is added scope on a running job), link it. The nightly sync links new projects by their number on its own.</div>
        ${j.same_site ? `<div class="flex flex-wrap items-center gap-2 mt-2"><span class="text-sm">Same site: <b>${escapeHtml(j.same_site.name)}</b></span><button class="pd-btn" data-link="${escapeHtml(j.same_site.qbo_id)}">Link to this project</button></div>` : ""}
        <div class="flex flex-wrap gap-2 mt-2"><input data-findproj class="input text-sm" style="max-width:280px" placeholder="Search QuickBooks projects"><div data-projhits class="flex flex-wrap gap-1.5"></div></div></div>`;
    sec.innerHTML = `<h3 class="su-h">QuickBooks</h3>
      <div class="grid gap-2 mt-2">${["po", "qbo_project", "qbo_estimate", "first_invoice"].map((k) => stepLine(j, s(k))).join("")}</div>${link}
      <div class="su-sub mt-3"><div class="flex flex-wrap items-center gap-2"><h4 class="font-bold text-sm flex-1">Draft of the project's first estimate</h4>
        <button class="pd-btn" disabled title="Pushing to QuickBooks needs write access to be switched on. For now, copy the lines in.">Send to QuickBooks (coming)</button></div>
        <div data-draft class="text-sm text-black/45 mt-2">Drafting from the estimator's estimate and the PO…</div></div>`;
    wireMarks(j, sec);
    loadDraft(j, sec.querySelector("[data-draft]"));
    const linkTo = async (qboId, name) => {
      if (!confirm(`Link "${j.title}" to ${name}?`)) return;
      try {
        await api(`/opportunities/${j.opportunity_id}`, { method: "PATCH", body: JSON.stringify({ project_qbo_id: String(qboId) }) });
        st.sel = String(qboId); remember(); delete st.cache[`draft:${j.key}`];
        await load();
      } catch (e) { alert(`Couldn't link: ${e?.message || e}`); }
    };
    sec.querySelector("[data-link]")?.addEventListener("click", (e) => linkTo(e.currentTarget.dataset.link, j.same_site.name));
    const find = sec.querySelector("[data-findproj]");
    let t;
    find?.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const hits = sec.querySelector("[data-projhits]");
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

  async function loadDraft(j, el) {
    let d = st.cache[`draft:${j.key}`];
    if (!d) {
      try { d = st.cache[`draft:${j.key}`] = await api(`/setup/job/${encodeURIComponent(j.key)}/estimate-draft`); }
      catch (e) { el.textContent = `Couldn't draft the estimate: ${e?.message || e}`; return; }
    }
    if (!d.groups) {
      el.innerHTML = `${(d.warnings || []).map((w) => `<div class="text-xs text-amber-800">${escapeHtml(w)}</div>`).join("")}`;
      return;
    }
    const copyBtn = (v, label = "Copy") => `<button class="su-copy" data-copy="${escapeHtml(String(v))}" title="Copy ${escapeHtml(String(v))}">${label}</button>`;
    const site = (j.project_name || "").split(" - ").slice(1).join(" - ");
    const steps = [
      j.project_qbo_id ? null : `In QuickBooks, add a project under <b>${escapeHtml(d.source?.customer || j.dealer || "the dealer")}</b> named <b>${escapeHtml(`${j.quote_number} - ${site || j.title}`)}</b>.`,
      `Copy estimate <b>#${escapeHtml(d.source?.doc_number || j.quote_number)}</b> onto the project with the PO line at the top and the line amounts below (OH&amp;P spread into the other lines).`,
      d.first_invoice?.amount ? `Send the first invoice: <b>${d.first_invoice.percent}% = ${money2(d.first_invoice.amount)}</b> (per the payment terms).` : null,
    ].filter(Boolean);
    el.className = "mt-2";
    el.innerHTML = `
      ${(d.warnings || []).map((w) => `<div class="su-warn">${escapeHtml(w)}</div>`).join("")}
      <ol class="su-howto">${steps.map((x) => `<li>${x}</li>`).join("")}</ol>
      <div class="grid gap-1 text-xs mt-2">
        <div class="flex flex-wrap gap-x-6 gap-y-1"><span><span class="text-black/45">From:</span> estimate #${escapeHtml(d.source?.doc_number || "")} on ${escapeHtml(d.source?.customer || "")} (${escapeHtml(d.source?.status || "")}, ${money2(d.source?.total)})</span>
          ${d.po ? `<span><span class="text-black/45">PO:</span> ${escapeHtml(d.po.po_number || "number not read")} · ${d.po.total != null ? money2(d.po.total) : "total not read"}</span>` : ""}</div>
      </div>
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
      ${d.terms ? `<div class="text-xs text-black/55 mt-2"><span class="font-semibold text-black/70">Payment terms:</span> ${escapeHtml(d.terms.replace(/\s+/g, " ").slice(0, 220))}</div>` : ""}
      ${d.po?.snippet ? `<details class="mt-2"><summary class="text-xs font-semibold text-black/60 cursor-pointer">What the app read from the PO</summary><pre class="su-snippet">${escapeHtml(d.po.snippet)}</pre></details>` : ""}`;
    el.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); const t = b.textContent; b.textContent = "Copied"; setTimeout(() => { b.textContent = t; }, 1200); }
      catch (_) { alert(b.dataset.copy); }
    }));
  }

  // ── Assignment ──────────────────────────────────────────────────────────
  function renderAssignment(j) {
    const sec = document.getElementById("su-Assignment");
    const s = (k) => stepOf(j, k);
    if (!j.project_qbo_id) {
      sec.innerHTML = `<h3 class="su-h">Assignment</h3><div class="text-sm text-black/50 mt-2">Opens once the project exists in QuickBooks and the nightly sync brings it in (or a QuickBooks sync runs). The PM, crew and dates are saved on the project.</div>`;
      return;
    }
    sec.innerHTML = `<h3 class="su-h">Assignment</h3>
      <div class="grid gap-2 mt-2">${["pm", "crew", "dates", "details"].map((k) => stepLine(j, s(k))).join("")}</div>
      <div class="su-cols mt-3">
        <div class="su-sub"><h4 class="font-bold text-sm">PM workload</h4><div data-pms class="text-xs text-black/45 mt-1.5">Loading…</div></div>
        <div class="su-sub"><h4 class="font-bold text-sm">Crew availability${j.start ? ` · ${day(j.start)} to ${day(j.end)}` : ""}</h4><div data-avail class="text-xs text-black/45 mt-1.5">${j.start ? "Loading…" : "Set the dates below to see which crews are free."}</div></div>
      </div>
      <div class="su-sub mt-3"><h4 class="font-bold text-sm">Crew offer</h4><div data-offers class="text-xs text-black/45 mt-1.5">Loading…</div></div>
      <div class="su-sub mt-3"><div class="flex items-center gap-2"><h4 class="font-bold text-sm flex-1">PM, crew, dates and job details</h4><span class="text-xs text-black/45">Same editor as the Assignments page</span></div><div data-assign class="mt-2 su-embed"></div></div>`;
    wireMarks(j, sec);
    loadPmWorkload(j, sec.querySelector("[data-pms]"));
    if (j.start) loadAvailability(j, sec.querySelector("[data-avail]"));
    loadOffers(j, sec.querySelector("[data-offers]"));
    mountAssignmentPanel(sec.querySelector("[data-assign]"), j.project_internal_id, () => {
      clearTimeout(st.assignTimer);
      st.assignTimer = setTimeout(async () => {
        await reloadJob(j.key);
        const fresh = st.jobs.find((x) => x.key === j.key);
        if (fresh && (fresh.start !== j.start || fresh.end !== j.end)) { renderSchedules(fresh); if (fresh.start) loadAvailability(fresh, sec.querySelector("[data-avail]")); }
      }, 600);
    });
  }

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
      return { p, now: now.length, next, overlap };
    }).sort((a, b) => (a.overlap.length - b.overlap.length) || (a.now - b.now));
    el.className = "overflow-x-auto mt-1.5";
    el.innerHTML = `<table class="w-full text-xs su-table"><thead><tr><th class="text-left">PM</th><th class="text-right">Running now</th><th class="text-right">Coming up</th><th class="text-left">${s ? "Busy during this job" : "During this job"}</th></tr></thead>
      <tbody>${rows.map(({ p, now, next, overlap }) => `<tr${(j.pms || []).includes(p.name) ? ' class="su-mine"' : ""}><td class="font-semibold">${escapeHtml(p.name)}${(j.pms || []).includes(p.name) ? " (assigned)" : ""}</td>
        <td class="text-right tabular-nums">${now}</td><td class="text-right tabular-nums">${next}</td>
        <td>${s ? (overlap.length ? `<span title="${escapeHtml(overlap.map((i) => `${i.name}: ${i.start} to ${i.end}`).join("\n"))}">${overlap.length} job${overlap.length > 1 ? "s" : ""}</span>` : chip("Free", C.good)) : '<span class="text-black/40">Set dates first</span>'}</td></tr>`).join("")}</tbody></table>`;
  }

  async function loadAvailability(j, el) {
    if (!el) return;
    el.textContent = "Loading…";
    let d;
    try { d = await api(`/offers/crew-availability?start=${j.start}&end=${j.end}`); }
    catch (e) { el.textContent = `Couldn't load availability: ${e?.message || e}`; return; }
    const rows = [...d.companies].sort((a, b) => b.min_free_weekdays - a.min_free_weekdays);
    el.className = "overflow-x-auto mt-1.5";
    el.innerHTML = `<table class="w-full text-xs su-table"><thead><tr><th class="text-left">Crew company</th><th class="text-left">Boss</th><th class="text-right">Free the whole time</th><th class="text-left">Booked on</th></tr></thead>
      <tbody>${rows.map((c) => `<tr><td class="font-semibold">${escapeHtml(c.name)}</td><td>${escapeHtml(c.boss_name || "")}</td>
        <td class="text-right">${chip(`${c.min_free_weekdays} of ${c.capacity}`, c.min_free_weekdays > 0 ? C.good : C.bad)}</td>
        <td class="text-black/55 su-avail-booked" title="${escapeHtml([...new Set((c.bookings || []).map((b) => b.project))].filter((p) => p).join("; "))}">${escapeHtml([...new Set((c.bookings || []).map((b) => b.project))].filter((p) => p).slice(0, 2).join("; "))}${(c.time_off || []).length ? ` ${chip("time off", C.warn)}` : ""}</td></tr>`).join("")}</tbody></table>`;
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
      ${d.accepted ? "" : `<form data-new class="grid gap-2 mt-3 su-offer">
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
      try { await api(`/offers/${b.dataset.resp}/respond`, { method: "POST", body: JSON.stringify({ status: b.dataset.st }) }); await reloadJob(j.key); loadOffers(j, el); reloadAssignEditor(j); }
      catch (e) { b.disabled = false; alert(`Couldn't save: ${e?.message || e}`); }
    }));
    el.querySelectorAll("[data-wd]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Withdraw this offer?")) return;
      try { await api(`/offers/${b.dataset.wd}/withdraw`, { method: "POST" }); await reloadJob(j.key); loadOffers(j, el); }
      catch (e) { alert(`Couldn't withdraw: ${e?.message || e}`); }
    }));
    const form = el.querySelector("[data-new]");
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

  function reloadAssignEditor(j) {
    const box = document.querySelector("#su-Assignment [data-assign]");
    if (box) { box.innerHTML = ""; mountAssignmentPanel(box, j.project_internal_id, () => reloadJob(j.key)); }
  }

  // ── Schedules ───────────────────────────────────────────────────────────
  function renderSchedules(j) {
    const sec = document.getElementById("su-Schedules");
    if (!sec) return;
    const s = (k) => stepOf(j, k);
    const ready = !!(j.project_qbo_id && j.start);
    sec.innerHTML = `<h3 class="su-h">Schedules</h3>
      <div class="text-xs text-black/55 mt-1">Built by the app from the estimates and the job's dates: invoices on 35/35/30 terms, crew pay from the estimates' contract labor on payroll Fridays, and expenses by category on the usual timing (Assumptions page). Review each one below and confirm it.</div>
      <div class="grid gap-2 mt-2">${["invoice_schedule", "crew_schedule", "expense_schedule"].map((k) => stepLine(j, s(k))).join("")}</div>
      ${ready ? `<div class="su-sub mt-3"><div class="flex items-center gap-2"><h4 class="font-bold text-sm flex-1">Invoice, crew pay and expense schedules</h4><button class="pd-btn" data-showbill>Show schedules</button></div><div data-bill class="mt-2 su-embed"></div></div>`
        : `<div class="text-sm text-black/50 mt-3">${j.project_qbo_id ? "Set the start and end dates first. The schedules are built from them." : "Opens once the project is in QuickBooks and has dates."}</div>`}`;
    wireMarks(j, sec);
    sec.querySelector("[data-showbill]")?.addEventListener("click", (e) => {
      const box = sec.querySelector("[data-bill]");
      if (box.dataset.on) { box.innerHTML = ""; delete box.dataset.on; e.target.textContent = "Show schedules"; return; }
      box.dataset.on = "1"; e.target.textContent = "Hide schedules";
      mountBillingPanel(box, j.project_qbo_id);
    });
  }

  // ── Events ──────────────────────────────────────────────────────────────
  root.addEventListener("click", (e) => {
    const v = e.target.closest("[data-view]");
    if (v && root.contains(v) && !v.closest("#suDetail")) { st.view = v.dataset.view; st.open = false; remember(); render(); return; }
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
