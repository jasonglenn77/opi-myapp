// Shell management: showing/hiding auth vs main UI, setting page title/subtitle/body, binding global handlers, etc.
import { clearToken, getMe, api } from "./api.js";

/**
 * Show/hide nav (and any other tagged element) based on the current user's
 * capabilities. UX only — the backend still enforces access.
 *   data-cap="page.x"            -> hidden unless the user has that capability
 *   data-cap-any="page.a,page.b" -> hidden unless the user has at least one
 */
export function applyNavPermissions() {
  const me = getMe();
  const allowed = new Set((me && me.capabilities) || []);

  document.querySelectorAll("[data-cap]").forEach((el) => {
    el.classList.toggle("hidden", !allowed.has(el.getAttribute("data-cap")));
  });

  document.querySelectorAll("[data-cap-any]").forEach((el) => {
    const any = (el.getAttribute("data-cap-any") || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    el.classList.toggle("hidden", !any.some((c) => allowed.has(c)));
  });
}

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

// Collapsible nav groups (data-navtoggle / data-navchildren) — lets the sidebar
// squeeze vertically. The group that contains the active route always expands;
// otherwise the last user choice (default collapsed) is restored + persisted.
export function bindNavCollapse() {
  const KEY = (k) => "opi_navcol_" + k;
  const apply = (box, toggle, collapsed) => {
    box.classList.toggle("hidden", collapsed);
    const chev = toggle?.querySelector("[data-navchevron]");
    if (chev) chev.style.transform = collapsed ? "rotate(-90deg)" : "";
  };
  // Teams & Settings start collapsed (they're accessed less often); the rest
  // start expanded. The group holding the active route always expands.
  const DEFAULT_COLLAPSED = new Set(["team", "set"]);
  document.querySelectorAll("[data-navchildren]").forEach((box) => {
    const key = box.getAttribute("data-navchildren");
    const toggle = document.querySelector(`[data-navtoggle="${key}"]`);
    const active = [...box.querySelectorAll("a[href]")].some((a) => a.getAttribute("href") === location.hash);
    let collapsed;
    if (active) collapsed = false;
    else { const saved = localStorage.getItem(KEY(key)); collapsed = saved == null ? DEFAULT_COLLAPSED.has(key) : saved === "1"; }
    apply(box, toggle, collapsed);
    if (toggle && !toggle.dataset.collbound) {
      toggle.dataset.collbound = "1";
      toggle.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const willCollapse = !box.classList.contains("hidden");
        apply(box, toggle, willCollapse);
        try { localStorage.setItem(KEY(key), willCollapse ? "1" : "0"); } catch (_) {}
      });
    }
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
  bindAccountMenu();
}

function bindAccountMenu() {
  const btn = document.getElementById("accountBtn");
  const dropdown = document.getElementById("accountDropdown");
  if (!btn || !dropdown) return;

  // Label the account button/email with the current user.
  const me = getMe();
  const label = document.getElementById("accountLabel");
  const emailEl = document.getElementById("accountEmail");
  if (me && label) label.textContent = me.email || "Account";
  if (me && emailEl) emailEl.textContent = me.email || "";

  if (!btn.dataset.bound) {
    const close = () => dropdown.classList.add("hidden");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.classList.toggle("hidden");
    });
    document.addEventListener("click", (e) => {
      if (!dropdown.contains(e.target) && e.target !== btn) close();
    });
    document.getElementById("changePwBtn")?.addEventListener("click", () => {
      close();
      openPasswordModal();
    });
    btn.dataset.bound = "1";
  }
  bindPasswordModal();
}

function openPasswordModal() {
  const modal = document.getElementById("pwModal");
  if (!modal) return;
  ["pwCurrent", "pwNew", "pwConfirm"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const msg = document.getElementById("pwMsg");
  if (msg) { msg.textContent = ""; msg.className = "text-sm min-h-[1.25rem]"; }
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.getElementById("pwCurrent")?.focus();
}

function bindPasswordModal() {
  const modal = document.getElementById("pwModal");
  const form = document.getElementById("pwForm");
  if (!modal || !form || form.dataset.bound) return;

  const close = () => { modal.classList.add("hidden"); modal.classList.remove("flex"); };
  const msg = document.getElementById("pwMsg");
  const setMsg = (text, ok) => {
    if (!msg) return;
    msg.textContent = text;
    msg.className = "text-sm min-h-[1.25rem] " + (ok ? "text-emerald-700" : "text-red-700");
  };

  document.getElementById("pwCancel")?.addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const current = document.getElementById("pwCurrent")?.value || "";
    const next = document.getElementById("pwNew")?.value || "";
    const confirm = document.getElementById("pwConfirm")?.value || "";
    if (next.length < 8) return setMsg("New password must be at least 8 characters.", false);
    if (next !== confirm) return setMsg("New passwords do not match.", false);

    const submitBtn = document.getElementById("pwSubmit");
    if (submitBtn) submitBtn.disabled = true;
    try {
      await api("/me/password", {
        method: "POST",
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      setMsg("Password updated.", true);
      setTimeout(close, 900);
    } catch (err) {
      let detail = err?.message || "Could not update password.";
      try { const o = JSON.parse(detail); if (o && o.detail) detail = o.detail; } catch (_) {}
      setMsg(detail, false);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
  form.dataset.bound = "1";
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
  bindNavCollapse();

  window.setTimeout(updateStickyOffsets, 0);

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.classList.toggle("hidden", !showLogout);
}