// Speelbord-routes: alleen met toegang tot de cursus en als Ik leg uit aan staat;
// ongeldige id's geven 400; de poging is altijd van de ingelogde gebruiker; en er is
// een rem op het aantal aanroepen van het taalmodel.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ access: true, featureOn: true, calls: [] }));
const COURSE = '11111111-1111-4111-8111-111111111111';
const EX = '33333333-3333-4333-8333-333333333333';

vi.mock('../lib/auth.js', () => ({
  requireAuthUser: async () => ({ user: { id: 'me' }, profile: { role: 'student' } }),
  userHasCourseAccess: async () => h.access,
  isStaffForCourse: async () => false,
}));
vi.mock('../lib/courseFeatureGate.js', () => ({
  rejectIfFeatureOff: async (res) => {
    if (h.featureOn) return false;
    res.status(403).json({ error: 'uit', code: 'feature_disabled' });
    return true;
  },
}));
vi.mock('../lib/supabase.js', () => ({ supabaseAdmin: {} }));
vi.mock('../lib/azureOpenai.js', () => ({ AZURE_CHAT_READY: true, LLM_NOT_CONFIGURED_MSG: 'x', OPENAI_MODEL: 'm', chatModelParams: () => ({}), openaiChatCompletion: async () => ({}) }));
vi.mock('../imageExercises/playService.js', () => {
  const rec = (name) => async (_db, ...rest) => { h.calls.push({ name, args: rest }); return { ok: true }; };
  return {
    listForStudent: rec('list'), startAttempt: rec('start'), restartAttempt: rec('restart'),
    answer: rec('answer'), hint: rec('hint'), finish: rec('finish'),
  };
});

const { registerImageExercisePlayRoutes, PLAY_RATE } = await import('../imageExercises/playRoutes.js');
const routes = [];
const app = {};
for (const m of ['get', 'post']) app[m] = (path, fn) => routes.push({ m, path, fn });
registerImageExercisePlayRoutes(app);

function call(m, path, params, body = {}) {
  const r = routes.find((x) => x.m === m && x.path === path);
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    r.fn({ params, body, get: () => 'nl' }, res);
  });
}

const base = '/api/image-exercises/:courseId';
const ALL = [
  ['get', base, {}],
  ['post', `${base}/:id/start`, { id: EX }],
  ['post', `${base}/:id/restart`, { id: EX }],
  ['post', `${base}/:id/answer`, { id: EX }, { text: 'iets' }],
  ['post', `${base}/:id/hint`, { id: EX }],
  ['post', `${base}/:id/finish`, { id: EX }],
];

beforeEach(() => { h.access = true; h.featureOn = true; h.calls = []; });

describe('toegang tot het speelbord', () => {
  it('alle routes zijn gedekt', () => { expect(routes.length).toBe(ALL.length); });

  it('zonder toegang tot de cursus: overal 403 en niets gedaan', async () => {
    h.access = false;
    for (const [m, path, params, body] of ALL) expect((await call(m, path, { courseId: COURSE, ...params }, body)).status, path).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('als Ik leg uit uit staat: overal 403', async () => {
    h.featureOn = false;
    for (const [m, path, params, body] of ALL) expect((await call(m, path, { courseId: COURSE, ...params }, body)).body.code, path).toBe('feature_disabled');
    expect(h.calls).toEqual([]);
  });

  it('ongeldige id’s: 400', async () => {
    expect((await call('post', `${base}/:id/start`, { courseId: COURSE, id: '../x' })).status).toBe(400);
    expect((await call('get', base, { courseId: 'nope' })).status).toBe(400);
  });

  it('de poging is altijd van de ingelogde gebruiker', async () => {
    await call('post', `${base}/:id/answer`, { courseId: COURSE, id: EX }, { text: 'iets', userId: 'iemand-anders' });
    expect(h.calls[0].args.at(-1)).toMatchObject({ userId: 'me', courseId: COURSE, id: EX, text: 'iets' });
  });

  it('rem: na het maximum aantal aanroepen een 429', async () => {
    let last;
    for (let i = 0; i <= PLAY_RATE.MAX_CALLS; i++) last = await call('post', `${base}/:id/hint`, { courseId: COURSE, id: EX });
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('slowDown');
  });
});
