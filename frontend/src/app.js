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
  const headers = Object.assign({}, opts.headers || {});
  if (!(opts.body instanceof FormData)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }

  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(typeof body === "string" ? body : JSON.stringify(body));
  return body;
}

function showAuth() {
  document.getElementById("authRoot")?.classList.remove("hidden");
  document.getElementById("shellRoot")?.classList.add("hidden");
}

function showShell() {
  document.getElementById("authRoot")?.classList.add("hidden");
  document.getElementById("shellRoot")?.classList.remove("hidden");
}

function bindNavHandlers() {
  document.querySelectorAll('a[href^="#/"]').forEach(a => {
    if (a.dataset.bound) return;
    a.addEventListener("click", () => {
      // Ensure routing happens even if hashchange event doesn't fire
      setTimeout(route, 0);
    });
    a.dataset.bound = "1";
  });
}

function bindGlobalHandlers() {
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn && !logoutBtn.dataset.bound) {
    logoutBtn.onclick = () => {
      clearToken();
      location.hash = "#/login";
      route();
    };
    logoutBtn.dataset.bound = "1";
  }
}

function setShell({ title = "", subtitle = "", bodyHtml = "", showLogout = true }) {
  // Ensure shell is visible for app pages
  showShell();
  bindGlobalHandlers();

  // Brand/header is rendered once
  const brandSlot = document.getElementById("brandSlot");
  if (brandSlot && !brandSlot.dataset.ready) {
    brandSlot.innerHTML = brandHeader();
    brandSlot.dataset.ready = "1";
  }

  const pageTitle = document.getElementById("pageTitle");
  const pageSubtitle = document.getElementById("pageSubtitle");
  const pageBody = document.getElementById("pageBody");

  if (pageTitle) pageTitle.textContent = title;
  if (pageSubtitle) pageSubtitle.textContent = subtitle;
  if (pageBody) pageBody.innerHTML = bodyHtml;

  // Sidebar always exists for app pages
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.classList.remove("hidden");

  bindNavHandlers();
  
  // Toggle logout
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.classList.toggle("hidden", !showLogout);
}

function brandHeader() {
  return `
  <div class="flex items-center gap-3">
    <img
      src="/assets/opi-wordmark-light.webp"
      alt="Company Logo"
      loading="eager"
      decoding="sync"
      fetchpriority="high"
      class="h-11 w-11 rounded-2xl shadow-soft object-contain"
    />
    <div>
      <div class="text-white font-extrabold leading-tight">OnPoint Installers</div>
      <div class="text-white/60 text-xs">Internal Ops Portal</div>
    </div>
  </div>`;
}

