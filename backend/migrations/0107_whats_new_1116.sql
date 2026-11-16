-- What's new for the 2026-11-16 release (Ashley's feedback: due dates follow
-- the terms, change orders confirmed on Project Setup, B151 refresh on Setup,
-- Assignments page retired, nightly QuickBooks estimate-deletion check),
-- published when the migration runs (the deploy). Staff can edit or unpublish
-- them on Help, Feedback & notes.
INSERT INTO release_notes (title, body, page, tour_key, capability, published_at, created_by)
SELECT * FROM (
  SELECT 'Due dates follow the terms' AS title, 'Change an invoice''s send date and its due date now moves with it: send date plus the job''s net days (net-30 unless the terms say otherwise). The expected paid date moves by the same number of days. Type a different due date in the same edit and yours is kept. Works on Billing & Schedule, Project Setup and Ashley''s Tracker.' AS body, '#/setup' AS page, NULL AS tour_key, 'page.assignment' AS capability, NOW() - INTERVAL 0 SECOND AS published_at, 'release-1116' AS created_by
  UNION ALL SELECT 'Change orders: confirm them on Project Setup', 'When a new estimate is accepted on a job that''s already set up, the job comes back to Project Setup and the box at the top names it (estimate number, amount, status). Mark Invoice schedule reviewed and Billing''s Needs review clears for every estimate on the job. Billing also has a Confirm button on each estimate again, and each estimate shows the date it was accepted in QuickBooks.', '#/setup', '#/setup', 'page.assignment', NOW() - INTERVAL 1 SECOND, 'release-1116'
  UNION ALL SELECT 'Refresh from B151 on Project Setup', 'Project Setup has the same Refresh from B151 button as the Pipeline page. A job just marked 100% Won shows up on To do right away instead of the next morning, and won quotes get linked to their QuickBooks projects. New QuickBooks projects still arrive with the nightly QuickBooks sync.', '#/setup', '#/setup', 'page.assignment', NOW() - INTERVAL 2 SECOND, 'release-1116'
  UNION ALL SELECT 'The Assignments page has moved', 'Set up and update jobs on Project Setup (To do for new and changed jobs, All active for any live job), finish them on Project Closeout, and look up a project''s history on All Projects (its Assignment tab). The old Assignments link now points you to the right page.', '#/setup', NULL, 'page.assignment', NOW() - INTERVAL 3 SECOND, 'release-1116'
  UNION ALL SELECT 'Estimates deleted in QuickBooks leave the app', 'Every night the app now checks for estimates that were deleted in QuickBooks and removes them, so Billing, Project Setup and the cash forecast don''t show an estimate QuickBooks no longer has.', '#/cashflow', NULL, 'page.assignment', NOW() - INTERVAL 4 SECOND, 'release-1116'
) d
WHERE NOT EXISTS (SELECT 1 FROM release_notes WHERE created_by = 'release-1116');
