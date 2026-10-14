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
//     drawings  PM-attached drawings for the Marked Drawings question
//               ([{id, filename, content_type}] — tpl.drawings). Rendered as
//               cards; the HOST binds by delegation and fills thumbnails
//               (utils/drawing-markup.js fillDrawingThumbs):
//                 data-dw-open (doc id) + data-dw-q (question key)
//                 data-dw-rm (editor: detach) · data-dw-attach (editor)
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
  daily_jha: "Daily JHA",
};
export const TOGGLE_LABEL = { jha: "Daily JHA", anchoring: "Anchoring", wire_guidance: "Wire Guidance" };

export function createFormRenderer(tpl, opts = {}) {
  const answers = opts.answers || {};
  const editor = !!opts.editor;
  const preview = !!opts.preview || editor;
  const removedKeys = new Set(opts.removedKeys || []);
  const onChange = opts.onChange || null;
  const onFiles = opts.onFiles || null;
  const drawings = Array.isArray(opts.drawings) ? opts.drawings : (tpl.drawings || []);
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

  // Marked drawings (items with source_document_id) render as thumbnail
  // cards with Open / edit + Remove; other files keep the plain row.
  const fileListHtml = (q, val) => {
    const marks = [], rows = [];
    val.forEach((f, i) => ((isDrawingQ(q) && f && f.source_document_id != null) ? marks : rows).push([f, i]));
    const cards = marks.map(([f, i]) => `
      <div class="dw-card">
        <div class="dw-thumb" data-mthumb="${escapeHtml(String(f.document_id))}"><span class="dm-thumb-fallback">…</span></div>
        <div class="dw-name" title="${escapeHtml(f.filename || "")}">✓ ${escapeHtml(f.filename || "Marked drawing")}</div>
        ${preview ? "" : `<div class="dw-actions">
          <button type="button" class="dw-open" data-mk-open="${escapeHtml(q.key)}" data-idx="${i}">Open / edit</button>
          <button type="button" class="dw-rm" data-rmfile="${escapeHtml(q.key)}" data-idx="${i}">Remove</button>
        </div>`}
      </div>`).join("");
    return (marks.length ? `
        <div class="dw-or" style="margin-top:4px">Your marked drawings</div>
        <div class="dw-list">${cards}</div>
        ${preview ? "" : `<div class="dw-saved-note">Saved to the project's Documents. Your PM receives them when you press <b>Submit</b> at the bottom of this form.</div>`}` : "")
      + rows.map(([f, i]) => fileRowHtml(f, q.key, i)).join("");
  };

  // allow_none (e.g. "No video today"): an explicit skip — the answer becomes
  // that text instead of a file list; uploading a file replaces it.
  const noneBtnHtml = (q) => {
    if (!q.allow_none) return "";
    const files = Array.isArray(answers[q.key]) && answers[q.key].length > 0;
    if (files) return "";
    const on = answers[q.key] === q.allow_none;
    return `<button type="button" class="ff-none${on ? " on" : ""}" data-none="${escapeHtml(q.key)}" ${preview ? "disabled" : ""}>${on ? "✓ " : ""}${escapeHtml(q.allow_none)}</button>`;
  };

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
    const fileRows = fileListHtml(q, val);
    const countHint = q.count ? `<div class="ff-hint mt-1">${q.count} expected · ${val.length} uploaded</div>` : "";
    const btn = preview
      ? `<div class="ff-filebtn" data-filewrap="${escapeHtml(q.key)}"><span>${btnText}</span></div>`
      : `<label class="ff-filebtn" data-filewrap="${escapeHtml(q.key)}">
        <span>${btnText}</span>
        <input type="file" accept="${accept}" ${capture} ${multiple ? "multiple" : ""} data-file="${escapeHtml(q.key)}" style="display:none" />
      </label>`;
    return `
      ${btn}
      <div data-nonewrap="${escapeHtml(q.key)}">${noneBtnHtml(q)}</div>
      <div data-filelist="${escapeHtml(q.key)}">${fileRows}</div>
      <div data-fileprog="${escapeHtml(q.key)}"></div>
      ${countHint}`;
  };

  // Marked Drawings: the PM attaches drawings from "2 Drawings and Calcs";
  // the crew opens one, highlights it, and the marked copy becomes the answer.
  const isDrawingQ = (q) => q.key === "marked_drawings" || q.drawings === true;
  const qDrawings = (q) => {
    const cards = drawings.map((d) => `
      <div class="dw-card">
        <div class="dw-thumb" data-dthumb="${escapeHtml(String(d.id))}"><span class="dm-thumb-fallback">…</span></div>
        <div class="dw-name" title="${escapeHtml(d.filename || "")}">${escapeHtml(d.filename || "Drawing")}</div>
        <div class="dw-actions">
          ${editor
            ? `<button type="button" class="dw-open" data-dw-open="${escapeHtml(String(d.id))}" data-dw-q="${escapeHtml(q.key)}">Preview</button>
               <button type="button" class="dw-rm" data-dw-rm="${escapeHtml(String(d.id))}" title="Remove from this form">✕</button>`
            : `<button type="button" class="dw-open" data-dw-open="${escapeHtml(String(d.id))}" data-dw-q="${escapeHtml(q.key)}">${preview ? "Open (try it)" : "Open &amp; mark up"}</button>`}
        </div>
      </div>`).join("");
    if (editor) {
      return `
        ${drawings.length ? `<div class="dw-list">${cards}</div>` : `<div class="dw-empty">No drawings attached yet — the crew will only see the upload button below.</div>`}
        <button type="button" class="dw-attach" data-dw-attach="${escapeHtml(q.key)}">📎 Attach drawings from "2 Drawings and Calcs"</button>
        <div class="dw-or">Crew can also upload</div>`;
    }
    if (!drawings.length) return "";
    return `<div class="dw-list">${cards}</div><div class="dw-or">Or add a photo / PDF</div>`;
  };

  // Signature: a finger/stylus pad. "Save signature" hands a PNG to the same
  // upload pipeline as photos (onFiles); allow_none offers the skip button.
  const signed = (q) => Array.isArray(answers[q.key]) && answers[q.key].length > 0;
  const sigPadHtml = (q) => {
    if (signed(q) || answers[q.key] === q.allow_none) return "";
    return `
      <div class="ff-sig">
        <canvas class="ff-sigpad" data-sigpad="${escapeHtml(q.key)}"></canvas>
        <div class="ff-sigline">Sign above</div>
      </div>
      <div class="ff-sigbtns">
        <button type="button" class="ff-btn2" data-sigclear="${escapeHtml(q.key)}" ${preview ? "disabled" : ""}>Clear</button>
        <button type="button" class="ff-btn" data-sigsave="${escapeHtml(q.key)}" ${preview ? "disabled" : ""}>Save signature</button>
      </div>
      <div class="ff-err" data-sigmsg="${escapeHtml(q.key)}" style="display:none"></div>`;
  };
  const qSignature = (q) => `
      <div data-sigwrap="${escapeHtml(q.key)}">${sigPadHtml(q)}</div>
      <div data-nonewrap="${escapeHtml(q.key)}">${noneBtnHtml(q)}</div>
      <div data-filelist="${escapeHtml(q.key)}">${(Array.isArray(answers[q.key]) ? answers[q.key] : []).map((f, i) => fileRowHtml(f, q.key, i)).join("")}</div>
      <div data-fileprog="${escapeHtml(q.key)}"></div>`;

  function bindSigPad(canvas) {
    if (canvas.dataset.bound) return; canvas.dataset.bound = "1";
    const dpr = window.devicePixelRatio || 1;
    const size = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      const c = canvas.getContext("2d");
      c.scale(dpr, dpr); c.lineWidth = 2.5; c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = "#111";
    };
    size();
    canvas._inked = false;
    let last = null;
    const pt = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    canvas.addEventListener("pointerdown", (e) => {
      if (preview) return;
      canvas.setPointerCapture(e.pointerId); last = pt(e);
      const m = root?.querySelector(`[data-sigmsg="${CSS.escape(canvas.getAttribute("data-sigpad"))}"]`);
      if (m) m.style.display = "none";
      const c = canvas.getContext("2d"); c.beginPath(); c.arc(last[0], last[1], 1.2, 0, Math.PI * 2); c.fillStyle = "#111"; c.fill();
      canvas._inked = true;
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!last) return;
      const p = pt(e); const c = canvas.getContext("2d");
      c.beginPath(); c.moveTo(last[0], last[1]); c.lineTo(p[0], p[1]); c.stroke(); last = p;
    });
    const end = () => { last = null; };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  }

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
    if (q.type === "signature" && !q.deferred) {
      return `<div class="ff-q" data-q="${escapeHtml(q.key)}">
        ${qLabelRow(q)}
        ${q.hint ? `<div class="ff-hint" style="margin-bottom:6px">${escapeHtml(q.hint)}</div>` : ""}
        ${qSignature(q)}
      </div>`;
    }
    if (q.type === "signature" && q.deferred) {
      return `<div class="ff-q" data-q="${escapeHtml(q.key)}">
        ${qLabelRow(q)}
        <div class="ff-note">Customer sign-off arrives in a later update.</div>
      </div>`;
    }
    let control = "";
    switch (q.type) {
      case "video": case "photos": case "media": control = (isDrawingQ(q) ? qDrawings(q) : "") + qFile(q); break;
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
    list.innerHTML = fileListHtml(q, val);
    const nw = root?.querySelector(`[data-nonewrap="${CSS.escape(key)}"]`);
    if (nw) nw.innerHTML = noneBtnHtml(q);
    const sw = root?.querySelector(`[data-sigwrap="${CSS.escape(key)}"]`);
    if (sw) { sw.innerHTML = sigPadHtml(q); bindControls(sw); }
    if (nw) bindControls(nw);
  };

  function bindControls(scope) {
    if (!preview) {
      scope.querySelectorAll("[data-val]").forEach((el) => {
        if (el.dataset.bound) return; el.dataset.bound = "1";
        el.addEventListener("input", () => { answers[el.getAttribute("data-val")] = el.value; changed(); });
        el.addEventListener("change", () => { answers[el.getAttribute("data-val")] = el.value; changed(); });
      });
      scope.querySelectorAll("[data-sigpad]").forEach(bindSigPad);
      scope.querySelectorAll("[data-sigclear]").forEach((b) => {
        if (b.dataset.bound) return; b.dataset.bound = "1";
        b.addEventListener("click", () => {
          const cv = scope.querySelector(`[data-sigpad="${CSS.escape(b.getAttribute("data-sigclear"))}"]`) ||
                     root?.querySelector(`[data-sigpad="${CSS.escape(b.getAttribute("data-sigclear"))}"]`);
          if (!cv) return;
          cv.getContext("2d").clearRect(0, 0, cv.width, cv.height); cv._inked = false;
        });
      });
      scope.querySelectorAll("[data-sigsave]").forEach((b) => {
        if (b.dataset.bound) return; b.dataset.bound = "1";
        b.addEventListener("click", () => {
          const key = b.getAttribute("data-sigsave");
          const cv = root?.querySelector(`[data-sigpad="${CSS.escape(key)}"]`);
          const msg = root?.querySelector(`[data-sigmsg="${CSS.escape(key)}"]`);
          if (!cv || !cv._inked) { if (msg) { msg.textContent = "Sign in the box first."; msg.style.display = ""; } return; }
          if (msg) msg.style.display = "none";
          // White background so the PNG reads on any viewer.
          const out = document.createElement("canvas");
          out.width = cv.width; out.height = cv.height;
          const c = out.getContext("2d"); c.fillStyle = "#fff"; c.fillRect(0, 0, out.width, out.height); c.drawImage(cv, 0, 0);
          out.toBlob((blob) => {
            if (!blob || !onFiles) return;
            const d = new Date();
            const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            onFiles(key, [new File([blob], `customer-signature-${day}.png`, { type: "image/png" })]);
          }, "image/png");
        });
      });
      scope.querySelectorAll("[data-none]").forEach((b) => {
        if (b.dataset.bound) return; b.dataset.bound = "1";
        b.addEventListener("click", () => {
          const key = b.getAttribute("data-none");
          const q = findQuestion(key);
          if (!q) return;
          answers[key] = answers[key] === q.allow_none ? [] : q.allow_none;
          changed();
          redrawFiles(key);
          root?.querySelector(`[data-q="${CSS.escape(key)}"]`)?.classList.remove("ff-missing");
          bindControls(root.querySelector(`[data-nonewrap="${CSS.escape(key)}"]`));
        });
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
    if (q.type === "signature" && q.deferred) return true;
    if (q.type === "signature") return (Array.isArray(answers[q.key]) && answers[q.key].length > 0)
      || (!!q.allow_none && answers[q.key] === q.allow_none);
    const v = answers[q.key];
    if (q.type === "video" || q.type === "photos" || q.type === "media")
      return (Array.isArray(v) && v.length > 0) || (!!q.allow_none && v === q.allow_none);
    if (q.type === "yes_no") return v === "yes" || v === "no";
    return v != null && String(v).trim() !== "";
  };

  return {
    answers, enabledSections, html, attach, renderBranch, findQuestion,
    redrawFiles, setFileProgress, activeQuestions, isAnswered,
  };
}
