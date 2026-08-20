-- Overhead edit history + revert-to-auto-generated (#3).
--
-- Keep the auto-generated (run-rate seeded) baseline on each overhead item so we
-- can show it next to a user's edit and offer a one-click revert, and log every
-- change (who/when/old->new) in a history table.

ALTER TABLE cashflow_overhead
  ADD COLUMN seed_amount DECIMAL(14,2) NULL AFTER amount,
  ADD COLUMN seed_cadence VARCHAR(16) NULL AFTER cadence,
  ADD COLUMN seed_anchor_date DATE NULL AFTER anchor_date;

-- Backfill the baseline from current values. These items are the auto-seed (the
-- edit feature is new), so current == auto-generated for the existing rows.
UPDATE cashflow_overhead
   SET seed_amount = amount, seed_cadence = cadence, seed_anchor_date = anchor_date
 WHERE seed_amount IS NULL;

CREATE TABLE IF NOT EXISTS cashflow_overhead_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  overhead_id INT NOT NULL,
  action VARCHAR(16) NOT NULL,            -- create | edit | revert | delete
  actor VARCHAR(255) NULL,                -- user email who made the change
  item_name VARCHAR(120) NULL,            -- name at the time (keeps deletes legible)
  old_amount DECIMAL(14,2) NULL, new_amount DECIMAL(14,2) NULL,
  old_cadence VARCHAR(16) NULL, new_cadence VARCHAR(16) NULL,
  old_anchor_date DATE NULL, new_anchor_date DATE NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_oh_hist (overhead_id, id)
) ENGINE=InnoDB;
