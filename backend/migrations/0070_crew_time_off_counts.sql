-- 0070 CREW TIME-OFF AS A COUNT PER COMPANY (Schedules page redesign).
-- OPI cares about how many crews a Crew Boss has out, not which lead. Each
-- row now means: company_id has crew_count crews unavailable for every day of
-- start_date..end_date (inclusive). crew_count NULL = ALL of the company's
-- crews (whole company off). lead_ids is an OPTIONAL JSON array of the
-- specific lead work_crews ids that are out (granular pick; the schedule
-- greys that lead's line when the lead code maps to a line, e.g. JR3).
-- crew_id is kept (NOT NULL) and now always equals company_id.
-- Legacy rows migrate as:
--   company-level row (crew_id = parent)  -> crew_count NULL (whole company)
--   lead-level row (crew_id = child lead) -> crew_count 1, lead_ids [lead]
ALTER TABLE crew_time_off
  ADD COLUMN company_id INT NULL AFTER crew_id,
  ADD COLUMN crew_count INT NULL AFTER company_id,
  ADD COLUMN lead_ids JSON NULL AFTER crew_count,
  ADD COLUMN updated_by_user_id BIGINT UNSIGNED NULL AFTER created_at,
  ADD COLUMN updated_at DATETIME NULL AFTER updated_by_user_id,
  ADD KEY idx_cto_company_start (company_id, start_date);

UPDATE crew_time_off cto
JOIN work_crews wc ON wc.id = cto.crew_id
SET cto.company_id = COALESCE(wc.parent_id, wc.id),
    cto.crew_count = CASE WHEN wc.parent_id IS NULL THEN NULL ELSE 1 END,
    cto.lead_ids   = CASE WHEN wc.parent_id IS NULL THEN NULL ELSE JSON_ARRAY(wc.id) END;

UPDATE crew_time_off SET crew_id = company_id WHERE company_id IS NOT NULL
