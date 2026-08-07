-- Backfill: snap un-edited crew pay dates (and their send-invoice dates) to Friday.
--
-- Existing crew schedules were generated with pay_date = start_date + 14*i, which
-- kept the project's start weekday (often Monday). OPI pays crews on Fridays
-- (payroll day), and the code now generates Friday dates (_friday_on_or_after in
-- payments/routes.py). This one-time backfill brings already-generated schedules
-- in line. Each column is snapped to its own next Friday (WEEKDAY: Mon=0..Fri=4),
-- which for the standard 7-day lead keeps send-invoice exactly one week before pay.
--
-- Only un-edited rows (edited = 0) are touched; hand-edited rows are left exactly
-- as the office set them. Rows already on a Friday are skipped (no-op guard).

UPDATE project_payment_installments
SET pay_date = pay_date + INTERVAL ((4 - WEEKDAY(pay_date) + 7) % 7) DAY
WHERE edited = 0 AND pay_date IS NOT NULL AND WEEKDAY(pay_date) <> 4;

UPDATE project_payment_installments
SET send_invoice_date = send_invoice_date + INTERVAL ((4 - WEEKDAY(send_invoice_date) + 7) % 7) DAY
WHERE edited = 0 AND send_invoice_date IS NOT NULL AND WEEKDAY(send_invoice_date) <> 4;
