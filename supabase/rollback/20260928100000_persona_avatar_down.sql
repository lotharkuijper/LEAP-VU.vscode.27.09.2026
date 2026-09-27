-- TERUGDRAAIEN van 20260928100000_persona_avatar.sql.
-- Persona's vallen dan terug op hun emoji; verder verandert er niets.
BEGIN;

ALTER TABLE project_personas DROP COLUMN IF EXISTS avatar;
ALTER TABLE course_personas DROP COLUMN IF EXISTS avatar;

COMMIT;
