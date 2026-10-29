-- 0089: Saved results of the slow page builds (Ashley's Tracker per project,
-- Data Review, Overview job cost), shared by every server worker and kept
-- across restarts. Each has a fingerprint (sig) of the data it was built from:
-- a page serves the saved result at once and rebuilds it in the background
-- when the data changed, so it is fast without showing stale numbers for long.

CREATE TABLE IF NOT EXISTS page_snapshots (
  skey VARCHAR(120) NOT NULL PRIMARY KEY,
  sig TEXT NULL,
  payload LONGTEXT NOT NULL,
  build_seconds DECIMAL(8,2) NULL,
  computed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
