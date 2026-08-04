// Projects hub — the operational system of record for every QuickBooks project.
// One row per project (status, team, schedule, value, profit) with a glanceable
// FLAGS column summarising what needs attention. Click a row to expand a detail
// panel (loaded lazily) whose cards echo the row's flags. Absorbs the old
// Projects dashboard + Assignment landing; Financials + Schedule remain focused
// deep-dive views inside a project.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";

const dash = (s) => (s == null || s === "" ? "—" : s);
const money = (n) => (n == null || n === "" ? "—" : "$" + Math.round(Number(n)).toLocaleString());
const csvList = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function shortDate(s) {
  if (!s) return "—";
  const p = String(s).slice(0, 10).split("-");
  if (p.length !== 3) return String(s);
  return `${MONTHS[+p[1] - 1] || p[1]} ${+p[2]}, ${p[0]}`;
}
function rangeShort(a, b) {
  if (!a) return "—";
  const pa = String(a).slice(0, 10).split("-"), pb = String(b || "").slice(0, 10).split("-");
  const l = `${MONTHS[+pa[1] - 1] || pa[1]} ${+pa[2]}`;
  if (!b) return `${l}, ${pa[0]}`;
  const r = (pa[0] === pb[0] && pa[1] === pb[1]) ? `${+pb[2]}` : `${MONTHS[+pb[1] - 1] || pb[1]} ${+pb[2]}`;
  return `${l} – ${r}, ${pb[0]}`;
}

// Operational status → label + pill styling. Order drives the filter pills.
const OP_STATUS = {
  needs_assignment: { label: "Needs assignment", cls: "bg-rose-100 text-rose-800" },
  pending:          { label: "Pending",          cls: "bg-amber-100 text-amber-800" },
  assigned:         { label: "Assigned",         cls: "bg-slate-200 text-slate-700" },
  scheduled:        { label: "Scheduled",        cls: "bg-sky-100 text-sky-800" },
  in_progress:      { label: "In progress",      cls: "bg-indigo-100 text-indigo-800" },
  complete:         { label: "Complete",         cls: "bg-emerald-100 text-emerald-800" },
  canceled:         { label: "Canceled",         cls: "bg-black/10 text-black/50" },
};
const statusBadge = (s) => {
  const m = OP_STATUS[s] || { label: s || "—", cls: "bg-black/10 text-black/50" };
  return `<span class="inline-flex items-center gap-1 text-[10.5px] font-bold rounded-full px-2 py-0.5 whitespace-nowrap ${m.cls}">${escapeHtml(m.label)}</span>`;
};

// Flag severity → chip classes (row) and card left-accent (detail).
const FLAG_CLS = {
  bad:  "bg-rose-50 text-rose-700 border-rose-200",
  warn: "bg-amber-50 text-amber-700 border-amber-200",
  good: "bg-emerald-50 text-emerald-700 border-emerald-200",
  mut:  "bg-black/[0.03] text-black/45 border-black/10",
};
const ACCENT = { bad: "border-l-rose-400", warn: "border-l-amber-400", good: "border-l-emerald-400", mut: "border-l-black/20" };

function profitInfo(fin) {
  if (!fin) return { pct: null };
  const inv = Number(fin.invoice_line_amt) || 0;
  const ap = fin.actual_profit_pct, pp = fin.projected_profit_pct;
  const useActual = inv > 0 && ap != null;
  const pct = (useActual ? ap : pp);
  if (pct == null) return { pct: null };
  return { pct: pct * 100, actual: useActual, ap, pp };
}

