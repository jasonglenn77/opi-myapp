-- 0063 CREW TIME-OFF (OPI feedback 2026-10-07 #3).
-- Date ranges a crew is off (vacation etc.). crew_id points at either a
-- COMPANY (parent work_crews row — the whole company is off: contributes 0
-- availability for the overlap) or a LEAD (child row — minus 1 crew for the
-- overlap). Managed from Teams -> Work Crews ("Time off…") and the Schedule
-- page quick-add; rendered on Schedule (grey Unavailable row), browse-crews
-- availability, and as a non-blocking warning in the assignment editors.
-- Hard delete (every add/remove is audited: crew.time_off_add / _remove).
CREATE TABLE IF NOT EXISTS crew_time_off (
  id                  INT NOT NULL AUTO_INCREMENT,
  crew_id             INT NOT NULL,            -- work_crews.id (company parent OR lead child)
  start_date          DATE NOT NULL,
  end_date            DATE NOT NULL,           -- inclusive; >= start_date (enforced in API)
  reason              VARCHAR(160) NULL,
  created_by_user_id  BIGINT UNSIGNED NULL,    -- matches users.id; no FK on purpose
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cto_crew_start (crew_id, start_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
