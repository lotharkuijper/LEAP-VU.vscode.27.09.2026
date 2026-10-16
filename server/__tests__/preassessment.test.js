import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import {
  splitForAssessment, verifyQuotes, normalizePreassessment, assessText,
  buildAssessmentDocx, buildOverviewCsv, streamZip, docLabels, safeName, PART_CHARS,
} from '../preassessment.js';

const PRODUCT = `Inleiding
In dit rapport onderzoeken we hoe buurtbewoners het nieuwe park gebruiken.

Methode
We hielden twaalf interviews met bewoners en telden bezoekers op vier zaterdagen.

Resultaten
De meeste bezoekers kwamen 's ochtends; gezinnen bleven het langst.`;

const ctx = {
  project: { title: 'Parkonderzoek', research_question: 'Hoe wordt het park gebruikt?', goals: 'Onderzoek opzetten', rubric_criteria: [] },
  persona: { name: 'Eindbeoordelaar', system_prompt: '', deliverable_label: 'Eindrapport' },
  rubricText: '[Rubric: rubric.docx]\n1. Methode\n2. Resultaten',
  groupName: 'Groep A',
  filename: 'rapport.docx',
};

const good = (quote = 'We hielden twaalf interviews met bewoners') => JSON.stringify({
  summary: 'Een kort onderzoeksrapport.',
  criteria: [
    { criterion: 'Methode', indication: 'adequate', strengths: ['Interviews en tellingen'], concerns: ['Steekproef klein'], quotes: [quote, 'Dit citaat staat nergens in het rapport'] },
    { criterion: 'Resultaten', indication: 'cijfer 8', strengths: [], concerns: ['Geen tabel'], quotes: [] },
  ],
  attention: ['Controleer de bronnen'],
});

describe('splitForAssessment', () => {
  it('houdt korte tekst heel en knipt lange tekst op alinea’s zonder iets te verliezen', () => {
    expect(splitForAssessment(PRODUCT)).toHaveLength(1);
    const para = 'Dit is een alinea met inhoud. '.repeat(40);
    const long = Array.from({ length: 40 }, (_, i) => `${i}: ${para}`).join('\n\n');
    const parts = splitForAssessment(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= PART_CHARS)).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, '')).toBe(long.replace(/\s+/g, ''));
  });
  it('geeft niets terug voor lege tekst', () => {
    expect(splitForAssessment('   ')).toEqual([]);
  });
});

describe('verifyQuotes', () => {
  it('houdt letterlijke citaten en gooit verzonnen citaten weg', () => {
    const q = verifyQuotes(['"We hielden  twaalf interviews met bewoners"', 'Bewoners waren zeer tevreden over het park', 'kort'], PRODUCT);
    expect(q).toEqual(['We hielden  twaalf interviews met bewoners']);
  });
  it('accepteert een citaat met weglating als alle stukken erin staan', () => {
    expect(verifyQuotes(['De meeste bezoekers kwamen … gezinnen bleven het langst'], PRODUCT)).toHaveLength(1);
  });
});

describe('normalizePreassessment', () => {
  it('maakt van een onbekende indicatie "unclear" en controleert citaten tegen de bron', () => {
    const n = normalizePreassessment(good(), PRODUCT);
    expect(n.criteria[0].quotes).toEqual(['We hielden twaalf interviews met bewoners']);
    expect(n.criteria[1].indication).toBe('unclear');
    expect(n.attention).toEqual(['Controleer de bronnen']);
  });
  it('geeft null bij geen JSON of een leeg antwoord', () => {
    expect(normalizePreassessment('geen json')).toBeNull();
    expect(normalizePreassessment('{}')).toBeNull();
  });
});

describe('assessText', () => {
  it('één modelaanroep voor een kort product, met de rubric in de prompt', async () => {
    const calls = [];
    const r = await assessText({ ctx, text: PRODUCT, callModel: async (m) => { calls.push(m); return good(); } });
    expect(calls).toHaveLength(1);
    expect(calls[0][1].content).toContain('1. Methode');
    expect(calls[0][1].content).toContain('We hielden twaalf interviews');
    expect(calls[0][0].content).toMatch(/GEEN cijfer/);
    expect(r.parts).toBe(1);
    expect(r.criteria).toHaveLength(2);
  });

  it('leest een lang product in delen en maakt daarna één samenvattende voorbeoordeling', async () => {
    const filler = 'Een zin over het onderzoek in het park. '.repeat(60);
    const long = Array.from({ length: 20 }, (_, i) => `Hoofdstuk ${i}\n${filler}`).join('\n\n') + '\n\nWe hielden twaalf interviews met bewoners.';
    const calls = [];
    const r = await assessText({ ctx, text: long, callModel: async (m) => { calls.push(m); return good(); } });
    const n = splitForAssessment(long).length;
    expect(n).toBeGreaterThan(1);
    expect(calls).toHaveLength(n + 1);
    expect(calls[0][1].content).toContain(`deel 1 van ${n}`);
    expect(calls[n][1].content).toContain('notities per deel');
    expect(r.parts).toBe(n);
    // Het citaat staat in het laatste deel, dus overleeft de controle tegen de hele tekst.
    expect(r.criteria[0].quotes).toEqual(['We hielden twaalf interviews met bewoners']);
  });

  it('probeert één keer opnieuw bij een onbruikbaar antwoord en faalt daarna', async () => {
    let i = 0;
    const r = await assessText({ ctx, text: PRODUCT, callModel: async () => (i++ === 0 ? 'oeps' : good()) });
    expect(r.criteria).toHaveLength(2);
    await expect(assessText({ ctx, text: PRODUCT, callModel: async () => 'oeps' })).rejects.toThrow(/bruikbaar/);
    await expect(assessText({ ctx, text: '  ', callModel: async () => good() })).rejects.toThrow(/leesbare tekst/);
  });
});

