// Crew Field Forms (#/field) — Phase 2. PUBLIC route (like #/set-password):
// no user account. A crew lead types their 4-6 digit passcode once; the device
// remembers a 30-day crew token in localStorage. From there: pick a project,
// pick a form (Kickoff Update / Daily Update / Completion), answer the
// questions, media goes straight to POST /api/forms/upload (into the project's
// S3 Documents tree), submit via POST /api/forms/submit.
//
// Built for phones in the field:
//   * big touch targets, opaque surfaces, explicit dark text (ff-* CSS)
//   * drafts persist to localStorage per project+form (flaky connectivity)
//   * uploads happen immediately with per-file progress, so a submission is
//     just a small JSON POST at the end.
//
// Crew Portal (2026-09-22): home is the AUTHORITATIVE assigned-project list
// from GET /api/crew-portal/my-projects (Active / Upcoming / Past buckets via
// the office assignment chain; boss master code sees every crew's projects).
// Scoping is enforced SERVER-SIDE — a crew token 403s on any project not
// assigned to its crew. Past (completed) projects are read-only: forms render
// disabled, no submit/upload; the PM-curated "10 Crew Documents" folder stays
// viewable. Recents + add-by-number survive only as a "having trouble?"
// fallback; #/field?p=<id> deep links still jump straight in. NO financials
// anywhere on this page (hard rule).
// PM VIEW (Crew Portal step 3): #/field?p=<id>&pmview=1 renders this same
// page authenticated by the PM's normal USER login — no passcode gate, a
// persistent banner, and every submission recorded on behalf of the crew
// (the backend stamps crew_context {on_behalf:true, user, crew}). The home
// project list stays crew-only; pmview always enters via ?p= and routes
// "home" back to the PM Portal.
import { showAuth, brandHeader } from "../shell.js";
import { api, getToken } from "../api.js";
import { escapeHtml } from "../utils/html.js";
import { createFormRenderer, FORM_SHORT, TOGGLE_LABEL } from "../utils/form-render.js";

const TOKEN_KEY = "opi_crew_session";      // {token, crew, role, label}
const RECENT_KEY = "opi_field_recent";     // [{qbo_id, name, ts}]
const DRAFT_KEY = (qbo, form) => `opi_field_draft_${qbo}_${form}`;

const CADENCE_SHORT = {
  one_time: "One-time",
  daily: "Daily",
  every_other_day: "Every other day",
  weekly: "Weekly",
  as_needed: "As needed",
};
const RECURRING = new Set(["daily", "every_other_day", "weekly"]);

// Cadence status hint on the form cards (from GET /forms/templates — the
// backend status engine). Text always present, color is reinforcement only.
function statusHintHtml(t) {
  if (t.required === false) return `<span style="color:rgba(0,0,0,.45);font-weight:700">not required</span>`;
  if (t.cadence === "as_needed" || t.status === "as_needed") {
    return `<span style="color:rgba(0,0,0,.55);font-weight:700">${Number(t.submissions_count || 0)} submitted</span>`;
  }
  // The PM excluded/skipped today for this form (5-day crews, excused days).
  const offBit = t.off_today ? ` · <span style="color:rgba(0,0,0,.45);font-weight:700">off day today</span>` : "";
  switch (t.status) {
    case "done_today": return `<span style="color:#059669;font-weight:800">done today ✓</span>`;
    case "done":       return `<span style="color:#059669;font-weight:800">done ✓</span>` + offBit;
    case "due_today":  return `<span style="color:#b45309;font-weight:800">due today</span>`;
    case "due":        return `<span style="color:#b45309;font-weight:800">due</span>`;
    case "overdue":    return `<span style="color:#b91c1c;font-weight:800">overdue${t.overdue_days ? ` · ${t.overdue_days} missed` : ""}</span>` + offBit;
    case "pending":    return `<span style="color:rgba(0,0,0,.45)">later in the project</span>`;
    case "upcoming":   return `<span style="color:rgba(0,0,0,.45)">upcoming</span>`;
    default:           return "";
  }
}

// ── device session helpers ───────────────────────────────────────────────────
function getSession() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY)) || null; } catch (_) { return null; }
}
function setSession(s) {
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify(s)); } catch (_) {}
}
function clearSession() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
}
function getRecents() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch (_) { return []; }
}
function rememberProject(p) {
  const list = getRecents().filter((r) => String(r.qbo_id) !== String(p.qbo_id));
  list.unshift({ qbo_id: String(p.qbo_id), name: p.name || `Project ${p.qbo_id}`, ts: Date.now() });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8))); } catch (_) {}
}
function loadDraft(qbo, form) {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY(qbo, form))) || null; } catch (_) { return null; }
}
function saveDraft(qbo, form, answers) {
  try { localStorage.setItem(DRAFT_KEY(qbo, form), JSON.stringify({ ts: Date.now(), answers })); } catch (_) {}
}
function clearDraft(qbo, form) {
  try { localStorage.removeItem(DRAFT_KEY(qbo, form)); } catch (_) {}
}

// ── pmview helpers ───────────────────────────────────────────────────────────
const isPmView = () => !!(_state && _state.pmview);
/** Crew token normally; the PM's user token (api.js) in pmview mode. */
function portalApi(path, opts = {}) {
  return isPmView() ? api(path, opts) : crewApi(path, opts);
}
/** 401 handling differs by mode: crews re-enter their code; a PM's expired
 *  user session is handled by api.js (bounce to #/login). Returns true when
 *  it consumed the error. */
function handleAuthError(e, notice) {
  if (e && e.status === 401 && !isPmView()) {
    clearSession();
    renderLogin(notice || "Your session expired — enter your code again.");
    return true;
  }
  return false;
}

