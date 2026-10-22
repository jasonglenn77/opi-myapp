// Ashley's Tracker — the office's estimates & progress-invoicing summary
// ("Progress Invoice" workbook, Sheet1) and per-PM schedule (Sheet2), in-app.
//
// Invoicing view: one row per project (status, PM, dates, contract,
// invoiced %, remaining, the invoice schedule as dated chips, next action).
// A row expands to its estimates' invoice schedules — editable in place via
// the SAME /api/invoices endpoints the Billing & Schedule tab uses (shared
// rows, so both screens stay in sync; every change is audited) — plus the
// project's change history. Default view hides past projects unless they still
// have something to send, collect, or a payment that's late.
//
// PM Schedule view: per-PM timeline (overlaps + gaps) and table.
import { api, getToken } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import { mountAssignmentPanel } from "./assignment-panel.js";

const money = (v) => (v == null ? "—" : "$" + Math.round(Number(v)).toLocaleString("en-US"));
const money2 = (v) => (v == null ? "—" : "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtMD = (iso) => { if (!iso) return "—"; const [y, m, d] = iso.split("-"); return `${Number(m)}/${Number(d)}`; };
const fmtMDY = (iso) => { if (!iso) return "—"; const [y, m, d] = iso.split("-"); return `${Number(m)}/${Number(d)}/${y.slice(2)}`; };
const STATUS = {
  in_progress: ["In progress", "at-st-prog"], not_started: ["Not started", "at-st-ns"], pending: ["Pending", "at-st-pend"],
  needs_attention: ["Needs attention", "at-st-attn"], completed: ["Completed", "at-st-done"], canceled: ["Canceled", "at-st-cxl"],
};
const statusPill = (s) => { const [l, c] = STATUS[s] || [s || "—", "at-st-ns"]; return `<span class="at-pill ${c}">${escapeHtml(l)}</span>`; };
const TIER = { realized: ["Paid", "at-c-paid"], committed: ["Sent", "at-c-sent"], partial: ["Partly sent", "at-c-part"], scheduled: ["To bill", "at-c-bill"], retainage: ["Retainage held", "at-c-ret"] };
const chipClass = (m) => (m.flag === "overdue_send" ? "at-c-over" : m.flag === "send_soon" ? "at-c-soon" : m.flag === "payment_late" ? "at-c-late" : (TIER[m.tier] || TIER.scheduled)[1]);
const chipTitle = (m) => `${m.label || "Invoice"} · ${money2(m.amount)} · ${m.invoice_date ? "invoice " + fmtMDY(m.invoice_date) : "no date"} · ${(TIER[m.tier] || TIER.scheduled)[0]}${m.flag === "overdue_send" ? " — past its send date" : m.flag === "send_soon" ? " — send soon" : m.flag === "payment_late" ? " — payment past due" : m.flag === "retainage" ? ` — paid except ${money2(m.retainage_held)} retainage held (expected at release, not late)` : ""}`;
const UNB_WHY = { past: "past its planned date", completed: "project completed", no_date: "no invoice date", soon: "planned soon" };

const PREF = "opi_tracker_prefs";
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF) || "{}"); } catch (_) { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch (_) {} };

