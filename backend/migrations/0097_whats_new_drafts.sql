-- Draft "What's new" notes for the November 2026 release. They are DRAFTS
-- (published_at NULL): nothing pops up until staff publish them on
-- Help -> Feedback & notes (#/help-admin).
INSERT INTO release_notes (title, body, page, tour_key, capability, published_at, created_by)
SELECT * FROM (
  SELECT 'Help, tours and feedback' AS title,
         'The ? button at the top right of every page: take a tour of the page, have any control explained, or send a bug, idea or question. Replies come back in the bell.' AS body,
         NULL AS page, 'app' AS tour_key, NULL AS capability, NULL AS published_at, 'release-draft' AS created_by
  UNION ALL SELECT 'New: Project Closeout',
         'Every finished job that is not closed yet: final invoice, getting paid, paying the crew in full, bills, change orders and the completion paperwork. Most steps tick themselves from QuickBooks and Drive.',
         '#/closeout', '#/closeout', 'page.assignment', NULL, 'release-draft'
  UNION ALL SELECT 'New: Issues',
         'Every problem the app finds, from every page, in one list: invoices, change orders, crew pay, expenses by category, progress, schedules and data.',
         '#/issues', '#/issues', 'page.customers', NULL, 'release-draft'
  UNION ALL SELECT 'New: Invoice & Pay Dates',
         'Every invoice to send, payment to collect, crew payment and planned expense across all projects, by week. Change a date here and the project schedule changes with it, and the PM is told.',
         '#/pay-dates', '#/pay-dates', 'page.cashflow', NULL, 'release-draft'
  UNION ALL SELECT 'New: Cash Plan',
         'The owners view of cash: the forecast plus won jobs not scheduled yet, the weighted pipeline, payroll and bi-weekly crew paydays, with a printable owner report.',
         '#/cashflow-plan', '#/cashflow-plan', 'page.cashflow', NULL, 'release-draft'
  UNION ALL SELECT 'New: Margins by PM & Month',
         'Finished jobs by the month they finished and their PM: revenue, cost, profit and margin. Click any number to see the jobs and export them to Excel.',
         '#/margins', NULL, 'page.financials', NULL, 'release-draft'
  UNION ALL SELECT 'Change alerts in the bell',
         'PMs now hear when their project dates, crew, invoice or crew-pay schedule change, or a customer answers a change order. Owners can switch on alerts for every project in the bell settings.',
         NULL, NULL, NULL, NULL, 'release-draft'
) d
WHERE NOT EXISTS (SELECT 1 FROM release_notes WHERE created_by = 'release-draft');
