-- 0068 Owner Guaranteed Contract Labor runs past 2026 (Luke, Oct 2026: keep $300k/mo,
-- no end date) so the Cash Flow and Revenue Forecast carry it every month.
UPDATE cashflow_overhead
   SET end_date = NULL
 WHERE name = 'General and Admin Payroll:Owner Guaranteed Contract Labor'
   AND deleted_at IS NULL;
