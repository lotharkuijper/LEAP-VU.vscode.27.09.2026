-- Project-bots: drie rollen, verstandhouding alleen waar de docent dat kiest,
-- en feedbackrondes per product (2026-09-29).
--
-- Rollen (persona_type):
--   'conversational' = Begeleider  — helpt de groep door de projectstappen; geen verstandhouding.
--   'evaluator'      = Beoordelaar — feedback op een product met een (verborgen) rubric,
--                                    een vast aantal rondes; geen verstandhouding.
--   'roleplayer'     = Rolspeler   — personage in een simulatie; verstandhouding optioneel.
--
-- Nieuwe kolommen (project_personas én course_personas, zodat sjablonen ze meegeven):
--   reputation_enabled  alleen zinvol bij een rolspeler: houdt een verstandhouding met de groep bij.
--   conduct_rules       "Gedragsregels" van de docent: { positive, negative, levels: { cold, strained,
--                       neutral, positive, warm } }. Worden NOOIT aan de persona in het gesprek
--                       gegeven, alleen aan de beoordelingsstap na afloop van een gesprek.
--   start_level         niveau waarop de groep begint: -2 koud … 0 neutraal … +2 warm.
--   deliverable_label   beoordelaar: over welk product hij feedback geeft ("Tussenproduct 1").
--   max_reviews         beoordelaar: aantal feedbackrondes per groep (NULL = onbeperkt).
--
-- project_persona_relationships.score krijgt een nieuwe betekenis: het NIVEAU
-- (-2..+2), met -3 = contact verbroken (dieptepunt). Er stonden nog geen rijen in.
--
-- project_group_products: werk dat een groep inlevert bij een beoordelaar.
-- project_document_reviews kan nu naar zo'n product verwijzen (product_id) in
-- plaats van naar een projectdocument van de docent.
--
-- Volledig ADDITIEF. Terugdraaien: supabase/rollback/20260929100000_persona_roles_down.sql
BEGIN;

-- 1. Rol 'roleplayer' toestaan.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname, rel.relname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname IN ('project_personas', 'course_personas')
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%persona_type%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', c.relname, c.conname);
  END LOOP;
END$$;
ALTER TABLE project_personas ADD CONSTRAINT project_personas_persona_type_check
  CHECK (persona_type IN ('conversational', 'evaluator', 'roleplayer'));
ALTER TABLE course_personas ADD CONSTRAINT course_personas_persona_type_check
  CHECK (persona_type IN ('conversational', 'evaluator', 'roleplayer'));

-- 2. Verstandhouding, gedragsregels, product en feedbackrondes.
ALTER TABLE project_personas
  ADD COLUMN IF NOT EXISTS reputation_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS conduct_rules jsonb,
  ADD COLUMN IF NOT EXISTS start_level smallint NOT NULL DEFAULT 0 CHECK (start_level BETWEEN -2 AND 2),
  ADD COLUMN IF NOT EXISTS deliverable_label text,
  ADD COLUMN IF NOT EXISTS max_reviews integer CHECK (max_reviews IS NULL OR (max_reviews BETWEEN 1 AND 50));
ALTER TABLE course_personas
  ADD COLUMN IF NOT EXISTS reputation_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS conduct_rules jsonb,
  ADD COLUMN IF NOT EXISTS start_level smallint NOT NULL DEFAULT 0 CHECK (start_level BETWEEN -2 AND 2),
  ADD COLUMN IF NOT EXISTS deliverable_label text,
  ADD COLUMN IF NOT EXISTS max_reviews integer CHECK (max_reviews IS NULL OR (max_reviews BETWEEN 1 AND 50));

-- 3. Ingeleverd werk bij een beoordelaar.
CREATE TABLE IF NOT EXISTS project_group_products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id)         ON DELETE CASCADE,
  group_id     uuid NOT NULL REFERENCES project_groups(id)   ON DELETE CASCADE,
  persona_id   uuid NOT NULL REFERENCES project_personas(id) ON DELETE CASCADE,
  filename     text NOT NULL,
  content_text text NOT NULL,
  byte_size    integer,
  uploaded_by  uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pgp_group_persona ON project_group_products (group_id, persona_id, created_at DESC);
ALTER TABLE project_group_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pgp_select ON project_group_products;
CREATE POLICY pgp_select ON project_group_products FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM project_group_members m
             WHERE m.group_id = project_group_products.group_id AND m.user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM projects p
                WHERE p.id = project_group_products.project_id AND pr_is_course_staff(p.course_id))
  );
-- Schrijven uitsluitend via de server (service role).

-- 4. Een oordeel hoort bij een projectdocument óf bij ingeleverd werk.
ALTER TABLE project_document_reviews ALTER COLUMN document_id DROP NOT NULL;
ALTER TABLE project_document_reviews
  ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES project_group_products(id) ON DELETE CASCADE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pdr_document_or_product') THEN
    ALTER TABLE project_document_reviews
      ADD CONSTRAINT pdr_document_or_product CHECK (document_id IS NOT NULL OR product_id IS NOT NULL);
  END IF;
END$$;
CREATE INDEX IF NOT EXISTS idx_pdr_product ON project_document_reviews (product_id);
CREATE INDEX IF NOT EXISTS idx_pdr_group_persona ON project_document_reviews (group_id, persona_id);

COMMIT;
