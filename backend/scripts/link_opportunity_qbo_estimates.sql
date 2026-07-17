UPDATE opportunities o
JOIN (
  SELECT x.opp_id, x.est_qbo_id FROM (
    SELECT o2.id AS opp_id, t.qbo_id AS est_qbo_id,
           ROW_NUMBER() OVER (PARTITION BY o2.id ORDER BY t.txn_date DESC, t.id DESC) AS rn
    FROM opportunities o2
    JOIN qbo_transactions t
      ON t.doc_number = o2.quote_number COLLATE utf8mb4_0900_ai_ci
     AND t.entity_type='Estimate'
    JOIN qbo_customers qc ON qc.qbo_id = t.customer_qbo_id AND COALESCE(qc.is_project,0)=0
    WHERE o2.quote_number IS NOT NULL AND o2.quote_number<>'' AND o2.qbo_estimate_id IS NULL
  ) x WHERE x.rn = 1
) m ON m.opp_id = o.id
SET o.qbo_estimate_id = m.est_qbo_id;