// ── crew-token API (parallel to api.js, which is user-token only) ────────────
async function crewApi(path, opts = {}) {
  const sess = getSession();
  const headers = Object.assign({}, opts.headers || {});
  if (!(opts.body instanceof FormData)) headers["Content-Type"] = headers["Content-Type"] || "application/json";
  if (sess?.token) headers["Authorization"] = `Bearer ${sess.token}`;
  const res = await fetch(`/api${path}`, { ...opts, headers });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(typeof body === "string" ? body : (body?.detail || JSON.stringify(body)));
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Upload with progress via XHR (fetch has no upload progress). Uses the crew
 *  token normally, the PM's user token in pmview mode. */
function xhrUpload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const token = isPmView() ? getToken() : getSession()?.token;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText || "{}"); } catch (_) {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else { const err = new Error(body?.detail || `Upload failed (${xhr.status})`); err.status = xhr.status; reject(err); }
    };
    xhr.onerror = () => reject(new Error("Network error — check your connection and try again."));
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}

function crewUpload(projectQboId, formCode, file, onProgress) {
  const qs = `project_qbo_id=${encodeURIComponent(projectQboId)}&form_code=${encodeURIComponent(formCode)}`;
  return xhrUpload(`/api/forms/upload?${qs}`, file, onProgress);
}

/** Receipt file → the project's "8 Receipts" documents folder. */
function receiptUpload(projectQboId, category, file, onProgress) {
  const qs = `project_qbo_id=${encodeURIComponent(projectQboId)}&category=${encodeURIComponent(category)}`;
  return xhrUpload(`/api/receipts/upload?${qs}`, file, onProgress);
}

// ── page entry ───────────────────────────────────────────────────────────────
let _state = null; // per-mount view state

export async function crewFormsPage(routeFn) {
  showAuth();
  const root = document.getElementById("authRoot");
  if (!root) return;

  const qs0 = new URLSearchParams((location.hash.split("?")[1] || ""));
  const pmview = qs0.get("pmview") === "1";
  _state = { root, routeFn, pmview };

  // PM view: the PM's normal user login stands in for the passcode gate; the
  // page always enters at a specific project (?p=) and "home" is the PM Portal.
  if (pmview) {
    const p0 = qs0.get("p");
    if (!getToken() || !p0) { location.hash = p0 ? "#/login" : "#/pm"; return; }
    _state.pmProjectId = p0;
    return openProject(p0);
  }

  const sess = getSession();
  if (!sess?.token) return renderLogin();

  // Remembered device: validate quietly. Only a real 401 clears the token —
  // offline/transient errors keep the session (field connectivity is flaky).
  renderShell(`<div class="ff-card" style="text-align:center"><div class="ff-muted" style="padding:18px 0">Checking your session…</div></div>`);
  try {
    const info = await crewApi("/crew-auth/session");
    setSession({ ...sess, ...info });     // refresh crew/role/label
  } catch (e) {
    if (e.status === 401) { clearSession(); return renderLogin("Your code was changed or expired — enter the new code."); }
    // transient: continue with the stored session
  }

  // Deep link: #/field?p=<project_qbo_id>
  const qs = new URLSearchParams((location.hash.split("?")[1] || ""));
  const p = qs.get("p");
  if (p) return openProject(p);
  renderHome();
}

function renderShell(inner) {
  _state.root.innerHTML = `
    <div class="ff-wrap px-1">
      <div class="mb-4 flex justify-center">${brandHeader()}</div>
      ${inner}
      <div class="mt-4 text-center text-xs text-white/50">© ${new Date().getFullYear()} OnPoint Installers · Field Forms</div>
    </div>`;
}

// ── passcode gate ────────────────────────────────────────────────────────────
function renderLogin(notice) {
  renderShell(`
    <div class="ff-card">
      <div class="ff-h1 mb-1">Crew sign in</div>
      <div class="ff-muted mb-4" style="font-size:14px">Enter your crew code to open the field forms.</div>
      ${notice ? `<div class="ff-err mb-3">${escapeHtml(notice)}</div>` : ""}
      <form id="ffLoginForm">
        <input id="ffCode" class="ff-code-input mb-3" type="password" inputmode="numeric" autocomplete="one-time-code"
               pattern="[0-9]{4,6}" maxlength="6" placeholder="••••" aria-label="Crew code" />
        <button class="ff-btn" type="submit" id="ffLoginBtn">Open forms</button>
        <div id="ffLoginMsg" class="mt-3" style="min-height:22px"></div>
      </form>
      <div class="ff-hint mt-2" style="text-align:center">4-6 digits. Ask the OPI office if you don't have a code.</div>
    </div>`);
  const input = document.getElementById("ffCode");
  input?.focus();
  document.getElementById("ffLoginForm").onsubmit = async (e) => {
    e.preventDefault();
    const code = (input.value || "").trim();
    const msg = document.getElementById("ffLoginMsg");
    const btn = document.getElementById("ffLoginBtn");
    if (!/^\d{4,6}$/.test(code)) { msg.innerHTML = `<div class="ff-err">Enter your 4-6 digit code.</div>`; return; }
    btn.disabled = true; btn.textContent = "Checking…"; msg.innerHTML = "";
    try {
      const d = await crewApi("/crew-auth/login", { method: "POST", body: JSON.stringify({ code }) });
      setSession({ token: d.token, crew: d.crew, role: d.role, label: d.label });
      renderHome();
    } catch (err) {
      btn.disabled = false; btn.textContent = "Open forms";
      msg.innerHTML = `<div class="ff-err">${err.status === 401 ? "That code didn't work. Check it and try again." : "Couldn't sign in: " + escapeHtml(err.message || String(err))}</div>`;
      input.select?.();
    }
  };
}

