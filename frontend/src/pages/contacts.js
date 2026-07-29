// Contacts — app-owned people under a customer company. Two surfaces:
//   • contactsPage(routeFn)                     global sortable/filterable Contacts page (#/contacts)
//   • openContactsModal(customerQboId, name)    per-customer manager (Customers page drill-down)
// Also exports customerCombobox() + contactFormModal reused by the Pipeline intake + estimate flow.
//
// Contacts are soft-deleted (deactivated) by default so historical customer/contact
// analysis stays intact; a hard Delete remains for genuine mistakes.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

const dash = (s) => (s == null || s === "" ? "—" : s);
const CANCEL_BTN = "rounded-lg bg-slate-100 text-slate-700 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200";
const primaryBadge = ` <span class="inline-flex rounded-full bg-blue-100 text-blue-700 px-1.5 py-0.5 text-[9px] font-bold align-middle">PRIMARY</span>`;
const statusPill = (c) => c.active
  ? `<span class="inline-flex rounded-full bg-emerald-50 text-emerald-700 px-2 py-0.5 text-[10px] font-semibold">Active</span>`
  : `<span class="inline-flex rounded-full bg-black/10 text-black/50 px-2 py-0.5 text-[10px] font-semibold">Inactive</span>`;

// ── reusable searchable customer combobox ───────────────────────────────────
export function customerCombobox(host, { onPick, placeholder = "Search customer…", initial = null }) {
  let picked = initial;
  host.innerHTML = `
    <div class="relative">
      <input type="text" class="input text-sm py-1.5 w-full" placeholder="${escapeHtml(placeholder)}"
             value="${picked ? escapeHtml(picked.name) : ""}" autocomplete="off" data-cc-input>
      <div class="absolute z-20 mt-1 w-full bg-white border border-black/10 rounded-xl shadow-lg max-h-56 overflow-auto hidden" data-cc-menu></div>
    </div>`;
  const input = host.querySelector("[data-cc-input]");
  const menu = host.querySelector("[data-cc-menu]");
  let timer = null;
  const close = () => menu.classList.add("hidden");
  const search = async (q) => {
    try {
      const d = await api(`/contacts/customer-options?q=${encodeURIComponent(q)}&limit=200`);
      const list = d.customers || [];
      menu.innerHTML = list.length
        ? list.map(c => `<div class="px-3 py-1.5 text-sm text-ink-900 hover:bg-blue-50 cursor-pointer" data-qbo="${escapeHtml(c.qbo_id)}">${escapeHtml(c.name)}</div>`).join("")
        : `<div class="px-3 py-1.5 text-xs text-black/40">No matches</div>`;
      menu.classList.remove("hidden");
      menu.querySelectorAll("[data-qbo]").forEach(el => el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        picked = { qbo_id: el.getAttribute("data-qbo"), name: el.textContent };
        input.value = picked.name; close(); onPick && onPick(picked);
      }));
    } catch (_) { /* ignore */ }
  };
  input.addEventListener("input", () => {
    picked = null; onPick && onPick(null);
    clearTimeout(timer); timer = setTimeout(() => search(input.value.trim()), 180);
  });
  input.addEventListener("focus", () => search(input.value.trim()));
  document.addEventListener("click", (e) => { if (!host.contains(e.target)) close(); });
  return { get: () => picked, clear: () => { picked = null; input.value = ""; } };
}

