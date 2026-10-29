// Leerlijn (server/courses/courseUnits.js, migratie 20261016130000): voorstel uit
// bestandsnamen, anker, geoefende onderdelen en het blok voor de tutorchat.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  orderKeyFromName, titleFromName, proposeUnits, parseLeerlijnInput, unitOfConcept, anchorUnit, relationTo,
  practiceByUnit, practicedUnitIds, buildLeerlijnBlock,
} from '../courses/courseUnits.js';
import { routeSource, functionSource } from './helpers/serverSource.js';

const root = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

describe('voorstel uit bestandsnamen', () => {
  it('nummer vooraan, na een woord als "Hoorcollege", of los; niet vast aan letters', () => {
    expect(orderKeyFromName('4.1.Confounding.docx')).toEqual([4, 1]);
    expect(orderKeyFromName('10.schatten.docx')).toEqual([10]);
    expect(orderKeyFromName('Metho2_Hoorcollege 6; kansmodellen_CANVAS.pdf')).toEqual([6]);
    expect(orderKeyFromName('Week 3 - Regressie.pptx')).toEqual([3]);
    expect(orderKeyFromName('correlatie.regressie.pptx')).toBe(null);
    expect(orderKeyFromName('Metho2_samenvatting.pdf')).toBe(null);
  });
  it('leesbare titels', () => {
    expect(titleFromName('4.1.Confounding.docx')).toBe('Confounding');
    expect(titleFromName('11.t.&.z.verdeling.docx')).toBe('T & z verdeling');
    expect(titleFromName('Metho2_Hoorcollege 1; Beschrijvende statistiek_CANVAS.pdf')).toBe('Beschrijvende statistiek');
  });
  it('volgorde van de nummers; gelijke nummers op dezelfde plek; zonder nummer open', () => {
    const files = ['10.c.docx', '2.b.docx', '1.a.docx', '4.1.e.docx', '4.d.docx', 'syllabus.pdf', '2.b-oefeningen.docx']
      .map((n, i) => ({ id: `d${i}`, filename: n }));
    const p = proposeUnits(files);
    expect(p.units.map((u) => `${u.position}:${u.title}`)).toEqual(['1:A', '2:B', '3:D', '4:E', '5:C']);
    expect(p.units[1].documentIds).toEqual(['d1', 'd6']);
    expect(p.unplaced).toEqual(['d5']);
  });
});

describe('opslaan', () => {
  const D = '6f7c1d5a-e115-4984-a373-4bb8fa337e03';
  it('posities worden 1, 2, 3, …; gelijke posities blijven naast elkaar', () => {
    const r = parseLeerlijnInput({ units: [{ key: 'a', title: 'A', position: 10 }, { key: 'b', title: 'B', position: 20 }, { key: 'c', title: 'C', position: 20 }], assignments: [{ documentId: D, unitKey: 'b' }] });
    expect(r.ok).toBe(true);
    expect(r.value.units.map((u) => u.position)).toEqual([1, 2, 2]);
  });
  it('rommel wordt geweigerd', () => {
    expect(parseLeerlijnInput({}).ok).toBe(false);
    expect(parseLeerlijnInput({ units: [{ key: 'a', title: '', position: 1 }], assignments: [] }).ok).toBe(false);
    expect(parseLeerlijnInput({ units: [{ key: 'a', title: 'A', position: 0 }], assignments: [] }).ok).toBe(false);
    expect(parseLeerlijnInput({ units: [{ key: 'a', title: 'A', position: 1 }], assignments: [{ documentId: D, unitKey: 'x' }] }).ok).toBe(false);
    expect(parseLeerlijnInput({ units: [{ key: 'a', title: 'A', position: 1 }], assignments: [{ documentId: 'geen-uuid', unitKey: 'a' }] }).ok).toBe(false);
  });
});

// Leerlijn: kansrekening (1) → kansmodellen (2) → toetsen (3), met een zijpad (3).
const U = [
  { id: 'u1', title: 'Kansrekening', position: 1 },
  { id: 'u2', title: 'Kansmodellen', position: 2 },
  { id: 'u3', title: 'Toetsen', position: 3 },
  { id: 'u3b', title: 'Zijpad', position: 3 },
];
const unitById = new Map(U.map((u) => [u.id, u]));
const docUnit = new Map([['d1', 'u1'], ['d2', 'u2'], ['d3', 'u3'], ['d3b', 'u3b']]);

