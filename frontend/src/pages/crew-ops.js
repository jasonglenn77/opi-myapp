import { api } from "../api.js";
import { setShell } from "../shell.js";

// Office-facing crew operations hub: upcoming/overdue crew payments (grouped by
// week, burned down against actual QBO payments) + which active projects still
// need a crew (and any offer's status). Three tabs.
export async function crewOpsPage(routeFn) {
  let d;
  try { d = await api("/crew-hub"); }
  catch (e) {
    setShell({ title: "Crew Operations", subtitle: "", routeFn,
      bodyHtml: `<div class="card p-6 text-sm text-red-700">Failed to load: ${(e && e.message) || e}</div>` });
    return;
  }

  const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString();
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const dt = (s) => { if (!s) return "—"; try { return new Date(String(s).slice(0, 10) + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch (_) { return s; } };
  const dtY = (s) => { if (!s) return "—"; try { return new Date(String(s).slice(0, 10) + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch (_) { return s; } };
  const schedText = (s) => (!s || (!s.start && !s.end)) ? `<span class="text-black/30">no dates</span>` : `${s.start ? dt(s.start) : "?"} – ${s.end ? dt(s.end) : "?"}`;
  const projLink = (qid, name, tab) => `<a href="#/entity/project/${encodeURIComponent(qid)}" data-proj="${tab || ""}" class="font-semibold text-brand-700 hover:underline">${esc(name)}</a>`;

  // Group a payment list by the app's Sat–Fri week (labeled by the ending Friday).
  const weekKey = (iso) => {
    if (!iso) return "9999-99-99";
    const dd = new Date(String(iso).slice(0, 10) + "T00:00:00");
    const fri = new Date(dd); fri.setDate(dd.getDate() + ((5 - dd.getDay() + 7) % 7));
    return fri.toISOString().slice(0, 10);
  };

  const payRow = (p) => `
    <tr class="border-b border-black/5">
      <td class="py-1.5 pr-3 text-xs tabular-nums whitespace-nowrap text-black/55">${dt(p.pay_date)}</td>
      <td class="py-1.5 pr-3 font-semibold">${esc(p.crew)}${p.company ? `<span class="text-[11px] text-black/45 font-normal"> · ${esc(p.company)}</span>` : ""}</td>
      <td class="py-1.5 pr-3">${projLink(p.entity_id, p.project, "billing")}</td>
      <td class="py-1.5 pr-3 text-xs text-black/50 whitespace-nowrap">${schedText(p.schedule)}</td>
      <td class="py-1.5 pr-3 text-right tabular-nums font-semibold whitespace-nowrap">${money(p.amount)}</td>
      <td class="py-1.5 text-xs whitespace-nowrap">${p.status === "partial" ? `<span class="text-amber-700 font-semibold">Partly paid</span>` : `<span class="text-black/50">Scheduled</span>`}</td>
    </tr>`;

  const payGroups = (arr, emptyMsg) => {
    if (!arr.length) return `<div class="text-sm text-black/40 py-8 text-center">${emptyMsg}</div>`;
    const groups = {};
    arr.forEach(p => { const k = weekKey(p.pay_date); (groups[k] = groups[k] || []).push(p); });
    return Object.keys(groups).sort().map(k => {
      const rows = groups[k];
      const total = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
      return `
        <div class="mb-5">
          <div class="flex items-baseline justify-between px-1 pb-1.5 mb-1 border-b-2 border-black/15">
            <div class="text-sm font-extrabold">Week ending ${dtY(k)} <span class="text-black/40 font-semibold">· ${rows.length}</span></div>
            <div class="text-sm font-extrabold tabular-nums">${money(total)}</div>
          </div>
          <div class="overflow-x-auto"><table class="w-full text-sm" style="min-width:680px;">
            <thead class="text-left text-black/40 text-[10px] uppercase tracking-wide"><tr class="border-b border-black/5">
              <th class="py-1 pr-3 font-bold">Pay date</th><th class="py-1 pr-3 font-bold">Crew</th><th class="py-1 pr-3 font-bold">Project</th>
              <th class="py-1 pr-3 font-bold">Job schedule</th><th class="py-1 pr-3 text-right font-bold">Amount owed</th><th class="py-1 font-bold">Status</th>
            </tr></thead>
            <tbody>${rows.map(payRow).join("")}</tbody>
          </table></div>
        </div>`;
    }).join("");
  };

  const STATUS = {
    needs_attention: ["Needs attention", "bg-red-50 text-red-700 border-red-200"],
    pending: ["Pending", "bg-amber-50 text-amber-700 border-amber-200"],
    not_started: ["Not started", "bg-black/5 text-black/60 border-black/15"],
    in_progress: ["In progress", "bg-emerald-50 text-emerald-700 border-emerald-200"],
  };
  const statusPill = (s) => { const m = STATUS[s] || [s, "bg-black/5 text-black/60 border-black/15"]; return `<span class="inline-flex rounded-full border px-2 py-0.5 text-[11px] font-bold whitespace-nowrap ${m[1]}">${m[0]}</span>`; };
  const OFFER = { sent: ["Offer sent", "text-blue-700"], accepted: ["Accepted", "text-emerald-700"], declined: ["Declined", "text-red-700"], withdrawn: ["Withdrawn", "text-black/50"] };
  const offerCell = (o) => {
    if (!o) return `<span class="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700"><span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>No offer sent</span>`;
    const m = OFFER[o.status] || [o.status, "text-black/60"];
    return `<span class="text-xs font-semibold ${m[1]}">${m[0]}</span>${o.sent_at ? `<span class="text-[11px] text-black/45"> · sent ${esc(dt(o.sent_at))}</span>` : ""}${o.crew ? `<span class="text-[11px] text-black/45"> · ${esc(o.crew)}</span>` : ""}`;
  };
  const needsTable = () => d.needs_crew.length ? `
    <div class="overflow-x-auto"><table class="w-full text-sm" style="min-width:640px;">
      <thead class="text-left text-black/40 text-[11px] uppercase tracking-wide"><tr class="border-b border-black/10">
        <th class="py-1.5 pr-3 font-bold">Project</th><th class="py-1.5 pr-3 font-bold">Job schedule</th>
        <th class="py-1.5 pr-3 font-bold">Status</th><th class="py-1.5 font-bold">Crew offer</th>
      </tr></thead>
      <tbody>${d.needs_crew.map(p => `
        <tr class="border-b border-black/5">
          <td class="py-1.5 pr-3">${projLink(p.entity_id, p.project, "assignment")}</td>
          <td class="py-1.5 pr-3 text-xs text-black/50 whitespace-nowrap">${schedText(p.schedule)}</td>
          <td class="py-1.5 pr-3">${statusPill(p.status)}</td>
          <td class="py-1.5">${offerCell(p.offer)}</td>
        </tr>`).join("")}</tbody>
    </table></div>` : `<div class="text-sm text-black/40 py-8 text-center">Every active project has a crew.</div>`;

  const TABS = [
    { k: "upcoming", label: "Upcoming pay", meta: money(d.upcoming_total) },
    { k: "overdue", label: "Overdue", meta: money(d.overdue_total) },
    { k: "needs", label: "Needs a crew", meta: String(d.needs_crew_count) },
  ];

  const bodyHtml = `
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
      <div class="card p-4"><div class="text-[11px] font-bold uppercase tracking-wide text-black/45">Upcoming crew payments</div><div class="text-2xl font-extrabold tabular-nums">${money(d.upcoming_total)}</div><div class="text-xs text-black/50">${d.upcoming.length} owed installment(s), today onward</div></div>
      <div class="card p-4 border-amber-300"><div class="text-[11px] font-bold uppercase tracking-wide text-amber-700">Overdue &amp; still owed</div><div class="text-2xl font-extrabold tabular-nums text-amber-700">${money(d.overdue_total)}</div><div class="text-xs text-black/50">${d.overdue.length} past-due, unpaid</div></div>
      <div class="card p-4"><div class="text-[11px] font-bold uppercase tracking-wide text-black/45">Projects needing a crew</div><div class="text-2xl font-extrabold tabular-nums">${d.needs_crew_count}</div><div class="text-xs text-black/50">active projects, no crew assigned</div></div>
    </div>

    <div class="inline-flex items-center gap-1 rounded-xl bg-white/5 border border-white/10 p-1 mb-3" role="tablist">
      ${TABS.map(t => `<button type="button" data-cptab="${t.k}" class="cp-tab px-4 py-2 rounded-lg text-sm font-bold text-white/60">${t.label} <span class="opacity-60 font-semibold">${t.meta}</span></button>`).join("")}
    </div>

    <div class="card p-5" data-cppanel="upcoming">
      <div class="text-xs text-black/50 mb-3">Owed crew payments by week (already burned down against what's actually been paid).</div>
      ${payGroups(d.upcoming, "No upcoming crew payments owed.")}
    </div>
    <div class="card p-5 hidden" data-cppanel="overdue">
      <div class="text-xs text-black/50 mb-3">Past-due installments that are still unpaid — worth chasing.</div>
      ${payGroups(d.overdue, "Nothing overdue. 🎉")}
    </div>
    <div class="card p-5 hidden" data-cppanel="needs">
      <div class="text-sm text-black/55 mb-3">Active projects with no crew assigned. Click a project to assign a crew or send an offer.</div>
      ${needsTable()}
    </div>`;

  setShell({ title: "Crew Operations", subtitle: "Everything crews — upcoming pay by week, what's overdue, and who still needs a crew.", bodyHtml, routeFn });

  // Tabs
  const KEY = "opi_crewops_tab";
  const btns = [...document.querySelectorAll("[data-cptab]")];
  const panels = { upcoming: document.querySelector('[data-cppanel="upcoming"]'), overdue: document.querySelector('[data-cppanel="overdue"]'), needs: document.querySelector('[data-cppanel="needs"]') };
  const show = (tab) => {
    if (!panels[tab]) tab = "upcoming";
    Object.entries(panels).forEach(([k, el]) => { if (el) el.classList.toggle("hidden", k !== tab); });
    btns.forEach(b => {
      const on = b.getAttribute("data-cptab") === tab;
      b.classList.toggle("bg-white", on); b.classList.toggle("text-ink-900", on); b.classList.toggle("shadow-sm", on);
      b.classList.toggle("text-white/60", !on); b.classList.toggle("hover:bg-white/10", !on); b.classList.toggle("hover:text-white", !on);
    });
    try { localStorage.setItem(KEY, tab); } catch (_) {}
  };
  btns.forEach(b => b.addEventListener("click", () => show(b.getAttribute("data-cptab"))));
  let saved = "upcoming"; try { saved = localStorage.getItem(KEY) || "upcoming"; } catch (_) {}
  show(saved);

  document.querySelectorAll("[data-proj]").forEach(a => a.addEventListener("click", () => {
    const tab = a.getAttribute("data-proj");
    if (tab) { try { sessionStorage.setItem("opi_entity_tab", tab); } catch (_) {} }
  }));
}
