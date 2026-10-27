-- Groepsindeling per project (2026-10-27, server/projectGroups.js).
--
-- projects.group_mode:
--   'self'    studenten vormen zelf groepen (uitnodigingscode) — het oude gedrag
--   'teacher' de docent deelt in (open cursussen)
--   'canvas'  de groepen komen uit Canvas: een student die het project opent via
--             een Canvas-groepsopdracht komt in de groep met dezelfde Canvas-groep
-- Bij 'teacher' en 'canvas' kan een student geen groep maken, verlaten of
-- wisselen; de docent kan altijd indelen en verplaatsen.
-- allow_self_signup blijft bestaan (oude code) en volgt group_mode = 'self'.
--
-- project_groups.source: wie de groep maakte (self/teacher/canvas);
-- external_ref/external_name: de Canvas-groep (issuer + groep-id) en haar naam.
-- project_group_members.added_by: de docent die indeelde (null = student zelf / Canvas).
--
-- Terugdraaien: supabase/rollback/20261027160000_project_group_modes_down.sql

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS group_mode text NOT NULL DEFAULT 'self'
    CHECK (group_mode IN ('self', 'teacher', 'canvas'));
UPDATE projects SET group_mode = CASE WHEN allow_self_signup IS FALSE THEN 'teacher' ELSE 'self' END;

ALTER TABLE project_groups
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'self'
    CHECK (source IN ('self', 'teacher', 'canvas')),
  ADD COLUMN IF NOT EXISTS external_ref text,
  ADD COLUMN IF NOT EXISTS external_name text;
CREATE UNIQUE INDEX IF NOT EXISTS project_groups_external_ref_uidx
  ON project_groups (project_id, external_ref) WHERE external_ref IS NOT NULL;

ALTER TABLE project_group_members
  ADD COLUMN IF NOT EXISTS added_by uuid REFERENCES profiles(id) ON DELETE SET NULL;
