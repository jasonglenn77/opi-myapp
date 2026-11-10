-- Project Setup page: what staff have marked on each won job's setup checklist,
-- and the PO numbers/totals read from PO PDFs (cached; reading S3 + the PDF is slow).

-- One row per (job, step) that someone marked by hand. Steps the app can see in
-- the data (PM set, dates set, offer accepted, invoice sent...) need no row.
-- subject = the QuickBooks project id, or 'opp:<opportunity id>' before the
-- project exists in QuickBooks.
CREATE TABLE IF NOT EXISTS project_setup_steps (
  subject      VARCHAR(40)  NOT NULL,
  step_key     VARCHAR(40)  NOT NULL,
  status       VARCHAR(16)  NOT NULL,           -- done | not_needed | confirmed
  note         VARCHAR(500) NULL,
  by_user_id   INT          NULL,
  by_email     VARCHAR(255) NULL,
  at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (subject, step_key)
);

CREATE TABLE IF NOT EXISTS setup_po_parsed (
  document_id  INT          NOT NULL PRIMARY KEY,
  po_number    VARCHAR(80)  NULL,
  po_total     DECIMAL(14,2) NULL,
  text_snippet TEXT         NULL,
  parsed_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
