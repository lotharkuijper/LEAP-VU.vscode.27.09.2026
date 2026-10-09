// Analytics: geaggregeerd, zonder personen, en los van de rest van LEAP.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import {
  K_MIN, weekStart, periodStart, matchConcepts, buildConceptThermometer, weeklyQuizSeries,
  summarizeIngestion, summarizePlatform, featureOf,
} from '../analytics/aggregate.js';
import { createCollector, analyticsMiddleware, installFetchMeter, recordTokens, isLlmUrl } from '../analytics/collector.js';

const root = path.resolve(__dirname, '..', '..');

describe('weken en periodes', () => {
  it('week begint op maandag (UTC)', () => {
    expect(weekStart(new Date('2026-10-09T12:00:00Z'))).toBe('2026-10-05'); // vrijdag → maandag
    expect(weekStart(new Date('2026-10-05T00:00:00Z'))).toBe('2026-10-05');
    expect(weekStart(new Date('2026-10-11T23:59:00Z'))).toBe('2026-10-05'); // zondag
  });
  it('periode van N weken, begrensd', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    expect(periodStart(1, now)).toBe('2026-10-05');
    expect(periodStart(4, now)).toBe('2026-09-14');
    expect(periodStart('onzin', now)).toBe(periodStart(8, now));
  });
});

describe('begrippen herkennen in een vraag', () => {
  const concepts = [
    { name: 'Confounding', aliases: ['verstorende variabele'] },
    { name: 'p-waarde', aliases: [] },
    { name: 'RR', aliases: ['relatief risico'] },
  ];
  it('naam of alias als heel woord, zonder hoofdletters of accenten', () => {
    expect(matchConcepts('Wat is een VERSTORENDE variabele?', concepts)).toEqual(['Confounding']);
    expect(matchConcepts('Hoe lees ik de p waarde af', concepts)).toEqual(['p-waarde']);
    expect(matchConcepts('Uitleg over het relatief risico graag', concepts)).toEqual(['RR']);
  });
  it('geen valse treffers op deelwoorden of korte namen', () => {
    expect(matchConcepts('confoundingseffect', concepts)).toEqual([]);
    expect(matchConcepts('rr', concepts)).toEqual([]); // < 3 tekens telt niet
  });
});

describe('begrippen-thermometer: privacy', () => {
  const concepts = [{ name: 'Confounding', aliases: [] }, { name: 'Bias', aliases: [] }];
  const at = (student, topics, score, created_at = '2026-10-06T10:00:00Z') => ({ student_id: student, topics, score_percentage: score, created_at });

  it(`onder ${K_MIN} studenten geen cijfer, wel de melding dat het verborgen is`, () => {
    const attempts = [at('s1', ['Confounding'], 40), at('s2', ['Confounding'], 60), at('s1', ['Confounding'], 80)];
    const r = buildConceptThermometer({ attempts, concepts });
    const c = r.concepts.find(x => x.name === 'Confounding');
    expect(c.quiz).toEqual({ attempts: null, avgScore: null, suppressed: true });
    expect(r.concepts.find(x => x.name === 'Bias').quiz.suppressed).toBe(false); // geen data ≠ verborgen
    expect(r.quiz.avgScore).toBeNull();
  });

  it(`vanaf ${K_MIN} verschillende studenten: gemiddelde en aantal pogingen, nooit wie`, () => {
    const attempts = ['a', 'b', 'c', 'd', 'e'].map((s, i) => at(s, ['Confounding', 'Bias'], 50 + i * 10));
    const r = buildConceptThermometer({ attempts, concepts });
    expect(r.concepts[0].quiz).toEqual({ attempts: 5, avgScore: 70, suppressed: false });
    expect(JSON.stringify(r)).not.toMatch(/"(a|b|c|d|e)"/);
    expect(JSON.stringify(r)).not.toContain('student');
  });

  it('vijf pogingen van één student tellen niet als vijf studenten', () => {
    const attempts = Array.from({ length: 5 }, () => at('s1', ['Confounding'], 90));
    expect(buildConceptThermometer({ attempts, concepts }).concepts[0].quiz.suppressed).toBe(true);
  });

  it('chatvragen met en zonder bewijs per begrip', () => {
    const chatRows = [
      { kind: 'chat_concept_hit', key: 'Confounding', n: 3 },
      { kind: 'chat_concept_miss', key: 'Confounding', n: 2 },
      { kind: 'chat_concept_miss', key: 'Confounding', n: 1 },
      { kind: 'chat_evidence', key: 'hit', n: 10 },
      { kind: 'chat_evidence', key: 'miss', n: 4 },
    ];
    const r = buildConceptThermometer({ attempts: [], concepts, chatRows });
    expect(r.concepts[0].chat).toEqual({ asked: 6, misses: 3 });
    expect(r.chat).toEqual({ hit: 10, miss: 4 });
  });

  it('verloop per week ook met k-drempel per week', () => {
    const wk1 = ['a', 'b', 'c', 'd', 'e'].map(s => at(s, ['Bias'], 60, '2026-09-29T10:00:00Z'));
    const wk2 = [at('a', ['Bias'], 90, '2026-10-06T10:00:00Z')];
    expect(weeklyQuizSeries([...wk1, ...wk2])).toEqual([
      { week: '2026-09-28', avgScore: 60, attempts: 5 },
      { week: '2026-10-05', avgScore: null, attempts: null, suppressed: true },
    ]);
  });
});

