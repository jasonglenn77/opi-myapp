// Billing & Schedule panel — reorganized around the ESTIMATE (Slice 2).
// From /api/billing/project/{id}: a project roll-up, then one invoice schedule
// per estimate (35/35/30, needs-review until confirmed), crew payments grouped
// into per-crew rollups (single lump per pay date; reassigning an estimate's
// crew splits the rollup), a pending-estimate tray, and shared project expenses
// (est-vs-actual by category + a weekly cash-out schedule).
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";

const money = (n) => (n == null || n === "" ? "—" : "$" + Math.round(Number(n)).toLocaleString("en-US"));
const money2 = (n) => (n == null || n === "" ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }));

// ── confidence encoding ─────────────────────────────────────────────────────
const DOT = {
  realized:  '<span class="inline-block w-2.5 h-2.5 rounded-full bg-ink-900 align-middle"></span>',
  committed: '<span class="inline-block w-2.5 h-2.5 rounded-full bg-ink-900 align-middle"></span>',
  partial:   '<span class="inline-block w-2.5 h-2.5 rounded-full bg-amber-500 align-middle"></span>',
  scheduled: '<span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 align-middle"></span>',
  estimated: '<span class="inline-block w-2.5 h-2.5 rounded-full border-[1.5px] border-black/40 align-middle"></span>',
};
const PILL = {
  Paid:          "text-emerald-700 bg-emerald-50 border border-emerald-200",
  "Sent · A/R":  "text-ink-900 bg-black/[0.06] border border-black/15",
  "Bill · A/P":  "text-ink-900 bg-black/[0.06] border border-black/15",
  Scheduled:     "text-emerald-700 bg-transparent border border-emerald-300",
  "To bill":     "text-emerald-700 bg-transparent border border-emerald-300",
  Allocated:     "text-black/45 bg-transparent border border-black/15",
};
function pill(label) {
  const cls = PILL[label] || (String(label).startsWith("Partial") ? "text-amber-700 bg-amber-50 border border-amber-200" : PILL.Allocated);
  return `<span class="inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${cls}">${escapeHtml(label)}</span>`;
}
const editedChip = (e) => e ? `<span class="ml-1.5 inline-flex items-center text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5" title="Hand-edited — preserved when the schedule refreshes">✎ edited</span>` : "";

// ── inline-edit cells (patch on change; kind → PATCH endpoint) ───────────────
const EDIT_BASE = "bg-transparent border border-transparent hover:border-black/20 focus:border-blue-500 focus:bg-white rounded px-1.5 py-1 text-[12.5px] outline-none";
const eInput = (kind, id, field, value, type = "text", extra = "") => {
  const v = value == null ? "" : String(value);
  if (type === "date") return `<input data-edit="${kind}" data-id="${id}" data-field="${field}" type="date" value="${escapeHtml(v ? v.slice(0, 10) : "")}" class="${EDIT_BASE} w-[8.2rem] tabular-nums ${extra}">`;
  if (type === "number") return `<input data-edit="${kind}" data-id="${id}" data-field="${field}" type="number" step="1" value="${escapeHtml(v)}" class="${EDIT_BASE} w-[6.5rem] text-right tabular-nums font-semibold ${extra}">`;
  return `<input data-edit="${kind}" data-id="${id}" data-field="${field}" type="text" value="${escapeHtml(v)}" class="${EDIT_BASE} w-full ${extra}">`;
};
const eSelect = (kind, id, field, value, opts) =>
  `<select data-edit="${kind}" data-id="${id}" data-field="${field}" class="${EDIT_BASE} font-semibold">${opts.map((o) => `<option ${o === value ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}</select>`;
const delBtn = (kind, id) => `<button data-del="${kind}" data-id="${id}" class="ml-2 text-black/25 hover:text-red-600 text-[13px] align-middle" title="Remove row">✕</button>`;
const addBtn = (kind, sid, label) => `<div class="px-4 py-2 border-t border-black/[0.06]"><button data-add="${kind}" data-sid="${sid ?? ""}" class="text-[12px] font-semibold text-blue-600 hover:underline">+ ${escapeHtml(label)}</button></div>`;

// stacked burn-down bar from labelled segments [{w, cls, label}]
function burnBar(segments) {
  const total = segments.reduce((a, s) => a + s.v, 0) || 1;
  const seg = (s) => {
    const pct = Math.max(0, (s.v / total) * 100);
    if (pct <= 0) return "";
    return `<div class="h-full flex items-center justify-center text-[10px] font-bold tabular-nums overflow-hidden whitespace-nowrap ${s.cls}" style="width:${pct}%" title="${escapeHtml(s.title || "")}">${pct > 11 ? escapeHtml(s.label) : ""}</div>`;
  };
  return `<div class="flex h-6 rounded-md overflow-hidden border border-black/10 bg-black/[0.04]">${segments.map(seg).join("")}</div>`;
}

const SEG = {
  realized:  "bg-emerald-700 text-white",
  committed: "bg-ink-900 text-white",
  scheduled: "bg-emerald-200 text-ink-900",
  estimated: "text-black/45 [background-image:repeating-linear-gradient(135deg,transparent,transparent_5px,rgba(0,0,0,.12)_5px,rgba(0,0,0,.12)_6px)]",
};

const ymd = (s) => (s ? String(s).slice(0, 10) : "—");
const shortDate = (s) => {
  if (!s) return "—";
  const [y, m, d] = String(s).slice(0, 10).split("-");
  return `${Number(m)}/${Number(d)}/${y.slice(2)}`;
};

const STATUS_PILL = {
  completed:       ["Complete", "text-emerald-700 bg-emerald-50 border-emerald-200"],
  in_progress:     ["In progress", "text-emerald-700 bg-emerald-50 border-emerald-200"],
  not_started:     ["Not started", "text-slate-700 bg-slate-100 border-slate-300"],
  pending:         ["Pending", "text-amber-800 bg-amber-50 border-amber-300"],
  needs_attention: ["Needs attention", "text-rose-700 bg-rose-50 border-rose-200"],
  canceled:        ["Canceled", "text-black/50 bg-black/10 border-black/15"],
};

// Warm cache: entity-detail calls prefetchBilling() the moment a project opens,
// so by the time the user clicks the Billing tab the bundle is already loading
// (or done). The bundle also auto-generates schedules on first fetch, so warming
// it early hides that one-time cost.
const _prefetch = new Map(); // entityId -> Promise<bundle|null>

export function prefetchBilling(entityId) {
  if (!entityId || _prefetch.has(entityId)) return;
  _prefetch.set(entityId, api(`/billing/project/${encodeURIComponent(entityId)}`).catch(() => null));
}

export async function mountBillingPanel(container, entityId) {
  container.innerHTML = `<div class="p-6 text-sm text-black/50">Loading billing & schedule…</div>`;
  let d = null;
  if (_prefetch.has(entityId)) {
    d = await _prefetch.get(entityId);
    _prefetch.delete(entityId); // one-shot; edits/regenerate re-fetch fresh
  }
  if (!d) {
    try {
      d = await api(`/billing/project/${encodeURIComponent(entityId)}`);
    } catch (e) {
      container.innerHTML = `<div class="p-6 text-sm text-red-600">Couldn't load billing data: ${escapeHtml(e?.message || "error")}</div>`;
      return;
    }
  }
  render(container, entityId, d);
}

