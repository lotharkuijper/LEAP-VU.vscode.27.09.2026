// Edities van een cursus (2026-10-29). Migratie 20261029100000_course_editions.
//
// Een LEAP-cursus kan meerdere jaargangen dienen (bijvoorbeeld twee
// Canvas-cursussen van opeenvolgende jaren). "Nieuwe editie starten" (docent
// van de cursus of beheerder) begint schoon, zonder iets weg te gooien:
//   - studenten van de vorige editie worden oud-deelnemer (course_alumni):
//     ze kunnen lezen en blijven oefenen (chat, Ik leg uit, quiz), maar staan
//     niet meer in ledenlijsten, groepsindelingen, aankondigingen en analytics,
//     en kunnen in het Studiecafé niet meer schrijven;
//   - docenten en assistenten die de docent niet aanvinkt, worden ook
//     oud-deelnemer;
//   - lopende projecten worden gearchiveerd; actieve groepen worden afgerond
//     (blijven voor de leden alleen-lezen bereikbaar);
//   - Studiecafé-vragen gaan naar het archief (gesloten, apart te bekijken);
//   - Canvas-cursussen van de vorige editie worden "oud": een klik daarvandaan
//     maakt niemand (weer) actief lid of docent.
// Wat van de student zelf is (leerdagboek, uitleg, quizpogingen) blijft altijd.
// Wie opnieuw lid wordt (Canvas, uitnodiging, zelf aansluiten), is vanzelf geen
// oud-deelnemer meer (trigger in de migratie).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is deze gebruiker oud-deelnemer (en geen lid) van de cursus? */
export async function isCourseAlumnus(db, userId, courseId) {
  if (!userId || !courseId) return false;
  try {
    const { data } = await db.from('course_alumni').select('user_id').eq('course_id', courseId).eq('user_id', userId).maybeSingle();
    return !!data;
  } catch { return false; }
}

/** Begin van de huidige editie (of null als er nooit een nieuwe editie is gestart). */
export async function currentEditionStart(db, courseId) {
  try {
    const { data } = await db.from('course_editions').select('started_at').eq('course_id', courseId)
      .order('started_at', { ascending: false }).limit(1);
    return data?.[0]?.started_at || null;
  } catch { return null; }
}

/**
 * Pure: wie wordt oud-deelnemer? Studenten altijd; docenten tenzij aangevinkt.
 * Wie de editie start, blijft altijd docent.
 */
export function planAlumni(members, { keepTeacherIds = [], actorId = null } = {}) {
  const keep = new Set([...(keepTeacherIds || []), actorId].filter(Boolean));
  const leave = [];
  const stay = [];
  for (const m of members || []) {
    const role = m.member_role === 'teacher' ? 'teacher' : 'student';
    if (role === 'teacher' && keep.has(m.user_id)) stay.push(m);
    else leave.push({ user_id: m.user_id, former_role: role });
  }
  return { leave, stay };
}

