-- Per-category expense cash-out mode. Default is the auto weekly spread; the
-- office can switch a category (e.g. a material buy) to a single one-time
-- payment at the project end date instead.

CREATE TABLE IF NOT EXISTS project_expense_category_schedule (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  entity_id  VARCHAR(64) NOT NULL,          -- project qbo_id
  category   VARCHAR(64) NOT NULL,
  mode       VARCHAR(16) NOT NULL DEFAULT 'weekly',  -- weekly | lump_end
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_expcat_sched (entity_id, category)
);
