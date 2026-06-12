-- Migration 0001: Roles & permissions foundation (Phase 1)
-- Adds login->resource links, widens the role column, and a per-user
-- permission-override table. Non-destructive: existing rows keep their data.

-- Normalize any missing roles before tightening the column.
UPDATE users SET role = 'user' WHERE role IS NULL OR role = '';

-- Widen role so 'pm' and 'crew_lead' are storable even if it was ENUM('admin','user').
ALTER TABLE users MODIFY COLUMN role VARCHAR(20) NOT NULL DEFAULT 'user';

-- 1:1 link: a login that is "also a PM" points at its project_managers record.
ALTER TABLE users
  ADD COLUMN project_manager_id INT NULL,
  ADD CONSTRAINT uq_users_project_manager UNIQUE (project_manager_id),
  ADD CONSTRAINT fk_users_project_manager
    FOREIGN KEY (project_manager_id) REFERENCES project_managers(id);

-- Link: a login that is "also a crew lead" points at its work_crews record.
ALTER TABLE users
  ADD COLUMN work_crew_id INT NULL,
  ADD CONSTRAINT fk_users_work_crew
    FOREIGN KEY (work_crew_id) REFERENCES work_crews(id);

-- Per-user permission overrides, layered on top of role defaults.
-- effect='allow' grants a capability the role lacks; 'deny' removes one it has.
-- user_id must match users.id exactly (bigint unsigned) for the FK to attach.
CREATE TABLE IF NOT EXISTS user_permission_overrides (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  capability VARCHAR(64) NOT NULL,
  effect ENUM('allow','deny') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_capability (user_id, capability),
  CONSTRAINT fk_upo_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
