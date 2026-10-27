-- 0083 OPI's "B250.OP.13 Week Cash Flow Forecast" workbook, parsed into the app
-- (app/gsync/b250_cash.py) so Data Review can check every typed number on it
-- against QuickBooks and the crew Payment Schedules (review_sources.py,
-- category "sources"). Read from Drive once the file is shared with the
-- service account, or uploaded on the Data Review page until then. Only the
-- latest few snapshots are kept.
--
-- gsync_b250_lines.section:
--   opening          week-1 opening cash (typed)
--   inflow_dealer    dealer header row (week 1 = cash collected)
--   inflow_invoice   an open invoice row (invoice #, due date, expected week)
--   forecast_invoice a dealer's "Forecasted Invoices" row (typed guess)
--   ap               A/P vendor row
--   contractor       crew row (payday amounts)
--   payroll / operating   payroll and other operating rows
--   total            a formula total row (kept for the sheet-integrity check)
--   snapshot         SnapShot tab past-due row
--   monthly          MonthlyYearly Totals (label bookings / revenue)

CREATE TABLE IF NOT EXISTS gsync_b250_snapshot (
  id INT AUTO_INCREMENT PRIMARY KEY,
  source VARCHAR(16) NOT NULL,
  file_id VARCHAR(64) NULL,
  file_name VARCHAR(255) NULL,
  file_modified VARCHAR(40) NULL,
  tab_name VARCHAR(120) NULL,
  week1_end DATE NULL,
  line_count INT NOT NULL DEFAULT 0,
  loaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  loaded_by VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gsync_b250_lines (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  snapshot_id INT NOT NULL,
  section VARCHAR(24) NOT NULL,
  row_num INT NULL,
  col VARCHAR(4) NULL,
  label VARCHAR(255) NULL,
  group_label VARCHAR(255) NULL,
  crew_code VARCHAR(32) NULL,
  invoice_num VARCHAR(40) NULL,
  due_date DATE NULL,
  week_end DATE NULL,
  amount DECIMAL(14,2) NULL,
  is_formula TINYINT(1) NOT NULL DEFAULT 0,
  formula VARCHAR(500) NULL,
  note VARCHAR(1000) NULL,
  KEY idx_b250_snap (snapshot_id, section),
  KEY idx_b250_inv (invoice_num)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
