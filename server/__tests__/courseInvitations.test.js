// Studenten uitnodigen voor een cursus (server/courses/courseInvitations.js, 2026-10-26).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { allServerSource, routeSource } from './helpers/serverSource.js';
import {
  signInviteToken, verifyInviteToken, inviteExpiresAt, invitationStatus, isUnusedAccount,
  createMailBudget, buildInvitationEmail, INVITE_VALID_DAYS,
} from '../courses/courseInvitations.js';

const root = path.resolve(__dirname, '..', '..');
const ID = '0573893c-c5a4-4517-bfa4-03cdbf48d8d4';
const DAY = 24 * 60 * 60 * 1000;

describe('link in de uitnodigingsmail', () => {
  it('alleen een token met de juiste handtekening geeft het id terug', () => {
    const tok = signInviteToken(ID, 'geheim');
    expect(verifyInviteToken(tok, 'geheim')).toBe(ID);
    expect(verifyInviteToken(tok, 'ander-geheim')).toBeNull();
    expect(verifyInviteToken(tok.slice(0, -2) + 'xx', 'geheim')).toBeNull();
    expect(verifyInviteToken(`${ID}.`, 'geheim')).toBeNull();
    expect(verifyInviteToken('geen-token', 'geheim')).toBeNull();
    // Een ander id met de handtekening van dit id werkt niet.
    const other = '1573893c-c5a4-4517-bfa4-03cdbf48d8d4';
    expect(verifyInviteToken(`${other}.${tok.split('.')[1]}`, 'geheim')).toBeNull();
  });
});

describe('geldigheid en status', () => {
  const invited = '2026-10-01T10:00:00Z';
  it('30 dagen vanaf de laatste mail; opnieuw sturen verlengt', () => {
    expect(INVITE_VALID_DAYS).toBe(30);
    expect(inviteExpiresAt({ invited_at: invited }).toISOString()).toBe('2026-10-31T10:00:00.000Z');
    expect(inviteExpiresAt({ invited_at: invited, last_sent_at: '2026-10-20T10:00:00Z' }).toISOString()).toBe('2026-11-19T10:00:00.000Z');
  });
  it('status voor de docent', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    expect(invitationStatus({ invited_at: invited, mail_status: 'queued' }, now)).toBe('queued');
    expect(invitationStatus({ invited_at: invited, mail_status: 'sent', last_sent_at: invited }, now)).toBe('pending');
    expect(invitationStatus({ invited_at: invited, mail_status: 'failed' }, now)).toBe('failed');
    expect(invitationStatus({ invited_at: invited, mail_status: 'sent', accepted_at: now.toISOString() }, now)).toBe('accepted');
    expect(invitationStatus({ invited_at: invited, mail_status: 'sent', last_sent_at: invited }, new Date(Date.parse(invited) + 31 * DAY))).toBe('expired');
  });
  it('alleen een nooit gebruikt account geldt als ongebruikt (dan mag opruimen het verwijderen)', () => {
    expect(isUnusedAccount({ email_confirmed_at: null, last_sign_in_at: null })).toBe(true);
    expect(isUnusedAccount({ email_confirmed_at: '2026-10-02', last_sign_in_at: null })).toBe(false);
    expect(isUnusedAccount({ email_confirmed_at: null, last_sign_in_at: '2026-10-02' })).toBe(false);
    expect(isUnusedAccount(null)).toBe(false);
  });
});

describe('mail-limiet', () => {
  it('per minuut en per uur, met een glijdend venster', () => {
    const b = createMailBudget({ perMinute: 2, perHour: 3 });
    const t0 = 1_000_000;
    expect([b.take(t0), b.take(t0), b.take(t0)]).toEqual([true, true, false]);
    expect(b.available(t0 + 61_000)).toBe(1); // minuut voorbij, maar uurlimiet: nog 1
    expect(b.take(t0 + 61_000)).toBe(true);
    expect(b.take(t0 + 62_000)).toBe(false);
    expect(b.available(t0 + 61 * 60_000)).toBe(2);
  });
});

describe('de mail', () => {
  it('noemt wie uitnodigt en voor welke cursus, met de link en de 30 dagen', () => {
    const m = buildInvitationEmail({ kind: 'new', lang: 'nl', inviterName: 'Sam de Vries', courseName: 'Statistiek 1', link: 'https://leap.example/invite#t=abc' });
    expect(m.subject).toBe('Sam de Vries nodigt je uit voor Statistiek 1 op LEAP-VU');
    expect(m.text).toContain('https://leap.example/invite#t=abc');
    expect(m.text).toContain('30 dagen');
    expect(m.html).toContain('Account activeren');
  });
  it('een bestaand account krijgt alleen een bericht, zonder activeringslink', () => {
    const m = buildInvitationEmail({ kind: 'added', lang: 'en', inviterName: 'Sam', courseName: 'Biology', link: 'https://leap.example/dashboard' });
    expect(m.subject).toBe('Sam added you to Biology on LEAP-VU');
    expect(m.text).not.toContain('invite#t=');
  });
  it('een docent krijgt een mail die de rol van docent noemt', () => {
    const m = buildInvitationEmail({ kind: 'new', lang: 'nl', inviterName: 'Sam', courseName: 'Projectcursus', link: 'https://x/invite#t=1', asTeacher: true });
    expect(m.text).toMatch(/als docent/);
    const s = buildInvitationEmail({ kind: 'new', lang: 'nl', inviterName: 'Sam', courseName: 'Projectcursus', link: 'https://x/invite#t=1' });
    expect(s.text).not.toMatch(/als docent/);
  });
  it('namen worden veilig in de HTML gezet', () => {
    const m = buildInvitationEmail({ kind: 'new', lang: 'nl', inviterName: '<b>X</b>', courseName: 'A & B', link: 'https://x/invite#t=1' });
    expect(m.html).not.toContain('<b>X</b>');
    expect(m.html).toContain('&lt;b&gt;X&lt;/b&gt;');
  });
});

