

// Bron-agnostische itembank: alle 'itembank'-achtige bronnen die items in
// quiz_questions wegschrijven met een exsection_path. ShareStats is er één van;
// 'csv_import' is een tweede provider (docent-geüploade CSV). Lees-endpoints
// (secties, vraagselectie, dekking, suggesties, diagnose) gebruiken deze set
// zodat elke cursus een eigen itembank kan meebrengen. ShareStats-specifieke
// flows (auto-link, GitHub-sync) blijven hard op 'sharestats'.
const ITEMBANK_SOURCES = ['sharestats', 'csv_import'];

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