// ── home: session banner + project picker ────────────────────────────────────
function sessionBanner() {
  if (isPmView()) {
    // Persistent PM-view banner (replaces the crew session banner).
    const back = _state.pmProjectId
      ? `#/pm/project/${encodeURIComponent(_state.pmProjectId)}`
      : "#/pm";
    return `
      <div class="ff-banner mb-3">PM view — you are seeing this project as the crew does; submissions are recorded under your name on behalf of the crew.
        <a href="${back}" style="color:#1d4ed8;font-weight:800;white-space:nowrap">← Back to PM Portal</a>
      </div>`;
  }
  const s = getSession() || {};
  const who = s.role === "boss" ? "Crew boss" : "Lead";
  const crewLine = s.crew?.name ? `<div class="ff-hint">${escapeHtml(s.crew.name)}</div>` : "";
  return `
    <div class="ff-card mb-3" style="display:flex;align-items:center;gap:10px">
      <div style="min-width:0;flex:1">
        <div class="ff-label">${escapeHtml(who)}: ${escapeHtml(s.label || "")}</div>
        ${crewLine}
      </div>
      <button type="button" id="ffSwitch" class="ff-btn2" style="flex:none">Not you? Switch code</button>
    </div>`;
}

function bindSwitch() {
  document.getElementById("ffSwitch")?.addEventListener("click", () => {
    clearSession();
    renderLogin();
  });
}

// ── assigned-project list (server-scoped, the authoritative home) ───────────
function fmtDate(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  return `${m}/${d}/${String(y).slice(2)}`;
}
function fmtRange(a, b) {
  const s = fmtDate(a), e = fmtDate(b);
  if (s && e) return `${s} – ${e}`;
  return s || e || "Dates TBD";
}
function fmtSize(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

async function loadMyProjects(force) {
  if (_state.projects && !force) return _state.projects;
  const d = await crewApi("/crew-portal/my-projects");
  _state.projects = d;
  return d;
}

/** Find a project row + its bucket in the cached my-projects payload. */
function findProjectMeta(qboId) {
  const d = _state.projects;
  if (!d) return null;
  for (const bucket of ["active", "upcoming", "past"]) {
    const row = (d[bucket] || []).find((r) => String(r.qbo_id) === String(qboId));
    if (row) return { row, bucket };
  }
  return null;
}

function projCardHtml(r, past) {
  const badge = past ? ` <span class="ff-badge">completed</span>` : "";
  const pmBit = r.pm_names ? ` · PM: ${escapeHtml(r.pm_names)}` : "";
  return `
    <button type="button" class="ff-row mb-2${past ? " ff-past" : ""}" data-proj="${escapeHtml(r.qbo_id)}">
      <div style="min-width:0;flex:1">
        <div class="ff-label" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.name)}${badge}</div>
        <div class="ff-hint" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.customer || "")}</div>
        <div class="ff-hint">${escapeHtml(fmtRange(r.start_date, r.end_date))}${pmBit}</div>
      </div>
      <span style="color:rgba(0,0,0,.3);font-size:20px">›</span>
    </button>`;
}

async function renderHome(err) {
  renderShell(`<div class="ff-card" style="text-align:center"><div class="ff-muted" style="padding:18px 0">Loading your projects…</div></div>`);
  let data = null, loadErr = null;
  try {
    data = await loadMyProjects(true);
  } catch (e) {
    if (e.status === 401) { clearSession(); return renderLogin("Your session expired — enter your code again."); }
    loadErr = e;                        // transient: fall back to the manual picker
    data = _state.projects;             // any earlier successful load
  }

  const section = (title, list, past) => {
    if (!list || !list.length) return "";
    return `<div class="ff-sechead">${escapeHtml(title)}</div>${list.map((r) => projCardHtml(r, past)).join("")}`;
  };
  const lists = data
    ? section("Active", data.active) + section("Upcoming", data.upcoming) + section("Past", data.past, true)
    : "";
  const none = data && !data.active?.length && !data.upcoming?.length && !data.past?.length
    ? `<div class="ff-note mb-2">No projects are assigned to your crew yet — check with your OPI PM.</div>`
    : "";

  // Secondary fallback only — the list above is authoritative.
  const recents = getRecents();
  const recentRows = recents.map((r) => `
    <button type="button" class="ff-row mb-2" data-proj="${escapeHtml(r.qbo_id)}">
      <div style="min-width:0;flex:1">
        <div class="ff-label" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.name)}</div>
        <div class="ff-hint">Project #${escapeHtml(r.qbo_id)}</div>
      </div>
      <span style="color:rgba(0,0,0,.3);font-size:20px">›</span>
    </button>`).join("");

  renderShell(`
    ${sessionBanner()}
    <div class="ff-card">
      <div class="ff-h1 mb-1">Your projects</div>
      <div class="ff-muted mb-4" style="font-size:14px">Pick the project you're working on.</div>
      ${err ? `<div class="ff-err mb-3">${escapeHtml(err)}</div>` : ""}
      ${loadErr ? `<div class="ff-err mb-3">Couldn't load your project list — check your connection. ${escapeHtml(loadErr.message || String(loadErr))}</div>` : ""}
      ${none}
      ${lists}
      <details class="mt-3">
        <summary class="ff-hint" style="font-weight:700;cursor:pointer">Having trouble? Enter a project #</summary>
        <div class="mt-2">
          ${recentRows}
          <form id="ffAddForm" style="display:flex;gap:8px">
            <input id="ffProjId" class="ff-input" inputmode="numeric" placeholder="Project # from your PM" style="flex:1" />
            <button class="ff-btn" type="submit" style="width:auto;flex:none;padding-left:20px;padding-right:20px">Open</button>
          </form>
        </div>
      </details>
    </div>`);

  bindSwitch();
  document.querySelectorAll("[data-proj]").forEach((b) =>
    b.addEventListener("click", () => openProject(b.getAttribute("data-proj"))));
  document.getElementById("ffAddForm").onsubmit = (e) => {
    e.preventDefault();
    const v = (document.getElementById("ffProjId").value || "").trim();
    if (v) openProject(v);
  };
}

// ── project view: form cards ─────────────────────────────────────────────────
async function openProject(qboId) {
  renderShell(`<div class="ff-card" style="text-align:center"><div class="ff-muted" style="padding:18px 0">Loading project…</div></div>`);
  // Header meta + the past/read-only flag come from the assigned-project
  // list; load it quietly if a deep link skipped home (best effort — the
  // server enforces scope regardless).
  if (!_state.projects && !isPmView()) {   // my-projects stays crew-only
    try { await loadMyProjects(); } catch (e) {
      if (handleAuthError(e)) return;
    }
  }
  let data;
  try {
    data = await portalApi(`/forms/templates?project_qbo_id=${encodeURIComponent(qboId)}`);
  } catch (e) {
    if (handleAuthError(e)) return;
    if (isPmView()) {
      renderShell(`${sessionBanner()}<div class="ff-card"><div class="ff-err">Couldn't load project #${escapeHtml(String(qboId))}: ${escapeHtml(e.message || String(e))}</div></div>`);
      return;
    }
    if (e.status === 403) return renderHome("This project isn't assigned to your crew — check with your PM.");
    return renderHome(e.status === 404
      ? `Project #${qboId} wasn't found. Double-check the number with your PM.`
      : `Couldn't load that project: ${e.message || e}`);
  }
  if (!isPmView()) rememberProject(data.project);
  else _state.pmProjectId = String(data.project?.qbo_id || qboId);
  renderProject(data);
}

