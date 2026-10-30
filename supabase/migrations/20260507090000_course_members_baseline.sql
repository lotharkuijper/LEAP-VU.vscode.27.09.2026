-- Reproduceerbaarheid (toegevoegd 2026-10-30): public.course_members is op de
-- productiedatabase ooit met de hand gemaakt (Supabase-dashboard) en nooit in
-- een migratie vastgelegd, terwijl 20260507100000 en ~30 latere migraties hem
-- gebruiken. Daardoor faalde een nieuwe database vanaf nul.
--
-- Deze migratie maakt de tabel alleen als hij NIET bestaat, in de vorm die hij
-- had vóór 20260521110000 (die voegt member_role toe). Op productie (tabel
-- bestaat al) doet hij niets. Vorm: src/lib/database.types.ts,
-- 20260527220000 (oude kolom role, NOT NULL) en de upserts op (course_id, user_id).
DO $$
BEGIN
  IF to_regclass('public.course_members') IS NULL THEN
    CREATE TABLE public.course_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('superuser', 'teacher', 'student')),
      joined_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (course_id, user_id)
    );
    CREATE INDEX course_members_user_id_idx ON public.course_members(user_id);
  END IF;
END $$;
