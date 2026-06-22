-- Phase 2: the document system. One table for files attached to any entity
-- (estimate / job / project) inside the 9-folder structure. S3-backed.
CREATE TABLE IF NOT EXISTS documents (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  entity_type        VARCHAR(16) NOT NULL,                       -- estimate | job | project
  entity_id          VARCHAR(40) COLLATE utf8mb4_unicode_ci NOT NULL,  -- qbo estimate id, or qbo_customers.qbo_id
  folder             VARCHAR(160) NOT NULL,                      -- folder key, e.g. "6_project_management/2_construction/1_before_pictures"
  s3_bucket          VARCHAR(255) NOT NULL,
  s3_key             VARCHAR(1024) NOT NULL,
  original_filename  VARCHAR(255),
  content_type       VARCHAR(100),
  size_bytes         BIGINT,
  uploaded_by_user_id BIGINT UNSIGNED NULL,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_documents_entity (entity_type, entity_id),
  INDEX idx_documents_folder (entity_type, entity_id, folder)
);
