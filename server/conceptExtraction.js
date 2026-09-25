// Pure helpers voor begrippenextractie (RAG-beheer → Begrippen → "Ik leg uit").
// Geen DB-calls hier, zodat vitest ze direct kan testen zonder Supabase-mock.
//
// Achtergrond (de bug die deze helpers oplossen): bij "Hergenereer
// begrippenlijst" (replace-modus) werden de zojuist ingevoegde begrippen
// meteen weer verwijderd, omdat de opruimstap álle RAG-begrippen van de cursus
// wiste — inclusief de nieuwe. Daardoor meldde de UI "68 toegevoegd" terwijl de
// database leeg bleef en de Begrippen-tab + "Ik leg uit" niets toonden.
//
// De oplossing: de opruimstap draait nu vóór de invoeg-stap én is cursusbewust:
//  - alleen RAG-geëxtraheerde begrippen worden opgeruimd (handmatige blijven);
//  - een begrip dat met een ándere cursus gedeeld wordt, verliest alleen de
//    markering van déze cursus en blijft bestaan (gedeelde begrippen beschermen).

export const RAG_MARKER = '[RAG-geëxtraheerd uit cursusmateriaal]';
export const QUIZ_READY_CONCEPT_ROLES = new Set([
  'main_course_concept',
  'module_concept',
  'definition_term',
  'method_term',
  'latent_concept',
]);

export function courseMarkerFor(courseId) {
  return `course_id:${courseId}`;
}

function isCourseMarker(kp) {
  return typeof kp === 'string' && kp.startsWith('course_id:');
}

const normName = (name) => String(name || '').toLowerCase().trim();

export function normalizeConceptRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (!value) return 'module_concept';
  if (['main_course_concept', 'hauptconcept', 'kernbegrip', 'core_concept'].includes(value)) return 'main_course_concept';
  if (['module_concept', 'modulebegrip', 'module-specific concept'].includes(value)) return 'module_concept';
  if (['definition_term', 'definitiebegrip', 'definition', 'definitional_term'].includes(value)) return 'definition_term';
  if (['method_term', 'methodebegrip', 'method', 'procedural_term'].includes(value)) return 'method_term';
  if (['latent_concept', 'latente concept', 'latent concept'].includes(value)) return 'latent_concept';
  if (['example_instance', 'voorbeeld', 'casusvoorbeeld', 'example_only', 'illustrative_example'].includes(value)) return 'example_instance';
  return value;
}

export function classifyConceptRole(name, definition = '', context = {}) {
  const text = `${name || ''} ${definition || ''} ${context?.documentTitle || ''} ${context?.definitionHint || ''}`.toLowerCase();
  if (!text.trim()) return 'module_concept';

  const stronglyConceptualName = /\b(misclassificatie|classificatie|validiteit|bias|confounding|effect|variabele|criterium|analyse|method|procedure|model|definitie|score|outcome|assumptie|vergelijking|synthese|inferentie|sensitiviteit|specificiteit|toetsing|interventie|systeem|verklaring|kernconcept)\b/.test(String(name || '').toLowerCase());

  const exampleSignals = [
    /\bvoorbeeld\b/, /\bcasus\b/, /\billustratie\b/, /\bscenario\b/, /\binstantie\b/, /\be\.g\./, /\bbv\./,
    /\bproduct\b/, /\bbedrijf\b/, /\bdataset\b/, /\bonderzoeksvoorbeeld\b/, /\bperson\b/, /\bmerk\b/, /\bnaam\b/,
  ];
  const definitionSignals = [
    /\bdefinitie\b/, /\bbetekent\b/, /\bhoudt in\b/, /\bwordt gedefinieerd\b/, /\bgericht op\b/, /\brefereert aan\b/,
    /\bconcept\b/, /\btheorie\b/, /\bmodel\b/, /\bmethode\b/, /\bprocedure\b/, /\bcriterium\b/, /\bkenmerk\b/,
    /\bvaliditeit\b/, /\bmisclassificatie\b/, /\bbias\b/, /\bconfounding\b/, /\beffect\b/, /\bvariabele\b/,
  ];
  const methodSignals = [/\bmethod\b/, /\bprocedure\b/, /\btechniek\b/, /\banalyse\b/, /\bmodel\b/, /\bframework\b/, /\bbenadering\b/, /\balgoritme\b/];

  if (stronglyConceptualName || definitionSignals.some((pattern) => pattern.test(text))) {
    return methodSignals.some((pattern) => pattern.test(text)) ? 'method_term' : 'main_course_concept';
  }

  if (exampleSignals.some((pattern) => pattern.test(text))) {
    return 'example_instance';
  }

  if (methodSignals.some((pattern) => pattern.test(text))) {
    return 'method_term';
  }

  return 'module_concept';
}

