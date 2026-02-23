import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

export async function assignmentPage(routeFn) {
  const projects = await api("/assignment/projects");

  const bodyHtml = `
    <div class="card p-5">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-lg font-extrabold">Assignment</div>
          <div class="text-sm text-black/60">Connect QuickBooks projects to a PM + Crew, and set dates + status.</div>
        </div>
        <div id="assignMsg" class="text-sm min-h-[1.25rem]"></div>
      </div>

      <div class="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div class="label mb-1">Project (QBO Customer)</div>
          <select id="projectSelect" class="input">
            <option value="">Select a project…</option>
            ${projects.map(p => `<option value="${p.id}">${escapeHtml(p.display_name || p.qbo_id)}</option>`).join("")}
          </select>
          <div class="text-xs text-black/50 mt-1">Only customers marked as projects in QBO are shown.</div>
        </div>

        <div>
          <div class="label mb-1">Status</div>
          <select id="statusSelect" class="input" disabled>
            <option value="not_started">not_started</option>
            <option value="in_progress">in_progress</option>
            <option value="completed">completed</option>
          </select>
        </div>

        <div>
          <div class="label mb-1">Start date</div>
          <input id="startDate" type="date" class="input" disabled />
        </div>

        <div>
          <div class="label mb-1">End date</div>
          <input id="endDate" type="date" class="input" disabled />
        </div>

        <div>
          <div class="label mb-1">Project Managers</div>
          <div id="pmBox" class="rounded-2xl border border-black/10 bg-white/40 p-3 text-sm text-black/50">Select a project first.</div>
        </div>

        <div>
          <div class="label mb-1">Work Crews</div>
          <div id="crewBox" class="rounded-2xl border border-black/10 bg-white/40 p-3 text-sm text-black/50">Select a project first.</div>
        </div>
      </div>

      <div class="mt-4 flex justify-end gap-2">
        <button id="saveAssignBtn" class="btn-primary" disabled>Save assignment</button>
      </div>
    </div>
  `;

  setShell({
    title: "Assignment",
    subtitle: "Manage PM/Crew assignments + project timeline.",
    bodyHtml,
    showLogout: true,
    routeFn
  });

  const projectSelect = document.getElementById("projectSelect");
  const statusSelect = document.getElementById("statusSelect");
  const startDate = document.getElementById("startDate");
  const endDate = document.getElementById("endDate");
  const pmBox = document.getElementById("pmBox");
  const crewBox = document.getElementById("crewBox");
  const saveBtn = document.getElementById("saveAssignBtn");
  const msg = document.getElementById("assignMsg");

  let bundle = null;

  function setMsg(text, ok=false) {
    msg.textContent = text || "";
    msg.className = ok ? "text-sm text-green-700 min-h-[1.25rem]" : "text-sm text-red-700 min-h-[1.25rem]";
  }

  function enableInputs(on) {
    statusSelect.disabled = !on;
    startDate.disabled = !on;
    endDate.disabled = !on;
    saveBtn.disabled = !on;
  }

  function renderMultiSelect(container, items, activeIds, primaryId, kind) {
    const rows = items.map(it => {
      const id = it.id;
      const label = kind === "pm"
        ? `${(it.first_name || "")} ${(it.last_name || "")}`.trim() || (it.email || `PM #${id}`)
        : `${it.name}${it.code ? ` (${it.code})` : ""}`;

      const checked = activeIds.has(String(id)) ? "checked" : "";
      const primaryChecked = String(primaryId || "") === String(id) ? "checked" : "";
      return `
        <label class="flex items-center justify-between gap-2 py-1">
          <span class="flex items-center gap-2">
            <input type="checkbox" class="h-4 w-4" data-${kind}-id="${id}" ${checked}/>
            <span class="font-semibold">${escapeHtml(label)}</span>
          </span>
          <span class="flex items-center gap-2 text-xs text-black/60">
            <span>Primary</span>
            <input type="radio" name="${kind}-primary" class="h-4 w-4" data-${kind}-primary="${id}" ${primaryChecked}/>
          </span>
        </label>
      `;
    }).join("") || `<div class="text-sm text-black/50">None found.</div>`;

    container.innerHTML = `
      <div class="text-xs font-bold text-black/60 mb-2">Select ${kind === "pm" ? "PMs" : "Crews"} (check = assigned)</div>
      <div class="max-h-[260px] overflow-auto pr-1">${rows}</div>
      <div class="text-xs text-black/50 mt-2">Tip: set Primary even if you only assign one.</div>
    `;
  }

  projectSelect.addEventListener("change", async () => {
    setMsg("");
    bundle = null;
    pmBox.innerHTML = `<div class="text-sm text-black/50">Loading…</div>`;
    crewBox.innerHTML = `<div class="text-sm text-black/50">Loading…</div>`;
    enableInputs(false);

    const qbo_customer_id = projectSelect.value;
    if (!qbo_customer_id) {
      pmBox.innerHTML = `<div class="text-sm text-black/50">Select a project first.</div>`;
      crewBox.innerHTML = `<div class="text-sm text-black/50">Select a project first.</div>`;
      return;
    }

    try {
      bundle = await api(`/assignment/bundle?qbo_customer_id=${encodeURIComponent(qbo_customer_id)}`);

      statusSelect.value = bundle.project.status || "not_started";
      startDate.value = bundle.project.start_date || "";
      endDate.value = bundle.project.end_date || "";

      const activePmIds = new Set((bundle.active_project_managers || []).map(x => String(x.project_manager_id)));
      const primaryPm = (bundle.active_project_managers || []).find(x => x.is_primary)?.project_manager_id || null;

      const activeCrewIds = new Set((bundle.active_work_crews || []).map(x => String(x.work_crew_id)));
      const primaryCrew = (bundle.active_work_crews || []).find(x => x.is_primary)?.work_crew_id || null;

      renderMultiSelect(pmBox, bundle.project_managers || [], activePmIds, primaryPm, "pm");
      renderMultiSelect(crewBox, bundle.work_crews || [], activeCrewIds, primaryCrew, "crew");

      enableInputs(true);
    } catch (e) {
      console.error(e);
      setMsg("Failed to load assignment data.");
      pmBox.innerHTML = `<div class="text-sm text-black/50">Select a project first.</div>`;
      crewBox.innerHTML = `<div class="text-sm text-black/50">Select a project first.</div>`;
    }
  });

  saveBtn.addEventListener("click", async () => {
    if (!bundle) return;

    setMsg("");
    saveBtn.disabled = true;

    const qbo_customer_id = Number(projectSelect.value);
    const status = statusSelect.value;
    const start_date = startDate.value || null;
    const end_date = endDate.value || null;

    const pmIds = Array.from(document.querySelectorAll("[data-pm-id]"))
      .filter(x => x.checked).map(x => Number(x.getAttribute("data-pm-id")));

    const pmPrimaryEl = document.querySelector("[data-pm-primary]:checked");
    const primaryPmId = pmPrimaryEl ? Number(pmPrimaryEl.getAttribute("data-pm-primary")) : null;

    const crewIds = Array.from(document.querySelectorAll("[data-crew-id]"))
      .filter(x => x.checked).map(x => Number(x.getAttribute("data-crew-id")));

    const crewPrimaryEl = document.querySelector("[data-crew-primary]:checked");
    const primaryCrewId = crewPrimaryEl ? Number(crewPrimaryEl.getAttribute("data-crew-primary")) : null;

    const payload = {
      qbo_customer_id,
      status,
      start_date,
      end_date,
      project_manager_ids: pmIds,
      primary_project_manager_id: primaryPmId,
      work_crew_ids: crewIds,
      primary_work_crew_id: primaryCrewId
    };

    try {
      await api("/assignment/save", { method: "POST", body: JSON.stringify(payload) });
      setMsg("Saved.", true);
    } catch (e) {
      console.error(e);
      setMsg("Save failed. Make sure primary is included in the checked assignments.");
    } finally {
      saveBtn.disabled = false;
    }
  });
}