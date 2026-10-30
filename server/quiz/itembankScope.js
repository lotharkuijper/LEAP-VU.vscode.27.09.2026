

// Bron-agnostische itembank: de bronnen 'sharestats' en 'csv_import' (door de
// docent geüploade CSV) schrijven items in quiz_questions met een exsection_path.
// Lees-endpoints (secties, vraagselectie, dekking, suggesties, diagnose) kijken
// naar beide, zodat elke cursus een eigen itembank kan meebrengen.
// ShareStats-specifieke flows (auto-link, GitHub-sync) blijven op 'sharestats'.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bouwt het PostgREST `or`-filter voor itembank-bronnen. ShareStats is een
// gedeelde, cursus-overstijgende bank; CSV-imports horen bij één cursus
// (metadata.course_id). Zonder geldige courseId vallen we terug op enkel
// ShareStats zodat CSV-banken van andere cursussen NOOIT lekken. courseId
// wordt gevalideerd als UUID om injectie in de filterstring te voorkomen.
export function itembankSourceOrFilter(courseId) {
  if (courseId && UUID_RE.test(String(courseId))) {
    return `source.eq.sharestats,and(source.eq.csv_import,metadata->>course_id.eq.${courseId})`;
  }
  return 'source.eq.sharestats';
}
