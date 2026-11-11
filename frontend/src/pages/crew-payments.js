// Contractor Payments: the one home for crew pay. The plan comes from the Payment
// Schedules in Drive, the actuals from QuickBooks, and every inconsistency between
// them is listed here with the decision it needs.
//
//   Needs a decision   every issue, grouped by type, with who decided what
//   By job             schedule, paid and remaining per job and crew
//   Pay runs           upcoming payments by date, to approve or hold
//   By crew            totals per crew company
//   Crew forms         what's on file for every job, and a viewer for it
//
// Crews are paid in lump runs covering several jobs, so everything compares
// paid-to-date per job and crew, not row by row.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { fmtMoney } from "../utils/format.js";
import { escapeHtml } from "../utils/html.js";
import { openDocViewer } from "../utils/doc-viewer.js";
import { openFinancialExport } from "../utils/financial-export.js";
import { openProjectDrawer } from "../utils/project-drawer.js";

const money0 = (n) => `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n || 0)).toLocaleString()}`;
const money = (n) => (n == null ? "—" : money0(n));
const day = (s) => s ? new Date(`${s.slice(0, 10)}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" }) : "—";
const chip = (txt, cls, title = "") => `<span class="inline-flex items-center text-[10px] font-bold rounded px-1.5 py-0.5 border whitespace-nowrap ${cls}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(txt)}</span>`;
const C = {
  bad: "text-rose-700 bg-rose-50 border-rose-200",
  warn: "text-amber-700 bg-amber-50 border-amber-200",
  good: "text-emerald-700 bg-emerald-50 border-emerald-200",
  info: "text-sky-700 bg-sky-50 border-sky-200",
  quiet: "text-slate-600 bg-slate-100 border-black/10",
};
const SEV = { 1: "#be123c", 2: "#b45309", 3: "#64748b" };
const OPEN = ["hold", "update_schedule", "still_owed", "create_schedule", "record_in_qbo", "fix_sheet", "fix_setup", "tag_in_qbo", "not_recorded", "get_form", "move_in_qbo"];
const isOpen = (i) => !i.decision || i.changed || OPEN.includes(i.decision.status);
const TABS = [["issues", "Needs a decision"], ["jobs", "By job"], ["runs", "Pay runs"], ["crews", "By crew"], ["forms", "Crew forms"]];

export async function crewPaymentsPage(routeFn) {
  const st = { tab: "issues", data: null, q: "", pm: "", crew: "", show: "open", openType: new Set(), editing: null, sort: "job", formView: "any", formScope: "recent" };
  setShell({
    title: "Contractor Payments",
    subtitle: "What each crew should be paid, what QuickBooks shows paid, and every difference that needs a decision.",
    bodyHtml: `<div id="cpRoot"><div class="card p-6 text-sm text-black/45">Loading crew payments…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("cpRoot");

  async function load(fresh = false) {
    try {
      st.data = await api(`/crew-payments${fresh ? "?fresh=true" : ""}`);
      if (!st.openType.size && st.data.issues.length) st.openType.add(st.data.issues[0].type);
      render();
      if (st.data.snapshot?.refreshing) setTimeout(() => load(), 8000);
    } catch (e) {
      root.innerHTML = `<div class="card p-6 text-sm text-red-700">Couldn't load crew payments: ${escapeHtml(e?.message || String(e))}</div>`;
    }
  }

  const match = (o) => {
    if (st.pm && (o.pm || "") !== st.pm) return false;
    if (st.crew && !(o.crew || "").includes(st.crew)) return false;
    if (st.q && !`${o.job || ""} ${o.crew || ""} ${o.pm || ""} ${o.detail || ""}`.toLowerCase().includes(st.q.toLowerCase())) return false;
    return true;
  };

  function tiles() {
    const s = st.data.summary;
    const t = (label, value, note, tone = "") => `<div class="card p-4"><div class="text-[11px] uppercase tracking-wide text-black/45 font-bold">${escapeHtml(label)}</div>
      <div class="text-2xl font-extrabold tabular-nums mt-1 ${tone}">${value}</div><div class="text-xs text-black/50 mt-0.5">${note}</div></div>`;
    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px">
      ${t("Waiting on a decision", s.open.toLocaleString(), "items still open")}
      ${t("Paid more than the schedule", money0(s.paid_over), `${s.paid_over_jobs} jobs. Leads to check, not proven overpayments.`, "text-rose-700")}
      ${t("Labor over the estimate", money0(s.labor_over), `${s.labor_over_jobs} jobs over by more than ${Math.round(st.data.rules.over_pct * 100)}%`, "text-rose-700")}
      ${t("Next pay run", s.next_date ? money0(s.next_amount) : "—", s.next_date ? `${day(s.next_date)}${s.held ? ` · ${money0(s.held)} on hold` : ""}` : "Nothing scheduled")}
    </div>`;
  }

  function filters() {
    const d = st.data;
    const pms = [...new Set(d.rows.map((r) => r.pm).filter(Boolean))].sort();
    const crews = [...new Set(d.crews.map((c) => c.crew))].sort();
    const sel = (id, all, items, v) => `<select id="${id}" class="input text-sm" style="width:auto"><option value="">${all}</option>${items.map((x) => `<option${x === v ? " selected" : ""}>${escapeHtml(x)}</option>`).join("")}</select>`;
    return `<div class="flex flex-wrap items-center gap-2">
      <input id="cpQ" class="input text-sm" style="width:220px" placeholder="Search job, crew or detail" value="${escapeHtml(st.q)}">
      ${sel("cpPm", "All PMs", pms, st.pm)}${sel("cpCrew", "All crews", crews, st.crew)}
      ${st.tab === "issues" ? `<select id="cpShow" class="input text-sm" style="width:auto">
        ${[["open", "Open items"], ["decided", "Decided"], ["all", "Everything"]].map(([k, l]) => `<option value="${k}"${st.show === k ? " selected" : ""}>${l}</option>`).join("")}</select>` : ""}
    </div>`;
  }

  // ── issues ────────────────────────────────────────────────────────────────
  function decisionHtml(i) {
    const d = i.decision;
    const opts = st.data.issue_types[i.type]?.decisions || [];
    if (st.editing === i.key) {
      const needsAmount = (s) => s === "co_coming";
      return `<form data-decide="${escapeHtml(i.key)}" class="grid gap-2 bg-sky-50 rounded-lg p-3 mt-2">
        <div class="flex flex-wrap gap-3">
          <label class="text-xs grid gap-1"><span class="text-black/55">Decision</span><select name="status" class="input text-sm">${opts.map(([k, l]) => `<option value="${k}"${d?.status === k ? " selected" : ""}>${escapeHtml(l)}</option>`).join("")}</select></label>
          <label class="text-xs grid gap-1"><span class="text-black/55">Amount, if there is one</span><input name="amount" type="number" step="0.01" class="input text-sm tabular-nums" style="width:130px" value="${d?.amount ?? ""}" title="${needsAmount("co_coming") ? "For a change order coming, the amount expected" : ""}"></label>
        </div>
        <label class="text-xs grid gap-1"><span class="text-black/55">Note</span><input name="note" maxlength="500" class="input text-sm" value="${escapeHtml(d?.note || "")}" placeholder="What was found, who is doing what"></label>
        <div class="flex gap-2"><button class="btn-primary text-xs" type="submit">Save</button>
          ${d ? `<button class="pd-btn" type="button" data-clear="${escapeHtml(i.key)}">Clear decision</button>` : ""}
          <button class="pd-btn" type="button" data-cancel>Cancel</button></div>
      </form>`;
    }
    return "";
  }

  function issueRow(i) {
    const d = i.decision;
    return `<div class="py-3 border-t border-black/[0.06]">
      <div class="flex flex-wrap items-start gap-x-4 gap-y-1">
        <div class="min-w-0" style="flex:1 1 320px">
          <div class="font-semibold text-sm">${i.entity_id ? `<button class="text-left hover:underline" data-job="${escapeHtml(i.entity_id)}" data-name="${escapeHtml(i.job || "")}">${escapeHtml(i.job || "Project")}</button>` : escapeHtml(i.crew || i.label)}</div>
          <div class="text-xs text-black/50">${[i.entity_id ? i.crew : null, i.pm].filter(Boolean).map(escapeHtml).join(" · ")}</div>
          <div class="text-sm text-black/70 mt-1">${escapeHtml(i.detail)}${i.drive_url ? ` <a class="text-sky-700 hover:underline" href="${escapeHtml(i.drive_url)}" target="_blank" rel="noopener">Open in Drive</a>` : ""}</div>
          ${d ? `<div class="text-xs mt-1">${chip(d.label, OPEN.includes(d.status) ? C.warn : C.good)}${i.changed ? ` ${chip("Amount changed since", C.bad, "The number moved after this decision. Check it again.")}` : ""}
            <span class="text-black/50">${escapeHtml(d.by || "")} ${day(d.at)}${d.amount != null ? ` · ${fmtMoney(d.amount)}` : ""}${d.note ? ` · ${escapeHtml(d.note)}` : ""}</span></div>` : ""}
        </div>
        <div class="text-right tabular-nums font-bold text-sm" style="min-width:90px">${i.amount != null ? fmtMoney(Math.abs(i.amount)) : ""}</div>
        <div>${i.type === "no_forms" ? `<button class="pd-btn" data-forms="${escapeHtml(i.entity_id)}" data-name="${escapeHtml(i.job || "")}">View forms</button> ` : ""}<button class="pd-btn" data-edit="${escapeHtml(i.key)}">${d ? "Change" : "Decide"}</button></div>
      </div>${decisionHtml(i)}</div>`;
  }

  function issuesTab() {
    const list = st.data.issues.filter(match).filter((i) => st.show === "all" || (st.show === "open" ? isOpen(i) : !isOpen(i)));
    if (!list.length) return `<div class="card p-6 text-sm text-black/50">Nothing here with these filters.</div>`;
    const groups = new Map();
    for (const i of list) { if (!groups.has(i.type)) groups.set(i.type, []); groups.get(i.type).push(i); }
    return [...groups.entries()].map(([type, items]) => {
      const open = st.openType.has(type) || !!st.q;
      const total = items.reduce((s, i) => s + Math.abs(i.amount || 0), 0);
      return `<section class="card">
        <button class="w-full flex items-center gap-3 p-4 text-left" data-type="${type}" aria-expanded="${open}">
          <span class="inline-block rounded-full" style="width:9px;height:9px;background:${SEV[items[0].severity]}" aria-hidden="true"></span>
          <span class="font-bold text-sm" style="flex:1">${escapeHtml(items[0].label)}</span>
          <span class="text-xs text-black/50 tabular-nums">${items.length} item${items.length === 1 ? "" : "s"}${total ? ` · ${fmtMoney(total)}` : ""}</span>
          <span class="text-black/35" aria-hidden="true">${open ? "▾" : "▸"}</span>
        </button>
        ${open ? `<div class="px-4 pb-2">${items.map(issueRow).join("")}</div>` : ""}
      </section>`;
    }).join("");
  }

  // ── by job ────────────────────────────────────────────────────────────────
  function jobsTab() {
    const rows = st.data.rows.filter(match);
    const SORTS = { job: (a, b) => a.job.localeCompare(b.job), gap: (a, b) => (b.paid - b.schedule) - (a.paid - a.schedule), next: (a, b) => (a.next_date || "9").localeCompare(b.next_date || "9") };
    rows.sort(SORTS[st.sort]);
    const stateChip = (r) => r.state === "finished" ? chip("Finished", C.quiet) : r.state === "active" ? chip("In progress", C.info) : chip("Not started", C.quiet);
    const gap = (r) => {
      if (!r.schedule) return r.paid ? chip("No schedule", C.warn) : "";
      const d = r.paid - r.schedule, tol = Math.max(st.data.rules.tol_abs, st.data.rules.tol_pct * r.schedule);
      if (d > tol) return chip(`${fmtMoney(d)} over`, C.bad);
      if (r.state === "finished" && d < -tol) return chip(`${fmtMoney(-d)} under`, C.warn);
      return r.state === "finished" ? chip("Matches", C.good) : "";
    };
    return `<section class="card p-4"><div class="flex items-center justify-between gap-3 flex-wrap mb-2">
        <div class="text-xs text-black/50">${rows.length} job and crew rows. Jobs ending in the last year, in progress or not started.</div>
        <label class="text-xs text-black/55">Sort <select id="cpSort" class="input text-xs" style="width:auto">${[["job", "Job"], ["gap", "Paid over schedule"], ["next", "Next payment"]].map(([k, l]) => `<option value="${k}"${st.sort === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <div class="overflow-x-auto"><table class="w-full text-sm">
      <thead><tr class="text-[11px] uppercase tracking-wide text-black/45">
        <th class="py-2 pr-3 text-left">Job</th><th class="py-2 pr-3 text-left">Crew</th><th class="py-2 pr-3 text-right">Estimate labor</th><th class="py-2 pr-3 text-right">Pending</th>
        <th class="py-2 pr-3 text-right">Schedule</th><th class="py-2 pr-3 text-right">Paid</th><th class="py-2 pr-3 text-right">Left to pay</th><th class="py-2 pr-3 text-left">Next</th><th class="py-2 text-left"></th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="border-t border-black/[0.06] align-top">
        <td class="py-2 pr-3"><button class="text-left font-semibold hover:underline" data-job="${escapeHtml(r.entity_id)}" data-name="${escapeHtml(r.job)}">${escapeHtml(r.job)}</button>
          <div class="text-[11px] text-black/45 mt-0.5">${stateChip(r)} ${escapeHtml(r.pm || "")}${r.schedules.length > 1 ? ` · ${r.schedules.length} schedules` : ""}${r.lodging ? ` · ${fmtMoney(r.lodging)} is lodging` : ""}</div></td>
        <td class="py-2 pr-3">${escapeHtml(r.crew)}</td>
        <td class="py-2 pr-3 text-right tabular-nums">${money(r.budget)}</td>
        <td class="py-2 pr-3 text-right tabular-nums text-black/55">${r.pending ? fmtMoney(r.pending) : ""}</td>
        <td class="py-2 pr-3 text-right tabular-nums">${money(r.schedule)}</td>
        <td class="py-2 pr-3 text-right tabular-nums font-semibold">${money(r.paid)}<div class="text-[10px] font-normal text-black/40">${r.last_paid ? `last ${day(r.last_paid)}` : ""}</div></td>
        <td class="py-2 pr-3 text-right tabular-nums">${r.state !== "finished" ? money(Math.max(0, r.remaining)) : ""}</td>
        <td class="py-2 pr-3 whitespace-nowrap text-xs">${r.next_date ? `${day(r.next_date)}<div class="text-black/45 tabular-nums">${fmtMoney(r.next_amount)}</div>` : ""}</td>
        <td class="py-2">${gap(r)}</td></tr>`).join("") || `<tr><td colspan="9" class="py-4 text-black/45">No rows with these filters.</td></tr>`}</tbody></table></div></section>`;
  }

  // ── pay runs ──────────────────────────────────────────────────────────────
  function runsTab() {
    const d = st.data, sign = d.can_sign;
    const rows = d.runs.filter(match);
    if (!rows.length) return `<div class="card p-6 text-sm text-black/50">No unpaid crew payments in the next ${6} weeks with these filters.</div>`;
    const dates = [...new Set(rows.map((r) => r.date))];
    const today = new Date().toISOString().slice(0, 10);
    return `${sign ? "" : `<div class="card p-3 text-sm text-black/60">You can see pay runs. Approving or holding a payment needs sign-off access, which an admin can give from Users.</div>`}
      <div class="card p-3 text-xs text-black/55">Approve and Hold are a record for whoever runs payroll. The app doesn't pay crews, so a hold here doesn't stop a payment by itself. If the Drive sheet changes a payment's date or amount, its approval no longer applies.</div>` +
      dates.map((dt) => {
        const g = rows.filter((r) => r.date === dt);
        const total = g.reduce((s, r) => s + r.amount, 0);
        const done = g.filter((r) => r.approval?.decision === "approved").length;
        const held = g.filter((r) => r.approval?.decision === "hold").length;
        return `<section class="card p-4">
          <div class="flex flex-wrap items-center gap-3">
            <div class="font-bold text-sm" style="flex:1">${day(dt)}${dt < today ? ` ${chip("Date passed, no matching payment yet", C.warn)}` : ""}</div>
            <div class="text-xs text-black/55 tabular-nums">${g.length} payment${g.length === 1 ? "" : "s"} · ${fmtMoney(total)} · ${done} approved${held ? ` · ${held} on hold` : ""}</div>
            ${sign ? `<button class="pd-btn" data-approve-all="${dt}">Approve all without a flag</button>` : ""}
          </div>
          <div class="overflow-x-auto mt-2"><table class="w-full text-sm"><tbody>${g.map((r) => {
            const after = r.paid_on_job + r.amount, over = r.budget > 0 && after > r.budget * 1.1;
            const a = r.approval;
            return `<tr class="border-t border-black/[0.06] align-top">
              <td class="py-2 pr-3"><button class="text-left font-semibold hover:underline" data-job="${escapeHtml(r.entity_id)}" data-name="${escapeHtml(r.job)}">${escapeHtml(r.job)}</button>
                <div class="text-[11px] text-black/45">${escapeHtml(r.crew)}${r.note ? ` · ${escapeHtml(r.note)}` : ""}</div></td>
              <td class="py-2 pr-3 text-right tabular-nums font-semibold">${fmtMoney(r.amount)}</td>
              <td class="py-2 pr-3 text-xs text-black/55 whitespace-nowrap">${fmtMoney(r.paid_on_job)} paid so far<div>${r.budget ? `${fmtMoney(r.budget)} budget` : "no estimate labor"}</div></td>
              <td class="py-2 pr-3">${over ? chip("Over budget if paid", C.bad, `Paid so far plus this payment is ${fmtMoney(after)}, more than 10% over the budget of estimate, pending and recorded lodging.`) : ""}${r.approval_lapsed ? chip("Changed since approved", C.warn) : ""}
                ${a ? `<div class="text-[11px] mt-0.5">${chip(a.decision === "hold" ? "On hold" : "Approved", a.decision === "hold" ? C.bad : C.good)} <span class="text-black/45">${escapeHtml(a.by || "")}${a.note ? ` · ${escapeHtml(a.note)}` : ""}</span></div>` : ""}</td>
              <td class="py-2 text-right whitespace-nowrap">${sign ? (a ? `<button class="pd-btn" data-appr="clear" data-id="${r.id}">Undo</button>`
                : `<button class="pd-btn" data-appr="approved" data-id="${r.id}">Approve</button> <button class="pd-btn" data-appr="hold" data-id="${r.id}">Hold</button>`) : ""}</td></tr>`;
          }).join("")}</tbody></table></div></section>`;
      }).join("");
  }

  function crewsTab() {
    const rows = st.data.crews.filter((c) => !st.q || c.crew.toLowerCase().includes(st.q.toLowerCase()));
    return `<section class="card p-4"><div class="overflow-x-auto"><table class="w-full text-sm">
      <thead><tr class="text-[11px] uppercase tracking-wide text-black/45"><th class="py-2 pr-3 text-left">Crew</th><th class="py-2 pr-3 text-right">Jobs</th><th class="py-2 pr-3 text-right">Scheduled</th><th class="py-2 pr-3 text-right">Paid</th><th class="py-2 pr-3 text-right">Paid vs scheduled</th><th class="py-2 text-right">Left on open jobs</th></tr></thead>
      <tbody>${rows.map((c) => `<tr class="border-t border-black/[0.06]">
        <td class="py-2 pr-3 font-semibold"><button class="hover:underline" data-crewfilter="${escapeHtml(c.crew)}">${escapeHtml(c.crew)}</button></td>
        <td class="py-2 pr-3 text-right tabular-nums">${c.jobs}</td><td class="py-2 pr-3 text-right tabular-nums">${fmtMoney(c.schedule)}</td>
        <td class="py-2 pr-3 text-right tabular-nums">${fmtMoney(c.paid)}</td>
        <td class="py-2 pr-3 text-right tabular-nums ${c.paid > c.schedule ? "text-rose-700 font-semibold" : ""}">${fmtMoney(c.paid - c.schedule)}</td>
        <td class="py-2 text-right tabular-nums">${fmtMoney(c.remaining)}</td></tr>`).join("")}</tbody></table></div></section>`;
  }

  // ── crew forms ────────────────────────────────────────────────────────────
  const FORM_VIEWS = [
    ["any", "Missing a form", (f) => f.missing.length],
    ["none", "No forms at all", (f) => f.none && f.missing.length],
    ["completion", "No completion form", (f) => f.missing.includes("completion")],
    ["kickoff", "No kickoff checklist", (f) => f.missing.includes("kickoff")],
    ["daily", "No daily forms", (f) => f.missing.includes("daily")],
    ["all", "Every job", () => true],
  ];

  function formsTab() {
    const base = (st.data.forms || []).filter(match).filter((f) => st.formScope === "all" || f.recent);
    const view = FORM_VIEWS.find(([k]) => k === st.formView);
    const rows = base.filter(view[2]);
    const cell = (n, due) => n ? `<span class="tabular-nums font-semibold">${n}</span>` : due ? chip("Missing", C.warn) : `<span class="text-black/30">—</span>`;
    const states = { finished: chip("Finished", C.quiet), active: chip("In progress", C.info), upcoming: chip("Not started", C.quiet) };
    return `<section class="card p-4">
      <div class="flex flex-wrap items-center gap-2">
        ${FORM_VIEWS.map(([k, l, fn]) => `<button class="pd-btn" data-formview="${k}" aria-pressed="${st.formView === k}"${st.formView === k ? ` style="background:#1c2430;color:#fff;border-color:#1c2430"` : ""}>${l} <span class="tabular-nums" style="opacity:.7">${base.filter(fn).length}</span></button>`).join("")}
        <label class="text-xs text-black/55" style="margin-left:auto;max-width:100%">Show <select id="cpFormScope" class="input text-xs" style="width:auto;max-width:100%">${[["recent", "Last 12 months and open jobs"], ["all", "All projects"]].map(([k, l]) => `<option value="${k}"${st.formScope === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <p class="text-xs text-black/50 mt-2">Numbers are forms on file. Jobs that haven't started need nothing yet, and a completion form is only due once a job finishes. A Word copy of the completion form has blank signature lines, so it counts as an unsigned draft. The date shown is the one written on the form; scans and photos can't be read.</p>
      <div class="overflow-x-auto mt-2"><table class="w-full text-sm">
      <thead><tr class="text-[11px] uppercase tracking-wide text-black/45"><th class="py-2 pr-3 text-left">Job</th><th class="py-2 pr-3 text-left">Crew</th><th class="py-2 pr-3 text-left">Kickoff</th><th class="py-2 pr-3 text-left">Daily</th><th class="py-2 pr-3 text-left">Completion</th><th class="py-2 text-right"></th></tr></thead>
      <tbody>${rows.map((f) => `<tr class="border-t border-black/[0.06] align-top">
        <td class="py-2 pr-3"><button class="text-left font-semibold hover:underline" data-job="${escapeHtml(f.entity_id)}" data-name="${escapeHtml(f.job)}">${escapeHtml(f.job)}</button>
          <div class="text-[11px] text-black/45 mt-0.5">${states[f.state] || ""} ${escapeHtml(f.pm || "")}</div></td>
        <td class="py-2 pr-3">${escapeHtml(f.crew || "—")}</td>
        <td class="py-2 pr-3">${cell(f.kickoff, f.missing.includes("kickoff"))}</td>
        <td class="py-2 pr-3">${cell(f.daily, f.missing.includes("daily"))}</td>
        <td class="py-2 pr-3">${cell(f.completion, f.missing.includes("completion"))}${f.draft ? ` ${chip("Unsigned draft", C.warn, "A Word copy is on file, with blank signature lines.")}` : ""}${f.completed_on ? `<div class="text-[11px] text-black/45">Dated ${day(f.completed_on)}</div>` : ""}</td>
        <td class="py-2 text-right whitespace-nowrap"><button class="pd-btn" data-forms="${escapeHtml(f.entity_id)}" data-name="${escapeHtml(f.job)}">View forms</button></td></tr>`).join("") || `<tr><td colspan="6" class="py-4 text-black/45">No jobs with these filters.</td></tr>`}</tbody></table></div>
    </section>`;
  }

  function render() {
    const d = st.data;
    const counts = { issues: d.summary.open, runs: d.runs.length, forms: (d.forms || []).filter((f) => f.recent && f.missing.length).length };
    root.innerHTML = `<div class="grid gap-4" style="grid-template-columns:minmax(0,1fr)">
      ${tiles()}
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" aria-selected="${st.tab === k}" data-tab="${k}" class="tab">${l}${counts[k] ? ` <span class="tab-n">${counts[k]}</span>` : ""}</button>`).join("")}</div>
        <div class="flex gap-2"><button class="pd-btn" id="cpExport">Export to Excel</button></div>
      </div>
      ${filters()}
      <div class="grid gap-3" id="cpBody" style="grid-template-columns:minmax(0,1fr)">${st.tab === "issues" ? issuesTab() : st.tab === "jobs" ? jobsTab() : st.tab === "runs" ? runsTab() : st.tab === "forms" ? formsTab() : crewsTab()}</div>
      <p class="text-xs text-white/60" style="max-width:52rem">Paid means QuickBooks bills and checks for contract labor tagged to the job. A job and crew match within ${fmtMoney(d.rules.tol_abs)} or ${Math.round(d.rules.tol_pct * 100)}%, the same tolerance the Cash Flow forecast uses. Updated from QuickBooks and Drive nightly.</p>
    </div>`;
    if (st.focus) { const el = document.getElementById(st.focus); if (el) { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); } }
  }

  async function decide(key, status, amount, note) {
    const i = st.data.issues.find((x) => x.key === key);
    await api("/crew-payments/decision", { method: "POST", body: JSON.stringify({ key, entity_id: i?.entity_id || null, status, amount, note, fingerprint: i?.fingerprint || "" }) });
    st.editing = null;
    await load();
  }

  async function approve(ids, decision, note) {
    try {
      await api("/crew-payments/approval", { method: "POST", body: JSON.stringify({ ids, decision, note }) });
      await load();
    } catch (e) { alert(`Couldn't save: ${e?.message || e}`); }
  }

  root.addEventListener("input", (ev) => {
    if (ev.target.id === "cpQ") { st.q = ev.target.value; st.focus = "cpQ"; render(); }
  });
  root.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t.id === "cpPm") st.pm = t.value; else if (t.id === "cpCrew") st.crew = t.value; else if (t.id === "cpShow") st.show = t.value;
    else if (t.id === "cpSort") st.sort = t.value; else if (t.id === "cpFormScope") st.formScope = t.value; else return;
    st.focus = null; render();
  });
  root.addEventListener("submit", async (ev) => {
    const form = ev.target.closest("[data-decide]");
    if (!form) return;
    ev.preventDefault();
    const f = new FormData(form), a = f.get("amount");
    try { await decide(form.dataset.decide, f.get("status"), a === "" ? null : Number(a), f.get("note")); }
    catch (e) { alert(`Couldn't save: ${e?.message || e}`); }
  });
  root.addEventListener("click", async (ev) => {
    const t = ev.target.closest("button");
    if (!t) return;
    st.focus = null;
    if (t.id === "cpExport") { openFinancialExport({ crew: st.crew, pm: st.pm }); return; }
    if (t.dataset.tab) { st.tab = t.dataset.tab; render(); return; }
    if (t.dataset.formview) { st.formView = t.dataset.formview; render(); return; }
    if (t.dataset.forms) { openFormsPanel(t.dataset.forms, t.dataset.name); return; }
    if (t.dataset.type) { const k = t.dataset.type; st.openType.has(k) ? st.openType.delete(k) : st.openType.add(k); render(); return; }
    if (t.dataset.edit) { st.editing = st.editing === t.dataset.edit ? null : t.dataset.edit; render(); return; }
    if (t.hasAttribute("data-cancel")) { st.editing = null; render(); return; }
    if (t.dataset.clear) { await decide(t.dataset.clear, null, null, null); return; }
    if (t.dataset.crewfilter) { st.crew = t.dataset.crewfilter; st.tab = "jobs"; render(); return; }
    if (t.dataset.job) { openJobPanel(t.dataset.job, t.dataset.name, () => load()); return; }
    if (t.dataset.appr) {
      const id = Number(t.dataset.id);
      if (t.dataset.appr === "clear") return approve([id], null, null);
      const note = t.dataset.appr === "hold" ? prompt("Why is this on hold?") : null;
      if (t.dataset.appr === "hold" && !note) return;
      return approve([id], t.dataset.appr, note);
    }
    if (t.dataset.approveAll) {
      const ids = st.data.runs.filter((r) => r.date === t.dataset.approveAll && match(r) && !r.approval
        && !(r.budget > 0 && r.paid_on_job + r.amount > r.budget * 1.1)).map((r) => r.id);
      if (ids.length && confirm(`Approve ${ids.length} payment${ids.length === 1 ? "" : "s"} dated ${day(t.dataset.approveAll)}? Payments flagged over budget are left for you to review.`)) approve(ids, "approved", null);
    }
  });

  await load();
}

