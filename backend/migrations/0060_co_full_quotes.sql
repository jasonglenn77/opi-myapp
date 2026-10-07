-- 0060: Change-order estimate rework, item #5 option 2, PHASE 2 (2026-10-06).
--
-- 1) estimates.project_qbo_id — a quoting-metrics estimate created FROM a
--    project's Change Orders tab ("Build a full quote") attaches to the
--    PROJECT instead of a pipeline opportunity. NULL = normal pipeline quote.
--    Collation-pinned to join qbo_customers.qbo_id.
--
-- 2) project_change_orders.app_estimate_id — the draft CO row created
--    alongside a full quote carries the app estimate id, so the Change Orders
--    tab lists the quote immediately (status + "Open quote →") and the
--    tab-load auto-link can match the synced QBO estimate by doc number ==
--    the app estimate's quote_number.
--
-- 3) project_change_orders.pdf_model — the full Estimate-PDF editor model
--    (bill-to / sales rep / footer title / preparer / lines) persisted per CO
--    so draft edits + re-prints keep the editor's customizations (previously
--    re-prints rebuilt from lines + defaults, losing bill-to/footer edits).

ALTER TABLE estimates
  ADD COLUMN project_qbo_id VARCHAR(32) COLLATE utf8mb4_unicode_ci NULL AFTER qbo_customer_qbo_id,
  ADD INDEX idx_estimates_project_qbo (project_qbo_id);

ALTER TABLE project_change_orders
  ADD COLUMN app_estimate_id INT UNSIGNED NULL AFTER qbo_estimate_id,
  ADD COLUMN pdf_model JSON NULL AFTER contract_labor,
  ADD INDEX idx_pco_app_estimate (app_estimate_id);
