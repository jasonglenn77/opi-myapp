// Data Review — where OPI's Google sheets (B151 forecast, Job Schedule),
// QuickBooks and the app disagree, as a worklist for the office.
//
// Nothing here edits data: each item says what differs and where to fix it
// (the B151, QuickBooks, or the project's Assignment). Staff mark items Fixed or
// Ignored (with an optional note); an Ignored item comes back if the difference
// changes. "Refresh from Google" re-reads both sheets (the B151 also updates the
// Pipeline) — the nightly sync does the same.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import { openDriveLinkModal } from "../utils/drive-link.js";

const CATS = [
  { key: "todo", label: "To-do", blurb: "100% Won quotes that still need a project in QuickBooks." },
  { key: "pipeline", label: "Pipeline", blurb: "The B151 vs QuickBooks estimates. The Pipeline page follows the B151, so most fixes go in the B151 or QuickBooks." },
  { key: "schedule", label: "Schedule", blurb: "The Job Schedule sheet vs each project's Assignment (dates, crews, PM, status). Assignments update from the sheet every night, so most fixes go in the Job Schedule." },
  { key: "sheets", label: "B151 vs Job Schedule", blurb: "The two Google sheets against each other: jobs scheduled but not Won on the B151, Won jobs starting soon that aren't scheduled, and B151 dates that don't match the Job Schedule." },
  { key: "documents", label: "Documents", blurb: "Google Drive Customers folders vs the app: folders that couldn't be matched to a project or quote (their files are copied and waiting to be linked), projects with no Drive folder, files removed in Drive (the app keeps its copies), the weekly Drive-vs-app check, and copy errors.", optional: true },
  { key: "old_estimates", label: "Old estimate folders", blurb: "Drive folders whose job # matches only a QuickBooks estimate — mostly 2023–24 jobs that never became a project or Pipeline quote. Their files are copied and kept in the holding area. Grouped by the estimate's year, sorted by customer. Link one if the job did become a project or quote under another number; otherwise Ignore it (the files stay in the holding area).", optional: true },
  { key: "billing", label: "Billing", blurb: "Invoice schedules that couldn't be lined up with the actual QuickBooks invoices automatically.", optional: true },
];
const TYPES = {
  create_qbo_project: "Create the QuickBooks project",
  accepted_not_won: "Accepted in QuickBooks, not Won on the B151",
  recurring_estimate: "Recurring estimate in QuickBooks",
  won_but_rejected: "Won on the B151, Rejected in QuickBooks",
  duplicate_row: "Quote # on the B151 more than once",
  negative_value: "Negative value",
  missing_from_b151: "In QuickBooks, missing from the B151",
  not_in_qbo: "On the B151, not in QuickBooks",
  value_differs: "Value differs (B151 vs QuickBooks)",
  missing_dates: "No estimated start date",
  not_in_app: "On the Job Schedule, not in the app",
  undated: "Scheduled on the sheet, no dates in the app",
  dates: "Dates differ",
  phases: "Return trips / phases missing",
  crews: "Crews differ",
  pm: "PM differs",
  status: "Status contradicts the dates",
  scheduled_not_on_b151: "On the Job Schedule, no quote on the B151",
  scheduled_not_won: "Scheduled, but not Won on the B151",
  b151_no_dates: "Scheduled, but no dates on the B151",
  won_not_scheduled: "Won and starting soon, not on the Job Schedule",
  unbilled_balance: "Partly billed — balance to bill",
  retainage_held: "Retainage held",
  unmatched_folder: "Drive folder not filed on a project or quote",
  ambiguous_folder: "Drive folder matches more than one project or quote",
  project_without_drive_folder: "Project with no Drive folder",
  quote_folder_mislinked: "Drive folder # and Pipeline link disagree",
  removed_in_drive: "Files removed from Google Drive (app keeps the copies)",
  reconcile_mismatch: "Drive vs app check: folder differs",
  copy_error: "Drive file did not copy",
  sync_failed: "Drive documents sync failed",
  estimate_folder: "Old estimate folder",
};
const TIP_FIXED = "You've corrected it at the source (the B151, the Job Schedule, QuickBooks or the app). Moves it to \"Marked fixed\" — the button itself changes no data. If the next refresh from Google / QuickBooks still finds the difference, it comes back to Open flagged \"still differs\".";
const TIP_IGNORE = "This difference is expected — leave it as is. Moves it to \"Ignored\" (add a reason). Nothing is changed. It comes back on its own if the difference changes later.";
const SEV = { high: ["High", "rv-sev-h"], medium: ["Medium", "rv-sev-m"], low: ["Low", "rv-sev-l"] };
const PREF = "opi_review_prefs";
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF) || "{}"); } catch (_) { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch (_) {} };
const ago = (iso) => {
  if (!iso) return "never";
  const d = new Date(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z"));
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : d.toLocaleDateString();
};

export async function reviewPage(routeFn) {
  const prefs = loadPrefs();
  const st = { cat: prefs.cat || "todo", state: "open", sev: prefs.sev || "all", q: "", data: null, open: new Set(), showAll: new Set(), busy: false };

  setShell({
    title: "Data Review",
    subtitle: "Where the Google sheets, QuickBooks and the app disagree — review and fix at the source.",
    bodyHtml: `<div id="rvRoot"><div class="card p-6 text-sm text-black/45">Comparing the B151, the Job Schedule, QuickBooks and the app…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("rvRoot");

  async function load(fresh = false) {
    try {
      st.data = await api(`/review${fresh ? "?fresh=1" : ""}`);
      render();
    } catch (e) {
      root.innerHTML = `<div class="card p-6 text-sm text-red-700">Couldn't load the review: ${escapeHtml(e?.message || String(e))}</div>`;
    }
  }

  function visible() {
    const q = st.q.trim().toLowerCase();
    return st.data.items.filter((i) => i.category === st.cat
      && (st.state === "all" || i.state === st.state)
      && (st.sev === "all" || (st.sev === "hm" ? i.severity !== "low" : i.severity === st.sev))
      && (!q || `${i.title} ${i.detail}`.toLowerCase().includes(q)));
  }

  function runLine(src, label) {
    const r = st.data.runs?.[src];
    if (!r) return `<span>${label}: not read yet</span>`;
    const s = r.summary || {};
    const bits = !r.ok ? "failed"
      : src === "b151" ? `${(s.rows || 0).toLocaleString()} rows`
      : src === "schedule_import" ? `${(s.lines_changed || 0) + (s.lines_new || 0)} lines updated from the sheet`
      : `${(s.cells || 0).toLocaleString()} day cells`;
    return `<span title="${escapeHtml(r.error || "")}">${label}: read ${ago(r.finished_at || r.started_at)} · ${bits}${r.ok ? "" : " ⚠"}</span>`;
  }

  function render() {
    const d = st.data, items = visible();
    const groups = new Map();
    items.forEach((i) => { const g = i.group || i.type; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); });
    // items with an explicit group (Old estimate folders: by year) list newest group first
    const entries = [...groups.entries()];
    if (entries.length && entries.every(([, l]) => l[0].group)) entries.sort((a, b) => (a[0] < b[0] ? 1 : -1));
    const cat = CATS.find((c) => c.key === st.cat);

    root.innerHTML = `
      <div class="card rv-bar">
        <div class="rv-tabs" role="tablist">
          ${CATS.filter((c) => !c.optional || Object.values(d.counts[c.key] || {}).some((n) => n)).map((c) => `<button type="button" role="tab" data-cat="${c.key}" class="rv-tab ${st.cat === c.key ? "rv-tab-on" : ""}">
            ${c.label}<span class="rv-badge ${d.counts[c.key]?.open ? "" : "rv-badge-zero"}">${d.counts[c.key]?.open || 0}</span></button>`).join("")}
        </div>
        <div class="rv-sources">
          ${runLine("b151", "B151")} ${runLine("job_schedule", "Job Schedule")} ${runLine("schedule_import", "Assignments")}
          <button type="button" class="rv-btn" data-refresh ${st.busy ? "disabled" : ""}>${st.busy ? "Reading Google…" : "Refresh from Google"}</button>
        </div>
      </div>
      <div class="rv-blurb">${escapeHtml(cat.blurb)} <span class="rv-legend"><b>Fixed</b> = you corrected it at the source · <b>Ignore</b> = the difference is expected. Neither button changes any data — they just track the review.</span></div>
      <div class="rv-filters">
        <input type="search" class="input py-1.5" data-q placeholder="Search job #, customer…" value="${escapeHtml(st.q)}" style="max-width:260px">
        <select class="input py-1.5" data-state style="width:auto">
          ${[["open", "Open"], ["fixed", "Marked fixed"], ["ignored", "Ignored"], ["all", "All"]].map(([v, l]) => `<option value="${v}" ${st.state === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <select class="input py-1.5" data-sev style="width:auto">
          ${[["all", "All priorities"], ["hm", "High + medium"], ["high", "High only"]].map(([v, l]) => `<option value="${v}" ${st.sev === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <span class="rv-count">${items.length} item${items.length === 1 ? "" : "s"}</span>
      </div>
      ${items.length ? entries.map(([type, list]) => groupHtml(type, list)).join("")
        : `<div class="card p-6 text-sm text-black/50">${st.state === "open" ? "Nothing to review here — everything matches." : "No items."}</div>`}`;
  }

  function groupHtml(type, list) {
    const LIMIT = 25;
    const all = st.showAll.has(type);
    const shown = all ? list : list.slice(0, LIMIT);
    return `
      <div class="card rv-group">
        <div class="rv-gh"><span>${escapeHtml(list[0].group_label || TYPES[type] || type)}</span><span class="rv-gcount">${list.length}</span></div>
        ${shown.map(itemHtml).join("")}
        ${list.length > LIMIT && !all ? `<button type="button" class="rv-more" data-more="${type}">Show all ${list.length}</button>` : ""}
      </div>`;
  }

  function itemHtml(i) {
    const [sl, sc] = SEV[i.severity] || SEV.low;
    const done = i.state !== "open";
    return `
      <div class="rv-item ${done ? "rv-done" : ""}" data-key="${escapeHtml(i.key)}">
        <span class="rv-sev ${sc}" title="${sl} priority"></span>
        <div class="rv-main">
          <div class="rv-title">${escapeHtml(i.title)}</div>
          ${i.detail ? `<div class="rv-detail">${escapeHtml(i.detail)}</div>` : ""}
          ${i.fix ? `<div class="rv-fix"><b>Fix:</b> ${escapeHtml(i.fix)}</div>` : ""}
          ${i.still_differs ? `<div class="rv-note rv-still">Marked fixed${i.state_by ? " by " + escapeHtml(i.state_by) : ""}, but the latest refresh still shows this difference.</div>` : ""}
          ${i.note || done ? `<div class="rv-note">${done ? `${i.state === "fixed" ? "Marked fixed" : "Ignored"}${i.state_by ? " by " + escapeHtml(i.state_by) : ""}` : ""}${i.note ? ` — “${escapeHtml(i.note)}”` : ""}</div>` : ""}
        </div>
        <div class="rv-actions">
          ${i.ref && i.ref.drive_unmatched_id ? `<button type="button" class="rv-btn rv-btn-go" data-drivelink title="Pick the project or quote this Google Drive folder belongs to — its files (already copied) move there">Link folder…</button>` : ""}
          ${i.link ? `<a class="rv-btn" href="${escapeHtml(i.link)}" title="Go to the record in the app to fix it">Open</a>` : ""}
          ${done ? `<button type="button" class="rv-btn" data-act="open" title="Put this item back on the open list">Reopen</button>`
                 : `<button type="button" class="rv-btn rv-btn-go" data-act="fixed" title="${escapeHtml(TIP_FIXED)}">Fixed</button><button type="button" class="rv-btn" data-act="ignored" title="${escapeHtml(TIP_IGNORE)}">Ignore</button>`}
          <button type="button" class="rv-btn rv-btn-ghost" data-act="note" title="Add a note other reviewers will see (who's on it, why it's ignored…)">Note</button>
        </div>
      </div>`;
  }

  async function setState(key, status, note) {
    const it = st.data.items.find((x) => x.key === key);
    if (!it) return;
    const prev = { state: it.state, note: it.note };
    it.state = status; if (note !== undefined) it.note = note;
    const c = st.data.counts[it.category];
    if (prev.state !== status) { c[prev.state] = Math.max(0, (c[prev.state] || 0) - 1); c[status] = (c[status] || 0) + 1; }
    render();
    try {
      await api("/review/state", { method: "POST", body: JSON.stringify({ key, status, note: it.note || null, fingerprint: it.fingerprint }) });
    } catch (e) {
      Object.assign(it, prev); render();
      alert("Couldn't save: " + (e?.message || e));
    }
  }

  async function refreshFromGoogle() {
    st.busy = true; render();
    const before = JSON.stringify(st.data.runs || {});
    try {
      await api("/review/refresh", { method: "POST" });
      for (let n = 0; n < 60; n++) {          // poll up to ~5 min
        await new Promise((r) => setTimeout(r, 5000));
        if (!document.body.contains(root)) return;
        const d = await api("/review");
        if (JSON.stringify(d.runs || {}) !== before && Object.values(d.runs || {}).every((r) => r.finished_at)) { st.data = d; break; }
      }
    } catch (e) {
      alert("Refresh failed: " + (e?.message || e));
    }
    st.busy = false; render();
  }

  root.addEventListener("click", (e) => {
    const t = e.target;
    const tab = t.closest("[data-cat]");
    if (tab) { st.cat = tab.dataset.cat; savePrefs({ cat: st.cat, sev: st.sev }); render(); return; }
    if (t.closest("[data-refresh]")) { refreshFromGoogle(); return; }
    const more = t.closest("[data-more]");
    if (more) { st.showAll.add(more.dataset.more); render(); return; }
    const dl = t.closest("[data-drivelink]");
    if (dl) {
      const key = dl.closest("[data-key]").dataset.key;
      const it = st.data.items.find((x) => x.key === key);
      Promise.resolve(openDriveLinkModal(it.ref)).then((res) => {
        if (res && res.action === "linked") setState(key, "fixed", it.note);
        else if (res && res.action === "ignored") setState(key, "ignored", it.note);
      });
      return;
    }
    const act = t.closest("[data-act]");
    if (act) {
      const key = act.closest("[data-key]").dataset.key;
      const a = act.dataset.act;
      if (a === "note") {
        const it = st.data.items.find((x) => x.key === key);
        const note = prompt("Note for this item (who's fixing it, why it's ignored…)", it?.note || "");
        if (note !== null) setState(key, it.state, note.trim());
        return;
      }
      if (a === "ignored") {
        const note = prompt("Why ignore it? (optional)", "");
        if (note === null) return;
        setState(key, "ignored", note.trim() || undefined);
        return;
      }
      setState(key, a);
    }
  });
  root.addEventListener("input", (e) => {
    if (e.target.matches("[data-q]")) {
      st.q = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const el = root.querySelector("[data-q]"); el.focus(); el.setSelectionRange(pos, pos);
    }
  });
  root.addEventListener("change", (e) => {
    if (e.target.matches("[data-state]")) { st.state = e.target.value; render(); }
    if (e.target.matches("[data-sev]")) { st.sev = e.target.value; savePrefs({ cat: st.cat, sev: st.sev }); render(); }
  });

  load();
}
