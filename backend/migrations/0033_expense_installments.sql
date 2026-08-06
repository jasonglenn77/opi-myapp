-- Editable per-category weekly expense schedule (like invoice milestones / crew
-- installments). Auto-generated the first time, then the office can change the
-- amounts + dates, add rows, or delete rows. Paid actuals tier against it so the
-- cash-flow forecast counts only what's still scheduled. Replaces the earlier
-- weekly/lump toggle (0032, now unused).

CREATE TABLE IF NOT EXISTS project_expense_installments (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  entity_id  VARCHAR(64) NOT NULL,          -- project qbo_id
  category   VARCHAR(64) NOT NULL,
  seq        INT NOT NULL DEFAULT 1,
  week_of    DATE NULL,
  amount     DECIMAL(14,2) NULL,
  edited     TINYINT(1) NOT NULL DEFAULT 0, -- hand-edited -> preserved on refresh
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_expinst (entity_id, category)
);
