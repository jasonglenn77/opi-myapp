-- 0042 Add an editable Bonus / Commission recurring line.
-- OPI pays bonuses/commissions through their external payroll provider, so they
-- never appear in QBO expense accounts (a scan of trailing-12-mo activity finds no
-- bonus/commission account and only 3 stray memo mentions). There is therefore no
-- QBO history to seed from -- this is a manual line seeded at $0 for OPI to enter
-- their own amount + cadence; once set, it projects into the 13-week forecast like
-- any other recurring item. Kept edited=1 so the nightly sync never overwrites it.
INSERT INTO cashflow_overhead
  (name, category, amount, seed_amount, cadence, seed_cadence, anchor_date, seed_anchor_date, active, sort_order, edited)
SELECT 'Bonus / Commission', 'Payroll', 0.00, 0.00, 'monthly', 'monthly',
       '2026-08-14', '2026-08-14', 1,
       (SELECT COALESCE(MAX(sort_order),0)+1 FROM cashflow_overhead co), 1
  FROM dual
 WHERE NOT EXISTS (
   SELECT 1 FROM cashflow_overhead co2 WHERE co2.name = 'Bonus / Commission'
 );
