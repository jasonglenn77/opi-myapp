# Cash Flow Forecast — Feature Documentation

_Last updated: 2026-06-13_

## What it is

A 13‑week cash flow page that replaces the manually-maintained spreadsheet. It pulls
directly from QuickBooks and shows two views:

- **Forecast** — what cash is *expected* to come in and go out over the next 13 weeks.
- **Actuals** — what cash *actually* moved historically, over any date range you choose.

Both show the same shape your spreadsheet used: Opening balance → Cash Inflow →
Cash Outflow → Surplus/(Deficit) → Ending balance, rolling week to week.

**Who can see it:** Admins and office staff (the `page.cashflow` permission). Not PMs or crew.
**Where:** the **Cash Flow** item in the left nav.

---

## The two modes

### Forecast (forward 13 weeks)

| Row | Where it comes from |
|---|---|
| **Cash Inflow** | Open invoices, placed in the week of their **due date** (expected collection) |
| **Cash Outflow → A/P** | Open bills, placed in the week of their **due date** (scheduled payments) |
| **Cash Outflow → Recurring** | A weekly **run‑rate** for payroll + overhead (Occupancy, Office & IT, Professional Fees, Travel, Taxes & Insurance, Charitable), derived from the trailing 13 weeks of actual spend |
| **Opening balance** | Your QuickBooks bank balance (auto-filled; editable) |

The forecast assumes invoices/bills are paid on their due dates, and that recurring
overhead continues at its recent average.

### Actuals (historical, choose a date range)

| Row | Where it comes from |
|---|---|
| **Cash Collected** | Actual customer **Payments**, by the date received |
| **Cash Paid Out → Bill payments** | Actual **Bill Payments** to vendors/contractors, by date |
| **Cash Paid Out → Direct expenses** | **Purchases** (card/check spend), grouped by expense category, by date |

Use the **# weeks** field (e.g. 13, 26, 52) and **Start week ending** to look back over
any window.

---

## How to read the grid

- **Columns** are weeks, ending on Fridays (matching the old spreadsheet).
- **Rows** are grouped: Opening Cash Balance, Cash Inflow, Cash Outflow (with expandable
  sub-sections), Total Surplus/(Deficit), and Ending Cash Balance.
- Click the **▸ chevron** on any subtotal row to drill into the detail (per customer,
  per vendor, per expense category).
- **Negative numbers** show in red and parentheses.
- **KPI cards** at the top: ending balance at the last week, the **lowest cash point**
  (and which week it hits), total inflow, and total outflow for the window.

---

## Opening balance (automatic)

The opening cash balance **auto-fills from your QuickBooks bank accounts** (sum of bank
`CurrentBalance`), with a note showing which accounts it used. You can type over it to
override for a what-if. It's QuickBooks' *book* balance as of the last sync, so it can
differ slightly from your cleared bank balance (uncleared checks/deposits).

---

## Categories filter (operating vs. excluded)

Not every expense category is true operating cash — some are bank transfers, credit‑card
payments, loan principal, or accounting entries that would distort cash-out. The
**Categories** button opens a panel to manage this:

- Every expense category is listed with its **trailing‑12‑month total** for context.
- Each is auto-labeled from its QuickBooks **account classification**:
  - **Operating** (green) — a P&L Expense account; counts as cash-out.
  - **Suggested** (amber) — not an Expense account (Asset/Liability/Revenue), so it's a
    transfer/financing/capex item you probably want to exclude.
- **Apply suggested exclusions** ticks all the suggested ones in one click. Review, then **Save**.
- Settings are **saved in the database and shared** across all users, so everyone sees the
  same definition of operating cash.
- Exclusions apply to the **Actuals** cash-out. (The Forecast run-rate already only counts
  operating overhead, so it isn't affected.)

> Tip: `Payroll Liabilities` and `FIT Payable` are flagged as suggested. Confirm with
> whoever runs payroll whether your `General and Admin Payroll` already includes those —
> if so, excluding them avoids double-counting.

---

## Where the data comes from & how to refresh it

All figures come from QuickBooks via the existing sync:

| Cash Flow data | QuickBooks source |
|---|---|
| Inflow (forecast) | Invoices |
| Inflow (actuals) | Payments |
| Outflow A/P (forecast) | Bills |
| Outflow bill payments (actuals) | Bill Payments |
| Outflow expenses / run-rate | Purchases |
| Opening balance + category classification | Chart of Accounts |

**To refresh:** go to the **QuickBooks** page and click **Sync transactions now**. That one
action pulls all the transaction types *and* refreshes the chart of accounts / bank
balances. It runs incrementally (only what changed since the last sync), so it's quick to
re-run any time. No separate cash-flow sync is needed.

---

## Current limitations / planned next

- **Forecast inflow tapers after ~5 weeks** — only actual open invoices exist that far out.
  Pulling *forecasted* revenue from accepted estimates/scheduled jobs is planned to fill the
  later weeks.
- **Recurring rows are run-rates, not your budget** — they reflect recent actual spend. The
  planned **per-cell overrides + monthly snapshots** will let you hand-adjust any figure
  (e.g. set payroll to budget) and save a named month you can archive and revisit.
- **Bank balance is QuickBooks' book balance** (see Opening balance note above).
