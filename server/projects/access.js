import { isCourseTeacher, isStaffForCourse, userHasCourseAccess } from '../lib/auth.js';
import { loadCourseFeatures } from '../lib/courseFeatureGate.js';
import { SUPERUSER_EMAIL, supabaseAdmin } from '../lib/supabase.js';

export async function isGroupMember(groupId, userId) {
  const { data } = await supabaseAdmin
    .from('project_group_members')
    .select('id')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}

// Bepaalt of de huidige user toegang heeft tot een project. Toegang =
// staff (admin/docent/superuser), of lid van een groep in dit project, of
// student met access tot project.course_id (gebruikt userHasCourseAccess).
export async function userHasProjectAccess(user, profile, project) {
  if (!project) return false;
  const isStaff = await isStaffForCourse(user, profile, project.course_id);
  if (isStaff) return true;
  // Projecten uit in deze cursus: ook groepsleden kunnen er niet meer in.
  if (project.course_id && (await loadCourseFeatures(project.course_id)).projects === false) return false;
  if (project.course_id) {
    if (await userHasCourseAccess(user, profile, project.course_id)) return true;
  }
  // Fallback: lid van enige groep in dit project.
  const { data: m } = await supabaseAdmin
    .from('project_group_members')
    .select('group_id, project_groups!inner(project_id)')
    .eq('user_id', user.id)
    .eq('project_groups.project_id', project.id)
    .limit(1);
  return !!(m && m.length > 0);
}

export async function requireProjectStaff(projectId, user, profile) {
  if (!projectId || !user) return { ok: false, status: 401, error: 'Niet geauthenticeerd' };
  const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
  if (isAdmin) {
    const { data: project } = await supabaseAdmin
      .from('projects').select('*').eq('id', projectId).maybeSingle();
    if (!project) return { ok: false, status: 404, error: 'Project niet gevonden' };
    return { ok: true, project };
  }
  const { data: project } = await supabaseAdmin
    .from('projects').select('*').eq('id', projectId).maybeSingle();
  if (!project) return { ok: false, status: 404, error: 'Project niet gevonden' };
  if (!project.course_id) {
    return { ok: false, status: 403, error: 'Project zonder cursus is alleen door admin te beheren' };
  }
  if (!(await isCourseTeacher(user.id, project.course_id))) {
    return { ok: false, status: 403, error: 'Je bent geen docent van de cursus van dit project' };
  }
  return { ok: true, project };
}
