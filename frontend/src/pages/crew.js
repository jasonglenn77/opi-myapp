// Crew Portal — wired to the real crew hierarchy with per-level metrics.
// Three levels:
//   overview  (#/crew)                                  parents + expandable child crews (metrics)
//   child     (#/crew/child/<id>)                       one child crew: metrics + its projects
//   project   (#/crew/child/<id>/project/<pid>)         foreman view, with "up" to the child crew
// Entry depth depends on role (backend scopes /crew/hierarchy).
import { api, getMe } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml } from "../utils/html.js";
import { foremanDetailHtml } from "./crew-foreman.js";

export async function crewPortalPage(routeFn, params = null) {
  const role = getMe()?.role || "";
  const isForeman = role === "crew_foreman";

  let data;
  try {
    data = await api("/crew/hierarchy");
  } catch (e) {
    mount(`<div class="mx-auto w-full max-w-2xl"><div class="card p-5 text-sm text-red-700">Failed to load crews: ${escapeHtml(e.message || e)}</div></div>`, routeFn);
    return;
  }
  const parents = data.parents || [];

  // ---- helpers ----
  const fmtDate = (d) => (d ? String(d).slice(0, 10) : "");
  const chip = (cls, txt) => `<span class="inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-bold ${cls}">${txt}</span>`;
  const statusBadge = (s) => {
    if (!s) return "";
    const map = { in_progress: "bg-blue-100 text-blue-700", not_started: "bg-violet-100 text-violet-700", needs_attention: "bg-amber-100 text-amber-700", completed: "bg-emerald-50 text-emerald-700" };
    return chip(map[s] || "bg-black/5 text-black/50", escapeHtml(s));
  };
  const metricChips = (m) => `
    <div class="flex flex-wrap gap-1.5 mt-1">
      ${m.active ? chip("bg-blue-100 text-blue-700", m.active + " active") : ""}
      ${m.upcoming ? chip("bg-violet-100 text-violet-700", m.upcoming + " upcoming") : ""}
      ${m.completed ? chip("bg-black/5 text-black/50", m.completed + " completed") : ""}
      ${!m.project_count ? chip("bg-black/5 text-black/40", "no projects") : ""}
    </div>`;
  const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
  const statBox = (label, a, av, b, bv, note) => `
    <div class="rounded-xl border border-black/10 bg-black/[0.02] p-3">
      <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">${label}</div>
      <div class="grid grid-cols-2 gap-2 text-center">
        <div><div class="text-base font-extrabold">${money(a)}</div><div class="text-[10px] text-black/40">${av}</div></div>
        <div><div class="text-base font-extrabold text-emerald-700">${money(b)}</div><div class="text-[10px] text-black/40">${bv}</div></div>
      </div>
      ${note ? `<div class="text-[10px] text-black/40 text-center mt-1">${note}</div>` : ""}
    </div>`;
  // Child crew earnings = contractor bills tied to THEIR projects (project-attributed).
  // Cash paid / open bills exist only at the vendor (parent) level — payments aren't
  // tagged per crew in QuickBooks — so the child shows the job-costed billing only.
  const childEarnings = (e) => e ? statBox(
    "Crew earnings · job-costed to projects", e.total, "Total billed", e.ytd, "This year",
    "From contractor bills tagged to this crew's projects · cash paid is tracked at the company level") : "";
  // Parent = actual cash paid to the vendor (company), with the attributed portion noted.
  const parentEarnings = (e) => {
    if (!e) return "";
    if (!e.mapped) {
      return `<div class="rounded-xl border border-dashed border-black/15 p-3 text-center">
        <div class="text-[11px] font-bold uppercase tracking-wide text-black/40">Paid by OPI</div>
        <div class="text-xs text-black/35 mt-1">Not linked to a QuickBooks vendor yet.${role === "admin" ? " Link it on the Teams page." : ""}</div>
      </div>`;
    }
    const note = `${money(e.attributed_total)} billed to specific projects/crews`
      + (e.open_bills ? `<br><span class="text-amber-700 font-semibold">${money(e.open_bills)} billed but not yet paid</span>` : "");
    return statBox("Paid by OPI · all crews", e.total_paid, "Total cash paid", e.ytd_paid, "Paid this year", note);
  };

  const findChild = (childId) => {
    for (const p of parents) {
      const c = (p.children || []).find(x => String(x.id) === String(childId));
      if (c) return { child: c, parent: p };
    }
    return null;
  };

  const projectRow = (childId, pr) => `
    <a href="#/crew/child/${childId}/project/${pr.qbo_customer_id}" class="flex items-center justify-between gap-3 py-2 px-2 hover:bg-black/[0.02] rounded-lg">
      <div class="min-w-0">
        <div class="text-sm font-semibold text-ink-900 truncate">${escapeHtml(pr.project_name || "(unnamed)")}</div>
        <div class="text-[11px] text-black/40">${fmtDate(pr.start_date)}${pr.end_date ? " – " + fmtDate(pr.end_date) : ""} ${statusBadge(pr.status)}</div>
      </div>
      <div class="text-right shrink-0">
        ${pr.earnings && pr.earnings.total ? `<div class="text-sm font-bold text-ink-900">${money(pr.earnings.total)}</div>` : ""}
        ${pr.earnings && pr.earnings.ytd ? `<div class="text-[10px] font-bold text-emerald-600">${money(pr.earnings.ytd)} this yr</div>` : ""}
        <div class="text-xs font-semibold text-blue-600">Open →</div>
      </div>
    </a>`;

  // ── PROJECT (foreman) level ───────────────────────────────────────────────
  if (params && params.projectId) {
    const found = findChild(params.childId);
    const pr = found ? (found.child.projects || []).find(x => String(x.qbo_customer_id) === String(params.projectId)) : null;
    const crewName = found ? found.child.name : "crew";
    const label = pr ? pr.project_name : `Project ${params.projectId}`;
    mount(`
      <div class="mx-auto w-full max-w-2xl grid grid-cols-1 gap-3 pb-3">
        <div><a href="#/crew/child/${params.childId}" class="text-xs font-semibold text-blue-600 hover:text-blue-800">← ${escapeHtml(crewName)} · other projects</a></div>
        ${foremanDetailHtml(label)}
        <div class="text-center text-[11px] text-black/30 pt-1">Skeleton — capture forms &amp; S3 uploads wired after feedback.</div>
      </div>`, routeFn);
    return;
  }

  // ── CHILD crew portal ─────────────────────────────────────────────────────
  const renderChild = (found, { showUp }) => {
    const { child, parent } = found;
    const projs = child.projects || [];
    const up = showUp ? `<div><a href="#/crew" class="text-xs font-semibold text-blue-600 hover:text-blue-800">← All crews</a></div>` : "";
    mount(`
      <div class="mx-auto w-full max-w-2xl grid grid-cols-1 gap-3 pb-3">
        ${up}
        <div class="card p-4">
          <div class="text-[11px] text-black/40">${escapeHtml(parent.name)}</div>
          <div class="text-lg font-extrabold">${escapeHtml(child.name)}</div>
          ${metricChips(child.metrics)}
          <div class="mt-2">${childEarnings(child.earnings)}</div>
        </div>
        <div class="card p-2">
          <div class="px-2 py-1 text-xs font-bold uppercase tracking-wide text-black/40">Projects (${projs.length})</div>
          <div class="divide-y divide-black/5">
            ${projs.length ? projs.map(pr => projectRow(child.id, pr)).join("") : `<div class="text-sm text-black/35 italic px-2 py-3">No projects.</div>`}
          </div>
        </div>
        <div class="text-center text-[11px] text-black/30 pt-1">Open a project for its foreman daily-execution view (skeleton).</div>
      </div>`, routeFn);
  };

  if (params && params.childId) {
    const found = findChild(params.childId);
    if (!found) { mount(`<div class="mx-auto w-full max-w-2xl"><div class="card p-5 text-sm text-black/50">Crew not found.</div></div>`, routeFn); return; }
    renderChild(found, { showUp: !isForeman });
    return;
  }

  // No params: a foreman lands directly on their own crew portal.
  if (isForeman) {
    const myChild = parents[0]?.children?.[0];
    if (myChild) { renderChild({ child: myChild, parent: parents[0] }, { showUp: false }); return; }
    mount(`<div class="mx-auto w-full max-w-2xl"><div class="card p-5 text-sm text-black/50">No crew assigned to your login yet.</div></div>`, routeFn);
    return;
  }

  // ── OVERVIEW: parents → child crews ───────────────────────────────────────
  const childBlock = (child) => `
    <details class="rounded-xl border border-black/10">
      <summary class="flex items-center justify-between gap-3 px-3 py-2 cursor-pointer list-none">
        <div class="min-w-0">
          <div class="text-sm font-extrabold text-ink-900">${escapeHtml(child.name)}</div>
          ${metricChips(child.metrics)}
          ${child.earnings && child.earnings.total ? `<div class="text-[11px] text-black/50 mt-0.5">Earned: <span class="font-bold">${money(child.earnings.total)}</span> · YTD ${money(child.earnings.ytd)}</div>` : ""}
        </div>
        <span class="text-black/30 text-xs shrink-0">▸</span>
      </summary>
      <div class="px-2 pb-2">
        <a href="#/crew/child/${child.id}" class="block text-xs font-semibold text-blue-600 hover:text-blue-800 px-2 py-2">Open crew portal →</a>
        <div class="divide-y divide-black/5">
          ${(child.projects || []).length ? child.projects.map(pr => projectRow(child.id, pr)).join("") : `<div class="text-xs text-black/35 italic px-2 py-2">No projects.</div>`}
        </div>
      </div>
    </details>`;

  const crewStat = (m) => {
    const parts = [];
    if (m.crews_active) parts.push(`<b>${m.crews_active}</b> active`);
    if (m.crews_upcoming) parts.push(`<b>${m.crews_upcoming}</b> upcoming`);
    if (m.crews_idle) parts.push(`${m.crews_idle} idle`);
    return `${m.child_count} crews — ${parts.join(" · ") || "—"} · ${m.project_count} projects`;
  };
  const parentBlock = (p) => {
    const m = p.metrics;
    return `
    <details class="card p-0 overflow-hidden">
      <summary class="px-4 py-3 cursor-pointer list-none">
        <div class="flex flex-col lg:flex-row lg:items-center lg:gap-6">
          <div class="min-w-0 lg:flex-1">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="text-base font-extrabold">${escapeHtml(p.name)}</div>
                <div class="text-[11px] text-black/40">${crewStat(m)}</div>
                ${metricChips(m)}
              </div>
              <span class="text-black/30 text-xs shrink-0 lg:hidden">▸ expand</span>
            </div>
          </div>
          <div class="mt-2 lg:mt-0 lg:shrink-0 lg:w-96 flex items-center gap-3">
            <div class="flex-1 min-w-0">${parentEarnings(p.earnings)}</div>
            <span class="text-black/30 text-xs shrink-0 hidden lg:inline">▸</span>
          </div>
        </div>
      </summary>
      <div class="px-4 pb-4">
        <div class="space-y-2">
          ${(p.children || []).length ? p.children.map(childBlock).join("") : `<div class="text-xs text-black/35 italic">No crews.</div>`}
        </div>
      </div>
    </details>`;
  };

  const scopeNote = data.scope === "all" ? "All crew parents." : "Your crews.";
  mount(`
    <div class="mx-auto w-full max-w-2xl grid grid-cols-1 gap-3 pb-3">
      <div class="card p-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-lg font-extrabold">Crew Portal</div>
            <div class="text-xs text-black/50">${scopeNote} Expand a parent for crew metrics → open a crew → open a project.</div>
          </div>
          <span class="inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-700">Preview</span>
        </div>
      </div>
      ${parents.length ? parents.map(parentBlock).join("") : `<div class="card p-5 text-sm text-black/50">No crews found.</div>`}
    </div>`, routeFn);
}

function mount(bodyHtml, routeFn) {
  setShell({ title: "", subtitle: "", bodyHtml, showLogout: true, routeFn });
  const pageTitleBlock = document.getElementById("pageTitle")?.closest(".mb-5");
  if (pageTitleBlock && pageTitleBlock.style.display !== "none") {
    pageTitleBlock.style.display = "none";
    window.addEventListener("hashchange", () => { if (pageTitleBlock) pageTitleBlock.style.display = ""; }, { once: true });
  }
}
