-- 0084: Forecast assumptions — every average the app uses to place dates and
-- money (expense timing per category, bill-to-payment lag, ...) is stored here
-- with the evidence it was measured from, so the Assumptions page can show it
-- and an owner can override it. Hard-coded rules (35/35/30, payday anchor, ...)
-- are listed on the same page from the code itself, not stored.
--   calibrated   = measured from QuickBooks history (recomputed nightly)
--   override     = an owner's replacement value (wins until cleared)

CREATE TABLE IF NOT EXISTS forecast_assumptions (
  akey          VARCHAR(64) NOT NULL PRIMARY KEY,   -- e.g. expense_timing.Rentals
  grp           VARCHAR(32) NOT NULL,               -- expense_timing | estimate_accuracy
  label         VARCHAR(120) NOT NULL,
  calibrated    JSON NULL,                          -- measured value
  basis         JSON NULL,                          -- evidence: projects, bills, dollars, window
  override_val  JSON NULL,                          -- owner override (NULL = use calibrated)
  override_note VARCHAR(255) NULL,
  override_by   VARCHAR(255) NULL,
  override_at   DATETIME NULL,
  computed_at   DATETIME NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- How each expense row was produced, so the schedule can say "auto · timing
-- profile" vs the old even spread vs a hand-entered row.
--   auto_even    = estimate spread evenly over the project weeks (pre-0084)
--   auto_profile = spread by the category's calibrated timing profile
ALTER TABLE project_expense_installments
  ADD COLUMN basis VARCHAR(20) NOT NULL DEFAULT 'auto_even' AFTER amount;
