// The financial audit export: pick status, PM, crew and a completion date range,
// see how many projects that selects, download the workbook. Opened from
// Financials, Contractor Payments and Progress Checks.
//
//   import { openFinancialExport } from "../utils/financial-export.js";
//   openFinancialExport({ crew: "MTY" });
import { api, getToken } from "../api.js";
import { escapeHtml } from "./html.js";

export async function openFinancialExport(preset = {}) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:fixed;inset:0;z-index:70;background:rgba(15,23,33,.4);display:flex;align-items:center;justify-content:center;padding:16px";
  wrap.innerHTML = `<div class="card p-5" role="dialog" aria-modal="true" aria-label="Export financials" style="width:min(560px,100%);max-height:92vh;overflow:auto">
    <div class="text-sm text-black/45">Loading…</div></div>`;
  document.body.appendChild(wrap);
  const box = wrap.firstElementChild;
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });

  let opt;
  try { opt = await api("/reports/financials/options"); }
  catch (e) { box.innerHTML = `<div class="text-sm text-red-700">Couldn't load the export: ${escapeHtml(e?.message || String(e))}</div>`; return; }

  const options = (items, sel) => items.map((v) => `<option value="${escapeHtml(v)}"${v === sel ? " selected" : ""}>${escapeHtml(v)}</option>`).join("");
  box.innerHTML = `
    <h2 class="text-base font-bold">Export financials to Excel</h2>
    <p class="text-sm text-black/60 mt-1">One workbook with tabs for the summary, cost buckets, every QuickBooks line, crew payments, open issues and expense timing. Each tab can be sorted and filtered in Excel.</p>
    <form class="grid gap-3 mt-4">
      <fieldset><legend class="text-xs text-black/55 mb-1">Status</legend><div class="flex flex-wrap gap-3 text-sm">
        ${opt.states.map(([k, l]) => `<label class="inline-flex items-center gap-1.5"><input type="checkbox" name="status" value="${k}" ${(preset.status || ["finished"]).includes(k) ? "checked" : ""}>${escapeHtml(l)}</label>`).join("")}
      </div></fieldset>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
        <label class="text-xs grid gap-1"><span class="text-black/55">PM</span><select name="pm" class="input"><option value="">All PMs</option>${options(opt.pms, preset.pm)}</select></label>
        <label class="text-xs grid gap-1"><span class="text-black/55">Crew</span><select name="crew" class="input"><option value="">All crews</option>${options(opt.crews, preset.crew)}</select></label>
      </div>
      <label class="text-xs grid gap-1"><span class="text-black/55">Filter dates on</span><select name="date_field" class="input">${opt.date_fields.map(([k, l]) => `<option value="${k}">${escapeHtml(l)}</option>`).join("")}</select></label>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
        <label class="text-xs grid gap-1"><span class="text-black/55">From</span><input type="date" name="date_from" class="input"></label>
        <label class="text-xs grid gap-1"><span class="text-black/55">To</span><input type="date" name="date_to" class="input"></label>
      </div>
      <p class="text-xs text-black/50">OPI has no official completion date. The best date is the crew's Project Completion Form when there is one, otherwise the last scheduled day. Every date is in the workbook, and jobs where they disagree by 30 days or more are flagged.</p>
      <div data-preview class="text-sm font-semibold" aria-live="polite"></div>
      <div data-err class="text-sm text-red-700"></div>
      <div class="flex gap-2 justify-end">
        <button type="button" class="btn-ghost text-sm" data-close>Cancel</button>
        <button type="submit" class="btn-primary text-sm">Download Excel</button>
      </div>
    </form>`;
  const form = box.querySelector("form");
  const qs = () => {
    const p = new URLSearchParams();
    const f = new FormData(form);
    for (const [k, v] of f.entries()) if (v) p.append(k, v);
    return p.toString();
  };
  let seq = 0;
  async function preview() {
    const n = ++seq;
    const el = box.querySelector("[data-preview]");
    el.textContent = "Counting…";
    try {
      const r = await api(`/reports/financials/preview?${qs()}`);
      if (n === seq) el.textContent = `${r.projects.toLocaleString()} projects · $${Math.round(r.contract).toLocaleString()} contract value${r.flagged_dates ? ` · ${r.flagged_dates} with completion dates that disagree` : ""}`;
    } catch (e) { if (n === seq) el.textContent = ""; }
  }
  form.addEventListener("change", preview);
  box.querySelector("[data-close]").addEventListener("click", close);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector("[type=submit]");
    const err = box.querySelector("[data-err]");
    err.textContent = "";
    btn.disabled = true; btn.textContent = "Building…";
    try {
      const res = await fetch(`/api/reports/financials.xlsx?${qs()}`, { headers: { Authorization: "Bearer " + getToken() } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || "OPI Financial Audit.xlsx";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await res.blob()); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      close();
    } catch (e) {
      err.textContent = `The export failed: ${e?.message || e}. Try fewer projects or try again.`;
      btn.disabled = false; btn.textContent = "Download Excel";
    }
  });
  preview();
}
