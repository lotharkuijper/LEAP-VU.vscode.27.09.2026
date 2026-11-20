// Toegangsaanvragen van medewerkers (2026-11-22). Een medewerker van de VU of
// Amsterdam UMC (isStaffEmail in server/courses/enrollment.js) kan een account
// aanmaken zonder cursus. Zolang die in geen cursus zit, ziet die een welkomstscherm
// met de beschikbare cursussen en kan die de beheerder een vraag stellen. De
// beheerder koppelt de medewerker in het beheer (Aanvragen) aan een cursus, als
// docent of student, en sluit de aanvraag af. Beide krijgen een e-mail.
//
// Tabel access_requests: alleen de server (RLS zonder regels). Een gebruiker ziet
// via de server alleen de eigen aanvragen; alleen een beheerder ziet ze allemaal.

import { isStaffEmail } from '../courses/enrollment.js';
import { escapeHtml } from '../lib/notifications.js';

export const ACCESS_LIMITS = { MAX_MESSAGE: 2000, MAX_COURSES: 20, MAX_OPEN: 3, PER_HOUR: 5 };
export const ROLE_WISHES = ['teacher', 'student', 'unsure'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure: telt deze ingelogde gebruiker als medewerker voor aanvragen en de cursuslijst?
 * Een adres van een medewerkersdomein, bevestigd door de gebruiker zelf. Een account
 * dat via Canvas werd aangemaakt telt niet: het adres komt dan van het Canvas-platform,
 * niet van een bevestigde mailbox.
 */
export function isConfirmedStaff(user) {
  return !!user && isStaffEmail(user.email) && !!user.email_confirmed_at && user.user_metadata?.source !== 'canvas';
}

/** Pure: controle van een aanvraag. Geeft { ok, code? , message, courseIds, role }. */
export function validateRequest(body, activeCourseIds) {
  const message = String(body?.message || '').trim().slice(0, ACCESS_LIMITS.MAX_MESSAGE);
  const active = new Set(activeCourseIds);
  const courseIds = [...new Set((Array.isArray(body?.courseIds) ? body.courseIds : []).map(String))]
    .filter((id) => UUID_RE.test(id) && active.has(id)).slice(0, ACCESS_LIMITS.MAX_COURSES);
  const role = ROLE_WISHES.includes(body?.role) ? body.role : 'unsure';
  if (!message && courseIds.length === 0) return { ok: false, code: 'emptyRequest' };
  return { ok: true, message, courseIds, role };
}

/** Eenvoudige teller per gebruiker en uur (geheugen van dit ene proces). */
function hourlyLimiter(limit) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    const list = (hits.get(key) || []).filter((t) => now - t < 3_600_000);
    if (list.length >= limit) { hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    return true;
  };
}

const ROLE_NL = { teacher: 'docent', student: 'student', unsure: 'weet nog niet' };
const ROLE_EN = { teacher: 'teacher', student: 'student', unsure: 'not sure yet' };

/** Pure: e-mail aan de beheerder(s) over een nieuwe aanvraag (Nederlands en Engels). */
export function buildAdminMail({ name, email, message, courseNames, role, url }) {
  const courses = courseNames.length ? courseNames.join(', ') : '-';
  const text = `Nieuwe toegangsaanvraag in LEAP / New access request in LEAP

${name} <${email}>
Rol / Role: ${ROLE_NL[role]} / ${ROLE_EN[role]}
Cursussen / Courses: ${courses}

${message || '-'}
${url ? `\n${url}` : ''}`;
  const html = `<p><strong>Nieuwe toegangsaanvraag in LEAP</strong> / New access request in LEAP</p>
<p>${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;<br>Rol / Role: ${ROLE_NL[role]} / ${ROLE_EN[role]}<br>Cursussen / Courses: ${escapeHtml(courses)}</p>
<p style="white-space:pre-wrap">${escapeHtml(message || '-')}</p>${url ? `
<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` : ''}`;
  return { subject: `LEAP: toegangsaanvraag van ${name}`, text, html };
}

/** Pure: e-mail aan de medewerker als die aan een cursus is gekoppeld (Nederlands en Engels). */
export function buildGrantMail({ name, courseName, role, url }) {
  const nl = `Beste ${name}, je bent in LEAP toegevoegd aan de cursus "${courseName}" als ${ROLE_NL[role]}. Log in om te beginnen.`;
  const en = `Dear ${name}, you have been added to the course "${courseName}" in LEAP as ${ROLE_EN[role]}. Log in to get started.`;
  return {
    subject: `LEAP: je bent toegevoegd aan ${courseName} / you have been added to ${courseName}`,
    text: `${nl}\n\n${en}${url ? `\n\n${url}` : ''}`,
    html: `<p>${escapeHtml(nl)}</p><p>${escapeHtml(en)}</p>${url ? `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` : ''}`,
  };
}

