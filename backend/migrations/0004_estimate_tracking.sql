-- Estimate tracking overlay: OPI status + ownership on top of QBO estimates.
-- Keyed by the QBO estimate id (qbo_transactions.qbo_id where entity_type='Estimate').
-- The QBO estimate is the spine (amount, DocNumber, TxnStatus); this adds OPI's
-- sales status, owner, and notes. Contacts attach to an estimate via the new
-- column on customer_contact_log (and still roll up to the customer).

CREATE TABLE IF NOT EXISTS estimate_tracking (
  -- collation pinned to match qbo_transactions.qbo_id so JOINs don't hit a
  -- "illegal mix of collations" error on MySQL 8 (default is utf8mb4_0900_ai_ci).
  qbo_estimate_id VARCHAR(32) COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
  -- OPI pipeline status (lookup_values.estimate_pipeline_status, e.g.
  -- "60% Project Confirmed…"); '' = not yet set. Same vocabulary as the
  -- per-customer pipeline on the Quoting page.
  status          VARCHAR(64)  NOT NULL DEFAULT '',
  owner_user_id   BIGINT UNSIGNED NULL,
  notes           VARCHAR(2000) NULL,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Let a logged contact attach to a specific estimate (nullable; existing rows
-- stay customer-level). Rolls up to the customer via the existing qbo_customer_id.
ALTER TABLE customer_contact_log
  ADD COLUMN qbo_estimate_id VARCHAR(32) COLLATE utf8mb4_unicode_ci NULL;
