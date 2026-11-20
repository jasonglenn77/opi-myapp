-- 2026-11-19 (owner): where the Job Schedule sheet says something different from
-- the app, the office can keep the app's values ("Keep the app's"). That choice
-- holds until the sheet changes again (same line, same differences).
CREATE TABLE IF NOT EXISTS gsync_schedule_dismissed (
  k             VARCHAR(160) NOT NULL,
  changes_hash  CHAR(40)     NOT NULL,
  by_email      VARCHAR(255) NULL,
  at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (k)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
