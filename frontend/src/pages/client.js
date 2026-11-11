// Customer portal (public route #/client): a customer opens the private link
// OnPoint gave them (#/client?k=<token>) and sees their projects: status and
// dates, invoices and balances, documents, and change orders to approve or
// decline. Uses its own session (localStorage opi_client_session), never a
// staff token. Backend: backend/app/custportal/routes.py.
import { showAuth, brandHeader } from "../shell.js";
import { escapeHtml as esc } from "../utils/html.js";
import { day, money0, money2 } from "../utils/ui.js";

const KEY = "opi_client_session";
const STATUS_TONE = { "In progress": "bg-emerald-50 text-emerald-800 border-emerald-200", Scheduled: "bg-sky-50 text-sky-800 border-sky-200",
  "Being scheduled": "bg-slate-50 text-slate-700 border-slate-200", "On hold": "bg-amber-50 text-amber-800 border-amber-200",
  Complete: "bg-slate-100 text-slate-700 border-slate-200" };

async function capi(path, opts = {}) {
  const t = localStorage.getItem(KEY);
  const res = await fetch(`/api/customer-portal${path}`, { ...opts, headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.detail || "Something went wrong"); e.status = res.status; throw e; }
  return body;
}

export async function clientPage() {
  showAuth();
  const root = document.getElementById("authRoot");
  root.className = "min-h-[100vh] overflow-auto px-4 py-6";
  const shell = (inner) => `<div class="max-w-3xl mx-auto"><div class="mb-5 flex items-center justify-between gap-3">${brandHeader().replace("Internal Ops Portal", "Customer Portal")}<button type="button" id="clOut" class="text-sm text-white/60 hover:text-white">Sign out</button></div>${inner}
    <div class="mt-8 text-center text-xs text-white/40">Questions? Contact your OnPoint Installers project manager. · © ${new Date().getFullYear()} OnPoint Installers</div></div>`;
  const bindOut = () => document.getElementById("clOut")?.addEventListener("click", () => { localStorage.removeItem(KEY); location.hash = "#/client"; clientPage(); });

  // A link token in the URL: trade it for a session, then drop it from the address bar.
  const k = (location.hash.match(/[?&]k=([^&]+)/) || [])[1];
  if (k) {
    try {
      const s = await capi("/login", { method: "POST", body: JSON.stringify({ token: decodeURIComponent(k) }) });
      localStorage.setItem(KEY, s.session);
    } catch (e) {
      root.innerHTML = shell(`<div class="card p-6"><div class="text-lg font-extrabold">This link doesn't work</div><div class="text-sm text-black/60 mt-1">${esc(e.message)}</div></div>`);
      return;
    }
    history.replaceState(null, "", location.pathname + "#/client");
  }
  if (!localStorage.getItem(KEY)) {
    root.innerHTML = shell(`<div class="card p-6"><div class="text-lg font-extrabold">Your projects with OnPoint Installers</div><div class="text-sm text-black/60 mt-1">Open the private link OnPoint Installers sent you to see your projects. If you don't have one, ask your project manager.</div></div>`);
    bindOut();
    return;
  }

  const m = location.hash.match(/^#\/client\/project\/([^?]+)/);
  try {
    if (m) await projectView(decodeURIComponent(m[1]));
    else await listView();
  } catch (e) {
    if (e.status === 401) { localStorage.removeItem(KEY); return clientPage(); }
    root.innerHTML = shell(`<div class="card p-6 text-sm text-rose-700">${esc(e.message)}</div>`);
  }
  bindOut();

  async function listView() {
    const d = await capi("/projects");
    const waiting = d.projects.reduce((a, p) => a + p.change_orders_waiting, 0);
    root.innerHTML = shell(`
      <div class="mb-4"><div class="text-2xl font-extrabold">${esc(d.customer)}</div><div class="text-white/60 text-sm">Your projects with OnPoint Installers</div></div>
      <div class="grid grid-cols-2 gap-3 mb-4">
        <div class="card p-4"><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">Open balance</div><div class="text-2xl font-extrabold tabular-nums">${money0(d.balance)}</div></div>
        <div class="card p-4"><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">Waiting on you</div><div class="text-2xl font-extrabold tabular-nums ${waiting ? "text-amber-700" : ""}">${waiting}</div><div class="text-xs text-black/50">change order${waiting === 1 ? "" : "s"} to approve</div></div>
      </div>
      <div class="grid gap-3">${d.projects.map((p) => `
        <a href="#/client/project/${encodeURIComponent(p.qbo_id)}" class="card p-4 block hover:shadow-lg transition-shadow">
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1"><div class="font-extrabold text-ink-900">${esc(p.name)}</div>
              <div class="text-sm text-black/60">${p.start ? `${day(p.start)} to ${day(p.end)}` : "Dates being set"}${p.pm ? ` · PM ${esc(p.pm)}` : ""}</div></div>
            <span class="text-xs font-bold border rounded-full px-2 py-0.5 ${STATUS_TONE[p.status] || STATUS_TONE["Being scheduled"]}">${esc(p.status)}</span>
          </div>
          <div class="flex flex-wrap gap-4 mt-2 text-sm text-black/70"><span>Invoiced ${money0(p.invoiced)}</span><span class="${p.balance > 0 ? "font-bold text-ink-900" : ""}">Balance ${money0(p.balance)}</span>
            ${p.change_orders_waiting ? `<span class="font-bold text-amber-700">${p.change_orders_waiting} change order${p.change_orders_waiting === 1 ? "" : "s"} to approve</span>` : ""}</div>
        </a>`).join("") || `<div class="card p-6 text-sm text-black/60">No projects yet.</div>`}</div>`);
  }

  async function projectView(id) {
    const p = await capi(`/project/${encodeURIComponent(id)}`);
    const groups = {};
    for (const d of p.documents) (groups[d.group] ||= []).push(d);
    root.innerHTML = shell(`
      <a href="#/client" class="text-sm text-white/70 hover:text-white">← All projects</a>
      <div class="mt-2 mb-4"><div class="text-2xl font-extrabold">${esc(p.name)}</div>
        <div class="text-white/60 text-sm">${esc(p.status)}${p.start ? ` · ${day(p.start)} to ${day(p.end)}` : ""}${p.pm ? ` · Project manager ${esc(p.pm)}` : ""}</div></div>
      ${p.change_orders.length ? `<section class="card p-4 mb-3"><div class="font-extrabold text-ink-900 mb-2">Change orders</div>
        <div class="grid gap-2">${p.change_orders.map((c) => `
          <div class="rounded-xl border border-black/10 p-3" data-co="${esc(c.id)}">
            <div class="flex flex-wrap items-start gap-2"><div class="min-w-0 flex-1"><div class="font-bold text-ink-900">${esc(c.title)}${c.number && !String(c.title).includes(c.number) ? ` <span class="font-normal text-black/50">#${esc(c.number)}</span>` : ""}</div>
              ${c.scope || c.reason ? `<div class="text-sm text-black/65 whitespace-pre-line">${esc(c.scope || c.reason)}</div>` : ""}
              <div class="text-xs text-black/50">${c.date ? day(c.date) : ""}</div></div>
              <div class="text-right"><div class="font-extrabold tabular-nums">${money2(c.amount)}</div>
                <div class="text-xs font-bold ${c.status === "sent" ? "text-amber-700" : c.status === "approved" ? "text-emerald-700" : "text-rose-700"}">${c.status === "sent" ? "Waiting on you" : c.status === "approved" ? "Approved" : "Declined"}</div></div></div>
            ${c.response ? `<div class="text-xs text-black/55 mt-1">${c.response.decision === "approved" ? "Approved" : "Declined"} by ${esc(c.response.by)} on ${esc(c.response.at)}${c.response.note ? `: “${esc(c.response.note)}”` : ""}</div>` : ""}
            ${c.status === "sent" ? `<div class="mt-3 grid gap-2">
              <input class="input" data-f="name" placeholder="Type your full name to sign" autocomplete="name">
              <textarea class="input text-sm" rows="2" data-f="note" placeholder="Note to OnPoint (optional)"></textarea>
              <div class="flex gap-2"><button type="button" class="btn-primary" data-d="approved">Approve</button><button type="button" class="pd-btn" data-d="declined">Decline</button></div>
              <div class="text-xs text-rose-700 min-h-[1rem]" data-err></div></div>` : ""}
          </div>`).join("")}</div></section>` : ""}
      <section class="card p-4 mb-3"><div class="font-extrabold text-ink-900 mb-2">Invoices</div>
        ${p.invoices.length ? `<div class="overflow-x-auto"><table class="w-full text-sm tabular-nums"><thead><tr class="text-left text-xs text-black/50"><th class="py-1">Invoice</th><th>Date</th><th>Due</th><th class="text-right">Amount</th><th class="text-right">Balance</th></tr></thead><tbody>
          ${p.invoices.map((i) => `<tr class="border-t border-black/[0.06]"><td class="py-2 font-semibold">#${esc(i.doc || "")}</td><td>${day(i.date)}</td><td>${day(i.due)}</td><td class="text-right">${money2(i.amount)}</td><td class="text-right ${i.balance > 0 ? "font-bold" : "text-emerald-700"}">${i.balance > 0 ? money2(i.balance) : "Paid"}</td></tr>`).join("")}
          </tbody></table></div>` : `<div class="text-sm text-black/55">No invoices yet.</div>`}</section>
      <section class="card p-4"><div class="font-extrabold text-ink-900 mb-2">Documents</div>
        ${Object.keys(groups).length ? Object.entries(groups).map(([g, list]) => `<div class="mb-2"><div class="text-xs font-bold uppercase tracking-wide text-black/45 mb-1">${esc(g)}</div>
          ${list.map((d) => `<button type="button" class="block w-full text-left text-sm font-semibold text-brand-600 hover:underline py-1" data-doc="${d.id}">${esc(d.name)}</button>`).join("")}</div>`).join("")
          : `<div class="text-sm text-black/55">No documents shared yet.</div>`}</section>`);
    root.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", async () => {
      const w = window.open("", "_blank");
      try { const r = await capi(`/file/${b.dataset.doc}`); if (w) w.location = r.url; else location.href = r.url; } catch (e) { w?.close(); alert(e.message); }
    }));
    root.querySelectorAll("[data-co] [data-d]").forEach((b) => b.addEventListener("click", async () => {
      const box = b.closest("[data-co]");
      const name = box.querySelector('[data-f="name"]').value.trim();
      const err = box.querySelector("[data-err]");
      if (name.length < 2) { err.textContent = "Type your full name to sign."; return; }
      if (b.dataset.d === "approved" && !confirm(`Approve this change order as ${name}?`)) return;
      try {
        await capi(`/change-order/${encodeURIComponent(box.dataset.co)}/respond`, { method: "POST", body: JSON.stringify({ decision: b.dataset.d, name, note: box.querySelector('[data-f="note"]').value }) });
        projectView(id);
      } catch (e) { err.textContent = e.message; }
    }));
  }
}
