-- 0057 Retire the global crew-boss MASTER code (Crew Model v2 CR2, Jason
-- decision c). Boss access is now a per-COMPANY passcode row pointing at the
-- PARENT crew (crew_id = company id, role 'boss') — crew_scope_clause already
-- scopes those to the company's projects. A crew_id-NULL row therefore no
-- longer means anything: /crew-auth/login stops accepting NULL-crew rows in
-- code, and this migration deactivates any that exist so their outstanding
-- 30-day device tokens die too (_crew_actor re-checks `active` per request).
-- Idempotent by construction (UPDATE with a WHERE on the state it changes).
UPDATE crew_passcodes SET active = 0 WHERE crew_id IS NULL AND active = 1;
