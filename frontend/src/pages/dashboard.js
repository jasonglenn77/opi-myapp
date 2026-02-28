import { api } from "../api.js";
import { setShell } from "../shell.js";
import { fmtMoney, fmtPct } from "../utils/format.js";
import { escapeHtml } from "../utils/html.js";

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

  function parseYmd(v) {
    // expects "YYYY-MM-DD" (end_date), tolerates ISO strings
    if (!v) return null;
    const s = String(v).slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const yyyy = Number(m[1]);
    const mm = Number(m[2]);
    const dd = Number(m[3]);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    return Number.isFinite(d.getTime()) ? d : null;
  }

  // Completed-only totals
  const completed = rows.filter(isCompleted);
  const totalIncome = completed.reduce((acc, r) => acc + n(r.total_income), 0);
  const totalCost = completed.reduce((acc, r) => acc + n(r.total_cost), 0);
  const totalProfit = completed.reduce((acc, r) => acc + n(r.total_profit), 0);

  // Weighted margin across completed projects
  const margin = totalIncome === 0 ? null : totalProfit / totalIncome;

  const bodyHtml = `
    <div class="grid grid-cols-1 gap-4">

      <!-- KPI card -->
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

      <!-- Chart card -->
      <div class="card p-5">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">Monthly performance</div>
            <div class="text-sm text-black/60">Completed projects by end date (Income = Cost + Profit)</div>
          </div>
          <div class="text-xs text-black/50 whitespace-nowrap" id="chartRange">—</div>
        </div>

        <div class="mt-4 border border-black/10 bg-black/5 rounded-2xl p-3">
          <!-- Legend -->
          <div class="flex flex-wrap items-center justify-between gap-2 px-1 pb-2">
            <div class="text-xs font-bold text-black/60">Legend</div>
            <div class="flex flex-wrap items-center gap-3 text-xs font-semibold text-black/70">
              <span class="inline-flex items-center gap-2">
                <span class="inline-block h-2.5 w-2.5 rounded-sm border border-black/10" style="background: rgba(17,24,39,.22)"></span>
                Cost
              </span>
              <span class="inline-flex items-center gap-2">
                <span class="inline-block h-2.5 w-2.5 rounded-sm border border-black/10" style="background: rgba(79,127,97,.30)"></span>
                Profit
              </span>
              <span class="inline-flex items-center gap-2">
                <span class="inline-block h-0.5 w-6 rounded-full" style="background: rgba(30,58,138,.55)"></span>
                Margin
              </span>
            </div>
          </div>

          <div id="dashboardChart" class="w-full"></div>
        </div>
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

  // ----------------------------
  // D3 Chart
  // ----------------------------
  const d3 = window.d3;
  const chartHost = document.getElementById("dashboardChart");
  if (!chartHost) return;

  if (!d3) {
    chartHost.innerHTML =
      `<div class="text-sm text-red-700">D3 not found. Add: &lt;script src="https://d3js.org/d3.v7.min.js"&gt;&lt;/script&gt;</div>`;
    return;
  }

  function buildMonthlySeries(list) {
    const byMonth = new Map();

    for (const r of list) {
      const d = parseYmd(r.end_date);
      if (!d) continue;

      const y = d.getUTCFullYear();
      const m = d.getUTCMonth() + 1;
      const key = `${y}-${String(m).padStart(2, "0")}`;

      const income = n(r.total_income);
      const cost = n(r.total_cost);
      const profit = income - cost;

      if (!byMonth.has(key)) {
        byMonth.set(key, {
          key,
          year: y,
          month: m,
          income: 0,
          cost: 0,
          profit: 0,
          count: 0,
          projects: [],
        });
      }

      const agg = byMonth.get(key);
      agg.income += income;
      agg.cost += cost;
      agg.profit += profit;
      agg.count += 1;

      agg.projects.push({
        name: (r.project_name || r.project_qbo_id || "—").toString(),
        qbo: r.project_qbo_id ?? null,
      });
    }

    const arr = Array.from(byMonth.values()).sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return a.month - b.month;
    });

    for (const x of arr) {
      x.margin = x.income === 0 ? null : x.profit / x.income;
      x.label = x.key; // "YYYY-MM"
      x.dt = new Date(Date.UTC(x.year, x.month - 1, 1));
      x.projects.sort((a, b) => a.name.localeCompare(b.name));
    }

    return arr;
  }

  const series = buildMonthlySeries(completed);

  // range label
  const rangeEl = document.getElementById("chartRange");
  if (rangeEl) {
    if (series.length === 0) rangeEl.textContent = "No completed projects with end dates";
    else rangeEl.textContent = `${series[0].label} → ${series[series.length - 1].label}`;
  }

  // Tooltip singleton (prevents duplicates)
  const existing = document.getElementById("dashChartTooltip");
  if (existing) existing.remove();

  const tooltip = document.createElement("div");
  tooltip.id = "dashChartTooltip";
  tooltip.className =
    "pointer-events-none absolute z-50 hidden rounded-xl border border-black/10 bg-white/95 px-3 py-2 text-xs shadow-sm";
  tooltip.style.transform = "translate(-50%, -110%)";
  document.body.appendChild(tooltip);

  function projectsHtml(d, limit = 8) {
    const items = d.projects || [];
    if (!items.length) return `<div class="text-black/50">No projects</div>`;

    const shown = items.slice(0, limit);
    const rest = items.length - shown.length;

    return `
      <div class="mt-2 text-black/60">Projects</div>
      <div class="mt-1 space-y-0.5">
        ${shown.map((p) => `<div class="text-black/80">• ${escapeHtml(p.name)}</div>`).join("")}
        ${rest > 0 ? `<div class="text-black/50">… +${rest} more</div>` : ""}
      </div>
    `;
  }

  function showTip(evt, d) {
    tooltip.innerHTML = `
      <div class="font-bold text-ink-800">${escapeHtml(d.label)}</div>
      <div class="mt-1 text-black/70">Income: <span class="font-semibold text-black/80">${fmtMoney(d.income)}</span></div>
      <div class="text-black/70">Cost: <span class="font-semibold text-black/80">${fmtMoney(d.cost)}</span></div>
      <div class="text-black/70">Profit: <span class="font-semibold text-black/80">${fmtMoney(d.profit)}</span></div>
      <div class="text-black/70">Margin: <span class="font-semibold text-black/80">${d.margin == null ? "—" : fmtPct(d.margin)}</span></div>
      <div class="mt-1 text-black/50">${d.count} completed</div>
      ${projectsHtml(d)}
    `;
    tooltip.classList.remove("hidden");
    tooltip.style.left = `${evt.clientX}px`;
    tooltip.style.top = `${evt.clientY}px`;
  }
  function moveTip(evt) {
    tooltip.style.left = `${evt.clientX}px`;
    tooltip.style.top = `${evt.clientY}px`;
  }
  function hideTip() {
    tooltip.classList.add("hidden");
  }

  function renderChart() {
    chartHost.innerHTML = "";

    const w = chartHost.clientWidth || 800;
    const h = 280;

    const margin = { top: 16, right: 46, bottom: 34, left: 56 };
    const innerW = Math.max(320, w) - margin.left - margin.right;
    const innerH = h - margin.top - margin.bottom;

    const svg = d3
      .select(chartHost)
      .append("svg")
      .attr("width", w)
      .attr("height", h)
      .style("display", "block");

    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Inline label
    g.append("text")
      .attr("x", 0)
      .attr("y", 0)
      .attr("dy", "0.9em")
      .attr("fill", "rgba(0,0,0,.55)")
      .attr("font-size", 11)
      .attr("font-weight", 700)
      .text("Cost + Profit = Income");

    if (series.length === 0) {
      g.append("text")
        .attr("x", 0)
        .attr("y", 28)
        .attr("fill", "rgba(0,0,0,.6)")
        .attr("font-size", 12)
        .text("No data to chart (no completed projects with end_date).");
      return;
    }

    const x = d3
      .scaleBand()
      .domain(series.map((d) => d.label))
      .range([0, innerW])
      .padding(0.22);

    const maxIncome = d3.max(series, (d) => d.income) ?? 0;
    const minProfit = d3.min(series, (d) => d.profit) ?? 0;
    const yMin = Math.min(0, minProfit);
    const yMax = Math.max(0, maxIncome);

    const y = d3
      .scaleLinear()
      .domain([yMin, yMax])
      .nice()
      .range([innerH, 0]);

    const moneyTick = (v) => {
      const abs = Math.abs(v);
      if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
      if (abs >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
      return `${v.toFixed(0)}`;
    };

    // Gridlines
    g.append("g")
      .call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(""))
      .call((gg) => gg.selectAll("line").attr("stroke", "rgba(0,0,0,.06)"))
      .call((gg) => gg.select(".domain").remove());

    // Bars
    const bar = g
      .append("g")
      .selectAll("g")
      .data(series)
      .enter()
      .append("g")
      .attr("transform", (d) => `translate(${x(d.label)},0)`);

    const rx = 8;
    const bw = x.bandwidth();

    // Cost segment
    bar.append("rect")
      .attr("x", 0)
      .attr("width", bw)
      .attr("y", (d) => y(d.cost))
      .attr("height", (d) => Math.max(0, y(0) - y(d.cost)))
      .attr("rx", rx)
      .attr("ry", rx)
      .attr("fill", "rgba(17,24,39,.22)")
      .attr("stroke", "rgba(17,24,39,.10)");

    // Profit segment
    bar.append("rect")
      .attr("x", 0)
      .attr("width", bw)
      .attr("y", (d) => (d.profit >= 0 ? y(d.income) : y(0)))
      .attr("height", (d) => {
        if (d.profit >= 0) return Math.max(0, y(d.cost) - y(d.income));
        return Math.max(0, y(d.profit) - y(0));
      })
      .attr("rx", rx)
      .attr("ry", rx)
      .attr("fill", "rgba(79,127,97,.30)")
      .attr("stroke", "rgba(79,127,97,.18)");

    // Zero line
    g.append("line")
      .attr("x1", 0)
      .attr("x2", innerW)
      .attr("y1", y(0))
      .attr("y2", y(0))
      .attr("stroke", "rgba(0,0,0,.12)");

    // Axes
    g.append("g")
      .call(d3.axisLeft(y).ticks(5).tickFormat(moneyTick))
      .call((gg) => gg.selectAll("text").attr("fill", "rgba(0,0,0,.55)"))
      .call((gg) => gg.selectAll("line").attr("stroke", "rgba(0,0,0,.10)"))
      .call((gg) => gg.select(".domain").attr("stroke", "rgba(0,0,0,.12)"));

    const xAxis = d3.axisBottom(x).tickFormat((d) => d);
    if (series.length > 10) {
      const step = Math.ceil(series.length / 10);
      const keep = new Set(series.map((d) => d.label).filter((_, i) => i % step === 0));
      xAxis.tickValues(series.map((d) => d.label).filter((k) => keep.has(k)));
    }

    g.append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(xAxis)
      .call((gg) => gg.selectAll("text").attr("fill", "rgba(0,0,0,.55)"))
      .call((gg) => gg.selectAll("line").attr("stroke", "rgba(0,0,0,.10)"))
      .call((gg) => gg.select(".domain").attr("stroke", "rgba(0,0,0,.12)"));

    // Margin line (right axis)
    const marginValues = series
      .map((d) => (d.margin == null ? null : d.margin))
      .filter((v) => v != null);

    const hasMargin = marginValues.length > 0;

    if (hasMargin) {
      const y2 = d3
        .scaleLinear()
        .domain([0, Math.max(0.01, d3.max(marginValues) ?? 0)])
        .nice()
        .range([innerH, 0]);

      const line = d3
        .line()
        .defined((d) => d.margin != null)
        .x((d) => x(d.label) + x.bandwidth() / 2)
        .y((d) => y2(d.margin));

      g.append("path")
        .datum(series)
        .attr("fill", "none")
        .attr("stroke", "rgba(30,58,138,.55)")
        .attr("stroke-width", 2)
        .attr("d", line);

      const lastDefined = [...series].reverse().find((d) => d.margin != null);
      if (lastDefined) {
        g.append("text")
          .attr("x", x(lastDefined.label) + x.bandwidth() / 2 + 6)
          .attr("y", y2(lastDefined.margin))
          .attr("dy", "0.35em")
          .attr("fill", "rgba(30,58,138,.70)")
          .attr("font-size", 11)
          .attr("font-weight", 700)
          .text("Margin");
      }

      g.append("g")
        .attr("transform", `translate(${innerW},0)`)
        .call(d3.axisRight(y2).ticks(4).tickFormat((v) => `${Math.round(v * 100)}%`))
        .call((gg) => gg.selectAll("text").attr("fill", "rgba(0,0,0,.55)"))
        .call((gg) => gg.selectAll("line").attr("stroke", "rgba(0,0,0,.10)"))
        .call((gg) => gg.select(".domain").attr("stroke", "rgba(0,0,0,.12)"));
    }

    // Month-wide hover zones (ALWAYS)
    g.append("g")
      .selectAll("rect")
      .data(series)
      .enter()
      .append("rect")
      .attr("x", (d) => x(d.label))
      .attr("y", 0)
      .attr("width", x.bandwidth())
      .attr("height", innerH)
      .attr("fill", "transparent")
      .style("cursor", "default")
      .on("mouseenter", function (evt, d) { showTip(evt, d); })
      .on("mousemove", function (evt) { moveTip(evt); })
      .on("mouseleave", function () { hideTip(); });
  }

  renderChart();

  // Responsive re-render
  const ro = new ResizeObserver(() => renderChart());
  ro.observe(chartHost);
}