-- 0049 Freeze reference data per estimate (#2 from OPI pipeline feedback).
-- Each estimate carries its own copy of the lookup values + productivity/rental
-- rates captured at Start quote (reference_snapshot) and of the contact as of
-- Save & Send (contact_snapshot), so a later revision prices exactly like the
-- original send even if the live tables changed in between.
-- Legacy estimates (NULL) are lazily frozen at current live values on first read.
ALTER TABLE estimates
  ADD COLUMN reference_snapshot JSON NULL,
  ADD COLUMN contact_snapshot JSON NULL,
  ADD COLUMN snapshot_at DATETIME NULL;
