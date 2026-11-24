// Job history (2026-11-24, owner): a read-only look at what really happened on a
// job — the estimates and POs placed on Ashley's Job Schedule phases, the
// bi-weekly crew pay worked out from the schedule days next to what was planned
// and paid, and each estimate's invoices. Backend: backend/app/setup/history.py.
// Nothing here changes a schedule; it's for checking them before anyone does.
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";
import { openDocViewer } from "../utils/doc-viewer.js";

const day = (s) => s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" }) : "—";
const md = (s) => s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric" }) : "—";
const money0 = (n) => `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n || 0)).toLocaleString()}`;
const num = (n) => (Math.round((n || 0) * 10) / 10).toLocaleString();
const TONE = {
  bad: "text-rose-700 bg-rose-50 border-rose-200",
  warn: "text-amber-800 bg-amber-50 border-amber-200",
  good: "text-emerald-700 bg-emerald-50 border-emerald-200",
  info: "text-sky-800 bg-sky-50 border-sky-200",
};
const HOW = {
  phase: "Its lines name this phase",
  follows: "Line follows a phase line",
  target: "Pipeline target dates",
  accepted: "First phase after it was accepted",
  main: "Rest of the estimate",
};
const diffCell = (d) => Math.abs(d) < 1 ? `<span class="text-black/35">—</span>`
  : `<span class="${d > 0 ? "text-rose-700" : "text-amber-700"} font-semibold">${d > 0 ? "+" : ""}${money0(d)}</span>`;

export async function mountHistory(box, key) {
  box.innerHTML = `<div class="text-sm text-black/50">Reading the estimates, POs, Job Schedule, invoices and crew bills…</div>`;
  let h;
  try {
    h = await api(`/setup/job/${encodeURIComponent(key)}/history`);
  } catch (e) {
    box.innerHTML = `<div class="text-sm text-rose-700">Couldn't load the job history: ${escapeHtml(e.message || String(e))}</div>`;
    return;
  }
  if (h.empty) {
    box.innerHTML = `<div class="text-sm text-black/50">The history opens once the project is in QuickBooks.</div>`;
    return;
  }
  box.innerHTML = html(h);
  box.addEventListener("click", (e) => {
    const a = e.target.closest("[data-hdoc]");
    if (a) { e.preventDefault(); openDocViewer({ id: +a.dataset.hdoc, filename: a.dataset.name }); }
  });
}

