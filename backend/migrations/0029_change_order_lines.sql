-- Batch B slice 4b: persist line items on app-created change orders, so a CO
-- built in the app (not QBO) becomes a first-class estimate — it expands to its
-- line items like a QBO estimate, its total auto-sums from the lines, it can be
-- re-printed to PDF, and the lines can be transferred into a QBO estimate.

CREATE TABLE IF NOT EXISTS project_change_order_lines (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  co_id       INT NOT NULL,                 -- project_change_orders.id
  seq         INT NOT NULL DEFAULT 1,
  item        VARCHAR(150) NULL,
  description VARCHAR(500) NULL,
  qty         DECIMAL(12,3) NULL,
  rate        DECIMAL(14,2) NULL,
  amount      DECIMAL(14,2) NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_col_co (co_id)
);
