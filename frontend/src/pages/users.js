import { api } from "../api.js";
import { setShell } from "../shell.js";

export async function usersPage(routeFn) {
  // Users plus the resource records a login can be linked to (PMs / work crews).
  const [users, pms, crews] = await Promise.all([
    api("/users"),
    api("/project-managers").catch(() => []),
    api("/work-crews").catch(() => []),
  ]);

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));

  const pmLabel = (p) => {
    const name = `${p.first_name || ""} ${p.last_name || ""}`.trim();
    return name || p.email || `PM #${p.id}`;
  };
  const crewLabel = (c) => {
    const base = c.name || `Crew #${c.id}`;
    return c.parent_id ? `— ${base}` : base;  // indent sub-crews
  };

  // Friendlier capability labels for the permissions matrix.
  const CAP_LABELS = {
    "page.dashboard": "Page: Projects (dashboard)",
    "page.financials": "Page: Financials",
    "page.estimate": "Page: Estimate",
    "page.schedule": "Page: Schedule",
    "page.assignment": "Page: Assignment",
    "page.teams": "Page: Teams",
    "page.users": "Page: Users",
    "page.quickbooks": "Page: QuickBooks",
    "project.view_all": "See all projects (not just assigned)",
    "assignment.edit_any": "Edit any project's schedule",
    "assignment.edit_own": "Edit own assigned schedule items",
    "users.manage": "Manage users & permissions",
    "teams.manage": "Manage PMs & work crews",
    "qbo.sync": "Run QuickBooks syncs",
    "projects.admin_tools": "Project admin tools (refresh/reset)",
  };
  const capLabel = (c) => CAP_LABELS[c] || c;

  // Small badge showing which PM/crew record a login is linked to.
  const linkBadge = (u) => {
    if (u.project_manager_id != null) {
      const p = pms.find(x => String(x.id) === String(u.project_manager_id));
      return `<div class="text-[11px] text-black/50 mt-0.5">PM: ${esc(p ? pmLabel(p) : "#" + u.project_manager_id)}</div>`;
    }
    if (u.work_crew_id != null) {
      const c = crews.find(x => String(x.id) === String(u.work_crew_id));
      return `<div class="text-[11px] text-black/50 mt-0.5">Crew: ${esc(c ? (c.name || "#" + u.work_crew_id) : "#" + u.work_crew_id)}</div>`;
    }
    return "";
  };

  const rows = users.map(u => `
    <tr class="border-b border-black/5">
      <td class="py-2 pr-3 font-semibold">${esc(u.email)}</td>
      <td class="py-2 pr-3">${esc(u.first_name || "")}</td>
      <td class="py-2 pr-3">${esc(u.last_name || "")}</td>
      <td class="py-2 pr-3">
        <span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold ${u.role === "admin" ? "bg-black/10" : "bg-black/5"}">
          ${esc(u.role)}
        </span>
        ${linkBadge(u)}
      </td>
      <td class="py-2 pr-3">${u.is_active ? "Active" : "Disabled"}</td>
      <td class="py-2 text-right space-x-2">
        <button
          class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5"
          data-edit="${u.id}"
        >
          Edit
        </button>

        <button
          class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5"
          data-perms="${u.id}"
        >
          Permissions
        </button>

        <button
          class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5 disabled:opacity-50"
          data-disable="${u.id}"
          ${u.is_active ? "" : "disabled"}
        >
          Disable
        </button>
      </td>
    </tr>
  `).join("");

  // Mobile/tablet card list — same actions, same data attributes so the
  // existing click handlers fire from either layout.
  const cards = users.map(u => {
    const fullName = `${u.first_name || ""} ${u.last_name || ""}`.trim();
    const displayName = fullName || u.email;
    const roleCls = u.role === "admin" ? "bg-black/10 text-ink-800" : "bg-black/5 text-black/70";
    const statusCls = u.is_active
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : "bg-red-50 text-red-700 border-red-200";
    return `
      <div class="rounded-2xl border border-black/10 bg-white p-4 text-ink-900 flex flex-col gap-2">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="font-extrabold text-sm leading-snug break-words">${esc(displayName)}</div>
            ${fullName ? `<div class="text-xs text-black/60 break-all">${esc(u.email)}</div>` : ""}
          </div>
          <div class="flex flex-col items-end gap-1 shrink-0">
            <span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${roleCls}">${esc(u.role)}</span>
            <span class="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${statusCls}">${u.is_active ? "Active" : "Disabled"}</span>
          </div>
        </div>

        <div class="flex items-center gap-2 pt-1">
          <button
            class="flex-1 rounded-xl border border-black/15 px-3 py-2 text-sm font-semibold text-ink-800 hover:bg-black/5 active:bg-black/10"
            data-edit="${u.id}"
          >Edit</button>
          <button
            class="flex-1 rounded-xl border border-black/15 px-3 py-2 text-sm font-semibold text-ink-800 hover:bg-black/5 active:bg-black/10"
            data-perms="${u.id}"
          >Perms</button>
          <button
            class="flex-1 rounded-xl border border-black/15 px-3 py-2 text-sm font-semibold text-ink-800 hover:bg-black/5 active:bg-black/10 disabled:opacity-50"
            data-disable="${u.id}"
            ${u.is_active ? "" : "disabled"}
          >Disable</button>
        </div>
        ${linkBadge(u)}
      </div>`;
  }).join("");

  const bodyHtml = `
    <div class="card p-5">
      <div class="flex items-center justify-between mb-4">
        <div>
          <div class="text-lg font-extrabold">Users</div>
          <div class="text-sm text-black/60">Add, edit, or disable users.</div>
        </div>
        <button id="newUserBtn" class="btn-primary">New user</button>
      </div>

      <div id="usersMsg" class="text-sm text-red-700 min-h-[1.25rem]"></div>

      <div class="hidden lg:block overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-black/60">
            <tr class="border-b border-black/10">
              <th class="py-2 pr-3">Email</th>
              <th class="py-2 pr-3">First</th>
              <th class="py-2 pr-3">Last</th>
              <th class="py-2 pr-3">Role</th>
              <th class="py-2 pr-3">Status</th>
              <th class="py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <!-- Mobile/tablet card list (hidden on lg+) -->
      <div class="lg:hidden flex flex-col gap-3">
        ${cards || `<div class="text-center text-sm text-black/40 py-6">No users.</div>`}
      </div>
    </div>

    <div id="userModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4">
      <div class="card p-6 w-full max-w-lg">
        <div class="flex items-center justify-between mb-3">
          <div class="text-lg font-extrabold" id="modalTitle">New user</div>
          <button id="closeModalBtn" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>

        <form id="userForm" class="space-y-3">
          <input type="hidden" id="userId" value="" />

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div class="label mb-1">First name</div>
              <input id="firstName" class="input" />
            </div>
            <div>
              <div class="label mb-1">Last name</div>
              <input id="lastName" class="input" />
            </div>
          </div>

          <div>
            <div class="label mb-1">Email</div>
            <input id="userEmail" class="input" type="email" required />
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div class="label mb-1">Role</div>
              <select id="userRole" class="input">
                <option value="user">user (office staff)</option>
                <option value="admin">admin</option>
                <option value="pm">pm (project manager)</option>
                <option value="crew_lead">crew_lead (parent crew / boss)</option>
                <option value="crew_foreman">crew_foreman (child crew)</option>
              </select>
              <div class="text-[11px] text-black/50 mt-1">Choose <b>pm</b>, <b>crew_lead</b>, or <b>crew_foreman</b> to link this login to a Teams record below.</div>
            </div>
            <label class="flex items-center gap-2 text-sm text-black/70 mt-6">
              <input id="userActive" type="checkbox" class="h-4 w-4 rounded border-black/20" checked />
              Active
            </label>
          </div>

          <!-- Resource link: shown only for pm / crew_lead roles -->
          <div id="linkPicker" class="hidden">
            <div class="label mb-1" id="linkLabel">Linked record</div>
            <select id="linkSelect" class="input"></select>
            <div class="text-xs text-black/50 mt-1" id="linkHint"></div>
          </div>

          <div>
            <div class="label mb-1">Password <span class="text-black/40">(leave blank to keep unchanged when editing)</span></div>
            <input id="userPassword" class="input" type="password" />
          </div>

          <div class="flex justify-end gap-2 pt-2">
            <button class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5" type="button" id="cancelBtn">Cancel</button>
            <button class="btn-primary" type="submit">Save</button>
          </div>

          <div class="text-sm text-red-700 min-h-[1.25rem]" id="modalMsg"></div>
        </form>
      </div>
    </div>

    <div id="permsModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 flex flex-col" style="width:100%; max-width:42rem; max-height:85vh; overflow:hidden;">
        <div class="flex items-center justify-between mb-1">
          <div class="text-lg font-extrabold">Permissions</div>
          <button id="closePermsBtn" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>
        <div class="text-sm text-black/60 mb-3" id="permsSubtitle"></div>

        <div class="text-xs text-black/50 mb-2">
          Each capability follows the role's default unless you override it.
          <span class="font-semibold">Allow</span> grants it, <span class="font-semibold">Deny</span> removes it.
        </div>

        <div id="permsList" class="divide-y divide-black/5 border-y border-black/10" style="flex:1 1 auto; min-height:0; overflow-y:auto;"></div>

        <div class="flex justify-end gap-2 pt-3">
          <button class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5" type="button" id="permsCancelBtn">Cancel</button>
          <button class="btn-primary" type="button" id="permsSaveBtn">Save permissions</button>
        </div>
        <div class="text-sm text-red-700 min-h-[1.25rem]" id="permsMsg"></div>
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

  const modal = document.getElementById("userModal");
  const modalMsg = document.getElementById("modalMsg");

  function openModal(title) {
    modalMsg.textContent = "";
    document.getElementById("modalTitle").textContent = title;
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  }

  function closeModal() {
    modal.classList.add("hidden");
    modal.classList.remove("flex");
  }

  // Close by clicking backdrop (but not the dialog itself)
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  // Close on Escape
  if (!document.body.dataset.usersEscBound) {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        document.getElementById("userModal")?.classList.add("hidden");
        document.getElementById("userModal")?.classList.remove("flex");
        document.getElementById("permsModal")?.classList.add("hidden");
        document.getElementById("permsModal")?.classList.remove("flex");
      }
    });
    document.body.dataset.usersEscBound = "1";
  }

  // Close buttons
  document.getElementById("closeModalBtn").addEventListener("click", closeModal);
  document.getElementById("cancelBtn").addEventListener("click", closeModal);

  // Show/populate the PM or crew picker based on the chosen role.
  const linkPicker = document.getElementById("linkPicker");
  const linkSelect = document.getElementById("linkSelect");
  const linkLabel  = document.getElementById("linkLabel");
  const linkHint   = document.getElementById("linkHint");

  function syncLinkPicker(role, selectedId) {
    const opt = (val, text, sel) => `<option value="${val}" ${sel ? "selected" : ""}>${esc(text)}</option>`;
    if (role === "pm") {
      linkLabel.textContent = "Linked project manager";
      linkHint.textContent = "Which Teams-page PM record this login represents (scopes them to that PM's projects).";
      linkSelect.innerHTML = opt("", "— none —", selectedId == null)
        + pms.map(p => opt(p.id, pmLabel(p), String(p.id) === String(selectedId))).join("");
      linkPicker.classList.remove("hidden");
    } else if (role === "crew_lead" || role === "crew_foreman") {
      linkLabel.textContent = "Linked work crew";
      linkHint.textContent = role === "crew_lead"
        ? "Link to a PARENT crew — they'll see all child crews + their projects."
        : "Link to a CHILD crew — the foreman sees only this crew's assigned project(s).";
      linkSelect.innerHTML = opt("", "— none —", selectedId == null)
        + crews.map(c => opt(c.id, crewLabel(c), String(c.id) === String(selectedId))).join("");
      linkPicker.classList.remove("hidden");
    } else {
      linkPicker.classList.add("hidden");
      linkSelect.innerHTML = "";
    }
  }

  document.getElementById("userRole").addEventListener("change", (e) => {
    syncLinkPicker(e.target.value, null);
  });

  document.getElementById("newUserBtn").addEventListener("click", () => {
    document.getElementById("userId").value = "";
    document.getElementById("firstName").value = "";
    document.getElementById("lastName").value = "";
    document.getElementById("userEmail").value = "";
    document.getElementById("userRole").value = "user";
    document.getElementById("userActive").checked = true;
    document.getElementById("userPassword").value = "";
    syncLinkPicker("user", null);
    openModal("New user");
  });

  // Wire edit/disable buttons
  document.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-edit");
      const u = users.find(x => String(x.id) === String(id));
      if (!u) return;

      const role = (u.role || "user").toLowerCase();
      document.getElementById("userId").value = u.id;
      document.getElementById("firstName").value = u.first_name || "";
      document.getElementById("lastName").value = u.last_name || "";
      document.getElementById("userEmail").value = u.email || "";
      document.getElementById("userRole").value = role;
      document.getElementById("userActive").checked = !!u.is_active;
      document.getElementById("userPassword").value = "";
      const linkedId = role === "pm" ? u.project_manager_id
                     : (role === "crew_lead" || role === "crew_foreman") ? u.work_crew_id
                     : null;
      syncLinkPicker(role, linkedId);
      openModal("Edit user");
    });
  });

  document.querySelectorAll("[data-disable]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-disable");
      if (!confirm("Disable this user? They will no longer be able to log in.")) return;
      try {
        await api(`/users/${id}`, { method: "DELETE" });
        location.hash = "#/users";
        routeFn();
      } catch (e) {
        document.getElementById("usersMsg").textContent = "Failed to disable user.";
      }
    });
  });

  // Save (create or update)
  document.getElementById("userForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    modalMsg.textContent = "";

    const id = document.getElementById("userId").value;
    const role = document.getElementById("userRole").value;

    // Only one link applies per role; clear the other so stale links don't linger.
    const linkVal = linkSelect.value ? parseInt(linkSelect.value, 10) : null;
    const project_manager_id = role === "pm" ? linkVal : null;
    const work_crew_id = (role === "crew_lead" || role === "crew_foreman") ? linkVal : null;

    const payload = {
      email: document.getElementById("userEmail").value.trim(),
      first_name: document.getElementById("firstName").value.trim() || null,
      last_name: document.getElementById("lastName").value.trim() || null,
      role,
      is_active: document.getElementById("userActive").checked,
      password: document.getElementById("userPassword").value || null,
      project_manager_id,
      work_crew_id,
    };

    try {
      if (!id) {
        if (!payload.password) {
          modalMsg.textContent = "Password is required for new users.";
          return;
        }
        await api("/users", { method: "POST", body: JSON.stringify(payload) });
      } else {
        // On update: omit password if blank
        if (!payload.password) delete payload.password;
        await api(`/users/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      }
      closeModal();
      location.hash = "#/users";
      routeFn();
    } catch (err) {
      modalMsg.textContent = "Save failed (check for duplicate email / permissions).";
    }
  });

  // ----- Permissions matrix modal -----
  const permsModal = document.getElementById("permsModal");
  const permsList = document.getElementById("permsList");
  const permsMsg = document.getElementById("permsMsg");
  const permsSubtitle = document.getElementById("permsSubtitle");
  let permsUserId = null;

  const openPerms = () => { permsModal.classList.remove("hidden"); permsModal.classList.add("flex"); };
  const closePerms = () => { permsModal.classList.add("hidden"); permsModal.classList.remove("flex"); };

  permsModal.addEventListener("click", (e) => { if (e.target === permsModal) closePerms(); });
  document.getElementById("closePermsBtn").addEventListener("click", closePerms);
  document.getElementById("permsCancelBtn").addEventListener("click", closePerms);

  function renderPermsRows(snapshot) {
    const overrideMap = {};
    for (const o of (snapshot.overrides || [])) overrideMap[o.capability] = o.effect;
    const defaults = new Set(snapshot.defaults || []);
    permsList.innerHTML = (snapshot.all_capabilities || []).map(cap => {
      const cur = overrideMap[cap] || "default";
      const defOn = defaults.has(cap);
      const sel = (v, t) => `<option value="${v}" ${cur === v ? "selected" : ""}>${t}</option>`;
      return `
        <div class="flex items-center justify-between gap-3 py-2">
          <div class="min-w-0">
            <div class="text-sm font-semibold text-ink-900 truncate">${esc(capLabel(cap))}</div>
            <div class="text-[11px] text-black/40">${esc(cap)} · role default: <span class="font-semibold ${defOn ? "text-emerald-600" : "text-black/40"}">${defOn ? "ON" : "off"}</span></div>
          </div>
          <select class="input shrink-0" style="width:9rem;" data-cap-select="${esc(cap)}">
            ${sel("default", `Default (${defOn ? "on" : "off"})`)}
            ${sel("allow", "Allow")}
            ${sel("deny", "Deny")}
          </select>
        </div>`;
    }).join("");
  }

  async function openPermsForUser(id) {
    const u = users.find(x => String(x.id) === String(id));
    permsUserId = id;
    permsMsg.textContent = "";
    permsSubtitle.textContent = u ? `${u.email} — role: ${u.role}` : "";
    permsList.innerHTML = `<div class="text-sm text-black/40 py-4">Loading…</div>`;
    openPerms();
    try {
      const snap = await api(`/users/${id}/permissions`);
      renderPermsRows(snap);
    } catch (e) {
      permsList.innerHTML = `<div class="text-sm text-red-700 py-4">Failed to load permissions.</div>`;
    }
  }

  document.querySelectorAll("[data-perms]").forEach(btn => {
    btn.addEventListener("click", () => openPermsForUser(btn.getAttribute("data-perms")));
  });

  document.getElementById("permsSaveBtn").addEventListener("click", async () => {
    permsMsg.textContent = "";
    const overrides = [];
    permsList.querySelectorAll("[data-cap-select]").forEach(sel => {
      if (sel.value === "allow" || sel.value === "deny") {
        overrides.push({ capability: sel.getAttribute("data-cap-select"), effect: sel.value });
      }
    });
    try {
      await api(`/users/${permsUserId}/permissions`, {
        method: "PUT",
        body: JSON.stringify({ overrides }),
      });
      closePerms();
    } catch (e) {
      permsMsg.textContent = "Failed to save permissions.";
    }
  });
}