function html(h) {
  const est = Object.fromEntries(h.estimates.map((e) => [e.doc, e]));
  const findings = h.findings.length ? `<ul class="grid gap-1.5 mt-3">${h.findings.map((f) =>
    `<li class="text-xs rounded-lg border px-2.5 py-1.5 ${TONE[f.tone] || TONE.info}">${escapeHtml(f.text)}</li>`).join("")}</ul>` : "";
  return `
    <div class="text-xs text-black/55">Read-only. Lines up the estimates and their POs with the job's phases on the Job Schedule,
      works out the bi-weekly crew pay from the schedule days at ${money0(h.rate)} a crew-day (${escapeHtml(h.rate_from)}),
      and compares it with the crew schedule and what QuickBooks paid. Nothing here changes a schedule.</div>
    ${h.on_sheet ? "" : `<div class="text-xs mt-2 rounded-lg border px-2.5 py-1.5 ${TONE.warn}">Job #${escapeHtml(h.job_number || "?")} isn't on the synced Job Schedule tabs, so there are no phases to place the estimates in.</div>`}
    ${findings}
    <h4 class="su-h mt-4">Phases on the Job Schedule, and the estimates in each</h4>
    <div class="grid gap-3 mt-2">${h.phases.map((b) => phaseHtml(b, est)).join("") || `<div class="text-xs text-black/45">No work days found for this job.</div>`}</div>
    ${h.unplaced.length ? `<div class="text-xs mt-2 rounded-lg border px-2.5 py-1.5 ${TONE.warn}">Not on the Job Schedule: ${h.unplaced.map((p) => `#${escapeHtml(p.doc)} ${escapeHtml(p.group)} ${money0(p.labor)} (${escapeHtml(p.why || "")})`).join("; ")}</div>` : ""}
    <h4 class="su-h mt-5">Crew pay, payday by payday</h4>
    <div class="text-xs text-black/55 mt-1">Each payday pays for the work done through the week before it (the crew's invoice date).
      "Worked out" is that period's Job Schedule days × ${money0(h.rate)}, plus the trip's mobilization in its first period.
      Paid bills come from QuickBooks and have no estimate on them, so this is per job.</div>
    ${ledgerHtml(h)}
    <h4 class="su-h mt-5">Invoices per estimate</h4>
    ${invoicesHtml(h)}
    ${h.po_files.length ? `<h4 class="su-h mt-5">PO files</h4>
      <div class="flex flex-wrap gap-1.5 mt-2">${h.po_files.map((p) => `<a href="#" class="su-pochip" data-hdoc="${p.document_id}" data-name="${escapeHtml(p.filename)}"
        title="${escapeHtml(p.filename)}">${escapeHtml(p.po_number ? `PO ${p.po_number}` : p.filename)}${p.total != null ? ` · ${money0(p.total)}` : ""}${p.estimates?.length ? ` · #${p.estimates.map(escapeHtml).join(", #")}` : ""}</a>`).join("")}</div>` : ""}`;
}

function phaseHtml(b, est) {
  const fit = b.est_days - b.work_days;
  const over = b.app_lines.reduce((s, l) => s + l.overage, 0);
  const app = b.app_lines.map((l) => `${md(l.start)} – ${md(l.end)}${l.overage ? ` + ${l.overage} overage days` : ""}`).join("; ");
  const fitTxt = Math.abs(fit) <= 2 ? `<span class="text-emerald-700 font-semibold">fits</span>`
    : fit > 0 ? `<span class="text-amber-700 font-semibold">${num(fit)} days short on the sheet</span>`
      : `<span class="text-amber-700 font-semibold">${num(-fit)} days no estimate fills</span>`;
  return `<div class="su-hphase">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <div class="font-extrabold">${escapeHtml(b.name)}</div>
      <div class="text-xs text-black/60">${day(b.start)} – ${day(b.end)} · ${escapeHtml(b.crews.join(", ") || "crew ?")}${b.done ? " · finished" : ""}</div>
      <div class="text-xs text-black/45 truncate" title="${escapeHtml(b.label)}">“${escapeHtml(b.label)}”</div>
    </div>
    <div class="text-xs mt-1 text-black/70">Job Schedule <b>${b.work_days}</b> work days${b.off_days ? ` (+${b.off_days} off)` : ""} ·
      estimates need <b>${num(b.est_days)}</b> crew-days · ${fitTxt}
      ${app ? ` · App dates: ${escapeHtml(app)}${over ? ` <span class="text-black/45">(the overage days are the change orders below, if it fits)</span>` : ""}` : ""}</div>
    <div class="overflow-x-auto mt-2"><table class="w-full text-xs su-table">
      <thead><tr><th class="text-left">Estimate</th><th class="text-left">Placed here by</th><th class="text-left">Pipeline start</th>
        <th class="text-right">Contract labor</th><th class="text-right">Crew-days</th><th class="text-left">PO</th><th class="text-right">Invoiced</th></tr></thead>
      <tbody>${b.estimates.map((a) => {
        const e = est[a.doc] || {};
        const split = e.phases && e.phases.length > 1 ? ` <span class="text-black/45">(part; also ${escapeHtml(e.phases.filter((n) => n !== b.name).join(", "))})</span>` : "";
        return `<tr>
          <td class="whitespace-nowrap"><b>#${escapeHtml(a.doc)}</b>${a.base ? ` <span class="text-black/45">main</span>` : ` <span class="text-black/45">change order</span>`}${split}</td>
          <td title="${escapeHtml(a.lines.map((l) => `${l.group} ${money0(l.labor)}: ${l.desc}`).join("\n"))}">${escapeHtml(a.how.map((x) => HOW[x] || x).join("; "))}</td>
          <td class="whitespace-nowrap">${a.target ? day(a.target) : "—"}</td>
          <td class="text-right tabular-nums">${money0(a.labor)}${a.mob ? ` <span class="text-black/45">incl. ${money0(a.mob)} trip</span>` : ""}</td>
          <td class="text-right tabular-nums">${num(a.days)}</td>
          <td class="whitespace-nowrap">${e.po ? `<a href="#" class="underline" data-hdoc="${e.po.document_id}" data-name="${escapeHtml(e.po.filename)}">${escapeHtml(e.po.po_number || "PO file")}</a>` : `<span class="text-black/40">none</span>`}</td>
          <td class="text-right tabular-nums">${money0(e.invoiced)} <span class="text-black/45">of ${money0(e.total)}</span></td></tr>`;
      }).join("")}</tbody>
      <tfoot><tr><td colspan="3" class="font-bold">Phase total</td><td class="text-right tabular-nums font-bold">${money0(b.labor)}</td>
        <td class="text-right tabular-nums font-bold">${num(b.est_days)}</td><td colspan="2"></td></tr></tfoot>
    </table></div></div>`;
}

function ledgerHtml(h) {
  if (!h.periods.length) return `<div class="text-xs text-black/45 mt-2">No crew pay or Job Schedule days to line up.</div>`;
  const rows = h.periods.map((p) => {
    const d = p.paid - p.expected;
    const phases = p.by_phase.length === 1 ? escapeHtml(p.by_phase[0].name) : p.by_phase.map((x) => `${x.days} ${escapeHtml(x.name)}`).join(", ");
    const sched = p.scheduled_rows.map((r) => `#${r.doc} ${money0(r.amount)}${r.note ? ` · ${r.note}` : ""}`).join("\n");
    const cumD = p.cum.paid - p.cum.expected;
    return `<tr class="${p.future ? "text-black/50" : ""}">
      <td class="whitespace-nowrap font-semibold">${day(p.pay_date)}${p.future ? ` <span class="font-normal">(coming)</span>` : ""}</td>
      <td class="whitespace-nowrap">${p.work_from ? md(p.work_from) : "start"} – ${md(p.work_to)}</td>
      <td>${p.days ? `${p.days} <span class="text-black/45">${phases}</span>` : `<span class="text-black/35">no work</span>`}</td>
      <td class="text-right tabular-nums">${money0(p.expected)}${p.mob ? ` <span class="text-black/45">incl. ${money0(p.mob)} trip</span>` : ""}</td>
      <td class="text-right tabular-nums" title="${escapeHtml(sched)}">${p.scheduled ? money0(p.scheduled) : "—"}</td>
      <td class="text-right tabular-nums font-semibold">${p.paid ? money0(p.paid) : "—"}</td>
      <td class="text-right tabular-nums">${p.future && !p.paid ? "" : diffCell(d)}</td>
      <td class="text-right tabular-nums">${p.future && !p.paid ? "" : diffCell(cumD)}</td></tr>`;
  }).join("");
  const last = [...h.periods].reverse().find((p) => !p.future) || h.periods[h.periods.length - 1];
  return `<div class="overflow-x-auto mt-2"><table class="w-full text-xs su-table">
    <thead><tr><th class="text-left">Payday</th><th class="text-left">Work covered</th><th class="text-left">Job Schedule days</th>
      <th class="text-right">Worked out</th><th class="text-right">Crew schedule</th><th class="text-right">Paid (QuickBooks)</th>
      <th class="text-right">Paid vs worked out</th><th class="text-right">Running</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td colspan="3" class="font-bold">To ${day(last.pay_date)}</td><td class="text-right tabular-nums font-bold">${money0(last.cum.expected)}</td>
      <td class="text-right tabular-nums font-bold">${money0(last.cum.scheduled)}</td><td class="text-right tabular-nums font-bold">${money0(last.cum.paid)}</td>
      <td></td><td class="text-right tabular-nums font-bold">${diffCell(last.cum.paid - last.cum.expected)}</td></tr></tfoot>
  </table></div>
  ${h.undated.length ? `<div class="text-xs mt-2 rounded-lg border px-2.5 py-1.5 ${TONE.warn}">Crew schedule rows with no pay date: ${h.undated.map((r) => `#${escapeHtml(r.doc)} ${money0(r.amount)}${r.note ? ` (${escapeHtml(r.note)})` : ""}`).join("; ")}</div>` : ""}
  <div class="text-[11px] text-black/45 mt-1">Hover a crew schedule amount to see its rows. "Worked out" is a guide from the schedule days, not a rule; the crew deal can differ.</div>`;
}

