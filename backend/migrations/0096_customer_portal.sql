-- Customer portal: private sign-in links staff give a customer (no app account),
-- and customers' answers on change orders.

CREATE TABLE IF NOT EXISTS customer_portal_access (
  id             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  customer_qbo_id VARCHAR(40) NOT NULL,          -- the customer (or dealer) whose projects they see
  contact_id     INT          NULL,              -- contacts.id, when made for a known contact
  name           VARCHAR(160) NULL,              -- who it's for (shown on approvals)
  email          VARCHAR(255) NULL,
  token_hash     CHAR(64)     NOT NULL,          -- sha256 of the link token; the token itself is never stored
  active         TINYINT(1)   NOT NULL DEFAULT 1,
  expires_at     DATETIME     NULL,
  created_by     VARCHAR(255) NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at   DATETIME     NULL,
  UNIQUE KEY ux_cpa_token (token_hash),
  KEY ix_cpa_customer (customer_qbo_id)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS change_order_responses (
  id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  co_id        INT          NOT NULL,              -- project_change_orders.id
  decision     VARCHAR(16)  NOT NULL,              -- approved | declined
  signer_name  VARCHAR(160) NOT NULL,
  note         TEXT         NULL,
  access_id    INT          NULL,                  -- customer_portal_access.id
  ip           VARCHAR(64)  NULL,
  at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_cor_co (co_id)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
