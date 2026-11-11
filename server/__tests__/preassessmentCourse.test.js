// Nakijkhulp met cursusmateriaal (2026-11-11): als de docent het instelt, toetst
// de nakijkhulp per rubriccriterium aan de leerstof, met bronnummers. Zonder
// bewijs in de leerstof zegt hij dat (geen eigen kennis). Staat het uit, dan
// verandert er niets.
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import {
  buildCourseQueries, mergeCourseMatches, normalizePreassessment, assessText, preassessmentSystemPrompt,
  createPreassessmentRunner, buildAssessmentDocx, docLabels, sourceLabel, COURSE_MAX_QUERIES,
} from '../projects/preassessment.js';

const PRODUCT = 'Inleiding\nWe controleren de bewering dat 80 procent van het nieuws nep is.\n\nAanpak\nWe vergeleken drie bronnen.';
const project = { id: 'p1', course_id: 'c1', title: 'Factcheck', research_question: 'Klopt de bewering?', goals: '', rubric_criteria: [{ title: 'Bronnen' }, { title: 'Redenering' }], preassessment_persona_id: 'm1' };
const answer = (evidence) => JSON.stringify({
  summary: 'Een factcheck.',
  criteria: [{ criterion: 'Bronnen', indication: 'adequate', strengths: ['Drie bronnen'], concerns: [], quotes: ['We vergeleken drie bronnen'], course_evidence: evidence }],
  attention: [],
});

describe('zoekvragen en treffers', () => {
  it('criteria uit het project en stukken uit het product, nooit te veel', () => {
    const q = buildCourseQueries({ project, rubricText: '', text: PRODUCT });
    expect(q.slice(0, 2)).toEqual(['Bronnen', 'Redenering']);
    expect(q.some((x) => x.includes('80 procent'))).toBe(true);
    const many = buildCourseQueries({ project: { rubric_criteria: Array.from({ length: 20 }, (_, i) => `Criterium nummer ${i}`) }, text: 'x '.repeat(50000) });
    expect(many.length).toBeLessThanOrEqual(COURSE_MAX_QUERIES);
  });
  it('zonder criteria in het project: korte regels uit de rubric', () => {
    const q = buildCourseQueries({ project: { rubric_criteria: [] }, rubricText: '1. Gebruik van betrouwbare bronnen\n2. Heldere redenering met bewijs\nx', text: '' });
    expect(q).toEqual(['Gebruik van betrouwbare bronnen', 'Heldere redenering met bewijs']);
  });
  it('elk fragment één keer, de sterkste eerst', () => {
    const a = { id: 'k1', content: 'A', similarity: 0.5, document_id: 'd1' };
    const merged = mergeCourseMatches([[a, { id: 'k2', content: 'B', similarity: 0.9 }], [{ ...a, similarity: 0.7 }, { id: 'k3', content: '  ' }]]);
    expect(merged.map((m) => m.id)).toEqual(['k2', 'k1']);
    expect(merged[1].similarity).toBe(0.7);
  });
});

