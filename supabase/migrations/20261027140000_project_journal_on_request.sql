-- Project → leerdagboek alleen op verzoek van de student (2026-10-27).
--
-- Tussenstanden, de eindreflectie, feedbackrondes van een beoordelaar en
-- "Beoordeling opvragen" schrijven niet meer automatisch in het leerdagboek van
-- ALLE groepsleden. De teksten staan bij de groep (projectruimte); elk groepslid
-- bewaart wat het wil in het eigen dagboek ("Bewaar in mijn leerdagboek").
--   group_checkpoints.journal_items     [{ key, title, content, sections }]
--   project_document_reviews.journal_entry { title, content, sections }
-- "Beoordeling opvragen" bewaart al zijn tekst in project_group_assessments.
--
-- Terugdraaien: supabase/rollback/20261027140000_project_journal_on_request_down.sql

ALTER TABLE group_checkpoints ADD COLUMN IF NOT EXISTS journal_items jsonb;
ALTER TABLE project_document_reviews ADD COLUMN IF NOT EXISTS journal_entry jsonb;
