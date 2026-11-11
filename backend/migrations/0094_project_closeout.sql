-- Project Closeout: what staff marked on each finished job's closeout checklist.
-- Same shape as project_setup_steps. Steps the app can see in the data (final
-- invoice sent, paid in full, crew paid, completion form on file...) need no row.
CREATE TABLE IF NOT EXISTS project_closeout_steps (
  entity_id    VARCHAR(40)  NOT NULL,           -- QuickBooks project id
  step_key     VARCHAR(40)  NOT NULL,
  status       VARCHAR(16)  NOT NULL,           -- done | not_needed
  note         VARCHAR(500) NULL,
  by_user_id   INT          NULL,
  by_email     VARCHAR(255) NULL,
  at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_id, step_key)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