// One job's crew forms, listed like a folder. Each opens in the document viewer.
function openFormsPanel(entityId, name) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;inset:0;z-index:65;background:rgba(15,23,33,.35);display:flex;justify-content:flex-end";
  wrap.innerHTML = `<div role="dialog" aria-modal="true" aria-label="Crew forms for ${escapeHtml(name || "project")}" style="background:#f4f6f8;width:min(620px,100vw);height:100%;display:flex;flex-direction:column;box-shadow:-12px 0 32px rgba(0,0,0,.28)">
    <div class="flex items-center gap-2 flex-wrap bg-white border-b border-black/10" style="padding:10px 16px">
      <div style="flex:1;min-width:180px;color:#1c2430"><div class="font-extrabold text-sm">Crew forms</div><div class="text-xs text-black/50">${escapeHtml(name || "Project")}</div></div>
      <span data-folder></span>
      <button class="pd-btn" data-x aria-label="Close">Close</button></div>
    <div data-body class="grid gap-3" style="flex:1;min-height:0;overflow:auto;padding:14px 16px 40px;align-content:start;color:#1c2430"><div class="text-sm text-black/45">Loading…</div></div></div>`;
  document.body.appendChild(wrap);
  const body = wrap.querySelector("[data-body]");
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape" && document.body.lastElementChild === wrap) close(); };
  document.addEventListener("keydown", onKey);
  wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-x]") || e.target.closest("[data-folderlink]")) close(); });

  const answerList = (a) => {
    const items = Object.entries(a && typeof a === "object" ? a : {}).filter(([, v]) => v != null && v !== "" && typeof v !== "object");
    return items.length ? `<div class="text-xs mt-1 grid gap-0.5">${items.map(([k, v]) => `<div><span class="text-black/50">${escapeHtml(k.replace(/_/g, " "))}:</span> ${escapeHtml(String(v))}</div>`).join("")}</div>` : `<div class="text-xs text-black/50 mt-1">No answers recorded.</div>`;
  };
  const item = (f) => {
    const meta = `${f.date ? day(f.date) : ""}${f.draft ? ` ${chip("Unsigned draft", C.warn, "This Word copy has blank signature lines.")}` : ""}`;
    if (f.id) return `<button class="w-full flex items-center gap-3 py-2 text-left hover:bg-slate-100 border-t border-black/[0.06]" data-doc="${f.id}" data-fn="${escapeHtml(f.name)}">
      <span class="text-sm font-semibold min-w-0" style="flex:1;overflow-wrap:anywhere">${escapeHtml(f.name)}</span><span class="text-xs text-black/50 whitespace-nowrap">${meta}</span><span class="text-xs font-semibold text-sky-700">View</span></button>`;
    if (f.kickoff_tab) return `<div class="py-2 text-sm border-t border-black/[0.06]">${escapeHtml(f.name)}</div>`;
    return `<details class="py-2 border-t border-black/[0.06]"><summary class="text-sm font-semibold cursor-pointer">${escapeHtml(f.name)} <span class="text-xs font-normal text-black/50">${meta} · sent from the Crew Portal</span></summary>${answerList(f.answers)}</details>`;
  };

  (async () => {
    let d;
    try { d = await api(`/crew-payments/job/${encodeURIComponent(entityId)}/forms`); }
    catch (e) { body.innerHTML = `<div class="card p-4 text-sm text-red-700">Couldn't load the forms: ${escapeHtml(e?.message || String(e))}</div>`; return; }
    if (d.can_browse) wrap.querySelector("[data-folder]").innerHTML = `<a class="pd-btn" data-folderlink href="#/entity/project/${encodeURIComponent(entityId)}?tab=documents">Open Documents folder</a>`;
    const groups = d.groups.filter((g) => g.files.length || g.key !== "other");
    body.innerHTML = groups.map((g) => `<section class="card p-4">
      <div class="flex items-center justify-between gap-3"><h3 class="font-bold text-sm">${escapeHtml(g.label)}</h3><span class="text-xs text-black/50 tabular-nums">${g.files.length}</span></div>
      ${g.files.length ? `<div class="mt-2">${g.files.map(item).join("")}</div>` : `<div class="text-sm text-black/50 mt-1">Nothing on file.</div>`}</section>`).join("");
  })();
  body.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-doc]");
    if (t) openDocViewer({ id: Number(t.dataset.doc), filename: t.dataset.fn });
  });
}

