// Billing & Schedule panel — reorganized around the ESTIMATE (Slice 2).
// From /api/billing/project/{id}: a project roll-up, then one invoice schedule
// per estimate (35/35/30, needs-review until confirmed), crew payments grouped
// into per-crew rollups (single lump per pay date; reassigning an estimate's
// crew splits the rollup), a pending-estimate tray, and shared project expenses
// (est-vs-actual by category + a weekly cash-out schedule).
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";
import { mountConsistencyChip } from "../utils/crew-consistency.js";
import { timeOffRangeLabel } from "../utils/crew-editor.js";
import { openDocViewer, DOC_ICON } from "../utils/doc-viewer.js";

const money = (n) => (n == null || n === "" ? "—" : "$" + Math.round(Number(n)).toLocaleString("en-US"));
const money2 = (n) => (n == null || n === "" ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }));

// ── confidence encoding ─────────────────────────────────────────────────────
const DOT = {
  realized:  '<span class="inline-block w-2.5 h-2.5 rounded-full bg-ink-900 align-middle"></span>',
  committed: '<span class="inline-block w-2.5 h-2.5 rounded-full bg-ink-900 align-middle"></span>',
  partial:   '<span class="inline-block w-2.5 h-2.5 rounded-full bg-amber-500 align-middle"></span>',
  scheduled: '<span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 align-middle"></span>',
  retainage: '<span class="inline-block w-2.5 h-2.5 rounded-full align-middle bl-ret-dot"></span>',
  estimated: '<span class="inline-block w-2.5 h-2.5 rounded-full border-[1.5px] border-black/40 align-middle"></span>',
};
const PILL = {
  Paid:          "text-emerald-700 bg-emerald-50 border border-emerald-200",
  "Sent · A/R":  "text-ink-900 bg-black/[0.06] border border-black/15",
  "Bill · A/P":  "text-ink-900 bg-black/[0.06] border border-black/15",
  Scheduled:     "text-emerald-700 bg-transparent border border-emerald-300",
  "To bill":     "text-emerald-700 bg-transparent border border-emerald-300",
  "Not paid":    "text-rose-700 bg-rose-50 border border-rose-200",
  "Not spent":   "text-rose-700 bg-rose-50 border border-rose-200",
  Allocated:     "text-black/45 bg-transparent border border-black/15",
};
// Held retainage (paid except a held-back 5-15%) — its own colour: money that
// comes at release, not overdue A/R.
const RET_PILL = "bl-ret-pill";
function pill(label) {
  const cls = PILL[label] || (String(label).startsWith("Partial") ? "text-amber-700 bg-amber-50 border border-amber-200"
    : String(label).startsWith("Retainage") ? RET_PILL : PILL.Allocated);
  return `<span class="inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${cls}">${escapeHtml(label)}</span>`;
}
// Milestone aligned to an actual QBO invoice (billing/align.py) — its dates,
// amount and status follow that invoice; the status pill names it on hover
// (zero extra width: the milestone table is already at full card width).
const qboTitle = (m) => m.qbo_invoice_doc ? ` title="QuickBooks invoice #${escapeHtml(m.qbo_invoice_doc)} — dates, amount and status follow the invoice"` : "";
// 0084: how an expense row was produced — links to the Assumptions page, where
// the timing profile and payment lag behind it are shown with their evidence.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const stayMonth = (billDate) => { const d = new Date(`${billDate}T00:00:00`); d.setMonth(d.getMonth() - 1); return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const basisChip = (w) => (w.edited || !w.basis || w.basis === "manual") ? "" : w.basis === "auto_lodging" && w.week_of
  ? `<a href="#/assumptions" class="ml-1.5 inline-flex items-center text-[10px] font-bold text-sky-700 bg-sky-50 border border-sky-200 rounded px-1 py-0.5" title="Estimated: ${stayMonth(w.week_of)} stays, billed on Hotel Engine's monthly statement and paid a few days later. Dates come from Hotel Engine's billing history (click for the numbers). The real statement replaces this when it posts.">est. · Hotel Engine · ${stayMonth(w.week_of).split(" ")[0].slice(0, 3)} stays</a>`
  : w.basis === "auto_month_end"
  ? `<span class="ml-1.5 inline-flex items-center text-[10px] font-bold text-sky-700 bg-sky-50 border border-sky-200 rounded px-1 py-0.5" title="Billed at the end of the month: the estimate is split evenly over the month-ends the work runs">month-end</span>`
  : w.basis === "auto_profile"
  ? `<a href="#/assumptions" class="ml-1.5 inline-flex items-center text-[10px] font-bold text-sky-700 bg-sky-50 border border-sky-200 rounded px-1 py-0.5" title="Placed by this category's timing profile measured from QuickBooks history; paid date = bill week + the measured bill-to-payment lag. Click to see the numbers.">auto · history</a>`
  : `<a href="#/assumptions" class="ml-1.5 inline-flex items-center text-[10px] font-bold text-slate-600 bg-slate-50 rounded px-1 py-0.5" style="border:1px solid #e2e8f0" title="Estimate spread evenly across the project weeks (no timing profile for this category). Click to see the rules.">auto · even</a>`;
// 0087: where an invoice row's dates come from. auto = job dates + OPI's billing
// history (re-placed when the job dates move); manual = typed by a person.
const INV_RULE = { deposit: "the deposit's measured timing before the start date", mobilization: "the job's start date",
  final: "the job's end date", full: "the job's end date" };
const invKind = (label) => { const s = (label || "").toLowerCase();
  return s.includes("deposit") ? "deposit" : (s.includes("mobiliz") || s.includes("progress")) ? "mobilization"
    : (s.includes("in full") || s.startsWith("full invoice")) ? "full" : (s.includes("final") || s.includes("completion") || s.includes("balance to bill")) ? "final" : null; };
const dateBasisChip = (m) => {
  if (m.qbo_invoice_id || m.date_basis === "invoice") return "";
  if (m.date_basis === "manual") return `<span style="width:fit-content" class="mt-0.5 flex items-center gap-1 text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5" title="A person set these dates, so the app won't move them when the job dates change">manual dates<button type="button" data-autodates="${m.id}" class="font-bold text-blue-600 hover:underline" title="Hand the dates back to the app: invoice on ${escapeHtml(INV_RULE[invKind(m.label)] || "the job dates")}, due and expected paid from history">↺ auto</button></span>`;
  const k = invKind(m.label);
  if (!k) return "";
  return `<a href="#/assumptions" style="width:fit-content" class="mt-0.5 flex items-center text-[10px] font-bold text-sky-700 bg-sky-50 border border-sky-200 rounded px-1 py-0.5" title="Estimated: invoiced on ${escapeHtml(INV_RULE[k])}; due = the net terms; expected paid = how long customers have taken to pay this kind of invoice (measured from QuickBooks). Moves with the job dates until the invoice is sent or a person edits a date. Click to see the numbers.">auto · history</a>`;
};
const editedChip = (e) => e ?`<span class="ml-1.5 inline-flex items-center text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5" title="Hand-edited — preserved when the schedule refreshes">✎ edited</span>` : "";

// Assignment-workflow glue (#4): corner toast after the offer-accept confirm —
// did the crew land on the project schedule? (shared .doc-toast style)
const assignToast = (r) => {
  if (!r || r.assigned === undefined) return;
  const t = document.createElement("div");
  t.className = "doc-toast";
  t.textContent = r.assigned
    ? "Crew assigned to the project schedule ✓"
    : (r.assign_error ? "Offer accepted — schedule assignment failed: " + r.assign_error : "Already on the schedule");
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
};

// 2026-11-19 (owner): no pop-ups while editing. Problems show in a small note
// in the corner for a few seconds; the page stays where it is.
export function panelNote(_container, msg) {
  let n = document.getElementById("blNote");
  if (!n) {
    n = document.createElement("div");
    n.id = "blNote"; n.className = "bl-note"; n.setAttribute("role", "status");
    document.body.appendChild(n);
  }
  n.textContent = msg; n.hidden = false;
  clearTimeout(n._t); n._t = setTimeout(() => { n.hidden = true; }, 7000);
}
// Every scrollable box around the panel (the page, Project Setup's detail
// column, the Cash Flow drawer) keeps its place when the panel re-draws.
const scrollState = (el) => {
  const out = [[document.scrollingElement || document.documentElement, window.scrollY]];
  for (let p = el && el.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight) out.push([p, p.scrollTop]);
  }
  return () => { for (const [p, t] of out) { if (p === document.scrollingElement || p === document.documentElement) window.scrollTo(0, t); else p.scrollTop = t; } };
};

