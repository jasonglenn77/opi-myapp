-- 0041 Align recurring overhead to reality / OPI workbook reconciliation.
-- Two high-confidence corrections found by reconciling our QBO-history-derived
-- run-rate against OPI's cashflow workbook + the underlying QBO transactions:
--
-- (1) Occupancy:Rent was auto-derived as $23,629/wk ($1.23M/yr). The QBO "Rent"
--     account holds two genuine recurring $20k/mo transfers (Pensacola + Dillon =
--     $40k/mo) PLUS ~$748k/yr of one-time / miscategorized junk (an IRS payment,
--     furniture, appliances, cost-segregation, alarm installs, TaskRabbit, etc.).
--     Cadence was mis-detected as weekly, so the whole polluted annual total got
--     amortized weekly. Reset to the true recurring rent: $40,000/month.
--
-- (2) W-2 base payroll wages (~$23,051/wk per OPI's workbook) are absent from ours
--     because gross wages never appear as QBO Purchase/Bill expense lines (they flow
--     through payroll/liability accounts our run-rate seed can't see). Add as a
--     manual item so the forecast includes it. Kept as edited=1 so sync won't touch it.

-- (1) Rent: junk-amortized weekly -> true recurring monthly. Keyed by name (dev+prod safe).
UPDATE cashflow_overhead
   SET amount = 40000.00,
       cadence = 'monthly',
       anchor_date = '2026-07-30',
       edited = 1
 WHERE name = 'Occupancy:Rent'
   AND deleted_at IS NULL;

-- (2) Add W-2 base wages (QBO-invisible; sourced from OPI workbook). Idempotent.
INSERT INTO cashflow_overhead
  (name, category, amount, seed_amount, cadence, seed_cadence, anchor_date, seed_anchor_date, active, sort_order, edited)
SELECT 'General and Admin Payroll:W-2 Wages', 'Payroll', 23051.00, 23051.00, 'weekly', 'weekly',
       '2026-08-14', '2026-08-14', 1,
       (SELECT COALESCE(MAX(sort_order),0)+1 FROM cashflow_overhead co), 1
  FROM dual
 WHERE NOT EXISTS (
   SELECT 1 FROM cashflow_overhead co2 WHERE co2.name = 'General and Admin Payroll:W-2 Wages'
 );
