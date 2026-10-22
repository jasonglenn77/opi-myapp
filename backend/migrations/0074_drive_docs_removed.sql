-- 0074 Google Drive documents sync: files removed in Drive (app/gsync/docs_sync.py).
-- A Drive file that was copied into the app and later trashed, deleted or
-- moved out of the Customers folder is NOT deleted from the app. The sync
-- stamps drive_removed_at (first time it noticed) and drive_removed_reason
-- (trashed, deleted, moved_out, folder_removed, missing) so the documents
-- list can show "Removed from Google Drive on <date>" and Data Review can
-- ask staff to confirm. Both are cleared if the file comes back (restored
-- from the Drive trash). A file moved to another folder is re-filed instead.
ALTER TABLE documents
  ADD COLUMN drive_removed_at DATETIME NULL,
  ADD COLUMN drive_removed_reason VARCHAR(16) NULL,
  ADD KEY idx_documents_drive_removed (drive_removed_at);
