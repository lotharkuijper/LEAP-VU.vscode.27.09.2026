-- Terugdraaien van 20261110100000_formative_feedback.sql: cijfers, oordelen en
-- badges terug uit de reservetabellen. Feedback die daarna is gegeven heeft geen
-- oordeel; die krijgt 'conditional' zodat verdict weer verplicht kan zijn.

UPDATE public.project_document_reviews r
   SET verdict = b.verdict, grade = b.grade,
       raw_llm_response = b.raw_llm_response, journal_entry = b.journal_entry
  FROM public.project_review_grades_backup b
 WHERE b.review_id = r.id;

INSERT INTO public.project_review_badges
SELECT * FROM public.project_review_badges_backup
ON CONFLICT DO NOTHING;

UPDATE public.project_document_reviews SET verdict = 'conditional' WHERE verdict IS NULL;
ALTER TABLE public.project_document_reviews ALTER COLUMN verdict SET NOT NULL;

DROP TABLE IF EXISTS public.project_review_badges_backup;
DROP TABLE IF EXISTS public.project_review_grades_backup;
