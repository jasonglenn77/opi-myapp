-- Owner decision 2026-11-11: the app no longer copies data out of Drive
-- documents or Julie's B250. The cash forecast runs on app data (QuickBooks
-- sync + what people enter in the app).
--  * Opening cash: QuickBooks bank accounts (the typed opening on Cash Flow
--    still overrides), never the B250's bank balance.
--  * The three overhead lines whose amounts were copied from the B250 stay,
--    as app entries anyone can edit.
UPDATE cashflow_settings SET svalue = 'qbo' WHERE skey = 'opening_source';
UPDATE cashflow_overhead
   SET source = 'manual',
       source_note = 'Entered in the app (amount first copied from the B250 at setup, edit it here)'
 WHERE source = 'b250';