function render(container, entityId, d) {
  const p = d.project, k = d.kpis;
  const est = d.estimates || { accepted: [], pending: [], needs_review: 0, contract_total: 0, collected: 0, open_ar: 0, invoiced_qbo: 0 };
  const roll = d.crew_rollups || { rollups: [], total_labor: 0, total_paid: 0 };
  const inv = d.invoices, crew = d.crew, exp = d.expenses;
  const crews = d.crews || [];
  const [stLabel, stCls] = STATUS_PILL[p.operational_status] || [p.operational_status || "—", "text-slate-700 bg-slate-100 border-slate-300"];
  const crewName = (id) => { const c = crews.find((x) => String(x.id) === String(id)); return c ? (c.parent_name ? c.parent_name + " — " : "") + c.name : null; };
  const crewOpts = (sel) => `<option value="">Unassigned</option>` + crews.map((c) => `<option value="${c.id}" ${String(c.id) === String(sel) ? "selected" : ""}>${escapeHtml((c.parent_name ? c.parent_name + " — " : "") + c.name)}</option>`).join("");
  // Crew "paid" = ALL actual Contract-Labor bills (any vendor, incl. crews not
  // registered/assigned in the app) — not just the assigned rollups.
  const crewPaid = crew.paid_qbo != null ? crew.paid_qbo : roll.total_paid;
  // Total contract labor = the estimates' Contract Labor (works even before the
  // bi-weekly schedules are generated, e.g. a project with no dates yet).
  const crewLaborEst = est.accepted.reduce((s, a) => s + (a.labor || 0), 0) || roll.total_labor;
  const crewLeft = Math.max(0, crewLaborEst - crewPaid);

  // ── roll-up KPIs + burn bars ──
  const kpi = (label, val, cls = "") =>
    `<div class="px-4 py-3 bg-white"><div class="text-[10.5px] font-bold uppercase tracking-wide text-black/40 mb-1">${label}</div><div class="text-lg font-bold tabular-nums ${cls}">${money(val)}</div></div>`;
  const burnRow = (label, sub, bar) =>
    `<div class="mb-3"><div class="flex justify-between items-baseline text-[12px] mb-1"><span class="font-semibold text-ink-900">${escapeHtml(label)}</span><span class="text-black/50">${escapeHtml(sub)}</span></div>${bar}</div>`;
  const invBar = burnBar([
    { v: est.collected, cls: SEG.realized, label: money(est.collected) + " paid", title: "Collected" },
    { v: Math.max(0, est.invoiced_qbo - est.collected), cls: SEG.committed, label: money(est.invoiced_qbo - est.collected) + " A/R", title: "Invoiced, unpaid" },
    { v: Math.max(0, est.contract_total - est.invoiced_qbo), cls: SEG.scheduled, label: money(est.contract_total - est.invoiced_qbo) + " to bill", title: "Not yet invoiced" },
  ]);
  const crewBar = burnBar([
    { v: Math.min(crewPaid, crewLaborEst), cls: SEG.realized, label: money(Math.min(crewPaid, crewLaborEst)) + " paid", title: "Paid to crews (all bills)" },
    { v: crewLeft, cls: SEG.scheduled, label: money(crewLeft) + " left", title: "Scheduled" },
    { v: Math.max(0, crewPaid - crewLaborEst), cls: "bg-red-600 text-white", label: money(Math.max(0, crewPaid - crewLaborEst)) + " over", title: "Paid beyond the estimate" },
  ]);
  const expSpent = exp.spent_qbo || 0, expEst = exp.estimate_total || 0;
  const expBar = burnBar([
    { v: Math.min(expSpent, expEst), cls: SEG.committed, label: money(Math.min(expSpent, expEst)) + " spent", title: "Spent (QBO)" },
    { v: Math.max(0, expEst - expSpent), cls: SEG.scheduled, label: money(Math.max(0, expEst - expSpent)) + " left", title: "Left to spend" },
    { v: Math.max(0, expSpent - expEst), cls: "bg-red-600 text-white", label: money(Math.max(0, expSpent - expEst)) + " over", title: "Over the estimate" },
  ]);

  // ── banners ──
  const reviewList = est.accepted.filter((a) => !a.confirmed);
  const banner = est.needs_review > 0 ? `
    <div class="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex items-center gap-3">
      <span class="w-6 h-6 rounded-md bg-amber-500 text-white flex items-center justify-center font-extrabold shrink-0">!</span>
      <div class="text-[13px] text-amber-900"><b>${est.needs_review} estimate${est.needs_review > 1 ? "s" : ""} need${est.needs_review > 1 ? "" : "s"} review</b> — newly converted; confirm ${est.needs_review > 1 ? "their" : "its"} invoice schedule &amp; crew assignment (${reviewList.map((a) => "#" + escapeHtml(a.doc)).join(", ")}).</div>
    </div>` : "";
  const completePrompt = p.appears_complete ? `
    <div class="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 flex items-center gap-3">
      <span class="w-6 h-6 rounded-md bg-emerald-600 text-white flex items-center justify-center font-extrabold shrink-0">✓</span>
      <div class="text-[13px] text-emerald-900 flex-1"><b>This project looks complete</b> — every invoice is billed and paid. Review, then mark it complete to close the books.</div>
      <button data-complete class="text-[12px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg px-3 py-1.5 whitespace-nowrap">Mark complete</button>
    </div>` : "";
  const driftPrompt = (p.drift && p.drift.length) ? `
    <div class="rounded-xl border border-blue-300 bg-blue-50 px-4 py-3 flex items-center gap-3">
      <span class="w-6 h-6 rounded-md bg-blue-600 text-white flex items-center justify-center font-extrabold shrink-0">↻</span>
      <div class="text-[13px] text-blue-900 flex-1"><b>Schedule is out of date.</b> ${p.drift.map(escapeHtml).join("; ")}. Refresh to rebuild the untouched schedules (your edits are kept).</div>
      <button data-refresh class="text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-3 py-1.5 whitespace-nowrap">↻ Refresh now</button>
    </div>` : "";
  const needsDates = !p.has_dates ? `
    <div class="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex items-center gap-3">
      <span class="w-6 h-6 rounded-md bg-amber-500 text-white flex items-center justify-center font-extrabold shrink-0">!</span>
      <div class="text-[13px] text-amber-900"><b>No assignment dates yet.</b> Add a start/end on the <b>Assignment</b> tab and the crew &amp; invoice schedules will generate automatically.</div>
    </div>` : "";

  // collapsible actuals disclosure
  const actualsBlock = (title, count, innerHtml, open = "") => `
    <details${open} class="group/act border-t border-black/[0.06] bg-black/[0.012]">
      <summary class="px-4 py-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wide text-black/40 hover:text-black/60">
        <svg class="w-3 h-3 transition-transform group-open/act:rotate-90" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
        ${escapeHtml(title)} <span class="text-black/30">(${count})</span>
      </summary><div class="px-4 pb-3 overflow-x-auto">${innerHtml}</div></details>`;

  // ── INVOICES section: one card per estimate (schedule + actual invoices) ──
  const milestoneRow = (m) => `
    <tr class="border-b border-black/5">
      <td class="py-1 pl-4 pr-3"><span class="flex items-center gap-2">${DOT[m.tier]}${eInput("milestone", m.id, "label", m.label || "Milestone", "text", "font-semibold min-w-[8rem]")}</span></td>
      <td class="py-1 px-2 tabular-nums text-black/50">${m.pct ? Math.round(m.pct) + "%" : "—"}</td>
      <td class="py-1 px-2">${eInput("milestone", m.id, "invoice_date", m.invoice_date, "date")}</td>
      <td class="py-1 px-2">${eInput("milestone", m.id, "due_date", m.due_date, "date")}</td>
      <td class="py-1 px-2 text-right">${eInput("milestone", m.id, "amount", Math.round(m.amount), "number", "ml-auto")}</td>
      <td class="py-1 pl-2 pr-4 text-right whitespace-nowrap">${pill(m.status_label)}${editedChip(m.edited)}${delBtn("milestone", m.id)}</td>
    </tr>`;
  const invEstimateCard = (a) => {
    const nr = !a.confirmed;
    const statusPill = nr
      ? `<span class="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">● Needs review</span>`
      : `<span class="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">Confirmed</span>`;
    const rows = a.milestones.map(milestoneRow).join("");
    const acts = a.invoice_actuals || [];
    const actTotal = acts.reduce((s, x) => s + (x.amount || 0), 0);
    const actuals = acts.length ? actualsBlock("Actual invoices in QuickBooks", acts.length,
      `<table class="w-full text-[12px]"><thead><tr class="text-[10px] text-black/40 text-left"><th class="pb-1 font-bold">Invoice #</th><th class="font-bold">Date</th><th class="font-bold">Due</th><th class="text-right font-bold">Amount</th><th class="text-right font-bold">Status</th></tr></thead>
       <tbody>${acts.map((x) => `<tr class="border-t border-black/[0.05]"><td class="py-1.5 tabular-nums font-semibold">${escapeHtml(x.doc_number || "—")}</td><td class="py-1.5 tabular-nums text-black/60">${shortDate(x.txn_date)}</td><td class="py-1.5 tabular-nums text-black/60">${shortDate(x.due_date)}</td><td class="py-1.5 text-right tabular-nums font-semibold">${money(x.amount)}</td><td class="py-1.5 text-right">${pill(x.status === "Paid" ? "Paid" : "Sent · A/R")}</td></tr>`).join("")}</tbody>
       <tfoot><tr class="border-t-2 border-black/15 font-bold"><td class="py-1.5" colspan="3">Total invoiced <span class="font-normal text-black/45">vs ${money(a.value)} est</span></td><td class="py-1.5 text-right tabular-nums">${money(actTotal)}</td><td></td></tr></tfoot></table>`) : "";
    return `<details open class="group card overflow-hidden mb-3 ${nr ? "border-amber-300" : ""}">
      <summary class="flex items-center gap-2 px-4 py-3 border-b border-black/10 bg-black/[0.02] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex-wrap">
        <svg class="w-3.5 h-3.5 text-black/30 transition-transform group-open:rotate-90 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
        <span class="text-sm font-bold text-ink-900">Estimate <span class="text-blue-700">#${escapeHtml(a.doc || "—")}</span></span>
        ${statusPill}
        <span class="ml-auto tabular-nums text-[13px] font-bold text-ink-900">${money(a.value)}</span>
      </summary>
      <div class="overflow-x-auto"><table class="w-full text-[12.5px]"><thead><tr class="text-[10px] font-bold uppercase tracking-wide text-black/40 border-b border-black/10">
        <th class="py-2 pl-4 pr-3 text-left">Milestone</th><th class="py-2 px-2 text-left">%</th><th class="py-2 px-2 text-left">Invoice</th><th class="py-2 px-2 text-left">Due</th><th class="py-2 px-2 text-right">Amount</th><th class="py-2 pl-2 pr-4 text-right">Status</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      ${a.schedule_id ? addBtn("milestone", a.schedule_id, "Add invoice milestone") : ""}
      ${actuals}
    </details>`;
  };

  // ── CREW section: rollup payment blocks (header) + per-estimate assignment rows ──
  const rollupBlock = (g) => {
    const cn = g.crew_name || "Unassigned";
    // "Other crews paid" — actual Contract-Labor cash to vendors that aren't an
    // assigned crew (unassigned estimates, or paid to a different vendor on a
    // legacy project). No schedule/offer — just the reconciling actual bills.
    if (g.is_other) {
      const rows = (g.vendors || []).map((v) => `<tr class="border-b border-black/[0.04]"><td class="py-1 pl-4 pr-3 text-black/70 font-semibold">${escapeHtml(v.vendor)}</td><td class="py-1 pl-2 pr-4 text-right tabular-nums font-semibold text-ink-900">${money(v.amount)}</td></tr>`).join("");
      return `<div class="rounded-xl border border-amber-200 overflow-hidden mb-3">
        <div class="flex items-center gap-2 px-4 py-2.5 bg-amber-50 border-b border-amber-200 flex-wrap">
          <span class="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300">Other crews</span>
          <span class="text-[13px] font-bold text-ink-900">${escapeHtml(cn)}</span>
          <span class="ml-auto tabular-nums text-[13px]"><b class="text-ink-900">${money(g.paid_qbo)}</b> <span class="text-black/45">paid</span></span>
        </div>
        <div class="overflow-x-auto"><table class="w-full text-[12.5px]"><tbody>${rows}</tbody></table></div>
        <div class="px-4 py-2 text-[11px] text-amber-800 bg-amber-50/60 border-t border-amber-200">Contract-Labor paid to crews not assigned to an estimate here. Assign the estimate to one of these crews to fold it into a rollup.</div>
      </div>`;
    }
    const chips = g.estimates.map((e) => `<span class="text-[10.5px] font-semibold px-2 py-0.5 rounded border border-black/10 bg-black/[0.02] text-black/60">#${escapeHtml(e.doc || "—")} · ${money(e.labor)}</span>`).join("");
    const insts = g.installments.map((i) => `
      <tr class="border-b border-black/5"><td class="py-1 pl-4 pr-3 tabular-nums text-black/60"><span class="flex items-center gap-2">${DOT[i.tier] || ""}${shortDate(i.pay_date)}</span></td><td class="py-1 px-2 text-right tabular-nums font-semibold text-ink-900">${money(i.amount)}</td><td class="py-1 pl-2 pr-4 text-right">${pill(i.status_label)}</td></tr>`).join("");
    const o = g.offer;
    let offerLine;
    if (p.books_closed)
      offerLine = "";  // complete: payments already sent, no offer to manage
    else if (o && o.status === "accepted")
      offerLine = `<div class="px-4 py-2.5 bg-emerald-50 border-t border-emerald-200 text-[12.5px] text-emerald-900 flex items-center gap-2 flex-wrap"><b>✓ Offer accepted</b> — ${escapeHtml(cn)} · ${money(o.labor_amount)}<button data-offer-script data-crew="${g.crew_id}" class="ml-auto text-[11.5px] font-semibold text-blue-600 hover:underline">📋 Script</button><button data-offer-withdraw="${o.id}" class="text-[11.5px] font-semibold text-black/45 hover:underline">Withdraw</button></div>`;
    else if (o && o.status === "sent")
      offerLine = `<div class="px-4 py-2.5 bg-blue-50 border-t border-blue-200 text-[12.5px] text-blue-900 flex items-center gap-2 flex-wrap"><b>Offer sent</b> to ${escapeHtml(cn)} — awaiting response<button data-offer-accept="${o.id}" class="text-[11.5px] font-bold text-emerald-700 hover:underline">Record accepted</button><button data-offer-script data-crew="${g.crew_id}" class="ml-auto text-[11.5px] font-semibold text-blue-600 hover:underline">📋 Script</button><button data-offer-withdraw="${o.id}" class="text-[11.5px] font-semibold text-blue-700 hover:underline">Withdraw</button></div>`;
    else offerLine = g.crew_id
      ? `<div class="px-4 py-2.5 border-t border-black/[0.06] bg-black/[0.01] text-[12.5px] flex items-center gap-2 flex-wrap"><span class="font-semibold text-black/55">Rollup offer:</span><span>${escapeHtml(cn)} · ${money(g.labor)}</span><button data-offer-send data-crew="${g.crew_id}" data-labor="${Math.round(g.labor)}" class="text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-3 py-1">Send offer</button><button data-offer-script data-crew="${g.crew_id}" class="text-[11.5px] font-semibold text-blue-600 hover:underline">📋 Script</button></div>`
      : `<div class="px-4 py-2.5 border-t border-black/[0.06] text-[12px] text-amber-700 bg-amber-50">Assign these estimates to a crew below to send an offer.</div>`;
    return `<div class="rounded-xl border border-black/10 overflow-hidden mb-3">
      <div class="flex items-center gap-2 px-4 py-2.5 bg-indigo-50/60 border-b border-black/10 flex-wrap">
        <span class="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200">Rollup</span>
        <span class="text-[13px] font-bold text-ink-900">${escapeHtml(cn)}</span>
        <span class="text-[11.5px] text-black/45">covers ${g.estimates.length} estimate${g.estimates.length > 1 ? "s" : ""}</span>
        <span class="ml-auto tabular-nums text-[13px]"><b class="text-ink-900">${money(g.paid_qbo)}</b> <span class="text-black/45">paid / ${money(g.labor)}</span></span>
      </div>
      <div class="px-4 py-2 flex flex-wrap gap-1.5 border-b border-black/[0.05]">${chips}</div>
      <div class="overflow-x-auto"><table class="w-full text-[12.5px]"><thead><tr class="text-[10px] font-bold uppercase tracking-wide text-black/40 border-b border-black/10"><th class="py-2 pl-4 pr-3 text-left">Rollup pay date</th><th class="py-2 px-2 text-right">Amount (lump)</th><th class="py-2 pl-2 pr-4 text-right">Status</th></tr></thead><tbody>${insts || `<tr><td colspan="3" class="px-4 py-3 text-black/40 text-[12px]">No installments — add assignment dates.</td></tr>`}</tbody></table></div>
      ${offerLine}
    </div>`;
  };
  const crewEstimateRow = (a) => {
    const complete = p.books_closed;
    const insts = (a.crew_installments || []).map((i) => `
      <tr class="border-b border-black/5">
        <td class="py-1 pl-4 pr-2">${complete ? `<span class="tabular-nums text-black/60">${shortDate(i.pay_date)}</span>` : eInput("installment", i.id, "pay_date", i.pay_date, "date")}</td>
        <td class="py-1 px-2 text-right">${complete ? `<span class="tabular-nums font-semibold">${money(i.amount)}</span>` : eInput("installment", i.id, "amount", Math.round(i.amount), "number", "ml-auto")}</td>
        <td class="py-1 pl-2 pr-4 text-right whitespace-nowrap">${i.edited ? editedChip(true) : ""}${complete ? "" : delBtn("installment", i.id)}</td>
      </tr>`).join("");
    // crew assignment lives OUTSIDE the <summary> so clicks reach the delegated
    // handler (a stopPropagation in the summary was swallowing them).
    const assignRow = complete
      ? `<div class="px-4 py-1.5 text-[11.5px] text-black/55">Crew paid: <b class="text-ink-900">${escapeHtml(crewName(a.crew_id) || "—")}</b> · books closed</div>`
      : `<div class="px-4 py-1.5 flex items-center gap-1.5 text-[11.5px] flex-wrap"><span class="text-black/55">Crew</span>
          <select data-assign-crew data-eq="${a.qbo_id}" class="${EDIT_BASE} border-black/15">${crewOpts(a.crew_id)}</select>
          <button data-crew-browse data-eq="${a.qbo_id}" class="text-[11px] font-semibold text-blue-600 hover:underline">browse crews →</button></div>`;
    return `<details class="group/ce border-b border-black/[0.06]">
      <summary class="flex items-center gap-2 px-4 py-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-black/[0.015] flex-wrap">
        <svg class="w-3 h-3 text-black/30 transition-transform group-open/ce:rotate-90 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
        <span class="text-[12.5px] font-semibold text-ink-900">Estimate #${escapeHtml(a.doc || "—")}</span>
        <span class="tabular-nums text-[12px] text-black/55">${money(a.labor)} labor</span>
        <span class="ml-auto text-[11px] text-black/40">${escapeHtml(crewName(a.crew_id) || "Unassigned")}</span>
      </summary>
      ${assignRow}
      <div class="overflow-x-auto px-2 pb-2"><table class="w-full text-[12px]"><thead><tr class="text-[10px] text-black/40 text-left"><th class="py-1 pl-4">Pay date (auto bi-weekly)</th><th class="py-1 text-right">Amount</th><th></th></tr></thead><tbody>${insts || `<tr><td colspan="3" class="px-4 py-2 text-black/40">No schedule — add dates.</td></tr>`}</tbody></table></div>
      ${!complete && a.crew_schedule_id ? addBtn("installment", a.crew_schedule_id, "Add payment") : ""}
    </details>`;
  };
  const crewActualsTotal = (crew.actuals || []).reduce((s, a) => s + (a.amount || 0), 0);
  // On a complete project the actual bills ARE the story — surface them open, with
  // every crew that was paid (incl. crews never registered/assigned in the app).
  const crewActualsOpen = p.books_closed ? " open" : "";
  const crewActuals = (crew.actuals && crew.actuals.length) ? actualsBlock("Actual crew bills in QuickBooks — all crews paid", crew.actuals.length, (() => {
    const byV = {}; crew.actuals.forEach((a) => { (byV[a.vendor || "—"] ||= []).push(a); });
    return Object.keys(byV).sort().map((v) => { const rows = byV[v]; const sub = rows.reduce((s, a) => s + a.amount, 0);
      return `<div class="mb-2"><div class="flex justify-between text-[11px] font-bold text-ink-900 border-b border-black/10 pb-1 mb-1"><span>${escapeHtml(v)}</span><span class="tabular-nums text-black/55">${money(sub)}</span></div>
        <table class="w-full text-[12px]"><tbody>${rows.map((a) => `<tr class="border-b border-black/[0.04]"><td class="py-1 pr-3 text-black/50">Contract Labor</td><td class="py-1 pr-3 tabular-nums text-black/60">${a.doc ? "#" + escapeHtml(a.doc) : ""}</td><td class="py-1 pr-3 tabular-nums text-black/60">${shortDate(a.date)}</td><td class="py-1 text-right tabular-nums font-semibold">${money(a.amount)}</td></tr>`).join("")}</tbody></table></div>`;
    }).join("") + `<div class="flex justify-between text-[12px] font-bold border-t-2 border-black/15 pt-1.5"><span>Total paid to crews</span><span class="tabular-nums">${money(crewActualsTotal)}</span></div>`;
  })(), crewActualsOpen) : "";

  // ── EXPENSES section: per-category (est-vs-actual header; editable weekly
  //    schedule + actuals inside). Weekly rows edit like invoices/crew. ──
  const expenseComplete = p.books_closed;
  const expenseCat = (c) => {
    const over = c.variance > 0.5;
    const weekly = (c.weekly || []).map((w) => `
      <tr class="border-b border-black/5">
        <td class="py-1 pl-6 pr-2"><span class="flex items-center gap-2">${DOT[w.tier]}${expenseComplete ? `<span class="tabular-nums text-black/60">${shortDate(w.week_of)}</span>` : eInput("expinst", w.id, "week_of", w.week_of, "date")}</span></td>
        <td class="py-1 px-2 text-right">${expenseComplete ? `<span class="tabular-nums font-semibold">${money(w.amount)}</span>` : eInput("expinst", w.id, "amount", Math.round(w.amount), "number", "ml-auto")}</td>
        <td class="py-1 pl-2 pr-4 text-right whitespace-nowrap">${pill(w.status_label)}${editedChip(w.edited)}${expenseComplete ? "" : delBtn("expinst", w.id)}</td>
      </tr>`).join("");
    const acts = c.actuals || [];
    const actuals = acts.length ? actualsBlock("Actual expenses in QuickBooks", acts.length,
      `<table class="w-full text-[12px]"><tbody>${acts.map((a) => `<tr class="border-b border-black/[0.04]"><td class="py-1 pr-3 font-semibold">${escapeHtml(a.vendor || "—")}</td><td class="py-1 pr-3 text-black/50">${escapeHtml(a.source_item || "")}</td><td class="py-1 pr-3 tabular-nums text-black/60">${shortDate(a.date)}</td><td class="py-1 text-right tabular-nums font-semibold">${money(a.amount)}</td></tr>`).join("")}</tbody></table>`) : "";
    return `<details class="group/ec border-b border-black/[0.06]">
      <summary class="flex items-center gap-2 px-4 py-2.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-black/[0.015] flex-wrap">
        <svg class="w-3 h-3 text-black/30 transition-transform group-open/ec:rotate-90 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
        <span class="text-[13px] font-bold text-ink-900">${escapeHtml(c.category)}</span>
        <span class="ml-auto flex items-center gap-3 text-[12px] tabular-nums">
          <span class="text-black/50">est ${money(c.estimated)}</span>
          <span class="font-semibold ${over ? "text-red-600" : "text-ink-900"}">actual ${money(c.actual)}</span>
          <span class="${over ? "text-red-600 font-bold" : "text-emerald-700"}">${over ? "over " + money(c.variance) : money(c.remaining) + " left"}</span>
        </span>
      </summary>
      <div class="bg-black/[0.012]">
        <div class="overflow-x-auto"><table class="w-full text-[12.5px]"><thead><tr class="text-[10px] font-bold uppercase tracking-wide text-black/40 border-b border-black/10"><th class="py-1.5 pl-6 text-left">Weekly cash-out</th><th class="py-1.5 px-2 text-right">Amount</th><th class="py-1.5 pl-2 pr-4 text-right">Status</th></tr></thead><tbody>${weekly || `<tr><td colspan="3" class="px-6 py-2 text-black/40 text-[12px]">No schedule — add dates + estimate.</td></tr>`}</tbody></table></div>
        ${expenseComplete ? "" : addBtn("expinst", c.category, "Add expense payment")}
        ${actuals}
      </div>
    </details>`;
  };

  // ── pending tray (bottom) ──
  const pendingTray = est.pending.length ? `
    <div class="card p-4 border-dashed">
      <div class="text-[10.5px] font-bold uppercase tracking-wide text-black/40 mb-2">Pending estimates — not yet billing</div>
      ${est.pending.map((e) => `<div class="flex items-center gap-2 py-1 text-[12.5px] border-b border-black/[0.05] last:border-0"><span class="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">Pending</span> Estimate <b class="text-blue-700">#${escapeHtml(e.doc || "—")}</b><span class="ml-auto tabular-nums">${money(e.value)}</span></div>`).join("")}
      <div class="text-[11px] text-black/40 mt-1.5">Becomes its own billing section automatically when accepted/converted in QuickBooks.</div>
    </div>` : "";

  const contribHtml = buildContribution(inv, crew, exp);

  container.innerHTML = `
    <div class="p-4 sm:p-5 space-y-4 max-w-5xl">

      <!-- meta bar -->
      <div class="card px-4 py-3 flex items-center gap-4 flex-wrap">
        <div>
          <div class="text-[16px] font-bold text-ink-900">${escapeHtml(p.name || "Project")}</div>
          <div class="flex gap-4 flex-wrap text-[12.5px] text-black/60 mt-1">
            <span>Contract <b class="tabular-nums text-ink-900">${money(est.contract_total)}</b></span>
            <span>Dates <b class="tabular-nums text-ink-900">${shortDate(p.start_date)} → ${shortDate(p.end_date)}</b></span>
            <span>Status <span class="inline-flex items-center text-[11px] font-bold px-2 py-0.5 rounded-full border ${stCls}">${stLabel}</span></span>
            ${p.books_closed ? `<span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-black/60 bg-black/[0.06] border border-black/15 px-2 py-0.5 rounded-full">🔒 Books closed</span>` : ""}
          </div>
        </div>
        <div class="ml-auto flex items-center gap-3 text-[11.5px] text-black/45">
          <button data-refresh class="text-[11.5px] font-bold text-black/60 bg-white border border-black/20 rounded-lg px-3 py-1.5 hover:border-black/40 hover:text-ink-900" title="Rebuild untouched schedules from the current estimates + dates, keeping your edits">↻ Refresh</button>
          <button data-rebuild class="text-[11px] text-black/40 hover:text-red-600 underline decoration-dotted" title="Discard all schedules and rebuild from scratch">rebuild all</button>
        </div>
      </div>

      ${banner}
      ${completePrompt}
      ${driftPrompt}
      ${needsDates}

      <!-- project roll-up -->
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-black/10 border border-black/10 rounded-xl overflow-hidden">
        ${kpi("Contract", est.contract_total)}
        ${kpi("Collected", est.collected, "text-emerald-700")}
        ${kpi("Open A/R", est.open_ar)}
        ${kpi("Crew paid", crewPaid, "text-black/60")}
        ${kpi("Crew left", crewLeft, "text-black/60")}
        ${kpi("Expenses", exp.estimate_total, "text-black/60")}
      </div>
      <div class="card p-4 sm:p-5">
        <div class="text-sm font-bold text-ink-900 mb-3">Cash summary — paid vs. expected</div>
        ${burnRow("Customer invoices", money(est.contract_total) + " · " + est.accepted.length + " estimate" + (est.accepted.length === 1 ? "" : "s"), invBar)}
        ${(() => { const nr = roll.rollups.filter((r) => !r.is_other).length; return burnRow("Crew payments", money(crewLaborEst) + " · " + nr + " rollup" + (nr === 1 ? "" : "s"), crewBar); })()}
        ${burnRow("Project expenses", money(exp.estimate_total) + " estimate", expBar)}
        <div class="flex gap-4 flex-wrap mt-3 pt-3 border-t border-black/10 text-[11px] text-black/55">
          <span class="inline-flex items-center gap-1.5"><i class="w-2.5 h-2.5 rounded-sm bg-emerald-700"></i>Paid / collected</span>
          <span class="inline-flex items-center gap-1.5"><i class="w-2.5 h-2.5 rounded-sm bg-ink-900"></i>Invoiced · spent</span>
          <span class="inline-flex items-center gap-1.5"><i class="w-2.5 h-2.5 rounded-sm bg-emerald-200"></i>Scheduled / left</span>
        </div>
      </div>

      <!-- INVOICES -->
      <details open class="group card overflow-hidden">
        <summary class="flex items-center gap-2 px-4 py-3 border-b border-black/10 bg-black/[0.02] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
          <svg class="w-3.5 h-3.5 text-black/30 transition-transform group-open:rotate-90 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
          <span class="text-sm font-bold text-ink-900">Customer invoices</span>
          <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">35 / 35 / 30 · net-30</span>
          <span class="ml-auto tabular-nums text-[13px] font-bold text-ink-900">${money(est.contract_total)}</span>
        </summary>
        <div class="p-3">
          ${est.accepted.map(invEstimateCard).join("") || `<div class="p-4 text-sm text-black/45">No accepted estimates yet.</div>`}
        </div>
      </details>

      <!-- CREW PAYMENTS -->
      <details open class="group card overflow-hidden">
        <summary class="flex items-center gap-2 px-4 py-3 border-b border-black/10 bg-black/[0.02] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
          <svg class="w-3.5 h-3.5 text-black/30 transition-transform group-open:rotate-90 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
          <span class="text-sm font-bold text-ink-900">Crew payments</span>
          <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full">rollup by crew · bi-weekly</span>
          <span class="ml-auto tabular-nums text-[13px] font-bold text-ink-900">${money(crewLaborEst)} labor</span>
        </summary>
        <div class="p-3">
          ${roll.rollups.map(rollupBlock).join("") || `<div class="p-4 text-sm text-black/45">No crew schedules yet — add assignment dates.</div>`}
          ${est.accepted.length ? `<div class="mt-1"><div class="text-[10.5px] font-bold uppercase tracking-wide text-black/40 px-1 mb-1">Crew assignment per estimate</div><div class="rounded-xl border border-black/10 overflow-hidden">${est.accepted.map(crewEstimateRow).join("")}</div></div>` : ""}
        </div>
        ${crewActuals}
      </details>

      <!-- EXPENSES -->
      <details open class="group card overflow-hidden">
        <summary class="flex items-center gap-2 px-4 py-3 border-b border-black/10 bg-black/[0.02] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
          <svg class="w-3.5 h-3.5 text-black/30 transition-transform group-open:rotate-90 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
          <span class="text-sm font-bold text-ink-900">Project expenses</span>
          <span class="text-[11.5px] text-black/45">estimated vs. actual by line item · weekly cash-out</span>
          <span class="ml-auto tabular-nums text-[12px] text-black/55">${money(exp.estimate_total)} est · ${money(exp.spent_qbo)} actual</span>
        </summary>
        ${(exp.by_category && exp.by_category.length) ? exp.by_category.map(expenseCat).join("") : `<div class="px-4 py-4 text-[12.5px] text-black/45">No estimate cost lines to plan from.</div>`}
      </details>

      ${pendingTray}
      ${contribHtml}
    </div>`;

  const post = async (url, label, btn) => {
    const orig = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = label; }
    try {
      const fresh = await api(url, { method: "POST" });
      render(container, entityId, fresh);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
      alert("Failed: " + (err?.message || "error"));
    }
  };

  container.querySelectorAll("[data-refresh]").forEach((b) =>
    b.addEventListener("click", (e) => post(`/billing/project/${encodeURIComponent(entityId)}/regenerate`, "↻ Refreshing…", e.currentTarget)));
  container.querySelector("[data-rebuild]")?.addEventListener("click", (e) => {
    if (!confirm("Discard ALL schedules (including your edits) and rebuild from the estimates + assignment dates?")) return;
    post(`/billing/project/${encodeURIComponent(entityId)}/regenerate?force=true`, "rebuilding…", e.currentTarget);
  });
  container.querySelector("[data-complete]")?.addEventListener("click", (e) => {
    if (!confirm("Mark this project complete? This closes the books — figures will reconcile to actual QuickBooks amounts.")) return;
    post(`/billing/project/${encodeURIComponent(entityId)}/mark-complete`, "Completing…", e.currentTarget);
  });

  const reload = async () => {
    const y = window.scrollY;
    try {
      const fresh = await api(`/billing/project/${encodeURIComponent(entityId)}`);
      render(container, entityId, fresh);
      window.scrollTo(0, y);
    } catch (_) {}
  };
  const root = container.firstElementChild; // replaced every render → no listener stacking

  root?.addEventListener("change", async (e) => {
    // per-estimate crew reassignment (the rollup key / split)
    const cr = e.target.closest("[data-assign-crew]");
    if (cr) {
      const eq = cr.getAttribute("data-eq");
      cr.disabled = true;
      try { await api(`/billing/project/${encodeURIComponent(entityId)}/estimate/${encodeURIComponent(eq)}/crew`, { method: "POST", body: JSON.stringify({ crew_id: cr.value ? Number(cr.value) : null }) }); await reload(); }
      catch (err) { cr.disabled = false; alert("Reassign failed: " + (err?.message || "error")); }
      return;
    }
    // inline field edits (invoice milestones / expense items)
    const el = e.target.closest("[data-edit]");
    if (!el) return;
    const kind = el.getAttribute("data-edit"), id = el.getAttribute("data-id"), field = el.getAttribute("data-field");
    let val = el.value;
    if (el.type === "number") val = val === "" ? null : Number(val);
    const url = { milestone: `/invoices/milestone/${id}`, installment: `/payments/installment/${id}`, item: `/expenses/item/${id}`, expinst: `/expenses/expense-installment/${id}` }[kind];
    if (!url) return;
    el.disabled = true;
    try { await api(url, { method: "PATCH", body: JSON.stringify({ [field]: val }) }); await reload(); }
    catch (err) { el.disabled = false; alert("Save failed: " + (err?.message || "error")); }
  });

  root?.addEventListener("click", async (e) => {
    const confirmEst = e.target.closest("[data-confirm-est]");
    if (confirmEst) {
      const eq = confirmEst.getAttribute("data-eq");
      post(`/billing/project/${encodeURIComponent(entityId)}/estimate/${encodeURIComponent(eq)}/confirm`, "Confirming…", confirmEst);
      return;
    }
    // browse crews (availability picker) for one estimate → assign on pick
    const browse = e.target.closest("[data-crew-browse]");
    if (browse) {
      const eq = browse.getAttribute("data-eq");
      openCrewRoster(entityId, p.start_date, p.end_date, async (crewId) => {
        try { await api(`/billing/project/${encodeURIComponent(entityId)}/estimate/${encodeURIComponent(eq)}/crew`, { method: "POST", body: JSON.stringify({ crew_id: crewId ? Number(crewId) : null }) }); await reload(); }
        catch (err) { alert("Reassign failed: " + (err?.message || "error")); }
      });
      return;
    }
    // record a sent offer as accepted (office-side)
    const oAccept = e.target.closest("[data-offer-accept]");
    if (oAccept) {
      oAccept.disabled = true;
      try { await api(`/offers/${oAccept.getAttribute("data-offer-accept")}/respond`, { method: "POST", body: JSON.stringify({ status: "accepted" }) }); await reload(); }
      catch (err) { oAccept.disabled = false; alert("Failed: " + (err?.message || "error")); }
      return;
    }
    const script = e.target.closest("[data-offer-script]");
    if (script) {
      const cid = script.getAttribute("data-crew");
      const g = roll.rollups.find((x) => String(x.crew_id) === String(cid));
      if (g) openOfferScriptModal(rollupScript(g, p.name));
      return;
    }
    const oSend = e.target.closest("[data-offer-send]");
    if (oSend) {
      const crewId = oSend.getAttribute("data-crew"), labor = oSend.getAttribute("data-labor");
      if (!crewId) { alert("Assign a crew first"); return; }
      oSend.disabled = true;
      try { await api(`/offers/project/${encodeURIComponent(entityId)}`, { method: "POST", body: JSON.stringify({ crew_id: Number(crewId), labor_amount: Number(labor || 0) }) }); await reload(); }
      catch (err) { oSend.disabled = false; alert("Send failed: " + (err?.message || "error")); }
      return;
    }
    const oWithdraw = e.target.closest("[data-offer-withdraw]");
    if (oWithdraw) {
      if (!confirm("Withdraw this crew offer?")) return;
      try { await api(`/offers/${oWithdraw.getAttribute("data-offer-withdraw")}/withdraw`, { method: "POST" }); await reload(); }
      catch (err) { alert("Withdraw failed: " + (err?.message || "error")); }
      return;
    }
    const add = e.target.closest("[data-add]");
    const del = e.target.closest("[data-del]");
    if (add) {
      const kind = add.getAttribute("data-add"), sid = add.getAttribute("data-sid");
      const url = { milestone: `/invoices/schedule/${sid}/milestone`, installment: `/payments/schedule/${sid}/installment`, item: `/expenses/project/${encodeURIComponent(entityId)}/item`, expinst: `/expenses/project/${encodeURIComponent(entityId)}/category/${encodeURIComponent(sid)}/installment` }[kind];
      if (!url) return;
      add.disabled = true;
      try { await api(url, { method: "POST", body: JSON.stringify({}) }); await reload(); }
      catch (err) { add.disabled = false; alert("Add failed: " + (err?.message || "error")); }
    } else if (del) {
      if (!confirm("Remove this row?")) return;
      const kind = del.getAttribute("data-del"), id = del.getAttribute("data-id");
      const url = { milestone: `/invoices/milestone/${id}`, installment: `/payments/installment/${id}`, item: `/expenses/item/${id}`, expinst: `/expenses/expense-installment/${id}` }[kind];
      if (!url) return;
      try { await api(url, { method: "DELETE" }); await reload(); }
      catch (err) { alert("Delete failed: " + (err?.message || "error")); }
    }
  });
}

// Scripted rollup crew offer — estimates + labor + total + payment schedule,
// ready to copy/email. Built from one crew rollup group.
function rollupScript(g, projectName) {
  const L = [];
  L.push(`Job offer — ${projectName || "Project"}`);
  if (g.crew_name) L.push(`Crew: ${g.crew_name}`);
  L.push("");
  L.push("Scope (contract labor by estimate):");
  (g.estimates || []).forEach((e) => L.push(`  Estimate #${e.doc}: ${money(e.labor)}`));
  L.push(`Total labor: ${money(g.labor)}`);
  L.push("");
  L.push("Payment schedule (bi-weekly, in arrears):");
  (g.installments || []).forEach((i) => L.push(`  ${shortDate(i.pay_date)}: ${money(i.amount)}`));
  return L.join("\n");
}

