// Settings → Roles & Permissions. Admin-only. Create roles and manage the
// default capabilities for each role (the admin role is locked). Capabilities
// themselves are code-defined; here you assign which roles get them.
import { api } from "../api.js";
import { setShell } from "../shell.js";

const CAP_LABELS = {
  "page.dashboard": "Projects (dashboard)",
  "page.financials": "Financials",
  "page.estimate": "Estimate",
  "page.schedule": "Schedule",
  "page.assignment": "Assignment",
  "page.teams": "Teams",
  "page.users": "Users",
  "page.quickbooks": "QuickBooks",
  "page.cashflow": "Cash Flow",
  "page.crew_portal": "Crew Portal",
  "page.customers": "Customers & Jobs",
  "page.settings": "Settings (roles)",
  "project.view_all": "See all projects (not just assigned)",
  "assignment.edit_any": "Edit any project's schedule",
  "assignment.edit_own": "Edit own assigned schedule items",
  "users.manage": "Manage users & permissions",
  "teams.manage": "Manage PMs & work crews",
  "qbo.sync": "Run QuickBooks syncs",
  "projects.admin_tools": "Project admin tools (refresh/reset)",
};
const capLabel = (c) => CAP_LABELS[c] || c;
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

export async function settingsPage(routeFn) {
  let data;
  try {
    data = await api("/roles");
  } catch (e) {
    mount(`<div class="mx-auto w-full max-w-3xl"><div class="card p-5 text-sm text-red-700">Failed to load roles: ${esc(e.message || e)}</div></div>`, routeFn);
    return;
  }
  const roles = data.roles || [];
  const allCaps = data.all_capabilities || [];
  const pageCaps = allCaps.filter(c => c.startsWith("page."));
  const actionCaps = allCaps.filter(c => !c.startsWith("page."));

  // A capability checkbox grid for a role (disabled for the locked admin role).
  const capGrid = (role) => {
    const have = new Set(role.capabilities || []);
    const group = (title, caps) => `
      <div class="mb-2">
        <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">${title}</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
          ${caps.map(c => `
            <label class="flex items-center gap-2 text-sm ${role.is_admin ? "opacity-60" : ""}">
              <input type="checkbox" value="${esc(c)}" ${have.has(c) ? "checked" : ""} ${role.is_admin ? "disabled" : ""}
                class="h-4 w-4 rounded border-black/25" data-rolecap="${role.id}" />
              <span class="truncate">${esc(capLabel(c))}</span>
            </label>`).join("")}
        </div>
      </div>`;
    return group("Pages", pageCaps) + group("Actions", actionCaps);
  };

  const roleCard = (role) => `
    <details class="card p-0 overflow-hidden" data-role="${role.id}">
      <summary class="px-4 py-3 cursor-pointer list-none flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-base font-extrabold">${esc(role.label || role.name)}</span>
            <span class="text-[11px] font-mono text-black/40">${esc(role.name)}</span>
            ${role.is_admin ? `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-700">locked</span>`
              : role.is_system ? `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-black/10 text-black/50">built-in</span>` : ""}
          </div>
          <div class="text-[11px] text-black/40">${role.user_count} user${role.user_count === 1 ? "" : "s"} · ${(role.capabilities || []).length} capabilities${role.description ? " · " + esc(role.description) : ""}</div>
        </div>
        <span class="text-black/30 text-xs shrink-0">▸</span>
      </summary>
      <div class="px-4 pb-4 border-t border-black/5 pt-3">
        ${role.is_admin ? `<div class="text-xs text-amber-700 mb-3">The admin role always has every capability and can't be changed — this prevents anyone from locking themselves out.</div>` : ""}
        ${role.is_admin ? "" : `
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div><div class="label mb-1">Display name</div><input class="input" data-rolelabel="${role.id}" value="${esc(role.label || "")}" /></div>
            <div><div class="label mb-1">Description</div><input class="input" data-roledesc="${role.id}" value="${esc(role.description || "")}" /></div>
          </div>`}
        ${capGrid(role)}
        <div class="flex items-center justify-between gap-3 mt-3">
          <div>
            ${role.is_system ? "" : `<button class="rounded-lg border border-red-200 text-red-600 px-3 py-1.5 text-sm font-semibold hover:bg-red-50" data-roledelete="${role.id}">Delete role</button>`}
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[11px]" data-rolestatus="${role.id}"></span>
            ${role.is_admin ? "" : `<button class="btn-primary" data-rolesave="${role.id}">Save</button>`}
          </div>
        </div>
      </div>
    </details>`;

  mount(`
    <div class="mx-auto w-full max-w-3xl grid grid-cols-1 gap-3 pb-3">
      <div class="card p-4 flex items-start justify-between gap-3">
        <div>
          <div class="text-lg font-extrabold">Roles &amp; Permissions</div>
          <div class="text-xs text-black/50">Create roles and choose which capabilities each role grants by default. Per-user exceptions are still set on the Users page.</div>
        </div>
        <button id="newRoleBtn" class="btn-primary shrink-0">New role</button>
      </div>
      ${roles.map(roleCard).join("")}
    </div>

    <div id="newRoleModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 w-full max-w-lg flex flex-col" style="max-height:88vh;">
        <div class="flex items-center justify-between mb-3">
          <div class="text-lg font-extrabold">New role</div>
          <button id="nrClose" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>
        <form id="nrForm" class="space-y-3 overflow-y-auto" style="min-height:0;">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div><div class="label mb-1">Key (lowercase)</div><input id="nrName" class="input" placeholder="e.g. viewer" /></div>
            <div><div class="label mb-1">Display name</div><input id="nrLabel" class="input" placeholder="e.g. Read-only viewer" /></div>
          </div>
          <div><div class="label mb-1">Description</div><input id="nrDesc" class="input" /></div>
          <div>
            <div class="label mb-1">Capabilities</div>
            <div class="border border-black/10 rounded-xl p-3">
              <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">Pages</div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 mb-2">
                ${pageCaps.map(c => `<label class="flex items-center gap-2 text-sm"><input type="checkbox" value="${esc(c)}" class="h-4 w-4 rounded border-black/25" data-newcap /> <span class="truncate">${esc(capLabel(c))}</span></label>`).join("")}
              </div>
              <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">Actions</div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                ${actionCaps.map(c => `<label class="flex items-center gap-2 text-sm"><input type="checkbox" value="${esc(c)}" class="h-4 w-4 rounded border-black/25" data-newcap /> <span class="truncate">${esc(capLabel(c))}</span></label>`).join("")}
              </div>
            </div>
          </div>
          <div class="text-sm text-red-700 min-h-[1.25rem]" id="nrMsg"></div>
          <div class="flex justify-end gap-2">
            <button type="button" id="nrCancel" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Cancel</button>
            <button type="submit" class="btn-primary">Create role</button>
          </div>
        </form>
      </div>
    </div>`, routeFn);

  // ---- handlers ----
  const setStatus = (id, text, ok) => {
    const el = document.querySelector(`[data-rolestatus="${id}"]`);
    if (!el) return;
    el.textContent = text;
    el.className = "text-[11px] " + (ok === true ? "text-emerald-600" : ok === false ? "text-red-600" : "text-black/40");
    if (ok === true) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 1500);
  };
  const errDetail = (e) => { let d = e?.message || "Error"; try { const o = JSON.parse(d); if (o && o.detail) d = o.detail; } catch (_) {} return d; };

  document.querySelectorAll("[data-rolesave]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.rolesave;
      const caps = [...document.querySelectorAll(`input[data-rolecap="${id}"]:checked`)].map(c => c.value);
      const label = document.querySelector(`[data-rolelabel="${id}"]`)?.value ?? "";
      const description = document.querySelector(`[data-roledesc="${id}"]`)?.value ?? "";
      setStatus(id, "Saving…");
      try {
        await api(`/roles/${id}`, { method: "PUT", body: JSON.stringify({ label, description, capabilities: caps }) });
        setStatus(id, "Saved ✓", true);
      } catch (e) { setStatus(id, errDetail(e), false); }
    });
  });

  document.querySelectorAll("[data-roledelete]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.roledelete;
      if (!confirm("Delete this role? This can't be undone.")) return;
      try { await api(`/roles/${id}`, { method: "DELETE" }); routeFn(); }
      catch (e) { setStatus(id, errDetail(e), false); }
    });
  });

  // New-role modal
  const modal = document.getElementById("newRoleModal");
  const open = () => { modal.classList.remove("hidden"); modal.classList.add("flex"); };
  const close = () => { modal.classList.add("hidden"); modal.classList.remove("flex"); };
  document.getElementById("newRoleBtn").addEventListener("click", () => {
    document.getElementById("nrName").value = "";
    document.getElementById("nrLabel").value = "";
    document.getElementById("nrDesc").value = "";
    document.getElementById("nrMsg").textContent = "";
    document.querySelectorAll("input[data-newcap]").forEach(c => { c.checked = false; });
    open();
  });
  document.getElementById("nrClose").addEventListener("click", close);
  document.getElementById("nrCancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.getElementById("nrForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("nrMsg");
    msg.textContent = "";
    const payload = {
      name: document.getElementById("nrName").value.trim(),
      label: document.getElementById("nrLabel").value.trim() || null,
      description: document.getElementById("nrDesc").value.trim() || null,
      capabilities: [...document.querySelectorAll("input[data-newcap]:checked")].map(c => c.value),
    };
    try { await api("/roles", { method: "POST", body: JSON.stringify(payload) }); close(); routeFn(); }
    catch (e) { msg.textContent = errDetail(e); }
  });
}

function mount(bodyHtml, routeFn) {
  setShell({ title: "", subtitle: "", bodyHtml, showLogout: true, routeFn });
  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => { if (pageTitleBlock) pageTitleBlock.style.display = ""; }, { once: true });
  }
}
