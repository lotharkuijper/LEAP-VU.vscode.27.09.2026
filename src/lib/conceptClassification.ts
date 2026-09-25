// Pure helper voor de teacher-facing indeling van begrippen in de Begrippen-tab.
// Los van de fijnmazige LLM-rol in `concepts.concept_role` (main_course_concept/
// module_concept/definition_term/method_term/latent_concept/example_instance):
// docenten hebben maar 3 klassen nodig om te kunnen filteren/bulk-selecteren:
//   - 'example': illustratief voorbeeld/casus, geen kernbegrip (concept_role
//     === 'example_instance', al bij de LLM-extractie bekend);
//   - 'course':  begrip met bewijs (concept_evidence) in meerdere modules/
//     bestanden van de cursus;
//   - 'module':  begrip met bewijs uit precies één bestand (of nog geen
//     gekoppeld bewijs — veilige default).
// Cursus- vs. moduleconcept is principieel niet bekend tijdens de LLM-
// extractie zelf: die krijgt de chunks van alle geselecteerde documenten
// samengevoegd als één stuk tekst (zie POST /api/admin/extract-concepts in
// server/index.js) en heeft dus geen bestandsgrens om op te classificeren.
// Het is pas afleidbaar ná de RAG-verificatiestap, via het aantal DISTINCT
// document_id's per begrip in `concept_evidence` (server/conceptEvidence.js,
// GET /api/concepts/evidence-summary).
export type ConceptClass = 'example' | 'course' | 'module';

export interface ClassifiableConcept {
  id: string;
  concept_role?: string | null;
  difficulty?: string | null;
}

export function classifyConceptForTeacher(
  concept: ClassifiableConcept,
  moduleCounts: Record<string, number>,
): ConceptClass {
  if (concept.concept_role === 'example_instance') return 'example';
  const distinctDocs = moduleCounts[concept.id] ?? 0;
  return distinctDocs > 1 ? 'course' : 'module';
}

// Moeilijkheidsgraad, beoordeeld door de LLM tijdens extractie op basis van de
// definitietekst zelf (zie server/conceptExtraction.js classifyConceptDifficulty
// voor de tekstuele vangnet-heuristiek). Bewust GEEN afleiding uit de
// embedding-vector: daarvoor bestaat geen gevalideerd signaal, dat zou
// schijnprecisie zijn die een docent niet kan navertellen of vertrouwen.
export type DifficultyTier = 'easy' | 'medium' | 'hard';

export function getDifficultyTier(concept: ClassifiableConcept): DifficultyTier {
  const v = concept.difficulty;
  if (v === 'easy' || v === 'medium' || v === 'hard') return v;
  // Nog niet beoordeeld (begrip van vóór dit veld bestond) — neutrale default,
  // geen aanname dat het per se makkelijk of moeilijk is.
  return 'medium';
}
