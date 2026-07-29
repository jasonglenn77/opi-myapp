// Settings — admin-only (page.settings). Two tabs:
//   Roles & Permissions — create roles + assign default capabilities (admin locked).
//   Lookup Tables       — CRUD the reference rows that drive the app's dropdowns
//                         (lookup_values), grouped by category.
import { api } from "../api.js";
import { setShell } from "../shell.js";

const CAP_LABELS = {
  "page.dashboard": "Projects (dashboard)",
  "page.financials": "Financials",
  "page.estimate": "Estimate",
  "page.schedule": "Schedule",
  "page.assignment": "Assignment",
  "page.teams": "Teams",
  "page.users": "Users",
  "page.quickbooks": "QuickBooks",
  "page.cashflow": "Cash Flow",
  "page.crew_portal": "Crew Portal",
  "page.customers": "Customers & Jobs",
  "page.settings": "Settings (roles)",
  "project.view_all": "See all projects (not just assigned)",
  "assignment.edit_any": "Edit any project's schedule",
  "assignment.edit_own": "Edit own assigned schedule items",
  "users.manage": "Manage users & permissions",
  "teams.manage": "Manage PMs & work crews",
  "qbo.sync": "Run QuickBooks syncs",
  "projects.admin_tools": "Project admin tools (refresh/reset)",
};
const capLabel = (c) => CAP_LABELS[c] || c;
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const errDetail = (e) => { let d = e?.message || "Error"; try { const o = JSON.parse(d); if (o && o.detail) d = o.detail; } catch (_) {} return d; };
const prettyCat = (c) => String(c || "").replace(/_/g, " ").replace(/\b\w/g, m => m.toUpperCase());

// Settings is now Roles only — Lookup Values + Rate Tables graduated to their
// own standalone pages under the Estimating nav (see lookupValuesPage /
// rateTablesPage below), so they no longer live as tabs here.
export async function settingsPage(routeFn) {
  setShell({
    title: "Settings",
    subtitle: "Roles & permissions — control what each role can see and do across the app.",
    bodyHtml: `<div class="w-full pb-3"><div id="setBody"></div></div>`,
    showLogout: true, routeFn,
  });
  showRoles(routeFn);
}

// Standalone reference-data pages. Both reuse showReference() but wrap it in the
// Pipeline-style shell: a header (title + description) from setShell + a card
// that flexes to fill the viewport with the content scrolling inside.
export async function lookupValuesPage(routeFn) {
  return referencePage(routeFn, "lookup", "Lookup Values",
    "The reference lists behind the app's dropdowns — pipeline statuses, communication types, environment factors, crew sizes, and more.");
}
export async function rateTablesPage(routeFn) {
  return referencePage(routeFn, "rates", "Rate Tables",
    "Productivity rates (units per day) and equipment rental rates that drive the quoting-metrics calculations.");
}

async function referencePage(routeFn, mode, title, subtitle) {
  setShell({
    title, subtitle, showLogout: true, routeFn,
    bodyHtml: `
      <div class="w-full">
        <div class="card p-3 sm:p-4 flex flex-col overflow-hidden" id="refCard" style="min-height:340px;">
          <div id="setBody" class="flex-1 overflow-auto">
            <div class="text-sm text-black/40 px-1 py-6">Loading…</div>
          </div>
        </div>
      </div>`,
  });
  // Size the card to fill the space left in the viewport (same as the Pipeline
  // table) so the page never gains its own vertical scrollbar.
  const sizeCard = () => {
    const c = document.getElementById("refCard");
    if (!c) return;
    const top = c.getBoundingClientRect().top;
    c.style.height = Math.max(340, window.innerHeight - top - 30) + "px";
  };
  window.addEventListener("resize", sizeCard);
  await showReference(mode);
  sizeCard();
  requestAnimationFrame(sizeCard);
}

