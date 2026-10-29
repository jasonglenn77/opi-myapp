// Project Money — crew payments and project expenses across all projects, by
// week or by project. The financials-level view of what each project's Billing
// tab shows (the project-level view).
//
// Planned rows come from the same per-project cash cache as the Cash Flow page
// (still-to-pay crew installments; expense rows not yet covered by a bill), so
// the totals agree. A planned row whose date has passed is "past due": a crew
// payment with no matching QuickBooks payment, or an expense with no bill yet.
// Actual rows are the QuickBooks bills / card purchases tagged to a project.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { fmtMoney } from "../utils/format.js";
import { escapeHtml } from "../utils/html.js";

const PREF_KEY = "opi_money_prefs";
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch (_) { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (_) {} };

const day = (s) => s ? new Date(`${s}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric" }) : "—";
const wkLabel = (s) => `Week ending ${new Date(`${s}T00:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`;
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const k = (n) => Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : `$${Math.round(n)}`;
const chip = (txt, cls, title = "") => `<span class="inline-flex items-center text-[10px] font-bold rounded px-1.5 py-0.5 border ${cls}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(txt)}</span>`;
const C = {
  late: "text-rose-700 bg-rose-50 border-rose-200",
  plan: "text-sky-700 bg-sky-50 border-sky-200",
  open: "text-amber-700 bg-amber-50 border-amber-200",
  paid: "text-emerald-700 bg-emerald-50 border-emerald-200",
  card: "text-slate-600 bg-slate-50 border-black/10",
};

export async function moneyPage(routeFn) {
  const prefs = loadPrefs();
  const st = { kind: prefs.kind || "both", view: prefs.view || "week", q: "", pm: "", data: null, open: new Set() };
  setShell({
    title: "Project Money",
    subtitle: "Crew payments and project expenses across every project: what's due, what's late, and what QuickBooks shows paid.",
    bodyHtml: `<div id="mnRoot"><div class="card p-6 text-sm text-black/45">Loading the money schedule…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("mnRoot");

  async function load() {
    try {
      st.data = await api("/money/schedule?weeks_back=4&weeks_ahead=13");
      render();
      if (st.data.cache?.stale && !st.data.cache?.computing) setTimeout(load, 20000); // cache was refreshing
    } catch (e) {
      root.innerHTML = `<div class="card p-6 text-sm text-red-700">Couldn't load the money schedule: ${escapeHtml(e?.message || String(e))}</div>`;
    }
  }

  const proj = (id) => st.data.projects[id] || { name: `Project ${id}` };
  function keep(r) {
    if (st.kind !== "both" && r.kind !== st.kind) return false;
    const p = proj(r.entity_id);
    if (st.pm && (p.pm || "") !== st.pm) return false;
    if (st.q) {
      const hay = `${p.name} ${p.pm || ""} ${r.crew || ""} ${r.category || ""} ${r.vendor || ""} ${r.item || ""}`.toLowerCase();
      if (!hay.includes(st.q.toLowerCase())) return false;
    }
    return true;
  }
  const sum = (rows) => rows.reduce((a, r) => a + (r.amount || 0), 0);
  const projLink = (id) => `<a href="#/entity/project/${encodeURIComponent(id)}" class="font-semibold hover:underline">${escapeHtml(proj(id).name)}</a>`;
  const what = (r) => r.kind === "crew" ? `Crew · ${escapeHtml(r.crew || r.vendor || "unassigned")}` : `${escapeHtml(r.category || "Expense")}${r.vendor ? ` · ${escapeHtml(r.vendor)}` : ""}`;

  function kpis(planned, actual) {
    const d = st.data, curStart = addDays(d.this_week_end, -6), in4 = addDays(d.this_week_end, 21);
    const payday = planned.filter((r) => r.kind === "crew" && !r.overdue && r.date === d.next_payday);
    const next4 = (kind) => planned.filter((r) => r.kind === kind && !r.overdue && r.date <= in4);
    const late = planned.filter((r) => r.overdue);
    const paid4 = actual.filter((a) => a.date >= addDays(curStart, -28));
    const tile = (label, val, sub, tone = "") => `<div class="card p-4"><div class="text-[11px] uppercase tracking-wide text-black/45">${label}</div><div class="text-xl font-bold tabular-nums mt-1 ${tone}">${val}</div><div class="text-xs text-black/50 mt-0.5">${sub}</div></div>`;
    return `<div class="grid gap-3" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
      ${st.kind !== "expense" ? tile(`Next payday · ${day(d.next_payday)}`, fmtMoney(sum(payday)), `${payday.length} crew payments`) : ""}
      ${st.kind !== "expense" ? tile("Crew pay, next 4 weeks", fmtMoney(sum(next4("crew"))), `${new Set(next4("crew").map((r) => r.entity_id)).size} projects`) : ""}
      ${st.kind !== "crew" ? tile("Expenses, next 4 weeks", fmtMoney(sum(next4("expense"))), "planned, not yet billed") : ""}
      ${tile("Past due", fmtMoney(sum(late)), `${late.length} planned items whose date passed`, late.length ? "text-rose-700" : "")}
      ${tile("Billed in QuickBooks, last 4 weeks", fmtMoney(sum(paid4)), `${fmtMoney(paid4.reduce((a, r) => a + r.open, 0))} still open`)}
    </div>`;
  }

  function plannedRow(r, inProject = false) {
    const late = r.overdue;
    const status = late
      ? chip("Past due", C.late, r.kind === "crew" ? "Pay date passed and QuickBooks shows no matching crew payment" : "Planned date passed and no QuickBooks bill covers it yet")
      : chip("Planned", C.plan, r.kind === "expense" && r.week_of ? `Expected bill week ${day(r.week_of)}; cash out ${day(r.date)}` : "");
    return `<tr class="border-t border-black/[0.05]">
      <td class="py-1.5 pr-3 tabular-nums text-black/60 whitespace-nowrap">${day(r.date)}</td>
      ${inProject ? "" : `<td class="py-1.5 pr-3">${projLink(r.entity_id)}<div class="text-[11px] text-black/40">${escapeHtml(proj(r.entity_id).pm || "No PM")}</div></td>`}
      <td class="py-1.5 pr-3">${what(r)}${r.kind === "crew" && r.full && r.full - r.amount > 1 ? `<div class="text-[11px] text-black/40">${fmtMoney(r.full - r.amount)} of ${fmtMoney(r.full)} already paid</div>` : ""}</td>
      <td class="py-1.5 pr-3 text-right tabular-nums font-semibold">${fmtMoney(r.amount)}</td>
      <td class="py-1.5 text-right whitespace-nowrap">${status}</td></tr>`;
  }

  function actualRow(a, inProject = false) {
    const status = a.type === "Card" ? chip("Card", C.card, "Card purchase, categorized in QuickBooks")
      : a.open > 0.5 ? chip(`Bill · ${k(a.open)} open`, C.open, a.due ? `Due ${day(a.due)}` : "") : chip("Bill · paid", C.paid);
    return `<tr class="border-t border-black/[0.05] bg-black/[0.015]">
      <td class="py-1.5 pr-3 tabular-nums text-black/60 whitespace-nowrap">${day(a.date)}</td>
      ${inProject ? "" : `<td class="py-1.5 pr-3">${projLink(a.entity_id)}</td>`}
      <td class="py-1.5 pr-3 text-black/70">${what(a)}${a.doc ? ` <span class="text-[11px] text-black/35">#${escapeHtml(a.doc)}</span>` : ""}</td>
      <td class="py-1.5 pr-3 text-right tabular-nums">${fmtMoney(a.amount)}</td>
      <td class="py-1.5 text-right whitespace-nowrap">${status}</td></tr>`;
  }

  // One row per project (planned crew / planned expenses / billed in QuickBooks);
  // click to expand into the individual installments and bills.
  function grouped(key, p, a) {
    const ids = [...new Set([...p, ...a].map((r) => r.entity_id))];
    const rows = ids.map((id) => {
      const pp = p.filter((r) => r.entity_id === id), aa = a.filter((r) => r.entity_id === id);
      const crew = pp.filter((r) => r.kind === "crew"), exp = pp.filter((r) => r.kind === "expense");
      return { id, pp, aa, crew: sum(crew), exp: sum(exp), billed: sum(aa), open: aa.reduce((x, r) => x + r.open, 0),
               crews: [...new Set(crew.map((r) => r.crew).filter(Boolean))], cats: [...new Set(exp.map((r) => r.category).filter(Boolean))] };
    }).sort((x, y) => (y.crew + y.exp + y.billed) - (x.crew + x.exp + x.billed));
    const money = (v) => v > 0.5 ? fmtMoney(v) : `<span class="text-black/20">—</span>`;
    return `<table class="w-full text-sm"><thead><tr class="text-[11px] uppercase tracking-wide text-black/45">
        <th class="py-1.5 pr-3 text-left">Project</th>
        ${st.kind !== "expense" ? `<th class="py-1.5 pr-3 text-right">Crew pay</th>` : ""}
        ${st.kind !== "crew" ? `<th class="py-1.5 pr-3 text-right">Expenses</th>` : ""}
        ${a.length ? `<th class="py-1.5 text-right">Billed in QuickBooks</th>` : ""}</tr></thead><tbody>
      ${rows.map((r) => {
        const ok = `${key}|${r.id}`, isOpen = st.open.has(ok);
        return `<tr class="border-t border-black/[0.06] cursor-pointer hover:bg-black/[0.02]" data-toggle="${escapeHtml(ok)}">
          <td class="py-2 pr-3"><span class="text-black/35 mr-1">${isOpen ? "▾" : "▸"}</span>${projLink(r.id)}
            <span class="text-[11px] text-black/40 ml-1">${escapeHtml(proj(r.id).pm || "No PM")}</span></td>
          ${st.kind !== "expense" ? `<td class="py-2 pr-3 text-right tabular-nums" title="${escapeHtml(r.crews.join(", "))}">${money(r.crew)}</td>` : ""}
          ${st.kind !== "crew" ? `<td class="py-2 pr-3 text-right tabular-nums" title="${escapeHtml(r.cats.join(", "))}">${money(r.exp)}</td>` : ""}
          ${a.length ? `<td class="py-2 text-right tabular-nums">${money(r.billed)}${r.open > 0.5 ? `<div class="text-[11px] text-amber-700">${k(r.open)} open</div>` : ""}</td>` : ""}
        </tr>${isOpen ? `<tr><td colspan="4" class="pb-3 pl-5"><table class="w-full text-sm"><tbody>
          ${r.pp.sort((x, y) => x.date.localeCompare(y.date)).map((x) => plannedRow(x, true)).join("")}${r.aa.sort((x, y) => x.date.localeCompare(y.date)).map((x) => actualRow(x, true)).join("")}
        </tbody></table></td></tr>` : ""}`;
      }).join("")}</tbody></table>`;
  }

  function byWeek(planned, actual) {
    const d = st.data;
    const late = planned.filter((r) => r.overdue).sort((a, b) => a.date.localeCompare(b.date));
    const sections = [];
    if (late.length) {
      sections.push(`<section class="card p-4 border border-rose-200">
        <div class="flex flex-wrap items-baseline justify-between gap-2"><h2 class="font-bold text-rose-700">Past due</h2>
        <div class="text-sm tabular-nums">${fmtMoney(sum(late))} · ${late.length} items on ${new Set(late.map((r) => r.entity_id)).size} projects</div></div>
        <p class="text-xs text-black/50 mt-1">Planned dates that passed with no matching QuickBooks payment (crew) or bill (expenses). Confirm and record it, or move the date on the project's Billing tab.</p>
        <div class="overflow-x-auto mt-2">${grouped("late", late, [])}</div></section>`);
    }
    for (const we of d.week_ends) {
      const ws = addDays(we, -6);
      const p = planned.filter((r) => !r.overdue && r.date >= ws && r.date <= we).sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
      const a = actual.filter((x) => x.date >= ws && x.date <= we).sort((x, y) => x.date.localeCompare(y.date) || y.amount - x.amount);
      if (!p.length && !a.length) continue;
      const isNow = we === d.this_week_end;
      const crewP = sum(p.filter((r) => r.kind === "crew")), expP = sum(p.filter((r) => r.kind === "expense"));
      sections.push(`<section class="card p-4${isNow ? " border border-sky-200" : ""}">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="font-bold">${wkLabel(we)}${isNow ? ` ${chip("This week", C.plan)}` : ""}${ws <= d.next_payday && d.next_payday <= we ? ` ${chip(`Payday ${day(d.next_payday)}`, C.paid)}` : ""}</h2>
          <div class="text-sm tabular-nums text-black/60 flex flex-wrap gap-x-4">
            ${p.length ? `<span>Planned <b class="text-black">${fmtMoney(crewP + expP)}</b>${st.kind === "both" ? ` <span class="text-black/40">(crew ${k(crewP)} · expenses ${k(expP)})</span>` : ""}</span>` : ""}
            ${a.length ? `<span>QuickBooks <b class="text-black">${fmtMoney(sum(a))}</b></span>` : ""}
          </div></div>
        <div class="overflow-x-auto mt-2">${grouped(we, p, a)}</div></section>`);
    }
    return sections.join("") || `<div class="card p-6 text-sm text-black/45">Nothing matches.</div>`;
  }

  function byProject(planned, actual) {
    const d = st.data;
    const future = d.week_ends.filter((w) => w >= d.this_week_end);
    const ids = [...new Set([...planned, ...actual].map((r) => r.entity_id))];
    const rows = ids.map((id) => {
      const p = planned.filter((r) => r.entity_id === id);
      const late = sum(p.filter((r) => r.overdue));
      const cells = future.map((we) => sum(p.filter((r) => !r.overdue && r.date > addDays(we, -7) && r.date <= we)));
      const beyond = sum(p.filter((r) => !r.overdue && r.date > future[future.length - 1]));
      const billed4 = sum(actual.filter((a) => a.entity_id === id));
      return { id, late, cells, total: late + cells.reduce((x, y) => x + y, 0), billed4, beyond };
    }).filter((r) => r.total > 0.5 || r.billed4 > 0.5).sort((a, b) => b.total - a.total);
    const colTot = future.map((_, i) => rows.reduce((a, r) => a + r.cells[i], 0));
    const cell = (v, cls = "") => `<td class="py-1.5 px-2 text-right tabular-nums whitespace-nowrap ${cls}">${v > 0.5 ? k(v) : `<span class="text-black/20">·</span>`}</td>`;
    return `<section class="card p-4"><div class="overflow-x-auto"><table class="w-full text-sm">
      <thead><tr class="text-[11px] uppercase tracking-wide text-black/45">
        <th class="py-2 pr-3 text-left">Project</th><th class="py-2 px-2 text-right" title="Paid or billed in QuickBooks over the last ${d.week_ends.length - future.length} weeks">Billed (past ${d.week_ends.length - future.length} wks)</th>
        <th class="py-2 px-2 text-right text-rose-700">Past due</th>
        ${future.map((w) => `<th class="py-2 px-2 text-right whitespace-nowrap">${day(w)}</th>`).join("")}
        <th class="py-2 pl-2 text-right">Total ahead</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="border-t border-black/[0.05]">
        <td class="py-1.5 pr-3 whitespace-nowrap">${projLink(r.id)}<div class="text-[11px] text-black/40">${escapeHtml(proj(r.id).pm || "No PM")}</div></td>
        ${cell(r.billed4, "text-black/50")}${cell(r.late, "text-rose-700 font-semibold")}
        ${r.cells.map((v) => cell(v)).join("")}
        <td class="py-1.5 pl-2 text-right tabular-nums font-semibold">${fmtMoney(r.total)}</td></tr>`).join("")}</tbody>
      <tfoot><tr class="border-t-2 border-black/10 font-semibold"><td class="py-2 pr-3">All projects</td>
        ${cell(rows.reduce((a, r) => a + r.billed4, 0))}${cell(rows.reduce((a, r) => a + r.late, 0), "text-rose-700")}
        ${colTot.map((v) => cell(v)).join("")}<td class="py-2 pl-2 text-right tabular-nums">${fmtMoney(rows.reduce((a, r) => a + r.total, 0))}</td></tr></tfoot>
    </table></div></section>`;
  }

  function render() {
    const d = st.data;
    const planned = d.planned.filter(keep), actual = d.actual.filter(keep);
    const pms = [...new Set(Object.values(d.projects).map((p) => p.pm).filter(Boolean))].sort();
    const seg = (key, opts) => `<div class="inline-flex rounded-lg border border-black/10 overflow-hidden text-xs">${opts.map(([v, l]) =>
      `<button data-${key}="${v}" class="px-3 py-1.5 font-semibold ${st[key] === v ? "bg-ink-900 text-white" : "bg-white text-black/60 hover:bg-slate-200 hover:text-ink-900"}">${l}</button>`).join("")}</div>`;
    root.innerHTML = `<div class="grid gap-4" style="grid-template-columns:minmax(0,1fr)">
      <div class="flex flex-wrap items-center gap-2">
        ${seg("kind", [["both", "Crew + expenses"], ["crew", "Crew pay"], ["expense", "Expenses"]])}
        ${seg("view", [["week", "By week"], ["project", "By project"]])}
        <select id="mnPm" class="input text-xs py-1.5" style="width:auto"><option value="">All PMs</option>${pms.map((p) => `<option ${st.pm === p ? "selected" : ""}>${escapeHtml(p)}</option>`).join("")}</select>
        <input id="mnQ" type="search" placeholder="Search project, crew, vendor…" value="${escapeHtml(st.q)}" class="input text-xs py-1.5" style="width:280px;max-width:100%">
        <a href="#/assumptions" class="text-xs text-white/60 hover:text-white hover:underline">How dates are set</a>
      </div>
      ${kpis(planned, actual)}
      ${st.view === "week" ? byWeek(planned, actual) : byProject(planned, actual)}
      ${d.cache?.stale ? `<div class="text-xs text-black/40">Refreshing the schedule in the background; this page reloads when it's done.</div>` : ""}
    </div>`;
  }

  root.addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-toggle]");
    if (tr && !ev.target.closest("a")) {
      const key = tr.dataset.toggle;
      st.open.has(key) ? st.open.delete(key) : st.open.add(key);
      render();
      return;
    }
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.dataset.kind) st.kind = b.dataset.kind;
    else if (b.dataset.view) st.view = b.dataset.view;
    else return;
    savePrefs({ kind: st.kind, view: st.view });
    render();
  });
  root.addEventListener("change", (ev) => {
    if (ev.target.id === "mnPm") { st.pm = ev.target.value; render(); }
  });
  root.addEventListener("input", (ev) => {
    if (ev.target.id !== "mnQ") return;
    st.q = ev.target.value;
    clearTimeout(st.t);
    st.t = setTimeout(() => { render(); const q = document.getElementById("mnQ"); q?.focus(); q?.setSelectionRange(st.q.length, st.q.length); }, 250);
  });

  await load();
}