/** Wat er gebeurt als nu een nieuwe editie start (voor het bevestigingsvenster). */
export async function previewEdition(db, courseId) {
  const [{ data: members }, { data: projects }, threads, { data: links }, { data: editions }, { count: alumni }] = await Promise.all([
    db.from('course_members').select('user_id, member_role').eq('course_id', courseId),
    db.from('projects').select('id').eq('course_id', courseId).eq('status', 'active'),
    db.from('studiecafe_threads').select('id', { count: 'exact', head: true }).eq('course_id', courseId).is('archived_at', null).is('deleted_at', null),
    db.from('lti_course_links').select('context_title, last_seen').eq('course_id', courseId).is('retired_at', null),
    db.from('course_editions').select('id, label, started_at').eq('course_id', courseId).order('started_at', { ascending: false }),
    db.from('course_alumni').select('user_id', { count: 'exact', head: true }).eq('course_id', courseId),
  ]);
  const teacherIds = (members || []).filter(m => m.member_role === 'teacher').map(m => m.user_id);
  const { data: profiles } = teacherIds.length
    ? await db.from('profiles').select('id, full_name, email').in('id', teacherIds)
    : { data: [] };
  const byId = new Map((profiles || []).map(p => [p.id, p]));
  const projectIds = (projects || []).map(p => p.id);
  const { count: groups } = projectIds.length
    ? await db.from('project_groups').select('id', { count: 'exact', head: true }).in('project_id', projectIds).eq('status', 'active')
    : { count: 0 };
  return {
    students: (members || []).filter(m => m.member_role !== 'teacher').length,
    teachers: teacherIds.map(id => ({ id, name: byId.get(id)?.full_name || null, email: byId.get(id)?.email || null })),
    projects: projectIds.length,
    groups: groups || 0,
    threads: threads?.count || 0,
    canvasCourses: (links || []).map(l => l.context_title).filter(Boolean),
    editions: editions || [],
    alumni: alumni || 0,
  };
}

/** Start een nieuwe editie. Volgorde zo gekozen dat een herhaling na een fout niets dubbel doet. */
export async function startEdition(db, { courseId, label, keepTeacherIds, actorId, now = new Date() }) {
  const stamp = now.toISOString();
  const { data: edition, error: edErr } = await db.from('course_editions')
    .insert({ course_id: courseId, label: String(label || '').trim().slice(0, 120) || null, started_at: stamp, started_by: actorId })
    .select('id').single();
  if (edErr || !edition) throw new Error(edErr?.message || 'Editie niet aangemaakt');

  const { data: members } = await db.from('course_members').select('user_id, member_role').eq('course_id', courseId);
  const { leave } = planAlumni(members, { keepTeacherIds, actorId });
  if (leave.length) {
    const { error } = await db.from('course_alumni').upsert(
      leave.map(l => ({ course_id: courseId, user_id: l.user_id, former_role: l.former_role, edition_id: edition.id, since: stamp })),
      { onConflict: 'course_id,user_id' },
    );
    if (error) throw new Error(error.message);
    const ids = leave.map(l => l.user_id);
    for (let i = 0; i < ids.length; i += 200) {
      const { error: delErr } = await db.from('course_members').delete().eq('course_id', courseId).in('user_id', ids.slice(i, i + 200));
      if (delErr) throw new Error(delErr.message);
    }
  }

  const { data: projects } = await db.from('projects').select('id').eq('course_id', courseId).eq('status', 'active');
  const projectIds = (projects || []).map(p => p.id);
  let groups = 0;
  if (projectIds.length) {
    const { data: g } = await db.from('project_groups').update({ status: 'finalized', finalized_at: stamp })
      .in('project_id', projectIds).eq('status', 'active').select('id');
    groups = (g || []).length;
    await db.from('projects').update({ status: 'archived' }).in('id', projectIds);
  }

  const { data: threads } = await db.from('studiecafe_threads')
    .update({ archived_at: stamp, is_locked: true, is_pinned: false })
    .eq('course_id', courseId).is('archived_at', null).select('id');
  await db.from('lti_course_links').update({ retired_at: stamp }).eq('course_id', courseId).is('retired_at', null);

  const summary = {
    alumniStudents: leave.filter(l => l.former_role === 'student').length,
    alumniTeachers: leave.filter(l => l.former_role === 'teacher').length,
    projects: projectIds.length, groups, threads: (threads || []).length,
  };
  await db.from('course_editions').update({ summary }).eq('id', edition.id);
  return { editionId: edition.id, summary };
}

/**
 * Routes. deps: supabaseAdmin, requireAuthUser, isStaffForCourse.
 *   GET  /api/courses/:courseId/editions           voorvertoning + eerdere edities + oud-deelnemers
 *   POST /api/courses/:courseId/editions           { label, keepTeacherIds, confirm: true }
 *   POST /api/courses/:courseId/alumni/:userId/reactivate   oud-deelnemer weer lid maken
 */