const addDaysIso = (iso, n) => { const t = new Date(`${String(iso).slice(0, 10)}T00:00:00`); t.setDate(t.getDate() + n); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
const OFFER_CHIP = { accepted: ["Offer accepted", "bl-oc-ok"], sent: ["Offer sent", "bl-oc-sent"], declined: ["Declined", "bl-oc-bad"] };
const offerChip = (o, a, short) => {
  if (o && OFFER_CHIP[o.status]) { const [t, c] = OFFER_CHIP[o.status]; return `<span class="bl-oc ${c}">${short ? t.replace("Offer ", "") : t}</span>`; }
  if (a && !a.crew_id) return `<span class="bl-oc bl-oc-quiet">${short ? "no crew" : "No crew yet"}</span>`;
  return `<span class="bl-oc bl-oc-warn">${short ? "not sent" : "Offer not sent"}</span>`;
};

// ── inline-edit cells (patch on change; kind → PATCH endpoint) ───────────────
const EDIT_BASE = "bg-transparent border border-transparent hover:border-black/20 focus:border-blue-500 focus:bg-white rounded px-1.5 py-1 text-[12.5px] outline-none";
// 2026-11-19 (owner): dates read mm/dd/yy (type one, or pick it from the small
// calendar button) and amounts read 12,345.67, so the tables fit without a
// sideways scrollbar.
const mdy = (iso) => { if (!iso) return ""; const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${m}/${d}/${y.slice(2)}`; };
export function parseDateInput(s) {
  s = String(s || "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y, mo, d;
  if (m) { [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]; }
  else {
    m = s.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?$/);
    if (!m) throw new Error(`"${s}" is not a date (mm/dd/yy)`);
    mo = Number(m[1]); d = Number(m[2]);
    y = m[3] ? Number(m[3]) : new Date().getFullYear();
    if (y < 100) y += 2000;
  }
  const t = new Date(y, mo - 1, d);
  if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d) throw new Error(`"${s}" is not a date (mm/dd/yy)`);
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
const fmtNum = (v) => { if (v === "" || v == null || !isFinite(Number(v))) return ""; const n = Number(v); return n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }); };
export const parseNumInput = (s) => { const t = String(s ?? "").replace(/[$,\s]/g, ""); if (t === "") return null; const n = Number(t); if (!isFinite(n)) throw new Error(`"${s}" is not an amount`); return n; };
const eInput = (kind, id, field, value, type = "text", extra = "") => {
  const v = value == null ? "" : String(value);
  if (type === "date") return `<span class="bl-dt"><input data-edit="${kind}" data-id="${id}" data-field="${field}" data-date type="text" inputmode="numeric" placeholder="mm/dd/yy" value="${escapeHtml(mdy(v))}" class="${EDIT_BASE} w-[5.6rem] pr-5 tabular-nums ${extra}"><button type="button" class="bl-dt-btn" data-dtpick tabindex="-1" title="Pick a date" aria-label="Pick a date"><svg viewBox="0 0 20 20" width="12" height="12" fill="currentColor"><path d="M6 2v2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H8V2H6zm-2 6h12v8H4V8z"/></svg></button><input type="date" class="bl-dt-hidden" tabindex="-1" aria-hidden="true"></span>`;
  if (type === "number") return `<input data-edit="${kind}" data-id="${id}" data-field="${field}" data-num type="text" inputmode="decimal" value="${escapeHtml(fmtNum(v))}" class="${EDIT_BASE} w-[6.2rem] text-right tabular-nums font-semibold ${extra}">`;
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
  on_hold:         ["On hold", "text-slate-700 bg-slate-100 border-slate-400"],
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

/** 0078: forget a warmed bundle (e.g. after a hold shifted the dates). */
export function dropBillingPrefetch(entityId) { _prefetch.delete(entityId); }

// opts.only: "invoice" | "crew" | "expense" shows just that part (Project Setup's
// schedule steps); the contract / dates bar and the banners always show.
export async function mountBillingPanel(container, entityId, opts = {}) {
  if (opts.only) container.dataset.blOnly = opts.only; else delete container.dataset.blOnly;
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

// 2026-11-18: sections someone opened stay open when the panel re-draws after a
// save (adding / removing a row used to fold everything up).
const _sumKey = (sm) => sm.textContent.replace(/\$[\d,.]+|\d[\d,.]*/g, "").replace(/\s+/g, " ").trim().slice(0, 40);

function render(container, entityId, d) {
  const _wasOpen = new Set([...container.querySelectorAll("details[open] > summary")].map(_sumKey));
  const p = d.project, k = d.kpis;
  const est = d.estimates || { accepted: [], pending: [], needs_review: 0, contract_total: 0, collected: 0, open_ar: 0, invoiced_qbo: 0 };
  const roll = d.crew_rollups || { rollups: [], total_labor: 0, total_paid: 0 };
  const inv = d.invoices, crew = d.crew, exp = d.expenses;
  const crews = d.crews || [];
  const terms = d.terms || { percents: [35, 35, 30], net_days: 30, label: "35 / 35 / 30 · net-30", custom: false };
  let [stLabel, stCls] = STATUS_PILL[p.operational_status] || [p.operational_status || "—", "text-slate-700 bg-slate-100 border-slate-300"];
  // 0078: an active hold — "On hold until 12/7/26" (remaining items below are
  // already shifted to after the resume date).
  if (p.hold) stLabel = `On hold until ${shortDate(p.hold.expected_resume)}${p.hold.shift_days ? ` · shifted ${p.hold.shift_days}d` : ""}`;
  // Crew Model v2 (CR3): assignable choices are COMPANIES ("MTY · Jesse
  // Rosales Jr."); leads stay in the list only so legacy child assignments
  // resolve to a readable "MTY · Gustavo Ramirez" label.
  const crewName = (id) => { const c = crews.find((x) => String(x.id) === String(id)); return c ? (c.label || c.name) : null; };
  const crewOpts = (sel) => {
    const selected = crews.find((c) => String(c.id) === String(sel));
    const opts = crews.filter((c) => c.is_company || (selected && String(c.id) === String(sel)));
    return `<option value="">Unassigned</option>` + opts.map((c) => `<option value="${c.id}" ${String(c.id) === String(sel) ? "selected" : ""}>${escapeHtml((c.label || c.name) + (c.is_company ? "" : " (legacy lead)"))}</option>`).join("");
  };
  // Multi-crew split (item #3): estimate_qbo_id -> ordered allocations
  // [{company_crew_id, name, pct}]. Absent/empty = single-crew mode.
  const splits = d.crew_splits || {};
  const splitOf = (eq) => { const s = splits[eq]; return (s && s.length >= 2) ? s : null; };
  const fmtPct = (p) => (Number(p) === Math.round(Number(p)) ? String(Math.round(Number(p))) : String(Math.round(Number(p) * 100) / 100));
  const splitLabel = (s) => "Split: " + s.map((a) => `${a.name} ${fmtPct(a.pct)}%`).join(" · ");
  // Crew "paid" = ALL actual Contract-Labor bills (any vendor, incl. crews not
  // registered/assigned in the app) — not just the assigned rollups.
  const crewPaid = crew.paid_qbo != null ? crew.paid_qbo : roll.total_paid;
  // Total contract labor = the estimates' Contract Labor (works even before the
  // bi-weekly schedules are generated, e.g. a project with no dates yet).
  const crewLaborEst = est.accepted.reduce((s, a) => s + (a.labor || 0), 0) || roll.total_labor;
  const crewLeft = Math.max(0, crewLaborEst - crewPaid);

  // ── roll-up KPIs + burn bars ──
  const kpi = (label, val, cls = "", sub = "") =>
    `<div class="px-4 py-3 bg-white"><div class="text-[10.5px] font-bold uppercase tracking-wide text-black/40 mb-1">${label}</div><div class="text-lg font-bold tabular-nums ${cls}">${money(val)}</div>${sub ? `<div class="text-[10.5px] text-black/45 tabular-nums">${sub}</div>` : ""}</div>`;
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
      <div class="text-[13px] text-amber-900"><b>${est.needs_review} estimate${est.needs_review > 1 ? "s" : ""} need${est.needs_review > 1 ? "" : "s"} review</b> (${reviewList.map((a) => "#" + escapeHtml(a.doc)).join(", ")}): accepted in QuickBooks after the job was set up, usually a change order. Check ${est.needs_review > 1 ? "their" : "its"} invoice schedule and crew below, then press Confirm on the estimate, or mark <b>Invoice schedule reviewed</b> on Project Setup.</div>
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
  // % and $ are BOTH editable and linked live (data-estval on the row lets the
  // input handler recompute the other field before the autosave persists both).
  // Expected paid = when the cash realistically lands; blank falls back to the
  // due date (the cash-flow forecast uses expected ?? due ?? invoice).
  // A row that IS a QuickBooks invoice has one expected-paid date: the
  // invoice's (edited here or under "Actual invoices"; Cash Flow follows).
  const msExpected = (m, acts) => {
    if (!m.qbo_invoice_id) return eInput("milestone", m.id, "expected_paid_date", m.expected_paid_date, "date");
    const x = (acts || []).find((a) => String(a.qbo_id) === String(m.qbo_invoice_id));
    if (!x || x.balance <= 0.01 || x.status === "Retainage") return `<span class="tabular-nums text-black/40 px-1.5">${x && x.balance <= 0.01 ? "paid" : "—"}</span>`;
    return eInput("qboinv", x.qbo_id, "expected_paid_date", x.expected_paid_date || x.due_date, "date");
  };
  const milestoneRow = (m, estVal, acts) => `
    <tr class="border-b border-black/5" data-ms-row data-estval="${estVal || 0}">
      <td class="py-1 pl-4 pr-3"><span class="flex items-center gap-2">${DOT[m.tier]}${eInput("milestone", m.id, "label", m.label || "Milestone", "text", "font-semibold min-w-[7rem]")}</span></td>
      <td class="py-1 px-2"><span class="flex items-center gap-0.5"><input data-edit="milestone" data-id="${m.id}" data-field="pct" type="number" step="0.1" min="0" value="${m.pct ? Math.round(m.pct * 10) / 10 : ""}" class="${EDIT_BASE} ms-pct-w text-right tabular-nums"><span class="text-black/40 text-[11px]">%</span></span></td>
      <td class="py-1 px-2">${eInput("milestone", m.id, "invoice_date", m.invoice_date, "date")}${dateBasisChip(m)}</td>
      <td class="py-1 px-2">${eInput("milestone", m.id, "due_date", m.due_date, "date")}</td>
      <td class="py-1 px-2">${msExpected(m, acts)}</td>
      <td class="py-1 px-2 text-right"><input data-edit="milestone" data-id="${m.id}" data-field="amount" data-num type="text" inputmode="decimal" value="${m.amount != null ? escapeHtml(fmtNum(Math.round(m.amount * 100) / 100)) : ""}" class="${EDIT_BASE} w-[6.2rem] text-right tabular-nums font-semibold ml-auto"></td>
      <td class="py-1 pl-2 pr-4 text-right whitespace-nowrap"><span${m.tier === "retainage" ? ` title="QuickBooks invoice #${escapeHtml(m.qbo_invoice_doc || "")} is paid except ${money(m.retainage_held)} the customer is holding back (retainage) — expected at release, not overdue"` : qboTitle(m)}>${pill(m.tier === "retainage" ? `Retainage · ${money(m.retainage_held)}` : m.status_label)}</span>${m.date_basis === "manual" ? "" : editedChip(m.edited)}${delBtn("milestone", m.id)}</td>
    </tr>`;
  const invEstimateCard = (a) => {
    const nr = !a.confirmed;
    const statusPill = nr
      ? `<span class="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">● Needs review</span>`
      : `<span class="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">Confirmed</span>`;
    const rows = a.milestones.map((m) => milestoneRow(m, a.value, a.invoice_actuals)).join("");
    // Σ reconciliation footer: milestone total vs the estimate's value.
    const msTotal = a.milestones.reduce((s, m) => s + (m.amount || 0), 0);
    const msPct = a.value ? Math.round((msTotal / a.value) * 1000) / 10 : 0;
    // The schedule adds up to the estimate automatically (un-overridden rows
    // true up on every load); only hand-set amounts can pull it off — then say
    // so plainly, with the gap and a one-click way back to automatic.
    const off = Math.round((msTotal - (a.value || 0)) * 100) / 100;
    const msOff = Math.abs(off) > 0.5;
    const ss = a.schedule_sum_state || (msOff ? "user_override" : "ok");
    const gap = `${money2(Math.abs(off))} ${off < 0 ? "short of" : "over"} the estimate`;
    let sumLine = "";
    if (a.milestones.length && !msOff) {
      sumLine = `<div class="px-4 py-1.5 border-t border-black/[0.06] text-[11px] tabular-nums text-black/45" title="The rows you haven't set by hand adjust automatically so the schedule always totals the current QuickBooks estimate">Σ ${money2(msTotal)} of ${money2(a.value)} (${msPct}%) · adds up to the estimate</div>`;
    } else if (a.milestones.length && ss === "overbilled") {
      sumLine = `<div class="bl-sum-warn"><span class="bl-sum-ico">!</span><div><b>Invoiced ${gap}.</b> QuickBooks invoices total more than estimate #${escapeHtml(a.doc || "")} (Σ ${money2(msTotal)} of ${money2(a.value)}). Raise the estimate or add a change-order estimate in QuickBooks.</div></div>`;
    } else if (a.milestones.length) {
      sumLine = `<div class="bl-sum-warn"><span class="bl-sum-ico">!</span><div><b>You changed this schedule — it's ${gap}.</b> Σ ${money2(msTotal)} of ${money2(a.value)} (${msPct}%). Rows with an amount you set by hand don't adjust automatically; fix an amount, or let the app balance it.</div>${a.schedule_id ? `<button type="button" data-autobal="${a.schedule_id}" class="bl-sum-btn" title="Clear your hand-set amounts on the not-yet-invoiced rows so they adjust to add up to the estimate again (dates and names are kept)">Balance automatically</button>` : ""}</div>`;
    }
    const acts = a.invoice_actuals || [];
    const actTotal = acts.reduce((s, x) => s + (x.amount || 0), 0);
    const actuals = acts.length ? actualsBlock("Actual invoices in QuickBooks", acts.length,
      `<table class="w-full text-[12px]"><thead><tr class="text-[10px] text-black/40 text-left"><th class="pb-1 font-bold">Invoice #</th><th class="font-bold">Sent</th><th class="font-bold">Due</th><th class="font-bold bl-th-in0" title="When the cash is expected. Same date as the invoice's row in the schedule above; the Cash Flow forecast uses it (blank = the due date). Saved in the app only.">Expected paid</th><th class="text-right font-bold">Amount</th><th class="text-right font-bold">Status</th></tr></thead>
       <tbody>${acts.map((x) => `<tr class="border-t border-black/[0.05]"><td class="py-1.5 tabular-nums font-semibold">${escapeHtml(x.doc_number || "—")}</td><td class="py-1.5 tabular-nums text-black/60">${shortDate(x.txn_date)}</td><td class="py-1.5 tabular-nums text-black/60">${shortDate(x.due_date)}</td><td class="py-1 tabular-nums">${x.balance > 0.01 && x.status !== "Retainage" ? `${eInput("qboinv", x.qbo_id, "expected_paid_date", x.expected_paid_date || x.due_date, "date")}${!x.expected_paid_date ? `<div class="text-[10px] text-black/40">the due date</div>` : ""}` : `<span class="text-black/30">—</span>`}</td><td class="py-1.5 text-right tabular-nums font-semibold">${money(x.amount)}</td><td class="py-1.5 text-right">${pill(x.status === "Paid" ? "Paid" : x.status === "Retainage" ? `Retainage held · ${money(x.balance)}` : x.status === "Partial" ? `Partial · ${money(x.balance)} A/R` : "Sent · A/R")}</td></tr>`).join("")}</tbody>
       <tfoot><tr class="border-t-2 border-black/15 font-bold"><td class="py-1.5" colspan="4">Total invoiced <span class="font-normal text-black/45">vs ${money(a.value)} est</span></td><td class="py-1.5 text-right tabular-nums">${money(actTotal)}</td><td></td></tr></tfoot></table>`) : "";
    return `<details open class="group card overflow-hidden mb-3 ${nr ? "border-amber-300" : ""}">
      <summary class="flex items-center gap-2 px-4 py-3 border-b border-black/10 bg-black/[0.02] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden flex-wrap">
        <svg class="w-3.5 h-3.5 text-black/30 transition-transform group-open:rotate-90 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
        <span class="text-sm font-bold text-ink-900">Estimate <span class="text-blue-700">#${escapeHtml(a.doc || "—")}</span></span>
        <span class="text-[11.5px] text-black/50 tabular-nums" title="${escapeHtml(`Estimate dated ${shortDate(a.txn_date)}${a.accepted_date ? `; marked accepted in QuickBooks on ${shortDate(a.accepted_date)}` : "; QuickBooks has no accepted date on it"}`)}">${a.accepted_date ? `Accepted ${shortDate(a.accepted_date)}` : "Accepted (no date in QuickBooks)"}</span>
        ${statusPill}
        ${nr ? `<button type="button" data-confirm-est data-eq="${escapeHtml(a.qbo_id)}" class="text-[11px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg px-2.5 py-0.5" title="You've checked this estimate's invoice schedule and crew. Marking Invoice schedule reviewed on Project Setup confirms every estimate on the job too.">Confirm</button>` : ""}
        <span class="ml-auto flex items-center gap-2.5 text-[11.5px] tabular-nums flex-wrap justify-end">
          ${a.paid > 0.5 ? `<span class="text-emerald-700 font-semibold">${money(a.paid)} paid</span>` : ""}
          ${a.sent_ar > 0.5 ? `<span class="text-ink-900 font-semibold">${money(a.sent_ar)} sent · A/R</span>` : ""}
          ${a.retainage_held > 0.5 ? `<span class="bl-ret-txt font-semibold" title="Paid except the retainage the customer is holding back">${money(a.retainage_held)} retainage held</span>` : ""}
          ${a.to_bill > 0.5 ? `<span class="text-emerald-600 font-semibold">${money(a.to_bill)} to bill</span>` : ""}
          <span class="text-[13px] font-bold text-ink-900 border-l border-black/15 pl-2.5">${money(a.value)}</span>
        </span>
      </summary>
      <div class="overflow-x-auto"><table class="w-full text-[12.5px] bl-ms"><thead><tr class="text-[10px] font-bold uppercase tracking-wide text-black/40 border-b border-black/10">
        <th class="py-2 pl-4 pr-3 text-left bl-th-ms">Milestone</th><th class="py-2 px-2 text-right bl-th-pct">%</th><th class="py-2 px-2 text-left bl-th-in">Invoice</th><th class="py-2 px-2 text-left bl-th-in">Due</th><th class="py-2 px-2 text-left bl-th-in" title="When the cash is expected to land. On a sent invoice it is the invoice's date (also under Actual invoices); Cash Flow uses it">Expected paid</th><th class="py-2 px-2 text-right bl-th-inr">Amount</th><th class="py-2 pl-2 pr-4 text-right bl-th-st">Status</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      ${sumLine}
      ${a.schedule_id ? addBtn("milestone", a.schedule_id, "Add invoice milestone") : ""}
      ${actuals}
    </details>`;
  };

  // ── RETAINAGE: invoices paid except a held-back portion (billing/retainage.py) ──
  const ret = est.retainage || { held: 0, invoices: [] };
  const retHeld = ret.held || 0;
  const retainageBlock = retHeld > 0.5 ? `
    <div class="bl-ret-card mb-3">
      <div class="bl-ret-head">
        <span class="bl-ret-pill text-[10.5px] font-bold px-2 py-0.5 rounded-full">Retainage</span>
        <span class="text-[13px] font-bold text-ink-900">${money(retHeld)} held on ${ret.invoices.length} invoice${ret.invoices.length === 1 ? "" : "s"}</span>
        <span class="text-[11.5px] text-black/55">paid except the part the customer holds back until the job is done — expected at release, not overdue A/R${ret.release_expected ? ` · release expected ~${shortDate(ret.release_expected)}` : ""}</span>
      </div>
      <div class="overflow-x-auto"><table class="w-full text-[12px]"><thead><tr class="text-[10px] text-black/40 text-left">
        <th class="py-1 pl-4 font-bold">Invoice #</th><th class="font-bold">Estimate</th><th class="font-bold">Invoice date</th><th class="text-right font-bold">Invoice</th><th class="text-right font-bold">Held</th><th class="text-right font-bold">%</th><th class="text-right pr-4 font-bold">Held since</th>
      </tr></thead><tbody>${ret.invoices.map((x) => `<tr class="border-t border-black/[0.05]">
        <td class="py-1.5 pl-4 tabular-nums font-semibold">${escapeHtml(x.doc || "—")}</td>
        <td class="tabular-nums text-black/60">${x.estimate_doc ? "#" + escapeHtml(x.estimate_doc) : "—"}</td>
        <td class="tabular-nums text-black/60">${shortDate(x.txn_date)}</td>
        <td class="text-right tabular-nums">${money(x.amount)}</td>
        <td class="text-right tabular-nums font-bold bl-ret-txt">${money(x.held)}</td>
        <td class="text-right tabular-nums text-black/60">${x.pct}%</td>
        <td class="text-right pr-4 tabular-nums text-black/60">${shortDate(x.held_since)}${x.age_days != null ? ` <span class="text-black/40">· ${x.age_days}d</span>` : ""}</td>
      </tr>`).join("")}</tbody></table></div>
    </div>` : "";

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
    const chips = g.estimates.map((e) => { const ea = est.accepted.find((x) => String(x.doc) === String(e.doc)); return `<span class="text-[10.5px] font-semibold px-2 py-0.5 rounded border border-black/10 bg-black/[0.02] text-black/60">#${escapeHtml(e.doc || "—")} · ${money(e.labor)}${e.split_pct ? ` <span class="text-indigo-700 font-bold">· ${fmtPct(e.split_pct)}% split</span>` : ""}</span>`; }).join("");
    const insts = g.installments.map((i) => `
      <tr class="border-b border-black/5"><td class="py-1 pl-4 pr-3 tabular-nums text-black/60"><span class="flex items-center gap-2">${DOT[i.tier] || ""}${shortDate(i.pay_date)}</span></td><td class="py-1 px-2 text-right tabular-nums font-semibold text-ink-900">${money(i.amount)}</td><td class="py-1 pl-2 pr-4 text-right">${pill(i.status_label)}</td></tr>`).join("");
    // 2026-11-19 (owner): offers are sent per estimate (below), not per roll-up.
    const offerLine = "";
    return `<div class="rounded-xl border border-blue-300 overflow-hidden mb-3">
      <div class="flex items-center gap-2 px-4 py-2.5 bg-blue-50 border-b border-blue-200 flex-wrap">
        <span class="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 border border-blue-200">Rollup</span>
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
    const split = splitOf(a.qbo_id);
    // the composed schedule for this estimate carries the per-company share
    // burn (installment "split" entries + "split_summary" subtotals)
    const compSched = split ? (crew.schedules || []).find((s) => String(s.estimate_qbo_id) === String(a.qbo_id)) : null;
    const splitByInst = {};
    if (compSched) (compSched.installments || []).forEach((i) => { if (i.split) splitByInst[i.id] = i.split; });
    const shareChips = (i) => {
      const entries = splitByInst[i.id];
      if (!entries) return "";
      const chips = entries.map((se) => {
        const paidUp = (se.remaining || 0) <= 0.5;
        const cls = paidUp ? "text-emerald-700 bg-emerald-50 border border-emerald-200" : "text-indigo-700 bg-indigo-50 border border-indigo-200";
        return `<span class="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${cls}" title="${escapeHtml(se.name)} · ${fmtPct(se.pct)}% — ${paidUp ? "paid" : money(se.remaining) + " remaining"}">${escapeHtml(se.name)} · ${fmtPct(se.pct)}% · ${money(se.amount)}${paidUp ? " ✓" : ""}</span>`;
      }).join("");
      return `<tr class="border-b border-black/5"><td colspan="3" class="pb-1.5 pl-6 pr-4"><span class="flex flex-wrap gap-1.5">${chips}</span></td></tr>`;
    };
    const lead = Number(a.crew_invoice_lead_days ?? 7);
    const sendOf = (i) => i.send_invoice_date || (i.pay_date ? addDaysIso(i.pay_date, -lead) : null);
    const insts = (a.crew_installments || []).map((i) => `
      <tr class="${split ? "" : "border-b border-black/5"}">
        <td class="py-1 pl-3 pr-1">${complete ? `<span class="tabular-nums text-black/60">${shortDate(i.pay_date)}</span>` : eInput("installment", i.id, "pay_date", i.pay_date, "date")}</td>
        <td class="py-1 px-1 text-right">${complete ? `<span class="tabular-nums font-semibold">${money(i.amount)}</span>` : eInput("installment", i.id, "amount", Math.round(i.amount * 100) / 100, "number", "ml-auto")}</td>
        <td class="py-1 px-1">${complete ? `<span class="tabular-nums text-black/60">${shortDate(sendOf(i))}</span>` : eInput("installment", i.id, "send_invoice_date", sendOf(i), "date", i.send_invoice_date ? "" : "text-black/45")}</td>
        <td class="py-1 px-1 w-full">${complete ? `<span class="text-black/60">${escapeHtml(i.note || "")}</span>` : eInput("installment", i.id, "note", i.note || "", "text", "min-w-[8rem]")}</td>
        <td class="py-1 pl-1 pr-3 text-right whitespace-nowrap">${i.status === "paid" ? pill("Paid") : ""}${i.amount_edited ? `<span class="bl-typed" title="Amount typed by hand: kept when the schedule re-balances">typed</span>` : ""}${complete ? "" : delBtn("installment", i.id)}</td>
      </tr>${split ? shareChips(i) : ""}`).join("");
    // per-company paid/remaining subtotals (split mode, from the server burn)
    const splitTotals = (compSched && compSched.split_summary) ? `
      <div class="px-4 pb-2">
        ${compSched.split_summary.map((t) => `<div class="flex items-center gap-2 py-1 text-[11.5px] border-t border-black/[0.05]">
          <span class="font-semibold text-ink-900">${escapeHtml(t.name)}</span>
          <span class="text-black/45">${fmtPct(t.pct)}%</span>
          <span class="ml-auto tabular-nums text-black/55">${money(t.scheduled)} scheduled</span>
          <span class="tabular-nums font-semibold text-emerald-700">${money(t.paid)} paid</span>
          <span class="tabular-nums font-semibold ${t.remaining > 0.5 ? "text-ink-900" : "text-black/35"}">${money(t.remaining)} remaining</span>
        </div>`).join("")}
      </div>` : "";
    // crew assignment lives OUTSIDE the <summary> so clicks reach the delegated
    // handler (a stopPropagation in the summary was swallowing them).
    const assignRow = complete
      ? `<div class="px-4 py-1.5 text-[11.5px] text-black/55">Crew assigned: <b class="text-ink-900">${escapeHtml(split ? splitLabel(split) : (crewName(a.crew_id) || "—"))}</b> · books closed <span class="text-black/40">(actual payments may differ — see rollup + Other crews above)</span></div>`
      : container.dataset.blOnly
        ? `<div class="px-4 py-1.5 text-[11.5px] text-black/55">Crew: <b class="text-ink-900">${escapeHtml(split ? splitLabel(split) : (crewName(a.crew_id) || "not picked yet"))}</b> <span class="text-black/40">(picked per estimate under Assignment)</span></div>`
      : split
        ? `<div class="px-4 py-1.5 flex items-center gap-1.5 text-[11.5px] flex-wrap"><span class="text-black/55">Crew</span>
            <span class="inline-flex items-center gap-1 text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">${escapeHtml(splitLabel(split))}</span>
            <button data-crew-split data-eq="${a.qbo_id}" class="text-[11px] font-semibold text-blue-600 hover:underline">Edit split…</button>
            <button data-crew-split-revert data-eq="${a.qbo_id}" class="text-[11px] font-semibold text-black/45 hover:underline hover:text-red-600">Revert to single crew</button></div>`
        : `<div class="px-4 py-1.5 flex items-center gap-1.5 text-[11.5px] flex-wrap"><span class="text-black/55">Crew</span>
            <select data-assign-crew data-eq="${a.qbo_id}" class="${EDIT_BASE} border-black/15">${crewOpts(a.crew_id)}</select>
            <button data-crew-browse data-eq="${a.qbo_id}" class="text-[11px] font-semibold text-blue-600 hover:underline">browse crews →</button>
            <button data-crew-split data-eq="${a.qbo_id}" class="text-[11px] font-semibold text-indigo-700 hover:underline" title="Split this estimate's crew payments across 2+ crew companies — one schedule, each payment divided by percentage">Split across crews…</button></div>`;
    // where the installments came from — the Payment Schedule file opens in the viewer
    const cs = a.crew_source || {};
    const srcLine = cs.source && String(cs.source).startsWith("sheet")
      ? `<div class="px-4 py-1 text-[11.5px] text-black/55 flex items-center gap-1.5 flex-wrap">First copied from the crew Payment Schedule in Google Drive${cs.source_modified ? ` (file updated ${escapeHtml(shortDate(cs.source_modified))})` : ""}. Edit it here: the sheet is read for reference only and never changes it (Data Review lists where they differ).
          ${cs.source_doc_id ? `<button type="button" data-srcdoc="${cs.source_doc_id}" data-srcname="${escapeHtml(cs.source_file_name || "Payment Schedule")}" class="src-doc-btn" title="Open the file this schedule was read from">${DOC_ICON} ${escapeHtml(cs.source_file_name || "Payment Schedule")}</button>` : ""}</div>`
      : cs.source ? `<div class="px-4 py-1 text-[11.5px] text-black/45">No crew payment schedule entered for this estimate: the estimate's labor split evenly across bi-weekly paydays.</div>` : "";
    return `<details class="group/ce border-b border-black/[0.06]">
      <summary class="flex items-center gap-2 px-4 py-2 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-black/[0.015] flex-wrap">
        <svg class="w-3 h-3 text-black/30 transition-transform group-open/ce:rotate-90 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
        <span class="text-[12.5px] font-semibold text-ink-900">Estimate #${escapeHtml(a.doc || "—")}</span>
        <span class="tabular-nums text-[12px] text-black/55">${money(a.labor)} labor</span>
        ${offerChip(a.offer, a)}
        ${cs.source_doc_id ? `<button type="button" data-srcdoc="${cs.source_doc_id}" data-srcname="${escapeHtml(cs.source_file_name || "Payment Schedule")}" class="src-doc-btn" title="These payments were read from this Payment Schedule. Click to view it here.">${DOC_ICON} Payment Schedule</button>` : ""}
        <span class="ml-auto text-[11px] ${split ? "font-bold text-indigo-700" : "text-black/40"}">${escapeHtml(split ? splitLabel(split) : (crewName(a.crew_id) || "Unassigned"))}</span>
      </summary>
      ${assignRow}
      ${srcLine}
      <div class="overflow-x-auto px-1 pb-1"><table class="w-full text-[12px] bl-crew"><thead><tr class="text-[10px] font-bold uppercase tracking-wide text-black/40 text-left"><th class="py-1 pl-3 pr-1 bl-th-c">Pay date</th><th class="py-1 px-1 text-right bl-th-cr">Amount</th><th class="py-1 px-1 bl-th-c" title="The date the crew sends its invoice for this payment (pay date minus ${lead} days unless changed)">Send invoice</th><th class="py-1 px-1 bl-th-c">Comment</th><th></th></tr></thead><tbody>${insts || `<tr><td colspan="5" class="px-4 py-2 text-black/40">No schedule — add dates.</td></tr>`}</tbody></table></div>
      ${(a.crew_installments || []).length ? (() => {
        const tot = Math.round((a.crew_installments || []).reduce((x, i) => x + (Number(i.amount) || 0), 0) * 100) / 100;
        const off = tot - (Number(a.labor) || 0);
        const kept = a.crew_sum_ok_total != null && Math.abs(Number(a.crew_sum_ok_total) - tot) < 0.5;
        if (Math.abs(off) <= 1) return `<div class="px-4 pb-1 text-[11.5px] tabular-nums text-black/50">Total ${money(tot)} of ${money(a.labor)} contract labor. Adding or removing a payment re-balances the payments nobody typed.</div>`;
        if (kept) return `<div class="px-4 pb-1 text-[11.5px] tabular-nums text-black/55">Total ${money(tot)} of ${money(a.labor)} contract labor: ${off > 0 ? "over" : "short"} by ${money(Math.abs(off))}, kept that way on purpose. <button type="button" class="su-linkbtn" data-crew-rebal="${a.crew_schedule_id}">Re-balance instead</button></div>`;
        return complete ? `<div class="px-4 pb-1 text-[11.5px] tabular-nums text-rose-700 font-semibold">Total ${money(tot)} of ${money(a.labor)} contract labor (${off > 0 ? "over" : "short"} by ${money(Math.abs(off))})</div>`
          : `<div class="bl-sum-warn mx-3 mb-2"><span class="bl-sum-ico">!</span><div><b>The payments ${off > 0 ? "come to more than" : "come to less than"} the contract labor: ${money(tot)} of ${money(a.labor)} (${off > 0 ? "over" : "short"} by ${money(Math.abs(off))}).</b> Re-balance the open payments, or keep it this way if you are paying the crew ${off > 0 ? "more" : "less"} on purpose.</div>
              <span class="flex gap-1.5 flex-wrap"><button type="button" class="bl-sum-btn" data-crew-rebal="${a.crew_schedule_id}">Re-balance</button><button type="button" class="bl-sum-btn" data-crew-keep="${a.crew_schedule_id}">Keep it</button></span></div>`;
      })() : ""}
      ${!complete && a.crew_schedule_id && a.crew_dates_confirmed === false ? `<div class="mx-4 mb-2 flex items-center gap-2 flex-wrap text-[11.5px] rounded-lg border border-amber-200 bg-amber-50 text-amber-800 px-2.5 py-1.5">
          <b>Check and confirm the payment dates.</b> The first payment is the second payday after the PO (the estimate's accepted date), then every other Friday.
          <button type="button" class="ml-auto pd-btn" data-confirm-dates="${a.crew_schedule_id}">Dates are right</button></div>` : ""}
      ${splitTotals}
      ${!complete && a.crew_schedule_id ? addBtn("installment", a.crew_schedule_id, "Add payment") : ""}
      ${complete ? "" : estOfferLine(a)}
    </details>`;
  };
  // 2026-11-19 (owner): one crew offer per estimate / change order.
  const estOfferLine = (a) => {
    const o = a.offer, cn = (o && o.crew_name) || crewName(a.crew_id) || "the crew";
    const lab = Number(a.labor) || 0;
    const btns = (more) => `<span class="ml-auto flex items-center gap-2.5 flex-wrap">${more}<button type="button" data-est-script="${escapeHtml(a.qbo_id)}" class="text-[11.5px] font-semibold text-blue-600 hover:underline">Offer email</button></span>`;
    const outside = `<button type="button" data-est-outside="${escapeHtml(a.qbo_id)}" class="text-[11.5px] font-semibold text-black/50 hover:underline" title="The offer went out by email, text or the Drive sheet: record when (and if it was accepted)">Sent outside the app</button>`;
    const proj = o && o.project_level ? ` <span class="text-black/45">(one offer for the whole project, before offers per estimate)</span>` : "";
    if (o && o.status === "accepted") return `<div class="bl-offer bl-offer-ok"><b>✓ Offer accepted</b> ${escapeHtml(cn)} · ${money(o.labor_amount || lab)}${o.responded_at ? ` · ${shortDate(o.responded_at)}` : ""}${proj}${btns("")}</div>`;
    if (o && o.status === "sent") return `<div class="bl-offer bl-offer-sent"><b>Offer sent</b> to ${escapeHtml(cn)}${o.sent_at ? ` ${shortDate(o.sent_at)}` : ""}, no answer yet${proj}${btns(`<button type="button" data-offer-accept="${o.id}" class="text-[11.5px] font-bold text-emerald-700 hover:underline">Record accepted</button><button type="button" data-offer-withdraw="${o.id}" class="text-[11.5px] font-semibold text-black/50 hover:underline">Withdraw</button>`)}</div>`;
    if (!a.crew_id) return `<div class="bl-offer bl-offer-none">Pick the crew company for this estimate (Assignment) to send its offer.</div>`;
    if (!(a.crew_installments || []).length) return `<div class="bl-offer bl-offer-none">Offer: build this payment schedule first (it goes out with the offer).</div>`;
    return `<div class="bl-offer bl-offer-none">${o && o.status === "declined" ? `<b>${escapeHtml(cn)} declined.</b> ` : "<b>Offer not sent</b> "}${escapeHtml(cn)} · ${money(lab)}${btns(`${outside}<button type="button" data-est-send="${escapeHtml(a.qbo_id)}" class="text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-3 py-1">Send offer…</button>`)}</div>`;
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
        <td class="py-1 pl-6 pr-2"><span class="flex items-center gap-2">${w.estimate_doc && (c.by_estimate || []).length > 1 ? `<span class="text-[10px] font-bold text-black/40">#${escapeHtml(w.estimate_doc)}</span>` : ""}${DOT[w.tier]}${expenseComplete ? `<span class="tabular-nums text-black/60">${shortDate(w.week_of)}</span>` : eInput("expinst", w.id, "week_of", w.week_of, "date")}</span></td>
        <td class="py-1 px-2">${expenseComplete ? `<span class="tabular-nums text-black/60">${w.expected_paid_date ? shortDate(w.expected_paid_date) : "—"}</span>` : eInput("expinst", w.id, "expected_paid_date", w.expected_paid_date, "date")}</td>
        <td class="py-1 px-2 text-right">${expenseComplete ? `<span class="tabular-nums font-semibold">${money(w.amount)}</span>` : eInput("expinst", w.id, "amount", Math.round(w.amount), "number", "ml-auto")}</td>
        <td class="py-1 pl-2 pr-4 text-right whitespace-nowrap">${pill(w.status_label)}${w.amount_edited ? `<span class="bl-typed" title="Amount typed by hand: kept when the plan re-balances">typed</span>` : editedChip(w.edited)}${basisChip(w)}${!expenseComplete && w.edited && w.app ? `<button type="button" data-exp-revert="${w.id}" class="bl-revert" title="Back to the app's plan: ${escapeHtml(`${shortDate(w.app.week_of)}, ${money(w.app.amount)}`)}">↺</button>` : ""}${expenseComplete ? "" : delBtn("expinst", w.id)}</td>
      </tr>`).join("");
    // 2026-11-19 (owner): each plan (item x estimate) adds up to what the estimate
    // has for it; when it doesn't, say so: Re-balance or Keep it.
    const groups = (c.by_estimate || []);
    const sumWarn = expenseComplete ? "" : groups.map((b) => {
      const off = Math.round((b.planned - b.target) * 100) / 100;
      if (Math.abs(off) <= 1 || !b.target) return "";
      const key = `${escapeHtml(c.category)}|${escapeHtml(b.estimate_qbo_id || "")}`;
      const who = b.doc ? `#${escapeHtml(b.doc)}'s ` : "The ";
      if (b.kept_total != null && Math.abs(b.kept_total - b.planned) < 0.5)
        return `<div class="px-6 py-1 text-[11.5px] text-black/55 tabular-nums">${who}${escapeHtml(c.category.toLowerCase())} plan: ${money(b.planned)} of ${money(b.target)}, kept that way on purpose. <button type="button" class="su-linkbtn" data-exp-rebal="${key}">Re-balance instead</button></div>`;
      return `<div class="bl-sum-warn"><span class="bl-sum-ico">!</span><div><b>${who}${escapeHtml(c.category.toLowerCase())} rows come to ${money(b.planned)}, the estimate has ${money(b.target)} (${off > 0 ? "over" : "short"} by ${money(Math.abs(off))}).</b> Re-balance the rows nobody typed, or keep it this way on purpose.</div>
        <span class="flex gap-1.5 flex-wrap"><button type="button" class="bl-sum-btn" data-exp-rebal="${key}">Re-balance</button><button type="button" class="bl-sum-btn" data-exp-keep="${key}">Keep it</button></span></div>`;
    }).join("");
    const addRows = expenseComplete ? "" : (groups.length > 1
      ? `<div class="px-4 py-2 border-t border-black/[0.06] flex flex-wrap gap-3">${groups.map((b) => `<button data-add="expinst" data-sid="${escapeHtml(c.category)}" data-eq="${escapeHtml(b.estimate_qbo_id || "")}" class="text-[12px] font-semibold text-blue-600 hover:underline">+ Add a payment${b.doc ? ` (#${escapeHtml(b.doc)})` : ""}</button>`).join("")}</div>`
      : `<div class="px-4 py-2 border-t border-black/[0.06]"><button data-add="expinst" data-sid="${escapeHtml(c.category)}" data-eq="${escapeHtml(groups[0]?.estimate_qbo_id || "")}" class="text-[12px] font-semibold text-blue-600 hover:underline">+ Add expense payment</button></div>`);
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
        ${c.timing_note ? `<div class="px-6 pt-2 pb-1 text-[11.5px] text-sky-900">${escapeHtml(c.timing_note)}</div>` : ""}
        ${(c.by_estimate || []).length > 1 || (c.by_estimate || [])[0]?.doc ? `<div class="px-6 pt-2 pb-1 text-[11.5px] text-black/60 flex flex-wrap gap-x-3 gap-y-1"><span class="font-bold text-black/45 uppercase text-[10px] tracking-wide">Planned per estimate</span>${c.by_estimate.map((b) => `<span class="tabular-nums">${b.doc ? `#${escapeHtml(b.doc)}` : "Whole project"} <b class="text-ink-900">${money(b.planned)}</b>${b.target && Math.abs(b.planned - b.target) > 1 ? ` <span class="text-black/45">of ${money(b.target)}</span>` : ""}</span>`).join("")}</div>` : ""}
        ${["Materials", "Propane", "Rentals", "Travel"].includes(c.category) ? `<div class="px-6 pt-1 text-[11.5px] text-sky-900">Billed at the end of each month: the estimate is split evenly over the month-ends the work runs, each paid that month-end.</div>` : ""}
        <div class="overflow-x-auto"><table class="w-full text-[12.5px]"><thead><tr class="text-[10px] font-bold uppercase tracking-wide text-black/40 border-b border-black/10"><th class="py-1.5 pl-6 text-left bl-th-exp0" title="When the vendor's bill is expected (an estimate unless a person edited it)">Expected bill date</th><th class="py-1.5 px-2 text-left bl-th-in" title="When the cash is expected to leave the bank. The Cash Flow forecast uses this date (blank = the bill date)">Expected paid</th><th class="py-1.5 px-2 text-right bl-th-inr">Amount</th><th class="py-1.5 pl-2 pr-4 text-right">Status</th></tr></thead><tbody>${weekly || `<tr><td colspan="4" class="px-6 py-2 text-black/40 text-[12px]">No schedule — add dates + estimate.</td></tr>`}</tbody></table></div>
        ${sumWarn}
        ${addRows}
        ${actuals}
      </div>
    </details>`;
  };

  // ── pending change orders (bottom of the invoice section) ──
  // From the Change Orders tab (app drafts + estimates sent/pending in QBO);
  // falls back to the QBO pending estimates when the CO list isn't available.
  const pcos = est.pending_cos || est.pending.map((e) => ({ doc_number: e.doc, amount: e.value, status: "sent", source: "qbo", kind: "change_order" }));
  const pcoTotal = pcos.reduce((s, c) => s + (c.amount || 0), 0);
  const pendingTray = pcos.length ? `
    <div class="rounded-xl border border-dashed border-amber-300 mt-1" style="background:rgba(255,251,235,.55)">
      <div class="flex items-center gap-2 px-4 py-2.5 flex-wrap">
        <span class="text-[10.5px] font-bold uppercase tracking-wide text-amber-800">Pending change orders: not billing yet</span>
        <a href="#" data-goto-cos class="text-[11px] font-semibold text-blue-600 hover:underline">Change Orders tab →</a>
        <span class="ml-auto tabular-nums text-[12.5px] font-bold text-ink-900">${money(pcoTotal)}</span>
      </div>
      ${pcos.map((c) => `<div class="flex items-center gap-2 px-4 py-1.5 text-[12.5px] flex-wrap" style="border-top:1px solid rgba(253,230,138,.7)">
        <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${c.status === "draft" ? "bg-slate-100 text-slate-600 border border-slate-300" : "bg-amber-50 text-amber-700 border border-amber-200"}">${c.status === "draft" ? "Draft (app)" : "Sent · awaiting approval"}</span>
        <span class="font-semibold text-ink-900">${c.kind === "change_order" && c.co_number ? `CO ${c.co_number}` : "Estimate"}${c.doc_number ? ` <span class="text-blue-700">#${escapeHtml(c.doc_number)}</span>` : ""}</span>
        ${c.title ? `<span class="text-black/60">${escapeHtml(c.title)}</span>` : ""}
        ${c.txn_date ? `<span class="text-black/40 text-[11px]">${shortDate(c.txn_date)}</span>` : ""}
        <span class="ml-auto tabular-nums font-semibold">${money(c.amount)}</span>
      </div>`).join("")}
      <div class="px-4 py-2 text-[11px] text-black/45" style="border-top:1px solid rgba(253,230,138,.7)">Not in the invoice schedule or the cash-flow forecast. Once it's accepted in QuickBooks it gets its own invoice schedule here automatically.</div>
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
            ${p.books_closed ? `<span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-black/60 bg-black/[0.06] border border-black/15 px-2 py-0.5 rounded-full" title="${p.books && p.books.why === "ended_before_cutover" ? "Ended before Oct 1 2026: its plans aren't in the cash forecast. Include it on Project Closeout if money is still to come or go." : "Closed out on Project Closeout"}">🔒 Books closed</span>` : p.books && p.books.finished ? `<span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-sky-800 bg-sky-50 border border-sky-200 px-2 py-0.5 rounded-full" title="Finished: its plans stay in the cash forecast until it's closed out on Project Closeout">Finished · books open until closed out</span>` : ""}
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
      <div data-bl-sec="summary" class="bl-kpis grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-black/10 border border-black/10 rounded-xl overflow-hidden">
        ${container.dataset.blOnly === "invoice" ? `
        ${kpi("Invoice total", est.contract_total)}
        ${kpi("Paid", est.collected, "text-emerald-700")}
        ${kpi("Sent, A/R", Math.max(0, est.invoiced_qbo - est.collected), "", retHeld > 0.5 ? `<span class="bl-ret-txt font-semibold">incl. ${money(retHeld)} retainage</span>` : "")}
        ${kpi("To bill", Math.max(0, est.contract_total - est.invoiced_qbo))}
        <div class="bg-white px-3 py-2.5 lg:col-span-2"><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">Project schedule</div>
          <div class="text-[15px] font-extrabold tabular-nums text-ink-900">${shortDate(p.start_date)} → ${shortDate(p.end_date)}</div>
          <div class="text-[11px] text-black/45">Each estimate's invoices follow its package's dates</div></div>` : `
        ${kpi("Contract", est.contract_total)}
        ${kpi("Collected", est.collected, "text-emerald-700")}
        ${kpi("Open A/R", est.open_ar, "", retHeld > 0.5 ? `<span class="bl-ret-txt font-semibold">incl. ${money(retHeld)} retainage</span>` : "")}
        ${kpi("Crew paid", crewPaid, "text-black/60")}
        ${kpi("Crew left", crewLeft, "text-black/60")}
        ${kpi("Expenses", exp.estimate_total, "text-black/60")}`}
      </div>
      <div class="card p-4 sm:p-5" data-bl-sec="cash">
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
      <details open class="group card overflow-hidden" data-bl-sec="invoice">
        <summary class="flex items-center gap-2 px-4 py-3 border-b border-black/10 bg-black/[0.02] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
          <svg class="w-3.5 h-3.5 text-black/30 transition-transform group-open:rotate-90 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
          <span class="text-sm font-bold text-ink-900">Customer invoices</span>
          <button data-terms-pill title="Change the invoice terms for this project" class="terms-pill inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">${escapeHtml(terms.label)} ▾</button>
          <span class="ml-auto tabular-nums text-[13px] font-bold text-ink-900">${money(est.contract_total)}</span>
        </summary>
        <div class="p-3">
          ${retainageBlock}
          ${est.accepted.map(invEstimateCard).join("") || `<div class="p-4 text-sm text-black/45">No accepted estimates yet.</div>`}
          ${pendingTray}
        </div>
      </details>

      <!-- CREW PAYMENTS -->
      <details open class="group card overflow-hidden" data-bl-sec="crew">
        <summary class="flex items-center gap-2 px-4 py-3 border-b border-black/10 bg-black/[0.02] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
          <svg class="w-3.5 h-3.5 text-black/30 transition-transform group-open:rotate-90 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
          <span class="text-sm font-bold text-ink-900">Crew payments</span>
          <span class="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full">rollup by crew · bi-weekly</span>
          ${p.books_closed ? "" : `<span class="flex items-center gap-1 flex-wrap" title="Crew offer per estimate">${est.accepted.filter((a) => (Number(a.labor) || 0) > 0).map((a) => `<span class="bl-ofh">#${escapeHtml(a.doc || "")} ${offerChip(a.offer, a, true)}</span>`).join("")}</span>`}
          <span class="ml-auto text-[12px] tabular-nums text-black/55"><b class="text-ink-900">${money(crewLaborEst)}</b> labor</span>
        </summary>
        <div class="p-3">
          ${crewCheckBanner(d.crew_check)}
          ${(d.crew_check && (d.crew_check.diffs || []).length) ? "" : `<div class="px-1 pb-2" data-ccx-slot></div>`}
          ${roll.rollups.map(rollupBlock).join("") || `<div class="p-4 text-sm text-black/45">No crew schedules yet — add assignment dates.</div>`}
          ${est.accepted.length ? `<div class="mt-1"><div class="text-[10.5px] font-bold uppercase tracking-wide text-black/40 px-1 mb-1">Crew assignment per estimate</div><div class="rounded-xl border border-black/10 overflow-hidden">${est.accepted.map(crewEstimateRow).join("")}</div></div>` : ""}
        </div>
        ${crewActuals}
      </details>

      <!-- EXPENSES -->
      <details open class="group card overflow-hidden" data-bl-sec="expense">
        <summary class="flex items-center gap-2 px-4 py-3 border-b border-black/10 bg-black/[0.02] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden">
          <svg class="w-3.5 h-3.5 text-black/30 transition-transform group-open:rotate-90 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path d="M7 5l6 5-6 5z"/></svg>
          <span class="text-sm font-bold text-ink-900">Project expenses</span>
          <span class="text-[11.5px] text-black/45">estimated vs. actual by line item · when the cash goes out</span>
          <span class="ml-auto tabular-nums text-[12px] text-black/55">${money(exp.estimate_total)} est · ${money(exp.spent_qbo)} actual</span>
        </summary>
        ${(exp.by_category && exp.by_category.length) ? exp.by_category.map(expenseCat).join("") : `<div class="px-4 py-4 text-[12.5px] text-black/45">No estimate cost lines to plan from.</div>`}
      </details>

      <div data-bl-sec="contrib">${contribHtml}</div>
    </div>`;
  if (_wasOpen.size) container.querySelectorAll("details > summary").forEach((sm) => { if (_wasOpen.has(_sumKey(sm))) sm.parentElement.open = true; });
  const only = container.dataset.blOnly;
  if (only) {
    container.querySelectorAll("[data-bl-sec]").forEach((el) => {
      const k = el.dataset.blSec;
      el.style.display = k === only || (only === "invoice" && k === "summary") ? "" : "none";
    });
  }

  // CR5 B3: crew-consistency chip near the crew section (fetched lazily so the
  // tab renders without waiting on it; re-fetched on every re-render so crew
  // reassignments move the chip).
  mountConsistencyChip(container, entityId);

  const post = async (url, label, btn) => {
    const orig = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = label; }
    try {
      const fresh = await api(url, { method: "POST" });
      render(container, entityId, fresh);
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = orig; }
      panelNote(container, "Failed: " + (err?.message || "error"));
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
    const restore = scrollState(container);
    try {
      const fresh = await api(`/billing/project/${encodeURIComponent(entityId)}`);
      const h = container.offsetHeight;
      if (h) container.style.minHeight = `${h}px`;
      render(container, entityId, fresh);
      restore();
      requestAnimationFrame(() => { container.style.minHeight = ""; restore(); });
    } catch (_) {}
    // every edit ends in a reload: let the Cash Flow drawer know the plan changed
    window.dispatchEvent(new CustomEvent("opi:billing-changed", { detail: { entityId } }));
  };
  const root = container.firstElementChild; // replaced every render → no listener stacking

  // Two-way % ↔ $ on milestone rows: typing in one recomputes the other LIVE
  // (amount = round(estimate × pct, 2); pct = amount / estimate, 1 decimal).
  // The change handler below then persists BOTH so stored pct and amount agree.
  root?.addEventListener("input", (e) => {
    const el = e.target.closest('[data-edit="milestone"]');
    if (!el) return;
    const field = el.getAttribute("data-field");
    if (field !== "pct" && field !== "amount") return;
    const row = el.closest("[data-ms-row]");
    const estVal = Number(row?.getAttribute("data-estval") || 0);
    if (!row || !estVal) return;
    const other = row.querySelector(`[data-edit="milestone"][data-field="${field === "pct" ? "amount" : "pct"}"]`);
    let v; try { v = parseNumInput(el.value); } catch (_) { return; }
    if (!other || v == null) return;
    if (field === "pct") other.value = fmtNum(Math.round(estVal * v) / 100);
    else other.value = Math.round((v / estVal) * 1000) / 10;
  });

  root?.addEventListener("change", async (e) => {
    // per-estimate crew reassignment (the rollup key / split)
    const cr = e.target.closest("[data-assign-crew]");
    if (cr) {
      const eq = cr.getAttribute("data-eq");
      cr.disabled = true;
      try { await api(`/billing/project/${encodeURIComponent(entityId)}/estimate/${encodeURIComponent(eq)}/crew`, { method: "POST", body: JSON.stringify({ crew_id: cr.value ? Number(cr.value) : null }) }); await reload(); }
      catch (err) { cr.disabled = false; panelNote(container, "Reassign failed: " + (err?.message || "error")); }
      return;
    }
    // inline field edits (invoice milestones / expense items)
    const el = e.target.closest("[data-edit]");
    if (!el) return;
    const kind = el.getAttribute("data-edit"), id = el.getAttribute("data-id"), field = el.getAttribute("data-field");
    let val = el.value;
    try {
      if (el.type === "number") val = val === "" ? null : Number(val);
      else if (el.hasAttribute("data-num")) val = parseNumInput(val);
      else if (el.hasAttribute("data-date")) { val = parseDateInput(val); el.value = mdy(val); }
    } catch (err) { panelNote(container, err.message); return; }
    const url = { milestone: `/invoices/milestone/${id}`, installment: `/payments/installment/${id}`, item: `/expenses/item/${id}`, expinst: `/expenses/expense-installment/${id}`, qboinv: `/invoices/qbo-invoice/${encodeURIComponent(id)}/expected` }[kind];
    if (!url) return;
    let payload = { [field]: val };
    // milestone % / $ save BOTH fields (kept in sync live by the input handler)
    if (kind === "milestone" && (field === "pct" || field === "amount") && val != null) {
      const estVal = Number(el.closest("[data-ms-row]")?.getAttribute("data-estval") || 0);
      if (estVal > 0) {
        payload = field === "pct"
          ? { pct: Math.round(val * 10) / 10, amount: Math.round(estVal * val) / 100 }
          : { amount: Math.round(val * 100) / 100, pct: Math.round((val / estVal) * 1000) / 10 };
      }
    }
    el.disabled = true;
    try { await api(url, { method: "PATCH", body: JSON.stringify(payload) }); await reload(); }
    catch (err) { el.disabled = false; panelNote(container, "Save failed: " + (err?.message || "error")); }
  });

  root?.addEventListener("click", async (e) => {
    const dp = e.target.closest("[data-dtpick]");
    if (dp) {
      e.preventDefault();
      const txt = dp.previousElementSibling, hid = dp.nextElementSibling;
      try { hid.value = parseDateInput(txt.value) || ""; } catch (_) { hid.value = ""; }
      hid.onchange = () => { if (!hid.value) return; txt.value = mdy(hid.value); txt.dispatchEvent(new Event("change", { bubbles: true })); };
      try { hid.showPicker(); } catch (_) { hid.click(); }
      return;
    }
    const ab = e.target.closest("[data-autobal]");
    if (ab) {
      ab.disabled = true; ab.textContent = "Balancing…";
      try { await api(`/invoices/schedule/${ab.getAttribute("data-autobal")}/auto-balance`, { method: "POST" }); await reload(); }
      catch (err) { ab.disabled = false; ab.textContent = "Balance automatically"; panelNote(container, "Failed: " + (err?.message || "error")); }
      return;
    }
    if (e.target.closest("[data-goto-cos]")) {
      e.preventDefault();
      const tab = document.querySelector('#tabBar [data-tab="changeorders"]');
      if (tab) tab.click();
      else location.hash = `#/entity/project/${encodeURIComponent(entityId)}?tab=changeorders`;   // from the Cash Flow drawer
      return;
    }
    const ad = e.target.closest("[data-autodates]");
    if (ad) {
      ad.disabled = true; ad.textContent = "…";
      try { await api(`/invoices/milestone/${ad.getAttribute("data-autodates")}`, { method: "PATCH", body: JSON.stringify({ auto_dates: true, via: "billing" }) }); await reload(); }
      catch (err) { ad.disabled = false; ad.textContent = "↺ auto"; panelNote(container, "Failed: " + (err?.message || "error")); }
      return;
    }
    const sd = e.target.closest("[data-srcdoc]");
    if (sd) {
      e.preventDefault();
      openDocViewer({ id: Number(sd.getAttribute("data-srcdoc")), filename: sd.getAttribute("data-srcname") || "" });
      return;
    }
    // terms pill lives inside a <details> summary — stop the toggle, open editor
    const tpill = e.target.closest("[data-terms-pill]");
    if (tpill) {
      e.preventDefault();
      e.stopPropagation();
      openTermsEditor(entityId, d, terms, container);
      return;
    }
    const confirmEst = e.target.closest("[data-confirm-est]");
    if (confirmEst) {
      e.preventDefault();
      e.stopPropagation();
      const eq = confirmEst.getAttribute("data-eq");
      post(`/billing/project/${encodeURIComponent(entityId)}/estimate/${encodeURIComponent(eq)}/confirm`, "Confirming…", confirmEst);
      return;
    }
    // multi-crew split (item #3): open the allocation editor / revert to single
    const splitBtn = e.target.closest("[data-crew-split]");
    if (splitBtn) {
      const eq = splitBtn.getAttribute("data-eq");
      openCrewSplitEditor(entityId, eq, crews, splitOf(eq), container);
      return;
    }
    const splitRevert = e.target.closest("[data-crew-split-revert]");
    if (splitRevert) {
      splitRevert.disabled = true;
      try {
        const fresh = await api(`/billing/project/${encodeURIComponent(entityId)}/estimate/${encodeURIComponent(splitRevert.getAttribute("data-eq"))}/crew-split`,
          { method: "POST", body: JSON.stringify({ allocations: [] }) });
        render(container, entityId, fresh);
      } catch (err) { splitRevert.disabled = false; panelNote(container, "Revert failed: " + (err?.message || "error")); }
      return;
    }
    // browse crews (availability picker) for one estimate → assign on pick
    const browse = e.target.closest("[data-crew-browse]");
    if (browse) {
      const eq = browse.getAttribute("data-eq");
      openCrewRoster(entityId, p.start_date, p.end_date, async (crewId) => {
        try { await api(`/billing/project/${encodeURIComponent(entityId)}/estimate/${encodeURIComponent(eq)}/crew`, { method: "POST", body: JSON.stringify({ crew_id: crewId ? Number(crewId) : null }) }); await reload(); }
        catch (err) { panelNote(container, "Reassign failed: " + (err?.message || "error")); }
      });
      return;
    }
    // record a sent offer as accepted (office-side)
    const oAccept = e.target.closest("[data-offer-accept]");
    if (oAccept) {
      oAccept.disabled = true;
      try {
        const r = await api(`/offers/${oAccept.getAttribute("data-offer-accept")}/respond`, { method: "POST", body: JSON.stringify({ status: "accepted" }) });
        assignToast(r); // #4 glue: "Crew assigned to the project schedule ✓" / "Already on the schedule"
        await reload();
      }
      catch (err) { oAccept.disabled = false; panelNote(container, "Failed: " + (err?.message || "error")); }
      return;
    }
    const script = e.target.closest("[data-offer-script]");
    if (script) {
      const cid = script.getAttribute("data-crew");
      const g = roll.rollups.find((x) => String(x.crew_id) === String(cid));
      if (g) openOfferScriptModal(rollupScript(g, p, d.offer_scope));
      return;
    }
    const oSend = e.target.closest("[data-offer-send]");
    if (oSend) {
      const crewId = oSend.getAttribute("data-crew"), labor = oSend.getAttribute("data-labor");
      if (!crewId) { panelNote(container, "Assign a crew first"); return; }
      oSend.disabled = true;
      try { await api(`/offers/project/${encodeURIComponent(entityId)}`, { method: "POST", body: JSON.stringify({ crew_id: Number(crewId), labor_amount: Number(labor || 0) }) }); await reload(); }
      catch (err) { oSend.disabled = false; panelNote(container, "Send failed: " + (err?.message || "error")); }
      return;
    }
    const oWithdraw = e.target.closest("[data-offer-withdraw]");
    if (oWithdraw) {
      try { await api(`/offers/${oWithdraw.getAttribute("data-offer-withdraw")}/withdraw`, { method: "POST" }); await reload(); }
      catch (err) { panelNote(container, "Withdraw failed: " + (err?.message || "error")); }
      return;
    }
    const xr = e.target.closest("[data-exp-revert],[data-exp-rebal],[data-exp-keep]");
    if (xr) {
      xr.disabled = true;
      let url;
      if (xr.dataset.expRevert) url = `/expenses/expense-installment/${xr.dataset.expRevert}/revert`;
      else {
        const [cat, q] = (xr.dataset.expRebal || xr.dataset.expKeep).split("|");
        url = `/expenses/project/${encodeURIComponent(entityId)}/category/${encodeURIComponent(cat)}/${xr.dataset.expRebal ? "rebalance" : "keep"}${q ? `?estimate_qbo_id=${encodeURIComponent(q)}` : ""}`;
      }
      try { await api(url, { method: "POST" }); await reload(); }
      catch (err) { xr.disabled = false; panelNote(container, "Couldn't save: " + (err?.message || "error")); }
      return;
    }
    const rb = e.target.closest("[data-crew-rebal],[data-crew-keep]");
    if (rb) {
      const sid = rb.dataset.crewRebal || rb.dataset.crewKeep;
      rb.disabled = true;
      try { await api(`/payments/schedule/${sid}/${rb.dataset.crewRebal ? "rebalance" : "keep-total"}`, { method: "POST" }); await reload(); }
      catch (err) { rb.disabled = false; panelNote(container, "Couldn't save: " + (err?.message || "error")); }
      return;
    }
    const es = e.target.closest("[data-est-script],[data-est-send]");
    if (es) {
      const a = est.accepted.find((x) => String(x.qbo_id) === String(es.dataset.estScript || es.dataset.estSend));
      if (!a) return;
      const canSend = !!a.crew_id && (!a.offer || a.offer.status === "declined");
      openEstimateOfferModal({ entityId, a, project: p, crewLabel: crewName(a.crew_id) || "the crew", canSend, onSent: reload });
      return;
    }
    const eo = e.target.closest("[data-est-outside]");
    if (eo) {
      const line = eo.closest(".bl-offer");
      if (!line || line.nextElementSibling?.matches("[data-outside-form]")) return;
      const a = est.accepted.find((x) => String(x.qbo_id) === String(eo.dataset.estOutside));
      const f = document.createElement("form");
      f.setAttribute("data-outside-form", "");
      f.className = "bl-outside";
      const today = new Date(); const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      f.innerHTML = `<b class="text-[12px]">Offer sent outside the app</b>
        <label>Sent <input name="sent" type="text" placeholder="mm/dd/yy" value="${mdy(iso)}" class="input text-xs py-1 w-[6rem]" required></label>
        <label>Accepted <input name="accepted" type="text" placeholder="mm/dd/yy (if it was)" class="input text-xs py-1 w-[8.5rem]"></label>
        <label class="bl-outside-file">Signed offer <input name="file" type="file" accept=".pdf,.png,.jpg,.jpeg,.heic,.doc,.docx,.xlsx,.eml,.msg" class="text-xs"></label>
        <button type="submit" class="bl-sum-btn">Record it</button><button type="button" data-outside-cancel class="text-[11.5px] text-black/50 hover:underline">Cancel</button>`;
      line.after(f);
      f.querySelector("[data-outside-cancel]").addEventListener("click", () => f.remove());
      f.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const fd = new FormData(f);
        let sent, acc;
        try { sent = parseDateInput(fd.get("sent")); acc = parseDateInput(fd.get("accepted")); }
        catch (err) { panelNote(container, err.message); return; }
        if (!sent) { panelNote(container, "When was it sent?"); return; }
        try {
          await api(`/offers/project/${encodeURIComponent(entityId)}/outside`, { method: "POST", body: JSON.stringify({ crew_id: Number(a.crew_id), labor_amount: Number(a.labor) || null, sent_date: sent, accepted_date: acc, estimate_qbo_id: a.qbo_id }) });
          const file = fd.get("file");
          if (file && file.size) {
            const up = new FormData(); up.append("file", file);
            await api(`/documents/project/${encodeURIComponent(entityId)}?folder=7_notes`, { method: "POST", body: up });
          }
          panelNote(container, acc ? "Recorded: sent and accepted." : "Recorded as sent.");
          await reload();
        } catch (err) { panelNote(container, "Couldn't record it: " + (err?.message || "error")); }
      });
      return;
    }
    const cd = e.target.closest("[data-confirm-dates]");
    if (cd) {
      cd.disabled = true;
      try { await api(`/payments/schedule/${cd.getAttribute("data-confirm-dates")}/confirm-dates`, { method: "POST" }); await reload(); }
      catch (err) { cd.disabled = false; panelNote(container, "Couldn't confirm: " + (err?.message || "error")); }
      return;
    }
    const add = e.target.closest("[data-add]");
    const del = e.target.closest("[data-del]");
    if (add) {
      const kind = add.getAttribute("data-add"), sid = add.getAttribute("data-sid");
      const eq = add.getAttribute("data-eq");
      const url = { milestone: `/invoices/schedule/${sid}/milestone`, installment: `/payments/schedule/${sid}/installment`, item: `/expenses/project/${encodeURIComponent(entityId)}/item`, expinst: `/expenses/project/${encodeURIComponent(entityId)}/category/${encodeURIComponent(sid)}/installment${eq ? `?estimate_qbo_id=${encodeURIComponent(eq)}` : ""}` }[kind];
      if (!url) return;
      add.disabled = true;
      try { await api(url, { method: "POST", body: JSON.stringify({}) }); await reload(); }
      catch (err) { add.disabled = false; panelNote(container, "Add failed: " + (err?.message || "error")); }
    } else if (del) {
      const kind = del.getAttribute("data-del"), id = del.getAttribute("data-id");
      const url = { milestone: `/invoices/milestone/${id}`, installment: `/payments/installment/${id}`, item: `/expenses/item/${id}`, expinst: `/expenses/expense-installment/${id}` }[kind];
      if (!url) return;
      try { await api(url, { method: "DELETE" }); await reload(); }
      catch (err) { panelNote(container, "Delete failed: " + (err?.message || "error")); }
    }
  });
}

