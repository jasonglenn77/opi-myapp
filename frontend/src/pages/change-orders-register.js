// Change Orders register (#/change-orders): every change order across all projects
// in one list, from sent -> answered -> in QuickBooks -> invoiced -> crew re-offered,
// so the office sees which ones still need something. Each row says its next step
// and links to the project's Change Orders tab, where the work is done.
// Backend: backend/app/coregister/routes.py (reads QuickBooks estimates, app change
// orders, customer-portal answers, billing schedules and crew offers).
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml as esc } from "../utils/html.js";
import { chip, C, day, money0, projectLink } from "../utils/ui.js";

const PAGE = 200;
const VIEWS = [["action", "Needs action"], ["waiting", "Waiting on customer"], ["done", "Done"], ["all", "All"]];
const INVIEW = {
  action: (r) => ["action", "approved_not_qbo", "draft"].includes(r.stage),
  waiting: (r) => r.stage === "waiting",
  done: (r) => r.stage === "done" || r.stage === "declined",
  all: () => true,
};
// KPI tiles filter exactly, on top of the "All" tab
const KPI = {
  waiting: ["Waiting on customer", (r) => r.stage === "waiting"],
  approved: ["Approved, not in QuickBooks", (r) => r.stage === "approved_not_qbo"],
  confirm: ["Schedule to confirm", (r) => r.accepted && r.billing_confirmed === false],
  crew: ["Crew not re-offered", (r) => r.accepted && r.crew_reoffer === "to_offer"],
  invoice: ["Not invoiced", (r) => r.accepted && !r.invoiced],
};
const TONE = { bad: C.bad, warn: C.warn, info: C.info, good: C.good, quiet: C.quiet };

