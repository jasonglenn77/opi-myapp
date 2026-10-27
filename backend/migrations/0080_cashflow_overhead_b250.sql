-- 0080: Recurring overhead aligned to OPI's "B250.OP.13 Week Cash Flow
-- Forecast" (tab "October 26-1", weeks ending 10/23/2026-1/15/2027).
-- Owner decisions 2026-10-26. Keyed by item NAME (ids differ per database),
-- idempotent, and every touched row gets edited = 1 so the nightly run-rate
-- refresh (overhead.refresh_auto_from_runrate) never overwrites it. Each
-- change is logged to cashflow_overhead_history (actor "B250 alignment").
--
-- Names with a ":" are built with CHAR(58) because the migration runner binds
-- ":word" as a parameter.
--
--  * W-2 wages            -> $31,174.75 biweekly, anchored Fri 10/30/2026
--                            (sheet payroll Fridays 10/30, 11/13, ... 1/8)
--  * Employer payroll tax -> removed (sheet's W-2 payroll line is the whole
--                            payroll debit; no separate tax line)
--  * Bonus / Commission   -> $30,000 monthly on the 1st (sheet 11/6, 12/4, 1/1)
--  * Owner payroll $300k  -> anchor Fri 10/30/2026 (sheet 10/30, 12/4, 1/8)
--  * Rent $40k            -> anchor Fri 10/30/2026 (sheet 10/30, 12/4, 1/8)
--  * Hotel Engine (new)   -> $150,000 monthly anchored 11/20/2026 (sheet 11/20, 12/25)
--  * Chase credit card    -> $20,000 weekly anchored Fri 10/30/2026 (sheet, every week)
--  * Card-paid run-rate lines removed (>= 85% of trailing-12-month spend was
--    on Chase cards, so the $20k/wk card line already covers them):
--    Meals Job Related, Travel Job Related, Travel and Entertainment (+ its
--    Automobile / Meals / Travel), Office and IT Business Licenses /
--    Communication and Internet / Computer and Software / Office Supplies and
--    General / Postage and Shipping.
--    Kept (mostly bank-paid): Entertainment - NDE, Parking Fees and Tolls,
--    Dues and Subscriptions, Bank and Service Charges, Charitable.

CREATE TABLE IF NOT EXISTS cashflow_overhead (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(80) NULL,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  seed_amount DECIMAL(14,2) NULL,
  cadence VARCHAR(16) NOT NULL DEFAULT 'monthly',
  seed_cadence VARCHAR(16) NULL,
  anchor_date DATE NULL, seed_anchor_date DATE NULL, end_date DATE NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  edited TINYINT(1) NOT NULL DEFAULT 0,
  from_qbo TINYINT(1) NOT NULL DEFAULT 1,
  deleted_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cashflow_overhead_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  overhead_id INT NOT NULL,
  action VARCHAR(16) NOT NULL,
  actor VARCHAR(255) NULL,
  item_name VARCHAR(120) NULL,
  old_amount DECIMAL(14,2) NULL, new_amount DECIMAL(14,2) NULL,
  old_cadence VARCHAR(16) NULL, new_cadence VARCHAR(16) NULL,
  old_anchor_date DATE NULL, new_anchor_date DATE NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_oh_hist (overhead_id, id)
) ENGINE=InnoDB;

-- ---- W-2 wages: $31,174.75 biweekly from Fri 10/30/2026 ----
INSERT INTO cashflow_overhead
  (name, category, amount, seed_amount, cadence, seed_cadence, anchor_date, seed_anchor_date,
   active, sort_order, edited, from_qbo)
SELECT CONCAT('General and Admin Payroll', CHAR(58), 'W-2 Wages'), 'Payroll', 31174.75, 31174.75,
       'biweekly', 'biweekly', '2026-10-30', '2026-10-30', 1,
       (SELECT COALESCE(MAX(o.sort_order), 0) + 1 FROM cashflow_overhead o), 1, 0
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM cashflow_overhead WHERE name LIKE '%W-2 Wages' AND deleted_at IS NULL);

INSERT INTO cashflow_overhead_history
  (overhead_id, action, actor, item_name, old_amount, new_amount, old_cadence, new_cadence, old_anchor_date, new_anchor_date)