describe('platform: inlezen, fouten en kosten', () => {
  it('inleesproblemen met dezelfde regels als "Klaar voor studenten"', () => {
    const s = summarizeIngestion([
      { processing_status: 'failed', file_size: 10 },
      { processing_status: 'processing' },
      { processing_status: 'completed', total_chunks: 0, file_size: 100 },
      { processing_status: 'completed', total_chunks: 1, file_size: 80000 },
      { processing_status: 'completed', total_chunks: 1, file_size: 80000, file_type: 'web' },
      { processing_status: 'completed', total_chunks: 12, file_size: 5000 },
    ]);
    expect(s).toMatchObject({ documents: 6, failed: 1, busy: 1, noChunks: 1, singleGiantChunk: 1, chunks: 14 });
  });
  it('vat tellers samen per onderdeel, cursus en week', () => {
    const C = '11111111-1111-1111-1111-111111111111';
    const r = summarizePlatform([
      { week: '2026-09-28', course_id: C, kind: 'api', key: 'quiz', n: 10, total: 5000 },
      { week: '2026-10-05', course_id: C, kind: 'api_error', key: 'quiz', n: 1, total: 0 },
      { week: '2026-10-05', course_id: C, kind: 'tokens', key: 'quiz', n: 4, total: 8000 },
      { week: '2026-10-05', course_id: null, kind: 'tokens', key: 'background', n: 1, total: 500 },
    ], { [C]: 'E&B1' });
    expect(r.since).toBe('2026-09-28');
    expect(r.parts.find(p => p.key === 'quiz')).toMatchObject({ requests: 10, errors: 1, avgMs: 500, errorRate: 0.1, llmCalls: 4, tokens: 8000 });
    expect(r.tokensByCourse).toEqual([{ courseId: C, name: 'E&B1', tokens: 8000 }, { courseId: null, name: null, tokens: 500 }]);
    expect(r.totals.tokens).toBe(8500);
  });
  it('onderdeel uit het pad; analytics meet zichzelf niet', () => {
    expect(featureOf('/api/quiz/generate')).toBe('quiz');
    expect(featureOf('/api/admin/course-files/abc')).toBe('admin/course-files');
    expect(featureOf('/api/chat', { purpose: 'tutor_chat' })).toBe('chat');
    expect(featureOf('/api/chat', {})).toBe('ai-calls');
    expect(featureOf('/api/analytics/platform')).toBeNull();
    expect(featureOf('/assets/x.js')).toBeNull();
  });
});

