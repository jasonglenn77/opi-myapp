// Assignments page, retired 2026-11-16 (owner): the office sets up and updates
// jobs on Project Setup and finishes them on Project Closeout; All Projects is
// for a project's history and the odd edit. The old sheet (assignment.js) is
// kept in the code but no longer routed; #/assignment shows where things went.
import { setShell } from "../shell.js";

const WHERE = [
  ["New jobs, and any job a change sent back", "Project Setup → To do", "PM, crew offer, dates, job details, and the invoice / crew / expense schedules, step by step.", "#/setup"],
  ["Any live job (change dates, crew, PM, details)", "Project Setup → All active", "Open the job and edit the Assignment part in place. Date changes ask why and whether a change order is needed.", "#/setup"],
  ["Finished jobs", "Project Closeout", "Final invoice, crew paid, expenses, paperwork, then close the books.", "#/closeout"],
  ["A project's history, or an older job", "All Projects", "Open the project and use its Assignment tab; every change is kept in its history.", "#/projects"],
  ["Who's busy when", "Schedules", "The month calendar of every job and crew.", "#/schedule"],
];

export function assignmentRetiredPage(routeFn) {
  setShell({
    title: "Assignments",
    subtitle: "This page has moved. Set up and update jobs on Project Setup; look up a project's history on All Projects.",
    bodyHtml: `
      <div class="card p-6 grid gap-4" style="max-width:760px">
        <div>
          <div class="text-lg font-extrabold text-ink-900">The Assignments page has been retired</div>
          <p class="text-sm text-black/60 mt-1">Everything it did now lives on the pages below, next to the rest of each job's setup and closeout.</p>
        </div>
        <div class="grid gap-2">
          ${WHERE.map(([what, where, how, href]) => `
            <a href="${href}" class="ar-row">
              <div class="min-w-0">
                <div class="text-[13px] font-bold text-ink-900">${what}</div>
                <div class="text-xs text-black/55">${how}</div>
              </div>
              <span class="ar-go">${where.replace(" → ", ": ")} →</span>
            </a>`).join("")}
        </div>
        <div class="flex flex-wrap gap-2">
          <a href="#/setup" class="btn-primary text-sm px-4 py-2">Go to Project Setup</a>
          <a href="#/projects" class="pd-btn">Go to All Projects</a>
        </div>
      </div>`,
    routeFn,
  });
}
