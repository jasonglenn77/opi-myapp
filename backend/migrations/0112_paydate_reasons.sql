-- 2026-11-11 idea from Ashley (Invoice & Pay Dates): a "Reason" note on each line,
-- so she can work through the invoices to send and jot why each one is where it is.
CREATE TABLE IF NOT EXISTS paydate_reasons (
  item_type  VARCHAR(12) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,   -- invoice | crew | expense
  item_id    INT NOT NULL,                                                             -- milestone / installment id
  note       VARCHAR(500) NOT NULL,
  by_email   VARCHAR(255) NULL,
  at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (item_type, item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