SELECT id, 'edit', 'B250 alignment (migration 0080)', name, amount, 31174.75, cadence, 'biweekly', anchor_date, '2026-10-30'
FROM cashflow_overhead
WHERE name LIKE '%W-2 Wages' AND deleted_at IS NULL
  AND NOT (amount = 31174.75 AND cadence = 'biweekly' AND anchor_date = '2026-10-30');

UPDATE cashflow_overhead SET amount = 31174.75, cadence = 'biweekly', anchor_date = '2026-10-30', active = 1, edited = 1
WHERE name LIKE '%W-2 Wages' AND deleted_at IS NULL;

-- ---- Employer payroll taxes: removed (inside the sheet's payroll figure) ----
INSERT INTO cashflow_overhead_history
  (overhead_id, action, actor, item_name, old_amount, new_amount, old_cadence, new_cadence, old_anchor_date, new_anchor_date)
SELECT id, 'delete', 'B250 alignment (migration 0080)', name, amount, NULL, cadence, NULL, anchor_date, NULL
FROM cashflow_overhead WHERE name LIKE '%Employer Payroll Taxes' AND deleted_at IS NULL;

UPDATE cashflow_overhead SET deleted_at = NOW(), edited = 1
WHERE name LIKE '%Employer Payroll Taxes' AND deleted_at IS NULL;

-- ---- Bonus / Commission: $30,000 monthly on the 1st ----
INSERT INTO cashflow_overhead
  (name, category, amount, seed_amount, cadence, seed_cadence, anchor_date, seed_anchor_date,
   active, sort_order, edited, from_qbo)
SELECT 'Bonus / Commission', 'Payroll', 30000, 30000, 'monthly', 'monthly', '2026-11-01', '2026-11-01', 1,
       (SELECT COALESCE(MAX(o.sort_order), 0) + 1 FROM cashflow_overhead o), 1, 0
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM cashflow_overhead WHERE name = 'Bonus / Commission' AND deleted_at IS NULL);

INSERT INTO cashflow_overhead_history
  (overhead_id, action, actor, item_name, old_amount, new_amount, old_cadence, new_cadence, old_anchor_date, new_anchor_date)
SELECT id, 'edit', 'B250 alignment (migration 0080)', name, amount, 30000, cadence, 'monthly', anchor_date, '2026-11-01'
FROM cashflow_overhead
WHERE name = 'Bonus / Commission' AND deleted_at IS NULL
  AND NOT (amount = 30000 AND cadence = 'monthly' AND anchor_date = '2026-11-01');

UPDATE cashflow_overhead SET amount = 30000, cadence = 'monthly', anchor_date = '2026-11-01', active = 1, edited = 1
WHERE name = 'Bonus / Commission' AND deleted_at IS NULL;

-- ---- Owner payroll ($300k) + Rent ($40k): anchor Fri 10/30/2026 ----
INSERT INTO cashflow_overhead_history
  (overhead_id, action, actor, item_name, old_amount, new_amount, old_cadence, new_cadence, old_anchor_date, new_anchor_date)
SELECT id, 'edit', 'B250 alignment (migration 0080)', name, amount, amount, cadence, 'monthly', anchor_date, '2026-10-30'
FROM cashflow_overhead
WHERE deleted_at IS NULL
  AND (name LIKE '%Owner Guaranteed Contract Labor' OR (category = 'Occupancy' AND name LIKE '%Rent'))
  AND NOT (cadence = 'monthly' AND anchor_date = '2026-10-30');

UPDATE cashflow_overhead SET cadence = 'monthly', anchor_date = '2026-10-30', edited = 1
WHERE deleted_at IS NULL
  AND (name LIKE '%Owner Guaranteed Contract Labor' OR (category = 'Occupancy' AND name LIKE '%Rent'));

-- ---- New: Hotel Engine $150,000 monthly from 11/20/2026 ----
INSERT INTO cashflow_overhead
  (name, category, amount, seed_amount, cadence, seed_cadence, anchor_date, seed_anchor_date,
   active, sort_order, edited, from_qbo)