describe('downloads', () => {
  const labels = docLabels('nl');
  const assessment = { status: 'done', content: { ...normalizePreassessment(good(), PRODUCT), parts: 1 } };

  it('labels bestaan in nl en en (geen kale sleutels)', () => {
    for (const lang of ['nl', 'en']) {
      const l = docLabels(lang);
      for (const v of [l.title, l.summary, l.disclaimer, l.indication.strong, l.csv.status, l.overviewFile]) {
        expect(v).not.toMatch(/^projects\.preassessment/);
      }
    }
    expect(docLabels('en').title).not.toBe(labels.title);
  });

  it('bouwt een geldig Word-bestand met de voorbeoordeling, veilig geëscaped', () => {
    const bytes = buildAssessmentDocx({ projectTitle: 'P & <Q>', groupName: 'Groep A', filename: 'r.docx', submittedAt: '1 okt', personaName: 'Eind', assessment, labels });
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']));
    const xml = strFromU8(files['word/document.xml']);
    expect(xml).toContain('P &amp; &lt;Q&gt;');
    expect(xml).toContain('We hielden twaalf interviews met bewoners');
    expect(xml).toContain(labels.indication.adequate);
    expect(xml).not.toContain('Dit citaat staat nergens');
  });

  it('meldt in het Word-bestand als de voorbeoordeling nog loopt of mislukte', () => {
    const xml = (a) => strFromU8(unzipSync(buildAssessmentDocx({ projectTitle: 'P', groupName: 'G', filename: 'f', assessment: a, labels }))['word/document.xml']);
    expect(xml({ status: 'pending' })).toContain(labels.pending);
    expect(xml({ status: 'failed', error: 'kapot' })).toContain('kapot');
  });

  it('overzicht: één kolom per criterium, met BOM en ; als scheidingsteken', () => {
    const csv = buildOverviewCsv([
      { groupName: 'Groep A', filename: 'a.docx', submittedAt: 'x', uploadedBy: 'Sam', assessment },
      { groupName: 'Groep; B', filename: 'b.pdf', submittedAt: 'y', uploadedBy: '', assessment: null },
    ], labels);
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0].split(';')).toContain('Methode');
    expect(lines[1]).toContain(labels.indication.adequate);
    expect(lines[2]).toContain('"Groep; B"');
    expect(lines[2]).toContain(labels.statusText.none);
  });

  it('streamZip zet alle bestanden in één zip, ook lui opgehaalde', async () => {
    const chunks = [];
    await streamZip([
      { name: 'overzicht.csv', compress: true, data: new TextEncoder().encode('a;b') },
      { name: 'Groep A/rapport.pdf', data: async () => new Uint8Array([1, 2, 3]) },
      { name: 'Groep B/leeg.pdf', data: async () => null },
    ], (c) => chunks.push(c));
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    const files = unzipSync(all);
    expect(Object.keys(files).sort()).toEqual(['Groep A/rapport.pdf', 'overzicht.csv']);
    expect([...files['Groep A/rapport.pdf']]).toEqual([1, 2, 3]);
  });

  it('safeName haalt padtekens weg', () => {
    expect(safeName('../a/b:c')).toBe('.._a_b_c');
    expect(safeName('', 'x')).toBe('x');
  });
});

describe('koppeling in de server', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  it('een inlevering start de voorbeoordeling op de achtergrond', () => {
    const handler = src.slice(src.indexOf('async function uploadProjectSubmissionHandler'), src.indexOf("app.post('/api/projects/:projectId/submissions'"));
    expect(handler).toMatch(/preassessmentRunner\.start\(newId\)/);
  });
  it('de voorbeoordelaar doet niet mee aan feedbackrondes en "Beoordeling opvragen"', () => {
    const list = src.slice(src.indexOf("app.get('/api/projects/:projectId/groups/:groupId/feedback'"), src.indexOf("app.post('/api/projects/:projectId/groups/:groupId/personas/:personaId/feedback'"));
    expect(list).toMatch(/neq\('id', project\.preassessment_persona_id/);
    const ctxFn = src.slice(src.indexOf('async function loadFeedbackContext'), src.indexOf("app.get('/api/projects/:projectId/groups/:groupId/feedback'"));
    expect(ctxFn).toMatch(/p\.id === project\.preassessment_persona_id/);
    const evaluate = src.slice(src.indexOf("app.post('/api/projects/groups/:groupId/evaluate'"));
    expect(evaluate.slice(0, 3000)).toMatch(/neq\('id', project\?\.preassessment_persona_id/);
  });
  it('de routes zijn alleen voor docenten van de cursus', () => {
    const mod = fs.readFileSync(path.join(__dirname, '..', 'preassessment.js'), 'utf8');
    const routes = mod.slice(mod.indexOf('export function registerPreassessmentRoutes'));
    const count = (routes.match(/app\.(get|post|put)\(/g) || []).length;
    const guarded = (routes.match(/const ctx = await staffProject\(req, res\);/g) || []).length;
    expect(count).toBe(5);
    expect(guarded).toBe(count);
    expect(routes).toMatch(/isStaffForCourse\(auth\.user, auth\.profile, project\.course_id\)/);
  });
});
