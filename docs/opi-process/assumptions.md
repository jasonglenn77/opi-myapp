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
