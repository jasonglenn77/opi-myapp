-- 0078 PROJECT HOLDS (owner decision 2026-10-26).
-- A project put ON HOLD stays in the cash forecast: the office records a hold
-- start + EXPECTED RESUME date and the project's remaining (not yet invoiced /
-- not yet paid / not yet spent) dated work is shifted by the hold length, so
-- Billing & Schedule, the Schedules page, Cash Flow and the Revenue Forecast
-- all read the new dates. Service: app/projects/holds.py.
--
-- project_holds: one row per hold (history kept; released_at NULL = active;
-- at most one active hold per project, enforced in the API).
-- shift_days = the shift currently applied to the hold's rows
-- (= expected_resume - hold_start, clamped >= 0).
CREATE TABLE IF NOT EXISTS project_holds (
  id                   INT NOT NULL AUTO_INCREMENT,
  project_id           INT NOT NULL,              -- projects.id
  qbo_customer_id      INT NOT NULL,              -- qbo_customers.id
  entity_id            VARCHAR(40) NOT NULL,      -- qbo_customers.qbo_id (billing/cash entity key)
  hold_start           DATE NOT NULL,
  expected_resume      DATE NOT NULL,
  shift_days           INT NOT NULL DEFAULT 0,
  reason               VARCHAR(160) NULL,
  note                 TEXT NULL,
  created_by_user_id   BIGINT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by_user_id   BIGINT UNSIGNED NULL,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  released_at          DATETIME NULL,
  released_by_user_id  BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY idx_ph_project (project_id, released_at),
  KEY idx_ph_entity (entity_id, released_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- project_hold_shifts: the ORIGINAL plan, one row per shifted field, so the
-- shift can be re-sized (Edit hold) or undone (Resume early) without losing
-- what the plan said before the hold. kind -> table.column is whitelisted in
-- holds.py (schedule_item, crew_schedule, milestone, crew_installment,
-- expense_installment, expense_item). orig_value / shifted_value are ISO
-- dates, a status string (field 'status') or non_working JSON.
-- detached = 1 once someone else changed the value (user edit / sheet import):
-- the hold stops managing that field.
CREATE TABLE IF NOT EXISTS project_hold_shifts (
  id             INT NOT NULL AUTO_INCREMENT,
  hold_id        INT NOT NULL,
  kind           VARCHAR(32) NOT NULL,
  row_id         INT NOT NULL,
  field          VARCHAR(40) NOT NULL,
  orig_value     TEXT NULL,
  shifted_value  TEXT NULL,
  detached       TINYINT(1) NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_phs_field (hold_id, kind, row_id, field),
  KEY idx_phs_row (kind, row_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
