// Beeldoefeningen: elke route is alleen voor een docent van déze cursus of een
// admin. Een student, of een docent van een andere cursus, krijgt 403 en er
// gebeurt niets; ongeldige id's geven 400. Ook: een foto staat niet twee keer in
// de wachtrij voor kenmerken, en een voorstel op het oog is geremd.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ staffFor: new Set(), calls: [], generated: [] }));
const COURSE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const EX = '33333333-3333-4333-8333-333333333333';
const FEAT = '44444444-4444-4444-8444-444444444444';

vi.mock('../lib/auth.js', () => ({
  requireAuthUser: async () => ({ user: { id: 'u1' }, profile: { role: 'student' } }),
  isStaffForCourse: async (_u, _p, courseId) => h.staffFor.has(courseId),
}));
vi.mock('../lib/supabase.js', () => {
  const chain = { update: () => chain, eq: () => chain, in: () => chain, then: (r) => Promise.resolve({ error: null }).then(r) };
  return { supabaseAdmin: { from: () => chain } };
});
vi.mock('../lib/azureOpenai.js', () => ({
  AZURE_CHAT_READY: true, LLM_NOT_CONFIGURED_MSG: 'x', OPENAI_MODEL: 'm',
  chatModelParams: () => ({}), openaiChatCompletion: async () => ({ ok: true, json: async () => ({}) }),
}));
vi.mock('../imageExercises/service.js', () => {
  const rec = (name, out = { ok: true }) => async (...args) => { h.calls.push(name); return typeof out === 'function' ? out(...args) : out; };
  return {
    listExercises: rec('list', []),
    addPhoto: rec('addPhoto', { id: EX }),
    applyDescriptionText: rec('descriptions', { sections: 1, matched: [], unmatchedSections: [], alreadyConfirmed: 0 }),
    suggestMatches: rec('suggest', { suggestions: [] }),
    confirmExercises: rec('confirm', (_db, { ids }) => ({ confirmed: ids })),
    updateExercise: rec('update'),
    saveFeatures: rec('saveFeatures'),
    setFeatureCore: rec('setFeatureCore'),
    deleteExercise: rec('delete'),
    generateFeatures: async (_db, _llm, id) => { h.generated.push(id); await new Promise((r) => setTimeout(r, 20)); return { ok: true }; },
  };
});

const { registerImageExerciseRoutes } = await import('../imageExercises/routes.js');

const routes = [];
const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (path, fn) => routes.push({ m, path, fn });
registerImageExerciseRoutes(app);

function call(m, path, params, body = {}) {
  const r = routes.find((x) => x.m === m && x.path === path);
  if (!r) throw new Error(`geen route ${m} ${path}`);
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    r.fn({ params, body, headers: {} }, res);
  });
}

const base = '/api/admin/image-exercises/:courseId';
const ALL = [
  ['get', base, {}],
  ['post', `${base}/photos`, {}, { filename: 'a.jpg', data: 'AAAA' }],
  ['post', `${base}/descriptions`, {}, { text: 'Foto 1\nx' }],
  ['post', `${base}/suggest`, {}, { sections: ['x'] }],
  ['post', `${base}/confirm`, {}, { ids: [EX] }],
  ['patch', `${base}/:id`, { id: EX }, { depth: 'name' }],
  ['post', `${base}/:id/regenerate`, { id: EX }],
  ['put', `${base}/:id/features`, { id: EX }, { features: [{ label: 'x' }] }],
  ['patch', `${base}/features/:featureId`, { featureId: FEAT }, { isCore: false }],
  ['delete', `${base}/:id`, { id: EX }],
];

beforeEach(() => { h.staffFor = new Set(); h.calls = []; h.generated = []; });

describe('toegang tot beeldoefeningen', () => {
  it('alle routes zijn gedekt door deze test', () => {
    expect(routes.length).toBe(ALL.length);
  });

  it('wie geen docent van deze cursus is, krijgt overal 403 en er gebeurt niets', async () => {
    h.staffFor.add(OTHER); // docent van een andere cursus
    for (const [m, path, params, body] of ALL) {
      const r = await call(m, path, { courseId: COURSE, ...params }, body);
      expect(r.status, `${m} ${path}`).toBe(403);
    }
    expect(h.calls).toEqual([]);
  });

  it('ongeldige id’s geven 400, nog vóór de toegangscontrole', async () => {
    h.staffFor.add(COURSE);
    expect((await call('get', base, { courseId: '../etc' })).status).toBe(400);
    expect((await call('delete', `${base}/:id`, { courseId: COURSE, id: 'x' })).status).toBe(400);
    expect((await call('patch', `${base}/features/:featureId`, { courseId: COURSE, featureId: '1 or 1=1' })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });

  it('een docent van de cursus komt overal door', async () => {
    h.staffFor.add(COURSE);
    for (const [m, path, params, body] of ALL) {
      const r = await call(m, path, { courseId: COURSE, ...params }, body);
      expect(r.status, `${m} ${path}`).toBe(200);
    }
  });
});

describe('kosten binnen de perken', () => {
  it('een foto komt niet twee keer in de wachtrij voor kenmerken', async () => {
    await new Promise((r) => setTimeout(r, 100)); // werk uit de vorige test afronden
    h.generated = [];
    h.staffFor.add(COURSE);
    await call('post', `${base}/confirm`, { courseId: COURSE }, { ids: [EX, EX] });
    await call('post', `${base}/:id/regenerate`, { courseId: COURSE, id: EX });
    await new Promise((r) => setTimeout(r, 80));
    expect(h.generated).toEqual([EX]);
  });

  it('een tweede voorstel op het oog binnen een halve minuut wordt geweigerd', async () => {
    h.staffFor.add(OTHER);
    expect((await call('post', `${base}/suggest`, { courseId: OTHER }, { sections: ['x'] })).status).toBe(200);
    const again = await call('post', `${base}/suggest`, { courseId: OTHER }, { sections: ['x'] });
    expect(again.status).toBe(429);
    expect(again.body.code).toBe('suggestBusy');
  });
});
