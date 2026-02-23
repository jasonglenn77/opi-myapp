import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

export async function schedulePage(routeFn) {
  // --- date helpers (no timezone surprises: treat as local dates)
  function parseYmd(s) {
    // s = "YYYY-MM-DD"
    const [y, m, d] = String(s).split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function ymd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function mondayOf(d) {
    const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const dow = (copy.getDay() + 6) % 7; // convert Sun(0) -> 6, Mon(1) -> 0
    copy.setDate(copy.getDate() - dow);
    return copy;
  }

  function addDays(d, n) {
    const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    copy.setDate(copy.getDate() + n);
    return copy;
  }

  function fmtHeader(d) {
    // e.g., Mon 1/5
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
    return `${dow} ${d.getMonth() + 1}/${d.getDate()}`;
  }

  // --- state
  const state = {
    weekStart: mondayOf(new Date()),
  };

  // --- fetch + render
  async function loadAndRender() {
    const data = await api(`/schedule?week_start=${encodeURIComponent(ymd(state.weekStart))}`);
    const crews = data.crews || [];
    const assignments = data.assignments || [];

    // build week days
    const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
    const weekEnd = days[6];

    // crews: sort stable (backend already sorts, but keep safe)
    const crewList = [...crews].sort((a, b) => {
      const sa = Number(a.sort_order ?? 0);
      const sb = Number(b.sort_order ?? 0);
      if (sa !== sb) return sa - sb;
      return String(a.code || "").localeCompare(String(b.code || ""));
    });

    // map: crewCode -> { ymd -> [items...] }
    const map = new Map(); // key: crewCode, value: Map(dateStr -> items[])
    for (const c of crewList) map.set(c.code, new Map());

    function pushItem(crewCode, dateStr, item) {
      if (!crewCode) return;
      if (!map.has(crewCode)) map.set(crewCode, new Map());
      const inner = map.get(crewCode);
      if (!inner.has(dateStr)) inner.set(dateStr, []);
      inner.get(dateStr).push(item);
    }

    // expand assignments across days they cover (within the week)
    for (const a of assignments) {
      const crewCode = a.work_crew_code || null;
      if (!crewCode) continue;

      const start = parseYmd(a.start_date);
      const end = parseYmd(a.end_date);

      const from = start > state.weekStart ? start : state.weekStart;
      const to = end < weekEnd ? end : weekEnd;

      // if no overlap, skip
      if (from > to) continue;

      for (let d = new Date(from.getFullYear(), from.getMonth(), from.getDate()); d <= to; d.setDate(d.getDate() + 1)) {
        const ds = ymd(d);
        pushItem(crewCode, ds, {
          pm: (a.pm_initials || "").trim(),
          project: a.project_name || "",
          status: a.project_status || "",
          project_id: a.project_id,
        });
      }
    }

    // build table header: each day spans 3 columns
    const header1 = days
      .map((d) => `<th class="px-3 py-2 text-left font-extrabold bg-white sticky top-0 z-20 border-b border-black/10" colspan="3">${escapeHtml(fmtHeader(d))}</th>`)
      .join("");

    const header2 = days
      .map(
        () => `
        <th class="px-3 py-2 text-left text-xs font-bold text-black/60 bg-white sticky top-[44px] z-20 border-b border-black/10">Crw</th>
        <th class="px-3 py-2 text-left text-xs font-bold text-black/60 bg-white sticky top-[44px] z-20 border-b border-black/10">PM</th>
        <th class="px-3 py-2 text-left text-xs font-bold text-black/60 bg-white sticky top-[44px] z-20 border-b border-black/10">Project</th>
      `
      )
      .join("");

    // rows: one per crew, repeated crew column for each day (like your sheet)
    const body = crewList
      .map((c) => {
        const crewCode = c.code || "";
        const inner = map.get(crewCode) || new Map();

        const tds = days
          .map((d) => {
            const ds = ymd(d);
            const items = inner.get(ds) || [];

            const crewCell = `
              <td class="px-3 py-2 whitespace-nowrap font-extrabold border-b border-black/5 bg-white/60">
                ${escapeHtml(crewCode)}
              </td>
            `;

            if (items.length === 0) {
              return (
                crewCell +
                `<td class="px-3 py-2 border-b border-black/5"></td>` +
                `<td class="px-3 py-2 border-b border-black/5"></td>`
              );
            }

            // show multiple if overlaps happen
            const pmHtml = items
              .map((it) => {
                const pm = (it.pm || "").toUpperCase();
                return pm
                  ? `<div class="inline-flex rounded-lg px-2 py-0.5 bg-black/5 border border-black/10 text-xs font-extrabold">${escapeHtml(pm)}</div>`
                  : `<div class="text-black/30">—</div>`;
              })
              .join(`<div class="h-1"></div>`);

            const projHtml = items
              .map((it) => `<div class="font-semibold">${escapeHtml(it.project)}</div>`)
              .join(`<div class="h-1"></div>`);

            return (
              crewCell +
              `<td class="px-3 py-2 border-b border-black/5 align-top">${pmHtml}</td>` +
              `<td class="px-3 py-2 border-b border-black/5 align-top min-w-[260px]">${projHtml}</td>`
            );
          })
          .join("");

        return `<tr>${tds}</tr>`;
      })
      .join("");

    const rangeLabel = `${ymd(state.weekStart)} → ${ymd(weekEnd)}`;

    const bodyHtml = `
      <div class="card p-5">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div class="text-lg font-extrabold">Schedule</div>
            <div class="text-sm text-black/60">Week view (Mon–Sun) by crew</div>
          </div>

          <div class="flex items-center gap-2">
            <div class="text-sm font-semibold text-black/60">${escapeHtml(rangeLabel)}</div>
            <button id="prevWeek" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold hover:bg-black/5">Prev</button>
            <button id="today" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold hover:bg-black/5">Today</button>
            <button id="nextWeek" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold hover:bg-black/5">Next</button>
          </div>
        </div>

        <div class="mt-4 border border-black/5 bg-white/40 rounded-2xl overflow-hidden">
          <div class="table-scroll">
            <table class="text-sm border-collapse w-full min-w-[1900px]">
              <thead>
                <tr>${header1}</tr>
                <tr>${header2}</tr>
              </thead>
              <tbody>${body || `<tr><td class="p-6 text-black/50" colspan="21">No crews found.</td></tr>`}</tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    setShell({
      title: "Schedule",
      subtitle: "Calendar-style view by crew.",
      bodyHtml,
      showLogout: true,
      routeFn,
    });

    // wire buttons
    document.getElementById("prevWeek").onclick = () => {
      state.weekStart = addDays(state.weekStart, -7);
      loadAndRender();
    };
    document.getElementById("nextWeek").onclick = () => {
      state.weekStart = addDays(state.weekStart, 7);
      loadAndRender();
    };
    document.getElementById("today").onclick = () => {
      state.weekStart = mondayOf(new Date());
      loadAndRender();
    };
  }

  await loadAndRender();
}