import { describe, it, expect } from 'vitest';
import { routeSource, functionSource } from './helpers/serverSource.js';
import {
  buildDocumentWindows, conceptKey, mergeByKey, parseSynonymGroups, applySynonymGroups,
  selectConcepts, overlapPenalty, planSureMerges, mapLimit, WINDOW_CHARS, isUsableConceptName,
  buildMergeSuggestions, buildDuplicateSuggestionPrompt,
} from '../concepts/conceptConsolidation.js';

describe('buildDocumentWindows — de hele cursus wordt gelezen (regressie E&B1: 5% gezien)', () => {
  it('elk document komt voor, in chunk-volgorde, en grote documenten worden in stukken gedeeld', () => {
    const chunks = [];
    for (let d = 1; d <= 16; d++) {
      for (let i = 0; i < 10; i++) chunks.push({ document_id: `doc${d}`, chunk_index: 9 - i, content: `D${d}C${9 - i} ` + 'x'.repeat(1700) });
    }
    const windows = buildDocumentWindows(chunks, WINDOW_CHARS);
    const docs = new Set(windows.map((w) => w.documentId));
    expect(docs.size).toBe(16);
    // Alle tekst van alle documenten zit in de vensters.
    const all = windows.map((w) => w.text).join('');
    for (let d = 1; d <= 16; d++) for (let i = 0; i < 10; i++) expect(all).toContain(`D${d}C${i} `);
    expect(windows.every((w) => w.text.length <= WINDOW_CHARS)).toBe(true);
    // Volgorde binnen een document volgt chunk_index.
    const first = windows.find((w) => w.documentId === 'doc9').text;
    expect(first.indexOf('D9C0 ')).toBeLessThan(first.indexOf('D9C1 '));
  });
});

describe('conceptKey — zekere spellingvarianten', () => {
  it.each([
    ['genest patiënt controleonderzoek', 'Geneste Patiënt Controleonderzoek'],
    ['Case control onderzoek', 'case-control onderzoek'],
    ['cross-overtrial', 'Cross-over trial'],
    ['controles', 'controle'],
    ['normale verdelingen', 'normale verdeling'],
    ['RCT', 'rct'],
    ['risico’s', 'risico'],
    ['Deelgroepen', 'deelgroepen'],
  ])('%s = %s', (a, b) => expect(conceptKey(a)).toBe(conceptKey(b)));

  it.each([
    ['parametrische maten', 'non-parametrische maten'],
    ['kwartiel', 'eerste kwartiel'],
    ['cohort', 'cohortonderzoek'],
    ['gemiddelde', 'mediaan'],
  ])('%s ≠ %s', (a, b) => expect(conceptKey(a)).not.toBe(conceptKey(b)));
});

