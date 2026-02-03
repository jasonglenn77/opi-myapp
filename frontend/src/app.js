const API_BASE = "/api";

/** Remember-me behavior:
 * - checked => localStorage (persists)
 * - unchecked => sessionStorage (clears on browser close)
 */
function setToken(token, remember) {
  clearToken();
  (remember ? localStorage : sessionStorage).setItem("token", token);
}
function getToken() {
  return localStorage.getItem("token") || sessionStorage.getItem("token");
}
function clearToken() {
  localStorage.removeItem("token");
  sessionStorage.removeItem("token");
}

async function api(path, opts = {}) {
  const token = getToken();
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(typeof body === "string" ? body : JSON.stringify(body));
  return body;
}

function mount(html) {
  document.getElementById("app").innerHTML = html;
}

function brandHeader() {
  return `
  <div class="flex items-center gap-3">
    <div class="h-11 w-11 rounded-2xl bg-brand-500 shadow-soft"></div>
    <div>
      <div class="text-white font-extrabold leading-tight">OnPoint Installers</div>
      <div class="text-white/60 text-xs">Internal Ops Portal</div>
    </div>
  </div>`;
}

function layoutShell({ title, subtitle, bodyHtml }) {
  return `
  <div class="min-h-screen">
    <div class="border-b border-white/10 bg-ink-900/60 backdrop-blur">
      <div class="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
        ${brandHeader()}
        <button id="logoutBtn" class="btn-outline">Log out</button>
      </div>
    </div>

    <div class="mx-auto max-w-6xl px-4 py-6">
      <div class="mb-5">
        <div class="text-2xl font-extrabold">${title}</div>
        <div class="text-white/60 text-sm">${subtitle}</div>
      </div>

      <div class="grid grid-cols-12 gap-4">
        <aside class="col-span-12 md:col-span-3">
          <div class="card p-4">
            <div class="text-xs font-bold text-black/60 mb-2">Navigation</div>
            <nav class="space-y-2">
              <a href="#/dashboard" class="block rounded-xl px-3 py-2 hover:bg-black/5 font-semibold">Dashboard</a>
              <a href="#/jobs" class="block rounded-xl px-3 py-2 hover:bg-black/5 font-semibold">Jobs</a>
              <a href="#/quotes" class="block rounded-xl px-3 py-2 hover:bg-black/5 font-semibold">Quotes</a>
              <a href="#/invoices" class="block rounded-xl px-3 py-2 hover:bg-black/5 font-semibold">Invoices</a>
              <a href="#/users" class="block rounded-xl px-3 py-2 hover:bg-black/5 font-semibold">Users</a>
              </nav>
          </div>
        </aside>

        <main class="col-span-12 md:col-span-9">
          ${bodyHtml}
        </main>
      </div>
    </div>
  </div>`;
}

function loginPage(message = "") {
  mount(`
  <div class="min-h-screen flex items-center justify-center px-4 relative">
    <!-- Top-right link -->
    <a
      href="https://www.onpointinstallers.com/"
      target="_blank"
      rel="noopener noreferrer"
      class="fixed top-4 right-4 z-50 inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold bg-white/10 text-white border border-white/20 hover:bg-white/20 backdrop-blur shadow-soft"
      aria-label="Open onpointinstallers.com"
    >
      onpointinstallers.com
      <span
        aria-hidden="true"
        class="inline-flex h-5 w-5 items-center justify-center rounded bg-brand-500"
      >
        <svg viewBox="0 0 20 20" fill="none" class="h-3.5 w-3.5">
          <path d="M7 13L13 7" stroke="white" stroke-width="2" stroke-linecap="round"/>
          <path d="M9 7h4v4" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
    </a>
    <div class="w-full max-w-md">
      <div class="mb-4 flex justify-center">
        ${brandHeader()}
      </div>

      <div class="card p-6">
        <div class="text-lg font-extrabold mb-1">Sign in</div>
        <div class="text-sm text-black/60 mb-5">Use your admin credentials to continue.</div>

        <form id="loginForm" class="space-y-4">
          <div>
            <div class="label mb-1">Email</div>
            <input id="email" class="input" type="email" autocomplete="username"
              value="admin@onpointinstallers.com" required />
          </div>

          <div>
            <div class="label mb-1">Password</div>
            <input id="password" class="input" type="password" autocomplete="current-password"
              value="Admin123!" required />
          </div>

          <label class="flex items-center gap-2 text-sm text-black/70">
            <input id="remember" type="checkbox" class="h-4 w-4 rounded border-black/20" checked />
            Remember me
          </label>

          <button class="btn-primary w-full" type="submit">Sign in</button>

          <div class="text-sm text-red-700 min-h-[1.25rem]">${message}</div>
        </form>
      </div>

      <div class="mt-4 text-center text-xs text-white/50">
        © ${new Date().getFullYear()} OnPoint Installers
      </div>
    </div>
  </div>
  `);

  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const remember = document.getElementById("remember").checked;

    try {
      const data = await api("/login", { method: "POST", body: JSON.stringify({ email, password }) });
      setToken(data.access_token, remember);
      location.hash = "#/dashboard";
      await route();
    } catch (err) {
      loginPage("Login failed. Check email/password.");
    }
  });
}

