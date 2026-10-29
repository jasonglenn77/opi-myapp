// In-app document viewer: a side panel that shows a file without downloading it,
// with Open in new tab / Print / Download. Used by the Documents tab and by every
// place whose numbers were read from a document (the "source" buttons).
//
//   import { openDocViewer, DOC_ICON } from "../utils/doc-viewer.js";
//   openDocViewer({ id: 123, filename: "Payment Schedule.xlsx" });          // a stored document
//   openDocViewer({ drive: fileId, sheet: "Oct 26", filename: "B250" });   // a Drive sheet the app reads
//
// Backed by /api/documents/file/{id}/preview + /content and /api/documents/drive/{id}/preview
// (backend/app/documents/preview.py). HTML previews render in a sandboxed iframe (no scripts).
import { api, getToken } from "../api.js";
import { escapeHtml } from "./html.js";

export const DOC_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>`;

const CSS = `
.dv-backdrop{position:fixed;inset:0;background:rgba(15,23,33,.45);z-index:9000;display:flex;justify-content:flex-end}
.dv-panel{background:#fff;width:min(1100px,94vw);height:100%;display:flex;flex-direction:column;box-shadow:-12px 0 32px rgba(0,0,0,.25)}
.dv-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #e5e8ec;flex-wrap:wrap}
.dv-title{flex:1;min-width:160px}
.dv-name{font-size:14px;font-weight:700;color:#1c2430;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dv-sub{font-size:11px;color:#7a8594;margin-top:1px}
.dv-acts{display:flex;gap:6px;flex-wrap:wrap}
.dv-btn{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:#1f3a5f;background:#fff;border:1px solid #d5dbe2;border-radius:8px;padding:5px 10px;cursor:pointer;text-decoration:none}
.dv-btn:hover{background:#f2f5f8}
.dv-btn:focus-visible,.dv-x:focus-visible,.src-doc-btn:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.dv-btn[disabled]{opacity:.45;cursor:default}
.dv-x{font-size:20px;line-height:1;color:#6b7684;background:none;border:0;cursor:pointer;padding:2px 6px;border-radius:6px}
.dv-x:hover{background:#f2f5f8;color:#1c2430}
.dv-body{flex:1;min-height:0;background:#f4f6f8;display:flex;align-items:stretch;justify-content:center;overflow:auto}
.dv-body iframe{border:0;width:100%;height:100%;background:#fff}
.dv-body img{max-width:100%;max-height:100%;object-fit:contain;margin:auto;display:block}
.dv-body video{max-width:100%;max-height:100%;margin:auto;background:#000}
.dv-msg{margin:auto;text-align:center;color:#4b5563;font-size:13px;max-width:420px;padding:24px;line-height:1.5}
.src-doc-btn{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:700;color:#1d4ed8;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:1px 6px;cursor:pointer;white-space:nowrap}
.src-doc-btn:hover{background:#dbeafe}
@media (max-width:640px){.dv-panel{width:100vw}.dv-acts .dv-lbl{display:none}}
`;
(function inject() {
  if (document.getElementById("dv-css")) return;
  const s = document.createElement("style");
  s.id = "dv-css";
  s.textContent = CSS;
  document.head.appendChild(s);
})();

const ICON = {
  tab: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>`,
  print: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/></svg>`,
  dl: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>`,
};

// A wrapper page for "Open in new tab" on HTML previews: the file's HTML stays in a
// sandboxed iframe, so nothing in it (e.g. an email) can run as the app.
const wrapPage = (title, html) => `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style></head>
<body><iframe sandbox="allow-same-origin allow-modals allow-popups allow-popups-to-escape-sandbox" srcdoc="${escapeHtml(html)}"></iframe></body></html>`;

async function fetchBlob(path) {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

export function openDocViewer({ id, drive, sheet, filename } = {}) {
  const urls = [];
  const wrap = document.createElement("div");
  wrap.className = "dv-backdrop";
  wrap.innerHTML = `<div class="dv-panel" role="dialog" aria-modal="true" aria-label="Document viewer">
      <div class="dv-head">
        <div class="dv-title"><div class="dv-name">${escapeHtml(filename || "Document")}</div><div class="dv-sub" data-sub>Loading…</div></div>
        <div class="dv-acts">
          <button type="button" class="dv-btn" data-act="tab" disabled title="Open in a new browser tab">${ICON.tab}<span class="dv-lbl">New tab</span></button>
          <button type="button" class="dv-btn" data-act="print" disabled title="Print">${ICON.print}<span class="dv-lbl">Print</span></button>
          <button type="button" class="dv-btn" data-act="dl" disabled title="Download a copy">${ICON.dl}<span class="dv-lbl">Download</span></button>
        </div>
        <button type="button" class="dv-x" data-act="close" aria-label="Close">×</button>
      </div>
      <div class="dv-body" data-body><div class="dv-msg">Loading…</div></div>
    </div>`;
  document.body.appendChild(wrap);
  const $ = (s) => wrap.querySelector(s);
  const body = $("[data-body]"), sub = $("[data-sub]");
  const btn = (a) => $(`[data-act="${a}"]`);
  const actions = {};
  const enable = (a, fn) => { if (fn) { actions[a] = fn; btn(a).disabled = false; } };

  const close = () => {
    document.removeEventListener("keydown", onKey);
    urls.forEach((u) => URL.revokeObjectURL(u));
    wrap.remove();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) return close();
    const a = e.target.closest("[data-act]");
    if (!a) return;
    if (a.getAttribute("data-act") === "close") return close();
    const fn = actions[a.getAttribute("data-act")];
    if (fn) fn();
  });
  $("[data-act=close]").focus();

  const openUrl = (u) => window.open(u, "_blank", "noopener");
  const download = (u, name) => { const l = document.createElement("a"); l.href = u; l.download = name || ""; l.rel = "noopener"; document.body.appendChild(l); l.click(); l.remove(); };
  const blobUrl = (b) => { const u = URL.createObjectURL(b); urls.push(u); return u; };
  const fail = (msg, p) => {
    body.innerHTML = `<div class="dv-msg">${escapeHtml(msg)}${p && p.download_url ? `<div style="margin-top:12px"><button type="button" class="dv-btn" data-act="dl">${ICON.dl} Download to open it</button></div>` : ""}</div>`;
    sub.textContent = "Preview not available";
  };

  (async () => {
    let p;
    try {
      p = drive ? await api(`/documents/drive/${encodeURIComponent(drive)}/preview${sheet ? `?sheet=${encodeURIComponent(sheet)}` : ""}`)
                : await api(`/documents/file/${id}/preview`);
    } catch (e) { return fail(`Could not load this file: ${e?.message || e}`); }
    const name = p.filename || filename || "Document";
    $(".dv-name").textContent = name;
    sub.textContent = drive ? `Google Drive${p.sheet ? ` · tab "${p.sheet}"` : ""}${p.modified ? ` · updated ${new Date(p.modified).toLocaleString()}` : ""}`
      : (p.drive_link ? "Copied from Google Drive" : "Stored in the app");
    if (p.download_url) enable("dl", () => download(p.download_url, name));
    else if (p.open_url) enable("dl", () => openUrl(p.open_url));

    if (p.kind === "pdf" || p.kind === "image") {
      let src = p.url;
      if (!src) {
        try { src = blobUrl(await fetchBlob(p.content_path)); } catch (e) { return fail(`Could not load this file (${e.message}).`, p); }
      }
      if (p.kind === "pdf") {
        body.innerHTML = `<iframe title="${escapeHtml(name)}" src="${src}"></iframe>`;
        const fr = body.querySelector("iframe");
        enable("print", () => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (_) { openUrl(src); } });
      } else {
        body.innerHTML = `<img alt="${escapeHtml(name)}" src="${src}">`;
        enable("print", () => {
          const w = window.open("", "_blank");
          if (!w) return;
          w.document.write(`<title>${escapeHtml(name)}</title><img src="${src}" style="max-width:100%" onload="window.print()">`);
          w.document.close();
        });
      }
      enable("tab", () => openUrl(src));
    } else if (p.kind === "video") {
      body.innerHTML = `<video controls preload="metadata" src="${escapeHtml(p.url)}"></video>`;
      enable("tab", () => openUrl(p.url));
    } else if (p.kind === "html") {
      body.innerHTML = `<iframe title="${escapeHtml(name)}" sandbox="allow-same-origin allow-modals allow-popups allow-popups-to-escape-sandbox"></iframe>`;
      const fr = body.querySelector("iframe");
      fr.srcdoc = p.html;
      enable("print", () => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (_) {} });
      enable("tab", () => openUrl(blobUrl(new Blob([wrapPage(name, p.html)], { type: "text/html" }))));
      if (p.open_url) $(".dv-sub").insertAdjacentHTML("beforeend", ` · <a href="${escapeHtml(p.open_url)}" target="_blank" rel="noopener" style="color:#1d4ed8">open in Google Sheets</a>`);
    } else if (p.kind === "drive") {
      body.innerHTML = `<iframe title="${escapeHtml(name)}" src="${escapeHtml(p.embed_url)}" allow="autoplay"></iframe>`;
      enable("tab", () => openUrl(p.open_url || p.embed_url));
      enable("print", () => openUrl(p.open_url || p.embed_url));
    } else {
      fail(p.reason || "This file type can't be previewed in the app.", p);
    }
  })();
  return { close };
}
