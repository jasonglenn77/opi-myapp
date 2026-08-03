-- Batch B (estimate-driven workflow), Slice 1b: work phases.
-- A project groups its estimates into phases (work windows). Estimates that share
-- a window sit in one phase; a change-order added mid-project is a new phase.
-- Shared on-site costs (mobilization / travel / equipment / overage) attach to
-- the phase (Slice 3). Phases are auto-suggested (default Phase 1) and the office
-- confirms or moves estimates — `confirmed=0` means "auto-assigned, review me".

CREATE TABLE IF NOT EXISTS project_phases (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  entity_id   VARCHAR(64)  NOT NULL,              -- project qbo_id
  seq         INT          NOT NULL DEFAULT 1,    -- Phase 1, 2, ...
  name        VARCHAR(120) NULL,                  -- optional custom name
  created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  KEY idx_phase_entity (entity_id)
);

CREATE TABLE IF NOT EXISTS project_estimate_phase (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  entity_id        VARCHAR(64) NOT NULL,          -- project qbo_id
  estimate_qbo_id  VARCHAR(64) NOT NULL,          -- the QBO estimate
  phase_id         INT         NOT NULL,
  confirmed        TINYINT(1)  NOT NULL DEFAULT 0,-- 0 = auto-suggested, needs office review
  created_at       TIMESTAMP   DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_est_phase (entity_id, estimate_qbo_id),
  KEY idx_ep_phase (phase_id)
);
