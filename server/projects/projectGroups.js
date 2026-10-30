// Groepsindeling per project (2026-10-27, migratie 20261027160000_project_group_modes).
//
//   group_mode 'self'    studenten vormen zelf groepen (uitnodigingscode)
//   group_mode 'teacher' de docent deelt in (open cursussen)
//   group_mode 'canvas'  de groepen komen uit Canvas: opent een student het project
//                        via een Canvas-groepsopdracht, dan komt hij in de LEAP-groep
//                        die bij zijn Canvas-groep hoort (lti.js → placeInCanvasGroup)
//
// Bij 'teacher' en 'canvas' kan een student geen groep maken, verlaten of
// wisselen: een bestaande indeling doorbreekt hij niet op eigen houtje. De docent
// van de cursus (en de beheerder) kan altijd indelen en verplaatsen; een
// verplaatsing door de docent gaat voor (Canvas zet een student die al in een
// groep zit niet terug). Privacy: de docent ziet alleen wie in welke groep zit.

export const GROUP_MODES = ['self', 'teacher', 'canvas'];
const CANVAS_ENROLLMENT = ['canvas', 'canvas_open'];
const MAX_NAME = 80;

export function normalizeGroupMode(v) {
  return GROUP_MODES.includes(v) ? v : 'self';
}

/** Standaard voor een nieuw project: Canvas-cursus → via Canvas, anders deelt de docent in. */
export function defaultGroupMode(enrollmentMode) {
  return CANVAS_ENROLLMENT.includes(enrollmentMode) ? 'canvas' : 'teacher';
}

/** Mag een student zelf een groep maken, aansluiten of opnieuw beginnen? */
export function studentMayFormGroups(project) {
  if (project?.group_mode) return project.group_mode === 'self';
  return project?.allow_self_signup !== false;
}

export const canvasGroupRef = (issuer, groupId) => `canvas:${issuer}:${groupId}`;

export const cleanGroupName = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

/** Verdeel studenten over groepen van ongeveer `size` (zo gelijk mogelijk). Pure. */
export function splitIntoGroups(userIds, size) {
  const n = Math.max(1, Math.floor(Number(size) || 4));
  const list = [...new Set(userIds)];
  if (!list.length) return [];
  const groups = Math.max(1, Math.round(list.length / n));
  const out = Array.from({ length: groups }, () => []);
  list.forEach((id, i) => out[i % groups].push(id));
  return out;
}

// ── Database ───────────────────────────────────────────────────────────────

async function activeGroupOf(db, projectId, userId) {
  const { data } = await db.from('project_group_members')
    .select('group_id, project_groups!inner(id, project_id, status)')
    .eq('user_id', userId).eq('project_groups.project_id', projectId).eq('project_groups.status', 'active');
  return (data || [])[0]?.group_id || null;
}

async function addMember(db, { projectId, groupId, userId, by = null }) {
  const { error } = await db.from('project_group_members')
    .upsert({ group_id: groupId, user_id: userId, role: 'member', added_by: by }, { onConflict: 'group_id,user_id' });
  if (error) throw error;
  // Zelfde sessie-record als bij zelf aansluiten (overzicht "Ga verder").
  await db.from('student_project_sessions').upsert({
    student_id: userId, project_id: projectId, group_id: groupId, status: 'in_progress', started_at: new Date().toISOString(),
  }, { onConflict: 'project_id,student_id' });
}

/** Docent deelt in of verplaatst: weg uit andere actieve groepen van dit project, erin bij groupId (null = uit de groep). */
export async function assignStudent(db, { projectId, groupId, userId, by }) {
  const { data: current } = await db.from('project_group_members')
    .select('id, group_id, project_groups!inner(project_id, status)')
    .eq('user_id', userId).eq('project_groups.project_id', projectId).eq('project_groups.status', 'active');
  const toRemove = (current || []).filter((m) => m.group_id !== groupId).map((m) => m.id);
  if (toRemove.length) await db.from('project_group_members').delete().in('id', toRemove);
  if (groupId && !(current || []).some((m) => m.group_id === groupId)) await addMember(db, { projectId, groupId, userId, by });
}

