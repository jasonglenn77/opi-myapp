// Assignment-line history renderer (Crew Model v2 CR4) — shared by the office
// Assignment page (assignment.js), the project-workspace Assignment tab
// (assignment-panel.js) and the Schedules-page modal (schedule.js).
//
// Data source: GET /api/projects/schedule-items/{id}/history (CR1 capture:
// rows {action, changed_by, changed_at, changes:{field:[old,new]}} newest
// first, crews/PMs already readable labels). Lazy-fetched on first expand and
// cached per item; hosts call invalidateHistory(id) after a save so the next
// expand re-fetches.
//
// Styling: real CSS (.ah-*) appended to BOTH styles.css and output.css —
// nothing here relies on new Tailwind utilities.
import { api } from "../api.js";
import { escapeHtml } from "./html.js";

const _cache = new Map();   // schedule_item_id -> rows array

export function invalidateHistory(itemId) {
  _cache.delete(String(itemId));
}

export function cachedHistory(itemId) {
  return _cache.get(String(itemId)) || null;
}

export async function loadHistory(itemId) {
  const key = String(itemId);
  if (_cache.has(key)) return _cache.get(key);
  const res = await api(`/projects/schedule-items/${encodeURIComponent(itemId)}/history`);
  const rows = res.history || [];
  _cache.set(key, rows);
  return rows;
}

// ── formatting ──────────────────────────────────────────────────────────────

function fmtDateMDY(v) {
  // "2026-03-10" -> "3/10/26"
  if (!v) return "—";
  const s = String(v).slice(0, 10);
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return "—";
  return `${m}/${d}/${String(y).slice(-2)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtWhen(iso) {
  // "2026-09-23T14:14:05" -> "Sep 23, 2:14 PM"
  if (!iso) return "";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return String(iso);
  const mon = MONTHS[Number(m[2]) - 1] || m[2];
  let h = Number(m[4]);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${mon} ${Number(m[3])}, ${h}:${m[5]} ${ap}`;
}

const STATUS_LABELS = {
  needs_attention: "Needs Attention",
  pending: "Pending",
  not_started: "Not Started",
  in_progress: "In Progress",
  completed: "Completed",
  canceled: "Canceled",
};

