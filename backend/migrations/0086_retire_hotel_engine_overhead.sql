-- 0086: Lodging is counted once, from the jobs.
-- Hotel Engine is OPI's lodging vendor: one monthly statement, split by the
-- bookkeeper across the jobs the crews stayed on (98-100% split to jobs since
-- July 2026). The B250-copied "Hotel Engine" overhead line ($150,000 a month,
-- migration 0080) paid for the same hotel nights as the lodging planned on each
-- job, so the forecast counted lodging twice. Owner decision 2026-10-28: keep
-- the job-based lodging (estimate lines placed on Hotel Engine's billing
-- calendar) and retire the overhead line. Soft delete: restorable from the
-- Overhead editor's deleted list; logged in the line's history.

INSERT INTO cashflow_overhead_history
  (overhead_id, action, actor, item_name, old_amount, new_amount, old_cadence, new_cadence, old_anchor_date, new_anchor_date)
SELECT id, 'delete', 'Lodging counted from jobs (migration 0086)', name, amount, NULL, cadence, NULL, anchor_date, NULL
FROM cashflow_overhead
WHERE name = 'Hotel Engine' AND deleted_at IS NULL;

UPDATE cashflow_overhead
SET source_note = 'Retired 2026-10-28: lodging is planned on each job instead (Hotel Engine bills are split to jobs), so this line double-counted it.',
    deleted_at = NOW()
WHERE name = 'Hotel Engine' AND deleted_at IS NULL;
