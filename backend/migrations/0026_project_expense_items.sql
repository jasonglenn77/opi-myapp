-- Project expense schedule (Projects hub Phase 2, Billing & Schedule tab).
-- Expected non-labor outflows the office plans across the project timeline —
-- materials, rentals, lodging, propane, travel — each dated so they feed the
-- cashflow OUTflows (Phase 3). Crew labor is handled separately by the crew
-- payment schedule. Keyed by project qbo_id (entity_id).

CREATE TABLE IF NOT EXISTS project_expense_items (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  entity_id    VARCHAR(64)  NOT NULL,                    -- project qbo_id
  category     VARCHAR(40)  NOT NULL DEFAULT 'Other',    -- Materials|Rentals|Lodging|Propane|Travel|Other
  description  VARCHAR(255) NULL,
  amount       DECIMAL(14,2) NULL,
  expense_date DATE NULL,
  status       VARCHAR(20)  NOT NULL DEFAULT 'planned',  -- planned | ordered | paid
  note         VARCHAR(255) NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_exp_proj (entity_id)
);