describe('verzamelen', () => {
  let server;
  afterEach(() => new Promise(r => (server ? server.close(() => r()) : r())));

  function appWith(collector, routes) {
    const app = express();
    app.use(express.json());
    app.use(analyticsMiddleware(collector, { conceptsFor: async () => [{ name: 'Confounding', aliases: [] }] }));
    routes(app);
    return new Promise(r => { server = app.listen(0, () => r(`http://127.0.0.1:${server.address().port}`)); });
  }
  const C = '22222222-2222-2222-2222-222222222222';

  it('tutorchat: bewijs ja/nee en begrip worden geteld, de vraag zelf niet', async () => {
    const collector = createCollector({ write: async () => {} });
    const base = await appWith(collector, app => app.post('/api/chat', (_q, res) => res.json({ ok: true })));
    const ask = (sources) => fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'tutor_chat', courseId: C, sources, messages: [{ role: 'user', content: 'Mijn naam is Piet, wat is confounding?' }] }),
    });
    await ask([]);
    await ask([{ title: 'x' }]);
    await new Promise(r => setTimeout(r, 30));
    const rows = collector.drain();
    const get = (kind, key) => rows.find(r => r.kind === kind && r.key === key)?.n;
    expect(get('chat_evidence', 'miss')).toBe(1);
    expect(get('chat_evidence', 'hit')).toBe(1);
    expect(get('chat_concept_miss', 'Confounding')).toBe(1);
    expect(get('chat_concept_hit', 'Confounding')).toBe(1);
    expect(get('api', 'chat')).toBe(2);
    expect(rows.every(r => r.course_id === C)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/Piet|naam/);
  });

  it('serverfouten en tokens per onderdeel en cursus', async () => {
    const collector = createCollector({ write: async () => {} });
    const base = await appWith(collector, app => {
      app.get('/api/quiz/:courseId/x', (_q, res) => { recordTokens(collector, 300); recordTokens(collector, 200); res.status(500).json({}); });
    });
    await fetch(`${base}/api/quiz/${C}/x`);
    await new Promise(r => setTimeout(r, 20));
    const rows = collector.drain();
    expect(rows.find(r => r.kind === 'api_error')).toMatchObject({ key: 'quiz', n: 1, course_id: C });
    expect(rows.find(r => r.kind === 'tokens')).toMatchObject({ key: 'quiz', n: 2, total: 500, course_id: C });
  });

  it('de fetch-meter leest usage uit Azure-antwoorden en laat het antwoord heel', async () => {
    const collector = createCollector({ write: async () => {} });
    const body = { choices: [{ message: { content: 'hoi' } }], usage: { total_tokens: 42 } };
    const target = { fetch: async () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }) };
    const restore = installFetchMeter(collector, target);
    const r = await target.fetch('https://x.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=1');
    expect((await r.json()).choices[0].message.content).toBe('hoi');
    await target.fetch('https://example.org/other');
    await new Promise(res => setTimeout(res, 20));
    expect(collector.drain()).toEqual([expect.objectContaining({ kind: 'tokens', key: 'background', total: 42 })]);
    restore();
    expect(isLlmUrl('https://x/openai/deployments/emb/embeddings?api-version=1')).toBe(true);
  });

  it('opslaan mislukt (bv. migratie ontbreekt): niets breekt, even pauze', async () => {
    let calls = 0;
    const collector = createCollector({ write: async () => { calls++; throw new Error('relation does not exist'); }, log: {} });
    collector.bump('api', 'quiz');
    expect(await collector.flush()).toBe(0);
    collector.bump('api', 'quiz');
    expect(await collector.flush()).toBe(0);
    expect(calls).toBe(1);
    expect(collector.size()).toBe(0); // buffer groeit niet door
  });
});

