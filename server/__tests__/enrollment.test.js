// Toegangsroute per cursus en open registratie (server/enrollment.js, 2026-10-20).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ENROLLMENT_MODES, isEnrollmentMode, allowsOpenRegistration, isBlockedEmail, isSelfJoinable,
  validateRegistration, createRateLimiter, blockedDomains,
} from '../enrollment.js';

const root = path.resolve(__dirname, '..', '..');

describe('toegangsroute', () => {
  it('kent precies vier routes; alleen open en canvas_open laten open registratie toe', () => {
    expect(ENROLLMENT_MODES).toEqual(['closed', 'canvas', 'open', 'canvas_open']);
    expect(isEnrollmentMode('open')).toBe(true);
    expect(isEnrollmentMode('public')).toBe(false);
    expect(ENROLLMENT_MODES.filter(allowsOpenRegistration)).toEqual(['open', 'canvas_open']);
  });
  it('een cursus is alleen te kiezen als hij actief, zichtbaar en open is', () => {
    const c = { is_active: true, student_visible: true, enrollment_mode: 'open' };
    expect(isSelfJoinable(c)).toBe(true);
    expect(isSelfJoinable({ ...c, enrollment_mode: 'closed' })).toBe(false);
    expect(isSelfJoinable({ ...c, enrollment_mode: 'canvas' })).toBe(false);
    expect(isSelfJoinable({ ...c, enrollment_mode: 'canvas_open' })).toBe(true);
    expect(isSelfJoinable({ ...c, is_active: false })).toBe(false);
    expect(isSelfJoinable({ ...c, student_visible: false })).toBe(false);
  });
});

describe('VU-adressen kunnen niet via open registratie', () => {
  it('vu.nl en alle subdomeinen (student.vu.nl) zijn geblokkeerd, andere adressen niet', () => {
    const d = blockedDomains({});
    expect(isBlockedEmail('a.b@vu.nl', d)).toBe(true);
    expect(isBlockedEmail('A.B@Student.VU.nl', d)).toBe(true);
    expect(isBlockedEmail('x@med.vu.nl', d)).toBe(true);
    expect(isBlockedEmail('x@gmail.com', d)).toBe(false);
    expect(isBlockedEmail('x@notvu.nl', d)).toBe(false);
    expect(isBlockedEmail('x@uva.nl', d)).toBe(false);
  });
});

describe('registratie controleren', () => {
  const open = ['c1', 'c2'];
  const ok = { fullName: 'Sam', email: 'sam@example.org', password: 'geheim1', courseIds: ['c1'] };
  it('geldig verzoek', () => {
    expect(validateRegistration(ok, open)).toEqual({ ok: true, name: 'Sam', email: 'sam@example.org', courseIds: ['c1'] });
  });
  it('weigert met een duidelijke code', () => {
    const code = (b) => validateRegistration({ ...ok, ...b }, open).code;
    expect(code({ fullName: ' ' })).toBe('nameRequired');
    expect(code({ email: 'geen-adres' })).toBe('invalidEmail');
    expect(code({ email: 'sam@student.vu.nl' })).toBe('vuEmail');
    expect(code({ password: '123' })).toBe('passwordTooShort');
    expect(code({ courseIds: [] })).toBe('courseRequired');
    expect(code({ courseIds: ['c1', 'gesloten'] })).toBe('courseNotOpen');
  });
  it('dubbele keuzes tellen één keer', () => {
    expect(validateRegistration({ ...ok, courseIds: ['c1', 'c1', 'c2'] }, open).courseIds).toEqual(['c1', 'c2']);
  });
});

describe('aantal aanmeldingen per adres beperkt', () => {
  it('na de limiet weigert de teller', () => {
    const allow = createRateLimiter({ limit: 2, windowMs: 1000 });
    expect([allow('ip'), allow('ip'), allow('ip'), allow('ander')]).toEqual([true, true, false, true]);
  });
});

describe('koppeling', () => {
  const src = fs.readFileSync(path.join(root, 'server', 'enrollment.js'), 'utf8');
  it('alleen een beheerder stelt de toegangsroute in; canvas_open vraagt om bevestiging', () => {
    const route = src.slice(src.indexOf("'/api/admin/courses/:courseId/enrollment-mode'"));
    expect(route).toMatch(/if \(!isAdminProfile\(auth\.profile\)\) return res\.status\(403\)/);
    expect(route).toMatch(/mode === 'canvas_open' && req\.body\?\.confirmBoth !== true/);
  });
  it('aanmeldingen in afwachting worden pas lid met een bevestigd e-mailadres', () => {
    const route = src.slice(src.indexOf("'/api/me/activate-enrollments'"), src.indexOf("'/api/courses/:courseId/join'"));
    expect(route).toMatch(/if \(!auth\.user\.email_confirmed_at\)/);
    expect(route).toMatch(/filter\(isSelfJoinable\)/);
  });
  it('zelf aansluiten: alleen open cursussen, en niet met een VU-adres', () => {
    const route = src.slice(src.indexOf("'/api/courses/:courseId/join'"), src.indexOf("'/api/courses/:courseId/membership'"));
    expect(route).toMatch(/if \(!isSelfJoinable\(course\)\)/);
    expect(route).toMatch(/isBlockedEmail\(auth\.user\.email\)/);
  });
  it('de migratie maakt alles open, vraagt lidmaatschap en zet bestaande gebruikers vooraf als lid', () => {
    const sql = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20261020100000_course_enrollment_mode.sql'), 'utf8');
    expect(sql).toMatch(/enrollment_mode text NOT NULL DEFAULT 'open'/);
    expect(sql).toMatch(/AND public\.is_course_member\(p_course\)/);
    expect(sql).toMatch(/INSERT INTO public\.course_members[\s\S]*ON CONFLICT \(user_id, course_id\) DO NOTHING/);
    expect(fs.existsSync(path.join(root, 'supabase', 'rollback', '20261020100000_course_enrollment_mode_down.sql'))).toBe(true);
  });
  it('het projectenoverzicht voor studenten voegt geen cursussen meer toe zonder lidmaatschap', () => {
    const idx = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
    const ov = idx.slice(idx.indexOf("app.get('/api/projects/student-overview'"), idx.indexOf("app.get('/api/projects/student-overview'") + 2500);
    expect(ov).not.toMatch(/Open cursussen: actief/);
  });
});