// ── invoice-terms editor (0058) ─────────────────────────────────────────────
// The "35 / 35 / 30 · net-30" pill opens this. Percent split = comma list that
// must sum to 100 (max 6 parts); net days ≥ 0. Apply PUTs the project terms —
// the backend re-seeds every estimate's schedule, keeping invoiced/paid
// milestones and redistributing the remaining value over the new split's
// remaining lines.
const TERM_PRESETS = [
  { p: [35, 35, 30], n: 30 },
  { p: [50, 50], n: 30 },
  { p: [20, 20, 60], n: 10 },
  { p: [100], n: 30 },
];

function parseTermPercents(s) {
  const parts = String(s || "").split(",").map((x) => x.trim()).filter((x) => x !== "");
  if (!parts.length || parts.length > 6) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !isFinite(n) || n <= 0)) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.1) return null;
  return nums.map((n) => Math.round(n * 100) / 100);
}

function openTermsEditor(entityId, d, terms, container) {
  const est = d.estimates || { accepted: [] };
  const nScheds = est.accepted.filter((a) => a.schedule_id).length;
  // mirrors the backend lock rule: stored status sent/paid OR QBO burn-down
  // tier realized/committed (fully paid / fully invoiced)
  const nKept = est.accepted.reduce((s, a) =>
    s + (a.milestones || []).filter((m) => ["sent", "paid", "partial", "retainage"].includes(m.status)
      || ["realized", "committed", "retainage"].includes(m.tier) || m.qbo_invoice_id).length, 0);
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4";
  overlay.style.zIndex = "100";   // above the Cash Flow project drawer
  overlay.innerHTML = `<div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
    <div class="text-base font-bold text-ink-900 mb-1">Invoice terms</div>
    <div class="text-[12px] text-black/55 mb-3">Percent split of each estimate's value + days to pay. Applying re-seeds the milestone schedules below; milestones already invoiced or paid are kept.</div>
    <div class="flex flex-wrap gap-1.5 mb-3">${TERM_PRESETS.map((pr, i) =>
      `<button data-preset="${i}" class="tp-preset">${pr.p.join(" / ")} · net-${pr.n}</button>`).join("")}</div>
    <label class="block text-[11px] font-bold uppercase tracking-wide text-black/45 mb-1">Percent split (comma list, sums to 100)</label>
    <input data-tp-pct type="text" value="${escapeHtml((terms.percents || []).join(", "))}" class="tp-input mb-3" placeholder="35, 35, 30">
    <label class="block text-[11px] font-bold uppercase tracking-wide text-black/45 mb-1">Net days</label>
    <input data-tp-net type="number" min="0" step="1" value="${terms.net_days != null ? terms.net_days : 30}" class="tp-input tp-input-sm">
    <div data-tp-err class="text-[11.5px] text-red-600 font-semibold mt-2 hidden"></div>
    <div class="mt-4 flex items-center justify-end gap-2">
      <button data-close class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Cancel</button>
      <button data-apply class="btn-primary text-sm px-4 py-1.5">Apply to this project</button>
    </div></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("[data-close]").addEventListener("click", close);
  const pctEl = overlay.querySelector("[data-tp-pct]");
  const netEl = overlay.querySelector("[data-tp-net]");
  const errEl = overlay.querySelector("[data-tp-err]");
  overlay.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
    const pr = TERM_PRESETS[Number(b.getAttribute("data-preset"))];
    pctEl.value = pr.p.join(", ");
    netEl.value = pr.n;
    errEl.classList.add("hidden");
  }));
  overlay.querySelector("[data-apply]").addEventListener("click", async (e) => {
    const percents = parseTermPercents(pctEl.value);
    const netDays = Number(netEl.value);
    let err = null;
    if (!percents) err = "Percent split must be 1–6 positive numbers that sum to 100 (±0.1).";
    else if (!Number.isInteger(netDays) || netDays < 0 || netDays > 365) err = "Net days must be a whole number between 0 and 365.";
    if (err) { errEl.textContent = err; errEl.classList.remove("hidden"); return; }
    if (!confirm(`Apply ${percents.join("/")} net-${netDays} to this project?\n\nRe-seed ${nScheds} schedule${nScheds === 1 ? "" : "s"}; ${nKept} invoiced/paid milestone${nKept === 1 ? "" : "s"} kept. Other milestone rows (including hand-edits) are rebuilt on the new split.`)) return;
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "Applying…";
    try {
      const fresh = await api(`/billing/project/${encodeURIComponent(entityId)}/terms`,
        { method: "PUT", body: JSON.stringify({ percents, net_days: netDays }) });
      close();
      render(container, entityId, fresh);
    } catch (err2) {
      btn.disabled = false; btn.textContent = "Apply to this project";
      errEl.textContent = "Save failed: " + (err2?.message || "error");
      errEl.classList.remove("hidden");
    }
  });
}

// ── multi-crew split editor (item #3) ──────────────────────────────────────
// Rows of company select + pct; 2+ companies, pcts sum to 100. Save POSTs the
// allocation list (server re-validates: parents only, sum 100 ±0.1); the
// header crew becomes the FIRST allocation's company. "Revert to single"
// posts an empty list — back to today's single-crew behavior.
function openCrewSplitEditor(entityId, estimateQboId, crews, existing, container) {
  const companies = (crews || []).filter((c) => c.is_company);
  const fmtPct = (p) => (Number(p) === Math.round(Number(p)) ? String(Math.round(Number(p))) : String(Math.round(Number(p) * 100) / 100));
  let rows = (existing && existing.length >= 2)
    ? existing.map((a) => ({ company_crew_id: a.company_crew_id, pct: a.pct }))
    : [{ company_crew_id: companies[0] ? companies[0].id : "", pct: 50 },
       { company_crew_id: companies[1] ? companies[1].id : "", pct: 50 }];
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4";
  overlay.style.zIndex = "100";   // above the Cash Flow project drawer
  overlay.innerHTML = `<div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
    <div class="text-base font-bold text-ink-900 mb-1">Split crew payments — estimate ${escapeHtml(estimateQboId)}</div>
    <div class="text-[12px] text-black/55 mb-3">One payment schedule (same dates); each installment's amount is divided across the companies by these percentages. The first company becomes the estimate's primary crew.</div>
    <div data-split-rows></div>
    <button data-split-add class="text-[12px] font-semibold text-blue-600 hover:underline mt-1">+ Add company</button>
    <div data-split-sum class="text-[12px] font-semibold mt-2"></div>
    <div data-split-err class="text-[11.5px] text-red-600 font-semibold mt-1 hidden"></div>
    <div class="mt-4 flex items-center justify-end gap-2 flex-wrap">
      ${existing && existing.length ? `<button data-split-revert class="mr-auto text-[12px] font-semibold text-black/45 hover:text-red-600 hover:underline">Revert to single crew</button>` : ""}
      <button data-close class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Cancel</button>
      <button data-split-save class="btn-primary text-sm px-4 py-1.5">Save split</button>
    </div></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("[data-close]").addEventListener("click", close);
  const rowsEl = overlay.querySelector("[data-split-rows]");
  const sumEl = overlay.querySelector("[data-split-sum]");
  const errEl = overlay.querySelector("[data-split-err]");
  const drawSum = () => {
    const sum = rows.reduce((s, r) => s + (Number(r.pct) || 0), 0);
    const ok = Math.abs(sum - 100) <= 0.1;
    sumEl.innerHTML = `Total: <span class="tabular-nums ${ok ? "text-emerald-700" : "text-amber-700"}">${fmtPct(sum)}%</span>${ok ? " ✓" : " — must sum to 100"}`;
  };
  const draw = () => {
    rowsEl.innerHTML = rows.map((r, i) => `
      <div class="flex items-center gap-2 py-1.5 border-b border-black/[0.06]">
        <select data-split-co="${i}" class="flex-1 min-w-0 text-[12.5px] border border-black/15 rounded px-1.5 py-1 bg-white text-ink-900">
          ${companies.map((c) => `<option value="${c.id}" ${String(c.id) === String(r.company_crew_id) ? "selected" : ""}>${escapeHtml(c.label || c.name)}</option>`).join("")}
        </select>
        <input data-split-pct="${i}" type="number" min="0.01" max="100" step="0.01" value="${r.pct}" style="width:5.5rem" class="text-right tabular-nums text-[12.5px] border border-black/15 rounded px-1.5 py-1 bg-white text-ink-900">
        <span class="text-black/40 text-[11px]">%</span>
        <button data-split-del="${i}" class="text-black/25 hover:text-red-600 text-[13px]" title="Remove">✕</button>
      </div>`).join("");
    drawSum();
    rowsEl.querySelectorAll("[data-split-co]").forEach((el) => el.addEventListener("change", () => { rows[Number(el.getAttribute("data-split-co"))].company_crew_id = Number(el.value); }));
    rowsEl.querySelectorAll("[data-split-pct]").forEach((el) => el.addEventListener("input", () => { rows[Number(el.getAttribute("data-split-pct"))].pct = el.value === "" ? 0 : Number(el.value); drawSum(); }));
    rowsEl.querySelectorAll("[data-split-del]").forEach((el) => el.addEventListener("click", () => { rows.splice(Number(el.getAttribute("data-split-del")), 1); draw(); }));
  };
  draw();
  overlay.querySelector("[data-split-add]").addEventListener("click", () => {
    const used = new Set(rows.map((r) => String(r.company_crew_id)));
    const next = companies.find((c) => !used.has(String(c.id)));
    rows.push({ company_crew_id: next ? next.id : (companies[0] ? companies[0].id : ""), pct: 0 });
    draw();
  });
  const postSplit = async (allocations, btn, busyLabel) => {
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = busyLabel;
    try {
      const fresh = await api(`/billing/project/${encodeURIComponent(entityId)}/estimate/${encodeURIComponent(estimateQboId)}/crew-split`,
        { method: "POST", body: JSON.stringify({ allocations }) });
      close();
      render(container, entityId, fresh);
    } catch (err) {
      btn.disabled = false; btn.textContent = orig;
      errEl.textContent = "Save failed: " + (err?.message || "error");
      errEl.classList.remove("hidden");
    }
  };
  overlay.querySelector("[data-split-save]").addEventListener("click", (e) => {
    const sum = rows.reduce((s, r) => s + (Number(r.pct) || 0), 0);
    let err = null;
    if (rows.length < 2) err = "A split needs at least 2 companies (use Revert to go back to one crew).";
    else if (rows.some((r) => !r.company_crew_id)) err = "Pick a company on every row.";
    else if (new Set(rows.map((r) => String(r.company_crew_id))).size !== rows.length) err = "Each company may appear only once.";
    else if (rows.some((r) => !(Number(r.pct) > 0))) err = "Every percentage must be greater than 0.";
    else if (Math.abs(sum - 100) > 0.1) err = `Percentages must sum to 100 (currently ${fmtPct(sum)}).`;
    if (err) { errEl.textContent = err; errEl.classList.remove("hidden"); return; }
    errEl.classList.add("hidden");
    postSplit(rows.map((r) => ({ company_crew_id: Number(r.company_crew_id), pct: Number(r.pct) })), e.currentTarget, "Saving…");
  });
  overlay.querySelector("[data-split-revert]")?.addEventListener("click", (e) => {
    postSplit([], e.currentTarget, "Reverting…");
  });
}

