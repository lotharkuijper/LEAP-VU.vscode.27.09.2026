// Toegangsroute per cursus en open registratie (2026-10-20).
//
// Elke cursus heeft een toegangsroute (courses.enrollment_mode):
//   closed      — gesloten: alleen wie de beheerder (of een docent van de cursus) toevoegt;
//   canvas      — Canvas: straks via de VUnet-id-lijst van de gekoppelde Canvas-cursus;
//   open        — open registratie: iedereen kan zich aanmelden en deze cursus kiezen;
//   canvas_open — beide (uitzondering; alleen na een extra bevestiging).
// Alleen een LEAP-beheerder stelt de route in. Docenten blijven zelf leden
// toevoegen en bevorderen tot docent (student-assistenten), zoals voorheen.
//
// Toegang tot een cursus = lidmaatschap (course_members), plus docenten en
// beheerders. "Actief en zichtbaar = open voor iedereen" bestaat niet meer.
//
// Open registratie: een nieuwe gebruiker kiest bij het aanmelden één of meer
// open cursussen. Die worden bewaard als aanmelding in afwachting
// (pending_course_enrollments) en worden lidmaatschappen bij de eerste login
// met een bevestigd e-mailadres. VU-adressen (vu.nl en subdomeinen, zoals
// student.vu.nl) kunnen niet via open registratie: VU-studenten komen straks
// via Canvas. Wie als VU-student toch een open cursus wil volgen, gebruikt een
// privé-adres. Dezelfde regel geldt voor zelf aansluiten bij een open cursus.

export const ENROLLMENT_MODES = ['closed', 'canvas', 'open', 'canvas_open'];
export const DEFAULT_ENROLLMENT_MODE = 'open';
export const MAX_COURSES_AT_SIGNUP = 10;
export const MIN_PASSWORD_LENGTH = 6;

/** Domeinen die niet via open registratie mogen (env OPEN_REG_BLOCKED_DOMAINS, kommagescheiden). */
export function blockedDomains(env = process.env) {
  return String(env.OPEN_REG_BLOCKED_DOMAINS || 'vu.nl').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
}

/** Pure: is dit een geldige toegangsroute? */
export const isEnrollmentMode = (m) => ENROLLMENT_MODES.includes(m);

/** Pure: staat deze route open registratie toe? */
export const allowsOpenRegistration = (mode) => mode === 'open' || mode === 'canvas_open';

/** Pure: valt dit e-mailadres onder een geblokkeerd domein (ook subdomeinen)? */
export function isBlockedEmail(email, domains = blockedDomains()) {
  const at = String(email || '').trim().toLowerCase().split('@');
  if (at.length !== 2 || !at[1]) return false;
  const host = at[1];
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Pure: kan een cursus via open registratie of "Cursus toevoegen" gekozen worden? */
export function isSelfJoinable(course) {
  return !!course && course.is_active !== false && course.student_visible !== false && allowsOpenRegistration(course.enrollment_mode);
}

/**
 * Pure: controleer een registratieverzoek. `openCourseIds` = ids van cursussen
 * die nu via open registratie te kiezen zijn. Geeft { ok, code?, courseIds? }.
 */
// Wegwerp-adressen (2026-10-28): open registratie is de ingang voor misbruik van het
// taalmodel; een adres dat over een uur niet meer bestaat, is geen echte deelnemer.
export const DISPOSABLE_DOMAINS = Object.freeze([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'sharklasers.com', 'grr.la', '10minutemail.com',
  '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'tempmail.net', 'yopmail.com', 'yopmail.fr', 'trashmail.com',
  'getnada.com', 'dispostable.com', 'maildrop.cc', 'mailnesia.com', 'mintemail.com', 'throwawaymail.com',
  'fakeinbox.com', 'emailondeck.com', 'moakt.com', 'tempail.com', 'mohmal.com', 'burnermail.io', 'mail.tm',
]);
export function isDisposableEmail(mail) {
  const domain = String(mail || '').toLowerCase().split('@')[1] || '';
  return DISPOSABLE_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
}

export function validateRegistration({ fullName, email, password, courseIds }, openCourseIds, domains = blockedDomains()) {
  const name = String(fullName || '').trim();
  const mail = String(email || '').trim().toLowerCase();
  if (!name) return { ok: false, code: 'nameRequired' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return { ok: false, code: 'invalidEmail' };
  if (isBlockedEmail(mail, domains)) return { ok: false, code: 'vuEmail' };
  if (isDisposableEmail(mail)) return { ok: false, code: 'disposableEmail' };
  if (String(password || '').length < MIN_PASSWORD_LENGTH) return { ok: false, code: 'passwordTooShort' };
  const wanted = [...new Set((Array.isArray(courseIds) ? courseIds : []).map(String))];
  if (wanted.length === 0) return { ok: false, code: 'courseRequired' };
  if (wanted.length > MAX_COURSES_AT_SIGNUP) return { ok: false, code: 'tooManyCourses' };
  const open = new Set(openCourseIds);
  if (wanted.some((id) => !open.has(id))) return { ok: false, code: 'courseNotOpen' };
  return { ok: true, name, email: mail, courseIds: wanted };
}

/** Eenvoudige teller per sleutel (IP) en venster; geheugen van dit ene proces (één replica). */
export function createRateLimiter({ limit = 5, windowMs = 60 * 60 * 1000 } = {}) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= limit) { hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 5000) hits.delete(hits.keys().next().value);
    return true;
  };
}

