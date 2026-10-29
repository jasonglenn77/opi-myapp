-- 0087: Where each invoice milestone's dates come from.
--   auto_history = placed by the app from the job dates + OPI's measured billing
--                  history (Mobilization on the start date, Final on the end
--                  date, due = net terms, expected paid = measured days to pay).
--                  Re-dated automatically when the job dates move.
--   manual       = a person set a date by hand; never moved automatically.
--   invoice      = follows the actual QuickBooks invoice (billing/align.py).
-- Owner decision 2026-10-28: Mobilization follows the project start date, and
-- due / expected paid are seeded from history with manual override.

ALTER TABLE project_invoice_milestones
  ADD COLUMN date_basis VARCHAR(20) NULL AFTER expected_paid_date;

UPDATE project_invoice_milestones SET date_basis = 'invoice' WHERE qbo_invoice_id IS NOT NULL;

UPDATE project_invoice_milestones SET date_basis = 'manual' WHERE qbo_invoice_id IS NULL AND edited = 1;

UPDATE project_invoice_milestones SET date_basis = 'auto_history' WHERE date_basis IS NULL;
