// Crew Model v2 (CR3/CR5) — the COMPANY-first crew editor, shared by the
// office Assignment page (assignment.js) and the project-workspace Assignment
// tab (assignment-panel.js). One implementation, two hosts (same rule as
// form-render.js): each entry = company (required) + optional lead
// ("— lead TBD —") + editable slot code (auto-suggested) + primary radio +
// ✕ remove, with "+ Add crew" for multiple crews per line.
//
// ctx = { companies: [{id,name,code,boss_name,leads:[{id,name}]}],
//         work_crews: [flat active crews incl. parents, w/ parent_id] }
// (both come straight from /assignment/bundle).
//
// The module owns the entry markup (crewEditorBodyHtml) and the draft
// mutations (handleCrewEditorClick/Change/Input — bound by the hosts via
// their own event delegation); hosts own the surrounding popup, the
// Cancel/Apply buttons and the save. Payload building for /assignment/save
// (v2 crew_assignments + legacy dual-write fields) lives here too so the
// two hosts can never drift apart.
import { escapeHtml } from "./html.js";

export function companiesOf(ctx) {
  return (ctx && ctx.companies) || [];
}

export function companyById(ctx, id) {
  return companiesOf(ctx).find(c => String(c.id) === String(id)) || null;
}

export function crewNameById(ctx, id) {
  if (id == null) return null;
  const wc = ((ctx && ctx.work_crews) || []).find(c => String(c.id) === String(id));
  if (wc) return wc.name;
  for (const co of companiesOf(ctx)) {
    if (String(co.id) === String(id)) return co.name;
    const l = (co.leads || []).find(x => String(x.id) === String(id));
    if (l) return l.name;
  }
  return `Crew #${id}`;
}

// Company picker label: "MTY · Jesse Rosales Jr." (boss shown when known).
export function companyLabel(co) {
  return co ? `${co.name}${co.boss_name ? ` · ${co.boss_name}` : ""}` : "";
}

// Assignment entry label for a display cell: "MTY · Gustavo Ramirez" /
// "MTY · lead TBD".
export function entryLabel(ctx, e) {
  const co = companyById(ctx, e.company_id);
  const coName = co ? co.name : (e.company_id != null ? crewNameById(ctx, e.company_id) : null);
  const lead = e.lead_crew_id != null ? crewNameById(ctx, e.lead_crew_id) : null;
  if (!coName) return crewNameById(ctx, e.work_crew_id) || "—";
  return `${coName} · ${lead || "lead TBD"}`;
}

