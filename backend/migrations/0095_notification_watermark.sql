-- Change alerts: how far the watcher (app/help/watch.py) has read the change logs
-- (project_schedule_item_history, audit_log), so each change is announced once.
CREATE TABLE IF NOT EXISTS notification_watermark (
  name     VARCHAR(40) NOT NULL PRIMARY KEY,      -- 'schedule_history' | 'audit_log'
  last_id  BIGINT      NOT NULL DEFAULT 0,
  at       DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Start from now: don't announce history that happened before alerts existed.
INSERT IGNORE INTO notification_watermark (name, last_id)
  SELECT 'schedule_history', COALESCE(MAX(id), 0) FROM project_schedule_item_history;
INSERT IGNORE INTO notification_watermark (name, last_id)
  SELECT 'audit_log', COALESCE(MAX(id), 0) FROM audit_log;
