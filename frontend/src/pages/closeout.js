// Project Closeout: every finished job until it's closed. Left: the queue (oldest
// finish first). Right: the selected job at a glance, then its steps grouped Job /
// Money in / Money out / Review as step cards (utils/stepcards.js) that open to
// the invoices, crew payments, bills, paperwork and margin behind each step.
// Steps the data can answer tick themselves (backend/app/closeout/routes.py);
// the rest are marked here.
import { api } from "../api.js";
import { setShell } from "../shell.js";
import { escapeHtml as esc } from "../utils/html.js";
import { openProjectDrawer } from "../utils/project-drawer.js";
import { chip, C, day, money0, money2, projectLink } from "../utils/ui.js";
import { openDocViewer, DOC_ICON } from "../utils/doc-viewer.js";
import { stepCardHtml, bindStepCards, STATE_ICON } from "../utils/stepcards.js";

const VIEWS = [["all", "All finished jobs"], ["money", "Money open"], ["bill", "To bill"], ["collect", "To collect"], ["crew", "Crew owed"], ["paper", "Paperwork"], ["review", "Ready to close"]];
const GROUPS = ["Job", "Money in", "Money out", "Review"];
// Where to go to fix each step.
const FIX = {
  marked_complete: ["Open project", "workspace"], completion_form: ["Documents", "documents"], change_orders: ["Change orders", "changeorders"],
  final_invoice: ["Billing", "billing"], paid: ["Billing", "billing"], retainage: ["Billing", "billing"],
  crew_paid: ["Contractor Payments", "#/crew-payments"], expenses: ["Financials", "financials"], signoff: ["Progress Checks", "#/progress"],
};

