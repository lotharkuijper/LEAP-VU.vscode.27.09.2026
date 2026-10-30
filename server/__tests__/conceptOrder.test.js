// Volgorde van begrippen in de stof (server/concepts/conceptOrder.js, 2026-10-24).
import { describe, it, expect } from 'vitest';
import { buildDocOrder, conceptPositions } from '../concepts/conceptOrder.js';

const material = [
  { id: 'd3', filename: '3. Toetsen.pdf' },
  { id: 'd1', filename: '1. Inleiding.pdf' },
  { id: 'd2', filename: '2. Designs.pdf' },
  { id: 'dx', filename: 'Losse aantekeningen.pdf' },
];

describe('volgorde van de documenten', () => {
  it('zonder leerlijn: de nummering van de bestanden; zonder nummer achteraan', () => {
    const { docOrder, unitCount } = buildDocOrder({ leerlijn: null, material });
    expect(['d1', 'd2', 'd3', 'dx'].map(id => docOrder.get(id).rank)).toEqual([0, 1, 2, 3]);
    expect(docOrder.get('dx').unitTitle).toBe(null);
    expect(unitCount).toBe(3);
  });
  it('met leerlijn: de volgorde van de onderdelen gaat voor de nummering', () => {
    const leerlijn = {
      units: [{ id: 'u2', title: 'Later', position: 2 }, { id: 'u1', title: 'Eerst', position: 1 }],
      docUnit: new Map([['d3', 'u1'], ['d1', 'u2'], ['d2', 'u2']]),
    };
    const { docOrder } = buildDocOrder({ leerlijn, material });
    expect(docOrder.get('d3')).toMatchObject({ rank: 0, unitTitle: 'Eerst', unitIndex: 1 });
    expect(docOrder.get('d1')).toMatchObject({ rank: 1, unitTitle: 'Later', unitIndex: 2 });
    expect(docOrder.get('dx').rank).toBe(3);
  });
});

describe('plek per begrip', () => {
  const { docOrder, unitCount } = buildDocOrder({ leerlijn: null, material });
  it('het eerste voorkomen telt, ook als een begrip later vaker terugkomt', () => {
    const concepts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const evidence = [
      { concept_id: 'a', document_id: 'd3', chunk_index: 0 },
      { concept_id: 'b', document_id: 'd3', chunk_index: 5 },
      { concept_id: 'b', document_id: 'd1', chunk_index: 9 }, // b komt al in hoofdstuk 1 voor
      { concept_id: 'c', document_id: 'd1', chunk_index: 2 },
    ];
    const r = new Map(conceptPositions({ concepts, evidence, docOrder, unitCount }).map(x => [x.id, x]));
    expect(['c', 'b', 'a'].map(id => r.get(id).order)).toEqual([0, 1, 2]);
    expect(r.get('c').pos).toBe(0);
    expect(r.get('a').pos).toBe(1);
    expect(r.get('b').pos).toBe(0.5);
  });
  it('zonder fragmenten: de documenten van het begrip; zonder iets: plek onbekend', () => {
    const concepts = [{ id: 'a', source_document_ids: ['d2'] }, { id: 'z' }];
    const r = conceptPositions({ concepts, evidence: [], docOrder, unitCount });
    expect(r[0]).toMatchObject({ order: 0, unitIndex: 2 });
    expect(r[1]).toMatchObject({ order: null, pos: null });
  });
});
