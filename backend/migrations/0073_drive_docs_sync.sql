-- 0073 Google Drive Customers folder -> app documents sync (app/gsync/docs_sync.py).
-- documents gains the Drive provenance columns. A Drive file is copied once
-- and keyed by source_drive_id, so re-runs skip it and a changed file updates
-- the same row. drive_path is the path below the matched project or quote
-- folder (deeper subfolders kept, so IMG_0001.HEIC in two dated photo
-- folders stays distinguishable). drive_link is the webViewLink for Google
-- Sheets and Docs (exported snapshot plus a link to the live file).
ALTER TABLE documents
  ADD COLUMN source_drive_id VARCHAR(64) NULL,
  ADD COLUMN drive_md5 VARCHAR(32) NULL,
  ADD COLUMN drive_modified VARCHAR(40) NULL,
  ADD COLUMN drive_path VARCHAR(1024) NULL,
  ADD COLUMN drive_link VARCHAR(512) NULL,
  ADD COLUMN drive_parent_id VARCHAR(64) NULL,
  ADD UNIQUE KEY uq_documents_drive (source_drive_id, entity_type, entity_id),
  ADD KEY idx_documents_drive_parent (drive_parent_id);

-- Mirror of every folder under Customers (about 120k rows). Lets the nightly
-- incremental sync (Drive Changes API) resolve a changed file's path, and
-- holds each detected project or quote folder's match result.
CREATE TABLE drive_folders (
  drive_id VARCHAR(64) NOT NULL PRIMARY KEY,
  parent_id VARCHAR(64) NULL,
  name VARCHAR(512) NOT NULL,
  path VARCHAR(1024) NOT NULL,
  is_root TINYINT(1) NOT NULL DEFAULT 0,
  match_kind VARCHAR(32) NULL,
  entity_type VARCHAR(16) NULL,
  entity_id VARCHAR(40) NULL,
  nums VARCHAR(255) NULL,
  match_note VARCHAR(1024) NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_drive_folders_parent (parent_id),
  KEY idx_drive_folders_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Holding area: Drive folders the sync could not match to a project or quote
-- (no job number, number not found, several candidates, estimate-only, or
-- files outside any project folder). Their files ARE copied to S3 and get
-- documents rows with entity_type drive_hold and entity_id = this id. Linking
-- the folder moves those rows to the chosen project or opportunity (no
-- re-upload) and the link is remembered for future syncs.
CREATE TABLE drive_unmatched_folders (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  drive_folder_id VARCHAR(64) NOT NULL,
  path VARCHAR(1024) NOT NULL,
  company VARCHAR(255) NULL,
  folder_name VARCHAR(512) NULL,
  kind VARCHAR(32) NOT NULL,
  guessed_job VARCHAR(64) NULL,
  suggestion JSON NULL,
  file_count INT NOT NULL DEFAULT 0,
  total_bytes BIGINT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  linked_entity_type VARCHAR(16) NULL,
  linked_entity_id VARCHAR(40) NULL,
  linked_by_email VARCHAR(255) NULL,
  linked_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_drive_unmatched_folder (drive_folder_id),
  KEY idx_drive_unmatched_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-file sync state that is not a documents row. status error = copy failed
-- (retried next run), deleted_in_app = a user deleted the copied document, so
-- the sync must not copy it again.
CREATE TABLE drive_file_state (
  drive_id VARCHAR(64) NOT NULL PRIMARY KEY,
  status VARCHAR(16) NOT NULL,
  path VARCHAR(1024) NULL,
  error VARCHAR(2000) NULL,
  attempts INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_drive_file_state_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Small key/value state: changes_page_token, backfill_completed_at,
-- template_md5 (JSON list of the known blank-template checksums).
CREATE TABLE drive_sync_state (
  k VARCHAR(64) NOT NULL PRIMARY KEY,
  v MEDIUMTEXT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
