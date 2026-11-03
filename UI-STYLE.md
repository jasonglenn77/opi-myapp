# OPI app UI style

The app has a **dark page** (`body` is `bg-ink-900` #0b0f14 with white text) and
**white cards** on top of it. Almost every color bug comes from styling an element
for the wrong one of those two surfaces. Before styling anything, ask: does this sit
on the dark page, or inside a white `.card` / modal / drawer?

## The two surfaces

| | On the dark page | Inside a white card, modal or drawer |
|---|---|---|
| Text | `text-white`, secondary `text-white/60` | `text-ink-900`, secondary `text-black/55`, faint `text-black/45` |
| Borders | `border-white/10` to `/30` | `border-black/10` (rows `border-black/[0.05]`) |
| Subtle fill | `bg-white/5` | `bg-slate-50` / `#f1f5f9` |
| Selected / active | **white** fill, dark text | dark or brand fill, white text |
| Never | `bg-ink-900`, `text-black/*`, `border-black/*` (all invisible) | translucent `bg-white/NN` (invisible) |

## Components to reuse (don't hand-roll)

- **Tabs:** `.tabs` + `.tab`, selected tab marked `aria-selected="true"` (styles.css).
  Works on the dark page (white selected pill) and inside a `.card` (light track).
  Examples: Contractor Payments, Progress Checks. (Tracker's `.at-tabs` and the
  `bg-white/5` strips on Crew Operations and Teams are the same look, older code.)
- **Card:** `.card` (white, rounded-2xl, soft shadow). Put tables and forms in one.
- **Buttons:** `.pd-btn` for small white buttons (in cards *and* on the dark page,
  e.g. "Export to Excel"); `.btn-primary` (forest green `brand-500`) for the one main
  action; `.btn-outline` for a secondary action on the dark page.
- **Inputs / selects:** `.input` (white, dark text) on either surface.
- **Status chips:** `chip(text, C.good|warn|bad|info|quiet)` (see crew-payments.js):
  emerald = done/fine, amber = check this, rose = problem, sky = info, slate = neutral.
  These are semantic; don't use them as decoration.
- **KPI tiles:** white cards with a small uppercase label, a big bold number, and a
  one-line caption. A red number means it needs attention.

## Colors

- Brand: forest green `brand-500` #4f7f61 (hover `brand-600`). Use for primary
  actions only.
- Ink: `ink-900` #0b0f14 (page), `ink-800` #111827 (dark text on white).
- Money columns: `tabular-nums`, right-aligned.

## Checklist for a new page

1. Tabs, buttons, inputs, chips: use the shared classes above.
2. Anything on the dark page: is it visible against #0b0f14? (No `bg-ink-900`,
   no `text-black`.)
3. Anything inside a card: dark text, `black/` borders.
4. Popups appended to `<body>` are outside any card: give them `bg-white` (dark
   text is forced automatically) or explicit text colors.
5. Look at it in the browser before calling it done.
