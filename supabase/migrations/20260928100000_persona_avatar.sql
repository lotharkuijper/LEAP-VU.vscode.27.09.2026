-- Cartoon-avatar per persona (2026-09-28).
--
-- Docenten geven een persona een eigen gezicht met de avatar-editor (DiceBear-
-- stijlen: robot, cartoon, Lorelei, schets, handgetekend). De configuratie is
-- klein JSON: { "style": "avataaars", "seed": "…", "options": { "top": [...],
-- "hairColor": [...], … } }. Zonder avatar toont de app een robotje dat uit de
-- naam wordt afgeleid, dus bestaande persona's houden gewoon een gezicht.
-- Het oude avatar_emoji-veld blijft bestaan voor tekst (dagboektitels e.d.).
--
-- Volledig ADDITIEF. Terugdraaien: supabase/rollback/20260928100000_persona_avatar_down.sql
BEGIN;

ALTER TABLE course_personas ADD COLUMN IF NOT EXISTS avatar jsonb;
ALTER TABLE project_personas ADD COLUMN IF NOT EXISTS avatar jsonb;

COMMIT;