export async function trackerPage(routeFn) {
  const prefs = loadPrefs();
  const st = {
    view: prefs.view || "invoicing",
    scope: prefs.scope || "relevant",     // relevant | attention | all
    q: "", pm: prefs.pm || "", status: "",
    sort: prefs.sort || { key: "next", dir: 1 },
    expanded: new Set(), history: new Map(),
    rows: [], today: "", soonDays: 14,
    pm: prefs.pm || "",
    pmView: prefs.pmView || "timeline", pmData: null,
    invView: prefs.invView || "tracker",   // tracker | sheet (Ashley's workbook layout)
    sheet: null,
    pmStatuses: Array.isArray(prefs.pmStatuses) ? prefs.pmStatuses : [], pmQ: prefs.pmQ || "",
    tlStart: null, tlMonths: 6,
  };

  setShell({
    title: "Ashley's Tracker",
    subtitle: "Estimates & progress invoicing across every project, plus each PM's schedule.",
    bodyHtml: `<div id="atRoot"><div class="card p-6 text-sm text-black/45">Loading every project's billing…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("atRoot");

  try {
    const d = await api("/tracker/invoicing");
    st.rows = d.rows || []; st.today = d.today; st.soonDays = d.soon_days || 14;
  } catch (e) {
    root.innerHTML = `<div class="card p-6 text-sm text-red-700">Couldn't load the tracker: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }

  const SESSION = "opi_tracker_session";
  try {
    const ss = JSON.parse(sessionStorage.getItem(SESSION) || "null");
    if (ss) { st.q = ss.q || ""; (ss.expanded || []).forEach((id) => st.expanded.add(id)); st.status = ss.status || ""; }
  } catch (_) {}
  const persist = () => {
    savePrefs({ view: st.view, scope: st.scope, pm: st.pm, sort: st.sort, pmView: st.pmView,
      invView: st.invView, pmStatuses: st.pmStatuses, pmQ: st.pmQ });
    try { sessionStorage.setItem(SESSION, JSON.stringify({ q: st.q, expanded: [...st.expanded], status: st.status })); } catch (_) {}
  };

  // ── filtering + sorting ────────────────────────────────────────────────────
  const ATTN = new Set(["overdue_send", "send_soon", "payment_late", "unbilled_balance"]);
  function visibleRows() {
    const q = st.q.trim().toLowerCase();
    let rows = st.rows.filter((r) => {
      if (st.scope === "relevant" && !r.relevant) return false;
      if (st.scope === "attention" && !r.flags.some((f) => ATTN.has(f))) return false;
      if (st.pm && !r.pms.some((p) => String(p.id) === st.pm)) return false;
      if (st.status && r.status !== st.status) return false;
      if (q && !(`${r.name} ${r.customer || ""} ${r.estimates.map((e) => e.doc).join(" ")}`.toLowerCase().includes(q))) return false;
      return true;
    });
    const k = st.sort.key, dir = st.sort.dir;
    const val = (r) => {
      switch (k) {
        case "project": return r.name.toLowerCase();
        case "status": return r.status;
        case "pm": return (r.pms[0]?.name || "~").toLowerCase();
        case "start": return r.start || "9999";
        case "end": return r.end || "9999";
        case "contract": return r.contract;
        case "invoiced": return r.pct_invoiced ?? -1;
        case "remaining": return r.remaining;
        default: // next action: overdue first, then soonest unbilled date
          return r.next ? `${r.next.flag === "overdue_send" ? "0" : "1"}${r.next.date}` : "9";
      }
    };
    rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    return rows;
  }

  // ── rendering: shell (tabs) ────────────────────────────────────────────────
  function render() {
    root.innerHTML = `
      <div class="at-tabs" role="tablist">
        <button type="button" class="at-tab ${st.view === "invoicing" ? "on" : ""}" data-view="invoicing">Invoicing</button>
        <button type="button" class="at-tab ${st.view === "pm" ? "on" : ""}" data-view="pm">PM Schedule</button>
      </div>
      <div id="atBody"></div>`;
    if (st.view === "invoicing") renderInvoicing(); else renderPm();
  }

  // ── Invoicing view ─────────────────────────────────────────────────────────
  function kpis(rows) {
    const sum = (f) => rows.reduce((s, r) => s + (f(r) || 0), 0);
    const ms = rows.flatMap((r) => r.estimates.flatMap((e) => e.milestones));
    const over = ms.filter((m) => m.flag === "overdue_send");
    const soon = ms.filter((m) => m.flag === "send_soon");
    const late = rows.filter((r) => r.flags.includes("payment_late"));
    const ret = rows.filter((r) => (r.retainage_held || 0) > 0.5);
    const unb = rows.filter((r) => r.unbilled);
    const contract = sum((r) => r.contract), invoiced = sum((r) => r.invoiced);
    const card = (label, value, sub, cls = "", act = "") => `
      <button type="button" class="at-kpi ${cls}" ${act ? `data-kpi="${act}"` : "disabled"}>
        <div class="at-kpi-l">${label}</div><div class="at-kpi-v">${value}</div><div class="at-kpi-s">${sub}</div>
      </button>`;
    return `<div class="at-kpis">
      ${card("Projects", rows.length, st.scope === "all" ? "all projects" : st.scope === "attention" ? "needing attention" : "active + open items")}
      ${card("Contract", money(contract), `${money(invoiced)} invoiced · ${contract ? Math.round(invoiced / contract * 100) : 0}%`)}
      ${card("Left to bill", money(sum((r) => r.remaining)), "contract − invoiced")}
      ${card(`Send in next ${st.soonDays} days`, soon.length, money(soon.reduce((s, m) => s + (m.remaining ?? m.amount ?? 0), 0)), soon.length ? "at-kpi-soon" : "", "attention")}
      ${card("Past send date", over.length, money(over.reduce((s, m) => s + (m.remaining ?? m.amount ?? 0), 0)), over.length ? "at-kpi-over" : "", "attention")}
      ${card("Payments past due", late.length, `${money(sum((r) => (r.flags.includes("payment_late") ? r.open_ar - (r.retainage_held || 0) : 0)))} open A/R`, late.length ? "at-kpi-late" : "", "attention")}
      ${card("Balance to bill", unb.length, `${money(sum((r) => (r.unbilled ? r.unbilled.amount : 0)))} on partly-billed jobs`, unb.length ? "at-kpi-soon" : "", "attention")}
      ${card("Retainage held", ret.length, `${money(sum((r) => r.retainage_held || 0))} · expected at release`)}
    </div>`;
  }

  function pmOptions() {
    const m = new Map();
    st.rows.forEach((r) => r.pms.forEach((p) => m.set(String(p.id), p.name)));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }

  const TH = (key, label, cls = "") => {
    const on = st.sort.key === key;
    return `<th class="${cls}"><button type="button" class="at-sort ${on ? "on" : ""}" data-sort="${key}">${label}${on ? (st.sort.dir > 0 ? " ▲" : " ▼") : ""}</button></th>`;
  };

  function scheduleChips(r) {
    const ms = r.estimates.flatMap((e) => e.milestones);
    if (!ms.length) return `<span class="at-muted">${r.estimates.length ? "No invoice schedule" : "No accepted estimate"}</span>`;
    // Identical date + state chips collapse into one with a count (projects
    // with several estimates repeat the same 35/35/30 dates).
    const groups = new Map();
    for (const m of [...ms].sort((x, y) => String(x.invoice_date || "9").localeCompare(String(y.invoice_date || "9")))) {
      const k = `${m.invoice_date}|${chipClass(m)}`;
      const g = groups.get(k) || { m, n: 0, amt: 0, titles: [] };
      g.n += 1; g.amt += Number(m.amount) || 0; g.titles.push(chipTitle(m));
      groups.set(k, g);
    }
    return `<div class="at-chips">${[...groups.values()].map((g) => `<span class="at-chip ${chipClass(g.m)}" title="${escapeHtml(g.titles.join(" | "))}">${fmtMD(g.m.invoice_date)}${g.n > 1 ? `<i class="at-chip-n">×${g.n}</i>` : ""}</span>`).join("")}</div>`;
  }

  function nextCell(r) {
    if (r.flags.includes("payment_late") && (!r.next || r.next.flag !== "overdue_send")) {
      return `<div class="at-next at-next-late">Payment past due<div class="at-sub">${money(r.open_ar)} open A/R</div></div>`;
    }
    if (!r.next && r.unbilled) {
      return `<div class="at-next at-next-unb">Balance to bill · ${money(r.unbilled.amount)}<div class="at-sub">${escapeHtml(UNB_WHY[r.unbilled.why] || "")}</div></div>`;
    }
    if (!r.next) {
      if (r.contract && r.remaining < 1) return `<div class="at-next ${r.retainage_held > 0.5 ? "at-next-ret" : "at-next-done"}">${r.retainage_held > 0.5 ? `Fully invoiced<div class="at-sub">${money(r.retainage_held)} retainage held</div>` : "Fully invoiced"}</div>`;
      return `<span class="at-muted">—</span>`;
    }
    const n = r.next;
    const cls = n.flag === "overdue_send" ? "at-next-over" : n.flag === "send_soon" ? "at-next-soon" : "";
    const lead = n.flag === "overdue_send" ? `Send — was due ${fmtMD(n.date)}` : `Send ${fmtMD(n.date)}`;
    return `<div class="at-next ${cls}">${lead}<div class="at-sub">${escapeHtml(n.label || "Invoice")} · ${money(n.amount)}</div></div>`;
  }

  function pmCell(r) {
    if (!r.pms.length) return `<span class="at-muted">—</span>`;
    return r.pms.map((p) => `<span class="at-pm" title="${escapeHtml(p.name)}${p.primary ? " (primary)" : ""}">${escapeHtml(p.initials)}</span>`).join("");
  }

  function rowHtml(r) {
    const open = st.expanded.has(r.entity_id);
    const pct = r.pct_invoiced ?? 0;
    return `
      <tr class="at-row ${open ? "open" : ""}" data-row="${escapeHtml(r.entity_id)}">
        <td class="at-proj">
          <div class="at-pname"><span class="at-caret">${open ? "▾" : "▸"}</span>${escapeHtml(r.name)}</div>
          <div class="at-sub">${escapeHtml(r.customer || "")}${r.flags.includes("pending_estimate") ? ` · <span class="at-flag-pend">pending estimate</span>` : ""}${r.retainage_held > 0.5 ? ` · <span class="at-flag-ret" title="Invoices paid except the retainage the customer is holding back — expected at release, not overdue">${money(r.retainage_held)} retainage held</span>` : ""}${r.unbilled ? ` · <span class="at-flag-unb" title="Partly billed — the rest is ${escapeHtml(UNB_WHY[r.unbilled.why] || "")}">${money(r.unbilled.amount)} balance to bill</span>` : ""}</div>
        </td>
        <td><button type="button" class="at-stbtn" data-assign="${escapeHtml(r.entity_id)}" title="Change status, dates, PM or crew">${statusPill(r.status)}</button></td>
        <td class="at-nowrap">${pmCell(r)}</td>
        <td class="at-nowrap">${r.start ? `${fmtMDY(r.start)} – ${fmtMDY(r.end)}<div class="at-sub">${r.days != null ? `${r.days} days` : ""}</div>` : `<span class="at-muted">No dates</span>`}</td>
        <td class="at-num">${money(r.contract)}</td>
        <td class="at-num">${money(r.invoiced)}<div class="at-bar"><span style="width:${Math.min(100, pct)}%"></span></div><div class="at-sub">${r.pct_invoiced != null ? pct + "%" : ""}</div></td>
        <td class="at-num">${money(r.remaining)}</td>
        <td>${scheduleChips(r)}</td>
        <td>${nextCell(r)}</td>
      </tr>
      ${open ? `<tr class="at-drill-row"><td colspan="9">${drillHtml(r)}</td></tr>` : ""}`;
  }

  // ── drill-down: editable invoice schedules + history ──
  const dateIn = (m, f) => `<input type="date" class="at-in" data-ms="${m.id}" data-f="${f}" value="${escapeHtml(m[f] || "")}">`;
  function estimateHtml(r, e) {
    const total = e.milestones.reduce((s, m) => s + (Number(m.amount) || 0), 0);
    const off = e.milestones.length && Math.abs(total - e.value) > 1;
    return `
      <div class="at-est">
        <div class="at-est-h">
          <div><b>Estimate #${escapeHtml(e.doc || "—")}</b> <span class="at-muted">· ${e.date ? fmtMDY(e.date) : "no date"}</span></div>
          <div class="at-est-nums">
            <span>Value <b>${money2(e.value)}</b></span>
            <span title="Actual QuickBooks invoices">Invoiced <b>${money2(e.invoiced)}</b></span>
            <span>Paid <b>${money2(e.paid)}</b></span>
            <span>Open A/R <b class="${e.open_ar - (e.retainage_held || 0) > 0.5 ? "at-amber" : ""}">${money2(e.open_ar)}</b>${e.retainage_held > 0.5 ? ` <span class="at-flag-ret">(${money2(e.retainage_held)} retainage)</span>` : ""}</span>
            <span>Left to bill <b>${money2(e.to_bill)}</b></span>
          </div>
        </div>
        <div class="at-tablewrap">
          <table class="at-ms">
            <thead><tr><th>Invoice</th><th>%</th><th>Amount</th><th>Invoice date</th><th>Due date</th><th>Expected paid</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${e.milestones.map((m) => `
                <tr data-msrow="${m.id}">
                  <td><input type="text" class="at-in at-in-label" data-ms="${m.id}" data-f="label" value="${escapeHtml(m.label || "")}"></td>
                  <td><input type="number" step="0.1" min="0" class="at-in at-in-pct" data-ms="${m.id}" data-f="pct" data-val="${e.value}" value="${m.pct ? Math.round(m.pct * 10) / 10 : ""}"></td>
                  <td><input type="number" step="0.01" class="at-in at-in-amt" data-ms="${m.id}" data-f="amount" data-val="${e.value}" value="${m.amount != null ? Math.round(m.amount * 100) / 100 : ""}"></td>
                  <td>${dateIn(m, "invoice_date")}</td>
                  <td>${dateIn(m, "due_date")}</td>
                  <td>${dateIn(m, "expected_paid_date")}</td>
                  <td class="at-nowrap"><span class="at-chip ${chipClass(m)}">${escapeHtml(m.status_label || (TIER[m.tier] || TIER.scheduled)[0])}</span>${m.edited ? ` <span class="at-edited" title="Edited by hand">edited</span>` : ""}</td>
                  <td><button type="button" class="at-x" data-delms="${m.id}" title="Delete this invoice line">✕</button></td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div class="at-est-f">
          ${e.schedule_id ? `<button type="button" class="at-btn" data-addms="${e.schedule_id}" data-ent="${escapeHtml(r.entity_id)}">+ Add invoice line</button>` : `<span class="at-muted">No invoice schedule yet — create it on Billing &amp; Schedule.</span>`}
          ${e.milestones.length ? `<span class="${off ? "at-warn" : "at-muted"}">Σ ${money2(total)} of ${money2(e.value)}${off ? ` — you changed this schedule: it's ${money2(Math.abs(total - e.value))} ${total < e.value ? "short of" : "over"} the estimate` : " · adds up"}</span>` : ""}
        </div>
        ${invoicesHtml(e)}
      </div>`;
  }

  // The real QuickBooks invoices behind this estimate (read-only) — so the
  // planned lines above can be adjusted to match what was actually billed.
  function invoicesHtml(e) {
    const inv = e.invoices || [];
    if (!inv.length) return `<div class="at-actuals at-muted">No QuickBooks invoices yet for this estimate.</div>`;
    return `
      <div class="at-actuals">
        <div class="at-actuals-h">Actual QuickBooks invoices</div>
        <div class="at-tablewrap"><table class="at-ms">
          <thead><tr><th>Invoice #</th><th>Date</th><th>Due</th><th class="at-num">Amount</th><th class="at-num">Balance</th><th>Status</th></tr></thead>
          <tbody>${inv.map((x) => `
            <tr>
              <td><b>${escapeHtml(x.doc || "—")}</b>${!x.estimate_doc ? ` <span class="at-muted">(no estimate link in QuickBooks)</span>` : ""}</td>
              <td>${fmtMDY(x.date)}</td><td>${fmtMDY(x.due)}</td>
              <td class="at-num">${money2(x.amount)}</td><td class="at-num">${money2(x.balance)}</td>
              <td><span class="at-chip ${x.status === "Paid" ? "at-c-paid" : x.retainage ? "at-c-ret" : x.late ? "at-c-late" : "at-c-sent"}">${x.status === "Paid" ? "Paid" : x.retainage ? "Retainage held" : x.late ? `${escapeHtml(x.status)} · past due` : escapeHtml(x.status)}</span></td>
            </tr>`).join("")}</tbody>
        </table></div>
      </div>`;
  }

  function historyHtml(id) {
    const h = st.history.get(id);
    if (!h) return `<div class="at-muted">Loading history…</div>`;
    if (!h.length) return `<div class="at-muted">No billing changes recorded for this project yet.</div>`;
    const fmtWhen = (v) => { const d = new Date(String(v).replace(" ", "T") + "Z"); return Number.isNaN(d.getTime()) ? v : d.toLocaleString(); };
    const FIELD = { label: "Name", pct: "%", amount: "Amount", invoice_date: "Invoice date", due_date: "Due date", expected_paid_date: "Expected paid", status: "Status", note: "Note" };
    const val = (f, v) => (v == null || v === "" ? "blank" : f === "amount" ? money2(v) : f === "pct" ? `${v}%` : /_date$/.test(f) ? fmtMDY(String(v).slice(0, 10)) : String(v));
    return `<ul class="at-hist">${h.map((x) => {
      let what;
      if (x.action === "billing.milestone_update" && x.changes) {
        what = Object.entries(x.changes).map(([f, [o, n]]) => `${FIELD[f] || f}: ${escapeHtml(val(f, o))} → <b>${escapeHtml(val(f, n))}</b>`).join(" · ");
        what = `<i>${escapeHtml(x.label || "Invoice")}</i> — ${what}`;
      } else if (x.action === "billing.milestone_add") what = "Added an invoice line";
      else if (x.action === "billing.milestone_delete") what = `Deleted invoice line <i>${escapeHtml(x.label || "")}</i>${x.deleted ? ` (${escapeHtml(money2(x.deleted.amount))}, ${escapeHtml(val("invoice_date", x.deleted.invoice_date))})` : ""}`;
      else if (x.action === "billing.terms_update") what = "Changed the project's invoice terms (schedule re-seeded)";
      else if (x.action === "billing.crew_split") what = "Changed the crew payment split";
      else what = escapeHtml(x.action);
      return `<li><span class="at-hist-when">${escapeHtml(fmtWhen(x.at))} · ${escapeHtml(x.who || "unknown")}${x.via === "tracker" ? " · via tracker" : ""}</span><span>${what}</span></li>`;
    }).join("")}</ul>`;
  }

  function drillHtml(r) {
    return `
      <div class="at-drill">
        <div class="at-drill-top">
          <div class="at-muted">Edits save as you go and update this project's <b>Billing &amp; Schedule</b> too. Every change is recorded below.</div>
          <span class="at-btnrow">
            <button type="button" class="at-btn" data-assign="${escapeHtml(r.entity_id)}">Assignment · status &amp; dates</button>
            <button type="button" class="at-btn" data-openbilling="${escapeHtml(r.entity_id)}">Open Billing &amp; Schedule ↗</button>
          </span>
        </div>
        ${r.estimates.length ? r.estimates.map((e) => estimateHtml(r, e)).join("") : `<div class="at-muted">No accepted estimates on this project.</div>`}
        ${r.pending_estimates.length ? `<div class="at-pendnote">Pending estimate${r.pending_estimates.length > 1 ? "s" : ""}: ${r.pending_estimates.map((p) => `#${escapeHtml(p.doc || "?")} (${money(p.value)})`).join(", ")} — not on the invoice schedule until accepted.</div>` : ""}
        <details class="at-histbox" data-hist="${escapeHtml(r.entity_id)}" ${st.history.has(r.entity_id) ? "open" : ""}>
          <summary>Change history</summary>
          <div data-histbody="${escapeHtml(r.entity_id)}">${historyHtml(r.entity_id)}</div>
        </details>
      </div>`;
  }

  const invToggle = () => `
    <div class="at-seg" role="group" title="Switch between the tracker and Ashley's Progress Invoice workbook layout">
      <button type="button" class="${st.invView === "tracker" ? "on" : ""}" data-invview="tracker">Tracker</button>
      <button type="button" class="${st.invView === "sheet" ? "on" : ""}" data-invview="sheet">Workbook</button>
    </div>`;

  function renderInvoicing() {
    if (st.invView === "sheet") { renderSheet(); return; }
    const rows = visibleRows();
    const body = document.getElementById("atBody");
    body.innerHTML = `
      ${kpis(rows)}
      <div class="at-filters">
        ${invToggle()}
        <input type="search" class="at-search" placeholder="Search project, customer or estimate #…" value="${escapeHtml(st.q)}" data-q>
        <div class="at-seg" role="group">
          ${[["relevant", "Active + open items"], ["attention", "Needs attention"], ["all", "All projects"]].map(([k, l]) => `<button type="button" class="${st.scope === k ? "on" : ""}" data-scope="${k}">${l}</button>`).join("")}
        </div>
        <select class="at-select" data-pm><option value="">All PMs</option>${pmOptions().map(([id, n]) => `<option value="${id}" ${st.pm === id ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}</select>
        <select class="at-select" data-status><option value="">All statuses</option>${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}" ${st.status === k ? "selected" : ""}>${l}</option>`).join("")}</select>
      </div>
      <div class="at-legend">
        <span class="at-chip at-c-paid">Paid</span><span class="at-chip at-c-sent">Sent</span><span class="at-chip at-c-bill">To bill</span>
        <span class="at-chip at-c-soon">Send soon</span><span class="at-chip at-c-over">Past send date</span><span class="at-chip at-c-late">Payment late</span><span class="at-chip at-c-ret">Retainage held</span>
        <span class="at-muted">· chips are each invoice's date — hover for details · click a project to edit</span>
      </div>
      <div class="at-card">
        <div class="at-tablewrap">
          <table class="at-table">
            <thead><tr>
              ${TH("project", "Project")}${TH("status", "Status")}${TH("pm", "PM")}${TH("start", "Dates")}
              ${TH("contract", "Contract", "at-num")}${TH("invoiced", "Invoiced", "at-num")}${TH("remaining", "Left to bill", "at-num")}
              <th>Invoice schedule</th>${TH("next", "Next action")}
            </tr></thead>
            <tbody>${rows.length ? rows.map(rowHtml).join("") : `<tr><td colspan="9" class="at-empty">No projects match these filters.</td></tr>`}</tbody>
          </table>
        </div>
      </div>`;
  }

  // ── Workbook view: Ashley's "Progress Invoice" sheet, column for column ────
  // A–I = QuickBooks' Estimates & Progress Invoicing Summary by Customer (open
  // estimates grouped by project, "Total for …" rows); J–O = the Job Schedule
  // columns she adds (job name, PM, invoice dates, start/end, job days), from
  // the app's assignment data. Styled like the spreadsheet; exports to .xlsx/.csv.
  const COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O"];
  const num2 = (v) => (v == null ? "" : Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const xlDate = (iso) => { if (!iso) return "?"; const [y, m, d] = iso.split("-"); return `${m}-${d}-${y.slice(2)}`; };
  const invDates = (ds) => (!ds.length ? "?" : ds.length === 1 ? xlDate(ds[0]) : ds.map(fmtMD).join(", "));

  function sheetGroups() {
    const q = st.q.trim().toLowerCase();
    return st.sheet.groups.map((g) => ({
      ...g,
      rows: g.rows.filter((x) => {
        if (st.pm && !x.pm_ids.includes(st.pm)) return false;
        if (st.status && x.sched_status !== st.status) return false;
        if (q && !`${g.name} ${x.customer} ${x.num} ${x.job_name}`.toLowerCase().includes(q)) return false;
        return true;
      }),
    })).filter((g) => g.rows.length);
  }

  function sheetHtml(groups) {
    let n = 1;
    const rn = () => `<td class="ws-rn">${++n}</td>`;
    const body = groups.map((g) => {
      const amt = g.rows.reduce((s, x) => s + x.amount, 0), inv = g.rows.reduce((s, x) => s + (x.invoiced || 0), 0);
      return `
        <tr class="ws-grp">${rn()}<td class="ws-a">${escapeHtml(g.name)}</td>${"<td></td>".repeat(14)}</tr>
        ${g.rows.map((x) => `
          <tr class="ws-row" data-goproj="${escapeHtml(x.entity_id)}" title="Open ${escapeHtml(x.customer)} in the tracker">${rn()}
            <td></td><td>${escapeHtml(x.date)}</td><td>${escapeHtml(x.num)}</td><td>${escapeHtml(x.status)}</td>
            <td>${escapeHtml(x.customer)}</td><td class="ws-n">${num2(x.amount)}</td><td class="ws-n">${num2(x.invoiced)}</td>
            <td class="ws-n">${num2(x.pct * 100)}%</td><td class="ws-n">${num2(x.remaining)}</td>
            <td class="ws-c">${escapeHtml(x.job_name)}</td><td class="ws-c ws-ctr">${escapeHtml(x.pm)}</td>
            <td class="ws-c ws-ctr">${escapeHtml(invDates(x.invoice_dates))}</td>
            <td class="ws-c ws-ctr">${xlDate(x.start)}</td><td class="ws-c ws-ctr">${xlDate(x.end)}</td>
            <td class="ws-c ws-ctr">${escapeHtml(String(x.job_days ?? "?"))}</td>
          </tr>`).join("")}
        <tr class="ws-tot">${rn()}<td class="ws-a">Total for ${escapeHtml(g.name)}</td>${"<td></td>".repeat(4)}
          <td class="ws-n ws-rule">$${num2(amt)}</td><td class="ws-n ws-rule">$${num2(inv)}</td>${"<td></td>".repeat(8)}</tr>`;
    }).join("");
    const all = groups.flatMap((g) => g.rows);
    const tAmt = all.reduce((s, x) => s + x.amount, 0), tInv = all.reduce((s, x) => s + (x.invoiced || 0), 0);
    return `
      <div class="ws-wrap">
        <table class="ws-table">
          <colgroup><col class="ws-col-rn">${COLS.map((c) => `<col class="ws-col-${c}">`).join("")}</colgroup>
          <thead>
            <tr class="ws-letters"><th class="ws-corner"></th>${COLS.map((c) => `<th>${c}</th>`).join("")}</tr>
            <tr class="ws-head"><th class="ws-rn">1</th>${st.sheet.columns.map((h, i) => `<th class="${i >= 9 ? "ws-c" : ""}">${escapeHtml(h)}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${body || `<tr><td class="ws-rn">2</td><td colspan="15" class="ws-empty">No open estimates match these filters.</td></tr>`}
            ${all.length ? `<tr class="ws-tot ws-grand"><td class="ws-rn">${n + 1}</td><td class="ws-a">TOTAL</td>${"<td></td>".repeat(4)}
              <td class="ws-n ws-rule ws-dbl">$${num2(tAmt)}</td><td class="ws-n ws-rule ws-dbl">$${num2(tInv)}</td>${"<td></td>".repeat(8)}</tr>` : ""}
          </tbody>
        </table>
      </div>`;
  }

  async function renderSheet() {
    const body = document.getElementById("atBody");
    if (!st.sheet) {
      body.innerHTML = `<div class="at-filters">${invToggle()}</div><div class="at-card at-pad at-muted">Loading the Progress Invoice sheet…</div>`;
      try { st.sheet = await api("/tracker/progress-sheet"); }
      catch (e) { body.innerHTML = `<div class="at-filters">${invToggle()}</div><div class="at-card at-pad" style="color:#b91c1c">Couldn't load: ${escapeHtml(e?.message || String(e))}</div>`; return; }
      if (st.invView !== "sheet" || st.view !== "invoicing") return;
    }
    const groups = sheetGroups();
    const est = groups.reduce((s, g) => s + g.rows.length, 0);
    body.innerHTML = `
      <div class="at-filters">
        ${invToggle()}
        <input type="search" class="at-search" placeholder="Search project, customer, estimate # or job name…" value="${escapeHtml(st.q)}" data-q>
        <select class="at-select" data-pm><option value="">All PMs</option>${pmOptions().map(([id, nm]) => `<option value="${id}" ${st.pm === id ? "selected" : ""}>${escapeHtml(nm)}</option>`).join("")}</select>
        <select class="at-select" data-status><option value="">All statuses</option>${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}" ${st.status === k ? "selected" : ""}>${l}</option>`).join("")}</select>
        <span class="ws-export">
          <button type="button" class="at-btn" data-export="xlsx">Export Excel</button>
          <button type="button" class="at-btn" data-export="csv">CSV</button>
        </span>
      </div>
      <div class="at-legend">
        <span class="at-muted">${groups.length} project${groups.length === 1 ? "" : "s"} · ${est} open estimate${est === 1 ? "" : "s"} · A–I from QuickBooks estimates &amp; linked invoices · J–O from the app's assignments · click a row to open it in the tracker</span>
      </div>
      ${sheetHtml(groups)}`;
  }

  async function exportSheet(btn) {
    const fmt = btn.getAttribute("data-export");
    const qs = new URLSearchParams({ fmt, q: st.q.trim(), pm: st.pm, status: st.status });
    const orig = btn.textContent; btn.disabled = true; btn.textContent = "Exporting…";
    try {
      const res = await fetch(`/api/tracker/progress-sheet/export?${qs}`, { headers: { Authorization: "Bearer " + getToken() } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || `Progress Invoice.${fmt}`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await res.blob()); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { toast(`Export failed: ${e?.message || e}`, true); }
    btn.disabled = false; btn.textContent = orig;
  }

  // ── PM Schedule view ───────────────────────────────────────────────────────
  async function renderPm() {
    const body = document.getElementById("atBody");
    if (!st.pmData) {
      body.innerHTML = `<div class="at-card at-pad at-muted">Loading PM schedules…</div>`;
      try { st.pmData = await api("/tracker/pm-schedule"); }
      catch (e) { body.innerHTML = `<div class="at-card at-pad" style="color:#b91c1c">Couldn't load: ${escapeHtml(e?.message || String(e))}</div>`; return; }
    }
    if (!st.tlStart) {
      const t = new Date(st.pmData.today + "T00:00:00");
      st.tlStart = new Date(t.getFullYear(), t.getMonth() - 1, 1);
    }
    body.innerHTML = `
      <div class="at-filters">
        <div class="at-seg" role="group">
          <button type="button" class="${st.pmView === "timeline" ? "on" : ""}" data-pmview="timeline">Timeline</button>
          <button type="button" class="${st.pmView === "table" ? "on" : ""}" data-pmview="table">Table</button>
        </div>
        <input type="search" class="at-search" placeholder="Search job #, project or customer…" value="${escapeHtml(st.pmQ)}" data-pmq>
        <select class="at-select" data-pmsel><option value="">All PMs</option>${st.pmData.pms.map((p) => `<option value="${p.id}" ${st.pm === String(p.id) ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}</select>
        ${st.pmView === "timeline" ? `
          <div class="at-seg" role="group">
            <button type="button" data-tlnav="-1">‹ Earlier</button>
            <button type="button" data-tlnav="0">Today</button>
            <button type="button" data-tlnav="1">Later ›</button>
          </div>
          <select class="at-select" data-tlmonths>${[3, 6, 12].map((n) => `<option value="${n}" ${st.tlMonths === n ? "selected" : ""}>${n} months</option>`).join("")}</select>` : ""}
      </div>
      <div class="pms-status" role="group" aria-label="Filter by status">
        <span class="pms-status-l">Status</span>
        <button type="button" class="pms-st ${st.pmStatuses.length ? "" : "on"}" data-pmst="">All</button>
        ${Object.entries(STATUS).map(([k, [l, c]]) => `<button type="button" class="pms-st ${st.pmStatuses.includes(k) ? `on ${c}` : ""}" data-pmst="${k}">${l}</button>`).join("")}
      </div>
      ${st.pmView === "timeline" ? timelineHtml() : pmTableHtml()}`;
  }

  // PM filter + status chips + search apply to both the timeline and the table;
  // with a status/search filter on, PMs left with nothing are hidden.
  const pmList = () => {
    const q = st.pmQ.trim().toLowerCase();
    const sts = new Set(st.pmStatuses);
    const filtered = !!(q || sts.size);
    return st.pmData.pms.filter((p) => !st.pm || String(p.id) === st.pm)
      .map((p) => ({ ...p, items: p.items.filter((i) => (!sts.size || sts.has(i.status))
        && (!q || `${i.name} ${i.customer || ""}`.toLowerCase().includes(q))) }))
      .filter((p) => !filtered || p.items.length);
  };

  function pmTableHtml() {
    return pmList().map((p) => {
      const items = [...p.items].sort((a, b) => String(a.start || "9999").localeCompare(String(b.start || "9999")));
      return `
        <div class="at-card at-pmcard">
          <div class="at-pmhead"><span class="at-pm">${escapeHtml(p.initials)}</span><b>${escapeHtml(p.name)}</b><span class="at-muted">${items.length} assignment${items.length === 1 ? "" : "s"}</span></div>
          <div class="at-tablewrap"><table class="at-table at-compact">
            <thead><tr><th>Project</th><th>Status</th><th>Start</th><th>End</th><th class="at-num">Days</th></tr></thead>
            <tbody>${items.map((i) => `
              <tr class="at-row" data-goproj="${escapeHtml(i.entity_id)}">
                <td>${escapeHtml(i.name)}</td><td>${statusPill(i.status)}</td>
                <td>${fmtMDY(i.start)}</td><td>${fmtMDY(i.end)}</td><td class="at-num">${i.days ?? "—"}</td>
              </tr>`).join("")}</tbody>
          </table></div>
        </div>`;
    }).join("") || `<div class="at-card at-pad at-muted">No PM assignments${st.pmQ || st.pmStatuses.length ? " match these filters" : ""}.</div>`;
  }

  function timelineHtml() {
    const DAY = 86400000;
    const start = st.tlStart;
    const end = new Date(start.getFullYear(), start.getMonth() + st.tlMonths, 1);
    const span = (end - start) / DAY;
    const pos = (iso) => (new Date(iso + "T00:00:00") - start) / DAY / span * 100;
    const today = new Date(st.pmData.today + "T00:00:00");
    const months = [];
    for (let i = 0; i < st.tlMonths; i++) {
      const m = new Date(start.getFullYear(), start.getMonth() + i, 1);
      months.push(`<div class="at-tl-month" style="left:${(m - start) / DAY / span * 100}%;width:${(new Date(m.getFullYear(), m.getMonth() + 1, 1) - m) / DAY / span * 100}%">${m.toLocaleString("en-US", { month: "short" })}${m.getMonth() === 0 || i === 0 ? " " + m.getFullYear() : ""}</div>`);
    }
    const startIso = start.toISOString().slice(0, 10), endIso = new Date(end - DAY).toISOString().slice(0, 10);
    const todayLeft = (today - start) / DAY / span * 100;

    const lanes = pmList().map((p) => {
      const items = p.items.filter((i) => i.start && i.end && i.end >= startIso && i.start <= endIso)
        .sort((a, b) => a.start.localeCompare(b.start));
      // stack overlapping bars into rows
      const rowsEnd = [];
      const placed = items.map((i) => {
        let r = rowsEnd.findIndex((e) => e < i.start);
        if (r < 0) { r = rowsEnd.length; rowsEnd.push(i.end); } else rowsEnd[r] = i.end;
        return { ...i, row: r };
      });
      // overlap bands: days covered by 2+ active (non-canceled) assignments
      const active = items.filter((i) => i.status !== "canceled");
      const ev = [];
      active.forEach((i) => { ev.push([i.start, 1]); const nx = new Date(new Date(i.end + "T00:00:00").getTime() + DAY).toISOString().slice(0, 10); ev.push([nx, -1]); });
      ev.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
      const bands = []; let n = 0, from = null;
      for (const [d, k] of ev) {
        const before = n; n += k;
        if (before < 2 && n >= 2) from = d;
        if (before >= 2 && n < 2 && from) { bands.push([from, d]); from = null; }
      }
      const overlapDays = bands.reduce((s, [a, b]) => s + (new Date(b) - new Date(a)) / DAY, 0);
      const rowsN = Math.max(1, rowsEnd.length);
      const clamp = (v) => Math.max(0, Math.min(100, v));
      return `
        <div class="at-lane">
          <div class="at-lane-h">
            <span class="at-pm">${escapeHtml(p.initials)}</span>
            <div><b>${escapeHtml(p.name)}</b><div class="at-sub">${items.length} in view${overlapDays ? ` · <span class="at-ovl">${Math.round(overlapDays)} overlap day${Math.round(overlapDays) === 1 ? "" : "s"}</span>` : ""}</div></div>
          </div>
          <div class="at-lane-track" style="height:${rowsN * 30 + 8}px">
            ${bands.map(([a, b]) => `<div class="at-tl-band" style="left:${clamp(pos(a))}%;width:${clamp(pos(b)) - clamp(pos(a))}%" title="Overlap ${fmtMDY(a)} – ${fmtMDY(new Date(new Date(b) - DAY).toISOString().slice(0, 10))}"></div>`).join("")}
            ${placed.map((i) => {
              const l = clamp(pos(i.start)), r = clamp(pos(new Date(new Date(i.end + "T00:00:00").getTime() + DAY).toISOString().slice(0, 10)));
              return `<button type="button" class="at-bar-item at-b-${escapeHtml(i.status)}" data-goproj="${escapeHtml(i.entity_id)}" style="left:${l}%;width:${Math.max(0.6, r - l)}%;top:${i.row * 30 + 4}px" title="${escapeHtml(`${i.name}\n${fmtMDY(i.start)} – ${fmtMDY(i.end)} · ${i.days} days · ${(STATUS[i.status] || [i.status])[0]}`)}"><span>${escapeHtml(i.name.split(" - ").slice(0, 2).join(" - "))}</span></button>`;
            }).join("")}
            ${items.length ? "" : `<div class="at-tl-free">No assignments in this window</div>`}
          </div>
        </div>`;
    }).join("");

    return `
      <div class="at-card at-tl">
        <div class="at-tl-scroll">
          <div class="at-tl-inner">
            <div class="at-tl-head"><div class="at-lane-h at-tl-corner"></div><div class="at-tl-axis">${months.join("")}</div></div>
            <div class="at-tl-lanes">
              ${todayLeft >= 0 && todayLeft <= 100 ? `<div class="at-tl-today" style="left:calc(var(--lbl) + (100% - var(--lbl)) * ${todayLeft / 100})"><span>Today</span></div>` : ""}
              ${lanes || `<div class="at-pad at-muted">No PM assignments${st.pmQ || st.pmStatuses.length ? " match these filters" : ""}.</div>`}
            </div>
          </div>
        </div>
        <div class="at-legend at-pad">
          <span class="at-bar-key at-b-in_progress">In progress</span><span class="at-bar-key at-b-not_started">Not started</span>
          <span class="at-bar-key at-b-pending">Pending</span><span class="at-bar-key at-b-completed">Completed</span>
          <span class="at-tl-band-key">Overlap (2+ projects at once)</span>
          <span class="at-muted">· gaps are open days · click a bar to see the project's invoicing</span>
        </div>
      </div>`;
  }

  // ── data refresh after edits ───────────────────────────────────────────────
  async function refreshRow(id) {
    try {
      const r = await api(`/tracker/project/${encodeURIComponent(id)}`);
      const i = st.rows.findIndex((x) => x.entity_id === id);
      if (i >= 0) st.rows[i] = r; else st.rows.push(r);
    } catch (_) { /* keep the old row */ }
    if (st.history.has(id)) await loadHistory(id, false);
    if (st.view === "invoicing") renderInvoicing();
  }
  async function loadHistory(id, rerender = true) {
    try { st.history.set(id, (await api(`/tracker/project/${encodeURIComponent(id)}/history`)).history || []); }
    catch (_) { st.history.set(id, []); }
    if (rerender) { const el = root.querySelector(`[data-histbody="${CSS.escape(id)}"]`); if (el) el.innerHTML = historyHtml(id); }
  }

  let toastT = null;
  function toast(msg, bad) {
    let t = document.getElementById("atToast");
    if (!t) { t = document.createElement("div"); t.id = "atToast"; t.className = "at-toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.toggle("bad", !!bad); t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2200);
  }

  async function saveMilestone(input) {
    const id = input.getAttribute("data-ms"), f = input.getAttribute("data-f");
    const tr = input.closest("[data-msrow]");
    const ent = input.closest("[data-drill-ent]")?.getAttribute("data-drill-ent") || input.closest(".at-drill-row")?.previousElementSibling?.getAttribute("data-row");
    const body = { via: "tracker" };
    if (f === "pct" || f === "amount") {
      // % and $ stay in sync (same rule as Billing & Schedule): save both
      const pctEl = tr.querySelector('[data-f="pct"]'), amtEl = tr.querySelector('[data-f="amount"]');
      body.pct = pctEl.value === "" ? null : Number(pctEl.value);
      body.amount = amtEl.value === "" ? null : Number(amtEl.value);
    } else {
      body[f] = input.value === "" ? null : input.value;
    }
    try {
      await api(`/invoices/milestone/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      toast("Saved — Billing & Schedule updated");
      if (ent) await refreshRow(ent);
    } catch (e) { toast(`Couldn't save: ${e?.message || e}`, true); }
  }

  // Assignment editor (the workspace's Assignment tab) in a modal: status,
  // dates, PMs, crews — with its own change history. Refreshes the row on close.
  function openAssignment(id) {
    const r = st.rows.find((x) => x.entity_id === id);
    const overlay = document.createElement("div");
    overlay.className = "at-modal";
    overlay.innerHTML = `
      <div class="at-modal-card">
        <div class="at-modal-h">
          <div><div class="at-modal-t">Assignment</div><div class="at-sub">${escapeHtml(r ? r.name : "")}</div></div>
          <button type="button" class="at-btn" data-close>Done</button>
        </div>
        <div class="at-modal-b" data-asgbody></div>
      </div>`;
    document.body.appendChild(overlay);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = async () => {
      overlay.remove(); document.body.style.overflow = prevOverflow;
      st.pmData = null;   // PM schedule reloads with any date/PM changes
      await refreshRow(id);
    };
    overlay.addEventListener("click", (e) => { if (e.target === overlay || e.target.closest("[data-close]")) close(); });
    // The assignment editor keys on the internal project-customer id.
    mountAssignmentPanel(overlay.querySelector("[data-asgbody]"), r ? r.qc_id : id, () => {});
  }

  // ── events ─────────────────────────────────────────────────────────────────
  root.addEventListener("click", async (e) => {
    const t = e.target;
    const tab = t.closest("[data-view]");
    if (tab) { st.view = tab.getAttribute("data-view"); persist(); render(); return; }
    const kpi = t.closest("[data-kpi]");
    if (kpi) { st.scope = kpi.getAttribute("data-kpi"); persist(); renderInvoicing(); return; }
    const sc = t.closest("[data-scope]");
    if (sc) { st.scope = sc.getAttribute("data-scope"); persist(); renderInvoicing(); return; }
    const so = t.closest("[data-sort]");
    if (so) {
      const k = so.getAttribute("data-sort");
      st.sort = st.sort.key === k ? { key: k, dir: -st.sort.dir } : { key: k, dir: ["contract", "invoiced", "remaining"].includes(k) ? -1 : 1 };
      persist(); renderInvoicing(); return;
    }
    const asg = t.closest("[data-assign]");
    if (asg) { openAssignment(asg.getAttribute("data-assign")); return; }
    const ob = t.closest("[data-openbilling]");
    if (ob) {
      persist();
      try { sessionStorage.setItem("opi_entity_tab", "billing"); } catch (_) {}
      location.hash = `#/entity/project/${encodeURIComponent(ob.getAttribute("data-openbilling"))}`;
      return;
    }
    const add = t.closest("[data-addms]");
    if (add) {
      add.disabled = true;
      try { await api(`/invoices/schedule/${add.getAttribute("data-addms")}/milestone`, { method: "POST" }); toast("Invoice line added"); await refreshRow(add.getAttribute("data-ent")); }
      catch (err) { toast(`Couldn't add: ${err?.message || err}`, true); add.disabled = false; }
      return;
    }
    const del = t.closest("[data-delms]");
    if (del) {
      const ent = del.closest(".at-drill-row")?.previousElementSibling?.getAttribute("data-row");
      if (!confirm("Delete this invoice line? It's removed from Billing & Schedule too (the deletion is recorded in the history).")) return;
      try { await api(`/invoices/milestone/${del.getAttribute("data-delms")}`, { method: "DELETE" }); toast("Invoice line deleted"); if (ent) await refreshRow(ent); }
      catch (err) { toast(`Couldn't delete: ${err?.message || err}`, true); }
      return;
    }
    const hist = t.closest("[data-hist] > summary");
    if (hist) {
      const id = hist.parentElement.getAttribute("data-hist");
      if (!st.history.has(id)) loadHistory(id);
      return;
    }
    const pmv = t.closest("[data-pmview]");
    if (pmv) { st.pmView = pmv.getAttribute("data-pmview"); persist(); renderPm(); return; }
    const pst = t.closest("[data-pmst]");
    if (pst) {
      const k = pst.getAttribute("data-pmst");
      st.pmStatuses = !k ? [] : st.pmStatuses.includes(k) ? st.pmStatuses.filter((x) => x !== k) : [...st.pmStatuses, k];
      persist(); renderPm(); return;
    }
    const iv = t.closest("[data-invview]");
    if (iv) { st.invView = iv.getAttribute("data-invview"); persist(); renderInvoicing(); return; }
    const ex = t.closest("[data-export]");
    if (ex) { exportSheet(ex); return; }
    const nav = t.closest("[data-tlnav]");
    if (nav) {
      const k = Number(nav.getAttribute("data-tlnav"));
      if (k === 0) { const td = new Date(st.pmData.today + "T00:00:00"); st.tlStart = new Date(td.getFullYear(), td.getMonth() - 1, 1); }
      else st.tlStart = new Date(st.tlStart.getFullYear(), st.tlStart.getMonth() + k * Math.max(1, Math.floor(st.tlMonths / 2)), 1);
      renderPm(); return;
    }
    const go = t.closest("[data-goproj]");
    if (go) {
      const id = go.getAttribute("data-goproj");
      const row = st.rows.find((r) => r.entity_id === id);
      st.view = "invoicing"; st.invView = "tracker"; st.expanded.add(id);
      if (row && !row.relevant) st.scope = "all";
      st.q = row ? row.name : ""; persist(); render();
      root.querySelector(`[data-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" });
      return;
    }
    // row toggle (not when clicking inside the drill-down)
    const row = t.closest("tr.at-row[data-row]");
    if (row && !t.closest("input, button, select, a")) {
      const id = row.getAttribute("data-row");
      st.expanded.has(id) ? st.expanded.delete(id) : st.expanded.add(id);
      persist(); renderInvoicing();
    }
  });

  root.addEventListener("input", (e) => {
    if (e.target.matches("[data-q]")) {
      st.q = e.target.value; persist();
      clearTimeout(root._qT);
      root._qT = setTimeout(() => {
        const pos = e.target.selectionStart; renderInvoicing();
        const q = root.querySelector("[data-q]"); if (q) { q.focus(); q.setSelectionRange(pos, pos); }
      }, 200);
      return;
    }
    if (e.target.matches("[data-pmq]")) {
      st.pmQ = e.target.value; persist();
      clearTimeout(root._qT);
      root._qT = setTimeout(() => {
        const pos = e.target.selectionStart; renderPm();
        const q = root.querySelector("[data-pmq]"); if (q) { q.focus(); q.setSelectionRange(pos, pos); }
      }, 200);
      return;
    }
    // live % <-> $ (saved on change)
    const el = e.target;
    if (el.matches('[data-f="pct"], [data-f="amount"]')) {
      const tr = el.closest("[data-msrow]"); const v = Number(el.getAttribute("data-val")) || 0;
      if (!v || el.value === "") return;
      if (el.getAttribute("data-f") === "pct") tr.querySelector('[data-f="amount"]').value = Math.round(v * Number(el.value) / 100 * 100) / 100;
      else tr.querySelector('[data-f="pct"]').value = Math.round(Number(el.value) / v * 1000) / 10;
    }
  });

  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches("[data-pm]")) { st.pm = t.value; persist(); renderInvoicing(); return; }
    if (t.matches("[data-status]")) { st.status = t.value; persist(); renderInvoicing(); return; }
    if (t.matches("[data-pmsel]")) { st.pm = t.value; persist(); renderPm(); return; }
    if (t.matches("[data-tlmonths]")) { st.tlMonths = Number(t.value); renderPm(); return; }
    if (t.matches("[data-ms]")) saveMilestone(t);
  });

  render();
}
