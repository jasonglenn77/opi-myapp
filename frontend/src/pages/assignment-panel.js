// Per-project assignment editor — the PM + crew + schedule editing from the
// standalone Assignment page, scoped to one project so it lives inside the
// project detail workspace (Projects hub Phase 2). Loads /assignment/bundle and
// saves each schedule item via /assignment/save.
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";

const STATUS_OPTIONS = [
  { value: "needs_attention", label: "Needs attention" },
  { value: "not_started",     label: "Not started" },
  { value: "in_progress",     label: "In progress" },
  { value: "completed",       label: "Completed" },
  { value: "canceled",        label: "Canceled" },
];

const pmName = (pm) => `${pm.first_name || ""} ${pm.last_name || ""}`.trim() || `PM ${pm.id}`;

export async function mountAssignmentPanel(container, qboCustomerId, onChange) {
  container.innerHTML = `<div class="p-4 text-sm text-black/40">Loading assignment…</div>`;
  let bundle;
  try {
    bundle = await api(`/assignment/bundle?qbo_customer_id=${encodeURIComponent(qboCustomerId)}`);
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-sm text-red-600">Failed to load assignment: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }
  const pms = bundle.pms || [];
  const crews = bundle.crews || [];

  const pmOptions = (sel) =>
    `<option value="">— Unassigned</option>` +
    pms.map((pm) => `<option value="${pm.id}" ${String(sel) === String(pm.id) ? "selected" : ""}>${escapeHtml(pmName(pm))}</option>`).join("");
  const crewOptions = (sel) =>
    `<option value="">— Unassigned</option>` +
    crews.map((c) => `<option value="${c.id}" ${String(sel) === String(c.id) ? "selected" : ""}>${escapeHtml(c.name || ("Crew " + c.id))}</option>`).join("");
  const statusOptions = (sel) =>
    STATUS_OPTIONS.map((s) => `<option value="${s.value}" ${s.value === sel ? "selected" : ""}>${escapeHtml(s.label)}</option>`).join("");

  const items = bundle.schedule_items || [];

  const rowHtml = (it, i) => {
    const pm = (it.active_project_managers || [])[0]?.project_manager_id || "";
    const crew = (it.active_work_crews || [])[0]?.work_crew_id || "";
    const st = it.status || "needs_attention";
    return `
      <tr class="border-b border-black/5 align-top" data-sid="${it.id}">
        <td class="py-2 pr-3 text-black/50 tabular-nums">${i + 1}${it.is_extra_row ? '<span class="text-[10px] text-black/30"> (extra)</span>' : ""}</td>
        <td class="py-2 pr-3"><select data-f="status" class="input text-xs py-1.5">${statusOptions(st)}</select></td>
        <td class="py-2 pr-3"><input data-f="start_date" type="date" value="${escapeHtml(it.start_date ? String(it.start_date).slice(0,10) : "")}" class="input text-xs py-1.5"/></td>
        <td class="py-2 pr-3"><input data-f="end_date" type="date" value="${escapeHtml(it.end_date ? String(it.end_date).slice(0,10) : "")}" class="input text-xs py-1.5"/></td>
        <td class="py-2 pr-3"><select data-f="pm" class="input text-xs py-1.5 max-w-[12rem]">${pmOptions(pm)}</select></td>
        <td class="py-2 pr-3"><select data-f="crew" class="input text-xs py-1.5 max-w-[12rem]">${crewOptions(crew)}</select></td>
        <td class="py-2 text-right"><span data-savestate class="text-[11px] text-black/30"></span></td>
      </tr>`;
  };

  const bodyRows = items.length
    ? items.map(rowHtml).join("")
    : `<tr><td colspan="7" class="py-4 text-center text-sm text-black/40">No schedule items yet — add one below.</td></tr>`;

  container.innerHTML = `
    <div class="p-4 sm:p-5">
      <div class="text-xs text-black/50 mb-3">Assign the PM, crew, dates, and status for each schedule item. Changes save automatically.</div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm" style="min-width:760px;">
          <thead><tr class="text-left text-black/45 border-b border-black/10 text-[11px] uppercase tracking-wide">
            <th class="py-2 pr-3 w-10">#</th>
            <th class="py-2 pr-3 w-40">Status</th>
            <th class="py-2 pr-3 w-36">Start</th>
            <th class="py-2 pr-3 w-36">End</th>
            <th class="py-2 pr-3">Project Manager</th>
            <th class="py-2 pr-3">Work Crew</th>
            <th class="py-2 w-16"></th>
          </tr></thead>
          <tbody data-rows>${bodyRows}</tbody>
        </table>
      </div>
      <div class="pt-3">
        <button data-add class="text-xs font-semibold text-emerald-700 hover:underline">+ Add schedule item</button>
      </div>
    </div>`;

  const rowsHost = container.querySelector("[data-rows]");

  async function saveRow(tr, sid) {
    const g = (f) => tr.querySelector(`[data-f="${f}"]`);
    const pmId = g("pm").value ? Number(g("pm").value) : null;
    const crewId = g("crew").value ? Number(g("crew").value) : null;
    const orig = items.find((x) => String(x.id) === String(sid)) || {};
    const state = tr.querySelector("[data-savestate]");
    if (state) { state.textContent = "Saving…"; state.className = "text-[11px] text-black/40"; }
    try {
      const saved = await api("/assignment/save", {
        method: "POST",
        body: JSON.stringify({
          schedule_item_id: sid || null,
          qbo_customer_id: Number(qboCustomerId),
          status: g("status").value,
          start_date: g("start_date").value || null,
          end_date: g("end_date").value || null,
          // preserve fields this editor doesn't expose
          wire_guidance: orig.wire_guidance || 0,
          travel_days: orig.travel_days || 0,
          overage_days: orig.overage_days || 0,
          equipment_type: orig.equipment_type || null,
          notes: orig.notes || null,
          project_manager_ids: pmId ? [pmId] : [],
          primary_project_manager_id: pmId,
          work_crew_ids: crewId ? [crewId] : [],
          primary_work_crew_id: crewId,
        }),
      });
      if (state) { state.textContent = "Saved ✓"; state.className = "text-[11px] text-emerald-600"; setTimeout(() => { if (state.textContent === "Saved ✓") state.textContent = ""; }, 1500); }
      if (onChange) onChange();
      return saved;
    } catch (e) {
      if (state) { state.textContent = "Failed"; state.className = "text-[11px] text-red-600"; }
      alert("Save failed: " + (e?.message || e));
    }
  }

  rowsHost?.addEventListener("change", (e) => {
    const tr = e.target.closest("tr[data-sid]");
    if (!tr) return;
    const sid = tr.getAttribute("data-sid");
    if (sid && sid !== "null") saveRow(tr, Number(sid));
  });

  container.querySelector("[data-add]")?.addEventListener("click", async () => {
    // Create a fresh schedule item, then re-mount to show it as an editable row.
    try {
      await api("/assignment/save", {
        method: "POST",
        body: JSON.stringify({
          qbo_customer_id: Number(qboCustomerId),
          status: "not_started",
          project_manager_ids: [], work_crew_ids: [],
        }),
      });
      if (onChange) onChange();
      mountAssignmentPanel(container, qboCustomerId, onChange);
    } catch (e) {
      alert("Could not add schedule item: " + (e?.message || e));
    }
  });
}
