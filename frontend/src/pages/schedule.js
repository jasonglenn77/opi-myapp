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
    const [data, pms] = await Promise.all([
    api(`/schedule?week_start=${encodeURIComponent(ymd(state.weekStart))}`),
    api("/project-managers"),
    ]);
    const crews = data.crews || [];
    const assignments = data.assignments || [];
    console.log("SCHEDULE assignments sample:", (assignments || []).slice(0, 5));
    console.log("Missing names:", (assignments || []).filter(a => !(a.project_name || "").trim()).slice(0, 10));

    // --- PM initials -> color map
    function pmInitialsFromRecord(pm) {
      const a = (pm.first_name || "").trim().slice(0, 1);
      const b = (pm.last_name || "").trim().slice(0, 1);
      const initials = (a + b).toUpperCase();
      return initials || null;
    }

    const pmColorByInitials = new Map();
    for (const pm of (pms || [])) {
      const initials = pmInitialsFromRecord(pm);
      if (initials && pm.color) pmColorByInitials.set(initials, pm.color);
    }

    // readable text color on colored badge
    function textColorForBg(hex) {
      // hex like "#RRGGBB"
      if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "#111";
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      // relative luminance
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return lum < 0.55 ? "#fff" : "#111";
    }

    // build week days
    const days = Array.from({ length: 7 }, (_, i) => addDays(state.weekStart, i));
    const weekEnd = days[6];

    // --- Build child-only crew list in the same order as Teams page
    const parents = (crews || []).filter(c => !c.parent_id);
    const children = (crews || []).filter(c => c.parent_id);

    function crewSortKey(a, b) {
      const sa = Number(a.sort_order ?? 0);
      const sb = Number(b.sort_order ?? 0);
      if (sa !== sb) return sa - sb;
      // tie breakers keep stable
      return Number(a.id || 0) - Number(b.id || 0);
    }

    const parentsSorted = [...parents].sort(crewSortKey);
    const childrenByParent = new Map();
    for (const ch of children) {
      const k = String(ch.parent_id);
      if (!childrenByParent.has(k)) childrenByParent.set(k, []);
      childrenByParent.get(k).push(ch);
    }
    for (const [k, arr] of childrenByParent.entries()) {
      arr.sort(crewSortKey);
    }

    const crewList = [];
    for (const p of parentsSorted) {
      const kids = childrenByParent.get(String(p.id)) || [];
      for (const ch of kids) crewList.push(ch);
    }
    // crewList is now: children only, in Teams page order

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
      const crewCodes = Array.isArray(a.work_crew_codes)
        ? a.work_crew_codes.filter(Boolean)
        : [];

      if (crewCodes.length === 0) continue;

      const start = parseYmd(a.start_date);
      const end = parseYmd(a.end_date);

      const from = start > state.weekStart ? start : state.weekStart;
      const to = end < weekEnd ? end : weekEnd;
      if (from > to) continue;

      const pmsForItem = Array.isArray(a.pm_initials)
        ? a.pm_initials.map(x => String(x || "").trim().toUpperCase()).filter(Boolean)
        : [];

      for (
        let d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
        d <= to;
        d.setDate(d.getDate() + 1)
      ) {
        const ds = ymd(d);

        for (const crewCode of crewCodes) {
          pushItem(crewCode, ds, {
            project_id: a.project_id,
            project: a.project_name || "",
            status: a.project_status || "",
            start_date: a.start_date,
            end_date: a.end_date,
            crews: crewCodes,
            pms: pmsForItem,
          });
        }
      }
    }

    // build table header: each day spans 2 columns
    const header1 = days
      .map((d) => `<th class="px-3 py-2 text-left font-extrabold bg-white sticky top-0 z-20 border-b border-black/10" colspan="2">${escapeHtml(fmtHeader(d))}</th>`)
      .join("");

    const header2 = days
      .map(
        () => `
          <th class="px-3 py-2 text-left text-xs font-bold text-black/60 bg-white sticky top-[44px] z-20 border-b border-black/10">Crw</th>
          <th class="px-3 py-2 text-left text-xs font-bold text-black/60 bg-white sticky top-[44px] z-20 border-b border-black/10">Assignments</th>
        `
      )
      .join("");

    function crewHasAnyThisWeek(crewCode) {
      const inner = map.get(crewCode) || new Map();
      return days.some(d => (inner.get(ymd(d)) || []).length > 0);
    }

    // rows: one per crew
    const body = crewList
      .filter(c => crewHasAnyThisWeek(c.code || ""))
      .map((c) => {
        const crewCode = c.code || "";
        const inner = map.get(crewCode) || new Map();

        const tds = days.map((d) => {
          const ds = ymd(d);
          const items = inner.get(ds) || [];

          const crewCell = `
            <td class="px-3 py-2 whitespace-nowrap font-extrabold border-b border-black/5 bg-white/60">
              ${escapeHtml(crewCode)}
            </td>
          `;

          // 2 columns per day now
          if (items.length === 0) {
            return crewCell + `<td class="px-3 py-2 border-b border-black/5"></td>`;
          }

          const assignmentsHtml = items
            .map((it) => {
              const pmList = Array.isArray(it.pms) ? it.pms : [];
              const pmBadges = pmList.length
                ? pmList.map((pm) => {
                    const color = pmColorByInitials.get(pm) || null;
                    if (!color) {
                      return `<span class="inline-flex rounded-lg px-2 py-0.5 bg-black/5 border border-black/10 text-xs font-extrabold">${escapeHtml(pm)}</span>`;
                    }
                    const fg = textColorForBg(color);
                    return `<span class="inline-flex rounded-lg px-2 py-0.5 border text-xs font-extrabold"
                      style="background:${color}; border-color: rgba(0,0,0,0.12); color:${fg};"
                    >${escapeHtml(pm)}</span>`;
                  }).join("")
                : `<span class="text-black/30">—</span>`;
              
              const tip = encodeURIComponent(JSON.stringify({
                project: it.project,
                status: it.status,
                start_date: it.start_date,
                end_date: it.end_date,
                crews: it.crews || [crewCode].filter(Boolean),
                pms: it.pms || [],
              }));

              return `
                <div class="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 items-start py-1">
                  <div class="flex flex-wrap gap-1">${pmBadges}</div>
                  <div class="font-semibold cursor-pointer hover:underline whitespace-normal break-words" data-proj-tip="${tip}">
                    ${escapeHtml(it.project)}
                  </div>
                </div>
              `;
            })
            .join("");

          return (
            crewCell +
            `<td class="px-3 py-2 border-b border-black/5 align-top min-w-[220px]">${assignmentsHtml}</td>`
          );
        }).join("");

        return `<tr>${tds}</tr>`;
      })
      .join("");

    const rangeLabel = `${ymd(state.weekStart)} → ${ymd(weekEnd)}`;
    const totalCols = days.length * 2;

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
            <table class="text-sm border-collapse w-full">
              <thead>
                <tr>${header1}</tr>
                <tr>${header2}</tr>
              </thead>
              <tbody>${body || `<tr><td class="p-6 text-black/50" colspan="${totalCols}">No crews found.</td></tr>`}</tbody>
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

    // --- Tooltip (global, avoids table overflow clipping)
    let tipEl = document.getElementById("projTip");
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = "projTip";
      tipEl.className = "fixed z-[9999] hidden pointer-events-none max-w-[360px] rounded-xl border border-black/10 bg-white p-3 text-sm shadow-lg text-ink-900";
      document.body.appendChild(tipEl);
    }

    function showTip(html, x, y) {
      tipEl.innerHTML = html;
      tipEl.classList.remove("hidden");

      const rect = tipEl.getBoundingClientRect();
      const tipWidth = rect.width;
      const tipHeight = rect.height;

      tipEl.style.left = `${Math.max(8, Math.min(x + 12, window.innerWidth - tipWidth - 8))}px`;
      tipEl.style.top  = `${Math.max(8, Math.min(y + 12, window.innerHeight - tipHeight - 8))}px`;
    }

    function hideTip() {
      tipEl.classList.add("hidden");
    }

    // wire hover handlers
    document.querySelectorAll("[data-proj-tip]").forEach((el) => {
      el.addEventListener("mouseenter", (e) => {
        const raw = el.getAttribute("data-proj-tip");
        console.log("TIP RAW:", raw);
        
        if (!raw) return;
        const data = JSON.parse(decodeURIComponent(raw));

        const crews = (data.crews || []).join(", ") || "—";
        const pms = (data.pms || []).join(", ") || "—";
        const status = data.status || "—";
        const dates = `${data.start_date || "—"} → ${data.end_date || "—"}`;

        const titleHtml = data.project
          ? `<div class="font-extrabold mb-1">${escapeHtml(data.project)}</div>`
          : "";

        const html = `
          ${titleHtml}
          <div class="text-black/70"><span class="font-semibold">Status:</span> ${escapeHtml(status)}</div>
          <div class="text-black/70"><span class="font-semibold">Dates:</span> ${escapeHtml(dates)}</div>
          <div class="text-black/70"><span class="font-semibold">Crews:</span> ${escapeHtml(crews)}</div>
          <div class="text-black/70"><span class="font-semibold">PMs:</span> ${escapeHtml(pms)}</div>
        `;
        showTip(html, e.clientX, e.clientY);
      });

      el.addEventListener("mousemove", (e) => {
        if (tipEl.classList.contains("hidden")) return;

        const rect = tipEl.getBoundingClientRect();
        const tipWidth = rect.width;
        const tipHeight = rect.height;

        tipEl.style.left = `${Math.max(8, Math.min(e.clientX + 12, window.innerWidth - tipWidth - 8))}px`;
        tipEl.style.top  = `${Math.max(8, Math.min(e.clientY + 12, window.innerHeight - tipHeight - 8))}px`;
      });

      el.addEventListener("mouseleave", hideTip);
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