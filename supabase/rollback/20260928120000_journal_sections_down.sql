-- TERUGDRAAIEN van 20260928120000_journal_sections.sql.
-- De leesbare tekst staat nog in `content`; het leerdagboek toont dan weer één tekstblok.
BEGIN;

ALTER TABLE learning_journal_entries DROP COLUMN IF EXISTS learning_level;
ALTER TABLE learning_journal_entries DROP COLUMN IF EXISTS sections;

COMMIT;
