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

      ${section("Daily Update Submission", "S3 media + new forms", `
        <div class="space-y-2">
          ${drop("🎥", "30–60s progress video")}
          ${formItem("Project drawing PDF — mark progress")}
          ${formItem("Daily toolbox talk form")}
          ${formItem("Anchoring submission", "Video: drill, vacuum, insert, torque, test")}
          ${formItem("Wire guidance form", "Videos: expansion joint, cut depth, loop continuity (ohms), epoxy machine cleaned")}
          ${formItem("Safety forms", "Client-specific")}
          ${formItem("Daily equipment checklist")}
          ${formItem("BOL / truck unloading", "Photo of materials on truck · BOL scan · report damage/shortage w/ photos")}
        </div>
        <button class="btn-primary w-full mt-3 opacity-50 cursor-not-allowed" disabled>Review &amp; submit daily update</button>
        <div class="text-[11px] text-black/40 mt-2">Forms are customizable to the scope of work / requirements.</div>
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
