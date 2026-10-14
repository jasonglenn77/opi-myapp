// Drawing viewer + highlighter (Daily Update › Marked Drawings).
//
// The crew opens a PM-attached drawing (PDF or image), pinch-zooms around it
// and highlights what they worked on; Save exports the drawing with the
// highlights burned in as a PNG for the form answer. Shared by the crew portal
// (#/field) and the PM's form preview (try-it mode, no save).
//
// PDFs render with the bundled pdf.js (vendor/pdfjs, loaded on first use).
// Drawing bytes must come through the app's own API (same origin) — a
// cross-origin S3 image would taint the canvas and block the export.

const PDFJS_SRC = "/vendor/pdfjs/pdf.min.js";
const PDFJS_WORKER = "/vendor/pdfjs/pdf.worker.min.js";
const MAX_DIM = 2400;      // longest side of the working canvas (iOS memory)
const INK_ALPHA = 0.45;    // highlighter transparency (screen + export)

export const MARK_COLORS = [
  { key: "yellow", hex: "#facc15", label: "In progress" },
  { key: "green",  hex: "#22c55e", label: "Completed" },
  { key: "red",    hex: "#ef4444", label: "Red flag / CO" },
  { key: "blue",   hex: "#3b82f6", label: "Other" },
];
const SIZES = [{ key: "S", px: 14 }, { key: "M", px: 28 }, { key: "L", px: 56 }];

let _pdfjs = null;
function loadPdfJs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = new Promise((resolve, reject) => {
    if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
    const s = document.createElement("script");
    s.src = PDFJS_SRC;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      resolve(window.pdfjsLib);
    };
    s.onerror = () => { _pdfjs = null; reject(new Error("Couldn't load the PDF viewer")); };
    document.head.appendChild(s);
  });
  return _pdfjs;
}

export const isPdf = (ct, name) =>
  String(ct || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(String(name || ""));

// Opened drawing source: render(page, maxDim) -> canvas; pageCount.
async function openSource(blob, contentType, filename) {
  if (isPdf(contentType, filename)) {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    return {
      pageCount: doc.numPages,
      async render(pageNo, maxDim) {
        const page = await doc.getPage(pageNo);
        const vp1 = page.getViewport({ scale: 1 });
        const scale = Math.min(maxDim / Math.max(vp1.width, vp1.height), 4);
        const vp = page.getViewport({ scale });
        const c = document.createElement("canvas");
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        return c;
      },
    };
  }
  const url = URL.createObjectURL(blob);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("Couldn't open this image"));
    i.src = url;
  });
  return {
    pageCount: 1,
    async render(_pageNo, maxDim) {
      const k = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return c;
    },
  };
}

/** Small preview (first page) as a data URL — for picker / form cards. */
export async function drawingThumbnail(blob, contentType, filename, size = 320) {
  const src = await openSource(blob, contentType, filename);
  const c = await src.render(1, size);
  return c.toDataURL("image/jpeg", 0.8);
}

/** Fill every [data-dthumb="<docId>"] inside root with a thumbnail, using
 *  loadBlob(docId) -> Promise<Blob>. Failures fall back to a file icon. */
export async function fillDrawingThumbs(root, drawings, loadBlob) {
  const byId = new Map((drawings || []).map((d) => [String(d.id), d]));
  for (const el of root.querySelectorAll("[data-dthumb]")) {
    if (el.dataset.filled) continue;
    el.dataset.filled = "1";
    const d = byId.get(el.getAttribute("data-dthumb"));
    if (!d) continue;
    try {
      const url = await drawingThumbnail(await loadBlob(d.id), d.content_type, d.filename);
      el.innerHTML = `<img src="${url}" alt="" />`;
    } catch (_) {
      el.innerHTML = `<span class="dm-thumb-fallback">${isPdf(d.content_type, d.filename) ? "PDF" : "IMG"}</span>`;
    }
  }
}

/** Fill every [data-mthumb="<docId>"] with the saved (already-PNG) image. */
export async function fillMarkedThumbs(root, loadBlob) {
  for (const el of root.querySelectorAll("[data-mthumb]")) {
    if (el.dataset.filled) continue;
    el.dataset.filled = "1";
    try {
      const url = URL.createObjectURL(await loadBlob(el.getAttribute("data-mthumb")));
      el.innerHTML = `<img src="${url}" alt="" />`;
    } catch (_) {
      el.innerHTML = `<span class="dm-thumb-fallback">IMG</span>`;
    }
  }
}

