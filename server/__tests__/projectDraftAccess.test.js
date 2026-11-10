// Project in concept (2026-11-11): alleen de docent van de cursus of een beheerder
// komt erin (eigen testgroep). Een student die al in een groep is gezet, komt er
// pas in als de docent het project opent. Gedragstest met een nep-database.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = { members: [], teachers: [], profiles: {} };

vi.mock('../lib/supabase.js', () => ({
  SUPERUSER_EMAIL: 'super@vu.nl',
  supabaseAdmin: {
    from(table) {
      const f = {};
      const chain = {
        select() { return chain; },
        eq(col, val) { f[col] = val; return chain; },
        async maybeSingle() {
          if (table === 'project_group_members') {
            const m = db.members.find(x => x.group_id === f.group_id && x.user_id === f.user_id);
            return { data: m ? { id: 'm', project_groups: { projects: m.project } } : null };
          }
          if (table === 'course_members') {
            return { data: db.teachers.some(x => x.user_id === f.user_id && x.course_id === f.course_id) ? { user_id: f.user_id } : null };
          }
          if (table === 'profiles') return { data: db.profiles[f.id] || null };
          return { data: null };
        },
      };
      return chain;
    },
  },
}));
vi.mock('../lib/courseFeatureGate.js', () => ({ loadCourseFeatures: async () => ({}) }));

const { isGroupMember, userHasProjectAccess } = await import('../projects/access.js');

const draft = { status: 'draft', course_id: 'c1' };
const open = { status: 'active', course_id: 'c1' };

beforeEach(() => {
  db.members = [
    { group_id: 'gDraft', user_id: 'student', project: draft },
    { group_id: 'gDraft', user_id: 'teacher', project: draft },
    { group_id: 'gDraft', user_id: 'admin', project: draft },
    { group_id: 'gOpen', user_id: 'student', project: open },
  ];
  db.teachers = [{ user_id: 'teacher', course_id: 'c1' }];
  db.profiles = { admin: { role: 'admin', email: 'a@vu.nl' }, student: { role: 'student', email: 's@vu.nl' } };
});

describe('isGroupMember bij een project in concept', () => {
  it('een student is geen lid zolang het project een concept is', async () => {
    expect(await isGroupMember('gDraft', 'student')).toBe(false);
    expect(await isGroupMember('gOpen', 'student')).toBe(true);
  });

  it('de docent van de cursus en een beheerder wel (testgroep)', async () => {
    expect(await isGroupMember('gDraft', 'teacher')).toBe(true);
    expect(await isGroupMember('gDraft', 'admin')).toBe(true);
  });

  it('wie niet in de groep zit, is nooit lid', async () => {
    expect(await isGroupMember('gOpen', 'teacher')).toBe(false);
  });
});

describe('userHasProjectAccess bij een project in concept', () => {
  it('een student met cursustoegang komt er niet in', async () => {
    const student = { id: 'student', email: 's@vu.nl' };
    expect(await userHasProjectAccess(student, db.profiles.student, { id: 'p', ...draft })).toBe(false);
  });

  it('de docent van de cursus wel', async () => {
    expect(await userHasProjectAccess({ id: 'teacher' }, { role: 'docent' }, { id: 'p', ...draft })).toBe(true);
  });
});
