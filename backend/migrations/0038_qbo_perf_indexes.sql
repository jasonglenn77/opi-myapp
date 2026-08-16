-- QBO query performance: index the customer/project/type columns the project
-- card and Billing & Schedule endpoints filter on.
--
-- Every existing composite index on these tables LEADS WITH realm_id
-- (idx_txn_customer, idx_line_customer, idx_sales_project, idx_txn_type_date),
-- but the app is single-realm and its per-project queries filter by the customer/
-- project column WITHOUT realm_id — so MySQL could not use those indexes and
-- full-scanned qbo_transactions (~38k), qbo_transaction_lines (~38k) and
-- qbo_sales_transaction_lines (~159k), parsing JSON on every row. That made
-- expanding a project row and opening the Billing & Schedule tab slow.
--
-- These three non-realm-leading indexes turn those scans into ref/range seeks
-- (measured: line scan 36k->27 rows, sales scan 156k->357, date scan 38k->158).
-- The endpoints already pass the ids as strings (the columns are VARCHAR), so no
-- query changes are needed for the optimizer to use them. Purely additive; adding
-- an index never changes query results.

CREATE INDEX idx_line_customer_only ON qbo_transaction_lines (line_customer_qbo_id);

CREATE INDEX idx_sales_project_only ON qbo_sales_transaction_lines (project_customer_qbo_id);

CREATE INDEX idx_txn_type_date_only ON qbo_transactions (entity_type, txn_date);
