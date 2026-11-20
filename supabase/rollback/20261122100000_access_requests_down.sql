-- Terug naar de situatie van vóór 20261122100000_access_requests: de toegangsaanvragen
-- verdwijnen. Accounts en cursuslidmaatschappen die via een aanvraag ontstonden, blijven.
DROP TABLE IF EXISTS public.access_requests;

NOTIFY pgrst, 'reload schema';
