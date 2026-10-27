-- 0081 Crew "Payment Schedule" files in Google Drive -> the app's crew payment
-- schedules (app/gsync/payment_import.py). Owner decision 2026-10-26 - the
-- sheet wins, imported daily and on the Data Review "Refresh from Google".
--
-- project_payment_schedules gains its provenance. source = 'app' (generated /
-- typed in the app) or 'sheet' (owned by a Drive Payment Schedule file, or a
-- change-order schedule folded into the project's sheet = 'sheet_covered').
-- estimate_qbo_id for an extra scope/crew file is 'gs-' + a hash of the Drive file id.
ALTER TABLE project_payment_schedules
  ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'app',
  ADD COLUMN source_file_id VARCHAR(64) NULL,
  ADD COLUMN source_file_name VARCHAR(255) NULL,
  ADD COLUMN source_modified VARCHAR(40) NULL,
  ADD COLUMN source_label VARCHAR(120) NULL,
  ADD COLUMN sheet_project_number VARCHAR(64) NULL,
  ADD COLUMN sheet_paid_to_date DECIMAL(12,2) NULL,
  ADD COLUMN synced_at DATETIME NULL,
  ADD KEY idx_pps_source_file (source_file_id);

-- Per installment - which side wrote it, whether the sheet marks it paid
-- (pd / paid), why it is paid (sheet, qbo, sheet+qbo, app) and the QBO bill
-- matched to it.
ALTER TABLE project_payment_installments
  ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'app',
  ADD COLUMN sheet_paid TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN paid_source VARCHAR(16) NULL,
  ADD COLUMN qbo_txn_id VARCHAR(40) NULL;

-- One row per Drive file named like Payment Schedule (in Customers). Cached
-- parse keyed by Drive modifiedTime, so only changed files are re-read.
-- status = ok, blank, error, superseded (older version of the same scope),
-- duplicate (its rows are all inside another file), unmatched.
CREATE TABLE IF NOT EXISTS gsync_payment_files (
  file_id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NULL,
  modified VARCHAR(40) NULL,
  md5 VARCHAR(32) NULL,
  parent_id VARCHAR(64) NULL,
  path VARCHAR(1024) NULL,
  entity_id VARCHAR(40) NULL,
  match_kind VARCHAR(32) NULL,
  match_note VARCHAR(500) NULL,
  scope_label VARCHAR(120) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ok',
  error VARCHAR(2000) NULL,
  parsed JSON NULL,
  read_at DATETIME NULL,
  seen_at DATETIME NULL,
  PRIMARY KEY (file_id),
  KEY idx_gpf_entity (entity_id),
  KEY idx_gpf_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
