// "Verbeter deze uitleg" (server/flawedExplanations.js, 2026-10-20): oefening ter
// plekke gemaakt en blind gecontroleerd, antwoorden alleen versleuteld bij de
// student, onderdeel per cursus uit te zetten. Echte Express-app, nep-taalmodel.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeErrorType, pickErrorCount, structuralCheck, matchVerification, makeExercise,
  sealExercise, openExercise, parseEvaluation, createDailyLimiter, registerFlawedExplanationRoutes,
  TOKEN_TTL_MS, generateSystem, VERIFY_SYSTEM, evaluationSystem,
} from '../explain/flawedExplanations.js';
import { routeSource } from './helpers/serverSource.js';
import { normalizeCourseFeatures, explainPartOn, explainPartsValid, mergeCourseFeatures, parseCourseFeaturesPatch } from '../courses/courseFeatures.js';

const root = path.resolve(__dirname, '..', '..');
const SECRET = 'test-secret';

const FLAWED = 'Een begrip A is altijd gelijk aan B. Daarom volgt C uit D. Verder geldt E onder voorwaarde F.';
const gen = (k = 1) => ({
  juist: 'Een begrip A is soms gelijk aan B. Daarom volgt C uit D. Verder geldt E onder voorwaarde F.',
  fout: FLAWED,
  fouten: [
    { zin: 'Een begrip A is altijd gelijk aan B', soort: 'te_smal', waarom_fout: 'niet altijd', juist_is: 'soms', bron: 1 },
    { zin: 'Daarom volgt C uit D', soort: 'oorzaak-gevolg', waarom_fout: 'omgekeerd', juist_is: 'D volgt uit C', bron: 2 },
    { zin: 'Verder geldt E onder voorwaarde F', soort: 'voorwaarde_weggelaten', waarom_fout: 'zonder G', juist_is: 'ook G', bron: 1 },
  ].slice(0, k),
});
const verifyOk = (k = 1) => ({
  onjuistheden: [
    { citaat: 'Een begrip A is altijd gelijk aan B.', waarom: 'x', ernst: 'wezenlijk', bron: 1 },
    { citaat: 'Daarom volgt C uit D.', waarom: 'y', ernst: 'wezenlijk', bron: 2 },
    { citaat: 'Verder geldt E onder voorwaarde F.', waarom: 'z', ernst: 'wezenlijk', bron: 1 },
  ].slice(0, k),
  tegenstrijdig: false,
});
const chunks = [{ content: 'fragment een', documentId: 'd1', title: 'Doc 1' }, { content: 'fragment twee', documentId: 'd2', title: 'Doc 2' }];

