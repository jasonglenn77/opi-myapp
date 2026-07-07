-- Per-estimate payment schedules. OPI stacks change-orders as separate estimates;
-- each converted estimate with Contract Labor gets its own bi-weekly schedule
-- (not one summed schedule per project). Link each schedule to its source estimate
-- and make the schedule unique per (project, estimate) instead of per project.
ALTER TABLE project_payment_schedules
  ADD COLUMN estimate_qbo_id VARCHAR(40) NULL AFTER entity_id,
  ADD COLUMN estimate_doc_number VARCHAR(50) NULL AFTER estimate_qbo_id;

ALTER TABLE project_payment_schedules DROP INDEX uq_pps_entity;
ALTER TABLE project_payment_schedules ADD UNIQUE KEY uq_pps_entity_est (entity_id, estimate_qbo_id);
