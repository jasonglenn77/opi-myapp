-- 0085: Cash Flow settings shared by everyone (key/value).
--   opening_source = where week 1's opening cash comes from:
--     b250 = the bank balance typed on OPI's B250 (the bank's own balance,
--            which QuickBooks doesn't share with outside apps)
--     qbo  = QuickBooks book balance of the chosen bank accounts
--   Owner decision 2026-10-28: use the B250 balance until the QuickBooks books
--   are reconciled to the bank; a typed opening still overrides either.

CREATE TABLE IF NOT EXISTS cashflow_settings (
  skey       VARCHAR(64) NOT NULL PRIMARY KEY,
  svalue     VARCHAR(255) NULL,
  updated_by VARCHAR(255) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT IGNORE INTO cashflow_settings (skey, svalue, updated_by) VALUES ('opening_source', 'b250', 'migration 0085');
