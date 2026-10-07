-- 0059: Multi-crew payment split (Jason item #3, design approved 2026-10-06).
--
-- An estimate's crew payments can OPT IN to being split across 2+ crew
-- COMPANIES (parent work_crews rows). ONE payment schedule (same dates);
-- each installment's amount is split per the allocation percentages.
--
-- Semantics:
--   * zero rows for an (entity, estimate)  = single-crew mode — today's
--     behavior exactly; the billing header's crew_id governs the rollup.
--   * 2+ rows (pcts sum to 100 ±0.1, server-validated) = split mode — the
--     schedule's installments stay one row per date at the full amount, and
--     the compose layer carries per-company shares (last allocation absorbs
--     rounding). Setting a split also points the header crew_id at the FIRST
--     allocation's company so legacy readers keep working.
--
-- company_crew_id is always a PARENT work_crews id (a company, CR Model v2).

CREATE TABLE IF NOT EXISTS project_estimate_crew_allocations (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  entity_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  estimate_qbo_id VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  company_crew_id INT NOT NULL,
  pct DECIMAL(5,2) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_peca_est_company (entity_id, estimate_qbo_id, company_crew_id),
  KEY idx_peca_entity (entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
