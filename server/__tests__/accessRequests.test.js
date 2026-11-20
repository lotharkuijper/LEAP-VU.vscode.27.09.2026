// Toegangsaanvragen van medewerkers: alleen @vu.nl en @amsterdamumc.nl mogen een vraag
// stellen en de cursuslijst zien; alleen een beheerder ziet de aanvragen en koppelt
// iemand aan een cursus. Beheerder en medewerker krijgen een e-mail.
import { describe, it, expect, beforeEach } from 'vitest';
import { registerAccessRequestRoutes, validateRequest, buildAdminMail, buildGrantMail } from '../access/accessRequests.js';

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const HIDDEN = '44444444-4444-4444-8444-444444444444';
const TEST = '55555555-5555-4555-8555-555555555555';
let tables;
let sent;
let me;

function fakeDb() {
  return {
    from(table) {
      const f = { eq: [], in: [] };
      let op = 'select';
      let payload = null;
      let head = false;
      const rows = () => (tables[table] ||= []);
      const match = (r) => f.eq.every(([k, v]) => r[k] === v) && f.in.every(([k, v]) => v.includes(r[k]));
      const run = () => {
        if (op === 'insert') { const row = { id: `r${rows().length + 1}`, status: 'open', granted_course_ids: [], created_at: 'nu', ...payload }; rows().push(row); return { data: row, error: null }; }
        if (op === 'upsert') {
          const ex = rows().find((r) => r.course_id === payload.course_id && r.user_id === payload.user_id);
          if (ex) Object.assign(ex, payload); else rows().push({ ...payload });
          return { error: null };
        }
        if (op === 'update') { rows().filter(match).forEach((r) => Object.assign(r, payload)); return { error: null }; }
        const hit = rows().filter(match);
        return head ? { count: hit.length, error: null } : { data: hit.map((r) => ({ ...r })), error: null };
      };
      const chain = {
        select(_c, o) { head = !!o?.head; return chain; },
        eq(k, v) { f.eq.push([k, v]); return chain; },
        in(k, v) { f.in.push([k, v]); return chain; },
        order() { return chain; },
        limit() { return chain; },
        insert(p) { op = 'insert'; payload = p; return chain; },
        upsert(p) { op = 'upsert'; payload = p; return chain; },
        update(p) { op = 'update'; payload = p; return chain; },
        async maybeSingle() { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data }; },
        async single() { return run(); },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return chain;
    },
  };
}

const routes = [];
const app = {};
for (const m of ['get', 'post']) app[m] = (path, fn) => routes.push({ m, path, fn });
registerAccessRequestRoutes(app, {
  supabaseAdmin: fakeDb(),
  requireAuthUser: async () => me,
  isAdminProfile: (p) => p?.role === 'admin',
  superuserEmail: 'baas@vu.nl',
  getEmailConfig: async () => ({ provider: 'test' }),
  sendEmail: async (_cfg, m) => { sent.push(m); return { ok: true }; },
  appUrl: () => 'https://leap.example',
});

function call(m, path, { params = {}, body = {}, query = {} } = {}) {
  const r = routes.find((x) => x.m === m && x.path === path);
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    r.fn({ params, body, query, get: () => '' }, res);
  });
}
const flush = () => new Promise((r) => setTimeout(r, 10));

const peter = { user: { id: 'peter', email: 'peter.van.grevelingen@vu.nl', email_confirmed_at: 'ja', user_metadata: {} }, profile: { role: 'student' } };
const studentVu = { user: { id: 's1', email: 's1@student.vu.nl', email_confirmed_at: 'ja' }, profile: { role: 'student' } };
const viaCanvas = { user: { id: 'c1', email: 'iemand@vu.nl', email_confirmed_at: 'ja', user_metadata: { source: 'canvas' } }, profile: { role: 'student' } };
const lothar = { user: { id: 'admin1', email: 'baas@vu.nl' }, profile: { role: 'admin' } };

