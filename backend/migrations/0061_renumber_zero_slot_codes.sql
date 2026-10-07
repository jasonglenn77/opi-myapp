-- 0061 Renumber legacy "<prefix>0" slot codes (OPI staff request: identifiers
-- should run EP1, EP2, EP3... with no 0 after the initials).
-- The 0-codes are backfill artifacts from the old crew-code system (the CR1
-- backfill copied each crew's legacy code, and several companies' first lead
-- was coded X0). The auto-suggester already starts at 1; this pass renumbers
-- the ACTIVE assignment rows still carrying a 0-code to the lowest free
-- ordinal within their project, per company prefix. Idempotent: re-running
-- finds no 0-codes left.
UPDATE project_schedule_item_work_crews swc
JOIN project_schedule_items psi ON psi.id = swc.schedule_item_id
JOIN (
  -- lowest free ordinal per (project, prefix): try 1..9 and pick the first
  -- not already used by an ACTIVE row of the same project+prefix
  SELECT z.id AS row_id,
         CONCAT(z.prefix, (
           SELECT MIN(n.n) FROM (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
                                 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7
                                 UNION SELECT 8 UNION SELECT 9) n
           WHERE CONCAT(z.prefix, n.n) NOT IN (
             SELECT s2.slot_code FROM project_schedule_item_work_crews s2
             JOIN project_schedule_items p2 ON p2.id = s2.schedule_item_id
             WHERE p2.project_id = z.project_id AND s2.unassigned_at IS NULL
               AND s2.slot_code IS NOT NULL AND s2.id <> z.id
           )
         )) AS new_code
  FROM (
    SELECT swc1.id, psi1.project_id,
           SUBSTRING(swc1.slot_code, 1, CHAR_LENGTH(swc1.slot_code) - 1) AS prefix
    FROM project_schedule_item_work_crews swc1
    JOIN project_schedule_items psi1 ON psi1.id = swc1.schedule_item_id
    WHERE swc1.unassigned_at IS NULL AND swc1.slot_code REGEXP '^[A-Za-z]+0$'
  ) z
) fix ON fix.row_id = swc.id
SET swc.slot_code = fix.new_code;