// Derive the collapsed-row flags from the merged data (basic + financials +
// attention). Each flag carries the detail card it points to.
function deriveFlags(p, fin, att) {
  const flags = [];
  const est = att && att.estimates, offer = att && att.offer;
  if (p.operational_status === "needs_assignment")
    flags.push({ c: "bad", i: "!", card: "team", t: "Needs attention — assign PM, crew, and dates" });
  else if (p.operational_status === "pending")
    flags.push({ c: "warn", i: "◔", card: "team", t: "Pending — partially set up (crew and/or dates unknown)" });

  if (est && est.pending > 0)
    flags.push({ c: "warn", i: "✎", card: "estimates", t: `${est.pending} estimate${est.pending > 1 ? "s" : ""} pending review` });

  if (offer && offer.state === "sent")
    flags.push({ c: offer.age_days > 7 ? "bad" : "warn", i: "◷", card: "offer",
      t: `Crew offer sent${offer.age_days != null ? ` ${offer.age_days}d ago` : ""} — awaiting response` });
  else if (offer && offer.state === "accepted")
    flags.push({ c: "good", i: "✓", card: "offer",
      t: `Crew offer accepted${offer.age_days != null ? ` ${offer.age_days}d ago` : ""}` });

  if (fin) {
    const inv = Number(fin.invoice_line_amt) || 0;
    const ap = fin.actual_profit_pct, pp = fin.projected_profit_pct;
    if (ap != null && inv > 0 && ap < 0)
      flags.push({ c: "bad", i: "$", card: "financial", t: `Project margin negative (${(ap * 100).toFixed(1)}%)` });
    else if (ap != null && pp != null && inv > 0 && ap < pp - 0.03)
      flags.push({ c: "warn", i: "$", card: "financial", t: `Margin ${((pp - ap) * 100).toFixed(1)} pts below plan` });
  }

  const dcount = csvList(p.all_start_dates).length;
  if (dcount > 1)
    flags.push({ c: "mut", i: "⑂", card: "schedule", t: `${dcount} separate date ranges` });

  return flags;
}

