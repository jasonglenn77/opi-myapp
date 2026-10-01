// Schedule page: month view by crew, with PM badges and tooltips.
// CR4: clicking a project on the grid opens an assignment-editor modal that
// reuses the Assignment page's endpoints (/assignment/bundle + /assignment/save
// incl. crew_assignments v2) and the shared history renderer.
import { api, fetchMe, hasCapability } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import {
  historyBadgeHtml, historyPanelHtml, loadHistory, invalidateHistory, cachedHistory,
  historyCountOf,
} from "../utils/assignment-history.js";
import {
  entryLabel, toDraftEntry, crewFieldsFor, crewEditorBodyHtml,
  handleCrewEditorClick, handleCrewEditorChange, handleCrewEditorInput,
} from "../utils/crew-editor.js";

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

  // Pay day: every 14 days centered on 2026-03-13 (Friday). Same biweekly
  // cadence rolls forward and backward from the anchor — past or future.
  // Compared at noon to sidestep DST edge cases on the boundary days.
  const PAY_DAY_ANCHOR_NOON = new Date(2026, 2, 13, 12).getTime();   // Mar = month 2
  function isPayDay(d) {
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
    const days = Math.round((target - PAY_DAY_ANCHOR_NOON) / 86400000);
    return days % 14 === 0;
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
  // CR5 B1: "Needs crew" rows (dated projects with no crew assigned) —
  // DEFAULT ON (Jason's notification intent; flip the default here if he
  // prefers it off after review), persisted per session.
  let needsCrewOn = true;
  try { needsCrewOn = sessionStorage.getItem("opi_sched_needscrew") !== "0"; } catch (_) { /* default on */ }
  const state = {
    year: now.getFullYear(),
    month: now.getMonth(), // 0-indexed
    crewView: "all", // "condensed" | "all"
    needsCrew: needsCrewOn,
  };

  // ── CR4: Schedules-page assignment modal ─────────────────────────────────
  // Opens on project click; lists EVERY schedule line of the project (each
  // editable) + "+ Add assignment line". Saves go through the exact same
  // /assignment/save payload the Assignment page sends (crew_assignments v2
  // included); after a save the modal closes and the schedule re-fetches in
  // place (scroll kept). Editing is gated by the same capabilities the
  // Assignment page's save uses (assignment.edit_any / edit_own — the server
  // still enforces per-project scope for edit_own); read-only otherwise.
  const MODAL_STATUS_OPTIONS = [
    ["needs_attention", "Needs Attention"], ["pending", "Pending"],
    ["not_started", "Not Started"], ["in_progress", "In Progress"],
    ["completed", "Completed"], ["canceled", "Canceled"],
  ];
  const MODAL_TRAVEL_OPTIONS = [[0, "None"], [2, "2 days"], [3, "3 days"], [4, "4 days"]];
  const MODAL_EQUIP_OPTIONS = ["", "Equip", "No Equip", "Electric"];

  async function openAssignModal(qboCustomerId, projectName) {
    document.getElementById("schedAssignModal")?.remove();

    let me = null;
    try { me = await fetchMe(); } catch { /* capability check falls back to read-only */ }
    const canEdit = !!me && (hasCapability("assignment.edit_any") || hasCapability("assignment.edit_own"));

    const overlay = document.createElement("div");
    overlay.id = "schedAssignModal";
    overlay.className = "schm-overlay";
    overlay.innerHTML = `
      <div class="schm-card">
        <div class="schm-head">
          <div>
            <div class="schm-title">${escapeHtml(projectName || "Project")}</div>
            <div class="schm-sub">Assignment lines — same data as the Assignment page.</div>
          </div>
          <button type="button" class="schm-x" data-m-close="1" aria-label="Close">✕</button>
        </div>
        <div class="schm-body"><div class="ah-loading">Loading assignment…</div></div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

    let bundle;
    try {
      bundle = await api(`/assignment/bundle?qbo_customer_id=${encodeURIComponent(qboCustomerId)}`);
    } catch (e) {
      overlay.querySelector(".schm-body").innerHTML =
        `<div class="schm-ro">Failed to load assignment: ${escapeHtml(e?.message || String(e))}</div>`;
      return;
    }

    const pms = bundle.project_managers || [];
    const histOpen = new Set();

    // Draft lines from the bundle — crew entries via the SHARED editor module
    // (utils/crew-editor.js, CR5 B1 de-fork): toDraftEntry derives company/
    // lead for legacy rows exactly like the Assignment page + workspace tab.
    const lines = (bundle.schedule_items || []).map((it) => ({
      id: it.id,
      status: it.status || "needs_attention",
      start_date: it.start_date ? String(it.start_date).slice(0, 10) : "",
      end_date: it.end_date ? String(it.end_date).slice(0, 10) : "",
      wire_guidance: it.wire_guidance ? 1 : 0,
      travel_days: Number(it.travel_days || 0),
      overage_days: Number(it.overage_days || 0),
      equipment_type: it.equipment_type || "",
      notes: it.notes || "",
      is_extra_row: it.is_extra_row,
      history_count: it.history_count,
      pms: (it.active_project_managers || []).map((x) => ({
        project_manager_id: Number(x.project_manager_id), is_primary: !!x.is_primary })),
      crews: (it.active_work_crews || []).map((x) => toDraftEntry(bundle, x)),
    }));
    if (!lines.length) {
      lines.push(blankLine());
    }
    function blankLine() {
      return { id: null, status: "not_started", start_date: "", end_date: "",
               wire_guidance: 0, travel_days: 0, overage_days: 0,
               equipment_type: "", notes: "", is_extra_row: 1, history_count: null,
               pms: [], crews: [], _new: true };
    }

    // Slot codes taken by the OTHER lines' drafts (host-specific bit the
    // shared editor needs for its slot auto-suggest).
    const takenSlots = (skipLine) => {
      const taken = new Set();
      lines.forEach((ln, li) => {
        if (li === skipLine) return;
        (ln.crews || []).forEach((c) => { if (c.slot_code) taken.add(String(c.slot_code).toUpperCase()); });
      });
      return taken;
    };

    const dis = canEdit ? "" : "disabled";

    function lineHtml(ln, i) {
      const pmRows = pms.map((pm) => {
        const name = `${pm.first_name || ""} ${pm.last_name || ""}`.trim() || pm.email || `PM ${pm.id}`;
        const on = ln.pms.some((x) => String(x.project_manager_id) === String(pm.id));
        const prim = ln.pms.find((x) => x.is_primary)?.project_manager_id;
        return `
          <label class="schm-pickrow">
            <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;">
              <input type="checkbox" class="h-4 w-4" data-m-pmchk="${i}" data-id="${pm.id}" ${on ? "checked" : ""} ${dis}/>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(name)}</span>
            </span>
            <span class="schm-prim">Primary
              <input type="radio" name="schm-pmprim-${i}" class="h-3.5 w-3.5" data-m-pmprim="${i}" data-id="${pm.id}"
                ${String(prim ?? "") === String(pm.id) ? "checked" : ""} ${dis}/>
            </span>
          </label>`;
      }).join("") || `<div class="ah-loading">No active PMs.</div>`;

      // CR5 B1 de-fork: the crew-entry markup comes from the SHARED editor
      // module (same as assignment.js + assignment-panel.js) — no forked copy.
      // Read-only mode renders a plain label list instead of the editor.
      const crewBox = canEdit
        ? crewEditorBodyHtml(bundle, ln.crews, `schm-crewprim-${i}`)
        : `<div class="schm-boxhead">Crews — company first, lead optional</div>`
          + ((ln.crews || []).map((e) => `
            <div class="schm-pickrow"><span>${escapeHtml(entryLabel(bundle, e))}${e.slot_code ? ` (${escapeHtml(e.slot_code)})` : ""}${e.is_primary ? ` <span class="text-black/40">· primary</span>` : ""}</span></div>`).join("")
            || `<div class="ah-loading">No crew on this line yet.</div>`);

      const open = ln.id != null && histOpen.has(String(ln.id));
      const cachedH = ln.id != null ? cachedHistory(ln.id) : null;
      const histCount = ln.id != null ? (cachedH ? historyCountOf(cachedH) : ln.history_count) : null;

      return `
        <div class="schm-line ${ln.id == null ? "schm-new" : ""}" data-m-line="${i}">
          <div class="schm-linehead">
            <span class="schm-linetag">Line ${i + 1}${ln.id == null ? " · new (not saved yet)" : (ln.is_extra_row ? "" : " · main")}</span>
            <span style="display:inline-flex;align-items:center;gap:8px;">
              ${ln.id != null ? historyBadgeHtml(ln.id, histCount, open) : ""}
              <span class="schm-msg" data-m-msg="${i}"></span>
              ${canEdit ? `<button type="button" class="btn-primary text-xs px-3 py-1.5" data-m-save="${i}">Save</button>` : ""}
            </span>
          </div>
          ${open ? historyPanelHtml(ln.id) : ""}
          <div class="schm-grid">
            <div><span class="schm-l">Status</span>
              <select class="input text-xs py-1.5" data-m-f="status" data-i="${i}" ${dis}>
                ${MODAL_STATUS_OPTIONS.map(([v, l]) => `<option value="${v}" ${ln.status === v ? "selected" : ""}>${l}</option>`).join("")}
              </select></div>
            <div><span class="schm-l">Start</span>
              <input type="date" class="input text-xs py-1.5" data-m-f="start_date" data-i="${i}" value="${escapeHtml(ln.start_date)}" ${dis}/></div>
            <div><span class="schm-l">End</span>
              <input type="date" class="input text-xs py-1.5" data-m-f="end_date" data-i="${i}" value="${escapeHtml(ln.end_date)}" ${dis}/></div>
            <div><span class="schm-l">Overage days</span>
              <input type="number" min="0" step="1" class="input text-xs py-1.5" data-m-f="overage_days" data-i="${i}" value="${ln.overage_days || 0}" ${dis}/></div>
            <div><span class="schm-l">Travel days</span>
              <select class="input text-xs py-1.5" data-m-f="travel_days" data-i="${i}" ${dis}>
                ${MODAL_TRAVEL_OPTIONS.map(([v, l]) => `<option value="${v}" ${Number(ln.travel_days || 0) === v ? "selected" : ""}>${l}</option>`).join("")}
              </select></div>
            <div><span class="schm-l">Equipment</span>
              <select class="input text-xs py-1.5" data-m-f="equipment_type" data-i="${i}" ${dis}>
                ${MODAL_EQUIP_OPTIONS.map((v) => `<option value="${escapeHtml(v)}" ${(ln.equipment_type || "") === v ? "selected" : ""}>${v || "None"}</option>`).join("")}
              </select></div>
            <div><span class="schm-l">Wire guidance</span>
              <label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#111;padding-top:6px;">
                <input type="checkbox" class="h-4 w-4" data-m-f="wire_guidance" data-i="${i}" ${ln.wire_guidance ? "checked" : ""} ${dis}/> Yes
              </label></div>
            <div style="grid-column:1 / -1;"><span class="schm-l">Notes</span>
              <input type="text" class="input text-xs py-1.5" data-m-f="notes" data-i="${i}" value="${escapeHtml(ln.notes || "")}" placeholder="—" ${dis}/></div>
          </div>
          <div class="schm-row2">
            <div class="schm-box">
              ${crewBox}
            </div>
            <div class="schm-box">
              <div class="schm-boxhead">Project managers</div>
              <div class="schm-boxlist">${pmRows}</div>
            </div>
          </div>
        </div>`;
    }

    function renderModal() {
      const body = overlay.querySelector(".schm-body");
      body.innerHTML = `
        ${canEdit ? "" : `<div class="schm-ro">Read-only — your role can't edit assignments. Changes are made by the office on the Assignment page.</div>`}
        ${lines.map(lineHtml).join("")}
        ${canEdit ? `<button type="button" class="schm-addline" data-m-addline="1">+ Add assignment line</button>` : ""}
      `;
    }
    renderModal();

    function setLineMsg(i, text, ok) {
      const el = overlay.querySelector(`[data-m-msg="${i}"]`);
      if (el) { el.textContent = text || ""; el.style.color = ok ? "#047857" : "#b91c1c"; }
    }

    async function saveLine(i) {
      const ln = lines[i];
      if (!ln) return;
      const payload = {
        schedule_item_id: ln.id != null ? Number(ln.id) : null,
        qbo_customer_id: Number(qboCustomerId),
        status: ln.status || "not_started",
        start_date: ln.start_date || null,
        end_date: ln.end_date || null,
        wire_guidance: ln.wire_guidance ? 1 : 0,
        travel_days: Number(ln.travel_days) || 0,
        overage_days: Number(ln.overage_days) || 0,
        equipment_type: ln.equipment_type || null,
        notes: ln.notes || null,
        project_manager_ids: (ln.pms || []).map((x) => Number(x.project_manager_id)),
        primary_project_manager_id: (ln.pms || []).find((x) => x.is_primary)?.project_manager_id || null,
        // CR5 B1 de-fork: the exact same v2 + legacy dual-write crew block the
        // Assignment page and workspace tab ship (shared crewFieldsFor).
        ...crewFieldsFor(bundle, ln.crews || []),
      };
      setLineMsg(i, "Saving…", true);
      try {
        const res = await api("/assignment/save", { method: "POST", body: JSON.stringify(payload) });
        if (res?.schedule_item_id != null) invalidateHistory(res.schedule_item_id);
        close();
        await loadAndRender();   // re-fetch + redraw in place (scroll kept)
      } catch (e) {
        let friendly = e?.message || "Save failed";
        try { const p = JSON.parse(friendly); if (p && p.detail) friendly = String(p.detail); } catch { /* not JSON */ }
        setLineMsg(i, friendly, false);
      }
    }

    overlay.addEventListener("click", async (e) => {
      if (e.target.closest("[data-m-close]")) { close(); return; }

      const histBtn = e.target.closest("[data-hist-toggle]");
      if (histBtn) {
        const id = String(histBtn.getAttribute("data-hist-toggle"));
        if (histOpen.has(id)) histOpen.delete(id);
        else {
          histOpen.add(id);
          renderModal();
          if (!cachedHistory(id)) { try { await loadHistory(id); } catch { /* keeps loading note */ } }
        }
        renderModal();
        return;
      }

      const saveBtn = e.target.closest("[data-m-save]");
      if (saveBtn) { await saveLine(Number(saveBtn.getAttribute("data-m-save"))); return; }

      if (e.target.closest("[data-m-addline]")) {
        lines.push(blankLine());
        renderModal();
        return;
      }

      // Shared crew editor (+ Add crew / ✕ remove) — delegated to the module;
      // the owning line comes from the [data-m-line] wrapper.
      const lineEl = e.target.closest("[data-m-line]");
      if (canEdit && lineEl) {
        const i = Number(lineEl.getAttribute("data-m-line"));
        if (lines[i] && handleCrewEditorClick(e, lines[i].crews)) { renderModal(); return; }
      }
    });

    overlay.addEventListener("change", (e) => {
      const f = e.target.closest("[data-m-f]");
      if (f) {
        const ln = lines[Number(f.getAttribute("data-i"))];
        if (!ln) return;
        const field = f.getAttribute("data-m-f");
        if (field === "wire_guidance") ln.wire_guidance = f.checked ? 1 : 0;
        else if (field === "overage_days") ln.overage_days = Math.max(0, parseInt(f.value) || 0);
        else if (field === "travel_days") ln.travel_days = Number(f.value) || 0;
        else ln[field] = f.value;
        return;
      }
      const pmChk = e.target.closest("[data-m-pmchk]");
      if (pmChk) {
        const ln = lines[Number(pmChk.getAttribute("data-m-pmchk"))];
        const id = Number(pmChk.getAttribute("data-id"));
        if (!ln) return;
        if (pmChk.checked) {
          if (!ln.pms.some((x) => x.project_manager_id === id)) ln.pms.push({ project_manager_id: id, is_primary: false });
        } else {
          ln.pms = ln.pms.filter((x) => x.project_manager_id !== id);
        }
        renderModal();
        return;
      }
      const pmPrim = e.target.closest("[data-m-pmprim]");
      if (pmPrim && pmPrim.checked) {
        const ln = lines[Number(pmPrim.getAttribute("data-m-pmprim"))];
        const id = Number(pmPrim.getAttribute("data-id"));
        if (!ln) return;
        if (!ln.pms.some((x) => x.project_manager_id === id)) ln.pms.push({ project_manager_id: id, is_primary: false });
        ln.pms.forEach((x) => { x.is_primary = x.project_manager_id === id; });
        renderModal();
        return;
      }
      // Shared crew editor (company select / lead select / primary radio) —
      // slot auto-suggest excludes the other lines' slot codes.
      const lineEl = e.target.closest("[data-m-line]");
      if (lineEl) {
        const i = Number(lineEl.getAttribute("data-m-line"));
        if (lines[i]) {
          const r = handleCrewEditorChange(e, bundle, lines[i].crews, takenSlots(i));
          if (r.handled) { if (r.rerender) renderModal(); return; }
        }
      }
    });

    overlay.addEventListener("input", (e) => {
      const lineEl = e.target.closest("[data-m-line]");
      if (!lineEl) return;
      const i = Number(lineEl.getAttribute("data-m-line"));
      if (lines[i]) handleCrewEditorInput(e, lines[i].crews);
    });
  }

  // --- fetch + render
  async function loadAndRender() {
    // CR4: keep the grid's scroll position across re-renders (modal saves
    // trigger a re-fetch + redraw in place).
    const prevScrollEl = document.getElementById("schedTableScroll");
    const prevScroll = prevScrollEl
      ? { top: prevScrollEl.scrollTop, left: prevScrollEl.scrollLeft }
      : null;

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

    // --- Crew Model v2 (CR3): rows are PROJECT SLOTS under each COMPANY
    // (JR1, JR2… from the assignment rows' slot_code), in Teams page order.
    const parents = (crews || []).filter(c => !c.parent_id);
    const children = (crews || []).filter(c => c.parent_id);

    function crewSortKey(a, b) {
      const sa = Number(a.sort_order ?? 0);
      const sb = Number(b.sort_order ?? 0);
      if (sa !== sb) return sa - sb;
      return Number(a.id || 0) - Number(b.id || 0);
    }

    const parentsSorted = [...parents].sort(crewSortKey);
    const childCountByParent = new Map();
    const childByCode = new Map();       // legacy fallback: code -> child crew
    const parentById = new Map(parentsSorted.map(p => [String(p.id), p]));
    for (const ch of children) {
      const k = String(ch.parent_id);
      childCountByParent.set(k, (childCountByParent.get(k) || 0) + 1);
      if (ch.code) childByCode.set(ch.code, ch);
    }

    // map: "companyId|slot" -> { ymd -> [items...] }; slots seen this month.
    const map = new Map();
    const slotsSeen = new Map();         // companyId -> Set(slot)

    // CR5 B1: dated assignments with NO crew → one shared "⚠ Needs crew" row
    // per week (amber bars; same modal on click, where the crew editor lets
    // staff assign a company right there). Completed projects are excluded —
    // a finished project no longer needs a crew (canceled never arrives from
    // the API). ncProjects counts distinct projects for the header toggle.
    const ncMap = new Map();             // ymd -> [items...]
    const ncProjects = new Set();
    function pushNc(dateStr, item) {
      if (!ncMap.has(dateStr)) ncMap.set(dateStr, []);
      ncMap.get(dateStr).push(item);
      ncProjects.add(String(item.qbo_customer_id));
    }

    function pushItem(companyId, slot, dateStr, item) {
      if (companyId == null) return;
      const key = `${companyId}|${slot || "—"}`;
      if (!slotsSeen.has(String(companyId))) slotsSeen.set(String(companyId), new Set());
      slotsSeen.get(String(companyId)).add(slot || "—");
      if (!map.has(key)) map.set(key, new Map());
      const inner = map.get(key);
      if (!inner.has(dateStr)) inner.set(dateStr, []);
      inner.get(dateStr).push(item);
    }

    // Expand assignments across days they cover (within the month range)
    for (const a of assignments) {
      // one entry per assignment crew row: {slot, company_id, company, lead}
      let entries = Array.isArray(a.crew_slots) ? a.crew_slots.filter(e => e && e.company_id != null) : [];
      if (!entries.length && Array.isArray(a.work_crew_codes)) {
        // legacy fallback — derive from the old code list
        entries = a.work_crew_codes.filter(Boolean).map(code => {
          const ch = childByCode.get(code);
          return ch ? { slot: code, company_id: ch.parent_id, company: (parentById.get(String(ch.parent_id)) || {}).name, lead: ch.name } : null;
        }).filter(Boolean);
      }
      // CR5 B1: crewless assignment → a pseudo "needs crew" entry expanded
      // into ncMap by the same day loops below (travel/overage included).
      const needsCrew = entries.length === 0;
      if (needsCrew) {
        if ((a.project_status || "") === "completed") continue;
        entries = [{ __nc: true, slot: null, company_id: null, company: null, lead: null }];
      }

      const start = parseYmd(a.start_date);
      const end = parseYmd(a.end_date);
      const travelDays = a.travel_days || 0;
      const overageDays = a.overage_days || 0;

      const travelBefore = Math.ceil(travelDays / 2);
      const travelAfter = Math.floor(travelDays / 2);

      const pmsForItem = Array.isArray(a.pm_initials)
        ? a.pm_initials.map(x => String(x || "").trim().toUpperCase()).filter(Boolean)
        : [];

      const equipmentSuffix = a.equipment_type ? ` (${a.equipment_type})` : "";

      // Tooltip "Crews": the LEAD NAME when set, else "JR1 — lead not
      // assigned yet" (Jason decision b); "— needs crew" for crewless rows.
      const crewsDisplay = needsCrew
        ? ["— needs crew"]
        : entries.map(e =>
            e.lead ? e.lead : `${e.slot || e.company || "?"} — lead not assigned yet`);

      const baseItem = {
        needsCrew,
        schedule_item_id: a.schedule_item_id,
        project_id: a.project_id,
        qbo_customer_id: a.qbo_customer_id,
        project_name_raw: a.project_name || "",
        project: `${a.project_name || ""}${equipmentSuffix}`,
        status: a.project_status || "",
        start_date: a.start_date,
        end_date: a.end_date,
        crews: crewsDisplay,
        pms: pmsForItem,
        wire_guidance: a.wire_guidance,
        travel_days: Number(a.travel_days || 0),
        overage_days: Number(a.overage_days || 0),
        equipment_type: a.equipment_type || "",
        notes: a.notes || "",
      };

      for (const entry of entries) {
        const coId = entry.company_id;
        const slot = entry.slot || null;
        const leadTbd = !entry.lead && !entry.__nc;
        // Needs-crew entries land in the shared "⚠ Needs crew" row's map.
        const put = entry.__nc
          ? (dateStr, item) => pushNc(dateStr, item)
          : (dateStr, item) => pushItem(coId, slot, dateStr, item);

        // Travel days BEFORE start
        for (let i = travelBefore; i >= 1; i--) {
          const d = addDays(start, -i);
          if (d >= monthStart && d <= monthEnd) {
            put(ymd(d), { ...baseItem, project: "Travel", cellType: "travel", leadTbd });
          }
        }

        // Regular project days
        for (
          let d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
          d <= end;
          d.setDate(d.getDate() + 1)
        ) {
          if (d >= monthStart && d <= monthEnd) {
            put(ymd(d), { ...baseItem, cellType: "project", leadTbd });
          }
        }

        // Overage days (after end)
        for (let i = 1; i <= overageDays; i++) {
          const d = addDays(end, i);
          if (d >= monthStart && d <= monthEnd) {
            put(ymd(d), { ...baseItem, cellType: "overage", leadTbd });
          }
        }

        // Travel days AFTER overage
        for (let i = 1; i <= travelAfter; i++) {
          const d = addDays(end, overageDays + i);
          if (d >= monthStart && d <= monthEnd) {
            put(ymd(d), { ...baseItem, project: "Travel", cellType: "travel", leadTbd });
          }
        }
      }
    }

    // --- Build the visible rows: per company, its slots (JR1…). "Show All"
    // pads every company up to its crew_capacity (fallback: lead count);
    // condensed = only slots that have items this month.
    function slotOrd(prefix, slot) {
      if (!slot || !prefix || !slot.startsWith(prefix)) return 9999;
      const n = Number(slot.slice(prefix.length));
      return Number.isFinite(n) ? n : 9998;
    }
    const rowList = [];   // {key, label, companyName}
    for (const p of parentsSorted) {
      const prefix = p.code || "";
      // CR5 A1: effective capacity — explicit override when set (0 honored),
      // else auto = the live active-lead count.
      const cap = p.crew_capacity != null
        ? Number(p.crew_capacity)
        : (childCountByParent.get(String(p.id)) || 0);
      const seen = new Set(slotsSeen.get(String(p.id)) || []);
      if (state.crewView === "all" && prefix) {
        for (let i = 1; i <= cap; i++) seen.add(`${prefix}${i}`);
      }
      const slots = [...seen].sort((x, y) => slotOrd(prefix, x) - slotOrd(prefix, y) || String(x).localeCompare(String(y)));
      for (const s of slots) {
        const key = `${p.id}|${s}`;
        const hasItems = map.has(key) && [...map.get(key).values()].some(arr => arr.length);
        if (state.crewView !== "all" && !hasItems) continue;
        rowList.push({ key, label: s === "—" ? `${prefix || p.name}·?` : s, companyName: p.name });
      }
    }
    const visibleCrews = rowList;

    // Build the fixed day-of-week header row (Mon–Sun)
    const dayHeaderRow = `
      <tr>
        <th class="text-[11px] font-extrabold text-black px-2 py-1.5 bg-white sticky top-0 z-30 border-b border-r border-black/10 whitespace-nowrap shadow-sm" style="min-width:36px;">Crew</th>
        ${DAY_LABELS.map(d => `
          <th class="text-[11px] font-extrabold text-black px-2 py-1.5 bg-white sticky top-0 z-30 border-b border-r border-black/10 whitespace-nowrap text-center shadow-sm" style="min-width:90px;">${d}</th>
        `).join("")}
      </tr>
    `;

    function renderAssignmentCell(items, currentDate) {
      if (items.length === 0) return `<td class="px-1 py-0.5 border-b border-r border-black/10 align-top"></td>`;

      const html = items.map(it => {
        const isTravel  = it.cellType === "travel";
        const isOverage = it.cellType === "overage";

        // 👉 NEW: detect if this is the project's START DATE
        const isStartDate = it.start_date === ymd(currentDate);
        const isEndDate   = it.end_date === ymd(currentDate);

        // 👉 NEW: wire guidance flag
        const hasWire = !!it.wire_guidance;

        let wrapClass;

        if (isTravel) {
          wrapClass = "bg-gray-300 rounded px-1 py-0.5 text-gray-800 italic text-center font-semibold border border-gray-400";
        } else if (it.needsCrew) {
          // CR5 B1: amber "needs crew" bar (start day slightly darker).
          wrapClass = isStartDate ? "nc-bar nc-startday" : "nc-bar";
        } else if (isOverage) {
          wrapClass = "bg-orange-50 border border-orange-200 rounded px-0.5 py-px text-orange-700";
        } else if (isStartDate) {
          // Start-date wins over end-date so single-day projects render as start
          wrapClass = hasWire
            ? "bg-teal-400 text-white rounded px-0.5 py-px font-extrabold"
            : "bg-yellow-300 text-black rounded px-0.5 py-px font-extrabold";
        } else if (isEndDate) {
          wrapClass = "bg-green-500 text-white rounded px-0.5 py-px font-extrabold";
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

        // Lead-TBD marker (Jason decision b): small amber chip on the cell
        // when the assignment has no lead yet — legend note in the header.
        const tbdChip = (it.leadTbd && !isTravel)
          ? ` <span title="Lead not assigned yet" style="display:inline-block;background:#fef3c7;color:#92400e;border:1px solid #fcd34d;border-radius:3px;padding:0 2px;font-size:8px;font-weight:800;line-height:1.3;vertical-align:middle;">TBD</span>`
          : "";
        // CR5 B1: "Needs crew" chip once per bar (on its start day; when the
        // start is off-screen the amber row label still announces it).
        const ncChip = (it.needsCrew && !isTravel && isStartDate)
          ? ` <span class="nc-chip" title="No crew assigned — click to assign">Needs crew</span>`
          : "";

        const tip = encodeURIComponent(JSON.stringify({
          project: it.project,
          status: it.status,
          start_date: it.start_date,
          end_date: it.end_date,
          crews: it.crews || [],
          pms: it.pms || [],
          wire_guidance: !!it.wire_guidance,
          travel_days: Number(it.travel_days || 0),
          overage_days: Number(it.overage_days || 0),
          equipment_type: it.equipment_type || "",
          notes: it.notes || "",
        }));

        return `
          <div class="flex flex-col gap-px ${wrapClass} mb-px">
            ${pmBadges ? `<div class="flex flex-wrap gap-px">${pmBadges}</div>` : ""}
            <div class="text-[10px] leading-tight font-semibold ${isTravel ? "text-center" : "cursor-pointer hover:underline"} break-words"
              ${isTravel ? "" : `data-proj-tip="${tip}" data-proj-open="${escapeHtml(String(it.qbo_customer_id ?? ""))}" data-proj-pname="${escapeHtml(it.project_name_raw)}"`}>
              ${escapeHtml(it.project)}${tbdChip}${ncChip}
            </div>
          </div>
        `;
      }).join("");

      return `<td class="px-1 py-0.5 border-b border-r border-black/10 align-top">${html}</td>`;
    }

    // Build week blocks
    const weeksHtml = weeks.map(week => {
      // Week label row: show date numbers for each day
      const dateNumbers = week.map(d => {
        const isCurrentMonth = d.getMonth() === state.month;
        const isToday        = ymd(d) === ymd(new Date());
        const isPay          = isPayDay(d);
        const textCls = isToday
          ? "text-blue-600 font-extrabold"
          : isCurrentMonth
            ? "text-black font-semibold"
            : "text-black/40";
        // Inline background overrides bg-gray-100 when this is a pay day.
        const payBg = isPay ? "background:#86efac;" : "";
        return `
          <td class="sticky top-[30px] z-20 text-[11px] px-1 py-1 text-center bg-gray-100 ${textCls}"
            style="${payBg}box-shadow: inset -1px 0 0 rgba(0,0,0,0.2), inset 0 -1px 0 rgba(0,0,0,0.2);"
            ${isPay ? 'title="Pay day"' : ""}
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

      // CR5 B1: shared "⚠ Needs crew" row at the top of the week's crew rows —
      // only when the toggle is on and a crewless dated project touches it.
      let ncRow = "";
      if (state.needsCrew && week.some(d => (ncMap.get(ymd(d)) || []).length)) {
        const tds = week.map(d => renderAssignmentCell(ncMap.get(ymd(d)) || [], d)).join("");
        ncRow = `
          <tr>
            <td class="nc-label align-top" title="Projects with schedule dates but no crew assigned — click a project to assign one">⚠ Needs<br>crew</td>
            ${tds}
          </tr>`;
      }

      if (visibleCrews.length === 0) {
        return dateRow + ncRow + (ncRow ? "" : `
          <tr>
            <td class="text-[10px] text-black/40 px-1 py-2 border-b border-black/10" colspan="8">No assignments this week.</td>
          </tr>
        `);
      }

      const crewRows = visibleCrews.map(c => {
        const inner = map.get(c.key) || new Map();

        const tds = week.map(d => {
          const items = inner.get(ymd(d)) || [];
          return renderAssignmentCell(items, d);
        }).join("");

        return `
          <tr>
            <td class="text-[10px] px-1 py-0.5 font-extrabold border-b border-black/10 bg-white/60 whitespace-nowrap align-top" title="${escapeHtml(c.companyName || "")}">${escapeHtml(c.label)}</td>
            ${tds}
          </tr>
        `;
      }).join("");

      return dateRow + ncRow + crewRows;
    }).join("");

    const monthLabel = `${MONTH_NAMES[state.month]} ${state.year}`;

    const bodyHtml = `
      <div class="card flex flex-col overflow-hidden" style="height:calc(100vh - 180px); min-height:400px;">

        <!-- Fixed card header -->
        <div class="shrink-0 px-4 pt-4 pb-3 border-b border-black/10">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div class="text-base font-extrabold">Schedule</div>
              <div class="text-xs text-black/60">Month view (Mon–Sun) by company crew slot (JR1…) ·
                <span style="display:inline-block;background:#fef3c7;color:#92400e;border:1px solid #fcd34d;border-radius:3px;padding:0 2px;font-size:8px;font-weight:800;vertical-align:middle;">TBD</span>
                = lead not assigned yet · click a project to view/edit its assignment</div>
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

              <button
                id="toggleNeedsCrew"
                class="rounded-xl border px-3 py-1.5 text-xs font-semibold"
                style="${state.needsCrew
                  ? "background:#fef3c7;color:#92400e;border-color:#fcd34d;"
                  : "background:#fff;color:rgba(0,0,0,0.55);border-color:rgba(0,0,0,0.15);"}"
                title="Show projects that have schedule dates but no crew assigned"
              >
                ${state.needsCrew ? "⚠ Needs-crew: on" : "Needs-crew: off"}${ncProjects.size ? ` (${ncProjects.size})` : ""}
              </button>
              <button
                id="toggleCrewView"
                class="bg-blue-300 text-gray-500 rounded-xl border border-black/15 px-3 py-1.5 text-xs font-semibold hover:bg-blue-400"
              >
                ${state.crewView === "all" ? "Show Condensed" : "Show All"}
              </button>
              <button id="prevMonth" class="rounded-xl border border-black/15 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">← Prev</button>
              <button id="todayBtn" class="rounded-xl border border-black/15 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">Today</button>
              <button id="nextMonth" class="rounded-xl border border-black/15 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">Next →</button>
            </div>
          </div>
        </div>

        <!-- Scrollable table area -->
        <div id="schedTableScroll" class="flex-1 overflow-auto">
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
      subtitle: "Crew schedule across all projects — week by week.",
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

        function formatTooltipDate(iso) {
          if (!iso) return "—";
          const [y, m, d] = String(iso).slice(0, 10).split("-");
          if (!y || !m || !d) return "—";
          return `${m}/${d}/${String(y).slice(-2)}`;
        }        

        const dates = `${formatTooltipDate(data.start_date)} → ${formatTooltipDate(data.end_date)}`;
        const wire = data.wire_guidance ? "Yes" : "No";
        const travel = Number(data.travel_days || 0) ? `${Number(data.travel_days)} day${Number(data.travel_days) === 1 ? "" : "s"}` : "None";
        const overage = Number(data.overage_days || 0) ? `${Number(data.overage_days)} day${Number(data.overage_days) === 1 ? "" : "s"}` : "None";
        const equip = data.equipment_type || "None";
        const notes = data.notes || "None";

        const statusLabel = (s) =>
          s === "not_started"     ? "Not Started"     :
          s === "in_progress"     ? "In Progress"     :
          s === "completed"       ? "Completed"       :
          s === "canceled"        ? "Canceled"        :
          s === "needs_attention" ? "Needs Attention" : (s || "—");

        const html = `
          ${data.project ? `<div class="font-extrabold mb-1">${escapeHtml(data.project)}</div>` : ""}
          <div class="text-black/70"><span class="font-semibold">Status:</span> ${escapeHtml(statusLabel(data.status))}</div>
          <div class="text-black/70"><span class="font-semibold">PMs:</span> ${escapeHtml(pms)}</div>
          <div class="text-black/70"><span class="font-semibold">Crews:</span> ${escapeHtml(crews)}</div>
          <div class="text-black/70"><span class="font-semibold">Dates:</span> ${escapeHtml(dates)}</div>
          <div class="text-black/70"><span class="font-semibold">Wire:</span> ${escapeHtml(wire)}</div>
          <div class="text-black/70"><span class="font-semibold">Travel:</span> ${escapeHtml(travel)}</div>
          <div class="text-black/70"><span class="font-semibold">Overage:</span> ${escapeHtml(overage)}</div>
          <div class="text-black/70"><span class="font-semibold">Equip:</span> ${escapeHtml(equip)}</div>
          <div class="text-black/70 mt-1"><span class="font-semibold">Notes:</span> ${escapeHtml(notes)}</div>
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

    // CR4: click a project → assignment modal (delegated; restore scroll too).
    const scrollHost = document.getElementById("schedTableScroll");
    if (scrollHost && prevScroll) {
      scrollHost.scrollTop = prevScroll.top;
      scrollHost.scrollLeft = prevScroll.left;
    }
    scrollHost?.addEventListener("click", (e) => {
      const el = e.target.closest("[data-proj-open]");
      if (!el) return;
      const qid = el.getAttribute("data-proj-open");
      if (!qid) return;
      hideTip();
      openAssignModal(qid, el.getAttribute("data-proj-pname") || "");
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

    const toggleCrewViewBtn = document.getElementById("toggleCrewView");
    if (toggleCrewViewBtn) {
      toggleCrewViewBtn.onclick = () => {
        state.crewView = state.crewView === "all" ? "condensed" : "all";
        loadAndRender();
      };
    }

    // CR5 B1: needs-crew filter toggle (session-persisted, default ON).
    const toggleNcBtn = document.getElementById("toggleNeedsCrew");
    if (toggleNcBtn) {
      toggleNcBtn.onclick = () => {
        state.needsCrew = !state.needsCrew;
        try { sessionStorage.setItem("opi_sched_needscrew", state.needsCrew ? "1" : "0"); } catch (_) { /* non-fatal */ }
        loadAndRender();
      };
    }
  }

  await loadAndRender();
}