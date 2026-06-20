-- Roles & their default capabilities, so admins can manage them from the
-- Settings page instead of editing code. Seeded lazily from the code defaults
-- (permissions.FALLBACK_ROLE_DEFAULTS) on first use. The admin role's caps are
-- always forced to "all" in code regardless of these rows.

CREATE TABLE IF NOT EXISTS roles (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(40)  NOT NULL UNIQUE,        -- the key stored on users.role
  label       VARCHAR(100) NULL,                   -- friendly display name
  description VARCHAR(255) NULL,
  is_system   TINYINT(1)   NOT NULL DEFAULT 0,     -- built-in: cannot be deleted
  created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS role_capabilities (
  role_id    INT         NOT NULL,
  capability VARCHAR(64) NOT NULL,
  PRIMARY KEY (role_id, capability),
  CONSTRAINT fk_role_caps_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);
