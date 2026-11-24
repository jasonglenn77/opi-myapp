-- 2026-11-22 (Leo, PM feedback): a contact directory for PMs. Crew bosses and
-- leads get a phone and email (work_crews rows: a company row is the boss, a
-- child row is a lead), so the PM Portal's Contacts tab lists the job's crews
-- next to the customer's and the site's contacts.
ALTER TABLE work_crews ADD COLUMN phone VARCHAR(64) NULL, ADD COLUMN email VARCHAR(255) NULL;
