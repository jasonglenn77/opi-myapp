import { api } from "../api.js";
import { setShell } from "../shell.js";

export async function teamsPage(routeFn) {
  const [pms, crews, vendorData, usersData] = await Promise.all([
    api("/project-managers"),
    api("/work-crews"),
    api("/crew/vendors").catch(() => ({ vendors: [] })),
    api("/users").catch(() => []),
  ]);
  const vendors = vendorData.vendors || [];
  const users = (Array.isArray(usersData) ? usersData : []).filter(u => u.is_active);
  const userByPm = new Map();
  users.forEach(u => { if (u.project_manager_id != null) userByPm.set(String(u.project_manager_id), u); });

  // Shared inline-cell styles + a users dropdown builder (for the Linked-user column)
  const CELL = "bg-transparent border border-transparent hover:border-black/15 focus:border-blue-400 focus:bg-white rounded px-1.5 py-1 outline-none text-sm";
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

  // Active crew hierarchy — parents then their active children, indented
  const activeParents = activeCrews.filter(c => !c.parent_id);
  const activeChildrenByParent = new Map();
  activeCrews.filter(c => c.parent_id).forEach(c => {
    const k = String(c.parent_id);
    if (!activeChildrenByParent.has(k)) activeChildrenByParent.set(k, []);
    activeChildrenByParent.get(k).push(c);
  });

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
    return `<select data-crew-field="vendor_qbo_id" data-crew-id="${c.id}" class="${CELL} w-full min-w-[12rem]"><option value="">(not linked)</option>${
      vendors.map(v => `<option value="${escOpt(v.vendor_qbo_id)}" ${String(c.vendor_qbo_id) === String(v.vendor_qbo_id) ? "selected" : ""}>${escOpt(v.name)}</option>`).join("")}</select>`;
  }
  function crewRow(c, indent = 0) {
    const isActive = !!c.is_active;
    const toggle = isActive
      ? `<button class="${BTN}" data-crew-disable="${c.id}">Disable</button>`
      : `<button class="${BTN}" data-crew-enable="${c.id}">Enable</button>`;
    return `
      <tr class="border-b border-black/5">
        <td class="py-1 pr-2"><input type="color" value="${c.color || "#000000"}" data-crew-field="color" data-crew-id="${c.id}" class="h-7 w-8 rounded border border-black/10 bg-white p-0.5 cursor-pointer align-middle" title="Color"></td>
        <td class="py-1 pr-2"><div style="padding-left:${indent}px"><input value="${esc(c.name)}" data-crew-field="name" data-crew-id="${c.id}" class="${CELL} w-full min-w-[10rem]" placeholder="Name"></div></td>
        <td class="py-1 pr-2"><input value="${esc(c.code)}" data-crew-field="code" data-crew-id="${c.id}" class="${CELL} w-24" placeholder="Code"></td>
        <td class="py-1 pr-2"><select data-crew-field="parent_id" data-crew-id="${c.id}" class="${CELL} w-full min-w-[9rem]">${crewParentOpts(c)}</select></td>
        <td class="py-1 pr-2">${crewVendorCell(c)}</td>
        <td class="py-1 pr-2"><input type="number" value="${c.sort_order ?? 0}" data-crew-field="sort_order" data-crew-id="${c.id}" class="${CELL} w-16 text-right tabular-nums"></td>
        <td class="py-1 pl-2 text-right whitespace-nowrap">${toggle}</td>
      </tr>
    `;
  }

  // Active crews: parent rows + indented active children
  let activeCrewRows = "";
  activeParents.forEach(p => {
    activeCrewRows += crewRow(p, 0);
    (activeChildrenByParent.get(String(p.id)) || []).forEach(ch => {
      activeCrewRows += crewRow(ch, 18);
    });
  });

  // Inactive crews: flat list sorted by name (avoids orphan-hierarchy weirdness)
  const inactiveCrewRows = [...inactiveCrews]
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
    .map(c => crewRow(c, 0))
    .join("");

  function crewCard(c, isChild = false) {
    const isActive = !!c.is_active;
    const CINP = `${CELL} border-black/15 w-full`;
    const childWrap = isChild ? "ml-4 border-l-4 border-l-black/15" : "";
    const toggle = isActive
      ? `<button class="flex-1 text-center ${BTN}" data-crew-disable="${c.id}">Disable</button>`
      : `<button class="flex-1 text-center ${BTN}" data-crew-enable="${c.id}">Enable</button>`;
    return `
      <div class="rounded-2xl border border-black/10 bg-white p-4 text-ink-900 flex flex-col gap-2 ${childWrap}">
        <div class="flex items-center gap-2">
          <input type="color" value="${c.color || "#000000"}" data-crew-field="color" data-crew-id="${c.id}" class="h-8 w-9 rounded border border-black/10 bg-white p-0.5 cursor-pointer shrink-0" title="Color">
          <input value="${esc(c.name)}" data-crew-field="name" data-crew-id="${c.id}" class="${CINP} min-w-0 font-semibold" placeholder="Name">
          ${statusPill(isActive)}
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div><div class="text-[11px] text-black/45 mb-0.5">Code</div><input value="${esc(c.code)}" data-crew-field="code" data-crew-id="${c.id}" class="${CINP}" placeholder="Code"></div>
          <div><div class="text-[11px] text-black/45 mb-0.5">Parent</div><select data-crew-field="parent_id" data-crew-id="${c.id}" class="${CINP}">${crewParentOpts(c)}</select></div>
        </div>
        ${!c.parent_id ? `<div><div class="text-[11px] text-black/45 mb-0.5">QuickBooks Vendor</div>${crewVendorCell(c)}</div>` : ""}
        <div class="flex items-center gap-2 pt-1">${toggle}</div>
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
          <table class="w-full text-sm" style="min-width:940px;">
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
              <table class="w-full text-sm" style="min-width:940px;">
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
            <div class="text-sm text-black/60">Manage crews and sub crews.</div>
          </div>
          <button id="newCrewBtn" class="btn-primary">New crew</button>
        </div>
        <div id="crewMsg" class="text-sm text-red-700 min-h-[1.25rem]"></div>
        <div class="hidden lg:block overflow-x-auto">
          <table class="w-full text-sm" style="min-width:900px;">
            <thead class="text-left text-black/50">
              <tr class="border-b border-black/10">
                <th class="py-2 pl-2 pr-2 font-bold w-8"></th>
                <th class="py-2 pr-2 font-bold">Name</th>
                <th class="py-2 pr-2 font-bold">Code</th>
                <th class="py-2 pr-2 font-bold">Parent</th>
                <th class="py-2 pr-2 font-bold">QuickBooks Vendor</th>
                <th class="py-2 pr-2 font-bold">Sort</th>
                <th class="py-2 pl-2 text-right font-bold"></th>
              </tr>
            </thead>
            <tbody>${activeCrewRows || `<tr><td colspan="7" class="py-6 text-center text-black/40 text-sm">No active crews.</td></tr>`}</tbody>
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
              <table class="w-full text-sm" style="min-width:900px;">
                <thead class="text-left text-black/50">
                  <tr class="border-b border-black/10">
                    <th class="py-2 pl-2 pr-2 font-bold w-8"></th>
                    <th class="py-2 pr-2 font-bold">Name</th>
                    <th class="py-2 pr-2 font-bold">Code</th>
                    <th class="py-2 pr-2 font-bold">Parent</th>
                    <th class="py-2 pr-2 font-bold">QuickBooks Vendor</th>
                    <th class="py-2 pr-2 font-bold">Sort</th>
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

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div><div class="label mb-1">Code</div><input id="crewCode" class="input" /></div>
            <div>
              <div class="label mb-1">Parent (optional)</div>
              <select id="crewParent" class="input">
                <option value="">(none)</option>
                ${parents.map(p => `<option value="${p.id}">${p.name}</option>`).join("")}
              </select>
            </div>
          </div>

          <div id="crewVendorWrap">
            <div class="label mb-1">QuickBooks Vendor <span class="text-black/40">(parent crews — for crew earnings)</span></div>
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

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div><div class="label mb-1">Sort order</div><input id="crewSort" type="number" class="input" value="0" /></div>
            <label class="flex items-center gap-2 text-sm text-black/70 mt-6">
              <input id="crewActive" type="checkbox" class="h-4 w-4 rounded border-black/20" checked />
              Active
            </label>
          </div>

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
  title: "",
  subtitle: "",
  bodyHtml,
  showLogout: true,
  routeFn
});

  // Hide the empty page-title block; restore when navigating away
  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => {
      if (pageTitleBlock) pageTitleBlock.style.display = "";
    }, { once: true });
  }

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
        else if (field === "sort_order") body = { sort_order: Number(t.value) || 0 };
        else if (field === "color") body = { color: t.value };
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

  // Vendor field only applies to PARENT crews (no parent selected).
  function toggleVendorWrap() {
    const isParent = !document.getElementById("crewParent").value;
    document.getElementById("crewVendorWrap").style.display = isParent ? "" : "none";
  }
  document.getElementById("crewParent").addEventListener("change", toggleVendorWrap);

  // New Crew
  document.getElementById("newCrewBtn").addEventListener("click", () => {
    document.getElementById("crewModalMsg").textContent = "";
    document.getElementById("crewModalTitle").textContent = "New crew";
    document.getElementById("crewId").value = "";
    document.getElementById("crewName").value = "";
    document.getElementById("crewCode").value = "";
    document.getElementById("crewParent").value = "";
    document.getElementById("crewSort").value = "0";
    document.getElementById("crewActive").checked = true;
    document.getElementById("crewVendor").value = "";
    toggleVendorWrap();
    crewColorEl.value = "#000000"; // optional default
    crewColorEl.dataset.cleared = "1";
    openModal(crewModal);
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
      document.getElementById("crewParent").value = c.parent_id ? String(c.parent_id) : "";
      document.getElementById("crewVendor").value = c.vendor_qbo_id || "";
      toggleVendorWrap();
      document.getElementById("crewSort").value = String(c.sort_order || 0);
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

    const payload = {
      name: document.getElementById("crewName").value.trim(),
      code: document.getElementById("crewCode").value.trim() || null,
      parent_id: parentVal ? Number(parentVal) : null,
      color: getCrewColorForPayload(),
      sort_order: Number(document.getElementById("crewSort").value || 0),
      is_active: document.getElementById("crewActive").checked,
      // Vendor link only meaningful for parent crews; null for children.
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