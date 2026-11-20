-- Terug naar de situatie van vóór 20261120100000_image_exercises: de tabellen voor
-- beeldoefeningen verdwijnen. De opslagmap wordt alleen verwijderd als hij leeg is;
-- staan er nog foto's in, verwijder die dan eerst via de server of laat de map staan
-- (een lege, private map zonder regels doet niets).
DROP TABLE IF EXISTS public.image_exercise_features;
DROP TABLE IF EXISTS public.image_exercises;

DELETE FROM storage.buckets b
WHERE b.id = 'image_exercises'
  AND NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = b.id);

NOTIFY pgrst, 'reload schema';
