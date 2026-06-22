// Kickoff & Process panel (Phase 3) — mounts inside the project detail page's
// "Kickoff & Process" tab. Shows the 13-step PM lifecycle (with SLA due dates
// and who/when stamps) plus the two structured kickoff forms (Customer, Crew).
// Backed by /api/kickoff.
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";

const CHECK = `<svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (v) => (v ? String(v).slice(0, 10) : "");
const fmtDT = (v) => { if (!v) return ""; const d = new Date(String(v).replace(" ", "T")); return Number.isNaN(d.getTime()) ? String(v).slice(0, 16) : d.toLocaleString(); };

export async function mountKickoffPanel(container, entityId) {
  let data, view = "overview", formKey = null, form = null, responses = {}, heldDate = "";
  const noteOpen = new Set();

  const load = async () => { data = await api(`/kickoff/project/${encodeURIComponent(entityId)}`); };
  try { await load(); }
  catch (e) { container.innerHTML = `<div class="p-5 text-sm text-red-700">Failed to load kickoff: ${escapeHtml(e?.message || String(e))}</div>`; return; }

  // ── overview (lifecycle tracker + form launchers) ──────────────────────────
  function dueChip(m) {
    if (m.done) return `<span class="inline-flex items-center gap-1 text-[11px] font-semibold text-kpi-completed-text">${CHECK}${m.done_by ? escapeHtml(m.done_by) : "Done"}${m.done_at ? ` · ${escapeHtml(fmtDT(m.done_at))}` : ""}</span>`;
    if (!m.due_date) return `<span class="text-[11px] text-black/40">${escapeHtml(m.sla)}</span>`;
    const overdue = m.due_date < today();
    return `<span class="inline-flex items-center gap-1.5">
      <span class="text-[11px] text-black/45">${escapeHtml(m.sla)}</span>
      <span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${overdue ? "bg-red-50 text-red-700 border border-red-200" : "bg-kpi-inProgress-bg text-kpi-inProgress-text border border-kpi-inProgress-bd"}">${overdue ? "Overdue · " : "Due "}${escapeHtml(fmtDate(m.due_date))}</span>
    </span>`;
  }

  function milestoneRow(m, idx) {
    const noteEditing = noteOpen.has(m.key);
    return `
      <div class="border-b border-black/5">
        <div class="flex items-start gap-3 py-2.5 px-1">
          <button type="button" data-toggle-done="${m.key}" class="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${m.done ? "bg-kpi-completed-text border-kpi-completed-text text-white" : "border-black/25 bg-white text-transparent hover:border-black/40"}">${CHECK}</button>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-[10px] font-bold text-black/30 tabular-nums">${idx + 1}</span>
              <span class="text-xs font-semibold ${m.done ? "text-black/45 line-through" : "text-ink-900"}">${escapeHtml(m.label)}</span>
              ${m.final_invoice ? `<span class="inline-flex rounded-full bg-purple-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-purple-700">→ final invoice</span>` : ""}
            </div>
            <div class="mt-1 flex items-center gap-2 flex-wrap">
              ${dueChip(m)}
              ${m.form ? `<button type="button" data-open-form="${m.form}" class="inline-flex items-center gap-1 rounded-lg border border-black/10 bg-white px-2 py-0.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-50">Open ${m.form} form →</button>` : ""}
              <button type="button" data-note="${m.key}" class="text-[11px] font-medium text-black/40 hover:text-black/70">${m.note ? "✎ note" : "+ note"}</button>
            </div>
            ${m.note && !noteEditing ? `<div class="mt-1 rounded-lg bg-black/[0.03] px-2 py-1 text-[11px] text-black/60 whitespace-pre-wrap">${escapeHtml(m.note)}</div>` : ""}
            ${noteEditing ? `
              <div class="mt-1.5 flex items-start gap-1.5">
                <textarea data-note-input="${m.key}" rows="2" class="input text-xs py-1 flex-1" placeholder="Add a note…">${escapeHtml(m.note || "")}</textarea>
                <button type="button" data-note-save="${m.key}" class="btn-primary text-[11px] px-2 py-1">Save</button>
                <button type="button" data-note-cancel="${m.key}" class="rounded-lg border border-black/10 px-2 py-1 text-[11px] font-semibold hover:bg-black/5">Cancel</button>
              </div>` : ""}
          </div>
        </div>
      </div>`;
  }

  function overviewHtml() {
    const e = data.entity, ms = data.milestones, doneN = ms.filter(m => m.done).length;
    const pct = Math.round((doneN / ms.length) * 100);
    const dateBit = (e.start_date || e.end_date) ? `${escapeHtml(fmtDate(e.start_date) || "—")} → ${escapeHtml(fmtDate(e.end_date) || "—")}` : "No schedule dates";
    const metaItem = (label, val) => `<div><div class="text-[10px] font-bold uppercase tracking-wide text-black/35">${label}</div><div class="text-xs font-semibold text-ink-900">${val}</div></div>`;
    return `
      <div class="p-4 sm:p-5">
        <div class="flex flex-wrap gap-x-8 gap-y-3 rounded-xl border border-black/10 bg-black/[0.015] px-4 py-3 mb-4">
          ${metaItem("Project Manager", escapeHtml(e.pm_name || "—"))}
          ${metaItem("Assigned", escapeHtml(fmtDate(e.assigned_at) || "—"))}
          ${metaItem("Schedule", dateBit)}
        </div>

        <div class="mb-3">
          <div class="flex items-center justify-between mb-1">
            <div class="text-sm font-extrabold text-ink-900">Project Lifecycle</div>
            <div class="text-xs font-semibold text-black/55">${doneN} / ${ms.length} complete</div>
          </div>
          <div class="h-2 w-full rounded-full bg-black/[0.06] overflow-hidden"><div class="h-full rounded-full bg-kpi-completed-text transition-all" style="width:${pct}%"></div></div>
        </div>
        <div class="rounded-xl border border-black/10 overflow-hidden">
          ${data.milestones.map((m, i) => milestoneRow(m, i)).join("")}
        </div>

        <div class="text-sm font-extrabold text-ink-900 mt-5 mb-2">Kickoff Forms</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${data.forms.map(formCard).join("")}
        </div>
      </div>`;
  }

  function formCard(f) {
    const pct = f.field_count ? Math.round((f.filled_count / f.field_count) * 100) : 0;
    return `
      <button type="button" data-open-form="${f.key}" class="text-left rounded-xl border border-black/10 bg-white p-3.5 hover:border-blue-300 hover:bg-blue-50/40 transition-colors">
        <div class="flex items-center justify-between">
          <div class="text-sm font-bold text-ink-900">${escapeHtml(f.label)}</div>
          <span class="text-[11px] font-semibold text-blue-700">Open →</span>
        </div>
        <div class="text-[11px] text-black/50 mt-0.5">${f.held_date ? "Held " + escapeHtml(fmtDate(f.held_date)) : "Not yet held"}</div>
        <div class="mt-2 flex items-center gap-2">
          <div class="h-1.5 flex-1 rounded-full bg-black/[0.06] overflow-hidden"><div class="h-full rounded-full bg-blue-500" style="width:${pct}%"></div></div>
          <span class="text-[10px] font-semibold text-black/45 tabular-nums">${f.filled_count}/${f.field_count}</span>
        </div>
      </button>`;
  }

  // ── form view ──────────────────────────────────────────────────────────────
  function fieldHtml(f) {
    const val = responses[f.key] || "";
    const noteVal = responses[`${f.key}__note`] || "";
    if (f.type === "yn" || f.type === "yn_note") {
      const btn = (v, label) => `<button type="button" data-yn="${f.key}" data-yn-val="${v}" class="px-3 py-1 text-xs font-semibold border ${val === v ? (v === "Y" ? "bg-kpi-completed-bg border-kpi-completed-bd text-kpi-completed-text" : "bg-red-50 border-red-200 text-red-700") : "bg-white border-black/15 text-black/55 hover:bg-black/5"} ${v === "Y" ? "rounded-l-lg" : "rounded-r-lg -ml-px"}">${label}</button>`;
      return `
        <div class="flex items-center gap-3 py-1.5">
          <div class="min-w-0 flex-1 text-xs text-ink-900">${escapeHtml(f.label)}</div>
          <div class="inline-flex shrink-0">${btn("Y", "Yes")}${btn("N", "No")}</div>
          ${f.type === "yn_note" ? `<input type="text" data-field-note="${f.key}" value="${escapeHtml(noteVal)}" placeholder="Note" class="input text-xs py-1 w-32 shrink-0">` : ""}
        </div>`;
    }
    if (f.type === "textarea") {
      return `<div class="py-1.5"><div class="text-xs text-ink-900 mb-1">${escapeHtml(f.label)}</div><textarea data-field="${f.key}" rows="3" class="input text-xs py-1.5 w-full">${escapeHtml(val)}</textarea></div>`;
    }
    return `
      <div class="flex items-center gap-3 py-1.5">
        <div class="min-w-0 flex-1 text-xs text-ink-900">${escapeHtml(f.label)}</div>
        <input type="text" data-field="${f.key}" value="${escapeHtml(val)}" class="input text-xs py-1 w-48 sm:w-64 shrink-0">
      </div>`;
  }

  function formHtml() {
    return `
      <div class="p-4 sm:p-5">
        <button type="button" data-back class="inline-flex items-center gap-1 text-xs font-semibold text-black/50 hover:text-black/80 mb-3">← Back to lifecycle</button>
        <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-4">
          <div>
            <div class="text-base font-extrabold text-ink-900">${escapeHtml(form.label)}</div>
            <div class="text-xs text-black/50">${escapeHtml(data.entity?.name || "")}</div>
          </div>
          <div class="flex items-end gap-2">
            <label class="text-xs"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-0.5">Kickoff held date</div>
              <input type="date" id="kHeld" value="${escapeHtml(heldDate || "")}" class="input text-xs py-1"></label>
            <button type="button" id="kSave" class="btn-primary text-xs px-4 py-2">Save form</button>
          </div>
        </div>
        <div class="space-y-3">
          ${form.sections.map(sectionHtml).join("")}
        </div>
        <div class="mt-4 flex justify-end"><button type="button" id="kSave2" class="btn-primary text-xs px-4 py-2">Save form</button></div>
        <div id="kMsg" class="mt-2 text-right text-xs font-semibold"></div>
      </div>`;
  }
  function sectionHtml(sec) {
    return `
      <div class="rounded-xl border border-black/10 overflow-hidden">
        ${sec.title ? `<div class="bg-black/[0.03] px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-black/55">${escapeHtml(sec.title)}</div>` : ""}
        <div class="px-3 py-1 divide-y divide-black/5">${sec.fields.map(fieldHtml).join("")}</div>
      </div>`;
  }

  // ── render + events ─────────────────────────────────────────────────────────
  function render() {
    container.innerHTML = view === "form" ? formHtml() : overviewHtml();
  }

  async function openForm(key) {
    try {
      const d = await api(`/kickoff/project/${encodeURIComponent(entityId)}/form/${key}`);
      formKey = key; form = d.form; responses = d.responses || {}; heldDate = d.held_date || ""; view = "form";
      render();
    } catch (err) { alert(`Could not open form: ${err.message}`); }
  }

  function collectForm() {
    // yn values live in `responses`; text + note inputs are read from the DOM
    const out = {};
    container.querySelectorAll("[data-field]").forEach(i => { out[i.getAttribute("data-field")] = i.value; });
    container.querySelectorAll("[data-field-note]").forEach(i => { out[`${i.getAttribute("data-field-note")}__note`] = i.value; });
    return { ...responses, ...out };
  }

  async function saveForm(btn) {
    const heldEl = container.querySelector("#kHeld");
    const payload = { responses: collectForm(), held_date: heldEl ? heldEl.value : null };
    const msg = container.querySelector("#kMsg");
    [btn].forEach(b => b && (b.disabled = true));
    try {
      await api(`/kickoff/project/${encodeURIComponent(entityId)}/form/${formKey}`, { method: "POST", body: JSON.stringify(payload) });
      await load();
      if (msg) { msg.textContent = "Saved ✓"; msg.className = "mt-2 text-right text-xs font-semibold text-kpi-completed-text"; }
      setTimeout(() => { view = "overview"; render(); }, 500);
    } catch (err) {
      if (msg) { msg.textContent = `Save failed: ${err.message}`; msg.className = "mt-2 text-right text-xs font-semibold text-red-600"; }
      [btn].forEach(b => b && (b.disabled = false));
    }
  }

  container.addEventListener("click", async (e) => {
    const openF = e.target.closest("[data-open-form]");
    if (openF) { await openForm(openF.getAttribute("data-open-form")); return; }
    if (e.target.closest("[data-back]")) { view = "overview"; render(); return; }

    // form: Yes/No toggle
    const yn = e.target.closest("[data-yn]");
    if (yn) {
      const k = yn.getAttribute("data-yn"), v = yn.getAttribute("data-yn-val");
      responses[k] = responses[k] === v ? "" : v;   // toggle off if same
      // keep current text/note edits before re-render
      container.querySelectorAll("[data-field]").forEach(i => { responses[i.getAttribute("data-field")] = i.value; });
      container.querySelectorAll("[data-field-note]").forEach(i => { responses[`${i.getAttribute("data-field-note")}__note`] = i.value; });
      render();
      return;
    }
    if (e.target.closest("#kSave")) { await saveForm(e.target.closest("#kSave")); return; }
    if (e.target.closest("#kSave2")) { await saveForm(e.target.closest("#kSave2")); return; }

    // milestone: toggle done
    const td = e.target.closest("[data-toggle-done]");
    if (td) {
      const key = td.getAttribute("data-toggle-done");
      const m = data.milestones.find(x => x.key === key);
      try {
        await api(`/kickoff/project/${encodeURIComponent(entityId)}/milestone`, { method: "POST", body: JSON.stringify({ milestone_key: key, done: !m.done }) });
        await load(); render();
      } catch (err) { alert(`Could not update: ${err.message}`); }
      return;
    }
    // milestone: note open/save/cancel
    const nb = e.target.closest("[data-note]");
    if (nb) { const k = nb.getAttribute("data-note"); noteOpen.has(k) ? noteOpen.delete(k) : noteOpen.add(k); render(); return; }
    const nc = e.target.closest("[data-note-cancel]");
    if (nc) { noteOpen.delete(nc.getAttribute("data-note-cancel")); render(); return; }
    const ns = e.target.closest("[data-note-save]");
    if (ns) {
      const key = ns.getAttribute("data-note-save");
      const ta = container.querySelector(`[data-note-input="${key}"]`);
      try {
        await api(`/kickoff/project/${encodeURIComponent(entityId)}/milestone`, { method: "POST", body: JSON.stringify({ milestone_key: key, note: ta ? ta.value : "" }) });
        noteOpen.delete(key); await load(); render();
      } catch (err) { alert(`Could not save note: ${err.message}`); }
      return;
    }
  });

  render();
}
