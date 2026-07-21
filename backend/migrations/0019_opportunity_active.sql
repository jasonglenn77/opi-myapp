-- Opportunities are archived, not deleted. Estimators asked for a "mark inactive"
-- action instead of Delete so nothing is lost: inactive rows drop out of the
-- default pipeline view but stay reviewable behind a filter (same pattern as the
-- Contacts page's Deactivate-vs-Delete).
ALTER TABLE opportunities
  ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 1 AFTER status;
