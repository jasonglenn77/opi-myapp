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

export async function mountKickoffPanel(container, entityId, opts = {}) {
  // readOnly = the office project workspace view: kickoff & process are
  // MANAGED in the PM Portal now; the office keeps a look-don't-touch copy.
  const ro = !!opts.readOnly;
  const roNote = ro ? `<div class="pm-ro-note mb-3">Read-only view — Kickoff &amp; Process is managed in the PM Portal.</div>` : "";
  let data, view = "overview", formKey = null, form = null, responses = {}, heldDate = "";
  // info: per-field provenance {shared, source, by, at, prev}; suggestions:
  // auto-fill values for empty fields {value, source, where}; otherLabel: the
  // other checklist's name (shared items stay in sync with it).
  let info = {}, suggestions = {}, otherLabel = "";
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
          <button type="button" data-toggle-done="${m.key}" ${ro ? "disabled" : ""} class="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${m.done ? "bg-kpi-completed-text border-kpi-completed-text text-white" : "border-black/25 bg-white text-transparent" + (ro ? "" : " hover:border-black/40")}">${CHECK}</button>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-[10px] font-bold text-black/30 tabular-nums">${idx + 1}</span>
              <span class="text-xs font-semibold ${m.done ? "text-black/45 line-through" : "text-ink-900"}">${escapeHtml(m.label)}</span>
              ${m.final_invoice ? `<span class="inline-flex rounded-full bg-purple-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-purple-700">→ final invoice</span>` : ""}
            </div>
            <div class="mt-1 flex items-center gap-2 flex-wrap">
              ${dueChip(m)}
              ${m.form ? `<button type="button" data-open-form="${m.form}" class="inline-flex items-center gap-1 rounded-lg border border-black/10 bg-white px-2 py-0.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-50">${ro ? "View" : "Open"} ${m.form} form →</button>` : ""}
              ${ro ? "" : `<button type="button" data-note="${m.key}" class="text-[11px] font-medium text-black/40 hover:text-black/70">${m.note ? "✎ note" : "+ note"}</button>`}
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
        ${roNote}
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
  // Stored timestamps are UTC (server clock) — show the viewer's local date.
  const fmtWhen = (v) => {
    if (!v) return "";
    const d = new Date(String(v).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? "" : "Z"));
    return Number.isNaN(d.getTime()) ? String(v).slice(0, 10) : d.toLocaleDateString();
  };
  function provenanceHtml(key) {
    const bits = [];
    const inf = info[key];
    const sug = suggestions[key];
    if (sug && responses[key] === sug.value && !(inf && inf.source)) {
      bits.push(`<span class="kk-prov kk-auto">✦ ${escapeHtml(sug.source)} — saves with the form</span>`);
    } else if (inf && inf.source) {
      const fromOther = inf.shared && inf.source === otherLabel;
      const isAuto = inf.source.startsWith("Auto-filled");
      if (fromOther || isAuto) {
        bits.push(`<span class="kk-prov ${isAuto ? "kk-auto" : "kk-from"}">${fromOther ? "⇄ From " : ""}${escapeHtml(inf.source)}${inf.by ? ` · ${escapeHtml(inf.by)}` : ""}${inf.at ? ` · ${escapeHtml(fmtWhen(inf.at))}` : ""}</span>`);
      }
    }
    if (inf && inf.prev) {
      const pv = inf.prev;
      const shown = pv.value === "Y" ? "Yes" : pv.value === "N" ? "No" : pv.value;
      bits.push(`<span class="kk-prov kk-was" title="Value before the last change">was: <b>${escapeHtml(shown)}</b>${pv.source ? ` · ${escapeHtml(pv.source)}` : ""}${pv.by ? ` · ${escapeHtml(pv.by)}` : ""}${pv.at ? ` · ${escapeHtml(fmtWhen(pv.at))}` : ""}</span>`);
    }
    return bits.length ? `<div class="kk-provrow">${bits.join("")}</div>` : "";
  }
  const sharedTag = (f) => f.shared ? `<span class="kk-shared" title="This item is on both checklists — an answer here also fills it on the ${escapeHtml(otherLabel)} checklist">⇄ both</span>` : "";
  const labelHtml = (f) => `<div class="min-w-0 flex-1 text-xs text-ink-900">${escapeHtml(f.label)} ${sharedTag(f)}${f.hint ? `<div class="text-[10px] text-black/45 mt-0.5">${escapeHtml(f.hint)}</div>` : ""}</div>`;

  function fieldHtml(f) {
    if (f.type === "label") {
      return `<div class="pt-2 pb-0.5 text-[11px] font-bold text-black/55">${escapeHtml(f.label)}:</div>`;
    }
    const val = responses[f.key] || "";
    const noteVal = responses[`${f.key}__note`] || "";
    const dis = ro ? "disabled" : "";
    if (f.type === "yn" || f.type === "yn_note") {
      const btn = (v, label) => `<button type="button" data-yn="${f.key}" data-yn-val="${v}" ${dis} class="px-3 py-1 text-xs font-semibold border ${val === v ? (v === "Y" ? "bg-kpi-completed-bg border-kpi-completed-bd text-kpi-completed-text" : "bg-red-50 border-red-200 text-red-700") : "bg-white border-black/15 text-black/55" + (ro ? "" : " hover:bg-black/5")} ${v === "Y" ? "rounded-l-lg" : "rounded-r-lg -ml-px"}">${label}</button>`;
      return `
        <div class="py-1.5">
          <div class="flex items-center gap-3">
            ${labelHtml(f)}
            <div class="inline-flex shrink-0">${btn("Y", "Yes")}${btn("N", "No")}</div>
            ${f.type === "yn_note" ? `<input type="text" data-field-note="${f.key}" value="${escapeHtml(noteVal)}" placeholder="${escapeHtml(f.note_label || "Note")}" ${dis} class="input text-xs py-1 w-32 shrink-0">` : ""}
          </div>
          ${provenanceHtml(f.key)}${f.type === "yn_note" ? provenanceHtml(`${f.key}__note`) : ""}
        </div>`;
    }
    if (f.type === "textarea") {
      return `<div class="py-1.5"><div class="text-xs text-ink-900 mb-1">${escapeHtml(f.label)}</div><textarea data-field="${f.key}" rows="3" ${dis} class="input text-xs py-1.5 w-full">${escapeHtml(val)}</textarea>${provenanceHtml(f.key)}</div>`;
    }
    let input;
    if (f.type === "select") {
      input = `<select data-field="${f.key}" ${dis} class="input text-xs py-1 w-48 sm:w-64 shrink-0"><option value="">—</option>${(f.options || []).map((o) => `<option ${o === val ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}</select>`;
    } else if (f.type === "date") {
      input = `<input type="date" data-field="${f.key}" value="${escapeHtml(String(val).slice(0, 10))}" ${dis} class="input text-xs py-1 w-48 sm:w-64 shrink-0">`;
    } else {
      input = `<input type="text" data-field="${f.key}" value="${escapeHtml(val)}" ${dis} class="input text-xs py-1 w-48 sm:w-64 shrink-0">`;
    }
    return `
      <div class="py-1.5">
        <div class="flex items-center gap-3">${labelHtml(f)}${input}</div>
        ${provenanceHtml(f.key)}
      </div>`;
  }

  function formHtml() {
    return `
      <div class="p-4 sm:p-5">
        <button type="button" data-back class="inline-flex items-center gap-1 text-xs font-semibold text-black/50 hover:text-black/80 mb-3">← Back to lifecycle</button>
        ${roNote}
        <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-4">
          <div>
            <div class="text-base font-extrabold text-ink-900">${escapeHtml(form.label)}</div>
            <div class="text-xs text-black/50">${escapeHtml(data.entity?.name || "")}</div>
          </div>
          <div class="flex items-end gap-2">
            <label class="text-xs"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-0.5">Kickoff held date</div>
              <input type="date" id="kHeld" value="${escapeHtml(heldDate || "")}" ${ro ? "disabled" : ""} class="input text-xs py-1"></label>
            ${ro ? "" : `<button type="button" id="kSave" class="btn-primary text-xs px-4 py-2">Save form</button>`}
          </div>
        </div>
        <div class="kk-legend">Items marked <span class="kk-shared">⇄ both</span> are on the Customer and Crew checklists — answering one fills the other. <span class="kk-prov kk-auto">✦ Auto-filled</span> values come from the project's data; <span class="kk-prov kk-was">was:</span> shows the answer before the last change.</div>
        <div class="space-y-3">
          ${form.sections.map(sectionHtml).join("")}
        </div>
        ${ro ? "" : `<div class="mt-4 flex justify-end"><button type="button" id="kSave2" class="btn-primary text-xs px-4 py-2">Save form</button></div>`}
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
      formKey = key; form = d.form; heldDate = d.held_date || ""; view = "form";
      info = d.info || {}; suggestions = d.suggestions || {}; otherLabel = d.other_form_label || "";
      // Empty auto-fillable fields start with the suggestion (saved on Save form).
      responses = { ...Object.fromEntries(Object.entries(suggestions).map(([k, v]) => [k, v.value])), ...(d.responses || {}) };
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
    const values = collectForm();
    const sources = {};
    for (const [k, sg] of Object.entries(suggestions)) {
      if (values[k] === sg.value) sources[k] = `auto:${sg.where}`;
    }
    const payload = { responses: values, held_date: heldEl ? heldEl.value : null, sources };
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
    if (ro) return;   // read-only: everything below mutates

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
