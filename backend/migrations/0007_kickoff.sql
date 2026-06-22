-- Phase 3: PM project lifecycle + kickoff forms.
-- entity_id = project qbo_customer_id (string, matched to qbo ids elsewhere).

-- Per-project status for each of the 13 lifecycle milestones (template lives in code).
CREATE TABLE IF NOT EXISTS project_milestones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_id VARCHAR(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  milestone_key VARCHAR(64) NOT NULL,
  done TINYINT(1) NOT NULL DEFAULT 0,
  done_by_user_id BIGINT UNSIGNED NULL,
  done_at DATETIME NULL,
  note TEXT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_project_milestone (entity_id, milestone_key)
);

-- Per-project answers to the Customer / Crew kickoff forms (templates live in code).
-- One row per (project, form, field). Form-level meta (held date) is stored under
-- the reserved field_key '_held_date'.
CREATE TABLE IF NOT EXISTS project_kickoff_responses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_id VARCHAR(40) COLLATE utf8mb4_unicode_ci NOT NULL,
  form_key VARCHAR(32) NOT NULL,
  field_key VARCHAR(120) NOT NULL,
  value TEXT NULL,
  updated_by_user_id BIGINT UNSIGNED NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_project_form_field (entity_id, form_key, field_key)
);
