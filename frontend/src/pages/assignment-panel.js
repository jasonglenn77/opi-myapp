// Per-project assignment editor — the full PM + crew + schedule editing from the
// standalone Assignment page, scoped to one project so it lives inside the
// project detail workspace (Projects hub Phase 2). Loads /assignment/bundle and
// saves each schedule item via /assignment/save. CR5 A2: this tab is the
// CANONICAL assignment editor going forward (the standalone page eventually
// retires) — the crew picker is the shared CR3 company-first editor
// (utils/crew-editor.js, same module as assignment.js) and saves ship the v2
// crew_assignments payload. CR5 A4: two-deck line layout (no horizontal
// scrollbar; the status select shows its full label).
// Fields: Status · Start · End · PM (multi + primary) · Crew (company → lead →
// slot, multi + primary) · Wire · Travel · Overage · Equipment · Notes;
// multiple schedule items per project (add / delete). Changes save
// automatically, exactly as before.
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";
import {
  historyBadgeHtml, historyPanelHtml, loadHistory, invalidateHistory, cachedHistory,
  historyCountOf, historyBadgeLabel,
} from "../utils/assignment-history.js";
import {
  entryLabel, toDraftEntry, crewFieldsFor, crewEditorBodyHtml,
  handleCrewEditorClick, handleCrewEditorChange, handleCrewEditorInput,
} from "../utils/crew-editor.js";
import { mountConsistencyChip } from "../utils/crew-consistency.js";
// 0062: shared "Days off" (non-working days) control.
import { nonWorkingButtonLabel, openNonWorkingEditor } from "../utils/nonworking.js";
// 0078: project holds (Put on hold / Edit hold / Resume now).
import { openHoldDialog, resumeHold, holdTitle } from "../utils/hold.js";

// CR4: schedule-item ids whose history sub-lines are expanded — module-level
// so the open state survives the panel's frequent remounts after saves.
const _openHist = new Set();
// 2026-11-15: projects whose undated lines the user chose to show (they're
// hidden when the project has dated lines: usually the placeholder line made
// with the project, which the Job Schedule import keeps as a spare).
const _showUndated = new Set();
const _justAdded = new Set();   // lines added in this session: never hidden

const STATUS_OPTIONS = [
  { value: "needs_attention", label: "Needs attention" },
  { value: "pending",         label: "Pending" },
  { value: "not_started",     label: "Not started" },
  { value: "in_progress",     label: "In progress" },
  { value: "on_hold",         label: "On hold" },
  { value: "completed",       label: "Completed" },
  { value: "canceled",        label: "Canceled" },
];
const TRAVEL_OPTIONS = [[0, "None"], [2, "2 days"], [3, "3 days"], [4, "4 days"]];
const EQUIP_OPTIONS = ["", "Equip", "No Equip", "Electric"];

const pmName = (pm) => (`${pm.first_name || ""} ${pm.last_name || ""}`.trim() || pm.email || `PM ${pm.id}`);

const STATUS_LABEL = { needs_attention: "No dates yet", pending: "No dates yet", not_started: "Not started", in_progress: "In progress",
  on_hold: "On hold", completed: "Finished", canceled: "Canceled" };
const isUndated = (it) => !it.start_date && !it.end_date;
// An undated line hasn't started anything: say so instead of "Not started".
const statusLabelOf = (it) => (isUndated(it) && it.status !== "canceled" && it.status !== "on_hold"
  ? "No dates yet" : (STATUS_LABEL[it.status] || "Not started"));
const fmtHd = (v) => { if (!v) return "—"; const [y, m, d] = String(v).slice(0, 10).split("-"); return `${Number(m)}/${Number(d)}/${y.slice(2)}`; };
const lastDay = (it) => {
  if (!it.end_date) return null;
  const t = new Date(`${String(it.end_date).slice(0, 10)}T00:00:00`);
  t.setDate(t.getDate() + (Number(it.overage_days) || 0));
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};

// opts.show: which parts to show (Project Setup's cards each show one job):
//   "dates"   start, end (quoted), overage, days off, hold bar, add / delete a set of dates, history
//   "pm"      the PM picker per line
//   "crew"    the crew picker + days off per line
//   "details" wire guidance, travel days, equipment
// Default: everything (the project workspace's Assignment tab). The status is
// worked out from the dates (projects/lifecycle.py) and is shown, not picked.
const ALL_PARTS = ["dates", "pm", "crew", "details", "notes"];

