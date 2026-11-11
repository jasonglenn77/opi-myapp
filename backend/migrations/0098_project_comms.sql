-- Running Jobs: the PM's customer and crew updates (Leo's Project Lifecycle list):
-- kickoff call, kickoff recaps, Day 1, daily updates, completion, group texts.
-- One row per update sent (or marked not needed); daily updates repeat.
CREATE TABLE IF NOT EXISTS project_comms (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_id VARCHAR(40) NOT NULL,
  kind VARCHAR(40) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'sent',
  to_addr VARCHAR(512) NULL,
  subject VARCHAR(512) NULL,
  body TEXT NULL,
  note VARCHAR(512) NULL,
  by_user_id INT NULL,
  by_email VARCHAR(255) NULL,
  at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_comms_job (entity_id, kind, at)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
