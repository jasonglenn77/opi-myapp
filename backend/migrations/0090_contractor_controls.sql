-- 0090 Contractor controls (Luke's 10/31 request): one home for crew payments,
-- progress checks on every project, and cost entries before QuickBooks has them.
--
-- review_decisions    one row per flagged item, who looked at it and what they
--                     decided (crew payment issues, labor overages). The fingerprint
--                     holds the amount it was decided on, so a changed number shows.
-- crew_pay_approvals  approve or hold on an upcoming crew payment, tied to the date
--                     and amount approved: if either changes the approval lapses.
-- progress_settings   per-project switch for sign-offs (NULL = by contract size)
-- progress_signoffs   sign-off at 25/50/75/100, with the numbers as they stood
-- receipts            now also holds entries with no receipt (a lift booked, a
--                     hotel block) and job tags for card charges (source), and
--                     records the QuickBooks line an entry was matched to.

ALTER TABLE project_payment_schedules
  ADD COLUMN lodging_included DECIMAL(12,2) NULL,
  ADD COLUMN lodging_note VARCHAR(255) NULL;

CREATE TABLE IF NOT EXISTS review_decisions (
  ikey         VARCHAR(160) NOT NULL,
  area         VARCHAR(24)  NOT NULL,
  entity_id    VARCHAR(64)  NULL,
  status       VARCHAR(24)  NOT NULL,
  amount       DECIMAL(14,2) NULL,
  note         VARCHAR(500) NULL,
  fingerprint  VARCHAR(64)  NULL,
  decided_by   VARCHAR(255) NULL,
  decided_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ikey),
  KEY idx_review_decisions_entity (entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crew_pay_approvals (
  installment_id INT NOT NULL,
  decision     VARCHAR(16) NOT NULL,
  pay_date     DATE NULL,
  amount       DECIMAL(12,2) NULL,
  note         VARCHAR(500) NULL,
  decided_by   VARCHAR(255) NULL,
  decided_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (installment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS progress_settings (
  entity_id    VARCHAR(64) NOT NULL,
  signoff      TINYINT(1) NULL,
  set_by       VARCHAR(255) NULL,
  set_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS progress_signoffs (
  entity_id    VARCHAR(64) NOT NULL,
  milestone    INT NOT NULL,
  decision     VARCHAR(16) NOT NULL,
  note         VARCHAR(500) NULL,
  numbers      JSON NULL,
  signed_by    VARCHAR(255) NULL,
  signed_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_id, milestone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE receipts
  MODIFY category ENUM('travel','materials','propane_fuel','other','lodging','lifts','rentals') NOT NULL DEFAULT 'other',
  ADD COLUMN source ENUM('receipt','manual','card') NOT NULL DEFAULT 'receipt',
  ADD COLUMN qbo_line_id BIGINT NULL,
  ADD COLUMN matched_how VARCHAR(16) NULL,
  ADD COLUMN matched_at DATETIME NULL,
  ADD KEY idx_receipts_line (qbo_line_id);