function renderProject(data) {
  const proj = data.project;
  const meta = findProjectMeta(proj.qbo_id);
  const past = meta?.bucket === "past";
  const row = meta?.row || {};
  const card = (t) => {
    const secs = (t.definition?.sections || []);
    const enabled = secs.filter((s) => s.enabled);
    const toggled = secs.filter((s) => (s.toggle || "always") !== "always");
    const chips = toggled.length
      ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${toggled.map((s) =>
          `<span class="ff-chip ${s.enabled ? "ff-chip-on" : "ff-chip-off"}">${escapeHtml(TOGGLE_LABEL[s.toggle] || s.title)}${s.enabled ? "" : " off"}</span>`).join("")}</div>`
      : "";
    const draft = past ? null : loadDraft(proj.qbo_id, t.code);
    const notRequired = t.required === false;
    const cadenceBit = t.cadence ? `${escapeHtml(CADENCE_SHORT[t.cadence] || t.cadence)} · ` : "";
    const hint = past
      ? `<span style="color:rgba(0,0,0,.5);font-weight:700">${Number(t.submissions_count || 0)} submitted · view only</span>`
      : statusHintHtml(t);
    return `
      <button type="button" class="ff-row mb-2" data-form="${escapeHtml(t.code)}" ${notRequired ? `style="opacity:.55"` : ""}>
        <div style="min-width:0;flex:1">
          <div class="ff-label">${escapeHtml(FORM_SHORT[t.code] || t.title)}</div>
          <div class="ff-hint">${cadenceBit}${hint}${draft ? ` · <span style="color:#b45309;font-weight:800">draft saved</span>` : ""}</div>
          ${chips}
        </div>
        <span style="color:rgba(0,0,0,.3);font-size:20px">›</span>
      </button>`;
  };

  // Not-required forms stay openable but sit de-emphasized at the bottom.
  const tpls = data.templates || [];
  const requiredCards = tpls.filter((t) => t.required !== false).map(card).join("");
  const optionalTpls = tpls.filter((t) => t.required === false);
  const optionalCards = optionalTpls.length
    ? `<div class="ff-hint mt-3 mb-2" style="font-weight:700">Not required for this project</div>
       ${optionalTpls.map(card).join("")}`
    : "";
  const cards = requiredCards + optionalCards;

  const dates = fmtRange(row.start_date || proj.start_date, row.end_date || proj.end_date);
  const pmBit = row.pm_names ? ` · PM: ${escapeHtml(row.pm_names)}` : "";
  const banner = past ? `<div class="ff-banner mb-3">Project completed — view only</div>` : "";

  const backBtn = isPmView()
    ? `<button type="button" id="ffBackHome" class="ff-btn2 mb-3">← PM Portal</button>`
    : `<button type="button" id="ffBackHome" class="ff-btn2 mb-3">← All projects</button>`;

  renderShell(`
    ${sessionBanner()}
    ${backBtn}
    <div class="ff-card">
      ${banner}
      <div class="ff-h1">${escapeHtml(proj.name || "Project")}</div>
      ${row.customer ? `<div class="ff-hint">${escapeHtml(row.customer)}</div>` : ""}
      <div class="ff-hint mb-4">${escapeHtml(dates)}${pmBit} · Project #${escapeHtml(String(proj.qbo_id))}</div>
      ${cards || `<div class="ff-note">No forms are available right now.</div>`}
    </div>
    <div class="ff-card mt-3">
      <div class="ff-h1" style="font-size:17px">Documents</div>
      <div class="ff-hint mb-2">Shared by your PM for this project.</div>
      <div id="ffDocs"><div class="ff-muted" style="font-size:13px;padding:6px 0">Loading documents…</div></div>
    </div>
    <div class="ff-card mt-3">
      <div class="ff-h1" style="font-size:17px">Receipts</div>
      <div class="ff-hint mb-2">Job receipts — travel, materials, propane/fuel. Snap it as soon as you buy.</div>
      <div id="ffReceipts"><div class="ff-muted" style="font-size:13px;padding:6px 0">Loading receipts…</div></div>
      ${past ? "" : `<button type="button" id="ffRcAdd" class="ff-btn mt-3">＋ Add receipt</button>`}
    </div>`);

  bindSwitch();
  document.getElementById("ffBackHome")?.addEventListener("click", () => {
    if (isPmView()) {
      location.hash = `#/pm/project/${encodeURIComponent(String(proj.qbo_id))}`;
      return;
    }
    renderHome();
  });
  document.querySelectorAll("[data-form]").forEach((b) =>
    b.addEventListener("click", () => {
      const t = (data.templates || []).find((x) => x.code === b.getAttribute("data-form"));
      if (t) renderForm(data, t, past);
    }));
  document.getElementById("ffRcAdd")?.addEventListener("click", () => renderReceiptForm(data));
  loadCrewDocuments(proj.qbo_id);
  loadCrewReceipts(proj.qbo_id);
}

