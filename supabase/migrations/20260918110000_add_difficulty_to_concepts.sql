/*
  # Moeilijkheidsgraad per begrip

  ## Overview
  server/conceptExtraction.js beoordeelt nu ook hoe moeilijk een begrip is voor
  een bachelorstudent (easy/medium/hard), op basis van de definitietekst en
  RAG-bewijs — NIET op basis van de embedding-vector (daarvoor bestaat geen
  gevalideerd signaal, dat zou schijnprecisie zijn). De Begrippen-tab gebruikt
  dit om binnen elke conceptgroep (cursus-/module-/voorbeeldbegrip) een
  moeilijkheids-hiërarchie te tonen.

  ## Changes
    - `concepts.difficulty` (text, nullable) - 'easy' | 'medium' | 'hard'
    - CHECK-constraint beperkt de waarde tot deze 3 niveaus
    - Bestaande rijen blijven NULL (geen betrouwbare default te backfillen
      zonder de definitietekst opnieuw te beoordelen); ze krijgen een waarde
      bij de volgende "Hergenereer begrippenlijst" via de self-healing refresh
      in POST /api/admin/extract-concepts
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'concepts' AND column_name = 'difficulty'
  ) THEN
    ALTER TABLE concepts ADD COLUMN difficulty text;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'concepts_difficulty_check'
  ) THEN
    ALTER TABLE concepts
      ADD CONSTRAINT concepts_difficulty_check
      CHECK (difficulty IS NULL OR difficulty IN ('easy', 'medium', 'hard'));
  END IF;
END $$;