export async function closeoutPage(routeFn) {
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem("opi_closeout") || "{}"); } catch (_) {}
  const isPhone = () => window.matchMedia("(max-width: 1023px)").matches;
  const st = { jobs: [], view: VIEWS.some(([k]) => k === saved.view) ? saved.view : "all", q: "", pm: "", sel: saved.sel || null, open: false, meta: {} };
  const remember = () => { try { sessionStorage.setItem("opi_closeout", JSON.stringify({ view: st.view, sel: st.sel })); } catch (_) {} };

  setShell({
    title: "Project Closeout",
    subtitle: "Finished jobs that aren't closed yet: the final invoice, getting paid, paying the crew in full, bills, change orders and the completion paperwork. A job leaves once every step is done.",
    bodyHtml: `<div id="coRoot" class="qpage"><div class="card p-6 text-sm text-black/45">Loading finished jobs…</div></div>`,
    routeFn,
  });
  const root = document.getElementById("coRoot");

  const stepOf = (j, k) => j.steps.find((s) => s.key === k) || {};
  const open = (j, k) => stepOf(j, k).state === "todo";
  const moneyOpen = (j) => j.money.unbilled > 1 || j.money.open_ar > 1 || j.money.crew_owed > 1 || j.money.retainage > 1;
  const TEST = {
    all: () => true, money: moneyOpen, bill: (j) => open(j, "final_invoice"), collect: (j) => open(j, "paid") || open(j, "retainage"),
    crew: (j) => open(j, "crew_paid"), paper: (j) => open(j, "completion_form") || open(j, "marked_complete") || open(j, "change_orders"),
    review: (j) => j.steps.every((s) => s.key === "margin" || s.state !== "todo"),
  };
  function visible() {
    const q = st.q.trim().toLowerCase();
    return st.jobs.filter((j) => TEST[st.view](j)
      && (!st.pm || (j.pms || []).includes(st.pm))
      && (!q || `${j.name} ${j.dealer || ""} ${(j.pms || []).join(" ")}`.toLowerCase().includes(q)));
  }

  async function load() {
    try {
      const d = await api("/closeout/queue");
      st.jobs = d.jobs; st.meta = d;
      if (!st.sel || !st.jobs.some((j) => j.entity_id === st.sel)) st.sel = visible()[0]?.entity_id || null;
      render();
    } catch (e) {
      root.innerHTML = `<div class="card p-6 text-sm text-rose-700">Couldn't load finished jobs: ${esc(e?.message || String(e))}</div>`;
    }
  }

  function kpis() {
    const sum = (f) => st.jobs.reduce((a, j) => a + f(j), 0);
    const n = (f) => st.jobs.filter(f).length;
    const tile = (label, value, caption, bad, view) => `<button type="button" class="card p-4 text-left su-kpi" data-view="${view}">
        <div class="text-[10px] uppercase tracking-wide font-bold text-black/45">${label}</div>
        <div class="text-2xl font-extrabold tabular-nums ${bad ? "text-rose-700" : ""}">${value}</div>
        <div class="text-xs text-black/50">${caption}</div></button>`;
    const unb = sum((j) => j.money.unbilled), ar = sum((j) => j.money.open_ar), crew = sum((j) => j.money.crew_owed);
    return `<div class="su-kpis">
      ${tile("Still to bill", money0(unb), `${n((j) => open(j, "final_invoice"))} jobs: final invoice not sent`, unb > 0, "bill")}
      ${tile("Owed to OPI", money0(ar), `${n((j) => open(j, "paid"))} jobs with unpaid invoices`, false, "collect")}
      ${tile("Owed to crews", money0(crew), `${n((j) => open(j, "crew_paid"))} jobs: crew not paid in full`, false, "crew")}
      ${tile("Paperwork", n(TEST.paper), "Completion form, status or change orders", false, "paper")}
      ${tile("Ready to close", n(TEST.review), "Everything in; review the margin", false, "review")}
    </div>`;
  }

  function listHtml() {
    const rows = visible();
    if (!rows.length) return `<div class="p-4 text-sm text-black/50">No jobs here.</div>`;
    return rows.map((j) => {
      const pct = Math.round((100 * j.done) / j.total);
      return `<button type="button" class="su-job${j.entity_id === st.sel ? " on" : ""}" data-key="${esc(j.entity_id)}" aria-current="${j.entity_id === st.sel}">
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <div class="font-bold text-sm truncate">${esc(j.name)}</div>
            <div class="text-[11.5px] text-black/50 truncate">${esc([j.dealer, (j.pms || [])[0], j.end ? `ended ${day(j.end)}` : null].filter(Boolean).join(" · "))}</div>
          </div>
          <span class="text-[11px] font-bold tabular-nums text-black/55">${j.done}/${j.total}</span>
        </div>
        <div class="su-bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
        ${j.flags.length ? `<div class="flex flex-wrap gap-1 mt-1.5">${j.flags.map((f) => chip(f.text, C[f.tone])).join("")}</div>` : ""}
      </button>`;
    }).join("");
  }

  function render() {
    remember();
    const pms = [...new Set(st.jobs.flatMap((j) => j.pms || []))].sort();
    const counts = Object.fromEntries(VIEWS.map(([k]) => [k, st.jobs.filter(TEST[k]).length]));
    root.classList.toggle("su-open", st.open);
    root.innerHTML = `
      ${kpis()}
      <div class="su-bar-row">
        <div class="tabs" role="tablist">${VIEWS.map(([k, l]) => `<button role="tab" class="tab" data-view="${k}" aria-selected="${st.view === k}">${l} <span class="tab-n">${counts[k]}</span></button>`).join("")}</div>
        <input id="coQ" class="input text-sm su-q" placeholder="Search job, dealer or PM" value="${esc(st.q)}">
        <select id="coPm" class="input text-sm su-pm"><option value="">All PMs</option>${pms.map((p) => `<option${p === st.pm ? " selected" : ""}>${esc(p)}</option>`).join("")}</select>
      </div>
      <div class="su-grid">
        <div class="card su-list" id="coList">${listHtml()}</div>
        <div id="coDetail" class="q-detail"></div>
      </div>
      <div class="text-xs text-white/50 mt-3">Jobs that finished more than ${st.meta.old_days || 180} days ago only show while money is still open. ${st.meta.closed_recent ? `${st.meta.closed_recent} job${st.meta.closed_recent === 1 ? "" : "s"} closed in the last 60 days.` : ""}</div>`;
    bind();
    renderDetail();
  }

  function bind() {
    root.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
      st.view = b.dataset.view;
      if (!visible().some((j) => j.entity_id === st.sel)) st.sel = visible()[0]?.entity_id || null;
      render();
    }));
    const q = root.querySelector("#coQ");
    q.addEventListener("input", () => { st.q = q.value; root.querySelector("#coList").innerHTML = listHtml(); bindList(); });
    root.querySelector("#coPm").addEventListener("change", (e) => { st.pm = e.target.value; render(); });
    bindList();
  }
  function bindList() {
    root.querySelectorAll(".su-job").forEach((b) => b.addEventListener("click", () => {
      st.sel = b.dataset.key; st.open = true; remember();
      root.querySelectorAll(".su-job").forEach((x) => x.classList.toggle("on", x === b));
      root.classList.add("su-open");
      renderDetail();
      if (isPhone()) window.scrollTo(0, 0);
    }));
  }

  function fixLink(j, key) {
    const f = FIX[key];
    if (!f) return "";
    const href = f[1].startsWith("#") ? f[1] : projectLink(j.entity_id, f[1] === "workspace" ? null : f[1]);
    return `<a class="pd-btn" href="${href}">${f[0]}</a>`;
  }

  // ── Detail: the job at a glance, then one step card per step ────────────
  // Each card opens in place to what's behind the step (the invoices, the crew
  // payments, the unpaid bills, the completion paperwork, the margin by
  // category), from GET /closeout/job/{id}/detail, loaded once per job.
  let D = null;
  const cache = {};
  const getDetail = (eid) => cache[eid] ||= api(`/closeout/job/${encodeURIComponent(eid)}/detail`).catch((e) => { delete cache[eid]; throw e; });

  function headParts(j, s) {
    const acts = [];
    if (s.state === "todo") {
      acts.push(fixLink(j, s.key));
      acts.push(`<button type="button" class="pd-btn" data-mark="${s.how === "manual" ? "done" : "not_needed"}" data-step="${s.key}">${s.how === "manual" ? "Close out" : "Not needed"}</button>`);
    }
    if (s.mark) acts.push(`<button type="button" class="pd-btn" data-mark="" data-step="${s.key}">Undo</button>`);
    const markTxt = s.mark ? `<div class="text-[11px] text-black/45 mt-0.5">Marked by ${esc(s.mark.by_email || "")} ${s.mark.at ? day(s.mark.at) : ""}${s.mark.note ? `: ${esc(s.mark.note)}` : ""}</div>` : "";
    return { key: s.key, state: s.state, label: s.label, detail: s.why, actions: acts.join(""), extra: markTxt };
  }
  const groupCount = (j, g) => { const ss = j.steps.filter((s) => s.group === g); return `${ss.filter((s) => s.state !== "todo").length}/${ss.length}`; };
  const stepLink = (s) => `<a href="#" class="su-step" data-jump="${s.key}">${STATE_ICON[s.state] || STATE_ICON.todo}<span>${esc(s.label)}</span></a>`;
  const moneyTiles = (m) => {
    const tile = (k, v, bad) => `<div><div class="k">${k}</div><div class="v${bad ? " bad" : ""}">${v}</div></div>`;
    return `${tile("Contract", money0(m.contract))}${tile("Invoiced", money0(m.invoiced))}${tile("Still to bill", money0(m.unbilled), m.unbilled > 1)}
      ${tile("Owed to OPI", money0(m.open_ar), m.open_ar > 1)}${m.retainage > 1 ? tile("Retainage held", money0(m.retainage)) : ""}
      ${tile("Crew scheduled", money0(m.crew_scheduled))}${tile("Crew paid", money0(m.crew_paid))}${tile("Owed to crew", money0(m.crew_owed), m.crew_owed > 1)}`;
  };

  function renderDetail() {
    let box = root.querySelector("#coDetail");
    const j = st.jobs.find((x) => x.entity_id === st.sel);
    if (!box) return;
    const fresh = box.cloneNode(false); box.replaceWith(fresh); box = fresh;   // drop the last job's listeners
    if (!j) { box.innerHTML = `<div class="card p-6 text-sm text-black/50">Pick a job on the left.</div>`; D = null; return; }
    D = { j };
    box.innerHTML = `
      <button type="button" class="su-back" data-back>← All finished jobs</button>
      <section class="card p-4">
        <div class="flex flex-wrap items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-lg font-extrabold leading-tight">${esc(j.name)}</div>
            <div class="text-xs text-black/55 mt-0.5">${esc([j.dealer ? `Dealer: ${j.dealer}` : null, (j.pms || []).length ? `PM: ${j.pms.join(", ")}` : null, `${day(j.start)} to ${day(j.end)}`, j.days_since_end != null && j.days_since_end >= 0 ? `ended ${j.days_since_end} days ago` : null].filter(Boolean).join(" · "))}</div>
          </div>
          <div class="text-right"><div class="text-[10px] uppercase tracking-wide font-bold text-black/45">Margin so far</div>
            <div class="font-extrabold tabular-nums ${j.margin_pct != null && j.margin_pct < 0 ? "text-rose-700" : ""}">${j.margin_pct != null ? `${j.margin_pct.toFixed(1)}%` : "—"}</div>
            ${j.profit != null ? `<div class="text-[11px] text-black/50">${money0(j.profit)} profit</div>` : ""}</div>
        </div>
        <div class="flex flex-wrap gap-2 mt-3">
          <button type="button" class="pd-btn" data-act="drawer">Quick view</button>
          <a class="pd-btn" href="${projectLink(j.entity_id)}">Open project workspace</a>
          <span data-flags class="contents">${j.flags.map((f) => chip(f.text, C[f.tone])).join(" ")}</span>
        </div>
        <div class="co-money mt-3" data-money>${moneyTiles(j.money)}</div>
        <div class="su-stages co-stages mt-3">${GROUPS.map((g) => `<div class="su-stage" data-group="${g}">
          <div class="flex items-center justify-between"><div class="text-[11px] uppercase tracking-wide font-bold text-black/50">${g}</div><div class="text-[11px] font-bold tabular-nums text-black/45" data-n>${groupCount(j, g)}</div></div>
          <div class="grid gap-1 mt-1.5" data-links>${j.steps.filter((s) => s.group === g).map(stepLink).join("")}</div></div>`).join("")}</div>
        <div class="text-[11px] text-black/45 mt-2">Click a step to open it below.</div>
      </section>
      ${GROUPS.map((g) => `<section class="card p-4 su-sec">
        <div class="su-h">${g} <span class="text-xs font-bold text-black/40 tabular-nums" data-gn="${g}">${groupCount(j, g)}</span></div>
        <div class="grid gap-2 mt-2">${j.steps.filter((s) => s.group === g).map((s) => stepCardHtml(headParts(j, s))).join("")}</div>
      </section>`).join("")}`;

    box.querySelector("[data-back]").addEventListener("click", () => { st.open = false; root.classList.remove("su-open"); });
    box.querySelector('[data-act="drawer"]').addEventListener("click", () =>
      openProjectDrawer({ entityId: j.entity_id, name: j.name, onChange: () => reload(j.entity_id), backLabel: "Project Closeout", backHash: "#/closeout" }));
    D.cards = bindStepCards(box, { onOpen: async (key, body) => { const d = await getDetail(j.entity_id); if (BODY[key]) BODY[key](j, d, body); else body.innerHTML = ""; } });
    box.addEventListener("click", async (e) => {
      const a = e.target.closest("[data-jump]");
      if (a) { e.preventDefault(); D.cards.open(a.dataset.jump); return; }
      const b = e.target.closest("[data-mark]");
      if (!b) return;
      const step = b.dataset.step;
      const status = b.dataset.mark || null;
      let note = null;
      if (status) {
        note = prompt(status === "done" ? "Note for the record (optional): e.g. margin reviewed with Luke" : "Why isn't this needed? (kept with the job)");
        if (note === null) return;
      }
      b.disabled = true;
      try {
        const row = await api(`/closeout/job/${encodeURIComponent(j.entity_id)}/step/${step}`, { method: "POST", body: JSON.stringify({ status, note }) });
        Object.assign(j, row);
        refreshHeads(j);
        root.querySelector("#coList").innerHTML = listHtml(); bindList();
      } catch (er) { b.disabled = false; alert(`Couldn't save: ${er?.message || er}`); }
    });
    const next = j.steps.find((s) => s.state === "todo");
    if (next) D.cards.open(next.key, { scroll: false });
  }

  // after a mark or a reload: ticks, counts, money and card heads, open cards kept
  function refreshHeads(j) {
    const box = root.querySelector("#coDetail");
    if (!box || !D || D.j.entity_id !== j.entity_id) return;
    for (const g of GROUPS) {
      box.querySelector(`[data-group="${g}"] [data-n]`).textContent = groupCount(j, g);
      box.querySelector(`[data-group="${g}"] [data-links]`).innerHTML = j.steps.filter((s) => s.group === g).map(stepLink).join("");
      box.querySelector(`[data-gn="${g}"]`).textContent = groupCount(j, g);
    }
    box.querySelector("[data-money]").innerHTML = moneyTiles(j.money);
    box.querySelector("[data-flags]").innerHTML = j.flags.map((f) => chip(f.text, C[f.tone])).join(" ");
    for (const s of j.steps) D.cards.setHead(s.key, headParts(j, s));
  }

  // ── Step bodies ─────────────────────────────────────────────────────────
  const err = (x) => (x && x.error ? `<div class="text-xs text-rose-700">Couldn't load this: ${esc(x.error)}</div>` : "");
  const facts = (list) => `<div class="su-facts">${list.filter(Boolean).map(([k, v, cls]) => `<div><span>${k}</span><b class="${cls || ""}">${v}</b></div>`).join("")}</div>`;
  const table = (heads, rows, empty) => (rows.length ? `<div class="overflow-x-auto"><table class="w-full text-xs su-table"><thead><tr>${heads.map((h) => `<th class="${h.startsWith(">") ? "text-right" : "text-left"}">${esc(h.replace(/^>/, ""))}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` : `<div class="text-xs text-black/55">${empty}</div>`);
  const r = (v, cls = "") => `<td class="text-right tabular-nums ${cls}">${v}</td>`;
  const isImg = (f) => /\.(jpe?g|png|heic|gif|webp)$/i.test(f.filename || "");
  const docBtn = (f) => `<button type="button" class="pd-btn su-doc" data-doc="${f.id}" data-fn="${esc(f.filename)}" title="${esc(f.filename)}">${DOC_ICON}<span class="truncate">${esc(f.filename)}</span></button>`;
  const wireDocs = (el) => el.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => openDocViewer({ id: Number(b.dataset.doc), filename: b.dataset.fn })));
  const statusTxt = { completed: "Completed", in_progress: "In progress", not_started: "Not started", needs_attention: "Needs attention", pending: "Pending", on_hold: "On hold", canceled: "Canceled" };
  const pct1 = (v) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);
  const pc = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);

  const BODY = {
    marked_complete(j, d, body) {
      const x = d.marked_complete || {};
      body.innerHTML = err(x) || `${table(["Schedule line", "Start", "End", ">Overage", "Status"], (x.items || []).map((i, n) => `<tr><td>#${n + 1}</td><td>${day(i.start)}</td><td>${day(i.end)}</td>${r(i.overage_days || 0)}<td>${esc(statusTxt[i.status] || i.status || "")}</td></tr>`), "No schedule lines.")}
        <div class="text-xs text-black/55 mt-2">${(x.pms || []).length ? `PM: ${esc(x.pms.join(", "))}. ` : ""}Set the status to Completed in the project's Assignment (Open project workspace).</div>`;
    },
    completion_form(j, d, body) {
      const x = d.completion_form || {};
      if (x.error) { body.innerHTML = err(x); return; }
      const docs = x.documents || [];
      const pdfs = docs.filter((f) => !isImg(f));
      const imgs = docs.filter(isImg);
      body.innerHTML = `${(x.submissions || []).length ? `<div class="text-[10px] uppercase tracking-wide font-bold text-black/45 mb-1">Completion forms from the crew portal</div>
          ${table(["Submitted", "By", "Signed by", "Status"], x.submissions.map((s) => `<tr><td>${day(s.submitted_at)}</td><td>${esc(s.by || "")}</td><td>${esc(s.signer || "")}</td><td>${esc(s.status || "")}</td></tr>`), "")}` : ""}
        <div class="text-[10px] uppercase tracking-wide font-bold text-black/45 mt-2 mb-1">Completion paperwork in Drive</div>
        ${pdfs.length ? pdfs.map(docBtn).join("") : `<div class="text-xs text-black/55">No completion form in the job's folders.</div>`}
        ${imgs.length ? `<details class="mt-2"><summary class="text-xs font-semibold text-black/60 cursor-pointer">${imgs.length} completion photo${imgs.length === 1 ? "" : "s"}</summary><div class="mt-2">${imgs.map(docBtn).join("")}</div></details>` : ""}`;
      wireDocs(body);
    },
    change_orders(j, d, body) {
      const x = d.change_orders || {};
      if (x.error) { body.innerHTML = err(x); return; }
      const rows = [
        ...(x.estimates || []).map((e) => `<tr><td>#${esc(e.number || "")}${e.original ? ` ${chip("Contract", C.quiet)}` : ""}</td><td>QuickBooks</td><td>${day(e.date)}</td>${r(money0(e.amount))}<td>${esc(e.status || "")}</td><td>${e.invoiced ? chip("Invoiced", C.good) : e.original ? "" : chip("Not invoiced", C.warn)}</td></tr>`),
        ...(x.app_change_orders || []).map((c) => `<tr><td>${esc(c.number || c.title || "")}</td><td>App</td><td>${day(c.date)}</td>${r(money0(c.amount))}<td>${esc(c.status || "")}</td><td>${c.qbo_estimate_id ? chip("In QuickBooks", C.good) : chip("Not in QuickBooks", C.warn)}</td></tr>`),
      ];
      body.innerHTML = `${table(["Estimate / CO", "Where", "Date", ">Amount", "Status", "Billing"], rows, "No change orders on this job.")}
        ${x.pending ? `<div class="su-warn mt-2">${x.pending} change order${x.pending === 1 ? " is" : "s are"} still pending.</div>` : ""}`;
    },
    final_invoice(j, d, body) { invoicesBody(d.final_invoice, body, "bill"); },
    paid(j, d, body) { invoicesBody(d.paid, body, "paid"); },
    retainage(j, d, body) { invoicesBody(d.retainage, body, "ret"); },
    crew_paid(j, d, body) {
      const x = d.crew_paid || {};
      if (x.error) { body.innerHTML = err(x); return; }
      body.innerHTML = `${facts([["Scheduled", money0(x.scheduled)], ["Paid", money0(x.paid)], ["Still owed", money0(x.owed), x.owed > 1 ? "text-rose-700" : "text-emerald-700"]])}
        <div class="mt-2">${table(["Crew", ">Scheduled", ">Paid", ">Owed", "Last paid", "Next"], (x.crews || []).map((c) => `<tr><td class="font-semibold">${esc(c.crew || "")}</td>${r(money0(c.scheduled))}${r(money0(c.paid))}${r(money0(c.owed), c.owed > 1 ? "font-bold text-rose-700" : "")}<td>${day(c.last_paid)}</td><td>${c.next_date ? `${day(c.next_date)} · ${money0(c.next_amount)}` : ""}</td></tr>`), "No crew pay on record.")}</div>
        ${(x.payments || []).length ? `<details class="mt-2"><summary class="text-xs font-semibold text-black/60 cursor-pointer">${x.payments.length} payment${x.payments.length === 1 ? "" : "s"} to crews</summary><div class="mt-2">${table(["Date", "Type", "Crew", "Description", ">Amount"], x.payments.map((p) => `<tr><td>${day(p.date)}</td><td>${esc(p.type || "")}</td><td>${esc(p.crew || "")}</td><td class="text-black/55">${esc((p.description || "").slice(0, 80))}</td>${r(money0(p.amount))}</tr>`), "")}</div></details>` : ""}
        <div class="text-xs text-black/50 mt-2">Same numbers as Contractor Payments.</div>`;
    },
    expenses(j, d, body) {
      const x = d.expenses || {};
      if (x.error) { body.innerHTML = err(x); return; }
      body.innerHTML = table(["Vendor", "Bill", "Date", "Due", ">On this job", ">Open"], (x.bills || []).map((b) => `<tr><td class="font-semibold">${esc(b.vendor || "")}</td><td>${esc(b.doc_number || "")}</td><td>${day(b.date)}</td><td>${day(b.due_date)} ${b.past_due ? chip("Past due", C.bad) : ""}</td>${r(money2(b.job_amount))}${r(money2(b.balance))}</tr>`), "No unpaid bills on this job.");
    },
    signoff(j, d, body) {
      const x = d.signoff || {};
      if (x.error) { body.innerHTML = err(x); return; }
      const p = x.progress;
      body.innerHTML = `<div class="text-sm">${x.required ? "This job needs a 100% sign-off" : "No sign-off required"}${x.rule ? ` <span class="text-black/50">(Progress Checks asks for one on ${esc(x.rule)})</span>` : ""}.</div>
        ${p ? `<div class="mt-2">${facts([["Progress check", esc(p.status || "—")], ["Time used", pc(p.pct_time)], ["Invoiced", pc(p.pct_invoiced)], ["Labor paid", pc(p.pct_labor)], ["Cost spent", pc(p.pct_cost)], p.last_checkpoint != null ? ["Last checkpoint", `${p.last_checkpoint}%${p.last_checkpoint_date ? ` · ${day(p.last_checkpoint_date)}` : ""}`] : null])}</div>` : ""}
        ${(x.signoffs || []).length ? `<div class="mt-2">${table(["Milestone", "Decision", "By", "When", "Note"], x.signoffs.map((s) => `<tr><td>${esc(String(s.milestone))}%</td><td>${esc(s.decision || "")}</td><td>${esc(s.by || "")}</td><td>${day(s.at)}</td><td>${esc(s.note || "")}</td></tr>`), "")}</div>` : ""}`;
    },
    margin(j, d, body) {
      const x = d.margin || {};
      if (x.error) { body.innerHTML = err(x); return; }
      body.innerHTML = `${facts([["Revenue", money0(x.revenue)], ["Cost", money0(x.cost)], ["Profit", money0(x.profit), x.profit < 0 ? "text-rose-700" : ""], ["Margin", pct1(x.margin_pct), x.margin_pct != null && x.margin_pct < 10 ? "text-rose-700" : ""], ["Planned margin", pct1(x.planned_margin_pct)]])}
        <div class="mt-2">${table(["Cost category", ">Estimate", ">Actual", ">Over"], (x.categories || []).map((c) => `<tr${c.over > 0 ? ' class="su-diff"' : ""}><td>${esc(c.category || "")}</td>${r(money0(c.estimate))}${r(money0(c.actual))}${r(c.over > 0 ? money0(c.over) : "", c.over > 0 ? "font-bold text-rose-700" : "")}</tr>`), "No cost categories on record.")}</div>
        <div class="text-xs text-black/50 mt-2">When the numbers are right, press "Close out" on this step. The job then leaves the list.</div>`;
    },
  };

  function invoicesBody(x, body, focus) {
    x = x || {};
    if (x.error) { body.innerHTML = err(x); return; }
    const rows = (x.invoices || []).filter((i) => focus !== "ret" || i.retainage).map((i) => `<tr${focus === "paid" && i.balance > 0.5 ? ' class="su-diff"' : ""}><td class="font-semibold">#${esc(i.doc_number || "")}${i.retainage ? ` ${chip("Retainage", C.info)}` : ""}</td><td>${day(i.date)}</td><td>${day(i.due_date)}</td>${r(money2(i.total))}${r(i.balance > 0.5 ? money2(i.balance) : "Paid", i.balance > 0.5 ? "font-bold" : "text-emerald-700")}</tr>`);
    body.innerHTML = `${facts([["Contract", money0(x.contract)], ["Invoiced", money0(x.invoiced)], ["Still to bill", money0(x.unbilled), x.unbilled > 1 ? "text-rose-700" : ""], ["Owed to OPI", money0(x.open_ar), x.open_ar > 1 ? "text-amber-700" : ""], x.retainage > 1 ? ["Retainage held", money0(x.retainage)] : null])}
      <div class="mt-2">${table(["Invoice", "Date", "Due", ">Amount", ">Open"], rows, focus === "ret" ? "No retainage invoices." : "No invoices yet.")}</div>
      ${focus === "bill" && (x.schedule_to_bill || []).length ? `<div class="text-[10px] uppercase tracking-wide font-bold text-black/45 mt-3 mb-1">Still on the invoice schedule, not invoiced</div>
        ${table(["Line", ">%", "Invoice date", ">Amount"], x.schedule_to_bill.map((s) => `<tr><td>${esc(s.label || "")}${s.estimate ? ` <span class="text-black/45">· est ${esc(String(s.estimate))}</span>` : ""}</td>${r(s.pct != null ? `${Math.round(s.pct)}%` : "")}<td>${day(s.invoice_date)}</td>${r(money2(s.amount))}</tr>`), "")}` : ""}`;
  }

  async function reload(eid) {
    try {
      const row = await api(`/closeout/job/${encodeURIComponent(eid)}`);
      const j = st.jobs.find((x) => x.entity_id === eid);
      if (j) Object.assign(j, row);
      delete cache[eid];
      root.querySelector("#coList").innerHTML = listHtml(); bindList();
      if (j) refreshHeads(j);
    } catch (_) { /* the next load catches up */ }
  }

  load();
}
