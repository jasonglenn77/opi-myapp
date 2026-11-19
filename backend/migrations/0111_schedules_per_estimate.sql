-- 2026-11-18 (owner feedback): schedules follow each estimate's package dates.
--
-- Crew pay: a new schedule's first payment is the second payday after the PO
-- (the estimate's accepted date), then every other Friday. The office is asked
-- to check and confirm the dates: dates_confirmed = 0 until someone does.
-- Existing schedules are treated as confirmed (they were made and reviewed
-- before this rule).
ALTER TABLE project_payment_schedules ADD COLUMN dates_confirmed TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN dates_confirmed_by VARCHAR(255) NULL;

-- Expenses: planned per estimate and per item, rolled up by item. Rows made
-- before this keep estimate_qbo_id NULL (the project as a whole).
ALTER TABLE project_expense_installments ADD COLUMN estimate_qbo_id VARCHAR(64) NULL,
  ADD KEY idx_pei_est (entity_id, estimate_qbo_id);

-- A crew payment row whose AMOUNT someone typed stays as typed when the rows are
-- re-balanced to the estimate's contract labor (adding / removing a row).
ALTER TABLE project_payment_installments ADD COLUMN amount_edited TINYINT(1) NOT NULL DEFAULT 0;
