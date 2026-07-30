// Per-project assignment editor — the full PM + crew + schedule editing from the
// standalone Assignment page, scoped to one project so it lives inside the
// project detail workspace (Projects hub Phase 2). Loads /assignment/bundle and
// saves each schedule item via /assignment/save; supports multiple schedule
// items per project (add / delete), matching the Assignment page's columns:
// Status · Start · End · PM · Crew · Wire · Travel · Overage · Equipment · Notes.
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";

const STATUS_OPTIONS = [
  { value: "needs_attention", label: "Needs attention" },
  { value: "not_started",     label: "Not started" },
  { value: "in_progress",     label: "In progress" },
  { value: "completed",       label: "Completed" },
  { value: "canceled",        label: "Canceled" },
];
const TRAVEL_OPTIONS = [[0, "None"], [2, "2 days"], [3, "3 days"], [4, "4 days"]];
const EQUIP_OPTIONS = ["", "Equip", "No Equip", "Electric"];

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
  const items = bundle.schedule_items || [];

  const remount = () => mountAssignmentPanel(container, qboCustomerId, onChange);

  const opt = (v, label, sel) => `<option value="${escapeHtml(String(v))}" ${String(sel) === String(v) ? "selected" : ""}>${escapeHtml(label)}</option>`;
  const pmOptions = (sel) => `<option value="">— Unassigned</option>` + pms.map((pm) => opt(pm.id, pmName(pm), sel)).join("");
  const crewOptions = (sel) => `<option value="">— Unassigned</option>` + crews.map((c) => opt(c.id, c.name || ("Crew " + c.id), sel)).join("");
  const statusOptions = (sel) => STATUS_OPTIONS.map((s) => opt(s.value, s.label, sel)).join("");
  const travelOptions = (sel) => TRAVEL_OPTIONS.map(([v, l]) => opt(v, l, sel || 0)).join("");
  const equipOptions = (sel) => EQUIP_OPTIONS.map((v) => opt(v, v || "None", sel || "")).join("");

  const rowHtml = (it, i) => {
    const pm = (it.active_project_managers || [])[0]?.project_manager_id || "";
    const crew = (it.active_work_crews || [])[0]?.work_crew_id || "";
    return `
      <tr class="border-b border-black/5 align-top" data-sid="${it.id}">
        <td class="py-2 pr-2 text-black/50 tabular-nums">${i + 1}${it.is_extra_row ? '<span class="text-[10px] text-black/30"> (extra)</span>' : ""}</td>
        <td class="py-2 pr-2"><select data-f="status" class="input text-xs py-1.5">${statusOptions(it.status || "needs_attention")}</select></td>
        <td class="py-2 pr-2"><input data-f="start_date" type="date" value="${escapeHtml(it.start_date ? String(it.start_date).slice(0,10) : "")}" class="input text-xs py-1.5"/></td>
        <td class="py-2 pr-2"><input data-f="end_date" type="date" value="${escapeHtml(it.end_date ? String(it.end_date).slice(0,10) : "")}" class="input text-xs py-1.5"/></td>
        <td class="py-2 pr-2"><select data-f="pm" class="input text-xs py-1.5 max-w-[11rem]">${pmOptions(pm)}</select></td>
        <td class="py-2 pr-2"><select data-f="crew" class="input text-xs py-1.5 max-w-[11rem]">${crewOptions(crew)}</select></td>
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
  };

  const bodyRows = items.length
    ? items.map(rowHtml).join("")
    : `<tr><td colspan="12" class="py-4 text-center text-sm text-black/40">No schedule items yet — add one below.</td></tr>`;

  container.innerHTML = `
    <div class="p-4 sm:p-5">
      <div class="text-xs text-black/50 mb-3">Assign the PM, crew, dates, and schedule detail for each schedule item. A project can have more than one schedule item (extra crews / phases). Changes save automatically.</div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm" style="min-width:1120px;">
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

  async function saveRow(tr, sid) {
    const g = (f) => tr.querySelector(`[data-f="${f}"]`);
    const pmId = g("pm").value ? Number(g("pm").value) : null;
    const crewId = g("crew").value ? Number(g("crew").value) : null;
    const state = tr.querySelector("[data-savestate]");
    if (state) { state.textContent = "Saving…"; state.className = "text-[11px] text-black/40 mr-2"; }
    try {
      await api("/assignment/save", {
        method: "POST",
        body: JSON.stringify({
          schedule_item_id: sid || null,
          qbo_customer_id: Number(qboCustomerId),
          status: g("status").value,
          start_date: g("start_date").value || null,
          end_date: g("end_date").value || null,
          wire_guidance: g("wire_guidance").checked ? 1 : 0,
          travel_days: Number(g("travel_days").value) || 0,
          overage_days: Number(g("overage_days").value) || 0,
          equipment_type: g("equipment_type").value || null,
          notes: g("notes").value || null,
          project_manager_ids: pmId ? [pmId] : [],
          primary_project_manager_id: pmId,
          work_crew_ids: crewId ? [crewId] : [],
          primary_work_crew_id: crewId,
        }),
      });
      if (state) { state.textContent = "Saved ✓"; state.className = "text-[11px] text-emerald-600 mr-2"; setTimeout(() => { if (state.textContent === "Saved ✓") state.textContent = ""; }, 1500); }
      if (onChange) onChange();
    } catch (e) {
      if (state) { state.textContent = "Failed"; state.className = "text-[11px] text-red-600 mr-2"; }
      alert("Save failed: " + (e?.message || e));
    }
  }

  rowsHost?.addEventListener("change", (e) => {
    if (!e.target.closest("[data-f]")) return;
    const tr = e.target.closest("tr[data-sid]");
    const sid = tr?.getAttribute("data-sid");
    if (sid && sid !== "null") saveRow(tr, Number(sid));
  });

  rowsHost?.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del]");
    if (!del) return;
    const tr = del.closest("tr[data-sid]");
    const sid = tr?.getAttribute("data-sid");
    if (!sid || sid === "null") return;
    if (!confirm("Delete this schedule item? This removes its assignment and cannot be undone.")) return;
    try {
      await api(`/assignment/schedule-item/${sid}`, { method: "DELETE" });
      if (onChange) onChange();
      remount();
    } catch (err) {
      alert("Delete failed: " + (err?.message || err));
    }
  });

  container.querySelector("[data-add]")?.addEventListener("click", async () => {
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
      remount();
    } catch (e) {
      alert("Could not add schedule item: " + (e?.message || e));
    }
  });
}
