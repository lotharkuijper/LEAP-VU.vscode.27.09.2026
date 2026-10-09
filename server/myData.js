// Mijn gegevens (2026-10-09): een student (of docent) kan zelf
//  * al zijn/haar eigen gegevens downloaden (GET /api/me/export), en
//  * het eigen account verwijderen (POST /api/me/delete-account).
//
// Wat "eigen" is, staat hieronder in EXPORT_SOURCES: per tabel de kolom die
// naar de gebruiker wijst. Alleen rijen waarvan de gebruiker de maker/eigenaar
// is; nooit berichten of gegevens van anderen (ook niet in een groepschat).
// Nieuwe tabel met persoonlijke gegevens? Voeg hem hier toe; de test in
// server/__tests__/myData.test.js vergelijkt deze lijst met de migraties.
//
// Account verwijderen gaat via dezelfde weg als bij de beheerder
// (auth.admin.deleteUser): wat er in de database aan het account hangt,
// verdwijnt of wordt losgekoppeld volgens de bestaande regels (ON DELETE).

export const EXPORT_SOURCES = [
  { table: 'profiles', column: 'id', label: 'profiel' },
  { table: 'course_members', column: 'user_id', label: 'cursussen' },
  { table: 'student_course_levels', column: 'user_id', label: 'leerniveaus' },
  { table: 'student_achievements', column: 'user_id', label: 'prestaties' },
  { table: 'learning_journal_entries', column: 'user_id', label: 'leerdagboek' },
  { table: 'student_explanations', column: 'student_id', label: 'ik leg uit' },
  { table: 'quiz_attempts', column: 'student_id', label: 'quizpogingen' },
  { table: 'conversations', column: 'user_id', label: 'chatgesprekken' },
  { table: 'project_group_members', column: 'user_id', label: 'projectgroepen' },
  { table: 'group_chat_messages', column: 'user_id', label: 'eigen berichten in groepschats' },
  { table: 'group_persona_messages', column: 'user_id', label: "eigen berichten aan persona's" },
  { table: 'project_group_products', column: 'uploaded_by', label: 'ingeleverd werk' },
  { table: 'project_submissions', column: 'uploaded_by', label: 'inleveringen' },
  { table: 'project_persona_documents', column: 'uploaded_by', label: "documenten voor persona's" },
  { table: 'student_project_sessions', column: 'student_id', label: 'projectsessies' },
  { table: 'project_review_badges', column: 'user_id', label: 'projectbadges' },
  { table: 'collaboration_messages', column: 'user_id', label: 'samenwerkingsberichten' },
  { table: 'collaboration_participants', column: 'user_id', label: 'samenwerkingen' },
  { table: 'studiecafe_threads', column: 'author_id', label: 'studiecafé: onderwerpen' },
  { table: 'studiecafe_replies', column: 'author_id', label: 'studiecafé: reacties' },
  { table: 'message_reactions', column: 'user_id', label: 'reacties op berichten' },
  { table: 'studiecafe_notification_prefs', column: 'user_id', label: 'meldingsvoorkeuren' },
  { table: 'course_enrollments', column: 'student_id', label: 'inschrijvingen' },
];

// Tabellen met een verwijzing naar een gebruiker die GEEN persoonlijke
// leergegevens van die gebruiker zijn (beheer, audit, tellers, gelezen-status).
export const NOT_EXPORTED = [
  'chatbot_prompts', 'collaboration_sessions', 'concept_itembank_sections', 'concept_rag_sources',
  'concepts', 'course_info', 'course_personas', 'datasets', 'document_folders', 'documents',
  'group_checkpoints', 'project_document_reviews', 'project_documents', 'project_groups',
  'project_persona_consultation_grants', 'projects', 'quiz_questions', 'quiz_sets', 'quiz_sources_mix',
  'quiz_validations', 'studiecafe_last_seen', 'studiecafe_notifications', 'studiecafe_thread_reads',
  'user_audit_log',
];

const PAGE = 1000;

/** Alle eigen rijen uit één bron; ontbrekende tabel of kolom → overslaan (null). */
async function rowsOf(db, { table, column }, userId) {
  const out = [];
  for (let from = 0; from < 20000; from += PAGE) {
    const { data, error } = await db.from(table).select('*').eq(column, userId).range(from, from + PAGE - 1);
    if (error) return from === 0 ? null : out;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** Bouwt het exportbestand: { exportedAt, user, sources: { tabel: rijen } }. */
export async function buildExport(db, user, now = new Date()) {
  const results = await Promise.all(EXPORT_SOURCES.map(async (s) => [s, await rowsOf(db, s, user.id)]));
  const sources = {};
  const skipped = [];
  for (const [s, rows] of results) {
    if (rows === null) skipped.push(s.table);
    else sources[s.table] = rows;
  }
  // Chatberichten horen bij de eigen gesprekken.
  const convIds = (sources.conversations || []).map(c => c.id).filter(Boolean);
  if (convIds.length) {
    const msgs = [];
    for (let i = 0; i < convIds.length; i += 200) {
      const { data, error } = await db.from('messages').select('*').in('conversation_id', convIds.slice(i, i + 200));
      if (!error) msgs.push(...(data || []));
    }
    sources.messages = msgs;
  }
  return {
    exportedAt: now.toISOString(),
    app: 'LEAP-VU',
    user: { id: user.id, email: user.email || null },
    explanation: 'Alle gegevens die LEAP van jou bewaart, per onderdeel. Berichten van anderen staan er niet in.',
    labels: Object.fromEntries(EXPORT_SOURCES.map(s => [s.table, s.label]).concat([['messages', 'chatberichten']])),
    skipped,
    sources,
  };
}

export function registerMyDataRoutes(app, deps) {
  const { supabaseAdmin, authUser, getProfile, superuserEmail, onDeleted } = deps;

  app.get('/api/me/export', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    try {
      const data = await buildExport(supabaseAdmin, auth.user);
      const day = data.exportedAt.slice(0, 10);
      res.setHeader('Content-Disposition', `attachment; filename="leap-mijn-gegevens-${day}.json"`);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });

  app.post('/api/me/delete-account', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    try {
      const profile = await getProfile(auth.user.id);
      const email = String(profile?.email || auth.user.email || '').trim().toLowerCase();
      const typed = String(req.body?.confirmEmail || '').trim().toLowerCase();
      if (!email || typed !== email) {
        return res.status(400).json({ error: 'Typ je eigen e-mailadres om te bevestigen', code: 'confirmMismatch' });
      }
      if (email === String(superuserEmail || '').toLowerCase() || profile?.role === 'admin') {
        return res.status(400).json({ error: 'Een beheerder kan het eigen account niet zelf verwijderen', code: 'adminSelfDelete' });
      }
      const { error } = await supabaseAdmin.auth.admin.deleteUser(auth.user.id);
      if (error) throw new Error(error.message);
      onDeleted?.(auth.user.id);
      console.log(`[me/delete-account] account verwijderd door gebruiker zelf: ${auth.user.id}`);
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err?.message || String(err) });
    }
  });
}
