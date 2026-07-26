-- App-level defaults for the generated estimate PDF's standard/boilerplate blocks
-- (company header, Payment Terms, Stipulations, Rentals/Dumpster notes, sales rep,
-- expiration window). Seeded from OPI's real QBO estimates. Key-value so blocks can
-- be added later; the estimate-PDF endpoint loads these as defaults and the estimator
-- can override any of them per quote.
CREATE TABLE IF NOT EXISTS estimate_pdf_defaults (
  setting_key   VARCHAR(64)  NOT NULL PRIMARY KEY,
  setting_value TEXT         NULL,
  updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO estimate_pdf_defaults (setting_key, setting_value) VALUES
 ('company_name',    'On Point Installations, LLC'),
 ('company_address', 'PO Box 148\nColumbus, TX 78934 US'),
 ('company_phone',   '979-575-3746'),
 ('company_email',   'chris@onpointinstallers.com'),
 ('sales_rep',       'Julie Martins'),
 ('expiration_days', '30'),
 ('payment_terms',   'Net 30\nInvoicing schedule:\n35% on receipt of PO\n35% at job start\n30% at job completion\n*** If a project is starting less than 2 weeks of receiving the PO, the first down payment will be due upon receiving the PO ***'),
 ('stipulations',    'Anchors will be provided by customer. Work Hours are 7am-7pm 7 days a week, unless otherwise agreed upon and stated in purchase order. Power, lighting and trash receptacle to be provided by customer.\nRamp or ground access required. Materials can be unloaded inside the building unless otherwise agreed upon and stated in the PO. Ambient Temperature assumed (no freezer/cooler).\nLabor and wait time charges will be billed at $3500 per day for non local projects and $3000 per day locally.\nIf contractor license is required, one can be provided upon request with 30 days notice.'),
 ('rentals_note',    '**Socks and diapers for equipment can be provided for an additional $450 per equipment piece.'),
 ('dumpster_note',   'Dumpster option if not provided by GC. Each dumpster is $1,000 for initial and $1,000 per swap. Porta potty rental option $1,000 - up to 28 consecutive day rental.')
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);