// Scripted rollup crew offer — estimates + labor + total + payment schedule,
// ready to copy/email. Built from one crew rollup group.
// Parse "6467 - TVH - Olathe, KS" -> { company: "TVH", location: "Olathe, KS" }.
// OPI project display names are "<num> - <company> - <city, ST>".
function parseProjectName(name) {
  const parts = String(name || "").split(" - ");
  if (parts.length >= 3 && /^\d+$/.test(parts[0].trim()))
    return { company: parts[1].trim(), location: parts.slice(2).join(" - ").trim() };
  if (parts.length === 2) return { company: parts[0].trim(), location: parts[1].trim() };
  return { company: String(name || "").trim(), location: "" };
}

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function longDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.slice(0, 10) + "T00:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function dowOf(iso) {
  if (!iso) return "";
  return DOW[new Date(iso.slice(0, 10) + "T00:00:00").getDay()];
}

// Build the OPI crew job-offer email. Mirrors the format OPI sends:
// boilerplate terms, the offer line (company: location - Day M/D - $labor),
// scope of work (from the estimate's Installation (Labor) description), and the
// payment schedule (send-invoice date + pay date + amount, on Fridays).
function rollupScript(g, project, scope) {
  const { company, location } = parseProjectName(project?.name);
  const start = project?.start_date;
  const offerLine = `${company}${location ? ": " + location : ""}${start ? " - " + dowOf(start) + " " + longDate(start) : ""} - ${money(g.labor)}`;
  const L = [];
  L.push(`Please see the official offer below. The Payment Schedule below shows you when to send an invoice for payment and when it's expected to pay. This is subject to change.`);
  L.push("");
  L.push("Offer is based on a 5 man crew, working 7am-7pm");
  L.push("Offer is based on a lump sum");
  L.push("");
  L.push("Please note we will need your daily updates submitted to the designated PM no later than 5pm each day.");
  L.push("Work outside of the scope below needs to be approved/reported to the PM before work is performed.");
  L.push("Delays, changes or issues related to the customer or equipment needs to be reported to the PM ASAP.");
  L.push("");
  L.push(offerLine);
  L.push("");
  L.push("Scope of work:");
  L.push((scope && scope.trim()) ? scope.trim() : "[Add the Installation (Labor) scope from the estimate]");
  L.push("");
  L.push("Payment Schedule:");
  const insts = g.installments || [];
  if (!insts.length) {
    L.push("  (no schedule yet — add assignment dates)");
  } else {
    L.push("  Send Invoice   Payment Date   Amount");
    insts.forEach((i) => {
      const pay = i.pay_date ? i.pay_date.slice(0, 10) : null;
      const send = pay ? new Date(new Date(pay + "T00:00:00").getTime() - 7 * 864e5).toISOString().slice(0, 10) : null;
      L.push(`  ${(send ? longDate(send) : "—").padEnd(13)}  ${(pay ? longDate(pay) : "—").padEnd(13)}  ${money(i.amount)}`);
    });
  }
  L.push(`  Total: ${money(g.labor)}`);
  return L.join("\n");
}

