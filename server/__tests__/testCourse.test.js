// Testcursus: alleen een beheerder zet hem aan of uit, en alleen als er geen leden
// zijn die geen beheerder zijn. De database bewaakt dat ook (migratie
// 20261123100000_course_is_test); de server zet een testcursus op gesloten.
import { describe, it, expect, beforeEach } from 'vitest';
import { registerTestCourseRoutes, countNonAdmins, isTestCourseError } from '../courses/testCourse.js';
import { registerEnrollmentRoutes } from '../courses/enrollment.js';

const C = '11111111-1111-4111-8111-111111111111';
let tables;
let who;

function fakeDb() {
  return {
    from(table) {
      const eqs = [];
      let ins = null;
      let patch = null;
      const rows = () => (tables[table] ||= []);
      const hit = () => rows().filter((r) => eqs.every(([k, v]) => r[k] === v) && (!ins || ins[1].includes(r[ins[0]])));
      const run = () => {
        if (patch) { hit().forEach((r) => Object.assign(r, patch)); return { data: hit()[0] || null, error: null }; }
        return { data: hit().map((r) => ({ ...r })), error: null };
      };
      const chain = {
        select() { return chain; },
        eq(k, v) { eqs.push([k, v]); return chain; },
        in(k, v) { ins = [k, v]; return chain; },
        update(p) { patch = p; return chain; },
        order() { return chain; },
        async maybeSingle() { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }; },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return chain;
    },
  };
}

let handler;
registerTestCourseRoutes({ patch: (_p, fn) => { handler = fn; } }, {
  supabaseAdmin: fakeDb(),
  resolveAdminUser: async () => who,
  superuserEmail: 'Baas@vu.nl',
});

function call(body, id = C) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
    handler({ params: { id }, body }, res);
  });
}

const admin = { user: { id: 'a1' }, isAdmin: true };
const teacher = { user: { id: 't1' }, isAdmin: false, isDocent: true };

beforeEach(() => {
  tables = {
    courses: [{ id: C, is_test: false, enrollment_mode: 'open' }],
    course_members: [{ course_id: C, user_id: 'a1' }, { course_id: C, user_id: 'boss' }],
    course_alumni: [],
    profiles: [{ id: 'a1', role: 'admin', email: 'a@vu.nl' }, { id: 'boss', role: 'student', email: 'baas@vu.nl' }, { id: 's1', role: 'student', email: 's@x.nl' }],
  };
});

describe('testcursus aan- en uitzetten', () => {
  it('alleen een beheerder', async () => {
    who = teacher;
    expect((await call({ is_test: true })).status).toBe(403);
    expect(tables.courses[0].is_test).toBe(false);
  });

  it('met alleen beheerders als lid: testcursus en gesloten', async () => {
    who = admin;
    const r = await call({ is_test: true });
    expect(r.status).toBe(200);
    expect(tables.courses[0]).toMatchObject({ is_test: true, enrollment_mode: 'closed' });
    expect((await call({ is_test: false })).status).toBe(200);
    expect(tables.courses[0]).toMatchObject({ is_test: false, enrollment_mode: 'closed' });
  });

  it('niet zolang er een student of oud-deelnemer in zit', async () => {
    who = admin;
    tables.course_members.push({ course_id: C, user_id: 's1' });
    expect((await call({ is_test: true })).body).toMatchObject({ code: 'hasMembers', count: 1 });
    tables.course_members.pop();
    tables.course_alumni.push({ course_id: C, user_id: 's1' });
    expect((await call({ is_test: true })).body.code).toBe('hasMembers');
    expect(tables.courses[0].is_test).toBe(false);
  });

  it('weigert vage waarden en vreemde ids', async () => {
    who = admin;
    expect((await call({ is_test: 'true' })).status).toBe(400);
    expect((await call({ is_test: true }, 'abc')).status).toBe(400);
    expect((await call({ is_test: true }, '22222222-2222-4222-8222-222222222222')).status).toBe(404);
  });
});

describe('hulpjes', () => {
  it('telt leden die geen beheerder zijn (hoofdbeheerder telt als beheerder)', () => {
    expect(countNonAdmins(['a1', 'boss', 's1', 's1'], tables.profiles, 'baas@vu.nl')).toBe(1);
  });
  it('herkent de weigering van de database', () => {
    expect(isTestCourseError({ message: 'x', hint: 'leap_test_course' })).toBe(true);
    expect(isTestCourseError({ message: 'Alleen beheerders kunnen lid zijn van een testcursus' })).toBe(true);
    expect(isTestCourseError({ message: 'duplicate key' })).toBe(false);
  });
});

describe('nergens te kiezen', () => {
  it('een testcursus staat niet in de lijst voor open registratie', async () => {
    tables.courses = [
      { id: C, name: 'Demo', is_active: true, student_visible: true, enrollment_mode: 'open', is_test: true },
      { id: '33333333-3333-4333-8333-333333333333', name: 'Open', is_active: true, student_visible: true, enrollment_mode: 'open', is_test: false },
    ];
    const got = {};
    registerEnrollmentRoutes({ get: (p, fn) => { got[p] = fn; }, post() {}, put() {}, patch() {}, delete() {} }, { supabaseAdmin: fakeDb() });
    const body = await new Promise((resolve) => got['/api/courses/open']({}, { status() { return this; }, json: resolve }));
    expect(body.courses.map((c) => c.name)).toEqual(['Open']);
  });
});
