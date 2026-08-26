import { api } from "../api.js";
import { showAuth, brandHeader } from "../shell.js";

// Public page reached from an invite / reset email: #/set-password?token=...
export async function setPasswordPage(routeFn) {
  showAuth();
  const root = document.getElementById("authRoot");
  if (!root) return;

  const qs = new URLSearchParams(location.hash.split("?")[1] || "");
  const token = qs.get("token") || "";

  const shell = (inner) => `
    <div class="w-full max-w-md">
      <div class="mb-4 flex justify-center">${brandHeader()}</div>
      <div class="card p-6">${inner}</div>
      <div class="mt-4 text-center text-xs text-white/50">© ${new Date().getFullYear()} OnPoint Installers</div>
    </div>`;

  root.innerHTML = shell(`<div class="text-sm text-black/60 py-6 text-center">Checking your link…</div>`);

  let info = { valid: false };
  try { info = await api(`/auth/token-info?token=${encodeURIComponent(token)}`); } catch (_) {}

  if (!token || !info.valid) {
    root.innerHTML = shell(`
      <div class="text-lg font-extrabold mb-1">Link expired</div>
      <div class="text-sm text-black/60 mb-5">This password link is invalid or has expired. Ask an admin to re-send your invite, or use “Forgot password?” on the sign-in page.</div>
      <a href="#/login" class="btn-primary w-full inline-block text-center">Back to sign in</a>`);
    return;
  }

  const isInvite = info.purpose === "invite";
  root.innerHTML = shell(`
    <div class="text-lg font-extrabold mb-1">${isInvite ? "Welcome — set your password" : "Choose a new password"}</div>
    <div class="text-sm text-black/60 mb-5">${isInvite ? "You're setting up" : "For"} <span class="font-semibold text-ink-900">${info.email || ""}</span>.</div>
    <form id="spForm" class="space-y-4">
      <div>
        <div class="label mb-1">New password</div>
        <input id="spPw" class="input" type="password" autocomplete="new-password" minlength="8" required />
      </div>
      <div>
        <div class="label mb-1">Confirm password</div>
        <input id="spPw2" class="input" type="password" autocomplete="new-password" required />
      </div>
      <button class="btn-primary w-full" type="submit">${isInvite ? "Set password &amp; continue" : "Update password"}</button>
      <div id="spMsg" class="text-sm text-red-700 min-h-[1.25rem]"></div>
    </form>`);

  document.getElementById("spForm").onsubmit = async (e) => {
    e.preventDefault();
    const msg = document.getElementById("spMsg");
    const pw = document.getElementById("spPw").value;
    const pw2 = document.getElementById("spPw2").value;
    msg.textContent = "";
    if (pw !== pw2) { msg.textContent = "Passwords don't match."; return; }
    try {
      await api("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, password: pw }) });
      try { sessionStorage.setItem("opi_pw_set", "1"); } catch (_) {}
      location.hash = "#/login";
      routeFn();
    } catch (err) {
      msg.textContent = (err && err.message) || "Could not set password. The link may have expired.";
    }
  };
}