/**
 * Canvas: zet een student in de LEAP-groep van zijn Canvas-groep (maakt die zo nodig
 * aan). Zit hij al in een actieve groep van dit project, dan blijft hij daar (de
 * docent kan hem verplaatst hebben). Geeft het groep-id terug.
 */
export async function placeInCanvasGroup(db, { projectId, userId, ref, name, genInviteCode }) {
  const existing = await activeGroupOf(db, projectId, userId);
  if (existing) return existing;
  let { data: group } = await db.from('project_groups').select('id, status')
    .eq('project_id', projectId).eq('external_ref', ref).maybeSingle();
  if (!group) {
    const ins = await db.from('project_groups').insert({
      project_id: projectId, name: cleanGroupName(name) || 'Groep', invite_code: genInviteCode(),
      source: 'canvas', external_ref: ref, external_name: cleanGroupName(name) || null,
    }).select('id, status').single();
    if (ins.error) {
      // Tegelijk door een groepsgenoot aangemaakt: lees de winnaar.
      ({ data: group } = await db.from('project_groups').select('id, status').eq('project_id', projectId).eq('external_ref', ref).maybeSingle());
      if (!group) throw ins.error;
    } else {
      group = ins.data;
    }
  }
  if (group.status !== 'active') return group.id; // afgerond: alleen terugkijken
  await addMember(db, { projectId, groupId: group.id, userId });
  return group.id;
}

/**
 * Beheerroutes voor de docent. deps: supabaseAdmin, authUser(req), loadProfile(userId),
 * requireProjectStaff(projectId, user, profile), genInviteCode().
 */
