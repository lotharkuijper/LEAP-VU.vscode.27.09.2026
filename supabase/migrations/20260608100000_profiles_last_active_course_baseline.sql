-- Reproduceerbaarheid (toegevoegd 2026-10-30): profiles.last_active_course_id
-- is op productie buiten de migraties om toegevoegd, terwijl 20260608110000 de
-- verwijzing ervan vervangt. Alleen toevoegen als de kolom ontbreekt (nieuwe
-- database); op productie doet dit niets.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_active_course_id uuid
  CONSTRAINT profiles_last_active_course_id_fkey REFERENCES public.courses(id);
