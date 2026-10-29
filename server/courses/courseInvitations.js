// ───────────────────────────────────────────────────────────────────────────
// Studenten uitnodigen voor een cursus (2026-10-26).
//
// Een docent (of beheerder) geeft e-mailadressen op voor een van zijn cursussen.
//  - Bestaand account: direct ingeschreven als student; een korte mail meldt dat.
//    De actieve cursus van die persoon verandert niet.
//  - Nog geen account: LEAP maakt het account aan (nog niet geactiveerd), schrijft
//    het in als student, zet de cursus als actieve cursus en stuurt een
//    persoonlijke uitnodiging ("<docent> nodigt je uit voor <cursus>"). De link
//    in die mail is 30 dagen geldig: hij wijst naar /invite in LEAP, en pas bij
//    het klikken maakt de server een eenmalige inlogcode (de gewone link van de
//    inlogdienst zou na een dag verlopen). Daarna kiest de student een
//    wachtwoord (/activate) en zit hij in de cursus.
//  - Niet geactiveerd na 30 dagen (gerekend vanaf de laatste mail): account,
//    inschrijving en uitnodiging worden verwijderd, zodat er geen account blijft
//    staan waar iemand nooit ja tegen zei.
//
// Met role 'teacher' ("Docent toevoegen", 2026-10-27) gaat het net zo, maar wordt
// de persoon docent van de cursus en krijgt hij het docentprofiel; een student
// van de cursus wordt gepromoveerd. De mail noemt dan de rol van docent.
//
// Uitnodigen staat los van de toegangsroute van de cursus (enrollment.js): ook
// in een Canvas- of gesloten cursus, en ook met een VU-adres. De docent staat
// ervoor in; wie uitnodigde staat in de mail en in invited_by.
//
// Mails gaan via een wachtrij in de database (mail_status), die zich aan de
// mail-limiet houdt (Azure: 30 per minuut, 100 per uur; wij blijven eronder,
// zodat account-mails ook nog door kunnen). Een docent nodigt hoogstens
// DAILY_INVITE_LIMIT mensen per 24 uur uit; een beheerder heeft geen limiet.
// ───────────────────────────────────────────────────────────────────────────

import { createHmac, timingSafeEqual } from 'node:crypto';
import { translate } from '../i18n/notificationI18n.js';
import { escapeHtml } from '../lib/notifications.js';
import { normalizeEmailList, validateBatchSize } from './bulkAccounts.js';
import { normalizeLang } from '../i18n/languages.js';

export const INVITE_VALID_DAYS = 30;
export const DAILY_INVITE_LIMIT = 300;
export const MAIL_PER_MINUTE = 20;
export const MAIL_PER_HOUR = 80;
export const MAX_MAIL_ATTEMPTS = 3;
export const RESEND_MIN_MINUTES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Link-token: uitnodigings-id + HMAC, zodat niemand een id kan raden of maken. */
export function signInviteToken(id, secret) {
  const mac = createHmac('sha256', String(secret)).update(`invite:${id}`).digest('base64url');
  return `${id}.${mac}`;
}

/** Geeft het uitnodigings-id terug, of null bij een ongeldig token. */
export function verifyInviteToken(token, secret) {
  const s = String(token || '');
  const dot = s.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = s.slice(0, dot);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const expected = Buffer.from(signInviteToken(id, secret));
  const given = Buffer.from(s);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return id;
}

/** De uitnodiging verloopt 30 dagen na de laatste mail (of na het uitnodigen). */
export function inviteExpiresAt(row) {
  const from = new Date(row.last_sent_at || row.invited_at).getTime();
  return new Date(from + INVITE_VALID_DAYS * DAY_MS);
}

/** Status voor de docent: queued | failed | pending | expired | accepted. */
export function invitationStatus(row, now = new Date()) {
  if (row.accepted_at) return 'accepted';
  if (inviteExpiresAt(row).getTime() <= now.getTime()) return 'expired';
  if (row.mail_status === 'queued') return 'queued';
  if (row.mail_status === 'failed') return 'failed';
  return 'pending';
}

/** Een account dat nog nooit is gebruikt (geen bevestiging, nooit ingelogd). */
export function isUnusedAccount(authUser) {
  return !!authUser && !authUser.email_confirmed_at && !authUser.last_sign_in_at;
}

