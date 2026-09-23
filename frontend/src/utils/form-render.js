// Shared definition-driven form renderer (PM Portal Design v3, Milestone C).
//
// ONE renderer for the crew's form-filling UI (pages/crew-forms.js, #/field)
// and the PM's "see what the crew sees" preview (pages/pm.js Forms tab) — the
// markup and branch logic are identical by construction, so the preview can
// never drift from the real form. Uses the ff-* CSS block (mobile-first, big
// touch targets, explicit dark text on light surfaces).
//
// createFormRenderer(tpl, opts) -> renderer
//   tpl   a MERGED template from GET /api/forms/templates?project_qbo_id=X
//         (sections carry "enabled"; custom questions already appended).
//   opts:
//     answers   answer map to read/mutate ({} default). Conventions:
//                 yes_no                     -> "yes" | "no"
//                 text/textarea/number/select-> string
//                 video/photos/media         -> [{document_id, filename}]
//     preview   true = PM preview: text/number/select inputs disabled, file
//               buttons inert (no <input>), yes/no buttons stay clickable so
//               branches are explorable. Default false (crew filling mode).
//     editor    true = PM FORM EDITOR (Milestone C2): implies preview input
//               behavior, but renders ALL sections (disabled ones dimmed,
//               with their JHA/Anchoring/WG switch INLINE at the section
//               header), a remove ✕ on every question (struck-through +
//               Restore once removed; custom questions get their own ✕;
//               red-flag-bearing questions show ⚑ and a disabled ✕), and a
//               "+ Add question" affordance at each section's end. The HOST
//               binds the emitted data attributes by delegation:
//                 data-rmq / data-restoreq (standard question key)
//                 data-rmq-custom (custom question key)
//                 data-addq (section key) · data-sec-toggle (toggle name)
//     removedKeys  (editor) question keys currently removed for this project.
//     onChange  called after any answer changes (crew persists drafts here).
//     onFiles   (key, FileList) — crew's upload pipeline; file inputs are
//               only rendered when filling (not in preview).
//
// renderer API:
//   enabledSections            the sections being rendered
//   html()                     the sections' inner HTML (host provides the
//                              surrounding card/form/submit chrome)
//   attach(rootEl)             bind controls inside rootEl + restore branch
//                              UIs for already-answered yes/no questions
//   renderBranch(parentKey)    re-render a yes/no branch container
//   findQuestion(key)          question def lookup (branches included)
//   redrawFiles(key)/setFileProgress(key, html)  upload-list helpers
//   activeQuestions()          questions in enabled sections + taken branches
//   isAnswered(q)              required-ness check for one question
import { escapeHtml } from "./html.js";

export const FORM_SHORT = {
  kickoff_update: "Kickoff Update",
  daily_update: "Daily Update",
  completion: "Completion",
  truck_unloading: "Truck Unloading",
  truck_loading: "Truck Loading",
  wire_guidance_trailer: "WG Trailer",
  gear_request: "Gear Request",
};
export const TOGGLE_LABEL = { jha: "Daily JHA", anchoring: "Anchoring", wire_guidance: "Wire Guidance" };

