-- What's new for the 2026-11-22 release: Closeout Still planned card, crew
-- payments follow the estimate's paid crew.
INSERT INTO release_notes (title, body, page, tour_key, capability, published_at, created_by)
SELECT * FROM (
  SELECT 'Closeout: Still planned' AS title, 'Each finished job on Project Closeout shows what its invoice, crew payment and expense schedules still plan to bill or pay, with past dates flagged. Cash Flow counts it until the job is closed out. Open a schedule right there to re-date or clear stale rows before closing out.' AS body, '#/closeout' AS page, NULL AS tour_key, 'page.assignment' AS capability, NOW() AS published_at, 'release-1122' AS created_by
  UNION ALL SELECT 'Crew payments follow the paid crew', 'A job''s crew payments now always follow the estimate''s crew company, so the crew QuickBooks paid is the one shown. 33 schedules on 25 jobs that still named an old crew were lined up by who was actually paid. Crew payment totals add up the payment rows.', '#/setup', NULL, 'page.assignment', NOW() - INTERVAL 1 SECOND, 'release-1122'
) d
WHERE NOT EXISTS (SELECT 1 FROM release_notes WHERE created_by = 'release-1122');
