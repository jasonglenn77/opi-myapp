-- 0047 One-time tokens for user invites and password resets (#5 user management).
-- The raw token is emailed in a link; only its SHA-256 hash is stored here.
CREATE TABLE IF NOT EXISTS user_auth_tokens (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,          -- matches users.id (BIGINT UNSIGNED)
  token_hash  CHAR(64) NOT NULL,                 -- sha256 hex of the raw token
  purpose     VARCHAR(16) NOT NULL,              -- 'invite' | 'reset'
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_token_hash (token_hash),
  KEY idx_user_purpose (user_id, purpose)
) ENGINE=InnoDB;