export async function projectsHubPage(routeFn) {
  let all = [];
  let finById = new Map();     // qbo_customer_id -> financial row
  let attById = new Map();     // project_qbo_id (string) -> attention row
  const cardCache = new Map(); // project_qbo_id -> card detail (lazy)
  const openSet = new Set();   // project_qbo_id currently expanded
  let statusFilter = "all", search = "", sortKey = "project_name", sortDir = "asc";

  const body = `
    <div class="w-full">
      <div class="card p-3 flex flex-col overflow-hidden" id="phCard" style="min-height:340px;">
        <div class="flex items-center gap-2 mb-2 flex-wrap shrink-0" id="phFilters"></div>
        <div id="phList" class="flex-1 overflow-auto text-sm text-black/40">Loading…</div>
      </div>
    </div>`;
  setShell({
    title: "Projects",
    subtitle: "Every project — status, team, schedule, financials, and what needs attention. Click a row for the full picture.",
    bodyHtml: body, showLogout: true, routeFn,
  });

  const listEl = document.getElementById("phList");
  const filtersEl = document.getElementById("phFilters");

  const setBack = (qid) => {
    try { sessionStorage.setItem("opi_entity_back", JSON.stringify({ entity: "project/" + qid, label: "Projects", hash: "#/projects" })); } catch (_) {}
  };

  const sizeCard = () => {
    const card = document.getElementById("phCard");
    if (!card) return;
    const top = card.getBoundingClientRect().top;
    card.style.height = Math.max(340, window.innerHeight - top - 30) + "px";
  };
  window.addEventListener("resize", sizeCard);

  const finVal = (p) => {
    const f = finById.get(p.qbo_customer_id);
    return f ? (Number(f.invoice_line_amt) || Number(f.estimate_line_amt) || 0) : 0;
  };
  const searchKey = (p) => `${p.project_name || ""} ${p.all_project_managers || ""} ${p.all_work_crews || ""} ${p.linked_quote_number || ""}`.toLowerCase();
  const sortVal = (p, key) => {
    if (key === "value") return finVal(p);
    if (key === "profit") { const pi = profitInfo(finById.get(p.qbo_customer_id)); return pi.pct == null ? -Infinity : pi.pct; }
    return (p[key] ?? "").toString().toLowerCase();
  };
  const sortedAll = () => {
    const out = [...all];
    out.sort((a, b) => { const av = sortVal(a, sortKey), bv = sortVal(b, sortKey); return (av < bv ? -1 : av > bv ? 1 : 0) * (sortDir === "asc" ? 1 : -1); });
    return out;
  };

  const HEADERS = [
    { key: "operational_status", label: "Status" },
    { key: "project_name", label: "Project" },
    { key: null, label: "Schedule" },
    { key: null, label: "Team" },
    { key: "value", label: "Value", align: "right" },
    { key: "profit", label: "Profit", align: "right" },
    { key: null, label: "Flags", align: "right" },
  ];
  const arrow = (k) => (sortKey !== k ? "" : sortDir === "asc" ? " ▲" : " ▼");
  const onHeaderClick = (k) => {
    if (!k) return;
    if (sortKey !== k) { sortKey = k; sortDir = "asc"; }
    else if (sortDir === "asc") sortDir = "desc";
    else { sortKey = "project_name"; sortDir = "asc"; }
    renderList();
  };

  const renderFilters = () => {
    const counts = all.reduce((m, p) => { m[p.operational_status] = (m[p.operational_status] || 0) + 1; return m; }, {});
    const pills = [["all", "All"], ...Object.keys(OP_STATUS).map((k) => [k, OP_STATUS[k].label])];
    filtersEl.innerHTML =
      pills.map(([k, label]) => {
        const n = k === "all" ? all.length : (counts[k] || 0);
        return `<button data-sf="${k}" class="rounded-full px-2.5 py-1 text-xs font-semibold border ${statusFilter === k ? "bg-ink-900 text-white border-ink-900" : "border-black/15 text-black/60 hover:bg-black/5"}">${escapeHtml(label)} <span class="opacity-60">${n}</span></button>`;
      }).join("") +
      `<input data-search value="${escapeHtml(search)}" placeholder="Search project, PM, crew, quote…" class="input text-xs py-1.5 w-full sm:max-w-xs ml-auto">` +
      `<span data-count class="text-xs text-black/40 whitespace-nowrap"></span>`;
    filtersEl.querySelectorAll("[data-sf]").forEach((b) => b.addEventListener("click", () => { statusFilter = b.getAttribute("data-sf"); renderFilters(); applyFilter(); }));
    const sb = filtersEl.querySelector("[data-search]");
    let t = null;
    sb.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { search = sb.value.trim(); applyFilter(); }, 60); });
    if (document.activeElement?.getAttribute?.("data-search") != null) sb.focus();
  };

  const applyFilter = () => {
    const q = search.toLowerCase();
    let shown = 0;
    listEl.querySelectorAll("tr.ph-row").forEach((tr) => {
      const ok = (statusFilter === "all" || tr.getAttribute("data-status") === statusFilter)
        && (!q || (tr.getAttribute("data-key") || "").includes(q));
      tr.hidden = !ok;
      const det = tr.nextElementSibling;
      if (det && det.classList.contains("ph-detail")) det.hidden = !ok || !tr.classList.contains("open");
      if (ok) shown++;
    });
    const countEl = filtersEl.querySelector("[data-count]");
    if (countEl) countEl.textContent = `${shown.toLocaleString()} of ${all.length.toLocaleString()}`;
    const empty = listEl.querySelector("[data-empty]");
    if (empty) empty.hidden = shown > 0;
  };

  // ── collapsed row cells ──
  const scheduleCell = (p) => {
    const starts = csvList(p.all_start_dates);
    if (!starts.length) return `<span class="text-black/35">${p.operational_status === "pending" ? "Dates TBD" : "Not scheduled"}</span>`;
    const label = rangeShort(p.start_date, p.end_date);
    const more = starts.length > 1 ? `<span class="ml-1.5 inline-flex items-center text-[10px] font-bold text-blue-700 bg-blue-50 rounded px-1 py-px align-middle">+${starts.length - 1} dates</span>` : "";
    return `<span class="text-ink-900 font-medium">${escapeHtml(label)}</span>${more}`;
  };
  const teamCell = (p) => {
    const pms = csvList(p.all_project_managers), crews = csvList(p.all_work_crews);
    const chip = (n) => n > 1 ? `<span class="ml-1 inline-flex items-center text-[10px] font-bold text-blue-700 bg-blue-50 rounded px-1 py-px align-middle">+${n - 1}</span>` : "";
    const pm = pms.length ? `${escapeHtml(pms[0])}${chip(pms.length)}` : `<span class="text-black/35">No PM</span>`;
    const cr = crews.length ? `${escapeHtml(crews[0])}${chip(crews.length)}` : `<span class="text-black/35">No crew</span>`;
    return `<div class="leading-tight"><div class="text-ink-900">${pm}</div><div class="text-black/55 text-[12px]">${cr}</div></div>`;
  };
  const profitCell = (p) => {
    const pi = profitInfo(finById.get(p.qbo_customer_id));
    if (pi.pct == null) return `<span class="text-black/30">—</span>`;
    const neg = pi.pct < 0;
    const cls = neg ? "text-rose-600" : "text-emerald-700";
    return `<span class="${cls} font-semibold tabular-nums"><span class="text-[9px] align-middle">${neg ? "▾" : "▴"}</span> ${pi.pct.toFixed(1)}%</span>`;
  };
  const flagsCell = (p) => {
    const flags = deriveFlags(p, finById.get(p.qbo_customer_id), attById.get(String(p.project_qbo_id)));
    const chips = flags.map((f) => `<span class="ph-flag inline-flex items-center justify-center w-[22px] h-[22px] rounded-md border text-[12px] cursor-pointer ${FLAG_CLS[f.c]}" data-card="${f.card}" title="${escapeHtml(f.t)} — click to jump to the card">${f.i}</span>`).join("");
    return `<div class="flex gap-1 justify-end items-center flex-wrap">${chips}<span class="ph-caret text-black/35 text-[11px] ml-0.5">▸</span></div>`;
  };

  const rowHtml = (p) => {
    const att = attById.get(String(p.project_qbo_id));
    const hasAtt = deriveFlags(p, finById.get(p.qbo_customer_id), att).some((f) => f.c === "bad" || f.c === "warn");
    const open = openSet.has(String(p.project_qbo_id));
    return `
      <tr class="ph-row border-b border-black/5 hover:bg-black/[0.02] cursor-pointer ${open ? "open bg-black/[0.02]" : ""} ${hasAtt ? "ph-att" : ""}"
          data-qid="${escapeHtml(String(p.project_qbo_id))}" data-status="${escapeHtml(p.operational_status || "")}" data-key="${escapeHtml(searchKey(p))}">
        <td class="py-2 pl-3 pr-3 align-top">${statusBadge(p.operational_status)}</td>
        <td class="py-2 pr-3 align-top">
          <div class="font-semibold text-ink-900 leading-tight">${escapeHtml(dash(p.project_name))}</div>
          <div class="text-[11.5px] text-black/40 mt-0.5">Quote <span class="text-blue-700 font-semibold">${p.linked_quote_number ? "#" + escapeHtml(String(p.linked_quote_number)) : "—"}</span> · 📎 ${p.file_count || 0}</div>
        </td>
        <td class="py-2 pr-3 align-top text-[12.5px]">${scheduleCell(p)}</td>
        <td class="py-2 pr-3 align-top text-[12.5px]">${teamCell(p)}</td>
        <td class="py-2 pr-3 align-top text-right tabular-nums font-semibold text-black/75">${money(finVal(p) || null)}</td>
        <td class="py-2 pr-3 align-top text-right">${profitCell(p)}</td>
        <td class="py-2 pr-3 align-top">${flagsCell(p)}</td>
      </tr>
      <tr class="ph-detail" data-qid="${escapeHtml(String(p.project_qbo_id))}" ${open ? "" : "hidden"}>
        <td colspan="7" class="bg-black/[0.015] border-b border-black/10 px-3 py-3">
          <div class="ph-detail-body" data-qid="${escapeHtml(String(p.project_qbo_id))}">${open && cardCache.has(String(p.project_qbo_id)) ? detailHtml(p, cardCache.get(String(p.project_qbo_id))) : `<div class="text-black/40 text-xs py-4">Loading…</div>`}</div>
        </td>
      </tr>`;
  };

  // ── expanded detail cards ──
  const box = (pid, key, title, srcTag, inner, flag) => {
    const badge = srcTag ? `<span class="ml-auto text-[9px] font-bold tracking-wide px-1.5 py-px rounded ${srcTag === "NEW" ? "text-violet-700 bg-violet-50" : "text-emerald-700 bg-emerald-50"}">${srcTag}</span>` : "";
    const cf = flag ? `<span class="inline-flex items-center justify-center w-[18px] h-[18px] rounded text-[11px] border ${FLAG_CLS[flag.c]}" title="${escapeHtml(flag.t)}">${flag.i}</span>` : "";
    const acc = flag ? `border-l-2 ${ACCENT[flag.c]}` : "";
    return `<div class="ph-card bg-white border border-black/10 rounded-lg p-3 ${acc}" data-card="${key}" id="phc-${pid}-${key}">
      <div class="flex items-center gap-1.5 mb-2 text-[10px] font-bold uppercase tracking-wide text-black/40">${cf}<span>${title}</span>${badge}</div>${inner}</div>`;
  };
  const kv = (k, v) => `<div class="flex justify-between gap-3 py-0.5 text-[12.5px] border-b border-black/[0.05] last:border-0"><span class="text-black/55">${k}</span><span class="font-semibold text-ink-900 text-right">${v}</span></div>`;

  const detailHtml = (p, c) => {
    if (!c) return `<div class="text-black/40 text-xs py-4">Loading…</div>`;
    const flags = deriveFlags(p, finById.get(p.qbo_customer_id), attById.get(String(p.project_qbo_id)));
    const fb = {}; flags.forEach((f) => { if (f.card && !fb[f.card]) fb[f.card] = f; });

    const dates = (c.date_ranges && c.date_ranges.length)
      ? `<div class="flex flex-wrap gap-1.5">${c.date_ranges.map((d) => `<span class="text-[11.5px] font-semibold px-2 py-0.5 rounded border border-black/10 bg-black/[0.02] text-black/60">${escapeHtml(rangeShort(d.start, d.end))}</span>`).join("")}</div>`
      : `<div class="text-black/35 text-[12.5px]">No dates assigned yet</div>`;
    const team = kv("Project managers", c.pms.length ? c.pms.map(escapeHtml).join(", ") : "—")
               + kv("Work crews", c.crews.length ? c.crews.map(escapeHtml).join(", ") : "—");
    const shared = kv("Wire", money(c.shared.wire)) + kv("Travel", money(c.shared.travel))
                 + kv("Overage", money(c.shared.overage)) + kv("Equipment", money(c.shared.equipment));
    const estPill = (n, label, cls) => n ? `<span class="text-[11.5px] font-semibold px-2 py-0.5 rounded border ${cls}">${n} ${label}</span>` : "";
    const eb = c.estimates.reduce((m, e) => { m[e.status] = (m[e.status] || 0) + 1; return m; }, {});
    const ests = `<div class="flex flex-wrap gap-1.5 mb-2">
        ${estPill(c.estimates.length, "total", "bg-sky-50 text-sky-700 border-sky-200")}
        ${estPill(eb.pending, "pending", "bg-amber-50 text-amber-700 border-amber-200")}
        ${estPill(eb.accepted, "accepted", "bg-emerald-50 text-emerald-700 border-emerald-200")}
        ${estPill(eb.declined, "declined", "bg-black/[0.03] text-black/45 border-black/10")}</div>
      ${c.estimates.slice(0, 6).map((e) => `<div class="flex justify-between text-[12px] py-0.5 border-b border-black/[0.05] last:border-0"><span class="text-black/55">#${escapeHtml(String(e.doc || "—"))} <span class="text-black/35">· ${escapeHtml(e.status)}</span></span><span class="tabular-nums font-semibold">${money(e.amount)}</span></div>`).join("")}`;
    const o = c.offer;
    const offerInner = o.state === "none"
      ? kv("Crew offer", `<span class="text-black/40">Not sent</span>`)
      : kv("Crew offer", `<span class="${o.state === "accepted" ? "text-emerald-700" : "text-amber-700"}">${escapeHtml(o.state)}</span>`)
        + (o.crew_name ? kv("Crew", escapeHtml(o.crew_name)) : "")
        + (o.age_days != null ? kv("Age", `${o.age_days} day${o.age_days === 1 ? "" : "s"} ago`) : "")
        + (o.labor ? kv("Labor", money(o.labor)) : "");
    const f = c.financial || {};
    const pct = (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
    const financial = kv("Estimate", money(f.estimate_line_amt)) + kv("Invoiced", money(f.invoice_line_amt))
                    + kv("Expenses", money(f.expense_line_amt)) + kv("Open A/R", money(f.balance_amt))
                    + kv("Profit", `${money(f.actual_profit != null ? f.actual_profit : f.projected_profit)} · ${pct(f.actual_profit_pct != null ? f.actual_profit_pct : f.projected_profit_pct)}`);
    const notes = c.notes && c.notes.length
      ? `<div class="text-[12.5px] text-black/55 italic leading-relaxed space-y-1">${c.notes.map((n) => `<div>“${escapeHtml(n)}”</div>`).join("")}</div>`
      : `<div class="text-black/35 text-[12.5px]">No notes</div>`;

    return `
      <div class="flex items-center gap-2 mb-2">
        <a href="#/entity/project/${escapeHtml(String(p.project_qbo_id))}" class="ph-open text-[12px] font-bold text-white bg-ink-900 hover:bg-black rounded-lg px-3 py-1.5">Open project workspace →</a>
        <span class="text-[11.5px] text-black/40">quote #${escapeHtml(String(p.linked_quote_number || "—"))}</span>
      </div>
      <div class="grid gap-2.5" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));">
        ${box(p.project_qbo_id, "schedule", "Schedule — all ranges", "LIVE", dates, fb.schedule)}
        ${box(p.project_qbo_id, "team", "Team", "LIVE", team, fb.team)}
        ${box(p.project_qbo_id, "shared", "Shared costs", "LIVE", shared, fb.shared)}
        ${box(p.project_qbo_id, "estimates", "Estimates", "LIVE", ests, fb.estimates)}
        ${box(p.project_qbo_id, "offer", "Crew offer", "LIVE", offerInner, fb.offer)}
        ${box(p.project_qbo_id, "financial", "Financials", "LIVE", financial, fb.financial)}
        ${box(p.project_qbo_id, "notes", "Notes", "LIVE", notes, fb.notes)}
      </div>`;
  };

  const renderList = () => {
    if (!all.length) { listEl.innerHTML = `<div class="text-black/45 py-4">No projects found.</div>`; return; }
    const rows = sortedAll();
    listEl.innerHTML = `
      <table class="w-full text-sm" style="min-width:940px;">
        <thead class="sticky top-0 z-10 bg-white text-left text-black/45"><tr class="border-b border-black/10">
          ${HEADERS.map((h) => `<th class="py-2 px-3 font-bold ${h.key ? "cursor-pointer select-none hover:text-black/70" : ""} bg-white whitespace-nowrap ${h.align === "right" ? "text-right" : ""}" ${h.key ? `data-sort="${h.key}"` : ""}>${h.label}${arrow(h.key)}</th>`).join("")}
        </tr></thead>
        <tbody>${rows.map(rowHtml).join("")}</tbody>
      </table>
      <div data-empty hidden class="text-black/45 py-4">No projects match.</div>`;
    listEl.querySelectorAll("[data-sort]").forEach((th) => th.addEventListener("click", () => onHeaderClick(th.getAttribute("data-sort"))));
    applyFilter();
  };

  // ── expand / collapse + flag→card jump ──
  const byQid = (qid) => all.find((p) => String(p.project_qbo_id) === String(qid));
  const loadCard = async (qid) => {
    if (cardCache.has(qid)) return cardCache.get(qid);
    const c = await api(`/projects/${encodeURIComponent(qid)}/card`);
    cardCache.set(qid, c);
    return c;
  };
  const renderDetailInto = (qid) => {
    const bodyEl = listEl.querySelector(`.ph-detail-body[data-qid="${CSS.escape(qid)}"]`);
    if (bodyEl) bodyEl.innerHTML = detailHtml(byQid(qid), cardCache.get(qid));
  };
  const pulseCard = (qid, key) => {
    const el = document.getElementById(`phc-${qid}-${key}`);
    if (!el) return;
    el.classList.remove("ring-2", "ring-indigo-400");
    void el.offsetWidth;
    el.classList.add("ring-2", "ring-indigo-400");
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => el.classList.remove("ring-2", "ring-indigo-400"), 1100);
  };
  const expand = async (row, qid, jumpCard) => {
    row.classList.add("open"); row.classList.add("bg-black/[0.02]");
    openSet.add(qid);
    const det = row.nextElementSibling;
    if (det && det.classList.contains("ph-detail")) det.hidden = false;
    if (!cardCache.has(qid)) {
      try { await loadCard(qid); } catch (_) { const b = det && det.querySelector(".ph-detail-body"); if (b) b.innerHTML = `<div class="text-rose-600 text-xs py-3">Couldn't load project detail.</div>`; return; }
    }
    renderDetailInto(qid);
    if (jumpCard) requestAnimationFrame(() => pulseCard(qid, jumpCard));
  };
  const collapse = (row, qid) => {
    row.classList.remove("open"); row.classList.remove("bg-black/[0.02]");
    openSet.delete(qid);
    const det = row.nextElementSibling;
    if (det && det.classList.contains("ph-detail")) det.hidden = true;
  };

  listEl.addEventListener("click", (e) => {
    // keep the "Open project workspace" link behaving as navigation (+ back link)
    const open = e.target.closest("a.ph-open, a[href^='#/entity/project/']");
    if (open) { setBack(decodeURIComponent(open.getAttribute("href").split("/").pop())); return; }
    const row = e.target.closest("tr.ph-row");
    if (!row) return;
    const qid = row.getAttribute("data-qid");
    const flag = e.target.closest(".ph-flag");
    if (flag) { // always open + jump; never collapse
      if (!row.classList.contains("open")) expand(row, qid, flag.getAttribute("data-card"));
      else { if (cardCache.has(qid)) requestAnimationFrame(() => pulseCard(qid, flag.getAttribute("data-card"))); }
      return;
    }
    if (row.classList.contains("open")) collapse(row, qid);
    else expand(row, qid);
  });

  // Load the project list first (fast); merge financials + attention when ready.
  try {
    const d = await api("/projects/basic");
    all = d.projects || [];
  } catch (e) {
    listEl.innerHTML = `<div class="text-red-700 text-sm">Failed to load projects.</div>`;
    return;
  }
  renderFilters();
  renderList();
  sizeCard();
  requestAnimationFrame(sizeCard);

  api("/projects/financials")
    .then((d) => { finById = new Map((d.financials || []).map((f) => [f.qbo_customer_id, f])); renderList(); })
    .catch(() => {});
  api("/projects/attention")
    .then((d) => { attById = new Map(Object.entries(d.attention || {})); renderList(); })
    .catch(() => {});
}