function loginPage(message = "") {
  showAuth();

  const root = document.getElementById("authRoot");
  if (!root) return;

  root.innerHTML = `
    <div class="w-full max-w-md relative">
      <a
        href="https://www.onpointinstallers.com/"
        target="_blank"
        rel="noopener noreferrer"
        class="fixed top-4 right-4 z-50 inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold bg-white/10 text-white border border-white/20 hover:bg-white/20 backdrop-blur shadow-soft"
        aria-label="Open onpointinstallers.com"
      >
        onpointinstallers.com
        <span aria-hidden="true" class="inline-flex h-5 w-5 items-center justify-center rounded bg-brand-500">
          <svg viewBox="0 0 20 20" fill="none" class="h-3.5 w-3.5">
            <path d="M7 13L13 7" stroke="white" stroke-width="2" stroke-linecap="round"/>
            <path d="M9 7h4v4" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
      </a>

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
  `;

  document.getElementById("loginForm").onsubmit = async (e) => {
    e.preventDefault();

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const remember = document.getElementById("remember").checked;

    try {
      const data = await api("/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });

      setToken(data.access_token, remember);
      location.hash = "#/dashboard";
      route();
    } catch (err) {
      console.error("Login error:", err);
      loginPage("Login failed. Check email/password.");
    }
  };
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

  setShell({
    title: "Dashboard",
    subtitle: "Overview of today’s operational activity.",
    bodyHtml,
    showLogout: true
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
            <button class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5" type="button" id="cancelBtn">Cancel</button>
            <button class="btn-primary" type="submit">Save</button>
          </div>

          <div class="text-sm text-red-700 min-h-[1.25rem]" id="modalMsg"></div>
        </form>
      </div>
    </div>
  `;

  setShell({
    title: "Users",
    subtitle: "Manage application access.",
    bodyHtml,
    showLogout: true
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

async function teamsPage() {
  const [pms, crews] = await Promise.all([
    api("/project-managers"),
    api("/work-crews"),
  ]);

  // Crew helpers
  const parents = crews.filter(c => !c.parent_id);
  const childrenByParent = new Map();
  crews.filter(c => c.parent_id).forEach(c => {
    const k = String(c.parent_id);
    if (!childrenByParent.has(k)) childrenByParent.set(k, []);
    childrenByParent.get(k).push(c);
  });

  const pmRows = pms.map(pm => `
    <tr class="border-b border-black/5">
      <td class="py-2 pr-3 font-semibold">${(pm.first_name || "")} ${(pm.last_name || "")}</td>
      <td class="py-2 pr-3">${pm.email || ""}</td>
      <td class="py-2 pr-3">${pm.phone || ""}</td>
      <td class="py-2 pr-3">${pm.is_active ? "Active" : "Disabled"}</td>
      <td class="py-2 text-right space-x-2">
        <button class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5" data-pm-edit="${pm.id}">Edit</button>
        <button class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5 disabled:opacity-50" data-pm-disable="${pm.id}" ${pm.is_active ? "" : "disabled"}>Disable</button>
      </td>
    </tr>
  `).join("");

  function crewRow(c, indent = 0) {
    return `
      <tr class="border-b border-black/5">
        <td class="py-2 pr-3">
          <div style="padding-left:${indent}px" class="font-semibold">${c.name}</div>
        </td>
        <td class="py-2 pr-3">${c.code || ""}</td>
        <td class="py-2 pr-3">${c.is_active ? "Active" : "Disabled"}</td>
        <td class="py-2 text-right space-x-2">
          <button class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5" data-crew-edit="${c.id}">Edit</button>
          <button class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5 disabled:opacity-50" data-crew-disable="${c.id}" ${c.is_active ? "" : "disabled"}>Disable</button>
        </td>
      </tr>
    `;
  }

  let crewRows = "";
  parents.forEach(p => {
    crewRows += crewRow(p, 0);
    (childrenByParent.get(String(p.id)) || []).forEach(ch => {
      crewRows += crewRow(ch, 18);
    });
  });

  const bodyHtml = `
    <div class="grid grid-cols-1 gap-4">
      <!-- PMs -->
      <div class="card p-5">
        <div class="flex items-center justify-between mb-4">
          <div>
            <div class="text-lg font-extrabold">Project Managers</div>
            <div class="text-sm text-black/60">Add, edit, or disable project managers.</div>
          </div>
          <button id="newPmBtn" class="btn-primary">New PM</button>
        </div>
        <div id="pmMsg" class="text-sm text-red-700 min-h-[1.25rem]"></div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-left text-black/60">
              <tr class="border-b border-black/10">
                <th class="py-2 pr-3">Name</th>
                <th class="py-2 pr-3">Email</th>
                <th class="py-2 pr-3">Phone</th>
                <th class="py-2 pr-3">Status</th>
                <th class="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>${pmRows}</tbody>
          </table>
        </div>
      </div>

      <!-- Crews -->
      <div class="card p-5">
        <div class="flex items-center justify-between mb-4">
          <div>
            <div class="text-lg font-extrabold">Work Crews</div>
            <div class="text-sm text-black/60">Manage crews and sub crews.</div>
          </div>
          <button id="newCrewBtn" class="btn-primary">New crew</button>
        </div>
        <div id="crewMsg" class="text-sm text-red-700 min-h-[1.25rem]"></div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-left text-black/60">
              <tr class="border-b border-black/10">
                <th class="py-2 pr-3">Name</th>
                <th class="py-2 pr-3">Code</th>
                <th class="py-2 pr-3">Status</th>
                <th class="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>${crewRows}</tbody>
          </table>
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
  title: "Teams",
  subtitle: "Manage project managers and work crews.",
  bodyHtml,
  showLogout: true 
});

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
        route();
      } catch {
        document.getElementById("pmMsg").textContent = "Failed to disable project manager.";
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
      is_active: document.getElementById("pmActive").checked,
    };

    try {
      if (!id) await api("/project-managers", { method: "POST", body: JSON.stringify(payload) });
      else await api(`/project-managers/${id}`, { method: "PUT", body: JSON.stringify(payload) });

      closeModal(pmModal);
      location.hash = "#/teams";
      route();
    } catch {
      msg.textContent = "Save failed (duplicate email / permissions).";
    }
  });

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
      document.getElementById("crewSort").value = String(c.sort_order || 0);
      document.getElementById("crewActive").checked = !!c.is_active;
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
        route();
      } catch {
        document.getElementById("crewMsg").textContent = "Failed to disable crew (it may have active sub crews).";
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
      sort_order: Number(document.getElementById("crewSort").value || 0),
      is_active: document.getElementById("crewActive").checked,
    };

    try {
      if (!id) await api("/work-crews", { method: "POST", body: JSON.stringify(payload) });
      else await api(`/work-crews/${id}`, { method: "PUT", body: JSON.stringify(payload) });

      closeModal(crewModal);
      location.hash = "#/teams";
      route();
    } catch {
      msg.textContent = "Save failed (duplicate code / invalid parent).";
    }
  });
}

function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s); // fallback
  return d.toLocaleString();
}

