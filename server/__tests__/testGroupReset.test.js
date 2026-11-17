// Testgroep opnieuw beginnen: alleen de docent/admin zelf, alleen in een groep
// die hij zelf aanmaakte, waar niemand anders in zit en waar niemand anders iets
// in heeft gezet. Werk van studenten (ook van oud-leden) mag nooit verdwijnen.
import { describe, it, expect, beforeEach } from 'vitest';
import { resetTestGroup } from '../projects/testGroupReset.js';

let state;

function fakeDb() {
  return {
    from(table) {
      const eq = {};
      const neq = {};
      const inn = {};
      let op = 'select';
      let payload = null;
      let head = false;
      const rows = () => (state.content[table] || []).filter((r) =>
        Object.entries(eq).every(([k, v]) => r[k] === v)
        && Object.entries(neq).every(([k, v]) => r[k] != null && r[k] !== v)
        && Object.entries(inn).every(([k, v]) => v.includes(r[k])));
      const run = () => {
        if (op === 'delete') { state.deleted.push({ table, ...eq }); return { error: null }; }
        if (op === 'insert') {
          state.inserted.push({ table, row: payload });
          if (table === 'project_groups') return { data: { id: 'gNew', ...payload }, error: null };
          return { error: null };
        }
        if (op === 'upsert') { state.upserted.push({ table, row: payload }); return { error: null }; }
        if (head) return { count: rows().length, error: null };
        if (table === 'project_groups') return { data: state.groups.find((g) => g.id === eq.id) || null };
        if (table === 'projects') return { data: state.projects.find((p) => p.id === eq.id) || null };
        if (table === 'project_group_members') return { data: state.members.filter((m) => m.group_id === eq.group_id) };
        return { data: rows(), error: null };
      };
      const chain = {
        select(_c, opts) { head = !!opts?.head; return chain; },
        eq(col, val) { eq[col] = val; return chain; },
        neq(col, val) { neq[col] = val; return chain; },
        in(col, val) { inn[col] = val; return chain; },
        delete() { op = 'delete'; return chain; },
        insert(row) { op = 'insert'; payload = row; return chain; },
        upsert(row) { op = 'upsert'; payload = row; return Promise.resolve(run()); },
        async maybeSingle() { return run(); },
        async single() { return run(); },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return chain;
    },
  };
}

const call = (over = {}) => resetTestGroup(fakeDb(), {
  groupId: 'gTest',
  userId: 'teacher',
  isStaffFor: async (courseId) => courseId === 'c1',
  genInviteCode: () => 'ABC123',
  ...over,
});

beforeEach(() => {
  state = {
    groups: [
      { id: 'gTest', project_id: 'p1', name: 'Testgroep van docent', created_by: 'teacher' },
      { id: 'gStudents', project_id: 'p1', name: 'Groep 1', created_by: 'student' },
    ],
    projects: [{ id: 'p1', course_id: 'c1', status: 'draft' }],
    members: [
      { group_id: 'gTest', user_id: 'teacher' },
      { group_id: 'gStudents', user_id: 'teacher' },
      { group_id: 'gStudents', user_id: 'student' },
    ],
    content: {
      group_chat_messages: [{ id: 'm1', group_id: 'gTest', user_id: 'teacher' }],
      group_persona_threads: [{ id: 't1', group_id: 'gTest' }],
      group_persona_messages: [
        { id: 'pm1', thread_id: 't1', role: 'user', user_id: 'teacher' },
        { id: 'pm2', thread_id: 't1', role: 'assistant', user_id: null },
      ],
    },
    deleted: [], inserted: [], upserted: [],
  };
});

describe('resetTestGroup', () => {
  it('maakt de eigen testgroep leeg en geeft een nieuwe met dezelfde naam', async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body.group).toMatchObject({ id: 'gNew', name: 'Testgroep van docent', project_id: 'p1', created_by: 'teacher' });
    expect(state.deleted).toEqual([{ table: 'project_groups', id: 'gTest', created_by: 'teacher' }]);
    expect(state.inserted).toContainEqual({ table: 'project_group_members', row: { group_id: 'gNew', user_id: 'teacher', role: 'owner' } });
    expect(state.upserted[0].row).toMatchObject({ student_id: 'teacher', group_id: 'gNew', status: 'in_progress' });
  });

  it('een student kan het niet, ook niet in een groep van één', async () => {
    state.members = [{ group_id: 'gTest', user_id: 'student' }];
    const r = await call({ userId: 'student', isStaffFor: async () => false });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('notStaff');
    expect(state.deleted).toEqual([]);
  });

  it('nooit een groep waar ook een student in zit', async () => {
    const r = await call({ groupId: 'gStudents' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('notTestGroup');
    expect(state.deleted).toEqual([]);
  });

  it('nooit een groep die iemand anders aanmaakte, ook al zit je er nu alleen in', async () => {
    state.members = [{ group_id: 'gStudents', user_id: 'teacher' }];
    const r = await call({ groupId: 'gStudents' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('notTestGroup');
    expect(state.deleted).toEqual([]);
  });

  it('nooit als een (oud-)lid er werk in achterliet', async () => {
    for (const [table, row] of [
      ['group_chat_messages', { id: 'x', group_id: 'gTest', user_id: 'student' }],
      ['project_submissions', { id: 'x', group_id: 'gTest', uploaded_by: 'student' }],
      ['group_checkpoints', { id: 'x', group_id: 'gTest', created_by: 'student' }],
      ['group_persona_messages', { id: 'x', thread_id: 't1', role: 'user', user_id: 'student' }],
    ]) {
      const before = state.content[table] || [];
      state.content[table] = [...before, row];
      const r = await call();
      expect(r.status, table).toBe(403);
      expect(r.body.code).toBe('notTestGroup');
      state.content[table] = before;
    }
    expect(state.deleted).toEqual([]);
  });

  it('niet de testgroep van een andere docent', async () => {
    const r = await call({ userId: 'otherTeacher' });
    expect(r.status).toBe(403);
    expect(state.deleted).toEqual([]);
  });

  it('niet in een gearchiveerd project, en 404 bij een onbekende groep', async () => {
    state.projects[0].status = 'archived';
    expect((await call()).status).toBe(400);
    expect((await call({ groupId: 'nope' })).status).toBe(404);
    expect(state.deleted).toEqual([]);
  });
});
