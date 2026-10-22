-- 0076 Cache of each quoting-metrics workbook's roll-up cells, keyed by Drive
-- file id + modified time. The B151 pulls quote #, dates and values from these
-- workbooks with IMPORTRANGE, which Google evaluates lazily, so the sync reads
-- the workbook directly for rows that come back blank (app/gsync/sheets.py).
CREATE TABLE IF NOT EXISTS gsync_workbook_cache (
  file_id VARCHAR(80) NOT NULL,
  modified VARCHAR(40) NULL,
  grid JSON NULL,
  fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (file_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
