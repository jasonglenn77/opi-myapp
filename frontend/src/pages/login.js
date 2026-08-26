import { api, setToken } from "../api.js";
import { showAuth, brandHeader } from "../shell.js";

export function loginPage(routeFn, message = "") {
  showAuth();

  const root = document.getElementById("authRoot");
  if (!root) return;

  // Friendly note when we bounced here because the session token expired.
  let expiredNote = "";
  try {
    if (sessionStorage.getItem("opi_session_expired")) {
      sessionStorage.removeItem("opi_session_expired");
      expiredNote = "Your session timed out. Please sign in again.";
    }
  } catch (_) {}

  // Friendly note after setting a password via an invite / reset link.
  let setNote = "";
  try {
    if (sessionStorage.getItem("opi_pw_set")) {
      sessionStorage.removeItem("opi_pw_set");
      setNote = "Your password has been set. Please sign in.";
    }
  } catch (_) {}

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
        ${expiredNote ? `<div class="mb-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-sm px-3 py-2">${expiredNote}</div>` : ""}
        ${setNote ? `<div class="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-2">${setNote}</div>` : ""}

        <form id="loginForm" class="space-y-4">
          <div>
            <div class="label mb-1">Email</div>
            <input id="email" class="input" type="email" autocomplete="username"
              placeholder="you@onpointinstallers.com" required />
          </div>

          <div>
            <div class="label mb-1">Password</div>
            <input id="password" class="input" type="password" autocomplete="current-password"
              placeholder="Your password" required />
          </div>

          <label class="flex items-center gap-2 text-sm text-black/70">
            <input id="remember" type="checkbox" class="h-4 w-4 rounded border-black/20" checked />
            Remember me
          </label>

          <button class="btn-primary w-full" type="submit">Sign in</button>

          <div class="text-center">
            <button type="button" id="forgotLink" class="text-sm font-semibold text-brand-600 hover:underline">Forgot password?</button>
          </div>

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
      location.hash = "#/projects";
      routeFn();
    } catch (err) {
      console.error("Login error:", err);
      loginPage(routeFn, "Login failed. Check email/password.");
    }
  };

  document.getElementById("forgotLink").onclick = () => renderForgot(root, routeFn);

  // Forgot-password relies on email delivery — hide it until SMTP is configured.
  api("/config").then((c) => {
    if (c && !c.email_enabled) {
      const fl = document.getElementById("forgotLink");
      if (fl && fl.parentElement) fl.parentElement.classList.add("hidden");
    }
  }).catch(() => {});
}

function renderForgot(root, routeFn) {
  root.innerHTML = `
    <div class="w-full max-w-md">
      <div class="mb-4 flex justify-center">${brandHeader()}</div>
      <div class="card p-6">
        <div class="text-lg font-extrabold mb-1">Reset your password</div>
        <div class="text-sm text-black/60 mb-5">Enter your email and we'll send you a link to set a new password.</div>
        <form id="forgotForm" class="space-y-4">
          <div><div class="label mb-1">Email</div><input id="fpEmail" class="input" type="email" autocomplete="username" required /></div>
          <button class="btn-primary w-full" type="submit">Send reset link</button>
          <div id="fpMsg" class="text-sm min-h-[1.25rem]"></div>
        </form>
        <button type="button" id="backToLogin" class="mt-3 text-sm font-semibold text-brand-600 hover:underline">← Back to sign in</button>
      </div>
      <div class="mt-4 text-center text-xs text-white/50">© ${new Date().getFullYear()} OnPoint Installers</div>
    </div>`;
  document.getElementById("backToLogin").onclick = () => loginPage(routeFn);
  document.getElementById("forgotForm").onsubmit = async (e) => {
    e.preventDefault();
    const msg = document.getElementById("fpMsg");
    const email = document.getElementById("fpEmail").value.trim();
    msg.className = "text-sm min-h-[1.25rem] text-black/60";
    msg.textContent = "Sending…";
    try { await api("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) }); } catch (_) {}
    msg.className = "text-sm min-h-[1.25rem] text-emerald-700";
    msg.textContent = "If that email is registered, a reset link is on its way — check your inbox.";
  };
}