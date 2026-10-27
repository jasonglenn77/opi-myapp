# How OPI works — process notes and learnings

A running record of how On Point Installers actually does things today (Google
Drive sheets + QuickBooks), what we learned from their data, and what the app
does about it. Add to it whenever we learn something; date every entry.

The rule behind all of it: never copy a number from an OPI sheet without knowing
where the sheet got it. Trace each value to its system of record (QuickBooks,
the bank, payroll). Where none exists, keep the sheet's value, label it, and
list it in Data Review.

| Note | What it covers |
|---|---|
| [money-flow.md](money-flow.md) | Bank and cash, invoices and collections, crew pay, project expenses, overhead. How each reaches QuickBooks and how timely it is |
| [sheets.md](sheets.md) | OPI's Google sheets (B250, B151, Job Schedule, Payment Schedules, Ashley's tracker): who keeps them, where their numbers come from |
| [assumptions.md](assumptions.md) | Averages and rules the app uses to place dates and money, and why. The live values are on the app's Assumptions page |

Where to look in the app:

- **Data Review** (`#/review`): every place OPI's sheets, QuickBooks and the app disagree.
- **Assumptions** (`#/assumptions`): every measured average and fixed rule behind a date or amount.
- **Questions for OPI** (Claude doc shared with staff): open questions only OPI can answer.
