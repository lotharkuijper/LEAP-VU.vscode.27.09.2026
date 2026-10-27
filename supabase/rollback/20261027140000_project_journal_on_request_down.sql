-- Terugdraaien van 20261027140000_project_journal_on_request.sql.
-- De vorige app-versie schrijft weer automatisch in de dagboeken; regels die
-- studenten zelf bewaarden blijven gewoon staan.
ALTER TABLE group_checkpoints DROP COLUMN IF EXISTS journal_items;
ALTER TABLE project_document_reviews DROP COLUMN IF EXISTS journal_entry;
DELETE FROM public.leap_migrations WHERE name = '20261027140000_project_journal_on_request.sql';
