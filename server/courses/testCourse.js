// Testcursus (2026-11-23). De beheerder kan een cursus tot testcursus maken: om alles
// uit te proberen of een demo te geven. Alleen beheerders kunnen er lid van zijn en
// erin; de cursus staat in geen enkele lijst voor anderen (open registratie,
// "Cursus toevoegen", de cursuslijst voor medewerkers).
//
// De database bewaakt het lidmaatschap (migratie 20261123100000_course_is_test):
// een lid dat geen beheerder is, wordt geweigerd, en een cursus met zulke leden
// wordt geen testcursus. De server weigert daarnaast de toegang
// (userHasCourseAccess in server/lib/auth.js).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure: is dit de weigering van de database voor een lid van een testcursus? */
export function isTestCourseError(err) {
  return !!err && (String(err.hint || '').startsWith('leap_test_course') || /testcursus|geen beheerder zijn/i.test(String(err.message || '')));
}

/** Pure: hoeveel leden (of oud-deelnemers) zijn geen beheerder? */
export function countNonAdmins(userIds, profiles, superuserEmail) {
  const admin = new Set((profiles || [])
    .filter((p) => p.role === 'admin' || (superuserEmail && String(p.email || '').toLowerCase() === superuserEmail.toLowerCase()))
    .map((p) => p.id));
  return new Set((userIds || []).filter((id) => !admin.has(id))).size;
}

export function registerTestCourseRoutes(app, { supabaseAdmin: db, resolveAdminUser, superuserEmail }) {
  // PATCH /api/admin/courses/:id/test  { is_test: boolean } — alleen een beheerder.
  app.patch('/api/admin/courses/:id/test', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    if (!r.isAdmin) return res.status(403).json({ error: 'Alleen een beheerder', code: 'adminOnly' });
    const courseId = req.params.id;
    if (!UUID_RE.test(courseId)) return res.status(400).json({ error: 'Ongeldige cursus' });
    const on = req.body?.is_test;
    if (typeof on !== 'boolean') return res.status(400).json({ error: 'Veld "is_test" (boolean) is verplicht' });
    try {
      const { data: course } = await db.from('courses').select('id').eq('id', courseId).maybeSingle();
      if (!course) return res.status(404).json({ error: 'Cursus niet gevonden' });
      if (on) {
        // Zelfde regel als de trigger leap_test_course_switch_check (die blijft de echte
        // bewaking); hier alleen om de beheerder het aantal te kunnen noemen.
        const [{ data: members }, { data: alumni }] = await Promise.all([
          db.from('course_members').select('user_id').eq('course_id', courseId),
          db.from('course_alumni').select('user_id').eq('course_id', courseId),
        ]);
        const ids = [...(members || []), ...(alumni || [])].map((m) => m.user_id);
        const { data: profs } = ids.length ? await db.from('profiles').select('id, role, email').in('id', ids) : { data: [] };
        const count = countNonAdmins(ids, profs, superuserEmail);
        if (count > 0) {
          return res.status(409).json({ error: 'Deze cursus heeft nog leden die geen beheerder zijn. Haal ze eerst uit de cursus.', code: 'hasMembers', count });
        }
      }
      // Een testcursus is gesloten: niemand kan zich aanmelden.
      const patch = on ? { is_test: true, enrollment_mode: 'closed' } : { is_test: false };
      const { data, error } = await db.from('courses').update(patch).eq('id', courseId).select('id, is_test, enrollment_mode').maybeSingle();
      if (error) {
        if (isTestCourseError(error)) return res.status(409).json({ error: 'Deze cursus heeft nog leden die geen beheerder zijn. Haal ze eerst uit de cursus.', code: 'hasMembers' });
        if (error.code === '42703' || /is_test/.test(error.message || '')) return res.status(503).json({ error: 'De database kent nog geen testcursussen.', code: 'notMigrated' });
        throw new Error(error.message);
      }
      console.log(`[cursussen] ${courseId} testcursus → ${on} (door ${r.user.id})`);
      return res.json({ ok: true, course: data });
    } catch (err) {
      console.error('[cursussen] testcursus:', err?.message || err);
      return res.status(500).json({ error: 'Er ging iets mis.' });
    }
  });
}
