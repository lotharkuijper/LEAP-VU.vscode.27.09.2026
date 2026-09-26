-- Websitebronnen (herinrichting docentenbeheer, 2026-09-26).
--
-- Een website die een docent als leerstof of cursusinformatie toevoegt, is voor
-- de docent ÉÉN bron ("het Quarto-boek Biostatistiek"), ook al bestaat ze uit
-- tientallen pagina's. Elke pagina blijft een eigen documents-rij
-- (file_type='web', file_path=url) met eigen chunks; web_sources groepeert ze
-- zodat de docent de hele site in één keer kan bijwerken, van doel wisselen of
-- verwijderen, en ziet wanneer ze voor het laatst is opgehaald.
--
-- Volledig ADDITIEF: de oude code negeert tabel en kolom. Terugdraaien:
-- supabase/rollback/20260926100000_web_sources_down.sql
BEGIN;

CREATE TABLE IF NOT EXISTS web_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  base_url text NOT NULL,
  title text,
  purpose text NOT NULL DEFAULT 'course_material'
    CHECK (purpose IN ('course_material','course_info')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  -- { imported, skipped, unchanged, errors, notFound, total } van de laatste ophaling.
  last_sync_summary jsonb,
  UNIQUE (course_id, base_url)
);

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS web_source_id uuid REFERENCES web_sources(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS documents_web_source_id_idx ON documents(web_source_id);

-- Alleen staf leest websitebronnen via PostgREST; de server gebruikt de
-- service role en valt hier niet onder.
ALTER TABLE web_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "web_sources_read_staff" ON web_sources;
CREATE POLICY "web_sources_read_staff" ON web_sources
  FOR SELECT TO authenticated
  USING (is_admin() OR is_course_teacher(auth.uid(), course_id));

COMMIT;
