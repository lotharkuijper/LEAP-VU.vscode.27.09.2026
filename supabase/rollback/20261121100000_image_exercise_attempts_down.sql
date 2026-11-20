-- Terug naar de situatie van vóór 20261121100000_image_exercise_attempts: de
-- pogingen van studenten bij beeldoefeningen verdwijnen (de foto's, beschrijvingen
-- en kenmerken van de docent blijven staan).
DROP TABLE IF EXISTS public.image_exercise_attempts;

NOTIFY pgrst, 'reload schema';
