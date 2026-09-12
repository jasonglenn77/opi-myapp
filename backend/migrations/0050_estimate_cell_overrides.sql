-- 0050 Override-any-cell (#1 sheet parity, OPI pipeline feedback).
-- A JSON map of {cellKey: typed-over value} per estimate. Mirrors typing over a
-- formula cell in the Google Sheet: the app still knows the formula value, the
-- override wins in display/rollups, and reverting just deletes the key.
ALTER TABLE estimates
  ADD COLUMN cell_overrides JSON NULL;