/**
 * Routes. deps: supabaseAdmin, requireAuthUser, isAdminProfile(profile), superuserEmail,
 * getEmailConfig(), sendEmail(cfg, mail, opts), appUrl() (publiek adres uit de instellingen, nooit uit het
 * verzoek, zodat een link in een mail niet naar een andere site kan wijzen; mag leeg zijn).
 */
export function registerAccessRequestRoutes(app, deps) {
  const { supabaseAdmin: db, requireAuthUser, isAdminProfile, superuserEmail, getEmailConfig, sendEmail, appUrl } = deps;
  const perHour = hourlyLimiter(ACCESS_LIMITS.PER_HOUR);

  async function activeCourses() {
    const { data, error } = await db.from('courses').select('id, name, description').eq('is_active', true);
    if (error) throw new Error(error.message);
    return (data || [])
      .map((c) => ({ id: c.id, name: c.name || '', description: String(c.description || '').slice(0, 200) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'nl', { sensitivity: 'base' }));
  }

  const namesOf = (courses, ids) => {
    const byId = new Map(courses.map((c) => [c.id, c.name]));
    return (ids || []).map((id) => byId.get(id)).filter(Boolean);
  };

  async function mail(to, content) {
    try {
      const cfg = await getEmailConfig();
      if (!cfg || !to.length) return;
      for (const address of to) {
        const r = await sendEmail(cfg, { to: address, ...content }, { wait: false });
        if (r && r.ok === false) console.warn('[toegangsaanvraag] mail niet verstuurd:', r.error || r.status);
      }
    } catch (err) {
      console.warn('[toegangsaanvraag] mail mislukt:', err?.message || err);
    }
  }

  async function adminEmails() {
    const { data } = await db.from('profiles').select('email').eq('role', 'admin');
    return [...new Set([...(data || []).map((p) => p.email), superuserEmail].filter(Boolean).map((e) => e.toLowerCase()))];
  }

  // Voor het welkomstscherm: ben je medewerker, in hoeveel cursussen zit je, en je eigen aanvragen.
  app.get('/api/access/me', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    try {
      const { count } = await db.from('course_members').select('course_id', { count: 'exact', head: true }).eq('user_id', auth.user.id);
      const { data: mine } = await db.from('access_requests')
        .select('id, status, wished_course_ids, granted_course_ids, created_at').eq('user_id', auth.user.id).order('created_at', { ascending: false });
      const courses = (mine || []).length ? await activeCourses() : [];
      return res.json({
        staff: isConfirmedStaff(auth.user),
        courseCount: count || 0,
        requests: (mine || []).map((r) => ({
          id: r.id, status: r.status, createdAt: r.created_at,
          wished: namesOf(courses, r.wished_course_ids), granted: namesOf(courses, r.granted_course_ids),
        })),
      });
    } catch (err) {
      console.error('[toegang] me:', err?.message || err);
      return res.status(500).json({ error: 'Er ging iets mis.' });
    }
  });

  // De beschikbare cursussen (naam en korte omschrijving), alleen voor medewerkers en beheerders.
  app.get('/api/access/catalog', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    if (!isConfirmedStaff(auth.user) && !isAdminProfile(auth.profile)) {
      return res.status(403).json({ error: 'Alleen voor medewerkers', code: 'notStaff' });
    }
    try { return res.json({ courses: await activeCourses() }); } catch (err) {
      console.error('[toegang] cursussen:', err?.message || err);
      return res.status(500).json({ error: 'Er ging iets mis.' });
    }
  });

  // Een vraag aan de beheerder (alleen medewerkers).
  app.post('/api/access/requests', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    if (!isConfirmedStaff(auth.user)) return res.status(403).json({ error: 'Alleen voor medewerkers', code: 'notStaff' });
    try {
      const courses = await activeCourses();
      const v = validateRequest(req.body, courses.map((c) => c.id));
      if (!v.ok) return res.status(400).json({ error: 'Schrijf een vraag of kies minstens één cursus.', code: v.code });
      const { count } = await db.from('access_requests').select('id', { count: 'exact', head: true }).eq('user_id', auth.user.id).eq('status', 'open');
      if ((count || 0) >= ACCESS_LIMITS.MAX_OPEN || !perHour(auth.user.id)) {
        return res.status(429).json({ error: 'Je hebt al een paar vragen openstaan. De beheerder reageert zo snel mogelijk.', code: 'tooMany' });
      }
      const { data: row, error } = await db.from('access_requests')
        .insert({ user_id: auth.user.id, message: v.message, wished_course_ids: v.courseIds, role_wish: v.role }).select('id').single();
      if (error) throw new Error(error.message);
      const { data: prof } = await db.from('profiles').select('full_name').eq('id', auth.user.id).maybeSingle();
      void mail(await adminEmails(), buildAdminMail({
        name: prof?.full_name || auth.user.email, email: auth.user.email, message: v.message,
        courseNames: namesOf(courses, v.courseIds), role: v.role, url: appUrl() ? `${appUrl()}/admin?tab=access_requests` : '',
      }));
      return res.json({ ok: true, id: row.id });
    } catch (err) {
      console.error('[toegang] aanvraag:', err?.message || err);
      return res.status(500).json({ error: 'Er ging iets mis.' });
    }
  });

  async function admin(req, res) {
    const auth = await requireAuthUser(req, res);
    if (!auth) return null;
    if (!isAdminProfile(auth.profile)) { res.status(403).json({ error: 'Alleen een beheerder', code: 'adminOnly' }); return null; }
    if (req.params.id && !UUID_RE.test(req.params.id)) { res.status(400).json({ error: 'Ongeldige aanvraag' }); return null; }
    return auth;
  }

  // Beheer: de aanvragen (standaard alleen open), met naam en e-mail en de cursussen om uit te kiezen.
  app.get('/api/admin/access-requests', async (req, res) => {
    if (!(await admin(req, res))) return;
    try {
      let q = db.from('access_requests').select('*').order('created_at', { ascending: false }).limit(200);
      if (req.query?.status !== 'all') q = q.eq('status', 'open');
      const { data: rows, error } = await q;
      if (error) throw new Error(error.message);
      const ids = [...new Set((rows || []).map((r) => r.user_id))];
      const { data: profs } = ids.length ? await db.from('profiles').select('id, full_name, email').in('id', ids) : { data: [] };
      const byId = new Map((profs || []).map((p) => [p.id, p]));
      const courses = await activeCourses();
      return res.json({
        courses,
        requests: (rows || []).map((r) => ({
          id: r.id, status: r.status, message: r.message, role: r.role_wish, createdAt: r.created_at, handledAt: r.handled_at,
          user: { id: r.user_id, name: byId.get(r.user_id)?.full_name || '', email: byId.get(r.user_id)?.email || '' },
          wished: r.wished_course_ids || [], granted: r.granted_course_ids || [],
        })),
      });
    } catch (err) {
      console.error('[toegang] lijst:', err?.message || err);
      return res.status(500).json({ error: 'Er ging iets mis.' });
    }
  });

  // Beheer: de aanvrager aan een cursus koppelen, als docent of student.
  app.post('/api/admin/access-requests/:id/grant', async (req, res) => {
    const auth = await admin(req, res);
    if (!auth) return;
    const { courseId, role } = req.body || {};
    if (!UUID_RE.test(String(courseId || '')) || !['teacher', 'student'].includes(role)) {
      return res.status(400).json({ error: 'Kies een cursus en een rol.', code: 'badGrant' });
    }
    try {
      const { data: r } = await db.from('access_requests').select('*').eq('id', req.params.id).maybeSingle();
      if (!r) return res.status(404).json({ error: 'Aanvraag niet gevonden' });
      const { data: course } = await db.from('courses').select('id, name, is_active').eq('id', courseId).maybeSingle();
      if (!course || course.is_active === false) return res.status(404).json({ error: 'Cursus niet gevonden' });
      // Was de aanvrager al lid? Dan melden we de vorige rol (zo maakt een beheerder niet per ongeluk een docent student).
      const { data: existing } = await db.from('course_members').select('member_role').eq('course_id', course.id).eq('user_id', r.user_id).maybeSingle();
      const { error: mErr } = await db.from('course_members').upsert(
        { course_id: course.id, user_id: r.user_id, member_role: role, role },
        { onConflict: 'course_id,user_id' },
      );
      if (mErr) throw new Error(mErr.message);
      const { data: prof } = await db.from('profiles').select('full_name, email, last_active_course_id').eq('id', r.user_id).maybeSingle();
      if (prof && !prof.last_active_course_id) await db.from('profiles').update({ last_active_course_id: course.id }).eq('id', r.user_id);
      const granted = [...new Set([...(r.granted_course_ids || []), course.id])];
      const { error: uErr } = await db.from('access_requests')
        .update({ granted_course_ids: granted, handled_by: auth.user.id, handled_at: new Date().toISOString() }).eq('id', r.id);
      if (uErr) throw new Error(uErr.message);
      if (prof?.email) void mail([prof.email], buildGrantMail({ name: prof.full_name || prof.email, courseName: course.name, role, url: appUrl() ? `${appUrl()}/` : '' }));
      return res.json({ ok: true, granted, previousRole: existing?.member_role || null });
    } catch (err) {
      console.error('[toegang] koppelen:', err?.message || err);
      return res.status(500).json({ error: 'Er ging iets mis.' });
    }
  });

  // Beheer: aanvraag afsluiten.
  app.post('/api/admin/access-requests/:id/close', async (req, res) => {
    const auth = await admin(req, res);
    if (!auth) return;
    try {
      const { error } = await db.from('access_requests')
        .update({ status: 'closed', handled_by: auth.user.id, handled_at: new Date().toISOString() }).eq('id', req.params.id);
      if (error) throw new Error(error.message);
      return res.json({ ok: true });
    } catch (err) {
      console.error('[toegang] afsluiten:', err?.message || err);
      return res.status(500).json({ error: 'Er ging iets mis.' });
    }
  });
}