function invoicesHtml(h) {
  const list = h.estimates.filter((e) => e.total && ["Accepted", "Converted", "Closed"].includes(e.status));
  return `<div class="overflow-x-auto mt-2"><table class="w-full text-xs su-table">
    <thead><tr><th class="text-left">Estimate</th><th class="text-left">Phase</th><th class="text-right">Total</th>
      <th class="text-left">QuickBooks invoices</th><th class="text-left">Invoice schedule</th><th class="text-left">Check</th></tr></thead>
    <tbody>${list.map((e) => `<tr>
      <td class="whitespace-nowrap"><b>#${escapeHtml(e.doc)}</b></td>
      <td class="whitespace-nowrap">${escapeHtml(e.phases.join(", ") || "—")}</td>
      <td class="text-right tabular-nums">${money0(e.total)}</td>
      <td>${e.invoices.map((i) => `<div class="whitespace-nowrap">#${escapeHtml(i.doc || "?")} ${day(i.date)} ${money0(i.amount)}${i.balance > 0.5 ? ` <span class="text-amber-700">${money0(i.balance)} open</span>` : ` <span class="text-emerald-700">paid</span>`}</div>`).join("") || `<span class="text-black/40">none yet</span>`}</td>
      <td>${e.milestones.map((m) => `<div class="whitespace-nowrap">${escapeHtml(m.label)} · ${money0(m.amount)} · ${m.invoice_date ? day(m.invoice_date) : `<span class="text-amber-700">no date</span>`}${m.qbo_invoice_id ? "" : ` <span class="text-black/45">planned</span>`}${m.edited ? ` <span class="text-black/45">· edited</span>` : ""}</div>`).join("") || `<span class="text-black/40">none</span>`}</td>
      <td>${e.flags.map((f) => `<div class="rounded border px-1.5 py-0.5 ${TONE[f.tone]}">${escapeHtml(f.text)}</div>`).join("") || `<span class="text-emerald-700">ok</span>`}</td></tr>`).join("")}</tbody>
  </table></div>`;
}
