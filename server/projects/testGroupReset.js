// Testgroep opnieuw beginnen (2026-11-17). Een docent van de cursus of een
// LEAP-admin kan zijn eigen testgroep leegmaken: de groep wordt verwijderd (alle
// gesprekken, bestanden, inleveringen en checkpoints gaan mee via ON DELETE
// CASCADE) en er komt een nieuwe, lege testgroep met dezelfde naam voor in de
// plaats. Alleen een groep die de aanvrager zelf heeft aangemaakt, waarin hij nu
// als enige zit en waarin niemand anders ooit iets heeft gezet: werk van
// studenten (ook van oud-leden) verdwijnt hier nooit. Studenten kunnen dit niet.

// Groepsinhoud met een auteur: [tabel, auteurkolom].
const AUTHORED_GROUP_CONTENT = [
  ['group_chat_messages', 'user_id'],
  ['group_checkpoints', 'created_by'],
  ['project_submissions', 'uploaded_by'],
  ['project_document_reviews', 'requested_by'],
  ['project_group_products', 'uploaded_by'],
];

const FAILED = { error: 'Resetten mislukt' };

/** Heeft iemand anders dan userId iets in deze groep gezet? */
async function othersWorkIn(db, groupId, userId) {
  for (const [table, col] of AUTHORED_GROUP_CONTENT) {
    const { count, error } = await db.from(table).select('id', { count: 'exact', head: true })
      .eq('group_id', groupId).neq(col, userId);
    if (error || (count || 0) > 0) return true;
  }
  const { data: threads, error: tErr } = await db.from('group_persona_threads').select('id').eq('group_id', groupId);
  if (tErr) return true;
  const threadIds = (threads || []).map((t) => t.id);
  if (threadIds.length) {
    const { count, error } = await db.from('group_persona_messages').select('id', { count: 'exact', head: true })
      .in('thread_id', threadIds).eq('role', 'user').neq('user_id', userId);
    if (error || (count || 0) > 0) return true;
  }
  return false;
}

/**
 * @param {object} db  supabaseAdmin
 * @param {object} p
 * @param {string} p.groupId
 * @param {string} p.userId
 * @param {(courseId: string|null) => Promise<boolean>} p.isStaffFor  docent van deze cursus of admin?
 * @param {() => string} p.genInviteCode
 * @returns {Promise<{status:number, body:object}>}
 */
export async function resetTestGroup(db, { groupId, userId, isStaffFor, genInviteCode }) {
  const { data: group } = await db.from('project_groups')
    .select('id, project_id, name, created_by').eq('id', groupId).maybeSingle();
  if (!group) return { status: 404, body: { error: 'Groep niet gevonden' } };
  const { data: project } = await db.from('projects')
    .select('id, course_id, status').eq('id', group.project_id).maybeSingle();
  if (!project) return { status: 404, body: { error: 'Project niet gevonden' } };
  if (!(await isStaffFor(project.course_id))) {
    return { status: 403, body: { error: 'Alleen een docent van de cursus kan een testgroep opnieuw beginnen', code: 'notStaff' } };
  }
  if (project.status === 'archived') return { status: 400, body: { error: 'Dit project is gearchiveerd' } };

  const notTestGroup = { status: 403, body: { error: 'Dit is niet je eigen testgroep', code: 'notTestGroup' } };
  if (group.created_by !== userId) return notTestGroup;
  const { data: members } = await db.from('project_group_members').select('user_id').eq('group_id', groupId);
  const ids = (members || []).map((m) => m.user_id);
  if (ids.length !== 1 || ids[0] !== userId) return notTestGroup;
  if (await othersWorkIn(db, groupId, userId)) return notTestGroup;

  const { error: delErr } = await db.from('project_groups').delete().eq('id', groupId).eq('created_by', userId);
  if (delErr) {
    console.error('[reset-test-group] verwijderen:', delErr.message);
    return { status: 500, body: FAILED };
  }

  const { data: fresh, error: gErr } = await db.from('project_groups')
    .insert({ project_id: project.id, name: group.name, invite_code: genInviteCode(), created_by: userId })
    .select('*').single();
  if (gErr) {
    console.error('[reset-test-group] nieuwe groep:', gErr.message);
    return { status: 500, body: FAILED };
  }
  const { error: mErr } = await db.from('project_group_members')
    .insert({ group_id: fresh.id, user_id: userId, role: 'owner' });
  if (mErr) {
    console.error('[reset-test-group] lidmaatschap:', mErr.message);
    return { status: 500, body: FAILED };
  }
  const { error: sErr } = await db.from('student_project_sessions').upsert({
    student_id: userId,
    project_id: project.id,
    group_id: fresh.id,
    status: 'in_progress',
    started_at: new Date().toISOString(),
    completed_at: null,
  }, { onConflict: 'project_id,student_id' });
  if (sErr) console.warn('[reset-test-group] sessie:', sErr.message);

  return { status: 200, body: { group: fresh } };
}
