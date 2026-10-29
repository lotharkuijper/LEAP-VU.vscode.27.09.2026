// Systeemberichten van de beheerder (2026-10-16, migratie 20261016120000).
//
// De beheerder stuurt een bericht ("LEAP heeft een nieuwe functie: …", "LEAP is
// van 11:00 tot 13:00 niet bereikbaar") naar:
//   all       — iedereen
//   students  — alle gebruikers met profielrol student
//   teachers  — alle gebruikers met profielrol docent
//   course    — leden van één cursus: alleen studenten (course_role 'students')
//               of iedereen in die cursus ('all')
// Het bericht staat op het Dashboard tot de gebruiker het wegklikt of tot de
// einddatum; bij "Dashboard" in het menu staat dan een rood uitroepteken.
// Eenrichtingsverkeer. Per persoon wordt alleen bewaard DAT hij een bericht
// wegklikte; de beheerder ziet daarvan alleen het totaal.
//
// Pure helpers + registerSystemMessageRoutes(app, deps) (één aanroep in
// server/index.js).

export const AUDIENCES = Object.freeze(['all', 'students', 'teachers', 'course']);
export const KINDS = Object.freeze(['info', 'warning']);
export const COURSE_ROLES = Object.freeze(['students', 'all']);
export const TITLE_MAX = 120;
export const BODY_MAX = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(error) {
  return { ok: false, status: 400, body: { error } };
}

function parseDate(v) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Controleert een nieuw bericht van de beheerder. Retour { ok, value } of { ok: false, status, body }. */
export function parseMessageInput(body, now = new Date()) {
  const b = body && typeof body === 'object' ? body : {};
  const title = String(b.title ?? '').trim();
  const text = String(b.body ?? '').replace(/\r\n?/g, '\n').trim();
  if (!title) return fail('Geef het bericht een titel');
  if (title.length > TITLE_MAX) return fail(`De titel is te lang (hoogstens ${TITLE_MAX} tekens)`);
  if (text.length > BODY_MAX) return fail(`Het bericht is te lang (hoogstens ${BODY_MAX} tekens)`);
  const kind = b.kind ?? 'info';
  if (!KINDS.includes(kind)) return fail('Onbekende soort bericht');
  const audience = b.audience;
  if (!AUDIENCES.includes(audience)) return fail('Kies voor wie het bericht is');
  let courseId = null;
  let courseRole = null;
  if (audience === 'course') {
    if (!UUID_RE.test(String(b.courseId || ''))) return fail('Kies een cursus');
    courseId = b.courseId;
    courseRole = COURSE_ROLES.includes(b.courseRole) ? b.courseRole : 'students';
  }
  const startsAt = parseDate(b.startsAt);
  const endsAt = parseDate(b.endsAt);
  if (startsAt === undefined || endsAt === undefined) return fail('Ongeldige datum of tijd');
  const start = startsAt || now;
  if (endsAt && endsAt <= start) return fail('Het einde moet na het begin liggen');
  return {
    ok: true,
    value: {
      title, body: text, kind, audience, course_id: courseId, course_role: courseRole,
      starts_at: start.toISOString(), ends_at: endsAt ? endsAt.toISOString() : null,
    },
  };
}

/** Is het bericht nu zichtbaar (begonnen en nog niet afgelopen)? */
export function isActive(msg, now = new Date()) {
  const t = now.getTime();
  if (msg?.starts_at && new Date(msg.starts_at).getTime() > t) return false;
  if (msg?.ends_at && new Date(msg.ends_at).getTime() <= t) return false;
  return true;
}

/**
 * Wijziging om een bericht nu te beëindigen. Een gepland bericht (nog niet
 * begonnen) krijgt begin en einde allebei in het verleden, zodat het nooit
 * meer verschijnt (de database eist einde > begin).
 */
export function endUpdate(msg, now = new Date()) {
  const t = now.getTime();
  if (msg?.starts_at && new Date(msg.starts_at).getTime() >= t) {
    return { starts_at: new Date(t - 1000).toISOString(), ends_at: now.toISOString() };
  }
  return { ends_at: now.toISOString() };
}