beforeEach(() => {
  sent = [];
  tables = {
    courses: [
      { id: C2, name: 'Statistiek', description: 'x', is_active: true },
      { id: C1, name: 'Embryologie', description: 'y', is_active: true },
      { id: '33333333-3333-4333-8333-333333333333', name: 'Oud', is_active: false },
      { id: HIDDEN, name: 'Anatomie (verborgen)', is_active: true, student_visible: false },
      { id: TEST, name: 'Demo', is_active: true, is_test: true },
    ],
    profiles: [
      { id: 'peter', full_name: 'Peter', email: 'peter.van.grevelingen@vu.nl', role: 'student', last_active_course_id: null },
      { id: 'admin1', full_name: 'Beheer', email: 'baas@vu.nl', role: 'admin' },
      { id: 'admin2', full_name: 'Tweede', email: 'twee@vu.nl', role: 'admin' },
    ],
    course_members: [],
    access_requests: [],
  };
});

describe('controle van een aanvraag', () => {
  it('alleen bestaande actieve cursussen; vraag of cursus verplicht', () => {
    expect(validateRequest({ message: ' Hoi ', courseIds: [C1, C1, 'nope'], role: 'teacher' }, [C1, C2])).toEqual({ ok: true, message: 'Hoi', courseIds: [C1], role: 'teacher' });
    expect(validateRequest({ message: '', courseIds: [] }, [C1]).code).toBe('emptyRequest');
    expect(validateRequest({ courseIds: [C2], role: 'baas' }, [C2]).role).toBe('unsure');
  });
  it('e-mails ontsnappen html', () => {
    expect(buildAdminMail({ name: '<b>', email: 'a@vu.nl', message: '<script>', courseNames: [], role: 'unsure', url: 'u' }).html).not.toContain('<script>');
    expect(buildGrantMail({ name: 'P', courseName: 'Embryologie', role: 'teacher', url: 'u' }).text).toContain('als docent');
  });
});

describe('medewerker zonder cursus', () => {
  it('ziet dat die medewerker is en in geen cursus zit', async () => {
    me = peter;
    const r = await call('get', '/api/access/me');
    expect(r.body).toEqual({ staff: true, courseCount: 0, requests: [] });
  });

  it('ziet de actieve cursussen op alfabet; een studentadres niet', async () => {
    me = peter;
    expect((await call('get', '/api/access/catalog')).body.courses.map((c) => c.name)).toEqual(['Embryologie', 'Statistiek']);
    me = studentVu;
    expect((await call('get', '/api/access/catalog')).status).toBe(403);
  });

  it('stelt een vraag; de beheerders krijgen een mail', async () => {
    me = peter;
    const r = await call('post', '/api/access/requests', { body: { message: 'Graag meekijken', courseIds: [C1], role: 'teacher' } });
    expect(r.body.ok).toBe(true);
    expect(tables.access_requests[0]).toMatchObject({ user_id: 'peter', message: 'Graag meekijken', wished_course_ids: [C1], role_wish: 'teacher' });
    await flush();
    expect(sent.map((m) => m.to).sort()).toEqual(['baas@vu.nl', 'twee@vu.nl']);
    expect(sent[0].text).toContain('Embryologie');
    expect(sent[0].text).toContain('https://leap.example/admin?tab=access_requests');
  });

  it('een studentadres of een extern adres kan geen vraag stellen', async () => {
    me = studentVu;
    expect((await call('post', '/api/access/requests', { body: { message: 'x' } })).status).toBe(403);
    me = { user: { id: 'e', email: 'iemand@gmail.com' }, profile: {} };
    expect((await call('post', '/api/access/requests', { body: { message: 'x' } })).status).toBe(403);
    expect(tables.access_requests).toEqual([]);
  });

  it('een @vu.nl-account uit Canvas telt niet als medewerker (het adres komt van Canvas, niet van een bevestigde mailbox)', async () => {
    me = viaCanvas;
    expect((await call('get', '/api/access/me')).body.staff).toBe(false);
    expect((await call('get', '/api/access/catalog')).status).toBe(403);
    expect((await call('post', '/api/access/requests', { body: { message: 'x' } })).status).toBe(403);
  });

  it('hooguit drie open vragen tegelijk', async () => {
    me = peter;
    for (let i = 0; i < 3; i++) expect((await call('post', '/api/access/requests', { body: { message: `v${i}` } })).status).toBe(200);
    expect((await call('post', '/api/access/requests', { body: { message: 'v4' } })).body.code).toBe('tooMany');
  });
});

