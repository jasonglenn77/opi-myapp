-- Revisions as sibling quoting-metrics under an opportunity (estimator feedback).
-- Instead of revising in place, the estimator DUPLICATES the current quoting-metrics
-- into a new estimate row with the SAME quote number and revision_no + 1; the newest
-- revision drives the pipeline row; older ones are locked (read-only) until unlocked.
--   opportunity_id — which pipeline opportunity this quote belongs to
--   revision_no    — 1, 2, 3 … within that opportunity's quote number
--   locked         — 1 = read-only (a superseded revision)
-- (Distinct from the existing `revision_count`, which counts Save-Revision snapshots
--  WITHIN a single estimate — a different feature.)
ALTER TABLE estimates
  ADD COLUMN opportunity_id INT UNSIGNED NULL       AFTER id,
  ADD COLUMN revision_no    INT NOT NULL DEFAULT 1   AFTER quote_number,
  ADD COLUMN locked         TINYINT(1) NOT NULL DEFAULT 0 AFTER status,
  ADD KEY idx_estimates_opportunity (opportunity_id);

-- Backfill: estimates already attached to an opportunity become its revision 1.
UPDATE estimates e
JOIN opportunities o ON o.app_estimate_id = e.id
SET e.opportunity_id = o.id, e.revision_no = 1;
