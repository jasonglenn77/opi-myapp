-- 0071 Job Schedule import: keep the description cell's FONT colour too.
-- OPI types overage days (work past the quoted end, the green "end of job"
-- cell) in orange text, so the importer (app/gsync/schedule_import.py) needs
-- it to split end_date / overage_days.
ALTER TABLE gsync_schedule_days
  ADD COLUMN desc_font VARCHAR(16) NULL AFTER desc_fill;
