// CR5 B3 — crew-consistency chip, shared by the Billing & Schedule tab
// (billing.js) and the workspace Assignment tab (assignment-panel.js).
// GET /api/projects/{qbo_id}/crew-consistency compares (a) assigned
// company(ies), (b) accepted-offer company, (c) QBO Contract-Labor bill
// vendors mapped via work_crews.vendor_qbo_id. Chip: green "✓ Crew
// consistent" / amber "⚠ Vendor not linked" / red "⚠ Crew mismatch: …",
// click to expand the detail lines (title tooltip carries them too).
import { api } from "../api.js";
import { escapeHtml } from "./html.js";

export async function fetchCrewConsistency(qboId) {
  if (qboId == null || qboId === "") return null;
  try { return await api(`/projects/${encodeURIComponent(qboId)}/crew-consistency`); }
  catch { return null; }   // chip simply doesn't render on failure
}

export function crewConsistencyChipHtml(d) {
  if (!d || !d.status || d.status === "no_data") return "";
  const details = d.details || [];
  const tip = escapeHtml(details.join("\n"));
  if (d.status === "ok") {
    return `<span class="ccx ccx-ok" title="${tip}">✓ Crew consistent</span>`;
  }
  const bad = d.status === "mismatch";
  const label = bad
    ? `⚠ Crew mismatch: ${escapeHtml(d.summary || "")}`
    : "⚠ Vendor not linked to a crew company";
  return `
    <details class="ccx-wrap">
      <summary class="ccx ${bad ? "ccx-bad" : "ccx-warn"}" title="${tip}">${label}</summary>
      <div class="ccx-pop">${details.map((x) => `<div class="ccx-line">${escapeHtml(x)}</div>`).join("")
        || `<div class="ccx-line">No detail.</div>`}</div>
    </details>`;
}

/** Fetch + render into the host's `[data-ccx-slot]` (no-op when absent or the
 *  fetch fails). Hosts call this after (re)rendering their markup. */
export async function mountConsistencyChip(container, qboId) {
  const slot = container.querySelector("[data-ccx-slot]");
  if (!slot) return;
  const d = await fetchCrewConsistency(qboId);
  const again = container.querySelector("[data-ccx-slot]");   // host may have re-rendered
  if (again) again.innerHTML = crewConsistencyChipHtml(d);
}
