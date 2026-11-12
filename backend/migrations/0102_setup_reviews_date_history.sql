-- 2026-11-12 Project Setup redesign, foundations.
--
-- project_setup_reviews: a change (dates moved, change order, crew changed,
-- contract value changed) reopens only the setup steps it affects. One open row
-- per (project, step); resolved when someone re-checks that step.
CREATE TABLE IF NOT EXISTS project_setup_reviews (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  entity_id        VARCHAR(32) NOT NULL,
  step_key         VARCHAR(32) NOT NULL,
  trigger_kind     VARCHAR(24) NOT NULL,
  reason           VARCHAR(1000) NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by       VARCHAR(255) NULL,
  resolved_at      DATETIME NULL,
  resolved_by      VARCHAR(255) NULL,
  resolution_note  VARCHAR(500) NULL,
  KEY idx_psr_open (entity_id, resolved_at),
  KEY idx_psr_step (entity_id, step_key, resolved_at)
);

-- What QuickBooks showed last time for each live project's estimates, so a new
-- estimate (a change order) or a changed contract value is noticed once.
CREATE TABLE IF NOT EXISTS project_setup_watch (
  entity_id   VARCHAR(32) NOT NULL PRIMARY KEY,
  est_n       INT NOT NULL DEFAULT 0,
  est_total   DECIMAL(14,2) NOT NULL DEFAULT 0,
  checked_at  DATETIME NOT NULL
);

-- Notes on a setup step that can't be done yet (no PO: why and when it's
-- expected; estimate not done; first invoice not sent). Kept as a history.
CREATE TABLE IF NOT EXISTS project_setup_notes (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  subject        VARCHAR(64) NOT NULL,
  step_key       VARCHAR(32) NOT NULL,
  reason_code    VARCHAR(32) NULL,
  note           TEXT NULL,
  expected_date  DATE NULL,
  by_user_id     BIGINT UNSIGNED NULL,
  by_email       VARCHAR(255) NULL,
  at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_psn_subject (subject, step_key)
);

-- Every change to a schedule line's dates (start, quoted end, overage days),
-- from the app or the Job Schedule import, with why it moved and whether a
-- change order is needed. It's also the end-date history: the quoted end
-- (end_date) and each extension (overage / new end), the latest one counting.
CREATE TABLE IF NOT EXISTS schedule_date_changes (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  entity_id         VARCHAR(32) NOT NULL,
  schedule_item_id  INT NULL,
  history_id        INT NULL,
  action            VARCHAR(12) NOT NULL DEFAULT 'updated',
  source            VARCHAR(16) NOT NULL,
  old_start         DATE NULL,
  new_start         DATE NULL,
  old_end           DATE NULL,
  new_end           DATE NULL,
  old_overage       INT NULL,
  new_overage       INT NULL,
  changed_by        VARCHAR(255) NULL,
  changed_at        DATETIME NOT NULL,
  reason_code       VARCHAR(32) NULL,
  co_needed         VARCHAR(12) NULL,
  note              VARCHAR(1000) NULL,
  answered_by       VARCHAR(255) NULL,
  answered_at       DATETIME NULL,
  UNIQUE KEY uq_sdc_history (history_id),
  KEY idx_sdc_entity (entity_id, changed_at),
  KEY idx_sdc_item (schedule_item_id)
);

INSERT IGNORE INTO notification_watermark (name, last_id)
SELECT 'setup_history', COALESCE(MAX(id), 0) FROM project_schedule_item_history;
INSERT IGNORE INTO notification_watermark (name, last_id)
SELECT 'setup_audit', COALESCE(MAX(id), 0) FROM audit_log;
