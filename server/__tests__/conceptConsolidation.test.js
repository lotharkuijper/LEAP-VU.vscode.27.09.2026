import { describe, it, expect } from 'vitest';
import {
  buildDocumentWindows, conceptKey, mergeByKey, parseSynonymGroups, applySynonymGroups,
  capFairly, planSureMerges, mapLimit, WINDOW_CHARS, isUsableConceptName,
} from '../conceptConsolidation.js';

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

describe('capFairly — kernbegrippen eerst, daarna eerlijk per document', () => {
  const r = (name, docs, score, role = 'module_concept') => ({ concept: { name, documentIds: docs, concept_role: role }, maxScore: score });
  it('één groot document eist niet alle plekken op', () => {
    const list = [
      r('a1', ['A'], 0.9), r('a2', ['A'], 0.89), r('a3', ['A'], 0.88), r('a4', ['A'], 0.87),
      r('b1', ['B'], 0.7), r('c1', ['C'], 0.6),
      r('kern', ['A', 'B', 'C'], 0.5, 'main_course_concept'),
      r('effect', ['A', 'B', 'C'], 0.95, 'module_concept'),
    ];
    const { kept, cutOff } = capFairly(list, 4);
    // 'kern' (vakbegrip in 3 documenten) krijgt voorrang; 'effect' (algemeen woord, ook in 3 documenten) niet.
    expect(kept.map((x) => x.concept.name)).toEqual(['kern', 'effect', 'b1', 'c1']);
    expect(cutOff).toHaveLength(4);
  });
  it('geen limiet → alles', () => {
    expect(capFairly([r('x', ['A'], 1)], 0).kept).toHaveLength(1);
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
