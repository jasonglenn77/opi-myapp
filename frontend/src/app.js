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


function fmtMoney(n) {
  const v = Number(n || 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);
}
function fmtPct(n) {
  if (n === null || typeof n === "undefined") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function sortIndicator(key, state) {
  if (state.sortKey !== key) return "";
  return state.sortDir === "asc" ? " ▲" : " ▼";
}

function normalizeStr(v) {
  return String(v ?? "").toLowerCase();
}


async function dashboardPage() {
  const data = await api("/dashboard/projects");
  const rows = data.projects || [];
  const summary = data.summary || null;

  const state = {
    q: "",
    sortKey: "project_name",
    sortDir: "asc",
  };

  const bodyHtml = `
    <div class="card p-5">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-lg font-extrabold">Projects</div>
          <div class="text-sm text-black/60">Snapshot from QBO rollups</div>
        </div>

        <div class="text-sm text-black/60 font-semibold">
          Avg age <span id="avgAgePill" class="inline-flex rounded-full px-2 py-0.5 bg-black/5 text-ink-800 font-bold">— days</span>
        </div>
      </div>

      <div class="mt-3 kpi-grid" id="kpiGrid"></div>
    </div>

    <div class="mt-4 card p-5">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-2">
          <div class="text-sm font-semibold text-black/60">Search</div>
          <input id="searchInput" class="input w-64" placeholder="Project name or QBO id" />
        </div>
      </div>
    </div>

    <div class="mt-4 card p-5">
      <div class="flex items-end justify-between gap-3">
        <div>
          <div class="text-lg font-extrabold">Projects</div>
          <div class="text-sm text-black/60">Scroll + sort by column</div>
        </div>
        <div class="text-sm text-black/60" id="rowCount">—</div>
      </div>

      <div class="mt-4 border border-black/5 bg-white/40 rounded-2xl overflow-hidden">
        <div class="table-scroll">
          <table id="projectsTable" class="text-sm border-collapse w-full min-w-[980px]">
            <thead class="sticky top-0 z-20 bg-white shadow-sm text-left text-black/60 border-b border-black/10">
              <tr>
                ${th("project_name", "Project")}
                ${th("project_balance", "Balance")}
                ${th("total_income", "Income")}
                ${th("total_cost", "Cost")}
                ${th("total_profit", "Profit")}
                ${th("profit_margin", "Margin")}
                ${th("project_create_dttm", "Created")}
                ${th("project_lastupdate_dttm", "Last updated")}
                ${th("total_transaction_ct", "Txns")}
              </tr>
            </thead>
            <tbody id="projectsBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  setShell({
    title: "Dashboard",
    subtitle: "Compact project overview + sortable table.",
    bodyHtml,
    showLogout: true
  });

  function th(key, label) {
    return `
      <th class="py-2 px-3 whitespace-nowrap">
        <button class="font-bold hover:bg-black/5 rounded-xl px-2 py-1" data-sort="${key}">
          ${label}
        </button>
      </th>`;
  }

  function normalize(v) {
    return (v ?? "").toString().toLowerCase();
  }

  function filtered() {
    const q = normalize(state.q);
    return rows.filter(r => {
      if (!q) return true;
      return normalize(r.project_name).includes(q) || normalize(r.project_qbo_id).includes(q);
    });
  }

  function sorted(list) {
    const dir = state.sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = a[state.sortKey];
      const vb = b[state.sortKey];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;

      const na = Number(va), nb = Number(vb);
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return (na - nb) * dir;

      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  function renderKpis(list) {
    const counts = { ALL: rows.length };

    // Prefer backend avg if present
    const avg = (summary && typeof summary.avg_age_days === "number")
      ? summary.avg_age_days
      : null;

    document.getElementById("avgAgePill").textContent =
      avg != null ? `${avg.toFixed(1)} days` : "— days";

    const grid = document.getElementById("kpiGrid");
    grid.innerHTML = `
      ${kpi("Total", counts.ALL || 0)}
      ${kpi("Showing", list.length)}
    `;

    function kpi(label, value) {
      return `
        <div class="rounded-xl border border-black/10 bg-black/5 px-4 py-3">
          <div class="text-xs font-bold text-black/60">${label}</div>
          <div class="text-2xl font-extrabold leading-tight">${value}</div>
        </div>
      `;
    }
  }

  function renderTable() {
    const list = sorted(filtered());
    renderKpis(list);
    document.getElementById("rowCount").textContent = `${list.length} projects`;

    const tbody = document.getElementById("projectsBody");
    tbody.innerHTML = list.map(r => {
      return `
        <tr class="border-b border-black/5">
          <td class="py-2 px-2 font-semibold truncate min-w-[100px]" title="${(r.project_name || "").replaceAll('"','&quot;')}">${r.project_name || ""}</td>
          <td class="py-2 px-2 whitespace-nowrap">${fmtMoney(r.project_balance)}</td>
          <td class="py-2 px-2 whitespace-nowrap">${fmtMoney(r.total_income)}</td>
          <td class="py-2 px-2 whitespace-nowrap">${fmtMoney(r.total_cost)}</td>
          <td class="py-2 px-2 whitespace-nowrap">${fmtMoney(r.total_profit)}</td>
          <td class="py-2 px-2 whitespace-nowrap">${fmtPct(r.profit_margin)}</td>
          <td class="py-2 px-2 whitespace-nowrap">${fmtDate(r.project_create_dttm)}</td>
          <td class="py-2 px-2 whitespace-nowrap">${fmtDate(r.project_lastupdate_dttm)}</td>
          <td class="py-2 px-2 whitespace-nowrap">${r.total_transaction_ct ?? ""}</td>
        </tr>
      `;
    }).join("") || `
      <tr><td class="py-6 text-center text-black/50" colspan="9">No projects match these filters.</td></tr>
    `;
  }

  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.q = e.target.value;
    renderTable();
  });

  document.querySelector("#projectsTable thead").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sort]");
    if (!btn) return;
    const key = btn.getAttribute("data-sort");
    if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else { state.sortKey = key; state.sortDir = "asc"; }
    renderTable();
  });

  renderTable();
}

async function assignmentPage() {
  // Load list of QBO projects
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
    title: "Assign",
    subtitle: "Manage PM/Crew assignments + project timeline.",
    bodyHtml,
    showLogout: true
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

  function escapeHtml(s) {
    return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
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

  const str = String(s).trim();
  let d;

  // "YYYY-MM-DD HH:MM:SS" -> assume UTC
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) {
    d = new Date(str.replace(" ", "T") + "Z");
  }
  // "YYYY-MM-DDTHH:MM:SS" (no timezone) -> assume UTC
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(str)) {
    d = new Date(str + "Z");
  }
  // already has timezone or parseable
  else {
    d = new Date(str);
  }

  if (Number.isNaN(d.getTime())) return str;

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(d);
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
  const lastTx = status?.last_transactions_sync || null;

  const lastBadge = !last
    ? `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-black/5">No runs yet</span>`
    : (last.success
        ? `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-green-100 text-green-800">Success</span>`
        : `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-red-100 text-red-800">Failed</span>`);

  const lastTxBadge = !lastTx
    ? `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-black/5">No runs yet</span>`
    : (lastTx.success
        ? `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-green-100 text-green-800">Success</span>`
        : `<span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold bg-red-100 text-red-800">Failed</span>`);

  const bodyHtml = `
    <div class="grid grid-cols-1 gap-4">

      <!-- Connection -->
      <div class="card p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">QuickBooks Connection</div>
            <div class="text-sm text-black/60">Status of your QBO production connection.</div>
          </div>
          <span class="inline-flex rounded-full px-2 py-0.5 text-xs font-bold ${connected ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}">
            ${connected ? "Connected" : "Not connected"}
          </span>
        </div>

        <div class="mt-4 rounded-2xl border border-black/5 bg-white/40 overflow-hidden">
          <div class="flex flex-wrap items-stretch divide-y sm:divide-y-0 sm:divide-x divide-black/5">
            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Realm ID</div>
              <div class="font-semibold mt-1 truncate">${status?.realm_id || "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Token expires</div>
              <div class="font-semibold mt-1 whitespace-nowrap">${status?.token_expires_at || "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Last customers sync</div>
              <div class="mt-1">${lastBadge}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Last transactions sync</div>
              <div class="mt-1">${lastTxBadge}</div>
            </div>
          </div>
        </div>

        <div class="mt-4 flex flex-wrap gap-2">
          <button id="qboConnectBtn" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Connect / Reconnect</button>
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

        <div class="mt-4 rounded-2xl border border-black/5 bg-white/40 overflow-hidden">
          <div class="flex flex-wrap items-stretch divide-y sm:divide-y-0 sm:divide-x divide-black/5">
            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Started</div>
              <div class="font-semibold mt-1">${last?.started_at ? fmtDate(last.started_at) : "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Finished</div>
              <div class="font-semibold mt-1">${last?.finished_at ? fmtDate(last.finished_at) : "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Fetched</div>
              <div class="font-semibold mt-1">${(last && typeof last.fetched_count !== "undefined") ? last.fetched_count : "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Upserted</div>
              <div class="font-semibold mt-1">${(last && typeof last.upserted_count !== "undefined") ? last.upserted_count : "—"}</div>
            </div>
          </div>
        </div>

        <div id="qboSyncMsg" class="text-sm text-red-700 min-h-[1.25rem] mt-3"></div>
      </div>

      <!-- Transactions Sync -->
      <div class="card p-5">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">Transactions Sync</div>
            <div class="text-sm text-black/60">Sync invoices, bills, purchases, etc. into qbo_transactions + qbo_transaction_lines.</div>
          </div>
          <button id="qboTxSyncBtn" class="btn-primary" ${connected ? "" : "disabled"}>Sync transactions now</button>
        </div>

        <div class="mt-4 rounded-2xl border border-black/5 bg-white/40 overflow-hidden">
          <div class="flex flex-wrap items-stretch divide-y sm:divide-y-0 sm:divide-x divide-black/5">
            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Started</div>
              <div class="font-semibold mt-1">${lastTx?.started_at ? fmtDate(lastTx.started_at) : "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Finished</div>
              <div class="font-semibold mt-1">${lastTx?.finished_at ? fmtDate(lastTx.finished_at) : "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Fetched</div>
              <div class="font-semibold mt-1">${(lastTx && typeof lastTx.fetched_count !== "undefined") ? lastTx.fetched_count : "—"}</div>
            </div>

            <div class="flex-1 min-w-[180px] p-4">
              <div class="text-xs font-bold text-black/60">Upserted</div>
              <div class="font-semibold mt-1">${(lastTx && typeof lastTx.upserted_count !== "undefined") ? lastTx.upserted_count : "—"}</div>
            </div>
          </div>
        </div>

        <div id="qboTxSyncMsg" class="text-sm text-red-700 min-h-[1.25rem] mt-3"></div>
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

  const txBtn = document.getElementById("qboTxSyncBtn");
  txBtn.onclick = async () => {
    const msg = document.getElementById("qboTxSyncMsg");
    msg.textContent = "";
    msg.className = "text-sm text-black/60 min-h-[1.25rem] mt-3";

    txBtn.disabled = true;
    const original = txBtn.textContent;
    txBtn.textContent = "Syncing…";

    try {
      const result = await api("/qbo/sync/transactions", { method: "POST" });
      msg.className = "text-sm text-green-700 min-h-[1.25rem] mt-3";
      msg.textContent = `Sync complete. Fetched ${result.fetched_total}, upserted ${result.transactions_upserted}, lines ${result.lines_upserted}.`;

      location.hash = "#/quickbooks";
      route();
    } catch (e) {
      msg.className = "text-sm text-red-700 min-h-[1.25rem] mt-3";
      msg.textContent = "Transactions sync failed. Check backend logs or status error details.";
      txBtn.disabled = false;
      txBtn.textContent = original;
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
  if (hash === "#/assignment") return assignmentPage();
  if (hash === "#/users") return usersPage();
  if (hash === "#/teams") return teamsPage();
  if (hash === "#/quickbooks") return quickBooksPage();

  // placeholder pages
  return dashboardPage();
}

window.addEventListener("hashchange", route);
route();
