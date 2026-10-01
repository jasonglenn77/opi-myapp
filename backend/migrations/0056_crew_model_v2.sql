-- 0056 Crew Model v2 + assignment history (CR1 of the crew-model rework,
-- plan: CREW MODEL V2 + ASSIGNMENT HISTORY 2026-09-24).
--
-- MODEL: work_crews parents = COMPANIES (boss_name + crew_capacity + the
-- existing vendor_qbo_id); children = CREW LEADS (identity only — the child
-- `code` column is deprecated, the slot code moves to the assignment row).
-- Assignment rows gain company_id (who's awarded/paid), lead_crew_id
-- (nullable — boss/PM sets later) and slot_code (per-project ordinal like
-- JR1 = "MTY's 1st crew on THIS project"). Legacy work_crew_id is kept and
-- dual-written until CR3 flips the readers.
--
-- Backfills are guarded with IS NULL / NOT EXISTS so re-running the DML on a
-- half-applied database is safe (the ALTERs run once via schema_migrations;
-- MySQL 8.0 has no ADD COLUMN IF NOT EXISTS).

-- ── work_crews: company fields ──────────────────────────────────────────────
ALTER TABLE work_crews
  ADD COLUMN boss_name VARCHAR(120) NULL AFTER name,
  ADD COLUMN crew_capacity INT NULL AFTER boss_name;

-- Parents: capacity defaults to the count of active children (Jason-approved
-- recommendation). Children stay NULL. Only fills rows still NULL.
UPDATE work_crews p
LEFT JOIN (
  SELECT parent_id, COUNT(*) AS n
  FROM work_crews
  WHERE parent_id IS NOT NULL AND is_active = 1
  GROUP BY parent_id
) kids ON kids.parent_id = p.id
SET p.crew_capacity = COALESCE(kids.n, 0)
WHERE p.parent_id IS NULL AND p.crew_capacity IS NULL;

-- ── assignment rows: company / lead / slot ──────────────────────────────────
ALTER TABLE project_schedule_item_work_crews
  ADD COLUMN company_id INT NULL AFTER work_crew_id,
  ADD COLUMN lead_crew_id INT NULL AFTER company_id,
  ADD COLUMN slot_code VARCHAR(12) NULL AFTER lead_crew_id,
  ADD KEY idx_psiwc_company (company_id),
  ADD KEY idx_psiwc_lead (lead_crew_id);

-- Backfill from the legacy work_crew_id: child crew -> company = its parent,
-- lead = the child itself, slot = the child's legacy code (JR1...); parent
-- crew assigned directly -> company = itself, lead-less, no slot.
UPDATE project_schedule_item_work_crews swc
JOIN work_crews wc ON wc.id = swc.work_crew_id
SET swc.company_id   = COALESCE(wc.parent_id, wc.id),
    swc.lead_crew_id = CASE WHEN wc.parent_id IS NOT NULL THEN wc.id ELSE NULL END,
    swc.slot_code    = CASE WHEN wc.parent_id IS NOT NULL THEN wc.code ELSE NULL END
WHERE swc.company_id IS NULL;

-- project_work_crews: LEGACY project-level assignment table (superseded by
-- the per-schedule-item table; no code writes it since 2026-04, only main.py
-- still reads it for a primary_crew_name display column). Same columns +
-- backfill for consistency so no reader ever sees a half-migrated model.
ALTER TABLE project_work_crews
  ADD COLUMN company_id INT NULL AFTER work_crew_id,
  ADD COLUMN lead_crew_id INT NULL AFTER company_id,
  ADD COLUMN slot_code VARCHAR(12) NULL AFTER lead_crew_id;

UPDATE project_work_crews pwc
JOIN work_crews wc ON wc.id = pwc.work_crew_id
SET pwc.company_id   = COALESCE(wc.parent_id, wc.id),
    pwc.lead_crew_id = CASE WHEN wc.parent_id IS NOT NULL THEN wc.id ELSE NULL END,
    pwc.slot_code    = CASE WHEN wc.parent_id IS NOT NULL THEN wc.code ELSE NULL END
WHERE pwc.company_id IS NULL;

-- ── assignment-line history ─────────────────────────────────────────────────
-- One row per create/update/delete of a schedule item (the "assignment line").
-- changes JSON = {field: [old, new]} (diff_fields convention from app/audit.py),
-- crews/PMs recorded as readable labels ("MTY · Gustavo Ramirez (JR1)").
-- NO foreign key to project_schedule_items: history must survive deletion.
-- changed_by_user_id NULL = "(before tracking)" backfill or a system write.
CREATE TABLE IF NOT EXISTS project_schedule_item_history (
  id                  INT NOT NULL AUTO_INCREMENT,
  schedule_item_id    INT NOT NULL,
  action              ENUM('created','updated','deleted') NOT NULL,
  changed_by_user_id  BIGINT UNSIGNED NULL,  -- matches users.id; no FK on purpose
  changed_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  changes             JSON NULL,
  PRIMARY KEY (id),
  KEY idx_psih_item_time (schedule_item_id, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Backfill: one 'created' row per existing schedule item, timestamped with the
-- item's created_at (column is NOT NULL DEFAULT CURRENT_TIMESTAMP, so every
-- row has one). changed_by NULL renders as "(before tracking)" in CR4's UI.
INSERT INTO project_schedule_item_history
  (schedule_item_id, action, changed_by_user_id, changed_at, changes)
SELECT psi.id, 'created', NULL, psi.created_at, NULL
FROM project_schedule_items psi
WHERE NOT EXISTS (
  SELECT 1 FROM project_schedule_item_history h
  WHERE h.schedule_item_id = psi.id AND h.action = 'created'
);