/**
 * Full-screen viewer with highlighter.
 *   title       drawing name for the header
 *   loadBlob()  -> Promise<Blob> of the drawing
 *   contentType / filename  to tell PDFs from images
 *   onSave(blob, filename, markup) -> Promise; omitted = try-it mode (no Save).
 *               markup = {page, w, h, strokes:[{c, w, p:[[x,y]...]}]} — pass it
 *               back as initialMarkup to reopen the marks as editable.
 *   initialMarkup  marks to restore (scaled if the page renders at another size)
 *   viewOnly    no highlighter at all (reviewing a submitted file)
 *   actions     extra header buttons [{label, onClick}]
 */
export function openMarkupViewer({ title, loadBlob, contentType, filename, onSave,
                                   initialMarkup = null, viewOnly = false, actions = [] }) {
  const canSave = !viewOnly && typeof onSave === "function";
  const overlay = document.createElement("div");
  overlay.className = "dm-overlay";
  overlay.innerHTML = `
    <div class="dm-top">
      <div class="dm-title" title="${esc(title)}">${esc(title)}</div>
      <select class="dm-page" data-dm-page hidden></select>
      ${actions.map((a, i) => `<button type="button" class="dm-btn" data-dm-action="${i}">${esc(a.label)}</button>`).join("")}
      <button type="button" class="dm-btn" data-dm-cancel>${canSave ? "Cancel" : "Close"}</button>
      ${canSave ? `<button type="button" class="dm-btn dm-primary" data-dm-save disabled>Save marked drawing</button>` : ""}
    </div>
    <div class="dm-stage" data-dm-stage>
      <div class="dm-world" data-dm-world></div>
      <div class="dm-status" data-dm-status>Loading drawing…</div>
    </div>
    ${viewOnly ? `<div class="dm-tools">
      <div class="dm-group"><button type="button" class="dm-tool" data-dm-fit title="Fit to screen">Fit</button></div>
      <div class="dm-legend">Pinch or scroll to zoom · drag to move</div>
    </div>` : `<div class="dm-tools">
      <div class="dm-group">
        <button type="button" class="dm-tool" data-dm-mode="pan" title="Move & zoom">✋ Move</button>
        <button type="button" class="dm-tool on" data-dm-mode="ink" title="Highlighter">🖍 Highlight</button>
      </div>
      <div class="dm-group">
        ${MARK_COLORS.map((c, i) => `<button type="button" class="dm-swatch${i === 0 ? " on" : ""}" data-dm-color="${c.hex}" title="${esc(c.label)}" style="--sw:${c.hex}"><span></span><em>${esc(c.label)}</em></button>`).join("")}
      </div>
      <div class="dm-group">
        ${SIZES.map((z) => `<button type="button" class="dm-tool${z.key === "M" ? " on" : ""}" data-dm-size="${z.px}" title="Highlighter size">${z.key}</button>`).join("")}
        <button type="button" class="dm-tool" data-dm-undo title="Undo last mark">↶ Undo</button>
        <button type="button" class="dm-tool" data-dm-clear title="Erase all marks">Clear</button>
        <button type="button" class="dm-tool" data-dm-fit title="Fit to screen">Fit</button>
      </div>
      <div class="dm-legend">${MARK_COLORS.slice(0, 3).map((c) => `<span><i style="background:${c.hex}"></i>${esc(c.label)}</span>`).join("")} · two fingers to zoom</div>
    </div>`}`;
  document.body.appendChild(overlay);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  const $ = (sel) => overlay.querySelector(sel);
  const stage = $("[data-dm-stage]");
  const world = $("[data-dm-world]");
  const status = $("[data-dm-status]");
  const pageSel = $("[data-dm-page]");
  const saveBtn = $("[data-dm-save]");

  let src = null, base = null, ink = null, inkCtx = null;
  let strokes = [];                 // {color, width, pts:[[x,y]...]}
  let mode = viewOnly ? "pan" : "ink", color = MARK_COLORS[0].hex, width = 28;
  let dirty = false;
  if (viewOnly) stage.classList.add("dm-panning");
  let scale = 1, tx = 0, ty = 0;
  let pageNo = 1, closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    document.body.style.overflow = prevOverflow;
    overlay.remove();
  };
  const setStatus = (t) => { status.textContent = t || ""; status.hidden = !t; };
  const applyTransform = () => { world.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; };
  const fit = () => {
    if (!base) return;
    const r = stage.getBoundingClientRect();
    scale = Math.min(r.width / base.width, r.height / base.height) * 0.96;
    tx = (r.width - base.width * scale) / 2;
    ty = (r.height - base.height * scale) / 2;
    applyTransform();
  };
  const toWorld = (cx, cy) => {
    const r = stage.getBoundingClientRect();
    return [(cx - r.left - tx) / scale, (cy - r.top - ty) / scale];
  };
  const zoomAt = (cx, cy, factor) => {
    const r = stage.getBoundingClientRect();
    const ns = Math.min(8, Math.max(0.05, scale * factor));
    const k = ns / scale;
    tx = (cx - r.left) - k * ((cx - r.left) - tx);
    ty = (cy - r.top) - k * ((cy - r.top) - ty);
    scale = ns;
    applyTransform();
  };

  const drawStroke = (s) => {
    inkCtx.strokeStyle = s.color;
    inkCtx.lineWidth = s.width;
    inkCtx.lineCap = "round";
    inkCtx.lineJoin = "round";
    inkCtx.beginPath();
    s.pts.forEach(([x, y], i) => (i ? inkCtx.lineTo(x, y) : inkCtx.moveTo(x, y)));
    if (s.pts.length === 1) inkCtx.lineTo(s.pts[0][0] + 0.1, s.pts[0][1]);
    inkCtx.stroke();
  };
  const redrawInk = () => {
    if (!inkCtx) return;
    inkCtx.clearRect(0, 0, ink.width, ink.height);
    strokes.forEach(drawStroke);
    if (saveBtn) saveBtn.disabled = strokes.length === 0;
  };

  async function showPage(n) {
    setStatus("Loading drawing…");
    try {
      base = await src.render(n, MAX_DIM);
    } catch (e) { setStatus(e?.message || "Couldn't open this drawing"); return; }
    if (closed) return;
    pageNo = n;
    dirty = false;
    ink = document.createElement("canvas");
    ink.width = base.width; ink.height = base.height;
    ink.className = "dm-ink";
    ink.style.opacity = String(INK_ALPHA);
    inkCtx = ink.getContext("2d");
    base.className = "dm-base";
    world.style.width = base.width + "px";
    world.style.height = base.height + "px";
    world.replaceChildren(base, ink);
    strokes = [];
    if (initialMarkup && Number(initialMarkup.page || 1) === n && Array.isArray(initialMarkup.strokes)) {
      const kx = initialMarkup.w ? base.width / initialMarkup.w : 1;
      const ky = initialMarkup.h ? base.height / initialMarkup.h : 1;
      strokes = initialMarkup.strokes.map((st) => ({
        color: st.c, width: (st.w || 28) * kx, pts: (st.p || []).map(([x, y]) => [x * kx, y * ky]),
      }));
    }
    redrawInk();
    fit();
    setStatus("");
  }

  // ── pointer handling: draw / pan / pinch ──
  const pts = new Map();     // pointerId -> {x,y}
  let cur = null;            // stroke in progress
  let pinch = null;          // {d, cx, cy}
  let panFrom = null;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  stage.addEventListener("pointerdown", (e) => {
    if (!base) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      // second finger: abandon the stroke, start pinch-zoom
      if (cur) { strokes.pop(); cur = null; redrawInk(); }
      const [a, b] = [...pts.values()];
      pinch = { d: dist(a, b), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      panFrom = null;
      return;
    }
    if (mode === "ink" && e.button !== 1 && e.button !== 2) {
      cur = { color, width: width, pts: [toWorld(e.clientX, e.clientY)] };
      strokes.push(cur);
      dirty = true;
      drawStroke(cur);
    } else {
      panFrom = { x: e.clientX, y: e.clientY };
    }
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = dist(a, b), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      tx += cx - pinch.cx; ty += cy - pinch.cy; applyTransform();
      if (pinch.d > 0) zoomAt(cx, cy, d / pinch.d);
      pinch = { d, cx, cy };
      return;
    }
    if (cur) {
      const p = toWorld(e.clientX, e.clientY);
      const last = cur.pts[cur.pts.length - 1];
      cur.pts.push(p);
      inkCtx.strokeStyle = cur.color; inkCtx.lineWidth = cur.width;
      inkCtx.lineCap = "round"; inkCtx.lineJoin = "round";
      inkCtx.beginPath(); inkCtx.moveTo(last[0], last[1]); inkCtx.lineTo(p[0], p[1]); inkCtx.stroke();
      return;
    }
    if (panFrom) {
      tx += e.clientX - panFrom.x; ty += e.clientY - panFrom.y;
      panFrom = { x: e.clientX, y: e.clientY };
      applyTransform();
    }
  });
  const endPointer = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size === 0) {
      if (cur) { cur = null; redrawInk(); }   // redraw as one path (no seams)
      panFrom = null;
    }
  };
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  stage.addEventListener("contextmenu", (e) => e.preventDefault());

  // ── toolbar ──
  overlay.addEventListener("click", async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.hasAttribute("data-dm-cancel")) {
      if (canSave && dirty && !confirm("Discard your changes to this drawing?")) return;
      close(); return;
    }
    if (t.hasAttribute("data-dm-action")) {
      const a = actions[Number(t.getAttribute("data-dm-action"))];
      if (a && a.onClick) a.onClick();
      return;
    }
    if (t.hasAttribute("data-dm-mode")) {
      mode = t.getAttribute("data-dm-mode");
      overlay.querySelectorAll("[data-dm-mode]").forEach((b) => b.classList.toggle("on", b === t));
      stage.classList.toggle("dm-panning", mode === "pan");
      return;
    }
    if (t.hasAttribute("data-dm-color")) {
      color = t.getAttribute("data-dm-color");
      overlay.querySelectorAll("[data-dm-color]").forEach((b) => b.classList.toggle("on", b === t));
      if (mode !== "ink") overlay.querySelector('[data-dm-mode="ink"]').click();
      return;
    }
    if (t.hasAttribute("data-dm-size")) {
      width = Number(t.getAttribute("data-dm-size"));
      overlay.querySelectorAll("[data-dm-size]").forEach((b) => b.classList.toggle("on", b === t));
      return;
    }
    if (t.hasAttribute("data-dm-undo")) { if (strokes.length) { strokes.pop(); dirty = true; redrawInk(); } return; }
    if (t.hasAttribute("data-dm-clear")) {
      if (strokes.length && confirm("Erase all marks?")) { strokes = []; dirty = true; redrawInk(); }
      return;
    }
    if (t.hasAttribute("data-dm-fit")) { fit(); return; }
    if (t.hasAttribute("data-dm-save") && canSave) {
      t.disabled = true; t.textContent = "Saving…";
      try {
        const out = document.createElement("canvas");
        out.width = base.width; out.height = base.height;
        const ctx = out.getContext("2d");
        ctx.drawImage(base, 0, 0);
        ctx.globalAlpha = INK_ALPHA;
        ctx.drawImage(ink, 0, 0);
        const blob = await new Promise((res) => out.toBlob(res, "image/png"));
        if (!blob) throw new Error("Couldn't create the image");
        const stem = String(filename || title || "drawing").replace(/\.[^.]+$/, "");
        const d = new Date();
        const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const pageTag = src && src.pageCount > 1 ? `-p${pageNo}` : "";
        const markup = {
          page: pageNo, w: base.width, h: base.height,
          strokes: strokes.map((st) => ({ c: st.color, w: Math.round(st.width),
                                          p: st.pts.map(([x, y]) => [Math.round(x), Math.round(y)]) })),
        };
        await onSave(blob, `${stem}${pageTag}-marked-${day}.png`, markup);
        close();
      } catch (err) {
        t.disabled = false; t.textContent = "Save marked drawing";
        alert(`Couldn't save: ${err?.message || err}`);
      }
    }
  });
  pageSel.addEventListener("change", () => {
    const n = Number(pageSel.value);
    if (canSave && dirty && !confirm("Switch pages? Marks on this page will be discarded — save first to keep them.")) {
      pageSel.value = String(pageNo); return;
    }
    showPage(n);
  });
  const onResize = () => { if (!closed) fit(); else window.removeEventListener("resize", onResize); };
  window.addEventListener("resize", onResize);

  (async () => {
    try {
      const blob = await loadBlob();
      src = await openSource(blob, contentType, filename);
      if (src.pageCount > 1) {
        pageSel.innerHTML = Array.from({ length: src.pageCount }, (_, i) =>
          `<option value="${i + 1}">Page ${i + 1} of ${src.pageCount}</option>`).join("");
        pageSel.hidden = false;
      }
      const startPage = Math.min(Math.max(1, Number(initialMarkup?.page || 1)), src.pageCount);
      pageSel.value = String(startPage);
      await showPage(startPage);
    } catch (err) {
      setStatus(`Couldn't open this drawing: ${err?.message || err}`);
    }
  })();

  return { close };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
