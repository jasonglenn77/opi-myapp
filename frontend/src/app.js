import { getToken, clearToken, fetchMe, getMe, hasCapability } from "./api.js";
import { setShell, applyNavPermissions } from "./shell.js";
import { loginPage } from "./pages/login.js";
import { setPasswordPage } from "./pages/set-password.js";
import { dashboardPage } from "./pages/dashboard.js";
import { projectsHubPage } from "./pages/projects-hub.js";
import { projectsPage } from "./pages/projects.js";
import { schedulePage } from "./pages/schedule.js";
import { assignmentPage } from "./pages/assignment.js";
import { usersPage } from "./pages/users.js";
import { teamsPage } from "./pages/teams.js";
import { quickBooksPage } from "./pages/quickbooks.js";
import { estimatePage } from "./pages/estimate.js";
import { cashflowPage } from "./pages/cashflow.js";
import { crewPortalPage } from "./pages/crew.js";
import { crewOpsPage } from "./pages/crew-ops.js";
import { customersPage } from "./pages/customers.js";
import { contactsPage } from "./pages/contacts.js";
import { pipelinePage } from "./pages/opportunities.js";
import { settingsPage, lookupValuesPage, rateTablesPage } from "./pages/settings.js";
import { estimateTrackingPage } from "./pages/estimate-tracking.js";
import { entityDetailPage } from "./pages/entity-detail.js";
// Base Quoting Metrics is embedded inside the Estimate page now; the standalone
// route is intentionally retired. The mountable function is still exported from
// base-quoting-metrics.js and is consumed by estimate.js.

// Which capability each route requires (mirrors backend page.* capabilities).
const ROUTE_CAPS = {
  "#/projects":   "page.dashboard",
  "#/financials": "page.financials",
  "#/cashflow":   "page.cashflow",
  "#/customers":  "page.customers",
  "#/pipeline":   "page.estimate",
  "#/estimate":   "page.estimate",
  "#/schedule":   "page.schedule",
  "#/assignment": "page.assignment",
  "#/crew-ops":   "page.assignment",
  "#/teams":      "page.teams",
  "#/users":      "page.users",
  "#/quickbooks": "page.quickbooks",
  "#/settings":   "page.settings",
  "#/crew": "page.crew_portal",
};

// Preference order for choosing a landing page the user is actually allowed to see.
const ROUTE_ORDER = [
  "#/projects", "#/financials", "#/cashflow", "#/customers", "#/estimate", "#/schedule",
  "#/assignment", "#/crew-ops", "#/crew", "#/teams", "#/users", "#/settings", "#/quickbooks",
];

function requiredCapForHash(hash) {
  if (hash.startsWith("#/entity/")) return "page.customers";
  if (hash.startsWith("#/estimate") || hash === "#/base-quoting-metrics") return "page.estimate";
  if (hash.startsWith("#/crew") && !hash.startsWith("#/crew-ops")) return "page.crew_portal";
  return ROUTE_CAPS[hash] || null;
}

function firstAllowedRoute() {
  return ROUTE_ORDER.find((r) => hasCapability(ROUTE_CAPS[r])) || null;
}

function renderNoAccess() {
  setShell({
    title: "No access",
    subtitle: "",
    bodyHtml: `<div class="card p-6">Your account doesn't have access to any pages yet. Please contact an administrator.</div>`,
    routeFn: route,
  });
}

