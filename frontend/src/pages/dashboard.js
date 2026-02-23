import { api } from "../api.js";
import { setShell } from "../shell.js";
import { fmtMoney, fmtPct } from "../utils/format.js";

export async function dashboardPage(routeFn) {
  const data = await api("/dashboard");
  const rows = data.projects || [];

  function normalize(v) {
    return (v ?? "").toString().toLowerCase();
  }

  function isCompleted(r) {
    return normalize(r.project_status) === "completed";
  }

  function n(v) {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }

  // Completed-only totals
  const completed = rows.filter(isCompleted);
  const totalIncome = completed.reduce((acc, r) => acc + n(r.total_income), 0);
  const totalCost = completed.reduce((acc, r) => acc + n(r.total_cost), 0);
  const totalProfit = completed.reduce((acc, r) => acc + n(r.total_profit), 0);

  // Weighted margin across completed projects
  const margin = totalIncome === 0 ? null : totalProfit / totalIncome;

  const bodyHtml = `
    <div class="card p-5">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-lg font-extrabold">KPI</div>
          <div class="text-sm text-black/60">Completed projects totals</div>
        </div>
        <div class="text-xs text-black/50 whitespace-nowrap">
          ${completed.length} completed
        </div>
      </div>

      <div class="mt-4 grid gap-3 sm:grid-cols-3">
        ${kpiCard("Total Income", fmtMoney(totalIncome))}
        ${kpiCard("Total Cost", fmtMoney(totalCost))}
        ${profitCard("Total Profit", fmtMoney(totalProfit), margin)}
      </div>
    </div>
  `;

  setShell({
    title: "Dashboard",
    subtitle: "KPI snapshot for completed projects.",
    bodyHtml,
    showLogout: true,
    routeFn,
  });

  function kpiCard(label, valueHtml) {
    return `
      <div class="rounded-2xl border border-black/10 bg-black/5 p-5">
        <div class="text-xs font-bold text-black/60">${label}</div>
        <div class="pt-2 text-3xl font-extrabold leading-tight">${valueHtml}</div>
      </div>
    `;
  }

  function profitCard(label, profitHtml, marginVal) {
    const marginHtml = marginVal == null ? "—" : fmtPct(marginVal);
    return `
      <div class="rounded-2xl border border-black/10 bg-black/5 p-5">
        <div class="flex items-start justify-between gap-3">
          <div class="text-xs font-bold text-black/60">${label}</div>
          <div class="text-xs font-bold text-black/60 whitespace-nowrap">
            Margin
            <span class="ml-1 inline-flex rounded-full px-2 py-0.5 bg-white/60 border border-black/10 text-black/70 font-extrabold">
              ${marginHtml}
            </span>
          </div>
        </div>
        <div class="pt-2 text-3xl font-extrabold leading-tight">${profitHtml}</div>
      </div>
    `;
  }
}