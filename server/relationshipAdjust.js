// ───────────────────────────────────────────────────────────────────────────
// Correctie door de docent op de verstandhouding van een rolspeler met een groep.
//
// `POST /api/projects/:projectId/groups/:groupId/personas/:personaId/relationship-adjust`
// { level: -3..2, note } — de docent kiest het niveau (−3 = contact verbroken,
// −2 koud … +2 warm) en legt kort uit waarom. Dit is ook de enige manier om
// een verbroken contact te herstellen. Alleen docenten van de cursus, en alleen
// bij een persona die een verstandhouding bijhoudt.
// Afhankelijkheden komen via `deps` binnen zodat de autorisatie en de wiring
// geautomatiseerd getest kunnen worden (server/__tests__/staffAdjust.integration.test.js).
// ───────────────────────────────────────────────────────────────────────────

export function registerRelationshipAdjustRoute(app, deps) {
  const {
    supabaseAdmin,
    authUser,
    isStaffForCourse,
    setRelationshipLevel,
    levelKey,
    reputationActive,
  } = deps;

  app.post('/api/projects/:projectId/groups/:groupId/personas/:personaId/relationship-adjust', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, groupId, personaId } = req.params;
    const { level, note } = req.body || {};
    const levelNum = Math.round(Number(level));
    if (!Number.isFinite(levelNum) || levelNum < -3 || levelNum > 2) {
      return res.status(400).json({ error: 'level moet een geheel getal tussen -3 en 2 zijn' });
    }
    const noteStr = typeof note === 'string' ? note.trim() : '';
    if (noteStr.length === 0) {
      return res.status(400).json({ error: 'note (korte motivatie) is verplicht' });
    }
    try {
      const { data: project } = await supabaseAdmin
        .from('projects').select('id, course_id').eq('id', projectId).maybeSingle();
      if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
      const { data: profile } = await supabaseAdmin
        .from('profiles').select('role, email').eq('id', auth.user.id).maybeSingle();
      const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
      if (!isStaff) return res.status(403).json({ error: 'Alleen staff van deze cursus mag de relatie aanpassen' });

      const { data: groupCheck } = await supabaseAdmin
        .from('project_groups').select('id, project_id').eq('id', groupId).maybeSingle();
      if (!groupCheck || groupCheck.project_id !== projectId) {
        return res.status(404).json({ error: 'Groep niet gevonden in dit project' });
      }
      const { data: persona } = await supabaseAdmin
        .from('project_personas').select('id, project_id, persona_type, reputation_enabled, start_level').eq('id', personaId).maybeSingle();
      if (!persona || persona.project_id !== projectId) {
        return res.status(404).json({ error: 'Persona niet gevonden in dit project' });
      }
      if (!reputationActive(persona)) {
        return res.status(400).json({ error: 'Deze persona houdt geen verstandhouding bij' });
      }

      const updated = await setRelationshipLevel({
        projectId, groupId, personaId,
        startLevel: persona.start_level,
        compute: () => levelNum,
        event: { source: 'staff_adjust', refId: `staff_adjust:${auth.user.id}:${Date.now()}`, by: auth.user.id, note: noteStr },
      });
      if (!updated) {
        return res.status(503).json({
          error: 'Migratie 20260529100000_project_persona_relationships.sql is nog niet toegepast in Supabase.',
        });
      }
      return res.json({
        relationship: {
          level: updated.score,
          key: levelKey(updated.score),
          history: updated.history,
          updated_at: updated.updated_at,
        },
      });
    } catch (err) {
      console.error('[relationship-adjust]', err);
      return res.status(500).json({ error: err.message });
    }
  });
}
