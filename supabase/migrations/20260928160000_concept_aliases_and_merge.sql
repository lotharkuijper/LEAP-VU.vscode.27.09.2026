-- Begrippen: alternatieve namen, bron-documenten en veilig samenvoegen (2026-09-28).
--
-- aliases: synoniemen, afkortingen, vertalingen en spellingvarianten van het
--   begrip ("standaarddeviatie" bij "standaardafwijking", "RCT" bij
--   "Randomized Controlled Trial"). Zo vindt een student het begrip ook onder
--   de andere naam.
-- source_document_ids: de documenten waarin het begrip is gevonden. Meer dan
--   één document = het komt in meerdere modules terug (kernbegrip).
--
-- merge_concepts(keep, dups): voegt dubbelingen samen in één transactie. Alle
-- verwijzingen verhuizen naar `keep` (botsingen op een uniekheidsregel: de rij
-- van de dubbeling vervalt, die van `keep` blijft), namen van de dubbelingen
-- worden aliassen, bron-documenten worden samengevoegd, daarna verdwijnen de
-- dubbelingen. Alleen binnen dezelfde cursus.
--
-- Volledig ADDITIEF. Terugdraaien: supabase/rollback/20260928160000_concept_aliases_and_merge_down.sql
BEGIN;

ALTER TABLE concepts ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}';
ALTER TABLE concepts ADD COLUMN IF NOT EXISTS source_document_ids uuid[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION merge_concepts(keep_id uuid, dup_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  keep_course uuid;
  dups uuid[];
  merged_count integer;
BEGIN
  SELECT course_id INTO keep_course FROM concepts WHERE id = keep_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Begrip % bestaat niet', keep_id; END IF;

  -- Alleen echte dubbelingen uit dezelfde cursus, nooit het begrip zelf.
  SELECT array_agg(id) INTO dups FROM concepts
   WHERE id = ANY(dup_ids) AND id <> keep_id AND course_id IS NOT DISTINCT FROM keep_course;
  IF dups IS NULL THEN RETURN 0; END IF;
  merged_count := array_length(dups, 1);

  -- Tabellen zonder uniekheidsregel op concept_id: gewoon verhuizen.
  UPDATE concept_evidence SET concept_id = keep_id WHERE concept_id = ANY(dups);
  UPDATE student_explanations SET concept_id = keep_id WHERE concept_id = ANY(dups);
  UPDATE student_achievements SET concept_id = keep_id WHERE concept_id = ANY(dups);

  -- Tabellen met een uniekheidsregel: eerst de botsende rijen van de dubbeling weg.
  DELETE FROM concept_itembank_sections d WHERE d.concept_id = ANY(dups)
    AND EXISTS (SELECT 1 FROM concept_itembank_sections k WHERE k.concept_id = keep_id AND k.exsection_path = d.exsection_path);
  DELETE FROM concept_itembank_sections d WHERE d.concept_id = ANY(dups)
    AND d.id NOT IN (SELECT DISTINCT ON (exsection_path) id FROM concept_itembank_sections WHERE concept_id = ANY(dups) ORDER BY exsection_path, id);
  UPDATE concept_itembank_sections SET concept_id = keep_id WHERE concept_id = ANY(dups);

  DELETE FROM concept_rag_sources d WHERE d.concept_id = ANY(dups)
    AND EXISTS (SELECT 1 FROM concept_rag_sources k WHERE k.concept_id = keep_id AND k.course_id IS NOT DISTINCT FROM d.course_id);
  DELETE FROM concept_rag_sources d WHERE d.concept_id = ANY(dups)
    AND d.id NOT IN (SELECT DISTINCT ON (course_id) id FROM concept_rag_sources WHERE concept_id = ANY(dups) ORDER BY course_id, id);
  UPDATE concept_rag_sources SET concept_id = keep_id WHERE concept_id = ANY(dups);

  DELETE FROM concept_topics d WHERE d.concept_id = ANY(dups)
    AND EXISTS (SELECT 1 FROM concept_topics k WHERE k.concept_id = keep_id AND k.topic_id = d.topic_id);
  DELETE FROM concept_topics d WHERE d.concept_id = ANY(dups)
    AND d.id NOT IN (SELECT DISTINCT ON (topic_id) id FROM concept_topics WHERE concept_id = ANY(dups) ORDER BY topic_id, id);
  UPDATE concept_topics SET concept_id = keep_id WHERE concept_id = ANY(dups);

  -- Namen van de dubbelingen worden aliassen; bron-documenten samenvoegen.
  UPDATE concepts k SET
    aliases = (
      SELECT COALESCE(array_agg(DISTINCT a) FILTER (WHERE a IS NOT NULL AND lower(a) <> lower(k.name)), '{}')
      FROM (
        SELECT unnest(k.aliases) AS a
        UNION SELECT name FROM concepts WHERE id = ANY(dups)
        UNION SELECT unnest(aliases) FROM concepts WHERE id = ANY(dups)
      ) s
    ),
    source_document_ids = (
      SELECT COALESCE(array_agg(DISTINCT d), '{}')
      FROM (
        SELECT unnest(k.source_document_ids) AS d
        UNION SELECT unnest(source_document_ids) FROM concepts WHERE id = ANY(dups)
        UNION SELECT source_document_id FROM concepts WHERE id = ANY(dups) AND source_document_id IS NOT NULL
      ) s WHERE d IS NOT NULL
    ),
    updated_at = now()
  WHERE k.id = keep_id;

  DELETE FROM concepts WHERE id = ANY(dups);
  RETURN merged_count;
END;
$$;

REVOKE ALL ON FUNCTION merge_concepts(uuid, uuid[]) FROM PUBLIC, anon, authenticated;

COMMIT;
