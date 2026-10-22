-- 0069 Google Drive sync + Data Review.
-- gsync_runs: one row per refresh from Drive (B151 forecast, Job Schedule).
-- gsync_b151_rows: latest parsed "2. Rolling Revenue" rows (replaced each refresh).
-- gsync_schedule_days: latest parsed Job Schedule day cells (replaced each refresh).
-- data_review_state: what staff decided about each Data Review item (fixed / ignored + note).

CREATE TABLE IF NOT EXISTS gsync_runs (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  source VARCHAR(32) NOT NULL,
  triggered_by VARCHAR(255) NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  ok TINYINT(1) NULL,
  drive_modified VARCHAR(40) NULL,
  summary JSON NULL,
  error TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_gsync_runs_source (source, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gsync_b151_rows (
  row_num INT NOT NULL,
  quote_number VARCHAR(50) NULL,
  data JSON NOT NULL,
  PRIMARY KEY (row_num),
  KEY idx_gsync_b151_quote (quote_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gsync_schedule_days (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tab VARCHAR(64) NOT NULL,
  day DATE NOT NULL,
  crew VARCHAR(16) NOT NULL,
  job VARCHAR(120) NULL,
  descr VARCHAR(500) NULL,
  extra VARCHAR(500) NULL,
  job_fill VARCHAR(16) NULL,
  desc_fill VARCHAR(16) NULL,
  PRIMARY KEY (id),
  KEY idx_gsync_sched_day (day),
  KEY idx_gsync_sched_job (job)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS data_review_state (
  item_key VARCHAR(191) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  note VARCHAR(1000) NULL,
  fingerprint VARCHAR(64) NULL,
  updated_by_user_id BIGINT UNSIGNED NULL,
  updated_by_email VARCHAR(255) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (item_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
