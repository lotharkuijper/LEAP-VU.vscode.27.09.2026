-- TERUGDRAAIEN van 20261126100000_feedback_process_product.sql.
-- Verwijdert de aparte instellingen voor proces- en productfeedback. Er gaat
-- geen feedback van groepen verloren; die staat in project_group_products,
-- project_document_reviews en project_group_assessments en blijft staan.
-- Zet ook de code terug (vóór 2026-11-26). Blijft de nieuwe code staan, dan
-- geldt voor procesfeedback het productmaximum (max_reviews), nooit onbeperkt.
BEGIN;

ALTER TABLE public.project_personas
  DROP COLUMN IF EXISTS product_feedback,
  DROP COLUMN IF EXISTS process_feedback,
  DROP COLUMN IF EXISTS max_process_reviews,
  DROP COLUMN IF EXISTS process_focus;

ALTER TABLE public.course_personas
  DROP COLUMN IF EXISTS product_feedback,
  DROP COLUMN IF EXISTS process_feedback,
  DROP COLUMN IF EXISTS max_process_reviews,
  DROP COLUMN IF EXISTS process_focus;

NOTIFY pgrst, 'reload schema';

COMMIT;
