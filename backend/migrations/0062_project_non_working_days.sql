-- 0062 PROJECT NON-WORKING DAYS (OPI feedback 2026-10-07 #2).
-- Per-assignment-line non-working config on project_schedule_items:
--   non_working JSON NULL, shape:
--     {"weekends_off": bool, "dates": ["YYYY-MM-DD", ...]}
--   * weekends_off  -> Sat/Sun inside start..true-end are not worked
--   * dates         -> specific no-work days (may lie outside the window;
--                      harmless there — render/calculators just ignore them)
--   * NULL          -> no non-working days (today's behavior, the default)
-- Written only through the normal save path (projects/service.py
-- save_schedule_item), validated + normalized server-side (ISO dates,
-- capped at 120 entries), history-tracked via ITEM_FIELDS.
ALTER TABLE project_schedule_items
  ADD COLUMN non_working JSON NULL;
