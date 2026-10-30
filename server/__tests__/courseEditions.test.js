// Edities van een cursus (server/courseEditions.js, 2026-10-29): nieuwe editie
// starten zonder iets weg te gooien; vorige jaargang wordt oud-deelnemer.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { planAlumni, startEdition, previewEdition, isCourseAlumnus } from '../courses/courseEditions.js';
import { allServerSource, fileSource, functionSource } from './helpers/serverSource.js';

const C = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

// Kleine nep-database met genoeg van de Supabase-builder voor deze module.
function fakeDb(tables) {
  let seq = 0;
  const from = (name) => {
    const rows = (tables[name] ||= []);
    const filters = [];
    let op = 'select'; let payload = null; let head = false; let returning = false; let opts = {};
    const match = (r) => filters.every((f) => f(r));
    const run = () => {
      if (op === 'insert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: `id-${++seq}`, ...r }));
        rows.push(...list);
        return { data: Array.isArray(payload) ? list : list[0], error: null };
      }
      if (op === 'upsert') {
        const keys = String(opts.onConflict || '').split(',');
        for (const r of Array.isArray(payload) ? payload : [payload]) {
          const ex = rows.find((x) => keys.every((k) => x[k] === r[k]));
          if (ex) { if (!opts.ignoreDuplicates) Object.assign(ex, r); } else rows.push({ ...r });
        }
        return { data: null, error: null };
      }
      if (op === 'update') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, payload)); return { data: returning ? hit : null, error: null }; }
      if (op === 'delete') { const keep = rows.filter((r) => !match(r)); rows.length = 0; rows.push(...keep); return { data: null, error: null }; }
      const data = rows.filter(match);
      return head ? { count: data.length, error: null } : { data, error: null };
    };
    const q = {
      select: (_c, o) => { if (o?.head) head = true; if (op !== 'select') returning = true; return q; },
      eq: (k, v) => { filters.push((r) => r[k] === v); return q; },
      in: (k, v) => { filters.push((r) => v.includes(r[k])); return q; },
      is: (k, v) => { filters.push((r) => (r[k] ?? null) === v); return q; },
      order: () => q, limit: () => q,
      insert: (p) => { op = 'insert'; payload = p; return q; },
      upsert: (p, o = {}) => { op = 'upsert'; payload = p; opts = o; return q; },
      update: (p) => { op = 'update'; payload = p; return q; },
      delete: () => { op = 'delete'; return q; },
      maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: null }; },
      single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: null }; },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  };
  return { tables, from };
}

const seed = () => ({
  course_members: [
    { course_id: C, user_id: 'docent', member_role: 'teacher' },
    { course_id: C, user_id: 'assistent', member_role: 'teacher' },
    { course_id: C, user_id: 'oud-assistent', member_role: 'teacher' },
    { course_id: C, user_id: 's1', member_role: 'student' },
    { course_id: C, user_id: 's2', member_role: 'student' },
    { course_id: OTHER, user_id: 's1', member_role: 'student' },
  ],
  course_alumni: [], course_editions: [],
  projects: [{ id: 'p1', course_id: C, status: 'active' }, { id: 'p2', course_id: OTHER, status: 'active' }],
  project_groups: [{ id: 'g1', project_id: 'p1', status: 'active' }, { id: 'g2', project_id: 'p2', status: 'active' }],
  studiecafe_threads: [
    { id: 't1', course_id: C, is_pinned: true, is_locked: false, archived_at: null, deleted_at: null },
    { id: 't2', course_id: OTHER, is_pinned: false, is_locked: false, archived_at: null, deleted_at: null },
  ],
  lti_course_links: [{ course_id: C, context_title: 'Methodologie 2 (2025)', retired_at: null }],
  profiles: [{ id: 'docent', full_name: 'D' }, { id: 'assistent', full_name: 'A' }, { id: 'oud-assistent', full_name: 'O' }],
  learning_journal_entries: [{ user_id: 's1', course_id: C }],
});

describe('wie wordt oud-deelnemer', () => {
  it('studenten altijd; docenten tenzij aangevinkt; wie start blijft docent', () => {
    const { leave, stay } = planAlumni(seed().course_members.filter((m) => m.course_id === C), { keepTeacherIds: ['assistent'], actorId: 'docent' });
    expect(stay.map((m) => m.user_id).sort()).toEqual(['assistent', 'docent']);
    expect(leave).toEqual([
      { user_id: 'oud-assistent', former_role: 'teacher' },
      { user_id: 's1', former_role: 'student' },
      { user_id: 's2', former_role: 'student' },
    ]);
  });
});

