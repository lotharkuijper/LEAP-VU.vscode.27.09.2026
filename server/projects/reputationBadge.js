// Badge voor de beste verstandhouding (besluit 2026-11-10). Bereikt een groep na
// een gesprek voor het eerst het hoogste niveau (LEVEL_MAX, "warm") bij een
// rolspeler, dan krijgt elk groepslid een prestatie in de eigen prijzenkast
// (student_achievements, kind 'reputation'). Feedback van een beoordelaar geeft
// nooit een badge: die is zuiver formatief.
//
// Alleen via een gesprek verdiend: een correctie door de docent telt niet.
// Eén badge per student per rolspeler (topic_key = persona-id); de unieke index
// op student_achievements geldt niet bij level NULL, dus we kijken eerst wat er al is.

import { LEVEL_MAX, clampLevel } from './personaRelationship.js';

export const REPUTATION_KIND = 'reputation';

/** Pure: verdient deze stap de badge? Alleen de overgang naar het hoogste niveau. */
export function earnsReputationBadge(from, to) {
  return clampLevel(to) === LEVEL_MAX && clampLevel(from) < LEVEL_MAX;
}

/**
 * Ken de badge toe aan elk lid van de groep dat hem nog niet heeft.
 * Retour: het aantal nieuwe badges (0 als er niets te doen was).
 */
export async function awardReputationBadge(supabaseAdmin, { projectId, groupId, persona }) {
  if (!supabaseAdmin || !projectId || !groupId || !persona?.id) return 0;
  const [{ data: project }, { data: members }] = await Promise.all([
    supabaseAdmin.from('projects').select('id, course_id, title').eq('id', projectId).maybeSingle(),
    supabaseAdmin.from('project_group_members').select('user_id').eq('group_id', groupId),
  ]);
  const userIds = (members || []).map(m => m.user_id).filter(Boolean);
  if (!project || userIds.length === 0) return 0;
  const { data: have } = await supabaseAdmin.from('student_achievements').select('user_id')
    .eq('kind', REPUTATION_KIND).eq('topic_key', persona.id).in('user_id', userIds);
  const already = new Set((have || []).map(r => r.user_id));
  const rows = userIds.filter(u => !already.has(u)).map(user_id => ({
    user_id,
    course_id: project.course_id || null,
    kind: REPUTATION_KIND,
    topic_key: persona.id,
    topic_label: persona.name || null,
    level: null,
    details: { project_id: project.id, project_title: project.title || null, group_id: groupId, persona_id: persona.id },
  }));
  if (rows.length === 0) return 0;
  const { error } = await supabaseAdmin.from('student_achievements').insert(rows);
  if (error) {
    console.warn('[reputation-badge] toekennen mislukt:', error.message);
    return 0;
  }
  return rows.length;
}