describe('cursussen die medewerkers niet zien', () => {
  it('geen cursus op "niet beschikbaar" en geen testcursus in de lijst, en ook niet aan te vragen', async () => {
    me = peter;
    expect((await call('get', '/api/access/catalog')).body.courses.map((c) => c.id)).toEqual([C1, C2]);
    const r = await call('post', '/api/access/requests', { body: { message: '', courseIds: [HIDDEN, TEST] } });
    expect(r.body.code).toBe('emptyRequest');
  });

  it('de beheerder kiest wel uit verborgen cursussen, nooit uit testcursussen', async () => {
    me = lothar;
    const ids = (await call('get', '/api/admin/access-requests')).body.courses.map((c) => c.id);
    expect(ids).toContain(HIDDEN);
    expect(ids).not.toContain(TEST);
  });

  it('niemand wordt via een aanvraag lid van een testcursus', async () => {
    const id = '66666666-6666-4666-8666-666666666666';
    tables.access_requests.push({ id, user_id: 'peter', status: 'open', granted_course_ids: [] });
    me = lothar;
    const r = await call('post', '/api/admin/access-requests/:id/grant', { params: { id }, body: { courseId: TEST, role: 'teacher' } });
    expect([r.status, r.body.code]).toEqual([409, 'testCourse']);
    expect(tables.course_members).toEqual([]);
  });
});

describe('beheerder', () => {
  it('alleen een beheerder ziet de aanvragen', async () => {
    me = peter;
    expect((await call('get', '/api/admin/access-requests')).status).toBe(403);
    expect((await call('post', '/api/admin/access-requests/:id/grant', { params: { id: C1 }, body: { courseId: C1, role: 'teacher' } })).status).toBe(403);
  });

  it('koppelt de medewerker als docent; die krijgt een mail; daarna afsluiten', async () => {
    me = peter;
    await call('post', '/api/access/requests', { body: { message: 'Graag', courseIds: [C1] } });
    tables.access_requests[0].id = '44444444-4444-4444-8444-444444444444';
    me = lothar;
    const list = await call('get', '/api/admin/access-requests');
    expect(list.body.requests[0]).toMatchObject({ user: { name: 'Peter', email: 'peter.van.grevelingen@vu.nl' }, wished: [C1], status: 'open' });
    sent = [];
    const id = '44444444-4444-4444-8444-444444444444';
    const g = await call('post', '/api/admin/access-requests/:id/grant', { params: { id }, body: { courseId: C1, role: 'teacher' } });
    expect(g.body).toEqual({ ok: true, granted: [C1], previousRole: null });
    expect(tables.course_members).toEqual([{ course_id: C1, user_id: 'peter', member_role: 'teacher', role: 'teacher' }]);
    expect(tables.profiles[0].last_active_course_id).toBe(C1);
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('peter.van.grevelingen@vu.nl');
    await call('post', '/api/admin/access-requests/:id/close', { params: { id } });
    expect(tables.access_requests[0]).toMatchObject({ status: 'closed', handled_by: 'admin1' });
    expect((await call('get', '/api/admin/access-requests')).body.requests).toEqual([]);
  });

  it('weigert een onbekende rol of ongeldig id', async () => {
    me = lothar;
    expect((await call('post', '/api/admin/access-requests/:id/grant', { params: { id: C1 }, body: { courseId: C1, role: 'baas' } })).status).toBe(400);
    expect((await call('post', '/api/admin/access-requests/:id/close', { params: { id: '../x' } })).status).toBe(400);
  });
});