// Next free slot code for a company: company prefix + first ordinal not taken
// by externalTaken (slots elsewhere in the project) or by the other draft
// entries (skipIdx = the entry being edited).
export function suggestSlot(ctx, companyId, draft, skipIdx, externalTaken) {
  const co = companyById(ctx, companyId);
  const prefix = co?.code;
  if (!prefix) return "";
  const taken = new Set([...(externalTaken || [])].map(s => String(s).toUpperCase()));
  (draft || []).forEach((e, i) => {
    if (i !== skipIdx && e.slot_code) taken.add(String(e.slot_code).toUpperCase());
  });
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

// Normalize an active_work_crews record (from the bundle or a prior save)
// into a draft entry {company_id, lead_crew_id, slot_code, is_primary}.
// Legacy records (no company_id) derive company/lead from work_crew_id.
export function toDraftEntry(ctx, x) {
  let companyId = x.company_id != null ? Number(x.company_id) : null;
  let leadId = x.lead_crew_id != null ? Number(x.lead_crew_id) : null;
  if (companyId == null && x.work_crew_id != null) {
    const wc = ((ctx && ctx.work_crews) || []).find(c => String(c.id) === String(x.work_crew_id));
    if (wc && wc.parent_id != null) { companyId = Number(wc.parent_id); leadId = Number(wc.id); }
    else if (wc) { companyId = Number(wc.id); leadId = null; }
  }
  return {
    company_id: companyId,
    lead_crew_id: leadId,
    slot_code: x.slot_code || "",
    is_primary: !!x.is_primary,
    work_crew_id: leadId != null ? leadId : companyId,
  };
}

// The crew fields every /assignment/save payload carries: v2 crew_assignments
// entries + the legacy dual-write fields so older readers keep working.
// activeList = active_work_crews-shaped records (draft entries work too).
export function crewFieldsFor(ctx, activeList) {
  const entries = (activeList || []).map(x => toDraftEntry(ctx, x))
    .filter(e => e.company_id != null);
  return {
    work_crew_ids: entries.map(e => Number(e.work_crew_id)),
    primary_work_crew_id: entries.find(e => e.is_primary)?.work_crew_id ?? null,
    crew_assignments: entries.map(e => ({
      company_id: Number(e.company_id),
      lead_crew_id: e.lead_crew_id != null ? Number(e.lead_crew_id) : null,
      slot_code: (e.slot_code || "").trim().toUpperCase() || null,
      is_primary: !!e.is_primary,
    })),
  };
}

// ── editor markup ───────────────────────────────────────────────────────────

function entryRowHtml(ctx, e, idx, radioName) {
  const companies = companiesOf(ctx);
  const co = companyById(ctx, e.company_id);
  const leads = co ? (co.leads || []) : [];
  const knownLead = e.lead_crew_id != null && leads.some(l => String(l.id) === String(e.lead_crew_id));
  const companyOpts = `<option value="">— pick company —</option>` + companies.map(c => `
    <option value="${c.id}" ${String(c.id) === String(e.company_id ?? "") ? "selected" : ""}>${escapeHtml(companyLabel(c))}</option>`).join("");
  const leadOpts = `<option value="">— lead TBD —</option>` + leads.map(l => `
    <option value="${l.id}" ${String(l.id) === String(e.lead_crew_id ?? "") ? "selected" : ""}>${escapeHtml(l.name)}</option>`).join("")
    + (e.lead_crew_id != null && !knownLead
        ? `<option value="${e.lead_crew_id}" selected>${escapeHtml(crewNameById(ctx, e.lead_crew_id))} (inactive)</option>` : "");
  return `
    <div class="rounded-lg border border-black/10 bg-black/[0.02] p-2 mb-2" data-crewdraft-entry="${idx}">
      <div class="flex items-center gap-2">
        <select class="input text-xs py-1 flex-1 min-w-0" data-crewdraft-company="${idx}">${companyOpts}</select>
        <button type="button" class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-red-200 text-red-700 text-xs font-bold hover:bg-red-50"
          data-crewdraft-remove="${idx}" aria-label="Remove crew" title="Remove crew">✕</button>
      </div>
      <div class="mt-1.5 flex items-center gap-2 flex-wrap">
        <select class="input text-xs py-1 flex-1 min-w-[120px]" data-crewdraft-lead="${idx}" ${co ? "" : "disabled"}>${leadOpts}</select>
        <input type="text" class="input text-xs py-1 w-16 uppercase" maxlength="12" placeholder="slot"
          title="Project slot code (auto-suggested — editable)"
          data-crewdraft-slot="${idx}" value="${escapeHtml(e.slot_code || "")}" />
        <label class="inline-flex items-center gap-1 text-[11px] text-black/60 whitespace-nowrap">
          <input type="radio" name="${escapeHtml(radioName)}" class="h-3.5 w-3.5"
            data-crewdraft-primary="${idx}" ${e.is_primary ? "checked" : ""} /> Primary
        </label>
      </div>
    </div>`;
}

/** The editor's inner body: heading, scrollable entry list, "+ Add crew".
 *  Hosts wrap it in their own popup and append Cancel/Apply. */
export function crewEditorBodyHtml(ctx, draft, radioName) {
  return `
    <div class="text-xs font-bold text-black/50 mb-2">Work Crews — company first, lead optional</div>
    <div class="overflow-auto pr-1" style="max-height:280px;">
      ${(draft || []).map((e, i) => entryRowHtml(ctx, e, i, radioName)).join("") || `<div class="text-xs text-black/45 mb-2">No crew on this line yet.</div>`}
    </div>
    <button type="button" class="inline-flex items-center rounded-lg border border-black/10 px-2 py-1 text-[11px] font-semibold hover:bg-black/5"
      data-crewdraft-add="1">+ Add crew</button>`;
}

// ── draft mutations (hosts delegate their events here) ─────────────────────

/** Click inside the editor: + Add crew / ✕ remove. Returns true when the
 *  draft changed (host re-renders the editor body). */
export function handleCrewEditorClick(e, draft) {
  if (!draft) return false;
  if (e.target.closest("[data-crewdraft-add]")) {
    draft.push({ company_id: null, lead_crew_id: null, slot_code: "", is_primary: false });
    return true;
  }
  const rm = e.target.closest("[data-crewdraft-remove]");
  if (rm) {
    const idx = Number(rm.getAttribute("data-crewdraft-remove"));
    if (draft[idx] !== undefined) { draft.splice(idx, 1); return true; }
  }
  return false;
}

/** Change inside the editor: company select (resets lead, re-suggests slot),
 *  lead select, primary radio. Returns {handled, rerender}. externalTaken =
 *  slot codes taken elsewhere in the project (Set or array). */
export function handleCrewEditorChange(e, ctx, draft, externalTaken) {
  if (!draft) return { handled: false, rerender: false };
  const coSel = e.target.closest("[data-crewdraft-company]");
  if (coSel) {
    const idx = Number(coSel.getAttribute("data-crewdraft-company"));
    const entry = draft[idx];
    if (entry) {
      entry.company_id = coSel.value ? Number(coSel.value) : null;
      entry.lead_crew_id = null;                      // lead is company-scoped
      entry.slot_code = entry.company_id
        ? suggestSlot(ctx, entry.company_id, draft, idx, externalTaken) : "";
    }
    return { handled: true, rerender: true };
  }
  const leadSel = e.target.closest("[data-crewdraft-lead]");
  if (leadSel) {
    const idx = Number(leadSel.getAttribute("data-crewdraft-lead"));
    const entry = draft[idx];
    if (entry) entry.lead_crew_id = leadSel.value ? Number(leadSel.value) : null;
    return { handled: true, rerender: false };
  }
  const prim = e.target.closest("[data-crewdraft-primary]");
  if (prim) {
    const idx = Number(prim.getAttribute("data-crewdraft-primary"));
    draft.forEach((en, i) => { en.is_primary = i === idx; });
    return { handled: true, rerender: false };
  }
  return { handled: false, rerender: false };
}

/** Slot-code typing (input event) — kept in the draft, no re-render while
 *  typing. Returns true when handled. */
export function handleCrewEditorInput(e, draft) {
  const slotInput = e.target.closest("[data-crewdraft-slot]");
  if (!slotInput || !draft) return false;
  const idx = Number(slotInput.getAttribute("data-crewdraft-slot"));
  const entry = draft[idx];
  if (entry) entry.slot_code = slotInput.value.trim().toUpperCase();
  return true;
}