// ── Crew Documents (the "10 Crew Documents" folder, read-only) ──────────────
async function loadCrewDocuments(qboId) {
  const host = document.getElementById("ffDocs");
  if (!host) return;
  try {
    const d = await portalApi(`/crew-portal/documents?project_qbo_id=${encodeURIComponent(qboId)}`);
    const files = d.files || [];
    if (!files.length) {
      host.innerHTML = `<div class="ff-note">No documents shared yet — your PM can add them.</div>`;
      return;
    }
    host.innerHTML = files.map((f) => `
      <a class="ff-doc mb-2" href="${escapeHtml(f.url)}" target="_blank" rel="noopener">
        <div style="min-width:0;flex:1">
          <div class="ff-label" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.filename || "Document")}</div>
          <div class="ff-hint">${escapeHtml(fmtSize(f.size))}${f.uploaded_at ? ` · ${escapeHtml(String(f.uploaded_at).slice(0, 10))}` : ""}</div>
        </div>
        <span style="color:rgba(0,0,0,.35);font-size:16px;flex:none">↗</span>
      </a>`).join("");
  } catch (e) {
    host.innerHTML = `<div class="ff-err">Couldn't load documents: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

// ── Receipts (Crew Portal step 4) ────────────────────────────────────────────
// The crew sees ONLY their own crew's submitted receipts (server-scoped); in
// pmview the PM sees every row. Status chips follow the office flow:
// uploaded (submitted) → reconciled (PM checked it) → allocated (in QBO).
const RC_CATS = [
  ["travel", "Travel"],
  ["materials", "Materials"],
  ["propane_fuel", "Propane / Fuel"],
  ["other", "Other"],
];
const RC_CAT_LABEL = Object.fromEntries(RC_CATS);

function rcStatusHtml(s) {
  switch (s) {
    case "reconciled": return `<span style="color:#1e40af;font-weight:800">reconciled ✓</span>`;
    case "allocated":  return `<span style="color:#059669;font-weight:800">recorded ✓</span>`;
    default:           return `<span style="color:#b45309;font-weight:800">submitted</span>`;
  }
}

function fmtMoneyRc(v) {
  const n = Number(v || 0);
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function loadCrewReceipts(qboId) {
  const host = document.getElementById("ffReceipts");
  if (!host) return;
  try {
    const d = await portalApi(`/receipts?project_qbo_id=${encodeURIComponent(qboId)}`);
    const items = d.receipts || [];
    if (!items.length) {
      host.innerHTML = `<div class="ff-note">No receipts yet${isPmView() ? "" : " from your crew"}.</div>`;
      return;
    }
    host.innerHTML = items.map((r) => {
      const isImg = (r.content_type || "").startsWith("image/");
      const thumb = r.file_url && isImg
        ? `<img class="ff-rc-thumb" src="${escapeHtml(r.file_url)}" alt="" loading="lazy" />`
        : `<span class="ff-rc-thumb" style="display:inline-flex;align-items:center;justify-content:center;font-size:18px">🧾</span>`;
      const flag = r.charged_back
        ? ` · <span style="color:#b91c1c;font-weight:800" title="Charge back to the customer — PM flagged for a change order">⚑ charge back</span>`
        : "";
      const inner = `
        ${thumb}
        <div style="min-width:0;flex:1">
          <div class="ff-label">${r.amount != null ? fmtMoneyRc(r.amount) : "No amount"} · ${escapeHtml(RC_CAT_LABEL[r.category] || r.category)}</div>
          <div class="ff-hint" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.vendor || "")}${r.receipt_date ? `${r.vendor ? " · " : ""}${escapeHtml(fmtDate(r.receipt_date) || r.receipt_date)}` : ""}</div>
          <div class="ff-hint">${rcStatusHtml(r.status)}${flag}</div>
        </div>`;
      return r.file_url
        ? `<a class="ff-rc-row mb-2" href="${escapeHtml(r.file_url)}" target="_blank" rel="noopener">${inner}<span style="color:rgba(0,0,0,.35);font-size:16px;flex:none">↗</span></a>`
        : `<div class="ff-rc-row mb-2">${inner}</div>`;
    }).join("");
  } catch (e) {
    if (handleAuthError(e)) return;
    host.innerHTML = `<div class="ff-err">Couldn't load receipts: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

