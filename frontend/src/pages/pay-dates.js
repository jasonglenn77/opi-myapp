// Invoice & Pay Dates: every invoice, crew payment and planned expense across all
// projects, by week (backend/app/paydates/routes.py). Overdue rows stay listed
// whatever the date range. Dates are edited right here with each schedule's own
// endpoint, so the project's Billing tab, the forecast and the change alerts agree.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml as esc } from "../utils/html.js";
import { chip, C, day, money0, projectLink } from "../utils/ui.js";
import { toast } from "../utils/help.js";

const TABS = [["money", "Invoices & crew pay"], ["invoice", "Invoices"], ["crew", "Crew pay"], ["expense", "Planned expenses"]];
const RANGES = [["14", "Next 2 weeks"], ["30", "Next 30 days"], ["90", "Next 90 days"], ["180", "Next 6 months"]];
const STATE = {
  overdue: ["Overdue", C.bad], late: ["Late", C.bad], no_date: ["No date", C.warn], waiting: ["Waiting on payment", C.info],
  upcoming: ["Upcoming", C.quiet], retainage: ["Retainage", C.quiet], past: ["Past week", C.quiet],
};
const TYPE = { invoice: ["Invoice", C.info], crew: ["Crew pay", C.warn], expense: ["Expense", C.quiet] };
const ENDPOINT = {
  invoice: (id) => `/invoices/milestone/${id}`, crew: (id) => `/payments/installment/${id}`, expense: (id) => `/expenses/expense-installment/${id}`,
};

const iso = (d) => d.toISOString().slice(0, 10);
const monday = (s) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };

