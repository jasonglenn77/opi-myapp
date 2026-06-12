const API_BASE = "/api";

/** Remember-me behavior:
 * - checked => localStorage (persists)
 * - unchecked => sessionStorage (clears on browser close)
 */
export function setToken(token, remember) {
  clearToken();
  (remember ? localStorage : sessionStorage).setItem("token", token);
}

export function getToken() {
  return localStorage.getItem("token") || sessionStorage.getItem("token");
}

export function clearToken() {
  localStorage.removeItem("token");
  sessionStorage.removeItem("token");
  _me = null;
}

/** Cached current user (role + capabilities + resource links) from /api/me. */
let _me = null;

export async function fetchMe(force = false) {
  if (_me && !force) return _me;
  const data = await api("/me");
  _me = data.user || null;
  return _me;
}

export function getMe() {
  return _me;
}

/** True if the current user has the given capability (e.g. "page.financials"). */
export function hasCapability(cap) {
  const caps = (_me && _me.capabilities) || [];
  return caps.includes(cap);
}

export async function api(path, opts = {}) {
  const token = getToken();
  const headers = Object.assign({}, opts.headers || {});
  if (!(opts.body instanceof FormData)) {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
  }
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(typeof body === "string" ? body : JSON.stringify(body));
    err.status = res.status;     // so callers can distinguish 401/403 from 500/503 etc.
    throw err;
  }
  return body;
}