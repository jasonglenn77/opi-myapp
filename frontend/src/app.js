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

  // placeholder pages
  return dashboardPage();
}

window.addEventListener("hashchange", route);
route();
