-- Expand `opportunities` to hold the fields carried by OPI's "Rolling Revenue"
-- quote log (B151), so the app can seed that sheet and become the pipeline of
-- record. The base table (0012) was a lean RFQ front-door; the Rolling Revenue
-- sheet is richer — it carries a win-probability STAGE plus the quote financials
-- (OH&P $/%, contract & order value) and schedule (labor/travel days). These also
-- feed the sales-pipeline KPIs the owner wants (volume, win rate, forecast $).
--
-- `pipeline_status` holds the granular probability stage verbatim (the
-- `estimate_pipeline_status` lookup values, e.g. "20% Budgetary, Project
-- Uncertain"); the existing lifecycle `status` (received/quoting/sent/won/lost/
-- declined) is derived from it. `*_raw` columns preserve the sheet's free-text
-- customer/contact names even when they don't resolve to a qbo_customers row, so
-- no data is lost on import.

-- Historical Rolling Revenue rows may name a customer we can't resolve to a
-- qbo_customers row (abbreviations, one-offs); allow a NULL link so those rows
-- still import with their customer_name_raw preserved rather than being dropped.
ALTER TABLE opportunities MODIFY COLUMN qbo_customer_id INT UNSIGNED NULL;

ALTER TABLE opportunities
  ADD COLUMN pipeline_status        VARCHAR(64)    NULL AFTER status,
  ADD COLUMN quoted_by             VARCHAR(64)    NULL AFTER estimator_user_id,
  ADD COLUMN customer_name_raw     VARCHAR(255)   NULL AFTER qbo_customer_id,
  ADD COLUMN contact_name_raw      VARCHAR(255)   NULL AFTER contact_id,
  ADD COLUMN city                  VARCHAR(120)   NULL AFTER target_start_date,
  ADD COLUMN state                 VARCHAR(64)    NULL AFTER city,
  ADD COLUMN labor_days            DECIMAL(8,2)   NULL,
  ADD COLUMN travel_days           DECIMAL(8,2)   NULL,
  ADD COLUMN contract_value        DECIMAL(14,2)  NULL,
  ADD COLUMN order_value           DECIMAL(14,2)  NULL,
  ADD COLUMN ohp_amount            DECIMAL(14,2)  NULL,
  ADD COLUMN ohp_pct               DECIMAL(6,2)   NULL,
  ADD COLUMN total_revisions       INT            NULL,
  ADD COLUMN order_date            DATE           NULL,
  ADD COLUMN quote_sent_date       DATE           NULL,
  ADD COLUMN expected_decision_date DATE          NULL;

CREATE INDEX idx_opp_pipeline_status ON opportunities (pipeline_status);
CREATE INDEX idx_opp_quote_number    ON opportunities (quote_number);
