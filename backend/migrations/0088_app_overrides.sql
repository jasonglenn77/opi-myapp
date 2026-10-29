-- 0088: Edits made in the app to data that is imported from a Google Drive file
-- (crew Payment Schedules, the Job Schedule). The nightly import used to write
-- the file's values over them ("the sheet wins"). Owner decision 2026-10-28:
-- keep the person's change, and list it on Data Review with the file and the
-- exact row/field to update, until the file says the same (then it resolves
-- itself) or someone chooses to use the file's value again.
--
--   field        a column name (pay_date, start_date, crews, ...), or
--                'added' (a row added in the app) / 'deleted:<n>' (sheet row n removed in the app)
--   app_value    what the app has (text)
--   sheet_value  what the file said at the last import (text)

CREATE TABLE IF NOT EXISTS app_overrides (
  id INT AUTO_INCREMENT PRIMARY KEY,
  source VARCHAR(30) NOT NULL,
  target_table VARCHAR(40) NOT NULL,
  target_id INT NOT NULL,
  field VARCHAR(40) NOT NULL,
  entity_id VARCHAR(40) NULL,
  app_value VARCHAR(1000) NULL,
  sheet_value VARCHAR(1000) NULL,
  file_id VARCHAR(100) NULL,
  file_name VARCHAR(255) NULL,
  sheet_ref VARCHAR(255) NULL,
  created_by VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  checked_at DATETIME NULL,
  resolved_at DATETIME NULL,
  resolved_how VARCHAR(30) NULL,
  resolved_by VARCHAR(255) NULL,
  UNIQUE KEY uq_app_override (target_table, target_id, field),
  KEY idx_app_override_open (resolved_at, source)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
