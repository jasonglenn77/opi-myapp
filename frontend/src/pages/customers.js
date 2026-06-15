// Customers & Jobs — the "money-in" (revenue) view by customer. Each top-level
// company rolls up its projects, jobs, and directly-tagged invoices.
//
// Accuracy: invoiced / collected / open-AR come from each invoice's balance_amt
// (correct no matter where a payment was applied), NOT from Payment rows.
// Children + the "Direct" bucket always sum to the customer total.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

export async function customersPage(routeFn) {
  let data;
  try {
    data = await api("/customers/hierarchy");
  } catch (e) {
    mount(`<div class="mx-auto w-full max-w-2xl"><div class="card p-5 text-sm text-red-700">Failed to load customers: ${escapeHtml(e.message || e)}</div></div>`, routeFn);
    return;
  }
  const customers = data.customers || [];
  const totals = data.totals || {};

  const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
  const ymd = (s) => (s ? String(s).slice(0, 10) : "—");

  const TYPE_BADGE = {
    project: `<span class="inline-flex rounded px-1.5 py-0.5 text-[9px] font-bold bg-blue-100 text-blue-700">PROJECT</span>`,
    job: `<span class="inline-flex rounded px-1.5 py-0.5 text-[9px] font-bold bg-violet-100 text-violet-700">JOB</span>`,
    direct: `<span class="inline-flex rounded px-1.5 py-0.5 text-[9px] font-bold bg-black/10 text-black/50">DIRECT</span>`,
  };

  // Inline financials: invoiced / collected / open AR (+ this-year invoiced).
  const fin = (o, big) => `
    <div class="flex flex-wrap items-baseline justify-end gap-x-3 gap-y-0.5 ${big ? "" : "text-xs"}">
      <span class="${big ? "text-sm font-bold text-ink-900" : "font-semibold"}">${money(o.invoiced)}<span class="text-[10px] font-medium text-black/40"> inv</span></span>
      <span class="text-black/55">${money(o.collected)}<span class="text-[10px] font-medium text-black/40"> collected</span></span>
      ${o.open_ar > 0 ? `<span class="font-semibold text-amber-700">${money(o.open_ar)}<span class="text-[10px] font-medium text-amber-700/60"> open AR</span></span>` : ""}
      ${o.invoiced_ytd ? `<span class="font-semibold text-emerald-600">${money(o.invoiced_ytd)}<span class="text-[10px] font-medium text-emerald-600/60"> this yr</span></span>` : ""}
    </div>`;

  const childRow = (ch) => `
    <div class="flex items-start justify-between gap-3 rounded-lg border border-black/5 bg-black/[0.015] px-3 py-2">
      <div class="min-w-0">
        <div class="flex items-center gap-2 min-w-0">
          ${TYPE_BADGE[ch.type] || ""}
          <span class="text-sm font-semibold text-ink-900 truncate">${escapeHtml(ch.name || "(unnamed)")}</span>
          ${ch.type !== "direct" && !ch.active ? `<span class="inline-flex rounded-full px-1.5 py-0.5 text-[9px] font-bold bg-black/5 text-black/40">inactive</span>` : ""}
        </div>
        <div class="text-[10px] text-black/40 mt-0.5">last activity ${ymd(ch.last_txn)}</div>
      </div>
      <div class="shrink-0">${fin(ch, false)}</div>
    </div>`;

  const customerBlock = (c) => {
    const bits = [];
    if (c.project_count) bits.push(`${c.project_count} project${c.project_count === 1 ? "" : "s"}`);
    if (c.job_count) bits.push(`${c.job_count} job${c.job_count === 1 ? "" : "s"}`);
    bits.push(`last ${ymd(c.last_txn)}`);
    return `
    <details class="card p-0 overflow-hidden" data-name="${escapeHtml((c.name || "").toLowerCase())}">
      <summary class="px-4 py-3 cursor-pointer list-none">
        <div class="flex flex-col lg:flex-row lg:items-center lg:gap-6">
          <div class="min-w-0 lg:flex-1">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="text-base font-extrabold truncate">${escapeHtml(c.name)}</div>
                <div class="text-[11px] text-black/40">${bits.join(" · ")}</div>
              </div>
              <span class="text-black/30 text-xs shrink-0 lg:hidden">▸</span>
            </div>
          </div>
          <div class="mt-2 lg:mt-0 lg:shrink-0 lg:w-[34rem] flex items-center gap-3">
            <div class="flex-1 min-w-0">${fin(c, true)}</div>
            <span class="text-black/30 text-xs shrink-0 hidden lg:inline">▸</span>
          </div>
        </div>
      </summary>
      <div class="px-4 pb-4">
        <div class="space-y-1.5">
          ${(c.children || []).length ? c.children.map(childRow).join("") : `<div class="text-xs text-black/35 italic">No invoiced projects or jobs.</div>`}
        </div>
      </div>
    </details>`;
  };

  const totalsCard = `
    <div class="card p-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-lg font-extrabold">Customers &amp; Jobs</div>
          <div class="text-xs text-black/50">Revenue by customer — projects, legacy jobs, and direct invoices rolled up. Expand a customer to see the detail.</div>
        </div>
        <span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-700 shrink-0">Preview</span>
      </div>
      <div class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
        <div class="rounded-xl border border-black/10 bg-black/[0.02] p-2">
          <div class="text-base font-extrabold">${totals.customer_count ?? 0}</div>
          <div class="text-[10px] text-black/40">customers</div>
          <div class="text-[10px] text-black/40">${totals.project_count ?? 0} proj · ${totals.job_count ?? 0} jobs</div>
        </div>
        <div class="rounded-xl border border-black/10 bg-black/[0.02] p-2">
          <div class="text-base font-extrabold">${money(totals.invoiced)}</div>
          <div class="text-[10px] text-black/40">invoiced</div>
        </div>
        <div class="rounded-xl border border-black/10 bg-black/[0.02] p-2">
          <div class="text-base font-extrabold text-black/70">${money(totals.collected)}</div>
          <div class="text-[10px] text-black/40">collected</div>
        </div>
        <div class="rounded-xl border border-black/10 bg-black/[0.02] p-2">
          <div class="text-base font-extrabold text-amber-700">${money(totals.open_ar)}</div>
          <div class="text-[10px] text-black/40">open AR</div>
        </div>
      </div>
      <div class="mt-2 text-[10px] text-black/35 leading-snug">
        Money-in only (invoices &amp; collections). Paid/AR come from each invoice's balance, so they're correct even when a
        customer pays at the parent level. Vendor expenses live in Cash Flow &amp; the Crew Portal.
      </div>
      <div class="mt-3">
        <input id="custFilter" type="text" placeholder="Filter by customer name…"
          class="w-full rounded-lg border border-black/15 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black/10" />
      </div>
    </div>`;

  mount(`
    <div class="mx-auto w-full max-w-5xl grid grid-cols-1 gap-3 pb-3">
      ${totalsCard}
      <div id="custList" class="grid grid-cols-1 gap-3">
        ${customers.length ? customers.map(customerBlock).join("") : `<div class="card p-5 text-sm text-black/50">No customers found.</div>`}
      </div>
    </div>`, routeFn);

  const input = document.getElementById("custFilter");
  if (input) {
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      document.querySelectorAll("#custList > details").forEach((el) => {
        el.style.display = !q || (el.dataset.name || "").includes(q) ? "" : "none";
      });
    });
  }
}

function mount(bodyHtml, routeFn) {
  setShell({ title: "", subtitle: "", bodyHtml, showLogout: true, routeFn });
  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => { if (pageTitleBlock) pageTitleBlock.style.display = ""; }, { once: true });
  }
}