export const DIFFICULTY_TIERS = new Set(['easy', 'medium', 'hard']);

export function normalizeDifficulty(value) {
  const v = String(value || '').trim().toLowerCase();
  if (DIFFICULTY_TIERS.has(v)) return v;
  if (['makkelijk', 'gemakkelijk', 'eenvoudig', 'simple'].includes(v)) return 'easy';
  if (['gemiddeld', 'medium', 'matig'].includes(v)) return 'medium';
  if (['moeilijk', 'lastig', 'complex', 'hard', 'difficult'].includes(v)) return 'hard';
  return null;
}

// Tekstuele vangnet-heuristiek voor moeilijkheidsgraad — gebruikt wanneer de
// LLM geen (geldige) `difficulty` meegaf (bv. handmatig toegevoegde begrippen,
// of oudere begrippen van vóór dit veld bestond). Beoordeelt uitsluitend de
// TEKST (definitielengte + methodologisch/statistisch jargon), NIET de
// embedding-vector: er is geen gevalideerde manier om moeilijkheidsgraad uit
// de rauwe vectorwiskunde af te leiden, dat zou schijnprecisie zijn.
export function classifyConceptDifficulty(name, definition = '') {
  const text = `${name || ''} ${definition || ''}`.toLowerCase();
  const wordCount = String(definition || '').trim().split(/\s+/).filter(Boolean).length;

  const hardSignals = /\b(interactie|confounding|effectmodificatie|multivariabel|multivariaat|regressie|standaardfout|betrouwbaarheidsinterval|hypothesetoetsing|steekproefkader|randomisatie|cross-?over|non-inferiority|intention-to-treat|per-protocol|sensitiviteitsanalyse|multicollineariteit|heterogeniteit|meta-analyse)\b/;
  const mediumSignals = /\b(validiteit|betrouwbaarheid|bias|correlatie|associatie|steekproef|populatie|design|studieopzet|variabele|criterium|toetsing|schatting)\b/;

  if (hardSignals.test(text) || wordCount > 35) return 'hard';
  if (mediumSignals.test(text) || wordCount > 15) return 'medium';
  return 'easy';
}

// Vangnet tegen begripsnamen die geen vakterm zijn maar COMMENTAAR op de stof
// (bv. "Methodologisch zeer uitdagend"): de latent_concept-rol in de prompt
// geeft de LLM bewust ruimte voor concepten zonder kopje, en dat leidt af en
// toe tot een waardeoordeel dat door de RAG-verificatie heen glipt (het staat
// immers letterlijk in de tekst, alleen niet als vakterm). Criterium: zou een
// docent een student ooit vragen "Wat bedoelen we met [naam]?" met een
// eenduidig feitelijk antwoord? Een naam die UITSLUITEND bestaat uit een
// intensiveerder/kwalificerende bijwoord + evaluatief bijvoeglijk naamwoord
// (zonder concreet vakinhoudelijk zelfstandig naamwoord) is dat per definitie
// niet. Bewust kort (≤4 woorden): een echte term is zelden langer, en bij
// twijfel laten we de RAG-verificatie het laatste woord houden.
const META_INTENSIFIERS = new Set(['zeer', 'erg', 'heel', 'bijzonder', 'ontzettend', 'buitengewoon', 'uiterst', 'behoorlijk', 'redelijk', 'vrij', 'nogal', 'tamelijk']);
const META_EVALUATIVE_WORDS = new Set([
  'uitdagend', 'moeilijk', 'lastig', 'complex', 'ingewikkeld', 'simpel', 'eenvoudig', 'makkelijk', 'gemakkelijk',
  'belangrijk', 'belangrijke', 'cruciaal', 'essentieel', 'relevant', 'interessant', 'boeiend', 'saai',
  'duidelijk', 'onduidelijk', 'verwarrend', 'opvallend', 'nuttig', 'waardevol', 'challenging', 'difficult',
  'important', 'crucial', 'essential', 'interesting', 'confusing',
]);
const META_QUALIFIERS = new Set(['methodologisch', 'theoretisch', 'praktisch', 'inhoudelijk', 'statistisch', 'conceptueel', 'analytisch', 'methodologically', 'theoretically', 'practically']);