// Add-receipt screen: photo/camera or PDF, then amount, category, vendor,
// date (defaults today), the charge-back question, optional note.
function renderReceiptForm(data) {
  const proj = data.project;
  const qbo = String(proj.qbo_id);
  const _now = new Date();   // device-LOCAL date
  const todayIso = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, "0")}-${String(_now.getDate()).padStart(2, "0")}`;

  renderShell(`
    ${sessionBanner()}
    <button type="button" id="ffBackProj" class="ff-btn2 mb-3">← ${escapeHtml(proj.name || "Project")}</button>
    <div class="ff-card">
      <div class="ff-h1">Add receipt</div>
      <div class="ff-hint mb-3">${escapeHtml(proj.name || "")}</div>

      <div class="ff-q" data-q="rc_file">
        <div class="ff-label mb-1">Receipt photo or PDF</div>
        <div class="ff-dropzone" id="ffRcDrop">
          <button type="button" class="ff-filebtn" id="ffRcCamBtn">📷 Take a photo</button>
          <button type="button" class="ff-filebtn" id="ffRcPick">📁 Choose a file</button>
          <div class="ff-hint" style="text-align:center;margin-top:6px">…or drag &amp; drop the file here</div>
        </div>
        <input type="file" id="ffRcCam" accept="image/*" capture="environment" style="display:none" />
        <input type="file" id="ffRcFile" accept="image/*,application/pdf" style="display:none" />
        <div id="ffRcFileInfo"></div>
      </div>

      <div class="ff-q" data-q="rc_amount">
        <div class="ff-label mb-1">Amount ($)</div>
        <input type="number" id="ffRcAmount" class="ff-input" inputmode="decimal" step="0.01" min="0" placeholder="0.00" />
      </div>

      <div class="ff-q" data-q="rc_cat">
        <div class="ff-label mb-1">Category</div>
        <select id="ffRcCat" class="ff-select">
          ${RC_CATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
        </select>
      </div>

      <div class="ff-q">
        <div class="ff-label mb-1">Vendor</div>
        <input type="text" id="ffRcVendor" class="ff-input" placeholder="Where you bought it" />
      </div>

      <div class="ff-q">
        <div class="ff-label mb-1">Receipt date</div>
        <input type="date" id="ffRcDate" class="ff-input" value="${todayIso}" max="${todayIso}" />
      </div>

      <div class="ff-q" data-q="rc_cb">
        <div class="ff-label mb-1">Should this be charged back to the customer?</div>
        <div class="ff-hint" style="margin-bottom:8px">If yes, the OPI PM is flagged for a change order.</div>
        <div class="ff-yn">
          <button type="button" data-rc-cb="yes">Yes</button>
          <button type="button" data-rc-cb="no">No</button>
        </div>
      </div>

      <div class="ff-q">
        <div class="ff-label mb-1">Note (optional)</div>
        <textarea id="ffRcNote" class="ff-textarea" rows="2" maxlength="500"></textarea>
      </div>

      <div id="ffRcMsg" style="min-height:22px"></div>
      <button type="button" class="ff-btn mt-2" id="ffRcSubmit">Submit receipt</button>
    </div>`);

  bindSwitch();
  document.getElementById("ffBackProj")?.addEventListener("click", () => renderProject(data));

  // Receipt file: camera capture, file picker, or drag & drop — one slot.
  let pickedFile = null;
  const fileInput = document.getElementById("ffRcFile");
  const camInput = document.getElementById("ffRcCam");
  const setPicked = (f) => {
    const info = document.getElementById("ffRcFileInfo");
    if (!f) return;
    const okType = (f.type || "").startsWith("image/") || f.type === "application/pdf";
    if (!okType) { info.innerHTML = `<div class="ff-err mt-1">"${escapeHtml(f.name)}" isn't a photo or PDF — receipts must be an image or PDF.</div>`; return; }
    if (f.size > 100 * 1024 * 1024) { info.innerHTML = `<div class="ff-err mt-1">"${escapeHtml(f.name)}" is over the 100 MB limit.</div>`; return; }
    pickedFile = f;
    info.innerHTML = `<div class="ff-file"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.name)}</span><span class="ff-hint" style="flex:none">${escapeHtml(fmtSize(f.size))}</span></div>`;
  };
  document.getElementById("ffRcPick").addEventListener("click", () => fileInput.click());
  document.getElementById("ffRcCamBtn").addEventListener("click", () => camInput.click());
  fileInput.addEventListener("change", () => setPicked(fileInput.files?.[0]));
  camInput.addEventListener("change", () => setPicked(camInput.files?.[0]));
  const rcDrop = document.getElementById("ffRcDrop");
  rcDrop.addEventListener("dragover", (e) => { e.preventDefault(); rcDrop.classList.add("drag"); });
  rcDrop.addEventListener("dragleave", (e) => { if (!rcDrop.contains(e.relatedTarget)) rcDrop.classList.remove("drag"); });
  rcDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    rcDrop.classList.remove("drag");
    setPicked(e.dataTransfer?.files?.[0]);
  });

  let chargedBack = null;   // requires an explicit Yes/No
  document.querySelectorAll("[data-rc-cb]").forEach((b) => b.addEventListener("click", () => {
    chargedBack = b.getAttribute("data-rc-cb") === "yes";
    document.querySelectorAll("[data-rc-cb]").forEach((x) => x.classList.toggle("on", x === b));
  }));

  document.getElementById("ffRcSubmit").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const msg = document.getElementById("ffRcMsg");
    msg.innerHTML = "";
    document.querySelectorAll(".ff-q").forEach((el) => el.classList.remove("ff-missing"));

    const file = pickedFile;
    const amountRaw = document.getElementById("ffRcAmount").value.trim();
    const amount = Number(amountRaw);
    const category = document.getElementById("ffRcCat").value;
    const missing = [];
    if (!file) missing.push("rc_file");
    if (!amountRaw || !(amount > 0)) missing.push("rc_amount");
    if (chargedBack === null) missing.push("rc_cb");
    if (missing.length) {
      missing.forEach((k) => document.querySelector(`[data-q="${k}"]`)?.classList.add("ff-missing"));
      msg.innerHTML = `<div class="ff-err">Fill in the parts marked in red.</div>`;
      document.querySelector(".ff-missing")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    btn.disabled = true; btn.textContent = "Uploading…";
    try {
      const up = await receiptUpload(qbo, category, file, (pct) => {
        btn.textContent = `Uploading… ${pct}%`;
      });
      btn.textContent = "Saving…";
      const res = await portalApi("/receipts", {
        method: "POST",
        body: JSON.stringify({
          project_qbo_id: qbo,
          document_id: up.document_id,
          amount,
          category,
          vendor: document.getElementById("ffRcVendor").value.trim() || null,
          receipt_date: document.getElementById("ffRcDate").value || null,
          charged_back: chargedBack,
          notes: document.getElementById("ffRcNote").value.trim() || null,
        }),
      });
      renderReceiptSuccess(data, res);
    } catch (err) {
      btn.disabled = false; btn.textContent = "Submit receipt";
      if (handleAuthError(err)) return;
      msg.innerHTML = `<div class="ff-err">Couldn't submit the receipt: ${escapeHtml(err.message || String(err))}</div>`;
    }
  });
}

