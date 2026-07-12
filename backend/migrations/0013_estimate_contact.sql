-- File quoting-metrics estimates under a specific customer contact (granular
-- per-contact reporting). Nullable — existing estimates stay unlinked.
ALTER TABLE estimates
  ADD COLUMN contact_id INT UNSIGNED NULL AFTER qbo_customer_qbo_id;
