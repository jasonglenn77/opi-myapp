-- Per-project materialized cash contribution (Phase 3b performance).
--
-- The company forecast was recomputing EVERY project from scratch on any change
-- (~5 min on prod). Instead we store each project's computed cash contribution
-- (its scheduled events + backlog) here, tagged with a source_version = the max
-- updated_at across that project's schedule tables at compute time. The forecast
-- refreshes only the projects whose schedules changed (source_version moved),
-- then aggregates these rows — so editing one project refreshes just that one.

CREATE TABLE IF NOT EXISTS project_cash_cache (
  entity_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
  payload JSON NOT NULL,
  source_version DATETIME NULL,
  computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Match the collation other tables use, so entity_id compares/joins cleanly.
ALTER TABLE project_cash_cache
  MODIFY entity_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL;
