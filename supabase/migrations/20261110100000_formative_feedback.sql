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
  -- Verdwijnt mee met de feedback (en dus met de groep).
  review_id        uuid PRIMARY KEY REFERENCES public.project_document_reviews(id) ON DELETE CASCADE,
  verdict          project_document_verdict,
  grade            numeric(4,2),
  raw_llm_response jsonb,
  journal_entry    jsonb,
  saved_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.project_review_badges_backup (LIKE public.project_review_badges INCLUDING DEFAULTS);
-- Verdwijnt mee met het account; staat in de gegevensexport (server/account/myData.js).
DO $$ BEGIN
  ALTER TABLE public.project_review_badges_backup
    ADD CONSTRAINT prb_backup_user_fk FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
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

-- 5. De oude opdracht met cijfer en oordeel wordt niet meer gelezen (nu: formative_feedback);
--    weg uit de promptbewerker, met een reservekopie (ook als een beheerder hem had aangepast).
CREATE TABLE IF NOT EXISTS public.chatbot_prompts_backup (LIKE public.chatbot_prompts INCLUDING DEFAULTS);
ALTER TABLE public.chatbot_prompts_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chatbot_prompts_backup FROM anon, authenticated;
INSERT INTO public.chatbot_prompts_backup
SELECT * FROM public.chatbot_prompts WHERE section = 'project' AND name = 'document_review';
DELETE FROM public.chatbot_prompts WHERE section = 'project' AND name = 'document_review';

-- 6. Prestaties zonder niveau (zoals de badge voor de beste verstandhouding) één keer
--    per student en onderwerp: de bestaande unieke index geldt niet als level leeg is.
CREATE UNIQUE INDEX IF NOT EXISTS student_achievements_unique_nolevel
  ON public.student_achievements (user_id, kind, topic_key) WHERE level IS NULL;
