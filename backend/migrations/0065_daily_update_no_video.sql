-- 0065 Daily Update: the progress video can be skipped with an explicit
-- "No video today" answer (allow_none = the button text; the answer value is
-- that text). Guarded on the question key, so it's a no-op if the layout moved.
UPDATE form_templates
SET definition = JSON_SET(definition, '$.sections[0].questions[0].allow_none', 'No video today')
WHERE code = 'daily_update'
  AND JSON_UNQUOTE(JSON_EXTRACT(definition, '$.sections[0].questions[0].key')) = 'progress_video';
