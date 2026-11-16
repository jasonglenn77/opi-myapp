-- 2026-11-15 owner decisions.
--
-- 1) Books: a job that ended on or after Oct 1 2026 keeps its books open until
--    it is closed out on Project Closeout. An older finished job counts in the
--    cash forecast only when someone includes it here (projects/books.py).
CREATE TABLE IF NOT EXISTS project_books_open (
  entity_id  VARCHAR(40)  NOT NULL PRIMARY KEY,
  include    TINYINT(1)   NOT NULL DEFAULT 1,
  note       VARCHAR(500) NULL,
  by_user_id BIGINT UNSIGNED NULL,
  by_email   VARCHAR(255) NULL,
  at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2) Opening cash: the balance a person types on Cash Flow (saved for everyone,
--    with the date it is as of). Not read from QuickBooks bank accounts or the
--    B250 any more. Kept as a history; the newest row is the opening.
CREATE TABLE IF NOT EXISTS cashflow_opening_cash (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  amount     DECIMAL(14,2) NOT NULL,
  as_of      DATE          NOT NULL,
  note       VARCHAR(500)  NULL,
  by_user_id BIGINT UNSIGNED NULL,
  by_email   VARCHAR(255)  NULL,
  at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
);

UPDATE cashflow_settings SET svalue = 'manual', updated_by = 'migration 0105' WHERE skey = 'opening_source';
