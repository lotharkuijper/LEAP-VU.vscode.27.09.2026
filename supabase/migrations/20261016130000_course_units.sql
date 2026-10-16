-- Leerlijn: onderdelen van een cursus in de volgorde van de stof (2026-10-16).
--
-- Een onderdeel ("Kansrekening", "Kansmodellen", …) heeft een positie in de
-- leerlijn: wat een hogere positie heeft, bouwt voort op wat ervoor komt.
-- Onderdelen met DEZELFDE positie staan naast elkaar (geen onderlinge
-- volgorde). Er zitten bewust geen datums in: de leerlijn gaat over de
-- opbouw van de stof, niet over een planning, zodat hij ook buiten de
-- cursusperiode en voor externen werkt.
--
-- Documenten (leerstof) krijgen per cursus een onderdeel. Begrippen erven de
-- plek van het vroegste onderdeel van hun brondocumenten (server/courseUnits.js).
-- Geen leerlijn ingesteld = alles werkt zoals voorheen.
--
-- Alleen de server (service role) leest en schrijft.
-- Terugdraaien: supabase/rollback/20261016130000_course_units_down.sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.course_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  position integer NOT NULL CHECK (position >= 1),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS course_units_course_idx ON public.course_units (course_id, position);
ALTER TABLE public.course_units ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.course_unit_documents (
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES public.course_units(id) ON DELETE CASCADE,
  PRIMARY KEY (course_id, document_id)
);
CREATE INDEX IF NOT EXISTS course_unit_documents_unit_idx ON public.course_unit_documents (unit_id);
ALTER TABLE public.course_unit_documents ENABLE ROW LEVEL SECURITY;
-- Geen policies: alleen de server leest en schrijft.

COMMIT;

NOTIFY pgrst, 'reload schema';
