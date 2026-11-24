-- What's new for the 2026-11-23 release: crew paid vs the app vs the Job
-- Schedule, PM Portal Contacts tab, day count, drawing colors, Daily Log retired.
INSERT INTO release_notes (title, body, page, tour_key, capability, published_at, created_by)
SELECT * FROM (
  SELECT 'Crew paid differs' AS title, 'When QuickBooks paid a crew company that the app does not have as the job''s paid crew, or that the Job Schedule sheet does not show on the job, the job is flagged on Project Setup (live jobs) and Project Closeout (finished jobs), the Crew payments section says which crews differ, and the bell tells you once per change.' AS body, '#/setup' AS page, NULL AS tour_key, 'page.assignment' AS capability, NOW() AS published_at, 'release-1123' AS created_by
  UNION ALL SELECT 'PM Portal: Contacts tab', 'Each job in the PM Portal has a Contacts tab: the site contacts for the job, the customer''s contacts and the crew bosses and leads on the job, with tap to call and email. Add a site contact, fix a phone or email, or copy all the customer emails at once.', '#/pm', NULL, 'page.pm_portal', NOW() - INTERVAL 1 SECOND, 'release-1123'
  UNION ALL SELECT 'PM Portal: day count and drawing colors', 'The Overview shows how many days the job runs and which day today is. Drawing markup colors now match OPI''s install stages: yellow standing, blue structurally complete, green 100% complete, red red flag. The Daily Log page is gone.', '#/pm', NULL, 'page.pm_portal', NOW() - INTERVAL 2 SECOND, 'release-1123'
) d
WHERE NOT EXISTS (SELECT 1 FROM release_notes WHERE created_by = 'release-1123');
