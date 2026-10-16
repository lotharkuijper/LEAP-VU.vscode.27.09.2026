-- Terugdraaien van 20261016100000_chat_attachments.sql.
-- Zet leap_course_feature_on terug zoals in 20261015100000_course_features.sql,
-- verwijdert de bewaking op berichten en Studiecafé en het schakelaarlogboek.
-- courses.features houdt eventueel {"attachments": true}; de oude code negeert
-- die sleutel.
BEGIN;

CREATE OR REPLACE FUNCTION public.leap_course_feature_on(p_course uuid, p_feature text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_course IS NULL
      OR pr_is_admin()
      OR is_course_teacher(auth.uid(), p_course)
      OR coalesce(
           (SELECT (c.features ->> p_feature) IS DISTINCT FROM 'false'
              FROM courses c WHERE c.id = p_course),
           true);
$$;

DROP TRIGGER IF EXISTS leap_messages_no_inline_files ON public.messages;
DROP TRIGGER IF EXISTS leap_studiecafe_threads_no_inline_files ON public.studiecafe_threads;
DROP TRIGGER IF EXISTS leap_studiecafe_replies_no_inline_files ON public.studiecafe_replies;
DROP FUNCTION IF EXISTS public.leap_reject_inline_files();
DROP FUNCTION IF EXISTS public.leap_has_inline_file(text);
DROP TABLE IF EXISTS public.leap_setting_changes;

DELETE FROM public.leap_migrations WHERE name = '20261016100000_chat_attachments.sql';

COMMIT;

NOTIFY pgrst, 'reload schema';
