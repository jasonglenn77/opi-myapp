-- 0055 Receipts flow (Crew Portal build step 4, Design v3 item 5).
--
-- Real-time project spend + credit-card reconciliation queue: a crew (passcode
-- token) or a PM/office user uploads a receipt file (photo/PDF) into the
-- project's "8 Receipts" document folder and files a `receipts` row with
-- amount / category / vendor / date. charged_back=1 = "should be charged back
-- to the customer" -> the PM is flagged for a change order (surfaced as a flag
-- everywhere the receipt renders).
--
-- Status flow (office does the last two; today's manual process is
-- card -> receipt -> PM reconciles -> office allocates in QBO):
--   uploaded    just submitted from the field / PM
--   reconciled  PM matched it to the credit-card statement (page.pm_portal)
--   allocated   office recorded it in QBO (page.financials / admin)
-- Receipts NOT yet allocated overlay the PM Overview's expense burndown as a
-- soft "+ $X in receipts pending" annotation (early signal before QBO).
--
-- submitted_by mirrors form_submissions.crew_context:
--   {"kind":"crew", crew_id, crew_name, role, label}                   (field)
--   {"kind":"user", user_id, email, on_behalf:true, user, crew}        (PM/office)
--
-- Charset/collation matches the 0052 forms tables (utf8mb4_unicode_ci — the
-- MySQL-8 default 0900 collation breaks joins against qbo_customers).

CREATE TABLE IF NOT EXISTS receipts (
  id                     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_qbo_id         VARCHAR(64)  NOT NULL,
  document_id            INT NULL,                 -- documents.id of the uploaded file
  amount                 DECIMAL(12,2) NULL,
  category               ENUM('travel','materials','propane_fuel','other') NOT NULL DEFAULT 'other',
  vendor                 VARCHAR(200) NULL,
  receipt_date           DATE NULL,
  charged_back           TINYINT(1)   NOT NULL DEFAULT 0,   -- 1 = needs a change order (PM flagged)
  notes                  VARCHAR(500) NULL,
  submitted_by           JSON NULL,                -- crew_context-style (see header)
  status                 ENUM('uploaded','reconciled','allocated') NOT NULL DEFAULT 'uploaded',
  reconciled_by_user_id  INT NULL,
  reconciled_at          DATETIME NULL,
  allocated_by_user_id   INT NULL,
  allocated_at           DATETIME NULL,
  created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_receipts_proj_status (project_qbo_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
