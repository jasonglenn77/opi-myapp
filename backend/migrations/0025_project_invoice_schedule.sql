-- Customer invoice schedule per project (Projects hub Phase 2, Billing & Schedule
-- tab). The office bills the customer on the estimate terms (default
-- 35% at PO / 35% at start / 30% at end, net-30); these milestones feed the
-- cashflow INflows (Phase 3). Keyed by project qbo_id (entity_id), mirroring the
-- crew payment schedule.

CREATE TABLE IF NOT EXISTS project_invoice_schedules (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  entity_id      VARCHAR(64)  NOT NULL,             -- project qbo_id
  contract_value DECIMAL(14,2) NULL,
  terms_note     VARCHAR(255) NULL,
  net_days       INT NOT NULL DEFAULT 30,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_inv_sched_proj (entity_id)
);

CREATE TABLE IF NOT EXISTS project_invoice_milestones (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  schedule_id  INT NOT NULL,
  seq          INT NOT NULL,
  label        VARCHAR(120) NULL,
  pct          DECIMAL(6,3) NULL,
  invoice_date DATE NULL,
  due_date     DATE NULL,
  amount       DECIMAL(14,2) NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | sent | paid
  note         VARCHAR(255) NULL,
  CONSTRAINT fk_inv_ms_sched FOREIGN KEY (schedule_id)
    REFERENCES project_invoice_schedules(id) ON DELETE CASCADE
);