export async function mountAssignmentPanel(container, qboCustomerId, onChange, opts = {}) {
  const show = new Set(opts.show || ALL_PARTS);
  const has = (k) => show.has(k);
  container.innerHTML = `<div class="p-4 text-sm text-black/40">Loading assignment…</div>`;
  let bundle;
  try {
    bundle = await api(`/assignment/bundle?qbo_customer_id=${encodeURIComponent(qboCustomerId)}`);
  } catch (e) {
    container.innerHTML = `<div class="p-4 text-sm text-red-600">Failed to load assignment: ${escapeHtml(e?.message || String(e))}</div>`;
    return;
  }
  // 2026-11-18: assignments per estimate, in work packages (app/packages). The
  // lines below are each package's date ranges; PM and crew are picked per
  // estimate; overage is the project's. Falls back to the plain line list.
  let pk = null;
  try { pk = bundle.qbo && bundle.qbo.qbo_id ? await api(`/packages/${encodeURIComponent(bundle.qbo.qbo_id)}`) : null; } catch (_) { pk = null; }
  const pkMode = !!(pk && (pk.packages || []).length);
  const pms = bundle.project_managers || [];
  const items = (bundle.schedule_items || []).map((it) => ({ ...it }));   // local, mutable
  // Shared crew-editor context (companies + flat crews incl. parents).
  const ctx = bundle;

  const remount = () => mountAssignmentPanel(container, qboCustomerId, onChange, opts);
  const opt = (v, label, sel) => `<option value="${escapeHtml(String(v))}" ${String(sel) === String(v) ? "selected" : ""}>${escapeHtml(label)}</option>`;
  // 'On hold' is driven by the hold bar (it shifts dates) — the select only
  // offers it while the project is on hold or the line already shows it.
  const hold = bundle.hold || null;
  const statusOptions = (sel) => STATUS_OPTIONS
    .filter((s) => s.value !== "on_hold" || hold || sel === "on_hold")
    .map((s) => opt(s.value, s.label, sel)).join("");
  const travelOptions = (sel) => TRAVEL_OPTIONS.map(([v, l]) => opt(v, l, sel || 0)).join("");
  const equipOptions = (sel) => EQUIP_OPTIONS.map((v) => opt(v, v || "None", sel || "")).join("");

  // PM summary shown in the cell (primary name + "+N", or "— assign").
  const pmSummary = (active) => {
    active = active || [];
    if (!active.length) return `<span class="text-black/35">— assign</span>`;
    const nameOf = (id) => { const x = pms.find((a) => String(a.id) === String(id)); return x ? pmName(x) : `#${id}`; };
    const primary = active.find((a) => a.is_primary) || active[0];
    const extra = active.length - 1;
    return `<span class="font-semibold">${escapeHtml(nameOf(primary.project_manager_id))}</span>${extra > 0 ? `<span class="text-black/40 text-[11px]"> +${extra}</span>` : ""}`;
  };

  // Crew summary: every entry as "MTY · Gustavo Ramirez (JR1)", primary first.
  const crewSummary = (active) => {
    const entries = (active || []).map((x) => toDraftEntry(ctx, x));
    if (!entries.length) return `<span class="text-black/35">— assign</span>`;
    entries.sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
    return entries.map((e, i) => {
      const slot = e.slot_code ? ` <span class="text-black/40">(${escapeHtml(e.slot_code)})</span>` : "";
      return `<span class="${i === 0 ? "font-semibold" : ""}">${escapeHtml(entryLabel(ctx, e))}${slot}</span>`;
    }).join(`<span class="text-black/30">, </span>`);
  };

  // Slot codes occupied by the OTHER schedule items (the edited item's entries
  // are being replaced by the draft).
  const takenSlotCodes = (sid) => {
    const taken = new Set();
    for (const it of items) {
      if (String(it.id) === String(sid)) continue;
      for (const e of (it.active_work_crews || [])) {
        if (e.slot_code) taken.add(String(e.slot_code).toUpperCase());
      }
    }
    return taken;
  };

  const field = (label, inner, cls = "") => `
    <div class="ap-f ${cls}"><span class="ap-l">${label}</span>${inner}</div>`;

  let visibleHasMain = true;
  const lineHtml = (it, i) => {
    const cachedH = cachedHistory(it.id);
    const histCount = cachedH ? historyCountOf(cachedH) : it.history_count;
    return `
    <div class="ap-line" data-sid="${it.id}">
      <div class="ap-deck">
        <span class="ap-idx">#${i + 1}${it.is_extra_row && visibleHasMain ? `<span class="text-[10px] text-black/30"> (extra)</span>` : ""}</span>
        ${field("Status", `<span class="ap-status-ro" title="Worked out from the dates: not started, in progress, finished. Put on hold with the hold bar.">${escapeHtml(statusLabelOf(it))}</span>`)}
        ${has("dates") ? field("Start", `<input data-f="start_date" type="date" value="${escapeHtml(it.start_date ? String(it.start_date).slice(0, 10) : "")}" class="input text-xs py-1.5"/>`) : field("Dates", `<span class="ap-ro">${fmtHd(it.start_date)} to ${fmtHd(lastDay(it))}</span>`)}
        ${has("dates") ? field("Quoted end", `<input data-f="end_date" type="date" value="${escapeHtml(it.end_date ? String(it.end_date).slice(0, 10) : "")}" class="input text-xs py-1.5" title="The end the price was built on (the green cell on the Job Schedule)"/>`) : ""}
        ${has("dates") && !pkMode ? field("Overage days", `<input data-f="overage_days" type="number" min="0" step="1" value="${it.overage_days || 0}" class="input text-xs py-1.5 w-16" title="Calendar days worked past the quoted end (orange on the Job Schedule)"/>`) : ""}
        ${has("dates") && !pkMode ? field("Last day", `<span class="ap-ro" title="Quoted end + overage days">${fmtHd(lastDay(it))}</span>`) : ""}
        ${has("pm") && !pkMode ? field("Project manager", `<button data-assign="pm" class="text-left text-xs rounded px-1.5 py-1.5 border border-black/10 hover:bg-black/5 min-w-[9rem]">${pmSummary(it.active_project_managers)}</button>`, "ap-grow") : ""}
        ${has("crew") ? field(pkMode ? "Crew on site (boss · slot)" : "Crew (company · lead · slot)", `<button data-crew-edit="${it.id}" class="text-left text-xs rounded px-1.5 py-1.5 border border-black/10 hover:bg-black/5 whitespace-normal" style="min-width:11rem;">${crewSummary(it.active_work_crews)}</button>`, "ap-grow2") : ""}
      </div>
      <div class="ap-deck">
        ${has("details") ? field("Wire", `<label class="inline-flex items-center" style="height:30px;"><input data-f="wire_guidance" type="checkbox" class="h-4 w-4 cursor-pointer" ${it.wire_guidance ? "checked" : ""}/></label>`) : ""}
        ${has("details") ? field("Travel", `<select data-f="travel_days" class="input text-xs py-1.5 w-20">${travelOptions(it.travel_days)}</select>`) : ""}
        ${has("dates") || has("crew") ? field("Days off", `<button type="button" data-nwd-edit="${it.id}" class="nwd-btn" title="Non-working days (weekends off / specific dates)">${nonWorkingButtonLabel(it.non_working)}</button>`) : ""}
        ${has("details") ? field("Equipment", `<select data-f="equipment_type" class="input text-xs py-1.5 w-28">${equipOptions(it.equipment_type)}</select>`) : ""}
        ${has("notes") ? field("Notes", `<input data-f="notes" type="text" value="${escapeHtml(it.notes || "")}" placeholder="—" title="${escapeHtml(it.notes || "")}" class="input text-xs py-1.5 w-full"/>`, "ap-notes") : ""}
        <div class="ap-f ap-actions">
          <span class="ap-l">&nbsp;</span>
          <div class="flex items-center gap-2" style="height:30px;">
            <span data-savestate class="text-[11px] text-black/30"></span>
            ${has("dates") ? historyBadgeHtml(it.id, histCount, _openHist.has(String(it.id))) : ""}
            ${has("dates") ? `<button data-del class="text-black/30 hover:text-red-600 text-sm" title="Delete this set of dates">✕</button>` : ""}
          </div>
        </div>
      </div>
      ${pkMode && has("dates") ? jsNote((pk.job_schedule || []).find((x) => String(x.schedule_item_id) === String(it.id))) : ""}
      ${_openHist.has(String(it.id)) ? `<div data-hist-row="${it.id}" class="pt-1">${historyPanelHtml(it.id)}</div>` : ""}
    </div>`;
  };

  // Undated lines are hidden while the project has dated ones (shown on request).
  const pkey = String(qboCustomerId);
  const anyDated = items.some((it) => !isUndated(it));
  const hiddenLines = anyDated ? items.filter((it) => isUndated(it) && it.status !== "canceled" && !_justAdded.has(String(it.id))) : [];
  const showHidden = _showUndated.has(pkey);
  const visible = showHidden ? items : items.filter((it) => !hiddenLines.includes(it));
  visibleHasMain = visible.some((it) => !it.is_extra_row);   // "(extra)" only means something next to the main line
  const hiddenNote = !hiddenLines.length ? "" : `<div class="text-[11px] text-black/45 pt-1">${showHidden
    ? `Showing ${hiddenLines.length} line${hiddenLines.length === 1 ? "" : "s"} with no dates · <button type="button" class="underline decoration-dotted hover:text-ink-900" data-undated="hide">hide</button>`
    : `${hiddenLines.length} line${hiddenLines.length === 1 ? "" : "s"} with no dates hidden · <button type="button" class="underline decoration-dotted hover:text-ink-900" data-undated="show">show</button>`}</div>`;
  const bodyLines = visible.length
    ? visible.map(lineHtml).join("")
    : `<div class="py-4 text-center text-sm text-black/40">No schedule items yet — add one below.</div>`;

  const allCanceled = items.length > 0 && items.every((x) => x.status === "canceled");
  const cancelBtn = !has("dates") ? "" : allCanceled
    ? `<div class="hold-bar-wrap hold-on"><span class="hold-pill">Canceled</span><span class="hold-bar-txt">This project is canceled.</span><button type="button" class="hold-btn hold-btn-go" data-restore>Restore</button></div>`
    : `<div class="flex justify-end -mt-1 mb-2"><button type="button" class="text-[11px] text-black/45 hover:text-red-600 underline decoration-dotted" data-cancelproj>Cancel this project…</button></div>`;
  const holdBar = !has("dates") || allCanceled ? "" : hold
    ? `<div class="hold-bar-wrap hold-on" data-hold-bar title="${escapeHtml(holdTitle(hold))}">
        <span class="hold-pill${hold.overdue ? " hold-pill-late" : ""}">On hold until ${fmtHd(hold.expected_resume)}</span>
        <span class="hold-bar-txt">Since <b>${fmtHd(hold.hold_start)}</b>${hold.shift_days ? ` · remaining work moved <b>${hold.shift_days} days</b>` : ""}${hold.reason ? ` · ${escapeHtml(hold.reason)}` : ""}${hold.note ? ` <span class="text-black/45">— ${escapeHtml(hold.note)}</span>` : ""}${hold.overdue ? ` · <b style="color:#b91c1c">resume date has passed</b>` : ""}${hold.created_by_name ? ` <span class="text-black/40">(${escapeHtml(hold.created_by_name)})</span>` : ""}</span>
        <button type="button" class="hold-btn" data-hold-edit>Edit hold</button>
        <button type="button" class="hold-btn hold-btn-go" data-hold-resume>Resume now</button>
      </div>`
    : `<div class="hold-bar-wrap" data-hold-bar>
        <span class="hold-bar-txt text-black/50">Job paused? Put it on hold with an expected resume date — the remaining schedule, invoices, crew payments and expenses move with it so the cash forecast stays right.</span>
        <button type="button" class="hold-btn" data-hold-put>Put on hold</button>
      </div>`;

  // ── package mode helpers ───────────────────────────────────────────────────
  const OFFER = { sent: ["Offer sent", "ap-chip-info"], accepted: ["Offer accepted", "ap-chip-good"], declined: ["Declined", "ap-chip-bad"],
    withdrawn: ["Withdrawn", "ap-chip-quiet"], draft: ["Offer draft", "ap-chip-quiet"] };
  const money0 = (n) => `$${Math.round(Number(n) || 0).toLocaleString()}`;
  const chipH = (t, cls, title = "") => `<span class="ap-chip ${cls}"${title ? ` title="${escapeHtml(title)}"` : ""}>${escapeHtml(t)}</span>`;
  const estById = (q) => (pk?.estimates || []).find((e) => e.qbo_id === String(q));
  // 2026-11-18: the Job Schedule sheet is reference-only: what it says differs
  // from the app is shown here, with "Use these" to take the sheet's values.
  const JS_LABEL = { start_date: "Start", end_date: "End", overage_days: "Overage days", travel_days: "Travel days",
    wire_guidance: "Wire", equipment_type: "Equipment", crews: "Crews", pms: "PMs", non_working: "Days off", status: "Status" };
  const jsVal = (k, v) => {
    if (v == null || v === "") return "—";
    if (k === "start_date" || k === "end_date") return fmtHd(v);
    if (k === "pms") return (v || []).map((id) => { const x = pms.find((m) => String(m.id) === String(id)); return x ? pmName(x) : `#${id}`; }).join(", ") || "—";
    if (k === "crews") return (v || []).join(", ") || "—";
    if (k === "wire_guidance") return Number(v) ? "Yes" : "No";
    if (k === "non_working") return v && typeof v === "object" ? `${(v.dates || []).length} day(s)${v.weekends_off ? ", weekends off" : ""}` : String(v);
    return String(v);
  };
  function jsNote(x) {
    if (!x) return "";
    const parts = Object.entries(x.changes || {}).filter(([k]) => k !== "status")
      .map(([k, [a, b]]) => `${JS_LABEL[k] || k}: <b>${escapeHtml(jsVal(k, b))}</b> <span class="text-black/40">(app: ${escapeHtml(jsVal(k, a))})</span>`);
    if (!parts.length) return "";
    return `<div class="ap-js"><span class="ap-js-t">Job Schedule says</span> ${parts.join(" · ")}
      <button type="button" class="pd-btn" data-js-use="${x.id}" title="Take the Job Schedule's values for this date range">Use these</button></div>`;
  }
  function jsNewVisits() {
    const xs = (pk.job_schedule || []).filter((x) => !x.schedule_item_id);
    return xs.map((x) => `<div class="ap-js"><span class="ap-js-t">Job Schedule has a visit the app doesn't</span> ${fmtHd(x.visit[0])} to ${fmtHd(x.visit[1])} (job ${escapeHtml(x.job || "")})
      <button type="button" class="pd-btn" data-js-use="${x.id}" title="Add it as a date range (in the first package; move its estimates after)">Add it</button></div>`).join("");
  }

  function projectStrip() {
    const t = pk.timeline || {};
    const brk = (t.breaks || []).map((b) => `${fmtHd(b.from)}–${fmtHd(b.to)}`).join(", ");
    if (!has("dates")) {
      return has("pm") ? `<div class="ap-proj"><div class="ap-proj-pm" style="margin-left:0"><span class="ap-l">PM for every estimate</span>
        <span class="flex gap-1"><select data-pk-pmall class="input text-xs py-1.5"><option value="">Pick a PM…</option>${pms.map((x) => `<option value="${x.id}">${escapeHtml(pmName(x))}</option>`).join("")}</select>
        <button type="button" class="pd-btn" data-pk-pmall-go>Set for all</button></span></div></div>` : "";
    }
    return `<div class="ap-proj">
      <div><span class="ap-l">Project</span><b>${t.start ? `${fmtHd(t.start)} to ${fmtHd(t.end)}` : "No dates yet"}</b>
        <em>${t.start ? `scheduled end, from ${pk.packages.length} package${pk.packages.length === 1 ? "" : "s"}` : "set each package's dates below"}</em></div>
      ${has("dates") ? `<div><span class="ap-l">Overage days</span><input data-pk-overage type="number" min="0" step="1" value="${t.overage_days || 0}" class="input text-xs py-1.5 w-20" ${t.start ? "" : "disabled"}
          title="Only for running past the scheduled end without a change order. A change order with its own dates extends the timeline instead."/>
        <em>past the scheduled end, no change order</em></div>` : ""}
      ${t.start ? `<div><span class="ap-l">Expected finish</span><b>${fmtHd(t.finish)}</b><em>${t.overage_days ? `${fmtHd(t.end)} + ${t.overage_days} day${t.overage_days === 1 ? "" : "s"}` : "same as the scheduled end"}</em></div>` : ""}
      ${brk ? `<div><span class="ap-l">Breaks</span><b>${escapeHtml(brk)}</b><em>no work between date ranges</em></div>` : ""}
      ${has("pm") ? `<div class="ap-proj-pm"><span class="ap-l">PM for every estimate</span>
        <span class="flex gap-1"><select data-pk-pmall class="input text-xs py-1.5"><option value="">Pick a PM…</option>${pms.map((x) => `<option value="${x.id}">${escapeHtml(pmName(x))}</option>`).join("")}</select>
        <button type="button" class="pd-btn" data-pk-pmall-go>Set for all</button></span></div>` : ""}
    </div>
    ${t.overage_elsewhere ? `<div class="ap-warn">Earlier date ranges also carry ${t.overage_elsewhere} overage day${t.overage_elsewhere === 1 ? "" : "s"} (from before packages). If those days were a change order's, give the change order its own dates instead.</div>` : ""}`;
  }
  function crewOptions(p, sel) {
    const a = avail[p.id];
    const free = {};
    for (const c of (a?.companies || [])) free[String(c.id)] = c;
    const list = (bundle.companies || []).slice().sort((x, y) => (Number(free[String(y.id)]?.min_free_weekdays) || 0) - (Number(free[String(x.id)]?.min_free_weekdays) || 0) || String(x.name).localeCompare(String(y.name)));
    return `<option value="">${p.has_dates ? "Pick a crew…" : "Set dates first"}</option>` + list.map((c) => {
      const f = free[String(c.id)];
      const tag = f ? ` · ${f.min_free_weekdays} free` : "";
      return `<option value="${c.id}" ${String(sel) === String(c.id) ? "selected" : ""}>${escapeHtml(c.name)}${tag}</option>`;
    }).join("");
  }
  function estRow(e, p) {
    const off = !e.accepted;
    const oc = e.offer ? OFFER[e.offer.status] || [e.offer.status, "ap-chip-quiet"] : null;
    const moveSel = `<select class="input text-xs py-1.5" data-pk-move="${e.qbo_id}" title="Estimates in one package share dates. Pick another package, or give it its own.">
        ${pk.packages.map((x) => `<option value="${x.id}" ${x.id === e.package_id ? "selected" : ""}>${escapeHtml(x.name)}</option>`).join("")}
        <option value="new">New package (own dates)</option></select>`;
    return `<tr class="${off ? "ap-est-off" : ""}">
      <td><b>#${escapeHtml(e.doc_number || "")}</b> ${chipH(e.change_order ? "Change order" : "Original", e.change_order ? "ap-chip-quiet" : "ap-chip-info")}
        ${off ? chipH(e.status || "Not accepted", "ap-chip-quiet") : ""}${!e.placed && e.accepted ? chipH("New: check its package", "ap-chip-warn", "Arrived after the project was set up: keep it here or move it") : ""}
        <div class="text-[11px] text-black/50 tabular-nums">${money0(e.total)}${e.accepted_date ? ` · accepted ${fmtHd(e.accepted_date)}` : ""}</div></td>
      ${has("pm") ? `<td><select class="input text-xs py-1.5" data-pk-pm="${e.qbo_id}"><option value="">— PM</option>${pms.map((x) => `<option value="${x.id}" ${String(e.pm_id) === String(x.id) ? "selected" : ""}>${escapeHtml(pmName(x))}</option>`).join("")}</select></td>` : ""}
      ${has("crew") ? `<td><select class="input text-xs py-1.5" data-pk-crew="${e.qbo_id}" ${p.has_dates && e.accepted ? "" : "disabled"} title="${p.has_dates ? "Crews sorted by how many are free on these dates (weekdays)" : "A crew is picked for dates: set this package's dates first"}">${crewOptions(p, e.crew_company_id || e.crew_id)}</select>
        ${oc ? `<div class="mt-0.5">${chipH(oc[0], oc[1], e.offer.sent_at ? `Sent ${e.offer.sent_at}` : "")}</div>` : e.crew_id ? `<div class="mt-0.5">${chipH("Offer not sent", "ap-chip-warn", "Send it from the crew roll-up under Schedules, once the pay schedule is confirmed")}</div>` : ""}</td>` : ""}
      ${has("dates") ? `<td>${moveSel}${!e.placed && e.accepted ? ` <button type="button" class="su-linkbtn" data-pk-keep="${e.qbo_id}" data-pkid="${e.package_id}">Keep here</button>` : ""}</td>` : ""}
    </tr>`;
  }
  function packagesHtml() {
    const lineIdx = new Map(items.map((it, i) => [String(it.id), i]));
    return pk.packages.map((p) => {
      const all = (pk.estimates || []).filter((e) => e.package_id === p.id);
      const live = (e) => e.accepted || e.status === "Pending";
      const mine = all.filter(live), dropped = all.filter((e) => !live(e));
      let lines = items.filter((it) => it.package_id === p.id);
      const dated = lines.some((it) => !isUndated(it));
      const hidden = dated ? lines.filter((it) => isUndated(it) && it.status !== "canceled" && !_justAdded.has(String(it.id))) : [];
      if (!_showUndated.has(pkey)) lines = lines.filter((it) => !hidden.includes(it));
      const head = `${p.start ? `${fmtHd(p.start)} to ${fmtHd(p.end)}` : "No dates yet"}${p.breaks.length ? ` · ${p.breaks.length} break${p.breaks.length === 1 ? "" : "s"}` : ""} · ${mine.filter((e) => e.accepted).length} accepted · ${money0(p.accepted_total)}`;
      return `<section class="ap-pk" data-pk="${p.id}">
        <div class="ap-pk-head"><button type="button" class="ap-pk-name" data-pk-rename="${p.id}" title="Rename this package">${escapeHtml(p.name)}</button><span class="ap-pk-sum">${head}</span></div>
        ${mine.length && (has("pm") || has("crew") || has("dates")) ? `<div class="overflow-x-auto"><table class="ap-pk-est"><thead><tr><th>Estimate</th>${has("pm") ? "<th>PM</th>" : ""}${has("crew") ? "<th>Crew</th>" : ""}${has("dates") ? "<th>Package</th>" : ""}</tr></thead>
          <tbody>${mine.map((e) => estRow(e, p)).join("")}</tbody></table></div>` : mine.length ? "" : `<div class="text-xs text-black/45 py-1">No estimates in this package.</div>`}
        ${dropped.length ? `<div class="text-[11px] text-black/45 pb-1">Not counted: ${dropped.map((e) => `#${escapeHtml(e.doc_number || "")} (${escapeHtml((e.status || "").toLowerCase() || "not accepted")})`).join(", ")}</div>` : ""}
        ${has("dates") || has("details") || has("crew") ? `<div class="ap-pk-lines">${lines.map((it) => lineHtml(it, lineIdx.get(String(it.id)))).join("") || `<div class="text-xs text-black/45 py-2">No date range yet.</div>`}
          ${hidden.length && !_showUndated.has(pkey) ? `<div class="text-[11px] text-black/45 pt-1">${hidden.length} line${hidden.length === 1 ? "" : "s"} with no dates hidden · <button type="button" class="underline decoration-dotted" data-undated="show">show</button></div>` : ""}</div>` : ""}
        ${has("dates") ? `<button type="button" class="text-xs font-semibold text-emerald-700 hover:underline mt-1" data-pk-addline="${p.id}">+ Add a date range to ${escapeHtml(p.name)} (a break in the work)</button>` : ""}
      </section>`;
    }).join("");
  }

  let avail = {};
  if (pkMode && has("crew")) {
    await Promise.all(pk.packages.filter((p) => p.has_dates).map(async (p) => {
      try { avail[p.id] = await api(`/offers/crew-availability?start=${p.start}&end=${p.end}`); } catch (_) { /* picker shows names only */ }
    }));
  }
  container.innerHTML = `
    <div class="p-4 sm:p-5 text-ink-900">
      ${holdBar}
      ${cancelBtn}
      <div class="flex items-start gap-3 flex-wrap mb-3">
        <div class="text-xs text-black/50 flex-1" style="min-width:220px;">${escapeHtml(opts.intro || (pkMode
          ? "Each package is one or more estimates that share dates. Pick the PM and crew per estimate; set each package's dates and details. Changes save automatically."
          : "Assign the PM(s), crew(s), dates, and schedule detail for each set of dates. A project can have more than one (extra crews / phases). Changes save automatically."))}</div>
        ${has("crew") ? `<span data-ccx-slot></span>` : ""}
      </div>
      ${pkMode && (has("dates") || has("pm")) ? projectStrip() : ""}
      ${pkMode && has("dates") ? jsNewVisits() : ""}
      <div data-rows>${pkMode ? packagesHtml() : bodyLines}</div>
      ${pkMode ? "" : hiddenNote}
      ${has("dates") && !pkMode ? `<div class="pt-3">
        <button data-add class="text-xs font-semibold text-emerald-700 hover:underline">+ Add another set of dates</button>
      </div>` : ""}
    </div>`;

  const rowsHost = container.querySelector("[data-rows]");
  const itemById = (sid) => items.find((x) => String(x.id) === String(sid));

  // CR5 B3: crew-consistency chip in the header area. The panel remounts after
  // every save, so the chip re-fetches and tracks crew changes automatically.
  // 2026-11-15: crew only (Project Setup shows it on the Crew card, not PM).
  if (has("crew")) mountConsistencyChip(container, bundle.qbo && bundle.qbo.qbo_id);
  container.querySelector("[data-undated]")?.addEventListener("click", (e) => {
    if (e.currentTarget.dataset.undated === "show") _showUndated.add(pkey); else _showUndated.delete(pkey);
    remount();
  });

  // CR4: refresh one line's history panel + badge from the cache.
  function refreshHistRow(sid) {
    sid = String(sid);
    const panel = rowsHost?.querySelector(`[data-hist-row="${sid}"]`);
    if (panel) panel.innerHTML = historyPanelHtml(sid);
    const badge = container.querySelector(`[data-hist-toggle="${sid}"] span`);
    const rowsH = cachedHistory(sid);
    if (badge && rowsH) badge.textContent = historyBadgeLabel(historyCountOf(rowsH));
  }
  // Panels left open across a remount: fetch any that aren't cached yet.
  for (const sid of _openHist) {
    if (!cachedHistory(sid) && items.some((x) => String(x.id) === sid)) {
      loadHistory(sid).then(() => refreshHistRow(sid)).catch(() => {});
    }
  }

  function payloadFor(line, it) {
    const g = (f) => line.querySelector(`[data-f="${f}"]`);
    const v = (f, cur) => { const el = g(f); return el ? (el.type === "checkbox" ? (el.checked ? 1 : 0) : el.value) : cur; };
    const iso = (x) => (x ? String(x).slice(0, 10) : null);
    const pmIds = (it.active_project_managers || []).map((a) => Number(a.project_manager_id));
    return {
      schedule_item_id: it.id || null,
      qbo_customer_id: Number(qboCustomerId),
      status: it.status || "not_started",
      start_date: v("start_date", iso(it.start_date)) || null,
      end_date: v("end_date", iso(it.end_date)) || null,
      wire_guidance: Number(v("wire_guidance", it.wire_guidance ? 1 : 0)) ? 1 : 0,
      travel_days: Number(v("travel_days", it.travel_days)) || 0,
      overage_days: Number(v("overage_days", it.overage_days)) || 0,
      equipment_type: v("equipment_type", it.equipment_type) || null,
      notes: v("notes", it.notes) || null,
      // 0062: non-working days ride the normal payload (null = none).
      non_working: it.non_working || null,
      project_manager_ids: pmIds,
      primary_project_manager_id: (it.active_project_managers || []).find((a) => a.is_primary)?.project_manager_id || (pmIds[0] || null),
      // CR5 A2: v2 crew_assignments + the legacy dual-write fields, from the
      // same shared builder as the Assignment page.
      ...crewFieldsFor(ctx, it.active_work_crews || []),
    };
  }

  async function saveRow(line, sid) {
    const it = itemById(sid);
    if (!it) return;
    const state = line.querySelector("[data-savestate]");
    if (state) { state.textContent = "Saving…"; state.className = "text-[11px] text-black/40"; }
    try {
      await api("/assignment/save", { method: "POST", body: JSON.stringify(payloadFor(line, it)) });
      if (state) { state.textContent = "Saved ✓"; state.className = "text-[11px] text-emerald-600"; setTimeout(() => { if (state.textContent === "Saved ✓") state.textContent = ""; }, 1500); }
      // CR4: the save may have recorded a history row — refresh badge/panel.
      invalidateHistory(sid);
      loadHistory(String(sid)).then(() => refreshHistRow(sid)).catch(() => {});
      if (onChange) onChange();
    } catch (e) {
      if (state) { state.textContent = "Failed"; state.className = "text-[11px] text-red-600"; }
      alert("Save failed: " + (e?.message || e));
    }
  }

  // ── popups (PM multi-select + shared crew editor) ──────────────────────────
  let openPopup = null;
  const closePopup = () => { if (openPopup) { openPopup.remove(); openPopup = null; document.removeEventListener("mousedown", onDocDown, true); } };
  function onDocDown(e) { if (openPopup && !openPopup.contains(e.target) && !e.target.closest("[data-assign],[data-crew-edit]")) closePopup(); }

  function placePopup(pop, anchor) {
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 16)) + "px";
    pop.style.top = Math.min(r.bottom + 4, Math.max(8, window.innerHeight - pop.offsetHeight - 16)) + "px";
    openPopup = pop;
    setTimeout(() => document.addEventListener("mousedown", onDocDown, true), 0);
  }

  // PM multi-select (unchanged behavior: checkbox list + primary radio).
  function openPmEditor(line, sid, anchor) {
    closePopup();
    const it = itemById(sid); if (!it) return;
    const active = it.active_project_managers || [];
    const checkedSet = new Set(active.map((a) => String(a.project_manager_id)));
    const primaryId = active.find((a) => a.is_primary)?.project_manager_id || (active[0] ? active[0].project_manager_id : null);
    const rowsHtml = pms.map((x) => `
      <label class="flex items-center justify-between gap-2 py-1">
        <span class="flex items-center gap-2 min-w-0">
          <input type="checkbox" class="h-4 w-4" data-chk data-id="${x.id}" ${checkedSet.has(String(x.id)) ? "checked" : ""}/>
          <span class="truncate">${escapeHtml(pmName(x))}</span>
        </span>
        <span class="flex items-center gap-1 text-[11px] text-black/50 shrink-0"><span>Primary</span>
          <input type="radio" name="prim" class="h-4 w-4" data-prim data-id="${x.id}" ${String(primaryId || "") === String(x.id) ? "checked" : ""}/></span>
      </label>`).join("") || `<div class="text-sm text-black/50">None found.</div>`;
    const pop = document.createElement("div");
    pop.className = "fixed z-[200] w-[340px] max-w-[92vw] rounded-xl border border-black/10 bg-white text-ink-900 p-3 shadow-xl text-sm";
    pop.innerHTML = `
      <div class="text-xs font-bold text-black/50 mb-2">Project Managers</div>
      <div class="max-h-[240px] overflow-auto pr-1">${rowsHtml}</div>
      <div class="mt-3 flex justify-end gap-2">
        <button type="button" data-cancel class="rounded-lg border border-black/10 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">Cancel</button>
        <button type="button" data-apply class="btn-primary text-xs px-3 py-1.5">Apply</button>
      </div>`;
    placePopup(pop, anchor);
    // Mirror the standalone page: picking a "primary" auto-includes that row;
    // unchecking a row that's primary clears the primary (no orphan primary).
    pop.addEventListener("change", (e) => {
      const rad = e.target.closest("[data-prim]");
      if (rad && rad.checked) {
        const cb = pop.querySelector(`[data-chk][data-id="${rad.getAttribute("data-id")}"]`);
        if (cb && !cb.checked) cb.checked = true;
        return;
      }
      const chk = e.target.closest("[data-chk]");
      if (chk && !chk.checked) {
        const r = pop.querySelector(`[data-prim][data-id="${chk.getAttribute("data-id")}"]`);
        if (r && r.checked) r.checked = false;
      }
    });
    pop.querySelector("[data-cancel]").addEventListener("click", closePopup);
    pop.querySelector("[data-apply]").addEventListener("click", async () => {
      const ids = [...pop.querySelectorAll("[data-chk]:checked")].map((c) => Number(c.getAttribute("data-id")));
      let prim = pop.querySelector("[data-prim]:checked")?.getAttribute("data-id");
      prim = prim ? Number(prim) : (ids[0] || null);
      if (prim && !ids.includes(prim)) ids.push(prim);
      it.active_project_managers = ids.map((id) => ({ project_manager_id: id, is_primary: id === prim ? 1 : 0 }));
      closePopup();
      await saveRow(line, sid);
      remount();
    });
  }

  // CR5 A2: the shared CR3 company→lead→slot crew editor (utils/crew-editor.js)
  // replaces the legacy crew multi-select (whose "+ Add crew" was broken).
  function openCrewEditor(line, sid, anchor) {
    closePopup();
    const it = itemById(sid); if (!it) return;
    const draft = (it.active_work_crews || []).map((x) => toDraftEntry(ctx, x));
    const pop = document.createElement("div");
    pop.className = "fixed z-[200] rounded-xl border border-black/10 bg-white text-ink-900 p-3 shadow-xl text-sm";
    pop.style.width = "380px";
    pop.style.maxWidth = "min(92vw,440px)";
    const radioName = `apcrew-primary-${sid}`;
    const renderBody = () => {
      pop.innerHTML = `
        ${crewEditorBodyHtml(ctx, draft, radioName,
          { start: it.start_date, end: it.end_date, overage: it.overage_days })}
        <div class="mt-3 flex justify-end gap-2">
          <button type="button" data-cancel class="rounded-lg border border-black/10 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">Cancel</button>
          <button type="button" data-apply class="btn-primary text-xs px-3 py-1.5">Apply</button>
        </div>`;
    };
    renderBody();
    placePopup(pop, anchor);
    pop.addEventListener("click", async (e) => {
      if (e.target.closest("[data-cancel]")) { closePopup(); return; }
      if (e.target.closest("[data-apply]")) {
        it.active_work_crews = draft
          .map((x) => toDraftEntry(ctx, x))
          .filter((e2) => e2.company_id != null)
          .map((e2) => ({
            work_crew_id: e2.work_crew_id, company_id: e2.company_id,
            lead_crew_id: e2.lead_crew_id, slot_code: (e2.slot_code || "").trim().toUpperCase() || null,
            is_primary: e2.is_primary ? 1 : 0,
          }));
        closePopup();
        await saveRow(line, sid);
        remount();
        return;
      }
      if (handleCrewEditorClick(e, draft)) renderBody();
    });
    pop.addEventListener("change", (e) => {
      const r = handleCrewEditorChange(e, ctx, draft, takenSlotCodes(sid));
      if (r.rerender) renderBody();
    });
    pop.addEventListener("input", (e) => handleCrewEditorInput(e, draft));
  }

  rowsHost?.addEventListener("change", (e) => {
    if (!e.target.closest("[data-f]")) return;
    const line = e.target.closest("[data-sid]");
    const sid = line?.getAttribute("data-sid");
    if (sid && sid !== "null") saveRow(line, Number(sid));
  });
  rowsHost?.addEventListener("click", async (e) => {
    // CR4: history badge — toggle the sub-lines block under this line.
    const histBtn = e.target.closest("[data-hist-toggle]");
    if (histBtn) {
      const sid = String(histBtn.getAttribute("data-hist-toggle"));
      const line = histBtn.closest("[data-sid]");
      const existing = rowsHost.querySelector(`[data-hist-row="${sid}"]`);
      if (existing) {
        existing.remove();
        _openHist.delete(sid);
        histBtn.classList.remove("ah-open");
        histBtn.setAttribute("aria-expanded", "false");
        return;
      }
      _openHist.add(sid);
      histBtn.classList.add("ah-open");
      histBtn.setAttribute("aria-expanded", "true");
      const panel = document.createElement("div");
      panel.setAttribute("data-hist-row", sid);
      panel.className = "pt-1";
      panel.innerHTML = historyPanelHtml(sid);
      line.appendChild(panel);
      if (!cachedHistory(sid)) {
        try { await loadHistory(sid); } catch { /* panel keeps the loading note */ }
        refreshHistRow(sid);
      }
      return;
    }

    const assign = e.target.closest("[data-assign]");
    if (assign) {
      const line = assign.closest("[data-sid]");
      const sid = line?.getAttribute("data-sid");
      if (sid && sid !== "null") openPmEditor(line, Number(sid), assign);
      return;
    }
    const crewBtn = e.target.closest("[data-crew-edit]");
    if (crewBtn) {
      const line = crewBtn.closest("[data-sid]");
      const sid = line?.getAttribute("data-sid");
      if (sid && sid !== "null") openCrewEditor(line, Number(sid), crewBtn);
      return;
    }
    // 0062: "Days off" popover — weekends-off + specific dates; saves through
    // the normal payload. NO auto-overage (text hint only; link focuses the
    // line's overage input).
    const nwdBtn = e.target.closest("[data-nwd-edit]");
    if (nwdBtn) {
      const line = nwdBtn.closest("[data-sid]");
      const sid = line?.getAttribute("data-sid");
      const it = sid && sid !== "null" ? itemById(sid) : null;
      if (!it) return;
      closePopup();
      openNonWorkingEditor(nwdBtn, {
        value: it.non_working,
        startDate: it.start_date ? String(it.start_date).slice(0, 10) : "",
        endDate: it.end_date ? String(it.end_date).slice(0, 10) : "",
        overageDays: Number(line.querySelector('[data-f="overage_days"]')?.value) || 0,
        onApply: async (v) => {
          it.non_working = v;
          await saveRow(line, Number(sid));
          remount();
        },
        onFocusOverage: () => line.querySelector('[data-f="overage_days"]')?.focus(),
      });
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      const line = del.closest("[data-sid]");
      const sid = line?.getAttribute("data-sid");
      if (!sid || sid === "null") return;
      if (!confirm("Delete this schedule item? This removes its assignment and cannot be undone.")) return;
      try { await api(`/assignment/schedule-item/${sid}`, { method: "DELETE" }); if (onChange) onChange(); remount(); }
      catch (err) { alert("Delete failed: " + (err?.message || err)); }
    }
  });

  // 2026-11-18: package actions
  if (pkMode) {
    const eid = encodeURIComponent(bundle.qbo.qbo_id);
    const post = async (path, body, method = "POST") => {
      try { await api(`/packages/${eid}${path}`, { method, body: JSON.stringify(body || {}) }); if (onChange) onChange(); remount(); }
      catch (err) { alert(`Couldn't save: ${err?.message || err}`); remount(); }
    };
    container.addEventListener("change", (e) => {
      const t = e.target;
      if (t.matches("[data-pk-pm]")) post("/pm", { pm_id: t.value ? Number(t.value) : null, estimates: [t.dataset.pkPm] });
      else if (t.matches("[data-pk-crew]")) post(`/estimate/${encodeURIComponent(t.dataset.pkCrew)}/crew`, { crew_id: t.value ? Number(t.value) : null });
      else if (t.matches("[data-pk-move]")) post(`/estimate/${encodeURIComponent(t.dataset.pkMove)}/package`, { package_id: t.value === "new" ? "new" : Number(t.value) });
      else if (t.matches("[data-pk-overage]")) post("/overage", { days: Number(t.value) || 0 });
    });
    container.addEventListener("click", async (e) => {
      const js = e.target.closest("[data-js-use]");
      if (js) { post(`/job-schedule/${js.dataset.jsUse}/apply`, {}); return; }
      const b = e.target.closest("[data-pk-addline],[data-pk-rename],[data-pk-keep],[data-pk-pmall-go]");
      if (!b) return;
      if (b.dataset.pkAddline) {
        try {
          const r = await api(`/packages/${eid}/package/${b.dataset.pkAddline}/line`, { method: "POST", body: "{}" });
          if (r && r.added_line) _justAdded.add(String(r.added_line));
          if (onChange) onChange();
          remount();
        } catch (err) { alert(`Couldn't add: ${err?.message || err}`); }
      } else if (b.dataset.pkRename) {
        const cur = pk.packages.find((x) => String(x.id) === b.dataset.pkRename);
        const name = prompt("Package name (blank = Package n)", cur?.custom_name ? cur.name : "");
        if (name !== null) post(`/package/${b.dataset.pkRename}`, { name }, "PATCH");
      } else if (b.dataset.pkKeep) {
        post(`/estimate/${encodeURIComponent(b.dataset.pkKeep)}/package`, { package_id: Number(b.dataset.pkid) });
      } else if (b.matches("[data-pk-pmall-go]")) {
        const v = container.querySelector("[data-pk-pmall]")?.value;
        if (!v) { alert("Pick a PM first."); return; }
        post("/pm", { pm_id: Number(v), estimates: null });
      }
    });
  }

  // 0078: hold actions — after any change the panel remounts (dates moved).
  const afterHold = () => { if (onChange) onChange({ hold: true }); remount(); };
  const pname = (bundle.qbo && bundle.qbo.display_name) || "";
  container.querySelector("[data-hold-put]")?.addEventListener("click", () =>
    openHoldDialog({ qboCustomerId, projectName: pname, hold: null, onDone: afterHold }));
  container.querySelector("[data-hold-edit]")?.addEventListener("click", () =>
    openHoldDialog({ qboCustomerId, projectName: pname, hold, onDone: afterHold }));
  container.querySelector("[data-hold-resume]")?.addEventListener("click", () =>
    resumeHold({ qboCustomerId, hold, onDone: afterHold }));

  // 2026-11-12: Cancel / Restore (with a reason) are the manual statuses; the
  // rest follow the dates.
  const qboId = bundle.qbo && bundle.qbo.qbo_id;
  container.querySelector("[data-cancelproj]")?.addEventListener("click", async () => {
    const reason = prompt(`Cancel ${pname || "this project"}? Every set of dates is canceled and it leaves the schedules and the cash forecast.\n\nWhy is it canceled?`);
    if (reason === null) return;
    if (!reason.trim()) { alert("Say why it's canceled (kept in the history)."); return; }
    try { await api(`/projects/${encodeURIComponent(qboId)}/status`, { method: "POST", body: JSON.stringify({ status: "canceled", reason }) }); if (onChange) onChange(); remount(); }
    catch (e) { alert("Couldn't cancel: " + (e?.message || e)); }
  });
  container.querySelector("[data-restore]")?.addEventListener("click", async () => {
    if (!confirm("Restore this project? Its status follows its dates again.")) return;
    try { await api(`/projects/${encodeURIComponent(qboId)}/status`, { method: "POST", body: JSON.stringify({ status: "not_started", reason: "Restored" }) }); if (onChange) onChange(); remount(); }
    catch (e) { alert("Couldn't restore: " + (e?.message || e)); }
  });

  container.querySelector("[data-add]")?.addEventListener("click", async () => {
    try {
      const r = await api("/assignment/save", { method: "POST", body: JSON.stringify({ qbo_customer_id: Number(qboCustomerId), status: "not_started", project_manager_ids: [], work_crew_ids: [] }) });
      if (r && r.schedule_item_id) _justAdded.add(String(r.schedule_item_id));   // keep the new (undated) line in view
      if (onChange) onChange();
      remount();
    } catch (e) { alert("Could not add schedule item: " + (e?.message || e)); }
  });
}
