// Project Billing & Schedule in a right-side panel, so a page (the Cash Flow
// forecast) can edit a project's invoices, crew payments and expenses without
// leaving. It mounts the same panel as the project workspace's Billing tab
// (pages/billing.js); every save there fires "opi:billing-changed", which the
// caller uses to refresh itself.
//
//   import { openProjectDrawer } from "../utils/project-drawer.js";
//   openProjectDrawer({ entityId, name, onChange: () => load(true), backLabel: "Cash Flow", backHash: "#/cashflow" });
import { escapeHtml } from "./html.js";
import { mountBillingPanel } from "../pages/billing.js";

const CSS = `
.pd-backdrop{position:fixed;inset:0;z-index:60;background:rgba(15,23,33,.35);display:flex;justify-content:flex-end}
.pd-panel{background:#f4f6f8;width:min(1180px,96vw);height:100%;display:flex;flex-direction:column;box-shadow:-12px 0 32px rgba(0,0,0,.28)}
.pd-head{display:flex;align-items:center;gap:10px;padding:10px 16px;background:#fff;border-bottom:1px solid #e5e8ec;flex-wrap:wrap}
.pd-title{flex:1;min-width:180px}
.pd-name{font-size:15px;font-weight:800;color:#1c2430}
.pd-sub{font-size:11.5px;color:#6b7684;margin-top:1px}
.pd-sub b{color:#0f766e}
.pd-btn{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:#1f3a5f;background:#fff;border:1px solid #d5dbe2;border-radius:8px;padding:5px 10px;cursor:pointer;text-decoration:none}
.pd-btn:hover{background:#eef2f6}
.pd-x{font-size:22px;line-height:1;color:#6b7684;background:none;border:0;cursor:pointer;padding:2px 8px;border-radius:6px}
.pd-x:hover{background:#eef2f6;color:#1c2430}
.pd-btn:focus-visible,.pd-x:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.pd-body{flex:1;min-height:0;overflow:auto;padding:14px 16px 40px}
@media (max-width:640px){.pd-panel{width:100vw}.pd-body{padding:10px 8px 40px}}
`;
(function inject() {
  if (document.getElementById("pd-css")) return;
  const s = document.createElement("style");
  s.id = "pd-css";
  s.textContent = CSS;
  document.head.appendChild(s);
})();

export function openProjectDrawer({ entityId, name, onChange, backLabel, backHash } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "pd-backdrop";
  wrap.innerHTML = `<div class="pd-panel" role="dialog" aria-modal="true" aria-label="Billing and schedule">
      <div class="pd-head">
        <div class="pd-title"><div class="pd-name">${escapeHtml(name || "Project")}</div>
          <div class="pd-sub" data-pd-sub>Billing &amp; Schedule. Changes save as you edit and update the forecast behind this panel.</div></div>
        <a class="pd-btn" data-pd-full href="#/entity/project/${encodeURIComponent(entityId)}?tab=billing" title="Open the full project workspace">Open project workspace →</a>
        <button type="button" class="pd-x" data-pd-close aria-label="Close">×</button>
      </div>
      <div class="pd-body" data-scroll-host><div data-pd-mount></div></div>
    </div>`;
  document.body.appendChild(wrap);
  const sub = wrap.querySelector("[data-pd-sub]");
  let changes = 0;

  const onSaved = (e) => {
    if (String(e.detail?.entityId) !== String(entityId)) return;
    changes += 1;
    sub.innerHTML = `Billing &amp; Schedule. <b>Saved${changes > 1 ? ` (${changes} changes)` : ""}</b>: the forecast behind this panel is updating.`;
    if (onChange) onChange();
  };
  // The panel reloads itself once when it first renders; only later reloads are edits.
  let armed = false;
  setTimeout(() => { armed = true; }, 0);
  const listener = (e) => { if (armed) onSaved(e); };

  const close = () => {
    window.removeEventListener("opi:billing-changed", listener);
    document.removeEventListener("keydown", onKey);
    wrap.remove();
    if (changes && onChange) onChange();
  };
  // Escape closes the panel unless one of the panel's own pop-ups is open on top.
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    if (document.querySelector(".dv-backdrop") || [...document.body.children].some((el) => el !== wrap && el.style?.zIndex === "100")) return;
    close();
  };
  window.addEventListener("opi:billing-changed", listener);
  document.addEventListener("keydown", onKey);
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap || e.target.closest("[data-pd-close]")) return close();
    if (e.target.closest("[data-pd-full]")) {
      try {
        if (backHash) sessionStorage.setItem("opi_entity_back", JSON.stringify({ entity: `project/${entityId}`, label: backLabel || "Back", hash: backHash }));
      } catch (_) {}
      close();
    }
  });
  wrap.querySelector("[data-pd-close]").focus();
  mountBillingPanel(wrap.querySelector("[data-pd-mount]"), entityId);
  return { close };
}
