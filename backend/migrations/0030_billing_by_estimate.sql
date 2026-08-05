-- Slice 2: Billing reorganized around the estimate.
--   * project_estimate_billing = the per-estimate billing header: which crew the
--     estimate is assigned to (drives rollup grouping) and whether the office has
--     reviewed/confirmed its schedules. A newly-converted estimate has no row (or
--     an unconfirmed one) -> it surfaces as "needs review".
--   * invoice schedules gain an estimate link, so each estimate bills its own
--     35/35/30 (project totals them).
--   * crew payment schedules gain a rollup flag: a schedule can now be a per-crew
--     rollup (covering several estimates) rather than strictly one-per-estimate.

CREATE TABLE IF NOT EXISTS project_estimate_billing (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  entity_id            VARCHAR(64) NOT NULL,          -- project qbo_id
  estimate_qbo_id      VARCHAR(40) NOT NULL,
  estimate_doc_number  VARCHAR(50) NULL,
  crew_id              INT NULL,                      -- assigned crew (rollup key)
  confirmed            TINYINT(1) NOT NULL DEFAULT 0, -- office reviewed the schedules
  confirmed_at         DATETIME NULL,
  confirmed_by_user_id BIGINT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_estbill (entity_id, estimate_qbo_id),
  KEY idx_estbill_entity (entity_id)
);

-- Invoice schedules become per-estimate (estimate_qbo_id NULL = legacy project-level).
ALTER TABLE project_invoice_schedules
  ADD COLUMN estimate_qbo_id     VARCHAR(40) NULL AFTER entity_id,
  ADD COLUMN estimate_doc_number VARCHAR(50) NULL AFTER estimate_qbo_id;

-- Crew payment schedules can be a per-crew rollup covering several estimates.
ALTER TABLE project_payment_schedules
  ADD COLUMN is_rollup TINYINT(1) NOT NULL DEFAULT 0 AFTER crew_id;