describe('koppeling', () => {
  const src = fs.readFileSync(path.join(root, 'server', 'courses', 'courseInvitations.js'), 'utf8');
  const route = (from, to) => src.slice(src.indexOf(from), to ? src.indexOf(to) : undefined);
  it('alleen een beheerder of een docent van déze cursus nodigt uit, trekt in of stuurt opnieuw', () => {
    expect(src).toMatch(/if \(!r\.isAdmin && !\(await deps\.isCourseTeacher\(r\.user\.id, courseId\)\)\)/);
    for (const p of ["'/api/admin/courses/:id/invitations'", "'/api/admin/courses/:id/invitations/:userId/resend'", "app.delete('/api/admin/courses/:id/invitations/:userId'"]) {
      expect(route(p)).toMatch(/await authorize\(req, res, courseId\)/);
    }
  });
  it('uitnodigen kan in elke cursus en met elk adres (ook Canvas, gesloten, VU-adres): de docent staat ervoor in', () => {
    expect(src).not.toMatch(/enrollment_mode|isBlockedEmail|isSelfJoinable/);
  });
  it('een uitgenodigde wordt student, tenzij uitdrukkelijk als docent toegevoegd (role teacher)', () => {
    expect(src).toMatch(/const role = req\.body\?\.role === 'teacher' \? 'teacher' : 'student';/);
    expect(src).toMatch(/role = 'student'/);
  });
  it('docent worden zet ook het docentprofiel (anders lopen projecten vast op de databaseregels)', () => {
    expect(route('async function enroll', 'async function saveInvitation')).toMatch(/if \(role === 'teacher'\) await deps\.promoteTeacherProfile/);
    expect(src).toMatch(/deps\.promoteTeacherProfile\?\.\(userId, r\.user\.id, courseId\);[\s\S]{0,120}status: 'promoted'/);
  });
  it('een bestaande inschrijving wordt nooit overschreven en een docent nooit gedegradeerd', () => {
    const post = route("'/api/admin/courses/:id/invitations'", "'/api/admin/courses/:id/invitations/:userId/resend'");
    expect(post).toMatch(/enroll\(courseId, userId, \{ insertOnly: true, role, by: r\.user\.id \}\)/);
    expect(post).toMatch(/if \(role === 'teacher' && memberRoles\.get\(userId\) !== 'teacher'\)/);
  });
  it('daglimiet voor docenten, niet voor beheerders', () => {
    expect(src).toMatch(/if \(!r\.isAdmin\) \{[\s\S]*?DAILY_INVITE_LIMIT/);
  });
  it('opruimen en intrekken verwijderen alleen een account dat nooit is gebruikt en nergens anders voor dient', () => {
    const fn = route('async function deleteIfOrphaned', 'let queueBusy');
    expect(fn).toMatch(/!isUnusedAccount\(au\?\.user\) \|\| \(memberships \|\| 0\) > 0 \|\| \(invitations \|\| 0\) > 0\) return false/);
    expect(fn).toMatch(/deps\.forgetUser\?\.\(userId\)/);
  });
  it('de link in de mail draagt geen inlogcode: die maakt de server pas bij het klikken', () => {
    expect(src).toMatch(/`\$\{base\}\/invite#t=\$\{signInviteToken\(row\.id, deps\.secret\)\}`/);
    expect(route("'/api/invitations/accept'", 'async function deleteIfOrphaned')).toMatch(/generateLink\(\{ type, email: au\.user\.email \}\)/);
  });
  it('de server gebruikt de module voor Beheer leden, en de migratie heeft een terugdraaiscript', () => {
    const all = allServerSource();
    expect(all).toMatch(/registerCourseInvitationRoutes\(app, \{/);
    expect(routeSource("app.get('/api/admin/courses/:id/members'")).toMatch(/m\.invitation = pending\.get\(m\.user_id\) \|\| null/);
    expect(all).not.toMatch(/'\/api\/admin\/bulk-accounts\/provision'/);
    expect(fs.existsSync(path.join(root, 'supabase', 'rollback', '20261026120000_course_invitations_down.sql'))).toBe(true);
  });
});