// ── Roles tab ────────────────────────────────────────────────────────────────
async function showRoles(routeFn) {
  const body = document.getElementById("setBody");
  body.innerHTML = `<div class="text-sm text-black/40 px-1 py-6">Loading roles…</div>`;
  let data;
  try { data = await api("/roles"); }
  catch (e) { body.innerHTML = `<div class="card p-5 text-sm text-red-700">Failed to load roles: ${esc(errDetail(e))}</div>`; return; }
  const roles = data.roles || [];
  const allCaps = data.all_capabilities || [];
  const pageCaps = allCaps.filter(c => c.startsWith("page."));
  const actionCaps = allCaps.filter(c => !c.startsWith("page."));

  const capGrid = (role) => {
    const have = new Set(role.capabilities || []);
    const group = (title, caps) => `
      <div class="mb-2">
        <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">${title}</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
          ${caps.map(c => `
            <label class="flex items-center gap-2 text-sm ${role.is_admin ? "opacity-60" : ""}">
              <input type="checkbox" value="${esc(c)}" ${have.has(c) ? "checked" : ""} ${role.is_admin ? "disabled" : ""}
                class="h-4 w-4 rounded border-black/25" data-rolecap="${role.id}" />
              <span class="truncate">${esc(capLabel(c))}</span>
            </label>`).join("")}
        </div>
      </div>`;
    return group("Pages", pageCaps) + group("Actions", actionCaps);
  };

  const roleCard = (role) => `
    <details class="card p-0 overflow-hidden mb-3" data-role="${role.id}">
      <summary class="px-4 py-3 cursor-pointer list-none flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-base font-extrabold">${esc(role.label || role.name)}</span>
            <span class="text-[11px] font-mono text-black/40">${esc(role.name)}</span>
            ${role.is_admin ? `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-700">locked</span>`
              : role.is_system ? `<span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-black/10 text-black/50">built-in</span>` : ""}
          </div>
          <div class="text-[11px] text-black/40">${role.user_count} user${role.user_count === 1 ? "" : "s"} · ${(role.capabilities || []).length} capabilities${role.description ? " · " + esc(role.description) : ""}</div>
        </div>
        <span class="text-black/30 text-xs shrink-0">▸</span>
      </summary>
      <div class="px-4 pb-4 border-t border-black/5 pt-3">
        ${role.is_admin ? `<div class="text-xs text-amber-700 mb-3">The admin role always has every capability and can't be changed — this prevents anyone from locking themselves out.</div>` : ""}
        ${role.is_admin ? "" : `
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div><div class="label mb-1">Display name</div><input class="input" data-rolelabel="${role.id}" value="${esc(role.label || "")}" /></div>
            <div><div class="label mb-1">Description</div><input class="input" data-roledesc="${role.id}" value="${esc(role.description || "")}" /></div>
          </div>`}
        ${capGrid(role)}
        <div class="flex items-center justify-between gap-3 mt-3">
          <div>
            ${role.is_system ? "" : `<button class="rounded-lg border border-red-200 text-red-600 px-3 py-1.5 text-sm font-semibold hover:bg-red-50" data-roledelete="${role.id}">Delete role</button>`}
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[11px]" data-rolestatus="${role.id}"></span>
            ${role.is_admin ? "" : `<button class="btn-primary" data-rolesave="${role.id}">Save</button>`}
          </div>
        </div>
      </div>
    </details>`;

  body.innerHTML = `
    <div class="mx-auto max-w-4xl">
    <div class="card p-4 flex items-start justify-between gap-3 mb-3">
      <div>
        <div class="text-base font-extrabold">Roles &amp; Permissions</div>
        <div class="text-xs text-black/50">Create roles and choose which capabilities each role grants by default. Per-user exceptions are still set on the Users page.</div>
      </div>
      <button id="newRoleBtn" class="btn-primary shrink-0">New role</button>
    </div>
    ${roles.map(roleCard).join("")}
    </div>

    <div id="newRoleModal" class="fixed inset-0 hidden items-center justify-center bg-black/40 p-4" style="z-index:70;">
      <div class="card p-6 w-full max-w-lg flex flex-col" style="max-height:88vh;">
        <div class="flex items-center justify-between mb-3">
          <div class="text-lg font-extrabold">New role</div>
          <button id="nrClose" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Close</button>
        </div>
        <form id="nrForm" class="space-y-3 overflow-y-auto" style="min-height:0;">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div><div class="label mb-1">Key (lowercase)</div><input id="nrName" class="input" placeholder="e.g. viewer" /></div>
            <div><div class="label mb-1">Display name</div><input id="nrLabel" class="input" placeholder="e.g. Read-only viewer" /></div>
          </div>
          <div><div class="label mb-1">Description</div><input id="nrDesc" class="input" /></div>
          <div>
            <div class="label mb-1">Capabilities</div>
            <div class="border border-black/10 rounded-xl p-3">
              <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">Pages</div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 mb-2">
                ${pageCaps.map(c => `<label class="flex items-center gap-2 text-sm"><input type="checkbox" value="${esc(c)}" class="h-4 w-4 rounded border-black/25" data-newcap /> <span class="truncate">${esc(capLabel(c))}</span></label>`).join("")}
              </div>
              <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">Actions</div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                ${actionCaps.map(c => `<label class="flex items-center gap-2 text-sm"><input type="checkbox" value="${esc(c)}" class="h-4 w-4 rounded border-black/25" data-newcap /> <span class="truncate">${esc(capLabel(c))}</span></label>`).join("")}
              </div>
            </div>
          </div>
          <div class="text-sm text-red-700 min-h-[1.25rem]" id="nrMsg"></div>
          <div class="flex justify-end gap-2">
            <button type="button" id="nrCancel" class="rounded-xl border border-black/15 px-3 py-1.5 text-sm font-semibold text-ink-800 hover:bg-black/5">Cancel</button>
            <button type="submit" class="btn-primary">Create role</button>
          </div>
        </form>
      </div>
    </div>`;

  // ---- handlers ----
  const setStatus = (id, msg, ok) => {
    const el = document.querySelector(`[data-rolestatus="${id}"]`);
    if (!el) return;
    el.textContent = msg;
    el.className = "text-[11px] " + (ok === true ? "text-emerald-600" : ok === false ? "text-red-600" : "text-black/40");
    if (ok === true) setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 1500);
  };

  document.querySelectorAll("[data-rolesave]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.rolesave;
      const caps = [...document.querySelectorAll(`input[data-rolecap="${id}"]:checked`)].map(c => c.value);
      const label = document.querySelector(`[data-rolelabel="${id}"]`)?.value ?? "";
      const description = document.querySelector(`[data-roledesc="${id}"]`)?.value ?? "";
      setStatus(id, "Saving…");
      try {
        await api(`/roles/${id}`, { method: "PUT", body: JSON.stringify({ label, description, capabilities: caps }) });
        setStatus(id, "Saved ✓", true);
      } catch (e) { setStatus(id, errDetail(e), false); }
    });
  });

  document.querySelectorAll("[data-roledelete]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.roledelete;
      if (!confirm("Delete this role? This can't be undone.")) return;
      try { await api(`/roles/${id}`, { method: "DELETE" }); showRoles(routeFn); }
      catch (e) { setStatus(id, errDetail(e), false); }
    });
  });

  const modal = document.getElementById("newRoleModal");
  const open = () => { modal.classList.remove("hidden"); modal.classList.add("flex"); };
  const close = () => { modal.classList.add("hidden"); modal.classList.remove("flex"); };
  document.getElementById("newRoleBtn").addEventListener("click", () => {
    document.getElementById("nrName").value = "";
    document.getElementById("nrLabel").value = "";
    document.getElementById("nrDesc").value = "";
    document.getElementById("nrMsg").textContent = "";
    document.querySelectorAll("input[data-newcap]").forEach(c => { c.checked = false; });
    open();
  });
  document.getElementById("nrClose").addEventListener("click", close);
  document.getElementById("nrCancel").addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.getElementById("nrForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = document.getElementById("nrMsg");
    msg.textContent = "";
    const payload = {
      name: document.getElementById("nrName").value.trim(),
      label: document.getElementById("nrLabel").value.trim() || null,
      description: document.getElementById("nrDesc").value.trim() || null,
      capabilities: [...document.querySelectorAll("input[data-newcap]:checked")].map(c => c.value),
    };
    try { await api("/roles", { method: "POST", body: JSON.stringify(payload) }); close(); showRoles(routeFn); }
    catch (e) { msg.textContent = errDetail(e); }
  });
}

// ── Reference Data tabs ──────────────────────────────────────────────────────
// Two tabs share this view via `mode`:
//   "lookup" → lookup_values (simple key/number/text lists)
//   "rates"  → productivity_rates + rental_rates (richer quoting rate tables)
const numOrNull = (v) => { const s = String(v ?? "").trim(); if (s === "") return null; const n = Number(s); return Number.isNaN(n) ? null : n; };

async function showReference(mode) {
  const body = document.getElementById("setBody");
  body.innerHTML = `<div class="text-sm text-black/40 px-1 py-6">Loading…</div>`;
  let lookup = { categories: [] }, prod = { categories: [] }, rentals = { rows: [] };
  try {
    if (mode === "lookup") {
      lookup = await api("/quoting/lookup-values/admin");
    } else {
      [prod, rentals] = await Promise.all([
        api("/quoting/productivity-rates/admin"),
        api("/quoting/rental-rates/admin"),
      ]);
    }
  } catch (e) { body.innerHTML = `<div class="card p-5 text-sm text-red-700">Failed to load: ${esc(errDetail(e))}</div>`; return; }

  let sel = mode === "lookup"
    ? { kind: "lookup", key: lookup.categories[0]?.category || null }
    : (prod.categories[0] ? { kind: "prod", key: prod.categories[0].category } : { kind: "rental", key: "rental_rates" });

  body.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-[230px_1fr] gap-3">
      <div class="card p-2 self-start" id="refNav"></div>
      <div id="refPanel"></div>
    </div>`;

  const setMsg = (t, ok) => {
    const m = document.getElementById("refMsg");
    if (!m) return;
    m.textContent = t;
    m.className = "text-[11px] mt-2 min-h-[1rem] " + (ok ? "text-emerald-600" : "text-red-600");
    if (ok) setTimeout(() => { if (m.textContent === t) m.textContent = ""; }, 1500);
  };

  function renderNav() {
    const groups = mode === "lookup"
      ? [{ title: "Categories", kind: "lookup", items: lookup.categories.map(c => ({ key: c.category, label: prettyCat(c.category), count: c.rows.length })) }]
      : [
          { title: "Productivity rates", kind: "prod", items: prod.categories.map(c => ({ key: c.category, label: c.category, count: c.rows.length })) },
          { title: "Rentals", kind: "rental", items: [{ key: "rental_rates", label: "Rental Rates", count: rentals.rows.length }] },
        ];
    const host = document.getElementById("refNav");
    host.innerHTML = groups.map(g => `
      <div class="mb-1.5">
        <div class="px-2 pt-1.5 pb-1 text-[10px] font-bold uppercase tracking-wide text-black/35">${g.title}</div>
        ${g.items.map(it => `
          <button type="button" data-kind="${g.kind}" data-key="${esc(it.key)}" class="flex items-center justify-between gap-2 w-full text-left rounded-lg px-2 py-1.5 text-xs font-semibold ${sel.kind === g.kind && sel.key === it.key ? "bg-blue-50 text-blue-700" : "text-black/60 hover:bg-black/5"}">
            <span class="truncate">${esc(it.label)}</span>
            <span class="text-[10px] text-black/35 shrink-0">${it.count}</span>
          </button>`).join("")}
      </div>`).join("");
    host.querySelectorAll("[data-kind]").forEach(b => b.addEventListener("click", () => {
      sel = { kind: b.dataset.kind, key: b.dataset.key }; renderNav(); renderPanel();
    }));
  }

  async function reloadAll() {
    if (mode === "lookup") {
      lookup = await api("/quoting/lookup-values/admin");
    } else {
      [prod, rentals] = await Promise.all([
        api("/quoting/productivity-rates/admin"),
        api("/quoting/rental-rates/admin"),
      ]);
    }
    renderNav(); renderPanel();
  }

  // Generic editable grid. cols: {key,label,type:text|num|select|computed,w,step,options,placeholder,required}
  function renderGrid({ title, code, note, cols, rows, endpoint, createExtra }) {
    const cellInput = (c, r, attr) => {
      if (c.type === "computed") return `<span class="text-black/45 tabular-nums">${r ? esc(r[c.key] ?? "—") : "—"}</span>`;
      if (c.type === "select") return `<select ${attr}="${c.key}" class="input text-xs py-1 w-full">${c.options.map(o => `<option ${r && String(r[c.key]) === String(o) ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
      const t = c.type === "num" ? "number" : "text";
      const step = c.step ? `step="${c.step}"` : "";
      const val = r ? esc(r[c.key] ?? "") : "";
      return `<input type="${t}" ${step} ${attr}="${c.key}" class="input text-xs py-1 w-full" value="${val}" placeholder="${esc(c.placeholder || "")}">`;
    };
    const head = cols.map(c => `<th class="py-1.5 px-2 font-bold ${c.w || ""}">${esc(c.label)}</th>`).join("");
    const rowHtml = (r) => `<tr class="border-b border-black/5" data-row="${r.id}">${cols.map(c => `<td class="py-1 px-2">${cellInput(c, r, "data-f")}</td>`).join("")}
      <td class="py-1 pl-2 text-right whitespace-nowrap"><button type="button" data-save class="btn-primary text-[11px] px-2 py-1">Save</button><button type="button" data-del title="Delete" class="ml-1 rounded-lg border border-red-200 text-red-600 px-2 py-1 text-[11px] font-semibold hover:bg-red-50">✕</button></td></tr>`;
    const addHtml = `<tr class="border-t-2 border-black/10 bg-black/[0.015]" data-newrow>${cols.map(c => `<td class="py-1 px-2">${c.type === "computed" ? `<span class="text-black/30">auto</span>` : cellInput(c, null, "data-nf")}</td>`).join("")}
      <td class="py-1 pl-2 text-right"><button type="button" data-add class="btn-primary text-[11px] px-3 py-1">Add</button></td></tr>`;

    document.getElementById("refPanel").innerHTML = `
      <div class="card p-4">
        <div class="text-base font-extrabold">${esc(title)}</div>
        ${code ? `<div class="text-[11px] font-mono text-black/40">${esc(code)}</div>` : ""}
        ${note ? `<div class="text-[11px] text-black/45 mt-2 mb-3">${note}</div>` : `<div class="mb-3"></div>`}
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead><tr class="text-black/45 text-left border-b border-black/10">${head}<th class="w-28"></th></tr></thead>
            <tbody>${rows.map(rowHtml).join("")}${addHtml}</tbody>
          </table>
        </div>
        <div id="refMsg" class="text-[11px] mt-2 min-h-[1rem]"></div>
      </div>`;

    const collect = (scope, attr) => {
      const o = {};
      cols.forEach(c => {
        if (c.type === "computed") return;
        const el = scope.querySelector(`[${attr}="${c.key}"]`);
        if (!el) return;
        o[c.key] = c.type === "num" ? numOrNull(el.value) : (el.value ?? "").trim();
        if (c.type === "text" && !c.required && o[c.key] === "") o[c.key] = null;
      });
      return o;
    };
    const missingRequired = (payload) => cols.some(c => c.required && !String(payload[c.key] ?? "").trim());

    const panel = document.getElementById("refPanel");
    panel.querySelectorAll("[data-row]").forEach(tr => {
      const id = tr.dataset.row;
      tr.querySelector("[data-save]").addEventListener("click", async () => {
        const b = collect(tr, "data-f");
        if (missingRequired(b)) { setMsg("Please fill the required fields.", false); return; }
        try { await api(`${endpoint}/${id}`, { method: "PATCH", body: JSON.stringify(b) }); setMsg("Saved ✓", true); await reloadAll(); }
        catch (e) { setMsg(errDetail(e), false); }
      });
      tr.querySelector("[data-del]").addEventListener("click", async () => {
        if (!confirm("Delete this row?")) return;
        try { await api(`${endpoint}/${id}`, { method: "DELETE" }); await reloadAll(); }
        catch (e) { setMsg(errDetail(e), false); }
      });
    });
    const nr = panel.querySelector("[data-newrow]");
    nr.querySelector("[data-add]").addEventListener("click", async () => {
      const b = { ...collect(nr, "data-nf"), ...(createExtra || {}) };
      if (missingRequired(b)) { setMsg("Please fill the required fields to add a row.", false); return; }
      try { await api(endpoint, { method: "POST", body: JSON.stringify(b) }); await reloadAll(); }
      catch (e) { setMsg(errDetail(e), false); }
    });
  }

  function renderPanel() {
    if (sel.kind === "lookup") {
      const cat = lookup.categories.find(c => c.category === sel.key);
      if (!cat) return;
      renderGrid({
        title: prettyCat(cat.category), code: cat.category,
        note: `<span class="font-semibold">Key</span> = the label shown in the dropdown · <span class="font-semibold">Number</span> / <span class="font-semibold">Text</span> = optional values used by calculations · <span class="font-semibold">Order</span> = list position. Renaming a key may affect features that reference it by name.`,
        cols: [
          { key: "lookup_key", label: "Key", type: "text", required: true },
          { key: "value_num", label: "Number", type: "num", step: "any", w: "w-28" },
          { key: "value_text", label: "Text", type: "text" },
          { key: "sort_order", label: "Order", type: "num", w: "w-20" },
        ],
        rows: cat.rows, endpoint: "/quoting/lookup-values", createExtra: { category: cat.category },
      });
    } else if (sel.kind === "prod") {
      const cat = prod.categories.find(c => c.category === sel.key);
      if (!cat) return;
      renderGrid({
        title: cat.category, code: "productivity_rates",
        note: `Install productivity per crew-day. <span class="font-semibold">Aggressive/day</span> is auto-calculated from Standard × Multiplier.`,
        cols: [
          { key: "item_name", label: "Item", type: "text", required: true },
          { key: "standard_per_day", label: "Std / day", type: "num", w: "w-24" },
          { key: "aggressive_multiplier", label: "Aggr. ×", type: "num", step: "any", w: "w-20" },
          { key: "aggressive_per_day", label: "Aggr. / day", type: "computed", w: "w-20" },
          { key: "unit", label: "Unit", type: "text", w: "w-20" },
          { key: "sort_order", label: "Order", type: "num", w: "w-16" },
        ],
        rows: cat.rows, endpoint: "/quoting/productivity-rates", createExtra: { category: cat.category },
      });
    } else {
      renderGrid({
        title: "Rental Rates", code: "rental_rates",
        note: `Equipment rental pricing by power source, size class and duration.`,
        cols: [
          { key: "equipment_type", label: "Equipment", type: "text", required: true },
          { key: "power_source", label: "Power", type: "text" },
          { key: "size_class", label: "Size class", type: "text" },
          { key: "duration", label: "Duration", type: "select", options: ["day", "week", "month"], w: "w-24" },
          { key: "price", label: "Price", type: "num", step: "any", w: "w-24" },
        ],
        rows: rentals.rows, endpoint: "/quoting/rental-rates", createExtra: {},
      });
    }
  }

  renderNav();
  renderPanel();
}

