import { api } from "../api.js";
import { setShell } from "../shell.js";
import { timeOffRangeLabel } from "../utils/crew-editor.js";

export async function teamsPage(routeFn) {
  const [pms, crews, vendorData, usersData, passcodeData] = await Promise.all([
    api("/project-managers"),
    api("/work-crews"),
    api("/crew/vendors").catch(() => ({ vendors: [] })),
    api("/users").catch(() => []),
    api("/crew-auth/passcodes").catch(() => ({ passcodes: [] })),
  ]);
  const vendors = vendorData.vendors || [];
  // Field-forms passcodes (Crew Model v2 CR2): one active lead code per crew
  // lead (child row) + one BOSS code per company (a passcode row pointing at
  // the PARENT crew, role 'boss' — scoped to the whole company's projects).
  // The old global crew_id-NULL master code is retired (migration 0057).
  // Codes are write-only — never retrievable.
  const passcodes = passcodeData.passcodes || [];
  const leadCodeByCrew = new Map();
  const bossCodeByCompany = new Map();
  passcodes.forEach(p => {
    if (!p.active || p.crew_id == null) return;
    if (p.role === "lead") leadCodeByCrew.set(String(p.crew_id), p);
    else if (p.role === "boss") bossCodeByCompany.set(String(p.crew_id), p);
  });
  const fmtLastUsed = (p) => {
    if (!p.last_used_at) return "never used";
    const d = String(p.last_used_at).slice(0, 10).split("-"); // YYYY-MM-DD
    return d.length === 3 ? `last used ${Number(d[1])}/${Number(d[2])}` : `last used ${String(p.last_used_at).slice(0, 10)}`;
  };
  const users = (Array.isArray(usersData) ? usersData : []).filter(u => u.is_active);
  const userByPm = new Map();
  users.forEach(u => { if (u.project_manager_id != null) userByPm.set(String(u.project_manager_id), u); });

  // Shared inline-cell styles + a users dropdown builder (for the Linked-user column)
  // CR5-C: text-xs to match the projects/pipeline table typography.
  const CELL = "bg-transparent border border-transparent hover:border-black/15 focus:border-blue-400 focus:bg-white rounded px-1.5 py-1 outline-none text-xs";
  const BTN = "rounded-lg border border-black/15 px-2.5 py-1 text-xs font-semibold text-ink-800 hover:bg-black/5 whitespace-nowrap";
  const userOpts = (selId) => `<option value="">— none —</option>` +
    users.map(u => `<option value="${u.id}" ${String(selId) === String(u.id) ? "selected" : ""}>${escOpt(u.email)}</option>`).join("");
  const flashSaved = (el) => { el.classList.add("ring-1", "ring-emerald-400"); setTimeout(() => el.classList.remove("ring-1", "ring-emerald-400"), 700); };
  const escOpt = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ── split by active status ────────────────────────────────────────────────
  const activePms     = pms.filter(pm => pm.is_active);
  const inactivePms   = pms.filter(pm => !pm.is_active);
  const activeCrews   = crews.filter(c => c.is_active);
  const inactiveCrews = crews.filter(c => !c.is_active);

  // Active crew hierarchy — parents then their active children, indented.
  // CR5-C: display order = sort_order (drag & drop persists it). The
  // /work-crews GET orders company BLOCKS by company id, so companies are
  // sorted here client-side the same way the offers/browse-crews endpoints
  // order them (sort_order, name); leads by (sort_order, id).
  const bySort = (a, b) => (Number(a.sort_order || 0) - Number(b.sort_order || 0))
    || String(a.name || "").localeCompare(String(b.name || ""))
    || (Number(a.id) - Number(b.id));
  const activeParents = activeCrews.filter(c => !c.parent_id).sort(bySort);
  const activeChildrenByParent = new Map();
  activeCrews.filter(c => c.parent_id).forEach(c => {
    const k = String(c.parent_id);
    if (!activeChildrenByParent.has(k)) activeChildrenByParent.set(k, []);
    activeChildrenByParent.get(k).push(c);
  });
  activeChildrenByParent.forEach(list => list.sort(
    (a, b) => (Number(a.sort_order || 0) - Number(b.sort_order || 0)) || (Number(a.id) - Number(b.id))));

  // Modal "Parent" dropdown — include all parents so an Edit of a disabled
  // crew still shows its current (possibly-disabled) parent.
  const parents = crews.filter(c => !c.parent_id);

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));

  function colorDot(color) {
    if (!color) return "";
    return `
      <span
        class="inline-block h-2.5 w-2.5 rounded-full ring-2 ring-black/10"
        style="background:${color}"
        title="${color}"
        aria-label="Color ${color}"
      ></span>
    `;
  }

  function statusPill(isActive) {
    const cls = isActive
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : "bg-red-50 text-red-700 border-red-200";
    return `<span class="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold whitespace-nowrap ${cls}">${isActive ? "Active" : "Disabled"}</span>`;
  }

  // ── row renderers ─────────────────────────────────────────────────────────
  function pmRow(pm) {
    const isActive = !!pm.is_active;
    const linked = userByPm.get(String(pm.id));
    const toggle = isActive
      ? `<button class="${BTN}" data-pm-disable="${pm.id}">Disable</button>`
      : `<button class="${BTN}" data-pm-enable="${pm.id}">Enable</button>`;
    return `
      <tr class="border-b border-black/5">
        <td class="py-1 pr-2"><input type="color" value="${pm.color || "#000000"}" data-pm-field="color" data-pm-id="${pm.id}" class="h-7 w-8 rounded border border-black/10 bg-white p-0.5 cursor-pointer align-middle" title="Color"></td>
        <td class="py-1 pr-2"><input value="${esc(pm.first_name)}" data-pm-field="first_name" data-pm-id="${pm.id}" class="${CELL} w-28" placeholder="First"></td>
        <td class="py-1 pr-2"><input value="${esc(pm.last_name)}" data-pm-field="last_name" data-pm-id="${pm.id}" class="${CELL} w-28" placeholder="Last"></td>
        <td class="py-1 pr-2"><input value="${esc(pm.email)}" data-pm-field="email" data-pm-id="${pm.id}" type="email" class="${CELL} w-full min-w-[13rem]" placeholder="email@…"></td>
        <td class="py-1 pr-2"><input value="${esc(pm.phone)}" data-pm-field="phone" data-pm-id="${pm.id}" class="${CELL} w-32" placeholder="Phone"></td>
        <td class="py-1 pr-2"><select data-pm-link="${pm.id}" class="${CELL} w-full min-w-[12rem]">${userOpts(linked ? linked.id : "")}</select></td>
        <td class="py-1 pl-2 text-right whitespace-nowrap">${toggle}</td>
      </tr>
    `;
  }

  const activePmRows   = activePms.map(pmRow).join("");
  const inactivePmRows = inactivePms.map(pmRow).join("");

  function pmCard(pm) {
    const isActive = !!pm.is_active;
    const linked = userByPm.get(String(pm.id));
    const CINP = `${CELL} border-black/15 w-full`;
    const toggle = isActive
      ? `<button class="flex-1 text-center ${BTN}" data-pm-disable="${pm.id}">Disable</button>`
      : `<button class="flex-1 text-center ${BTN}" data-pm-enable="${pm.id}">Enable</button>`;
    return `
      <div class="rounded-2xl border border-black/10 bg-white p-4 text-ink-900 flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <input type="color" value="${pm.color || "#000000"}" data-pm-field="color" data-pm-id="${pm.id}" class="h-8 w-9 rounded border border-black/10 bg-white p-0.5 cursor-pointer shrink-0" title="Color">
          <input value="${esc(pm.first_name)}" data-pm-field="first_name" data-pm-id="${pm.id}" class="${CINP} min-w-0" placeholder="First">
          <input value="${esc(pm.last_name)}" data-pm-field="last_name" data-pm-id="${pm.id}" class="${CINP} min-w-0" placeholder="Last">
          ${statusPill(isActive)}
        </div>
        <div><div class="text-[11px] text-black/45 mb-0.5">Email</div><input value="${esc(pm.email)}" data-pm-field="email" data-pm-id="${pm.id}" type="email" class="${CINP}" placeholder="email@…"></div>
        <div class="grid grid-cols-2 gap-2">
          <div><div class="text-[11px] text-black/45 mb-0.5">Phone</div><input value="${esc(pm.phone)}" data-pm-field="phone" data-pm-id="${pm.id}" class="${CINP}" placeholder="Phone"></div>
          <div><div class="text-[11px] text-black/45 mb-0.5">Linked user</div><select data-pm-link="${pm.id}" class="${CINP}">${userOpts(linked ? linked.id : "")}</select></div>
        </div>
        <div class="flex items-center gap-2 pt-1">${toggle}</div>
      </div>`;
  }

  const activePmCards   = activePms.map(pmCard).join("");
  const inactivePmCards = inactivePms.map(pmCard).join("");

  function crewParentOpts(c) {
    return `<option value="">(none)</option>` +
      parents.filter(p => p.id !== c.id).map(p => `<option value="${p.id}" ${String(c.parent_id) === String(p.id) ? "selected" : ""}>${escOpt(p.name)}</option>`).join("");
  }
  function crewVendorCell(c) {
    if (c.parent_id) return `<span class="text-black/30 text-xs pl-1">—</span>`;
    return `<select data-crew-field="vendor_qbo_id" data-crew-id="${c.id}" class="${CELL} w-full" style="min-width:7.5rem"><option value="">(not linked)</option>${
      vendors.map(v => `<option value="${escOpt(v.vendor_qbo_id)}" ${String(c.vendor_qbo_id) === String(v.vendor_qbo_id) ? "selected" : ""}>${escOpt(v.name)}</option>`).join("")}</select>`;
  }
  // Field-forms passcode controls (Crew Model v2 CR2 — compacted in CR5-C to
  // a VERTICAL stack: status line over small action buttons, so the column
  // stays narrow). Codes are set/rotated here, read aloud to the carrier,
  // and never shown again. The label auto-fills (lead name / company boss)
  // — no "who carries it" prompt anymore.
  // "New code" (ex-Rotate) sets a fresh code and kills the old one's devices.
  const NEWCODE_TIP = "Sets a new code and signs out any device using the old one";
  // Lead code = the child crew's own sign-in (their assigned projects only).
  function crewPasscodeCell(c) {
    const pc = leadCodeByCrew.get(String(c.id));
    const def = escOpt(c.name); // label auto-fills with the lead's name
    if (!pc) return `
      <div class="tm-pc">
        <div class="tm-pc-line text-black/40">No code</div>
        <div class="tm-pc-btns"><button class="tm-pc-btn" data-pc-set="${c.id}" data-pc-role="lead" data-pc-default="${def}">Set code</button></div>
      </div>`;
    return `
      <div class="tm-pc">
        <div class="tm-pc-line" title="${escOpt(pc.label)} — ${fmtLastUsed(pc)}">
          <span class="tm-pc-dot tm-pc-dot-ok"></span>Code set · ${escOpt(pc.label)} · ${fmtLastUsed(pc)}
        </div>
        <div class="tm-pc-btns">
          <button class="tm-pc-btn" data-pc-set="${c.id}" data-pc-role="lead" data-pc-default="${def}" title="${NEWCODE_TIP}">New code</button>
          <button class="tm-pc-btn" data-pc-deact="${pc.id}" data-pc-who="${escOpt(pc.label)}">Deactivate</button>
        </div>
      </div>`;
  }
  // Boss code = one code per COMPANY (points at the parent crew row): the
  // boss sees every project of their company, lead-less lines included.
  function companyBossCodeCell(c) {
    const pc = bossCodeByCompany.get(String(c.id));
    const def = escOpt(c.boss_name || `${c.name} boss`); // auto label
    if (!pc) return `
      <div class="tm-pc">
        <div class="tm-pc-line text-black/40">No boss code</div>
        <div class="tm-pc-btns"><button class="tm-pc-btn" data-pc-set="${c.id}" data-pc-role="boss" data-pc-default="${def}">Set boss code</button></div>
      </div>`;
    return `
      <div class="tm-pc">
        <div class="tm-pc-line" title="${escOpt(pc.label)} — ${fmtLastUsed(pc)}">
          <span class="tm-pc-dot tm-pc-dot-boss"></span>Boss code · ${escOpt(pc.label)} · ${fmtLastUsed(pc)}
        </div>
        <div class="tm-pc-btns">
          <button class="tm-pc-btn" data-pc-set="${c.id}" data-pc-role="boss" data-pc-default="${def}" title="${NEWCODE_TIP}">New code</button>
          <button class="tm-pc-btn" data-pc-deact="${pc.id}" data-pc-who="${escOpt(pc.label)}">Deactivate</button>
        </div>
      </div>`;
  }

  // CR5 A1 — capacity is auto-by-default. The cell shows the EFFECTIVE number
  // (override when set, else the live active-lead count): typing a number
  // creates an override; the small "auto" button (shown only when overridden)
  // PUTs null to go back to tracking active leads.
  function capacityCell(c, inputCls) {
    const leadN = Number(c.active_lead_count || 0);
    const overridden = c.crew_capacity != null;
    const eff = c.effective_capacity != null ? c.effective_capacity : (overridden ? c.crew_capacity : leadN);
    const leadWord = `${leadN} active lead${leadN === 1 ? "" : "s"}`;
    return `
      <div>
        <div class="flex items-center gap-1">
          <input type="number" min="0" max="99" value="${eff}" data-crew-field="crew_capacity" data-crew-id="${c.id}"
            class="${inputCls} w-14 text-right tabular-nums"
            title="${overridden ? "Manual override — press auto to track active leads again" : "Auto — tracks active leads; typing a number creates an override"}">
          ${overridden ? `<button class="${BTN}" data-cap-auto="${c.id}" title="Back to auto (track active leads)">auto</button>` : ""}
        </div>
        <div class="text-[10px] text-black/40 mt-0.5 whitespace-nowrap">${overridden ? `override — ${leadWord}` : `auto (${leadWord})`}</div>
      </div>`;
  }

  // Companies = parent rows (bold, with Boss/Owner + Crews capacity + vendor
  // + Boss code); crew leads = indented child rows (identity only — the
  // legacy per-lead code is deprecated and no longer shown: slot codes now
  // live on the assignment, not the person).
  // CR5-C: the Sort number column is gone — rows get a drag handle instead
  // (active table only): companies reorder among companies (their lead block
  // moves with them), leads reorder within their own company. Drop persists
  // sort_order through the existing PUT /work-crews/{id}.
  function crewRow(c, draggable = false) {
    const isCompany = !c.parent_id;
    const isActive = !!c.is_active;
    const toggle = isActive
      ? `<button class="${BTN}" data-crew-disable="${c.id}">Disable</button>`
      : `<button class="${BTN}" data-crew-enable="${c.id}">Enable</button>`;
    const addLead = (isCompany && isActive)
      ? `<button class="${BTN}" data-crew-addlead="${c.id}" data-crew-addlead-name="${escOpt(c.name)}" title="Add a crew lead under ${escOpt(c.name)}">+ Lead</button> `
      : "";
    // 0063 CREW TIME-OFF: per-company manager (list + add + delete) — covers
    // the whole company AND its leads in one panel.
    const timeOffBtn = (isCompany && isActive)
      ? `<button class="${BTN}" data-crew-timeoff="${c.id}" data-crew-timeoff-name="${escOpt(c.name)}" title="Vacation / unavailable date ranges for ${escOpt(c.name)} and its leads">Time off…</button> `
      : "";
    const nameCell = isCompany
      ? `<div class="flex items-center gap-1.5">
           <input value="${esc(c.name)}" data-crew-field="name" data-crew-id="${c.id}" class="${CELL} w-full font-semibold" style="min-width:7.5rem" placeholder="Company name">
           <input value="${esc(c.code)}" data-crew-field="code" data-crew-id="${c.id}" class="${CELL} w-14" placeholder="JR" title="Slot-code prefix (JR1, JR2… on projects)">
         </div>`
      : `<div style="padding-left:18px"><input value="${esc(c.name)}" data-crew-field="name" data-crew-id="${c.id}" class="${CELL} w-full" style="min-width:7.5rem" placeholder="Lead name"></div>`;
    const dndAttrs = draggable
      ? ` data-dnd-kind="${isCompany ? "company" : "lead"}" data-dnd-id="${c.id}"${isCompany ? "" : ` data-dnd-parent="${c.parent_id}"`}`
      : "";
    const handleTd = draggable
      ? `<td class="py-1 pr-1"><span class="tm-drag" draggable="true" data-drag-handle title="Drag to reorder${isCompany ? " (companies)" : " (within this company)"} — Esc cancels">⋮⋮</span></td>`
      : "";
    return `
      <tr class="border-b border-black/5${isCompany ? " tm-company-row" : ""}"${dndAttrs}>
        ${handleTd}
        <td class="py-1 pr-2">${nameCell}</td>
        <td class="py-1 pr-2">${isCompany
          ? `<input value="${esc(c.boss_name)}" data-crew-field="boss_name" data-crew-id="${c.id}" class="${CELL} w-full" style="min-width:7rem" placeholder="Boss / owner">`
          : `<span class="text-black/30 text-xs pl-1">—</span>`}</td>
        <td class="py-1 pr-2">${isCompany
          ? capacityCell(c, CELL)
          : `<span class="text-black/30 text-xs pl-1">—</span>`}</td>
        <td class="py-1 pr-2">${isCompany
          ? `<span class="text-black/30 text-xs pl-1">—</span>`
          : `<select data-crew-field="parent_id" data-crew-id="${c.id}" class="${CELL} w-full" style="min-width:7rem">${crewParentOpts(c)}</select>`}</td>
        <td class="py-1 pr-2">${crewVendorCell(c)}</td>
        <td class="py-1 pr-2">${isCompany ? companyBossCodeCell(c) : crewPasscodeCell(c)}</td>
        <td class="py-1 pl-2 text-right whitespace-nowrap">${timeOffBtn}${addLead}${toggle}</td>
      </tr>
    `;
  }

  // Active crews: company rows + their indented active leads (draggable)
  let activeCrewRows = "";
  activeParents.forEach(p => {
    activeCrewRows += crewRow(p, true);
    (activeChildrenByParent.get(String(p.id)) || []).forEach(ch => {
      activeCrewRows += crewRow(ch, true);
    });
  });

  // Inactive crews: flat list sorted by name (avoids orphan-hierarchy weirdness)
  const inactiveCrewRows = [...inactiveCrews]
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
    .map(c => crewRow(c, false))
    .join("");

  function crewCard(c, isChild = false) {
    const isCompany = !c.parent_id;
    const isActive = !!c.is_active;
    const CINP = `${CELL} border-black/15 w-full`;
    const childWrap = isChild ? "ml-4 border-l-4 border-l-black/15" : "";
    const toggle = isActive
      ? `<button class="flex-1 text-center ${BTN}" data-crew-disable="${c.id}">Disable</button>`
      : `<button class="flex-1 text-center ${BTN}" data-crew-enable="${c.id}">Enable</button>`;
    const addLead = (isCompany && isActive)
      ? `<button class="flex-1 text-center ${BTN}" data-crew-addlead="${c.id}" data-crew-addlead-name="${escOpt(c.name)}">+ Lead</button>`
      : "";
    const timeOffBtn = (isCompany && isActive)
      ? `<button class="flex-1 text-center ${BTN}" data-crew-timeoff="${c.id}" data-crew-timeoff-name="${escOpt(c.name)}">Time off…</button>`
      : "";
    const companyBits = isCompany ? `
        <div class="grid grid-cols-2 gap-2">
          <div><div class="text-[11px] text-black/45 mb-0.5">Boss / owner</div><input value="${esc(c.boss_name)}" data-crew-field="boss_name" data-crew-id="${c.id}" class="${CINP}" placeholder="Boss / owner"></div>
          <div><div class="text-[11px] text-black/45 mb-0.5">Crews (capacity)</div>${capacityCell(c, `${CELL} border-black/15`)}</div>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div><div class="text-[11px] text-black/45 mb-0.5">Slot prefix</div><input value="${esc(c.code)}" data-crew-field="code" data-crew-id="${c.id}" class="${CINP}" placeholder="JR" title="Slot-code prefix (JR1, JR2… on projects)"></div>
          <div><div class="text-[11px] text-black/45 mb-0.5">QuickBooks Vendor</div>${crewVendorCell(c)}</div>
        </div>
        <div><div class="text-[11px] text-black/45 mb-0.5">Boss code (all ${esc(c.name)} projects)</div>${companyBossCodeCell(c)}</div>` : `
        <div><div class="text-[11px] text-black/45 mb-0.5">Company</div><select data-crew-field="parent_id" data-crew-id="${c.id}" class="${CINP}">${crewParentOpts(c)}</select></div>
        <div><div class="text-[11px] text-black/45 mb-0.5">Field-forms passcode</div>${crewPasscodeCell(c)}</div>`;
    return `
      <div class="rounded-2xl border border-black/10 bg-white p-4 text-ink-900 flex flex-col gap-2 ${childWrap}">
        <div class="flex items-center gap-2">
          <input value="${esc(c.name)}" data-crew-field="name" data-crew-id="${c.id}" class="${CINP} min-w-0 ${isCompany ? "font-semibold" : ""}" placeholder="${isCompany ? "Company name" : "Lead name"}">
          ${statusPill(isActive)}
        </div>
        ${companyBits}
        <div class="flex items-center gap-2 pt-1">${timeOffBtn}${addLead}${toggle}</div>
      </div>`;
  }

  // Active crews: parent cards followed by their indented active children
  let activeCrewCards = "";
  activeParents.forEach(p => {
    activeCrewCards += crewCard(p, false);
    (activeChildrenByParent.get(String(p.id)) || []).forEach(ch => {
      activeCrewCards += crewCard(ch, true);
    });
  });

  // Inactive crews: flat list sorted by name (parity with table)
  const inactiveCrewCards = [...inactiveCrews]
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
    .map(c => crewCard(c, false))
    .join("");

  const bodyHtml = `
    <div class="grid grid-cols-1 gap-4 pb-6">
      <div class="inline-flex items-center gap-1 rounded-xl bg-white/5 border border-white/10 p-1" role="tablist" aria-label="Teams">
        <button type="button" data-teamtabbtn="pm" class="team-tab px-4 py-2 rounded-lg text-sm font-bold">Project Managers <span class="opacity-60 font-semibold">${activePms.length}</span></button>
        <button type="button" data-teamtabbtn="crew" class="team-tab px-4 py-2 rounded-lg text-sm font-bold">Work Crews <span class="opacity-60 font-semibold">${activeCrews.length}</span></button>
      </div>

      <!-- PMs -->
      <div id="teamsPmPanel" data-teamtab="pm">
      <div class="card p-5">
        <div class="flex items-center justify-between mb-4">
          <div>
            <div class="text-lg font-extrabold">Project Managers</div>
            <div class="text-sm text-black/60">Add, edit, or disable project managers.</div>
          </div>
          <button id="newPmBtn" class="btn-primary">New PM</button>
        </div>
        <div id="pmMsg" class="text-sm text-red-700 min-h-[1.25rem]"></div>
        <div class="hidden lg:block overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="text-left text-black/50">
              <tr class="border-b border-black/10">
                <th class="py-2 pl-2 pr-2 font-bold w-8"></th>
                <th class="py-2 pr-2 font-bold">First</th>
                <th class="py-2 pr-2 font-bold">Last</th>
                <th class="py-2 pr-2 font-bold">Email</th>
                <th class="py-2 pr-2 font-bold">Phone</th>
                <th class="py-2 pr-2 font-bold">Linked user</th>
                <th class="py-2 pl-2 text-right font-bold"></th>
              </tr>
            </thead>
            <tbody>${activePmRows || `<tr><td colspan="7" class="py-6 text-center text-black/40 text-sm">No active project managers.</td></tr>`}</tbody>
          </table>
        </div>

        <!-- Mobile/tablet card list -->
        <div class="lg:hidden flex flex-col gap-3">
          ${activePmCards || `<div class="text-center text-sm text-black/40 py-6">No active project managers.</div>`}
        </div>

        ${inactivePms.length > 0 ? `
          <details class="mt-4 border-t border-black/10 pt-3">
            <summary class="cursor-pointer text-sm font-semibold text-black/60 hover:text-black/80 py-1 select-none">
              Disabled project managers (${inactivePms.length})
            </summary>
            <div class="hidden lg:block overflow-x-auto mt-3">
              <table class="w-full text-xs">
                <thead class="text-left text-black/50">
                  <tr class="border-b border-black/10">
                    <th class="py-2 pl-2 pr-2 font-bold w-8"></th>
                    <th class="py-2 pr-2 font-bold">First</th>
                    <th class="py-2 pr-2 font-bold">Last</th>
                    <th class="py-2 pr-2 font-bold">Email</th>
                    <th class="py-2 pr-2 font-bold">Phone</th>
                    <th class="py-2 pr-2 font-bold">Linked user</th>
                    <th class="py-2 pl-2 text-right font-bold"></th>
                  </tr>
                </thead>
                <tbody>${inactivePmRows}</tbody>
              </table>
            </div>
            <div class="lg:hidden flex flex-col gap-3 mt-3">
              ${inactivePmCards}
            </div>
          </details>
        ` : ""}
      </div>
      </div>

      <!-- Crews -->
      <div id="teamsCrewPanel" data-teamtab="crew" class="hidden">
      <div class="card p-5">
        <div class="flex items-center justify-between mb-4">
          <div>
            <div class="text-lg font-extrabold">Work Crews</div>
            <div class="text-sm text-black/60">Companies (paid via their QBO vendor) with their crew leads underneath. Crews sign in at <span class="font-semibold">/#/field</span>.</div>
          </div>
          <button id="newCrewBtn" class="btn-primary">New crew</button>
        </div>
        <div id="crewMsg" class="text-sm text-red-700 min-h-[1.25rem]"></div>

        <div class="hidden lg:block overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="text-left text-black/50">
              <tr class="border-b border-black/10">
                <th class="py-2 pr-1 font-bold" style="width:20px" title="Drag rows to reorder"></th>
                <th class="py-2 pr-2 font-bold">Company / Lead</th>
                <th class="py-2 pr-2 font-bold">Boss / Owner</th>
                <th class="py-2 pr-2 font-bold" title="How many crews the company can field">Crews</th>
                <th class="py-2 pr-2 font-bold">Company</th>
                <th class="py-2 pr-2 font-bold">QuickBooks Vendor</th>
                <th class="py-2 pr-2 font-bold">Passcode</th>
                <th class="py-2 pl-2 text-right font-bold"></th>
              </tr>
            </thead>
            <tbody id="crewActiveBody">${activeCrewRows || `<tr><td colspan="9" class="py-6 text-center text-black/40 text-sm">No active crews.</td></tr>`}</tbody>
          </table>
        </div>

        <!-- Mobile/tablet card list -->
        <div class="lg:hidden flex flex-col gap-3">
          ${activeCrewCards || `<div class="text-center text-sm text-black/40 py-6">No active crews.</div>`}
        </div>

        ${inactiveCrews.length > 0 ? `
          <details class="mt-4 border-t border-black/10 pt-3">
            <summary class="cursor-pointer text-sm font-semibold text-black/60 hover:text-black/80 py-1 select-none">
              Disabled crews (${inactiveCrews.length})
            </summary>
            <div class="hidden lg:block overflow-x-auto mt-3">
              <table class="w-full text-xs">
                <thead class="text-left text-black/50">
                  <tr class="border-b border-black/10">
                    <th class="py-2 pr-2 font-bold" style="padding-left:8px">Company / Lead</th>
                    <th class="py-2 pr-2 font-bold">Boss / Owner</th>
                    <th class="py-2 pr-2 font-bold" title="How many crews the company can field">Crews</th>
                    <th class="py-2 pr-2 font-bold">Company</th>
                    <th class="py-2 pr-2 font-bold">QuickBooks Vendor</th>
                    <th class="py-2 pr-2 font-bold">Passcode</th>
                    <th class="py-2 pl-2 text-right font-bold"></th>
                  </tr>
                </thead>
                <tbody>${inactiveCrewRows}</tbody>
              </table>
            </div>
            <div class="lg:hidden flex flex-col gap-3 mt-3">
              ${inactiveCrewCards}
            </div>
          </details>
        ` : ""}
      </div>
      </div>
    </div>

    <!-- PM Modal -->
    <div id="pmModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4">
      <div class="card p-6 w-full max-w-lg">
        <div class="flex items-center justify-between mb-3">
          <div class="text-lg font-extrabold" id="pmModalTitle">New PM</div>
          <button id="pmCloseBtn" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>

        <form id="pmForm" class="space-y-3">
          <input type="hidden" id="pmId" value="" />

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div><div class="label mb-1">First name</div><input id="pmFirst" class="input" /></div>
            <div><div class="label mb-1">Last name</div><input id="pmLast" class="input" /></div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div><div class="label mb-1">Email</div><input id="pmEmail" class="input" type="email" /></div>
            <div><div class="label mb-1">Phone</div><input id="pmPhone" class="input" /></div>

            <div>
              <div class="label mb-1">Color</div>
              <div class="flex items-center gap-2">
                <input id="pmColor" type="color" class="h-10 w-14 rounded-xl border border-black/15 bg-white p-1" />
                <button type="button" id="pmColorClear" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Clear</button>
              </div>
            </div>
          </div>

          <label class="flex items-center gap-2 text-sm text-black/70">
            <input id="pmActive" type="checkbox" class="h-4 w-4 rounded border-black/20" checked />
            Active
          </label>

          <div class="flex justify-end gap-2 pt-2">
            <button class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5" type="button" id="pmCancelBtn">Cancel</button>
            <button class="btn-primary" type="submit">Save</button>
          </div>

          <div class="text-sm text-red-700 min-h-[1.25rem]" id="pmModalMsg"></div>
        </form>
      </div>
    </div>

    <!-- Crew Modal -->
    <div id="crewModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4">
      <div class="card p-6 w-full max-w-lg">
        <div class="flex items-center justify-between mb-3">
          <div class="text-lg font-extrabold" id="crewModalTitle">New crew</div>
          <button id="crewCloseBtn" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>

        <form id="crewForm" class="space-y-3">
          <input type="hidden" id="crewId" value="" />

          <div><div class="label mb-1">Name</div><input id="crewName" class="input" required /></div>

          <div>
            <div class="label mb-1">Company <span class="text-black/40">(leave empty to create a company; pick one to add a crew lead under it)</span></div>
            <select id="crewParent" class="input">
              <option value="">(none — this is a company)</option>
              ${parents.map(p => `<option value="${p.id}">${p.name}</option>`).join("")}
            </select>
          </div>

          <div id="crewCompanyWrap" class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div><div class="label mb-1">Boss / Owner</div><input id="crewBoss" class="input" placeholder="e.g. Jesse Rosales Jr." /></div>
            <div><div class="label mb-1">Crews (capacity, 0-99 — blank = auto: tracks active leads)</div><input id="crewCapacity" type="number" min="0" max="99" class="input" placeholder="auto" /></div>
            <div><div class="label mb-1">Slot-code prefix <span class="text-black/40">(JR → JR1, JR2… on projects)</span></div><input id="crewCode" class="input" /></div>
          </div>

          <div id="crewVendorWrap">
            <div class="label mb-1">QuickBooks Vendor <span class="text-black/40">(companies — for crew earnings)</span></div>
            <select id="crewVendor" class="input">
              <option value="">(not linked)</option>
              ${vendors.map(v => `<option value="${escOpt(v.vendor_qbo_id)}">${escOpt(v.name)} — $${Math.round(v.total_paid).toLocaleString("en-US")}</option>`).join("")}
            </select>
          </div>

          <div>
            <div class="label mb-1">Color</div>
            <div class="flex items-center gap-2">
              <input id="crewColor" type="color" class="h-10 w-14 rounded-xl border border-black/15 bg-white p-1" />
              <button type="button" id="crewColorClear" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Clear</button>
            </div>
          </div>

          <label class="flex items-center gap-2 text-sm text-black/70">
            <input id="crewActive" type="checkbox" class="h-4 w-4 rounded border-black/20" checked />
            Active
          </label>

          <div class="flex justify-end gap-2 pt-2">
            <button class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5" type="button" id="crewCancelBtn">Cancel</button>
            <button class="btn-primary" type="submit">Save</button>
          </div>

          <div class="text-sm text-red-700 min-h-[1.25rem]" id="crewModalMsg"></div>
        </form>
      </div>
    </div>
  `;

