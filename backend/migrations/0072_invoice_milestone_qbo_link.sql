-- Align invoice schedules to actual QuickBooks invoices (billing/align.py).
-- A milestone that has been matched to a real QBO invoice remembers WHICH
-- invoice (qbo_invoice_id = the invoice's QBO TxnId) so the Billing tab can show
-- that invoice's own status (Paid / Sent · A/R / part paid) instead of the
-- amount burn-down, and so re-alignment is stable (idempotent).
-- aligned_at = when the engine last wrote the row. The engine clears `edited`
-- when it writes, so edited = 1 always means "hand-edited since the last
-- alignment" — those rows are preserved unless they conflict with an invoice.

ALTER TABLE project_invoice_milestones ADD COLUMN qbo_invoice_id VARCHAR(40) NULL;
ALTER TABLE project_invoice_milestones ADD COLUMN aligned_at DATETIME NULL;
CREATE INDEX idx_inv_ms_qbo_invoice ON project_invoice_milestones (qbo_invoice_id);
