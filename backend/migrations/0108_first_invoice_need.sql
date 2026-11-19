-- 2026-11-18 (owner feedback, Project Setup "First invoice sent"): per estimate,
-- does a first invoice need to go out? No row = the app's default (the billing
-- rule: change orders and small estimates bill once, at completion, so no first
-- invoice; otherwise one is needed). The office can set it either way.
CREATE TABLE IF NOT EXISTS project_estimate_first_invoice (
  entity_id        VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,   -- project qbo_id
  estimate_qbo_id  VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  need             VARCHAR(12) NOT NULL,             -- needed | not_needed
  note             VARCHAR(500) NULL,
  by_email         VARCHAR(255) NULL,
  at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_id, estimate_qbo_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