setShell({
  title: "Team Management",
  subtitle: "Project managers and work-crew companies — contacts, capacity, QuickBooks vendors, and field passcodes.",
  bodyHtml,
  showLogout: true,
  routeFn
});

  // --- Teams tabs: Project Managers | Work Crews (remembers last tab) ---
  (function bindTeamTabs() {
    const KEY = "opi_teams_tab";
    const panels = { pm: document.getElementById("teamsPmPanel"), crew: document.getElementById("teamsCrewPanel") };
    const btns = [...document.querySelectorAll("[data-teamtabbtn]")];
    const show = (tab) => {
      if (!panels[tab]) tab = "pm";
      Object.entries(panels).forEach(([k, el]) => { if (el) el.classList.toggle("hidden", k !== tab); });
      btns.forEach((b) => {
        const on = b.getAttribute("data-teamtabbtn") === tab;
        b.classList.toggle("bg-white", on);
        b.classList.toggle("text-ink-900", on);
        b.classList.toggle("shadow-sm", on);
        b.classList.toggle("text-white/60", !on);
        b.classList.toggle("hover:bg-white/10", !on);
        b.classList.toggle("hover:text-white", !on);
        b.setAttribute("aria-selected", String(on));
      });
      try { localStorage.setItem(KEY, tab); } catch (_) {}
    };
    btns.forEach((b) => b.addEventListener("click", () => show(b.getAttribute("data-teamtabbtn"))));
    let saved = "pm";
    try { saved = localStorage.getItem(KEY) || "pm"; } catch (_) {}
    show(saved);
  })();

  // --- Inline editing: save each cell on change via the partial-update endpoints.
  // Rebind on the persistent #pageBody each render so the closure (users/routeFn) stays fresh.
  const teamsRoot = document.getElementById("pageBody");
  if (teamsRoot) {
    if (teamsRoot._teamsInlineHandler) teamsRoot.removeEventListener("change", teamsRoot._teamsInlineHandler);
    const handler = async (e) => {
      const t = e.target;
      if (t.matches("[data-pm-field]")) {
        const id = t.getAttribute("data-pm-id"), field = t.getAttribute("data-pm-field");
        const val = field === "color" ? t.value : (t.value.trim() || null);
        try { await api(`/project-managers/${id}`, { method: "PUT", body: JSON.stringify({ [field]: val }) }); flashSaved(t); }
        catch (err) { alert("Save failed: " + (err.message || err)); }
      } else if (t.matches("[data-pm-link]")) {
        const pmId = Number(t.getAttribute("data-pm-link"));
        const newUserId = t.value ? Number(t.value) : null;
        try {
          const fresh = await api("/users").catch(() => []);
          const current = (Array.isArray(fresh) ? fresh : []).find(u => Number(u.project_manager_id) === pmId);
          if (!newUserId) { if (current) await api(`/users/${current.id}`, { method: "PUT", body: JSON.stringify({ project_manager_id: null }) }); }
          else {
            if (current && current.id !== newUserId) await api(`/users/${current.id}`, { method: "PUT", body: JSON.stringify({ project_manager_id: null }) });
            await api(`/users/${newUserId}`, { method: "PUT", body: JSON.stringify({ project_manager_id: pmId }) });
          }
          location.hash = "#/teams"; routeFn();
        } catch (err) { alert("Failed to update linked user: " + (err.message || err)); }
      } else if (t.matches("[data-crew-field]")) {
        const id = t.getAttribute("data-crew-id"), field = t.getAttribute("data-crew-field");
        let body, reload = false;
        if (field === "parent_id") { body = { parent_id: t.value ? Number(t.value) : null }; reload = true; }
        else if (field === "vendor_qbo_id") body = { vendor_qbo_id: t.value || null };
        else if (field === "color") body = { color: t.value };
        else if (field === "crew_capacity") {
          const raw = t.value.trim();
          const n = raw === "" ? null : Number(raw);
          if (n !== null && (!Number.isInteger(n) || n < 0 || n > 99)) { alert("Crews capacity must be a whole number 0-99."); return; }
          body = { crew_capacity: n };
          reload = true;   // CR5 A1: the auto/override sub-label must refresh
        }
        else if (field === "boss_name") body = { boss_name: t.value.trim() || null };
        else {
          const v = t.value.trim();
          if (field === "name" && !v) { alert("Name cannot be empty."); return; }
          body = { [field]: v || null };
        }
        try { await api(`/work-crews/${id}`, { method: "PUT", body: JSON.stringify(body) }); if (reload) { location.hash = "#/teams"; routeFn(); } else flashSaved(t); }
        catch (err) { alert("Save failed: " + (err.message || err)); }
      }
    };
    teamsRoot._teamsInlineHandler = handler;
    teamsRoot.addEventListener("change", handler);
  }

  // --- Field-forms passcodes: set/rotate + deactivate (Teams → Work Crews) ---
  // The code is typed once, sent hashed to the server, and can NEVER be read
  // back — the office reads it aloud to the lead/boss when setting it.
  async function setFieldPasscode(crewId, role, defaultLabel) {
    // CR5-C: no "who carries it" prompt — the label auto-fills (lead's name,
    // or the company's boss_name / "<company> boss"). Only the code is asked.
    const lbl = (defaultLabel || "").trim() || (role === "boss" ? "Boss" : "Crew lead");
    const code = prompt(`New 4-6 digit code for ${lbl}:`);
    if (code === null) return;
    const c = code.trim();
    if (!/^\d{4,6}$/.test(c)) { alert("The code must be 4-6 digits."); return; }
    try {
      await api("/crew-auth/passcodes", {
        method: "POST",
        body: JSON.stringify({ crew_id: crewId, role, label: lbl, code: c }),
      });
      alert(`Code set for ${lbl}.\n\nRead it aloud to them now — it cannot be shown again later.\nThey sign in at ${location.origin}/#/field`);
      location.hash = "#/teams"; routeFn();
    } catch (err) {
      let detail = err?.message || "Failed to set the code.";
      try { const o = JSON.parse(detail); if (o && o.detail) detail = o.detail; } catch (_) {}
      alert("Failed to set the code: " + detail);
    }
  }
  document.querySelectorAll("[data-pc-set]").forEach(btn => {
    btn.addEventListener("click", () => {
      const crewId = Number(btn.getAttribute("data-pc-set"));
      const role = btn.getAttribute("data-pc-role") || "lead";
      const def = btn.getAttribute("data-pc-default") || "";
      setFieldPasscode(crewId, role, def);
    });
  });
  document.querySelectorAll("[data-pc-deact]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const who = btn.getAttribute("data-pc-who") || "this code";
      if (!confirm(`Deactivate the field-forms code for ${who}? Their signed-in devices stop working immediately.`)) return;
      try {
        await api(`/crew-auth/passcodes/${btn.getAttribute("data-pc-deact")}/deactivate`, { method: "POST" });
        location.hash = "#/teams"; routeFn();
      } catch (err) {
        alert("Failed to deactivate: " + (err?.message || err));
      }
    });
  });

  // --- 0063 CREW TIME-OFF: per-company panel (list + add + delete) --------
  // Whole-company range = the company is unavailable for the overlap; a
  // lead's range = minus one crew. Rendered on Schedule (grey row), in
  // browse-crews availability and as a warning in the assignment editors.
  async function openTimeOffPanel(companyId, companyName) {
    document.getElementById("ctoModal")?.remove();
    const leads = activeChildrenByParent.get(String(companyId)) || [];
    const overlay = document.createElement("div");
    overlay.id = "ctoModal";
    overlay.className = "fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4";
    overlay.innerHTML = `
      <div class="card p-5 w-full max-w-lg" style="max-height:85vh;overflow:auto;">
        <div class="flex items-center justify-between gap-3 mb-2">
          <div>
            <div class="text-lg font-extrabold">Time off — ${escOpt(companyName)}</div>
            <div class="text-xs text-black/55">A whole-company range makes ${escOpt(companyName)} unavailable; a lead's range takes one crew out. Shows on the Schedule and in crew availability.</div>
          </div>
          <button class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5" data-cto-close>Close</button>
        </div>
        <div class="rounded-xl border border-black/10 p-3 mb-3 bg-black/[0.02]">
          <div class="text-xs font-bold text-black/50 mb-2">Add time off</div>
          <div class="flex items-center gap-2 flex-wrap">
            <select data-cto-lead class="input text-xs py-1.5" style="flex:1;min-width:140px;">
              <option value="">Whole company (${escOpt(companyName)})</option>
              ${leads.map(l => `<option value="${l.id}">${escOpt(l.name)}</option>`).join("")}
            </select>
            <input type="date" data-cto-start class="input text-xs py-1.5" style="width:138px;" />
            <input type="date" data-cto-end class="input text-xs py-1.5" style="width:138px;" />
          </div>
          <div class="flex items-center gap-2 mt-2">
            <input type="text" data-cto-reason maxlength="160" placeholder="Reason (optional, e.g. vacation)" class="input text-xs py-1.5" style="flex:1;min-width:0;" />
            <button class="btn-primary text-xs px-3 py-1.5" data-cto-addbtn>Add</button>
          </div>
          <div data-cto-msg class="text-xs text-red-700 min-h-[1rem] mt-1"></div>
        </div>
        <div data-cto-list class="text-sm text-black/50">Loading…</div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector("[data-cto-close]").addEventListener("click", close);

    async function refreshList() {
      const host = overlay.querySelector("[data-cto-list]");
      let rows = [];
      try {
        rows = (await api(`/crew-time-off?crew_id=${companyId}`)).time_off || [];
      } catch (err) {
        host.innerHTML = `<div class="text-red-700 text-sm">Failed to load time off: ${escOpt(err?.message || err)}</div>`;
        return;
      }
      const today = new Date();
      const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      host.innerHTML = rows.length ? rows.map(r => `
        <div class="cto-row ${r.end_date < todayYmd ? "cto-row-past" : ""}">
          <span class="cto-range">${escOpt(timeOffRangeLabel(r.start_date, r.end_date))}</span>
          <span class="cto-who">${r.level === "company" ? "Whole company" : escOpt(r.crew_name)}</span>
          ${r.reason ? `<span class="cto-meta">· ${escOpt(r.reason)}</span>` : ""}
          ${r.added_by ? `<span class="cto-meta">· added by ${escOpt(r.added_by)}</span>` : ""}
          <button class="cto-del" data-cto-del="${r.id}">Delete</button>
        </div>`).join("")
        : `<div class="text-sm text-black/40 py-2">No time off recorded for ${escOpt(companyName)}.</div>`;
      host.querySelectorAll("[data-cto-del]").forEach(b => b.addEventListener("click", async () => {
        if (!confirm("Remove this time-off range?")) return;
        try {
          await api(`/crew-time-off/${b.getAttribute("data-cto-del")}`, { method: "DELETE" });
          await refreshList();
        } catch (err) { alert("Failed to remove: " + (err?.message || err)); }
      }));
    }

    overlay.querySelector("[data-cto-addbtn]").addEventListener("click", async () => {
      const msg = overlay.querySelector("[data-cto-msg]");
      const leadVal = overlay.querySelector("[data-cto-lead]").value;
      const s = overlay.querySelector("[data-cto-start]").value;
      const en = overlay.querySelector("[data-cto-end]").value;
      const reason = overlay.querySelector("[data-cto-reason]").value.trim();
      msg.textContent = "";
      if (!s || !en) { msg.textContent = "Start and end dates are required."; return; }
      if (en < s) { msg.textContent = "End must be on or after start."; return; }
      try {
        await api("/crew-time-off", { method: "POST", body: JSON.stringify({
          crew_id: Number(leadVal || companyId), start_date: s, end_date: en,
          reason: reason || null }) });
        overlay.querySelector("[data-cto-start]").value = "";
        overlay.querySelector("[data-cto-end]").value = "";
        overlay.querySelector("[data-cto-reason]").value = "";
        await refreshList();
      } catch (err) {
        let detail = err?.message || "Failed to add.";
        try { const o = JSON.parse(detail); if (o && o.detail) detail = o.detail; } catch (_) {}
        msg.textContent = detail;
      }
    });

    await refreshList();
  }
  document.querySelectorAll("[data-crew-timeoff]").forEach(btn => {
    btn.addEventListener("click", () => openTimeOffPanel(
      Number(btn.getAttribute("data-crew-timeoff")),
      btn.getAttribute("data-crew-timeoff-name") || ""));
  });

  // CR5 A1: "auto" reset — clear the capacity override (PUT null) so the
  // company's capacity tracks its live active-lead count again.
  document.querySelectorAll("[data-cap-auto]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-cap-auto");
      try {
        await api(`/work-crews/${id}`, { method: "PUT", body: JSON.stringify({ crew_capacity: null }) });
        location.hash = "#/teams"; routeFn();
      } catch (err) {
        alert("Could not reset capacity to auto: " + (err?.message || err));
      }
    });
  });

  // --- CR5-C: drag & drop reorder (active Work Crews table) ---------------
  // Companies reorder among companies (a company's lead rows travel with it);
  // leads reorder within their own company. On drop the whole scope is
  // renumbered 10,20,30… and only the rows whose sort_order changed are PUT
  // through the existing /work-crews/{id} endpoint (each write audited as
  // crew.update) — no new backend. Esc cancels the native drag (dragend
  // fires, marks are cleared, nothing is saved).
  (function bindCrewDnd() {
    const tbody = document.getElementById("crewActiveBody");
    if (!tbody) return;
    let drag = null; // { kind: "company"|"lead", id, parent }

    const rows = () => [...tbody.querySelectorAll("tr[data-dnd-id]")];
    const blockRows = (companyId) => rows().filter(r =>
      r.getAttribute("data-dnd-id") === String(companyId) ||
      r.getAttribute("data-dnd-parent") === String(companyId));
    const clearDropMarks = () => rows().forEach(r => r.classList.remove("tm-drop-before", "tm-drop-after"));
    const clearAll = () => rows().forEach(r => r.classList.remove("tm-drop-before", "tm-drop-after", "tm-dragging"));

    // Resolve the hovered row into a drop target within the drag's scope,
    // or null when the spot isn't a legal destination.
    const targetOf = (e) => {
      if (!drag) return null;
      const tr = e.target.closest && e.target.closest("tr[data-dnd-id]");
      if (!tr) return null;
      if (drag.kind === "company") {
        // Any row maps to its company block; before/after by block midpoint.
        const coId = tr.getAttribute("data-dnd-kind") === "company"
          ? tr.getAttribute("data-dnd-id")
          : tr.getAttribute("data-dnd-parent");
        if (!coId || String(coId) === String(drag.id)) return null;
        const block = blockRows(coId);
        if (!block.length) return null;
        const top = block[0].getBoundingClientRect().top;
        const bottom = block[block.length - 1].getBoundingClientRect().bottom;
        const before = e.clientY < (top + bottom) / 2;
        return { id: coId, before, markRow: before ? block[0] : block[block.length - 1] };
      }
      // Lead drag: only sibling lead rows of the SAME company are targets.
      if (tr.getAttribute("data-dnd-kind") !== "lead") return null;
      if (String(tr.getAttribute("data-dnd-parent")) !== String(drag.parent)) return null;
      if (tr.getAttribute("data-dnd-id") === String(drag.id)) return null;
      const r = tr.getBoundingClientRect();
      return { id: tr.getAttribute("data-dnd-id"), before: e.clientY < (r.top + r.bottom) / 2, markRow: tr };
    };

    // Persist: renumber the scope's rows 10,20,30… in the new order and PUT
    // only the changed ones (sequentially — small N, each write audited).
    async function persistOrder(orderedIds) {
      const byId = new Map(crews.map(c => [String(c.id), c]));
      const writes = [];
      orderedIds.forEach((cid, i) => {
        const want = (i + 1) * 10;
        const c = byId.get(String(cid));
        if (c && Number(c.sort_order || 0) !== want) writes.push({ id: cid, sort_order: want });
      });
      if (!writes.length) return;
      const msgEl = document.getElementById("crewMsg");
      if (msgEl) msgEl.textContent = "Saving order…";
      try {
        for (const w of writes) {
          await api(`/work-crews/${w.id}`, { method: "PUT", body: JSON.stringify({ sort_order: w.sort_order }) });
        }
        location.hash = "#/teams"; routeFn();
      } catch (err) {
        if (msgEl) msgEl.textContent = "Could not save the new order: " + (err?.message || err);
        location.hash = "#/teams"; routeFn(); // re-render from server truth
      }
    }

    tbody.addEventListener("dragstart", (e) => {
      const handle = e.target.closest && e.target.closest("[data-drag-handle]");
      const tr = e.target.closest && e.target.closest("tr[data-dnd-id]");
      if (!handle || !tr) { e.preventDefault(); return; }
      drag = {
        kind: tr.getAttribute("data-dnd-kind"),
        id: tr.getAttribute("data-dnd-id"),
        parent: tr.getAttribute("data-dnd-parent") || null,
      };
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", drag.id); } catch (_) {} // Firefox needs data
      try { e.dataTransfer.setDragImage(tr, 24, 12); } catch (_) {}
      const moving = drag.kind === "company" ? blockRows(drag.id) : [tr];
      moving.forEach(r => r.classList.add("tm-dragging"));
    });

    tbody.addEventListener("dragover", (e) => {
      const t = targetOf(e);
      clearDropMarks();
      if (!t) return; // no preventDefault → not-allowed cursor
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      t.markRow.classList.add(t.before ? "tm-drop-before" : "tm-drop-after");
    });

    tbody.addEventListener("dragleave", (e) => {
      if (!tbody.contains(e.relatedTarget)) clearDropMarks();
    });

    tbody.addEventListener("drop", (e) => {
      const t = targetOf(e);
      if (!t || !drag) return;
      e.preventDefault();
      // Current displayed order of the drag's scope, from the DOM.
      const scopeIds = rows()
        .filter(r => drag.kind === "company"
          ? r.getAttribute("data-dnd-kind") === "company"
          : (r.getAttribute("data-dnd-kind") === "lead" &&
             String(r.getAttribute("data-dnd-parent")) === String(drag.parent)))
        .map(r => r.getAttribute("data-dnd-id"));
      const from = scopeIds.indexOf(String(drag.id));
      if (from < 0) return;
      scopeIds.splice(from, 1);
      let at = scopeIds.indexOf(String(t.id));
      if (at < 0) return;
      if (!t.before) at += 1;
      scopeIds.splice(at, 0, String(drag.id));
      clearAll();
      drag = null;
      persistOrder(scopeIds);
    });

    tbody.addEventListener("dragend", () => { clearAll(); drag = null; });
  })();

  // --- Color controls (must be after setShell because DOM now exists) ---
  const pmColorEl = document.getElementById("pmColor");
  const pmColorClearBtn = document.getElementById("pmColorClear");
  const crewColorEl = document.getElementById("crewColor");
  const crewColorClearBtn = document.getElementById("crewColorClear");

  pmColorClearBtn.addEventListener("click", () => {
    pmColorEl.value = "#000000";
    pmColorEl.dataset.cleared = "1";
  });
  crewColorClearBtn.addEventListener("click", () => {
    crewColorEl.value = "#000000";
    crewColorEl.dataset.cleared = "1";
  });

  pmColorEl.addEventListener("input", () => {
    delete pmColorEl.dataset.cleared;
  });
  crewColorEl.addEventListener("input", () => {
    delete crewColorEl.dataset.cleared;
  });

  function getPmColorForPayload() {
    return pmColorEl.dataset.cleared === "1" ? null : (pmColorEl.value || null);
  }
  function getCrewColorForPayload() {
    return crewColorEl.dataset.cleared === "1" ? null : (crewColorEl.value || null);
  }

  // Modal helpers
  function openModal(modalEl) {
    modalEl.classList.remove("hidden");
    modalEl.classList.add("flex");
  }
  function closeModal(modalEl) {
    modalEl.classList.add("hidden");
    modalEl.classList.remove("flex");
  }

  const pmModal = document.getElementById("pmModal");
  const crewModal = document.getElementById("crewModal");

  // Close modals
  document.getElementById("pmCloseBtn").addEventListener("click", () => closeModal(pmModal));
  document.getElementById("pmCancelBtn").addEventListener("click", () => closeModal(pmModal));
  pmModal.addEventListener("click", (e) => { if (e.target === pmModal) closeModal(pmModal); });

  document.getElementById("crewCloseBtn").addEventListener("click", () => closeModal(crewModal));
  document.getElementById("crewCancelBtn").addEventListener("click", () => closeModal(crewModal));
  crewModal.addEventListener("click", (e) => { if (e.target === crewModal) closeModal(crewModal); });

  if (!document.body.dataset.teamsEscBound) {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeModal(pmModal);
        closeModal(crewModal);
      }
    });
    document.body.dataset.teamsEscBound = "1";
  }

  // New PM
  document.getElementById("newPmBtn").addEventListener("click", () => {
    document.getElementById("pmModalMsg").textContent = "";
    document.getElementById("pmModalTitle").textContent = "New PM";
    document.getElementById("pmId").value = "";
    document.getElementById("pmFirst").value = "";
    document.getElementById("pmLast").value = "";
    document.getElementById("pmEmail").value = "";
    document.getElementById("pmPhone").value = "";
    document.getElementById("pmActive").checked = true;
    pmColorEl.value = "#000000"; // optional default
    pmColorEl.dataset.cleared = "1";
    openModal(pmModal);
  });

  // Edit PM
  document.querySelectorAll("[data-pm-edit]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-pm-edit");
      const pm = pms.find(x => String(x.id) === String(id));
      if (!pm) return;

      document.getElementById("pmModalMsg").textContent = "";
      document.getElementById("pmModalTitle").textContent = "Edit PM";
      document.getElementById("pmId").value = pm.id;
      document.getElementById("pmFirst").value = pm.first_name || "";
      document.getElementById("pmLast").value = pm.last_name || "";
      document.getElementById("pmEmail").value = pm.email || "";
      document.getElementById("pmPhone").value = pm.phone || "";
      document.getElementById("pmActive").checked = !!pm.is_active;
      if (pm.color) {
        pmColorEl.value = pm.color;
        delete pmColorEl.dataset.cleared;
      } else {
        // keep it "cleared" so Save sends null
        pmColorEl.value = "#000000";      // placeholder
        pmColorEl.dataset.cleared = "1";  // means null
      }
      openModal(pmModal);
    });
  });

  // Disable PM
  document.querySelectorAll("[data-pm-disable]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-pm-disable");
      if (!confirm("Disable this project manager?")) return;
      try {
        await api(`/project-managers/${id}`, { method: "DELETE" });
        location.hash = "#/teams";
        routeFn();
      } catch {
        document.getElementById("pmMsg").textContent = "Failed to disable project manager.";
      }
    });
  });

  // Enable PM — re-activates a disabled project manager without opening the edit modal
  document.querySelectorAll("[data-pm-enable]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-pm-enable");
      const pm = pms.find(x => String(x.id) === String(id));
      if (!pm) return;
      if (!confirm("Re-enable this project manager?")) return;
      const payload = {
        first_name: pm.first_name || null,
        last_name:  pm.last_name  || null,
        email:      pm.email      || null,
        phone:      pm.phone      || null,
        color:      pm.color      || null,
        is_active:  true,
      };
      try {
        await api(`/project-managers/${id}`, { method: "PUT", body: JSON.stringify(payload) });
        location.hash = "#/teams";
        routeFn();
      } catch {
        document.getElementById("pmMsg").textContent = "Failed to re-enable project manager.";
      }
    });
  });

  // Save PM (create/update)
  document.getElementById("pmForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("pmModalMsg");
    msg.textContent = "";

    const id = document.getElementById("pmId").value;
    const payload = {
      first_name: document.getElementById("pmFirst").value.trim() || null,
      last_name: document.getElementById("pmLast").value.trim() || null,
      email: document.getElementById("pmEmail").value.trim() || null,
      phone: document.getElementById("pmPhone").value.trim() || null,
      color: getPmColorForPayload(),
      is_active: document.getElementById("pmActive").checked,
    };

    try {
      if (!id) await api("/project-managers", { method: "POST", body: JSON.stringify(payload) });
      else await api(`/project-managers/${id}`, { method: "PUT", body: JSON.stringify(payload) });

      closeModal(pmModal);
      location.hash = "#/teams";
      routeFn();
    } catch {
      msg.textContent = "Save failed (duplicate email / permissions).";
    }
  });

  // Company-only fields (boss/capacity/prefix/vendor) hide when a company is
  // selected — the row being created/edited is then a crew LEAD (identity
  // only: leads carry no code anymore, slot codes live on the assignment).
  function toggleVendorWrap() {
    const isCompany = !document.getElementById("crewParent").value;
    document.getElementById("crewVendorWrap").style.display = isCompany ? "" : "none";
    document.getElementById("crewCompanyWrap").style.display = isCompany ? "" : "none";
  }
  document.getElementById("crewParent").addEventListener("change", toggleVendorWrap);

  function openNewCrewModal(parentId, parentName) {
    document.getElementById("crewModalMsg").textContent = "";
    document.getElementById("crewModalTitle").textContent =
      parentId ? `New crew lead — ${parentName || "company"}` : "New company / crew";
    document.getElementById("crewId").value = "";
    document.getElementById("crewName").value = "";
    document.getElementById("crewCode").value = "";
    document.getElementById("crewBoss").value = "";
    document.getElementById("crewCapacity").value = "";
    document.getElementById("crewParent").value = parentId ? String(parentId) : "";
    document.getElementById("crewActive").checked = true;
    document.getElementById("crewVendor").value = "";
    toggleVendorWrap();
    crewColorEl.value = "#000000"; // optional default
    crewColorEl.dataset.cleared = "1";
    openModal(crewModal);
  }

  // New Crew (company, or a lead once a company is picked)
  document.getElementById("newCrewBtn").addEventListener("click", () => openNewCrewModal(null, null));

  // "+ Lead" on a company row: same modal, company preselected
  document.querySelectorAll("[data-crew-addlead]").forEach(btn => {
    btn.addEventListener("click", () =>
      openNewCrewModal(Number(btn.getAttribute("data-crew-addlead")),
                       btn.getAttribute("data-crew-addlead-name") || ""));
  });

  // Edit Crew
  document.querySelectorAll("[data-crew-edit]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-crew-edit");
      const c = crews.find(x => String(x.id) === String(id));
      if (!c) return;

      document.getElementById("crewModalMsg").textContent = "";
      document.getElementById("crewModalTitle").textContent = "Edit crew";
      document.getElementById("crewId").value = c.id;
      document.getElementById("crewName").value = c.name || "";
      document.getElementById("crewCode").value = c.code || "";
      document.getElementById("crewBoss").value = c.boss_name || "";
      document.getElementById("crewCapacity").value = c.crew_capacity ?? "";
      document.getElementById("crewParent").value = c.parent_id ? String(c.parent_id) : "";
      document.getElementById("crewVendor").value = c.vendor_qbo_id || "";
      toggleVendorWrap();
      document.getElementById("crewActive").checked = !!c.is_active;
      if (c.color) {
        crewColorEl.value = c.color;
        delete crewColorEl.dataset.cleared;
      } else {
        crewColorEl.value = "#000000";      // placeholder
        crewColorEl.dataset.cleared = "1";  // means null
      }
      openModal(crewModal);
    });
  });

  // Disable Crew
  document.querySelectorAll("[data-crew-disable]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-crew-disable");
      if (!confirm("Disable this crew? (Will fail if active sub crews exist)")) return;
      try {
        await api(`/work-crews/${id}`, { method: "DELETE" });
        location.hash = "#/teams";
        routeFn();
      } catch {
        document.getElementById("crewMsg").textContent = "Failed to disable crew (it may have active sub crews).";
      }
    });
  });

  // Enable Crew — re-activates a disabled crew without opening the edit modal
  document.querySelectorAll("[data-crew-enable]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-crew-enable");
      const c  = crews.find(x => String(x.id) === String(id));
      if (!c) return;
      if (!confirm("Re-enable this crew?")) return;
      const payload = {
        name:       c.name,
        code:       c.code || null,
        parent_id:  c.parent_id || null,
        color:      c.color || null,
        sort_order: Number(c.sort_order || 0),
        is_active:  true,
      };
      try {
        await api(`/work-crews/${id}`, { method: "PUT", body: JSON.stringify(payload) });
        location.hash = "#/teams";
        routeFn();
      } catch {
        document.getElementById("crewMsg").textContent = "Failed to re-enable crew.";
      }
    });
  });

  // Save Crew
  document.getElementById("crewForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("crewModalMsg");
    msg.textContent = "";

    const id = document.getElementById("crewId").value;
    const parentVal = document.getElementById("crewParent").value;

    const capRaw = document.getElementById("crewCapacity").value.trim();
    const cap = capRaw === "" ? null : Number(capRaw);
    if (!parentVal && cap !== null && (!Number.isInteger(cap) || cap < 0 || cap > 99)) {
      msg.textContent = "Crews capacity must be a whole number 0-99.";
      return;
    }

    // CR5-C: the Sort field is gone — order is drag & drop on the table.
    // Edits keep the row's current sort_order; new rows append at the end of
    // their scope (companies, or the picked company's leads).
    let sortVal;
    if (id) {
      const cur = crews.find(x => String(x.id) === String(id));
      sortVal = Number((cur && cur.sort_order) || 0);
    } else {
      const scope = parentVal
        ? crews.filter(x => String(x.parent_id) === String(parentVal))
        : crews.filter(x => !x.parent_id);
      sortVal = Math.max(0, ...scope.map(x => Number(x.sort_order || 0))) + 10;
    }

    const payload = {
      name: document.getElementById("crewName").value.trim(),
      // Company-only fields; crew leads are identity-only (no code — slot
      // codes live on the assignment, boss/capacity/vendor on the company).
      code: parentVal ? null : (document.getElementById("crewCode").value.trim() || null),
      boss_name: parentVal ? null : (document.getElementById("crewBoss").value.trim() || null),
      crew_capacity: parentVal ? null : cap,
      parent_id: parentVal ? Number(parentVal) : null,
      color: getCrewColorForPayload(),
      sort_order: sortVal,
      is_active: document.getElementById("crewActive").checked,
      vendor_qbo_id: parentVal ? null : (document.getElementById("crewVendor").value || null),
    };

    try {
      if (!id) await api("/work-crews", { method: "POST", body: JSON.stringify(payload) });
      else await api(`/work-crews/${id}`, { method: "PUT", body: JSON.stringify(payload) });

      closeModal(crewModal);
      location.hash = "#/teams";
      routeFn();
    } catch {
      msg.textContent = "Save failed (duplicate code / invalid parent).";
    }
  });
}