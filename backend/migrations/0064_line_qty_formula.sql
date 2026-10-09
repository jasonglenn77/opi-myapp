-- 0064 Quoting-metrics line additions.
-- qty_formula: Excel-style QTY entry (e.g. =500*10); qty stores the result,
-- qty_formula keeps the expression so the line shows how it was derived.
-- custom_*_per_day: a quote-specific Miscellaneous contract-labor item (the
-- workbook's blank Misc rows) carries its own daily production rates instead
-- of a catalog productivity rate.
ALTER TABLE quote_metric_lines
  ADD COLUMN qty_formula VARCHAR(255) NULL AFTER qty,
  ADD COLUMN custom_std_per_day DECIMAL(12,3) NULL AFTER qty_formula,
  ADD COLUMN custom_agg_per_day DECIMAL(12,3) NULL AFTER custom_std_per_day;
