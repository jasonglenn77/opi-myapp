-- Slice 1 of the estimating-pipeline redesign: app-owned Contacts + the RFQ
-- "opportunity" front-door.
--
-- Contacts: QBO carries ~one primary contact per customer; we seed from that and
-- then OWN contacts app-side (multiple contacts per customer, staff-managed). We
-- do NOT write contacts back to QBO (same as won/lost status).
--
-- Opportunities: the pre-award pipeline record. Starts at RFQ intake (before any
-- QBO estimate exists) and carries stage timestamps so we can report volume,
-- turn-times (24-hr SLA), sales-cycle, and win rate. QBO still mints the quote
-- number + generates the customer PDF (decision: "keep QBO for PDF + number").
--
-- Customer links use the INTERNAL qbo_customers.id (INT UNSIGNED), matching
-- estimates.qbo_customer_id / customer_contact_log.qbo_customer_id. qbo_estimate_id
-- / project_qbo_id are QBO id strings, collation-pinned to join qbo_transactions.

CREATE TABLE IF NOT EXISTS contacts (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  qbo_customer_id    INT UNSIGNED NOT NULL,           -- internal qbo_customers.id (the company)
  first_name         VARCHAR(120)  NULL,
  last_name          VARCHAR(120)  NULL,
  full_name          VARCHAR(255)  NULL,              -- display label (person name, else email)
  email              VARCHAR(255)  NULL,
  phone              VARCHAR(64)   NULL,
  title              VARCHAR(120)  NULL,
  is_primary         TINYINT(1) NOT NULL DEFAULT 0,
  active             TINYINT(1) NOT NULL DEFAULT 1,
  source             VARCHAR(16) NOT NULL DEFAULT 'manual',   -- 'qbo_seed' | 'manual'
  notes              VARCHAR(2000) NULL,
  created_by_user_id BIGINT UNSIGNED NULL,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_contacts_customer (qbo_customer_id),
  KEY idx_contacts_email (email)
);

CREATE TABLE IF NOT EXISTS opportunities (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  qbo_customer_id    INT UNSIGNED NOT NULL,           -- internal qbo_customers.id
  contact_id         INT UNSIGNED NULL,               -- contacts.id
  title              VARCHAR(255) NULL,               -- short descriptor of the job
  source             VARCHAR(64)  NULL,               -- how the RFQ arrived (email/referral/...)
  rfq_received_date  DATE NULL,
  target_start_date  DATE NULL,                       -- customer's desired start date
  quote_number       VARCHAR(50) NULL,                -- QBO doc# once minted
  qbo_estimate_id    VARCHAR(32) COLLATE utf8mb4_unicode_ci NULL,  -- QBO estimate (for the PDF)
  app_estimate_id    INT UNSIGNED NULL,               -- estimates.id (quoting-metrics workbook) if used
  project_qbo_id     VARCHAR(32) COLLATE utf8mb4_unicode_ci NULL,  -- set when won -> project
  estimator_user_id  BIGINT UNSIGNED NULL,
  -- lifecycle: received -> quoting -> sent -> won | lost | declined
  status             VARCHAR(24) NOT NULL DEFAULT 'received',
  -- stage timestamps power the turn-time / sales-cycle analytics
  received_at        DATETIME NULL,
  quoting_started_at DATETIME NULL,
  sent_at            DATETIME NULL,
  decided_at         DATETIME NULL,
  notes              VARCHAR(2000) NULL,
  created_by_user_id BIGINT UNSIGNED NULL,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_opp_customer (qbo_customer_id),
  KEY idx_opp_contact (contact_id),
  KEY idx_opp_status (status)
);

-- Seed one primary contact per customer company from QBO's primary-contact fields
-- (person name where present, else the primary email as the label). Runs once with
-- the freshly-created (empty) table, so no de-dupe guard is needed. Projects/jobs
-- are excluded — contacts belong to the customer company.
INSERT INTO contacts (qbo_customer_id, first_name, last_name, full_name, email, phone, is_primary, active, source)
SELECT
  qc.id,
  JSON_UNQUOTE(JSON_EXTRACT(qc.raw_json, '$.GivenName')),
  JSON_UNQUOTE(JSON_EXTRACT(qc.raw_json, '$.FamilyName')),
  COALESCE(
    NULLIF(TRIM(CONCAT(
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(qc.raw_json, '$.GivenName')), ''), ' ',
      COALESCE(JSON_UNQUOTE(JSON_EXTRACT(qc.raw_json, '$.FamilyName')), ''))), ''),
    JSON_UNQUOTE(JSON_EXTRACT(qc.raw_json, '$.PrimaryEmailAddr.Address'))
  ),
  JSON_UNQUOTE(JSON_EXTRACT(qc.raw_json, '$.PrimaryEmailAddr.Address')),
  JSON_UNQUOTE(JSON_EXTRACT(qc.raw_json, '$.PrimaryPhone.FreeFormNumber')),
  1, 1, 'qbo_seed'
FROM qbo_customers qc
WHERE qc.raw_json IS NOT NULL
  AND COALESCE(qc.is_project, 0) = 0
  AND COALESCE(qc.job, 0) = 0
  AND (
    JSON_EXTRACT(qc.raw_json, '$.GivenName') IS NOT NULL
    OR JSON_UNQUOTE(JSON_EXTRACT(qc.raw_json, '$.PrimaryEmailAddr.Address')) IS NOT NULL
  );