export function registerCourseEditionRoutes(app, deps) {
  const db = () => deps.supabaseAdmin;
  const staff = async (req, res) => {
    const auth = await deps.requireAuthUser(req, res);
    if (!auth) return null;
    const { courseId } = req.params;
    if (!UUID.test(String(courseId))) { res.status(400).json({ error: 'Ongeldige cursus' }); return null; }
    if (!(await deps.isStaffForCourse(auth.user, auth.profile, courseId))) { res.status(403).json({ error: 'Onvoldoende rechten' }); return null; }
    return auth;
  };

  app.get('/api/courses/:courseId/editions', async (req, res) => {
    if (!(await staff(req, res))) return;
    try {
      const preview = await previewEdition(db(), req.params.courseId);
      const { data: alumniRows } = await db().from('course_alumni').select('user_id, former_role, since')
        .eq('course_id', req.params.courseId).order('since', { ascending: false }).limit(500);
      const ids = (alumniRows || []).map(a => a.user_id);
      const { data: profiles } = ids.length ? await db().from('profiles').select('id, full_name, email').in('id', ids) : { data: [] };
      const byId = new Map((profiles || []).map(p => [p.id, p]));
      const alumni = (alumniRows || []).map(a => ({
        userId: a.user_id, formerRole: a.former_role, since: a.since,
        name: byId.get(a.user_id)?.full_name || null, email: byId.get(a.user_id)?.email || null,
      }));
      return res.json({ ...preview, alumniList: alumni });
    } catch (e) {
      return res.status(500).json({ error: e?.message || 'Fout' });
    }
  });

  app.post('/api/courses/:courseId/editions', async (req, res) => {
    const auth = await staff(req, res);
    if (!auth) return;
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Bevestig het starten van een nieuwe editie', code: 'confirmEdition' });
    const keep = Array.isArray(req.body?.keepTeacherIds) ? req.body.keepTeacherIds.filter(id => UUID.test(String(id))) : [];
    try {
      const r = await startEdition(db(), { courseId: req.params.courseId, label: req.body?.label, keepTeacherIds: keep, actorId: auth.user.id });
      try {
        await db().from('leap_setting_changes').insert({
          course_id: req.params.courseId, setting: 'course_edition', value: { editionId: r.editionId, label: req.body?.label || null, ...r.summary }, changed_by: auth.user.id,
        });
      } catch { /* logboek is aanvullend */ }
      console.log(`[editions] nieuwe editie voor cursus ${req.params.courseId}: ${JSON.stringify(r.summary)}`);
      return res.json(r);
    } catch (e) {
      console.warn('[editions] starten mislukt:', e?.message || e);
      return res.status(500).json({ error: 'Het starten van de nieuwe editie lukte niet helemaal. Probeer het opnieuw; wat al gedaan is, wordt niet dubbel gedaan.' });
    }
  });

  app.post('/api/courses/:courseId/alumni/:userId/reactivate', async (req, res) => {
    if (!(await staff(req, res))) return;
    const { courseId, userId } = req.params;
    if (!UUID.test(String(userId))) return res.status(400).json({ error: 'Ongeldige gebruiker' });
    const { data: row } = await db().from('course_alumni').select('former_role').eq('course_id', courseId).eq('user_id', userId).maybeSingle();
    if (!row) return res.status(404).json({ error: 'Niet gevonden' });
    // Altijd terug als student: docentschap geeft de docent bewust opnieuw (Beheer leden).
    const { error } = await db().from('course_members').insert({ course_id: courseId, user_id: userId, member_role: 'student', role: 'student' });
    if (error && !/duplicate/i.test(error.message)) return res.status(500).json({ error: error.message });
    await db().from('course_alumni').delete().eq('course_id', courseId).eq('user_id', userId);
    return res.json({ ok: true });
  });
}
