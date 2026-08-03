-- Batch A (Phase 3a): mark schedule rows a user has hand-edited so an automatic
-- refresh (when assignment dates or the estimate change) can rebuild the
-- untouched rows while PRESERVING manual edits. Without this the app would have
-- to blow away edits or never refresh — the owner wants "handle new info
-- automatically, but don't lose my QC edits."

ALTER TABLE project_invoice_milestones   ADD COLUMN edited TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE project_payment_installments  ADD COLUMN edited TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE project_expense_items         ADD COLUMN edited TINYINT(1) NOT NULL DEFAULT 0;
