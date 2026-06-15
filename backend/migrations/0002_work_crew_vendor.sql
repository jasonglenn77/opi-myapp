-- Migration 0002: link a (parent) work crew to its QBO vendor, so we can show
-- crew earnings (what OPI pays them) from Bills / BillPayments.
ALTER TABLE work_crews ADD COLUMN vendor_qbo_id VARCHAR(32) NULL;
