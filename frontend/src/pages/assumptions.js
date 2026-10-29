// Assumptions — every average and fixed rule the app uses to place dates and
// money, in one reviewable place (migration 0084).
//
//   Expense timing   measured nightly from QuickBooks bills: when each
//                    category's bills land relative to the job's start/end,
//                    and how long a bill takes to get paid. New expense
//                    schedules are spread by it; owners can override.
//   Actual vs estimate  measured on finished jobs, for review only — never
//                    applied to amounts.
//   Fixed rules      read from the app's code (35/35/30, payday, matching
//                    tolerances, categories, ...), so the page can't drift.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { fmtMoney } from "../utils/format.js";
import { escapeHtml } from "../utils/html.js";

// time-ordered: before start (warm grey) -> during the job (blues) -> after end (indigo)
const BUCKET_COLORS = {
  before: "#a8a29e", q1: "#bae6fd", q2: "#7dd3fc", q3: "#38bdf8", q4: "#0284c7",
  after30: "#6366f1", after30plus: "#3730a3",
};
const pct = (v) => `${Math.round((v || 0) * 100)}%`;
const days = (v) => (v == null ? "—" : `${Math.round(v)} days`);
const when = (s) => s ? new Date(s.replace(" ", "T")).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";

export async function assumptionsPage(routeFn) {
  const st = { data: null, editing: null, busy: false, msg: "" };
  setShell({
    title: "Assumptions",
    subtitle: "Every average and rule the app uses to place dates and money, with the evidence behind it.",
    bodyHtml: `<div id="asRoot"><div class="card p-6 text-sm text-black/45">Loading assumptions…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("asRoot");

  async function load() {
    try {
      st.data = await api("/assumptions");
      render();
    } catch (e) {
      root.innerHTML = `<div class="card p-6 text-sm text-red-700">Couldn't load assumptions: ${escapeHtml(e?.message || String(e))}</div>`;
    }
  }

  const eff = (it) => ({ ...(it.calibrated || {}), ...Object.fromEntries(Object.entries(it.override || {}).filter(([, v]) => v != null)) });

  function bar(profile, buckets) {
    if (!profile) return `<span class="text-xs text-black/40">Not enough dated jobs, spread evenly</span>`;
    return `<div class="flex h-5 w-full overflow-hidden rounded" style="min-width:220px" role="img" aria-label="${buckets.map(([k, l]) => `${l} ${pct(profile[k])}`).join(", ")}">
      ${buckets.map(([k, l]) => profile[k] > 0.004 ? `<div title="${escapeHtml(l)}: ${pct(profile[k])}" style="width:${profile[k] * 100}%;background:${BUCKET_COLORS[k]};line-height:20px" class="h-full text-[10px] text-center ${["q3", "q4", "after30", "after30plus"].includes(k) ? "text-white" : "text-black/70"} overflow-hidden">${profile[k] >= 0.07 ? pct(profile[k]) : ""}</div>` : "").join("")}
    </div>`;
  }

  function legend(buckets) {
    return `<div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-black/55">${buckets.map(([k, l]) =>
      `<span class="inline-flex items-center gap-1.5"><span class="inline-block w-3 h-3 rounded-sm" style="background:${BUCKET_COLORS[k]}"></span>${escapeHtml(l)}</span>`).join("")}</div>`;
  }

  function timingRow(it, d) {
    const e = eff(it), b = it.basis || {}, u = it.usage || {};
    const overridden = it.override && Object.keys(it.override).length;
    const evidence = `${(b.projects || 0).toLocaleString()} jobs · ${(b.lines || 0).toLocaleString()} bill lines · ${fmtMoney(b.amount || 0)} since ${escapeHtml(b.since || "")}`;
    const tops = (b.top_items || []).map(([n, a]) => `${n} ${fmtMoney(a)}`).join(", ");
    return `<tr class="border-t border-black/[0.06] align-top">
      <td class="py-3 pr-3 font-semibold whitespace-nowrap">${escapeHtml(it.category)}${overridden ? `<div class="mt-1"><span class="text-[10px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded px-1 py-0.5" title="${escapeHtml(`Overridden by ${it.override_by || "?"} ${when(it.override_at)}${it.override_note ? ": " + it.override_note : ""}`)}">Overridden</span></div>` : ""}</td>
      <td class="py-3 pr-3" style="width:38%">${bar(e.profile, d.buckets)}${overridden && it.calibrated?.profile && it.override?.profile ? `<div class="mt-1 opacity-50" title="Measured from QuickBooks">${bar(it.calibrated.profile, d.buckets)}</div><div class="text-[10px] text-black/40">measured (not in use)</div>` : ""}</td>
      <td class="py-3 pr-3 tabular-nums whitespace-nowrap">${days(e.paid_lag_days)}${it.override?.paid_lag_days != null ? `<div class="text-[10px] text-black/40">measured ${days(it.calibrated?.paid_lag_days)}</div>` : ""}<div class="text-[10px] text-black/40">${(b.paid_bills || 0).toLocaleString()} paid bills</div></td>
      <td class="py-3 pr-3 tabular-nums whitespace-nowrap">${days(e.entry_lag_days)}</td>
      <td class="py-3 pr-3 text-xs text-black/60"><div>${evidence}</div>${tops ? `<div class="text-black/40 mt-0.5">${escapeHtml(tops)}</div>` : ""}</td>
      <td class="py-3 pr-3 text-xs text-black/60 whitespace-nowrap">${u.projects ? `${u.projects} projects<div class="text-black/40">${u.auto_profile || 0} rows by history · ${u.auto_even || 0} even · ${u.edited || 0} hand-edited</div>` : `<span class="text-black/35">not in use</span>`}</td>
      <td class="py-3 text-right whitespace-nowrap">${d.can_edit ? `<button class="btn-ghost text-xs" data-edit="${escapeHtml(it.key)}">Override</button>` : ""}</td>
    </tr>${st.editing === it.key ? editorRow(it, d) : ""}`;
  }

  function editorRow(it, d) {
    const e = eff(it), p = e.profile || {};
    return `<tr class="bg-sky-50"><td colspan="7" class="p-3">
      <form id="asEdit" class="grid gap-3">
        <div class="text-xs text-black/60">Shares are rescaled to add up to 100%. Leave the payment lag blank to keep the measured value.</div>
        <div class="flex flex-wrap gap-3">${d.buckets.map(([k, l]) => `<label class="text-xs grid gap-1"><span class="text-black/55">${escapeHtml(l)}</span><input name="b_${k}" type="number" min="0" step="1" value="${Math.round((p[k] || 0) * 100)}" class="input w-24 tabular-nums"></label>`).join("")}
          <label class="text-xs grid gap-1"><span class="text-black/55">Bill to payment (days)</span><input name="lag" type="number" min="0" max="180" step="1" value="${it.override?.paid_lag_days ?? ""}" placeholder="${Math.round(it.calibrated?.paid_lag_days || 0)}" class="input w-28 tabular-nums"></label></div>
        <label class="text-xs grid gap-1"><span class="text-black/55">Why (shown on the page)</span><input name="note" maxlength="255" value="${escapeHtml(it.override_note || "")}" class="input"></label>
        <div class="flex gap-2"><button class="btn-primary text-xs" type="submit">Save override</button>
          ${it.override ? `<button class="btn-ghost text-xs" type="button" data-reset="${escapeHtml(it.key)}">Use measured values</button>` : ""}
          <button class="btn-ghost text-xs" type="button" data-cancel>Cancel</button></div>
      </form></td></tr>`;
  }

  function accuracyRow(it) {
    const c = it.calibrated || {}, b = it.basis || {};
    const r = c.actual_to_estimate || 0;
    const tone = r > 1.1 ? "text-rose-700" : r < 0.8 ? "text-amber-700" : "text-emerald-700";
    return `<tr class="border-t border-black/[0.06]">
      <td class="py-2 pr-3 font-semibold">${escapeHtml(it.category)}</td>
      <td class="py-2 pr-3 text-right tabular-nums">${fmtMoney(b.estimated || 0)}</td>
      <td class="py-2 pr-3 text-right tabular-nums">${fmtMoney(b.actual || 0)}</td>
      <td class="py-2 pr-3 text-right tabular-nums font-semibold ${tone}">${pct(r)}</td>
      <td class="py-2 pr-3 text-right tabular-nums">${pct(c.median_ratio)}</td>
      <td class="py-2 pr-3 text-right tabular-nums">${b.no_actual_projects || 0} of ${b.projects || 0}</td>
    </tr>`;
  }

  // Lodging follows Hotel Engine's billing calendar instead of a timing profile.
  function lodgingCard(d) {
    const it = d.items.find((i) => i.group === "lodging_billing");
    if (!it) return "";
    const v = eff(it), b = it.basis || {};
    const lodging = d.items.find((i) => i.key === "expense_timing.Lodging");
    const u = lodging?.usage || {};
    const fmtD = (s) => s ? new Date(`${s}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" }) : "—";
    const days = (a, z) => (a && z) ? Math.round((new Date(`${z}T00:00:00`) - new Date(`${a}T00:00:00`)) / 864e5) : null;
    return `<section class="card p-5">
      <h2 class="text-base font-bold">Lodging dates (Hotel Engine)</h2>
      <p class="text-sm text-black/60 mt-1" style="max-width:48rem">Lodging is planned on each job from its estimate (the B250-style company-wide Hotel Engine line was retired on 10/28 because it paid for the same hotel nights). The dates follow how Hotel Engine actually bills: the job's nights are spread over its scheduled days, each month's nights go on one statement dated about the <b>${v.bill_day}th of the following month</b>, and OPI pays it about <b>${Math.round(v.paid_lag_days || 0)} days</b> later (due ${v.due_days != null ? Math.round(v.due_days) + " days" : "—"} after the statement). These are estimates; the real statement replaces them when it posts.${u.auto_lodging ? ` Used by ${u.auto_lodging} lodging rows.` : ""}</p>
      <div class="overflow-x-auto mt-3"><table class="w-full text-sm">
        <thead><tr class="text-[11px] uppercase tracking-wide text-black/45"><th class="py-2 pr-3 text-left">Statement</th><th class="py-2 pr-3 text-left">Stays in</th><th class="py-2 pr-3 text-left">Dated</th><th class="py-2 pr-3 text-left">Due</th><th class="py-2 pr-3 text-left">Paid</th><th class="py-2 pr-3 text-right">Days to pay</th><th class="py-2 text-right">Amount</th></tr></thead>
        <tbody>${(b.bills || []).map((x) => `<tr class="border-t border-black/[0.06]"><td class="py-1.5 pr-3 tabular-nums">${escapeHtml(x.doc || "")}</td><td class="py-1.5 pr-3">${escapeHtml(x.stay_month || "")}</td><td class="py-1.5 pr-3 tabular-nums">${fmtD(x.date)}</td><td class="py-1.5 pr-3 tabular-nums">${fmtD(x.due)}</td><td class="py-1.5 pr-3 tabular-nums">${fmtD(x.paid)}</td><td class="py-1.5 pr-3 text-right tabular-nums">${days(x.date, x.paid) ?? "—"}</td><td class="py-1.5 text-right tabular-nums">${fmtMoney(x.amount)}</td></tr>`).join("")}</tbody>
      </table></div>
      <div class="text-xs text-black/45 mt-2">Measured from Hotel Engine's monthly statements since ${escapeHtml(b.since || "")} (it billed weekly before mid-2026). Re-measured nightly.</div>
    </section>`;
  }

  // 0087: when planned invoices are dated, and which estimates bill in one invoice.
  const KIND_ROWS = [
    ["deposit", "Deposit (35% at PO)", "Before the start, at its measured timing"],
    ["mobilization", "Mobilization (35% at start)", "The job's start date"],
    ["final", "Final (30% at completion)", "The job's end date"],
    ["full", "Payment in full (one invoice)", "The job's end date"],
  ];
  function invoiceCard(d) {
    const it = d.items.find((i) => i.key === "invoice_timing");
    if (!it) return "";
    const cal = it.calibrated || {}, ov = it.override || {}, b = it.basis || {};
    const k = (name) => ({ ...((cal.kinds || {})[name] || {}), ...Object.fromEntries(Object.entries((ov.kinds || {})[name] || {}).filter(([, v]) => v != null)) });
    const below = ov.single_below ?? cal.single_below;
    const off = (n) => n == null ? "—" : n === 0 ? "same day" : `${Math.abs(Math.round(n))} days ${n < 0 ? "before" : "after"}`;
    const overridden = ov && Object.keys(ov).length;
    const co = b.change_orders || {};
    const sh = (x, n) => n ? `${Math.round((x / n) * 100)}%` : "—";
    const editing = st.editing === "invoice_timing";
    const fmtD = (s) => s ? new Date(`${s}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" }) : "—";
    return `<section class="card p-5">
      <h2 class="text-base font-bold">Invoice dates ${overridden ? `<span class="text-[10px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded px-1 py-0.5 align-middle" title="${escapeHtml(`Overridden by ${it.override_by || "?"} ${when(it.override_at)}${it.override_note ? ": " + it.override_note : ""}`)}">Overridden</span>` : ""}</h2>
      <p class="text-sm text-black/60 mt-1" style="max-width:52rem">Planned (not yet sent) invoices are dated from the job dates. Mobilization goes out on the start date and the Final on the end date, and both move when the job dates change. The due date adds the project's net terms. <b>Expected paid</b> adds how long customers have actually taken to pay that kind of invoice, measured from QuickBooks; the Cash Flow forecast uses it. These rows show <b>auto · history</b> on the Billing tab. A date someone types is kept and marked <b>manual dates</b>. Once the real invoice is in QuickBooks, its dates take over.</p>
      <div class="overflow-x-auto mt-3"><table class="w-full text-sm">
        <thead><tr class="text-[11px] uppercase tracking-wide text-black/45"><th class="py-2 pr-3 text-left">Invoice</th><th class="py-2 pr-3 text-left">Invoiced on</th><th class="py-2 pr-3 text-left" title="Median days between the job date and the actual invoice date">OPI actually invoiced</th><th class="py-2 pr-3 text-left">Terms</th><th class="py-2 pr-3 text-left">Days to pay (used)</th><th class="py-2 text-right">Invoices measured</th></tr></thead>
        <tbody>${KIND_ROWS.map(([name, label, rule]) => { const x = k(name); return `<tr class="border-t border-black/[0.06]">
          <td class="py-2 pr-3 font-semibold">${escapeHtml(label)}</td>
          <td class="py-2 pr-3">${name === "deposit" ? `${off(x.offset_days)} the start` : escapeHtml(rule)}</td>
          <td class="py-2 pr-3 tabular-nums text-black/60">${off(x.measured_offset_days)} the ${x.anchor === "end" ? "end" : "start"}</td>
          <td class="py-2 pr-3 tabular-nums">${x.terms_days != null ? `net ${Math.round(x.terms_days)}` : "—"}</td>
          <td class="py-2 pr-3 tabular-nums font-semibold">${days(x.paid_lag_days)}${(ov.kinds || {})[name]?.paid_lag_days != null ? `<div class="text-[10px] font-normal text-black/40">measured ${days((cal.kinds || {})[name]?.paid_lag_days)}</div>` : ""}</td>
          <td class="py-2 text-right tabular-nums text-black/60">${x.n || 0}${x.n_paid ? ` <span class="text-black/40">(${x.n_paid} paid)</span>` : ""}</td></tr>`; }).join("")}</tbody>
      </table></div>
      <h3 class="text-xs font-bold uppercase tracking-wide text-black/45 mt-5">One invoice or 35/35/30</h3>
      <p class="text-sm text-black/60 mt-1" style="max-width:52rem">New invoice schedules bill <b>change orders${cal.change_orders_single === false ? " (not currently)" : ""}</b> and <b>estimates under ${fmtMoney(below || 0)}</b> in one invoice at completion; larger estimates bill 35/35/30. Custom terms set on a project always win. How OPI's estimates were actually billed in the last ${b.window_months || 24} months:</p>
      <div class="overflow-x-auto mt-2"><table class="w-full text-sm" style="max-width:46rem">
        <thead><tr class="text-[11px] uppercase tracking-wide text-black/45"><th class="py-2 pr-3 text-left">Estimate size</th><th class="py-2 pr-3 text-right">Estimates</th><th class="py-2 pr-3 text-right">1 invoice</th><th class="py-2 pr-3 text-right">2 invoices</th><th class="py-2 text-right">3 or more</th></tr></thead>
        <tbody>${(b.size_buckets || []).map((x) => `<tr class="border-t border-black/[0.06]"><td class="py-1.5 pr-3">${escapeHtml(x.label)}</td><td class="py-1.5 pr-3 text-right tabular-nums">${x.n}</td><td class="py-1.5 pr-3 text-right tabular-nums ${x.n && x.single / x.n >= 0.5 ? "font-bold" : ""}">${sh(x.single, x.n)}</td><td class="py-1.5 pr-3 text-right tabular-nums">${sh(x.two, x.n)}</td><td class="py-1.5 text-right tabular-nums ${x.n && x.three_plus / x.n >= 0.5 ? "font-bold" : ""}">${sh(x.three_plus, x.n)}</td></tr>`).join("")}
          <tr class="border-t border-black/[0.06]"><td class="py-1.5 pr-3">Change orders</td><td class="py-1.5 pr-3 text-right tabular-nums">${co.n || 0}</td><td class="py-1.5 pr-3 text-right tabular-nums font-bold">${sh(co.single || 0, co.n)}</td><td class="py-1.5 pr-3 text-right text-black/35" colspan="2">more than one</td></tr></tbody>
      </table></div>
      ${d.can_edit ? `<div class="mt-3">${editing ? `<form id="asInvEdit" class="grid gap-3 bg-sky-50 rounded-lg p-3">
          <div class="text-xs text-black/60">Leave a box blank to keep the measured value. Saving re-dates every auto · history invoice right away.</div>
          <div class="flex flex-wrap gap-3">
            <label class="text-xs grid gap-1"><span class="text-black/55">Deposit: days before start</span><input name="dep_off" type="number" min="0" max="180" step="1" value="${(ov.kinds || {}).deposit?.offset_days != null ? -ov.kinds.deposit.offset_days : ""}" placeholder="${Math.round(-((cal.kinds || {}).deposit?.offset_days || 0))}" class="input w-28 tabular-nums"></label>
            ${KIND_ROWS.map(([name, label]) => `<label class="text-xs grid gap-1"><span class="text-black/55">${escapeHtml(label.split(" (")[0])}: days to pay</span><input name="lag_${name}" type="number" min="0" max="180" step="1" value="${(ov.kinds || {})[name]?.paid_lag_days ?? ""}" placeholder="${Math.round((cal.kinds || {})[name]?.paid_lag_days || 0)}" class="input w-28 tabular-nums"></label>`).join("")}
            <label class="text-xs grid gap-1"><span class="text-black/55">One invoice under ($)</span><input name="below" type="number" min="0" step="500" value="${ov.single_below ?? ""}" placeholder="${cal.single_below || 0}" class="input w-32 tabular-nums"></label>
          </div>
          <label class="text-xs grid gap-1"><span class="text-black/55">Why (shown on the page)</span><input name="note" maxlength="255" value="${escapeHtml(it.override_note || "")}" class="input"></label>
          <div class="flex gap-2"><button class="btn-primary text-xs" type="submit">Save override</button>
            ${overridden ? `<button class="btn-ghost text-xs" type="button" data-reset="invoice_timing">Use measured values</button>` : ""}
            <button class="btn-ghost text-xs" type="button" data-cancel>Cancel</button></div>
        </form>` : `<button class="btn-ghost text-xs" data-edit="invoice_timing">Override</button>`}</div>` : ""}
      <details class="mt-3"><summary class="text-xs font-semibold text-black/55 cursor-pointer">Recent invoices measured (${(b.samples || []).length})</summary>
        <div class="overflow-x-auto mt-2"><table class="w-full text-xs">
          <thead><tr class="text-[10px] uppercase tracking-wide text-black/45"><th class="py-1 pr-3 text-left">Project</th><th class="py-1 pr-3 text-left">Invoice</th><th class="py-1 pr-3 text-left">Job</th><th class="py-1 pr-3 text-left">Invoiced</th><th class="py-1 pr-3 text-left">Due</th><th class="py-1 pr-3 text-left">Paid</th><th class="py-1 text-right">Amount</th></tr></thead>
          <tbody>${(b.samples || []).map((x) => `<tr class="border-t border-black/[0.05]"><td class="py-1 pr-3">${escapeHtml(x.project || "")}</td><td class="py-1 pr-3">${escapeHtml(x.label || "")}</td><td class="py-1 pr-3 tabular-nums whitespace-nowrap">${fmtD(x.start)} – ${fmtD(x.end)}</td><td class="py-1 pr-3 tabular-nums">${fmtD(x.invoice)}</td><td class="py-1 pr-3 tabular-nums">${fmtD(x.due)}</td><td class="py-1 pr-3 tabular-nums">${fmtD(x.paid)}</td><td class="py-1 text-right tabular-nums">${fmtMoney(x.amount)}</td></tr>`).join("")}</tbody>
        </table></div></details>
    </section>`;
  }

  function render() {
    const d = st.data;
    const timing = d.items.filter((i) => i.group === "expense_timing").sort((a, b) => (b.basis?.amount || 0) - (a.basis?.amount || 0));
    const acc = d.items.filter((i) => i.group === "estimate_accuracy").sort((a, b) => (b.basis?.estimated || 0) - (a.basis?.estimated || 0));
    const measured = timing[0]?.computed_at;
    const areas = [...new Set(d.rules.map((r) => r.area))];
    root.innerHTML = `
      <div class="grid gap-5">
        <div class="card p-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          <div class="text-black/60">Measured from QuickBooks <b>${when(measured)}</b> (every night after the sync), over the last ${d.window_months} months of job-tagged bills and card purchases.</div>
          ${d.can_edit ? `<div class="flex gap-2">
            <button class="btn-ghost text-xs" data-act="recalibrate" ${st.busy ? "disabled" : ""}>Re-measure now</button>
            <button class="btn-ghost text-xs" data-act="apply" ${st.busy ? "disabled" : ""} title="Rebuild expense rows the app generated (never hand-edited) on active projects using the values below">Re-spread auto expense rows</button>
          </div>` : ""}
          ${st.msg ? `<div class="w-full text-xs text-emerald-700">${escapeHtml(st.msg)}</div>` : ""}
        </div>

        <section class="card p-5">
          <h2 class="text-base font-bold">Expense timing</h2>
          <p class="text-sm text-black/60 mt-1" style="max-width:48rem">When each category's bills are dated relative to the job's scheduled start and end, as a share of dollars. A project's expense estimate is spread the same way, and each row's paid date is the bill week plus the bill-to-payment time. Categories measured from fewer than ${d.min_projects} jobs are spread evenly. Rows someone edited by hand are never re-spread.</p>
          <div class="mt-3">${legend(d.buckets)}</div>
          <div class="overflow-x-auto mt-3"><table class="w-full text-sm">
            <thead><tr class="text-left text-[11px] uppercase tracking-wide text-black/45">
              <th class="py-2 pr-3">Category</th><th class="py-2 pr-3">When bills land</th><th class="py-2 pr-3">Bill to payment</th>
              <th class="py-2 pr-3" title="Days between the bill/charge date and when it was entered in QuickBooks">Entered after</th>
              <th class="py-2 pr-3">Measured from</th><th class="py-2 pr-3">Used by</th><th></th></tr></thead>
            <tbody>${timing.map((it) => timingRow(it, d)).join("") || `<tr><td colspan="7" class="py-4 text-black/45">Not measured yet.</td></tr>`}</tbody>
          </table></div>
        </section>

        ${invoiceCard(d)}

        ${lodgingCard(d)}

        <section class="card p-5">
          <h2 class="text-base font-bold">Actual cost vs estimate</h2>
          <p class="text-sm text-black/60 mt-1" style="max-width:48rem">Jobs that ended at least 45 days ago: QuickBooks bills and card purchases tagged to the job, against the estimate's cost lines. <b>Shown for review only. The app does not adjust any amounts by these numbers.</b> A job with no actual cost in a category usually means the spend wasn't tagged to the job in QuickBooks (often card purchases), not that it cost nothing.</p>
          <div class="overflow-x-auto mt-3"><table class="w-full text-sm">
            <thead><tr class="text-[11px] uppercase tracking-wide text-black/45">
              <th class="py-2 pr-3 text-left">Category</th><th class="py-2 pr-3 text-right">Estimated</th><th class="py-2 pr-3 text-right">Actual</th>
              <th class="py-2 pr-3 text-right">Actual / estimate</th><th class="py-2 pr-3 text-right">Typical job</th><th class="py-2 pr-3 text-right">Jobs with $0 actual</th></tr></thead>
            <tbody>${acc.map(accuracyRow).join("") || `<tr><td colspan="6" class="py-4 text-black/45">Not measured yet.</td></tr>`}</tbody>
          </table></div>
        </section>

        <section class="card p-5">
          <h2 class="text-base font-bold">Fixed rules</h2>
          <p class="text-sm text-black/60 mt-1" style="max-width:48rem">Rules the app applies as set, not averages. Read straight from the app's code and settings, so this list always matches what is running. Rows marked <span class="text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded px-1">B250</span> are values copied from OPI's cash-flow sheet with no system of record yet.</p>
          ${areas.map((a) => `<h3 class="text-xs font-bold uppercase tracking-wide text-black/45 mt-4">${escapeHtml(a)}</h3>
            <div class="overflow-x-auto"><table class="w-full text-sm mt-1"><tbody>
            ${d.rules.filter((r) => r.area === a).map((r) => `<tr class="border-t border-black/[0.06] align-top">
              <td class="py-2 pr-3 font-semibold" style="width:22%">${escapeHtml(r.name)}${r.flag === "b250" ? ` <span class="text-[10px] font-bold text-rose-700 bg-rose-50 border border-rose-200 rounded px-1">B250</span>` : ""}</td>
              <td class="py-2 pr-3" style="width:32%">${escapeHtml(r.value)}</td>
              <td class="py-2 pr-3 text-black/60">${escapeHtml(r.drives)}</td>
              <td class="py-2 text-[11px] text-black/35 font-mono" style="width:18%">${escapeHtml(r.where)}</td></tr>`).join("")}
            </tbody></table></div>`).join("")}
        </section>
      </div>`;
  }

  root.addEventListener("click", async (ev) => {
    const t = ev.target.closest("button");
    if (!t) return;
    if (t.dataset.edit) { st.editing = st.editing === t.dataset.edit ? null : t.dataset.edit; render(); return; }
    if (t.hasAttribute("data-cancel")) { st.editing = null; render(); return; }
    if (t.dataset.reset) {
      st.data = await api(`/assumptions/${encodeURIComponent(t.dataset.reset)}`, { method: "PATCH", body: JSON.stringify({ override: null }) });
      st.editing = null; st.msg = "Back to the measured values. New schedules use them; re-spread to update existing auto rows."; render(); return;
    }
    if (t.dataset.act) {
      st.busy = true; st.msg = ""; render();
      try {
        if (t.dataset.act === "recalibrate") {
          st.data = await api("/assumptions/recalibrate", { method: "POST" });
          st.msg = "Re-measured from QuickBooks.";
        } else {
          const r = await api("/assumptions/apply", { method: "POST" });
          st.msg = `Re-spread auto expense rows on ${r.projects_rebuilt} projects${r.invoices ? ` and re-dated ${r.invoices.rows_redated} planned invoices` : ""}. Hand-edited rows were left as they were.`;
          st.data = await api("/assumptions");
        }
      } catch (e) { st.msg = `Failed: ${e?.message || e}`; }
      st.busy = false; render();
    }
  });

  root.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    if (ev.target.id === "asInvEdit") {
      const num = (n) => { const v = f.get(n); return v === "" || v == null ? null : Number(v); };
      const kinds = {};
      for (const [name] of KIND_ROWS) { const lag = num(`lag_${name}`); if (lag != null) kinds[name] = { paid_lag_days: lag }; }
      const dep = num("dep_off");
      if (dep != null) kinds.deposit = { ...(kinds.deposit || {}), offset_days: -dep };
      const override = { kinds, ...(num("below") != null ? { single_below: num("below") } : {}) };
      try {
        st.data = await api("/assumptions/invoice_timing", { method: "PATCH", body: JSON.stringify({ override, note: f.get("note") || null }) });
        st.editing = null; st.msg = "Override saved. Planned invoices marked auto · history were re-dated.";
      } catch (e) { st.msg = `Couldn't save: ${e?.message || e}`; }
      render();
      return;
    }
    const profile = Object.fromEntries(st.data.buckets.map(([k]) => [k, Number(f.get(`b_${k}`) || 0) / 100]));
    const lag = f.get("lag");
    const override = { profile, ...(lag !== "" && lag != null ? { paid_lag_days: Number(lag) } : {}) };
    try {
      st.data = await api(`/assumptions/${encodeURIComponent(st.editing)}`, { method: "PATCH", body: JSON.stringify({ override, note: f.get("note") || null }) });
      st.editing = null; st.msg = "Override saved. New schedules use it; re-spread to update existing auto rows.";
    } catch (e) { st.msg = `Couldn't save: ${e?.message || e}`; }
    render();
  });

  await load();
}
