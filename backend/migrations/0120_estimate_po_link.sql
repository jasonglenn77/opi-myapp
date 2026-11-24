-- 2026-11-24 (owner, Project Setup "Project estimate created"): tie an estimate to
-- its PO file by hand when the automatic match misses (PO number written
-- differently, a revised PO, a blanket PO). No row = the automatic match.
-- document_id NULL with no_po = 1: this estimate has no PO of its own.
CREATE TABLE IF NOT EXISTS project_estimate_po_link (
  entity_id        VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,   -- project qbo_id
  estimate_qbo_id  VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  document_id      INT NULL,
  no_po            TINYINT(1) NOT NULL DEFAULT 0,
  by_email         VARCHAR(255) NULL,
  at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_id, estimate_qbo_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