describe('mergeByKey', () => {
  it('voegt varianten samen, bewaart de andere naam als alias en verenigt documenten', () => {
    const out = mergeByKey([
      { name: 'genest patiënt controleonderzoek', definition: 'kort', documentIds: ['d1'] },
      { name: 'Geneste Patiënt Controleonderzoek', definition: 'een langere definitie', documentIds: ['d2'] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Geneste Patiënt Controleonderzoek');
    expect(out[0].aliases).toEqual(['genest patiënt controleonderzoek']);
    expect(out[0].documentIds.sort()).toEqual(['d1', 'd2']);
  });
});

describe('synoniemen via het taalmodel', () => {
  const names = ['Randomized Controlled Trial', 'RCT', 'standaardafwijking', 'standaarddeviatie', 'parametrische maten', 'non-parametrische maten'];

  it('parseSynonymGroups accepteert alleen namen uit de lijst en nooit dubbel', () => {
    const raw = 'Hier: [{"preferred":"Randomized Controlled Trial","others":["RCT","Verzonnen"]},{"preferred":"rct","others":["standaardafwijking"]},{"preferred":"standaardafwijking","others":["standaarddeviatie"]}]';
    expect(parseSynonymGroups(raw, names)).toEqual([
      { preferred: 'Randomized Controlled Trial', others: ['RCT'] },
      { preferred: 'standaardafwijking', others: ['standaarddeviatie'] },
    ]);
    expect(parseSynonymGroups('geen json', names)).toEqual([]);
  });

  it('bestaand begrip wint: nieuwe synoniemen worden alias, niet ingevoegd', () => {
    const cands = [
      { name: 'RCT', definition: 'x', documentIds: ['d3'] },
      { name: 'standaarddeviatie', definition: 'y', documentIds: ['d5'] },
      { name: 'standaardafwijking', definition: 'z', documentIds: ['d5', 'd9'] },
    ];
    const groups = [
      { preferred: 'Randomized Controlled Trial', others: ['RCT'] },
      { preferred: 'standaardafwijking', others: ['standaarddeviatie'] },
    ];
    const r = applySynonymGroups(cands, ['Randomized Controlled Trial'], groups);
    expect(r.kept.map((c) => c.name)).toEqual(['standaardafwijking']);
    expect(r.kept[0].aliases).toEqual(['standaarddeviatie']);
    expect(r.kept[0].documentIds.sort()).toEqual(['d5', 'd9']);
    expect(r.toExisting.get('Randomized Controlled Trial')).toEqual({ aliases: ['RCT'], documentIds: ['d3'] });
  });
});

describe('selectConcepts — hoge match en lage overlap, binnen minimum en maximum', () => {
  // Embeddings als eenheidsvectoren: gelijke richting = zelfde betekenis.
  const v = (deg) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  const r = (name, { docs = ['A'], score = 0.7, n = 3, role = 'module_concept', emb = v(0) } = {}) => ({
    concept: { name, documentIds: docs, concept_role: role }, maxScore: score, matchedCount: n, embedding: emb,
  });

  it('geen maximum: alles blijft staan', () => {
    const list = [r('a'), r('b'), r('c')];
    const out = selectConcepts(list, {});
    expect(out.kept).toHaveLength(3);
    expect(out.cutOff).toEqual([]);
    expect(out.shortBy).toBe(0);
  });

  it('een goed onderbouwd begrip dat iets nieuws toevoegt gaat voor een variant van wat er al is', () => {
    const list = [
      r('toets A', { score: 0.9, emb: v(0) }),
      r('toets A, variant', { score: 0.88, emb: v(3) }),   // hoge match, maar bijna dezelfde betekenis
      r('ander begrip', { score: 0.8, emb: v(80) }),       // iets lagere match, wel nieuw
    ];
    const { kept, cutOff } = selectConcepts(list, { max: 2 });
    expect(kept.map((x) => x.concept.name)).toEqual(['toets A', 'ander begrip']);
    expect(cutOff.map((x) => x.concept.name)).toEqual(['toets A, variant']);
  });

  it('bij gelijke overlap wint de sterkere match (score en aantal bewijsfragmenten)', () => {
    const list = [
      r('zwak', { score: 0.6, n: 1, emb: v(0) }),
      r('sterk', { score: 0.85, n: 5, emb: v(90) }),
      r('middel', { score: 0.7, n: 3, emb: v(180) }),
    ];
    expect(selectConcepts(list, { max: 2 }).kept.map((x) => x.concept.name)).toEqual(['sterk', 'middel']);
  });

  it('één groot document eist niet alle plekken op', () => {
    const list = [
      // Begrippen uit hetzelfde document liggen in betekenis dicht bij elkaar.
      r('a1', { docs: ['A'], score: 0.9, emb: v(0) }), r('a2', { docs: ['A'], score: 0.89, emb: v(25) }),
      r('a3', { docs: ['A'], score: 0.88, emb: v(35) }), r('b1', { docs: ['B'], score: 0.85, emb: v(120) }),
      r('c1', { docs: ['C'], score: 0.84, emb: v(220) }),
    ];
    const names = selectConcepts(list, { max: 3 }).kept.map((x) => x.concept.name);
    expect(names).toContain('b1');
    expect(names).toContain('c1');
  });

  it('voorbeelden uit casussen komen achteraan', () => {
    const list = [r('casus', { role: 'example_instance', score: 0.72, emb: v(0) }), r('term', { score: 0.7, emb: v(90) })];
    expect(selectConcepts(list, { max: 1 }).kept[0].concept.name).toBe('term');
  });

  it('onder het minimum: aanvullen alleen met kandidaten MET bewijs, gemarkeerd als topUp', () => {
    const accepted = [r('a', { emb: v(0) })];
    const reserve = [r('dun bewijs', { n: 1, emb: v(90) }), r('geen bewijs', { n: 0, emb: v(180) })];
    const out = selectConcepts(accepted, { min: 3, reserve });
    expect(out.kept.map((x) => x.concept.name)).toEqual(['a', 'dun bewijs']);
    expect(out.toppedUp.map((x) => x.concept.name)).toEqual(['dun bewijs']);
    expect(out.kept[1].topUp).toBe(true);
    expect(out.shortBy).toBe(1);
  });

  it('minimum gehaald zonder reserve: niets aangevuld', () => {
    const out = selectConcepts([r('a'), r('b', { emb: v(90) })], { min: 2, reserve: [r('x', { n: 2 })] });
    expect(out.toppedUp).toEqual([]);
    expect(out.shortBy).toBe(0);
  });

  it('overlap telt pas boven cosine 0,5 en volledig vanaf 0,95', () => {
    expect(overlapPenalty(0.4)).toBe(0);
    expect(overlapPenalty(0.95)).toBeCloseTo(1, 9);
    expect(overlapPenalty(0.99)).toBe(1);
    expect(overlapPenalty(0.725)).toBeCloseTo(0.5, 5);
  });
});

describe('isUsableConceptName', () => {
  it('geen losse letters, symbolen of formules; wel afkortingen', () => {
    for (const bad of ['n', 'x', 'z', 't=0', 'z = 1.96', 'Σ']) expect(isUsableConceptName(bad)).toBe(false);
    for (const ok of ['RCT', 'OR', 'p-waarde', 'z-verdeling', '95% betrouwbaarheidsinterval']) expect(isUsableConceptName(ok)).toBe(true);
  });
});

describe('planSureMerges — opruimen van de bestaande lijst', () => {
  it('alleen zekere varianten; het goedgekeurde begrip blijft', () => {
    const rows = [
      { id: '1', name: 'genest patiënt controleonderzoek', review_status: 'rejected', definition: 'lang lang lang' },
      { id: '2', name: 'Geneste Patiënt Controleonderzoek', review_status: 'approved', definition: 'kort' },
      { id: '3', name: 'RCT', review_status: 'rejected', definition: '' },
      { id: '4', name: 'Randomized Controlled Trial', review_status: 'approved', definition: '' },
    ];
    expect(planSureMerges(rows)).toEqual([
      { keepId: '2', keepName: 'Geneste Patiënt Controleonderzoek', dupIds: ['1'], dupNames: ['genest patiënt controleonderzoek'] },
    ]);
  });

  // Regressie (E&B1, 2026-09-29): deze drie stonden als alias bij het ene
  // begrip én als los begrip in de lijst — de docent zag ze dubbel.
  it('naam = alias van een ander begrip → zeker samenvoegen; het begrip met de alias blijft', () => {
    const rows = [
      { id: 'snv', name: 'standaardnormale verdeling', aliases: ['z-verdeling'], review_status: 'approved', docCount: 2, definition: 'kort' },
      { id: 'z', name: 'z-verdeling', aliases: [], review_status: 'approved', docCount: 3, definition: 'veel langere definitie' },
      { id: 'eo', name: 'Experimenteel onderzoek', aliases: ['experiment', 'Experimentele studie'], review_status: 'approved', docCount: 3 },
      { id: 'ex', name: 'experiment', aliases: [], review_status: 'approved', docCount: 4 },
      { id: 'gem', name: 'gemiddelde', aliases: ['Gemiddelde van de waarnemingen'], review_status: 'approved', docCount: 3 },
      { id: 'gw', name: 'gemiddelde van de waarnemingen', aliases: [], review_status: 'approved', docCount: 2 },
      { id: 'med', name: 'mediaan', aliases: [], review_status: 'approved', docCount: 3 },
    ];
    const plans = planSureMerges(rows);
    expect(plans.map((p) => [p.keepId, p.dupIds])).toEqual([['snv', ['z']], ['eo', ['ex']], ['gem', ['gw']]]);
  });

  it('goedkeuring gaat vóór het hebben van de alias', () => {
    const rows = [
      { id: 'a', name: 'standaardnormale verdeling', aliases: ['z-verdeling'], review_status: 'rejected' },
      { id: 'b', name: 'z-verdeling', aliases: [], review_status: 'approved' },
    ];
    expect(planSureMerges(rows)).toEqual([{ keepId: 'b', keepName: 'z-verdeling', dupIds: ['a'], dupNames: ['standaardnormale verdeling'] }]);
  });

  it('een alias zonder los begrip, of een gedeelde alias, is geen zekere dubbeling', () => {
    const rows = [
      { id: 'a', name: 'p-waarde', aliases: ['overschrijdingskans'] },
      { id: 'b', name: 'tweezijdige overschrijdingskans', aliases: ['overschrijdingskans'] },
    ];
    expect(planSureMerges(rows)).toEqual([]);
  });
});

describe('buildMergeSuggestions — twijfelgevallen voor de docent', () => {
  const rows = [
    { id: 'bi', name: 'betrouwbaarheidsinterval', review_status: 'approved', cls: 'course' },
    { id: 'bi95', name: '95% betrouwbaarheidsinterval', review_status: 'approved', cls: 'module' },
    { id: 'pc', name: 'Prospectief cohort', review_status: 'approved', cls: 'module' },
    { id: 'pco', name: 'Prospectief cohortonderzoek', review_status: 'approved', cls: 'module' },
    { id: 'ruw', name: 'ruwe effect', review_status: 'approved', cls: 'course' },
    { id: 'ong', name: 'Ongestratificeerde effect', review_status: 'needs_review', cls: 'module' },
  ];

  it('moduleconcept dat al als cursusconcept bestaat: het cursusconcept blijft, en staat bovenaan', () => {
    const groups = [
      { preferred: 'Prospectief cohortonderzoek', others: ['Prospectief cohort'] },
      // het model kiest hier de modulenaam als voorkeur; het cursusconcept moet toch blijven
      { preferred: '95% betrouwbaarheidsinterval', others: ['betrouwbaarheidsinterval'] },
    ];
    const s = buildMergeSuggestions(groups, rows);
    expect(s.map((x) => [x.kind, x.keep.id, x.others.map((o) => o.id)])).toEqual([
      ['crossClass', 'bi', ['bi95']],
      ['same', 'pco', ['pc']],
    ]);
  });

  it('goedkeuring gaat vóór klasse; weggeklikte voorstellen komen niet terug', () => {
    const s = buildMergeSuggestions([{ preferred: 'Ongestratificeerde effect', others: ['ruwe effect'] }], rows);
    expect(s[0].keep.id).toBe('ruw');
    expect(buildMergeSuggestions([{ preferred: 'ruwe effect', others: ['Ongestratificeerde effect'] }], rows, new Set(['ong|ruw']))).toEqual([]);
  });

  it('de prompt draagt de klasse per begrip en vraagt om varianten met een toevoeging', () => {
    const p = buildDuplicateSuggestionPrompt(rows.slice(0, 2).map((r) => ({ ...r, definition: 'x' })));
    expect(p).toContain('1. [C] betrouwbaarheidsinterval — x');
    expect(p).toContain('2. [M] 95% betrouwbaarheidsinterval');
    expect(p).toMatch(/qualifier/);
  });

  it('parser accepteert namen waar het model de klasse-tag voor laat staan', () => {
    const g = parseSynonymGroups('[{"preferred":"[C] betrouwbaarheidsinterval","others":["[M] 95% betrouwbaarheidsinterval"]}]', rows.map((r) => r.name));
    expect(g).toEqual([{ preferred: 'betrouwbaarheidsinterval', others: ['95% betrouwbaarheidsinterval'] }]);
  });
});

describe('mapLimit', () => {
  it('nooit meer dan het maximum tegelijk, volgorde blijft', async () => {
    let busy = 0; let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => {
      busy++; peak = Math.max(peak, busy);
      await new Promise((r) => setTimeout(r, 5));
      busy--; return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
});

describe('extract-concepts: minimum en maximum in de route (extractConceptsHandler)', () => {
  const handler = functionSource('extractConceptsHandler');
  it('de reserve bevat alleen kandidaten met bewijs, en aangevulde begrippen worden "te beoordelen"', () => {
    expect(handler).toMatch(/if \(r\.matchedCount >= 1\) reserveResults\.push\(r\)/);
    expect(handler).toMatch(/c\.__topUp \? \{ review_status: 'needs_review' \}/);
    expect(handler).toMatch(/selectConcepts\(dedupedResults, \{\s*min: extractionSettings\.min_concepts,\s*max: extractionSettings\.max_concepts,/);
  });
  it('een minimum boven het maximum wordt geweigerd; een tekort wordt gemeld', () => {
    expect(routeSource("app.put('/api/rag-settings'")).toMatch(/minC > maxC[\s\S]{0,200}min_above_max/);
    expect(handler).toMatch(/shortBy: selection\.shortBy/);
  });
});
