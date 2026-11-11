// Staff page for the customer portal (#/customer-portal): give a customer or
// dealer a private link to their projects, see who has one and when they last
// used it, and revoke links. The link is shown once, when it's made.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml as esc } from "../utils/html.js";
import { chip, C, day } from "../utils/ui.js";
import { toast } from "../utils/help.js";

export async function customerPortalAdminPage(routeFn) {
  setShell({
    title: "Customer Portal",
    subtitle: "Give a customer a private link to their projects: status and dates, invoices and balances, documents, and change orders to approve.",
    bodyHtml: `<div id="cpaRoot"><div class="card p-6 text-sm text-black/45">Loading…</div></div>`, routeFn,
  });
  const root = document.getElementById("cpaRoot");
  let picked = null;

  async function render(newLink = null) {
    const d = await api("/customer-portal/access");
    root.innerHTML = `
      <div class="grid gap-3 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] items-start">
        <section class="card p-4">
          <div class="font-extrabold text-ink-900 mb-2">New link</div>
          <label class="text-xs text-black/55">Customer or dealer</label>
          <input id="cpaQ" class="input mt-1" placeholder="Search customers" autocomplete="off">
          <div id="cpaHits" class="grid gap-1 mt-1"></div>
          <div id="cpaPicked" class="text-sm mt-2"></div>
          <label class="text-xs text-black/55 block mt-3">Who it's for</label>
          <input id="cpaName" class="input mt-1" placeholder="Name, e.g. Pat Smith">
          <input id="cpaEmail" class="input mt-2" placeholder="Email (optional)">
          <label class="text-xs text-black/55 block mt-3">Link works for</label>
          <select id="cpaDays" class="input mt-1"><option value="90">90 days</option><option value="365" selected>1 year</option><option value="730">2 years</option></select>
          <button type="button" class="btn-primary w-full mt-3" id="cpaMake">Create link</button>
          <div class="text-xs text-black/45 mt-2">${d.email_configured ? "With an email, the link is also emailed to them." : "Email isn't set up yet: copy the link and send it yourself."} Anyone with the link sees this customer's projects, so send it only to them.</div>
          ${newLink ? `<div class="mt-3 rounded-xl bg-emerald-50 border border-emerald-200 p-3"><div class="text-xs font-bold text-emerald-800 mb-1">Link created. Copy it now; it isn't shown again.</div>
            <div class="flex gap-2"><input class="input text-xs" readonly value="${esc(newLink)}" id="cpaLink"><button type="button" class="pd-btn" id="cpaCopy">Copy</button></div></div>` : ""}
        </section>
        <section class="card overflow-hidden">
          <div class="px-4 py-3 font-extrabold text-ink-900 border-b border-black/5">Links (${d.items.filter((x) => x.active).length} active)</div>
          ${d.items.length ? d.items.map((a) => `
            <div class="px-4 py-3 border-t border-black/[0.05] flex flex-wrap items-center gap-3">
              <div class="min-w-0 flex-1"><div class="font-semibold text-ink-900">${esc(a.customer || a.customer_qbo_id)} ${a.active ? chip("Active", C.good) : chip("Revoked", C.quiet)}</div>
                <div class="text-xs text-black/55">${esc([a.name, a.email].filter(Boolean).join(" · ") || "No name")} · made ${day(a.created_at)} by ${esc(a.created_by || "")}</div>
                <div class="text-xs text-black/45">${a.last_used_at ? `Last opened ${day(a.last_used_at)}` : "Not opened yet"}${a.expires_at ? ` · works until ${day(a.expires_at)}` : ""}</div></div>
              ${a.active ? `<button type="button" class="pd-btn !text-rose-700" data-revoke="${a.id}">Revoke</button>` : ""}
            </div>`).join("") : `<div class="p-6 text-sm text-black/50">No links yet.</div>`}
        </section>
      </div>`;
    const q = root.querySelector("#cpaQ"), hits = root.querySelector("#cpaHits");
    let t;
    q.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        if (q.value.trim().length < 2) { hits.innerHTML = ""; return; }
        const r = await api(`/customer-portal/customers?q=${encodeURIComponent(q.value.trim())}`);
        hits.innerHTML = r.items.map((c) => `<button type="button" class="text-left text-sm px-2 py-1.5 rounded-lg hover:bg-slate-100" data-c="${esc(c.qbo_id)}" data-n="${esc(c.display_name)}">${esc(c.display_name)} <span class="text-black/45">· ${c.projects} projects</span></button>`).join("") || `<div class="text-xs text-black/45 px-2">No customer with projects matches.</div>`;
        hits.querySelectorAll("[data-c]").forEach((b) => b.addEventListener("click", () => {
          picked = { id: b.dataset.c, name: b.dataset.n };
          root.querySelector("#cpaPicked").innerHTML = `Customer: <b>${esc(picked.name)}</b>`;
          hits.innerHTML = ""; q.value = "";
        }));
      }, 250);
    });
    root.querySelector("#cpaMake").addEventListener("click", async () => {
      if (!picked) { toast("Pick a customer first."); return; }
      const r = await api("/customer-portal/access", { method: "POST", body: JSON.stringify({
        customer_qbo_id: picked.id, name: root.querySelector("#cpaName").value, email: root.querySelector("#cpaEmail").value,
        days: +root.querySelector("#cpaDays").value }) });
      picked = null;
      render(r.link);
      if (r.emailed) toast("Link created and emailed.");
    });
    root.querySelector("#cpaCopy")?.addEventListener("click", async () => {
      const v = root.querySelector("#cpaLink").value;
      try { await navigator.clipboard.writeText(v); toast("Link copied."); } catch (_) { root.querySelector("#cpaLink").select(); }
    });
    root.querySelectorAll("[data-revoke]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Revoke this link? It stops working at once.")) return;
      await api(`/customer-portal/access/${b.dataset.revoke}/revoke`, { method: "POST" });
      render();
    }));
  }
  render();
}