// 2026-11-22 (owner): who QuickBooks paid vs the app's paid crew vs the crews on
// the Job Schedule sheet (backend app/crewcheck.py), called out when they differ.
function crewCheckBanner(cc) {
  if (!cc || !(cc.diffs || []).length) return "";
  const list = (xs) => (xs && xs.length ? xs.map(escapeHtml).join(", ") : "none");
  const paid = (cc.paid || []).map((x) => `${escapeHtml(x.name)} ${money(x.amount)}`).join(", ") || "nothing yet";
  return `<div class="mx-1 mb-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 text-[12px]">
      <div class="font-bold">Crew paid differs</div>
      <ul class="list-disc pl-4 mt-1 space-y-0.5">${cc.diffs.map((x) => `<li>${escapeHtml(x.text)}</li>`).join("")}</ul>
      <div class="mt-1.5 text-[11.5px] text-amber-900/80">QuickBooks paid: ${paid} · App's paid crew: ${list(cc.app_paid)} · On site in the app: ${list(cc.onsite)} · Job Schedule: ${cc.on_sheet ? list(cc.sheet) : "job not on the synced tabs"}</div>
      <div class="mt-1 text-[11.5px] text-amber-900/80">If QuickBooks shows the right crew, set it under Crew assignment per estimate below (crew payments follow it). If the Job Schedule is wrong, let whoever keeps the sheet know. A crew that helped on part of the job can be split across crews.</div>
    </div>`;
}

