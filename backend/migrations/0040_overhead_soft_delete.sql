-- Soft-delete for overhead items so a deleted row can be seen and restored.
-- Deleting now stamps deleted_at (and logs history) instead of removing the row;
-- the item drops out of the forecast and the main list, but shows in a "Deleted
-- items" section with a Restore button.

ALTER TABLE cashflow_overhead
  ADD COLUMN deleted_at DATETIME NULL AFTER edited;
