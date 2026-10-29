# Assumptions the app uses — and why

The live values, with the evidence behind each one, are on the app's
**Assumptions** page (`#/assumptions`). This note records why each exists.

Principle (owner, 2026-10-27): every average or rule that drives a date, an
amount or a document must be visible in the app and easy to review. Measured
values show what they were measured from; fixed rules are read from the code so
the page can't drift from what runs.

## Expense timing (added 2026-10-27, migration 0084)

**Problem.** Project expense estimates were spread evenly across the job weeks.
No category behaves that way, and OPI has no receipts or purchase orders for
lodging and rentals, so the forecast needs a reasonable default date.

**Decision.** Auto-fill dates from measured history, never leave them blank. A
blank date drops the cost out of the cash forecast, making cash look better
than it is. Unconfirmed amounts get flagged instead (planned: kickoff checklist
before start).

**How.** Nightly, after the QuickBooks sync, `app/assumptions/calibrate.py`
looks at 24 months of job-tagged bills and card purchases. For each category it
measures:

- the dollar share by when the bill is dated relative to the job's scheduled
  start/end (before start, each quarter of the job, up to 30 days after, later);
- bill-to-payment days (BillPayment date minus Bill date, dollar-weighted);
- entry delay (when it was entered in QuickBooks minus its date).

New expense schedules are spread by that profile. Each row's paid date is the
bill week plus the payment lag. Categories measured from fewer than 15 jobs fall
back to even. Rows edited by hand are never re-spread. Owners can override any
profile on the page. "Re-spread auto expense rows" rebuilds untouched rows on
active projects.

First measurement (2026-10-27, dev copy of prod data):

| Category | Before start | During job | ≤30 days after end | Later | Bill → paid |
|---|---|---|---|---|---|
| Rentals (mostly lifts) | 4% | 57% | 33% | 5% | 27 days |
| Lodging | 4% | 70% | 23% | 3% | 13 days |
| Materials | 20% | 67% | 8% | 5% | 28 days |
| Propane | 3% | 62% | 30% | 5% | 31 days |
| Travel | 27% | 62% | 7% | 4% | 14 days |

**Not applied:** actual-vs-estimate ratios. They are shown for review only,
because low actuals mostly reflect untagged spend, not savings.

## Lodging dates (added 2026-10-28, migration 0086)

Lodging follows Hotel Engine's billing calendar instead of a timing profile. A job's
lodging estimate is spread evenly over its scheduled nights. Each calendar month's
nights are billed on the statement dated around the 11th of the following month,
and paid after the measured lag (median 4 days; due 10 days). These are measured
nightly from Hotel Engine's monthly statements (`calibrate.measure_lodging_billing`),
shown on the Assumptions page, and can be overridden.

On the Billing & Schedule tab, each lodging row shows "est. · Hotel Engine · <month>
stays", and the Lodging section explains the estimate. Each row carries two dates:
- **Expected bill date:** drives job cost and burn-down.
- **Expected paid:** when cash leaves; the forecast uses it.

When the real statement posts, it burns the plan down and its due date takes over.

## Invoice dates (added 2026-10-28, migration 0087)

**Owner rules (from OPI).** Larger jobs bill 35% at PO, 35% at start (Mobilization), and 30% at
completion (Final). Change orders and small jobs are billed once, in full. The Mobilization invoice
goes out on the project's start date, and when the start date changes it moves too.

**What we found.** Invoice dates were copied from the job dates once, when the schedule was first
built, and never updated. Jobs scheduled after their estimate was accepted (Mygrant Urbandale, BGI)
had no Mobilization or Final dates at all, so that money sat in the "not yet dated" backlog, off
the weekly grid. Jobs that moved (PPG Mojave) kept old dates and showed as overdue.

**How it works now** (`billing/invoice_dates.py`):
- Mobilization = start date; Final and a single full invoice = end date; the deposit sits at its
  measured timing (median 45 days before start), never before the estimate date.
- Due date = invoice date + the schedule's net terms.
- Expected paid = invoice date + the measured days customers took to pay that kind of invoice
  (deposit 34, Mobilization 31, Final 29, full 34; 24 months of matched QuickBooks invoices).
- These rows are marked `auto_history` ("auto · history" on the Billing tab) and are re-dated
  whenever the job dates change (Assignment save, nightly Job Schedule import, Billing tab open,
  nightly calibration). Typing a date makes it `manual`, which is never moved ("↺ auto" hands it
  back). A row that is a QuickBooks invoice (`invoice`) follows the invoice.
- Completed projects are not re-dated: their leftover balance is a Data Review item.

**One invoice or 35/35/30** is measured too: estimates under $10k were billed in one invoice 83% of
the time (vs 26% at $10-25k, where two invoices is most common), and change orders 86%. New
schedules for change orders (as classified on the Change Orders tab) and estimates under the
threshold get one "Payment in full (at completion)" row. Untouched 35/35/30 plans that match are
converted. Custom project terms always win. Both rules are on the Assumptions page with the
evidence, and can be overridden.

## Crew pay vs the B250 (2026-10-28)

The app reads each job's crew Payment Schedule from Drive every night, so the difference from the
B250 (12 weeks: B250 $1.91M, app $1.60M) is not missing data. It comes from:
1. **Stale Payment Schedules.** About $291k of unpaid installments are dated before this week,
   mostly jobs that moved after the sheet was made (Sysco Walnut CA: sheet dated Jan-Apr 2026,
   job now starts 10/19; Sysco Denver: dated May-June). The app shows them as overdue, not in the
   weekly totals. The B250 puts that crew pay in the coming weeks.
2. **Jobs with no Payment Schedule.** About $393k on 15 jobs comes from the estimate's labor split
   evenly (Amazon Dallas $231k), not from a sheet.
3. **Crew naming.** The B250 names some crews differently (ABM = A&B Installations, Gomez = JG
   Pallet Rack); Data Review maps them by payment amounts and compares per crew.