// 2026-11-19 (owner): the offer is per estimate, and its payment schedule is a
// grid like OPI's Drive Payment Schedule, so it pastes into Outlook as a table.
function estimateOffer(a, project, crewLabel) {
  const num = (String(project?.name || "").match(/^\s*(\d+)\s*-/) || [])[1] || "";
  const { company, location } = parseProjectName(project?.name);
  const insts = (a.crew_installments || []).filter((i) => i.pay_date).slice().sort((x, y) => String(x.pay_date).localeCompare(String(y.pay_date)));
  const lead = Number(a.crew_invoice_lead_days ?? 7);
  const sendOf = (i) => i.send_invoice_date || addDaysIso(i.pay_date, -lead);
  const total = insts.reduce((t, i) => t + (Number(i.amount) || 0), 0);
  const paid = insts.filter((i) => i.status === "paid").reduce((t, i) => t + (Number(i.amount) || 0), 0);
  const labor = Number(a.labor) || total;
  const start = a.crew_start || insts[0]?.pay_date || project?.start_date;
  const end = a.crew_end || project?.end_date;
  const md = (iso) => { if (!iso) return ""; const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${Number(m)}/${Number(d)}/${y}`; };
  const m2 = (n) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const scope = (a.offer_scope || "").trim() || "[Add the Installation (Labor) scope from the estimate]";
  const head = `${company}${location ? ": " + location : ""}${start ? " - " + dowOf(start) + " " + longDate(start) : ""} - ${money(labor)}${a.doc ? ` (estimate #${a.doc})` : ""}`;
  const intro = [
    "Please see the official offer below. The Payment Schedule below shows you when to send an invoice for payment and when it's expected to pay. This is subject to change.",
    "",
    "Offer is based on a 5 man crew, working 7am-7pm",
    "Offer is based on a lump sum",
    "",
    "Please note we will need your daily updates submitted to the designated PM no later than 5pm each day.",
    "Work outside of the scope below needs to be approved/reported to the PM before work is performed.",
    "Delays, changes or issues related to the customer or equipment needs to be reported to the PM ASAP.",
  ];
  // plain text (pastes anywhere)
  const L = [...intro, "", head, "", "Scope of work:", scope, "", "Payment Schedule:"];
  L.push(`  Project: ${company}${num ? " #" + num : ""}   Start ${md(start)}   End ${md(end)}`);
  L.push(`  Contract value ${m2(labor)}   Paid to date ${m2(paid)}   Remaining ${m2(labor - paid)}`);
  L.push("  #   Payment date   Amount          Send invoice   Comments");
  insts.forEach((i, k) => L.push(`  ${String(k + 1).padEnd(3)} ${md(i.pay_date).padEnd(14)} ${m2(i.amount).padEnd(15)} ${md(sendOf(i)).padEnd(14)} ${i.note || ""}`));
  L.push(`      Total          ${m2(total)}`);
  const text = L.join("\n");
  // HTML (inline styles: Outlook keeps them)
  const B = "border:1px solid #BFBFBF;padding:4px 8px;";
  const H = `${B}background:#A9C4EB;font-weight:bold;text-align:center;`;
  const C = `${B}text-align:center;`;
  const esc = escapeHtml;
  const info = [[["Project Name", company], ["Contract Value", m2(labor)]], [["Project Number", num], ["Paid to Date", m2(paid)]],
    [["Project Start Date", md(start)], ["Remaining Value", m2(labor - paid)]], [["Estimated End Date", md(end)], ["", ""]]];
  const grid = `<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:10.5pt;">
    <tr><td colspan="6" style="${H}">Estimated Contract Payment Schedule</td></tr>
    ${info.map(([[k1, v1], [k2, v2]]) => `<tr><td style="${B}">${esc(k1)}</td><td style="${C}">${esc(String(v1 || ""))}</td><td style="${B}"></td><td style="${B}"></td><td style="${B}">${esc(k2)}</td><td style="${B}text-align:right;">${esc(v2)}</td></tr>`).join("")}
    <tr><td colspan="6" style="${B}height:8px;"></td></tr>
    <tr><td style="${H}">Payment Number</td><td style="${H}">Payment Date</td><td style="${H}">Payment Amount</td><td style="${H}">Send Invoice Date</td><td style="${H}">Comments</td><td style="${H}"></td></tr>
    ${insts.map((i, k) => `<tr><td style="${C}">${k + 1}</td><td style="${C}">${md(i.pay_date)}</td><td style="${C}">${m2(i.amount)}</td><td style="${C}">${md(sendOf(i))}</td><td style="${C}">${esc(i.note || "")}</td><td style="${B}"></td></tr>`).join("")}
    <tr><td style="${B}"></td><td style="${C}font-weight:bold;">Total</td><td style="${C}font-weight:bold;">${m2(total)}</td><td style="${B}"></td><td style="${B}"></td><td style="${B}"></td></tr>
  </table>`;
  const P = (t) => `<p style="margin:0 0 10px 0;">${t}</p>`;
  const html = `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#111;">
    ${P(esc(intro[0]))}${P(`${esc(intro[2])}<br>${esc(intro[3])}`)}${P(`${esc(intro[5])}<br>${esc(intro[6])}<br>${esc(intro[7])}`)}
    ${P(`<b>${esc(head)}</b>`)}
    ${P(`<b>Scope of work:</b><br>${esc(scope).replace(/\n/g, "<br>")}`)}
    ${P("<b>Payment Schedule:</b>")}${grid}</div>`;
  return { text, html, labor, crewLabel };
}

function openEstimateOfferModal({ entityId, a, project, crewLabel, canSend, onSent }) {
  const off = estimateOffer(a, project, crewLabel);
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4";
  overlay.style.zIndex = "100";
  overlay.innerHTML = `<div class="bg-white rounded-2xl shadow-xl w-full max-w-3xl p-5 flex flex-col" style="max-height:92vh">
    <div class="text-base font-bold text-ink-900">Crew offer · estimate #${escapeHtml(a.doc || "")} · ${escapeHtml(crewLabel)}</div>
    <div class="text-[12px] text-black/50 mb-3">Edit it here if you like, then <b>Copy for email</b> and paste into Outlook: the payment schedule pastes as a table.${canSend ? " <b>Mark offer as sent</b> records it and saves the email and the payment schedule in the job's 7 Notes folder." : ""}</div>
    <div data-preview contenteditable="true" class="rounded-xl border border-black/15 p-4 overflow-auto bg-white text-ink-900" style="flex:1 1 auto;min-height:240px">${off.html}</div>
    <div class="mt-3 flex items-center justify-end gap-2 flex-wrap"><span data-msg class="text-xs font-semibold text-emerald-700 mr-auto"></span>
      <button data-close class="rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">Close</button>
      <button data-copy class="rounded-lg border border-blue-600 text-blue-700 px-3 py-1.5 text-sm font-semibold hover:bg-blue-50">Copy for email</button>
      ${canSend ? `<button data-send class="btn-primary text-sm px-4 py-1.5">Mark offer as sent</button>` : ""}</div></div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  const pv = overlay.querySelector("[data-preview]");
  const msg = overlay.querySelector("[data-msg]");
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("[data-close]").addEventListener("click", close);
  overlay.querySelector("[data-copy]").addEventListener("click", async () => {
    const html = pv.innerHTML, text = pv.innerText;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
    } catch (_) {
      const r = document.createRange(); r.selectNodeContents(pv);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      document.execCommand("copy"); sel.removeAllRanges();
    }
    msg.textContent = "Copied. Paste it into the email.";
  });
  overlay.querySelector("[data-send]")?.addEventListener("click", async (e) => {
    const b = e.currentTarget; b.disabled = true; msg.textContent = "Saving…";
    try {
      const r = await api(`/offers/project/${encodeURIComponent(entityId)}`, { method: "POST", body: JSON.stringify({
        crew_id: Number(a.crew_id), labor_amount: off.labor, scope: a.offer_scope || null, estimate_qbo_id: a.qbo_id,
        script_html: pv.innerHTML, script_text: pv.innerText }) });
      const files = (r.docs || []).map((d) => d.filename);
      panelNote(null, files.length ? `Offer recorded. Saved in 7 Notes: ${files.join(", ")}` : (r.docs_error ? `Offer recorded. The files didn't save: ${r.docs_error}` : "Offer recorded."));
      close();
      if (onSent) onSent();
    } catch (err) { b.disabled = false; msg.textContent = ""; panelNote(null, "Couldn't record the offer: " + (err?.message || "error")); }
  });
}

