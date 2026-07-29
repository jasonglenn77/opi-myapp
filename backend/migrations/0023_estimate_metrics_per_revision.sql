-- Per-estimate (per-revision) rollup metrics.
--
-- The pipeline row shows Labor / Travel / OH&P / Value for the CURRENT quote,
-- sourced from the opportunity (populated by Save & Send -> sync-metrics). To
-- show those figures on EACH revision row, we mirror them onto the estimate so
-- every revision carries its own last-synced summary, and "use this revision"
-- can copy the chosen revision's figures back onto the pipeline row.

ALTER TABLE estimates
  ADD COLUMN labor_days     DECIMAL(10,2) NULL,
  ADD COLUMN travel_days    DECIMAL(10,2) NULL,
  ADD COLUMN ohp_pct        DECIMAL(8,2)  NULL,
  ADD COLUMN ohp_amount     DECIMAL(14,2) NULL,
  ADD COLUMN contract_value DECIMAL(14,2) NULL;

-- Backfill the current revision of each opportunity from the figures already
-- stored on the opportunity, so existing quotes show metrics immediately.
UPDATE estimates e
  JOIN opportunities o ON o.app_estimate_id = e.id
   SET e.labor_days     = o.labor_days,
       e.travel_days    = o.travel_days,
       e.ohp_pct        = o.ohp_pct,
       e.ohp_amount     = o.ohp_amount,
       e.contract_value = o.contract_value;
