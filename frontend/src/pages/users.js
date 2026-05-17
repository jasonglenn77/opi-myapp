import { api } from "../api.js";
import { setShell } from "../shell.js";

export async function usersPage(routeFn) {
  const users = await api("/users");

  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));

  const rows = users.map(u => `
    <tr class="border-b border-black/5">
      <td class="py-2 pr-3 font-semibold">${esc(u.email)}</td>
      <td class="py-2 pr-3">${esc(u.first_name || "")}</td>
      <td class="py-2 pr-3">${esc(u.last_name || "")}</td>
      <td class="py-2 pr-3">
        <span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold ${u.role === "admin" ? "bg-black/10" : "bg-black/5"}">
          ${esc(u.role)}
        </span>
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
            class="flex-1 rounded-xl border border-black/15 px-3 py-2 text-sm font-semibold text-ink-800 hover:bg-black/5 active:bg-black/10 disabled:opacity-50"
            data-disable="${u.id}"
            ${u.is_active ? "" : "disabled"}
          >Disable</button>
        </div>
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
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </div>
            <label class="flex items-center gap-2 text-sm text-black/70 mt-6">
              <input id="userActive" type="checkbox" class="h-4 w-4 rounded border-black/20" checked />
              Active
            </label>
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
      if (e.key === "Escape") closeModal();
    });
    document.body.dataset.usersEscBound = "1";
  }

  // Close buttons
  document.getElementById("closeModalBtn").addEventListener("click", closeModal);
  document.getElementById("cancelBtn").addEventListener("click", closeModal);

  document.getElementById("newUserBtn").addEventListener("click", () => {
    document.getElementById("userId").value = "";
    document.getElementById("firstName").value = "";
    document.getElementById("lastName").value = "";
    document.getElementById("userEmail").value = "";
    document.getElementById("userRole").value = "user";
    document.getElementById("userActive").checked = true;
    document.getElementById("userPassword").value = "";
    openModal("New user");
  });

  // Wire edit/disable buttons
  document.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-edit");
      const u = users.find(x => String(x.id) === String(id));
      if (!u) return;

      document.getElementById("userId").value = u.id;
      document.getElementById("firstName").value = u.first_name || "";
      document.getElementById("lastName").value = u.last_name || "";
      document.getElementById("userEmail").value = u.email || "";
      document.getElementById("userRole").value = (u.role || "user").toLowerCase();
      document.getElementById("userActive").checked = !!u.is_active;
      document.getElementById("userPassword").value = "";
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
    const payload = {
      email: document.getElementById("userEmail").value.trim(),
      first_name: document.getElementById("firstName").value.trim() || null,
      last_name: document.getElementById("lastName").value.trim() || null,
      role: document.getElementById("userRole").value,
      is_active: document.getElementById("userActive").checked,
      password: document.getElementById("userPassword").value || null
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
}