// Help, tours, feedback, what's new, and the notification bell — all in the top bar.
//
//   initHelp()        once per page load (from setShell); idempotent
//   startTour(key)    run a guided tour ("app" or a hash route like "#/setup")
//   openFeedback()    the bug / idea / question form
//
// Tours are defined in tours.js. Progress is stored per person (/api/help/tours),
// so a page offers its tour once. Notes for "What's new" are written by staff on
// #/help-admin and shown once, after the next sign-in.
import { api, getMe, hasCapability } from "../api.js";
import { escapeHtml as esc } from "./html.js";
import { TOURS, tourFor } from "./tours.js";

let ready = false;
let toursSeen = null;         // {tour_key: 'done'|'skipped'}
let pollTimer = null;
let offeredThisSession = new Set();

const ICON_HELP = `<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01"/></svg>`;
const ICON_BELL = `<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/></svg>`;

function curHash() { return (location.hash || "#/projects").split("?")[0]; }

// ------------------------------------------------------------------ top bar
export function initHelp() {
  if (ready) return;
  const menu = document.getElementById("accountMenu");
  if (!menu || !getMe()) return;
  ready = true;
  const wrap = document.createElement("div");
  wrap.className = "flex items-center gap-2 shrink-0";
  wrap.id = "topTools";
  menu.parentNode.insertBefore(wrap, menu);
  wrap.innerHTML = `
    <div class="relative">
      <button id="notifBtn" type="button" class="hp-iconbtn" aria-label="Notifications" title="Notifications">${ICON_BELL}<span id="notifBadge" class="hp-badge hidden">0</span></button>
      <div id="notifPanel" class="hp-panel hidden" role="dialog" aria-label="Notifications"></div>
    </div>
    <div class="relative">
      <button id="helpBtn" type="button" class="hp-iconbtn" aria-label="Help" title="Help">${ICON_HELP}</button>
      <div id="helpPanel" class="hp-panel hp-menu hidden" role="menu" aria-label="Help"></div>
    </div>`;
  wrap.appendChild(menu);

  document.getElementById("helpBtn").addEventListener("click", (e) => { e.stopPropagation(); toggle("helpPanel", renderHelpMenu); });
  document.getElementById("notifBtn").addEventListener("click", (e) => { e.stopPropagation(); toggle("notifPanel", renderNotifications); });
  document.addEventListener("click", (e) => {
    for (const id of ["helpPanel", "notifPanel"]) {
      const p = document.getElementById(id);
      if (p && !p.classList.contains("hidden") && !p.contains(e.target)) p.classList.add("hidden");
    }
  });

  refreshBadge();
  pollTimer = setInterval(refreshBadge, 120000);
  api("/help/tours").then((r) => { toursSeen = r.tours || {}; maybeOfferTour(); }).catch(() => { toursSeen = {}; });
  setTimeout(checkWhatsNew, 1200);
  window.addEventListener("hashchange", () => setTimeout(maybeOfferTour, 1200));
}

function toggle(id, render) {
  const p = document.getElementById(id);
  const other = id === "helpPanel" ? "notifPanel" : "helpPanel";
  document.getElementById(other)?.classList.add("hidden");
  if (p.classList.contains("hidden")) { p.classList.remove("hidden"); render(p); } else p.classList.add("hidden");
}

function renderHelpMenu(p) {
  const key = tourFor(curHash());
  const seen = key && toursSeen && toursSeen[key] === "done";
  const item = (act, label, sub = "") =>
    `<button type="button" role="menuitem" class="hp-mi" data-act="${act}"><span>${label}</span>${sub ? `<span class="hp-mi-sub">${sub}</span>` : ""}</button>`;
  p.innerHTML = `
    ${key ? item("page", `Tour this page`, seen ? "seen" : TOURS[key].title) : `<div class="hp-mi hp-mi-off">No tour for this page yet</div>`}
    ${item("app", "Tour the app", toursSeen && toursSeen.app === "done" ? "seen" : "2 min")}
    ${item("explain", "Explain a control", "click anything")}
    <div class="hp-sep"></div>
    ${item("news", "What's new")}
    ${item("feedback", "Send feedback", "bug, idea, question")}
    ${item("mine", "My feedback")}
    ${hasCapability("users.manage") ? `<div class="hp-sep"></div>${item("admin", "Feedback &amp; notes", "staff")}` : ""}`;
  p.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => {
    p.classList.add("hidden");
    const a = b.dataset.act;
    if (a === "page") startTour(key);
    else if (a === "app") startTour("app");
    else if (a === "explain") explainMode();
    else if (a === "news") checkWhatsNew(true);
    else if (a === "feedback") openFeedback();
    else if (a === "mine") location.hash = "#/help-mine";
    else if (a === "admin") location.hash = "#/help-admin";
  }));
}

