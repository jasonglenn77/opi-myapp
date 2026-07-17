-- Final Rolling-Revenue column parity + the two "polish" pieces:
--   • workbook_url   — the RR "Link" column: a Google-Drive link to the detailed
--     quoting-metrics workbook, which lives OUTSIDE the app (we don't import it;
--     new quotes are built in-app). Editable per row.
--   • target_end_date, discounted_contract_value — RR columns we hadn't captured.
--   • metrics_source  — where a row's financial summary comes from: 'rr' (seeded
--     from the sheet) vs 'app' (pushed live from the in-app quoting-metrics
--     estimate). Lets the UI badge app-generated rows and drives the go-forward
--     model (new quotes feed the pipeline from the app calc).

ALTER TABLE opportunities
  ADD COLUMN workbook_url             VARCHAR(512)  NULL AFTER app_estimate_id,
  ADD COLUMN target_end_date          DATE          NULL AFTER target_start_date,
  ADD COLUMN discounted_contract_value DECIMAL(14,2) NULL AFTER contract_value,
  ADD COLUMN metrics_source           VARCHAR(8)    NULL AFTER order_value;
