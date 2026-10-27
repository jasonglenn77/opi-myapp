// Project holds (0078) — shared UI bits: the "On hold until …" pill, the
// active-holds overlay map every list page uses, and the Put on hold / Edit
// hold / Resume now dialog (Assignment panel). Backend: app/projects/holds.py
// — putting a project on hold SHIFTS its remaining (un-invoiced / unpaid /
// unspent) dated work by the hold length, so Billing, Schedules, Cash Flow and
// the Revenue Forecast all move together.
import { api, apiCached, invalidateCache } from "../api.js";
import { escapeHtml } from "./html.js";

const HOLDS_PATH = "/projects/holds/active";

/** Local (browser) today as YYYY-MM-DD — the office's day, not the server's UTC. */
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const mdy = (s) => {
  if (!s) return "—";
  const [y, m, d] = String(s).slice(0, 10).split("-");
  return `${Number(m)}/${Number(d)}/${String(y).slice(2)}`;
};

/** Active holds keyed three ways: { byEntity, byCustomer, byProject }. */
export async function loadHolds(force = false) {
  if (force) invalidateCache(HOLDS_PATH);
  let list = [];
  try { list = (await apiCached(HOLDS_PATH, 60000)).holds || []; } catch (_) { list = []; }
  const byEntity = new Map(), byCustomer = new Map(), byProject = new Map();
  for (const h of list) {
    byEntity.set(String(h.entity_id), h);
    byCustomer.set(String(h.qbo_customer_id), h);
    byProject.set(String(h.project_id), h);
  }
  return { list, byEntity, byCustomer, byProject };
}

export function invalidateHolds() { invalidateCache(HOLDS_PATH); }

export function holdTitle(h) {
  if (!h) return "";
  const bits = [`On hold since ${mdy(h.hold_start)} — expected resume ${mdy(h.expected_resume)}`];
  if (h.shift_days) bits.push(`remaining work shifted ${h.shift_days} days`);
  if (h.reason) bits.push(h.reason);
  if (h.note) bits.push(h.note);
  return bits.join(" · ");
}

/** "On hold until 12/7/26" pill (overdue resume → red). opts.short = "On hold". */
export function holdPillHtml(h, opts = {}) {
  if (!h) return "";
  const label = opts.short ? "On hold" : `On hold until ${mdy(h.expected_resume)}`;
  return `<span class="hold-pill${h.overdue ? " hold-pill-late" : ""}" title="${escapeHtml(holdTitle(h) + (h.overdue ? " · resume date has passed" : ""))}">${escapeHtml(label)}</span>`;
}

const KIND_LABEL = {
  schedule_item: ["schedule line", "schedule lines"],
  milestone: ["invoice to bill", "invoices to bill"],
  crew_installment: ["crew payment", "crew payments"],
  expense_installment: ["expense week", "expense weeks"],
  expense_item: ["planned expense", "planned expenses"],
};
function countsText(counts) {
  const parts = [];
  for (const [k, [one, many]] of Object.entries(KIND_LABEL)) {
    const n = Number((counts || {})[k] || 0);
    if (n) parts.push(`${n} ${n === 1 ? one : many}`);
  }
  return parts.join(", ");
}

