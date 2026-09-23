-- 0054 Milestone C2: four more crew form templates + report_date on
-- submissions (PM Portal Design v3, C2 rework).
--
-- 1) form_templates: seed truck_unloading / truck_loading /
--    wire_guidance_trailer / gear_request — labels VERBATIM from the OPI APP
--    Project Management doc, same definition-JSON vocabulary as 0052
--    (yes_no + branches for every If YES / If NO, photos/video/media for
--    uploads, number for counts, red_flag_on where the doc implies
--    escalation: truck damage YES, BOL not-all-received NO (= shortage),
--    extra materials YES, trailer repairs YES). These four are EVENT-DRIVEN:
--    their serve-time defaults (forms/status.py) are required=false +
--    cadence "as_needed" (never due/overdue; UI shows "N submitted").
--    Receipt Upload stays out on purpose — Milestone D's Receipts tab owns it.
--
-- 2) form_submissions.report_date: the calendar day a submission is FOR.
--    Daily-type forms can be backfilled for a missed day (crew picks the
--    date); the status engine keys on report_date and falls back to
--    DATE(submitted_at). Existing rows are backfilled to DATE(submitted_at).
--
-- 3) project_form_settings.forms map (0053) gains per-form OPTIONAL keys,
--    applied at serve time (no schema change needed for a JSON column):
--      exclude_weekdays: [ints 0=Mon..6=Sun, Python date.weekday() numbering]
--                        — recurring forms are never expected on these days
--                        (e.g. [5,6] for a 5-day crew).
--      skipped_dates:    ["YYYY-MM-DD", ...] — PM-excused specific days,
--                        never expected/overdue.
--      removed_questions:[question keys] — standard questions hidden from
--                        this project's crew (red_flag_on carriers refused).

INSERT IGNORE INTO form_templates (code, title, definition, sort_order)
VALUES ('truck_unloading', 'Truck Unloading Form', '{"sections": [{"key": "truck_materials","title": "Materials on Truck","toggle": "always","questions": [{"key": "truck_materials_photos","label": "Upload Photos of materials on truck prior to unloading","type": "photos","multiple": true}]},{"key": "bol_photos","title": "BOL Photos","toggle": "always","questions": [{"key": "bol_photos","label": "Upload Photos of BOL (all pages)","type": "photos","multiple": true}]},{"key": "damaged","title": "Damaged Materials","toggle": "always","questions": [{"key": "damaged_materials","label": "Did any materials/hardware arrive damaged?","type": "yes_no","red_flag_on": "yes","branches": {"yes": [{"key": "damaged_item_desc","label": "Provide item description","type": "text"},{"key": "damaged_photos","label": "Photos","type": "photos","multiple": true},{"key": "damaged_counts","label": "Counts","type": "number"}],"no": []}}]},{"key": "bol_received","title": "BOL Received","toggle": "always","questions": [{"key": "bol_all_received","label": "Do you confirm that all materials/hardware on the BOL has been received?","type": "yes_no","red_flag_on": "no","branches": {"yes": [],"no": [{"key": "bol_short_items","label": "What item was short/missing?","type": "text"},{"key": "bol_short_counts","label": "Provide counts of what is missing","type": "number"}]}}]},{"key": "not_on_bol","title": "Not on the BOL","toggle": "always","questions": [{"key": "extra_materials","label": "Was anything received that is not on the BOL?","type": "yes_no","red_flag_on": "yes","branches": {"yes": [{"key": "extra_item_desc","label": "Provide item description","type": "text"},{"key": "extra_photos","label": "Photos","type": "photos","multiple": true},{"key": "extra_counts","label": "Counts","type": "number"}],"no": []}}]}]}', 40);

INSERT IGNORE INTO form_templates (code, title, definition, sort_order)
VALUES ('truck_loading', 'Truck Loading Form', '{"sections": [{"key": "loaded_materials","title": "Materials Loaded","toggle": "always","questions": [{"key": "loaded_photos","label": "Upload Photos of materials loaded on truck","type": "photos","multiple": true},{"key": "loaded_desc","label": "Provide a Description of materials & counts on truck","type": "text"}]}]}', 50);

INSERT IGNORE INTO form_templates (code, title, definition, sort_order)
VALUES ('wire_guidance_trailer', 'Wire Guidance Trailer Form', '{"sections": [{"key": "epoxy_machine","title": "Epoxy Machine","toggle": "always","questions": [{"key": "wgt_xylene_video","label": "Upload 30 Sec Video of Xylane Cycling through Epoxy machine","type": "video","hint": "30 seconds"},{"key": "wgt_oil_photo","label": "Upload a Photo of Epoxy machine with Oil in tanks","type": "photos"}]},{"key": "inventory","title": "Inventory Count","toggle": "always","questions": [{"key": "wgt_epoxy_kits","label": "How Many Epoxy Kits?","type": "number"},{"key": "wgt_wire_rolls","label": "How many rolls of wire?","type": "number"},{"key": "wgt_drill_bits","label": "How many ½” Drill bits?","type": "number"},{"key": "wgt_silicone_tubes","label": "How many Silicone tubes?","type": "number"},{"key": "wgt_foam_bags","label": "How many bags of foam tubes?","type": "number"}]},{"key": "repairs","title": "Repairs","toggle": "always","questions": [{"key": "wgt_repairs","label": "Were any repairs made to the epoxy machine or floor saw?","type": "yes_no","red_flag_on": "yes","branches": {"yes": [{"key": "wgt_repairs_photos","label": "Submit photo of parts that were replaced","type": "photos","multiple": true}],"no": []}}]}]}', 60);

INSERT IGNORE INTO form_templates (code, title, definition, sort_order)
VALUES ('gear_request', 'OPI Gear Request Form', '{"sections": [{"key": "gear","title": "Gear Request","toggle": "always","questions": [{"key": "gear_lead_shirts","label": "Do you need more Crew Lead shirts?","type": "yes_no","branches": {"yes": [{"key": "gear_lead_shirts_size","label": "What size?","type": "text"},{"key": "gear_lead_shirts_count","label": "How many?","type": "number"}],"no": []}},{"key": "gear_lead_vest","label": "Do you need another Crew Lead Safety Vest?","type": "yes_no","branches": {"yes": [{"key": "gear_lead_vest_size","label": "What size?","type": "text"}],"no": []}},{"key": "gear_crew_vests","label": "Do you need more Crew Safety Vest?","type": "yes_no","branches": {"yes": [{"key": "gear_crew_vests_size","label": "What size?","type": "text"},{"key": "gear_crew_vests_count","label": "How many?","type": "number"}],"no": []}},{"key": "gear_hard_hats","label": "Do you need more Hard Hats?","type": "yes_no","branches": {"yes": [{"key": "gear_hard_hats_count","label": "How many?","type": "number"}],"no": []}}]}]}', 70);

ALTER TABLE form_submissions ADD COLUMN report_date DATE NULL AFTER answers;

UPDATE form_submissions SET report_date = DATE(submitted_at) WHERE report_date IS NULL;

ALTER TABLE form_submissions ADD KEY idx_fs_proj_form_report (project_qbo_id, form_code, report_date);