// ------------------------------------------------------------------ notifications
async function refreshBadge() {
  try {
    const r = await api("/notifications?unread=1&limit=1");
    const b = document.getElementById("notifBadge");
    if (!b) return;
    b.textContent = r.unread > 99 ? "99+" : String(r.unread);
    b.classList.toggle("hidden", !r.unread);
  } catch (_) { /* signed out or offline */ }
}

function ago(iso) {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return d.toLocaleDateString();
}

async function renderNotifications(p) {
  p.innerHTML = `<div class="hp-ph">Loading…</div>`;
  let r;
  try { r = await api("/notifications?limit=30"); } catch (e) { p.innerHTML = `<div class="hp-ph">Couldn't load notifications.</div>`; return; }
  p.innerHTML = `
    <div class="hp-phead"><span class="font-bold">Notifications</span>
      <span class="flex gap-3">${r.unread ? `<button type="button" class="hp-link" data-act="all">Mark all read</button>` : ""}<button type="button" class="hp-link" data-act="prefs">Settings</button></span></div>
    <div class="hp-nlist">${r.items.length ? r.items.map((n) => `
      <button type="button" class="hp-n ${n.read_at ? "" : "hp-n-new"}" data-id="${n.id}" data-link="${esc(n.link || "")}">
        <span class="hp-n-t">${esc(n.title)}</span>
        ${n.body ? `<span class="hp-n-b">${esc(n.body).slice(0, 220)}</span>` : ""}
        <span class="hp-n-d">${ago(n.created_at)}</span>
      </button>`).join("") : `<div class="hp-ph">Nothing yet. Changes to your projects and replies to your feedback will show up here.</div>`}</div>`;
  p.querySelector('[data-act="all"]')?.addEventListener("click", async (e) => {
    e.stopPropagation(); await api("/notifications/read-all", { method: "POST" }); refreshBadge(); renderNotifications(p);
  });
  p.querySelector('[data-act="prefs"]')?.addEventListener("click", (e) => { e.stopPropagation(); p.classList.add("hidden"); openPrefs(); });
  p.querySelectorAll(".hp-n").forEach((b) => b.addEventListener("click", async () => {
    p.classList.add("hidden");
    api(`/notifications/${b.dataset.id}/read`, { method: "POST" }).then(refreshBadge).catch(() => {});
    if (b.dataset.link) location.hash = b.dataset.link.replace(/^#?/, "#");
  }));
}

async function openPrefs() {
  const r = await api("/notifications/prefs");
  const m = modal(`
    <div class="text-lg font-extrabold">Notification settings</div>
    <div class="text-xs text-black/55 mt-1 mb-3">${r.email_configured ? "Choose what shows in the bell and what's also emailed to you." : "Choose what shows in the bell. Email isn't set up yet; these settings will apply once it is."}</div>
    <table class="w-full text-sm"><thead><tr class="text-left text-xs text-black/55"><th class="py-1">Tell me about</th><th class="py-1 text-center">In app</th><th class="py-1 text-center">Email</th></tr></thead>
    <tbody>${r.kinds.map((k) => `<tr class="border-t border-black/[0.05]"><td class="py-2">${esc(k.label)}</td>
      <td class="text-center"><input type="checkbox" data-k="${k.kind}" data-f="in_app" ${k.in_app ? "checked" : ""}></td>
      <td class="text-center"><input type="checkbox" data-k="${k.kind}" data-f="email" ${k.email ? "checked" : ""}></td></tr>`).join("")}</tbody></table>
    <div class="flex justify-end gap-2 mt-4"><button type="button" class="pd-btn" data-x>Cancel</button><button type="button" class="btn-primary" data-save>Save</button></div>`);
  m.querySelector("[data-save]").addEventListener("click", async () => {
    const rows = r.kinds.map((k) => ({
      kind: k.kind,
      in_app: m.querySelector(`[data-k="${k.kind}"][data-f="in_app"]`).checked,
      email: m.querySelector(`[data-k="${k.kind}"][data-f="email"]`).checked,
    }));
    await api("/notifications/prefs", { method: "PUT", body: JSON.stringify(rows) });
    closeModal(m); toast("Notification settings saved");
  });
}

// ------------------------------------------------------------------ modal + toast
export function modal(html, { wide = false } = {}) {
  const m = document.createElement("div");
  m.className = "hp-modal";
  m.innerHTML = `<div class="hp-modal-card ${wide ? "hp-wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(m);
  m.addEventListener("click", (e) => { if (e.target === m) closeModal(m); });
  m.querySelectorAll("[data-x]").forEach((b) => b.addEventListener("click", () => closeModal(m)));
  const onKey = (e) => { if (e.key === "Escape") { closeModal(m); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);
  setTimeout(() => m.querySelector("textarea, input, button")?.focus(), 30);
  return m;
}
export function closeModal(m) { m?.remove(); }

export function toast(text, actions = null, ms = 4000) {
  document.querySelector(".hp-toast")?.remove();
  const t = document.createElement("div");
  t.className = "hp-toast";
  t.innerHTML = `<span>${esc(text)}</span>${actions ? `<span class="flex gap-2">${actions.map((a, i) => `<button type="button" class="${i === 0 ? "btn-primary" : "pd-btn"} !py-1 !px-3 text-xs" data-i="${i}">${esc(a.label)}</button>`).join("")}</span>` : ""}`;
  document.body.appendChild(t);
  if (actions) t.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => { t.remove(); actions[+b.dataset.i].fn(); }));
  else setTimeout(() => t.remove(), ms);
  return t;
}

// ------------------------------------------------------------------ feedback
export function openFeedback(kind = "bug") {
  const page = document.getElementById("pageTitle")?.textContent?.trim() || curHash();
  const m = modal(`
    <div class="text-lg font-extrabold">Send feedback</div>
    <div class="text-xs text-black/55 mt-1 mb-3">Goes to the people who build and run the app. You'll get the reply in the bell${hasCapability("users.manage") ? "" : " and by email"}.</div>
    <div class="tabs card mb-3" role="tablist">
      ${[["bug", "Something's wrong"], ["idea", "Idea"], ["question", "Question"]].map(([k, l]) => `<button type="button" role="tab" class="tab" data-kind="${k}" aria-selected="${k === kind}">${l}</button>`).join("")}
    </div>
    <textarea id="fbMsg" class="input w-full" rows="6" placeholder="What happened, or what would help? For a bug: what you clicked and what you expected."></textarea>
    <div class="text-xs text-black/45 mt-2">Sent with it: this page (${esc(page)}), your browser and screen size.</div>
    <div id="fbErr" class="text-sm text-rose-600 min-h-[1.25rem] mt-1"></div>
    <div class="flex justify-end gap-2 mt-2"><button type="button" class="pd-btn" data-x>Cancel</button><button type="button" class="btn-primary" id="fbSend">Send</button></div>`);
  let k = kind;
  m.querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => {
    k = b.dataset.kind;
    m.querySelectorAll("[data-kind]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  }));
  m.querySelector("#fbSend").addEventListener("click", async () => {
    const msg = m.querySelector("#fbMsg").value.trim();
    if (!msg) { m.querySelector("#fbErr").textContent = "Write a short message first."; return; }
    try {
      await api("/help/feedback", { method: "POST", body: JSON.stringify({
        kind: k, message: msg, page: location.hash, page_title: page,
        browser: navigator.userAgent, viewport: `${innerWidth}x${innerHeight}`,
      }) });
      closeModal(m); toast("Thanks, it's been sent. You'll see the reply under Help → My feedback.");
    } catch (e) { m.querySelector("#fbErr").textContent = "Couldn't send it. Try again in a moment."; }
  });
}

// ------------------------------------------------------------------ what's new
async function checkWhatsNew(force = false) {
  let r;
  try { r = await api("/help/whats-new"); } catch (_) { return; }
  const notes = force ? (r.unseen.length ? r.unseen : r.recent.slice(0, 8)) : r.unseen;
  if (!notes.length) { if (force) toast("Nothing new since your last visit."); return; }
  const m = modal(`
    <div class="text-lg font-extrabold">What's new</div>
    <div class="text-xs text-black/55 mt-1 mb-3">Changes since your last visit.</div>
    <div class="hp-news">${notes.map((n) => `
      <div class="hp-note" data-id="${n.id}">
        <div class="font-bold text-ink-900">${esc(n.title)}</div>
        <div class="text-sm text-black/65 whitespace-pre-line mt-0.5">${esc(n.body)}</div>
        <div class="flex items-center gap-3 mt-2">
          ${n.page ? `<button type="button" class="pd-btn" data-show="${n.id}">Show me</button>` : ""}
          <span class="text-xs text-black/45">${new Date(n.published_at + "Z").toLocaleDateString()}</span>
        </div>
      </div>`).join("")}</div>
    <div class="flex justify-end gap-2 mt-4">
      ${force ? "" : `<button type="button" class="pd-btn" data-later>Remind me later</button>`}
      <button type="button" class="btn-primary" data-ok>${force ? "Close" : "Got it"}</button>
    </div>`, { wide: true });
  const mark = (action, ids) => Promise.all(ids.map((id) => api(`/help/whats-new/${id}`, { method: "POST", body: JSON.stringify({ action }) }).catch(() => {})));
  const unseenIds = r.unseen.map((n) => n.id);
  m.querySelector("[data-ok]").addEventListener("click", () => { mark("seen", unseenIds); closeModal(m); });
  m.querySelector("[data-later]")?.addEventListener("click", () => { mark("later", unseenIds); closeModal(m); });
  m.querySelectorAll("[data-show]").forEach((b) => b.addEventListener("click", () => {
    const n = notes.find((x) => String(x.id) === b.dataset.show);
    mark("seen", unseenIds); closeModal(m);
    const go = () => { if (n.tour_key && TOURS[n.tour_key]) setTimeout(() => startTour(n.tour_key), 900); };
    if (curHash() !== n.page) { location.hash = n.page; go(); } else go();
  }));
}

// ------------------------------------------------------------------ first-visit offer
function maybeOfferTour() {
  if (!toursSeen || document.querySelector(".hp-tour")) return;
  const firstEver = !toursSeen.app;
  const key = firstEver ? "app" : tourFor(curHash());
  if (!key || toursSeen[key] || offeredThisSession.has(key)) return;
  offeredThisSession.add(key);
  const label = key === "app" ? "New to the app? Take the 2-minute tour." : `New to ${TOURS[key].title}? Take the 1-minute tour.`;
  toast(label, [
    { label: "Start", fn: () => startTour(key) },
    { label: "No thanks", fn: () => markTour(key, "skipped") },
  ]);
}

function markTour(key, status) {
  if (!toursSeen) toursSeen = {};
  toursSeen[key] = status;
  api(`/help/tours/${encodeURIComponent(key)}`, { method: "POST", body: JSON.stringify({ status }) }).catch(() => {});
}

// ------------------------------------------------------------------ tour engine
// A step's element: a selector (or several, comma-separated: the first one on
// screen, in page order, wins) or a function. undefined = not on the page (yet),
// false = on the page but hidden (phone layout, a closed panel).
function findEl(step) {
  if (!step.el) return null;
  let cands;
  if (typeof step.el === "function") { const e = step.el(); cands = e ? [e] : []; }
  else cands = [...document.querySelectorAll(step.el)];
  for (const el of cands) {
    const r = el.getBoundingClientRect();
    if (r.width && r.height) return el;                  // hidden ones (permissions, phone layout) are passed over
  }
  return cands.length ? false : undefined;               // false = there but hidden: no point waiting
}
// Steps' text: plain, with "\n" for a new line and "• " lines shown as a list.
function stepBody(txt) {
  const lines = String(txt || "").split("\n");
  let html = "", list = false;
  for (const l of lines) {
    if (l.startsWith("• ")) { if (!list) { html += `<ul class="hp-list">`; list = true; } html += `<li>${esc(l.slice(2))}</li>`; continue; }
    if (list) { html += "</ul>"; list = false; }
    if (l.trim()) html += `<p>${esc(l)}</p>`;
  }
  return html + (list ? "</ul>" : "");
}

export function startTour(key) {
  const tour = TOURS[key];
  if (!tour) return;
  document.querySelector(".hp-toast")?.remove();
  endTour();
  const root = document.createElement("div");
  root.className = "hp-tour";
  root.innerHTML = `<div class="hp-block"></div><div class="hp-spot"></div><div class="hp-pop" role="dialog" aria-live="polite"></div>`;
  document.body.appendChild(root);
  const spot = root.querySelector(".hp-spot"), pop = root.querySelector(".hp-pop");
  let i = 0, dir = 1, el = null;

  const steps = tour.steps;
  const finish = (done) => { endTour(); markTour(key, done ? "done" : "skipped"); if (done) toast("Tour finished. Help → Tour this page runs it again."); };

  function place() {
    const vw = innerWidth, vh = innerHeight, phone = vw < 640;
    if (el) {
      const r = el.getBoundingClientRect(), pad = 6;
      // the spotlight stays inside the window, even for a very tall list
      const top0 = Math.max(4, r.top - pad), bot0 = Math.min(vh - 4, r.bottom + pad);
      Object.assign(spot.style, { display: "block", left: `${Math.max(4, r.left - pad)}px`, top: `${top0}px`, width: `${Math.min(vw - 8, r.width + pad * 2)}px`, height: `${Math.max(12, bot0 - top0)}px` });
      root.classList.remove("hp-center");
      if (phone) {
        // bottom of the screen, unless the element sits there: then the top
        const low = r.top > vh * 0.55;
        Object.assign(pop.style, { left: "12px", right: "12px", top: low ? "12px" : "", bottom: low ? "" : "12px", width: "" });
        return;
      }
      const pw = Math.min(380, vw - 24), ph = pop.offsetHeight || 180;
      let top, left;
      if (r.bottom + 14 + ph <= vh - 12) { top = r.bottom + 14; left = r.left; }                 // below
      else if (r.top - ph - 14 >= 12) { top = r.top - ph - 14; left = r.left; }                 // above
      else if (r.right + 14 + pw <= vw - 12) { top = Math.max(12, Math.min(r.top, vh - ph - 12)); left = r.right + 14; }   // right
      else if (r.left - pw - 14 >= 12) { top = Math.max(12, Math.min(r.top, vh - ph - 12)); left = r.left - pw - 14; }    // left
      else { top = vh - ph - 20; left = vw - pw - 24; }                                           // big element: corner
      left = Math.max(12, Math.min(left, vw - pw - 12));
      top = Math.max(12, Math.min(top, vh - ph - 12));
      Object.assign(pop.style, { left: `${left}px`, top: `${top}px`, right: "", bottom: "", width: `${pw}px` });
    } else {
      spot.style.display = "none";
      root.classList.add("hp-center");
      Object.assign(pop.style, { left: "", top: "", right: "", bottom: "", width: "" });
    }
  }

  let run = 0;
  async function show() {
    // Skip steps whose element isn't on screen; wait briefly for slow pages. A
    // newer show() (Next pressed again while this one waits) wins.
    const me = ++run;
    pop.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    for (;;) {
      if (i < 0) { i = 0; dir = 1; }
      if (i >= steps.length) return finish(true);
      const s = steps[i];
      if (!s.el) { el = null; break; }
      let found = findEl(s);
      for (let t = 0; t < 8 && found === undefined; t++) { await new Promise((r) => setTimeout(r, 250)); if (me !== run) return; found = findEl(s); }
      if (found) { el = found; break; }
      // Not on screen (phone layout, no data, no access): an "optional" step is
      // skipped; any other step still shows its words, in the middle.
      if (!s.optional) { el = null; break; }
      i += dir;
    }
    if (el) {
      const r = el.getBoundingClientRect(), head = document.getElementById("topBar")?.getBoundingClientRect().height || 70;
      if (r.height > innerHeight * 0.6) {
        // tall (a long list): bring its top under the top bar
        if (r.top < head + 8 || r.top > innerHeight * 0.4) { el.scrollIntoView({ block: "start", behavior: "instant" }); scrollBy(0, -(head + 16)); }
      } else if (r.top < head + 8 || r.bottom > innerHeight - 20) el.scrollIntoView({ block: "center", behavior: "instant" });
    }
    if (me !== run || !root.isConnected) return;
    const s = steps[i];
    if (!s) return finish(true);
    const visible = steps.length;
    pop.innerHTML = `
      <div class="flex items-start justify-between gap-3">
        <div class="font-extrabold text-ink-900">${esc(s.title)}</div>
        <button type="button" class="hp-x" data-close aria-label="End tour">×</button>
      </div>
      <div class="hp-body text-sm text-black/70 mt-1 leading-relaxed">${stepBody(s.body)}</div>
      <div class="flex items-center justify-between mt-3 gap-2">
        <span class="text-xs text-black/45">${i + 1} of ${visible}</span>
        <span class="flex gap-2">
          ${i > 0 ? `<button type="button" class="pd-btn" data-back>Back</button>` : ""}
          <button type="button" class="btn-primary !py-1.5 !px-4 text-sm" data-next>${i === steps.length - 1 ? "Done" : "Next"}</button>
        </span>
      </div>`;
    pop.querySelector("[data-close]").onclick = () => finish(false);
    pop.querySelector("[data-back]")?.addEventListener("click", () => { i--; dir = -1; show(); });
    pop.querySelector("[data-next]").onclick = () => { i++; dir = 1; show(); };
    place();
    requestAnimationFrame(place);
    pop.querySelector("[data-next]").focus();
  }

  const onKey = (e) => {
    if (e.key === "Escape") finish(false);
    else if (e.key === "ArrowRight") { i++; dir = 1; show(); }
    else if (e.key === "ArrowLeft" && i > 0) { i--; dir = -1; show(); }
  };
  const onMove = () => place();
  document.addEventListener("keydown", onKey);
  addEventListener("resize", onMove);
  addEventListener("scroll", onMove, true);
  root._cleanup = () => { document.removeEventListener("keydown", onKey); removeEventListener("resize", onMove); removeEventListener("scroll", onMove, true); };
  root.querySelector(".hp-block").addEventListener("click", () => finish(false));
  show();
}

function endTour() {
  document.querySelectorAll(".hp-tour").forEach((t) => { t._cleanup?.(); t.remove(); });
}

// ------------------------------------------------------------------ explain a control
// Click anything: show its tooltip / label / data-help text, or say what kind of
// control it is. Esc or a second click ends it.
function explainMode() {
  document.body.classList.add("hp-explaining");
  const hint = toast("Click any button, tab, column or box to see what it does. Esc to stop.", [{ label: "Stop", fn: stop }]);
  let tip = null;
  function describe(t) {
    const el = t.closest("[data-help], [title], [aria-label], button, a, th, label, input, select, .tab, .card") || t;
    const help = el.closest("[data-help]")?.dataset.help;
    const name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
    let what = help || el.getAttribute("title") || "";
    if (!what) {
      const tag = el.tagName;
      if (el.classList.contains("tab")) what = "A tab: switches what this page shows. The number is how many items are in it.";
      else if (tag === "TH") what = "A column heading. Click it to sort by this column, where sorting is available.";
      else if (tag === "INPUT" || tag === "SELECT") what = "A filter or field. What you type here narrows or changes what's shown.";
      else if (tag === "A") what = "A link: opens another page.";
      else if (tag === "BUTTON") what = "A button: runs this action. Nothing is sent to QuickBooks or Google Drive from this app unless the button says so.";
      else what = "Part of the page. If something here is unclear, send feedback (Help → Send feedback) and we'll explain it, or improve it.";
    }
    return { el, name, what };
  }
  function onClick(e) {
    if (e.target.closest(".hp-toast")) return;
    e.preventDefault(); e.stopPropagation();
    const { el, name, what } = describe(e.target);
    tip?.remove();
    tip = document.createElement("div");
    tip.className = "hp-tip";
    tip.innerHTML = `${name ? `<div class="font-bold text-ink-900 mb-0.5">${esc(name)}</div>` : ""}<div>${esc(what)}</div>`;
    document.body.appendChild(tip);
    const r = el.getBoundingClientRect();
    const w = Math.min(320, innerWidth - 24);
    tip.style.width = `${w}px`;
    tip.style.left = `${Math.max(12, Math.min(r.left, innerWidth - w - 12))}px`;
    tip.style.top = `${r.bottom + 8 + tip.offsetHeight > innerHeight ? Math.max(12, r.top - tip.offsetHeight - 8) : r.bottom + 8}px`;
  }
  function onKey(e) { if (e.key === "Escape") stop(); }
  function stop() {
    document.body.classList.remove("hp-explaining");
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey);
    tip?.remove(); hint?.remove();
  }
  setTimeout(() => document.addEventListener("click", onClick, true), 0);
  document.addEventListener("keydown", onKey);
}

export function stopHelpPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; ready = false; }
