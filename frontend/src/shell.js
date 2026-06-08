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
    a.addEventListener("click", () => {
      // Only force a routeFn() call when the link's target is the SAME hash
      // as the current location — the browser won't fire `hashchange` in
      // that case, so we'd otherwise miss the re-render. For different-hash
      // links, hashchange fires naturally; calling routeFn here too would
      // mount the destination page twice (race condition that doubles up
      // document-level listeners and breaks stateful UIs like the picker
      // chevron).
      if (a.getAttribute("href") === location.hash) {
        setTimeout(routeFn, 0);
      }
    });
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

function bindMobileNavDrawer() {
  const drawer = document.getElementById("mobileNavDrawer");
  if (!drawer || drawer.dataset.bound) return;
  drawer.dataset.bound = "1";

  const backdrop = document.getElementById("mobileNavBackdrop");
  const sheet    = document.getElementById("mobileNavSheet");
  const openBtn  = document.getElementById("mobileNavMoreBtn");
  const closeBtn = document.getElementById("mobileNavCloseBtn");

  const open = () => {
    drawer.classList.remove("hidden");
    // Force a paint before transitioning so the slide-up plays
    requestAnimationFrame(() => {
      backdrop.classList.remove("opacity-0");
      backdrop.classList.add("opacity-100");
      sheet.classList.remove("translate-y-full");
    });
  };

  const close = () => {
    backdrop.classList.add("opacity-0");
    backdrop.classList.remove("opacity-100");
    sheet.classList.add("translate-y-full");
    setTimeout(() => drawer.classList.add("hidden"), 200);
  };

  openBtn?.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);

  // Tapping any link inside the drawer should dismiss it
  drawer.querySelectorAll('a[href^="#/"]').forEach(a => {
    a.addEventListener("click", close);
  });

  // Close on Escape (helps with desktop testing in a narrow viewport)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !drawer.classList.contains("hidden")) close();
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

  bindSidebarHover();
  bindMobileNavDrawer();
  bindNavHandlers(routeFn);

  window.setTimeout(updateStickyOffsets, 0);

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.classList.toggle("hidden", !showLogout);
}