export function isMetaCommentaryName(name) {
  const words = String(name || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  const isJudgmentWord = (w) => META_INTENSIFIERS.has(w) || META_EVALUATIVE_WORDS.has(w) || META_QUALIFIERS.has(w);
  return words.every(isJudgmentWord) && words.some((w) => META_EVALUATIVE_WORDS.has(w));
}

// Beperk het aantal geaccepteerde kandidaten tot maxConcepts, met behoud van
// de best onderbouwde begrippen (hoogste RAG-similarity/maxScore eerst) —
// zodat een docent die een limiet instelt niet een willekeurige selectie
// krijgt, maar de begrippen met de sterkste dekking in het bronmateriaal.
// Geen limiet (null/0/ongeldig, of minder kandidaten dan de limiet) laat de
// lijst ongewijzigd. Pure functie zodat de afkaplogica los van de Express-
// handler (POST /api/admin/extract-concepts) getest kan worden.
export function capByBestMatch(results, maxConcepts) {
  const list = Array.isArray(results) ? results : [];
  const max = Number(maxConcepts);
  if (!Number.isFinite(max) || max <= 0 || list.length <= max) {
    return { kept: list, cutOff: [] };
  }
  const sorted = [...list].sort((a, b) => (b?.maxScore || 0) - (a?.maxScore || 0));
  return { kept: sorted.slice(0, max), cutOff: sorted.slice(max) };
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// Woordoverlap tussen twee begripsnamen (op spatie/streepje gesplitst,
// verzameling-overlap t.o.v. de langste naam). Puur lexicaal, geen betekenis.
function nameWordOverlapRatio(nameA, nameB) {
  const words = (s) => String(s || '').toLowerCase().split(/[\s-]+/).filter(Boolean);
  const wordsA = new Set(words(nameA));
  const wordsB = new Set(words(nameB));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared++;
  return shared / Math.max(wordsA.size, wordsB.size);
}

// Vind kandidaat-begrippen die hetzelfde betekenen — spellings-/verbuigings-
// varianten ("Genest patiënt controleonderzoek" vs "Geneste patiënt
// controleonderzoek") of synonieme bewoording ("Cross-over onderzoek" vs
// "Cross-over studie"). VEREIST BEIDE signalen, niet één:
//   1) hoge cosine-similarity tussen de naam-embeddings (dezelfde embedding
//      die al voor de RAG-verificatie wordt berekend, geen extra API-call);
//   2) voldoende lexicale woordoverlap.
// Reden voor de dubbele eis: in de praktijk scoren twee VERSCHILLENDE
// vaktermen uit hetzelfde smalle vakgebied (bv. twee losse epidemiologie-
// begrippen) op een kort-zin-embedding als text-embedding-3-small vaak óók
// al hoog (0.85+) puur omdat ze uit hetzelfde domein komen — cosine alleen
// bleek in de praktijk veel te agressief (75 werden er 18). Woordoverlap
// vangt dat: twee namen die grotendeels dezelfde woorden delen én semantisch
// dicht bij elkaar liggen, zijn zeer waarschijnlijk hetzelfde begrip; twee
// namen die alleen "toevallig" in dezelfde vakhoek liggen delen geen woorden.
// Houdt per cluster alleen de kandidaat met de beste RAG-match (hoogste
// maxScore) — zo "verspilt" een docent-ingesteld maximum aantal begrippen
// (capByBestMatch) geen plek aan duplicaten van hetzelfde begrip.
export function mergeNearDuplicateConcepts(results, { cosineThreshold = 0.90, wordOverlapThreshold = 0.5 } = {}) {
  const list = Array.isArray(results) ? results : [];
  const n = list.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i];
    return i;
  };
  const union = (i, j) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };

  for (let i = 0; i < n; i++) {
    if (!Array.isArray(list[i]?.embedding)) continue;
    for (let j = i + 1; j < n; j++) {
      if (!Array.isArray(list[j]?.embedding)) continue;
      if (cosineSimilarity(list[i].embedding, list[j].embedding) < cosineThreshold) continue;
      if (nameWordOverlapRatio(list[i]?.concept?.name, list[j]?.concept?.name) < wordOverlapThreshold) continue;
      union(i, j);
    }
  }

  const clusters = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(list[i]);
  }

  const kept = [];
  const merged = [];
  for (const members of clusters.values()) {
    if (members.length === 1) {
      kept.push(members[0]);
      continue;
    }
    const sorted = [...members].sort((a, b) => (b?.maxScore || 0) - (a?.maxScore || 0));
    kept.push(sorted[0]);
    for (const m of sorted.slice(1)) {
      merged.push({ ...m, mergedIntoName: sorted[0]?.concept?.name });
    }
  }
  return { kept, merged };
}