/** Glijdend venster voor het aantal mails per minuut en per uur. */
export function createMailBudget({ perMinute = MAIL_PER_MINUTE, perHour = MAIL_PER_HOUR } = {}) {
  let sent = [];
  const prune = (now) => { sent = sent.filter((t) => now - t < 60 * 60 * 1000); };
  return {
    available(now = Date.now()) {
      prune(now);
      const lastMinute = sent.filter((t) => now - t < 60 * 1000).length;
      return Math.max(0, Math.min(perMinute - lastMinute, perHour - sent.length));
    },
    take(now = Date.now()) {
      if (this.available(now) <= 0) return false;
      sent.push(now);
      return true;
    },
  };
}

/** Bouwt { subject, html, text } voor een uitnodiging (kind 'new') of een melding (kind 'added'). */
export function buildInvitationEmail({ kind, lang = 'nl', inviterName, courseName, link, asTeacher = false }) {
  const t = (key, vars) => translate(lang, key, vars);
  const vars = { inviter: inviterName || t('email.invite.someone'), course: courseName || '' };
  const group = kind === 'new' ? 'invite' : 'added';
  const subject = t(`email.${group}.subject`, vars);
  const greeting = t('email.digest.greetingNoName');
  const intro = t(`email.${group}.${asTeacher ? 'introTeacher' : 'intro'}`, vars);
  const paragraphs = kind === 'new'
    ? [intro, t('email.invite.howto', vars)]
    : [intro];
  const cta = t(`email.${group}.cta`, vars);
  const footer = kind === 'new'
    ? [t('email.invite.validity', vars), t('email.invite.ignore', vars)]
    : [t('email.added.ignore', vars)];

  const text = [greeting, '', ...paragraphs.flatMap((p) => [p, '']), `${cta}: ${link}`, '', ...footer].join('\n');
  const html =
    `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#222;line-height:1.5">` +
    `<p>${escapeHtml(greeting)}</p>` +
    paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('') +
    `<p style="margin:20px 0"><a href="${escapeHtml(link)}" ` +
    `style="background:#f59e0b;color:#fff;padding:10px 18px;border-radius:10px;` +
    `text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(cta)}</a></p>` +
    `<p style="color:#888;font-size:12px">${escapeHtml(t('email.auth.linkHint'))}<br/>` +
    `<a href="${escapeHtml(link)}" style="color:#888;word-break:break-all">${escapeHtml(link)}</a></p>` +
    `<hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>` +
    footer.map((p) => `<p style="color:#888;font-size:12px">${escapeHtml(p)}</p>`).join('') +
    `</div>`;
  return { subject, html, text };
}

// ── Database-helpers ────────────────────────────────────────────────────────

/** Openstaande uitnodigingen (nieuw account, nog niet geactiveerd) per lid van een cursus. */
export async function pendingInvitationsForCourse(db, courseId, now = new Date()) {
  const { data, error } = await db
    .from('course_invitations')
    .select('user_id, invited_at, last_sent_at, mail_status, mail_error, accepted_at, invited_by')
    .eq('course_id', courseId).eq('kind', 'new').is('accepted_at', null);
  if (error) return new Map(); // tabel ontbreekt (migratie nog niet gedraaid): geen status tonen
  const map = new Map();
  for (const r of data || []) {
    map.set(r.user_id, {
      status: invitationStatus(r, now),
      invitedAt: r.invited_at,
      lastSentAt: r.last_sent_at,
      expiresAt: inviteExpiresAt(r).toISOString(),
      mailError: r.mail_error || null,
    });
  }
  return map;
}

// ── Routes, wachtrij en opruimen ────────────────────────────────────────────

/**
 * deps: supabaseAdmin, resolveAdminUser(req), isCourseTeacher(userId, courseId),
 *       secret, appUrl() (publiek adres, mag leeg zijn), getEmailConfig(), sendEmail(cfg, mail),
 *       forgetUser(id) (auth-caches legen na verwijderen), now() (tests)
 */