export async function changeOrdersRegisterPage(routeFn) {
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem("opi_coreg") || "{}"); } catch (_) {}
  const st = { data: null, days: saved.days ?? 365, view: saved.view || "action", kpi: null, q: "", pm: "", shown: PAGE };
  const remember = () => { try { sessionStorage.setItem("opi_coreg", JSON.stringify({ days: st.days, view: st.view })); } catch (_) {} };

  setShell({
    title: "Change Orders",
    subtitle: "Every change order on every project: whether the customer answered, it's in QuickBooks, it's invoiced, its schedule is confirmed and the added labor is offered to a crew. The next step is on each row.",
    bodyHtml: `<div id="coRegRoot"><div class="card p-6 text-sm text-black/45">Loading change orders…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("coRegRoot");

  async function load(fresh = false) {
    try {
      st.data = await api(`/change-orders/register?days=${st.days}${fresh ? "&fresh=1" : ""}`);
      render();
    } catch (e) {
      root.innerHTML = `<div class="card p-6 text-sm text-rose-700">Couldn't load change orders: ${esc(e?.message || String(e))}</div>`;
    }
  }

  function filtered() {
    const q = st.q.trim().toLowerCase();
    return st.data.rows.filter((r) => (st.kpi ? KPI[st.kpi][1](r) : INVIEW[st.view](r))
      && (!st.pm || (r.pm || "").split(", ").includes(st.pm))
      && (!q || `${r.project} ${r.number || ""} ${r.title || ""} ${r.dealer || ""} ${r.pm || ""}`.toLowerCase().includes(q)));
  }

  // one chip per stage: customer, QuickBooks, invoiced, schedule, crew
  function stages(r) {
    const pr = r.portal_response;
    const cust = pr ? chip(pr.decision === "approved" ? "Approved" : "Declined", pr.decision === "approved" ? C.good : C.quiet, `${pr.decision === "approved" ? "Approved" : "Declined"} by ${pr.by} in the portal on ${pr.at}${pr.note ? `: ${pr.note}` : ""}`)
      : r.app_status === "draft" ? chip("Draft", C.quiet)
        : r.accepted ? chip("Accepted", C.good)
          : r.stage === "declined" ? chip("Declined", C.quiet)
            : chip("Waiting", C.info);
    const qbo = r.status ? chip(r.status, r.accepted ? C.good : r.status === "Rejected" ? C.quiet : C.info) : chip("Not entered", r.stage === "approved_not_qbo" ? C.bad : C.quiet);
    const dash = `<span class="text-black/30">—</span>`;
    const inv = !r.accepted ? dash : r.invoiced ? chip("Invoiced", C.good) : chip("Not yet", C.warn);
    const sch = !r.accepted || r.billing_confirmed == null ? dash : r.billing_confirmed ? chip("Confirmed", C.good) : chip("To confirm", C.warn);
    const crewTxt = { accepted: ["Accepted", C.good], sent: ["Offered", C.info], to_offer: ["To offer", C.warn], unknown: ["No offer on record", C.quiet] };
    const crew = !r.crew_reoffer ? dash : !r.accepted ? `<span class="text-[11px] text-black/45">After approval</span>` : chip(...crewTxt[r.crew_reoffer]);
    return { cust, qbo, inv, sch, crew };
  }

  function render() {
    remember();
    const d = st.data, s = d.summary;
    const rows = filtered();
    const pms = [...new Set(d.rows.flatMap((r) => (r.pm ? r.pm.split(", ") : [])))].sort();
    const n = (k) => d.rows.filter(KPI[k][1]).length;
    const tile = (k, caption, bad) => `<button type="button" class="card p-4 text-left su-kpi${st.kpi === k ? " on" : ""}" data-kpi="${k}" aria-pressed="${st.kpi === k}">
        <div class="text-[10px] uppercase tracking-wide font-bold text-black/45">${KPI[k][0]}</div>
        <div class="text-2xl font-extrabold tabular-nums ${bad && n(k) ? "text-rose-700" : ""}">${n(k)}</div>
        <div class="text-xs text-black/50">${caption}</div></button>`;
    const counts = Object.fromEntries(VIEWS.map(([k]) => [k, d.rows.filter(INVIEW[k]).length]));
    root.innerHTML = `
      <div class="su-kpis">
        ${tile("waiting", "Sent; Pending in QuickBooks")}
        ${tile("approved", "Customer said yes; QuickBooks still Pending", true)}
        ${tile("confirm", "Accepted; invoice and crew-pay schedule not confirmed")}
        ${tile("crew", "Adds crew labor; no offer sent since")}
        ${tile("invoice", "Accepted; no invoice linked yet")}
        <div class="card p-4 su-kpi !cursor-default"><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">Accepted, last 90 days</div>
          <div class="text-2xl font-extrabold tabular-nums">${money0(s.value_90)}</div><div class="text-xs text-black/50">${s.count_90} change orders</div></div>
      </div>
      <div class="su-bar-row">
        <div class="tabs" role="tablist">${VIEWS.map(([k, l]) => `<button type="button" role="tab" class="tab" data-view="${k}" aria-selected="${!st.kpi && st.view === k}">${l} <span class="tab-n">${counts[k]}</span></button>`).join("")}</div>
        ${st.kpi ? `<button type="button" class="su-filter" data-clearkpi>Showing: ${esc(KPI[st.kpi][0])} <span aria-hidden="true">✕</span></button>` : ""}
        <input id="corQ" class="input text-sm su-q" placeholder="Search job, number or dealer" value="${esc(st.q)}">
        <select id="corPm" class="input text-sm su-pm"><option value="">All PMs</option>${pms.map((p) => `<option${p === st.pm ? " selected" : ""}>${esc(p)}</option>`).join("")}</select>
        <select id="corDays" class="input text-sm su-pm">${[[90, "Last 90 days"], [180, "Last 6 months"], [365, "Last 12 months"], [0, "All time"]].map(([v, l]) => `<option value="${v}"${Number(st.days) === v ? " selected" : ""}>${l}</option>`).join("")}</select>
        <button type="button" class="pd-btn" id="corCsv">Export CSV</button>
      </div>
      <section class="card overflow-hidden">
        <div class="overflow-x-auto"><table id="corTable" class="w-full text-sm cor-table">
          <thead><tr><th>Job</th><th>Change order</th><th>Date</th><th class="r">Amount</th><th>Customer</th><th>QuickBooks</th><th>Invoiced</th><th>Schedule</th><th>Crew</th><th>Next step</th></tr></thead>
          <tbody>${rows.slice(0, st.shown).map((r) => {
            const x = stages(r);
            return `<tr>
              <td><a class="font-semibold text-ink-900 hover:underline" href="${projectLink(r.entity_id, "changeorders")}">${esc(r.project)}</a>
                <div class="text-[11px] text-black/50">${esc([r.pm, r.dealer].filter(Boolean).join(" · "))}</div></td>
              <td>${esc(r.number ? `#${r.number}` : "")}${r.title && !String(r.title).includes(r.number || "~") ? ` <span class="text-black/60">${esc(r.title)}</span>` : ""}
                <div class="text-[11px] text-black/45">${r.source === "App" ? "Made in the app" : r.app_id ? "QuickBooks, made in the app" : "QuickBooks"}${r.labor ? ` · ${money0(r.labor)} labor` : ""}</div></td>
              <td class="whitespace-nowrap">${day(r.date)}</td>
              <td class="r tabular-nums">${money0(r.amount)}</td>
              <td>${x.cust}</td><td>${x.qbo}</td><td>${x.inv}</td><td>${x.sch}</td><td>${x.crew}</td>
              <td class="cor-next">${chip(r.stage === "done" ? "Done" : r.stage === "declined" ? "Closed" : r.stage === "waiting" ? "Waiting" : "To do", TONE[r.tone])} <span class="text-xs text-black/70">${esc(r.next_step)}</span></td>
            </tr>`;
          }).join("") || `<tr><td colspan="10" class="px-4 py-10 text-center text-sm text-black/50">No change orders here.</td></tr>`}</tbody>
        </table></div>
        ${rows.length > st.shown ? `<div class="px-4 py-3 border-t border-black/5"><button type="button" class="pd-btn" id="corMore">Show ${Math.min(PAGE, rows.length - st.shown)} more of ${rows.length - st.shown}</button></div>` : ""}
      </section>
      <div class="text-xs text-white/50 mt-3">The first estimate on a project is its contract; every estimate after it counts as a change order. Crew re-offers are only asked for on jobs that use crew offers in the app, or change orders from the last 45 days.</div>`;
  }

  function csv() {
    const rows = filtered();
    const cols = [["Job", (r) => r.project], ["PM", (r) => r.pm], ["Dealer", (r) => r.dealer], ["Number", (r) => r.number], ["Title", (r) => r.title],
      ["Source", (r) => r.source], ["Date", (r) => r.date], ["Amount", (r) => r.amount], ["Contract labor", (r) => r.labor],
      ["QuickBooks status", (r) => r.status], ["App status", (r) => r.app_status],
      ["Portal answer", (r) => (r.portal_response ? `${r.portal_response.decision} by ${r.portal_response.by} ${r.portal_response.at}` : "")],
      ["Invoiced", (r) => (r.invoiced ? "yes" : "no")], ["Schedule confirmed", (r) => (r.billing_confirmed == null ? "" : r.billing_confirmed ? "yes" : "no")],
      ["Crew offer", (r) => r.crew_reoffer || ""], ["Next step", (r) => r.next_step]];
    const q = (v) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const text = [cols.map((c) => c[0]).join(","), ...rows.map((r) => cols.map((c) => q(c[1](r))).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = `change-orders-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  root.addEventListener("click", (e) => {
    const k = e.target.closest("[data-kpi]");
    if (k) { st.kpi = st.kpi === k.dataset.kpi ? null : k.dataset.kpi; st.shown = PAGE; render(); return; }
    if (e.target.closest("[data-clearkpi]")) { st.kpi = null; render(); return; }
    const v = e.target.closest("[data-view]");
    if (v) { st.view = v.dataset.view; st.kpi = null; st.shown = PAGE; render(); return; }
    if (e.target.closest("#corMore")) { st.shown += PAGE; render(); return; }
    if (e.target.closest("#corCsv")) csv();
  });
  root.addEventListener("input", (e) => {
    if (e.target.id === "corQ") {
      st.q = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const q = root.querySelector("#corQ"); q.focus(); q.setSelectionRange(pos, pos);
    }
  });
  root.addEventListener("change", (e) => {
    if (e.target.id === "corPm") { st.pm = e.target.value; render(); }
    if (e.target.id === "corDays") { st.days = Number(e.target.value); root.querySelector("#corTable")?.style.setProperty("opacity", ".5"); load(); }
  });

  load();
}
