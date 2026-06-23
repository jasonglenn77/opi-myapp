-- Phase 4: per-project, per-day daily requirements checklist (active projects).
-- entity_id = project qbo_customer_id. One row per (project, day, item).
CREATE TABLE IF NOT EXISTS project_daily_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_id VARCHAR(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  log_date DATE NOT NULL,
  item_key VARCHAR(64) NOT NULL,
  done TINYINT(1) NOT NULL DEFAULT 0,
  note TEXT NULL,
  updated_by_user_id BIGINT UNSIGNED NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_daily (entity_id, log_date, item_key),
  INDEX idx_daily_entity_date (entity_id, log_date)
);