export function registerCourseInvitationRoutes(app, deps) {
  const db = deps.supabaseAdmin;
  const now = deps.now || (() => new Date());
  const budget = deps.mailBudget || createMailBudget();
  let lastOrigin = '';
  const baseUrl = () => String(deps.appUrl?.() || lastOrigin || '').replace(/\/+$/, '');
  const acceptLimiter = new Map();

  async function authorize(req, res, courseId) {
    if (!db) { res.status(503).json({ error: 'Admin client niet beschikbaar' }); return null; }
    // Zonder ingesteld publiek adres (lokaal) gebruikt de mail het adres van de docent.
    if (typeof req.headers.origin === 'string' && /^https?:\/\//.test(req.headers.origin)) lastOrigin = req.headers.origin;
    const r = await deps.resolveAdminUser(req);
    if (r.error) { res.status(r.error.status).json(r.error.body); return null; }
    if (!r.isAdmin && !(await deps.isCourseTeacher(r.user.id, courseId))) {
      res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
      return null;
    }
    return r;
  }

  async function enroll(courseId, userId, { insertOnly, role = 'student', by = null }) {
    const { error } = await db.from('course_members').upsert(
      { course_id: courseId, user_id: userId, member_role: role, role },
      { onConflict: 'course_id,user_id', ignoreDuplicates: !!insertOnly },
    );
    if (error) return error.message;
    // Docent in een cursus = docentprofiel (databaseregels voor projecten en opslag kijken daarnaar).
    if (role === 'teacher') await deps.promoteTeacherProfile?.(userId, by, courseId);
    return null;
  }

  async function saveInvitation(row) {
    const { error } = await db.from('course_invitations').upsert(row, { onConflict: 'course_id,user_id' });
    return error ? error.message : null;
  }

  // POST /api/admin/courses/:id/invitations — { emails: string[], role?: 'student'|'teacher' } (hoogstens 50 per keer).
  app.post('/api/admin/courses/:id/invitations', async (req, res) => {
    const courseId = req.params.id;
    const r = await authorize(req, res, courseId);
    if (!r) return;
    const role = req.body?.role === 'teacher' ? 'teacher' : 'student';

    const { data: course } = await db.from('courses').select('id, name').eq('id', courseId).maybeSingle();
    if (!course) return res.status(404).json({ error: 'Cursus niet gevonden' });

    const { valid, invalid, duplicates } = normalizeEmailList(Array.isArray(req.body?.emails) ? req.body.emails : []);
    const size = validateBatchSize(valid);
    if (!size.ok) return res.status(size.status).json(size.body);

    // Daglimiet per docent (beheerders niet).
    let room = Infinity;
    if (!r.isAdmin) {
      const since = new Date(now().getTime() - DAY_MS).toISOString();
      const { count } = await db.from('course_invitations').select('id', { count: 'exact', head: true })
        .eq('invited_by', r.user.id).gte('invited_at', since);
      room = Math.max(0, DAILY_INVITE_LIMIT - (count || 0));
    }

    const lang = normalizeLang(req.get('x-leap-lang') || r.profile?.preferred_lang || 'nl');
    const { data: profs } = await db.from('profiles').select('id, email').in('email', valid);
    const byEmail = new Map((profs || []).map((p) => [String(p.email).toLowerCase(), p.id]));
    const { data: members } = await db.from('course_members').select('user_id, member_role').eq('course_id', courseId);
    const memberRoles = new Map((members || []).map((m) => [m.user_id, m.member_role]));

    const results = [];
    for (const email of valid) {
      try {
        let userId = byEmail.get(email);
        if (userId && memberRoles.has(userId)) {
          // Docent toevoegen voor iemand die al student is: promoveren, geen mail.
          if (role === 'teacher' && memberRoles.get(userId) !== 'teacher') {
            const { error: upErr } = await db.from('course_members').update({ member_role: 'teacher', role: 'teacher' })
              .eq('course_id', courseId).eq('user_id', userId).neq('role', 'superuser');
            if (upErr) { results.push({ email, status: 'failed', error: upErr.message }); continue; }
            await deps.promoteTeacherProfile?.(userId, r.user.id, courseId);
            memberRoles.set(userId, 'teacher');
            results.push({ email, status: 'promoted' });
            continue;
          }
          results.push({ email, status: 'alreadyMember' });
          continue;
        }
        if (room <= 0) { results.push({ email, status: 'limit' }); continue; }

        let kind = 'added';
        if (userId) {
          // Bestaat al, maar nooit geactiveerd (bijv. eerder uitgenodigd voor een andere cursus)?
          // Dan krijgt ook deze uitnodiging een activeringslink.
          const { data: au } = await db.auth.admin.getUserById(userId);
          if (isUnusedAccount(au?.user)) kind = 'new';
          const err = await enroll(courseId, userId, { insertOnly: true, role, by: r.user.id });
          if (err) { results.push({ email, status: 'failed', error: err }); continue; }
        } else {
          const { data: created, error: cErr } = await db.auth.admin.createUser({ email, email_confirm: false, user_metadata: { full_name: '' } });
          if (cErr || !created?.user?.id) {
            // Tegelijk door iemand anders aangemaakt: behandel als bestaand.
            const { data: p2 } = await db.from('profiles').select('id').eq('email', email).maybeSingle();
            if (!p2?.id) { results.push({ email, status: 'failed', error: cErr?.message || 'createUser' }); continue; }
            userId = p2.id;
            const err = await enroll(courseId, userId, { insertOnly: true, role, by: r.user.id });
            if (err) { results.push({ email, status: 'failed', error: err }); continue; }
          } else {
            userId = created.user.id;
            kind = 'new';
            const err = await enroll(courseId, userId, { insertOnly: false, role, by: r.user.id });
            if (err) { results.push({ email, status: 'failed', error: err }); continue; }
            await db.from('profiles').update({ last_active_course_id: courseId }).eq('id', userId);
          }
        }
        const saveErr = await saveInvitation({
          course_id: courseId, user_id: userId, email, kind, invited_by: r.user.id,
          invited_at: now().toISOString(), lang, mail_status: 'queued', mail_attempts: 0, mail_error: null,
          last_sent_at: null, accepted_at: kind === 'added' ? now().toISOString() : null,
        });
        if (saveErr) { results.push({ email, status: 'failed', error: saveErr }); continue; }
        room -= 1;
        memberRoles.set(userId, role);
        results.push({ email, status: kind === 'new' ? 'invited' : 'added' });
      } catch (e) {
        results.push({ email, status: 'failed', error: e?.message || 'onbekende fout' });
      }
    }
    setTimeout(() => { processQueue().catch(() => {}); }, 0);
    const count = (s) => results.filter((x) => x.status === s).length;
    return res.json({
      results,
      summary: {
        invited: count('invited'), added: count('added'), promoted: count('promoted'), alreadyMember: count('alreadyMember'),
        limit: count('limit'), failed: count('failed'), invalid: invalid.length, duplicates,
      },
    });
  });

  // POST …/invitations/:userId/resend — uitnodiging opnieuw sturen (verlengt ook de geldigheid).
  app.post('/api/admin/courses/:id/invitations/:userId/resend', async (req, res) => {
    const { id: courseId, userId } = req.params;
    if (!(await authorize(req, res, courseId))) return;
    const { data: row } = await db.from('course_invitations').select('*')
      .eq('course_id', courseId).eq('user_id', userId).maybeSingle();
    if (!row || row.kind !== 'new' || row.accepted_at) return res.status(404).json({ error: 'Geen openstaande uitnodiging' });
    if (row.mail_status === 'queued') return res.json({ ok: true, status: 'queued' });
    if (row.mail_status === 'sent' && row.last_sent_at
      && now().getTime() - new Date(row.last_sent_at).getTime() < RESEND_MIN_MINUTES * 60 * 1000) {
      return res.status(429).json({ error: 'De uitnodiging is net verstuurd. Probeer het over een paar minuten opnieuw.', code: 'resendTooSoon' });
    }
    await db.from('course_invitations').update({ mail_status: 'queued', mail_attempts: 0, mail_error: null })
      .eq('id', row.id);
    setTimeout(() => { processQueue().catch(() => {}); }, 0);
    return res.json({ ok: true, status: 'queued' });
  });

  // DELETE …/invitations/:userId — uitnodiging intrekken: uit de cursus, en het account
  // weg als het nergens anders voor dient en nooit is gebruikt.
  app.delete('/api/admin/courses/:id/invitations/:userId', async (req, res) => {
    const { id: courseId, userId } = req.params;
    if (!(await authorize(req, res, courseId))) return;
    const { data: row } = await db.from('course_invitations').select('id, kind, accepted_at')
      .eq('course_id', courseId).eq('user_id', userId).maybeSingle();
    if (!row || row.kind !== 'new' || row.accepted_at) return res.status(404).json({ error: 'Geen openstaande uitnodiging' });
    await db.from('course_members').delete().eq('course_id', courseId).eq('user_id', userId);
    await db.from('course_invitations').delete().eq('id', row.id);
    const accountDeleted = await deleteIfOrphaned(userId);
    return res.json({ ok: true, accountDeleted });
  });

  // POST /api/invitations/accept — { token } uit de mail. Geen inlog nodig: het
  // token bewijst dat de klikker de mail ontving. Geeft een eenmalige inlogcode.
  app.post('/api/invitations/accept', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const ip = String(req.ip || 'x');
    const hits = (acceptLimiter.get(ip) || []).filter((t) => Date.now() - t < 10 * 60 * 1000);
    if (hits.length >= 20) return res.status(429).json({ error: 'Te veel pogingen. Probeer het later opnieuw.', code: 'tooMany' });
    hits.push(Date.now()); acceptLimiter.set(ip, hits);
    if (acceptLimiter.size > 5000) acceptLimiter.delete(acceptLimiter.keys().next().value);

    const id = verifyInviteToken(req.body?.token, deps.secret);
    if (!id) return res.status(400).json({ error: 'Deze uitnodigingslink klopt niet.', code: 'invalid' });
    const { data: row } = await db.from('course_invitations').select('id, course_id, user_id, email, kind, invited_at, last_sent_at, accepted_at')
      .eq('id', id).maybeSingle();
    if (!row || row.kind !== 'new') return res.status(404).json({ error: 'Deze uitnodiging bestaat niet meer.', code: 'gone' });
    if (row.accepted_at) return res.status(409).json({ error: 'Deze uitnodiging is al gebruikt. Log in met je e-mailadres en wachtwoord.', code: 'used' });
    if (invitationStatus(row, now()) === 'expired') return res.status(410).json({ error: 'Deze uitnodiging is verlopen. Vraag je docent om een nieuwe.', code: 'expired' });

    const { data: au } = await db.auth.admin.getUserById(row.user_id);
    if (!au?.user) return res.status(404).json({ error: 'Deze uitnodiging bestaat niet meer.', code: 'gone' });
    const needsPassword = isUnusedAccount(au.user);
    const type = au.user.email_confirmed_at ? 'magiclink' : 'invite';
    const { data: link, error } = await db.auth.admin.generateLink({ type, email: au.user.email });
    const tokenHash = link?.properties?.hashed_token;
    if (error || !tokenHash) return res.status(500).json({ error: 'Inloggen lukte niet. Probeer het opnieuw.', code: 'loginFailed' });

    // Het account is nu geactiveerd: alle openstaande uitnodigingen van deze persoon tellen als aangenomen.
    await db.from('course_invitations').update({ accepted_at: now().toISOString() })
      .eq('user_id', row.user_id).eq('kind', 'new').is('accepted_at', null);
    await db.from('profiles').update({ last_active_course_id: row.course_id }).eq('id', row.user_id);
    const { data: course } = await db.from('courses').select('name').eq('id', row.course_id).maybeSingle();
    return res.json({ tokenHash, type, needsPassword, courseName: course?.name || '' });
  });

  // Verwijdert een account dat alleen door uitnodigingen bestaat en nooit is gebruikt.
  async function deleteIfOrphaned(userId) {
    const [{ data: au }, { count: memberships }, { count: invitations }] = await Promise.all([
      db.auth.admin.getUserById(userId),
      db.from('course_members').select('user_id', { count: 'exact', head: true }).eq('user_id', userId),
      db.from('course_invitations').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    ]);
    if (!isUnusedAccount(au?.user) || (memberships || 0) > 0 || (invitations || 0) > 0) return false;
    const { error } = await db.auth.admin.deleteUser(userId);
    if (error) return false;
    deps.forgetUser?.(userId);
    return true;
  }

  let queueBusy = false;
  async function processQueue() {
    if (!db || queueBusy) return;
    queueBusy = true;
    try {
      const room = budget.available();
      if (room <= 0) return;
      const { data: rows, error } = await db.from('course_invitations')
        .select('id, course_id, user_id, email, kind, invited_by, lang, mail_attempts')
        .eq('mail_status', 'queued').order('invited_at', { ascending: true }).limit(room);
      if (error || !rows?.length) return;
      const cfg = await deps.getEmailConfig();
      const base = baseUrl();
      for (const row of rows) {
        if (!cfg || !base) {
          await db.from('course_invitations').update({ mail_status: 'failed', mail_error: cfg ? 'noAppUrl' : 'notConfigured' }).eq('id', row.id);
          continue;
        }
        if (!budget.take()) break;
        const [{ data: course }, { data: inviter }, { data: membership }] = await Promise.all([
          db.from('courses').select('name').eq('id', row.course_id).maybeSingle(),
          row.invited_by ? db.from('profiles').select('full_name, email').eq('id', row.invited_by).maybeSingle() : Promise.resolve({ data: null }),
          db.from('course_members').select('member_role').eq('course_id', row.course_id).eq('user_id', row.user_id).maybeSingle(),
        ]);
        const link = row.kind === 'new' ? `${base}/invite#t=${signInviteToken(row.id, deps.secret)}` : `${base}/dashboard`;
        const mail = buildInvitationEmail({
          kind: row.kind, lang: row.lang, link, courseName: course?.name,
          inviterName: inviter?.full_name?.trim() || inviter?.email || '',
          asTeacher: membership?.member_role === 'teacher',
        });
        let result;
        try { result = await deps.sendEmail(cfg, { to: row.email, ...mail }); } catch (e) { result = { ok: false, error: e?.message }; }
        if (result?.ok) {
          await db.from('course_invitations').update({ mail_status: 'sent', mail_error: null, last_sent_at: now().toISOString(), mail_attempts: (row.mail_attempts || 0) + 1 }).eq('id', row.id);
        } else {
          const attempts = (row.mail_attempts || 0) + 1;
          await db.from('course_invitations').update({
            mail_attempts: attempts, mail_error: String(result?.error || 'sendFailed').slice(0, 300),
            mail_status: attempts >= MAX_MAIL_ATTEMPTS ? 'failed' : 'queued',
          }).eq('id', row.id);
        }
      }
    } finally {
      queueBusy = false;
    }
  }

  // Ruimt verlopen, nooit geactiveerde uitnodigingen op (met het account als dat nergens anders voor dient).
  async function cleanupExpired() {
    if (!db) return { removed: 0, accounts: 0 };
    const { data: rows, error } = await db.from('course_invitations')
      .select('id, course_id, user_id, invited_at, last_sent_at, accepted_at, mail_status, kind')
      .eq('kind', 'new').is('accepted_at', null);
    if (error || !rows?.length) return { removed: 0, accounts: 0 };
    const expired = rows.filter((r) => invitationStatus(r, now()) === 'expired');
    let removed = 0; let accounts = 0;
    for (const r of expired) {
      const { data: au } = await db.auth.admin.getUserById(r.user_id);
      if (au?.user && !isUnusedAccount(au.user)) {
        // Toch binnengekomen (bijv. via Canvas of wachtwoord vergeten): telt als aangenomen.
        await db.from('course_invitations').update({ accepted_at: now().toISOString() }).eq('id', r.id);
        continue;
      }
      await db.from('course_members').delete().eq('course_id', r.course_id).eq('user_id', r.user_id);
      await db.from('course_invitations').delete().eq('id', r.id);
      removed += 1;
      if (await deleteIfOrphaned(r.user_id)) accounts += 1;
    }
    if (removed) console.log(`[invitations] ${removed} verlopen uitnodiging(en) opgeruimd, ${accounts} ongebruikt(e) account(s) verwijderd`);
    return { removed, accounts };
  }

  if (deps.startTimers !== false) {
    setInterval(() => { processQueue().catch((e) => console.warn('[invitations] wachtrij:', e?.message)); }, 30 * 1000).unref?.();
    setTimeout(() => { cleanupExpired().catch(() => {}); }, 2 * 60 * 1000).unref?.();
    setInterval(() => { cleanupExpired().catch((e) => console.warn('[invitations] opruimen:', e?.message)); }, 6 * 60 * 60 * 1000).unref?.();
  }

  return { processQueue, cleanupExpired };
}