export function filterQuizReadyConcepts(concepts) {
  return (concepts || [])
    .map((concept) => {
      const role = normalizeConceptRole(concept?.concept_role || concept?.category || classifyConceptRole(concept?.name, concept?.definition));
      return { ...concept, concept_role: role, category: concept?.category || role };
    })
    .filter((concept) => QUIZ_READY_CONCEPT_ROLES.has(concept.concept_role) && concept.concept_role !== 'example_instance');
}

// Bepaalt welke bestaande RAG-begrippen van een cursus opgeruimd moeten worden
// bij een replace/hergenereer-actie. Wordt aangeroepen NÁ de schrijfstap, zodat
// een mislukte insert de cursus nooit leeg achterlaat.
//
// Input:
//  - `taggedConcepts` = rijen ({id, name, key_points}) die de `courseMarker`
//    bevatten (inclusief de zojuist geschreven/bijgewerkte rijen);
//  - `keepNames` = set/array met de (genormaliseerde) namen die in deze run zijn
//    geëxtraheerd; deze worden NOOIT verwijderd of losgekoppeld. Daardoor blijven
//    (a) de zojuist ingevoegde begrippen en (b) opnieuw voorgestelde bestaande
//    begrippen behouden, terwijl alleen verouderde (niet meer voorgestelde)
//    RAG-begrippen worden opgeruimd.
// Geeft terug:
//  - toDeleteIds: begrippen die ALLEEN bij deze cursus horen → volledig wissen;
//  - toUntag: begrippen die ook bij een andere cursus horen → alleen de
//    markering van deze cursus verwijderen (rij blijft bestaan).
// Handmatige begrippen (zonder RAG-markering) worden altijd met rust gelaten.
export function planConceptReplace(taggedConcepts, { courseMarker, ragMarker = RAG_MARKER, keepNames } = {}) {
  if (!courseMarker) throw new Error('courseMarker is verplicht');
  const keep = keepNames instanceof Set
    ? keepNames
    : new Set((keepNames || []).map(normName));
  const toDeleteIds = [];
  const toUntag = [];
  for (const concept of taggedConcepts || []) {
    const kps = Array.isArray(concept.key_points) ? concept.key_points : [];
    if (!kps.includes(courseMarker)) continue; // defensief: hoort niet bij deze cursus
    if (!kps.includes(ragMarker)) continue;    // handmatig begrip → niet opruimen
    if (keep.has(normName(concept.name))) continue; // opnieuw voorgesteld of net geschreven → behouden
    const otherCourseMarkers = kps.filter((kp) => isCourseMarker(kp) && kp !== courseMarker);
    if (otherCourseMarkers.length > 0) {
      toUntag.push({ id: concept.id, key_points: kps.filter((kp) => kp !== courseMarker) });
    } else {
      toDeleteIds.push(concept.id);
    }
  }
  return { toDeleteIds, toUntag };
}

