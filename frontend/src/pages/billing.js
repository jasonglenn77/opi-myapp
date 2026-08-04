// Billing & Schedule panel (Projects hub Phase 3a).
// Renders a project's full cash picture from /api/billing/project/{id}: the
// auto-generated invoice / crew / expense schedules, each burned down against
// QuickBooks actuals and tiered (realized / committed / scheduled / estimated),
// plus the anatomy KPIs + paid-vs-expected burn bars + a contribution strip.
// Tables are inline-editable (dates, amounts, labels; add/remove rows); the crew
// job-offer flow stays in an "advanced" disclosure until it's fully integrated.
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";

const money = (n) => (n == null || n === "" ? "—" : "$" + Math.round(Number(n)).toLocaleString("en-US"));
const money2 = (n) => (n == null || n === "" ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }));

// ── confidence encoding ─────────────────────────────────────────────────────
const DOT = {
  realized:  '<span class="inline-block w-2.5 h-2.5 rounded-full bg-ink-900 align-middle"></span>',
  committed: '<span class="inline-block w-2.5 h-2.5 rounded-full bg-ink-900 align-middle"></span>',
  scheduled: '<span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 align-middle"></span>',
  estimated: '<span class="inline-block w-2.5 h-2.5 rounded-full border-[1.5px] border-black/40 align-middle"></span>',
};
const PILL = {
  Paid:          "text-emerald-700 bg-emerald-50 border border-emerald-200",
  "Sent · A/R":  "text-ink-900 bg-black/[0.06] border border-black/15",
  "Bill · A/P":  "text-ink-900 bg-black/[0.06] border border-black/15",
  Scheduled:     "text-emerald-700 bg-transparent border border-emerald-300",
  Allocated:     "text-black/45 bg-transparent border border-black/15",
};
function pill(label) {
  return `<span class="inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${PILL[label] || PILL.Allocated}">${escapeHtml(label)}</span>`;
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
  complete:      ["Complete", "text-emerald-700 bg-emerald-50 border-emerald-200"],
  in_progress:   ["In progress", "text-emerald-700 bg-emerald-50 border-emerald-200"],
  scheduled:     ["Scheduled", "text-blue-700 bg-blue-50 border-blue-200"],
  needs_dates:   ["Needs dates", "text-amber-800 bg-amber-50 border-amber-300"],
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
  const p = d.project, inv = d.invoices, crew = d.crew, exp = d.expenses, k = d.kpis;
  const [stLabel, stCls] = STATUS_PILL[p.operational_status] || STATUS_PILL.scheduled;

  const kpi = (label, val, cls = "") =>
    `<div class="px-4 py-3 bg-white">
       <div class="text-[10.5px] font-bold uppercase tracking-wide text-black/40 mb-1">${label}</div>
       <div class="text-lg font-bold tabular-nums ${cls}">${money(val)}</div>
     </div>`;

  // ── burn bars ──
  const invBar = burnBar([
    { v: inv.summary.paid, cls: SEG.realized, label: money(inv.summary.paid) + " paid", title: "Collected" },
    { v: inv.summary.ar, cls: SEG.committed, label: money(inv.summary.ar) + " A/R", title: "Invoiced, unpaid" },
    { v: inv.summary.scheduled, cls: SEG.scheduled, label: money(inv.summary.scheduled) + " to bill", title: "Not yet invoiced" },
  ]);
  // Crew bar always shows the estimate as the reference: paid + remaining
  // (scheduled while open, or under/over vs estimate once closed).
  const crewEst = crew.estimate_total || crew.summary.total || 0;
  const crewPaid = crew.summary.paid;
  const crewBar = burnBar(
    p.books_closed
      ? (crewPaid > crewEst + 0.5
          ? [
              { v: crewEst, cls: SEG.realized, label: money(crewEst) + " est. paid", title: "Paid up to the estimate" },
              { v: crewPaid - crewEst, cls: "bg-red-600 text-white", label: money(crewPaid - crewEst) + " over", title: "Paid beyond the estimate" },
            ]
          : [
              { v: crewPaid, cls: SEG.realized, label: money(crewPaid) + " paid", title: "Paid to crew" },
              { v: Math.max(0, crewEst - crewPaid), cls: SEG.estimated, label: money(crewEst - crewPaid) + " under", title: "Came in under the estimate" },
            ])
      : [
          { v: crewPaid, cls: SEG.realized, label: money(crewPaid) + " paid", title: "Paid to crew" },
          { v: crew.summary.scheduled, cls: SEG.scheduled, label: money(crew.summary.scheduled) + " scheduled", title: "Remaining" },
        ]);
  const expOver = exp.summary.over || 0;
  const expBar = expOver > 0
    ? burnBar([
        { v: Math.max(0, exp.summary.total - 0), cls: SEG.committed, label: money(exp.summary.total) + " est. spent", title: "Spent up to the estimate" },
        { v: expOver, cls: "bg-red-600 text-white", label: money(expOver) + " over", title: "Spent beyond the estimate" },
      ])
    : burnBar([
        { v: exp.summary.committed, cls: SEG.committed, label: money(exp.summary.committed) + " spent", title: "Spent to date (QBO)" },
        { v: exp.summary.allocated, cls: SEG.estimated, label: money(exp.summary.allocated) + " allocated", title: "Estimated, not yet spent" },
      ]);

  // variance chip shown when the project is closed (estimate vs actual)
  const varChip = (v) => {
    if (!p.books_closed || !v) return "";
    const over = v > 0;
    return `<span class="ml-2 inline-flex items-center text-[10.5px] font-bold px-1.5 py-0.5 rounded ${over ? "text-red-700 bg-red-50 border border-red-200" : "text-emerald-700 bg-emerald-50 border border-emerald-200"}">${over ? "+" : "−"}${money(Math.abs(v))} vs est</span>`;
  };

  const burnRow = (name, sub, bar, variance) => `
    <div class="mb-4 last:mb-0">
      <div class="flex justify-between items-baseline mb-1.5">
        <span class="text-[13px] font-bold text-ink-900">${escapeHtml(name)}${varChip(variance)}</span>
        <span class="tabular-nums text-[12px] text-black/55">${escapeHtml(sub)}</span>
      </div>
      ${bar}
    </div>`;

  // ── schedule tables (inline-editable: dates, amounts, labels; status auto) ──
  const invRows = inv.milestones.map((m) => `
    <tr class="border-b border-black/5">
      <td class="py-1 pl-4 pr-3"><span class="flex items-center gap-2">${DOT[m.tier]}${eInput("milestone", m.id, "label", m.label || "Milestone", "text", "font-semibold min-w-[8rem]")}</span></td>
      <td class="py-1 px-2 tabular-nums text-black/50 whitespace-nowrap">${m.pct ? m.pct + "%" : "—"}</td>
      <td class="py-1 px-2">${eInput("milestone", m.id, "invoice_date", m.invoice_date, "date")}</td>
      <td class="py-1 px-2">${eInput("milestone", m.id, "due_date", m.due_date, "date")}</td>
      <td class="py-1 px-2 text-right">${eInput("milestone", m.id, "amount", Math.round(m.amount), "number", "ml-auto")}</td>
      <td class="py-1 pl-2 pr-4 text-right whitespace-nowrap">${pill(m.status_label)}${editedChip(m.edited)}${delBtn("milestone", m.id)}</td>
    </tr>`).join("");

  // crew grouped by estimate (change-orders show under their own sub-header)
  const multiCrew = (crew.schedules || []).length > 1;
  const crewRows = (crew.schedules || []).map((s) => {
    const header = multiCrew ? `
      <tr class="bg-black/[0.02]"><td colspan="4" class="py-1.5 px-4 text-[11px] font-bold text-black/50">
        ${s.estimate_doc_number ? "Estimate #" + escapeHtml(s.estimate_doc_number) : "Estimate"}${s.crew_name ? " · " + escapeHtml(s.crew_name) : ""} · <span class="tabular-nums">${money(s.subtotal)}</span>
      </td></tr>` : "";
    const rows = s.installments.map((i) => `
      <tr class="border-b border-black/5">
        <td class="py-1 pl-4 pr-3"><span class="flex items-center gap-2">${DOT[i.tier]}${eInput("installment", i.id, "note", i.note || "Payment", "text", "font-semibold min-w-[7rem]")}</span></td>
        <td class="py-1 px-2">${eInput("installment", i.id, "pay_date", i.pay_date, "date")}</td>
        <td class="py-1 px-2 text-right">${eInput("installment", i.id, "amount", Math.round(i.amount), "number", "ml-auto")}</td>
        <td class="py-1 pl-2 pr-4 text-right whitespace-nowrap">${pill(i.status_label)}${editedChip(i.edited)}${delBtn("installment", i.id)}</td>
      </tr>`).join("");
    const addRow = `<tr><td colspan="4" class="px-4 py-1.5"><button data-add="installment" data-sid="${s.schedule_id}" class="text-[11.5px] font-semibold text-blue-600 hover:underline">+ Add payment</button></td></tr>`;
    return header + rows + addRow;
  }).join("");

  const expRows = exp.items.map((i) => `
    <tr class="border-b border-black/5">
      <td class="py-1 pl-4 pr-3"><span class="flex items-center gap-2">${DOT[i.tier]}${eSelect("item", i.id, "category", i.category || "Other", exp.categories)}</span></td>
      <td class="py-1 px-2">${eInput("item", i.id, "description", i.description || "", "text", "min-w-[9rem]")}</td>
      <td class="py-1 px-2">${eInput("item", i.id, "expense_date", i.expense_date, "date")}</td>
      <td class="py-1 px-2 text-right">${eInput("item", i.id, "amount", Math.round(i.amount), "number", "ml-auto")}</td>
      <td class="py-1 pl-2 pr-4 text-right whitespace-nowrap">${pill(i.status_label)}${editedChip(i.edited)}${delBtn("item", i.id)}</td>
    </tr>`).join("");

  const tableCard = (title, sub, headHtml, rowsHtml, emptyMsg, addHtml = "", preHtml = "") => `
    <details open class="group card overflow-hidden mb-4">
      <summary class="flex items-center gap-2 px-4 py-3 border-b border-black/10 bg-black/[0.02] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
        <svg class="w-3.5 h-3.5 text-black/30 transition-transform group-open:rotate-90 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
        <span class="text-sm font-bold text-ink-900">${escapeHtml(title)}</span>
        <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">◆ Auto</span>
        <span class="ml-auto tabular-nums text-[12px] text-black/55">${escapeHtml(sub)}</span>
      </summary>
      ${preHtml}
      ${rowsHtml
        ? `<div class="overflow-x-auto"><table class="w-full text-[12.5px]"><thead><tr class="text-[10px] font-bold uppercase tracking-wide text-black/40 border-b border-black/10">${headHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`
        : `<div class="px-4 py-6 text-sm text-black/45">${escapeHtml(emptyMsg || "Nothing scheduled.")}</div>`}
      ${rowsHtml ? addHtml : ""}
    </details>`;

  const th = (cols) => cols.map((c, i) => {
    const pad = i === 0 ? "pl-4 pr-3" : i === cols.length - 1 ? "pl-2 pr-4" : "px-2";
    return `<th class="py-2 ${pad} ${c.r ? "text-right" : "text-left"} font-bold">${c.t}</th>`;
  }).join("");

  // ── crew job-offer bar (surfaced in the crew section) ──
  const crews = d.crews || [];
  const offer = crew.offer || {};
  const offerBar = (() => {
    if (offer.accepted) {
      return `<div class="px-4 py-2.5 bg-emerald-50 border-b border-emerald-200 text-[12.5px] text-emerald-900 flex items-center gap-2">
        <b>✓ Crew accepted</b> — ${escapeHtml(offer.accepted.crew_name || "crew")} · <span class="tabular-nums">${money(offer.accepted.labor_amount)}</span></div>`;
    }
    const cur = offer.current;
    if (cur && cur.status === "sent") {
      return `<div class="px-4 py-2.5 bg-blue-50 border-b border-blue-200 text-[12.5px] text-blue-900 flex items-center gap-3">
        <span><b>Offer sent</b> to ${escapeHtml(cur.crew_name || "crew")} · <span class="tabular-nums">${money(cur.labor_amount)}</span> — awaiting response</span>
        <button data-offer-withdraw="${cur.id}" class="ml-auto text-[11.5px] font-semibold text-blue-700 hover:underline">Withdraw</button></div>`;
    }
    return `<div class="px-4 py-2.5 border-b border-black/[0.06] bg-black/[0.01] text-[12.5px] flex items-center gap-2 flex-wrap">
      <span class="font-semibold text-black/55">Crew job offer:</span>
      <select data-offer-crew class="${EDIT_BASE} border-black/15">${crews.map((c) => `<option value="${c.id}">${escapeHtml((c.parent_name ? c.parent_name + " — " : "") + c.name)}</option>`).join("")}</select>
      <button data-crew-browse class="text-[11.5px] font-semibold text-blue-600 hover:underline">Browse crews →</button>
      <span class="text-black/50">Labor</span>
      <input data-offer-labor type="number" value="${Math.round(offer.suggested_labor || crew.summary.total || 0)}" class="${EDIT_BASE} border-black/15 w-[7rem] text-right tabular-nums">
      <button data-offer-send class="text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-3 py-1">Send offer</button>
    </div>`;
  })();

  // ── actuals from QuickBooks (plan vs. actual), collapsible ──
  const actualsBlock = (title, count, innerHtml) => `
    <details class="group/act border-t border-black/[0.06] bg-black/[0.012]">
      <summary class="px-4 py-2.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wide text-black/40 hover:text-black/60">
        <svg class="w-3 h-3 transition-transform group-open/act:rotate-90" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
        ${escapeHtml(title)} <span class="text-black/30">(${count})</span>
      </summary>
      <div class="px-4 pb-3 overflow-x-auto">${innerHtml}</div>
    </details>`;

  const invActuals = (inv.actuals && inv.actuals.length)
    ? actualsBlock("Actual invoices in QuickBooks", inv.actuals.length,
        `<table class="w-full text-[12px]"><thead><tr class="text-[10px] text-black/40 text-left"><th class="pb-1 font-bold">Invoice #</th><th class="font-bold">Estimate</th><th class="font-bold">Date</th><th class="font-bold">Due</th><th class="text-right font-bold">Amount</th><th class="text-right font-bold">Status</th></tr></thead>
         <tbody>${inv.actuals.map((a) => `<tr class="border-t border-black/[0.05]">
           <td class="py-1.5 tabular-nums font-semibold">${escapeHtml(a.doc_number || "—")}</td>
           <td class="py-1.5 tabular-nums text-black/60">${a.estimate_doc ? "#" + escapeHtml(a.estimate_doc) : "—"}</td>
           <td class="py-1.5 tabular-nums text-black/60">${shortDate(a.txn_date)}</td>
           <td class="py-1.5 tabular-nums text-black/60">${shortDate(a.due_date)}</td>
           <td class="py-1.5 text-right tabular-nums font-semibold">${money(a.amount)}</td>
           <td class="py-1.5 text-right">${pill(a.status === "Paid" ? "Paid" : "Sent · A/R")}</td></tr>`).join("")}</tbody></table>`)
    : `<div class="px-4 py-2.5 text-[12px] text-black/40 border-t border-black/[0.06]">No invoices in QuickBooks yet — the schedule above is the plan.</div>`;

  const expActuals = (exp.actuals && exp.actuals.length)
    ? actualsBlock("Actual expenses in QuickBooks", exp.actuals.length, (() => {
        const byCat = {};
        exp.actuals.forEach((a) => { (byCat[a.category || "Other"] ||= []).push(a); });
        return Object.keys(byCat).sort().map((cat) => {
          const rows = byCat[cat];
          const sub = rows.reduce((s, a) => s + a.amount, 0);
          return `<div class="mb-2.5">
            <div class="flex justify-between items-baseline text-[11px] font-bold text-ink-900 border-b border-black/10 pb-1 mb-1"><span>${escapeHtml(cat)}</span><span class="tabular-nums text-black/55">${money(sub)}</span></div>
            <table class="w-full text-[12px]"><tbody>${rows.map((a) => `<tr class="border-b border-black/[0.04]">
              <td class="py-1 pr-3 font-semibold">${escapeHtml(a.vendor || "—")}</td>
              <td class="py-1 pr-3 text-black/50">${escapeHtml(a.source_item || a.type || "")}</td>
              <td class="py-1 pr-3 tabular-nums text-black/60">${shortDate(a.date)}</td>
              <td class="py-1 text-right tabular-nums font-semibold">${money(a.amount)}</td></tr>`).join("")}</tbody></table>
          </div>`;
        }).join("");
      })())
    : `<div class="px-4 py-2.5 text-[12px] text-black/40 border-t border-black/[0.06]">No project expenses recorded in QuickBooks yet.</div>`;

  // ── banners ──
  const needsDates = !p.has_dates ? `
    <div class="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 mb-4 flex items-center gap-3">
      <span class="w-6 h-6 rounded-md bg-amber-500 text-white flex items-center justify-center font-extrabold">!</span>
      <div class="text-[13px] text-amber-900"><b>No assignment dates yet.</b> Add a start/end on the <b>Assignment</b> tab and the crew &amp; invoice schedules will generate automatically.</div>
    </div>` : "";

  // "Looks complete" review prompt — office confirms (never auto-closed).
  const completePrompt = p.appears_complete ? `
    <div class="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 mb-4 flex items-center gap-3">
      <span class="w-6 h-6 rounded-md bg-emerald-600 text-white flex items-center justify-center font-extrabold">✓</span>
      <div class="text-[13px] text-emerald-900 flex-1"><b>This project looks complete</b> — every invoice is billed and paid. Review, then mark it complete to close the books.</div>
      <button data-complete class="text-[12px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg px-3 py-1.5 whitespace-nowrap">Mark complete</button>
    </div>` : "";

  // Drift — schedule fell out of sync with current dates/estimate.
  const driftPrompt = (p.drift && p.drift.length) ? `
    <div class="rounded-xl border border-blue-300 bg-blue-50 px-4 py-3 mb-4 flex items-center gap-3">
      <span class="w-6 h-6 rounded-md bg-blue-600 text-white flex items-center justify-center font-extrabold">↻</span>
      <div class="text-[13px] text-blue-900 flex-1"><b>Schedule is out of date.</b> ${p.drift.map(escapeHtml).join("; ")}. Refresh to rebuild the untouched schedules (your edits are kept).</div>
      <button data-refresh class="text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-3 py-1.5 whitespace-nowrap">↻ Refresh now</button>
    </div>` : "";

  // ── contribution strip (upcoming unpaid cash, by week) ──
  const contribHtml = buildContribution(inv, crew, exp);

  container.innerHTML = `
    <div class="p-4 sm:p-5 space-y-4 max-w-5xl">

      <!-- meta bar -->
      <div class="card px-4 py-3 flex items-center gap-4 flex-wrap">
        <div>
          <div class="text-[16px] font-bold text-ink-900">${escapeHtml(p.name || "Project")}</div>
          <div class="flex gap-4 flex-wrap text-[12.5px] text-black/60 mt-1">
            <span>Contract <b class="tabular-nums text-ink-900">${money(p.contract_value)}</b></span>
            <span>Dates <b class="tabular-nums text-ink-900">${shortDate(p.start_date)} → ${shortDate(p.end_date)}</b></span>
            <span>Status <span class="inline-flex items-center text-[11px] font-bold px-2 py-0.5 rounded-full border ${stCls}">${stLabel}</span></span>
          </div>
        </div>
        <div class="ml-auto flex items-center gap-3 text-[11.5px] text-black/45">
          <span class="inline-flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">◆ Auto-generated</span>
          <span class="hidden sm:inline">from estimate + assignment dates</span>
          <button data-refresh class="text-[11.5px] font-bold text-black/60 bg-white border border-black/20 rounded-lg px-3 py-1.5 hover:border-black/40 hover:text-ink-900 inline-flex items-center gap-1.5" title="Rebuild untouched schedules from the current estimate + dates, keeping your edits">↻ Refresh</button>
          <button data-rebuild class="text-[11px] text-black/40 hover:text-red-600 underline decoration-dotted" title="Discard all schedules and rebuild from scratch">rebuild all</button>
        </div>
      </div>

      ${completePrompt}
      ${driftPrompt}
      ${needsDates}

      <!-- KPI strip -->
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-black/10 border border-black/10 rounded-xl overflow-hidden">
        ${kpi("Contract", k.contract)}
        ${kpi("Collected", k.collected, "text-emerald-700")}
        ${kpi("Open A/R", k.open_ar)}
        ${kpi("Unbilled", k.unbilled, "text-black/60")}
        ${kpi("Crew left", k.crew_left, "text-black/60")}
        ${kpi("Expenses left", k.expenses_left, "text-black/60")}
      </div>

      <!-- cash summary burn bars -->
      <div class="card p-4 sm:p-5">
        <div class="flex items-center gap-2 mb-3">
          <span class="text-sm font-bold text-ink-900">Cash summary — paid vs. expected</span>
          ${p.books_closed ? `<span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-black/60 bg-black/[0.06] border border-black/15 px-2 py-0.5 rounded-full" title="Project complete — figures reconciled to actual QuickBooks amounts, estimate shown as variance">🔒 Books closed · actuals</span>` : ""}
        </div>
        ${burnRow("Customer invoices", (p.books_closed ? money(inv.invoiced_qbo) + " invoiced" : money(inv.summary.total) + " · 35 / 35 / 30, net-30"), invBar, inv.variance)}
        ${burnRow("Crew payments", money(crew.paid_qbo) + " paid / " + money(crewEst) + " est" + (crew.crew_name ? " · " + crew.crew_name : "") + " · bi-weekly", crewBar, crew.variance)}
        ${burnRow("Project expenses", money(exp.summary.total) + " estimate" + (exp.spent_qbo ? " · " + money(exp.spent_qbo) + " spent (QBO)" : ""), expBar, exp.variance)}
        <div class="flex gap-4 flex-wrap mt-3 pt-3 border-t border-black/10 text-[11px] text-black/55">
          <span class="inline-flex items-center gap-1.5"><i class="w-2.5 h-2.5 rounded-sm bg-emerald-700"></i>Realized (in bank)</span>
          <span class="inline-flex items-center gap-1.5"><i class="w-2.5 h-2.5 rounded-sm bg-ink-900"></i>Committed (A/R, A/P)</span>
          <span class="inline-flex items-center gap-1.5"><i class="w-2.5 h-2.5 rounded-sm bg-emerald-200"></i>Scheduled</span>
          <span class="inline-flex items-center gap-1.5"><i class="w-2.5 h-2.5 rounded-sm border border-black/20 [background-image:repeating-linear-gradient(135deg,transparent,transparent_3px,rgba(0,0,0,.12)_3px,rgba(0,0,0,.12)_4px)]"></i>Estimated</span>
        </div>
      </div>

      <!-- schedules -->
      ${tableCard("Customer invoices", money(inv.summary.total) + " · net-30",
        th([{ t: "Milestone" }, { t: "%" }, { t: "Invoice" }, { t: "Due" }, { t: "Amount", r: 1 }, { t: "Status", r: 1 }]),
        invRows, "Add a contract value on the estimate to generate invoices.",
        (inv.schedule_id ? addBtn("milestone", inv.schedule_id, "Add invoice milestone") : "") + invActuals)}

      ${tableCard("Crew payments", (crew.crew_name || "Crew") + " · " + money(crew.summary.total),
        th([{ t: "Payment" }, { t: "Pay date" }, { t: "Amount", r: 1 }, { t: "Status", r: 1 }]),
        crewRows, "Add assignment dates to generate the bi-weekly schedule.", "",
        offerBar + ((crew.schedules && crew.schedules.length) ? `<div class="px-4 py-1.5 border-b border-black/[0.06] text-[11.5px]"><button data-offer-script class="font-semibold text-blue-600 hover:underline">📋 Offer script</button><span class="text-black/40 ml-2">estimate amounts + payment schedule, ready to copy / email</span></div>` : ""))}

      ${tableCard("Project expenses", money(exp.summary.total) + " estimate",
        th([{ t: "Category" }, { t: "Description" }, { t: "Date" }, { t: "Amount", r: 1 }, { t: "Status", r: 1 }]),
        expRows, "No estimate cost lines to plan from.",
        addBtn("item", null, "Add expense") + expActuals)}

      <!-- contribution -->
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

  // Refresh — edit-preserving (both the meta-bar button and the drift banner).
  container.querySelectorAll("[data-refresh]").forEach((b) =>
    b.addEventListener("click", (e) => post(`/billing/project/${encodeURIComponent(entityId)}/regenerate`, "↻ Refreshing…", e.currentTarget)));

  // Rebuild all — discards edits (confirm).
  container.querySelector("[data-rebuild]")?.addEventListener("click", (e) => {
    if (!confirm("Discard ALL schedules (including your edits) and rebuild from the estimate + assignment dates?")) return;
    post(`/billing/project/${encodeURIComponent(entityId)}/regenerate?force=true`, "rebuilding…", e.currentTarget);
  });

  // Mark complete — office confirms the project is done.
  container.querySelector("[data-complete]")?.addEventListener("click", (e) => {
    if (!confirm("Mark this project complete? This closes the books — figures will reconcile to actual QuickBooks amounts.")) return;
    post(`/billing/project/${encodeURIComponent(entityId)}/mark-complete`, "Completing…", e.currentTarget);
  });

  // ── inline editing: patch a field on change, then reload the bundle ──
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
    const el = e.target.closest("[data-edit]");
    if (!el) return;
    const kind = el.getAttribute("data-edit"), id = el.getAttribute("data-id"), field = el.getAttribute("data-field");
    let val = el.value;
    if (el.type === "number") val = val === "" ? null : Number(val);
    const url = { milestone: `/invoices/milestone/${id}`, installment: `/payments/installment/${id}`, item: `/expenses/item/${id}` }[kind];
    if (!url) return;
    el.disabled = true;
    try { await api(url, { method: "PATCH", body: JSON.stringify({ [field]: val }) }); await reload(); }
    catch (err) { el.disabled = false; alert("Save failed: " + (err?.message || "error")); }
  });
  root?.addEventListener("click", async (e) => {
    // crew job offer
    const browse = e.target.closest("[data-crew-browse]");
    if (browse) {
      openCrewRoster(entityId, p.start_date, p.end_date, (id) => {
        const sel = root.querySelector("[data-offer-crew]");
        if (sel) sel.value = id;
      });
      return;
    }
    const script = e.target.closest("[data-offer-script]");
    if (script) { openOfferScriptModal(offerScript(crew, p.name)); return; }
    const oSend = e.target.closest("[data-offer-send]");
    if (oSend) {
      const crewId = root.querySelector("[data-offer-crew]")?.value;
      const labor = root.querySelector("[data-offer-labor]")?.value;
      if (!crewId) { alert("Pick a crew"); return; }
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
      const url = { milestone: `/invoices/schedule/${sid}/milestone`, installment: `/payments/schedule/${sid}/installment`, item: `/expenses/project/${encodeURIComponent(entityId)}/item` }[kind];
      if (!url) return;
      add.disabled = true;
      try { await api(url, { method: "POST", body: JSON.stringify({}) }); await reload(); }
      catch (err) { add.disabled = false; alert("Add failed: " + (err?.message || "error")); }
    } else if (del) {
      if (!confirm("Remove this row?")) return;
      const kind = del.getAttribute("data-del"), id = del.getAttribute("data-id");
      const url = { milestone: `/invoices/milestone/${id}`, installment: `/payments/installment/${id}`, item: `/expenses/item/${id}` }[kind];
      if (!url) return;
      try { await api(url, { method: "DELETE" }); await reload(); }
      catch (err) { alert("Delete failed: " + (err?.message || "error")); }
    }
  });
}