describe('routes: wie mag wat zien', () => {
  let server;
  afterEach(() => new Promise(r => (server ? server.close(() => r()) : r())));
  const C = '33333333-3333-3333-3333-333333333333';

  // Nagebootste PostgREST: elke tabel levert vaste rijen; filters doen er hier niet toe.
  function fakeDb(tables, { countersMissing = false } = {}) {
    const builder = (table) => {
      const result = () => (table === 'analytics_counters' && countersMissing)
        ? { data: null, error: { message: 'relation "analytics_counters" does not exist' } }
        : { data: tables[table] || [], error: null };
      const b = {};
      for (const m of ['select', 'eq', 'gte', 'order', 'in', 'not', 'contains']) b[m] = () => b;
      b.range = async () => result();
      b.maybeSingle = async () => ({ data: (tables[table] || [])[0] || null, error: null });
      b.then = (res, rej) => Promise.resolve(result()).then(res, rej);
      return b;
    };
    return { from: builder, rpc: async () => ({ error: null }) };
  }

  async function start({ role, staff, countersMissing }) {
    const { installAnalytics } = await import('../analytics/index.js');
    const attempts = ['a', 'b', 'c', 'd', 'e'].map(s => ({ student_id: s, topics: ['Bias'], score_percentage: 70, created_at: new Date().toISOString() }));
    const db = fakeDb({
      profiles: [{ role, email: 'x@vu.nl' }],
      concepts: [{ name: 'Bias', aliases: [], review_status: 'approved' }],
      quiz_attempts: attempts,
      analytics_counters: [{ week: '2026-10-05', course_id: C, kind: 'tokens', key: 'quiz', n: 1, total: 10 }],
      courses: [{ id: C, name: 'E&B1', is_active: true }],
    }, { countersMissing });
    const app = express();
    app.use(express.json());
    installAnalytics(app, {
      getDb: () => db, flushMs: 1e9,
      authUser: async () => ({ user: { id: 'u1' } }),
      isStaffForCourse: async () => staff,
      isLeapAdmin: (p) => p?.role === 'admin',
    });
    return new Promise(r => { server = app.listen(0, () => r(`http://127.0.0.1:${server.address().port}`)); });
  }

  it('docent van de cursus: thermometer zonder student-id\'s; geen platformoverzicht', async () => {
    const base = await start({ role: 'docent', staff: true });
    const r = await fetch(`${base}/api/analytics/courses/${C}/concepts`);
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.concepts[0]).toMatchObject({ name: 'Bias', quiz: { avgScore: 70, attempts: 5 } });
    expect(JSON.stringify(body)).not.toMatch(/student_id|"a"|"b"/);
    expect((await fetch(`${base}/api/analytics/platform`)).status).toBe(403);
  });

  it('geen docent van deze cursus: 403', async () => {
    const base = await start({ role: 'docent', staff: false });
    expect((await fetch(`${base}/api/analytics/courses/${C}/concepts`)).status).toBe(403);
  });

  it('beheerder: platformoverzicht; ontbrekende tabel geeft lege tellers, geen fout', async () => {
    const base = await start({ role: 'admin', staff: true, countersMissing: true });
    const r = await fetch(`${base}/api/analytics/platform`);
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.countersAvailable).toBe(false);
    expect(body.totals.tokens).toBe(0);
    expect(body.ingestion[0]).toMatchObject({ name: 'E&B1', documents: 0 });
  });
});

describe('losse module', () => {
  it('server/index.js raakt analytics alleen via één import en één aanroep', () => {
    const src = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
    expect(src.match(/^import .*'\.\/analytics\//gm)).toHaveLength(1);
    expect(src.match(/installAnalytics\(/g)).toHaveLength(1);
    expect(src).not.toMatch(/analytics_counters|recordTokens|analyticsMiddleware/);
  });
  it('de tabel bevat geen kolom die naar een persoon wijst', () => {
    const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261009100000_analytics_counters.sql'), 'utf8');
    const table = sql.slice(sql.indexOf('CREATE TABLE'), sql.indexOf(');', sql.indexOf('CREATE TABLE')));
    expect(table).not.toMatch(/user|student|profile|email|text_content|question/i);
    expect(fs.existsSync(path.join(root, 'supabase/rollback/20261009100000_analytics_counters_down.sql'))).toBe(true);
  });
});
