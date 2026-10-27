-- 0082: Where each recurring-overhead amount comes from, so the Cash Flow page
-- and Data Review can tell sourced lines from values copied off OPI's B250.
--   qbo_runrate = trailing QBO run-rate (auto items) or confirmed against QBO
--   b250        = typed on OPI's B250 cash-flow sheet; no system of record found
--                 yet (owner decision 2026-10-27: keep the B250 value, list it
--                 in Data Review until a real source exists)
--   manual      = entered in the app by a user
-- Owner payroll and rent were checked against QBO postings (amount + month-end
-- timing), so they stay qbo_runrate even though 0080 re-anchored them.

ALTER TABLE cashflow_overhead
  ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'qbo_runrate' AFTER from_qbo,
  ADD COLUMN source_note VARCHAR(255) NULL AFTER source;

UPDATE cashflow_overhead SET source = 'manual'
WHERE from_qbo = 0 AND edited = 1;

UPDATE cashflow_overhead
SET source = 'b250',
    source_note = 'B250 W-2 Payroll line. W-2 payroll is not in the QBO API (runs in QuickBooks Payroll / provider), needs a payroll register.'
WHERE name LIKE '%W-2 Wages' AND deleted_at IS NULL;

UPDATE cashflow_overhead
SET source = 'b250',
    source_note = 'B250 Bonus/Commission line. No QBO account carries bonuses or commissions, needs the payroll register and commission plan.'
WHERE name = 'Bonus / Commission' AND deleted_at IS NULL;

UPDATE cashflow_overhead
SET source = 'b250',
    source_note = 'B250 Hotel Engine line. QBO Hotel Engine bills average about $111.5k/mo since July, may overlap lodging already in project expense schedules.'
WHERE name = 'Hotel Engine' AND deleted_at IS NULL;

UPDATE cashflow_overhead
SET source = 'b250',
    source_note = 'B250 Chase Credit Card line. Card payments now mirror from QBO (CreditCardPayment/Transfer), needs statement balances and due dates.'
WHERE name = 'Chase credit card' AND deleted_at IS NULL;
