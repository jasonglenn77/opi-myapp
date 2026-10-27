# OPI's Google sheets — who keeps them and where their numbers come from

| Sheet | Kept by | Used for | Where its numbers come from | In the app |
|---|---|---|---|---|
| B250 13-week cash flow | Julie | Weekly cash plan | Opening = bank-feed balance (typed). Invoices and bills partly from QuickBooks, crew lines typed, several overhead lines typed with no source (W-2, bonus, Hotel Engine, Chase card) | Read nightly (`gsync/b250_cash.py`); compared line by line in Data Review → Cash flow sources |
| B151 forecast / pipeline | Sales / owners | Quotes and win stages | Typed; values should match QuickBooks estimates | Mirrored into the Pipeline nightly; differences in Data Review → Pipeline |
| Job Schedule | Office | Crew and PM assignments, dates | Typed | Drives project Assignments nightly; differences in Data Review → Schedule |
| Payment Schedule (one per project folder) | Office | Crew pay plan per job | Typed crew deal; QuickBooks bills are the actuals | Imported nightly as the crew payment schedule (sheet wins); issues in Data Review → Crew payments |
| Progress Invoice ("Ashley's tracker") | Ashley | What to invoice next, PM schedule | Typed from estimates and QuickBooks invoices | Tracker page |
| B155 Quoting Metrics | Estimators | Building a quote | Rate tables and lookups | Estimate page (quoting); comparison to QuickBooks estimates/actuals is a backlog item |

Open questions for staff about these sheets are in the "Questions for OPI" doc.