describe('fouten maken en controleren', () => {
  it('soorten met een net andere schrijfwijze horen bij de vaste lijst', () => {
    expect(normalizeErrorType('te_smal')).toBe('te_ruim_te_smal');
    expect(normalizeErrorType('oorzaak-gevolg')).toBe('oorzaak_gevolg');
    expect(normalizeErrorType('iets anders')).toBe(null);
  });
  it('kiest 1, 2 of 3 fouten', () => {
    expect(pickErrorCount(() => 0.1)).toBe(1);
    expect(pickErrorCount(() => 0.5)).toBe(2);
    expect(pickErrorCount(() => 0.9)).toBe(3);
  });
  it('vormcontrole: aantal, terug te vinden zin en bron', () => {
    expect(structuralCheck(gen(2), 2, 2)).toBe(null);
    expect(structuralCheck(gen(1), 2, 2)).toMatch(/aantal/);
    const g = gen(1); g.fouten[0].zin = 'iets wat er niet staat helemaal niet'; expect(structuralCheck(g, 1, 2)).toMatch(/terug te vinden/);
    const h = gen(1); h.fouten[0].bron = 9; expect(structuralCheck(h, 1, 2)).toMatch(/bron/);
  });
  it('blinde controle: alleen goed bij precies de bedoelde, wezenlijke fouten', () => {
    expect(matchVerification(gen(2), verifyOk(2)).ok).toBe(true);
    expect(matchVerification(gen(2), verifyOk(1)).reason).toMatch(/niet gevonden/);
    const marg = verifyOk(1); marg.onjuistheden[0].ernst = 'marginaal';
    expect(matchVerification(gen(1), marg).reason).toMatch(/marginaal/);
    const extra = verifyOk(1); extra.onjuistheden.push({ citaat: 'Verder geldt E onder voorwaarde F.', ernst: 'wezenlijk' });
    expect(matchVerification(gen(1), extra).reason).toMatch(/extra/);
    expect(matchVerification(gen(1), { ...verifyOk(1), tegenstrijdig: true }).ok).toBe(true); // geen afkeurgrond
    expect(matchVerification(gen(1), null).ok).toBe(false);
  });
  it('probeert opnieuw en geeft het na 3 pogingen op', async () => {
    let calls = 0;
    const llmJson = async (system) => { calls++; return system === VERIFY_SYSTEM ? { onjuistheden: [] } : gen(1); };
    const r = await makeExercise({ concept: { name: 'A' }, chunks, llmJson, rand: () => 0.1 });
    expect(r.ok).toBe(false);
    expect(r.attempts).toHaveLength(3);
    expect(calls).toBe(6);
  });
  it('geeft een goedgekeurde oefening terug', async () => {
    const llmJson = async (system) => (system === VERIFY_SYSTEM ? verifyOk(1) : gen(1));
    const r = await makeExercise({ concept: { name: 'A' }, chunks, llmJson, rand: () => 0.1 });
    expect(r.ok).toBe(true);
    expect(r.exercise.errors[0]).toMatchObject({ type: 'te_ruim_te_smal', source: 1 });
  });
});

describe('versleuteld pakketje', () => {
  it('alleen de server kan het openen; aanpassen of verlopen = ongeldig', () => {
    const now = 1_000_000;
    const t = sealExercise({ uid: 'u1', errors: [{ sentence: 'geheim' }] }, SECRET, now);
    expect(t).not.toMatch(/geheim/);
    expect(Buffer.from(t, 'base64url').toString('utf8')).not.toMatch(/geheim/);
    expect(openExercise(t, SECRET, now).uid).toBe('u1');
    expect(openExercise(t, 'ander-geheim', now)).toBe(null);
    const i = 40;
    const tampered = t.slice(0, i) + (t[i] === 'A' ? 'B' : 'A') + t.slice(i + 1);
    expect(openExercise(tampered, SECRET, now)).toBe(null);
    expect(openExercise(t, SECRET, now + TOKEN_TTL_MS + 1)).toBe(null);
  });
});

describe('beoordeling uitlezen', () => {
  it('leest de blokken en het aantal gevonden fouten', () => {
    const p = parseEvaluation('### FOUND\n2/3\n- a gevonden\n### REASONING\nGoed.\n### WRONGLY_FLAGGED\n-\n### NEXT_STEP\nLees [1].', 3);
    expect(p).toMatchObject({ found: 2, total: 3, reasoning: 'Goed.', wronglyFlagged: '', nextStep: 'Lees [1].' });
    expect(p.foundDetail).toMatch(/gevonden/);
    expect(parseEvaluation('### FOUND\n5/3', 3).found).toBe(3);
    expect(parseEvaluation('geen kopjes', 2)).toBe(null);
  });
  it('de beoordelaar verraadt gemiste fouten niet in de feedback', () => {
    expect(evaluationSystem('nl')).toMatch(/NIET bij naam/);
  });
});

