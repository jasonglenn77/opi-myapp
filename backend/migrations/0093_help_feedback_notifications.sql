-- Help, tours, feedback, what's new, and in-app notifications.

-- Which guided tours each person has finished or skipped (so a page only offers
-- its tour once, and "Tour this page" can say "seen").
CREATE TABLE IF NOT EXISTS help_tour_progress (
  user_id   INT          NOT NULL,
  tour_key  VARCHAR(60)  NOT NULL,
  status    VARCHAR(16)  NOT NULL,              -- done | skipped
  at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, tour_key)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bug reports, ideas and questions sent from any page.
CREATE TABLE IF NOT EXISTS feedback (
  id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id      INT          NULL,
  user_email   VARCHAR(255) NULL,
  kind         VARCHAR(16)  NOT NULL,           -- bug | idea | question
  message      TEXT         NOT NULL,
  page         VARCHAR(255) NULL,               -- the hash route it was sent from
  page_title   VARCHAR(255) NULL,
  browser      VARCHAR(500) NULL,
  viewport     VARCHAR(40)  NULL,
  status       VARCHAR(16)  NOT NULL DEFAULT 'new',  -- new | in_progress | answered | closed
  staff_note   TEXT         NULL,               -- internal, never shown to the sender
  reply        TEXT         NULL,
  replied_at   DATETIME     NULL,
  replied_by   VARCHAR(255) NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_feedback_status (status, created_at),
  KEY ix_feedback_user (user_id)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- "What's new" notes, written by staff and shown once to the people they're for.
CREATE TABLE IF NOT EXISTS release_notes (
  id            INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title         VARCHAR(200) NOT NULL,
  body          TEXT         NOT NULL,
  page          VARCHAR(120) NULL,              -- "#/setup": Show me opens it
  tour_key      VARCHAR(60)  NULL,              -- and starts this tour
  capability    VARCHAR(60)  NULL,              -- only people with this capability see it
  published_at  DATETIME     NULL,              -- NULL = draft
  created_by    VARCHAR(255) NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS release_note_seen (
  user_id  INT          NOT NULL,
  note_id  INT          NOT NULL,
  action   VARCHAR(16)  NOT NULL,               -- seen | skipped | later
  at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, note_id)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- In-app notifications (the bell): feedback replies, change alerts to PMs and
-- owners, offers, and anything else that needs a person's attention. Email is
-- sent alongside when the mail server is configured (mailer.py).
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     INT          NOT NULL,
  kind        VARCHAR(40)  NOT NULL,            -- feedback.reply | change.dates | change.crew | ...
  title       VARCHAR(255) NOT NULL,
  body        TEXT         NULL,
  link        VARCHAR(255) NULL,                -- hash route to open
  subject     VARCHAR(60)  NULL,                -- e.g. project qbo id, for grouping
  dedupe_key  VARCHAR(160) NULL,                -- same key + user = not repeated
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at     DATETIME     NULL,
  emailed_at  DATETIME     NULL,
  KEY ix_notif_user (user_id, read_at, created_at),
  UNIQUE KEY ux_notif_dedupe (user_id, dedupe_key)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What each person wants to be told about, and how. Missing row = defaults.
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id   INT          NOT NULL,
  kind      VARCHAR(40)  NOT NULL,              -- a notification kind, or '*' for all
  in_app    TINYINT(1)   NOT NULL DEFAULT 1,
  email     TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, kind)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
