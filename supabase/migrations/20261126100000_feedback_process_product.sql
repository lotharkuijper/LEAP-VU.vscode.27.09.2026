-- Feedback op het product en feedback op het proces apart (2026-11-26).
-- Een feedbackgever (beoordelaar) kan twee soorten feedback geven, elk met een
-- eigen schakelaar en een eigen aantal rondes per groep:
--   * op het product: de groep levert een voorlopige versie in (max_reviews, zoals
--     voorheen; telt project_group_products);
--   * op het proces: geen upload; hij leest wat de groep deed in de gesprekken met
--     de personages en de checkpoints (max_process_reviews; telt
--     project_group_assessments). Nooit de groepschat.
-- process_focus: waar de feedbackgever bij het proces op let (door de docent).
--
-- Bestaande beoordelaars deden beide uit één potje; ze houden beide aan, met
-- hetzelfde maximum voor elk. Terugdraaien:
-- supabase/rollback/20261126100000_feedback_process_product_down.sql
BEGIN;

ALTER TABLE public.project_personas
  ADD COLUMN IF NOT EXISTS product_feedback boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS process_feedback boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_process_reviews integer
    CHECK (max_process_reviews IS NULL OR (max_process_reviews BETWEEN 1 AND 50)),
  ADD COLUMN IF NOT EXISTS process_focus text
    CHECK (process_focus IS NULL OR char_length(process_focus) <= 2000);

ALTER TABLE public.course_personas
  ADD COLUMN IF NOT EXISTS product_feedback boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS process_feedback boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_process_reviews integer
    CHECK (max_process_reviews IS NULL OR (max_process_reviews BETWEEN 1 AND 50)),
  ADD COLUMN IF NOT EXISTS process_focus text
    CHECK (process_focus IS NULL OR char_length(process_focus) <= 2000);

UPDATE public.project_personas SET max_process_reviews = max_reviews
  WHERE persona_type = 'evaluator' AND max_process_reviews IS NULL AND max_reviews IS NOT NULL;
UPDATE public.course_personas SET max_process_reviews = max_reviews
  WHERE persona_type = 'evaluator' AND max_process_reviews IS NULL AND max_reviews IS NOT NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