describe('nieuwe editie starten', () => {
  it('voorvertoning telt wat er gebeurt', async () => {
    const db = fakeDb(seed());
    const p = await previewEdition(db, C);
    expect(p).toMatchObject({ students: 2, projects: 1, groups: 1, threads: 1, canvasCourses: ['Methodologie 2 (2025)'], alumni: 0 });
    expect(p.teachers.map((t) => t.id).sort()).toEqual(['assistent', 'docent', 'oud-assistent']);
  });

  it('archiveert alleen deze cursus en gooit niets van studenten weg', async () => {
    const db = fakeDb(seed());
    const r = await startEdition(db, { courseId: C, label: '2026-2027', keepTeacherIds: ['assistent'], actorId: 'docent' });
    const t = db.tables;
    expect(r.summary).toEqual({ alumniStudents: 2, alumniTeachers: 1, projects: 1, groups: 1, threads: 1 });
    expect(t.course_members.filter((m) => m.course_id === C).map((m) => m.user_id).sort()).toEqual(['assistent', 'docent']);
    expect(t.course_members.filter((m) => m.course_id === OTHER)).toHaveLength(1); // andere cursus ongemoeid
    expect(t.course_alumni.map((a) => `${a.user_id}:${a.former_role}`).sort()).toEqual(['oud-assistent:teacher', 's1:student', 's2:student']);
    expect(t.projects.find((p) => p.id === 'p1').status).toBe('archived');
    expect(t.projects.find((p) => p.id === 'p2').status).toBe('active');
    expect(t.project_groups.find((g) => g.id === 'g1').status).toBe('finalized'); // blijft voor de leden leesbaar
    expect(t.project_groups.find((g) => g.id === 'g2').status).toBe('active');
    expect(t.studiecafe_threads.find((x) => x.id === 't1')).toMatchObject({ is_locked: true, is_pinned: false });
    expect(t.studiecafe_threads.find((x) => x.id === 't1').archived_at).toBeTruthy();
    expect(t.studiecafe_threads.find((x) => x.id === 't2').archived_at).toBeNull();
    expect(t.lti_course_links[0].retired_at).toBeTruthy();
    expect(t.learning_journal_entries).toHaveLength(1);
    expect(t.course_editions[0]).toMatchObject({ course_id: C, label: '2026-2027', started_by: 'docent', summary: r.summary });
    expect(await isCourseAlumnus(db, 's1', C)).toBe(true);
    expect(await isCourseAlumnus(db, 's1', OTHER)).toBe(false);
  });

  it('nog een keer starten doet niets dubbel', async () => {
    const db = fakeDb(seed());
    await startEdition(db, { courseId: C, keepTeacherIds: [], actorId: 'docent' });
    const r2 = await startEdition(db, { courseId: C, keepTeacherIds: [], actorId: 'docent' });
    expect(r2.summary).toEqual({ alumniStudents: 0, alumniTeachers: 0, projects: 0, groups: 0, threads: 0 });
    expect(db.tables.course_alumni).toHaveLength(4);
    expect(db.tables.course_editions).toHaveLength(2);
  });
});

describe('aansluiting', () => {
  const src = (f) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
  it('migratie: oud-deelnemer houdt leestoegang en wordt weer lid via elke route', () => {
    const sql = src('supabase/migrations/20261029100000_course_editions.sql');
    expect(sql).toMatch(/FUNCTION public\.is_course_member[\s\S]*course_alumni/);
    expect(sql).toMatch(/FUNCTION public\.sc_can_read_course[\s\S]*is_course_member/);
    expect(sql).toMatch(/AFTER INSERT ON public\.course_members[\s\S]*course_members_clear_alumni/);
    expect(fs.existsSync(path.join(process.cwd(), 'supabase/rollback/20261029100000_course_editions_down.sql'))).toBe(true);
  });
  it('server: leestoegang telt oud-deelnemers mee; meedoen aan projecten en schrijven in het Studiecafé niet', () => {
    expect(functionSource('userHasCourseMembership')).toMatch(/return await isCourseAlumnus\(supabaseAdmin, userId, courseId\)/);
    expect((allServerSource().match(/userIsActiveCourseMember\(auth\.user\.id, project\.course_id\)/g) || []).length).toBe(2);
    const sc = fileSource('server/studiecafe/studiecafe.js');
    expect((sc.match(/isActiveMember\(auth\.user\.id, courseId\)\)\) return res\.status\(403\)/g) || []).length).toBe(2);
    expect(sc).not.toMatch(/\.eq\('role', 'student'\)/); // aankondigingen nooit meer aan "alle studenten"
  });
  it('Canvas: een klik uit de Canvas-cursus van een vorige editie maakt niemand weer actief lid', () => {
    expect(fileSource('server/lti/lti.js')).toMatch(/if \(retired\) \{[\s\S]*course_alumni/);
  });
});
