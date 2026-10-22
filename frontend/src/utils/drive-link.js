// Drive holding-area modal: link an unmatched Google Drive folder to a project
// or Pipeline quote (its already-copied files move there, no re-upload), or
// ignore it. Backed by /api/drive-docs (backend/app/gsync/docs_routes.py).
//
//   import { openDriveLinkModal } from "../utils/drive-link.js";
//   const res = await openDriveLinkModal(item.ref);   // ref from review_docs items
//   // res = { action: "linked", link, label, moved } | { action: "ignored" } | { action: null }
//
// itemRef may be the Data Review item's ref ({ drive_unmatched_id, ... }) or a
// plain holding-area id. Styling: real CSS (.dlm-*) appended to BOTH
// styles.css and output.css.
import { api } from "../api.js";
import { escapeHtml } from "./html.js";

const KIND = {
  no_number: "No job number in the folder name",
  number_unmatched: "Job # matches no project or quote",
  estimate_only: "Matches only a QuickBooks estimate",
  outside_project: "Files outside any project folder",
  ambiguous: "Job # matches several projects or quotes",
};

function fmtBytes(n) {
  n = Number(n || 0);
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

const post = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
});

export function openDriveLinkModal(itemRef) {
  const id = typeof itemRef === "object" && itemRef ? itemRef.drive_unmatched_id : itemRef;
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "dlm-backdrop";
    wrap.innerHTML = `<div class="dlm-modal" role="dialog" aria-modal="true" aria-label="Link Drive folder">
      <div class="dlm-body"><div class="dlm-muted">Loading…</div></div></div>`;
    document.body.appendChild(wrap);
    let result = { action: null };
    let target = null;          // { type: 'project'|'opportunity', id, label }
    const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); resolve(result); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
    const body = wrap.querySelector(".dlm-body");

    api(`/drive-docs/unmatched/${encodeURIComponent(id)}`).then(({ folder, files }) => {
      const sug = folder.suggestion || {};
      const chips = [];
      (sug.candidates || []).forEach((c) => chips.push({ type: c.type, id: c.id, label: c.label }));
      const ests = sug.estimates || [];
      const estNote = ests.length
        ? `<div class="dlm-note">QuickBooks estimate${ests.length > 1 ? "s" : ""}: ${ests.map((e) =>
            `#${escapeHtml(e.doc_number)} (${escapeHtml(e.customer || "no customer")})`).join(", ")}. If it was won,
            find its project or quote below.</div>` : "";
      const guess = folder.guessed_job ? folder.guessed_job.split(",")[0] : "";
      const fileRows = files.slice(0, 300).map((f) => `
        <div class="dlm-file">
          <div class="dlm-file-name" title="${escapeHtml(f.drive_path || f.filename)}">${escapeHtml(f.drive_path || f.filename)}</div>
          <div class="dlm-file-size">${f.link_only ? "link" : fmtBytes(f.size_bytes)}</div>
          <button type="button" class="dlm-link" data-open="${f.id}">Open</button>
        </div>`).join("");
      const locked = folder.status === "linked";
      body.innerHTML = `
        <div class="dlm-head">
          <div>
            <div class="dlm-title">${escapeHtml(folder.folder_name || folder.path)}</div>
            <div class="dlm-path">${escapeHtml(folder.path)}</div>
          </div>
          <button type="button" class="dlm-x" data-close aria-label="Close">×</button>
        </div>
        <div class="dlm-meta">
          <span class="dlm-pill">${escapeHtml(KIND[folder.kind] || folder.kind)}</span>
          <span>${folder.file_count} file${folder.file_count === 1 ? "" : "s"} · ${fmtBytes(folder.total_bytes)} in the holding area</span>
          ${folder.drive_url ? `<a class="dlm-link" href="${escapeHtml(folder.drive_url)}" target="_blank" rel="noopener">Open in Google Drive</a>` : ""}
        </div>
        ${locked ? `<div class="dlm-note">Linked to ${escapeHtml(folder.linked_entity_type)} ${escapeHtml(folder.linked_entity_id)}
            by ${escapeHtml(folder.linked_by_email || "")}.</div>` : `
        ${estNote}
        <div class="dlm-section">Link to a project or quote</div>
        ${chips.length ? `<div class="dlm-chips">${chips.map((c, i) =>
          `<button type="button" class="dlm-chip" data-chip="${i}">${escapeHtml(c.type === "project" ? "Project" : "Quote")}: ${escapeHtml(c.label)}</button>`).join("")}</div>` : ""}
        <input class="dlm-input" type="search" placeholder="Search job #, quote # or name" value="${escapeHtml(guess)}" />
        <div class="dlm-results"></div>
        <div class="dlm-picked"></div>`}
        <div class="dlm-section">Files (${files.length}${files.length > 300 ? ", first 300 shown" : ""})</div>
        <div class="dlm-files">${fileRows || `<div class="dlm-muted">No files copied yet.</div>`}</div>
        <div class="dlm-foot">
          <span class="dlm-err"></span>
          ${locked ? "" : folder.status === "ignored"
            ? `<button type="button" class="dlm-btn" data-reopen>Re-open</button>`
            : `<button type="button" class="dlm-btn" data-ignore>Ignore</button>`}
          <button type="button" class="dlm-btn" data-close>Close</button>
          ${locked ? "" : `<button type="button" class="dlm-btn dlm-primary" data-link disabled>Link folder</button>`}
        </div>`;

      const err = body.querySelector(".dlm-err");
      const picked = body.querySelector(".dlm-picked");
      const linkBtn = body.querySelector("[data-link]");
      const pick = (t) => {
        target = t;
        if (picked) picked.innerHTML = t ? `Will link to <b>${escapeHtml(t.type === "project" ? "project" : "quote")}</b> ${escapeHtml(t.label)}` : "";
        if (linkBtn) linkBtn.disabled = !t;
      };
      const input = body.querySelector(".dlm-input");
      const results = body.querySelector(".dlm-results");
      let timer = null, seq = 0;
      const search = async () => {
        const q = (input.value || "").trim();
        if (q.length < 2) { results.innerHTML = ""; return; }
        const my = ++seq;
        try {
          const r = await api(`/drive-docs/targets?q=${encodeURIComponent(q)}`);
          if (my !== seq) return;
          const opts = [
            ...r.projects.map((p) => ({ type: "project", id: p.qbo_id, label: p.display_name, sub: "QuickBooks project" })),
            ...r.opportunities.map((o) => ({ type: "opportunity", id: o.id,
              label: `#${o.quote_number || "—"} ${o.title || ""}`.trim(),
              sub: `${o.customer || ""} · ${o.status || ""}${o.project_qbo_id ? " · linked to a project" : ""}` })),
          ];
          results._opts = opts;
          results.innerHTML = opts.length ? opts.map((o, i) => `
            <button type="button" class="dlm-opt" data-opt="${i}">
              <span class="dlm-opt-type">${o.type === "project" ? "Project" : "Quote"}</span>
              <span class="dlm-opt-label">${escapeHtml(o.label)}</span>
              <span class="dlm-opt-sub">${escapeHtml(o.sub)}</span>
            </button>`).join("") : `<div class="dlm-muted">No matches.</div>`;
        } catch (e) { results.innerHTML = `<div class="dlm-muted">Search failed: ${escapeHtml(e.message || "")}</div>`; }
      };
      if (input) {
        input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 250); });
        if (guess) search();
      }

      body.addEventListener("click", async (e) => {
        if (e.target.closest("[data-close]")) { close(); return; }
        const chip = e.target.closest("[data-chip]");
        if (chip) { pick(chips[Number(chip.dataset.chip)]); return; }
        const opt = e.target.closest("[data-opt]");
        if (opt) { pick(results._opts[Number(opt.dataset.opt)]); return; }
        const open = e.target.closest("[data-open]");
        if (open) {
          try { const r = await api(`/documents/file/${open.dataset.open}/url`); if (r.url) window.open(r.url, "_blank"); }
          catch (x) { err.textContent = x.message || "Could not open"; }
          return;
        }
        const busy = (b) => body.querySelectorAll(".dlm-foot .dlm-btn").forEach((x) => { x.disabled = b || (x === linkBtn && !target); });
        try {
          if (e.target.closest("[data-link]") && target) {
            busy(true);
            const r = await post(`/drive-docs/unmatched/${encodeURIComponent(id)}/link`,
              target.type === "project" ? { project_qbo_id: String(target.id) } : { opportunity_id: Number(target.id) });
            result = { action: "linked", ...r };
            close();
          } else if (e.target.closest("[data-ignore]")) {
            busy(true);
            await post(`/drive-docs/unmatched/${encodeURIComponent(id)}/ignore`);
            result = { action: "ignored" };
            close();
          } else if (e.target.closest("[data-reopen]")) {
            busy(true);
            await post(`/drive-docs/unmatched/${encodeURIComponent(id)}/reopen`);
            result = { action: "reopened" };
            close();
          }
        } catch (x) { err.textContent = x.message || "Failed"; busy(false); }
      });
    }).catch((e) => {
      body.innerHTML = `<div class="dlm-head"><div class="dlm-title">Drive folder</div><button type="button" class="dlm-x" data-close>×</button></div>
        <div class="dlm-err">Could not load: ${escapeHtml(e.message || String(e))}</div>`;
      body.querySelector("[data-close]").addEventListener("click", close);
    });
  });
}

/** Small "From Google Drive" line for a documents-tree file row. */
export function driveSourceHtml(f) {
  if (!f || !f.from_drive) return "";
  const dir = (f.drive_path || "").split("/").slice(0, -1);
  const short = dir.length > 2 ? "…/" + dir.slice(-2).join("/") : dir.join("/");
  return `<span class="dlm-src" title="${escapeHtml(f.drive_path || "")}">From Google Drive${short ? " · " + escapeHtml(short) : ""}${f.link_only ? " · link only" : ""}</span>`;
}
