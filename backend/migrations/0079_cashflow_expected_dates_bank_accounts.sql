-- 0079: Cash Flow owner decisions (2026-10-26) — schema.
--
-- 1) cashflow_bank_accounts: which QuickBooks Bank accounts make up the
--    forecast's opening balance. One row per account the office has toggled;
--    no row = included when the account is active (the default). Lets OPI
--    decide e.g. "Prosperity Checking (6458)" vs the look-alike
--    "On Point Installations (6458)" (QBO account created 10/3).
--
-- 2) qbo_invoice_expected_paid: an expected-paid date for an ACTUAL open QBO
--    invoice (the milestone table already has one for planned invoices). The
--    forecast places each open invoice on COALESCE(this, the linked
--    milestone's expected_paid_date, the QBO due date). entity_id = the
--    invoice's customer/project qbo id (lets caches key on it).
--
-- 3) project_expense_installments.expected_paid_date: when a planned project
--    expense is expected to actually be PAID (NULL = its week_of date). The
--    forecast places expense cash-out on COALESCE(expected_paid_date, week_of).
--
-- NOTE FOR DEPLOY: the cash-flow caches self-invalidate (schedule_forecast
-- LOGIC_VERSION), no manual cache clear needed.

CREATE TABLE IF NOT EXISTS cashflow_bank_accounts (
  qbo_account_id VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
  included TINYINT(1) NOT NULL DEFAULT 1,
  updated_by VARCHAR(255) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS qbo_invoice_expected_paid (
  invoice_qbo_id VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
  entity_id VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  expected_paid_date DATE NULL,
  note VARCHAR(255) NULL,
  updated_by VARCHAR(255) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_qiep_entity (entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE project_expense_installments
  ADD COLUMN expected_paid_date DATE NULL AFTER week_of;
