-- Per-estimate final price adjustment (+/-).
--
-- The workbooks let estimators hand-nudge the final Price to Customer off the
-- computed value (e.g. round UP +$2,404 to a clean number, or DISCOUNT -$950 to
-- win the job). This column captures that manual override at the estimate level;
-- the Review tab applies it to Price to Customer and re-derives profit/margin.
-- Positive = charge more than computed; negative = discount. 0 = no override.

-- Nullable (NULL = no adjustment = 0) to match the other optional numeric
-- estimate columns; the frontend clears the field to NULL and treats it as 0.
ALTER TABLE estimates
  ADD COLUMN price_adjustment DECIMAL(12,2) NULL;
