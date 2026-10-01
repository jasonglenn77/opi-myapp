// Per-project assignment editor — the full PM + crew + schedule editing from the
// standalone Assignment page, scoped to one project so it lives inside the
// project detail workspace (Projects hub Phase 2). Loads /assignment/bundle and
// saves each schedule item via /assignment/save. CR5 A2: this tab is the
// CANONICAL assignment editor going forward (the standalone page eventually
// retires) — the crew picker is the shared CR3 company-first editor
// (utils/crew-editor.js, same module as assignment.js) and saves ship the v2
// crew_assignments payload. CR5 A4: two-deck line layout (no horizontal
// scrollbar; the status select shows its full label).
// Fields: Status · Start · End · PM (multi + primary) · Crew (company → lead →
// slot, multi + primary) · Wire · Travel · Overage · Equipment · Notes;
// multiple schedule items per project (add / delete). Changes save
// automatically, exactly as before.
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";
import {
  historyBadgeHtml, historyPanelHtml, loadHistory, invalidateHistory, cachedHistory,
  historyCountOf, historyBadgeLabel,
} from "../utils/assignment-history.js";
import {
  entryLabel, toDraftEntry, crewFieldsFor, crewEditorBodyHtml,
  handleCrewEditorClick, handleCrewEditorChange, handleCrewEditorInput,
} from "../utils/crew-editor.js";
import { mountConsistencyChip } from "../utils/crew-consistency.js";

// CR4: schedule-item ids whose history sub-lines are expanded — module-level
// so the open state survives the panel's frequent remounts after saves.
const _openHist = new Set();

const STATUS_OPTIONS = [
  { value: "needs_attention", label: "Needs attention" },
  { value: "pending",         label: "Pending" },
  { value: "not_started",     label: "Not started" },
  { value: "in_progress",     label: "In progress" },
  { value: "completed",       label: "Completed" },
  { value: "canceled",        label: "Canceled" },
];
const TRAVEL_OPTIONS = [[0, "None"], [2, "2 days"], [3, "3 days"], [4, "4 days"]];
const EQUIP_OPTIONS = ["", "Equip", "No Equip", "Electric"];

const pmName = (pm) => (`${pm.first_name || ""} ${pm.last_name || ""}`.trim() || pm.email || `PM ${pm.id}`);