function openOfferScriptModal(text) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4";
  overlay.innerHTML = `<div class="bg-white rounded-2xl shadow-xl w-full max-w-lg p-5">
    <div class="text-base font-bold text-ink-900 mb-1">Crew job offer</div>
    <div class="text-[12px] text-black/50 mb-3">Copy this to send the crew — edit first if you like.</div>
    <textarea data-script class="w-full h-64 rounded-xl border border-black/15 p-3 text-[12.5px] tabular-nums" style="font-family:ui-monospace,Consolas,monospace">${escapeHtml(text)}</textarea>
    <div class="mt-3 flex items-center justify-end gap-2"><span data-msg class="text-xs font-semibold text-emerald-700 mr-auto"></span>
      <button data-close class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Close</button>
      <button data-copy class="btn-primary text-sm px-4 py-1.5">Copy</button></div></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("[data-close]").addEventListener("click", close);
  overlay.querySelector("[data-copy]").addEventListener("click", async () => {
    const ta = overlay.querySelector("[data-script]");
    try { await navigator.clipboard.writeText(ta.value); } catch (_) { ta.select(); document.execCommand("copy"); }
    overlay.querySelector("[data-msg]").textContent = "Copied to clipboard.";
  });
}

// Crew-availability slide-over — pick a crew from an informed panel (availability
// for the project dates + jobs done + $ paid, last 365 days), grouped by company.
function openCrewRoster(entityId, start, end, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "fixed inset-0 z-[100]";
  wrap.innerHTML = `<div data-backdrop class="absolute inset-0 bg-black/30"></div>
    <div class="absolute top-0 right-0 h-full w-full max-w-md bg-white shadow-xl overflow-y-auto">
      <div class="sticky top-0 bg-white border-b border-black/10 px-4 py-3 flex items-center justify-between z-10">
        <div><div class="text-sm font-bold text-ink-900">Work crews</div>
          <div class="text-[11px] text-black/45">${start && end ? "availability " + shortDate(start) + "–" + shortDate(end) + " · " : ""}jobs &amp; $ paid, last 365 days</div></div>
        <button data-close class="text-black/40 hover:text-black/70 text-lg leading-none">✕</button>
      </div>
      <div data-roster class="p-3 text-sm text-black/50">Loading…</div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector("[data-backdrop]").addEventListener("click", close);
  wrap.querySelector("[data-close]").addEventListener("click", close);
  (async () => {
    let d;
    try {
      const q = start && end ? `&start=${start.slice(0, 10)}&end=${end.slice(0, 10)}` : "";
      d = await api(`/offers/crew-roster?project_qbo_id=${encodeURIComponent(entityId)}${q}`);
    } catch (e) { wrap.querySelector("[data-roster]").innerHTML = `<div class="text-red-600 p-2">Failed to load crews.</div>`; return; }
    const byCo = {};
    (d.crews || []).forEach((c) => { (byCo[c.company || "—"] ||= []).push(c); });
    const badge = (a) => a === null ? "" : a
      ? `<span class="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">✓ free</span>`
      : `<span class="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">⚠ busy</span>`;
    wrap.querySelector("[data-roster]").innerHTML = Object.keys(byCo).sort().map((co) => {
      const list = byCo[co];
      return `<div class="mb-3">
        <div class="flex justify-between items-baseline px-2 py-1.5 bg-black/[0.03] rounded-lg mb-1">
          <span class="font-bold text-[13px] text-ink-900">${escapeHtml(co)}</span>
          <span class="text-[11px] text-black/50 tabular-nums">${money(list[0]?.earned_365 || 0)} · 365d</span></div>
        ${list.map((c) => `<button data-pick="${c.id}" data-name="${escapeHtml(c.name)}" class="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-blue-50">
          <span class="flex-1 font-semibold text-[13px]">${escapeHtml(c.name)}</span>
          <span class="text-[11px] text-black/45 tabular-nums">${c.jobs_365} job${c.jobs_365 === 1 ? "" : "s"}</span>${badge(c.available)}
        </button>`).join("")}
      </div>`;
    }).join("") || `<div class="text-black/40 p-2">No crews found.</div>`;
    wrap.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => { onPick(b.getAttribute("data-pick"), b.getAttribute("data-name")); close(); }));
  })();
}

