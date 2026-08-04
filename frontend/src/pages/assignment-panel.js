// Per-project assignment editor — the full PM + crew + schedule editing from the
// standalone Assignment page, scoped to one project so it lives inside the
// project detail workspace (Projects hub Phase 2). Loads /assignment/bundle and
// saves each schedule item via /assignment/save. Feature parity with the
// standalone page: Status · Start · End · PM (multi + primary) · Crew (multi +
// primary) · Wire · Travel · Overage · Equipment · Notes; multiple schedule
// items per project (add / delete).
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";

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
const crewName = (c) => `${c.name || ("Crew " + c.id)}${c.code ? ` (${c.code})` : ""}`;

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
  const crews = bundle.work_crews || [];
  const items = (bundle.schedule_items || []).map((it) => ({ ...it }));   // local, mutable

  const remount = () => mountAssignmentPanel(container, qboCustomerId, onChange);
  const opt = (v, label, sel) => `<option value="${escapeHtml(String(v))}" ${String(sel) === String(v) ? "selected" : ""}>${escapeHtml(label)}</option>`;
  const statusOptions = (sel) => STATUS_OPTIONS.map((s) => opt(s.value, s.label, sel)).join("");
  const travelOptions = (sel) => TRAVEL_OPTIONS.map(([v, l]) => opt(v, l, sel || 0)).join("");
  const equipOptions = (sel) => EQUIP_OPTIONS.map((v) => opt(v, v || "None", sel || "")).join("");

  // PM/crew summary shown in the cell (primary name + "+N", or "— assign").
  const assignSummary = (active, all, isPm) => {
    active = active || [];
    if (!active.length) return `<span class="text-black/35">— assign</span>`;
    const idKey = isPm ? "project_manager_id" : "work_crew_id";
    const nameOf = (id) => { const x = all.find((a) => String(a.id) === String(id)); return x ? (isPm ? pmName(x) : crewName(x)) : `#${id}`; };
    const primary = active.find((a) => a.is_primary) || active[0];
    const extra = active.length - 1;
    return `<span class="font-semibold">${escapeHtml(nameOf(primary[idKey]))}</span>${extra > 0 ? `<span class="text-black/40 text-[11px]"> +${extra}</span>` : ""}`;
  };

  const rowHtml = (it, i) => `
    <tr class="border-b border-black/5 align-top" data-sid="${it.id}">
      <td class="py-2 pr-2 text-black/50 tabular-nums">${i + 1}${it.is_extra_row ? '<span class="text-[10px] text-black/30"> (extra)</span>' : ""}</td>
      <td class="py-2 pr-2"><select data-f="status" class="input text-xs py-1.5">${statusOptions(it.status || "needs_attention")}</select></td>
      <td class="py-2 pr-2"><input data-f="start_date" type="date" value="${escapeHtml(it.start_date ? String(it.start_date).slice(0,10) : "")}" class="input text-xs py-1.5"/></td>
      <td class="py-2 pr-2"><input data-f="end_date" type="date" value="${escapeHtml(it.end_date ? String(it.end_date).slice(0,10) : "")}" class="input text-xs py-1.5"/></td>
      <td class="py-2 pr-2"><button data-assign="pm" class="text-left text-xs w-full min-w-[9rem] rounded px-1.5 py-1.5 border border-black/10 hover:bg-black/[0.03]">${assignSummary(it.active_project_managers, pms, true)}</button></td>
      <td class="py-2 pr-2"><button data-assign="crew" class="text-left text-xs w-full min-w-[9rem] rounded px-1.5 py-1.5 border border-black/10 hover:bg-black/[0.03]">${assignSummary(it.active_work_crews, crews, false)}</button></td>
      <td class="py-2 pr-2 text-center"><input data-f="wire_guidance" type="checkbox" class="h-4 w-4 cursor-pointer" ${it.wire_guidance ? "checked" : ""}/></td>
      <td class="py-2 pr-2"><select data-f="travel_days" class="input text-xs py-1.5 w-20">${travelOptions(it.travel_days)}</select></td>
      <td class="py-2 pr-2"><input data-f="overage_days" type="number" min="0" step="1" value="${it.overage_days || 0}" class="input text-xs py-1.5 w-16"/></td>
      <td class="py-2 pr-2"><select data-f="equipment_type" class="input text-xs py-1.5 w-28">${equipOptions(it.equipment_type)}</select></td>
      <td class="py-2 pr-2"><input data-f="notes" type="text" value="${escapeHtml(it.notes || "")}" placeholder="—" class="input text-xs py-1.5 w-44"/></td>
      <td class="py-2 text-right whitespace-nowrap">
        <span data-savestate class="text-[11px] text-black/30 mr-2"></span>
        <button data-del class="text-black/30 hover:text-red-600 text-sm" title="Delete this schedule item">✕</button>
      </td>
    </tr>`;

  const bodyRows = items.length
    ? items.map(rowHtml).join("")
    : `<tr><td colspan="12" class="py-4 text-center text-sm text-black/40">No schedule items yet — add one below.</td></tr>`;

  container.innerHTML = `
    <div class="p-4 sm:p-5">
      <div class="text-xs text-black/50 mb-3">Assign the PM(s), crew(s), dates, and schedule detail for each schedule item. A project can have more than one schedule item (extra crews / phases). Changes save automatically.</div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm" style="min-width:1180px;">
          <thead><tr class="text-left text-black/45 border-b border-black/10 text-[11px] uppercase tracking-wide">
            <th class="py-2 pr-2 w-8">#</th>
            <th class="py-2 pr-2 w-36">Status</th>
            <th class="py-2 pr-2 w-32">Start</th>
            <th class="py-2 pr-2 w-32">End</th>
            <th class="py-2 pr-2">PM</th>
            <th class="py-2 pr-2">Crew</th>
            <th class="py-2 pr-2 w-12 text-center" title="Wire guidance">Wire</th>
            <th class="py-2 pr-2 w-20">Travel</th>
            <th class="py-2 pr-2 w-16">Overage</th>
            <th class="py-2 pr-2 w-28">Equipment</th>
            <th class="py-2 pr-2">Notes</th>
            <th class="py-2 w-20"></th>
          </tr></thead>
          <tbody data-rows>${bodyRows}</tbody>
        </table>
      </div>
      <div class="pt-3">
        <button data-add class="text-xs font-semibold text-emerald-700 hover:underline">+ Add schedule item</button>
      </div>
    </div>`;

  const rowsHost = container.querySelector("[data-rows]");
  const itemById = (sid) => items.find((x) => String(x.id) === String(sid));

  function payloadFor(tr, it) {
    const g = (f) => tr.querySelector(`[data-f="${f}"]`);
    const pmIds = (it.active_project_managers || []).map((a) => Number(a.project_manager_id));
    const crewIds = (it.active_work_crews || []).map((a) => Number(a.work_crew_id));
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
      work_crew_ids: crewIds,
      primary_work_crew_id: (it.active_work_crews || []).find((a) => a.is_primary)?.work_crew_id || (crewIds[0] || null),
    };
  }

  async function saveRow(tr, sid) {
    const it = itemById(sid);
    if (!it) return;
    const state = tr.querySelector("[data-savestate]");
    if (state) { state.textContent = "Saving…"; state.className = "text-[11px] text-black/40 mr-2"; }
    try {
      await api("/assignment/save", { method: "POST", body: JSON.stringify(payloadFor(tr, it)) });
      if (state) { state.textContent = "Saved ✓"; state.className = "text-[11px] text-emerald-600 mr-2"; setTimeout(() => { if (state.textContent === "Saved ✓") state.textContent = ""; }, 1500); }
      if (onChange) onChange();
    } catch (e) {
      if (state) { state.textContent = "Failed"; state.className = "text-[11px] text-red-600 mr-2"; }
      alert("Save failed: " + (e?.message || e));
    }
  }

  // ── Multi-select PM/crew popup ──────────────────────────────────────────────
  let openPopup = null;
  const closePopup = () => { if (openPopup) { openPopup.remove(); openPopup = null; document.removeEventListener("mousedown", onDocDown, true); } };
  function onDocDown(e) { if (openPopup && !openPopup.contains(e.target) && !e.target.closest("[data-assign]")) closePopup(); }

  function openAssignEditor(tr, sid, isPm, anchor) {
    closePopup();
    const it = itemById(sid); if (!it) return;
    const all = isPm ? pms : crews;
    const idKey = isPm ? "project_manager_id" : "work_crew_id";
    const active = isPm ? (it.active_project_managers || []) : (it.active_work_crews || []);
    const checkedSet = new Set(active.map((a) => String(a[idKey])));
    const primaryId = active.find((a) => a.is_primary)?.[idKey] || (active[0] ? active[0][idKey] : null);
    const rowsHtml = all.map((x) => `
      <label class="flex items-center justify-between gap-2 py-1">
        <span class="flex items-center gap-2 min-w-0">
          <input type="checkbox" class="h-4 w-4" data-chk data-id="${x.id}" ${checkedSet.has(String(x.id)) ? "checked" : ""}/>
          <span class="truncate">${escapeHtml(isPm ? pmName(x) : crewName(x))}</span>
        </span>
        <span class="flex items-center gap-1 text-[11px] text-black/50 shrink-0"><span>Primary</span>
          <input type="radio" name="prim" class="h-4 w-4" data-prim data-id="${x.id}" ${String(primaryId || "") === String(x.id) ? "checked" : ""}/></span>
      </label>`).join("") || `<div class="text-sm text-black/50">None found.</div>`;
    const pop = document.createElement("div");
    pop.className = "fixed z-[200] w-[340px] max-w-[92vw] rounded-xl border border-black/10 bg-white text-ink-900 p-3 shadow-xl text-sm";
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.min(r.left, window.innerWidth - 356) + "px";
    pop.style.top = Math.min(r.bottom + 4, window.innerHeight - 320) + "px";
    pop.innerHTML = `
      <div class="text-xs font-bold text-black/50 mb-2">${isPm ? "Project Managers" : "Work Crews"}</div>
      <div class="max-h-[240px] overflow-auto pr-1">${rowsHtml}</div>
      <div class="mt-3 flex justify-end gap-2">
        <button type="button" data-cancel class="rounded-lg border border-black/10 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">Cancel</button>
        <button type="button" data-apply class="btn-primary text-xs px-3 py-1.5">Apply</button>
      </div>`;
    document.body.appendChild(pop);
    openPopup = pop;
    setTimeout(() => document.addEventListener("mousedown", onDocDown, true), 0);
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
      const list = ids.map((id) => ({ [idKey]: id, is_primary: id === prim ? 1 : 0 }));
      if (isPm) it.active_project_managers = list; else it.active_work_crews = list;
      closePopup();
      await saveRow(tr, sid);
      remount();
    });
  }

  rowsHost?.addEventListener("change", (e) => {
    if (!e.target.closest("[data-f]")) return;
    const tr = e.target.closest("tr[data-sid]");
    const sid = tr?.getAttribute("data-sid");
    if (sid && sid !== "null") saveRow(tr, Number(sid));
  });
  rowsHost?.addEventListener("click", async (e) => {
    const assign = e.target.closest("[data-assign]");
    if (assign) {
      const tr = assign.closest("tr[data-sid]");
      const sid = tr?.getAttribute("data-sid");
      if (sid && sid !== "null") openAssignEditor(tr, Number(sid), assign.getAttribute("data-assign") === "pm", assign);
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      const tr = del.closest("tr[data-sid]");
      const sid = tr?.getAttribute("data-sid");
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
