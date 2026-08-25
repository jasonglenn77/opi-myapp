-- 0044 Add the remaining OPI-workbook recurring lines so the app forecast covers
-- everything the workbook does. Both are editable in the Overhead editor.
--
-- (1) Employer Payroll Taxes: not booked to a QBO expense account (payroll runs
--     through an outside provider), so it can't be auto-derived. Seed at the employer
--     FICA match -- a fixed statutory 7.65% of gross W-2 wages ($23,051/wk) = $1,763/wk.
--     This is a floor: OPI can raise it for FUTA/SUTA. edited=1 so sync won't touch it.
--
-- (2) Miscellaneous: the workbook's catch-all (shows ~$5k periodically). No QBO basis
--     and inherently unpredictable, so seed at $0 for OPI to set. edited=1.

INSERT INTO cashflow_overhead
  (name, category, amount, seed_amount, cadence, seed_cadence, anchor_date, seed_anchor_date, active, sort_order, edited)
SELECT 'General and Admin Payroll:Employer Payroll Taxes', 'Payroll', 1763.00, 1763.00, 'weekly', 'weekly',
       '2026-08-14', '2026-08-14', 1,
       (SELECT COALESCE(MAX(sort_order),0)+1 FROM cashflow_overhead co), 1
  FROM dual
 WHERE NOT EXISTS (SELECT 1 FROM cashflow_overhead c WHERE c.name = 'General and Admin Payroll:Employer Payroll Taxes');

INSERT INTO cashflow_overhead
  (name, category, amount, seed_amount, cadence, seed_cadence, anchor_date, seed_anchor_date, active, sort_order, edited)
SELECT 'Miscellaneous', 'Miscellaneous', 0.00, 0.00, 'monthly', 'monthly',
       '2026-08-14', '2026-08-14', 1,
       (SELECT COALESCE(MAX(sort_order),0)+1 FROM cashflow_overhead co), 1
  FROM dual
 WHERE NOT EXISTS (SELECT 1 FROM cashflow_overhead c WHERE c.name = 'Miscellaneous');