const MESSAGES = {
  nameRequired: 'Vul je naam in',
  invalidEmail: 'Vul een geldig e-mailadres in',
  vuEmail: 'Met een VU-adres kun je je hier niet aanmelden. VU-studenten komen via Canvas in hun cursus. Wil je een open cursus volgen, gebruik dan een privé-e-mailadres.',
  passwordTooShort: 'Je wachtwoord moet minstens 6 tekens hebben',
  courseRequired: 'Kies minstens één cursus',
  tooManyCourses: 'Kies hoogstens 10 cursussen',
  courseNotOpen: 'Een van de gekozen cursussen is niet (meer) open voor aanmelding',
  disposableEmail: 'Met een wegwerp-e-mailadres kun je je niet aanmelden. Gebruik een e-mailadres dat je blijft gebruiken.',
};

/**
 * Routes. deps: supabaseAdmin, createAnonClient(), requireAuthUser, isAdminProfile(profile),
 * appOrigin(req), onMembershipChanged(userId), onOpenRegistration(userId) (tokenbudget, server/account/tokenBudget.js).
 */
export function registerEnrollmentRoutes(app, deps) {
  const { supabaseAdmin: db, createAnonClient, requireAuthUser, isAdminProfile, appOrigin, onMembershipChanged = () => {} } = deps;
  // Hoogstens 20 geldige registraties per uur per adres (een zaal op één netwerk
  // moet kunnen); typefouten tellen niet mee.
  // Hoogstens 10 aanmeldingen per IP-adres per uur (tegen nep-accounts, 2026-10-28).
  const registerLimiter = createRateLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });

  async function openCourses() {
    const { data, error } = await db.from('courses')
      .select('id, name, description, is_active, student_visible, enrollment_mode')
      .eq('is_active', true).eq('student_visible', true)
      .in('enrollment_mode', ['open', 'canvas_open'])
      .order('name');
    if (error) throw new Error(error.message);
    return (data || []).filter(isSelfJoinable);
  }

  // Openbaar (ook zonder login): de cursussen die je bij het aanmelden kunt kiezen.
  app.get('/api/courses/open', async (_req, res) => {
    try {
      const list = await openCourses();
      return res.json({ courses: list.map((c) => ({ id: c.id, name: c.name, description: c.description || '' })) });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Open registratie: account aanmaken + gekozen cursussen in afwachting zetten.
  app.post('/api/auth/register', async (req, res) => {
    const ip = String(req.ip || '') || 'onbekend';
    try {
      const open = await openCourses();
      const v = validateRegistration(req.body || {}, open.map((c) => c.id));
      if (!v.ok) return res.status(400).json({ error: MESSAGES[v.code], code: v.code });
      if (!registerLimiter(ip)) return res.status(429).json({ error: 'Te veel aanmeldingen vanaf dit adres. Probeer het later opnieuw.', code: 'rateLimited' });
      const anon = createAnonClient();
      const { data, error } = await anon.auth.signUp({
        email: v.email,
        password: String(req.body.password),
        options: { data: { full_name: v.name }, emailRedirectTo: `${appOrigin(req)}/` },
      });
      if (error) {
        const already = /already registered/i.test(error.message || '');
        return res.status(already ? 409 : 400).json({ error: error.message, code: already ? 'alreadyRegistered' : 'signupFailed' });
      }
      // Bestaand adres: GoTrue geeft dan een gebruiker zonder identiteiten terug.
      // Niets vastleggen; dezelfde melding als bij een bestaand account.
      const user = data?.user;
      if (!user || (Array.isArray(user.identities) && user.identities.length === 0)) {
        return res.status(409).json({ error: 'Er bestaat al een account met dit e-mailadres. Log in en kies daarna "Cursus toevoegen".', code: 'alreadyRegistered' });
      }
      const rows = v.courseIds.map((courseId) => ({ user_id: user.id, course_id: courseId }));
      const { error: pErr } = await db.from('pending_course_enrollments').upsert(rows, { onConflict: 'user_id,course_id', ignoreDuplicates: true });
      if (pErr) console.error('[open registratie] aanmelding in afwachting niet bewaard:', pErr.message);
      // Tokenbudget: dit account kwam via open registratie binnen.
      await deps.onOpenRegistration?.(user.id);
      return res.json({ ok: true, needsConfirmation: !data.session });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Na inloggen: aanmeldingen in afwachting omzetten in lidmaatschappen
  // (alleen met een bevestigd e-mailadres, en alleen voor cursussen die nog open zijn).
  app.post('/api/me/activate-enrollments', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    try {
      const { data: pending } = await db.from('pending_course_enrollments').select('course_id').eq('user_id', auth.user.id);
      if (!pending || pending.length === 0) return res.json({ activated: [] });
      if (!auth.user.email_confirmed_at) return res.json({ activated: [], waiting: pending.length });
      const ids = pending.map((p) => p.course_id);
      const { data: courses } = await db.from('courses').select('id, is_active, student_visible, enrollment_mode').in('id', ids);
      const ok = (courses || []).filter(isSelfJoinable).map((c) => c.id);
      if (ok.length) {
        const { error } = await db.from('course_members').upsert(
          ok.map((courseId) => ({ course_id: courseId, user_id: auth.user.id, member_role: 'student', role: 'student' })),
          { onConflict: 'course_id,user_id', ignoreDuplicates: true },
        );
        if (error) return res.status(500).json({ error: error.message });
        // Eerste keer: meteen de eerste gekozen cursus openen.
        const { data: prof } = await db.from('profiles').select('last_active_course_id').eq('id', auth.user.id).maybeSingle();
        if (!prof?.last_active_course_id) await db.from('profiles').update({ last_active_course_id: ok[0] }).eq('id', auth.user.id);
        onMembershipChanged(auth.user.id);
      }
      await db.from('pending_course_enrollments').delete().eq('user_id', auth.user.id);
      return res.json({ activated: ok });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Ingelogd: zelf aansluiten bij een open cursus ("Cursus toevoegen").
  app.post('/api/courses/:courseId/join', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    try {
      const { data: course } = await db.from('courses').select('id, is_active, student_visible, enrollment_mode').eq('id', req.params.courseId).maybeSingle();
      if (!isSelfJoinable(course)) return res.status(403).json({ error: 'Deze cursus is niet open voor aanmelding', code: 'courseNotOpen' });
      if (!isAdminProfile(auth.profile) && isBlockedEmail(auth.user.email)) {
        return res.status(403).json({ error: MESSAGES.vuEmail, code: 'vuEmail' });
      }
      const { error } = await db.from('course_members').upsert(
        { course_id: course.id, user_id: auth.user.id, member_role: 'student', role: 'student' },
        { onConflict: 'course_id,user_id', ignoreDuplicates: true },
      );
      if (error) return res.status(500).json({ error: error.message });
      onMembershipChanged(auth.user.id);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Ingelogd: zelf uitschrijven uit een open cursus (alleen als student; je werk blijft bewaard).
  app.delete('/api/courses/:courseId/membership', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    try {
      const { data: course } = await db.from('courses').select('id, enrollment_mode').eq('id', req.params.courseId).maybeSingle();
      if (!course || !allowsOpenRegistration(course.enrollment_mode)) return res.status(403).json({ error: 'Uitschrijven kan alleen bij een open cursus', code: 'notOpen' });
      const { data: m } = await db.from('course_members').select('member_role').eq('course_id', course.id).eq('user_id', auth.user.id).maybeSingle();
      if (!m) return res.json({ ok: true });
      if (m.member_role !== 'student') return res.status(403).json({ error: 'Een docent kan zich niet zelf uitschrijven', code: 'teacher' });
      const { error } = await db.from('course_members').delete().eq('course_id', course.id).eq('user_id', auth.user.id);
      if (error) return res.status(500).json({ error: error.message });
      onMembershipChanged(auth.user.id);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  // Alleen beheerder: de toegangsroute van een cursus instellen.
  app.put('/api/admin/courses/:courseId/enrollment-mode', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    if (!isAdminProfile(auth.profile)) return res.status(403).json({ error: 'Alleen een beheerder kan de toegangsroute instellen', code: 'adminOnly' });
    const mode = req.body?.mode;
    if (!isEnrollmentMode(mode)) return res.status(400).json({ error: 'Onbekende toegangsroute', code: 'invalidMode' });
    if (mode === 'canvas_open' && req.body?.confirmBoth !== true) {
      return res.status(400).json({ error: 'Bevestig dat deze cursus zowel via Canvas als via open registratie te bereiken is', code: 'confirmBoth' });
    }
    try {
      const { data: before } = await db.from('courses').select('id, enrollment_mode').eq('id', req.params.courseId).maybeSingle();
      if (!before) return res.status(404).json({ error: 'Cursus niet gevonden' });
      const { error } = await db.from('courses').update({ enrollment_mode: mode }).eq('id', before.id);
      if (error) return res.status(500).json({ error: error.message });
      await db.from('leap_setting_changes').insert({ course_id: before.id, setting: 'enrollment_mode', value: { from: before.enrollment_mode, to: mode }, changed_by: auth.user.id });
      return res.json({ ok: true, mode });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });
}
