-- Terugdraaien van 20261027160000_project_group_modes.sql.
-- Groepen en leden blijven bestaan; alleen de nieuwe kolommen verdwijnen.
UPDATE projects SET allow_self_signup = (group_mode = 'self');
DROP INDEX IF EXISTS project_groups_external_ref_uidx;
ALTER TABLE project_group_members DROP COLUMN IF EXISTS added_by;
ALTER TABLE project_groups
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS external_ref,
  DROP COLUMN IF EXISTS external_name;
ALTER TABLE projects DROP COLUMN IF EXISTS group_mode;
DELETE FROM public.leap_migrations WHERE name = '20261027160000_project_group_modes.sql';