// One job: every schedule, every crew bill, pending estimates and the change log.
function openJobPanel(entityId, name, onChange) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;inset:0;z-index:60;background:rgba(15,23,33,.35);display:flex;justify-content:flex-end";
  wrap.innerHTML = `<div role="dialog" aria-modal="true" aria-label="Crew payments for ${escapeHtml(name || "project")}" style="background:#f4f6f8;width:min(820px,100vw);height:100%;display:flex;flex-direction:column;box-shadow:-12px 0 32px rgba(0,0,0,.28)">
    <div class="flex items-center gap-2 flex-wrap bg-white border-b border-black/10" style="padding:10px 16px">
      <div class="font-extrabold text-sm" style="flex:1;min-width:180px;color:#1c2430">${escapeHtml(name || "Project")}</div>
      <button class="pd-btn" data-forms>Crew forms</button>
      <button class="pd-btn" data-billing>Open Billing &amp; Schedule</button>
      <button class="pd-btn" data-x aria-label="Close">Close</button></div>
    <div data-body class="grid gap-3" style="flex:1;min-height:0;overflow:auto;padding:14px 16px 40px;align-content:start;color:#1c2430"><div class="text-sm text-black/45">Loading…</div></div></div>`;
  document.body.appendChild(wrap);
  const body = wrap.querySelector("[data-body]");
  let dirty = false;
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); if (dirty) onChange?.(); };
  const onKey = (e) => { if (e.key === "Escape" && document.body.lastElementChild === wrap) close(); };
  document.addEventListener("keydown", onKey);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.querySelector("[data-x]").addEventListener("click", close);
  wrap.querySelector("[data-forms]").addEventListener("click", () => openFormsPanel(entityId, name));
  wrap.querySelector("[data-billing]").addEventListener("click", () => openProjectDrawer({ entityId, name, onChange: () => { dirty = true; load(); }, backLabel: "Contractor Payments", backHash: "#/crew-payments" }));

  const ACTION = { "crew_payment.update": "Changed a payment", "crew_payment.add": "Added a payment", "crew_payment.delete": "Removed a payment", "crew_payment.approved": "Approved", "crew_payment.hold": "Put on hold", "crew_payment.approval_cleared": "Cleared approval", "crew_schedule.lodging": "Set lodging included", "crew_schedule.crew": "Changed the crew", "crew_schedule.generate": "Built a schedule", "crew_schedule.delete": "Removed a schedule", "crew_review.decision": "Recorded a decision" };
  const logDetail = (l) => {
    const ch = l.detail?.changes;
    if (ch) return Object.entries(ch).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v[0] ?? "blank"} to ${v[1] ?? "blank"}`).join("; ");
    return l.detail?.note || "";
  };

  async function load() {
    let d;
    try { d = await api(`/crew-payments/job/${encodeURIComponent(entityId)}`); }
    catch (e) { body.innerHTML = `<div class="card p-4 text-sm text-red-700">Couldn't load this job: ${escapeHtml(e?.message || String(e))}</div>`; return; }
    const j = d.job || { est: {}, act: {}, pend: {} };
    const lab = j.est?.["Crew labor"] || 0, pend = j.pend?.["Crew labor"] || 0, paid = d.bills.reduce((s, b) => s + b.amount, 0);
    const sched = d.schedules.reduce((s, x) => s + x.total, 0), lod = d.schedules.reduce((s, x) => s + x.lodging, 0);
    const owed = d.schedules.reduce((t, s) => t + s.rows.reduce((u, r) => u + (r.status === "paid" || r.covered ? 0 : r.amount), 0), 0);
    const stat = (l, v) => `<div><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">${l}</div><div class="font-extrabold tabular-nums">${money0(v)}</div></div>`;
    const status = (r) => r.status === "paid" ? chip(r.paid_source === "sheet" ? "Marked paid on sheet" : "Paid", r.paid_source === "sheet" ? C.warn : C.good)
      : r.covered ? `<span title="QuickBooks bills from this crew on this job already add up past this row. Bills rarely match the sheet's rows one for one, so the app pays rows off in date order.">${chip("Covered by payments", C.good)}</span>`
      : chip("Scheduled", C.quiet);
    // change-order labor the app added (not on any Drive sheet): one card, one row per estimate
    const cos = d.schedules.filter((s) => s.source === "sheet_covered");
    const coCard = cos.length ? `<section class="card p-4">
        <div class="flex flex-wrap items-start gap-2">
          <div style="flex:1;min-width:200px"><div class="font-bold text-sm">Change-order labor not on the Drive sheet</div>
            <div class="text-xs text-black/50">Added by the app from each accepted estimate's Contract Labor line, because the Payment Schedule wasn't updated for it. Not in any Drive file.</div></div>
          <div class="font-bold tabular-nums text-sm">${fmtMoney(cos.reduce((t, s) => t + s.total, 0))}</div>
        </div>
        <div class="overflow-x-auto mt-2"><table class="w-full text-xs"><thead><tr class="text-[10px] uppercase tracking-wide text-black/45"><th class="py-1 pr-2 text-left">Estimate</th><th class="py-1 pr-2 text-left">Crew</th><th class="py-1 pr-2 text-left">Pay date</th><th class="py-1 pr-2 text-right">Amount</th><th class="py-1 text-left">Status</th></tr></thead>
        <tbody>${cos.flatMap((s) => s.rows.map((r) => `<tr class="border-t border-black/[0.05]"><td class="py-1 pr-2">#${escapeHtml(s.estimate || "")}</td><td class="py-1 pr-2">${escapeHtml(s.crew || "No crew set")}</td><td class="py-1 pr-2 tabular-nums">${day(r.date)}</td><td class="py-1 pr-2 text-right tabular-nums">${fmtMoney(r.amount)}</td><td class="py-1">${status(r)}</td></tr>`)).join("")}</tbody></table></div>
      </section>` : "";
    body.innerHTML = `
      <section class="card p-4 flex flex-wrap" style="gap:12px 32px">${stat("Estimate labor", lab)}${stat("Pending", pend)}${lod ? stat("Lodging in schedule", lod) : ""}${stat("Schedule", sched)}${stat("Paid", paid)}${stat("Still owed", owed)}</section>
      ${d.schedules.filter((s) => s.source !== "sheet_covered").map((s) => `<section class="card p-4">
        <div class="flex flex-wrap items-start gap-2">
          <div style="flex:1;min-width:200px"><div class="font-bold text-sm">${escapeHtml(s.file || `Estimate ${s.estimate || ""}`)}</div>
            <div class="text-xs text-black/50">${escapeHtml(s.crew || "No crew set")}${s.source === "sheet" ? " · read from Drive" : " · built in the app"}${s.modified ? ` · sheet updated ${day(s.modified)}` : ""}</div></div>
          ${s.doc_id ? `<button class="pd-btn" data-doc="${s.doc_id}" data-fn="${escapeHtml(s.file || "Payment Schedule")}">View the sheet</button>` : ""}
          <div class="font-bold tabular-nums text-sm">${fmtMoney(s.total)}</div>
        </div>
        <form data-lodging="${s.id}" class="flex flex-wrap items-end gap-2 mt-2">
          <label class="text-xs grid gap-1"><span class="text-black/55">Includes lodging ($)</span><input name="amount" type="number" min="0" step="0.01" value="${s.lodging || ""}" class="input text-sm tabular-nums" style="width:120px"></label>
          <label class="text-xs grid gap-1" style="flex:1;min-width:160px"><span class="text-black/55">Note</span><input name="note" maxlength="255" value="${escapeHtml(s.lodging_note || "")}" class="input text-sm" placeholder="How it was confirmed"></label>
          <button class="pd-btn" type="submit">Save</button>
        </form>
        <div class="overflow-x-auto mt-2"><table class="w-full text-xs"><thead><tr class="text-[10px] uppercase tracking-wide text-black/45"><th class="py-1 pr-2 text-left">Pay date</th><th class="py-1 pr-2 text-right">Amount</th><th class="py-1 pr-2 text-left">Status</th><th class="py-1 text-left">Note</th></tr></thead>
        <tbody>${s.rows.map((r) => `<tr class="border-t border-black/[0.05]"><td class="py-1 pr-2 tabular-nums">${day(r.date)}</td><td class="py-1 pr-2 text-right tabular-nums">${fmtMoney(r.amount)}</td>
          <td class="py-1 pr-2">${status(r)}</td><td class="py-1 text-black/55">${escapeHtml(r.note || "")}</td></tr>`).join("")}</tbody></table></div>
      </section>`).join("") || (cos.length ? "" : `<div class="card p-4 text-sm text-black/50">No Payment Schedule for this job.</div>`)}
      ${coCard}
      <section class="card p-4"><h3 class="font-bold text-sm">QuickBooks crew bills</h3>
        <div class="overflow-x-auto mt-2"><table class="w-full text-xs"><thead><tr class="text-[10px] uppercase tracking-wide text-black/45"><th class="py-1 pr-2 text-left">Date</th><th class="py-1 pr-2 text-left">Crew</th><th class="py-1 pr-2 text-left">Doc</th><th class="py-1 pr-2 text-left">Description</th><th class="py-1 text-right">Amount</th></tr></thead>
        <tbody>${d.bills.map((b) => `<tr class="border-t border-black/[0.05]"><td class="py-1 pr-2 tabular-nums whitespace-nowrap">${day(b.date)}</td><td class="py-1 pr-2">${escapeHtml(b.crew || "")}</td><td class="py-1 pr-2">${escapeHtml(b.doc || b.type)}</td><td class="py-1 pr-2 text-black/55">${escapeHtml(b.description || "")}</td><td class="py-1 text-right tabular-nums">${fmtMoney(b.amount)}</td></tr>`).join("") || `<tr><td colspan="5" class="py-2 text-black/45">No crew bills on this job.</td></tr>`}</tbody></table></div></section>
      ${d.pending.length ? `<section class="card p-4"><h3 class="font-bold text-sm">Pending change orders</h3><div class="text-xs mt-1 grid gap-1">${d.pending.map((p) => `<div class="flex justify-between gap-3"><span>${escapeHtml(p.title || (p.doc_number ? `Estimate ${p.doc_number}` : "Change order"))}</span><span class="tabular-nums font-semibold">${fmtMoney(p.amount)}</span></div>`).join("")}</div></section>` : ""}
      <section class="card p-4"><h3 class="font-bold text-sm">Change log</h3>
        ${d.log.length ? `<div class="text-xs mt-1 grid gap-1">${d.log.map((l) => `<div><span class="text-black/45">${day(l.at)} ${escapeHtml(l.who || "")}</span> ${escapeHtml(ACTION[l.action] || l.action)}${logDetail(l) ? `: ${escapeHtml(logDetail(l))}` : ""}</div>`).join("")}</div>` : `<div class="text-xs text-black/50 mt-1">No changes in the app yet. Edits made from now on are logged here.</div>`}</section>`;
  }

  body.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-doc]");
    if (t) openDocViewer({ id: Number(t.dataset.doc), filename: t.dataset.fn });
  });
  body.addEventListener("submit", async (ev) => {
    const form = ev.target.closest("[data-lodging]");
    if (!form) return;
    ev.preventDefault();
    const f = new FormData(form), a = f.get("amount");
    try {
      await api(`/crew-payments/schedule/${form.dataset.lodging}/lodging`, { method: "POST", body: JSON.stringify({ amount: a === "" ? null : Number(a), note: f.get("note") }) });
      dirty = true;
      await load();
    } catch (e) { alert(`Couldn't save: ${e?.message || e}`); }
  });
  load();
}
