-- C3: crew work offers. Office sends an offer (labor amount + scope auto-filled
-- from the accepted estimate); the crew accepts/declines; declines are reassigned
-- by withdrawing and sending a new offer to another crew. An accepted offer feeds
-- the payment schedule. Multiple rows per project = the reassignment history.
CREATE TABLE IF NOT EXISTS work_offers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_id VARCHAR(40) COLLATE utf8mb4_unicode_ci NOT NULL,   -- project qbo_customers.qbo_id
  crew_id INT NOT NULL,                                        -- work_crews.id (child crew offered)
  labor_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  scope TEXT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'sent',                  -- sent | accepted | declined | withdrawn
  sent_at DATETIME NULL,
  responded_at DATETIME NULL,
  response_note VARCHAR(255) NULL,
  created_by_user_id BIGINT UNSIGNED NULL,
  responded_by_user_id BIGINT UNSIGNED NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_wo_entity (entity_id),
  INDEX idx_wo_crew (crew_id, status)
);