export function createFormRenderer(tpl, opts = {}) {
  const answers = opts.answers || {};
  const editor = !!opts.editor;
  const preview = !!opts.preview || editor;
  const removedKeys = new Set(opts.removedKeys || []);
  const onChange = opts.onChange || null;
  const onFiles = opts.onFiles || null;
  const dis = preview ? "disabled" : "";

  // Editor shows EVERY section (disabled ones dimmed, toggle inline);
  // crew filling + plain preview show only the enabled ones.
  const enabledSections = (tpl.definition?.sections || [])
    .filter((s) => editor || s.enabled);
  let root = null;

  const changed = () => { if (onChange) onChange(); };

  // — question renderers —
  const fileRowHtml = (f, key, i) => `
      <div class="ff-file">
        <span style="flex:none">📎</span>
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(f.filename || "file")}</span>
        <span style="color:#059669;font-weight:800;flex:none">✓</span>
        ${preview ? "" : `<button type="button" class="ff-x" data-rmfile="${escapeHtml(key)}" data-idx="${i}">Remove</button>`}
      </div>`;

  const qFile = (q) => {
    const val = Array.isArray(answers[q.key]) ? answers[q.key] : [];
    const isVideo = q.type === "video";
    const isPhotos = q.type === "photos";
    const accept = isVideo ? "video/*" : isPhotos ? "image/*" : "image/*,video/*,application/pdf";
    const multiple = !!q.multiple;
    // capture= forces the camera app; keep it for single video/photo shots but
    // omit it when multiple files are expected so the gallery stays available.
    const capture = multiple ? "" : `capture="environment"`;
    const btnText = isVideo ? "Record / choose video" : isPhotos ? (multiple ? "Add photos" : "Take / choose photo") : "Add photo, video or PDF";
    const fileRows = val.map((f, i) => fileRowHtml(f, q.key, i)).join("");
    const countHint = q.count ? `<div class="ff-hint mt-1">${q.count} expected · ${val.length} uploaded</div>` : "";
    const btn = preview
      ? `<div class="ff-filebtn" data-filewrap="${escapeHtml(q.key)}"><span>${btnText}</span></div>`
      : `<label class="ff-filebtn" data-filewrap="${escapeHtml(q.key)}">
        <span>${btnText}</span>
        <input type="file" accept="${accept}" ${capture} ${multiple ? "multiple" : ""} data-file="${escapeHtml(q.key)}" style="display:none" />
      </label>`;
    return `
      ${btn}
      <div data-filelist="${escapeHtml(q.key)}">${fileRows}</div>
      <div data-fileprog="${escapeHtml(q.key)}"></div>
      ${countHint}`;
  };

  const qYesNo = (q) => {
    const v = answers[q.key];
    return `
      <div class="ff-yn" data-yn="${escapeHtml(q.key)}">
        <button type="button" data-ynval="yes" class="${v === "yes" ? "on" : ""}">Yes</button>
        <button type="button" data-ynval="no" class="${v === "no" ? "on" : ""}">No</button>
      </div>
      <div data-branch="${escapeHtml(q.key)}"></div>`;
  };

  // Editor-only per-question controls (host binds the data attributes).
  const qControls = (q) => {
    if (!editor) return "";
    if (q.custom) {
      return `<button type="button" class="ff-qx" data-rmq-custom="${escapeHtml(q.key)}" title="Remove this custom question">✕</button>`;
    }
    if (removedKeys.has(q.key)) {
      return `<button type="button" class="ff-restore" data-restoreq="${escapeHtml(q.key)}">Restore</button>`;
    }
    if (q.red_flag_on === "yes" || q.red_flag_on === "no") {
      return `<span class="ff-flagmark" title="Raises a red flag for the PM">⚑</span>
        <button type="button" class="ff-qx" disabled title="This question raises a red flag for the PM and can't be removed">✕</button>`;
    }
    return `<button type="button" class="ff-qx" data-rmq="${escapeHtml(q.key)}" title="Remove this question for this project">✕</button>`;
  };

  const qLabelRow = (q) => `
    <div class="${editor ? "ff-qhead " : ""}mb-1">
      <div class="ff-label" ${editor ? `style="flex:1;min-width:0"` : ""}>${escapeHtml(q.label)}${q.optional ? ` <span class="ff-hint" style="font-weight:600">(if applicable)</span>` : ""}${q.custom ? ` <span style="font-size:9px;font-weight:800;text-transform:uppercase;color:#6d28d9">custom</span>` : ""}</div>
      ${qControls(q)}
    </div>`;

  const qHtml = (q) => {
    // Removed for this project: struck-through with Restore (editor only —
    // merged templates never contain removed questions outside the editor).
    if (editor && !q.custom && removedKeys.has(q.key)) {
      return `<div class="ff-q ff-q-removed" data-q="${escapeHtml(q.key)}">${qLabelRow(q)}</div>`;
    }
    if (q.type === "signature" && q.deferred) {
      return `<div class="ff-q" data-q="${escapeHtml(q.key)}">
        ${qLabelRow(q)}
        <div class="ff-note">Customer sign-off arrives in a later update.</div>
      </div>`;
    }
    let control = "";
    switch (q.type) {
      case "video": case "photos": case "media": control = qFile(q); break;
      case "yes_no": control = qYesNo(q); break;
      case "number": control = `<input class="ff-input" inputmode="decimal" data-val="${escapeHtml(q.key)}" value="${escapeHtml(answers[q.key] ?? "")}" ${dis} />`; break;
      case "select": control = `<select class="ff-select" data-val="${escapeHtml(q.key)}" ${dis}>
          <option value="">Choose…</option>
          ${(q.options || []).map((o) => `<option value="${escapeHtml(o)}" ${answers[q.key] === o ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}
        </select>`; break;
      case "textarea": control = `<textarea class="ff-textarea" rows="3" data-val="${escapeHtml(q.key)}" ${dis}>${escapeHtml(answers[q.key] ?? "")}</textarea>`; break;
      default: control = `<textarea class="ff-textarea" rows="2" data-val="${escapeHtml(q.key)}" ${dis}>${escapeHtml(answers[q.key] ?? "")}</textarea>`;
    }
    return `<div class="ff-q" data-q="${escapeHtml(q.key)}">
      ${qLabelRow(q)}
      ${q.hint ? `<div class="ff-hint" style="margin-bottom:6px">${escapeHtml(q.hint)}</div>` : ""}
      ${control}
    </div>`;
  };

  const sectionHtml = (sec) => {
    const isToggled = (sec.toggle || "always") !== "always";
    const head = editor && isToggled
      ? `<div class="ff-section" style="display:flex;align-items:center;gap:10px">
           <span style="flex:1;min-width:0">${escapeHtml(sec.title)}</span>
           <span style="display:inline-flex;align-items:center;gap:6px;text-transform:none;letter-spacing:0;font-size:11px;font-weight:700;color:rgba(0,0,0,.55)">
             ${sec.enabled ? "On" : "Off"}
             <button type="button" class="pm-switch ${sec.enabled ? "on" : ""}" data-sec-toggle="${escapeHtml(sec.toggle)}" role="switch" aria-checked="${sec.enabled ? "true" : "false"}" aria-label="${escapeHtml(TOGGLE_LABEL[sec.toggle] || sec.toggle)}"></button>
           </span>
         </div>`
      : `<div class="ff-section">${escapeHtml(sec.title)}</div>`;
    const qs = (sec.questions || []).map(qHtml).join("");
    const add = editor
      ? `<button type="button" class="ff-addq" data-addq="${escapeHtml(sec.key)}">+ Add question</button>`
      : "";
    if (editor && !sec.enabled) return `${head}<div class="ff-sec-off">${qs}${add}</div>`;
    return `${head}${qs}${add}`;
  };

  const html = () => enabledSections.map(sectionHtml).join("");

  // — lookups & branch rendering —
  const findQuestion = (key) => {
    const walk = (qs) => {
      for (const q of qs || []) {
        if (q.key === key) return q;
        if (q.branches) {
          const hit = walk(q.branches.yes) || walk(q.branches.no);
          if (hit) return hit;
        }
      }
      return null;
    };
    for (const sec of enabledSections) {
      const hit = walk(sec.questions);
      if (hit) return hit;
    }
    return null;
  };

  const renderBranch = (parentKey) => {
    if (!root) return;
    const host = root.querySelector(`[data-branch="${CSS.escape(parentKey)}"]`);
    const q = findQuestion(parentKey);
    if (!host || !q) return;
    const taken = answers[parentKey];
    const kids = (q.branches && q.branches[taken]) || [];
    host.innerHTML = kids.length ? `<div class="ff-branch">${kids.map(qHtml).join("")}</div>` : "";
    bindControls(host);
  };

  const setFileProgress = (key, htmlStr) => {
    const el = root?.querySelector(`[data-fileprog="${CSS.escape(key)}"]`);
    if (el) el.innerHTML = htmlStr;
  };

  const redrawFiles = (key) => {
    const q = findQuestion(key);
    const list = root?.querySelector(`[data-filelist="${CSS.escape(key)}"]`);
    if (!q || !list) return;
    const val = Array.isArray(answers[key]) ? answers[key] : [];
    list.innerHTML = val.map((f, i) => fileRowHtml(f, key, i)).join("");
  };

  function bindControls(scope) {
    if (!preview) {
      scope.querySelectorAll("[data-val]").forEach((el) => {
        if (el.dataset.bound) return; el.dataset.bound = "1";
        el.addEventListener("input", () => { answers[el.getAttribute("data-val")] = el.value; changed(); });
        el.addEventListener("change", () => { answers[el.getAttribute("data-val")] = el.value; changed(); });
      });
      scope.querySelectorAll("[data-file]").forEach((inp) => {
        if (inp.dataset.bound) return; inp.dataset.bound = "1";
        inp.addEventListener("change", () => { if (onFiles) onFiles(inp.getAttribute("data-file"), inp.files || []); inp.value = ""; });
      });
    }
    // Yes/No stays live in BOTH modes — the preview explores branches with it.
    scope.querySelectorAll("[data-yn]").forEach((wrap) => {
      if (wrap.dataset.bound) return; wrap.dataset.bound = "1";
      const key = wrap.getAttribute("data-yn");
      wrap.querySelectorAll("[data-ynval]").forEach((b) => b.addEventListener("click", () => {
        answers[key] = b.getAttribute("data-ynval");
        if (!preview) changed();
        wrap.querySelectorAll("[data-ynval]").forEach((x) => x.classList.toggle("on", x === b));
        renderBranch(key);
      }));
    });
  }

  const attach = (rootEl) => {
    root = rootEl;
    bindControls(root);
    // Restore branch UIs for already-answered yes/no questions (drafts).
    enabledSections.forEach((sec) => (sec.questions || []).forEach((q) => {
      if (q.type === "yes_no" && (answers[q.key] === "yes" || answers[q.key] === "no")) renderBranch(q.key);
    }));
  };

  // — required-ness (crew submit) —
  // Every question is required EXCEPT: optional:true ("If applicable"),
  // deferred signatures, and branch children of the branch not taken.
  const activeQuestions = () => {
    const out = [];
    const walk = (qs) => {
      for (const q of qs || []) {
        out.push(q);
        if (q.type === "yes_no" && q.branches) {
          const taken = answers[q.key];
          if (taken === "yes" || taken === "no") walk(q.branches[taken]);
        }
      }
    };
    enabledSections.forEach((sec) => walk(sec.questions));
    return out;
  };

  const isAnswered = (q) => {
    if (q.optional) return true;
    if (q.type === "signature") return true; // deferred to Phase 3
    const v = answers[q.key];
    if (q.type === "video" || q.type === "photos" || q.type === "media") return Array.isArray(v) && v.length > 0;
    if (q.type === "yes_no") return v === "yes" || v === "no";
    return v != null && String(v).trim() !== "";
  };

  return {
    answers, enabledSections, html, attach, renderBranch, findQuestion,
    redrawFiles, setFileProgress, activeQuestions, isAnswered,
  };
}
