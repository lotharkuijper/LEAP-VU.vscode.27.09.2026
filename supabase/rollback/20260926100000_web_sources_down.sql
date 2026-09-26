-- TERUGDRAAIEN van 20260926100000_web_sources.sql
-- ("val terug op de oude systematiek").
--
-- De pagina's zelf blijven gewone documents-rijen (file_type='web') met hun
-- chunks in de RAG-map van de cursus; alleen de groepering verdwijnt. Draai dit
-- vóór 20260925100000_document_purposes_down.sql als je beide terugdraait.
BEGIN;

DROP INDEX IF EXISTS documents_web_source_id_idx;
ALTER TABLE documents DROP COLUMN IF EXISTS web_source_id;
DROP TABLE IF EXISTS web_sources;

COMMIT;
