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
  _getCache.clear();
  _getInflight.clear();
}

/** Cached current user (role + capabilities + resource links) from /api/me. */
let _me = null;

// ── Lightweight GET cache ───────────────────────────────────────────────────
// For read-only, sync-fed pages (Customers, hierarchies) so revisiting a page
// within a session is instant instead of re-fetching a large payload every time.
// Cache-first with a TTL; concurrent calls for the same path are de-duped.
const _getCache = new Map();     // path -> { ts, data }
const _getInflight = new Map();  // path -> Promise

/** Cache-first GET. Returns cached data instantly if younger than ttl (ms),
 *  otherwise fetches once and caches. Use only for endpoints where a few
 *  minutes of staleness is acceptable (data comes from periodic QBO sync). */
export async function apiCached(path, ttl = 120000) {
  const hit = _getCache.get(path);
  if (hit && Date.now() - hit.ts < ttl) return hit.data;
  if (_getInflight.has(path)) return _getInflight.get(path);
  const pr = api(path)
    .then((data) => { _getCache.set(path, { ts: Date.now(), data }); _getInflight.delete(path); return data; })
    .catch((err) => { _getInflight.delete(path); throw err; });
  _getInflight.set(path, pr);
  return pr;
}

/** Drop cached GETs — all, or only those whose path contains `prefix`.
 *  Call after a mutation that would change a cached read. */
export function invalidateCache(prefix) {
  if (!prefix) { _getCache.clear(); return; }
  for (const k of [..._getCache.keys()]) if (k.includes(prefix)) _getCache.delete(k);
}

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
    // Token expired/invalid mid-session: instead of surfacing a cryptic
    // "Invalid/expired token" to the user, clear it and bounce to login with a
    // friendly note. Guarded on `token` so a failed *login* (no token yet)
    // doesn't loop. Login page reads opi_session_expired to show the message.
    if (res.status === 401 && token && !location.hash.startsWith("#/login")) {
      clearToken();
      try { sessionStorage.setItem("opi_session_expired", "1"); } catch (_) {}
      location.hash = "#/login";
    }
    const err = new Error(typeof body === "string" ? body : JSON.stringify(body));
    err.status = res.status;     // so callers can distinguish 401/403 from 500/503 etc.
    throw err;
  }
  return body;
}