-- C1: per-project contractor (crew) payment schedule.
-- One schedule per project; installments paid bi-weekly in arrears (even split
-- of the contract labor across the periods, then individually editable).
CREATE TABLE IF NOT EXISTS project_payment_schedules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_id VARCHAR(40) COLLATE utf8mb4_unicode_ci NOT NULL,   -- project qbo_customers.qbo_id
  crew_id INT NULL,                                            -- work_crews.id (accepted crew)
  contract_labor DECIMAL(12,2) NOT NULL DEFAULT 0,
  start_date DATE NULL,
  end_date DATE NULL,
  invoice_lead_days INT NOT NULL DEFAULT 7,                    -- send invoice N days before pay date
  created_by_user_id BIGINT UNSIGNED NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pps_entity (entity_id)
);

CREATE TABLE IF NOT EXISTS project_payment_installments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  schedule_id INT NOT NULL,
  seq INT NOT NULL,
  pay_date DATE NULL,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  send_invoice_date DATE NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',              -- pending | paid
  note VARCHAR(255) NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ppi_schedule (schedule_id)
);
