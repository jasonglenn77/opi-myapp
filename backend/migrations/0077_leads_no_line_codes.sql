-- 0077 Crew leads are names only: a lead has NO schedule line number.
-- Line numbers (JR1..JR6) are the crew BOSS's code prefix + ordinal and live
-- on the assignment (project_schedule_item_work_crews.slot_code, unchanged).
-- Lead rows (parent_id IS NOT NULL) drop their legacy codes (JR1, GT5, EP0...).
UPDATE work_crews SET code = NULL WHERE parent_id IS NOT NULL AND code IS NOT NULL;

-- Crew bosses DS and RC appear on OPI's Job Schedule but were missing in the
-- app. Placeholder name = the code (Data Review flags "Crew boss name needed").
-- crew_capacity = lines seen on the sheet (one each: DS, RC).
INSERT INTO work_crews (name, code, parent_id, crew_capacity, is_active, sort_order)
SELECT 'DS', 'DS', NULL, 1, 1, COALESCE((SELECT MAX(w.sort_order) FROM work_crews w WHERE w.parent_id IS NULL), 0) + 1
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM work_crews x WHERE x.code = 'DS');

INSERT INTO work_crews (name, code, parent_id, crew_capacity, is_active, sort_order)
SELECT 'RC', 'RC', NULL, 1, 1, COALESCE((SELECT MAX(w.sort_order) FROM work_crews w WHERE w.parent_id IS NULL), 0) + 1
FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM work_crews x WHERE x.code = 'RC');
