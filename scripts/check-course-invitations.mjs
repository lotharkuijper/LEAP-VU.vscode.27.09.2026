// Controle van "Studenten uitnodigen" (server/courses/courseInvitations.js) tegen de echte
// database en de draaiende API (poort 3001). Maakt een tijdelijke cursus en
// tijdelijke accounts aan en ruimt alles weer op. Er gaat geen echte mail uit
// zolang lokaal geen mailinstelling is geladen (status wordt dan "failed").
//
//   node --env-file=.env scripts/check-course-invitations.mjs
import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { registerCourseInvitationRoutes, signInviteToken } from '../server/courses/courseInvitations.js';

const API = process.env.CHECK_API || 'http://localhost:3001';
const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.VITE_PUBLIC_SUPABASE_URL;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_PUBLIC_SUPABASE_ANON_KEY;
const anon = () => createClient(url, anonKey, { auth: { persistSession: false } });
const SECRET = process.env.LEAP_TURN_SECRET
  || createHmac('sha256', String(process.env.SUPABASE_SERVICE_ROLE_KEY || 'leap-dev')).update('leap-turn-v1').digest('hex');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'OK  ' : 'FOUT'} ${msg}`); if (!cond) failures += 1; };
const stamp = Date.now();
const mail = (n) => `leap-invite-check-${n}-${stamp}@example.org`;
const created = { users: [], course: null };

async function api(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5000', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const userIdOf = async (email) => (await admin.from('profiles').select('id').eq('email', email).maybeSingle()).data?.id;

try {
  const { data: login, error: lErr } = await anon().auth.signInWithPassword({ email: process.env.UI_AUDIT_EMAIL, password: process.env.UI_AUDIT_PASSWORD });
  if (lErr) throw new Error(`inloggen testaccount: ${lErr.message}`);
  const token = login.session.access_token;

  const { data: course, error: cErr } = await admin.from('courses').insert({ name: `Test uitnodigen ${stamp}`, folder_name: `test-uitnodigen-${stamp}`, is_active: true }).select('id, name').single();
  if (cErr) throw new Error(`cursus aanmaken: ${cErr.message}`);
  created.course = course.id;

  // Een bestaand, gebruikt account.
  const { data: ex } = await admin.auth.admin.createUser({ email: mail('bestaand'), email_confirm: true, password: `Test-${stamp}-a1` });
  created.users.push(ex.user.id);

  // 1. Uitnodigen: nieuw, bestaand, dubbel, ongeldig.
  const r1 = await api('POST', `/api/admin/courses/${course.id}/invitations`, token, { emails: [mail('nieuw'), mail('bestaand'), mail('BESTAAND').toLowerCase(), 'geen-adres'] });
  ok(r1.status === 200, `uitnodigen geeft 200 (${r1.status} ${r1.body.error || ''})`);
  const st = Object.fromEntries((r1.body.results || []).map((x) => [x.email, x.status]));
  ok(st[mail('nieuw')] === 'invited', 'nieuw adres: uitgenodigd');
  ok(st[mail('bestaand')] === 'added', 'bestaand account: toegevoegd');
  ok(r1.body.summary?.invalid === 1, 'ongeldig adres geteld, niet verwerkt');
  const newId = await userIdOf(mail('nieuw'));
  if (newId) created.users.push(newId);
  const { data: au } = await admin.auth.admin.getUserById(newId);
  ok(!!au?.user && !au.user.email_confirmed_at, 'nieuw account bestaat, nog niet geactiveerd');
  const { data: prof } = await admin.from('profiles').select('last_active_course_id').eq('id', newId).maybeSingle();
  ok(prof?.last_active_course_id === course.id, 'cursus is de actieve cursus van het nieuwe account');
  const { data: mem } = await admin.from('course_members').select('user_id, member_role').eq('course_id', course.id);
  ok((mem || []).length === 2 && mem.every((m) => m.member_role === 'student'), 'beide zijn student in de cursus');
  const { data: exProf } = await admin.from('profiles').select('last_active_course_id').eq('id', ex.user.id).maybeSingle();
  ok(exProf?.last_active_course_id !== course.id, 'actieve cursus van het bestaande account blijft ongemoeid');

  // 2. Nogmaals: al lid.
  const r2 = await api('POST', `/api/admin/courses/${course.id}/invitations`, token, { emails: [mail('bestaand')] });
  ok(r2.body.results?.[0]?.status === 'alreadyMember', 'nogmaals uitnodigen: "was al lid"');

  // 3. Beheer leden toont de openstaande uitnodiging (alleen voor het nieuwe account).
  await new Promise((r) => setTimeout(r, 1500));
  const r3 = await api('GET', `/api/admin/courses/${course.id}/members`, token);
  const byId = Object.fromEntries((r3.body.members || []).map((m) => [m.user_id, m]));
  if (!r3.body.members) console.log(`     (antwoord leden: ${r3.status} ${JSON.stringify(r3.body).slice(0, 200)})`);
  ok(!!byId[newId]?.invitation && ['queued', 'failed', 'pending'].includes(byId[newId].invitation.status), `Beheer leden: uitnodiging zichtbaar (${byId[newId]?.invitation?.status})`);
  ok(byId[ex.user.id] && !byId[ex.user.id].invitation, 'Beheer leden: bestaand account zonder uitnodigingslabel');

  // 4. Link met verkeerde handtekening.
  const { data: inv } = await admin.from('course_invitations').select('id').eq('course_id', course.id).eq('user_id', newId).single();
  const bad = await api('POST', '/api/invitations/accept', null, { token: `${inv.id}.nep` });
  ok(bad.status === 400 && bad.body.code === 'invalid', 'vervalste link geweigerd');

  // 5. Echte link: inloggen, daarna wachtwoord kiezen.
  const acc = await api('POST', '/api/invitations/accept', null, { token: signInviteToken(inv.id, SECRET) });
  ok(acc.status === 200 && !!acc.body.tokenHash && acc.body.needsPassword === true, `uitnodiging aannemen geeft een inlogcode (${acc.status} ${acc.body.code || ''})`);
  const student = anon();
  const { data: v, error: vErr } = await student.auth.verifyOtp({ token_hash: acc.body.tokenHash, type: acc.body.type });
  ok(!vErr && !!v?.session, `inloggen met de code lukt (${vErr?.message || 'ok'})`);
  const { error: pwErr } = await student.auth.updateUser({ password: `Nieuw-${stamp}-x9` });
  ok(!pwErr, 'student kiest een wachtwoord');
  const { data: au2 } = await admin.auth.admin.getUserById(newId);
  ok(!!au2.user.email_confirmed_at, 'account is nu geactiveerd');
  const { data: inv2 } = await admin.from('course_invitations').select('accepted_at').eq('id', inv.id).single();
  ok(!!inv2.accepted_at, 'uitnodiging staat op aangenomen');
  const again = await api('POST', '/api/invitations/accept', null, { token: signInviteToken(inv.id, SECRET) });
  ok(again.status === 409 && again.body.code === 'used', 'dezelfde link nogmaals: "al gebruikt"');

  // 6. Intrekken: uit de cursus en het ongebruikte account weg.
  await api('POST', `/api/admin/courses/${course.id}/invitations`, token, { emails: [mail('intrekken')] });
  const revId = await userIdOf(mail('intrekken'));
  if (revId) created.users.push(revId);
  const rv = await api('DELETE', `/api/admin/courses/${course.id}/invitations/${revId}`, token);
  ok(rv.status === 200 && rv.body.accountDeleted === true, 'intrekken: account verwijderd');
  const { data: gone } = await admin.auth.admin.getUserById(revId);
  ok(!gone?.user, 'ingetrokken account bestaat niet meer');

  // 7. Verlopen na 30 dagen: opruimen (zelfde module, echte database).
  await api('POST', `/api/admin/courses/${course.id}/invitations`, token, { emails: [mail('verlopen')] });
  const expId = await userIdOf(mail('verlopen'));
  if (expId) created.users.push(expId);
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  await admin.from('course_invitations').update({ invited_at: old, last_sent_at: old }).eq('course_id', course.id).eq('user_id', expId);
  const mod = registerCourseInvitationRoutes({ post() {}, get() {}, delete() {} }, {
    supabaseAdmin: admin, secret: SECRET, startTimers: false, getEmailConfig: async () => null, sendEmail: async () => ({ ok: false }),
  });
  const res = await mod.cleanupExpired();
  ok(res.removed >= 1 && res.accounts >= 1, `opruimen: verlopen uitnodiging en account weg (${JSON.stringify(res)})`);
  const { data: expUser } = await admin.auth.admin.getUserById(expId);
  ok(!expUser?.user, 'verlopen account bestaat niet meer');
  const { data: stillNew } = await admin.auth.admin.getUserById(newId);
  ok(!!stillNew?.user, 'geactiveerd account blijft bestaan');

  // 8. Wachtrij met een nep-mailer: de echte mailtekst, en de link uit de mail werkt.
  await api('POST', `/api/admin/courses/${course.id}/invitations`, token, { emails: [mail('mail')] });
  const mailId = await userIdOf(mail('mail'));
  if (mailId) created.users.push(mailId);
  await new Promise((r) => setTimeout(r, 1000));
  await admin.from('course_invitations').update({ mail_status: 'queued', mail_error: null }).eq('course_id', course.id).eq('user_id', mailId);
  const sent = [];
  const mailer = registerCourseInvitationRoutes({ post() {}, get() {}, delete() {} }, {
    supabaseAdmin: admin, secret: SECRET, startTimers: false, appUrl: () => API,
    getEmailConfig: async () => ({ provider: 'test' }),
    sendEmail: async (_cfg, m) => { sent.push(m); return { ok: true }; },
  });
  await mailer.processQueue();
  const m = sent.find((x) => x.to === mail('mail'));
  const { data: me } = await admin.from('profiles').select('full_name, email').eq('email', process.env.UI_AUDIT_EMAIL).maybeSingle();
  const inviter = me?.full_name?.trim() || me?.email;
  ok(!!m && m.subject.includes(inviter) && m.subject.includes(course.name), `mail noemt docent en cursus ("${m?.subject}")`);
  const tokenFromMail = m?.text.match(/invite#t=([^\s]+)/)?.[1];
  const viaMail = await api('POST', '/api/invitations/accept', null, { token: tokenFromMail });
  ok(viaMail.status === 200 && !!viaMail.body.tokenHash, 'de link uit de mail werkt');
  const { data: q } = await admin.from('course_invitations').select('mail_status, last_sent_at').eq('course_id', course.id).eq('user_id', mailId).single();
  ok(q.mail_status === 'sent' && !!q.last_sent_at, 'wachtrij zet de uitnodiging op verstuurd');
} catch (e) {
  ok(false, `onverwachte fout: ${e.message}`);
} finally {
  for (const id of created.users) await admin.auth.admin.deleteUser(id).catch(() => {});
  if (created.course) await admin.from('courses').delete().eq('id', created.course);
  console.log(`opgeruimd: ${created.users.length} account(s), cursus ${created.course ? 'verwijderd' : '-'}`);
  console.log(failures ? `\n${failures} controle(s) mislukt` : '\nAlles in orde');
  process.exit(failures ? 1 : 0);
}
