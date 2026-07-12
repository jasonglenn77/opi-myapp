-- Slice 2: revision analytics. The existing estimate_revisions snapshot mechanism
-- captured numbers but not WHY a revision happened. Add the metadata that powers
-- "which customers/contacts request revisions, how many, and why" analytics.
-- (saved_by_user_id already exists on the table but was never populated — the
--  POST /revisions endpoint now sets it too.)
ALTER TABLE estimate_revisions
  ADD COLUMN reason       VARCHAR(120)  NULL AFTER revision_number,
  ADD COLUMN note         VARCHAR(1000) NULL AFTER reason,
  ADD COLUMN total_amount DECIMAL(14,2) NULL AFTER note;
