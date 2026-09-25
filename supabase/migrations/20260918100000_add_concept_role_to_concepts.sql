/*
  # Concept role classificatie

  ## Overview
  server/conceptExtraction.js classificeert elk geëxtraheerd begrip in een rol
  (main_course_concept, module_concept, definition_term, method_term,
  latent_concept, example_instance) zodat voorbeelden/casussen (example_instance)
  worden uitgesloten van quizgeneratie. De applicatiecode schreef dit veld al
  naar de `concepts`-tabel, maar de kolom bestond nooit in de database — vandaar
  de PostgREST-fout "Could not find the 'concept_role' column of 'concepts' in
  the schema cache" bij het opslaan van begrippen.

  ## Changes
    - `concepts.concept_role` (text, nullable) - rolclassificatie van het begrip
    - CHECK-constraint beperkt de waarde tot de 6 rollen die de applicatie kent
    - Bestaande rijen krijgen 'main_course_concept' (behoudt huidig gedrag:
      alles behalve example_instance is quiz-geschikt, zie QUIZ_READY_CONCEPT_ROLES)
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'concepts' AND column_name = 'concept_role'
  ) THEN
    ALTER TABLE concepts ADD COLUMN concept_role text;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'concepts_concept_role_check'
  ) THEN
    ALTER TABLE concepts
      ADD CONSTRAINT concepts_concept_role_check
      CHECK (concept_role IS NULL OR concept_role IN (
        'main_course_concept',
        'module_concept',
        'definition_term',
        'method_term',
        'latent_concept',
        'example_instance'
      ));
  END IF;
END $$;

UPDATE concepts SET concept_role = 'main_course_concept' WHERE concept_role IS NULL;
