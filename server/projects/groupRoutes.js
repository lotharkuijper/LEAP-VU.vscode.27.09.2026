import { randomInt } from 'node:crypto';
import { canAccessCourseContent } from '../courses/courseAvailability.js';
import {
  authUser,
  isLeapAdmin,
  isStaffForCourse,
  loadProfileRoleEmail,
  profileCache,
  userHasCourseAccess,
  userIsActiveCourseMember,
} from '../lib/auth.js';
import { courseFeatureOnFor, rejectIfFeatureOff } from '../lib/courseFeatureGate.js';
import { coursesHasStudentVisible } from '../lib/schemaFlags.js';
import { SUPERUSER_EMAIL, supabaseAdmin } from '../lib/supabase.js';
import { normalizeGroupMode, registerProjectGroupRoutes, studentMayFormGroups } from './projectGroups.js';
import { requireProjectStaff } from './access.js';

// Six characters from 0-9A-Z, as before, but from a cryptographic source:
// a guessable code would let anyone in the course join a group.
const INVITE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function genInviteCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return code;
}

export function registerProjectRoutes(app) {
  // POST /api/projects/groups — maak een nieuwe groep voor een project. De
  // initiator wordt direct als 'owner' lid. Voor solo-werk: groep van 1.
  app.post('/api/projects/groups', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, name } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId is vereist' });

    try {
      const { data: project } = await supabaseAdmin
        .from('projects').select('id, title, course_id, allow_self_signup, group_mode, status').eq('id', projectId).maybeSingle();
      if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
      if (project.status === 'archived') return res.status(400).json({ error: 'Dit project is gearchiveerd' });

      // Autorisatie: alleen leden van de cursus (of staff) mogen een groep
      // aanmaken. Voorkomt dat een willekeurige ingelogde user buiten de cursus
      // groepen aanmaakt op andermans projecten.
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
      if (!isStaff) {
        if (!project.course_id || !(await userHasCourseAccess(auth.user, profile, project.course_id))) {
          return res.status(403).json({ error: 'Geen toegang tot de cursus van dit project' });
        }
        if (await rejectIfFeatureOff(res, auth.user, profile, project.course_id, 'projects')) return;
        // Docent of Canvas deelt in: een student maakt geen eigen groep (projectGroups.js).
        if (!studentMayFormGroups(project)) {
          return res.status(403).json({ error: 'De groepen voor dit project worden door je docent of via Canvas ingedeeld', code: 'groupsAssigned' });
        }
        if (!(await userIsActiveCourseMember(auth.user.id, project.course_id))) {
          return res.status(403).json({ error: 'Je hoort bij een vorige editie van deze cursus en kunt niet meer meedoen aan nieuwe projecten', code: 'alumni' });
        }
      }

      const inviteCode = genInviteCode();
      const { data: group, error: gErr } = await supabaseAdmin
        .from('project_groups')
        .insert({
          project_id: projectId,
          name: name || `Groep van ${(auth.user.email || 'student').split('@')[0]}`,
          invite_code: inviteCode,
          created_by: auth.user.id,
        })
        .select('*')
        .single();
      if (gErr) return res.status(500).json({ error: gErr.message });

      const { error: mErr } = await supabaseAdmin
        .from('project_group_members')
        .insert({ group_id: group.id, user_id: auth.user.id, role: 'owner' });
      if (mErr) return res.status(500).json({ error: mErr.message });

      // Maak een sessie-record aan voor ALLE gebruikers (ook admin/docent die
      // het project als student gebruiken). Client-side inserts kunnen stil
      // mislukken door RLS — hier gebruiken we supabaseAdmin.
      // onConflict matcht de bestaande unique-constraint (project_id, student_id).
      await supabaseAdmin.from('student_project_sessions').upsert({
        student_id: auth.user.id,
        project_id: projectId,
        group_id: group.id,
        status: 'in_progress',
        started_at: new Date().toISOString(),
      }, { onConflict: 'project_id,student_id' });

      return res.json({ group });
    } catch (err) {
      console.error('[projects/groups POST]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/groups/join — sluit aan bij een groep via invite-code.
  app.post('/api/projects/groups/join', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { inviteCode } = req.body || {};
    if (!inviteCode) return res.status(400).json({ error: 'inviteCode is vereist' });

    try {
      const { data: group } = await supabaseAdmin
        .from('project_groups')
        .select('id, project_id, status')
        .eq('invite_code', String(inviteCode).toUpperCase())
        .maybeSingle();
      if (!group) return res.status(404).json({ error: 'Geen groep gevonden bij deze code' });
      if (group.status === 'finalized') {
        return res.status(400).json({ error: 'Deze groep is al afgesloten' });
      }

      // Autorisatie: alleen users met toegang tot de cursus van dit project
      // mogen aansluiten. Een geldige invite-code is niet voldoende — anders kan
      // een gelekte code een buitenstaander toegang tot de chat geven.
      const { data: project } = await supabaseAdmin
        .from('projects').select('id, course_id, allow_self_signup, group_mode').eq('id', group.project_id).maybeSingle();
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const isStaff = await isStaffForCourse(auth.user, profile, project?.course_id);
      if (!isStaff && !studentMayFormGroups(project)) {
          return res.status(403).json({ error: 'De groepen voor dit project worden door je docent of via Canvas ingedeeld', code: 'groupsAssigned' });
      }
      if (!isStaff && project?.course_id && !(await userHasCourseAccess(auth.user, profile, project.course_id))) {
        return res.status(403).json({ error: 'Geen toegang tot de cursus van dit project' });
      }
      if (!isStaff && project?.course_id && !(await userIsActiveCourseMember(auth.user.id, project.course_id))) {
        return res.status(403).json({ error: 'Je hoort bij een vorige editie van deze cursus en kunt niet meer meedoen aan nieuwe projecten', code: 'alumni' });
      }
      if (!isStaff && (await rejectIfFeatureOff(res, auth.user, profile, project?.course_id, 'projects'))) return;
      // Privacy (2026-10-08): een docent komt nooit in de groep van studenten
      // (chats, bestanden). Alleen een LEAP-admin mag dat; een eigen testgroep
      // aanmaken blijft voor docenten mogelijk.
      if (isStaff && !isLeapAdmin(profile)) {
        const { count: others } = await supabaseAdmin.from('project_group_members')
          .select('id', { count: 'exact', head: true }).eq('group_id', group.id).neq('user_id', auth.user.id);
        if ((others || 0) > 0) return res.status(403).json({ error: 'Geen toegang tot deze groep' });
      }
      // En andersom: een student sluit niet aan bij een groep waarin een docent
      // van de cursus zit (bv. de eigen testgroep van de docent).
      if (!isStaff && project?.course_id) {
        const { data: groupMembers } = await supabaseAdmin.from('project_group_members')
          .select('user_id').eq('group_id', group.id);
        const memberIds = (groupMembers || []).map((m) => m.user_id).filter((id) => id !== auth.user.id);
        if (memberIds.length) {
          const { data: teachers } = await supabaseAdmin.from('course_members').select('user_id')
            .eq('course_id', project.course_id).eq('member_role', 'teacher').in('user_id', memberIds);
          if ((teachers || []).length) return res.status(403).json({ error: 'Geen toegang tot deze groep' });
        }
      }

      // Idempotent — als je al lid bent, gewoon de groep teruggeven. Race-safe:
      // bij gelijktijdige join kan de unique-constraint (group_id, user_id) een
      // 23505-fout geven; behandel die als succes.
      const { data: existing } = await supabaseAdmin
        .from('project_group_members')
        .select('id').eq('group_id', group.id).eq('user_id', auth.user.id).maybeSingle();
      if (!existing) {
        const { error: mErr } = await supabaseAdmin
          .from('project_group_members')
          .insert({ group_id: group.id, user_id: auth.user.id, role: 'member' });
        if (mErr && mErr.code !== '23505' && !/duplicate key/i.test(mErr.message || '')) {
          return res.status(500).json({ error: mErr.message });
        }
      }

      // Maak (of herstel) een sessie-record voor ALLE gebruikers zodat de
      // overzichtspagina "Ga verder" kan tonen.
      // onConflict matcht de bestaande unique-constraint (project_id, student_id).
      await supabaseAdmin.from('student_project_sessions').upsert({
        student_id: auth.user.id,
        project_id: group.project_id,
        group_id: group.id,
        status: 'in_progress',
        started_at: new Date().toISOString(),
      }, { onConflict: 'project_id,student_id' });

      return res.json({ group });
    } catch (err) {
      console.error('[projects/groups/join]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/projects/:projectId — docent/admin werkt projectvelden bij
  // (titel, onderzoeksvraag, briefing, doelen, rubrics, min/max, status,
  // allow_self_signup). Onbekende velden worden genegeerd.
  app.patch('/api/projects/:projectId', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId } = req.params;
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const access = await requireProjectStaff(projectId, auth.user, profile);
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      // course_id bewust niet wijzigbaar: een lopend project verplaatsen tussen
      // cursussen laat groepslidmaatschappen + cursus-toegang inconsistent achter.
      const allowed = ['title', 'research_question', 'description', 'briefing_markdown',
        'goals', 'rubric_criteria', 'min_group_size', 'max_group_size',
        'allow_self_signup', 'status', 'submissions_enabled', 'group_mode'];
      const patch = {};
      for (const k of allowed) {
        if (k in (req.body || {})) patch[k] = req.body[k];
      }
      // allow_self_signup volgt de groepsindeling (oude code leest dat veld nog).
      if ('group_mode' in patch) {
        patch.group_mode = normalizeGroupMode(patch.group_mode);
        patch.allow_self_signup = patch.group_mode === 'self';
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Geen wijzigingen' });
      if (patch.min_group_size != null && patch.max_group_size != null
          && Number(patch.min_group_size) > Number(patch.max_group_size)) {
        return res.status(400).json({ error: 'Minimum groepsgrootte mag niet groter zijn dan het maximum' });
      }
      const { data, error: e } = await supabaseAdmin
        .from('projects').update(patch).eq('id', projectId).select('*').single();
      if (e) return res.status(500).json({ error: e.message });
      return res.json({ project: data });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/student-overview — lijst per cursus van projecten en
  // laatste sessie-status. Wordt door /projects gebruikt voor de drie keuzes
  // (start nieuw, vervolg laatste, herstart).
  app.get('/api/projects/student-overview', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    try {
      // Cursussen waarvan de student projecten mag zien: de cursussen waar hij
      // lid of docent van is en die de centrale toegangsregel doorlaten
      // (canAccessCourseContent; toegang = lidmaatschap sinds 2026-10-20). De
      // frontend filtert vervolgens op de actieve cursus.
      const courseMap = new Map(); // id -> { id, name }
      const memberCols = coursesHasStudentVisible
        ? 'course_id, member_role, courses(id, name, is_active, student_visible)'
        : 'course_id, member_role, courses(id, name, is_active)';
      const { data: memberships } = await supabaseAdmin
        .from('course_members').select(memberCols).eq('user_id', auth.user.id);
      for (const m of (memberships || [])) {
        const c = m.courses;
        if (!c?.id || courseMap.has(c.id)) continue;
        const studentVisible = coursesHasStudentVisible ? (c.student_visible !== false) : true;
        const isActive = c.is_active !== false;
        const allowed = canAccessCourseContent({
          isAdmin: false,
          isCourseTeacher: m.member_role === 'teacher',
          isMember: true,
          isActive,
          studentVisible,
        });
        if (allowed) courseMap.set(c.id, { id: c.id, name: c.name });
      }
      // Oud-deelnemer van een vorige editie (server/courses/courseEditions.js): alleen de
      // afgeronde groepen van toen, geen nieuwe projecten.
      const alumniCourseIds = new Set();
      const { data: alumniRows } = await supabaseAdmin
        .from('course_alumni').select('course_id, courses(id, name, student_visible)').eq('user_id', auth.user.id);
      for (const a of (alumniRows || [])) {
        const c = a.courses;
        if (!c?.id || courseMap.has(c.id) || c.student_visible === false) continue;
        alumniCourseIds.add(c.id);
        courseMap.set(c.id, { id: c.id, name: c.name });
      }

      // Een LEAP-beheerder heeft overal toegang, ook zonder lidmaatschap: alle
      // cursussen (de frontend toont alleen de actieve). Zo kan de beheerder in
      // elk project zijn eigen groep starten om te controleren of alles klopt.
      // (Sinds de toegangsroute van 2026-10-20 kwam hij hier anders leeg uit.)
      const { data: ovProfile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      if (ovProfile?.role === 'admin' || ovProfile?.email === SUPERUSER_EMAIL) {
        const { data: allCourses } = await supabaseAdmin.from('courses').select('id, name');
        for (const c of (allCourses || [])) if (!courseMap.has(c.id)) courseMap.set(c.id, { id: c.id, name: c.name });
      }

      // Cursussen waar Projecten uit staat vallen weg (behalve voor de docent).
      const courses = [];
      for (const c of courseMap.values()) {
        if (await courseFeatureOnFor(auth.user, ovProfile, c.id, 'projects')) courses.push(c);
      }
      const courseIds = courses.map(c => c.id);
      if (courseIds.length === 0) return res.json({ courses: [] });

      const { data: projects } = await supabaseAdmin
        .from('projects').select('id, title, research_question, course_id, status, briefing_markdown, max_group_size, min_group_size, group_mode, allow_self_signup')
        .in('course_id', courseIds).in('status', ['active', 'archived']);
      const projectIds = (projects || []).map(p => p.id);

      let sessions = [];
      if (projectIds.length > 0) {
        const { data: s } = await supabaseAdmin
          .from('student_project_sessions').select('*')
          .eq('student_id', auth.user.id).in('project_id', projectIds)
          .order('started_at', { ascending: false });
        sessions = s || [];
      }

      // Groepslidmaatschappen voor "vervolg in groep".
      // Inclusief created_at zodat we de meest recente actieve groep kunnen kiezen.
      const { data: groupRows } = await supabaseAdmin
        .from('project_group_members')
        .select('group_id, project_groups!inner(id, project_id, name, status, invite_code, created_at)')
        .eq('user_id', auth.user.id);
      const groupsByProject = new Map();
      for (const g of (groupRows || [])) {
        const grp = g.project_groups;
        if (!grp) continue;
        const list = groupsByProject.get(grp.project_id) || [];
        list.push(grp);
        groupsByProject.set(grp.project_id, list);
      }

      // Haal het meest recente checkpoint op voor elke actieve groep zodat de
      // UI "Ga verder (checkpoint: ...)" kan tonen.
      const allActiveGroupIds = [];
      for (const [, groups] of groupsByProject) {
        const ag = groups.find(g => g.status === 'active');
        if (ag) allActiveGroupIds.push(ag.id);
      }
      const lastCheckpointByGroup = new Map();
      if (allActiveGroupIds.length > 0) {
        const { data: cpRows } = await supabaseAdmin
          .from('group_checkpoints')
          .select('group_id, created_at')
          .in('group_id', allActiveGroupIds)
          .order('created_at', { ascending: false });
        for (const row of (cpRows || [])) {
          if (!lastCheckpointByGroup.has(row.group_id)) {
            lastCheckpointByGroup.set(row.group_id, row.created_at);
          }
        }
      }

      const result = courses.map(c => {
        const cps = (projects || []).filter(p => p.course_id === c.id).map(p => {
          const pSessions = sessions.filter(s => s.project_id === p.id);
          const lastSession = pSessions[0] || null;
          const groups = groupsByProject.get(p.id) || [];
          // Kies de "beste" actieve groep: eerst op meest recente checkpoint,
          // daarna op meest recent aangemaakt (bij meerdere actieve groepen door
          // eerder mislukte herstart-pogingen).
          const activeGroups = groups.filter(g => g.status === 'active');
          activeGroups.sort((a, b) => {
            const cpA = lastCheckpointByGroup.get(a.id) || null;
            const cpB = lastCheckpointByGroup.get(b.id) || null;
            if (cpA && !cpB) return -1;
            if (!cpA && cpB) return 1;
            if (cpA && cpB) return new Date(cpB) - new Date(cpA);
            return new Date(b.created_at) - new Date(a.created_at);
          });
          const activeGroup = activeGroups[0] || null;
          const activeGroupWithCp = activeGroup
            ? { ...activeGroup, lastCheckpointAt: lastCheckpointByGroup.get(activeGroup.id) || null }
            : null;
          // Afgeronde groep blijft bereikbaar (alleen lezen): feedback, beoordelingen en
          // de eindreflectie terugzien en in het eigen leerdagboek bewaren (2026-10-27).
          const finishedGroup = groups.filter(g => g.status === 'finalized')
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
          return { ...p, sessions: pSessions, lastSession, activeGroup: activeGroupWithCp, finishedGroup, archived: p.status === 'archived' };
        })
          // Gearchiveerde projecten (vorige editie) en cursussen waarvan je oud-deelnemer
          // bent: alleen zichtbaar als terugblik op je eigen afgeronde groep.
          .filter(p => (p.status === 'active' && !alumniCourseIds.has(c.id)) || p.finishedGroup);
        return { course: c, projects: cps, alumni: alumniCourseIds.has(c.id) };
      });
      return res.json({ courses: result });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/student-restart — sluit lopende sessies/groepslidmaatschap
  // af en start opnieuw. Body: { projectId }.
  app.post('/api/projects/student-restart', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId vereist' });
    try {
      const { data: project } = await supabaseAdmin
        .from('projects').select('id, course_id, status, allow_self_signup, group_mode').eq('id', projectId).maybeSingle();
      if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
      if (project.status === 'archived') return res.status(400).json({ error: 'Project is gearchiveerd' });
      // Een ingedeelde groep verlaat een student niet op eigen houtje; de docent verplaatst.
      if (!studentMayFormGroups(project) && !(await isStaffForCourse(auth.user, (await profileCache.get(auth.user.id, loadProfileRoleEmail)).data, project.course_id))) {
          return res.status(403).json({ error: 'De groepen voor dit project worden door je docent of via Canvas ingedeeld', code: 'groupsAssigned' });
      }

      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
      if (!isStaff && project.course_id && !(await userHasCourseAccess(auth.user, profile, project.course_id))) {
        return res.status(403).json({ error: 'Geen toegang tot de cursus van dit project' });
      }
      if (!isStaff && (await rejectIfFeatureOff(res, auth.user, profile, project.course_id, 'projects'))) return;

      // Markeer lopende sessies als afgerond zodat de student de oude voortgang
      // terug kan vinden in de Afgerond-lijst.
      await supabaseAdmin.from('student_project_sessions')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('student_id', auth.user.id).eq('project_id', projectId).neq('status', 'completed');

      // Verlaat alle actieve groepen voor dit project zodat een nieuwe sessie
      // niet in de oude groep terechtkomt. Lege groepen worden gearchiveerd
      // zodat ze niet meer als "actief" verschijnen voor de overige leden.
      const { data: myGroups } = await supabaseAdmin
        .from('project_group_members')
        .select('group_id, project_groups!inner(id, project_id, status)')
        .eq('user_id', auth.user.id);
      const groupIdsThisProject = (myGroups || [])
        .filter(g => g.project_groups && g.project_groups.project_id === projectId
          && g.project_groups.status !== 'archived')
        .map(g => g.group_id);
      for (const gid of groupIdsThisProject) {
        await supabaseAdmin.from('project_group_members')
          .delete().eq('group_id', gid).eq('user_id', auth.user.id);
        const { count } = await supabaseAdmin
          .from('project_group_members')
          .select('user_id', { count: 'exact', head: true }).eq('group_id', gid);
        if ((count || 0) === 0) {
          await supabaseAdmin.from('project_groups')
            .update({ status: 'archived' }).eq('id', gid);
        }
      }

      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Studenten uitnodigen voor een cursus, met mail-wachtrij en opruimen (server/courses/courseInvitations.js).
  registerProjectGroupRoutes(app, {
    supabaseAdmin,
    authUser,
    loadProfile: async (id) => (await profileCache.get(id, loadProfileRoleEmail)).data,
    requireProjectStaff,
    genInviteCode,
  });

  // GET /api/projects/:projectId/groups-overview — voor docenten van de cursus:
  // welke groepen er zijn en wie erin zit. Bewust ALLEEN namen en groep; de
  // inhoud van een groep blijft voor de groep zelf (privacy, 2026-10-08).
  app.get('/api/projects/:projectId/groups-overview', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const access = await requireProjectStaff(req.params.projectId, auth.user, profile);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const { data: groups } = await supabaseAdmin
        .from('project_groups').select('id, name, status, created_at')
        .eq('project_id', req.params.projectId).order('created_at');
      const ids = (groups || []).map(g => g.id);
      const { data: members } = ids.length
        ? await supabaseAdmin.from('project_group_members').select('group_id, user_id, profiles(full_name, email)').in('group_id', ids)
        : { data: [] };
      return res.json({
        groups: (groups || []).map(g => ({
          id: g.id,
          name: g.name,
          status: g.status || 'active',
          members: (members || []).filter(m => m.group_id === g.id).map(m => ({
            name: m.profiles?.full_name || m.profiles?.email || null,
            email: m.profiles?.email || null,
          })).sort((a, b) => String(a.name).localeCompare(String(b.name), 'nl')),
        })),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}