// ── contact add/edit modal ──────────────────────────────────────────────────
export function contactFormModal({ customer, contact, onSaved }) {
  const editing = !!contact;
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4";
  overlay.innerHTML = `
    <div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
      <div class="text-base font-bold text-ink-900 mb-3">${editing ? "Edit contact" : "New contact"}</div>
      <div class="space-y-3">
        ${customer ? `<div class="text-xs text-black/50">Customer: <span class="font-semibold text-ink-900">${escapeHtml(customer.name)}</span></div>`
                   : `<label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Customer</div><div data-cust></div></label>`}
        <div class="grid grid-cols-2 gap-2">
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">First name</div><input data-f="first_name" class="input text-sm py-1.5 w-full" value="${escapeHtml(contact?.first_name || "")}"></label>
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Last name</div><input data-f="last_name" class="input text-sm py-1.5 w-full" value="${escapeHtml(contact?.last_name || "")}"></label>
        </div>
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Title</div><input data-f="title" class="input text-sm py-1.5 w-full" value="${escapeHtml(contact?.title || "")}" placeholder="e.g. Purchasing"></label>
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Email</div><input data-f="email" type="email" class="input text-sm py-1.5 w-full" value="${escapeHtml(contact?.email || "")}"></label>
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Phone</div><input data-f="phone" class="input text-sm py-1.5 w-full" value="${escapeHtml(contact?.phone || "")}"></label>
        <label class="flex items-center gap-2 text-sm text-black/70"><input type="checkbox" data-f="is_primary" class="h-4 w-4 rounded border-black/25" ${contact?.is_primary ? "checked" : ""}> Primary contact</label>
      </div>
      <div class="mt-4 flex items-center justify-end gap-2">
        <span data-msg class="text-xs font-semibold mr-auto"></span>
        <button data-cancel class="${CANCEL_BTN}">Cancel</button>
        <button data-save class="btn-primary text-sm px-4 py-1.5">${editing ? "Save" : "Create"}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("[data-cancel]").addEventListener("click", close);

  let picker = null;
  if (!customer) picker = customerCombobox(overlay.querySelector("[data-cust]"), { onPick: () => {} });
  const val = (f) => overlay.querySelector(`[data-f="${f}"]`);
  const setMsg = (t, ok) => { const m = overlay.querySelector("[data-msg]"); m.textContent = t; m.className = "text-xs font-semibold mr-auto " + (ok ? "text-emerald-700" : "text-red-600"); };
  overlay.querySelector("[data-save]").addEventListener("click", async () => {
    const cust = customer || (picker && picker.get());
    if (!cust) return setMsg("Pick a customer.", false);
    const payload = {
      first_name: val("first_name").value.trim() || null, last_name: val("last_name").value.trim() || null,
      title: val("title").value.trim() || null, email: val("email").value.trim() || null,
      phone: val("phone").value.trim() || null, is_primary: val("is_primary").checked,
    };
    try {
      const saved = editing
        ? (await api(`/contacts/${contact.id}`, { method: "PATCH", body: JSON.stringify(payload) })).contact
        : (await api(`/contacts`, { method: "POST", body: JSON.stringify({ ...payload, customer_qbo_id: cust.qbo_id }) })).contact;
      close(); onSaved && onSaved(saved);
    } catch (err) { let d = err?.message || "Could not save"; try { const o = JSON.parse(d); if (o.detail) d = o.detail; } catch (_) {} setMsg(d, false); }
  });
  setTimeout(() => val("first_name")?.focus(), 30);
}

async function setActive(id, active) { await api(`/contacts/${id}`, { method: "PATCH", body: JSON.stringify({ active }) }); }
async function hardDelete(id) { await api(`/contacts/${id}`, { method: "DELETE" }); }

// ── per-customer contacts modal (Customers page drill-down) ─────────────────
export async function openContactsModal(customerQboId, customerName) {
  const overlay = document.createElement("div");
  overlay.className = "fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4";
  overlay.innerHTML = `<div class="bg-white rounded-2xl shadow-xl w-full max-w-xl p-5 max-h-[85vh] overflow-auto" data-card></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) overlay.remove(); });
  const card = overlay.querySelector("[data-card]");
  const render = async () => {
    let d;
    try { d = await api(`/contacts/customer/${encodeURIComponent(customerQboId)}`); }
    catch (e) { card.innerHTML = `<div class="text-sm text-red-700">Failed to load contacts.</div>`; return; }
    const cust = { qbo_id: customerQboId, name: d.customer?.name || customerName || "Customer" };
    card.innerHTML = `
      <div class="flex items-center justify-between mb-3">
        <div><div class="text-base font-bold text-ink-900">Contacts</div><div class="text-xs text-black/50">${escapeHtml(cust.name)}</div></div>
        <button data-close class="text-black/40 hover:text-black/70 text-xl leading-none">&times;</button>
      </div>
      ${contactRows(d.contacts)}
      <div class="mt-3"><button data-add class="btn-primary text-sm px-3 py-1.5">+ Add contact</button></div>`;
    card.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    card.querySelector("[data-add]").addEventListener("click", () => contactFormModal({ customer: cust, contact: null, onSaved: render }));
    wireRowActions(card, d.contacts, cust, render);
  };
  render();
}

