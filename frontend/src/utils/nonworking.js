// PROJECT NON-WORKING DAYS (0062) — shared "Days off" control used by the
// office Assignment page (assignment.js), the workspace Assignment tab
// (assignment-panel.js) and the Schedules-page modal (schedule.js).
//
// Value shape (same as the API's non_working field):
//   null                                  -> no non-working days
//   {weekends_off: bool, dates: ["YYYY-MM-DD", ...]} -> config
//
// The control is a compact button ("2 days off" / "weekends off · 3 days")
// whose popover offers a weekends-off checkbox + a date list (add input +
// removable chips). NO auto-overage: when listed dates fall inside the
// schedule window the popover shows a text hint "N working days lost — add
// overage?" (optionally focusing the host's overage field — nothing else).
//
// Styling: real CSS (.nwd-*) appended to BOTH styles.css and output.css;
// the few Tailwind utilities used here are grep-verified in the prebuilt
// output.css.
import { escapeHtml } from "./html.js";

export function normalizeNonWorking(nw) {
  if (!nw || typeof nw !== "object") return null;
  const weekends = !!nw.weekends_off;
  const dates = [...new Set((nw.dates || [])
    .map((d) => String(d).slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  if (!weekends && !dates.length) return null;
  return { weekends_off: weekends, dates };
}

/** Compact label for the control button: "—" when empty. */
export function nonWorkingSummary(nw) {
  nw = normalizeNonWorking(nw);
  if (!nw) return "";
  const n = nw.dates.length;
  const datesBit = n ? `${n} day${n === 1 ? "" : "s"} off` : "";
  if (nw.weekends_off && n) return `weekends off · ${n} day${n === 1 ? "" : "s"}`;
  if (nw.weekends_off) return "weekends off";
  return datesBit;
}

/** Sat/Sun check straight from the ISO string (UTC — no TZ drift). */
export function isWeekendYmd(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return false;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun .. 6=Sat
  return dow === 0 || dow === 6;
}

/** Is this ISO day a non-working day under the config? (weekends_off applies
 *  anywhere — hosts bound it to the bar/window themselves when needed). */
export function isNonWorkingYmd(nw, ymd) {
  nw = normalizeNonWorking(nw);
  if (!nw) return false;
  const day = String(ymd).slice(0, 10);
  if (nw.dates.includes(day)) return true;
  return nw.weekends_off && isWeekendYmd(day);
}

const addDaysYmd = (ymd, n) => {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};

/** Working days lost to the LISTED dates inside start..true-end (end +
 *  overage). Dates already covered by weekends-off don't double count —
 *  the editor hint ("N working days lost — add overage?") uses this. */
export function countWorkingDaysLost(nw, startYmd, endYmd, overageDays) {
  nw = normalizeNonWorking(nw);
  if (!nw || !nw.dates.length || !startYmd || !endYmd) return 0;
  const start = String(startYmd).slice(0, 10);
  const trueEnd = addDaysYmd(endYmd, Number(overageDays) || 0);
  return nw.dates.filter((d) =>
    d >= start && d <= trueEnd && !(nw.weekends_off && isWeekendYmd(d))).length;
}

/** Non-working days in the half-open ISO range (fromYmd, toYmd] — the
 *  days-remaining calculators subtract this from "N days remaining". */
export function countNonWorkingBetween(nw, fromYmd, toYmd) {
  nw = normalizeNonWorking(nw);
  if (!nw || !fromYmd || !toYmd || toYmd <= fromYmd) return 0;
  let count = 0;
  let cur = addDaysYmd(fromYmd, 1);
  let guard = 0;
  while (cur <= String(toYmd).slice(0, 10) && guard++ < 1000) {
    if (isNonWorkingYmd(nw, cur)) count++;
    cur = addDaysYmd(cur, 1);
  }
  return count;
}

const fmtMDY = (s) => {
  const [y, m, d] = String(s).slice(0, 10).split("-");
  return (y && m && d) ? `${Number(m)}/${Number(d)}/${String(y).slice(-2)}` : s;
};

/** The compact control's inner HTML (hosts wrap it in their own button). */
export function nonWorkingButtonLabel(nw) {
  const s = nonWorkingSummary(nw);
  return s ? escapeHtml(s) : `<span class="nwd-none">—</span>`;
}

/**
 * Open the "Days off" popover anchored to `anchor`.
 * opts: {value, startDate, endDate, overageDays, onApply(normalizedOrNull),
 *        onFocusOverage()?} — onFocusOverage, when given, wires the hint's
 *  "add overage?" link (close + focus; no value is changed).
 * Returns the popover element.
 */
export function openNonWorkingEditor(anchor, opts) {
  document.querySelector(".nwd-pop")?.remove();
  const draft = normalizeNonWorking(opts.value) || { weekends_off: false, dates: [] };

  const pop = document.createElement("div");
  pop.className = "nwd-pop";

  const render = () => {
    const lost = countWorkingDaysLost(draft, opts.startDate, opts.endDate, opts.overageDays);
    const chips = draft.dates.map((d) => `
      <span class="nwd-chip">${escapeHtml(fmtMDY(d))}
        <button type="button" class="nwd-chip-x" data-nwd-rm="${escapeHtml(d)}" title="Remove ${escapeHtml(fmtMDY(d))}">✕</button>
      </span>`).join("");
    pop.innerHTML = `
      <div class="nwd-title">Days off — no work on these days</div>
      <label class="nwd-weekends">
        <input type="checkbox" class="h-4 w-4" data-nwd-weekends ${draft.weekends_off ? "checked" : ""}/>
        Weekends off (Sat + Sun)
      </label>
      <div class="nwd-addrow">
        <input type="date" class="input text-xs py-1.5" data-nwd-date/>
        <button type="button" class="nwd-addbtn" data-nwd-add>+ Add day</button>
      </div>
      <div class="nwd-chips">${chips || `<span class="nwd-none">No specific days off.</span>`}</div>
      ${lost > 0 ? `
        <div class="nwd-hint">${lost} working day${lost === 1 ? "" : "s"} lost${
          opts.onFocusOverage
            ? ` — <button type="button" class="nwd-hintlink" data-nwd-overage>add overage?</button>`
            : " — add overage?"}</div>` : ""}
      <div class="nwd-foot">
        <button type="button" class="rounded-lg border border-black/10 px-3 py-1.5 text-xs font-semibold hover:bg-black/5" data-nwd-cancel>Cancel</button>
        <button type="button" class="btn-primary text-xs px-3 py-1.5" data-nwd-apply>Apply</button>
      </div>`;
  };
  render();

  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 16)) + "px";
  pop.style.top = Math.min(r.bottom + 4, Math.max(8, window.innerHeight - pop.offsetHeight - 16)) + "px";

  const close = () => {
    pop.remove();
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onDocDown = (e) => { if (!pop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(); };
  // stopPropagation: hosts with their own Escape handling (the Schedules
  // modal) shouldn't also close when Escape dismisses just this popover.
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  setTimeout(() => {
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);

  const addDate = () => {
    const inp = pop.querySelector("[data-nwd-date]");
    const v = inp && inp.value;
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    if (draft.dates.length >= 120) return; // server cap — mirror it
    if (!draft.dates.includes(v)) draft.dates = [...draft.dates, v].sort();
    render();
    const again = pop.querySelector("[data-nwd-date]");
    if (again) again.focus();
  };

  pop.addEventListener("click", (e) => {
    if (e.target.closest("[data-nwd-cancel]")) { close(); return; }
    if (e.target.closest("[data-nwd-apply]")) {
      const v = normalizeNonWorking(draft);
      close();
      opts.onApply && opts.onApply(v);
      return;
    }
    if (e.target.closest("[data-nwd-add]")) { addDate(); return; }
    const rm = e.target.closest("[data-nwd-rm]");
    if (rm) {
      const d = rm.getAttribute("data-nwd-rm");
      draft.dates = draft.dates.filter((x) => x !== d);
      render();
      return;
    }
    if (e.target.closest("[data-nwd-overage]")) {
      close();
      opts.onFocusOverage && opts.onFocusOverage();
    }
  });
  pop.addEventListener("change", (e) => {
    const wk = e.target.closest("[data-nwd-weekends]");
    if (wk) { draft.weekends_off = wk.checked; render(); }
  });
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.closest("[data-nwd-date]")) { e.preventDefault(); addDate(); }
  });
  return pop;
}
