import { api, getToken, clearToken } from "./api.js";
import { loginPage } from "./pages/login.js";
import { dashboardPage } from "./pages/dashboard.js";
import { projectsPage } from "./pages/projects.js";
import { schedulePage } from "./pages/schedule.js";
import { assignmentPage } from "./pages/assignment.js";
import { usersPage } from "./pages/users.js";
import { teamsPage } from "./pages/teams.js";
import { quickBooksPage } from "./pages/quickbooks.js";
import { estimatePage } from "./pages/estimate.js";
import { baseQuotingMetricsPage } from "./pages/base-quoting-metrics.js";

async function route() {
  const hash = location.hash || "#/projects";

  // Auto-login UX: if token exists, validate quickly via /me before rendering the landing page.
  // Only clear the token on genuine auth failures (401/403). Transient server errors
  // (500, 503, network blips) must NOT log the user out — those tokens are still valid.
  if (hash !== "#/login") {
    const token = getToken();
    if (!token) {
      location.hash = "#/login";
      return loginPage(route);
    }
    try {
      await api("/me");
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) {
        clearToken();
        location.hash = "#/login";
        return loginPage(route);
      }
      // Any other failure: keep the user signed in and let the target page render.
      // The page's own API calls will surface their own errors if the backend is down.
      console.warn("Token validation skipped (transient error):", err?.message || err);
    }
  }

  if (hash === "#/login") return loginPage(route);
  if (hash === "#/projects") return dashboardPage(route);
  if (hash === "#/financials") return projectsPage(route);
  // Backward-compat redirects for any old bookmarks; remove after a grace period.
  if (hash === "#/dashboard") { location.hash = "#/projects"; return; }
  if (hash === "#/schedule") return schedulePage(route);
  if (hash === "#/assignment") return assignmentPage(route);
  if (hash === "#/users") return usersPage(route);
  if (hash === "#/teams") return teamsPage(route);
  if (hash === "#/quickbooks") return quickBooksPage(route);
  if (hash === "#/estimate") return estimatePage(route);
  if (hash === "#/base-quoting-metrics") return baseQuotingMetricsPage(route);

  // placeholder pages
  return dashboardPage(route);
}

window.addEventListener("hashchange", route);
route();