function contactRows(contacts) {
  if (!contacts || !contacts.length) return `<div class="text-sm text-black/45 py-4">No contacts yet.</div>`;
  return `<div class="divide-y divide-black/5 border border-black/10 rounded-xl overflow-hidden">
    ${contacts.map(c => `
      <div class="flex items-center gap-3 px-3 py-2 hover:bg-black/[0.02] ${c.active ? "" : "opacity-60"}">
        <div class="min-w-0 flex-1">
          <div class="text-sm font-semibold text-ink-900 truncate">${escapeHtml(c.full_name || "—")}${c.is_primary ? primaryBadge : ""} ${statusPill(c)}</div>
          <div class="text-[11px] text-black/50 truncate">${escapeHtml([c.title, c.email, c.phone].filter(Boolean).join(" · ") || "—")}</div>
        </div>
        <button data-edit="${c.id}" class="text-xs text-blue-600 font-semibold hover:underline">Edit</button>
        <button data-toggle="${c.id}" data-active="${c.active ? 1 : 0}" class="text-xs font-semibold hover:underline ${c.active ? "text-amber-700" : "text-emerald-700"}">${c.active ? "Deactivate" : "Activate"}</button>
        <button data-del="${c.id}" class="text-xs text-black/35 hover:text-red-600 hover:underline">Delete</button>
      </div>`).join("")}
  </div>`;
}

function wireRowActions(root, contacts, customer, refresh) {
  root.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => {
    const c = contacts.find(x => String(x.id) === b.getAttribute("data-edit"));
    contactFormModal({ customer, contact: c, onSaved: refresh });
  }));
  root.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", async () => {
    try { await setActive(b.getAttribute("data-toggle"), b.getAttribute("data-active") !== "1"); refresh(); }
    catch (err) { alert(err.message); }
  }));
  root.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
    if (!confirm("Permanently delete this contact? (Use Deactivate to keep it for history.)")) return;
    try { await hardDelete(b.getAttribute("data-del")); refresh(); } catch (err) { alert(err.message); }
  }));
}