// Scripted crew job offer — estimate amounts + total + payment schedule, ready
// to copy/email. Built from the per-estimate schedules + summed installments.
function offerScript(crew, projectName) {
  const L = [];
  L.push(`Job offer — ${projectName || "Project"}`);
  if (crew.crew_name) L.push(`Crew: ${crew.crew_name}`);
  L.push("");
  L.push("Scope (contract labor by estimate):");
  (crew.schedules || []).forEach((s) => {
    const est = s.estimate_doc_number ? `Estimate #${s.estimate_doc_number}` : "Estimate";
    L.push(`  ${est}: ${money(s.contract_labor || s.subtotal || 0)}`);
  });
  L.push(`Total labor: ${money(crew.summary.total)}`);
  L.push("");
  L.push("Payment schedule (bi-weekly, in arrears):");
  const byDate = {};
  (crew.installments || []).forEach((i) => { if (i.pay_date) byDate[i.pay_date] = (byDate[i.pay_date] || 0) + i.amount; });
  Object.keys(byDate).sort().forEach((d) => L.push(`  ${shortDate(d)}: ${money(byDate[d])}`));
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
  const inflow = inv.milestones.filter((m) => m.tier !== "realized" && m.due_date)
    .map((m) => ({ date: m.due_date.slice(0, 10), amt: m.amount }));
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
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.in, w.out)));
  const H = 90;
  const cols = weeks.map((w) => {
    const hi = w.in > 0 ? Math.max(4, Math.round((w.in / max) * H)) : 0;
    const ho = w.out > 0 ? Math.max(4, Math.round((w.out / max) * H)) : 0;
    const inbar = hi ? `<div class="absolute left-[22%] right-[22%] rounded-t bg-emerald-500" style="height:${hi}px;bottom:0" title="in ${money(w.in)}"></div>` : "";
    const outbar = ho ? `<div class="absolute left-[22%] right-[22%] rounded-t bg-red-500/90" style="height:${ho}px;bottom:${hi}px" title="out ${money(w.out)}"></div>` : "";
    return `<div class="flex-1 flex flex-col items-center min-w-0">
      <div class="relative w-full border-b-2 border-black/15" style="height:${H + 4}px">${inbar}${outbar}</div>
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
