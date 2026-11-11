// Help pages:
//   #/help-mine   what I've sent (bugs, ideas, questions) and the replies
//   #/help-admin  staff (users.manage): triage feedback, write "What's new" notes
import { api, hasCapability } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml as esc } from "../utils/html.js";
import { chip, C, tabs, day, empty } from "../utils/ui.js";
import { openFeedback, toast, startTour } from "../utils/help.js";
import { TOURS } from "../utils/tours.js";

const KIND = { bug: ["Bug", C.bad], idea: ["Idea", C.info], question: ["Question", C.warn] };
const STATUS = { new: ["New", C.warn], in_progress: ["Working on it", C.info], answered: ["Answered", C.good], closed: ["Closed", C.quiet] };
const when = (s) => s ? new Date(s + "Z").toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";

export async function helpMinePage(routeFn) {
  setShell({ title: "My feedback", subtitle: "Bugs, ideas and questions you've sent, and the replies.", routeFn,
    bodyHtml: `<div class="flex flex-wrap gap-2 mb-4"><button type="button" class="btn-primary" id="hmNew">Send feedback</button><button type="button" class="btn-outline" id="hmTour">Tour the app</button></div><div id="hmBody"><div class="card p-6 text-sm text-black/50">Loading…</div></div>` });
  document.getElementById("hmNew").onclick = () => openFeedback();
  document.getElementById("hmTour").onclick = () => startTour("app");
  const r = await api("/help/feedback/mine");
  const box = document.getElementById("hmBody");
  if (!r.items.length) { box.innerHTML = `<div class="card">${empty("You haven't sent anything yet. Use Help → Send feedback from any page.")}</div>`; return; }
  box.innerHTML = `<div class="grid gap-3">${r.items.map((f) => `
    <div class="card p-4">
      <div class="flex flex-wrap items-center gap-2">${chip(...KIND[f.kind])}${chip(...STATUS[f.status])}<span class="text-xs text-black/50">${when(f.created_at)}${f.page_title ? ` · from ${esc(f.page_title)}` : ""}</span></div>
      <div class="text-sm text-ink-900 whitespace-pre-line mt-2">${esc(f.message)}</div>
      ${f.reply ? `<div class="mt-3 rounded-xl bg-emerald-50 border border-emerald-200 p-3"><div class="text-xs font-bold text-emerald-800">Reply from ${esc(f.replied_by || "OPI")} · ${when(f.replied_at)}</div><div class="text-sm text-ink-900 whitespace-pre-line mt-1">${esc(f.reply)}</div></div>` : ""}
    </div>`).join("")}</div>`;
}