function renderReceiptSuccess(data, res) {
  const flag = res?.charged_back
    ? `<div class="ff-flag mt-3">⚑ Marked "charge back to customer" — the OPI PM has been flagged for a change order.</div>`
    : "";
  renderShell(`
    ${sessionBanner()}
    <div class="ff-card" style="text-align:center">
      <div style="font-size:44px;line-height:1;margin:8px 0 10px">🧾</div>
      <div class="ff-h1 mb-1">Receipt submitted</div>
      <div class="ff-muted" style="font-size:14px">${escapeHtml(data.project?.name || "")}</div>
      ${flag}
      <div style="display:grid;gap:10px;margin-top:18px">
        <button type="button" id="ffRcDone1" class="ff-btn">Add another receipt</button>
        <button type="button" id="ffRcDone2" class="ff-btn2">Back to ${escapeHtml(data.project?.name || "project")}</button>
      </div>
    </div>`);
  bindSwitch();
  document.getElementById("ffRcDone1")?.addEventListener("click", () => renderReceiptForm(data));
  document.getElementById("ffRcDone2")?.addEventListener("click", () => openProject(data.project.qbo_id));
}

// ── form filling ─────────────────────────────────────────────────────────────
// Answer conventions (also what the PM review UI expects):
//   yes_no                    -> "yes" | "no"
//   text/textarea/number/select-> string
//   video/photos/media        -> [{document_id, filename}]
// The section/question rendering + branch logic live in the SHARED renderer
// (utils/form-render.js) — the same module the PM's form preview uses, so the
// preview always matches what the crew sees here.
function renderForm(data, tpl, readOnly) {
  const proj = data.project;
  const qbo = String(proj.qbo_id);
  const code = tpl.code;

  // Past (completed) project: the form renders view-only — inputs disabled,
  // no submit/upload, no drafts. (Submitted answers are NOT shown here; the
  // card's status/counts cover that.)
  if (readOnly) {
    const ro = createFormRenderer(tpl, { answers: {}, preview: true });
    renderShell(`
      ${sessionBanner()}
      <button type="button" id="ffBackProj" class="ff-btn2 mb-3">← ${escapeHtml(proj.name || "Project")}</button>
      <div class="ff-card">
        <div class="ff-banner mb-3">Project completed — view only</div>
        <div class="ff-h1">${escapeHtml(tpl.title)}</div>
        <div class="ff-hint mb-3">${escapeHtml(proj.name || "")}</div>
        <div class="ff-preview" id="ffRoBody">${ro.html() || `<div class="ff-note">This form has no sections.</div>`}</div>
      </div>`);
    bindSwitch();
    document.getElementById("ffBackProj")?.addEventListener("click", () => renderProject(data));
    const roHost = document.getElementById("ffRoBody");
    if (roHost) ro.attach(roHost);   // yes/no stays tappable to explore branches
    return;
  }
  const draft = loadDraft(qbo, code);
  const answers = (draft && draft.answers) || {};
  const uploadsInFlight = new Set();

  const persist = () => saveDraft(qbo, code, answers);

  const renderer = createFormRenderer(tpl, {
    answers,
    onChange: persist,
    onFiles: (key, files) => handleFiles(key, files),
  });

  // Recurring (daily-type) forms: optional "For date" so a missed day can be
  // backfilled (report_date, C2). Defaults to today; capped at today; never
  // before the project window start.
  const _now = new Date();   // device-LOCAL date (toISOString would be UTC)
  const todayIso = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, "0")}-${String(_now.getDate()).padStart(2, "0")}`;
  const isRecurring = RECURRING.has(tpl.cadence);
  const datePicker = !isRecurring ? "" : `
    <div class="ff-q" style="margin-top:14px">
      <div class="ff-label mb-1">For date</div>
      <div class="ff-hint" style="margin-bottom:6px">Filling this in for an earlier day? Pick that day — otherwise leave today.${tpl.off_today ? " Today is an off day for this form." : ""}</div>
      <input type="date" id="ffReportDate" class="ff-input" value="${todayIso}" max="${todayIso}" ${proj.start_date ? `min="${escapeHtml(String(proj.start_date).slice(0, 10))}"` : ""} />
    </div>`;

  renderShell(`
    ${sessionBanner()}
    <button type="button" id="ffBackProj" class="ff-btn2 mb-3">← ${escapeHtml(proj.name || "Project")}</button>
    <div class="ff-card">
      <div class="ff-h1">${escapeHtml(tpl.title)}</div>
      <div class="ff-hint">${escapeHtml(proj.name || "")} · answers save on this phone until you submit</div>
      ${datePicker}
      <form id="ffForm">
        ${renderer.html()}
        <div id="ffSubmitMsg" class="mt-3"></div>
        <button class="ff-btn mt-3" type="submit" id="ffSubmitBtn">Submit ${escapeHtml(FORM_SHORT[code] || "form")}</button>
      </form>
    </div>`);

  bindSwitch();
  document.getElementById("ffBackProj")?.addEventListener("click", () => renderProject(data));
  const form = document.getElementById("ffForm");

  async function handleFiles(key, files) {
    const list = [...files];
    if (!list.length) return;
    uploadsInFlight.add(key);
    const btn = document.getElementById("ffSubmitBtn");
    if (btn) btn.disabled = true;
    for (const file of list) {
      const progId = `p_${Math.random().toString(36).slice(2, 8)}`;
      renderer.setFileProgress(key, `
        <div class="ff-file">
          <svg class="animate-spin" style="width:16px;height:16px;flex:none" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="3"><path d="M12 2a10 10 0 0 1 10 10"/></svg>
          <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(file.name)}</span>
          <div class="ff-prog"><div id="${progId}"></div></div>
        </div>`);
      try {
        const res = await crewUpload(qbo, code, file, (pct) => {
          const bar = document.getElementById(progId);
          if (bar) bar.style.width = pct + "%";
        });
        const cur = Array.isArray(answers[key]) ? answers[key] : [];
        answers[key] = [...cur, { document_id: res.document_id, filename: res.filename || file.name }];
        persist();
        renderer.redrawFiles(key);
        renderer.setFileProgress(key, "");
      } catch (err) {
        if (handleAuthError(err)) return;
        renderer.setFileProgress(key, `<div class="ff-err mt-1">Upload of ${escapeHtml(file.name)} failed: ${escapeHtml(err.message || String(err))}. Try again.</div>`);
        break; // stop the batch; the crew retries when they have signal
      }
    }
    uploadsInFlight.delete(key);
    if (btn && uploadsInFlight.size === 0) btn.disabled = false;
  }

  // Remove-file is delegated (rows re-render).
  form.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rmfile]");
    if (!rm) return;
    const key = rm.getAttribute("data-rmfile");
    const idx = Number(rm.getAttribute("data-idx"));
    const cur = Array.isArray(answers[key]) ? answers[key] : [];
    answers[key] = cur.filter((_, i) => i !== idx);
    persist();
    renderer.redrawFiles(key);
  });

  // Bind controls + restore branch UIs for drafted yes/no answers.
  renderer.attach(form);

  form.onsubmit = async (e) => {
    e.preventDefault();
    const msg = document.getElementById("ffSubmitMsg");
    const btn = document.getElementById("ffSubmitBtn");
    if (uploadsInFlight.size) { msg.innerHTML = `<div class="ff-err">Wait for the upload to finish first.</div>`; return; }

    form.querySelectorAll(".ff-q").forEach((el) => el.classList.remove("ff-missing"));
    const active = renderer.activeQuestions();
    const missing = active.filter((q) => !renderer.isAnswered(q));
    if (missing.length) {
      missing.forEach((q) => form.querySelector(`[data-q="${CSS.escape(q.key)}"]`)?.classList.add("ff-missing"));
      msg.innerHTML = `<div class="ff-err">${missing.length} question${missing.length === 1 ? " still needs" : "s still need"} an answer — marked in red.</div>`;
      form.querySelector(".ff-missing")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    // Submit only the answers that belong to enabled sections + taken branches
    // (drafts can hold stale values from a flipped yes/no).
    const activeKeys = new Set(active.map((q) => q.key));
    const clean = {};
    for (const k of Object.keys(answers)) if (activeKeys.has(k)) clean[k] = answers[k];

    btn.disabled = true; btn.textContent = "Submitting…"; msg.innerHTML = "";
    const reportDate = document.getElementById("ffReportDate")?.value || null;
    try {
      const res = await portalApi("/forms/submit", {
        method: "POST",
        body: JSON.stringify({ project_qbo_id: qbo, form_code: code, answers: clean,
                               ...(reportDate && reportDate !== todayIso ? { report_date: reportDate } : {}) }),
      });
      clearDraft(qbo, code);
      renderSuccess(data, tpl, res);
    } catch (err) {
      btn.disabled = false; btn.textContent = `Submit ${FORM_SHORT[code] || "form"}`;
      if (handleAuthError(err)) return;
      msg.innerHTML = `<div class="ff-err">Couldn't submit — your answers are still saved on this phone. ${escapeHtml(err.message || String(err))}</div>`;
    }
  };
}

