// Crew Offer + per-estimate Payment Schedules — the project's "Payments" tab.
// Flow: office sends a work offer (labor+scope from the accepted estimate) → crew
// accepts/declines → then each converted estimate (main + change-orders) with
// Contract Labor gets its OWN bi-weekly schedule (even split, in arrears, editable).
// Actual paid amounts are pulled from QuickBooks at the project level.
import { api } from "../api.js";
import { escapeHtml } from "../utils/html.js";

const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const ymd = (s) => (s ? String(s).slice(0, 10) : "");

export async function mountPaymentsPanel(container, entityId) {
  let data, offers;
  const load = async () => {
    [data, offers] = await Promise.all([
      api(`/payments/project/${encodeURIComponent(entityId)}`),
      api(`/offers/project/${encodeURIComponent(entityId)}`),
    ]);
  };
  try { await load(); }
  catch (e) { container.innerHTML = `<div class="p-5 text-sm text-red-700">Failed to load payments: ${escapeHtml(e?.message || String(e))}</div>`; return; }

  const crewOptions = (list, selected) => `<option value="">— select crew —</option>` + (list || []).map(c =>
    `<option value="${c.id}" ${String(c.id) === String(selected ?? "") ? "selected" : ""}>${escapeHtml(c.name)}${c.parent_name ? " (" + escapeHtml(c.parent_name) + ")" : ""}</option>`).join("");
  const acceptedCrewId = () => (offers.accepted ? offers.accepted.crew_id : data.entity.suggested_crew_id);

  // ── Crew Offer section (project-level) ──────────────────────────────────────
  function offerSection() {
    const latest = (offers.offers || [])[0] || null;
    const history = (offers.offers || []).filter(o => o !== latest && ["declined", "withdrawn"].includes(o.status));
    const histHtml = history.length ? `<div class="mt-2 text-[11px] text-black/45">Previous: ${history.map(o => `${escapeHtml(o.crew_name || "crew")} — ${o.status}`).join(" · ")}</div>` : "";
    let inner;
    if (latest && latest.status === "accepted") {
      inner = `<div class="rounded-xl border border-kpi-completed-bd bg-kpi-completed-bg px-3 py-2.5">
        <div class="text-sm font-semibold text-kpi-completed-text">✓ Accepted by ${escapeHtml(latest.crew_name || "crew")} · ${money(latest.labor_amount)}</div>
        ${latest.scope ? `<div class="text-xs text-black/55 mt-0.5">${escapeHtml(latest.scope)}</div>` : ""}</div>`;
    } else if (latest && latest.status === "sent") {
      inner = `<div class="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5">
        <div class="text-sm font-semibold text-ink-900">Offer sent to ${escapeHtml(latest.crew_name || "crew")} · ${money(latest.labor_amount)}
          <span class="ml-1 inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">Awaiting response</span></div>
        ${latest.scope ? `<div class="text-xs text-black/55 mt-0.5">${escapeHtml(latest.scope)}</div>` : ""}
        <div class="mt-2 flex items-center gap-2 flex-wrap">
          <button type="button" data-respond="${latest.id}:accepted" class="btn-primary text-[11px] px-2.5 py-1">Mark accepted</button>
          <button type="button" data-respond="${latest.id}:declined" class="rounded-lg border border-black/15 px-2.5 py-1 text-[11px] font-semibold hover:bg-black/5">Mark declined</button>
          <button type="button" data-withdraw="${latest.id}" class="rounded-lg border border-red-200 text-red-600 px-2.5 py-1 text-[11px] font-semibold hover:bg-red-50">Withdraw &amp; reassign</button>
          <span class="text-[10px] text-black/40">or the crew responds in the Crew Portal</span></div></div>`;
    } else {
      const suggested = offers.suggested_labor || 0;
      inner = `<div class="rounded-xl border border-black/10 px-3 py-3">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Crew</div>
            <select id="oCrew" class="input text-sm py-1.5 w-full">${crewOptions(offers.crews, data.entity.suggested_crew_id)}</select></label>
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Labor offer ($)</div>
            <input id="oAmount" type="number" step="100" class="input text-sm py-1.5 w-full" value="${suggested ? Math.round(suggested) : ""}">
            <div class="text-[10px] text-black/40 mt-0.5">${suggested ? "Total accepted-estimate Contract Labor." : "No estimate labor found."}</div></label>
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Scope of work</div>
            <input id="oScope" type="text" class="input text-sm py-1.5 w-full" value="${escapeHtml(offers.suggested_scope || "")}" placeholder="Scope from the estimate"></label></div>
        <div class="mt-3 flex items-center gap-3"><button id="oSend" class="btn-primary text-sm px-4 py-2">Send offer</button><span id="oMsg" class="text-xs font-semibold"></span></div></div>`;
    }
    return `<div class="mb-6"><div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-2">Crew offer</div>${inner}${histHtml}</div>`;
  }

  // ── per-estimate schedule cards ─────────────────────────────────────────────
  const COLGROUP = `<colgroup><col style="width:34px"><col style="width:150px"><col style="width:120px"><col style="width:150px"><col><col style="width:44px"></colgroup>`;
  function instRow(i) {
    return `<tr class="border-b border-black/5" data-inst="${i.id}">
      <td class="py-1.5 px-2 text-black/50 tabular-nums">${i.seq}</td>
      <td class="py-1 px-1.5"><input type="date" data-f="pay_date" value="${ymd(i.pay_date)}" class="input text-xs py-1 w-full"></td>
      <td class="py-1 px-1.5"><input type="number" step="100" data-f="amount" value="${i.amount}" class="input text-xs py-1 w-full text-right"></td>
      <td class="py-1 px-1.5"><input type="date" data-f="send_invoice_date" value="${ymd(i.send_invoice_date)}" class="input text-xs py-1 w-full"></td>
      <td class="py-1 px-1.5"><input type="text" data-f="note" value="${escapeHtml(i.note || "")}" class="input text-xs py-1 w-full" placeholder="Note"></td>
      <td class="py-1 px-1.5 text-center"><button type="button" data-del="${i.id}" title="Delete" class="rounded-lg border border-red-200 text-red-600 px-2 py-1 text-[11px] font-semibold hover:bg-red-50">✕</button></td></tr>`;
  }
  function estimateCard(pkg) {
    const e = pkg, s = pkg.schedule, insts = pkg.installments || [];
    const header = `<div class="flex items-center justify-between gap-2 flex-wrap mb-2">
      <div class="text-sm font-bold text-ink-900">Estimate #${escapeHtml(String(e.doc_number || "—"))}
        <span class="text-xs font-normal text-black/45">· ${escapeHtml(ymd(e.txn_date))} · Contract Labor ${money(e.contract_labor)}</span></div>
      ${s ? `<button type="button" data-delsched="${s.id}" class="rounded-lg border border-red-200 text-red-600 px-2 py-1 text-[11px] font-semibold hover:bg-red-50">Remove schedule</button>` : ""}
    </div>`;
    let body;
    if (!s) {
      body = `<div class="flex items-end gap-2 flex-wrap" data-setup="${escapeHtml(e.qbo_id)}" data-doc="${escapeHtml(String(e.doc_number || ""))}" data-labor="${e.contract_labor}">
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Crew</div>
          <select data-screw class="input text-xs py-1.5" style="width:220px">${crewOptions(data.crews, acceptedCrewId())}</select></label>
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Start</div><input data-sstart type="date" class="input text-xs py-1.5" value="${ymd(e.txn_date || data.entity.start_date)}"></label>
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">End</div><input data-send type="date" class="input text-xs py-1.5" value="${ymd(data.entity.end_date)}"></label>
        <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Invoice lead</div><input data-slead type="number" class="input text-xs py-1.5" style="width:80px" value="7"></label>
        <button type="button" data-gen class="btn-primary text-xs px-3 py-2">Generate schedule</button>
        <span data-smsg class="text-xs font-semibold"></span></div>`;
    } else {
      const scheduled = insts.reduce((a, i) => a + (i.amount || 0), 0);
      const mismatch = Math.abs(scheduled - e.contract_labor) >= 1;
      body = `<div class="flex items-end gap-3 flex-wrap mb-2">
          <label class="block"><div class="text-[10px] font-bold uppercase tracking-wide text-black/40 mb-1">Crew</div>
            <select data-crewedit="${s.id}" class="input text-xs py-1.5">${crewOptions(data.crews, s.crew_id)}</select></label>
          <div class="text-[11px] text-black/45 pb-1.5">${escapeHtml(ymd(s.start_date))} → ${escapeHtml(ymd(s.end_date))} · invoice ${s.invoice_lead_days}d before · scheduled <b data-cardsched="${s.id}">${money(scheduled)}</b><span data-cardmismatch="${s.id}" class="text-red-600"${mismatch ? "" : ' style="display:none"'}> (≠ labor)</span></div>
        </div>
        <div class="overflow-x-auto"><table class="w-full text-xs table-fixed">${COLGROUP}
          <thead><tr class="text-black/45 text-left border-b border-black/10">
            <th class="py-1.5 px-2 font-bold">#</th><th class="py-1.5 px-1.5 font-bold">Pay date</th>
            <th class="py-1.5 px-1.5 font-bold">Amount</th><th class="py-1.5 px-1.5 font-bold">Send invoice</th>
            <th class="py-1.5 px-1.5 font-bold">Note</th><th></th></tr></thead>
          <tbody>${insts.map(instRow).join("")}</tbody></table></div>
        <div class="mt-2"><button type="button" data-add="${s.id}" class="rounded-lg border border-black/15 px-3 py-1 text-[11px] font-semibold hover:bg-black/5">+ Add installment</button></div>`;
    }
    const cardAttrs = s ? ` data-card="${s.id}" data-labor2="${e.contract_labor}"` : "";
    return `<div class="rounded-xl border border-black/10 p-3 mb-3"${cardAttrs}>${header}${body}</div>`;
  }

  function scheduleSection() {
    const est = data.estimates || [];
    const t = data.totals || {};
    const qbo = data.qbo || { available: false, total: 0, payments: [] };
    const chip = (label, val, cls = "", sub = "") => `<div class="rounded-xl border border-black/10 bg-black/[0.015] px-3 py-2"><div class="text-[10px] font-bold uppercase tracking-wide text-black/35">${label}</div><div class="text-sm font-extrabold ${cls}">${money(val)}</div>${sub ? `<div class="text-[10px] text-black/40">${sub}</div>` : ""}</div>`;
    const qboRows = (qbo.payments || []).map(p => `<tr class="border-b border-black/5"><td class="py-1 px-2 text-black/60">${escapeHtml(ymd(p.date))}</td><td class="py-1 px-2 text-right tabular-nums font-semibold text-kpi-completed-text">${money(p.amount)}</td></tr>`).join("");
    const cards = est.length ? est.map(estimateCard).join("") : `<div class="text-xs text-black/45 mb-3">No converted estimates with Contract Labor found for this project yet.</div>`;
    return `
      <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-2">Payment schedules — one per estimate / change-order</div>
      ${cards}
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-4 mb-3">
        ${chip("Total contract labor", t.contract_labor)}
        <div class="rounded-xl border border-black/10 bg-black/[0.015] px-3 py-2"><div class="text-[10px] font-bold uppercase tracking-wide text-black/35">Total scheduled</div><div class="text-sm font-extrabold" data-total-scheduled>${money(t.scheduled)}</div></div>
        ${chip("Actual paid (QuickBooks)", t.paid_qbo, "text-kpi-completed-text", qbo.available ? `${(qbo.payments || []).length} payment${(qbo.payments || []).length === 1 ? "" : "s"} · project-wide` : "no crew vendor")}
      </div>
      <div>
        <div class="text-[11px] font-bold uppercase tracking-wide text-black/40 mb-1">Actual crew payments (QuickBooks)</div>
        ${!qbo.available
          ? `<div class="text-xs text-black/45">Set a crew linked to a QuickBooks vendor to track actual payments.</div>`
          : (qbo.payments || []).length
            ? `<div class="text-[11px] text-black/45 mb-1">Bill payments to the crew's vendor tagged to this project (across all estimates).</div>
               <div class="overflow-x-auto max-w-md"><table class="w-full text-xs">
                 <thead><tr class="text-black/45 text-left border-b border-black/10"><th class="py-1 px-2 font-bold">Date</th><th class="py-1 px-2 font-bold text-right">Amount</th></tr></thead>
                 <tbody>${qboRows}<tr class="border-t border-black/10"><td class="py-1 px-2 font-bold">Total paid</td><td class="py-1 px-2 text-right font-extrabold tabular-nums">${money(qbo.total)}</td></tr></tbody></table></div>`
            : `<div class="text-xs text-black/45">No payments to this crew tagged to this project in QuickBooks yet.</div>`}
      </div>`;
  }

  function render() { container.innerHTML = `<div class="p-4 sm:p-5">${offerSection()}${scheduleSection()}</div>`; wire(); }
  async function reload() { try { await load(); render(); } catch (err) { alert(`Could not reload: ${err.message}`); } }
  // Recompute the "scheduled" totals from the amount inputs and update them in
  // place — used after an installment value edit so we don't rebuild the whole
  // panel (which would lose scroll position and focus).
  function refreshTotals() {
    let grand = 0;
    container.querySelectorAll("[data-card]").forEach(card => {
      const sid = card.getAttribute("data-card");
      const labor = parseFloat(card.getAttribute("data-labor2")) || 0;
      let sum = 0;
      card.querySelectorAll('[data-f="amount"]').forEach(inp => { sum += parseFloat(inp.value) || 0; });
      grand += sum;
      const b = card.querySelector(`[data-cardsched="${sid}"]`);
      if (b) b.textContent = money(sum);
      const mm = card.querySelector(`[data-cardmismatch="${sid}"]`);
      if (mm) mm.style.display = Math.abs(sum - labor) >= 1 ? "" : "none";
    });
    const tot = container.querySelector("[data-total-scheduled]");
    if (tot) tot.textContent = money(grand);
  }
  const setMsg = (el, t, ok) => { if (el) { el.textContent = t; el.className = "text-xs font-semibold " + (ok ? "text-kpi-completed-text" : "text-red-600"); } };

  function wire() {
    // offer
    const send = container.querySelector("#oSend");
    if (send) send.addEventListener("click", async () => {
      const crew = container.querySelector("#oCrew").value;
      if (!crew) { setMsg(container.querySelector("#oMsg"), "Select a crew.", false); return; }
      send.disabled = true;
      try { await api(`/offers/project/${encodeURIComponent(entityId)}`, { method: "POST", body: JSON.stringify({ crew_id: Number(crew), labor_amount: parseFloat(container.querySelector("#oAmount").value) || 0, scope: container.querySelector("#oScope").value || null }) }); await reload(); }
      catch (err) { setMsg(container.querySelector("#oMsg"), err.message, false); send.disabled = false; }
    });
    container.querySelectorAll("[data-respond]").forEach(b => b.addEventListener("click", async () => {
      const [id, status] = b.getAttribute("data-respond").split(":");
      const note = status === "declined" ? (prompt("Reason for declining (optional):") ?? "") : "";
      try { await api(`/offers/${id}/respond`, { method: "POST", body: JSON.stringify({ status, note }) }); await reload(); } catch (err) { alert(err.message); }
    }));
    const wd = container.querySelector("[data-withdraw]");
    if (wd) wd.addEventListener("click", async () => {
      if (!confirm("Withdraw this offer so you can reassign?")) return;
      try { await api(`/offers/${wd.getAttribute("data-withdraw")}/withdraw`, { method: "POST" }); await reload(); } catch (err) { alert(err.message); }
    });

    // per-estimate: generate a schedule
    container.querySelectorAll("[data-setup]").forEach(box => {
      box.querySelector("[data-gen]").addEventListener("click", async () => {
        const body = {
          estimate_qbo_id: box.getAttribute("data-setup"),
          estimate_doc_number: box.getAttribute("data-doc") || null,
          contract_labor: parseFloat(box.getAttribute("data-labor")) || 0,
          start_date: box.querySelector("[data-sstart]").value,
          end_date: box.querySelector("[data-send]").value,
          invoice_lead_days: parseInt(box.querySelector("[data-slead]").value, 10) || 0,
          crew_id: box.querySelector("[data-screw]").value ? Number(box.querySelector("[data-screw]").value) : null,
        };
        if (!body.start_date || !body.end_date) { setMsg(box.querySelector("[data-smsg]"), "Start and end dates required.", false); return; }
        try { await api(`/payments/project/${encodeURIComponent(entityId)}/generate`, { method: "POST", body: JSON.stringify(body) }); await reload(); }
        catch (err) { setMsg(box.querySelector("[data-smsg]"), err.message, false); }
      });
    });
    // schedule edits
    container.querySelectorAll("[data-crewedit]").forEach(sel => sel.addEventListener("change", async () => {
      try { await api(`/payments/schedule/${sel.getAttribute("data-crewedit")}`, { method: "PATCH", body: JSON.stringify({ crew_id: sel.value ? Number(sel.value) : null }) }); await reload(); } catch (err) { alert(err.message); }
    }));
    container.querySelectorAll("[data-delsched]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Remove this estimate's payment schedule?")) return;
      try { await api(`/payments/schedule/${b.getAttribute("data-delsched")}`, { method: "DELETE" }); await reload(); } catch (err) { alert(err.message); }
    }));
    container.querySelectorAll("[data-add]").forEach(b => b.addEventListener("click", async () => {
      try { await api(`/payments/schedule/${b.getAttribute("data-add")}/installment`, { method: "POST", body: JSON.stringify({ amount: 0 }) }); await reload(); } catch (err) { alert(err.message); }
    }));
    container.querySelectorAll("[data-inst]").forEach(tr => {
      const id = tr.getAttribute("data-inst");
      tr.querySelectorAll("[data-f]").forEach(inp => inp.addEventListener("change", async () => {
        const f = inp.getAttribute("data-f");
        const val = f === "amount" ? (parseFloat(inp.value) || 0) : inp.value;
        // Persist the single field, then update totals in place — no full
        // re-render, so focus and scroll position are preserved.
        try { await api(`/payments/installment/${id}`, { method: "PATCH", body: JSON.stringify({ [f]: val }) }); if (f === "amount") refreshTotals(); } catch (err) { alert(err.message); }
      }));
    });
    container.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this installment?")) return;
      try { await api(`/payments/installment/${b.getAttribute("data-del")}`, { method: "DELETE" }); await reload(); } catch (err) { alert(err.message); }
    }));
  }

  render();
}