export async function mountAssignmentPanel(container, qboCustomerId, onChange) {
  container.innerHTML = `<div class="p-4 text-sm text-black/40">Loading assignment…</div>`;
  let bundle;
  try {
    bundle = await api(`/assignment/bundle?qbo_customer_id=${encodeURIComponent(qboCustomerId)}`);
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-sm text-red-600">Failed to load assignment: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }
  const pms = bundle.project_managers || [];
  const items = (bundle.schedule_items || []).map((it) => ({ ...it }));   // local, mutable
  // Shared crew-editor context (companies + flat crews incl. parents).
  const ctx = bundle;

  const remount = () => mountAssignmentPanel(container, qboCustomerId, onChange);
  const opt = (v, label, sel) => `<option value="${escapeHtml(String(v))}" ${String(sel) === String(v) ? "selected" : ""}>${escapeHtml(label)}</option>`;
  const statusOptions = (sel) => STATUS_OPTIONS.map((s) => opt(s.value, s.label, sel)).join("");
  const travelOptions = (sel) => TRAVEL_OPTIONS.map(([v, l]) => opt(v, l, sel || 0)).join("");
  const equipOptions = (sel) => EQUIP_OPTIONS.map((v) => opt(v, v || "None", sel || "")).join("");

  // PM summary shown in the cell (primary name + "+N", or "— assign").
  const pmSummary = (active) => {
    active = active || [];
    if (!active.length) return `<span class="text-black/35">— assign</span>`;
    const nameOf = (id) => { const x = pms.find((a) => String(a.id) === String(id)); return x ? pmName(x) : `#${id}`; };
    const primary = active.find((a) => a.is_primary) || active[0];
    const extra = active.length - 1;
    return `<span class="font-semibold">${escapeHtml(nameOf(primary.project_manager_id))}</span>${extra > 0 ? `<span class="text-black/40 text-[11px]"> +${extra}</span>` : ""}`;
  };

  // Crew summary: every entry as "MTY · Gustavo Ramirez (JR1)", primary first.
  const crewSummary = (active) => {
    const entries = (active || []).map((x) => toDraftEntry(ctx, x));
    if (!entries.length) return `<span class="text-black/35">— assign</span>`;
    entries.sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
    return entries.map((e, i) => {
      const slot = e.slot_code ? ` <span class="text-black/40">(${escapeHtml(e.slot_code)})</span>` : "";
      return `<span class="${i === 0 ? "font-semibold" : ""}">${escapeHtml(entryLabel(ctx, e))}${slot}</span>`;
    }).join(`<span class="text-black/30">, </span>`);
  };

  // Slot codes occupied by the OTHER schedule items (the edited item's entries
  // are being replaced by the draft).
  const takenSlotCodes = (sid) => {
    const taken = new Set();
    for (const it of items) {
      if (String(it.id) === String(sid)) continue;
      for (const e of (it.active_work_crews || [])) {
        if (e.slot_code) taken.add(String(e.slot_code).toUpperCase());
      }
    }
    return taken;
  };

  const field = (label, inner, cls = "") => `
    <div class="ap-f ${cls}"><span class="ap-l">${label}</span>${inner}</div>`;

  const lineHtml = (it, i) => {
    const cachedH = cachedHistory(it.id);
    const histCount = cachedH ? historyCountOf(cachedH) : it.history_count;
    return `
    <div class="ap-line" data-sid="${it.id}">
      <div class="ap-deck">
        <span class="ap-idx">#${i + 1}${it.is_extra_row ? `<span class="text-[10px] text-black/30"> (extra)</span>` : ""}</span>
        ${field("Status", `<select data-f="status" class="input text-xs py-1.5 ap-status">${statusOptions(it.status || "needs_attention")}</select>`)}
        ${field("Start", `<input data-f="start_date" type="date" value="${escapeHtml(it.start_date ? String(it.start_date).slice(0, 10) : "")}" class="input text-xs py-1.5"/>`)}
        ${field("End", `<input data-f="end_date" type="date" value="${escapeHtml(it.end_date ? String(it.end_date).slice(0, 10) : "")}" class="input text-xs py-1.5"/>`)}
        ${field("Project manager", `<button data-assign="pm" class="text-left text-xs rounded px-1.5 py-1.5 border border-black/10 hover:bg-black/5 min-w-[9rem]">${pmSummary(it.active_project_managers)}</button>`, "ap-grow")}
        ${field("Crew (company · lead · slot)", `<button data-crew-edit="${it.id}" class="text-left text-xs rounded px-1.5 py-1.5 border border-black/10 hover:bg-black/5 whitespace-normal" style="min-width:11rem;">${crewSummary(it.active_work_crews)}</button>`, "ap-grow2")}
      </div>
      <div class="ap-deck">
        ${field("Wire", `<label class="inline-flex items-center" style="height:30px;"><input data-f="wire_guidance" type="checkbox" class="h-4 w-4 cursor-pointer" ${it.wire_guidance ? "checked" : ""}/></label>`)}
        ${field("Travel", `<select data-f="travel_days" class="input text-xs py-1.5 w-20">${travelOptions(it.travel_days)}</select>`)}
        ${field("Overage", `<input data-f="overage_days" type="number" min="0" step="1" value="${it.overage_days || 0}" class="input text-xs py-1.5 w-16"/>`)}
        ${field("Equipment", `<select data-f="equipment_type" class="input text-xs py-1.5 w-28">${equipOptions(it.equipment_type)}</select>`)}
        ${field("Notes", `<input data-f="notes" type="text" value="${escapeHtml(it.notes || "")}" placeholder="—" title="${escapeHtml(it.notes || "")}" class="input text-xs py-1.5 w-full"/>`, "ap-notes")}
        <div class="ap-f ap-actions">
          <span class="ap-l">&nbsp;</span>
          <div class="flex items-center gap-2" style="height:30px;">
            <span data-savestate class="text-[11px] text-black/30"></span>
            ${historyBadgeHtml(it.id, histCount, _openHist.has(String(it.id)))}
            <button data-del class="text-black/30 hover:text-red-600 text-sm" title="Delete this schedule item">✕</button>
          </div>
        </div>
      </div>
      ${_openHist.has(String(it.id)) ? `<div data-hist-row="${it.id}" class="pt-1">${historyPanelHtml(it.id)}</div>` : ""}
    </div>`;
  };

  const bodyLines = items.length
    ? items.map(lineHtml).join("")
    : `<div class="py-4 text-center text-sm text-black/40">No schedule items yet — add one below.</div>`;

  container.innerHTML = `
    <div class="p-4 sm:p-5 text-ink-900">
      <div class="flex items-start gap-3 flex-wrap mb-3">
        <div class="text-xs text-black/50 flex-1" style="min-width:220px;">Assign the PM(s), crew(s), dates, and schedule detail for each schedule item. A project can have more than one schedule item (extra crews / phases). Changes save automatically.</div>
        <span data-ccx-slot></span>
      </div>
      <div data-rows>${bodyLines}</div>
      <div class="pt-3">
        <button data-add class="text-xs font-semibold text-emerald-700 hover:underline">+ Add schedule item</button>
      </div>
    </div>`;

  const rowsHost = container.querySelector("[data-rows]");
  const itemById = (sid) => items.find((x) => String(x.id) === String(sid));

  // CR5 B3: crew-consistency chip in the header area. The panel remounts after
  // every save, so the chip re-fetches and tracks crew changes automatically.
  mountConsistencyChip(container, bundle.qbo && bundle.qbo.qbo_id);

  // CR4: refresh one line's history panel + badge from the cache.
  function refreshHistRow(sid) {
    sid = String(sid);
    const panel = rowsHost?.querySelector(`[data-hist-row="${sid}"]`);
    if (panel) panel.innerHTML = historyPanelHtml(sid);
    const badge = container.querySelector(`[data-hist-toggle="${sid}"] span`);
    const rowsH = cachedHistory(sid);
    if (badge && rowsH) badge.textContent = historyBadgeLabel(historyCountOf(rowsH));
  }
  // Panels left open across a remount: fetch any that aren't cached yet.
  for (const sid of _openHist) {
    if (!cachedHistory(sid) && items.some((x) => String(x.id) === sid)) {
      loadHistory(sid).then(() => refreshHistRow(sid)).catch(() => {});
    }
  }

  function payloadFor(line, it) {
    const g = (f) => line.querySelector(`[data-f="${f}"]`);
    const pmIds = (it.active_project_managers || []).map((a) => Number(a.project_manager_id));
    return {
      schedule_item_id: it.id || null,
      qbo_customer_id: Number(qboCustomerId),
      status: g("status").value,
      start_date: g("start_date").value || null,
      end_date: g("end_date").value || null,
      wire_guidance: g("wire_guidance").checked ? 1 : 0,
      travel_days: Number(g("travel_days").value) || 0,
      overage_days: Number(g("overage_days").value) || 0,
      equipment_type: g("equipment_type").value || null,
      notes: g("notes").value || null,
      project_manager_ids: pmIds,
      primary_project_manager_id: (it.active_project_managers || []).find((a) => a.is_primary)?.project_manager_id || (pmIds[0] || null),
      // CR5 A2: v2 crew_assignments + the legacy dual-write fields, from the
      // same shared builder as the Assignment page.
      ...crewFieldsFor(ctx, it.active_work_crews || []),
    };
  }

  async function saveRow(line, sid) {
    const it = itemById(sid);
    if (!it) return;
    const state = line.querySelector("[data-savestate]");
    if (state) { state.textContent = "Saving…"; state.className = "text-[11px] text-black/40"; }
    try {
      await api("/assignment/save", { method: "POST", body: JSON.stringify(payloadFor(line, it)) });
      if (state) { state.textContent = "Saved ✓"; state.className = "text-[11px] text-emerald-600"; setTimeout(() => { if (state.textContent === "Saved ✓") state.textContent = ""; }, 1500); }
      // CR4: the save may have recorded a history row — refresh badge/panel.
      invalidateHistory(sid);
      loadHistory(String(sid)).then(() => refreshHistRow(sid)).catch(() => {});
      if (onChange) onChange();
    } catch (e) {
      if (state) { state.textContent = "Failed"; state.className = "text-[11px] text-red-600"; }
      alert("Save failed: " + (e?.message || e));
    }
  }

  // ── popups (PM multi-select + shared crew editor) ──────────────────────────
  let openPopup = null;
  const closePopup = () => { if (openPopup) { openPopup.remove(); openPopup = null; document.removeEventListener("mousedown", onDocDown, true); } };
  function onDocDown(e) { if (openPopup && !openPopup.contains(e.target) && !e.target.closest("[data-assign],[data-crew-edit]")) closePopup(); }

  function placePopup(pop, anchor) {
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 16)) + "px";
    pop.style.top = Math.min(r.bottom + 4, Math.max(8, window.innerHeight - pop.offsetHeight - 16)) + "px";
    openPopup = pop;
    setTimeout(() => document.addEventListener("mousedown", onDocDown, true), 0);
  }

  // PM multi-select (unchanged behavior: checkbox list + primary radio).
  function openPmEditor(line, sid, anchor) {
    closePopup();
    const it = itemById(sid); if (!it) return;
    const active = it.active_project_managers || [];
    const checkedSet = new Set(active.map((a) => String(a.project_manager_id)));
    const primaryId = active.find((a) => a.is_primary)?.project_manager_id || (active[0] ? active[0].project_manager_id : null);
    const rowsHtml = pms.map((x) => `
      <label class="flex items-center justify-between gap-2 py-1">
        <span class="flex items-center gap-2 min-w-0">
          <input type="checkbox" class="h-4 w-4" data-chk data-id="${x.id}" ${checkedSet.has(String(x.id)) ? "checked" : ""}/>
          <span class="truncate">${escapeHtml(pmName(x))}</span>
        </span>
        <span class="flex items-center gap-1 text-[11px] text-black/50 shrink-0"><span>Primary</span>
          <input type="radio" name="prim" class="h-4 w-4" data-prim data-id="${x.id}" ${String(primaryId || "") === String(x.id) ? "checked" : ""}/></span>
      </label>`).join("") || `<div class="text-sm text-black/50">None found.</div>`;
    const pop = document.createElement("div");
    pop.className = "fixed z-[200] w-[340px] max-w-[92vw] rounded-xl border border-black/10 bg-white text-ink-900 p-3 shadow-xl text-sm";
    pop.innerHTML = `
      <div class="text-xs font-bold text-black/50 mb-2">Project Managers</div>
      <div class="max-h-[240px] overflow-auto pr-1">${rowsHtml}</div>
      <div class="mt-3 flex justify-end gap-2">
        <button type="button" data-cancel class="rounded-lg border border-black/10 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">Cancel</button>
        <button type="button" data-apply class="btn-primary text-xs px-3 py-1.5">Apply</button>
      </div>`;
    placePopup(pop, anchor);
    // Mirror the standalone page: picking a "primary" auto-includes that row;
    // unchecking a row that's primary clears the primary (no orphan primary).
    pop.addEventListener("change", (e) => {
      const rad = e.target.closest("[data-prim]");
      if (rad && rad.checked) {
        const cb = pop.querySelector(`[data-chk][data-id="${rad.getAttribute("data-id")}"]`);
        if (cb && !cb.checked) cb.checked = true;
        return;
      }
      const chk = e.target.closest("[data-chk]");
      if (chk && !chk.checked) {
        const r = pop.querySelector(`[data-prim][data-id="${chk.getAttribute("data-id")}"]`);
        if (r && r.checked) r.checked = false;
      }
    });
    pop.querySelector("[data-cancel]").addEventListener("click", closePopup);
    pop.querySelector("[data-apply]").addEventListener("click", async () => {
      const ids = [...pop.querySelectorAll("[data-chk]:checked")].map((c) => Number(c.getAttribute("data-id")));
      let prim = pop.querySelector("[data-prim]:checked")?.getAttribute("data-id");
      prim = prim ? Number(prim) : (ids[0] || null);
      if (prim && !ids.includes(prim)) ids.push(prim);
      it.active_project_managers = ids.map((id) => ({ project_manager_id: id, is_primary: id === prim ? 1 : 0 }));
      closePopup();
      await saveRow(line, sid);
      remount();
    });
  }

  // CR5 A2: the shared CR3 company→lead→slot crew editor (utils/crew-editor.js)
  // replaces the legacy crew multi-select (whose "+ Add crew" was broken).
  function openCrewEditor(line, sid, anchor) {
    closePopup();
    const it = itemById(sid); if (!it) return;
    const draft = (it.active_work_crews || []).map((x) => toDraftEntry(ctx, x));
    const pop = document.createElement("div");
    pop.className = "fixed z-[200] rounded-xl border border-black/10 bg-white text-ink-900 p-3 shadow-xl text-sm";
    pop.style.width = "380px";
    pop.style.maxWidth = "min(92vw,440px)";
    const radioName = `apcrew-primary-${sid}`;
    const renderBody = () => {
      pop.innerHTML = `
        ${crewEditorBodyHtml(ctx, draft, radioName)}
        <div class="mt-3 flex justify-end gap-2">
          <button type="button" data-cancel class="rounded-lg border border-black/10 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">Cancel</button>
          <button type="button" data-apply class="btn-primary text-xs px-3 py-1.5">Apply</button>
        </div>`;
    };
    renderBody();
    placePopup(pop, anchor);
    pop.addEventListener("click", async (e) => {
      if (e.target.closest("[data-cancel]")) { closePopup(); return; }
      if (e.target.closest("[data-apply]")) {
        it.active_work_crews = draft
          .map((x) => toDraftEntry(ctx, x))
          .filter((e2) => e2.company_id != null)
          .map((e2) => ({
            work_crew_id: e2.work_crew_id, company_id: e2.company_id,
            lead_crew_id: e2.lead_crew_id, slot_code: (e2.slot_code || "").trim().toUpperCase() || null,
            is_primary: e2.is_primary ? 1 : 0,
          }));
        closePopup();
        await saveRow(line, sid);
        remount();
        return;
      }
      if (handleCrewEditorClick(e, draft)) renderBody();
    });
    pop.addEventListener("change", (e) => {
      const r = handleCrewEditorChange(e, ctx, draft, takenSlotCodes(sid));
      if (r.rerender) renderBody();
    });
    pop.addEventListener("input", (e) => handleCrewEditorInput(e, draft));
  }

  rowsHost?.addEventListener("change", (e) => {
    if (!e.target.closest("[data-f]")) return;
    const line = e.target.closest("[data-sid]");
    const sid = line?.getAttribute("data-sid");
    if (sid && sid !== "null") saveRow(line, Number(sid));
  });
  rowsHost?.addEventListener("click", async (e) => {
    // CR4: history badge — toggle the sub-lines block under this line.
    const histBtn = e.target.closest("[data-hist-toggle]");
    if (histBtn) {
      const sid = String(histBtn.getAttribute("data-hist-toggle"));
      const line = histBtn.closest("[data-sid]");
      const existing = rowsHost.querySelector(`[data-hist-row="${sid}"]`);
      if (existing) {
        existing.remove();
        _openHist.delete(sid);
        histBtn.classList.remove("ah-open");
        histBtn.setAttribute("aria-expanded", "false");
        return;
      }
      _openHist.add(sid);
      histBtn.classList.add("ah-open");
      histBtn.setAttribute("aria-expanded", "true");
      const panel = document.createElement("div");
      panel.setAttribute("data-hist-row", sid);
      panel.className = "pt-1";
      panel.innerHTML = historyPanelHtml(sid);
      line.appendChild(panel);
      if (!cachedHistory(sid)) {
        try { await loadHistory(sid); } catch { /* panel keeps the loading note */ }
        refreshHistRow(sid);
      }
      return;
    }

    const assign = e.target.closest("[data-assign]");
    if (assign) {
      const line = assign.closest("[data-sid]");
      const sid = line?.getAttribute("data-sid");
      if (sid && sid !== "null") openPmEditor(line, Number(sid), assign);
      return;
    }
    const crewBtn = e.target.closest("[data-crew-edit]");
    if (crewBtn) {
      const line = crewBtn.closest("[data-sid]");
      const sid = line?.getAttribute("data-sid");
      if (sid && sid !== "null") openCrewEditor(line, Number(sid), crewBtn);
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      const line = del.closest("[data-sid]");
      const sid = line?.getAttribute("data-sid");
      if (!sid || sid === "null") return;
      if (!confirm("Delete this schedule item? This removes its assignment and cannot be undone.")) return;
      try { await api(`/assignment/schedule-item/${sid}`, { method: "DELETE" }); if (onChange) onChange(); remount(); }
      catch (err) { alert("Delete failed: " + (err?.message || err)); }
    }
  });

  container.querySelector("[data-add]")?.addEventListener("click", async () => {
    try {
      await api("/assignment/save", { method: "POST", body: JSON.stringify({ qbo_customer_id: Number(qboCustomerId), status: "not_started", project_manager_ids: [], work_crew_ids: [] }) });
      if (onChange) onChange();
      remount();
    } catch (e) { alert("Could not add schedule item: " + (e?.message || e)); }
  });
}
