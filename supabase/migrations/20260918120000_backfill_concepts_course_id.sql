/*
  # Backfill concepts.course_id vanuit key_points-markers (hermetische cursusscheiding)

  ## Overview
  20260414_add_course_id_to_concepts.sql voegde de course_id-kolom en de
  per-cursus unieke index (name, course_id) al toe, maar backfillde geen
  bestaande data. Tot deze migratie liep cursus-koppeling nog via een
  `course_id:<uuid>`-marker in key_points, waarbij MEERDERE cursussen dezelfde
  rij (dus dezelfde definitie, dezelfde review_status) konden delen. Dat is
  onwenselijk: eenzelfde begripsnaam kan in twee cursussen een andere
  betekenis hebben, en het goedkeuren/afkeuren van een begrip in cursus A mag
  nooit doorwerken in cursus B, zeker niet tussen docenten die elkaar niet
  kennen.

  ## Strategy
  - Begrip met PRECIES ÉÉN course_id:-marker: course_id direct invullen op de
    bestaande rij (geen duplicatie nodig).
  - Begrip met MEERDERE course_id:-markers (op moment van schrijven: 0 rijen,
    maar toekomstbestendig): de EERSTE cursus krijgt de bestaande rij, elke
    VOLGENDE cursus krijgt een eigen kopie (nieuwe id) met dezelfde inhoud als
    startpunt — vanaf nu volledig onafhankelijk, ook in review_status.
    Bekende beperking: gekoppeld bewijs/topics (concept_evidence,
    concept_topics, student_explanations) wijst nog naar de ORIGINELE rij en
    wordt niet automatisch mee-gekopieerd naar de nieuwe rij(en); dat is geen
    probleem zolang er geen multi-cursus-rijen bestaan (nu het geval).
  - Begrip zonder course_id:-marker: blijft NULL (globaal/seed-begrip, met
    opzet gedeeld curriculum-materiaal — dat blijft ongewijzigd).
*/

DO $$
DECLARE
  rec RECORD;
  marker TEXT;
  markers TEXT[];
  parsed_course_id UUID;
  is_first BOOLEAN;
BEGIN
  FOR rec IN SELECT id, key_points FROM concepts WHERE course_id IS NULL LOOP
    markers := ARRAY(
      SELECT kp FROM unnest(rec.key_points) AS kp WHERE kp LIKE 'course_id:%'
    );
    IF markers IS NULL OR array_length(markers, 1) IS NULL THEN
      CONTINUE;
    END IF;

    is_first := true;
    FOREACH marker IN ARRAY markers LOOP
      parsed_course_id := NULLIF(substring(marker FROM 11), '')::uuid;
      IF parsed_course_id IS NULL THEN
        CONTINUE;
      END IF;

      IF is_first THEN
        UPDATE concepts SET course_id = parsed_course_id WHERE id = rec.id;
        is_first := false;
      ELSE
        INSERT INTO concepts (name, category, definition, key_points, examples, course_id, concept_role, difficulty, review_status)
        SELECT name, category, definition, key_points, examples, parsed_course_id, concept_role, difficulty, review_status
        FROM concepts WHERE id = rec.id
        ON CONFLICT (name, course_id) WHERE course_id IS NOT NULL DO NOTHING;
      END IF;
    END LOOP;
  END LOOP;
END $$;
