import { describe, it, expect } from 'vitest';
import {
  planConceptReplace,
  planConceptWrites,
  courseMarkerFor,
  RAG_MARKER,
  classifyConceptRole,
  filterQuizReadyConcepts,
  classifyConceptDifficulty,
  normalizeDifficulty,
  isMetaCommentaryName,
  capByBestMatch,
  cosineSimilarity,
  mergeNearDuplicateConcepts,
} from '../conceptExtraction.js';

const COURSE = '9485d5c9-e0b8-47b1-9d13-452e8518f5ad';
const OTHER = 'dbb59936-d4cc-43ce-b1cc-15afa963930d';
const marker = courseMarkerFor(COURSE);
const otherMarker = courseMarkerFor(OTHER);

describe('concept classification', () => {
  it('classificeert een voorbeeldnaam als example_instance en niet als hoofdconcept', () => {
    const role = classifyConceptRole('chocolade', 'In een voorbeeld wordt chocolade gebruikt om het probleem te illustreren.');
    expect(role).toBe('example_instance');
  });

  it('classificeert kernbegrippen als main_course_concept en laat alleen die door voor quiz-topics', () => {
    const concepts = [
      { name: 'Misclassificatie', definition: 'Een fout waarbij een geval ten onrechte in een categorie wordt geplaatst.' },
      { name: 'Chocolade', definition: 'Voorbeeld uit een casus, niet een vakbegrip.' },
      { name: 'Bias', definition: 'Systematische vertekening in een oordeel of model.' },
    ];

    const filtered = filterQuizReadyConcepts(concepts);
    expect(filtered.map((c) => c.name)).toEqual(['Misclassificatie', 'Bias']);
  });

  it('laat echte vaktermen niet wegvallen als er in de tekst een voorbeeld wordt genoemd', () => {
    const role = classifyConceptRole('Misclassificatie', 'In het voorbeeld wordt misclassificatie duidelijk zichtbaar in een casus over een dataset.');
    expect(role).toBe('main_course_concept');
  });
});

describe('classifyConceptDifficulty (tekstuele vangnet-heuristiek, GEEN embedding)', () => {
  it('classificeert een kort, zelfverklarend begrip als easy', () => {
    const difficulty = classifyConceptDifficulty('Blijvend effect', 'Een effect dat blijft bestaan.');
    expect(difficulty).toBe('easy');
  });

  it('classificeert een begrip met methodologisch jargon als hard', () => {
    const difficulty = classifyConceptDifficulty(
      'Cross-over trial',
      'Een studiedesign waarbij deelnemers na randomisatie beide interventies doorlopen, met een sensitiviteitsanalyse voor carry-over effecten.'
    );
    expect(difficulty).toBe('hard');
  });

  it('classificeert een middellang begrip zonder zwaar jargon als medium', () => {
    const difficulty = classifyConceptDifficulty(
      'Steekproef',
      'Een deelverzameling van de populatie die wordt gebruikt om conclusies te trekken over die populatie.'
    );
    expect(difficulty).toBe('medium');
  });

  it('een lange definitie duwt de classificatie naar hard, ook zonder herkende jargon-term', () => {
    const longDef = 'Dit begrip vereist dat de student meerdere achtereenvolgende stappen zorgvuldig doorloopt en daarbij verschillende onderling samenhangende factoren tegen elkaar afweegt voordat er uiteindelijk een goed onderbouwde conclusie kan worden getrokken over de precieze uitkomst van de uitgevoerde analyse in deze bijzonder specifieke onderzoekscontext.';
    expect(classifyConceptDifficulty('Willekeurige term', longDef)).toBe('hard');
  });
});

