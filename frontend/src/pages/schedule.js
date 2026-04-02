import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

export async function schedulePage(routeFn) {
  // --- date helpers (no timezone surprises: treat as local dates)
  function parseYmd(s) {
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
    const dow = (copy.getDay() + 6) % 7; // Sun(0)->6, Mon(1)->0
    copy.setDate(copy.getDate() - dow);
    return copy;
  }

  function addDays(d, n) {
    const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    copy.setDate(copy.getDate() + n);
    return copy;
  }

  // Returns all Mon–Sun week arrays that cover the given month.
  // Each week is an array of 7 Date objects.
  function weeksForMonth(year, month) {
    // First day of month
    const firstOfMonth = new Date(year, month, 1);
    // Last day of month
    const lastOfMonth = new Date(year, month + 1, 0);

    // Start from the Monday of the week containing the 1st
    let weekStart = mondayOf(firstOfMonth);

    const weeks = [];
    while (weekStart <= lastOfMonth) {
      const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
      weeks.push(week);
      weekStart = addDays(weekStart, 7);
    }
    return weeks;
  }

  // Month range: first Monday of month's first week → last Sunday of month's last week
  function monthRange(year, month) {
    const weeks = weeksForMonth(year, month);
    return {
      start: weeks[0][0],
      end: weeks[weeks.length - 1][6],
    };
  }

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // --- state: track current month/year
  const now = new Date();
  const state = {
    year: now.getFullYear(),
    month: now.getMonth(), // 0-indexed
  };

  // --- fetch + render
  async function loadAndRender() {
    const { start, end } = monthRange(state.year, state.month);

    const [data, pms] = await Promise.all([
      api(`/schedule?week_start=${encodeURIComponent(ymd(start))}&week_end=${encodeURIComponent(ymd(end))}`),
      api("/project-managers"),
    ]);

    const crews = data.crews || [];
    const assignments = data.assignments || [];

    // --- PM initials -> color map
    function pmInitialsFromRecord(pm) {
      const a = (pm.first_name || "").trim().slice(0, 1);
      const b = (pm.last_name || "").trim().slice(0, 1);
      return (a + b).toUpperCase() || null;
    }

    const pmColorByInitials = new Map();
    for (const pm of (pms || [])) {
      const initials = pmInitialsFromRecord(pm);
      if (initials && pm.color) pmColorByInitials.set(initials, pm.color);
    }

    function textColorForBg(hex) {
      if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "#111";
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return lum < 0.55 ? "#fff" : "#111";
    }

    // Build weeks for this month
    const weeks = weeksForMonth(state.year, state.month);
    const monthStart = weeks[0][0];
    const monthEnd = weeks[weeks.length - 1][6];

    // --- Build child-only crew list in Teams page order
    const parents = (crews || []).filter(c => !c.parent_id);
    const children = (crews || []).filter(c => c.parent_id);

    function crewSortKey(a, b) {
      const sa = Number(a.sort_order ?? 0);
      const sb = Number(b.sort_order ?? 0);
      if (sa !== sb) return sa - sb;
      return Number(a.id || 0) - Number(b.id || 0);
    }

    const parentsSorted = [...parents].sort(crewSortKey);
    const childrenByParent = new Map();
    for (const ch of children) {
      const k = String(ch.parent_id);
      if (!childrenByParent.has(k)) childrenByParent.set(k, []);
      childrenByParent.get(k).push(ch);
    }
    for (const arr of childrenByParent.values()) arr.sort(crewSortKey);

    const crewList = [];
    for (const p of parentsSorted) {
      const kids = childrenByParent.get(String(p.id)) || [];
      for (const ch of kids) crewList.push(ch);
    }

    // map: crewCode -> { ymd -> [items...] }
    const map = new Map();
    for (const c of crewList) map.set(c.code, new Map());

    function pushItem(crewCode, dateStr, item) {
      if (!crewCode) return;
      if (!map.has(crewCode)) map.set(crewCode, new Map());
      const inner = map.get(crewCode);
      if (!inner.has(dateStr)) inner.set(dateStr, []);
      inner.get(dateStr).push(item);
    }

    // Expand assignments across days they cover (within the month range)
    for (const a of assignments) {
      const crewCodes = Array.isArray(a.work_crew_codes)
        ? a.work_crew_codes.filter(Boolean)
        : [];
      if (crewCodes.length === 0) continue;

      const start = parseYmd(a.start_date);
      const end = parseYmd(a.end_date);
      const travelDays = a.travel_days || 0;
      const overageDays = a.overage_days || 0;
      const halfTravel = travelDays / 2;

      const pmsForItem = Array.isArray(a.pm_initials)
        ? a.pm_initials.map(x => String(x || "").trim().toUpperCase()).filter(Boolean)
        : [];

      const baseItem = {
        project_id: a.project_id,
        project: a.project_name || "",
        status: a.project_status || "",
        start_date: a.start_date,
        end_date: a.end_date,
        crews: crewCodes,
        pms: pmsForItem,
        wire_guidance: a.wire_guidance,
      };

      for (const crewCode of crewCodes) {
        // Travel days BEFORE start
        for (let i = halfTravel; i >= 1; i--) {
          const d = addDays(start, -i);
          if (d >= monthStart && d <= monthEnd) {
            pushItem(crewCode, ymd(d), { ...baseItem, project: "Travel", cellType: "travel" });
          }
        }

        // Regular project days
        for (
          let d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
          d <= end;
          d.setDate(d.getDate() + 1)
        ) {
          if (d >= monthStart && d <= monthEnd) {
            pushItem(crewCode, ymd(d), { ...baseItem, cellType: "project" });
          }
        }

        // Overage days (after end)
        for (let i = 1; i <= overageDays; i++) {
          const d = addDays(end, i);
          if (d >= monthStart && d <= monthEnd) {
            pushItem(crewCode, ymd(d), { ...baseItem, cellType: "overage" });
          }
        }

        // Travel day AFTER overage
        for (let i = 1; i <= halfTravel; i++) {
          const d = addDays(end, overageDays + i);
          if (d >= monthStart && d <= monthEnd) {
            pushItem(crewCode, ymd(d), { ...baseItem, project: "Travel", cellType: "travel" });
          }
        }
      }
    }

    function crewHasAnyThisMonth(crewCode) {
      const inner = map.get(crewCode) || new Map();
      return weeks.some(week => week.some(d => (inner.get(ymd(d)) || []).length > 0));
    }

    const visibleCrews = crewList.filter(c => crewHasAnyThisMonth(c.code || ""));

    // Build the fixed day-of-week header row (Mon–Sun)
    const dayHeaderRow = `
      <tr>
        <th class="text-[11px] font-extrabold text-black px-2 py-1.5 bg-white sticky top-0 z-30 border-b border-r border-black/10 whitespace-nowrap shadow-sm" style="min-width:36px;">Crew</th>
        ${DAY_LABELS.map(d => `
          <th class="text-[11px] font-extrabold text-black px-2 py-1.5 bg-white sticky top-0 z-30 border-b border-black/10 whitespace-nowrap text-center shadow-sm" style="min-width:90px;">${d}</th>
        `).join("")}
      </tr>
    `;

    function renderAssignmentCell(items, crewCode, currentDate) {
      if (items.length === 0) return `<td class="px-1 py-0.5 border-b border-black/5 align-top"></td>`;

      const html = items.map(it => {
        const isTravel  = it.cellType === "travel";
        const isOverage = it.cellType === "overage";

        // 👉 NEW: detect if this is the project's START DATE
        const isStartDate = it.start_date === ymd(currentDate);

        // 👉 NEW: wire guidance flag
        const hasWire = !!it.wire_guidance;

        let wrapClass;

        if (isTravel) {
          wrapClass = "bg-gray-300 rounded px-1 py-0.5 text-gray-800 italic text-center font-semibold border border-gray-400";
        } else if (isOverage) {
          wrapClass = "bg-orange-50 border border-orange-200 rounded px-0.5 py-px text-orange-700";
        } else if (isStartDate) {
          // 👉 NEW: highlight ONLY on start date
          wrapClass = hasWire
            ? "bg-teal-400 text-white rounded px-0.5 py-px font-extrabold"
            : "bg-yellow-300 text-black rounded px-0.5 py-px font-extrabold";
        } else {
          wrapClass = "rounded px-0.5 py-px";
        }

        const pmList = Array.isArray(it.pms) ? it.pms : [];
        const pmBadges = (!isTravel && pmList.length)
          ? pmList.map(pm => {
              const color = pmColorByInitials.get(pm) || null;
              if (!color) {
                return `<span class="inline-flex rounded px-0.5 bg-black/5 border border-black/10 text-[9px] font-extrabold leading-tight">${escapeHtml(pm)}</span>`;
              }
              const fg = textColorForBg(color);
              return `<span class="inline-flex rounded px-0.5 border text-[9px] font-extrabold leading-tight"
                style="background:${color}; border-color:rgba(0,0,0,0.12); color:${fg};"
              >${escapeHtml(pm)}</span>`;
            }).join("")
          : "";

        const tip = encodeURIComponent(JSON.stringify({
          project: it.project,
          status: it.status,
          start_date: it.start_date,
          end_date: it.end_date,
          crews: it.crews || [crewCode].filter(Boolean),
          pms: it.pms || [],
        }));

        return `
          <div class="flex flex-col gap-px ${wrapClass} mb-px">
            ${pmBadges ? `<div class="flex flex-wrap gap-px">${pmBadges}</div>` : ""}
            <div class="text-[10px] leading-tight font-semibold ${isTravel ? "text-center" : "cursor-pointer hover:underline"} break-words"
              ${isTravel ? "" : `data-proj-tip="${tip}"`}>
              ${escapeHtml(it.project)}
            </div>
          </div>
        `;
      }).join("");

      return `<td class="px-1 py-0.5 border-b border-black/5 align-top">${html}</td>`;
    }

    // Build week blocks
    const weeksHtml = weeks.map(week => {
      // Week label row: show date numbers for each day
      const dateNumbers = week.map(d => {
        const isCurrentMonth = d.getMonth() === state.month;
        const isToday = ymd(d) === ymd(new Date());
        return `
          <td class="sticky top-[30px] z-20 text-[11px] px-1 py-1 text-center border-b border-black/20 bg-gray-100
            ${isToday 
              ? "bg-gray-100 text-blue-600 font-extrabold" 
              : isCurrentMonth 
                ? "text-black font-semibold" 
                : "text-black/40"}"
          >${d.getDate()}</td>
        `;
      }).join("");

      const dateRow = `
        <tr>
          <td class="sticky top-[30px] z-20 text-[11px] px-1 py-1 font-extrabold bg-gray-200 text-black border-b border-black/20">
            ${(week[0].getMonth() + 1)}/${week[0].getDate()}
          </td>
          ${dateNumbers}
        </tr>
      `;

      if (visibleCrews.length === 0) {
        return dateRow + `
          <tr>
            <td class="text-[10px] text-black/40 px-1 py-2 border-b border-black/5" colspan="8">No assignments this week.</td>
          </tr>
        `;
      }

      const crewRows = visibleCrews.map(c => {
        const crewCode = c.code || "";
        const inner = map.get(crewCode) || new Map();

        const tds = week.map(d => {
          const items = inner.get(ymd(d)) || [];
          return renderAssignmentCell(items, crewCode, d);
        }).join("");

        return `
          <tr>
            <td class="text-[10px] px-1 py-0.5 font-extrabold border-b border-black/5 bg-white/60 whitespace-nowrap align-top">${escapeHtml(crewCode)}</td>
            ${tds}
          </tr>
        `;
      }).join("");

      return dateRow + crewRows;
    }).join("");

    const monthLabel = `${MONTH_NAMES[state.month]} ${state.year}`;

    const bodyHtml = `
      <div class="card flex flex-col overflow-hidden" style="height:calc(100vh - 180px); min-height:400px;">

        <!-- Fixed card header -->
        <div class="shrink-0 px-4 pt-4 pb-3 border-b border-black/10">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div class="text-base font-extrabold">Schedule</div>
              <div class="text-xs text-black/60">Month view (Mon–Sun) by crew</div>
            </div>
            <div class="flex items-center gap-2 flex-wrap justify-end">
              <div class="text-xs font-semibold text-black/60 whitespace-nowrap">${escapeHtml(monthLabel)}</div>

              <label for="jumpMonth" class="text-xs font-semibold text-black/60 whitespace-nowrap">
                Jump to:
              </label>
              <input
                id="jumpMonth"
                type="month"
                value="${state.year}-${String(state.month + 1).padStart(2, "0")}"
                class="rounded-xl border border-black/15 px-3 py-1.5 text-xs font-semibold bg-white hover:bg-black/5"
              />

              <button id="prevMonth" class="rounded-xl border border-black/15 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">← Prev</button>
              <button id="todayBtn" class="rounded-xl border border-black/15 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">Today</button>
              <button id="nextMonth" class="rounded-xl border border-black/15 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">Next →</button>
            </div>
          </div>
        </div>

        <!-- Scrollable table area -->
        <div class="flex-1 overflow-auto">
          <table class="text-[10px] border-collapse w-full">
            <thead class="sticky top-0 z-20">
              ${dayHeaderRow}
            </thead>
            <tbody>
              ${weeksHtml}
            </tbody>
          </table>
        </div>

      </div>
    `;

    setShell({
      title: "Schedule",
      subtitle: "Month view by crew.",
      bodyHtml,
      showLogout: true,
      routeFn,
    });

    // --- Tooltip (global, avoids table overflow clipping)
    let tipEl = document.getElementById("projTip");
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = "projTip";
      tipEl.className = "fixed z-[9999] hidden pointer-events-none max-w-[320px] rounded-xl border border-black/10 bg-white p-3 text-xs shadow-lg text-ink-900";
      document.body.appendChild(tipEl);
    }

    function showTip(html, x, y) {
      tipEl.innerHTML = html;
      tipEl.classList.remove("hidden");
      const rect = tipEl.getBoundingClientRect();
      tipEl.style.left = `${Math.max(8, Math.min(x + 12, window.innerWidth - rect.width - 8))}px`;
      tipEl.style.top  = `${Math.max(8, Math.min(y + 12, window.innerHeight - rect.height - 8))}px`;
    }

    function hideTip() { tipEl.classList.add("hidden"); }

    document.querySelectorAll("[data-proj-tip]").forEach(el => {
      el.addEventListener("mouseenter", e => {
        const raw = el.getAttribute("data-proj-tip");
        if (!raw) return;
        const data = JSON.parse(decodeURIComponent(raw));
        const crews = (data.crews || []).join(", ") || "—";
        const pms   = (data.pms   || []).join(", ") || "—";
        const html = `
          ${data.project ? `<div class="font-extrabold mb-1">${escapeHtml(data.project)}</div>` : ""}
          <div class="text-black/70"><span class="font-semibold">Status:</span> ${escapeHtml(data.status || "—")}</div>
          <div class="text-black/70"><span class="font-semibold">Dates:</span> ${escapeHtml(`${data.start_date || "—"} → ${data.end_date || "—"}`)}</div>
          <div class="text-black/70"><span class="font-semibold">Crews:</span> ${escapeHtml(crews)}</div>
          <div class="text-black/70"><span class="font-semibold">PMs:</span> ${escapeHtml(pms)}</div>
        `;
        showTip(html, e.clientX, e.clientY);
      });

      el.addEventListener("mousemove", e => {
        if (tipEl.classList.contains("hidden")) return;
        const rect = tipEl.getBoundingClientRect();
        tipEl.style.left = `${Math.max(8, Math.min(e.clientX + 12, window.innerWidth - rect.width - 8))}px`;
        tipEl.style.top  = `${Math.max(8, Math.min(e.clientY + 12, window.innerHeight - rect.height - 8))}px`;
      });

      el.addEventListener("mouseleave", hideTip);
    });

    // --- Wire navigation buttons
    document.getElementById("prevMonth").onclick = () => {
      state.month -= 1;
      if (state.month < 0) { state.month = 11; state.year -= 1; }
      loadAndRender();
    };

    document.getElementById("nextMonth").onclick = () => {
      state.month += 1;
      if (state.month > 11) { state.month = 0; state.year += 1; }
      loadAndRender();
    };

    document.getElementById("todayBtn").onclick = () => {
      const t = new Date();
      state.year  = t.getFullYear();
      state.month = t.getMonth();
      loadAndRender();
    };

    const jumpMonthEl = document.getElementById("jumpMonth");
    if (jumpMonthEl) {
      jumpMonthEl.onchange = () => {
        const value = jumpMonthEl.value; // format: YYYY-MM
        if (!value) return;

        const [yearStr, monthStr] = value.split("-");
        const year = Number(yearStr);
        const month = Number(monthStr);

        if (!Number.isFinite(year) || !Number.isFinite(month)) return;

        state.year = year;
        state.month = month - 1; // input is 1-based, JS month is 0-based
        loadAndRender();
      };
    }
  }

  await loadAndRender();
}