export async function helpAdminPage(routeFn) {
  if (!hasCapability("users.manage")) { location.hash = "#/help-mine"; return; }
  let st = { tab: "feedback", status: "open", sel: null };
  try { Object.assign(st, JSON.parse(sessionStorage.getItem("opi_help_admin") || "{}")); } catch (_) {}
  const save = () => { try { sessionStorage.setItem("opi_help_admin", JSON.stringify(st)); } catch (_) {} };
  setShell({ title: "Feedback & what's new", subtitle: "Answer what people send, and tell them what changed.", routeFn,
    bodyHtml: `<div id="haRoot"><div class="card p-6 text-sm text-black/50">Loading…</div></div>` });
  const root = document.getElementById("haRoot");

  async function render() {
    save();
    const [fb, notes] = await Promise.all([api("/help/feedback"), api("/help/notes")]);
    const open = fb.counts.new + fb.counts.in_progress;
    root.innerHTML = `
      <div class="mb-4">${tabs([["feedback", "Feedback", open], ["notes", "What's new notes", notes.items.length], ["tours", "Tours", Object.keys(TOURS).length]], st.tab)}</div>
      <div id="haBody"></div>`;
    root.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { st.tab = b.dataset.tab; render(); });
    const body = document.getElementById("haBody");
    if (st.tab === "feedback") feedbackTab(body, fb);
    else if (st.tab === "notes") notesTab(body, notes.items);
    else toursTab(body);
  }

  function feedbackTab(body, fb) {
    const shown = fb.items.filter((f) => st.status === "all" || (st.status === "open" ? ["new", "in_progress"].includes(f.status) : f.status === st.status));
    body.innerHTML = `
      <div class="flex flex-wrap gap-2 mb-3">${tabs([["open", "Open", fb.counts.new + fb.counts.in_progress], ["answered", "Answered", fb.counts.answered], ["closed", "Closed", fb.counts.closed], ["all", "All", fb.items.length]], st.status, "data-st")}</div>
      ${shown.length ? `<div class="grid gap-3">${shown.map((f) => `
        <div class="card p-4" data-id="${f.id}">
          <div class="flex flex-wrap items-center gap-2">${chip(...KIND[f.kind])}${chip(...STATUS[f.status])}
            <span class="text-xs text-black/55">${esc(f.user_email || "")} · ${when(f.created_at)}</span>
            ${f.page ? `<a class="text-xs font-semibold text-brand-600 hover:underline" href="${esc(f.page)}">${esc(f.page_title || f.page)}</a>` : ""}
          </div>
          <div class="text-sm text-ink-900 whitespace-pre-line mt-2">${esc(f.message)}</div>
          <details class="mt-1"><summary class="text-xs text-black/45 cursor-pointer">Browser</summary><div class="text-xs text-black/55 mt-1">${esc(f.browser || "")} · ${esc(f.viewport || "")}</div></details>
          ${f.reply ? `<div class="mt-3 rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-sm whitespace-pre-line"><div class="text-xs font-bold text-emerald-800 mb-1">Replied by ${esc(f.replied_by)} · ${when(f.replied_at)}</div>${esc(f.reply)}</div>` : ""}
          <div class="grid gap-2 mt-3 md:grid-cols-2">
            <textarea class="input text-sm" rows="3" data-f="reply" placeholder="Reply to ${esc(f.user_email || "them")} (shows in their bell${"" /* email once configured */})"></textarea>
            <textarea class="input text-sm" rows="3" data-f="note" placeholder="Staff note (never shown to them)">${esc(f.staff_note || "")}</textarea>
          </div>
          <div class="flex flex-wrap items-center gap-2 mt-2">
            <select class="input text-sm !w-auto" data-f="status">${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}"${k === f.status ? " selected" : ""}>${l}</option>`).join("")}</select>
            <button type="button" class="btn-primary" data-save>Save</button>
          </div>
        </div>`).join("")}</div>` : `<div class="card">${empty("Nothing here.")}</div>`}`;
    body.querySelectorAll("[data-st]").forEach((b) => b.onclick = () => { st.status = b.dataset.st; feedbackTab(body, fb); save(); });
    body.querySelectorAll("[data-save]").forEach((b) => b.onclick = async () => {
      const card = b.closest("[data-id]");
      const v = (f) => card.querySelector(`[data-f="${f}"]`).value;
      const r = await api(`/help/feedback/${card.dataset.id}`, { method: "PATCH", body: JSON.stringify({ reply: v("reply"), staff_note: v("note"), status: v("reply").trim() ? null : v("status") }) });
      toast(v("reply").trim() ? (r.email_sent ? "Reply sent (bell and email)." : "Reply sent to their bell. Email isn't set up yet.") : "Saved.");
      render();
    });
  }

  function notesTab(body, items) {
    const pages = Object.keys(TOURS).filter((k) => k !== "app");
    const form = (n = {}) => `
      <div class="grid gap-2">
        <input class="input" data-n="title" placeholder="Title, e.g. New: Project Closeout" value="${esc(n.title || "")}">
        <textarea class="input text-sm" rows="4" data-n="body" placeholder="What changed and why it helps, in a few sentences.">${esc(n.body || "")}</textarea>
        <div class="grid gap-2 md:grid-cols-3">
          <label class="text-xs text-black/55">Show me opens<select class="input text-sm mt-1" data-n="page"><option value="">No page</option>${["#/setup", "#/closeout", "#/issues", "#/pay-dates", "#/projects", "#/tracker", "#/crew-payments", "#/cashflow", "#/cashflow-plan", "#/pipeline", "#/progress", "#/review", "#/margins", "#/users", "#/customer-portal"].map((p) => `<option${p === n.page ? " selected" : ""}>${p}</option>`).join("")}</select></label>
          <label class="text-xs text-black/55">and starts the tour<select class="input text-sm mt-1" data-n="tour_key"><option value="">No tour</option>${["app", ...pages].map((p) => `<option value="${p}"${p === n.tour_key ? " selected" : ""}>${esc(TOURS[p].title)}</option>`).join("")}</select></label>
          <label class="text-xs text-black/55">Only for people who can see<select class="input text-sm mt-1" data-n="capability"><option value="">Everyone</option>${["page.assignment", "page.cashflow", "page.customers", "page.financials", "page.pm_portal", "users.manage", "financial.signoff"].map((p) => `<option${p === n.capability ? " selected" : ""}>${p}</option>`).join("")}</select></label>
        </div>
      </div>`;
    body.innerHTML = `
      <div class="card p-4 mb-4"><div class="font-extrabold text-ink-900 mb-2">New note</div><div id="haNew">${form()}</div>
        <div class="flex gap-2 mt-3"><button type="button" class="pd-btn" data-create="0">Save draft</button><button type="button" class="btn-primary" data-create="1">Publish</button></div>
        <div class="text-xs text-black/45 mt-2">Published notes pop up once for each person, the next time they open the app. Drafts are only visible here.</div></div>
      ${items.length ? `<div class="grid gap-3">${items.map((n) => `
        <div class="card p-4" data-id="${n.id}">
          <div class="flex flex-wrap items-center gap-2 mb-2">${n.published_at ? chip(`Published ${day(n.published_at)}`, C.good) : chip("Draft", C.warn)}<span class="text-xs text-black/50">seen by ${n.seen_by} · by ${esc(n.created_by || "")}</span></div>
          ${form(n)}
          <div class="flex flex-wrap gap-2 mt-3"><button type="button" class="pd-btn" data-upd>Save</button>
            ${n.published_at ? `<button type="button" class="pd-btn" data-pub="0">Unpublish</button>` : `<button type="button" class="btn-primary" data-pub="1">Publish</button><button type="button" class="pd-btn !text-rose-700" data-del>Delete</button>`}</div>
        </div>`).join("")}</div>` : ""}`;
    const read = (el) => Object.fromEntries([...el.querySelectorAll("[data-n]")].map((i) => [i.dataset.n, i.value]));
    body.querySelectorAll("[data-create]").forEach((b) => b.onclick = async () => {
      const v = read(document.getElementById("haNew"));
      if (!v.title.trim() || !v.body.trim()) { toast("A note needs a title and some text."); return; }
      await api("/help/notes", { method: "POST", body: JSON.stringify({ ...v, publish: b.dataset.create === "1" }) });
      toast(b.dataset.create === "1" ? "Published." : "Draft saved."); render();
    });
    body.querySelectorAll("[data-id]").forEach((card) => {
      const id = card.dataset.id;
      card.querySelector("[data-upd]").onclick = async () => { await api(`/help/notes/${id}`, { method: "PATCH", body: JSON.stringify(read(card)) }); toast("Saved."); render(); };
      card.querySelector("[data-pub]")?.addEventListener("click", async (e) => {
        await api(`/help/notes/${id}`, { method: "PATCH", body: JSON.stringify({ ...read(card), publish: e.target.dataset.pub === "1" }) }); render();
      });
      card.querySelector("[data-del]")?.addEventListener("click", async () => { if (confirm("Delete this draft?")) { await api(`/help/notes/${id}`, { method: "DELETE" }); render(); } });
    });
  }

  function toursTab(body) {
    body.innerHTML = `<div class="card p-4"><div class="text-sm text-black/60 mb-3">Each page's tour, as people see it. Tours live in <code>frontend/src/utils/tours.js</code>; a step whose control isn't on screen is skipped.</div>
      <table class="w-full text-sm"><thead><tr class="text-left text-xs text-black/50"><th class="py-1">Tour</th><th>Page</th><th>Steps</th><th></th></tr></thead><tbody>
      ${Object.entries(TOURS).map(([k, t]) => `<tr class="border-t border-black/[0.05]"><td class="py-2 font-semibold">${esc(t.title)}</td><td class="text-black/55">${k === "app" ? "every page" : esc(k)}</td><td class="tabular-nums">${t.steps.length}</td>
        <td class="text-right"><button type="button" class="pd-btn" data-try="${esc(k)}">Try it</button></td></tr>`).join("")}</tbody></table></div>`;
    body.querySelectorAll("[data-try]").forEach((b) => b.onclick = () => {
      const k = b.dataset.try;
      if (k === "app") return startTour("app");
      location.hash = k; setTimeout(() => startTour(k), 1200);
    });
  }

  render();
}
