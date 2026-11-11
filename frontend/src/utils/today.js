// "Today" strip for the Overview page: the owner's one glance across every queue.
// Each tile loads on its own (the slow ones don't hold up the fast ones) and links
// to the page that owns it. A tile the person can't open is left out.
import { api, hasCapability } from "../api.js";
import { money0 } from "./ui.js";

const TILES = [
  { key: "cash", cap: "page.cashflow", href: "#/cashflow-plan", label: "Lowest cash ahead", load: async () => {
      const d = await api("/cash-plan?weeks=13");
      const sides = { in: 0, out: 0 };
      let b = d.opening, lo = Infinity, at = null;
      d.week_ends.forEach((w, i) => {
        const net = d.lines.filter((l) => l.layer === "forecast" || l.layer === "won").reduce((a, l) => a + (l.side === "in" ? 1 : -1) * l.weekly[i], 0);
        b += net; if (b < lo) { lo = b; at = w; }
      });
      return { value: money0(lo), caption: `Week ending ${new Date(at + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric" })}; today ${money0(d.opening)}`, bad: lo < 0 };
    } },
  { key: "setup", cap: "page.assignment", href: "#/setup", label: "New jobs to set up", load: async () => {
      const d = await api("/setup/queue");
      const urgent = d.jobs.filter((j) => j.flags.some((f) => f.tone === "bad")).length;
      return { value: d.jobs.length, caption: urgent ? `${urgent} urgent (not in QuickBooks, starting soon…)` : "Nothing urgent", bad: urgent > 0 };
    } },
  { key: "dates", cap: "page.cashflow", href: "#/pay-dates", label: "Invoices overdue to send", load: async () => {
      const d = await api("/pay-dates");
      const s = d.summary;
      return { value: money0(s.overdue_send), caption: `${s.overdue_send_n} invoices · ${s.late_paid_n} payments late (${money0(s.late_paid)})`, bad: s.overdue_send_n > 0 };
    } },
  { key: "closeout", cap: "page.assignment", href: "#/closeout", label: "Finished, not closed", load: async () => {
      const d = await api("/closeout/queue");
      const unb = d.jobs.reduce((a, j) => a + j.money.unbilled, 0);
      return { value: d.jobs.length, caption: `${money0(unb)} still to bill on finished jobs`, bad: unb > 0 };
    } },
  { key: "issues", cap: "page.customers", href: "#/issues", label: "Open problems", load: async () => {
      const d = await api("/issues");
      const bad = d.areas.reduce((a, x) => a + x.bad, 0);
      const top = d.areas.filter((a) => a.key !== "data").sort((a, b) => b.bad - a.bad)[0];
      return { value: bad, caption: top ? `Most in ${top.label.toLowerCase()} (${top.bad})` : "", bad: bad > 0 };
    } },
];

export function mountToday(el) {
  const tiles = TILES.filter((t) => hasCapability(t.cap));
  if (!tiles.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="flex items-baseline justify-between mb-2"><div class="text-lg font-extrabold">Today</div><div class="text-xs text-white/50">Click a tile to open its page</div></div>
    <div class="su-kpis">${tiles.map((t) => `<a href="${t.href}" class="card p-4 block su-kpi" data-t="${t.key}">
      <div class="text-[10px] uppercase tracking-wide font-bold text-black/45">${t.label}</div>
      <div class="text-2xl font-extrabold tabular-nums text-black/30" data-v>…</div><div class="text-xs text-black/50" data-c>Loading</div></a>`).join("")}</div>`;
  for (const t of tiles) {
    const box = el.querySelector(`[data-t="${t.key}"]`);
    t.load().then((r) => {
      box.querySelector("[data-v]").textContent = r.value;
      box.querySelector("[data-v]").className = `text-2xl font-extrabold tabular-nums ${r.bad ? "text-rose-700" : "text-ink-900"}`;
      box.querySelector("[data-c]").textContent = r.caption;
    }).catch(() => { box.querySelector("[data-v]").textContent = "—"; box.querySelector("[data-c]").textContent = "Couldn't load"; });
  }
}