/** Status voor het beheer: gepland, actief of afgelopen. */
export function statusOf(msg, now = new Date()) {
  if (msg?.starts_at && new Date(msg.starts_at).getTime() > now.getTime()) return 'scheduled';
  return isActive(msg, now) ? 'active' : 'ended';
}

/**
 * Is deze gebruiker ontvanger? role = profiles.role; memberships =
 * [{ course_id, member_role }] van deze gebruiker.
 */
export function isRecipient(msg, { role, memberships = [] }) {
  switch (msg?.audience) {
    case 'all': return true;
    case 'students': return role === 'student';
    case 'teachers': return role === 'docent';
    case 'course': {
      const m = memberships.find((x) => x.course_id === msg.course_id);
      if (!m) return false;
      return msg.course_role === 'all' || m.member_role === 'student';
    }
    default: return false;
  }
}

/** Berichten voor deze gebruiker: actief, voor hem bedoeld, niet weggeklikt; nieuwste eerst. */
export function messagesForUser(messages, { role, memberships, dismissedIds = [] }, now = new Date()) {
  const dismissed = new Set(dismissedIds);
  return (messages || [])
    .filter((m) => isActive(m, now) && !dismissed.has(m.id) && isRecipient(m, { role, memberships }))
    .sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)))
    .map((m) => ({ id: m.id, title: m.title, body: m.body, kind: m.kind, starts_at: m.starts_at, ends_at: m.ends_at }));
}

// ── Routes ───────────────────────────────────────────────────────────────────
/**
 * GET    /api/messages                    berichten voor de ingelogde gebruiker
 * POST   /api/messages/:id/dismiss        wegklikken
 * GET    /api/admin/messages              alle berichten + aantallen (beheerder)
 * POST   /api/admin/messages              nieuw bericht (beheerder)
 * POST   /api/admin/messages/:id/end      nu beëindigen (beheerder)
 * DELETE /api/admin/messages/:id          verwijderen (beheerder)
 */