async function dashboardPage() {
  const data = await api("/dashboard");

  const bodyHtml = `
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div class="card p-5">
        <div class="text-xs font-bold text-black/60">Open jobs</div>
        <div class="text-3xl font-extrabold mt-1">${data.stats.open_jobs}</div>
        <div class="text-sm text-black/50 mt-1">Active work orders assigned</div>
      </div>
      <div class="card p-5">
        <div class="text-xs font-bold text-black/60">Quotes pending</div>
        <div class="text-3xl font-extrabold mt-1">${data.stats.quotes_pending}</div>
        <div class="text-sm text-black/50 mt-1">Awaiting approval</div>
      </div>
      <div class="card p-5">
        <div class="text-xs font-bold text-black/60">Invoices due</div>
        <div class="text-3xl font-extrabold mt-1">${data.stats.invoices_due}</div>
        <div class="text-sm text-black/50 mt-1">Needs follow-up</div>
      </div>
    </div>

    <div class="mt-4 card p-5">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-lg font-extrabold">Welcome back</div>
          <div class="text-sm text-black/60">Signed in as <span class="font-semibold">${data.user.email}</span></div>
        </div>
        <div class="h-10 w-10 rounded-2xl bg-brand-500"></div>
      </div>

      <div class="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div class="rounded-2xl border border-black/5 p-4">
          <div class="font-bold">Next step</div>
          <div class="text-sm text-black/60 mt-1">Hook these tiles up to real tables (jobs / quotes / invoices).</div>
        </div>
        <div class="rounded-2xl border border-black/5 p-4">
          <div class="font-bold">Quick action</div>
          <button class="btn-primary mt-2">Create new job</button>
        </div>
      </div>
    </div>
  `;

  mount(layoutShell({
    title: "Dashboard",
    subtitle: "Overview of today’s operational activity.",
    bodyHtml
  }));

  document.getElementById("logoutBtn").addEventListener("click", () => {
    clearToken();
    location.hash = "#/login";
    route();
  });
}

async function usersPage() {
  const users = await api("/users");

  const rows = users.map(u => `
    <tr class="border-b border-black/5">
      <td class="py-2 pr-3 font-semibold">${u.email}</td>
      <td class="py-2 pr-3">${u.first_name || ""}</td>
      <td class="py-2 pr-3">${u.last_name || ""}</td>
      <td class="py-2 pr-3">
        <span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold ${u.role === "admin" ? "bg-black/10" : "bg-black/5"}">
          ${u.role}
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

      <div class="overflow-x-auto">
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
            <button class="btn-outline" type="button" id="cancelBtn">Cancel</button>
            <button class="btn-primary" type="submit">Save</button>
          </div>

          <div class="text-sm text-red-700 min-h-[1.25rem]" id="modalMsg"></div>
        </form>
      </div>
    </div>
  `;

  mount(layoutShell({
    title: "Users",
    subtitle: "Manage application access.",
    bodyHtml
  }));

  // header logout
  document.getElementById("logoutBtn").addEventListener("click", () => {
    clearToken();
    location.hash = "#/login";
    route();
  });

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
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

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
        route();
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
      route();
    } catch (err) {
      modalMsg.textContent = "Save failed (check for duplicate email / permissions).";
    }
  });
}

async function route() {
  const hash = location.hash || "#/dashboard";

  // Auto-login UX: if token exists, validate quickly via /me before rendering dashboard
  if (hash !== "#/login") {
    const token = getToken();
    if (!token) {
      location.hash = "#/login";
      return loginPage();
    }
    try {
      await api("/me");
    } catch {
      clearToken();
      location.hash = "#/login";
      return loginPage();
    }
  }

  if (hash === "#/login") return loginPage();
  if (hash === "#/dashboard") return dashboardPage();
  if (hash === "#/users") return usersPage();

  // placeholder pages
  return dashboardPage();
}

window.addEventListener("hashchange", route);
route();
