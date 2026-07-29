-- Ownership + join docs model: restore estimate-stage documents (folders 1–5)
-- that a prior "move on link" copied onto the project back to their owning
-- opportunity. Going forward docs are never moved — the project merges the
-- linked opportunity's folders at read time.
--
-- Only estimate-stage folders on a project that HAS a linked opportunity are
-- moved back (a project with no linked opportunity keeps directly-uploaded
-- estimate docs — the backfill case). The S3 key is unchanged (it already
-- reflects the original upload path), so this is a pure DB ownership fix.

UPDATE documents d
  JOIN opportunities o ON o.project_qbo_id = d.entity_id
   SET d.entity_type = 'opportunity',
       d.entity_id   = CAST(o.id AS CHAR)
 WHERE d.entity_type = 'project'
   AND d.folder IN ('1_request_for_quote', '2_drawings_calcs',
                    '3_bill_of_materials', '4_quotes', '5_purchase_orders');