export function registerProjectGroupRoutes(app, deps) {
  const db = deps.supabaseAdmin;

  async function staff(req, res) {
    if (!db) { res.status(503).json({ error: 'Admin client niet beschikbaar' }); return null; }
    const auth = await deps.authUser(req);
    if (auth.error) { res.status(auth.error.status).json(auth.error.body); return null; }
    const profile = await deps.loadProfile(auth.user.id);
    const access = await deps.requireProjectStaff(req.params.projectId, auth.user, profile);
    if (!access.ok) { res.status(access.status).json({ error: access.error }); return null; }
    return { user: auth.user, project: access.project };
  }

  // GET …/group-admin — groepen met leden en de studenten van de cursus die nog in geen groep zitten.
  app.get('/api/projects/:projectId/group-admin', async (req, res) => {
    const s = await staff(req, res);
    if (!s) return;
    try {
      const projectId = req.params.projectId;
      const [{ data: proj }, { data: groups }, { data: courseMembers }] = await Promise.all([
        db.from('projects').select('group_mode, allow_self_signup').eq('id', projectId).maybeSingle(),
        db.from('project_groups').select('id, name, status, source, external_name, created_at').eq('project_id', projectId).order('created_at'),
        s.project.course_id
          ? db.from('course_members').select('user_id').eq('course_id', s.project.course_id).eq('member_role', 'student')
          : Promise.resolve({ data: [] }),
      ]);
      const groupIds = (groups || []).map((g) => g.id);
      const { data: members } = groupIds.length
        ? await db.from('project_group_members').select('group_id, user_id').in('group_id', groupIds)
        : { data: [] };
      const userIds = [...new Set([...(members || []).map((m) => m.user_id), ...(courseMembers || []).map((m) => m.user_id)])];
      const { data: profs } = userIds.length
        ? await db.from('profiles').select('id, full_name, email').in('id', userIds)
        : { data: [] };
      const person = (id) => {
        const p = (profs || []).find((x) => x.id === id);
        return { userId: id, name: p?.full_name || null, email: p?.email || null };
      };
      const activeIds = new Set((groups || []).filter((g) => g.status === 'active').map((g) => g.id));
      const placed = new Set((members || []).filter((m) => activeIds.has(m.group_id)).map((m) => m.user_id));
      const byName = (a, b) => String(a.name || a.email || '').localeCompare(String(b.name || b.email || ''));
      return res.json({
        groupMode: proj?.group_mode || (proj?.allow_self_signup === false ? 'teacher' : 'self'),
        groups: (groups || []).map((g) => ({
          ...g,
          members: (members || []).filter((m) => m.group_id === g.id).map((m) => person(m.user_id)).sort(byName),
        })),
        unassigned: (courseMembers || []).map((m) => m.user_id).filter((id) => !placed.has(id)).map(person).sort(byName),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST …/group-admin/groups — { name } nieuwe groep (docent).
  app.post('/api/projects/:projectId/group-admin/groups', async (req, res) => {
    const s = await staff(req, res);
    if (!s) return;
    const { data, error } = await db.from('project_groups').insert({
      project_id: req.params.projectId, name: cleanGroupName(req.body?.name) || 'Groep',
      invite_code: deps.genInviteCode(), source: 'teacher', created_by: s.user.id,
    }).select('id, name, status, source').single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ group: data });
  });

  // POST …/group-admin/auto — { size } verdeel de studenten die nog nergens zitten over nieuwe groepen.
  app.post('/api/projects/:projectId/group-admin/auto', async (req, res) => {
    const s = await staff(req, res);
    if (!s) return;
    try {
      const unassigned = Array.isArray(req.body?.userIds) ? req.body.userIds.filter((x) => typeof x === 'string') : [];
      const parts = splitIntoGroups(unassigned, req.body?.size);
      const { count } = await db.from('project_groups').select('id', { count: 'exact', head: true }).eq('project_id', req.params.projectId);
      let made = 0;
      for (const [i, ids] of parts.entries()) {
        const { data: g, error } = await db.from('project_groups').insert({
          project_id: req.params.projectId, name: `Groep ${(count || 0) + i + 1}`,
          invite_code: deps.genInviteCode(), source: 'teacher', created_by: s.user.id,
        }).select('id').single();
        if (error) return res.status(500).json({ error: error.message });
        for (const uid of ids) await assignStudent(db, { projectId: req.params.projectId, groupId: g.id, userId: uid, by: s.user.id });
        made += 1;
      }
      return res.json({ groups: made });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // PATCH …/group-admin/groups/:groupId — { name }
  app.patch('/api/projects/:projectId/group-admin/groups/:groupId', async (req, res) => {
    const s = await staff(req, res);
    if (!s) return;
    const name = cleanGroupName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Geef de groep een naam' });
    const { error } = await db.from('project_groups').update({ name })
      .eq('id', req.params.groupId).eq('project_id', req.params.projectId);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  });

  // DELETE …/group-admin/groups/:groupId — alleen een lege groep (werk van studenten verdwijnt nooit stil).
  app.delete('/api/projects/:projectId/group-admin/groups/:groupId', async (req, res) => {
    const s = await staff(req, res);
    if (!s) return;
    const { count } = await db.from('project_group_members').select('id', { count: 'exact', head: true }).eq('group_id', req.params.groupId);
    if ((count || 0) > 0) return res.status(409).json({ error: 'Haal eerst alle studenten uit deze groep', code: 'groupNotEmpty' });
    const { error } = await db.from('project_groups').delete().eq('id', req.params.groupId).eq('project_id', req.params.projectId);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  });

  // PUT …/group-admin/members/:userId — { groupId | null } indelen, verplaatsen of uit de groep halen.
  app.put('/api/projects/:projectId/group-admin/members/:userId', async (req, res) => {
    const s = await staff(req, res);
    if (!s) return;
    try {
      const groupId = req.body?.groupId || null;
      if (groupId) {
        const { data: g } = await db.from('project_groups').select('id, status').eq('id', groupId).eq('project_id', req.params.projectId).maybeSingle();
        if (!g) return res.status(404).json({ error: 'Groep niet gevonden' });
        if (g.status !== 'active') return res.status(400).json({ error: 'Deze groep is afgerond' });
      }
      // Alleen studenten van de cursus van dit project. Een docent in een groep
      // zetten zou hem toegang geven tot de chats en bestanden van die groep
      // (privacybesluit 2026-10-08: groepsinhoud alleen voor leden en LEAP-admins).
      const { data: cm } = await db.from('course_members').select('user_id, member_role')
        .eq('course_id', s.project.course_id).eq('user_id', req.params.userId).maybeSingle();
      if (!cm) return res.status(400).json({ error: 'Deze persoon zit niet in de cursus' });
      if (groupId && cm.member_role && cm.member_role !== 'student') return res.status(403).json({ error: 'Geen toegang tot deze groep' });
      await assignStudent(db, { projectId: req.params.projectId, groupId, userId: req.params.userId, by: s.user.id });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}