async function route() {
  const hash = location.hash || "#/projects";

  // Auto-login UX: if token exists, validate via /me before rendering the landing page.
  // Only clear the token on genuine auth failures (401/403). Transient server errors
  // (500, 503, network blips) must NOT log the user out — those tokens are still valid.
  if (hash !== "#/login" && !hash.startsWith("#/set-password")) {
    const token = getToken();
    if (!token) {
      location.hash = "#/login";
      return loginPage(route);
    }
    if (!getMe()) {
      // Cold start only: we have no cached user yet, so block on /me once to
      // validate the token and load capabilities before rendering/guarding.
      try {
        await fetchMe(true);
      } catch (err) {
        if (err && (err.status === 401 || err.status === 403)) {
          clearToken();
          location.hash = "#/login";
          return loginPage(route);
        }
        // Transient error (500/503/network): keep the user signed in and let the
        // target page render; its own API calls surface backend errors.
        console.warn("Token validation skipped (transient error):", err?.message || err);
      }
    } else {
      // Warm navigation: render instantly from the cached user and refresh /me
      // in the background so an admin's permission change is still picked up —
      // without blocking every nav click on a round-trip.
      fetchMe(true)
        .then(() => applyNavPermissions())
        .catch((err) => {
          if (err && (err.status === 401 || err.status === 403)) {
            clearToken();
            location.hash = "#/login";
            route();
          }
        });
    }

    // Reflect capabilities in the nav (no-op if /me was unavailable).
    applyNavPermissions();

    // Route guard (UI only; the backend enforces too). If we have a known user
    // and they lack the target page's capability, send them somewhere allowed.
    if (getMe()) {
      const needed = requiredCapForHash(hash);
      if (needed && !hasCapability(needed)) {
        const dest = firstAllowedRoute();
        if (dest && dest !== hash) {
          location.hash = dest;
          return;
        }
        return renderNoAccess();
      }
    }
  }

  if (hash === "#/login") return loginPage(route);
  if (hash.startsWith("#/set-password")) return setPasswordPage(route);
  if (hash === "#/projects") return projectsHubPage(route);
  if (hash === "#/financials") return projectsPage(route);
  if (hash === "#/cashflow") return cashflowPage(route);
  if (hash === "#/customers") return customersPage(route);
  if (hash === "#/contacts") return contactsPage(route);
  if (hash === "#/pipeline") return pipelinePage(route);
  if (hash.startsWith("#/entity/")) {
    const m = hash.match(/^#\/entity\/(estimate|job|project)\/(.+)$/);
    if (m) return entityDetailPage(route, { entityType: m[1], entityId: decodeURIComponent(m[2]) });
    location.hash = "#/customers";
    return;
  }
  if (hash === "#/settings/lookups") return lookupValuesPage(route);
  if (hash === "#/settings/rates") return rateTablesPage(route);
  if (hash === "#/settings" || hash.startsWith("#/settings/")) return settingsPage(route);
  if (hash.startsWith("#/crew") && !hash.startsWith("#/crew-ops")) {
    const cm = hash.match(/^#\/crew\/child\/([^/]+)(?:\/project\/(.+))?$/);
    if (cm) return crewPortalPage(route, { childId: decodeURIComponent(cm[1]), projectId: cm[2] ? decodeURIComponent(cm[2]) : null });
    return crewPortalPage(route, null);
  }
  // Backward-compat redirects for any old bookmarks; remove after a grace period.
  if (hash === "#/dashboard") { location.hash = "#/projects"; return; }
  if (hash === "#/schedule") return schedulePage(route);
  if (hash === "#/assignment") return assignmentPage(route);
  if (hash === "#/crew-ops") return crewOpsPage(route);
  if (hash === "#/users") return usersPage(route);
  if (hash === "#/teams") return teamsPage(route);
  if (hash === "#/quickbooks") return quickBooksPage(route);
  // Estimates-tracking page retired: the pipeline supersedes estimator/QBO-estimate
  // tracking, and project estimates get a purpose-built view during the project
  // flow. The page fn + endpoints/data are kept for that future buildout.
  if (hash === "#/estimates" || hash.startsWith("#/estimates")) { location.hash = "#/pipeline"; return; }
  if (hash.startsWith("#/estimate") || hash === "#/base-quoting-metrics") return estimatePage(route);

  // placeholder pages
  return dashboardPage(route);
}

window.addEventListener("hashchange", route);
route();
