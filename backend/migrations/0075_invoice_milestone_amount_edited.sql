-- Invoice schedules always add up to the estimate (billing/align.py trues the
-- un-overridden rows up). `edited` = 1 marks ANY hand edit (a date, a label);
-- `amount_edited` = 1 marks a hand-set AMOUNT / % — only those rows are held
-- fixed by the true-up, so changing a date never stops the schedule adding up.
-- Backfill: rows whose audit history shows an amount/% edit, plus edited rows
-- with no audit history at all (unknown -> treat as an amount override).

ALTER TABLE project_invoice_milestones ADD COLUMN amount_edited TINYINT(1) NOT NULL DEFAULT 0;

UPDATE project_invoice_milestones m SET m.amount_edited = 1
WHERE m.edited = 1 AND (
  NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.target_type = 'invoice_milestone'
              AND a.target_id = m.id AND a.action = 'billing.milestone_update')
  OR EXISTS (SELECT 1 FROM audit_log a WHERE a.target_type = 'invoice_milestone'
             AND a.target_id = m.id AND a.action = 'billing.milestone_update'
             AND JSON_CONTAINS_PATH(a.detail, 'one', '$.changes.amount', '$.changes.pct'))
);
