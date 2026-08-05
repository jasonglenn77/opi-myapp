-- Invoice schedules move from one-per-project to one-per-estimate.
--   * Drop the old UNIQUE(entity_id) that allowed only a single schedule.
--   * Remove legacy project-level schedules (estimate_qbo_id IS NULL) + their
--     milestones so they regenerate per estimate (they're auto-generated plans).
--   * Add UNIQUE(entity_id, estimate_qbo_id).

DELETE m FROM project_invoice_milestones m
  JOIN project_invoice_schedules s ON s.id = m.schedule_id
  WHERE s.estimate_qbo_id IS NULL;

DELETE FROM project_invoice_schedules WHERE estimate_qbo_id IS NULL;

ALTER TABLE project_invoice_schedules DROP INDEX uq_inv_sched_proj;

ALTER TABLE project_invoice_schedules
  ADD UNIQUE KEY uq_inv_sched_est (entity_id, estimate_qbo_id);
