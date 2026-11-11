// Issues: every problem the app already finds, from every page, in one list
// (backend/app/issues/routes.py). Tabs by area (Invoices / Crew pay / Expenses
// by category / Progress / Schedules / Data), filters by category, PM and
// severity. Each issue links to the page that owns it; decisions are made there.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml as esc } from "../utils/html.js";
import { chip, C, money0, day } from "../utils/ui.js";

const SEV = { bad: ["Problem", C.bad], warn: ["Check", C.warn], info: ["Info", C.info] };
const PAGE = 150;

export async function issuesPage(routeFn) {
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem("opi_issues") || "{}"); } catch (_) {}
  const st = { data: null, area: saved.area || "invoices", cat: "", pm: "", sev: "", q: "", shown: PAGE };
  const remember = () => { try { sessionStorage.setItem("opi_issues", JSON.stringify({ area: st.area })); } catch (_) {} };

  setShell({
    title: "Issues",
    subtitle: "Every problem the app finds, from every page, in one list. Open one to fix it where it lives; what you decide there carries over.",
    bodyHtml: `<div id="isRoot"><div class="card p-6 text-sm text-black/45">Gathering issues from every page…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("isRoot");

  async function load(fresh = false) {
    try {
      st.data = await api(`/issues${fresh ? "?fresh=1" : ""}`);
      render();
    } catch (e) {
      root.innerHTML = `<div class="card p-6 text-sm text-rose-700">Couldn't load issues: ${esc(e?.message || String(e))}</div>`;
    }
  }

  function filtered() {
    const q = st.q.trim().toLowerCase();
    return st.data.items.filter((i) => i.area === st.area
      && (!st.cat || (i.category || "Other") === st.cat)
      && (!st.pm || (i.pm || "").split(", ").includes(st.pm))
      && (!st.sev || i.sev === st.sev)
      && (!q || `${i.title} ${i.job || ""} ${i.detail || ""} ${i.pm || ""}`.toLowerCase().includes(q)));
  }

  function render() {
    remember();
    const d = st.data;
    const inArea = d.items.filter((i) => i.area === st.area);
    const pms = [...new Set(inArea.flatMap((i) => (i.pm || "").split(", ").filter(Boolean)))].sort();
    const cats = d.categories[st.area] || [];
    const rows = filtered();
    const total = rows.reduce((a, i) => a + Math.abs(i.amount || 0), 0);
    root.innerHTML = `
      <div class="flex flex-wrap items-center gap-3 mb-3">
        <div class="tabs" role="tablist">${d.areas.map((a) => `<button type="button" role="tab" class="tab" data-area="${a.key}" aria-selected="${st.area === a.key}">${esc(a.label)} <span class="tab-n">${a.count}</span></button>`).join("")}</div>
        <button type="button" class="pd-btn" id="isRefresh">Refresh</button>
      </div>
      ${d.errors?.length ? `<div class="card p-3 mb-3 text-sm text-amber-800 bg-amber-50">Some sources couldn't be read: ${esc(d.errors.join("; "))}</div>` : ""}
      ${cats.length > 1 ? `<div class="flex flex-wrap gap-2 mb-3" id="isCats">
        <button type="button" class="is-cat${!st.cat ? " on" : ""}" data-cat="">All <span>${inArea.length}</span></button>
        ${cats.map(([c, n]) => `<button type="button" class="is-cat${st.cat === c ? " on" : ""}" data-cat="${esc(c)}">${esc(c)} <span>${n}</span></button>`).join("")}</div>` : ""}
      <div class="flex flex-wrap items-center gap-2 mb-3" id="isFilters">
        <input id="isQ" class="input text-sm !w-auto flex-1 min-w-[180px] max-w-[320px]" placeholder="Search job, issue or PM" value="${esc(st.q)}">
        <select id="isPm" class="input text-sm !w-auto"><option value="">All PMs</option>${pms.map((p) => `<option${p === st.pm ? " selected" : ""}>${esc(p)}</option>`).join("")}</select>
        <select id="isSev" class="input text-sm !w-auto"><option value="">Every severity</option>${Object.entries(SEV).map(([k, [l]]) => `<option value="${k}"${k === st.sev ? " selected" : ""}>${l}</option>`).join("")}</select>
        <span class="text-sm text-white/60">${rows.length} issue${rows.length === 1 ? "" : "s"}${total ? ` · ${money0(total)}` : ""}</span>
      </div>
      <div class="card overflow-hidden" id="isList">${listHtml(rows)}</div>
      <div class="text-xs text-white/45 mt-2">Built ${esc(d.built)}. Sources: Ashley's Tracker, Data Review, Contractor Payments, job costs vs estimates, QuickBooks bills, Progress Checks.</div>`;
    bind();
  }

  function listHtml(rows) {
    if (!rows.length) return `<div class="px-4 py-10 text-center text-sm text-black/50">Nothing open here.</div>`;
    return `<div class="is-rows">${rows.slice(0, st.shown).map((i) => `
      <div class="is-row">
        <div class="is-sev">${chip(...SEV[i.sev])}</div>
        <div class="min-w-0">
          <div class="text-sm font-semibold text-ink-900">${esc(i.title)}${i.decision ? ` ${chip(`Decided: ${i.decision}`, C.quiet)}` : ""}</div>
          ${i.job ? `<div class="text-xs font-semibold text-black/70 truncate">${esc(i.job)}${i.pm ? ` <span class="font-normal text-black/50">· ${esc(i.pm)}</span>` : ""}</div>` : ""}
          ${i.detail ? `<div class="text-xs text-black/55 mt-0.5 is-detail">${esc(i.detail)}</div>` : ""}
          <div class="text-[11px] text-black/40 mt-0.5">${esc(i.source || "")}${i.category ? ` · ${esc(i.category)}` : ""}${i.date ? ` · ${day(i.date)}` : ""}</div>
        </div>
        <div class="is-amt tabular-nums">${i.amount != null ? money0(i.amount) : ""}</div>
        <div class="is-act">${i.link ? `<a class="pd-btn" href="${esc(i.link)}">Open</a>` : ""}</div>
      </div>`).join("")}</div>
      ${rows.length > st.shown ? `<div class="p-3 text-center border-t border-black/[0.05]"><button type="button" class="pd-btn" id="isMore">Show ${Math.min(PAGE, rows.length - st.shown)} more of ${rows.length - st.shown}</button></div>` : ""}`;
  }

  function bind() {
    root.querySelectorAll("[data-area]").forEach((b) => b.addEventListener("click", () => { st.area = b.dataset.area; st.cat = ""; st.pm = ""; st.shown = PAGE; render(); }));
    root.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => { st.cat = b.dataset.cat; st.shown = PAGE; render(); }));
    root.querySelector("#isRefresh").addEventListener("click", () => { root.querySelector("#isList").innerHTML = `<div class="p-6 text-sm text-black/45">Refreshing…</div>`; load(true); });
    root.querySelector("#isPm").addEventListener("change", (e) => { st.pm = e.target.value; render(); });
    root.querySelector("#isSev").addEventListener("change", (e) => { st.sev = e.target.value; render(); });
    const q = root.querySelector("#isQ");
    q.addEventListener("input", () => { st.q = q.value; st.shown = PAGE; root.querySelector("#isList").innerHTML = listHtml(filtered()); bindMore(); });
    bindMore();
  }
  function bindMore() {
    root.querySelector("#isMore")?.addEventListener("click", () => { st.shown += PAGE; root.querySelector("#isList").innerHTML = listHtml(filtered()); bindMore(); });
  }

  load();
}
