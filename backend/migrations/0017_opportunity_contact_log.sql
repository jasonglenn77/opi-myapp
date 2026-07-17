-- Pipeline contact-logging, mirroring the Rolling Revenue sheet's follow-up
-- workflow. Each opportunity (quote row) carries a running summary — last
-- contact date, follow-up count, last communication type — plus the most-recent
-- revision date. The individual log entries live in customer_contact_log (which
-- already backs the estimate-level log); we add opportunity_id so a log entry can
-- be scoped to a pipeline row. Comm types are the existing `communication_type`
-- lookup (LVM/PC/ES/ER).

ALTER TABLE opportunities
  ADD COLUMN last_contact_date         DATE        NULL AFTER pipeline_status,
  ADD COLUMN follow_up_count           INT         NULL DEFAULT 0 AFTER last_contact_date,
  ADD COLUMN last_comm_type            VARCHAR(8)  NULL AFTER follow_up_count,
  ADD COLUMN most_recent_revision_date DATE        NULL AFTER last_comm_type;

ALTER TABLE customer_contact_log
  ADD COLUMN opportunity_id INT UNSIGNED NULL AFTER qbo_customer_id,
  ADD KEY idx_ccl_opportunity (opportunity_id);