// Bepaalt welke begrippen ingevoegd, bijgewerkt of overgeslagen moeten worden.
// Wordt aangeroepen NA de opruimstap, zodat `existingConcepts` de actuele staat
// weerspiegelt (oude RAG-begrippen van deze cursus zijn dan al verwijderd).
//
//  - Begrip al gemarkeerd voor deze cursus (bv. handmatig) → overslaan/behouden;
//  - Begrip bestaat al onder dezelfde naam (andere cursus of globaal) → bijwerken
//    door deze cursus-markering toe te voegen (gedeeld begrip). De RAG-markering
//    wordt alleen toegevoegd als het bestaande begrip die al heeft; een handmatig
//    begrip blijft dus handmatig (en wordt later nooit als RAG opgeruimd);
//  - Anders → nieuw invoegen met [courseMarker, ragMarker].
export function planConceptWrites(validConcepts, existingConcepts, { courseMarker, ragMarker = RAG_MARKER } = {}) {
  if (!courseMarker) throw new Error('courseMarker is verplicht');
  const norm = (name) => String(name || '').toLowerCase().trim();

  const existingByName = new Map();
  const alreadyTaggedForCourse = new Set();
  for (const c of existingConcepts || []) {
    const key = norm(c.name);
    if (!key) continue;
    existingByName.set(key, c);
    if ((Array.isArray(c.key_points) ? c.key_points : []).includes(courseMarker)) {
      alreadyTaggedForCourse.add(key);
    }
  }

  const toInsert = [];
  const toUpdate = [];
  const seenInBatch = new Set();
  let skipped = 0;

  for (const c of validConcepts || []) {
    const key = norm(c.name);
    if (!key) { skipped++; continue; }

    const role = normalizeConceptRole(c.concept_role || c.category || classifyConceptRole(c.name, c.definition));
    const difficulty = normalizeDifficulty(c.difficulty) || classifyConceptDifficulty(c.name, c.definition);

    if (alreadyTaggedForCourse.has(key)) {
      // Al gemarkeerd voor deze cursus → geen nieuwe insert en key_points blijft
      // ongewijzigd, MAAR de rol/moeilijkheidsgraad wél verversen als de LLM die
      // nu anders beoordeelt. Zonder dit blijft een begrip van vóór dit veld
      // bestond (of vóór de vorige classificatie-fix) permanent op zijn oude/
      // ontbrekende waarde staan, hoe vaak je ook hergenereert — precies de bug
      // die difficulty voor alle bestaande begrippen op NULL liet staan.
      const existing = existingByName.get(key);
      if (existing && (existing.concept_role !== role || existing.difficulty !== difficulty)) {
        toUpdate.push({
          id: existing.id,
          key_points: Array.isArray(existing.key_points) ? existing.key_points : [],
          category: existing.category || role,
          concept_role: role,
          difficulty,
        });
      }
      skipped++;
      continue;
    }
    if (seenInBatch.has(key)) { skipped++; continue; }
    seenInBatch.add(key);

    const existing = existingByName.get(key);
    if (existing) {
      const existingKps = Array.isArray(existing.key_points) ? existing.key_points : [];
      const markers = existingKps.includes(ragMarker)
        ? [courseMarker, ragMarker]
        : [courseMarker];
      const merged = [...new Set([...existingKps, ...markers])];
      toUpdate.push({
        id: existing.id,
        key_points: merged,
        category: existing.category || role,
        concept_role: role,
        difficulty,
      });
    } else {
      toInsert.push({
        name: String(c.name).trim(),
        definition: String(c.definition || '').trim(),
        key_points: [courseMarker, ragMarker],
        examples: [],
        category: role,
        concept_role: role,
        difficulty,
      });
    }
  }

  return { toInsert, toUpdate, skipped };
}
