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
    "page.cashflow": "Page: Cash Flow",
    "page.crew_portal": "Page: Crew Portal",
    "page.customers": "Page: Customers & Jobs",
    "page.settings": "Page: Settings (roles)",
    "project.view_all": "See all projects (not just assigned)",
    "assignment.edit_any": "Edit any project's schedule",
    "assignment.edit_own": "Edit own assigned schedule items",
    "users.manage": "Manage users & permissions",
    "teams.manage": "Manage PMs & work crews",
    "qbo.sync": "Run QuickBooks syncs",
    "projects.admin_tools": "Project admin tools (refresh/reset)",
  };
  const capLabel = (c) => CAP_LABELS[c] || c;

  // ---- inline-control styling (borderless until hover/focus = "click to edit") ----
  const INPUT = "w-full min-w-[8rem] bg-transparent rounded px-1.5 py-1 text-sm border border-transparent hover:border-black/15 focus:border-black/30 focus:outline-none focus:ring-1 focus:ring-black/10";
  const SELECT = "bg-transparent rounded px-1.5 py-1 text-sm border border-black/10 hover:border-black/25 focus:outline-none focus:ring-1 focus:ring-black/10";
  const BTN = "rounded-lg border border-black/15 px-2.5 py-1 text-xs font-semibold text-ink-800 hover:bg-black/5";

  const ROLE_OPTS = [
    ["user", "user (office)"], ["admin", "admin"], ["pm", "pm"],
    ["crew_lead", "crew_lead"], ["crew_foreman", "crew_foreman"],
  ];
  const roleOpts = (sel) =>
    ROLE_OPTS.map(([v, t]) => `<option value="${v}" ${sel === v ? "selected" : ""}>${t}</option>`).join("");

  // The PM/crew link selector for a row, depending on its role.
  const linkSelect = (u) => {
    const role = (u.role || "").toLowerCase();
    if (role === "pm") {
      return `<select class="${SELECT} mt-1 w-full" data-field="link" data-linktype="pm" data-id="${u.id}">
        <option value="">— link PM —</option>
        ${pms.map(p => `<option value="${p.id}" ${String(p.id) === String(u.project_manager_id) ? "selected" : ""}>${esc(pmLabel(p))}</option>`).join("")}
      </select>`;
    }
    if (role === "crew_lead" || role === "crew_foreman") {
      return `<select class="${SELECT} mt-1 w-full" data-field="link" data-linktype="crew" data-id="${u.id}">
        <option value="">— link crew —</option>
        ${crews.map(c => `<option value="${c.id}" ${String(c.id) === String(u.work_crew_id) ? "selected" : ""}>${esc(crewLabel(c))}</option>`).join("")}
      </select>`;
    }
    return "";
  };

  const toggle = (u) => `
    <label class="inline-flex items-center gap-2 cursor-pointer">
      <input type="checkbox" data-field="active" data-id="${u.id}" class="sr-only peer" ${u.is_active ? "checked" : ""}>
      <div class="w-9 h-5 bg-black/20 rounded-full relative transition-colors peer-checked:bg-emerald-500 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:bg-white after:rounded-full after:shadow after:transition-transform peer-checked:after:translate-x-4"></div>
      <span data-activelabel="${u.id}" class="text-xs ${u.is_active ? "text-emerald-700" : "text-black/40"}">${u.is_active ? "Active" : "Off"}</span>
    </label>`;

  const cellText = (u, field, val, type) => `<input class="celltext ${INPUT}" data-field="${field}" data-id="${u.id}" data-orig="${esc(val || "")}" value="${esc(val || "")}" ${type ? `type="${type}"` : ""} />`;

  // ---- desktop table ----
  const rows = users.map(u => `
    <tr class="border-b border-black/5 align-top">
      <td class="py-1.5 pr-2 min-w-[14rem]">${cellText(u, "email", u.email, "email")}</td>
      <td class="py-1.5 pr-2">${cellText(u, "first_name", u.first_name)}</td>
      <td class="py-1.5 pr-2">${cellText(u, "last_name", u.last_name)}</td>
      <td class="py-1.5 pr-2 min-w-[12rem]">
        <select class="${SELECT}" data-field="role" data-id="${u.id}">${roleOpts((u.role || "user").toLowerCase())}</select>
        <div data-linkcell="${u.id}">${linkSelect(u)}</div>
      </td>
      <td class="py-1.5 pr-2">${toggle(u)}</td>
      <td class="py-1.5 text-right whitespace-nowrap">
        <span data-status="${u.id}" class="text-[11px] mr-2 align-middle"></span>
        <button class="${BTN}" data-resend="${u.id}" title="Email a set-password link">Invite</button>
        <button class="${BTN}" data-resetpw="${u.id}">Reset pw</button>
        <button class="${BTN}" data-perms="${u.id}">Permissions</button>
      </td>
    </tr>`).join("");

  // ---- mobile/tablet cards (same data-attrs → same handlers) ----
  const cards = users.map(u => `
    <div class="rounded-2xl border border-black/10 bg-white p-4 text-ink-900 flex flex-col gap-2">
      <div class="flex items-center justify-between gap-2">
        <div class="text-xs font-bold text-black/40 uppercase tracking-wide">User #${u.id}</div>
        ${toggle(u)}
      </div>
      <div>
        <div class="label mb-0.5">Email</div>
        ${cellText(u, "email", u.email, "email")}
      </div>
      <div class="grid grid-cols-2 gap-2">
        <div><div class="label mb-0.5">First</div>${cellText(u, "first_name", u.first_name)}</div>
        <div><div class="label mb-0.5">Last</div>${cellText(u, "last_name", u.last_name)}</div>
      </div>
      <div>
        <div class="label mb-0.5">Role</div>
        <select class="${SELECT} w-full" data-field="role" data-id="${u.id}">${roleOpts((u.role || "user").toLowerCase())}</select>
        <div data-linkcell="${u.id}">${linkSelect(u)}</div>
      </div>
      <div class="flex items-center gap-2 pt-1">
        <button class="${BTN} flex-1" data-resend="${u.id}" title="Email a set-password link">Invite</button>
        <button class="${BTN} flex-1" data-resetpw="${u.id}">Reset pw</button>
        <button class="${BTN} flex-1" data-perms="${u.id}">Permissions</button>
        <span data-status="${u.id}" class="text-[11px] shrink-0"></span>
      </div>
    </div>`).join("");

  const bodyHtml = `
    <div class="card p-5">
      <div class="flex items-center justify-between mb-3">
        <div>
          <div class="text-lg font-extrabold">Users</div>
          <div class="text-sm text-black/60">Edit fields directly — changes save automatically.</div>
        </div>
        <div class="flex items-center gap-2">
          <button id="auditLogBtn" class="rounded-xl border border-black/15 px-3 py-2 text-sm font-semibold text-ink-800 hover:bg-black/5">Activity log</button>
          <button id="newUserBtn" class="btn-primary">New user</button>
        </div>
      </div>

      <div id="usersMsg" class="text-sm text-red-700 min-h-[1.25rem]"></div>

      <div class="hidden lg:block overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="text-left text-black/50">
            <tr class="border-b border-black/10">
              <th class="py-2 pr-2 font-semibold">Email</th>
              <th class="py-2 pr-2 font-semibold">First</th>
              <th class="py-2 pr-2 font-semibold">Last</th>
              <th class="py-2 pr-2 font-semibold">Role &amp; link</th>
              <th class="py-2 pr-2 font-semibold">Active</th>
              <th class="py-2 text-right font-semibold"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <div class="lg:hidden flex flex-col gap-3">
        ${cards || `<div class="text-center text-sm text-black/40 py-6">No users.</div>`}
      </div>
    </div>

    ${newUserModalHtml()}
    ${auditModalHtml()}
    ${resetPwModalHtml()}
    ${permsModalHtml()}
  `;

  setShell({ title: "", subtitle: "", bodyHtml, showLogout: true, routeFn });

  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => { if (pageTitleBlock) pageTitleBlock.style.display = ""; }, { once: true });
  }

  // ---------- inline autosave ----------
  const setStatus = (id, state, detail) => {
    document.querySelectorAll(`[data-status="${id}"]`).forEach(el => {
      if (state === "saving") { el.textContent = "Saving…"; el.className = el.className.replace(/text-\S+$/, "") + " text-[11px] mr-2 align-middle text-black/40"; }
      else if (state === "saved") {
        el.textContent = "Saved ✓"; el.className = "text-[11px] mr-2 align-middle text-emerald-600";
        setTimeout(() => { if (el.textContent === "Saved ✓") el.textContent = ""; }, 1500);
      } else { el.textContent = detail || "Error"; el.className = "text-[11px] mr-2 align-middle text-red-600"; }
    });
  };

  async function saveField(id, patch, opts = {}) {
    setStatus(id, "saving");
    try {
      await api(`/users/${id}`, { method: "PUT", body: JSON.stringify(patch) });
      const u = users.find(x => String(x.id) === String(id));
      if (u) Object.assign(u, patch);
      setStatus(id, "saved");
      if (opts.reload) routeFn();
    } catch (e) {
      let d = e?.message || "Error";
      try { const o = JSON.parse(d); if (o && o.detail) d = o.detail; } catch (_) {}
      setStatus(id, "error", d);
    }
  }

  // Text fields: save on blur / Enter, revert on Escape.
  document.querySelectorAll("input.celltext").forEach(inp => {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
      if (e.key === "Escape") { inp.value = inp.dataset.orig || ""; inp.blur(); }
    });
    inp.addEventListener("blur", () => {
      const id = inp.dataset.id, field = inp.dataset.field;
      const val = inp.value.trim();
      if (field === "email" && !val) { setStatus(id, "error", "Email required"); inp.value = inp.dataset.orig || ""; return; }
      const send = field === "email" ? val : (val || null);
      if (String(send ?? "") === String(inp.dataset.orig ?? "")) return;  // unchanged
      inp.dataset.orig = send ?? "";
      saveField(id, { [field]: send });
    });
  });

  // Role change: clear stale links, then re-render so the link picker matches.
  document.querySelectorAll('select[data-field="role"]').forEach(sel => {
    sel.addEventListener("change", () => {
      saveField(sel.dataset.id, { role: sel.value, project_manager_id: null, work_crew_id: null }, { reload: true });
    });
  });

  // Link change: set the relevant id, null the other.
  document.querySelectorAll('select[data-field="link"]').forEach(sel => {
    sel.addEventListener("change", () => {
      const id = sel.dataset.id;
      const val = sel.value ? parseInt(sel.value, 10) : null;
      const patch = sel.dataset.linktype === "pm"
        ? { project_manager_id: val, work_crew_id: null }
        : { work_crew_id: val, project_manager_id: null };
      saveField(id, patch);
    });
  });

  // Active toggle.
  document.querySelectorAll('input[data-field="active"]').forEach(cb => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.id;
      document.querySelectorAll(`[data-activelabel="${id}"]`).forEach(s => {
        s.textContent = cb.checked ? "Active" : "Off";
        s.className = "text-xs " + (cb.checked ? "text-emerald-700" : "text-black/40");
      });
      // keep both layouts' checkboxes in sync
      document.querySelectorAll(`input[data-field="active"][data-id="${id}"]`).forEach(o => { o.checked = cb.checked; });
      saveField(id, { is_active: cb.checked });
    });
  });

  // ---------- New user modal ----------
  const modal = document.getElementById("userModal");
  const modalMsg = document.getElementById("modalMsg");
  const openModal = () => { modalMsg.textContent = ""; modal.classList.remove("hidden"); modal.classList.add("flex"); };
  const closeModal = () => { modal.classList.add("hidden"); modal.classList.remove("flex"); };
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  document.getElementById("closeModalBtn").addEventListener("click", closeModal);
  document.getElementById("cancelBtn").addEventListener("click", closeModal);

  const linkPicker = document.getElementById("linkPicker");
  const linkSel = document.getElementById("linkSelect");
  const linkLabel = document.getElementById("linkLabel");
  const linkHint = document.getElementById("linkHint");
  function syncLinkPicker(role) {
    const opt = (val, text) => `<option value="${val}">${esc(text)}</option>`;
    if (role === "pm") {
      linkLabel.textContent = "Linked project manager";
      linkHint.textContent = "Scopes this login to that PM's projects.";
      linkSel.innerHTML = opt("", "— none —") + pms.map(p => opt(p.id, pmLabel(p))).join("");
      linkPicker.classList.remove("hidden");
    } else if (role === "crew_lead" || role === "crew_foreman") {
      linkLabel.textContent = "Linked work crew";
      linkHint.textContent = role === "crew_lead" ? "Link to a PARENT crew." : "Link to a CHILD crew.";
      linkSel.innerHTML = opt("", "— none —") + crews.map(c => opt(c.id, crewLabel(c))).join("");
      linkPicker.classList.remove("hidden");
    } else { linkPicker.classList.add("hidden"); linkSel.innerHTML = ""; }
  }
  document.getElementById("userRole").addEventListener("change", (e) => syncLinkPicker(e.target.value));
  document.getElementById("newUserBtn").addEventListener("click", () => {
    document.getElementById("firstName").value = "";
    document.getElementById("lastName").value = "";
    document.getElementById("userEmail").value = "";
    document.getElementById("userRole").value = "user";
    document.getElementById("userActive").checked = true;
    document.getElementById("userPassword").value = "";
    const inv = document.getElementById("userInvite");
    if (inv) { inv.checked = true; document.getElementById("pwWrap").classList.add("hidden"); }
    syncLinkPicker("user");
    openModal();
  });
  const inviteChk = document.getElementById("userInvite");
  if (inviteChk) inviteChk.addEventListener("change", () => {
    document.getElementById("pwWrap").classList.toggle("hidden", inviteChk.checked);
  });

  document.getElementById("userForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    modalMsg.textContent = "";
    const role = document.getElementById("userRole").value;
    const linkVal = linkSel.value ? parseInt(linkSel.value, 10) : null;
    const payload = {
      email: document.getElementById("userEmail").value.trim(),
      first_name: document.getElementById("firstName").value.trim() || null,
      last_name: document.getElementById("lastName").value.trim() || null,
      role,
      is_active: document.getElementById("userActive").checked,
      project_manager_id: role === "pm" ? linkVal : null,
      work_crew_id: (role === "crew_lead" || role === "crew_foreman") ? linkVal : null,
    };
    const invite = document.getElementById("userInvite").checked;
    if (invite) {
      payload.send_invite = true;
      payload.password = null;
    } else {
      payload.password = document.getElementById("userPassword").value || null;
      if (!payload.password) { modalMsg.textContent = "Enter a password, or check “Email an invite.”"; return; }
    }
    try {
      const r = await api("/users", { method: "POST", body: JSON.stringify(payload) });
      closeModal();
      if (r && r.invite_link) showInviteLink(payload.email, r.invite_link);
      routeFn();
    } catch (err) {
      modalMsg.textContent = "Save failed (check for duplicate email / permissions).";
    }
  });

  // ---------- Reset password modal ----------
  const rpModal = document.getElementById("resetPwModal");
  const rpMsg = document.getElementById("rpMsg");
  let rpUserId = null;
  const openRp = (id) => {
    rpUserId = id;
    const u = users.find(x => String(x.id) === String(id));
    document.getElementById("rpSubtitle").textContent = u ? u.email : "";
    document.getElementById("rpPassword").value = "";
    rpMsg.textContent = "";
    rpModal.classList.remove("hidden"); rpModal.classList.add("flex");
    document.getElementById("rpPassword").focus();
  };
  const closeRp = () => { rpModal.classList.add("hidden"); rpModal.classList.remove("flex"); };
  rpModal.addEventListener("click", (e) => { if (e.target === rpModal) closeRp(); });
  document.getElementById("rpCancel").addEventListener("click", closeRp);
  document.querySelectorAll("[data-resetpw]").forEach(btn => btn.addEventListener("click", () => openRp(btn.dataset.resetpw)));

  // Resend / send a set-password invite email to a user.
  document.querySelectorAll("[data-resend]").forEach(btn => btn.addEventListener("click", async () => {
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const r = await api(`/users/${btn.dataset.resend}/resend-invite`, { method: "POST" });
      if (r && r.link) { showInviteLink(r.email || "this user", r.link); btn.textContent = orig; }
      else btn.textContent = "Sent ✓";
    } catch (_) { btn.textContent = "Failed"; }
    setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 1800);
  }));

  // ---------- Activity log modal ----------
  const auditModal = document.getElementById("auditModal");
  const closeAudit = () => { auditModal.classList.add("hidden"); auditModal.classList.remove("flex"); };
  document.getElementById("auditLogBtn").addEventListener("click", async () => {
    auditModal.classList.remove("hidden"); auditModal.classList.add("flex");
    const body = document.getElementById("auditBody");
    body.innerHTML = `<div class="text-sm text-black/40 py-4">Loading…</div>`;
    try { body.innerHTML = renderAuditRows(await api("/audit-log?limit=300")); }
    catch (e) { body.innerHTML = `<div class="text-sm text-red-700 py-4">Failed to load activity log: ${e.message || e}</div>`; }
  });
  document.getElementById("auditCloseBtn").addEventListener("click", closeAudit);
  auditModal.addEventListener("click", (e) => { if (e.target === auditModal) closeAudit(); });
  document.getElementById("rpForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = document.getElementById("rpPassword").value;
    if (pw.length < 8) { rpMsg.textContent = "Password must be at least 8 characters."; rpMsg.className = "text-sm text-red-700 min-h-[1.25rem]"; return; }
    try {
      await api(`/users/${rpUserId}`, { method: "PUT", body: JSON.stringify({ password: pw }) });
      rpMsg.textContent = "Password reset.";
      rpMsg.className = "text-sm text-emerald-700 min-h-[1.25rem]";
      setTimeout(closeRp, 800);
    } catch (err) {
      rpMsg.textContent = "Failed to reset password.";
      rpMsg.className = "text-sm text-red-700 min-h-[1.25rem]";
    }
  });

  // ---------- Permissions modal ----------
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
          <select class="${SELECT} shrink-0" style="width:9rem;" data-cap-select="${esc(cap)}">
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
    try { renderPermsRows(await api(`/users/${id}/permissions`)); }
    catch (e) { permsList.innerHTML = `<div class="text-sm text-red-700 py-4">Failed to load permissions.</div>`; }
  }
  document.querySelectorAll("[data-perms]").forEach(btn => btn.addEventListener("click", () => openPermsForUser(btn.getAttribute("data-perms"))));
  document.getElementById("permsSaveBtn").addEventListener("click", async () => {
    permsMsg.textContent = "";
    const overrides = [];
    permsList.querySelectorAll("[data-cap-select]").forEach(sel => {
      if (sel.value === "allow" || sel.value === "deny") overrides.push({ capability: sel.getAttribute("data-cap-select"), effect: sel.value });
    });
    try { await api(`/users/${permsUserId}/permissions`, { method: "PUT", body: JSON.stringify({ overrides }) }); closePerms(); }
    catch (e) { permsMsg.textContent = "Failed to save permissions."; }
  });

  // Esc closes any open modal.
  if (!document.body.dataset.usersEscBound) {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      ["userModal", "resetPwModal", "permsModal"].forEach(idm => {
        const m = document.getElementById(idm);
        if (m) { m.classList.add("hidden"); m.classList.remove("flex"); }
      });
    });
    document.body.dataset.usersEscBound = "1";
  }
}

