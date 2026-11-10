-- Terugdraaien van 20261110100000_formative_feedback.sql: cijfers, oordelen,
-- badges en de oude prompt terug uit de reservetabellen. Feedback die daarna is
-- gegeven heeft geen oordeel; die krijgt 'conditional' zodat verdict weer verplicht
-- kan zijn. Badges waarvan de feedback, persona, groep of student intussen is
-- verwijderd, komen niet terug.

UPDATE public.project_document_reviews r
   SET verdict = b.verdict, grade = b.grade,
       raw_llm_response = b.raw_llm_response, journal_entry = b.journal_entry
  FROM public.project_review_grades_backup b
 WHERE b.review_id = r.id;

INSERT INTO public.project_review_badges
SELECT b.* FROM public.project_review_badges_backup b
 WHERE EXISTS (SELECT 1 FROM public.project_document_reviews x WHERE x.id = b.review_id)
   AND EXISTS (SELECT 1 FROM public.project_personas x WHERE x.id = b.persona_id)
   AND EXISTS (SELECT 1 FROM public.project_groups x WHERE x.id = b.group_id)
   AND EXISTS (SELECT 1 FROM public.profiles x WHERE x.id = b.user_id)
ON CONFLICT DO NOTHING;

UPDATE public.project_document_reviews SET verdict = 'conditional' WHERE verdict IS NULL;
ALTER TABLE public.project_document_reviews ALTER COLUMN verdict SET NOT NULL;

INSERT INTO public.chatbot_prompts SELECT * FROM public.chatbot_prompts_backup ON CONFLICT DO NOTHING;

DROP INDEX IF EXISTS public.student_achievements_unique_nolevel;
DROP TABLE IF EXISTS public.chatbot_prompts_backup;
DROP TABLE IF EXISTS public.project_review_badges_backup;
DROP TABLE IF EXISTS public.project_review_grades_backup;
