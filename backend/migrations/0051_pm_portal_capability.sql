-- Migration 0051: PM Portal page capability (page.pm_portal)
--
-- The capability itself is code-defined (permissions.PAGE_PM_PORTAL); role
-- defaults in code only seed EMPTY roles tables, so existing databases need
-- the grant inserted here. Granted to:
--   * admin — forced to ALL capabilities in code anyway (row kept for parity
--             with the Settings page's role editor), and
--   * pm    — project managers, the portal's audience.
INSERT IGNORE INTO role_capabilities (role_id, capability)
SELECT id, 'page.pm_portal' FROM roles WHERE name IN ('admin', 'pm');
