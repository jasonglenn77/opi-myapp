-- 0052 Forms engine + crew passcode auth (PM Portal Phase 2).
--
-- form_templates.definition JSON vocabulary:
--   {"sections": [ {key, title, toggle, questions: [...]}, ... ]}
--   section.toggle: "always" (base questions, every submission) or a per-project
--     PM toggle name: "jha" or "anchoring" or "wire_guidance" (section only shown
--     when project_form_settings.toggles[name] is true).
--   question: {key, label, type, hint?, count?, multiple?, optional?, options?,
--              deferred?, red_flag_on?, branches?}
--   question types:
--     video     one video upload (hint = min/max seconds guidance text)
--     photos    photo upload(s) (count = expected number of photos, hint text)
--     media     photo OR video upload (multiple = allow several)
--     yes_no    branching question. branches = {"yes": [questions], "no": [questions]}
--               shown only when that answer is chosen (every If YES / If NO from
--               the doc is encoded this way). red_flag_on = "yes" or "no": the
--               answer value that raises a red flag on the submission.
--     text      free text
--     number    numeric answer
--     select    one of question.options
--     signature drawn customer sign-off. Marked {"deferred": true} because the
--               signature canvas ships in Phase 3.
--   Media-type answers store uploaded document id(s) from POST /api/forms/upload.
--
-- project_form_settings: one row per project. toggles JSON e.g.
--   {"jha": true, "anchoring": false, "wire_guidance": false} and
--   custom_questions JSON: [{form_code, question}] = Jason's per-project
--   additions, appended to that form's last section at serve time.
--
-- crew_passcodes: 4-6 digit field passcodes. crew_id NULL + role boss = the
--   crew boss MASTER code. code_hash = pbkdf2_sha256; uniqueness enforced at
--   set time by verifying the new code against all active rows.

