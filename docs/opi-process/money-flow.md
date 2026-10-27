# Money flow — how cash, invoices, crew pay and expenses reach QuickBooks

Measured from the synced QuickBooks data unless noted. Dates are when we learned it.

## QuickBooks Projects switch (2026-10-28)

- OPI began using QuickBooks Projects in **December 2024** (0 projects before, 20-38 a month
  since). Old-style customer sub-jobs stopped by April 2025.
- Job costing in QuickBooks only exists from then on. Share of job-cost bills tagged to a job:
  2023 0.5%, 2024 5.5%, 2025 91%, 2026 98%. Card purchases are still mostly untagged in 2026.
- So cost-vs-estimate uses QuickBooks Projects only (`app/jobcost`). Most other mismatches
  are from 2025-26 records: current habits, not legacy. Pending estimates pile up every year.

## Bank and cash (2026-10-27)

- OPI's operating account is Prosperity checking ending 6458. QuickBooks has **two**
  registers for it: "Prosperity Checking (6458)" and "On Point Installations (6458)"
  (added 10/3/2026). Both appear to be the same bank account connected twice.
- QuickBooks shows two balances per bank account. The **book balance** is the ledger.
  The **bank balance** is what the bank feed reports. The QuickBooks API returns only the book
  balance. Intuit keeps the bank feed (balance and "For review" transactions)
  private, so no app can read it through the QuickBooks connection.
- 10/27/2026 chart of accounts: books $3.18M vs bank feed $2.13M on the On Point
  register. The books are about $1.05M high.
- $1.72M sits in QuickBooks "Payments to deposit" (undeposited funds): 28 customer
  payments, the oldest from 3/2025, never matched to a bank deposit. This likely
  explains most of the gap.
- Julie's B250 cash-flow sheet opens with the **bank-feed** balance ($2,130,249),
  typed in by hand.
- Card payoffs are not recorded in QuickBooks: no CreditCardPayment entries at all,
  and transfers stop in 2023. The only card-clearing entry is a $1.09M journal
  entry on 7/31/2026.
- Ways to get the true bank balance into the app: keep reading the B250 (today),
  connect the bank directly (e.g. Plaid), or reconcile the books so the book
  balance is right (the real fix).

## Invoices and collections

- Default terms: 35% deposit at PO, 35% at mobilization, 30% at completion, net 30.
  Many jobs drift from this (282 flagged in Data Review), and some customers hold
  retainage.
- Ashley's tracker (Progress Invoice workbook) is the office's working list of
  what to invoice next. The app's Tracker page mirrors it.

## Crew pay

- Crew deals are set early in a per-project "Payment Schedule" sheet in the
  project's Drive folder. These are the current crew plan (owner decision
  2026-10-27). B250 crew lines that disagree are flagged in Data Review.
- The crew invoices; the bookkeeper enters a QuickBooks **Bill** the same day,
  dated the Thursday before payday. It is paid every other Friday (payday anchor 1/2/2026).
- Crew labor is about 72% of job cost ($8.1M in 2026) and is the most timely
  data in QuickBooks: entered within 0-1 days.
- W-2 office payroll runs in QuickBooks Payroll, which the QuickBooks API doesn't
  expose. It needs a payroll register export.

## Project expenses (2026-10-27)

How non-crew job costs reach QuickBooks, from 2026 entry dates:

| Path | 2026 job cost | How it arrives | Delay |
|---|---|---|---|
| Crew labor | $8.1M (72%) | Crew invoice → Bill | Same day |
| Vendor bills | $2.8M (25%) | Ordered by phone or portal; nothing recorded until the vendor's invoice arrives → Bill | Lifts ~7 days (bill every 28-day cycle), Hotel Engine ~16 (one monthly bill), fasteners (TMK) ~15; paid ~18 days after entry, mostly by check from Prosperity |
| Card purchases | $1.28M on cards, only $0.36M (28%) tagged to a job | Charge comes in on the card feed and is categorized later by the bookkeeper | 12 days on average, 26 in September, some July charges in mid-October |

- There are no purchase orders or commitments in QuickBooks, and no receipt-first
  entry. QuickBooks is the right record of **actual** cost but is 1-3 weeks late
  for rentals and lodging and incomplete for card spend.
- Lifts ran about 136% of estimate in the sample checked: nobody sees the cost
  until the bill arrives, so a lift that wasn't called off keeps billing.
- Over 24 months on finished jobs: lodging actuals were 69% of estimate, propane
  49%, travel 48%. Many jobs had $0 actual in those categories, which points to
  spend not tagged to the job (card purchases, Hotel Engine) rather than savings.
  Live numbers are on the Assumptions page.

**What the app does about it:** expense schedules are spread by each category's
measured timing (see [assumptions.md](assumptions.md)). Planned: PMs log
commitments (lift orders with call-off dates, lodging bookings, material orders)
and upload receipts tagged to the job, so cost is visible before the bill.

## Overhead

- Recurring overhead in the app comes from a trailing 13-week QuickBooks run-rate.
  Lines with no system of record keep the B250 value and are badged "B250 · no
  source": W-2 wages, bonus/commission, Hotel Engine, Chase card.
- The B250 "Hotel Engine" overhead line ($150k/month) likely overlaps lodging
  already scheduled per project. Retire it once project lodging schedules are
  trusted.
