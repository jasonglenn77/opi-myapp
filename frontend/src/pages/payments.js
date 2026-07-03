// Crew Payment Schedule panel (C1) — a project's contractor payment plan.
// Mounted in the project detail page's "Payments" tab. Paid in arrears every
// 2 weeks until completion; default = even split of contract labor across the
// bi-weekly periods, each installment then editable. Backed by /api/payments.
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";

const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const ymd = (s) => (s ? String(s).slice(0, 10) : "");

export async function mountPaymentsPanel(container, entityId) {
  let data;
  const load = async () => { data = await api(`/payments/project/${encodeURIComponent(entityId)}`); };
  try { await load(); }
  catch (e) { container.innerHTML = `<div class="p-5 text-sm text-red-700">Failed to load payments: ${escapeHtml(e?.message || String(e))}</div>`; return; }

  const crewOptions = (selected) => `<option value="">— select crew —</option>` + (data.crews || []).map(c =>
    `<option value="${c.id}" ${String(c.id) === String(selected ?? "") ? "selected" : ""}>${escapeHtml(c.name)}${c.parent_name ? " (" + escapeHtml(c.parent_name) + ")" : ""}</option>`).join("");

  // ── setup form (no schedule yet) ────────────────────────────────────────────
  function setupForm() {
    const e = data.entity;
    return `
      <div class="p-4 sm:p-5 max-w-2xl">
        <div class="text-sm font-extrabold text-ink-900 mb-1">Set up the crew payment schedule</div>
        <div class="text-xs text-black/50 mb-4">Paid in arrears every 2 weeks until completion. We'll split the contract labor evenly across the bi-weekly periods — you can adjust any installment afterward.</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label class="block"><div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">Contract labor ($)</div>
            <input id="pContract" type="number" step="100" class="input text-sm py-1.5 w-full" placeholder="0" value=""></label>
          <label class="block"><div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">Crew</div>
            <select id="pCrew" class="input text-sm py-1.5 w-full">${crewOptions(e.suggested_crew_id)}</select></label>
          <label class="block"><div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">Start date</div>
            <input id="pStart" type="date" class="input text-sm py-1.5 w-full" value="${ymd(e.start_date)}"></label>
          <label class="block"><div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">End date</div>
            <input id="pEnd" type="date" class="input text-sm py-1.5 w-full" value="${ymd(e.end_date)}"></label>
          <label class="block"><div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">Invoice lead (days before pay date)</div>
            <input id="pLead" type="number" step="1" class="input text-sm py-1.5 w-full" value="7"></label>
        </div>
        <div class="mt-4 flex items-center gap-3">
          <button id="pGenerate" class="btn-primary text-sm px-4 py-2">Generate schedule</button>
          <span id="pMsg" class="text-xs font-semibold"></span>
        </div>
      </div>`;
  }

  // ── schedule view ───────────────────────────────────────────────────────────
  function statusPill(inst) {
    const paid = inst.status === "paid";
    return `<button type="button" data-status="${inst.id}" class="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${paid ? "bg-kpi-completed-bg border border-kpi-completed-bd text-kpi-completed-text" : "bg-black/[0.06] text-black/55"}">${paid ? "Paid" : "Pending"}</button>`;
  }
  function instRow(i) {
    return `<tr class="border-b border-black/5" data-inst="${i.id}">
      <td class="py-1.5 px-2 text-black/50 tabular-nums">${i.seq}</td>
      <td class="py-1 px-2"><input type="date" data-f="pay_date" value="${ymd(i.pay_date)}" class="input text-xs py-1 w-36"></td>
      <td class="py-1 px-2"><input type="number" step="100" data-f="amount" value="${i.amount}" class="input text-xs py-1 w-28 text-right"></td>
      <td class="py-1 px-2"><input type="date" data-f="send_invoice_date" value="${ymd(i.send_invoice_date)}" class="input text-xs py-1 w-36"></td>
      <td class="py-1.5 px-2">${statusPill(i)}</td>
      <td class="py-1 px-2"><input type="text" data-f="note" value="${escapeHtml(i.note || "")}" class="input text-xs py-1 w-full" placeholder="Note"></td>
      <td class="py-1 px-2 text-right"><button type="button" data-del="${i.id}" title="Delete" class="rounded-lg border border-red-200 text-red-600 px-2 py-1 text-[11px] font-semibold hover:bg-red-50">✕</button></td>
    </tr>`;
  }
  function scheduleView() {
    const s = data.schedule, sum = data.summary, insts = data.installments || [];
    const mismatch = Math.abs((sum.scheduled_total || 0) - (sum.contract_labor || 0)) >= 1;
    const chip = (label, val, cls = "") => `<div class="rounded-xl border border-black/10 bg-black/[0.015] px-3 py-2"><div class="text-[10px] font-bold uppercase tracking-wide text-black/35">${label}</div><div class="text-sm font-extrabold ${cls}">${money(val)}</div></div>`;
    return `
      <div class="p-4 sm:p-5">
        <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-3">
          <div class="flex items-end gap-3 flex-wrap">
            <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Crew</div>
              <select id="pCrewEdit" class="input text-xs py-1.5">${crewOptions(s.crew_id)}</select></label>
            <div class="text-[11px] text-black/45 pb-1.5">${escapeHtml(ymd(s.start_date))} → ${escapeHtml(ymd(s.end_date))} · invoice ${s.invoice_lead_days}d before</div>
          </div>
          <button id="pRegen" class="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">↻ Regenerate even-split…</button>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          ${chip("Contract labor", sum.contract_labor)}
          ${chip("Paid to date", sum.paid_to_date, "text-kpi-completed-text")}
          ${chip("Remaining", sum.remaining, sum.remaining > 0 ? "text-amber-700" : "")}
          ${chip("Scheduled total", sum.scheduled_total, mismatch ? "text-red-600" : "")}
        </div>
        ${mismatch ? `<div class="text-[11px] text-red-600 mb-2">Scheduled total doesn't match contract labor — adjust an installment or regenerate.</div>` : ""}

        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead><tr class="text-black/45 text-left border-b border-black/10">
              <th class="py-1.5 px-2 font-bold w-8">#</th>
              <th class="py-1.5 px-2 font-bold">Pay date</th>
              <th class="py-1.5 px-2 font-bold text-right">Amount</th>
              <th class="py-1.5 px-2 font-bold">Send invoice</th>
              <th class="py-1.5 px-2 font-bold">Status</th>
              <th class="py-1.5 px-2 font-bold">Note</th>
              <th class="w-10"></th>
            </tr></thead>
            <tbody>${insts.map(instRow).join("")}</tbody>
          </table>
        </div>
        <div class="mt-3 flex items-center gap-3">
          <button id="pAdd" class="rounded-lg border border-black/15 px-3 py-1.5 text-xs font-semibold hover:bg-black/5">+ Add installment</button>
          <span id="pMsg" class="text-xs font-semibold"></span>
        </div>
      </div>`;
  }

  const setMsg = (t, ok) => { const m = container.querySelector("#pMsg"); if (m) { m.textContent = t; m.className = "text-xs font-semibold " + (ok ? "text-kpi-completed-text" : "text-red-600"); if (ok) setTimeout(() => { if (m.textContent === t) m.textContent = ""; }, 1500); } };

  function render() { container.innerHTML = data.schedule ? scheduleView() : setupForm(); wire(); }

  async function reload() { try { await load(); render(); } catch (err) { setMsg(`Could not reload: ${err.message}`, false); } }

  function wire() {
    // setup form
    const gen = container.querySelector("#pGenerate");
    if (gen) gen.addEventListener("click", async () => {
      const body = {
        contract_labor: parseFloat(container.querySelector("#pContract").value) || 0,
        start_date: container.querySelector("#pStart").value,
        end_date: container.querySelector("#pEnd").value,
        invoice_lead_days: parseInt(container.querySelector("#pLead").value, 10) || 0,
        crew_id: container.querySelector("#pCrew").value ? Number(container.querySelector("#pCrew").value) : null,
      };
      if (!body.start_date || !body.end_date) { setMsg("Start and end dates are required.", false); return; }
      gen.disabled = true;
      try { await api(`/payments/project/${encodeURIComponent(entityId)}/generate`, { method: "POST", body: JSON.stringify(body) }); await reload(); }
      catch (err) { setMsg(err.message, false); gen.disabled = false; }
    });

    // schedule view
    const crewEdit = container.querySelector("#pCrewEdit");
    if (crewEdit) crewEdit.addEventListener("change", async () => {
      try { await api(`/payments/project/${encodeURIComponent(entityId)}/schedule`, { method: "PATCH", body: JSON.stringify({ crew_id: crewEdit.value ? Number(crewEdit.value) : null }) }); setMsg("Saved ✓", true); }
      catch (err) { setMsg(err.message, false); }
    });
    const regen = container.querySelector("#pRegen");
    if (regen) regen.addEventListener("click", () => {
      const s = data.schedule;
      // reopen the setup form pre-filled from the current schedule
      data.entity = { ...data.entity, start_date: s.start_date, end_date: s.end_date, suggested_crew_id: s.crew_id };
      data._forceForm = true;
      container.innerHTML = setupForm();
      container.querySelector("#pContract").value = s.contract_labor;
      container.querySelector("#pLead").value = s.invoice_lead_days;
      wire();
    });
    const add = container.querySelector("#pAdd");
    if (add) add.addEventListener("click", async () => {
      try { await api(`/payments/project/${encodeURIComponent(entityId)}/installment`, { method: "POST", body: JSON.stringify({ amount: 0 }) }); await reload(); }
      catch (err) { setMsg(err.message, false); }
    });

    // per-installment inline edits
    container.querySelectorAll("[data-inst]").forEach(tr => {
      const id = tr.getAttribute("data-inst");
      tr.querySelectorAll("[data-f]").forEach(inp => inp.addEventListener("change", async () => {
        const f = inp.getAttribute("data-f");
        const val = f === "amount" ? (parseFloat(inp.value) || 0) : inp.value;
        try { await api(`/payments/installment/${id}`, { method: "PATCH", body: JSON.stringify({ [f]: val }) }); await reload(); }
        catch (err) { setMsg(err.message, false); }
      }));
    });
    container.querySelectorAll("[data-status]").forEach(b => b.addEventListener("click", async () => {
      const id = b.getAttribute("data-status");
      const inst = (data.installments || []).find(x => String(x.id) === String(id));
      try { await api(`/payments/installment/${id}`, { method: "PATCH", body: JSON.stringify({ status: inst.status === "paid" ? "pending" : "paid" }) }); await reload(); }
      catch (err) { setMsg(err.message, false); }
    }));
    container.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this installment?")) return;
      try { await api(`/payments/installment/${b.getAttribute("data-del")}`, { method: "DELETE" }); await reload(); }
      catch (err) { setMsg(err.message, false); }
    }));
  }

  render();
}