describe('anker en relaties', () => {
  it('een begrip hoort bij het vroegste onderdeel van zijn bronnen', () => {
    expect(unitOfConcept(['d3', 'd2'], docUnit, unitById).id).toBe('u2');
    expect(unitOfConcept(['onbekend'], docUnit, unitById)).toBe(null);
  });
  it('anker: keuze van de student, anders het onderdeel met de meeste overeenkomst', () => {
    const sources = [{ documentId: 'd2', similarity: 0.8 }, { documentId: 'd1', similarity: 0.6 }, { documentId: 'd1', similarity: 0.5 }];
    expect(anchorUnit({ sources, docUnit, unitById }).id).toBe('u1');
    expect(anchorUnit({ sources, explicitUnitId: 'u3', docUnit, unitById }).id).toBe('u3');
    expect(anchorUnit({ sources: [{ documentId: 'x', similarity: 1 }], docUnit, unitById })).toBe(null);
  });
  it('voorafgaand, dit onderdeel, ernaast, verderop', () => {
    const anchor = unitById.get('u2');
    expect(U.map((u) => relationTo(u, anchor))).toEqual(['earlier', 'anchor', 'later', 'later']);
    expect(relationTo(unitById.get('u3b'), unitById.get('u3'))).toBe('parallel');
  });
});

describe('geoefende onderdelen', () => {
  const conceptUnitByName = new Map([['toets', 'u3'], ['kans', 'u1']]);
  const conceptUnitById = new Map([['c3', 'u3']]);
  it('quiz, uitleg en chat tellen mee; pas vanaf de drempel geldt het als geoefend', () => {
    const pts = practiceByUnit({
      quiz: [{ topics: ['Toets'], score_percentage: 80 }, { topics: ['kans'], score_percentage: 20 }],
      explanations: [{ concept_id: 'c3', score: { total: 90 } }],
      chatDocs: [['d1'], ['d1', 'd3']],
      conceptUnitByName, conceptUnitById, docUnit,
    });
    expect(pts.get('u3')).toBeCloseTo(2.25);
    expect(pts.get('u1')).toBeCloseTo(1);
    expect([...practicedUnitIds(pts)]).toEqual(['u3']);
  });
});

describe('blok voor de tutorchat', () => {
  it('voorafgaand mag; verderop alleen als de student het al oefende', () => {
    const block = buildLeerlijnBlock({ units: U, anchor: unitById.get('u2'), practiced: new Set(['u3']), sources: [{ documentId: 'd2' }, { documentId: 'd1' }], docUnit });
    expect(block).toMatch(/1\. Kansrekening — voorafgaand/);
    expect(block).toMatch(/2\. Kansmodellen — dit onderdeel/);
    expect(block).toMatch(/3\. Toetsen — verderop in de leerlijn, maar de student heeft dit al geoefend/);
    expect(block).toMatch(/3\. Zijpad — verderop in de leerlijn: niet als bekend veronderstellen/);
    expect(block).toMatch(/\[1\] hoort bij "Kansmodellen"; \[2\] hoort bij "Kansrekening"/);
    expect(block).not.toMatch(/\d{4}-\d{2}-\d{2}/); // geen datums
  });
  it('geen leerlijn of geen anker: geen blok (de chat werkt zoals voorheen)', () => {
    expect(buildLeerlijnBlock({ units: [], anchor: null, docUnit })).toBe('');
    expect(buildLeerlijnBlock({ units: U, anchor: null, docUnit })).toBe('');
  });
});

describe('koppeling in de server', () => {
  it('alleen in de tutorchat, vóór het taal-/niveaublok, en een storing breekt de chat niet', () => {
    const src = routeSource("app.post('/api/chat',");
    const block = src.indexOf('systemContent += await leerlijnBlockFor(');
    const lang = src.indexOf('systemContent += langSuffix;', block);
    expect(block).toBeGreaterThan(0);
    expect(lang).toBeGreaterThan(block);
    expect(src.slice(block - 200, block)).toMatch(/purpose === 'tutor_chat' && courseId/);
    expect(functionSource('leerlijnBlockFor')).toMatch(/\[leerlijn\] blok overgeslagen/);
  });
  it('tabellen alleen via de server, met terugdraaiscript', () => {
    const up = read('supabase/migrations/20261016130000_course_units.sql');
    expect(up).toMatch(/course_units ENABLE ROW LEVEL SECURITY/);
    expect(up).toMatch(/course_unit_documents ENABLE ROW LEVEL SECURITY/);
    expect(up).not.toMatch(/CREATE POLICY/);
    expect(fs.existsSync(path.join(root, 'supabase/rollback/20261016130000_course_units_down.sql'))).toBe(true);
  });
});