// ── global Contacts page (sortable / filterable; Customer first) ─────────────
export async function contactsPage(routeFn) {
  let all = [], search = "", statusFilter = "all", sortKey = "customer_name", sortDir = "asc";

  const COLS = [
    { key: "customer_name", label: "Customer", td: (c) => `<span class="font-semibold text-ink-900">${escapeHtml(dash(c.customer_name))}</span>` },
    { key: "full_name", label: "Name", td: (c) => `${escapeHtml(dash(c.full_name))}${c.is_primary ? primaryBadge : ""}` },
    { key: "title", label: "Title", td: (c) => `<span class="text-black/60">${escapeHtml(dash(c.title))}</span>` },
    { key: "email", label: "Email", td: (c) => `<span class="text-black/60">${escapeHtml(dash(c.email))}</span>` },
    { key: "phone", label: "Phone", td: (c) => `<span class="text-black/60">${escapeHtml(dash(c.phone))}</span>` },
    { key: "active", label: "Status", td: (c) => statusPill(c) },
  ];

  const body = `
    <div class="w-full">
      <div class="card p-3 flex flex-col overflow-hidden" id="cCard" style="min-height:340px;">
        <div class="flex items-center gap-2 mb-2 flex-wrap shrink-0">
          <input id="cSearch" class="input text-sm py-1.5 w-full sm:max-w-xs" placeholder="Search name, email, phone, or customer…">
          <div id="cStatusFilter" class="flex items-center gap-1"></div>
          <span id="cCount" class="text-xs text-black/40 whitespace-nowrap"></span>
          <button id="cAdd" class="btn-primary text-xs px-3 py-1.5 ml-auto whitespace-nowrap">+ Add contact</button>
        </div>
        <div id="cList" class="flex-1 overflow-auto text-sm text-black/40">Loading…</div>
      </div>
    </div>`;
  setShell({
    title: "Contacts",
    subtitle: "People under each customer — used to file estimates at the contact level. Deactivate keeps history; Delete removes permanently.",
    bodyHtml: body, showLogout: true, routeFn,
  });

  const listEl = document.getElementById("cList");
  const countEl = document.getElementById("cCount");

  // Size the card to fill the viewport so the table scrolls inside it (matches
  // the Pipeline page) rather than growing the page.
  const sizeCard = () => {
    const card = document.getElementById("cCard");
    if (!card) return;
    const top = card.getBoundingClientRect().top;
    card.style.height = Math.max(340, window.innerHeight - top - 30) + "px";
  };
  window.addEventListener("resize", sizeCard);

  const sortVal = (c, key) => key === "active" ? (c.active ? 1 : 0) : (c[key] ?? "").toString().toLowerCase();
  const visible = () => {
    let out = all.filter(c => {
      if (statusFilter === "active" && !c.active) return false;
      if (statusFilter === "inactive" && c.active) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!(`${c.full_name || ""} ${c.email || ""} ${c.phone || ""} ${c.title || ""} ${c.customer_name || ""}`).toLowerCase().includes(q)) return false;
      }
      return true;
    });
    if (sortKey) out.sort((a, b) => { const av = sortVal(a, sortKey), bv = sortVal(b, sortKey); return (av < bv ? -1 : av > bv ? 1 : 0) * (sortDir === "asc" ? 1 : -1); });
    return out;
  };

  const arrow = (k) => sortKey !== k ? "" : (sortDir === "asc" ? " ▲" : " ▼");
  const onHeaderClick = (k) => {
    if (sortKey !== k) { sortKey = k; sortDir = "asc"; }
    else if (sortDir === "asc") sortDir = "desc";
    else { sortKey = "customer_name"; sortDir = "asc"; }  // 3rd click resets
    renderList();
  };

  const renderStatusFilter = () => {
    const el = document.getElementById("cStatusFilter");
    el.innerHTML = [["all", "All"], ["active", "Active"], ["inactive", "Inactive"]].map(([k, label]) =>
      `<button data-sf="${k}" class="rounded-full px-2.5 py-1 text-xs font-semibold border ${statusFilter === k ? "bg-ink-900 text-white border-ink-900" : "border-black/15 text-black/60 hover:bg-black/5"}">${label}</button>`).join("");
    el.querySelectorAll("[data-sf]").forEach(b => b.addEventListener("click", () => { statusFilter = b.getAttribute("data-sf"); renderStatusFilter(); renderList(); }));
  };

  const renderList = () => {
    const rows = visible();
    countEl.textContent = `${rows.length} contact${rows.length === 1 ? "" : "s"}`;
    if (!rows.length) { listEl.innerHTML = `<div class="text-black/45 py-4">No contacts match.</div>`; return; }
    listEl.innerHTML = `
      <table class="w-full text-sm" style="min-width:720px;">
        <thead class="sticky top-0 z-10 bg-white text-left text-black/45"><tr class="border-b border-black/10">
          ${COLS.map(c => `<th class="py-2 pr-3 font-bold cursor-pointer select-none hover:text-black/70 bg-white" data-sort="${c.key}">${c.label}${arrow(c.key)}</th>`).join("")}
          <th class="py-2 font-bold text-right bg-white">Actions</th></tr></thead>
        <tbody>${rows.map(c => `
          <tr class="border-b border-black/5 hover:bg-black/[0.015] ${c.active ? "" : "opacity-60"}">
            ${COLS.map(col => `<td class="py-1.5 pr-3">${col.td(c)}</td>`).join("")}
            <td class="py-1.5 text-right whitespace-nowrap">
              <button data-edit="${c.id}" class="text-xs text-blue-600 font-semibold hover:underline">Edit</button>
              <button data-toggle="${c.id}" data-active="${c.active ? 1 : 0}" class="text-xs font-semibold hover:underline ml-2 ${c.active ? "text-amber-700" : "text-emerald-700"}">${c.active ? "Deactivate" : "Activate"}</button>
              <button data-del="${c.id}" class="text-xs text-black/35 hover:text-red-600 hover:underline ml-2">Delete</button></td>
          </tr>`).join("")}
        </tbody></table>`;
    listEl.querySelectorAll("[data-sort]").forEach(th => th.addEventListener("click", () => onHeaderClick(th.getAttribute("data-sort"))));
    listEl.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => {
      const c = all.find(x => String(x.id) === b.getAttribute("data-edit"));
      contactFormModal({ customer: { qbo_id: c.customer_qbo_id, name: c.customer_name }, contact: c, onSaved: load });
    }));
    listEl.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", async () => {
      try { await setActive(b.getAttribute("data-toggle"), b.getAttribute("data-active") !== "1"); load(); } catch (err) { alert(err.message); }
    }));
    listEl.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Permanently delete this contact? (Use Deactivate to keep it for history.)")) return;
      try { await hardDelete(b.getAttribute("data-del")); load(); } catch (err) { alert(err.message); }
    }));
  };

  const load = async () => {
    try { all = (await api(`/contacts?limit=2000`)).contacts || []; }
    catch (e) { listEl.innerHTML = `<div class="text-red-700">Failed to load contacts.</div>`; return; }
    renderList();
    sizeCard();
  };

  let t = null;
  document.getElementById("cSearch").addEventListener("input", (e) => { search = e.target.value.trim(); clearTimeout(t); t = setTimeout(renderList, 150); });
  document.getElementById("cAdd").addEventListener("click", () => contactFormModal({ customer: null, contact: null, onSaved: load }));
  renderStatusFilter();
  load();
  requestAnimationFrame(sizeCard);   // after first paint, once layout settles
}