SELECT 'Hotel Engine', 'Lodging', 150000, 150000, 'monthly', 'monthly', '2026-11-20', '2026-11-20', 1,
       (SELECT COALESCE(MAX(o.sort_order), 0) + 1 FROM cashflow_overhead o), 1, 0
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM cashflow_overhead WHERE name = 'Hotel Engine');

INSERT INTO cashflow_overhead_history
  (overhead_id, action, actor, item_name, old_amount, new_amount, old_cadence, new_cadence, old_anchor_date, new_anchor_date)
SELECT o.id, 'create', 'B250 alignment (migration 0080)', o.name, NULL, o.amount, NULL, o.cadence, NULL, o.anchor_date
FROM cashflow_overhead o
WHERE o.name = 'Hotel Engine'
  AND NOT EXISTS (SELECT 1 FROM cashflow_overhead_history h WHERE h.overhead_id = o.id AND h.action = 'create');

-- ---- New: Chase credit card $20,000 weekly from Fri 10/30/2026 ----
INSERT INTO cashflow_overhead
  (name, category, amount, seed_amount, cadence, seed_cadence, anchor_date, seed_anchor_date,
   active, sort_order, edited, from_qbo)
SELECT 'Chase credit card', 'Credit card', 20000, 20000, 'weekly', 'weekly', '2026-10-30', '2026-10-30', 1,
       (SELECT COALESCE(MAX(o.sort_order), 0) + 1 FROM cashflow_overhead o), 1, 0
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM cashflow_overhead WHERE name = 'Chase credit card');

INSERT INTO cashflow_overhead_history
  (overhead_id, action, actor, item_name, old_amount, new_amount, old_cadence, new_cadence, old_anchor_date, new_anchor_date)
SELECT o.id, 'create', 'B250 alignment (migration 0080)', o.name, NULL, o.amount, NULL, o.cadence, NULL, o.anchor_date
FROM cashflow_overhead o
WHERE o.name = 'Chase credit card'
  AND NOT EXISTS (SELECT 1 FROM cashflow_overhead_history h WHERE h.overhead_id = o.id AND h.action = 'create');

-- ---- Card-paid run-rate lines: soft-delete (restorable; deletions stick on sync) ----
INSERT INTO cashflow_overhead_history
  (overhead_id, action, actor, item_name, old_amount, new_amount, old_cadence, new_cadence, old_anchor_date, new_anchor_date)
SELECT id, 'delete', 'B250 alignment (migration 0080) - paid by Chase card', name, amount, NULL, cadence, NULL, anchor_date, NULL
FROM cashflow_overhead
WHERE deleted_at IS NULL AND name IN (
  'Meals, Job Related', 'Travel, Job Related', 'Travel and Entertainment',
  CONCAT('Travel and Entertainment', CHAR(58), 'Automobile Expense'),
  CONCAT('Travel and Entertainment', CHAR(58), 'Meals'),
  CONCAT('Travel and Entertainment', CHAR(58), 'Travel'),
  CONCAT('Office and IT', CHAR(58), 'Business Licenses'),
  CONCAT('Office and IT', CHAR(58), 'Communication and Internet'),
  CONCAT('Office and IT', CHAR(58), 'Computer and Software'),
  CONCAT('Office and IT', CHAR(58), 'Office Supplies and General'),
  CONCAT('Office and IT', CHAR(58), 'Postage and Shipping'));

UPDATE cashflow_overhead SET deleted_at = NOW(), edited = 1
WHERE deleted_at IS NULL AND name IN (
  'Meals, Job Related', 'Travel, Job Related', 'Travel and Entertainment',
  CONCAT('Travel and Entertainment', CHAR(58), 'Automobile Expense'),
  CONCAT('Travel and Entertainment', CHAR(58), 'Meals'),
  CONCAT('Travel and Entertainment', CHAR(58), 'Travel'),
  CONCAT('Office and IT', CHAR(58), 'Business Licenses'),
  CONCAT('Office and IT', CHAR(58), 'Communication and Internet'),
  CONCAT('Office and IT', CHAR(58), 'Computer and Software'),
  CONCAT('Office and IT', CHAR(58), 'Office Supplies and General'),
  CONCAT('Office and IT', CHAR(58), 'Postage and Shipping'));