export async function payDatesPage(routeFn) {
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem("opi_paydates") || "{}"); } catch (_) {}
  const st = { data: null, tab: saved.tab || "money", range: saved.range || "30", pm: "", crew: "", q: "", only: saved.only || "" };
  const remember = () => { try { sessionStorage.setItem("opi_paydates", JSON.stringify({ tab: st.tab, range: st.range, only: st.only })); } catch (_) {} };

  setShell({
    title: "Invoice & Pay Dates",
    subtitle: "Every invoice to send, payment to collect, crew payment and planned expense, across all projects. Change a date here and the project's schedule changes with it.",
    bodyHtml: `<div id="pdRoot"><div class="card p-6 text-sm text-black/45">Loading every schedule…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("pdRoot");

  async function load() {
    const end = new Date(); end.setDate(end.getDate() + Number(st.range));
    const start = new Date(); start.setDate(start.getDate() - 14);
    try {
      st.data = await api(`/pay-dates?start=${iso(start)}&end=${iso(end)}`);
      render();
    } catch (e) {
      root.innerHTML = `<div class="card p-6 text-sm text-rose-700">Couldn't load the schedules: ${esc(e?.message || String(e))}</div>`;
    }
  }

  const isLate = (i) => ["overdue", "late", "no_date"].includes(i.state);
  function filtered() {
    const q = st.q.trim().toLowerCase();
    return st.data.items.filter((i) => (st.tab === "money" ? i.type !== "expense" : i.type === st.tab)
      && (!st.only || (st.only === "late" ? isLate(i) : !isLate(i)))
      && (!st.pm || (i.pm || "").split(", ").includes(st.pm))
      && (!st.crew || i.crew === st.crew)
      && (!q || `${i.job} ${i.label} ${i.crew || ""} ${i.ref || ""}`.toLowerCase().includes(q)));
  }

  function kpis() {
    const s = st.data.summary;
    const tile = (label, value, caption, bad, act) => `<button type="button" class="card p-4 text-left su-kpi" data-kpi="${act}">
      <div class="text-[10px] uppercase tracking-wide font-bold text-black/45">${label}</div>
      <div class="text-2xl font-extrabold tabular-nums ${bad ? "text-rose-700" : ""}">${value}</div>
      <div class="text-xs text-black/50">${caption}</div></button>`;
    return `<div class="su-kpis">
      ${tile("Invoices overdue to send", money0(s.overdue_send), `${s.overdue_send_n} invoices past their planned date`, s.overdue_send_n > 0, "invoice:late")}
      ${tile("Payments late", money0(s.late_paid), `${s.late_paid_n} sent invoices past due`, s.late_paid_n > 0, "invoice:late")}
      ${tile("Crew pay past due", money0(s.crew_overdue), `${s.crew_overdue_n} payments not covered by a QuickBooks bill`, s.crew_overdue_n > 0, "crew:late")}
      ${tile("Coming in, 2 weeks", money0(s.in_14), "Invoices to send or collect", false, "invoice:")}
      ${tile("Going out, 2 weeks", money0(s.out_14), "Crew pay and planned expenses", false, "crew:")}
    </div>`;
  }

  function render() {
    remember();
    const items = st.data.items;
    const pms = [...new Set(items.flatMap((i) => (i.pm || "").split(", ").filter(Boolean)))].sort();
    const crews = [...new Set(items.map((i) => i.crew).filter(Boolean))].sort();
    const counts = Object.fromEntries(TABS.map(([k]) => [k, items.filter((i) => (k === "money" ? i.type !== "expense" : i.type === k)).length]));
    root.innerHTML = `
      ${kpis()}
      <div class="su-bar-row">
        <div class="tabs" role="tablist">${TABS.map(([k, l]) => `<button type="button" role="tab" class="tab" data-tab="${k}" aria-selected="${st.tab === k}">${l} <span class="tab-n">${counts[k]}</span></button>`).join("")}</div>
      </div>
      <div class="flex flex-wrap items-center gap-2 mb-3" id="pdFilters">
        <select id="pdRange" class="input text-sm !w-auto">${RANGES.map(([k, l]) => `<option value="${k}"${k === st.range ? " selected" : ""}>${l}</option>`).join("")}</select>
        <select id="pdOnly" class="input text-sm !w-auto"><option value="">Overdue and upcoming</option><option value="late"${st.only === "late" ? " selected" : ""}>Only overdue / late / undated</option><option value="ok"${st.only === "ok" ? " selected" : ""}>Only on time</option></select>
        <select id="pdPm" class="input text-sm !w-auto"><option value="">All PMs</option>${pms.map((p) => `<option${p === st.pm ? " selected" : ""}>${esc(p)}</option>`).join("")}</select>
        ${st.tab === "crew" || st.tab === "money" ? `<select id="pdCrew" class="input text-sm !w-auto"><option value="">All crews</option>${crews.map((c) => `<option${c === st.crew ? " selected" : ""}>${esc(c)}</option>`).join("")}</select>` : ""}
        <input id="pdQ" class="input text-sm !w-auto flex-1 min-w-[160px] max-w-[280px]" placeholder="Search job, crew, estimate #" value="${esc(st.q)}">
      </div>
      <div id="pdList">${listHtml()}</div>`;
    bind();
  }

  function listHtml() {
    const rows = filtered();
    if (!rows.length) return `<div class="card px-4 py-10 text-center text-sm text-black/50">Nothing in this range.</div>`;
    const today = st.data.today;
    const late = rows.filter((i) => i.date == null || (isLate(i) && i.date < today));
    late.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
    const rest = rows.filter((i) => !late.includes(i));
    const groups = [];
    if (late.length) groups.push(["Overdue, late or no date", late]);
    const byWeek = {};
    for (const i of rest) (byWeek[monday(i.date)] ||= []).push(i);
    for (const w of Object.keys(byWeek).sort()) groups.push([`Week of ${day(w)}`, byWeek[w]]);
    return groups.map(([title, list]) => {
      const inSum = list.filter((i) => i.type === "invoice").reduce((a, i) => a + i.amount, 0);
      const outSum = list.filter((i) => i.type !== "invoice").reduce((a, i) => a + i.amount, 0);
      return `<section class="card mb-3 overflow-hidden">
        <div class="pd-head"><span class="font-extrabold text-ink-900">${esc(title)}</span>
          <span class="text-xs text-black/55 tabular-nums">${inSum ? `In ${money0(inSum)}` : ""}${inSum && outSum ? " · " : ""}${outSum ? `Out ${money0(outSum)}` : ""} · ${list.length} item${list.length === 1 ? "" : "s"}</span></div>
        ${list.slice(0, 400).map((i) => `
          <div class="pd-row" data-type="${i.type}" data-id="${i.id}">
            <div class="pd-date">${i.editable
              ? `<input type="date" class="pd-in" value="${i.date || ""}" data-field="${i.field}" aria-label="Date">`
              : `<span class="text-sm font-semibold tabular-nums text-ink-900">${i.date ? day(i.date) : "—"}</span>`}</div>
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-1.5">${chip(...TYPE[i.type])}${chip(...(STATE[i.state] || STATE.upcoming))}<span class="text-sm font-semibold text-ink-900">${esc(i.what)}</span><span class="text-xs text-black/55">${esc(i.label || "")}</span></div>
              <a class="text-xs font-semibold text-black/70 hover:underline truncate block" href="${projectLink(i.entity_id, "billing")}">${esc(i.job)}</a>
              <div class="text-[11px] text-black/45">${esc([i.pm, i.crew, i.ref ? `Est. ${i.ref}` : null, i.due && i.type === "invoice" ? `due ${day(i.due)}` : null].filter(Boolean).join(" · "))}</div>
            </div>
            <div class="pd-amt tabular-nums ${i.type === "invoice" ? "text-emerald-700" : "text-ink-900"}">${i.type === "invoice" ? "+" : "−"}${money0(i.amount)}</div>
          </div>`).join("")}
        ${list.length > 400 ? `<div class="p-3 text-xs text-black/50">${list.length - 400} more: narrow the filters.</div>` : ""}
      </section>`;
    }).join("");
  }

  function bind() {
    root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { st.tab = b.dataset.tab; render(); }));
    root.querySelectorAll("[data-kpi]").forEach((b) => b.addEventListener("click", () => {
      const [t, o] = b.dataset.kpi.split(":"); st.tab = t; st.only = o; render();
    }));
    root.querySelector("#pdRange").addEventListener("change", (e) => { st.range = e.target.value; root.querySelector("#pdList").innerHTML = `<div class="card p-6 text-sm text-black/45">Loading…</div>`; load(); });
    root.querySelector("#pdOnly").addEventListener("change", (e) => { st.only = e.target.value; render(); });
    root.querySelector("#pdPm").addEventListener("change", (e) => { st.pm = e.target.value; render(); });
    root.querySelector("#pdCrew")?.addEventListener("change", (e) => { st.crew = e.target.value; render(); });
    const q = root.querySelector("#pdQ");
    q.addEventListener("input", () => { st.q = q.value; root.querySelector("#pdList").innerHTML = listHtml(); bindRows(); });
    bindRows();
  }
  function bindRows() {
    root.querySelectorAll(".pd-in").forEach((inp) => inp.addEventListener("change", async () => {
      const row = inp.closest(".pd-row");
      const { type, id } = row.dataset;
      const item = st.data.items.find((i) => i.type === type && String(i.id) === id);
      const old = item.date;
      try {
        await api(ENDPOINT[type](id), { method: "PATCH", body: JSON.stringify({ [inp.dataset.field]: inp.value || "" }) });
        item.date = inp.value || null;
        if (item.date && item.date >= st.data.today && ["overdue", "no_date"].includes(item.state)) item.state = "upcoming";
        toast(`Moved to ${item.date ? day(item.date) : "no date"}. The project's schedule is updated${type === "expense" ? "" : " and its PM will be told"}.`);
        root.querySelector("#pdList").innerHTML = listHtml(); bindRows();
      } catch (e) {
        inp.value = old || "";
        toast(`Couldn't change the date: ${(e?.message || "").slice(0, 120)}`);
      }
    }));
  }

  load();
}
