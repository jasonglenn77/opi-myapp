-- What's new for the 2026-11-24 release: Project Setup job history, PO matching
-- and hand ties, availability per date range, crew company per estimate, crew
-- payments roll-up.
INSERT INTO release_notes (title, body, page, tour_key, capability, published_at, created_by)
SELECT * FROM (
  SELECT 'Job history' AS title, 'On Project Setup, the Job history button lines up the job''s estimates and POs with the Job Schedule sheet: which estimates fall in each phase, the crew-days they need vs the days the sheet shows, the crew pay worked out payday by payday next to the crew schedule and what QuickBooks paid, and each estimate''s invoices vs its invoice schedule. It only reads, nothing is changed.' AS body, '#/setup' AS page, NULL AS tour_key, 'page.assignment' AS capability, NOW() AS published_at, 'release-1124' AS created_by
  UNION ALL SELECT 'POs matched to estimates', 'The Purchase order step lists every PO file with its PO number, total and the estimate it covers. The app reads the PO number and estimate numbers from the PDF and matches on total. When it picks the wrong one, use Tie to PO on the estimate to set it by hand.', '#/setup', NULL, 'page.assignment', NOW() - INTERVAL 1 SECOND, 'release-1124'
  UNION ALL SELECT 'Availability per date range', 'PM and crew availability can be checked for each of the job''s date ranges or the whole job. It starts on the next range that isn''t finished, and a job no longer shows its own crew as booked.', '#/setup', NULL, 'page.assignment', NOW() - INTERVAL 2 SECOND, 'release-1124'
  UNION ALL SELECT 'Crew payments roll-up', 'Crew payments show paid, scheduled and rows with no date yet against the contract labor, per estimate: whether each estimate''s schedule balances or is covered by another estimate''s schedule. Schedules on estimates no longer in QuickBooks are flagged and left out of the crew check.', '#/setup', NULL, 'page.assignment', NOW() - INTERVAL 3 SECOND, 'release-1124'
) d
WHERE NOT EXISTS (SELECT 1 FROM release_notes WHERE created_by = 'release-1124');
