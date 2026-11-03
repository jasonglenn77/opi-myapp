-- The date written on each Project Completion Form. Reading a form means fetching
-- it from S3, so it's read once and kept here; a changed file is read again.
CREATE TABLE IF NOT EXISTS completion_form_dates (
  document_id BIGINT NOT NULL PRIMARY KEY,
  drive_md5   VARCHAR(64) COLLATE utf8mb4_unicode_ci NULL,
  form_date   DATE NULL,
  how         VARCHAR(20) NOT NULL,
  read_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