describe('onderbouwing uit het cursusmateriaal', () => {
  it('alleen bronnummers die echt zijn meegegeven', () => {
    const r = normalizePreassessment(answer([{ source: 1, note: 'Volgens [1] is het 5 procent.' }, { source: 7, note: 'verzonnen bron' }, { source: 2, note: '' }]), null, { sourceCount: 2 });
    expect(r.criteria[0].course_evidence).toEqual([{ source: 1, note: 'Volgens [1] is het 5 procent.' }]);
    expect(normalizePreassessment(answer([{ source: 1, note: 'x' }]), null).criteria[0].course_evidence).toEqual([]);
  });
  it('met cursusmateriaal: leerstof als maatstaf, geen eigen kennis, en het schema vraagt om bronnen', () => {
    const p = preassessmentSystemPrompt({ withCourse: true });
    expect(p).toMatch(/maatstaf voor wat inhoudelijk juist/);
    expect(p).toMatch(/Gebruik geen eigen kennis als maatstaf/);
    expect(p).toContain('"course_evidence"');
    const plain = preassessmentSystemPrompt();
    expect(plain).not.toContain('course_evidence');
    expect(plain).toMatch(/GEEN cijfer/);
  });
  it('de leerstof gaat met bronnummers mee in de vraag aan het model', async () => {
    const calls = [];
    const r = await assessText({
      ctx: { project, persona: { name: 'Nakijkhulp' }, rubricText: 'Rubric', groupName: 'G', filename: 'f.pdf', courseMode: 'all', courseText: '[1] Mediawijsheid\nNepnieuws is ongeveer 5 procent.', courseSourceCount: 1 },
      text: PRODUCT,
      callModel: async (m) => { calls.push(m); return answer([{ source: 1, note: 'De leerstof noemt 5 procent.' }]); },
    });
    expect(calls[0][1].content).toContain('[1] Mediawijsheid');
    expect(calls[0][0].content).toMatch(/course_evidence/);
    expect(r.criteria[0].course_evidence).toHaveLength(1);
  });
  it('aan, maar niets gevonden: toch geen eigen kennis als maatstaf; twijfels naar de docent', async () => {
    const calls = [];
    await assessText({
      ctx: { project, persona: { name: 'Nakijkhulp' }, rubricText: 'Rubric', groupName: 'G', filename: 'f.pdf', courseMode: 'all', courseText: '', courseSourceCount: 0 },
      text: PRODUCT,
      callModel: async (m) => { calls.push(m); return answer([{ source: 1, note: 'verzonnen' }]); },
    });
    expect(calls[0][0].content).toMatch(/Gebruik geen eigen kennis als maatstaf/);
    expect(calls[0][1].content).toMatch(/niets gevonden dat bij dit product past/);
  });
  it('uit: de vraag aan het model is zoals voorheen', async () => {
    const calls = [];
    await assessText({ ctx: { project, persona: { name: 'Nakijkhulp' }, rubricText: 'Rubric', courseMode: 'none' }, text: PRODUCT, callModel: async (m) => { calls.push(m); return answer([]); } });
    expect(calls[0][0].content).not.toMatch(/eigen kennis/);
    expect(calls[0][1].content).not.toMatch(/Cursusmateriaal/);
  });
});

// Nep-database voor de runner: alleen wat run() leest en schrijft.
function fakeDb({ persona }) {
  const saved = [];
  const rows = {
    project_submissions: [{ id: 's1', project_id: 'p1', group_id: 'g1', filename: 'f.pdf', mime_type: 'application/pdf' }],
    projects: [project],
    project_personas: [persona],
    project_groups: [{ id: 'g1', name: 'Groep 1' }],
    project_documents: [],
    course_members: [],
  };
  const db = {
    saved,
    from(table) {
      const fs = [];
      const chain = {
        select() { return chain; },
        eq(c, v) { fs.push((r) => r[c] === v); return chain; },
        in(c, v) { fs.push((r) => v.includes(r[c])); return chain; },
        limit() { return chain; },
        order() { return chain; },
        maybeSingle() { return Promise.resolve({ data: (rows[table] || []).find((r) => fs.every((f) => f(r))) || null }); },
        upsert(row) { saved.push(row); return Promise.resolve({ error: null }); },
        then(res) { return res({ data: (rows[table] || []).filter((r) => fs.every((f) => f(r))), error: null }); },
      };
      return chain;
    },
  };
  return db;
}

async function runWith(persona, matches) {
  const db = fakeDb({ persona });
  const searched = [];
  const runner = createPreassessmentRunner({
    supabaseAdmin: db,
    pgPool: { query: async () => ({ rows: [{ file_bytes: Buffer.from('x') }] }) },
    extractText: async () => PRODUCT,
    modelReady: () => true,
    callModel: async () => answer([{ source: 1, note: 'De leerstof noemt 5 procent.' }]),
    searchCourse: async (args) => { searched.push(args); return matches; },
  });
  await runner.run('s1', { lang: 'nl' });
  return { done: db.saved.find((r) => r.status === 'done'), searched };
}

