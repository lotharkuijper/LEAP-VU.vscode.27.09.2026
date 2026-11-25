// Analytics per dag (2026-11-25): actieve studenten, onderdelen, achievements en
// kosten. Bewaakt vooral de privacy: geen gebruikers in de tellers, en elk aantal
// studenten onder K_MIN verborgen.
import { describe, it, expect } from 'vitest';
import express from 'express';
import { createCollector, recordActivity, groupIdOf, analyticsMiddleware } from '../analytics/collector.js';
import {
  amsterdamDay, daysBetween, studentPartOf, tokenGroupOf,
  buildCourseUsage, explainPerConcept, summarizeAchievements, summarizeDaily, splitForTables, weeksBetween,
} from '../analytics/aggregate.js';

const C = '22222222-2222-2222-2222-222222222222';
const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '33333333-3333-3333-3333-333333333333';
const G = '44444444-4444-4444-4444-444444444444';

describe('dagen', () => {
  it('Amsterdamse kalenderdag, ook rond middernacht UTC', () => {
    expect(amsterdamDay(new Date('2026-11-24T23:30:00Z'))).toBe('2026-11-25');
    expect(daysBetween('2026-11-29', '2026-12-02')).toEqual(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
  });
  it('onderdelen en tokengroepen', () => {
    expect(studentPartOf('chat-attachments')).toBe('chat');
    expect(studentPartOf('admin/extract-concepts')).toBeNull();
    expect(tokenGroupOf('explain')).toBe('students');
    expect(tokenGroupOf('admin/process-rag-document')).toBe('teachers');
    expect(tokenGroupOf('background')).toBe('background');
    expect(tokenGroupOf('embeddings')).toBe('other');
  });
});

describe('activiteit tellen', () => {
  const student = async () => ({ courseId: C, role: 'student' });

  it('de groep komt uit het pad', () => {
    expect(groupIdOf(`/api/projects/p/groups/${G}/personas`)).toBe(G);
  });

  it('telt alleen een gebruiker wiens login de server heeft gecontroleerd', async () => {
    const collector = createCollector({ write: async () => {} });
    const app = express();
    app.use(express.json());
    // verifyUser zegt "niet ingelogd": een nagemaakt token telt dus niet mee.
    app.use(analyticsMiddleware(collector, { who: student, verifyUser: async () => null }));
    app.post('/api/quiz/x', (_q, res) => res.json({ ok: true }));
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const fake = `Bearer x.${Buffer.from(JSON.stringify({ sub: U1 })).toString('base64url')}.y`;
    await fetch(`http://127.0.0.1:${server.address().port}/api/quiz/x`, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: fake }, body: JSON.stringify({ courseId: C }) });
    await new Promise((r) => setTimeout(r, 30));
    server.close();
    expect(collector.drain().some((r) => r.kind.startsWith('active_'))).toBe(false);
  });

  it('telt een student één keer per dag, en bewaart nooit wie', async () => {
    const collector = createCollector({ write: async () => {} });
    const act = (userId, extra = {}) => recordActivity(collector, { userId, feature: 'quiz', courseId: C, method: 'POST', path: '/api/quiz/sessions', status: 200, ...extra }, student);
    await act(U1); await act(U1); await act(U2);
    await act(U1, { method: 'GET' });          // openen telt niet
    await act(U2, { status: 403 });            // mislukt telt niet
    const rows = collector.drain();
    const n = (kind, key = '') => rows.find((r) => r.kind === kind && r.key === key && r.course_id === C)?.n;
    expect(n('active_students')).toBe(2);
    expect(n('active_part', 'quiz')).toBe(2);
    expect(n('part_actions', 'quiz')).toBe(3);
    expect(rows.find((r) => r.kind === 'active_users' && r.course_id === null)?.n).toBe(2);
    expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${U1}|${U2}`));
  });

  it('docenten tellen niet als student', async () => {
    const collector = createCollector({ write: async () => {} });
    await recordActivity(collector, { userId: U1, feature: 'chat', courseId: C, method: 'POST', path: '/api/chat', status: 200 }, async () => ({ courseId: C, role: 'teacher' }));
    const rows = collector.drain();
    expect(rows.some((r) => r.kind === 'active_students')).toBe(false);
    expect(rows.find((r) => r.kind === 'active_users' && r.course_id === C)?.key).toBe('staff');
  });

  it('actieve projectgroepen per week, zonder de groep op te slaan', async () => {
    const collector = createCollector({ write: async () => {} });
    await recordActivity(collector, { userId: U1, feature: 'projects', courseId: C, method: 'POST', path: `/api/projects/p/groups/${G}/x`, status: 200 }, student);
    await recordActivity(collector, { userId: U2, feature: 'projects', courseId: C, method: 'POST', path: `/api/projects/p/groups/${G}/x`, status: 200 }, student);
    const rows = collector.drain();
    expect(rows.find((r) => r.kind === 'active_group')?.n).toBe(1);
    expect(JSON.stringify(rows)).not.toContain(G);
  });
});

describe('overzicht voor de docent', () => {
  it('verbergt dagen en weken met minder dan 5 actieve studenten', () => {
    const u = buildCourseUsage({
      dailyRows: [{ day: '2026-11-24', kind: 'active_students', n: 3 }, { day: '2026-11-25', kind: 'active_students', n: 12 }],
      weeklyRows: [{ week: '2026-11-23', kind: 'active_students_week', n: 20 }, { week: '2026-11-23', kind: 'active_part', key: 'chat', n: 8 }, { week: '2026-11-23', kind: 'part_actions', key: 'chat', n: 40 }, { week: '2026-11-23', kind: 'active_part', key: 'quiz', n: 2 }, { week: '2026-11-23', kind: 'part_actions', key: 'quiz', n: 9 }],
      days: ['2026-11-24', '2026-11-25'], weeks: ['2026-11-23'], enrolled: 40, groups: 2,
    });
    expect(u.daily).toEqual([{ day: '2026-11-24', activeStudents: null, suppressed: true }, { day: '2026-11-25', activeStudents: 12, suppressed: false }]);
    expect(u.weekly[0]).toMatchObject({ activeStudents: 20, share: 0.5 });
    const chat = u.parts.find((p) => p.part === 'chat');
    const quiz = u.parts.find((p) => p.part === 'quiz');
    expect(chat.share).toBe(1);
    expect(quiz.weeks[0]).toMatchObject({ students: null, suppressed: true });
    expect(quiz.actions).toBeNull();
    expect(u.groups.suppressed).toBe(true);   // minder dan 5 groepen: niets tonen
    expect(u.groups.weeks).toBeNull();
  });

  it('Ik leg uit per begrip: gemiddeld per student, onder 5 verborgen', () => {
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push({ student_id: `s${i}`, concept_id: 'a', score: 60 + i * 10 });
    rows.push({ student_id: 's0', concept_id: 'a', score: 100 });
    rows.push({ student_id: 's1', concept_id: 'b', score: 90 });
    const out = explainPerConcept(rows, { a: 'Bias', b: 'Confounding' });
    expect(out[0]).toMatchObject({ name: 'Bias', students: 5, suppressed: false });
    expect(out.find((c) => c.name === 'Confounding')).toMatchObject({ students: null, avgScore: null, suppressed: true });
  });

  it('achievements: niets zichtbaar onder 5 studenten', () => {
    const few = [{ user_id: 'a', kind: 'explain_clear', earned_at: '2026-11-24T10:00:00Z' }];
    expect(summarizeAchievements(few, { enrolled: 10 })).toMatchObject({ suppressed: true, total: null });
    const many = ['a', 'b', 'c', 'd', 'e'].map((u) => ({ user_id: u, kind: 'explain_clear', earned_at: '2026-11-24T10:00:00Z' }));
    const s = summarizeAchievements(many, { enrolled: 10, weeks: ['2026-11-23'] });
    expect(s).toMatchObject({ suppressed: false, total: 5, students: 5, share: 0.5 });
    expect(s.weeks).toEqual([{ week: '2026-11-23', count: 5, suppressed: false }]);
  });
});

describe('niet terug te rekenen naar één student', () => {
  it('op minder dan 5 na iedereen actief: verborgen', () => {
    const u = buildCourseUsage({ dailyRows: [{ day: 'd', kind: 'active_students', n: 28 }, { day: 'e', kind: 'active_students', n: 20 }], days: ['d', 'e'], enrolled: 30 });
    expect(u.daily[0]).toMatchObject({ activeStudents: null, suppressed: true });
    expect(u.daily[1]).toMatchObject({ activeStudents: 20, suppressed: false });
  });
  it('gemiddelde score bij Ik leg uit afgerond op 10', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((s, i) => ({ student_id: s, concept_id: 'x', score: 60 + i }));
    expect(explainPerConcept(rows, { x: 'Bias' })[0].avgScore).toBe(60);
  });
  it('achievements: een zeldzame soort en een rustige week worden verborgen', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((u) => ({ user_id: u, kind: 'explain_clear', earned_at: '2026-11-24T10:00:00Z' }));
    rows.push({ user_id: 'a', kind: 'quiz_comeback', earned_at: '2026-11-17T10:00:00Z' });
    const s = summarizeAchievements(rows, { enrolled: 30, weeks: ['2026-11-16', '2026-11-23'] });
    expect(s.kinds.find((x) => x.kind === 'quiz_comeback')).toMatchObject({ count: null, suppressed: true });
    expect(s.weeks).toEqual([{ week: '2026-11-16', count: null, suppressed: true }, { week: '2026-11-23', count: 5, suppressed: false }]);
  });
  it('beheerder, één cursus: ook daar geen aantal studenten onder 5', () => {
    const d = summarizeDaily([{ day: 'd', course_id: C, kind: 'active_users', key: 'student', n: 1 }], { days: ['d'], courseId: C });
    expect(d.days[0].students).toBeNull();
  });
});

describe('tabellen en weken', () => {
  it('dagtellers alleen in de dagtabel, weektellers alleen in de weektabel', () => {
    const { weekly, daily } = splitForTables([{ kind: 'tokens' }, { kind: 'active_students' }, { kind: 'active_part' }, { kind: 'api' }]);
    expect(weekly.map((r) => r.kind)).toEqual(['tokens', 'active_part', 'api']);
    expect(daily.map((r) => r.kind)).toEqual(['tokens', 'active_students']);
  });
  it('weken van maandag tot en met de huidige week', () => {
    expect(weeksBetween('2026-11-18', '2026-11-30')).toEqual(['2026-11-16', '2026-11-23', '2026-11-30']);
  });
});

describe('kosten per dag (beheer)', () => {
  const rows = [
    { day: '2026-11-24', course_id: C, kind: 'tokens', key: 'chat', n: 2, total: 1000 },
    { day: '2026-11-24', course_id: C, kind: 'tokens', key: 'admin/extract-concepts', n: 1, total: 5000 },
    { day: '2026-11-25', course_id: null, kind: 'tokens', key: 'background', n: 1, total: 200 },
    { day: '2026-11-24', course_id: null, kind: 'active_users', key: 'student', n: 7 },
    { day: '2026-11-24', course_id: C, kind: 'active_users', key: 'student', n: 4 },
  ];
  it('heel LEAP: per dag, per groep en per cursus', () => {
    const d = summarizeDaily(rows, { days: ['2026-11-24', '2026-11-25'], courseNames: { [C]: 'E&B1' } });
    expect(d.days[0]).toMatchObject({ tokens: 6000, students: 7, groups: { students: 1000, teachers: 5000 } });
    expect(d.totalTokens).toBe(6200);
    expect(d.courses[0]).toEqual({ courseId: C, name: 'E&B1', tokens: 6000 });
  });
  it('één cursus', () => {
    const d = summarizeDaily(rows, { days: ['2026-11-24'], courseId: C });
    expect(d.days[0]).toMatchObject({ tokens: 6000, students: null });
  });
});
