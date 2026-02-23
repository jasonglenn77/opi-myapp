import { clearToken } from "./api.js";

export function showAuth() {
  document.getElementById("authRoot")?.classList.remove("hidden");
  document.getElementById("shellRoot")?.classList.add("hidden");
}

export function showShell() {
  document.getElementById("authRoot")?.classList.add("hidden");
  document.getElementById("shellRoot")?.classList.remove("hidden");
}

export function brandHeader() {
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

export function bindNavHandlers(routeFn) {
  document.querySelectorAll('a[href^="#/"]').forEach(a => {
    if (a.dataset.bound) return;
    a.addEventListener("click", () => setTimeout(routeFn, 0));
    a.dataset.bound = "1";
  });
}

export function bindGlobalHandlers(routeFn) {
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn && !logoutBtn.dataset.bound) {
    logoutBtn.onclick = () => {
      clearToken();
      location.hash = "#/login";
      routeFn();
    };
    logoutBtn.dataset.bound = "1";
  }
}

export function setShell({ title = "", subtitle = "", bodyHtml = "", showLogout = true, routeFn }) {
  showShell();
  bindGlobalHandlers(routeFn);

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

  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.classList.remove("hidden");

  bindNavHandlers(routeFn);

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.classList.toggle("hidden", !showLogout);
}