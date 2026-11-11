// Step cards: a checklist where every step is a card you can open. Closed, a card
// shows the step's state, what the app knows ("Invoiced Oct 12 ($75,340)") and its
// quick buttons; open, it shows the tools for that step (the PO, the PM workload,
// the crew offer, the schedules…). Used by Project Setup and Project Closeout so a
// person sees the whole job at a glance and digs into any one step in place.
//
//   stepCardHtml({ key, state, label, detail, actions, open })  -> html
//   bindStepCards(root, { onOpen(key, bodyEl, cardEl) })        -> { open(key, {scroll}), setHead(key, html-parts) }
//
// Bodies are built the first time a card opens (onOpen), then kept, so editors
// inside keep their state when the card closes and opens again.
import { escapeHtml as esc } from "./html.js";
import { chip, C } from "./ui.js";

export const STATE_CHIP = {
  done: ["Done", C.good], not_needed: ["Not needed", C.quiet], todo: ["To do", C.warn],
  waiting: ["Waiting", C.info], locked: ["Later", C.quiet], confirmed: ["Done", C.good],
};
export const STATE_ICON = {
  done: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#059669"/><path d="M6 10.5l2.5 2.5L14 7.5" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  not_needed: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#f1f5f9" stroke="#94a3b8"/><path d="M6.5 10h7" stroke="#64748b" stroke-width="2" stroke-linecap="round"/></svg>`,
  todo: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#fff" stroke="#d97706" stroke-width="2"/></svg>`,
  waiting: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#e0f2fe" stroke="#0284c7" stroke-width="1.5"/><path d="M10 6v4l2.5 1.5" stroke="#0284c7" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>`,
  locked: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="#f8fafc" stroke="#cbd5e1" stroke-dasharray="2 2"/></svg>`,
};
STATE_ICON.confirmed = STATE_ICON.done;

const CHEV = `<svg class="sc-chev" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M7 5l5 5-5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// The closed part of a card. `detail` is plain text; `actions` and `extra` are html.
export function stepHeadInner({ state, label, detail, actions = "", extra = "", hint = "" }) {
  const [txt, cls] = STATE_CHIP[state] || [state, C.quiet];
  return `${CHEV}${STATE_ICON[state] || STATE_ICON.todo}
    <div class="min-w-0 flex-1">
      <div class="text-sm font-semibold text-ink-900">${esc(label)} ${chip(txt, cls)}${hint ? ` <span class="sc-hint">${esc(hint)}</span>` : ""}</div>
      ${detail ? `<div class="text-xs text-black/55 mt-0.5">${esc(detail)}</div>` : ""}${extra}
    </div>
    ${actions ? `<div class="sc-act">${actions}</div>` : ""}`;
}

export function stepCardHtml(s) {
  return `<div class="sc${s.open ? " open" : ""}" data-sc="${esc(s.key)}" data-state="${esc(s.state)}">
    <div class="sc-head" role="button" tabindex="0" aria-expanded="${s.open ? "true" : "false"}">${stepHeadInner(s)}</div>
    <div class="sc-body"${s.open ? "" : " hidden"}></div>
  </div>`;
}

export function bindStepCards(root, { onOpen }) {
  const built = new WeakSet();
  const cardOf = (key) => root.querySelector(`.sc[data-sc="${CSS.escape(key)}"]`);
  function setOpen(card, on) {
    card.classList.toggle("open", on);
    card.querySelector(".sc-head").setAttribute("aria-expanded", String(on));
    const body = card.querySelector(".sc-body");
    body.hidden = !on;
    if (on && !built.has(body)) {
      built.add(body);
      body.innerHTML = `<div class="text-xs text-black/45">Loading…</div>`;
      Promise.resolve(onOpen(card.dataset.sc, body, card)).catch((e) => { body.innerHTML = `<div class="text-xs text-rose-700">Couldn't load: ${esc(e?.message || String(e))}</div>`; });
    } else if (on) {
      card.dispatchEvent(new CustomEvent("sc:reopen", { bubbles: true, detail: { key: card.dataset.sc, body } }));
    }
  }
  root.addEventListener("click", (e) => {
    const head = e.target.closest(".sc-head");
    if (!head || !root.contains(head)) return;
    if (e.target.closest("button, a, input, select, textarea, label")) return;   // the card's own buttons
    const card = head.closest(".sc");
    setOpen(card, !card.classList.contains("open"));
  });
  root.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("sc-head")) {
      e.preventDefault();
      const card = e.target.closest(".sc");
      setOpen(card, !card.classList.contains("open"));
    }
  });
  // cards rendered open: build their bodies now
  root.querySelectorAll(".sc.open").forEach((c) => { c.classList.remove("open"); setOpen(c, true); });
  return {
    open(key, { scroll = true } = {}) {
      const card = cardOf(key);
      if (!card) return;
      if (!card.classList.contains("open")) setOpen(card, true);
      if (scroll) card.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    // re-draw a card's closed part (after a save) without touching its open body
    setHead(key, parts) {
      const card = cardOf(key);
      if (!card) return;
      card.dataset.state = parts.state;
      card.querySelector(".sc-head").innerHTML = stepHeadInner(parts);
    },
    isOpen: (key) => !!cardOf(key)?.classList.contains("open"),
  };
}
