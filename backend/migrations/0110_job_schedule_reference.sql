-- 2026-11-18 (owner): the Job Schedule sheet becomes REFERENCE-ONLY. The nightly
-- import still reads it and works out what it would change, but no longer writes
-- dates, crews, PMs or overage into the app. Each would-be change is kept here
-- (replaced every night) and shown on the Assignment as "Job Schedule says ...",
-- with "Use these" to apply that one change.
CREATE TABLE IF NOT EXISTS gsync_schedule_proposals (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  qbo_customer_id   INT NOT NULL,                  -- qbo_customers.id (the project)
  schedule_item_id  INT NULL,                      -- NULL = a visit the app has no line for
  job               VARCHAR(40) NULL,
  visit_first       DATE NULL,
  visit_last        DATE NULL,
  changes           JSON NOT NULL,                 -- {field: [app value, sheet value]}
  payload           JSON NOT NULL,                 -- the planned change, to apply on request
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_gsp_cust (qbo_customer_id),
  KEY idx_gsp_item (schedule_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
