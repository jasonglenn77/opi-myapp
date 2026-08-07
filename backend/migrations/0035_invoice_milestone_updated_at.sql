-- Add updated_at to project_invoice_milestones so the cashflow scheduled-cash
-- cache can detect edits automatically (it tracks the max updated_at across the
-- schedule tables and recomputes when anything changes — no per-endpoint wiring).
-- The other schedule tables (project_payment_installments, project_expense_
-- installments, project_schedule_items) already have updated_at.

ALTER TABLE project_invoice_milestones
  ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Drop the cache so it recreates with the new source_max column (it's a cache —
-- it recomputes on next view; nothing is lost).
DROP TABLE IF EXISTS cashflow_schedule_cache;