async function quickBooksPage() {
  // Load status from backend
  let status;
  try {
    status = await api("/qbo/status");
  } catch (e) {
    console.error(e);
    status = null;
  }

  const connected = !!status?.connected;
  const last = status?.last_customers_sync || null;

  const lastBadge = !last
    ? `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-black/5">No runs yet</span>`
    : (last.success
        ? `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-green-100 text-green-800">Success</span>`
        : `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-red-100 text-red-800">Failed</span>`);

  const bodyHtml = `
    <div class="grid grid-cols-1 gap-4">

      <!-- Connection -->
      <div class="card p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">QuickBooks Connection</div>
            <div class="text-sm text-black/60">Status of your QBO sandbox connection.</div>
          </div>
          <span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold ${connected ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}">
            ${connected ? "Connected" : "Not connected"}
          </span>
        </div>

        <div class="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div class="rounded-2xl border border-black/5 p-4">
            <div class="text-xs font-bold text-black/60">Realm ID</div>
            <div class="font-semibold mt-1">${status?.realm_id || "—"}</div>
          </div>
          <div class="rounded-2xl border border-black/5 p-4">
            <div class="text-xs font-bold text-black/60">Token expires</div>
            <div class="font-semibold mt-1">${status?.token_expires_at || "—"}</div>
          </div>
          <div class="rounded-2xl border border-black/5 p-4">
            <div class="text-xs font-bold text-black/60">Last customers sync</div>
            <div class="mt-1">${lastBadge}</div>
          </div>
        </div>

        <div class="mt-4 flex flex-wrap gap-2">
          <button id="qboConnectBtn" class="btn-outline">Connect / Reconnect</button>
        </div>

        <div id="qboConnectMsg" class="text-sm text-red-700 min-h-[1.25rem] mt-2"></div>
      </div>

      <!-- Sync -->
      <div class="card p-5">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">Customers Sync</div>
            <div class="text-sm text-black/60">Sync customers from QuickBooks into your database.</div>
          </div>
          <button id="qboSyncBtn" class="btn-primary" ${connected ? "" : "disabled"}>Sync customers now</button>
        </div>

        <div class="mt-4 grid grid-cols-1 md:grid-cols-4 gap-3">
          <div class="rounded-2xl border border-black/5 p-4">
            <div class="text-xs font-bold text-black/60">Started</div>
            <div class="font-semibold mt-1">${last?.started_at ? fmtDate(last.started_at) : "—"}</div>
          </div>
          <div class="rounded-2xl border border-black/5 p-4">
            <div class="text-xs font-bold text-black/60">Finished</div>
            <div class="font-semibold mt-1">${last?.finished_at ? fmtDate(last.finished_at) : "—"}</div>
          </div>
          <div class="rounded-2xl border border-black/5 p-4">
            <div class="text-xs font-bold text-black/60">Fetched</div>
            <div class="font-semibold mt-1">${(last && typeof last.fetched_count !== "undefined") ? last.fetched_count : "—"}</div>
          </div>
          <div class="rounded-2xl border border-black/5 p-4">
            <div class="text-xs font-bold text-black/60">Upserted</div>
            <div class="font-semibold mt-1">${(last && typeof last.upserted_count !== "undefined") ? last.upserted_count : "—"}</div>
          </div>
        </div>

        <div id="qboSyncMsg" class="text-sm text-red-700 min-h-[1.25rem] mt-3"></div>
      </div>

    </div>
  `;

  setShell({
    title: "QuickBooks",
    subtitle: "Connection + manual sync controls.",
    bodyHtml,
    showLogout: true
  });

  // Connect / Reconnect: get auth_url from backend and open it
  document.getElementById("qboConnectBtn").onclick = async () => {
    const msg = document.getElementById("qboConnectMsg");
    msg.textContent = "";
    try {
      const data = await api("/qbo/start");
      if (!data?.auth_url) throw new Error("Missing auth_url");
      window.open(data.auth_url, "_blank", "noopener,noreferrer");
      msg.textContent = "Opened QuickBooks authorization in a new tab.";
      msg.className = "text-sm text-green-700 min-h-[1.25rem] mt-2";
    } catch (e) {
      msg.textContent = "Failed to start QuickBooks auth (check backend logs).";
    }
  };

  // Sync button: blocking call, show loading state, then reload page to refresh status
  const syncBtn = document.getElementById("qboSyncBtn");
  syncBtn.onclick = async () => {
    const msg = document.getElementById("qboSyncMsg");
    msg.textContent = "";
    msg.className = "text-sm text-black/60 min-h-[1.25rem] mt-3";

    syncBtn.disabled = true;
    const original = syncBtn.textContent;
    syncBtn.textContent = "Syncing…";

    try {
      const result = await api("/qbo/sync/customers", { method: "POST" });
      msg.className = "text-sm text-green-700 min-h-[1.25rem] mt-3";
      msg.textContent = `Sync complete. Fetched ${result.customers_fetched}, upserted ${result.customers_upserted}.`;

      // reload status from server and rerender the page
      location.hash = "#/quickbooks";
      route();

    } catch (e) {
      msg.className = "text-sm text-red-700 min-h-[1.25rem] mt-3";
      msg.textContent = "Sync failed. Check backend logs or status error details.";
      syncBtn.disabled = false;
      syncBtn.textContent = original;
    }
  };
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
  if (hash === "#/teams") return teamsPage();
  if (hash === "#/quickbooks") return quickBooksPage();

  // placeholder pages
  return dashboardPage();
}

window.addEventListener("hashchange", route);
route();
