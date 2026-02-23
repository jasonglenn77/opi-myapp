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
  if (!res.ok) throw new Error(typeof body === "string" ? body : JSON.stringify(body));
  return body;
}