// Build a compact weekly strip of upcoming unpaid cash (in green / out red).
function buildContribution(inv, crew, exp) {
  // Invoice cash in: the already-sent-but-unpaid (A/R) portion lands on the
  // invoice's DUE date; the not-yet-billed portion lands on its planned invoice
  // date. Partial milestones contribute to both.
  const inflow = [];
  inv.milestones.forEach((m) => {
    const ar = Math.max(0, (m.covered || 0) - (m.paid || 0));   // sent, awaiting payment
    const toBill = m.remaining != null ? m.remaining : (m.tier !== "realized" ? m.amount : 0);
    if (ar > 0.5 && m.due_date) inflow.push({ date: m.due_date.slice(0, 10), amt: ar });
    if (toBill > 0.5 && m.invoice_date) inflow.push({ date: m.invoice_date.slice(0, 10), amt: toBill });
  });
  const outflow = [
    ...crew.installments.filter((i) => i.tier !== "realized" && i.pay_date).map((i) => ({ date: i.pay_date.slice(0, 10), amt: i.amount })),
    ...exp.items.filter((i) => i.tier !== "realized" && i.expense_date).map((i) => ({ date: i.expense_date.slice(0, 10), amt: i.amount })),
  ];
  if (!inflow.length && !outflow.length) {
    return `<div class="card p-4 text-[13px] text-black/50">No upcoming scheduled cash — everything on this project is settled.</div>`;
  }
  // window: 10 weeks from the earliest unpaid date (or today, whichever is earlier)
  const all = [...inflow, ...outflow].map((x) => x.date).sort();
  const start = new Date(all[0] + "T00:00:00");
  start.setDate(start.getDate() - start.getDay() + 1); // Monday of that week
  const weeks = [];
  for (let i = 0; i < 10; i++) {
    const s = new Date(start); s.setDate(s.getDate() + i * 7);
    const e = new Date(s); e.setDate(e.getDate() + 6);
    weeks.push({ s, e, in: 0, out: 0 });
  }
  const place = (arr, key) => arr.forEach((x) => {
    const dt = new Date(x.date + "T00:00:00");
    const w = weeks.find((w) => dt >= w.s && dt <= w.e);
    if (w) w[key] += x.amt;
  });
  place(inflow, "in"); place(outflow, "out");
  let beyondIn = 0, beyondOut = 0;
  const lastEnd = weeks[weeks.length - 1].e;
  inflow.forEach((x) => { if (new Date(x.date + "T00:00:00") > lastEnd) beyondIn += x.amt; });
  outflow.forEach((x) => { if (new Date(x.date + "T00:00:00") > lastEnd) beyondOut += x.amt; });
  // scale to the tallest STACK (in + out), so stacked bars never overflow upward
  const max = Math.max(1, ...weeks.map((w) => w.in + w.out));
  const H = 90;
  const cols = weeks.map((w) => {
    const hi = w.in > 0 ? Math.max(4, Math.round((w.in / max) * H)) : 0;
    const ho = w.out > 0 ? Math.max(4, Math.round((w.out / max) * H)) : 0;
    const inbar = hi ? `<div class="absolute left-[22%] right-[22%] rounded-t bg-emerald-500" style="height:${hi}px;bottom:0" title="in ${money(w.in)}"></div>` : "";
    const outbar = ho ? `<div class="absolute left-[22%] right-[22%] rounded-t bg-red-500/90" style="height:${ho}px;bottom:${hi}px" title="out ${money(w.out)}"></div>` : "";
    return `<div class="flex-1 flex flex-col items-center min-w-0">
      <div class="relative w-full border-b-2 border-black/15 overflow-hidden" style="height:${H + 4}px">${inbar}${outbar}</div>
      <div class="text-[10px] text-black/40 mt-1.5 tabular-nums">${w.s.getMonth() + 1}/${w.s.getDate()}</div>
    </div>`;
  }).join("");
  const beyondChip = (beyondIn || beyondOut) ? `
    <div class="self-center ml-2 text-[11px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5 whitespace-nowrap">
      → later:${beyondIn ? " +" + money(beyondIn) : ""}${beyondOut ? " −" + money(beyondOut) : ""}</div>` : "";

  return `
    <div class="card p-4 sm:p-5">
      <div class="text-sm font-bold text-ink-900">This project's contribution to the cash forecast</div>
      <div class="text-[12.5px] text-black/55 mb-2">Upcoming unpaid cash that rolls up into the company forecast — in green, out red, on their cash dates.</div>
      <div class="flex items-end gap-1.5">
        <div class="flex-1 flex items-stretch gap-1.5">${cols}</div>
        ${beyondChip}
      </div>
      <div class="flex gap-4 mt-3 text-[11.5px] text-black/55">
        <span class="inline-flex items-center gap-1.5"><i class="w-2.5 h-2.5 rounded-sm bg-emerald-500"></i>Cash in (invoices)</span>
        <span class="inline-flex items-center gap-1.5"><i class="w-2.5 h-2.5 rounded-sm bg-red-500/90"></i>Cash out (crew + expenses)</span>
      </div>
    </div>`;
}
