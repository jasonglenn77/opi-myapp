-- 2026-11-12: crew Payment Schedule sheets in Drive are read for reference
-- only. Each nightly read saves, per project, what the sheet would change in
-- the app's crew payment schedule; Data Review lists them ("Payment Schedule
-- differs from the app") for someone to decide. Nothing is applied.
CREATE TABLE IF NOT EXISTS gsync_payment_diffs (
  entity_id   VARCHAR(32) NOT NULL PRIMARY KEY,
  project     VARCHAR(255) NULL,
  changes     JSON NULL,
  files       JSON NULL,
  checked_at  DATETIME NOT NULL
);
