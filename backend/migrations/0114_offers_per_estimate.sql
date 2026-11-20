-- 2026-11-19 (owner feedback, Project Setup round 2).
--
-- Crew offers go out per estimate / change order (not per crew roll-up): an offer
-- row can name its estimate. Rows made before this keep NULL (the whole project).
ALTER TABLE work_offers ADD COLUMN estimate_qbo_id VARCHAR(64) NULL,
  ADD KEY idx_wo_est (entity_id, estimate_qbo_id);

-- A crew schedule that doesn't add up to its contract labor can be kept that way
-- on purpose (paying the crew more or less): the total someone accepted.
ALTER TABLE project_payment_schedules ADD COLUMN sum_ok_total DECIMAL(14,2) NULL,
  ADD COLUMN sum_ok_by VARCHAR(255) NULL;

-- Expense rows remember what the app planned, so an edited row can go back to it.
ALTER TABLE project_expense_installments ADD COLUMN app_week_of DATE NULL,
  ADD COLUMN app_expected_paid_date DATE NULL,
  ADD COLUMN app_amount DECIMAL(14,2) NULL,
  ADD COLUMN amount_edited TINYINT(1) NOT NULL DEFAULT 0;
UPDATE project_expense_installments
   SET app_week_of = week_of, app_expected_paid_date = expected_paid_date, app_amount = amount
 WHERE edited = 0;

-- An expense item whose rows don't add up to its estimate, kept that way on purpose.
CREATE TABLE IF NOT EXISTS project_expense_sum_ok (
  entity_id        VARCHAR(40)  NOT NULL,
  category         VARCHAR(80)  NOT NULL,
  estimate_qbo_id  VARCHAR(64)  NOT NULL DEFAULT '',
  total            DECIMAL(14,2) NOT NULL,
  by_email         VARCHAR(255) NULL,
  at               DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_id, category, estimate_qbo_id)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
