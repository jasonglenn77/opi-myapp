-- 0067 Kickoff checklists: shared items + provenance + change history.
-- Items on BOTH checklists are stored once under form_key 'shared'. `source`
-- records which checklist (or an auto-fill) last set the answer, and every
-- change keeps the replaced value in project_kickoff_history.
ALTER TABLE project_kickoff_responses ADD COLUMN source VARCHAR(64) NULL AFTER value;

CREATE TABLE IF NOT EXISTS project_kickoff_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_id VARCHAR(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  form_key VARCHAR(32) NOT NULL,
  field_key VARCHAR(120) NOT NULL,
  old_value TEXT NULL,
  new_value TEXT NULL,
  old_source VARCHAR(64) NULL,
  new_source VARCHAR(64) NULL,
  changed_by_user_id BIGINT UNSIGNED NULL,
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_kickoff_hist (entity_id, form_key, field_key)
);