function truncate(s, n) {
  s = String(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// The old (pre-change) value of one field, rendered as a readable fragment.
// Field names humanized: Start/End (dates), Overage days, Travel days,
// Equipment, Wire guidance, Notes, Status, Crews, PMs.
function oldFragment(field, oldVal) {
  switch (field) {
    case "overage_days":    return `${Number(oldVal || 0)} overage`;
    case "travel_days":     return `${Number(oldVal || 0)} travel`;
    case "wire_guidance":   return oldVal ? "wire guidance on" : "wire guidance off";
    case "equipment_type":  return oldVal ? `equip ${oldVal}` : "no equip";
    case "status":          return `status ${STATUS_LABELS[oldVal] || oldVal || "—"}`;
    case "notes":           return oldVal ? `notes “${truncate(oldVal, 60)}”` : "no notes";
    case "crews": {
      const list = Array.isArray(oldVal) ? oldVal : [];
      return list.length ? `crews ${list.join(", ")}` : "no crews";
    }
    case "project_managers": {
      const list = Array.isArray(oldVal) ? oldVal : [];
      return list.length ? `PMs ${list.join(", ")}` : "no PMs";
    }
    // 0062 PROJECT NON-WORKING DAYS: {weekends_off, dates} or null —
    // "non-working days: 3 dates + weekends off" style.
    case "non_working": {
      if (!oldVal || typeof oldVal !== "object") return "no days off";
      const n = Array.isArray(oldVal.dates) ? oldVal.dates.length : 0;
      const bits = [];
      if (n) bits.push(`${n} date${n === 1 ? "" : "s"}`);
      if (oldVal.weekends_off) bits.push("weekends off");
      return bits.length ? `non-working days: ${bits.join(" + ")}` : "no days off";
    }
    default:                return `${field} ${oldVal ?? "—"}`;
  }
}

// Readable-sentence order: dates first, then the rest.
const FIELD_ORDER = ["start_date", "end_date", "overage_days", "travel_days",
                     "non_working", "wire_guidance", "equipment_type", "status",
                     "crews", "project_managers", "notes"];

/** One history row -> the sub-line sentence, e.g.
 *  "was 3/10/26 → 4/5/26 · 0 overage — changed by Kelly Losee · Sep 23, 2:14 PM" */
export function historySentence(row) {
  const who = row.changed_by || "(before tracking)";
  const when = fmtWhen(row.changed_at);
  if (row.action === "created") return `created by ${who} · ${when}`;
  if (row.action === "deleted") return `deleted by ${who} · ${when}`;

  const changes = row.changes || {};
  const keys = Object.keys(changes);
  const parts = [];

  // Start/End render together as one "3/10/26 → 4/5/26" fragment when both
  // changed; alone as "start 3/10/26" / "end 4/5/26".
  const hasStart = keys.includes("start_date");
  const hasEnd = keys.includes("end_date");
  if (hasStart && hasEnd) {
    parts.push(`${fmtDateMDY(changes.start_date[0])} → ${fmtDateMDY(changes.end_date[0])}`);
  } else if (hasStart) {
    parts.push(`start ${fmtDateMDY(changes.start_date[0])}`);
  } else if (hasEnd) {
    parts.push(`end ${fmtDateMDY(changes.end_date[0])}`);
  }

  const ordered = FIELD_ORDER.filter((f) => keys.includes(f))
    .concat(keys.filter((k) => !FIELD_ORDER.includes(k)));
  for (const f of ordered) {
    if (f === "start_date" || f === "end_date") continue; // handled above
    parts.push(oldFragment(f, (changes[f] || [])[0]));
  }

  if (!parts.length) return `updated by ${who} · ${when}`;
  return `was ${parts.join(" · ")} — changed by ${who} · ${when}`;
}

// ── HTML ────────────────────────────────────────────────────────────────────

const CLOCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15.5 14"></polyline></svg>`;

/** CR5 A3: the badge count from loaded rows — the single backfilled
 *  "(before tracking)" created row (oldest row, changed_by NULL) doesn't
 *  count, so an untouched pre-tracking line reads plain "History" instead
 *  of "1 change". (The backend badge-count subqueries apply the same rule
 *  for lines whose history isn't loaded yet.) */
export function historyCountOf(rows) {
  if (!Array.isArray(rows)) return null;
  const oldest = rows[rows.length - 1];   // rows arrive newest-first
  const backfilled = oldest && oldest.action === "created" && !oldest.changed_by;
  return Math.max(0, rows.length - (backfilled ? 1 : 0));
}

/** CR5 A3: badge text — "History", plus the count when there are entries
 *  beyond the backfill. */
export function historyBadgeLabel(count) {
  const n = Number(count);
  return Number.isFinite(n) && n > 0 ? `History (${n})` : "History";
}

/** The subtle per-line affordance: clock icon + "History (N)". Clicking
 *  toggles the panel (hosts wire [data-hist-toggle] by delegation). No badge
 *  for unsaved draft lines (no item id / no history yet). */
export function historyBadgeHtml(itemId, count, open = false) {
  if (itemId == null) return "";
  const label = historyBadgeLabel(count);
  return `
    <button type="button" class="ah-badge${open ? " ah-open" : ""}"
      data-hist-toggle="${escapeHtml(String(itemId))}"
      title="Assignment line history" aria-expanded="${open ? "true" : "false"}">
      ${CLOCK_SVG}<span>${escapeHtml(label)}</span>
    </button>`;
}

/** The expanded sub-lines block. Rendered from cache when available, else a
 *  loading note (host calls loadHistory then re-renders). */
export function historyPanelHtml(itemId) {
  const rows = cachedHistory(itemId);
  if (!rows) return `<div class="ah-panel"><div class="ah-loading">Loading history…</div></div>`;
  if (!rows.length) return `<div class="ah-panel"><div class="ah-loading">No history recorded for this line.</div></div>`;
  const lines = rows.map((r) => `
    <div class="ah-line ah-${escapeHtml(r.action || "updated")}">
      <span class="ah-dot"></span>${escapeHtml(historySentence(r))}
    </div>`).join("");
  return `<div class="ah-panel">${lines}</div>`;
}
