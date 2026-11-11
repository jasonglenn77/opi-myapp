// Foreman daily-execution view — the deepest level of the Crew Portal.
// Exports an HTML fragment (not a full page) so crew.js can render it under a
// breadcrumb. SKELETON: photo/video zones mark where S3 uploads will go.
// Structure follows "OPI PM & Crew Application Notes.docx".

export function foremanDetailHtml(projectLabel = "Your assigned project") {
  const section = (title, sourceTag, inner) => `
    <div class="card p-4">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="text-base font-extrabold">${title}</div>
        ${sourceTag ? `<span class="shrink-0 inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold bg-amber-100 text-amber-700">${sourceTag}</span>` : ""}
      </div>
      ${inner}
    </div>`;
  const drop = (icon, label) => `
    <div class="rounded-2xl border-2 border-dashed border-black/15 p-4 text-center text-black/35">
      <div class="text-2xl leading-none mb-1">${icon}</div>
      <div class="text-xs font-semibold">${label}</div>
      <div class="text-[10px] text-black/30">Tap to capture / upload · S3</div>
    </div>`;
  const info = (label) => `
    <div class="flex items-center justify-between gap-3 py-2 border-b border-black/5 last:border-b-0">
      <span class="text-xs font-semibold text-black/50">${label}</span>
      <span class="text-sm text-black/30">—</span>
    </div>`;
  const formItem = (label, sub) => `
    <div class="rounded-xl border border-black/10 px-3 py-2">
      <div class="text-sm font-semibold text-black/50">${label}</div>
      ${sub ? `<div class="text-[11px] text-black/35">${sub}</div>` : ""}
    </div>`;

  return `
      <div class="card p-4">
        <div class="text-lg font-extrabold">Foreman — Daily Execution</div>
        <div class="text-xs text-black/50">${projectLabel}</div>
      </div>

      ${section("Active Project", "Project data + new fields", `
        ${["Project drawings & info (kickoff checklist)", "Project address", "Hotel address", "Onsite contact information", "Access / equipment codes", "Anchor information", "Propane refill dates"].map(info).join("")}
        <button class="mt-3 w-full rounded-xl border border-black/15 px-3 py-2 text-sm font-semibold text-black/40">View drawings (PDF)</button>
      `)}

      ${section("Day One — Project Kickoff Form", "S3 photos + report", `
        <div class="grid grid-cols-2 gap-2 mb-2">
          ${drop("📷", "Facility & work area — before")}
          ${drop("📷", "Equipment — confirm working")}
        </div>
        ${formItem("Report facility damage or product in our work area", "Notes + photos")}
        <button class="btn-primary w-full mt-3 opacity-50 cursor-not-allowed" disabled>Submit kickoff</button>
      `)}

      ${section("Daily Update — media capture", "S3 (future)", `
        <div class="text-[11px] text-black/45 mb-2">The daily requirements checklist is above. These media captures attach to the daily update (wired after feedback).</div>
        <div class="space-y-2">
          ${drop("🎥", "30–60s progress video")}
          ${formItem("Project drawing PDF — mark progress")}
          ${formItem("Anchoring submission", "Video: drill, vacuum, insert, torque, test")}
          ${formItem("Wire guidance form", "Videos: expansion joint, cut depth, loop continuity (ohms), epoxy machine cleaned")}
          ${formItem("BOL / truck unloading", "Photo of materials on truck · BOL scan · report damage/shortage w/ photos")}
        </div>
      `)}

      ${section("Equipment & Propane Service Request", "S3 + new form", `
        <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">Equipment</div>
        <div class="space-y-2 mb-3">
          ${drop("📷", "Photo of Asset #")}
          ${formItem("Description of problem", "Attach video")}
          ${formItem("Urgency rating", "1 – 5")}
          ${formItem("Socks & diapers", "Request more if needed")}
        </div>
        <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">Propane</div>
        <div class="space-y-2">
          ${formItem("# of tanks left")}
          ${formItem("Urgency rating", "1 – 5")}
          ${formItem("Cage lock combo")}
        </div>
      `)}

      ${section("Project Completion Form", "S3 media + signature", `
        <div class="grid grid-cols-2 gap-2 mb-2">
          ${drop("📷", "Min. 10 completion photos")}
          ${drop("🎥", "1 completion video")}
          ${drop("📷", "Equipment ready for pickup")}
          ${drop("🎥", "Anchor torque video")}
        </div>
        ${formItem("Wire guidance continuity testing video")}
        ${formItem("Signed completion form", "Customer signature")}
        <button class="btn-primary w-full mt-3 opacity-50 cursor-not-allowed" disabled>Submit completion</button>
      `)}

      ${section("Completed Projects", "Submission records", `
        <div class="text-sm text-black/35 italic">Record of daily-update submissions &amp; completion forms will appear here.</div>
      `)}

      <div class="card p-4 bg-amber-50/40">
        <div class="text-sm font-extrabold mb-1">Daily updates due Sun–Thu by 7:00 PM</div>
        <div class="text-[11px] text-black/50">Reminders (future — notifications): foreman @ 6:30 PM · PM &amp; crew boss @ 9:00 PM if no update · final @ 7:00 AM next day.</div>
      </div>`;
}

