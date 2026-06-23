// Daily Log panel (Phase 4) — per-project, per-day requirements checklist for
// active projects. Shared component mounted in two places: the project detail
// page's "Daily Log" tab (PM) and the Crew Foreman portal (foreman). Backed by
// /api/daily. Date selector (defaults to today) + recent-day history.
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";

const CHECK = `<svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const fmtDT = (v) => { if (!v) return ""; const d = new Date(String(v).replace(" ", "T")); return Number.isNaN(d.getTime()) ? String(v).slice(0, 16) : d.toLocaleString(); };
const shiftDay = (ymd, n) => { const [y, m, d] = ymd.split("-").map(Number); const dt = new Date(y, m - 1, d + n); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`; };
const niceDate = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }); };

export async function mountDailyPanel(container, entityId, opts = {}) {
  let data, logDate = opts.date || localToday();
  const noteOpen = new Set();

  const load = async () => { data = await api(`/daily/project/${encodeURIComponent(entityId)}?date=${logDate}`); };
  try { await load(); }
  catch (e) { container.innerHTML = `<div class="p-5 text-sm text-red-700">Failed to load daily log: ${escapeHtml(e?.message || String(e))}</div>`; return; }

  function itemRow(it) {
    const editing = noteOpen.has(it.key);
    return `
      <div class="flex items-start gap-3 py-2 px-1 border-b border-black/5 last:border-b-0">
        <button type="button" data-toggle="${it.key}" class="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${it.done ? "bg-kpi-completed-text border-kpi-completed-text text-white" : "border-black/25 bg-white text-transparent hover:border-black/40"}">${CHECK}</button>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-xs font-semibold ${it.done ? "text-black/45 line-through" : "text-ink-900"}">${escapeHtml(it.label)}</span>
            ${it.crew_sourced ? `<span class="inline-flex rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700">from crew</span>` : ""}
          </div>
          <div class="mt-0.5 flex items-center gap-2 flex-wrap">
            ${it.done && it.done_by ? `<span class="text-[10px] text-black/40">${escapeHtml(it.done_by)}${it.done_at ? " · " + escapeHtml(fmtDT(it.done_at)) : ""}</span>` : ""}
            <button type="button" data-note="${it.key}" class="text-[11px] font-medium text-black/40 hover:text-black/70">${it.note ? "✎ note" : "+ note"}</button>
          </div>
          ${it.note && !editing ? `<div class="mt-1 rounded-lg bg-black/[0.03] px-2 py-1 text-[11px] text-black/60 whitespace-pre-wrap">${escapeHtml(it.note)}</div>` : ""}
          ${editing ? `
            <div class="mt-1.5 flex items-start gap-1.5">
              <textarea data-note-input="${it.key}" rows="2" class="input text-xs py-1 flex-1" placeholder="Add a note…">${escapeHtml(it.note || "")}</textarea>
              <button type="button" data-note-save="${it.key}" class="btn-primary text-[11px] px-2 py-1">Save</button>
              <button type="button" data-note-cancel="${it.key}" class="rounded-lg border border-black/10 px-2 py-1 text-[11px] font-semibold hover:bg-black/5">Cancel</button>
            </div>` : ""}
        </div>
      </div>`;
  }

  function groupCard(g) {
    const doneN = g.items.filter(i => i.done).length;
    return `
      <div class="rounded-xl border border-black/10 overflow-hidden">
        <div class="flex items-center justify-between bg-black/[0.03] px-3 py-1.5">
          <span class="text-[11px] font-bold uppercase tracking-wide text-black/55">${escapeHtml(g.title)}</span>
          <span class="text-[10px] font-semibold text-black/40 tabular-nums">${doneN}/${g.items.length}</span>
        </div>
        <div class="px-3">${g.items.map(itemRow).join("")}</div>
      </div>`;
  }

  function render() {
    const allItems = data.groups.flatMap(g => g.items);
    const doneN = allItems.filter(i => i.done).length;
    const pct = Math.round((doneN / (data.item_count || 1)) * 100);
    const isToday = logDate === localToday();
    const histChips = (data.history || []).filter(h => h.date !== logDate).slice(0, 7).map(h =>
      `<button type="button" data-hist="${h.date}" class="inline-flex items-center gap-1 rounded-lg border border-black/10 bg-white px-2 py-1 text-[11px] font-semibold text-black/60 hover:bg-black/5 whitespace-nowrap">${escapeHtml(niceDate(h.date))} <span class="text-[10px] text-black/35">${h.done}/${data.item_count}</span></button>`
    ).join("");

    container.innerHTML = `
      <div class="p-4 sm:p-5">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
          <div>
            <div class="text-sm font-extrabold text-ink-900">Daily Requirements</div>
            <div class="text-xs text-black/50">Complete on active project days. ${data.history?.length ? "" : "No entries yet."}</div>
          </div>
          <div class="flex items-center gap-1.5">
            <button type="button" data-day="-1" class="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 hover:bg-black/5 text-black/60">‹</button>
            <input type="date" id="dLogDate" value="${logDate}" max="${localToday()}" class="input text-xs py-1.5">
            <button type="button" data-day="1" ${isToday ? "disabled" : ""} class="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 hover:bg-black/5 text-black/60 disabled:opacity-30">›</button>
            ${isToday ? `<span class="ml-1 inline-flex rounded-full bg-kpi-inProgress-bg border border-kpi-inProgress-bd px-2 py-0.5 text-[10px] font-bold text-kpi-inProgress-text">Today</span>` : `<button type="button" data-today class="ml-1 text-[11px] font-semibold text-blue-600 hover:underline">Jump to today</button>`}
          </div>
        </div>

        <div class="mb-4">
          <div class="flex items-center justify-between mb-1">
            <div class="text-xs font-semibold text-black/55">${escapeHtml(niceDate(logDate))}</div>
            <div class="text-xs font-semibold text-black/55">${doneN} / ${data.item_count} complete</div>
          </div>
          <div class="h-2 w-full rounded-full bg-black/[0.06] overflow-hidden"><div class="h-full rounded-full bg-kpi-completed-text transition-all" style="width:${pct}%"></div></div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
          ${data.groups.map(groupCard).join("")}
        </div>

        ${histChips ? `<div class="mt-4"><div class="text-[10px] font-bold uppercase tracking-wide text-black/35 mb-1.5">Recent days</div><div class="flex gap-1.5 flex-wrap">${histChips}</div></div>` : ""}
      </div>`;

    const di = container.querySelector("#dLogDate");
    if (di) di.addEventListener("change", async (e) => { if (e.target.value) { logDate = e.target.value; await reload(); } });
  }

  async function reload() { try { await load(); render(); } catch (err) { alert(`Could not load: ${err.message}`); } }

  async function postItem(key, patch) {
    await api(`/daily/project/${encodeURIComponent(entityId)}/item`, {
      method: "POST", body: JSON.stringify({ log_date: logDate, item_key: key, ...patch }),
    });
  }

  container.addEventListener("click", async (e) => {
    const day = e.target.closest("[data-day]");
    if (day) { logDate = shiftDay(logDate, Number(day.getAttribute("data-day"))); await reload(); return; }
    if (e.target.closest("[data-today]")) { logDate = localToday(); await reload(); return; }
    const hist = e.target.closest("[data-hist]");
    if (hist) { logDate = hist.getAttribute("data-hist"); await reload(); return; }

    const tog = e.target.closest("[data-toggle]");
    if (tog) {
      const key = tog.getAttribute("data-toggle");
      const it = data.groups.flatMap(g => g.items).find(x => x.key === key);
      try { await postItem(key, { done: !it.done }); await reload(); }
      catch (err) { alert(`Could not update: ${err.message}`); }
      return;
    }
    const nb = e.target.closest("[data-note]");
    if (nb) { const k = nb.getAttribute("data-note"); noteOpen.has(k) ? noteOpen.delete(k) : noteOpen.add(k); render(); return; }
    const nc = e.target.closest("[data-note-cancel]");
    if (nc) { noteOpen.delete(nc.getAttribute("data-note-cancel")); render(); return; }
    const ns = e.target.closest("[data-note-save]");
    if (ns) {
      const key = ns.getAttribute("data-note-save");
      const ta = container.querySelector(`[data-note-input="${key}"]`);
      try { await postItem(key, { note: ta ? ta.value : "" }); noteOpen.delete(key); await reload(); }
      catch (err) { alert(`Could not save note: ${err.message}`); }
      return;
    }
  });

  render();
}
