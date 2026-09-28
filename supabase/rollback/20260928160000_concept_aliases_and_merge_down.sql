-- TERUGDRAAIEN van 20260928160000_concept_aliases_and_merge.sql.
-- LET OP: samengevoegde begrippen komen hiermee niet terug; alleen de
-- alternatieve namen en bron-documenten vervallen.
BEGIN;

DROP FUNCTION IF EXISTS merge_concepts(uuid, uuid[]);
ALTER TABLE concepts DROP COLUMN IF EXISTS source_document_ids;
ALTER TABLE concepts DROP COLUMN IF EXISTS aliases;

COMMIT;