/** Modal: put on hold (no hold yet) or edit the active hold. */
export function openHoldDialog({ qboCustomerId, projectName, hold, onDone }) {
  document.getElementById("holdDlg")?.remove();
  const editing = !!hold;
  const today = localToday();
  const ov = document.createElement("div");
  ov.id = "holdDlg";
  ov.className = "hold-ov";
  ov.innerHTML = `
    <div class="hold-card" role="dialog" aria-modal="true">
      <div class="hold-h">${editing ? "Edit hold" : "Put project on hold"}</div>
      ${projectName ? `<div class="hold-sub">${escapeHtml(projectName)}</div>` : ""}
      <div class="hold-grid">
        <label class="hold-f"><span>Hold starts</span>
          <input type="date" data-h="hold_start" class="input text-sm" value="${escapeHtml(hold ? hold.hold_start : today)}"/></label>
        <label class="hold-f"><span>Expected resume</span>
          <input type="date" data-h="expected_resume" class="input text-sm" value="${escapeHtml(hold ? hold.expected_resume : "")}"/></label>
      </div>
      <label class="hold-f"><span>Reason</span>
        <input type="text" data-h="reason" maxlength="160" class="input text-sm" placeholder="e.g. Customer site not ready" value="${escapeHtml(hold?.reason || "")}"/></label>
      <label class="hold-f"><span>Note</span>
        <textarea data-h="note" rows="2" class="input text-sm" placeholder="Optional">${escapeHtml(hold?.note || "")}</textarea></label>
      <div class="hold-info" data-h-info>Remaining work that isn't invoiced, paid or spent yet moves by the hold length, so Billing, the Schedules page, Cash Flow and the Revenue Forecast pick it up from the resume date. Work before the hold start is left alone.</div>
      <div class="hold-err" data-h-err></div>
      <div class="hold-btns">
        <button type="button" data-h-cancel class="rounded-lg border border-black/10 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">Cancel</button>
        <button type="button" data-h-save class="btn-primary text-xs px-3 py-1.5">${editing ? "Save hold" : "Put on hold"}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const q = (k) => ov.querySelector(`[data-h="${k}"]`);
  const info = ov.querySelector("[data-h-info]");
  const err = ov.querySelector("[data-h-err]");
  const close = () => ov.remove();
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close(); });
  ov.querySelector("[data-h-cancel]").addEventListener("click", close);

  const daysBetween = (a, b) => {
    if (!a || !b) return null;
    const pa = a.split("-").map(Number), pb = b.split("-").map(Number);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 864e5);
  };
  let seq = 0;
  async function refreshPreview() {
    const hs = q("hold_start").value, er = q("expected_resume").value;
    const n = daysBetween(hs, er);
    if (!er || n == null || n <= 0) { info.textContent = n != null && n <= 0 ? "The resume date must be after the hold start." : info.textContent; return; }
    if (editing) {
      info.textContent = `Remaining work will sit ${n} days after its original plan (now ${hold.shift_days || 0}).`;
      return;
    }
    const my = ++seq;
    info.textContent = `Hold length ${n} days — checking what moves…`;
    try {
      const p = await api(`/projects/hold/preview?qbo_customer_id=${encodeURIComponent(qboCustomerId)}&hold_start=${hs}&expected_resume=${er}`);
      if (my !== seq) return;
      const t = countsText(p.counts);
      info.textContent = `Hold length ${n} days. ${t ? `Moves ${t} to after the resume date.` : "Nothing dated after the hold start yet — only the status changes."}`;
    } catch (e) { if (my === seq) info.textContent = `Hold length ${n} days.`; }
  }
  q("hold_start").addEventListener("change", refreshPreview);
  q("expected_resume").addEventListener("change", refreshPreview);
  if (editing) refreshPreview();

  ov.querySelector("[data-h-save]").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    err.textContent = "";
    const body = {
      qbo_customer_id: Number(qboCustomerId),
      hold_start: q("hold_start").value || today,
      expected_resume: q("expected_resume").value || null,
      reason: q("reason").value.trim() || null,
      note: q("note").value.trim() || null,
    };
    if (!body.expected_resume) { err.textContent = "Pick the expected resume date."; return; }
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const r = await api("/projects/hold", { method: editing ? "PUT" : "POST", body: JSON.stringify(body) });
      invalidateHolds();
      close();
      if (onDone) onDone(r);
    } catch (ex) {
      err.textContent = ex?.message || String(ex);
      btn.disabled = false; btn.textContent = editing ? "Save hold" : "Put on hold";
    }
  });
  setTimeout(() => q("expected_resume").focus(), 0);
}

/** Confirm + release the hold today (early resume shrinks the shift). */
export async function resumeHold({ qboCustomerId, hold, onDone }) {
  const today = localToday();
  const early = hold && hold.expected_resume > today;
  const msg = early
    ? `Resume now? The project was expected back ${mdy(hold.expected_resume)}. Remaining work will be pulled back so it sits only the days actually held (${hold.hold_start <= today ? "from " + mdy(hold.hold_start) + " to today" : "none"}), and the lines leave On hold.`
    : "Resume the project? Dates stay where the hold put them; the lines leave On hold.";
  if (!confirm(msg)) return;
  try {
    const r = await api("/projects/hold/resume", { method: "POST", body: JSON.stringify({ qbo_customer_id: Number(qboCustomerId), resume_date: today }) });
    invalidateHolds();
    if (onDone) onDone(r);
  } catch (ex) { alert("Resume failed: " + (ex?.message || ex)); }
}