// ---------- modal markup ----------
// Shown to the admin when email is off (or send failed): copy the invite/reset
// link and hand it to the user directly.
function showInviteLink(email, link) {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const wrap = document.createElement("div");
  wrap.className = "fixed inset-0 flex items-center justify-center bg-black/40 p-4";
  wrap.style.zIndex = "80";
  wrap.innerHTML = `
    <div class="card p-6 w-full max-w-lg">
      <div class="text-lg font-extrabold mb-1">Invite link ready</div>
      <div class="text-sm text-black/60 mb-4">Email delivery isn't set up, so copy this link and send it to <span class="font-semibold text-ink-900">${esc(email)}</span> yourself. It lets them set a password and sign in (expires in 7 days).</div>
      <div class="flex items-center gap-2">
        <input readonly value="${esc(link)}" class="input flex-1 text-xs" id="ilInput" />
        <button class="btn-primary whitespace-nowrap" id="ilCopy">Copy</button>
      </div>
      <div class="flex justify-end mt-4"><button class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5" id="ilDone">Done</button></div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.querySelector("#ilDone").addEventListener("click", close);
  const input = wrap.querySelector("#ilInput");
  wrap.querySelector("#ilCopy").addEventListener("click", async () => {
    input.select();
    try { await navigator.clipboard.writeText(link); } catch (_) { try { document.execCommand("copy"); } catch (e) {} }
    const b = wrap.querySelector("#ilCopy"); b.textContent = "Copied ✓"; setTimeout(() => { b.textContent = "Copy"; }, 1500);
  });
  setTimeout(() => { input.focus(); input.select(); }, 30);
}

function auditModalHtml() {
  return `
    <div id="auditModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 w-full flex flex-col" style="max-width:60rem;max-height:85vh;overflow:hidden;">
        <div class="flex items-center justify-between mb-3">
          <div>
            <div class="text-lg font-extrabold">Activity log</div>
            <div class="text-sm text-black/60">Recent user, role &amp; permission changes — who did what, and when.</div>
          </div>
          <button id="auditCloseBtn" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>
        <div id="auditBody" class="overflow-y-auto" style="flex:1 1 auto;min-height:0;">Loading…</div>
      </div>
    </div>`;
}

function renderAuditRows(rows) {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  if (!rows || !rows.length) return `<div class="text-sm text-black/40 py-6 text-center">No activity recorded yet.</div>`;
  const ACT = {
    "user.create": ["Created user", "bg-emerald-500"], "user.update": ["Updated user", "bg-blue-500"],
    "user.disable": ["Disabled user", "bg-red-500"], "user.invite": ["Sent invite", "bg-indigo-500"],
    "perms.update": ["Changed permissions", "bg-amber-500"], "role.create": ["Created role", "bg-emerald-500"],
    "role.update": ["Updated role", "bg-blue-500"], "role.delete": ["Deleted role", "bg-red-500"],
  };
  const when = (s) => { try { return new Date(String(s).replace(" ", "T") + "Z").toLocaleString(); } catch (_) { return s; } };
  const detail = (r) => {
    const d = r.detail || {};
    if (r.action === "user.update" && Array.isArray(d.fields)) return d.fields.join(", ") || "—";
    if (r.action === "user.create") return `role ${d.role || "?"}${d.invited ? " · invited" : ""}`;
    if (r.action === "perms.update") return `${d.overrides ?? 0} override(s)`;
    if (r.action === "role.create") return `${d.capabilities ?? 0} capabilities`;
    return "";
  };
  const body = rows.map(r => {
    const m = ACT[r.action] || [r.action, "bg-black/40"];
    return `<tr class="border-b border-black/5">
      <td class="py-1.5 pr-3 text-xs text-black/50 whitespace-nowrap tabular-nums">${esc(when(r.created_at))}</td>
      <td class="py-1.5 pr-3 whitespace-nowrap"><span class="inline-flex items-center gap-1.5 text-xs font-semibold text-black/80"><span class="w-1.5 h-1.5 rounded-full ${m[1]}"></span>${esc(m[0])}</span></td>
      <td class="py-1.5 pr-3 text-black/80">${esc(r.target_label || r.target_id || "")}</td>
      <td class="py-1.5 pr-3 text-xs text-black/50">${esc(detail(r))}</td>
      <td class="py-1.5 text-xs text-black/50 whitespace-nowrap">${esc(r.actor_email || "—")}</td>
    </tr>`;
  }).join("");
  return `<table class="w-full text-sm">
    <thead class="text-left text-black/40 text-[11px] uppercase tracking-wide">
      <tr class="border-b border-black/10">
        <th class="py-1.5 pr-3 font-bold">When</th><th class="py-1.5 pr-3 font-bold">Action</th>
        <th class="py-1.5 pr-3 font-bold">Target</th><th class="py-1.5 pr-3 font-bold">Details</th><th class="py-1.5 font-bold">By</th>
      </tr>
    </thead><tbody>${body}</tbody></table>`;
}

function newUserModalHtml() {
  return `
    <div id="userModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 w-full max-w-lg">
        <div class="flex items-center justify-between mb-3">
          <div class="text-lg font-extrabold">New user</div>
          <button id="closeModalBtn" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>
        <form id="userForm" class="space-y-3">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div><div class="label mb-1">First name</div><input id="firstName" class="input" /></div>
            <div><div class="label mb-1">Last name</div><input id="lastName" class="input" /></div>
          </div>
          <div><div class="label mb-1">Email</div><input id="userEmail" class="input" type="email" required /></div>
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
            </div>
            <label class="flex items-center gap-2 text-sm text-black/70 mt-6">
              <input id="userActive" type="checkbox" class="h-4 w-4 rounded border-black/20" checked /> Active
            </label>
          </div>
          <div id="linkPicker" class="hidden">
            <div class="label mb-1" id="linkLabel">Linked record</div>
            <select id="linkSelect" class="input"></select>
            <div class="text-xs text-black/50 mt-1" id="linkHint"></div>
          </div>
          <label class="flex items-center gap-2 text-sm text-black/70">
            <input id="userInvite" type="checkbox" class="h-4 w-4 rounded border-black/20" checked />
            Invite them to set their own password (email it, or copy a link to share)
          </label>
          <div id="pwWrap" class="hidden"><div class="label mb-1">Password</div><input id="userPassword" class="input" type="password" placeholder="Min 8 characters" /></div>
          <div class="flex justify-end gap-2 pt-2">
            <button class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5" type="button" id="cancelBtn">Cancel</button>
            <button class="btn-primary" type="submit">Create user</button>
          </div>
          <div class="text-sm text-red-700 min-h-[1.25rem]" id="modalMsg"></div>
        </form>
      </div>
    </div>`;
}

function resetPwModalHtml() {
  return `
    <div id="resetPwModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 w-full max-w-sm">
        <div class="text-lg font-extrabold">Reset password</div>
        <div class="text-xs text-black/50 mb-3 mt-0.5" id="rpSubtitle"></div>
        <form id="rpForm" class="space-y-3">
          <input id="rpPassword" type="text" autocomplete="off" placeholder="New password (min 8 chars)" class="input" />
          <div class="text-sm text-red-700 min-h-[1.25rem]" id="rpMsg"></div>
          <div class="flex justify-end gap-2">
            <button type="button" id="rpCancel" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Cancel</button>
            <button type="submit" class="btn-primary">Set password</button>
          </div>
        </form>
      </div>
    </div>`;
}

function permsModalHtml() {
  return `
    <div id="permsModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 flex flex-col" style="width:100%; max-width:42rem; max-height:85vh; overflow:hidden;">
        <div class="flex items-center justify-between mb-1">
          <div class="text-lg font-extrabold">Permissions</div>
          <button id="closePermsBtn" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>
        <div class="text-sm text-black/60 mb-3" id="permsSubtitle"></div>
        <div class="text-xs text-black/50 mb-2">Each capability follows the role's default unless you override it. <span class="font-semibold">Allow</span> grants it, <span class="font-semibold">Deny</span> removes it.</div>
        <div id="permsList" class="divide-y divide-black/5 border-y border-black/10" style="flex:1 1 auto; min-height:0; overflow-y:auto;"></div>
        <div class="flex justify-end gap-2 pt-3">
          <button class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5" type="button" id="permsCancelBtn">Cancel</button>
          <button class="btn-primary" type="button" id="permsSaveBtn">Save permissions</button>
        </div>
        <div class="text-sm text-red-700 min-h-[1.25rem]" id="permsMsg"></div>
      </div>
    </div>`;
}