describe('dagelijkse limiet', () => {
  it('telt per gebruiker per dag', () => {
    const l = createDailyLimiter(2);
    const d = new Date('2026-10-20T10:00:00Z');
    expect(l.take('u', d)).toBe(true);
    expect(l.take('u', d)).toBe(true);
    expect(l.take('u', d)).toBe(false);
    expect(l.take('v', d)).toBe(true);
    expect(l.take('u', new Date('2026-10-21T10:00:00Z'))).toBe(true);
  });
});

describe('onderdelen van Ik leg uit', () => {
  it('standaard beide aan; alleen geldig als Ik leg uit aan staat', () => {
    expect(normalizeCourseFeatures(null)).toMatchObject({ explainSelf: true, explainImprove: true });
    expect(explainPartOn({ explainImprove: false }, 'explainImprove')).toBe(false);
    expect(explainPartOn({ explain: false }, 'explainSelf')).toBe(false);
    expect(explainPartOn({}, 'explainSelf')).toBe(true);
  });
  it('minstens één van beide blijft aan; uit wordt bewaard als false', () => {
    expect(parseCourseFeaturesPatch({ features: { explainImprove: false } }).ok).toBe(true);
    expect(mergeCourseFeatures({}, { explainImprove: false })).toEqual({ explainImprove: false });
    expect(explainPartsValid(mergeCourseFeatures({ explainImprove: false }, { explainSelf: false }))).toBe(false);
    expect(explainPartsValid({ explainSelf: false })).toBe(true);
  });
  it('de server weigert "beide uit" en Leg zelf uit controleert zijn eigen schakelaar', () => {
    expect(routeSource("app.patch('/api/courses/:id/features'")).toMatch(/explainNeedsOnePart/);
    expect(routeSource("app.post('/api/explain/evaluate'")).toMatch(/rejectIfFeatureOff\(res, auth\.user, auth\.profile, scopeCourseId, 'explainSelf'\)/);
  });
  it('browser en server kennen dezelfde onderdelen', () => {
    const ts = fs.readFileSync(path.join(root, 'src/lib/courseFeatures.ts'), 'utf8');
    expect(ts).toMatch(/EXPLAIN_PARTS = \['explainSelf', 'explainImprove'\] as const/);
  });
});

describe('vakneutraal', () => {
  it('de vaste instructies bevatten geen vakinhoud', () => {
    const DOMAIN = /epidemiolog|biostatist|odds ratio|confounder|prevalentie|incidentie|betrouwbaarheidsinterval|regressie|patiënt|ziekte/i;
    for (const p of [generateSystem('nl'), VERIFY_SYSTEM, evaluationSystem('nl')]) expect(p).not.toMatch(DOMAIN);
  });
});