describe('isMetaCommentaryName (REGRESSIE: "Methodologisch zeer uitdagend" is geen vakbegrip)', () => {
  it('herkent het gerapporteerde geval en kortere varianten daarvan', () => {
    expect(isMetaCommentaryName('Methodologisch zeer uitdagend')).toBe(true);
    expect(isMetaCommentaryName('Zeer uitdagend')).toBe(true);
    expect(isMetaCommentaryName('Uitdagend')).toBe(true);
    expect(isMetaCommentaryName('Erg belangrijk')).toBe(true);
  });

  it('laat echte vaktermen ongemoeid, ook als ze een intensiveerder of kwalificerend woord bevatten', () => {
    expect(isMetaCommentaryName('Cross-over trial')).toBe(false);
    expect(isMetaCommentaryName('Confounding')).toBe(false);
    expect(isMetaCommentaryName('Zeer lage validiteit')).toBe(false);
    expect(isMetaCommentaryName('Belangrijke confounders')).toBe(false);
    expect(isMetaCommentaryName('Methodologische kwaliteit')).toBe(false);
    expect(isMetaCommentaryName('Type I-fout')).toBe(false);
  });

  it('laat een lange zin ongemoeid (laat de RAG-verificatie die afhandelen)', () => {
    expect(isMetaCommentaryName('Dit is een zeer uitdagend en methodologisch complex vraagstuk voor studenten')).toBe(false);
  });
});

describe('capByBestMatch (docent-instelbaar maximum, "niet 1387 begrippen")', () => {
  const mk = (name, maxScore) => ({ concept: { name }, maxScore });

  it('laat de lijst ongewijzigd zonder limiet (null/0/ongeldig)', () => {
    const results = [mk('A', 0.9), mk('B', 0.5)];
    expect(capByBestMatch(results, null).kept).toEqual(results);
    expect(capByBestMatch(results, 0).kept).toEqual(results);
    expect(capByBestMatch(results, undefined).kept).toEqual(results);
    expect(capByBestMatch(results, 'geen getal').kept).toEqual(results);
  });

  it('laat de lijst ongewijzigd als het aantal kandidaten al onder de limiet ligt', () => {
    const results = [mk('A', 0.9), mk('B', 0.5)];
    const { kept, cutOff } = capByBestMatch(results, 10);
    expect(kept).toEqual(results);
    expect(cutOff).toEqual([]);
  });

  it('behoudt bij een limiet de beste RAG-matches (hoogste maxScore), niet een willekeurige selectie', () => {
    const results = [mk('Laag', 0.3), mk('Hoog', 0.9), mk('Middel', 0.6)];
    const { kept, cutOff } = capByBestMatch(results, 2);
    expect(kept.map((r) => r.concept.name)).toEqual(['Hoog', 'Middel']);
    expect(cutOff.map((r) => r.concept.name)).toEqual(['Laag']);
  });
});

