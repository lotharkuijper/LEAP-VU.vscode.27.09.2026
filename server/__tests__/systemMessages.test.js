// Systeemberichten van de beheerder (server/systemMessages.js, migratie 20261016120000).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseMessageInput, isRecipient, messagesForUser, statusOf, endUpdate, isActive } from '../systemMessages.js';

const root = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const NOW = new Date('2026-10-16T12:00:00Z');
const COURSE = '6f7c1d5a-e115-4984-a373-4bb8fa337e03';

describe('invoer van de beheerder', () => {
  it('titel en doelgroep zijn verplicht; een cursusbericht heeft een cursus', () => {
    expect(parseMessageInput({ audience: 'all' }, NOW).ok).toBe(false);
    expect(parseMessageInput({ title: 'x' }, NOW).ok).toBe(false);
    expect(parseMessageInput({ title: 'x', audience: 'course' }, NOW).ok).toBe(false);
    const ok = parseMessageInput({ title: ' Onderhoud ', body: 'Van 11 tot 13 uur', audience: 'course', courseId: COURSE }, NOW);
    expect(ok.ok).toBe(true);
    expect(ok.value).toMatchObject({ title: 'Onderhoud', audience: 'course', course_id: COURSE, course_role: 'students', kind: 'info', ends_at: null });
    expect(ok.value.starts_at).toBe(NOW.toISOString());
  });
  it('einde moet na het begin liggen; te lange tekst of onbekende soort wordt geweigerd', () => {
    expect(parseMessageInput({ title: 'x', audience: 'all', endsAt: '2026-10-16T11:00:00Z' }, NOW).ok).toBe(false);
    expect(parseMessageInput({ title: 'x'.repeat(121), audience: 'all' }, NOW).ok).toBe(false);
    expect(parseMessageInput({ title: 'x', audience: 'all', body: 'y'.repeat(2001) }, NOW).ok).toBe(false);
    expect(parseMessageInput({ title: 'x', audience: 'all', kind: 'urgent' }, NOW).ok).toBe(false);
    expect(parseMessageInput({ title: 'x', audience: 'iedereen' }, NOW).ok).toBe(false);
  });
});

describe('wie krijgt het bericht', () => {
  const student = { role: 'student', memberships: [{ course_id: COURSE, member_role: 'student' }] };
  const docentInCourse = { role: 'docent', memberships: [{ course_id: COURSE, member_role: 'teacher' }] };
  const outsider = { role: 'student', memberships: [] };
  it('alle gebruikers, alle studenten, alle docenten', () => {
    expect(isRecipient({ audience: 'all' }, outsider)).toBe(true);
    expect(isRecipient({ audience: 'students' }, student)).toBe(true);
    expect(isRecipient({ audience: 'students' }, docentInCourse)).toBe(false);
    expect(isRecipient({ audience: 'teachers' }, docentInCourse)).toBe(true);
    expect(isRecipient({ audience: 'teachers' }, student)).toBe(false);
  });
  it('één cursus: alleen studenten, of iedereen in die cursus', () => {
    const studentsOnly = { audience: 'course', course_id: COURSE, course_role: 'students' };
    const everyone = { audience: 'course', course_id: COURSE, course_role: 'all' };
    expect(isRecipient(studentsOnly, student)).toBe(true);
    expect(isRecipient(studentsOnly, docentInCourse)).toBe(false);
    expect(isRecipient(everyone, docentInCourse)).toBe(true);
    expect(isRecipient(everyone, outsider)).toBe(false);
  });
  it('alleen actieve, niet-weggeklikte berichten; nieuwste eerst', () => {
    const msgs = [
      { id: 'oud', audience: 'all', starts_at: '2026-10-10T00:00:00Z', ends_at: null },
      { id: 'nieuw', audience: 'all', starts_at: '2026-10-15T00:00:00Z', ends_at: null },
      { id: 'gepland', audience: 'all', starts_at: '2026-10-20T00:00:00Z', ends_at: null },
      { id: 'afgelopen', audience: 'all', starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-10-02T00:00:00Z' },
      { id: 'weg', audience: 'all', starts_at: '2026-10-12T00:00:00Z', ends_at: null },
      { id: 'docenten', audience: 'teachers', starts_at: '2026-10-12T00:00:00Z', ends_at: null },
    ];
    const out = messagesForUser(msgs, { ...student, dismissedIds: ['weg'] }, NOW);
    expect(out.map((m) => m.id)).toEqual(['nieuw', 'oud']);
    expect(Object.keys(out[0])).not.toContain('audience');
  });
});

describe('status en beëindigen', () => {
  it('gepland, zichtbaar, afgelopen', () => {
    expect(statusOf({ starts_at: '2026-10-20T00:00:00Z' }, NOW)).toBe('scheduled');
    expect(statusOf({ starts_at: '2026-10-10T00:00:00Z', ends_at: null }, NOW)).toBe('active');
    expect(statusOf({ starts_at: '2026-10-10T00:00:00Z', ends_at: '2026-10-11T00:00:00Z' }, NOW)).toBe('ended');
  });
  it('een gepland bericht beëindigen: begin en einde allebei voorbij, dus nooit meer zichtbaar', () => {
    const upd = endUpdate({ starts_at: '2026-10-20T00:00:00Z' }, NOW);
    expect(new Date(upd.ends_at) > new Date(upd.starts_at)).toBe(true);
    expect(isActive(upd, NOW)).toBe(false);
    expect(isActive(upd, new Date('2026-10-21T00:00:00Z'))).toBe(false);
    expect(endUpdate({ starts_at: '2026-10-10T00:00:00Z' }, NOW)).toEqual({ ends_at: NOW.toISOString() });
  });
});

describe('beveiliging en privacy', () => {
  const src = read('server/systemMessages.js');
  it('alle beheerroutes zijn alleen voor de beheerder', () => {
    for (const route of ["app.get('/api/admin/messages'", "app.post('/api/admin/messages'", "app.post('/api/admin/messages/:id/end'", "app.delete('/api/admin/messages/:id'"]) {
      const start = src.indexOf(route);
      expect(start).toBeGreaterThan(0);
      expect(src.slice(start, start + 300)).toMatch(/adminOnly\(req, res\)/);
    }
  });
  it('de beheerder ziet alleen totalen, geen namen van wie wegklikte', () => {
    const admin = src.slice(src.indexOf("app.get('/api/admin/messages'"), src.indexOf("app.post('/api/admin/messages'"));
    expect(admin).toMatch(/select\('message_id'\)/);
    expect(admin).not.toMatch(/user_id/);
  });
  it('tabellen alleen via de server; wegklikken staat in "Mijn gegevens"', () => {
    const up = read('supabase/migrations/20261016120000_system_messages.sql');
    expect(up).toMatch(/system_messages ENABLE ROW LEVEL SECURITY/);
    expect(up).toMatch(/system_message_dismissals ENABLE ROW LEVEL SECURITY/);
    expect(up).not.toMatch(/CREATE POLICY/);
    expect(read('server/myData.js')).toMatch(/table: 'system_message_dismissals', column: 'user_id'/);
    expect(fs.existsSync(path.join(root, 'supabase/rollback/20261016120000_system_messages_down.sql'))).toBe(true);
  });
});
