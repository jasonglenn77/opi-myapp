-- Recurring overhead schedule (Phase 3b-2): editable rent / insurance / payroll /
-- loan-payment items that expand across the weekly forecast, replacing the
-- trailing run-rate. Auto-seeded from the run-rate the first time so the forecast
-- is unchanged until the office refines it into real recurring items.

CREATE TABLE IF NOT EXISTS cashflow_overhead (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(80) NULL,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  cadence VARCHAR(16) NOT NULL DEFAULT 'monthly',   -- weekly|biweekly|monthly|quarterly|annual
  anchor_date DATE NULL,                             -- first/reference occurrence
  end_date DATE NULL,                                -- optional stop
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  edited TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
