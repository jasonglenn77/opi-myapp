-- 0048 Audit trail for user / role / permission administration (#5 security).
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_user_id BIGINT UNSIGNED NULL,           -- who did it
  actor_email   VARCHAR(255) NULL,
  action        VARCHAR(48) NOT NULL,           -- user.create | user.update | user.disable | user.invite | perms.update | role.create | role.update | role.delete
  target_type   VARCHAR(32) NULL,               -- 'user' | 'role'
  target_id     VARCHAR(64) NULL,
  target_label  VARCHAR(255) NULL,              -- e.g. the affected user's email or the role name
  detail        JSON NULL,                      -- changed fields / extra context
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_created (created_at),
  KEY idx_target (target_type, target_id)
) ENGINE=InnoDB;