export function registerSystemMessageRoutes(app, deps) {
  const { supabaseAdmin, requireAuthUser, isLeapAdmin } = deps;
  const db = () => supabaseAdmin;
  const missingTable = (err) => /system_message/.test(err?.message || '') && /(does not exist|schema cache|Could not find)/i.test(err?.message || '');

  async function adminOnly(req, res) {
    const auth = await requireAuthUser(req, res);
    if (!auth) return null;
    if (!isLeapAdmin(auth.profile)) { res.status(403).json({ error: 'Alleen de beheerder' }); return null; }
    return auth;
  }

  app.get('/api/messages', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    try {
      const now = new Date();
      const [{ data: msgs, error }, { data: dism }, { data: members }] = await Promise.all([
        db().from('system_messages').select('id, title, body, kind, audience, course_id, course_role, starts_at, ends_at')
          .lte('starts_at', now.toISOString()).or(`ends_at.is.null,ends_at.gt.${now.toISOString()}`),
        db().from('system_message_dismissals').select('message_id').eq('user_id', auth.user.id),
        db().from('course_members').select('course_id, member_role').eq('user_id', auth.user.id),
      ]);
      if (error) {
        if (missingTable(error)) return res.json({ messages: [] });
        return res.status(500).json({ error: error.message });
      }
      const messages = messagesForUser(msgs, {
        role: auth.profile?.role || 'student',
        memberships: members || [],
        dismissedIds: (dism || []).map((d) => d.message_id),
      }, now);
      return res.json({ messages });
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Berichten konden niet worden geladen' });
    }
  });

  app.post('/api/messages/:id/dismiss', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Onbekend bericht' });
    const { error } = await db().from('system_message_dismissals')
      .upsert({ message_id: req.params.id, user_id: auth.user.id }, { onConflict: 'message_id,user_id', ignoreDuplicates: true });
    if (error) return res.status(error.code === '23503' ? 404 : 500).json({ error: error.code === '23503' ? 'Onbekend bericht' : error.message });
    return res.json({ ok: true });
  });

  /** Aantal ontvangers per bericht (alleen een totaal, geen namen). */
  async function recipientCounts(msgs) {
    const out = {};
    const count = async (q) => { const { count: n } = await q; return n || 0; };
    const cache = {};
    for (const m of msgs) {
      const key = m.audience === 'course' ? `course:${m.course_id}:${m.course_role}` : m.audience;
      if (!(key in cache)) {
        if (m.audience === 'all') cache[key] = await count(db().from('profiles').select('id', { count: 'exact', head: true }));
        else if (m.audience === 'students') cache[key] = await count(db().from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'student'));
        else if (m.audience === 'teachers') cache[key] = await count(db().from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'docent'));
        else {
          let q = db().from('course_members').select('user_id', { count: 'exact', head: true }).eq('course_id', m.course_id);
          if (m.course_role !== 'all') q = q.eq('member_role', 'student');
          cache[key] = await count(q);
        }
      }
      out[m.id] = cache[key];
    }
    return out;
  }

  app.get('/api/admin/messages', async (req, res) => {
    if (!(await adminOnly(req, res))) return;
    try {
      const { data: msgs, error } = await db().from('system_messages')
        .select('id, title, body, kind, audience, course_id, course_role, starts_at, ends_at, created_at')
        .order('created_at', { ascending: false }).limit(100);
      if (error) {
        if (missingTable(error)) return res.status(503).json({ error: 'De tabel voor systeemberichten ontbreekt — pas de migratie eerst toe.' });
        return res.status(500).json({ error: error.message });
      }
      const ids = (msgs || []).map((m) => m.id);
      const { data: dism } = ids.length
        ? await db().from('system_message_dismissals').select('message_id').in('message_id', ids)
        : { data: [] };
      const dismissedCount = {};
      for (const d of dism || []) dismissedCount[d.message_id] = (dismissedCount[d.message_id] || 0) + 1;
      const recipients = await recipientCounts(msgs || []);
      const courseIds = [...new Set((msgs || []).map((m) => m.course_id).filter(Boolean))];
      const { data: courses } = courseIds.length ? await db().from('courses').select('id, name').in('id', courseIds) : { data: [] };
      const courseName = new Map((courses || []).map((c) => [c.id, c.name]));
      const now = new Date();
      return res.json({
        messages: (msgs || []).map((m) => ({
          ...m,
          course_name: m.course_id ? courseName.get(m.course_id) || null : null,
          status: statusOf(m, now),
          recipients: recipients[m.id] ?? 0,
          dismissed: dismissedCount[m.id] || 0,
        })),
      });
    } catch (err) {
      return res.status(500).json({ error: err?.message || 'Berichten konden niet worden geladen' });
    }
  });

  app.post('/api/admin/messages', async (req, res) => {
    const auth = await adminOnly(req, res);
    if (!auth) return;
    const parsed = parseMessageInput(req.body);
    if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
    const { data, error } = await db().from('system_messages')
      .insert({ ...parsed.value, created_by: auth.user.id }).select('id').single();
    if (error) return res.status(500).json({ error: error.message });
    console.log(`[messages] Nieuw systeembericht ${data.id} voor ${parsed.value.audience}${parsed.value.course_id ? ` (${parsed.value.course_id})` : ''}`);
    return res.status(201).json({ id: data.id });
  });

  app.post('/api/admin/messages/:id/end', async (req, res) => {
    if (!(await adminOnly(req, res))) return;
    const { data: msg } = await db().from('system_messages').select('id, starts_at').eq('id', req.params.id).maybeSingle();
    if (!msg) return res.status(404).json({ error: 'Onbekend bericht' });
    const update = endUpdate(msg);
    const { error } = await db().from('system_messages').update(update).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  });

  app.delete('/api/admin/messages/:id', async (req, res) => {
    if (!(await adminOnly(req, res))) return;
    const { error } = await db().from('system_messages').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  });
}