// ── Routes ──────────────────────────────────────────────────────────────────
let server;
let state;
async function call(method, url, body, user = 'u1') {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { 'Content-Type': 'application/json', 'x-user': user } }, (res) => {
      let raw = ''; res.on('data', c => (raw += c)); res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

function fakeDb() {
  return {
    from(table) {
      const f = {};
      const b = {
        select: () => b, limit: () => b, order: () => b,
        eq: (k, v) => { f[k] = v; return b; },
        maybeSingle: async () => ({ data: (state.db[table] || []).find(r => Object.entries(f).every(([k, v]) => r[k] === v)) || null, error: null }),
        insert: (row) => { state.inserts.push({ table, row }); return { select: () => ({ single: async () => ({ data: { id: 'j1' }, error: null }) }) }; },
        then: (res) => res({ data: (state.db[table] || []).filter(r => Object.entries(f).every(([k, v]) => r[k] === v)), error: null }),
      };
      return b;
    },
  };
}

beforeEach(async () => {
  state = {
    db: { concepts: [{ id: 'c1', name: 'A', definition: 'def', course_id: 'k1', review_status: 'approved' }] },
    inserts: [],
    features: {},
    journal: true,
    verify: null,
  };
  const app = express();
  app.use(express.json());
  registerFlawedExplanationRoutes(app, {
    supabaseAdmin: fakeDb(),
    requireAuthUser: async (req) => ({ user: { id: req.headers['x-user'] }, profile: { role: 'student' } }),
    userHasCourseAccess: async () => true,
    rejectIfFeatureOff: async (res, _u, _p, _c, feature) => {
      if (state.features[feature] === false) { res.status(403).json({ code: 'feature_disabled', feature }); return true; }
      return false;
    },
    courseFeatureOnFor: async () => state.journal,
    isStaffForCourse: async () => false,
    getChunks: async () => chunks,
    llmJson: async (system, user) => {
      const k = Number((String(user).match(/K = (\d)/) || [])[1] || state.lastK);
      if (system !== VERIFY_SYSTEM) { state.lastK = k; return gen(k); }
      return state.verify || verifyOk(state.lastK);
    },
    llmText: async () => '### FOUND\n1/1\n- gevonden\n### REASONING\nGoed.\n### WRONGLY_FLAGGED\n-\n### NEXT_STEP\nVerder.',
    secret: SECRET,
    resolveJournalCourseId: async (c) => c,
    llmReady: true,
    limiter: createDailyLimiter(100),
  });
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
});
afterEach(async () => { await new Promise(r => server.close(r)); });

describe('routes', () => {
  it('maakt een oefening zonder de antwoorden te tonen', async () => {
    const r = await call('POST', '/api/explain/improve/create', { conceptId: 'c1' });
    expect(r.status).toBe(200);
    expect(r.body.text).toBe(FLAWED);
    expect(JSON.stringify(r.body)).not.toMatch(/niet altijd|soms gelijk/);
    expect(state.inserts).toHaveLength(0); // niets bewaard
  });
  it('onderdeel uit = geweigerd', async () => {
    state.features.explainImprove = false;
    expect((await call('POST', '/api/explain/improve/create', { conceptId: 'c1' })).status).toBe(403);
    state.features = { explain: false };
    expect((await call('POST', '/api/explain/improve/create', { conceptId: 'c1' })).status).toBe(403);
  });
  it('geen goedgekeurde oefening = nette melding', async () => {
    state.verify = { onjuistheden: [] };
    const r = await call('POST', '/api/explain/improve/create', { conceptId: 'c1' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('noExercise');
  });
  it('beoordeelt en onthult pas daarna; een ander kan het pakketje niet gebruiken', async () => {
    const { body } = await call('POST', '/api/explain/improve/create', { conceptId: 'c1' });
    expect((await call('POST', '/api/explain/improve/evaluate', { token: body.token, answer: 'x' }, 'u2')).status).toBe(403);
    expect((await call('POST', '/api/explain/improve/evaluate', { token: 'rommel', answer: 'x' })).status).toBe(400);
    const r = await call('POST', '/api/explain/improve/evaluate', { token: body.token, answer: 'A is niet altijd B' });
    expect(r.status).toBe(200);
    expect(r.body.feedback).toMatchObject({ found: 1, total: r.body.reveal.errors.length });
    expect(r.body.reveal.errors[0].why).toBe('niet altijd');
    expect(r.body.reveal.sources[0]).toMatchObject({ index: 1, title: 'Doc 1' });
  });
  it('reflectie alleen als het dagboek aan staat', async () => {
    const { body } = await call('POST', '/api/explain/improve/create', { conceptId: 'c1' });
    state.journal = false;
    expect((await call('POST', '/api/explain/improve/reflect', { token: body.token, answer: 'a', feedback: {} })).status).toBe(403);
    expect(state.inserts).toHaveLength(0);
    state.journal = true;
    const r = await call('POST', '/api/explain/improve/reflect', { token: body.token, answer: 'a', feedback: { found: 1 } });
    expect(r.status).toBe(200);
    expect(state.inserts[0]).toMatchObject({ table: 'learning_journal_entries', row: { user_id: 'u1', course_id: 'k1', activity_type: 'explanation_reflection' } });
  });
});
