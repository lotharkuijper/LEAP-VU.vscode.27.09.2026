-- Leerdagboek in drie blokken + leerniveau ten tijde van de activiteit (2026-09-28).
--
-- sections: { summary, went_well[], to_improve[], feedback?, next_steps[] }
--   (zie server/journalSections.js). NULL = oude/vrije tekst in `content`.
-- learning_level: 1..5 (Nieuw … Expert) zoals de student dat op het moment
--   van de activiteit had ingesteld; NULL waar geen niveau van toepassing is
--   (bv. quizzen) of voor oude regels.
-- `content` blijft altijd gevuld (leesbare tekst).
--
-- Volledig ADDITIEF. Terugdraaien: supabase/rollback/20260928120000_journal_sections_down.sql
BEGIN;

ALTER TABLE learning_journal_entries ADD COLUMN IF NOT EXISTS sections jsonb;
ALTER TABLE learning_journal_entries ADD COLUMN IF NOT EXISTS learning_level smallint
  CHECK (learning_level IS NULL OR learning_level BETWEEN 1 AND 5);

COMMIT;