describe('de nakijkhulp in de server', () => {
  const base = { id: 'm1', project_id: 'p1', name: 'Nakijkhulp', persona_type: 'evaluator', system_prompt: '', project_knowledge_doc_ids: [] };
  const hit = [{ id: 'k1', document_id: 'd1', document_title: 'Mediawijsheid', content: 'Nepnieuws is ongeveer 5 procent.', similarity: 0.8, metadata: { pageStart: 3 } }];

  it('staat cursusmateriaal uit, dan zoekt hij niets en verandert er niets', async () => {
    const { done, searched } = await runWith({ ...base, course_knowledge: 'none' }, hit);
    expect(searched).toHaveLength(0);
    expect(done.content.courseKnowledge).toBe('none');
    expect(done.content.courseSources).toEqual([]);
    expect(done.content.criteria[0].course_evidence).toEqual([]);
  });
  it('alle leerstof: zoekt in de cursus en bewaart de bronnen bij het commentaar', async () => {
    const { done, searched } = await runWith({ ...base, course_knowledge: 'all' }, hit);
    expect(searched.length).toBeGreaterThan(0);
    expect(searched[0].courseId).toBe('c1');
    expect(done.content.courseSources).toEqual([expect.objectContaining({ index: 1, title: 'Mediawijsheid', documentId: 'd1', label: 'Mediawijsheid, p. 3' })]);
    expect(done.content.criteria[0].course_evidence).toEqual([{ source: 1, note: 'De leerstof noemt 5 procent.' }]);
    expect(done.content.courseNoMatch).toBe(false);
  });
  it('niets gevonden in de leerstof: dat staat erbij, en er komen geen verzonnen bronnen', async () => {
    const { done } = await runWith({ ...base, course_knowledge: 'all' }, []);
    expect(done.content.courseNoMatch).toBe(true);
    expect(done.content.criteria[0].course_evidence).toEqual([]);
  });
  it('gekozen bestanden zonder keuze: niet zoeken', async () => {
    const { searched } = await runWith({ ...base, course_knowledge: 'selected', course_knowledge_doc_ids: [] }, hit);
    expect(searched).toHaveLength(0);
  });
});

describe('Word-document', () => {
  it('onderbouwing per criterium en de lijst met gebruikte leerstof', () => {
    const bytes = buildAssessmentDocx({
      projectTitle: 'Factcheck', groupName: 'G', filename: 'f.pdf', personaName: 'Nakijkhulp', labels: docLabels('nl'),
      assessment: { status: 'done', content: {
        summary: 'S', attention: [], courseSources: [{ index: 1, title: 'Mediawijsheid', pageStart: 3, pageEnd: 4 }],
        criteria: [{ criterion: 'Bronnen', indication: 'adequate', strengths: [], concerns: [], quotes: [], course_evidence: [{ source: 1, note: 'De leerstof noemt 5 procent.' }] }],
      } },
    });
    const xml = strFromU8(unzipSync(bytes)['word/document.xml']);
    expect(xml).toContain('Onderbouwing uit het cursusmateriaal');
    expect(xml).toContain('[1] De leerstof noemt 5 procent.');
    expect(xml).toContain('Gebruikt cursusmateriaal');
    expect(xml).toContain('[1] Mediawijsheid, p. 3-4');
    expect(sourceLabel({ title: 'Dia', slideStart: 2 })).toBe('Dia, 2');
  });
});

describe('zoeken mislukt', () => {
  it('één zoekvraag mislukt: telt als leeg; alles mislukt: geen stil leeg commentaar', async () => {
    const persona = { id: 'm1', project_id: 'p1', name: 'Nakijkhulp', persona_type: 'evaluator', system_prompt: '', project_knowledge_doc_ids: [], course_knowledge: 'all' };
    const make = (search) => {
      const db = fakeDb({ persona });
      const runner = createPreassessmentRunner({
        supabaseAdmin: db, pgPool: { query: async () => ({ rows: [{ file_bytes: Buffer.from('x') }] }) },
        extractText: async () => PRODUCT, modelReady: () => true, callModel: async () => answer([]), searchCourse: search,
      });
      return { db, runner };
    };
    let n = 0;
    const one = make(async () => { n += 1; if (n === 1) throw new Error('kapot'); return []; });
    await one.runner.run('s1');
    expect(one.db.saved.some((r) => r.status === 'done')).toBe(true);
    const all = make(async () => { throw new Error('kapot'); });
    await all.runner.run('s1');
    expect(all.db.saved.find((r) => r.status === 'failed')?.error).toMatch(/cursusmateriaal/);
  });
});
