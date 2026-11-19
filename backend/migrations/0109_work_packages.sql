-- 2026-11-18 (owner): assignments move from the project to its estimates.
-- A WORK PACKAGE (the existing project_phases table; the UI says "package",
-- never "phase") is one or more estimates that share dates. Its dates are its
-- schedule lines (project_schedule_items.package_id): usually one range, more
-- when the work breaks. Each estimate has its own PM (project_estimate_phase.pm_id)
-- and crew (project_estimate_billing.crew_id, as on Billing). The project keeps
-- its status and its overage days (on its last line).
--
-- Additive only: every page that reads project_schedule_items keeps working.
-- The backfill (every project: one package with all its estimates and all its
-- lines, PM from the lines) is app/packages/service.ensure_all(), run by the
-- deploy and idempotent.
ALTER TABLE project_schedule_items ADD COLUMN package_id INT NULL, ADD KEY idx_psi_package (package_id);
ALTER TABLE project_estimate_phase ADD COLUMN pm_id INT NULL;
