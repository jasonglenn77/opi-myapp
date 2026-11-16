-- 2026-11-15 Comments on a project and on each Project Setup step.
-- subject: the same key as project_setup_notes (the QuickBooks project id, or
-- opp:ID for a won quote that isn't in QuickBooks yet). step_key NULL = a
-- comment on the project itself. Kept as a thread, newest shown first.
CREATE TABLE IF NOT EXISTS project_comments (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  subject      VARCHAR(64)  NOT NULL,
  step_key     VARCHAR(32)  NULL,
  body         TEXT         NOT NULL,
  by_user_id   BIGINT UNSIGNED NULL,
  by_email     VARCHAR(255) NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pc_subject (subject, created_at)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
