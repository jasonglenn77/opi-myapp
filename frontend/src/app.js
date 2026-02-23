import { api, getToken, clearToken } from "./api.js";
import { loginPage } from "./pages/login.js";
import { dashboardPage } from "./pages/dashboard.js";
import { projectsPage } from "./pages/projects.js";
import { schedulePage } from "./pages/schedule.js";
import { assignmentPage } from "./pages/assignment.js";
import { usersPage } from "./pages/users.js";
import { teamsPage } from "./pages/teams.js";
import { quickBooksPage } from "./pages/quickbooks.js";

async function route() {
  const hash = location.hash || "#/dashboard";

  // Auto-login UX: if token exists, validate quickly via /me before rendering dashboard
  if (hash !== "#/login") {
    const token = getToken();
    if (!token) {
      location.hash = "#/login";
      return loginPage(route);
    }
    try {
      await api("/me");
    } catch {
      clearToken();
      location.hash = "#/login";
      return loginPage(route);
    }
  }

  if (hash === "#/login") return loginPage(route);
  if (hash === "#/dashboard") return dashboardPage(route);
  if (hash === "#/projects") return projectsPage(route);
  if (hash === "#/schedule") return schedulePage(route);
  if (hash === "#/assignment") return assignmentPage(route);
  if (hash === "#/users") return usersPage(route);
  if (hash === "#/teams") return teamsPage(route);
  if (hash === "#/quickbooks") return quickBooksPage(route);

  // placeholder pages
  return dashboardPage(route);
}

window.addEventListener("hashchange", route);
route();
