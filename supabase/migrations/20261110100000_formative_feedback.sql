-- Feedback van een beoordelaar is zuiver formatief (besluit 2026-11-10): geen
-- cijfer, geen oordeel en geen badge. Nieuwe feedback laat verdict en grade leeg.
-- Oude cijfers, oordelen en badges verdwijnen uit wat studenten kunnen lezen: ze
-- gaan naar een reservetabel zonder leesregels (alleen de server en het
-- terugdraaiscript komen erbij). Terugdraaien:
-- supabase/rollback/20261110100000_formative_feedback_down.sql

-- 1. Oordeel mag leeg zijn.
ALTER TABLE public.project_document_reviews ALTER COLUMN verdict DROP NOT NULL;

-- 2. Reservekopie van wat er weg gaat.
CREATE TABLE IF NOT EXISTS public.project_review_grades_backup (
  review_id        uuid PRIMARY KEY,
  verdict          project_document_verdict,
  grade            numeric(4,2),
  raw_llm_response jsonb,
  journal_entry    jsonb,
  saved_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.project_review_badges_backup (LIKE public.project_review_badges INCLUDING DEFAULTS);
ALTER TABLE public.project_review_grades_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_review_badges_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_review_grades_backup FROM anon, authenticated;
REVOKE ALL ON public.project_review_badges_backup FROM anon, authenticated;

INSERT INTO public.project_review_grades_backup (review_id, verdict, grade, raw_llm_response, journal_entry)
SELECT id, verdict, grade, raw_llm_response, journal_entry
  FROM public.project_document_reviews
 WHERE verdict IS NOT NULL OR grade IS NOT NULL
ON CONFLICT (review_id) DO NOTHING;

-- 3. Uit de feedback halen. De dagboektekst bouwt de server opnieuw op uit de
--    feedback zelf (reviewEntry in server/projects/projectJournalSave.js); het
--    ruwe antwoord van het taalmodel bevatte het cijfer ook.
UPDATE public.project_document_reviews
   SET verdict = NULL, grade = NULL, raw_llm_response = NULL, journal_entry = NULL
 WHERE id IN (SELECT review_id FROM public.project_review_grades_backup);

-- 4. Badges voor feedback bestaan niet meer.
INSERT INTO public.project_review_badges_backup SELECT * FROM public.project_review_badges;
DELETE FROM public.project_review_badges;