function openOfferScriptModal(text) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4";
  overlay.style.zIndex = "100";   // above the Cash Flow project drawer
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

// Crew Model v2 (CR3) browse-crews slide-over — ONE CARD PER COMPANY:
// "MTY · Jesse Rosales Jr. · 2 of 3 crews available" + the occupied-slot list
// ("JR1 · Gustavo Ramirez — 6304 DHL thru 10/09"; lead-less = "JR1 · lead
// TBD"). Assign = COMPANY assign with an optional lead pick — onPick gets the
// lead's crew id when one is chosen, else the company id (same backend path).
function openCrewRoster(entityId, start, end, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "fixed inset-0 z-[100]";
  wrap.style.zIndex = "100";   // above the Cash Flow project drawer
  wrap.innerHTML = `<div data-backdrop class="absolute inset-0 bg-black/30"></div>
    <div class="absolute top-0 right-0 h-full w-full max-w-md bg-white shadow-xl overflow-y-auto">
      <div class="sticky top-0 bg-white border-b border-black/10 px-4 py-3 flex items-center justify-between z-10">
        <div><div class="text-sm font-bold text-ink-900">Crew companies</div>
          <div class="text-[11px] text-black/45">${start && end ? "availability " + shortDate(start) + "–" + shortDate(end) + " · " : ""}$ paid &amp; jobs, last 365 days</div></div>
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
    const availBadge = (co) => co.available === null
      ? `<span class="text-[10px] font-bold text-black/45 bg-black/[0.04] border border-black/10 rounded-full px-2 py-0.5">${co.capacity} crew${co.capacity === 1 ? "" : "s"} · add dates for availability</span>`
      : co.available > 0
        ? `<span class="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">${co.available} of ${co.capacity} crews available</span>`
        : `<span class="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">0 of ${co.capacity} crews available</span>`;
    const thruShort = (s) => { if (!s) return "—"; const p = String(s).slice(0, 10).split("-"); return `${Number(p[1])}/${Number(p[2])}`; };
    wrap.querySelector("[data-roster]").innerHTML = (d.companies || []).map((co, i) => {
      const occ = (co.occupied || []).map((o) => `
        <div class="flex items-baseline gap-1.5 px-2 py-1 text-[12px] border-t border-black/[0.05]">
          <span class="font-bold tabular-nums text-ink-900">${escapeHtml(o.slot || "—")}</span>
          <span class="${o.lead ? "text-black/70" : "text-amber-700 font-semibold"}">· ${escapeHtml(o.lead || "lead TBD")}</span>
          <span class="text-black/45 truncate ml-auto text-right">— ${escapeHtml(o.project || "")} thru ${thruShort(o.thru)}</span>
        </div>`).join("");
      const leadOpts = `<option value="">— lead TBD —</option>` + (co.leads || []).map((l) =>
        `<option value="${l.id}">${escapeHtml(l.name)}</option>`).join("");
      // 0063 CREW TIME-OFF: company-level = the whole company is unavailable
      // for the overlap ("Unavailable Oct 10-14 · vacation"); lead-level =
      // that lead is off (availability already minus 1 server-side).
      const offNotes = (co.time_off || []).map((t) => {
        const range = timeOffRangeLabel(t.start_date, t.end_date);
        const tail = t.reason ? ` · ${escapeHtml(t.reason)}` : "";
        return t.level === "company"
          ? `<span class="cto-note">Unavailable ${escapeHtml(range)}${tail}</span>`
          : `<span class="cto-note">${escapeHtml(t.name)} off ${escapeHtml(range)}${tail}</span>`;
      }).join("");
      return `<div class="mb-3 rounded-xl border border-black/10 overflow-hidden">
        <div class="flex justify-between items-center gap-2 px-3 py-2 bg-black/[0.03] flex-wrap">
          <span class="font-bold text-[13px] text-ink-900">${escapeHtml(co.name)}${co.boss_name ? ` <span class="font-semibold text-black/55">· ${escapeHtml(co.boss_name)}</span>` : ""}</span>
          ${availBadge(co)}
        </div>
        ${offNotes}
        <div class="px-3 py-1 text-[11px] text-black/45 tabular-nums">${money(co.earned_365 || 0)} paid · ${co.jobs_365 || 0} job${co.jobs_365 === 1 ? "" : "s"} · 365d</div>
        ${occ ? `<div class="pb-1">${occ}</div>` : `<div class="px-3 pb-1.5 text-[11.5px] text-black/35">No crews booked in this window.</div>`}
        <div class="flex items-center gap-2 px-3 py-2 border-t border-black/[0.06] bg-black/[0.01]">
          <select data-lead-pick="${i}" class="flex-1 min-w-0 text-[12px] border border-black/15 rounded px-1.5 py-1 bg-white text-black/70">${leadOpts}</select>
          <button data-pick-co="${i}" data-cid="${co.id}" data-name="${escapeHtml(co.name)}"
            class="text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-3 py-1 whitespace-nowrap">Assign</button>
        </div>
      </div>`;
    }).join("") || `<div class="text-black/40 p-2">No crew companies found.</div>`;
    wrap.querySelectorAll("[data-pick-co]").forEach((b) => b.addEventListener("click", () => {
      const i = b.getAttribute("data-pick-co");
      const leadSel = wrap.querySelector(`[data-lead-pick="${i}"]`);
      const leadId = leadSel && leadSel.value ? leadSel.value : null;
      // company assign; a picked lead narrows it to that lead's crew id
      onPick(leadId || b.getAttribute("data-cid"), b.getAttribute("data-name"));
      close();
    }));
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
    // expected_paid_date (0058) wins when set — the realistic cash-lands date
    const arDate = m.expected_paid_date || m.due_date;
    const billDate = m.expected_paid_date || m.invoice_date;
    if (ar > 0.5 && arDate) inflow.push({ date: arDate.slice(0, 10), amt: ar });
    if (toBill > 0.5 && billDate) inflow.push({ date: billDate.slice(0, 10), amt: toBill });
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
