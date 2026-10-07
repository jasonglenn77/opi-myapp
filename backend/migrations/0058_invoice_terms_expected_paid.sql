-- 0058: Invoice-schedule upgrades (owner feedback batch, 2026-10-03).
--
-- 1) expected_paid_date on invoice milestones: the office's realistic "when
--    will the cash actually land" date. NULL = fall back to the due date (the
--    behavior to date). The cash-flow forecast places invoice inflows on
--    COALESCE(expected_paid_date, due_date, invoice_date).
--
-- 2) project_billing_terms: the project's chosen default invoice terms
--    (percent split + net days). Stored per PROJECT in its own table — NOT on
--    project_invoice_schedules — because schedules are per-estimate AND are
--    deleted/recreated by the Billing tab's refresh/rebuild flows, which would
--    lose the choice. No row (or NULL fields) = the built-in 35/35/30 net-30.
--    terms_percents is a comma list, e.g. "35,35,30" or "50,50".
--
-- NOTE FOR DEPLOY: the cash-flow caches key on schedule-row timestamps, so a
-- CODE change to _project_events does not invalidate them. After deploying
-- this batch, clear both caches on prod:
--   DELETE FROM project_cash_cache; DELETE FROM cashflow_schedule_cache;

ALTER TABLE project_invoice_milestones
  ADD COLUMN expected_paid_date DATE NULL AFTER due_date;

CREATE TABLE IF NOT EXISTS project_billing_terms (
  entity_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
  terms_percents VARCHAR(64) NULL,
  terms_net_days INT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
