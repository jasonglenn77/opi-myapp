-- Slice 3: change-order / supplemental project estimates.
-- The office creates change-order estimates in QBO (skipping the quoting-metrics
-- workbook). Those already sync in as Estimates tagged to the project. This overlay
-- classifies + annotates them (original cost-basis vs change-order, CO #, reason,
-- scope, approval status) and also allows a quick app-side DRAFT (qbo_estimate_id
-- NULL) captured before it exists in QBO, linkable later by doc number.
--
-- project_qbo_id / qbo_estimate_id are QBO id strings, collation-pinned to join
-- qbo_transactions.
CREATE TABLE IF NOT EXISTS project_change_orders (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_qbo_id     VARCHAR(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  qbo_estimate_id    VARCHAR(32) COLLATE utf8mb4_unicode_ci NULL,   -- linked QBO estimate; NULL = app draft
  kind               VARCHAR(16) NOT NULL DEFAULT 'change_order',   -- 'original' | 'change_order'
  co_number          INT NULL,                                      -- CO sequence per project
  title              VARCHAR(255) NULL,
  reason             VARCHAR(120) NULL,
  scope              TEXT NULL,
  amount             DECIMAL(14,2) NULL,   -- customer amount (drafts; QBO-linked pulls from QBO)
  contract_labor     DECIMAL(14,2) NULL,   -- crew "your rate" (drafts)
  status             VARCHAR(16) NOT NULL DEFAULT 'draft',          -- draft|sent|approved|rejected
  created_by_user_id BIGINT UNSIGNED NULL,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pco_estimate (qbo_estimate_id),
  KEY idx_pco_project (project_qbo_id)
);
