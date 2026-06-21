-- Phase 0b: quoting-metrics estimates become per-opportunity (many per
-- customer) with a create -> ready-for-QBO -> linked lifecycle.

-- A customer can now have multiple quoting-metrics estimates.
ALTER TABLE estimates DROP INDEX uq_estimates_customer;

-- Lifecycle + link to the QuickBooks estimate once transferred.
--   status: draft -> ready_for_qbo -> in_qbo
--   qbo_estimate_id: the linked QBO estimate (qbo_transactions.qbo_id); set at
--     transfer. Collation pinned to match qbo_transactions.qbo_id for JOINs.
ALTER TABLE estimates
  ADD COLUMN status            VARCHAR(24) NOT NULL DEFAULT 'draft',
  ADD COLUMN qbo_estimate_id   VARCHAR(32) COLLATE utf8mb4_unicode_ci NULL,
  ADD COLUMN ready_at          DATETIME NULL,
  ADD COLUMN ready_by_user_id  BIGINT UNSIGNED NULL,
  ADD COLUMN linked_at         DATETIME NULL,
  ADD COLUMN linked_by_user_id BIGINT UNSIGNED NULL;

CREATE INDEX idx_estimates_status ON estimates (status);
CREATE INDEX idx_estimates_qbo_estimate ON estimates (qbo_estimate_id);