CREATE TABLE IF NOT EXISTS form_templates (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(64) NOT NULL,
  title       VARCHAR(255) NOT NULL,
  definition  JSON NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_form_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_form_settings (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  project_qbo_id     VARCHAR(64) NOT NULL,
  toggles            JSON NULL,
  custom_questions   JSON NULL,
  updated_by_user_id BIGINT UNSIGNED NULL,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pfs_project (project_qbo_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS form_submissions (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_qbo_id      VARCHAR(64) NOT NULL,
  form_code           VARCHAR(64) NOT NULL,
  crew_context        JSON NULL,
  answers             JSON NOT NULL,
  red_flag            TINYINT(1) NOT NULL DEFAULT 0,
  red_flag_reason     VARCHAR(500) NULL,
  status              ENUM('submitted','reviewed') NOT NULL DEFAULT 'submitted',
  submitted_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by_user_id BIGINT UNSIGNED NULL,
  reviewed_at         DATETIME NULL,
  KEY idx_fs_proj_form_time (project_qbo_id, form_code, submitted_at),
  KEY idx_fs_status (status, red_flag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crew_passcodes (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  crew_id      INT NULL,
  role         ENUM('lead','boss') NOT NULL DEFAULT 'lead',
  label        VARCHAR(120) NOT NULL,
  code_hash    VARCHAR(255) NOT NULL,
  active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME NULL,
  KEY idx_cp_crew (crew_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the three Phase 2 form templates (labels verbatim from the OPI APP
-- Project Management doc). INSERT IGNORE keeps re-runs harmless.

INSERT IGNORE INTO form_templates (code, title, definition, sort_order)
VALUES ('kickoff_update', 'Project Kickoff Update Form', '{"sections": [{"key": "site_video","title": "Site Video","toggle": "always","questions": [{"key": "site_video","label": "Upload a 30 - 60 Second video showcasing the facility before we start.","type": "video","hint": "30 to 60 seconds"}]},{"key": "existing_damage","title": "Existing Damage","toggle": "always","questions": [{"key": "existing_damage","label": "Is there any existing damage to the facility?","type": "yes_no","red_flag_on": "yes","branches": {"yes": [{"key": "existing_damage_media","label": "Photo/Video document all existing damages to the facility.","type": "media","multiple": true}],"no": []}}]},{"key": "work_area","title": "Work Area","toggle": "always","questions": [{"key": "work_area_clear","label": "Is the work area free and clear?","type": "yes_no","red_flag_on": "no","branches": {"yes": [],"no": [{"key": "work_area_media","label": "Photo/Video documenting any materials or personnel in our work area","type": "media","multiple": true}]}}]},{"key": "onsite_materials","title": "Onsite Materials","toggle": "always","questions": [{"key": "onsite_materials","label": "Is there any materials or hardware that is already onsite?","type": "yes_no","branches": {"yes": [{"key": "onsite_materials_counts","label": "Provide counts to OPI PM","type": "text"},{"key": "onsite_materials_media","label": "Provide photos/Videos to OPI PM","type": "media","multiple": true}],"no": []}}]}]}', 10);

INSERT IGNORE INTO form_templates (code, title, definition, sort_order)
VALUES ('daily_update', 'Daily Update Form', '{"sections": [{"key": "progress_video","title": "Progress Video","toggle": "always","questions": [{"key": "progress_video","label": "Upload a 30 - 60 Second video showcasing the progress of the day.","type": "video","hint": "30 to 60 seconds"}]},{"key": "marked_drawings","title": "Marked Drawings","toggle": "always","questions": [{"key": "marked_drawings","label": "Marked the PDF drawings to show what we are working on and what is completed.","type": "media","hint": "Yellow = in progress, Green = completed, Red = Redflag/CO","multiple": true}]},{"key": "jha","title": "Daily OPI JHA","toggle": "jha","questions": [{"key": "jha_hazards","label": "Job Hazard Analysis: what hazards did you notice on the jobsite today?","type": "text"},{"key": "jha_prevention","label": "What prevention steps were taken for those hazards?","type": "text"}]},{"key": "equipment","title": "Equipment","toggle": "always","questions": [{"key": "equipment_down","label": "Is any of the equipment down?","type": "yes_no","red_flag_on": "yes","branches": {"yes": [{"key": "equipment_down_desc","label": "Provide a brief description of problem","type": "text"},{"key": "equipment_down_photos","label": "Photos of asset #","type": "photos","multiple": true}],"no": []}}]},{"key": "propane","title": "Propane/Fuel","toggle": "always","questions": [{"key": "propane_low","label": "Are we low on Propane/Fuel?","type": "yes_no","branches": {"yes": [{"key": "propane_tanks_left","label": "How many tanks are left?","type": "number"}],"no": []}}]},{"key": "layout_changes","title": "Layout / Elevation Changes","toggle": "always","questions": [{"key": "layout_changes","label": "Were any changes made to the layout or elevation today with the approval of OPI PM?","type": "yes_no","red_flag_on": "yes","branches": {"yes": [{"key": "layout_changes_desc","label": "Provide a brief description of changes made","type": "text"},{"key": "layout_changes_photos","label": "Photos of changes made","type": "photos","multiple": true}],"no": []}}]},{"key": "shortages","title": "Material Shortages / Damages","toggle": "always","questions": [{"key": "material_shortages","label": "Are there any material shortages or damages to report?","type": "yes_no","red_flag_on": "yes","branches": {"yes": [{"key": "shortage_item_desc","label": "Provide item description","type": "text"},{"key": "shortage_photos","label": "Photos","type": "photos","multiple": true},{"key": "shortage_counts","label": "Counts","type": "text"}],"no": []}}]},{"key": "anchoring","title": "Anchoring","toggle": "anchoring","questions": [{"key": "anchoring_video","label": "Upload Video showcasing proper anchoring procedures.","type": "video"}]},{"key": "wire_guidance","title": "Wire Guidance","toggle": "wire_guidance","questions": [{"key": "wg_saw_cut","label": "Upload 3 Photos/Videos of \u00bd\u201d depth saw cut in different areas throughout the system.","type": "media","count": 3,"multiple": true},{"key": "wg_expansion_joints","label": "Upload a Video showing the expansion joints foam and silicon installed.","type": "video"},{"key": "wg_continuity","label": "Upload a Video showing continuity in wire at line driver box prior to epoxy pour.","type": "video"},{"key": "wg_aisles_clean","label": "Upload Photos/Videos showing the aisles cleaned and completed.","type": "media","multiple": true},{"key": "wg_ohms_final","label": "Upload a Final video of ohms reading at line driver box with it written inside the box.","type": "video"}]}]}', 20);

INSERT IGNORE INTO form_templates (code, title, definition, sort_order)
VALUES ('completion', 'Project Completion Form', '{"sections": [{"key": "completed_photos","title": "Completed Project Photos","toggle": "always","questions": [{"key": "completed_photos","label": "Upload 10 Photos showcasing the completed project","type": "photos","count": 10,"multiple": true,"hint": "Provide photos showing aisle widths, elevation levels, footplates w/ anchors, bolts torqued for knockdown uprights and any detail work. (palletback stops showcasing tek screws, ERG\u2019s showcasing anchors, netting etc.)"}]},{"key": "completed_video","title": "Completed Project Video","toggle": "always","questions": [{"key": "completed_video","label": "Upload a 30 to 60 second video showcasing the completed project.","type": "video","hint": "30 to 60 seconds"}]},{"key": "resubmissions","title": "Resubmit anchoring video & final wire guidance ohms reading (If applicable)","toggle": "always","questions": [{"key": "resubmit_anchoring_video","label": "Resubmit anchoring video (If applicable)","type": "video","optional": true},{"key": "resubmit_wg_ohms_video","label": "Resubmit final wire guidance ohms reading (If applicable)","type": "video","optional": true}]},{"key": "additional_comments","title": "Additional Information","toggle": "always","questions": [{"key": "additional_comments","label": "Is there any additional information or comments to report from the crew lead or client?","type": "yes_no","branches": {"yes": [{"key": "additional_comments_text","label": "Comments from the crew lead or client","type": "text"},{"key": "additional_comments_media","label": "Media upload","type": "media","multiple": true}],"no": []}}]},{"key": "customer_signoff","title": "Customer Sign off","toggle": "always","questions": [{"key": "customer_signoff","label": "Customer Sign off","type": "signature","deferred": true}]}]}', 30);
