// Shell management: showing/hiding auth vs main UI, setting page title/subtitle/body, binding global handlers, etc.
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
  <div class="flex items-center gap-3 min-w-0">
    <img
      src="/assets/opi-wordmark-light.webp"
      alt="Company Logo"
      loading="eager"
      decoding="sync"
      fetchpriority="high"
      class="h-10 w-10 sm:h-11 sm:w-11 rounded-2xl shadow-soft object-contain"
    />
    <div class="min-w-0">
      <div class="text-white font-extrabold leading-tight truncate">OnPoint Installers</div>
      <div class="text-white/60 text-xs truncate">Internal Ops Portal</div>
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

function bindSidebarHover() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar || sidebar.dataset.hoverBound) return;
  sidebar.dataset.hoverBound = "1";

  const COLLAPSED = "48px";
  const EXPANDED  = "180px";

  sidebar.addEventListener("mouseenter", () => {
    sidebar.style.width = EXPANDED;
    document.getElementById("navLabel").style.opacity = "1";
    document.querySelectorAll(".nav-label").forEach(el => el.style.opacity = "1");
  });

  sidebar.addEventListener("mouseleave", () => {
    sidebar.style.width = COLLAPSED;
    document.getElementById("navLabel").style.opacity = "0";
    document.querySelectorAll(".nav-label").forEach(el => el.style.opacity = "0");
  });
}

function updateStickyOffsets() {
  const topBar = document.getElementById("topBar");
  const topBarH = topBar ? topBar.getBoundingClientRect().height : 65;

  // Sidebar only — assignment card/thead are no longer viewport-sticky.
  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.style.top = (topBarH + 20) + "px";

  // Dynamically size the assignment card to fill remaining viewport height.
  const card = document.querySelector("#pageBody .card");
  if (card && card.querySelector("#assignTableScroll")) {
    const top = card.getBoundingClientRect().top;
    const available = window.innerHeight - top - 24;
    card.style.height = Math.max(400, available) + "px";
  }
}
window.addEventListener("resize", updateStickyOffsets);

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

  // ✅ Inject page HTML FIRST
  if (pageBody) pageBody.innerHTML = bodyHtml;

  const sidebar = document.getElementById("sidebar");
  if (sidebar) sidebar.classList.remove("hidden");

  bindSidebarHover();
  bindNavHandlers(routeFn);

  window.setTimeout(updateStickyOffsets, 0);

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.classList.toggle("hidden", !showLogout);
}