// ── success ──────────────────────────────────────────────────────────────────
function renderSuccess(data, tpl, res) {
  const flag = res?.red_flag
    ? `<div class="ff-flag mt-3">⚠️ The OPI PM has been flagged.${res.red_flag_reason ? `<div class="ff-hint mt-1" style="color:#991b1b">${escapeHtml(res.red_flag_reason)}</div>` : ""}</div>`
    : "";
  renderShell(`
    ${sessionBanner()}
    <div class="ff-card" style="text-align:center">
      <div style="font-size:44px;line-height:1;margin:8px 0 10px">✅</div>
      <div class="ff-h1 mb-1">${escapeHtml(FORM_SHORT[tpl.code] || tpl.title)} submitted</div>
      <div class="ff-muted" style="font-size:14px">${escapeHtml(data.project?.name || "")}</div>
      ${flag}
      <div style="display:grid;gap:10px;margin-top:18px">
        <button type="button" id="ffDone1" class="ff-btn">Back to ${escapeHtml(data.project?.name || "project")}</button>
        <button type="button" id="ffDone2" class="ff-btn2">${isPmView() ? "Back to PM Portal" : "All projects"}</button>
      </div>
    </div>`);
  bindSwitch();
  document.getElementById("ffDone1")?.addEventListener("click", () => openProject(data.project.qbo_id));
  document.getElementById("ffDone2")?.addEventListener("click", () => {
    if (isPmView()) { location.hash = `#/pm/project/${encodeURIComponent(String(data.project?.qbo_id || ""))}`; return; }
    renderHome();
  });
}
