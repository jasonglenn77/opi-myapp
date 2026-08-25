-- 0045 Mark which recurring overhead lines are backed by QuickBooks data vs. entered
-- by hand, so the UI can highlight the manual ones (they need human upkeep — QBO never
-- refreshes them). from_qbo=1 = derived from / corresponds to a QBO account (auto items,
-- plus Rent and Owner which are QBO accounts we override); from_qbo=0 = purely manual.
ALTER TABLE cashflow_overhead
  ADD COLUMN from_qbo TINYINT(1) NOT NULL DEFAULT 1 AFTER edited;

-- The hand-entered lines (no QBO account behind them): payroll runs through an outside
-- provider, and Miscellaneous is a manual catch-all.
UPDATE cashflow_overhead SET from_qbo = 0
 WHERE name IN (
   'General and Admin Payroll:W-2 Wages',
   'Bonus / Commission',
   'General and Admin Payroll:Employer Payroll Taxes',
   'Miscellaneous'
 );