// ── Live foreman view (replaces the skeleton above) ──────────────────────────
// One project as the crew lead needs it: dates, site details, PM and crews, the
// crew forms on file and the crew documents. No money. Data: GET /api/crew/project/{qbo}/foreman.
import { api } from "../api.js";
import { escapeHtml as escF } from "../utils/html.js";
import { day as dayF } from "../utils/ui.js";

export async function mountForeman(host, qboId) {
  host.innerHTML = `<div class="card p-4 text-sm text-black/45">Loading the job…</div>`;
  let d;
  try { d = await api(`/crew/project/${encodeURIComponent(qboId)}/foreman`); }
  catch (e) { host.innerHTML = `<div class="card p-4 text-sm text-rose-700">Couldn't load the job: ${escF(e?.message || "")}</div>`; return; }
  const row = (k, v) => `<div class="flex items-start justify-between gap-3 py-2 border-b border-black/5 last:border-b-0"><span class="text-xs font-semibold text-black/50">${k}</span><span class="text-sm text-ink-900 text-right">${v}</span></div>`;
  const yesno = (v) => (v ? "Yes" : "No");
  const items = d.items.length ? d.items : [{}];
  const formGroups = (d.form_files || []).map((g) => `
    <div class="rounded-xl border border-black/10 px-3 py-2">
      <div class="flex items-center justify-between gap-2"><span class="text-sm font-semibold text-ink-900">${escF(g.label)}</span>
        <span class="text-xs font-bold ${g.files.length ? "text-emerald-700" : "text-black/40"}">${g.files.length ? `${g.files.length} on file` : "None yet"}</span></div>
      ${g.files.slice(0, 3).map((f) => `<div class="text-[11px] text-black/55 truncate">${escF(f.name)}${f.draft ? " (draft)" : ""}${f.date ? ` · ${dayF(f.date)}` : ""}</div>`).join("")}
    </div>`).join("");
  const portalForms = d.forms.length ? d.forms.map((f) => `<span class="inline-flex text-xs font-semibold rounded-full border border-black/10 px-2 py-0.5 mr-1 mb-1">${escF(f.code.replace(/_/g, " "))}: ${f.count}${f.red_flags ? ` · <span class="text-rose-700">&nbsp;${f.red_flags} red flag${f.red_flags === 1 ? "" : "s"}</span>` : ""}</span>`).join("") : `<span class="text-sm text-black/45">Nothing submitted in the crew portal yet.</span>`;
  host.innerHTML = `
    ${items.map((i, n) => `<div class="card p-4">
      <div class="flex items-start justify-between gap-3 mb-1"><div class="text-base font-extrabold text-ink-900">${n === 0 ? escF(d.name) : `Phase ${n + 1}`}</div>
        <span class="text-xs font-bold text-black/55">${escF((i.status || "").replace(/_/g, " "))}</span></div>
      ${row("Dates", i.start ? `${dayF(i.start)} to ${dayF(i.end)}` : "Not set")}
      ${row("PM", escF(i.pms || "—"))}${row("Crew", escF(i.crews || "—"))}
      ${row("Travel days", i.travel_days ?? "—")}${row("Overage days", i.overage_days ?? "—")}
      ${row("Wire guidance", i.wire_guidance == null ? "—" : yesno(i.wire_guidance))}${row("Equipment", escF(i.equipment || "—"))}
      ${i.days_off ? row("Days off", escF(String(i.days_off))) : ""}${i.notes ? row("Notes", escF(i.notes)) : ""}
    </div>`).join("")}
    <div class="card p-4"><div class="text-base font-extrabold text-ink-900 mb-2">Crew forms</div>
      <div class="mb-2">${portalForms}</div><div class="grid gap-2 sm:grid-cols-2">${formGroups}</div>
      <div class="text-[11px] text-black/45 mt-2">Crews submit forms at the field link (#/field) with their passcode; forms filed in the job's Drive folder count too.</div></div>
    <div class="card p-4"><div class="text-base font-extrabold text-ink-900 mb-2">Crew documents</div>
      ${d.documents.length ? d.documents.map((x) => `<button type="button" class="block w-full text-left text-sm font-semibold text-brand-600 hover:underline py-1 truncate" data-doc="${x.id}">${escF(x.name)}</button>`).join("") : `<div class="text-sm text-black/45">No crew documents yet.</div>`}</div>`;
  host.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", async () => {
    const r = await api(`/documents/file/${b.dataset.doc}/url`);
    window.open(r.url, "_blank", "noopener");
  }));
}