describe('cosineSimilarity', () => {
  it('geeft 1 voor identieke vectoren en 0 voor loodrechte vectoren', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('geeft 0 terug voor ongeldige input i.p.v. te crashen', () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
    expect(cosineSimilarity(null, [1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('mergeNearDuplicateConcepts (REGRESSIE: "Genest/Geneste patiënt controleonderzoek" en "Cross-over onderzoek/studie")', () => {
  const mk = (name, embedding, maxScore) => ({ concept: { name }, embedding, maxScore });

  it('voegt twee kandidaten met bijna-identieke naam-embeddings ÉN grote woordoverlap samen, houdt de beste RAG-match', () => {
    const results = [
      mk('Genest patiënt controleonderzoek', [1, 0, 0], 0.7),
      mk('Geneste patiënt controleonderzoek', [0.99, 0.01, 0], 0.85),
    ];
    const { kept, merged } = mergeNearDuplicateConcepts(results);
    expect(kept).toHaveLength(1);
    expect(kept[0].concept.name).toBe('Geneste patiënt controleonderzoek');
    expect(merged).toHaveLength(1);
    expect(merged[0].concept.name).toBe('Genest patiënt controleonderzoek');
    expect(merged[0].mergedIntoName).toBe('Geneste patiënt controleonderzoek');
  });

  it('voegt een synonieme laatste-woordvariant samen ("Cross-over onderzoek" vs "Cross-over studie")', () => {
    const results = [
      mk('Cross-over onderzoek', [1, 0, 0], 0.7),
      mk('Cross-over studie', [0.99, 0.01, 0], 0.85),
    ];
    const { kept, merged } = mergeNearDuplicateConcepts(results);
    expect(kept).toHaveLength(1);
    expect(kept[0].concept.name).toBe('Cross-over studie');
    expect(merged).toHaveLength(1);
  });

  it('REGRESSIE: laat twee VERSCHILLENDE begrippen uit hetzelfde vakgebied staan, ook al scoort de cosine-similarity hoog (bug: 75 werden er 18)', () => {
    // Simuleert het echte probleem: twee losse epidemiologie-vaktermen die
    // qua embedding dicht bij elkaar liggen (zelfde smalle vakgebied) maar
    // helemaal geen woorden delen — cosine alleen zou dit ten onrechte
    // samenvoegen, de woordoverlap-eis moet dit tegenhouden.
    const results = [
      mk('Cross-over onderzoek', [1, 0, 0], 0.8),
      mk('Cohortonderzoek', [0.93, 0.01, 0], 0.75),
    ];
    const { kept, merged } = mergeNearDuplicateConcepts(results);
    expect(kept).toHaveLength(2);
    expect(merged).toHaveLength(0);
  });

  it('laat duidelijk verschillende begrippen (lage cosine-similarity én geen woordoverlap) allebei staan', () => {
    const results = [
      mk('Cross-over onderzoek', [1, 0, 0], 0.8),
      mk('Willekeurige toewijzing', [0, 1, 0], 0.6),
    ];
    const { kept, merged } = mergeNearDuplicateConcepts(results);
    expect(kept).toHaveLength(2);
    expect(merged).toHaveLength(0);
  });

  it('clustert transitief (A~B en B~C worden allemaal één cluster) en negeert kandidaten zonder embedding', () => {
    const results = [
      mk('Kernbegrip Alfa', [1, 0], 0.5),
      mk('Kernbegrip Beta', [0.99, 0.01], 0.9),
      mk('Kernbegrip Gamma', [0.98, 0.02], 0.6),
      mk('D-zonder-embedding', undefined, 0.7),
    ];
    const { kept, merged } = mergeNearDuplicateConcepts(results);
    expect(kept.map((r) => r.concept.name).sort()).toEqual(['D-zonder-embedding', 'Kernbegrip Beta']);
    expect(merged).toHaveLength(2);
  });

  it('REGRESSIE: een entry met maxScore=Infinity (pseudo-kandidaat voor een AL BESTAAND begrip) wint altijd als representant van het cluster', () => {
    // server/index.js voegt bestaande cursusbegrippen toe als pseudo-kandidaat
    // met maxScore=Infinity, zodat een nieuwe LLM-kandidaat die in een latere
    // hergenereer-run net iets anders geformuleerd is (bug: "Genest ..." in
    // run 1, "Geneste ..." in run 3, nooit met elkaar vergeleken) niet als
    // nieuwe, dubbele rij wordt ingevoegd naast de bestaande.
    const results = [
      mk('Genest patiënt controleonderzoek', [1, 0, 0], 0.7),
      mk('Geneste patiënt controleonderzoek (bestaand)', [0.99, 0.01, 0], Infinity),
    ];
    const { kept, merged } = mergeNearDuplicateConcepts(results);
    expect(kept).toHaveLength(1);
    expect(kept[0].concept.name).toBe('Geneste patiënt controleonderzoek (bestaand)');
    expect(merged).toHaveLength(1);
    expect(merged[0].concept.name).toBe('Genest patiënt controleonderzoek');
  });
});

describe('normalizeDifficulty', () => {
  it('herkent de canonieke waarden en Nederlandse synoniemen', () => {
    expect(normalizeDifficulty('hard')).toBe('hard');
    expect(normalizeDifficulty('moeilijk')).toBe('hard');
    expect(normalizeDifficulty('gemiddeld')).toBe('medium');
    expect(normalizeDifficulty('makkelijk')).toBe('easy');
  });

  it('geeft null terug voor een onherkende waarde (zodat de heuristiek als vangnet dient)', () => {
    expect(normalizeDifficulty('')).toBeNull();
    expect(normalizeDifficulty(undefined)).toBeNull();
    expect(normalizeDifficulty('onzin')).toBeNull();
  });
});

describe('planConceptReplace', () => {
  it('verwijdert verouderde RAG-begrippen die alleen bij deze cursus horen', () => {
    const tagged = [
      { id: 'a', name: 'Oud A', key_points: [marker, RAG_MARKER] },
      { id: 'b', name: 'Oud B', key_points: [marker, RAG_MARKER] },
    ];
    const { toDeleteIds, toUntag } = planConceptReplace(tagged, { courseMarker: marker });
    expect(toDeleteIds).toEqual(['a', 'b']);
    expect(toUntag).toEqual([]);
  });

  it('behoudt begrippen waarvan de naam in keepNames staat (net geschreven of opnieuw voorgesteld)', () => {
    const tagged = [
      { id: 'a', name: 'Behoud Mij', key_points: [marker, RAG_MARKER] },
      { id: 'b', name: 'Verouderd', key_points: [marker, RAG_MARKER] },
    ];
    const keepNames = new Set(['behoud mij']);
    const { toDeleteIds, toUntag } = planConceptReplace(tagged, { courseMarker: marker, keepNames });
    expect(toDeleteIds).toEqual(['b']);
    expect(toUntag).toEqual([]);
  });

  it('laat gedeelde begrippen staan en verwijdert alleen de markering van deze cursus', () => {
    const tagged = [
      { id: 'shared', name: 'Gedeeld', key_points: [marker, otherMarker, RAG_MARKER] },
    ];
    const { toDeleteIds, toUntag } = planConceptReplace(tagged, { courseMarker: marker });
    expect(toDeleteIds).toEqual([]);
    expect(toUntag).toHaveLength(1);
    expect(toUntag[0].id).toBe('shared');
    expect(toUntag[0].key_points).toContain(otherMarker);
    expect(toUntag[0].key_points).not.toContain(marker);
    expect(toUntag[0].key_points).toContain(RAG_MARKER);
  });

  it('laat handmatige begrippen (zonder RAG-markering) volledig ongemoeid', () => {
    const tagged = [{ id: 'manual', name: 'Handmatig', key_points: [marker] }];
    const { toDeleteIds, toUntag } = planConceptReplace(tagged, { courseMarker: marker });
    expect(toDeleteIds).toEqual([]);
    expect(toUntag).toEqual([]);
  });
});

describe('planConceptWrites', () => {
  it('voegt nieuwe begrippen in met cursus- en RAG-markering', () => {
    const valid = [
      { name: 'Type I-fout', category: 'statistiek', definition: 'def1' },
      { name: 'Type II-fout', category: 'statistiek', definition: 'def2' },
    ];
    const { toInsert, toUpdate, skipped } = planConceptWrites(valid, [], { courseMarker: marker });
    expect(toInsert).toHaveLength(2);
    expect(toUpdate).toHaveLength(0);
    expect(skipped).toBe(0);
    expect(toInsert[0].key_points).toEqual([marker, RAG_MARKER]);
  });

  it('REGRESSIE: neemt concept_role én difficulty mee in zowel insert als update (niet laten vallen zoals eerder gebeurde)', () => {
    const validNew = [{ name: 'Nieuw Begrip', definition: 'def', concept_role: 'method_term', difficulty: 'hard' }];
    const { toInsert } = planConceptWrites(validNew, [], { courseMarker: marker });
    expect(toInsert[0].concept_role).toBe('method_term');
    expect(toInsert[0].difficulty).toBe('hard');

    const existing = [{ id: 'x', name: 'Bestaand Begrip', key_points: [otherMarker, RAG_MARKER] }];
    const validShared = [{ name: 'Bestaand Begrip', definition: 'def', concept_role: 'definition_term', difficulty: 'easy' }];
    const { toUpdate } = planConceptWrites(validShared, existing, { courseMarker: marker });
    expect(toUpdate[0].concept_role).toBe('definition_term');
    expect(toUpdate[0].difficulty).toBe('easy');
  });

  it('slaat begrippen over die al voor deze cursus gemarkeerd zijn EN al de juiste classificatie hebben (geen duplicaat, geen overbodige update)', () => {
    const existing = [{ id: 'm', name: 'Gemiddelde', key_points: [marker], concept_role: 'module_concept', difficulty: 'easy' }];
    const valid = [{ name: 'Gemiddelde', category: 'c', definition: 'd', concept_role: 'module_concept', difficulty: 'easy' }];
    const { toInsert, toUpdate, skipped } = planConceptWrites(valid, existing, { courseMarker: marker });
    expect(toInsert).toHaveLength(0);
    expect(toUpdate).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it('REGRESSIE: een al-gemarkeerd begrip met een verouderde/ontbrekende rol of moeilijkheidsgraad wordt ververst, NIET gedupliceerd (bug: alle 79 bestaande begrippen bleven difficulty=NULL houden bij hergenereren)', () => {
    // key_points bevat de courseMarker al (alreadyTaggedForCourse) — vóór deze
    // fix stopte de loop hier meteen met skipped++, zonder concept_role/
    // difficulty ooit opnieuw te berekenen of weg te schrijven.
    const existing = [{ id: 'stale', name: 'Cross-over trial', key_points: [marker, RAG_MARKER], concept_role: null, difficulty: null }];
    const valid = [{ name: 'Cross-over trial', definition: 'd', concept_role: 'method_term', difficulty: 'hard' }];
    const { toInsert, toUpdate, skipped } = planConceptWrites(valid, existing, { courseMarker: marker });
    expect(toInsert).toHaveLength(0); // geen duplicaat-insert
    expect(skipped).toBe(1); // telt nog steeds als "niet opnieuw ingevoegd"
    expect(toUpdate).toHaveLength(1);
    expect(toUpdate[0].id).toBe('stale');
    expect(toUpdate[0].concept_role).toBe('method_term');
    expect(toUpdate[0].difficulty).toBe('hard');
    expect(toUpdate[0].key_points).toEqual([marker, RAG_MARKER]); // ongewijzigd
  });

  it('deelt een bestaand RAG-begrip van een andere cursus door beide markeringen toe te voegen', () => {
    const existing = [{ id: 'x', name: 'Variantie', key_points: [otherMarker, RAG_MARKER] }];
    const valid = [{ name: 'variantie', category: 'c', definition: 'd' }];
    const { toInsert, toUpdate } = planConceptWrites(valid, existing, { courseMarker: marker });
    expect(toInsert).toHaveLength(0);
    expect(toUpdate).toHaveLength(1);
    expect(toUpdate[0].id).toBe('x');
    expect(toUpdate[0].key_points).toContain(otherMarker);
    expect(toUpdate[0].key_points).toContain(marker);
    expect(toUpdate[0].key_points).toContain(RAG_MARKER);
  });

  it('een bestaand HANDMATIG begrip (andere cursus) blijft handmatig: GEEN RAG-markering toevoegen', () => {
    const existing = [{ id: 'man', name: 'Steekproef', key_points: [otherMarker] }];
    const valid = [{ name: 'Steekproef', category: 'c', definition: 'd' }];
    const { toUpdate } = planConceptWrites(valid, existing, { courseMarker: marker });
    expect(toUpdate).toHaveLength(1);
    expect(toUpdate[0].key_points).toContain(otherMarker);
    expect(toUpdate[0].key_points).toContain(marker);
    expect(toUpdate[0].key_points).not.toContain(RAG_MARKER);
  });

  it('ontdubbelt herhaalde namen binnen één batch', () => {
    const valid = [
      { name: 'Mediaan', category: 'c', definition: 'd' },
      { name: 'mediaan', category: 'c', definition: 'd' },
    ];
    const { toInsert, skipped } = planConceptWrites(valid, [], { courseMarker: marker });
    expect(toInsert).toHaveLength(1);
    expect(skipped).toBe(1);
  });
});

describe('extractie-flow (schrijven-eerst, daarna keep-aware opruimen)', () => {
  it('REGRESSIE: nieuwe extractie persisteert — opruimen verwijdert de net geschreven begrippen niet', () => {
    // Begin: cursus leeg. Extractie levert 2 begrippen → beide ingevoegd.
    const valid = [
      { name: 'Begrip A', category: 'c', definition: 'd' },
      { name: 'Begrip B', category: 'c', definition: 'd' },
    ];
    const { toInsert } = planConceptWrites(valid, [], { courseMarker: marker });
    expect(toInsert).toHaveLength(2);

    // Na de insert staan ze in de DB en zitten in keepNames. De opruimstap mag
    // ze NIET verwijderen.
    const keepNames = new Set(valid.map((c) => c.name.toLowerCase().trim()));
    const taggedAfterInsert = [
      { id: 'newA', name: 'Begrip A', key_points: [marker, RAG_MARKER] },
      { id: 'newB', name: 'Begrip B', key_points: [marker, RAG_MARKER] },
    ];
    const { toDeleteIds, toUntag } = planConceptReplace(taggedAfterInsert, { courseMarker: marker, keepNames });
    expect(toDeleteIds).toEqual([]);
    expect(toUntag).toEqual([]);
  });

  it('REGRESSIE: hergenereren behoudt opnieuw voorgestelde begrippen en wist alleen verouderde', () => {
    // Bestaand (RAG, deze cursus): "Begrip A" + "Begrip Oud".
    const existing = [
      { id: 'A', name: 'Begrip A', key_points: [marker, RAG_MARKER] },
      { id: 'OUD', name: 'Begrip Oud', key_points: [marker, RAG_MARKER] },
    ];
    // Nieuwe extractie stelt "Begrip A" (opnieuw) + "Begrip C" (nieuw) voor.
    const valid = [
      { name: 'Begrip A', category: 'c', definition: 'd' },
      { name: 'Begrip C', category: 'c', definition: 'd' },
    ];
    const { toInsert, skipped } = planConceptWrites(valid, existing, { courseMarker: marker });
    // "Begrip A" al getagd → overgeslagen (behouden); "Begrip C" → nieuw.
    expect(toInsert.map((c) => c.name)).toEqual(['Begrip C']);
    expect(skipped).toBe(1);

    // Opruimen: keepNames = {begrip a, begrip c}. "Begrip Oud" is niet meer
    // voorgesteld → verwijderd; "Begrip A" behouden.
    const keepNames = new Set(valid.map((c) => c.name.toLowerCase().trim()));
    const taggedAfter = [
      ...existing,
      { id: 'C', name: 'Begrip C', key_points: [marker, RAG_MARKER] },
    ];
    const { toDeleteIds } = planConceptReplace(taggedAfter, { courseMarker: marker, keepNames });
    expect(toDeleteIds).toEqual(['OUD']);
  });

  it('REGRESSIE: een handmatig begrip dat per cursus gedeeld wordt, overleeft een latere replace', () => {
    // Stap 1: handmatig begrip uit andere cursus wordt voor deze cursus gedeeld.
    const existing = [{ id: 'man', name: 'Hypothese', key_points: [otherMarker] }];
    const valid = [{ name: 'Hypothese', category: 'c', definition: 'd' }];
    const { toUpdate } = planConceptWrites(valid, existing, { courseMarker: marker });
    const updatedKeyPoints = toUpdate[0].key_points; // [otherMarker, marker], GEEN RAG
    expect(updatedKeyPoints).not.toContain(RAG_MARKER);

    // Stap 2: latere replace waarbij "Hypothese" NIET meer voorgesteld wordt.
    const tagged = [{ id: 'man', name: 'Hypothese', key_points: updatedKeyPoints }];
    const { toDeleteIds, toUntag } = planConceptReplace(tagged, { courseMarker: marker, keepNames: new Set() });
    // Handmatig (geen RAG-markering) → blijft volledig ongemoeid.
    expect(toDeleteIds).toEqual([]);
    expect(toUntag).toEqual([]);
  });
});
