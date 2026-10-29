import { createClient } from '@supabase/supabase-js';
import { loadProfileRoleEmail, profileCache, userCache } from '../lib/auth.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, SUPERUSER_EMAIL, supabaseAdmin } from '../lib/supabase.js';

export function registerJournalRoutes(app) {
  // ─── Journal routes (admin-client om RLS te omzeilen) ────────────────────────

  app.get('/api/journal', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      const { data, error } = await supabaseAdmin
        .from('learning_journal_entries')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) return res.status(500).json({ error: error.message });
      const entries = data || [];
      // Verrijk met cursusnaam zodat de UI per notitie kan tonen in welke cursus
      // ze is aangemaakt. course_id kan null zijn (legacy of buiten cursuscontext).
      const courseIds = [...new Set(entries.map(e => e.course_id).filter(Boolean))];
      let courseNameById = {};
      if (courseIds.length > 0) {
        const { data: courses } = await supabaseAdmin
          .from('courses').select('id, name').in('id', courseIds);
        courseNameById = Object.fromEntries((courses || []).map(c => [c.id, c.name]));
      }
      const enriched = entries.map(e => ({
        ...e,
        course_name: e.course_id ? (courseNameById[e.course_id] || null) : null,
      }));
      return res.json(enriched);
    } catch (err) {
      console.error('[journal GET] Fout:', err.message);
      return res.status(500).json({ error: 'Interne fout' });
    }
  });

  app.patch('/api/journal/:id', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      const { data: profile } = await profileCache.get(user.id, loadProfileRoleEmail);
      // Alleen admin/superuser mag andermans journal-entries bewerken.
      const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);

      const { id } = req.params;
      const { title, content, activity_type } = req.body;

      // Controleer eigenaar tenzij admin
      const { data: existingEntry } = await supabaseAdmin
        .from('learning_journal_entries').select('user_id, content').eq('id', id).maybeSingle();
      if (!isAdmin) {
        if (!existingEntry || existingEntry.user_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot deze notitie' });
      }

      const journalPatch = { title, content, activity_type, updated_at: new Date().toISOString() };
      // Eigen tekst van de student wint: de automatische blokken vervallen dan.
      if (existingEntry && content !== undefined && content !== existingEntry.content) journalPatch.sections = null;
      const { data, error } = await supabaseAdmin
        .from('learning_journal_entries')
        .update(journalPatch)
        .eq('id', id)
        .select()
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.json(data);
    } catch (err) {
      console.error('[journal PATCH] Fout:', err.message);
      return res.status(500).json({ error: 'Interne fout' });
    }
  });

  app.delete('/api/journal/:id', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      const { data: profile } = await profileCache.get(user.id, loadProfileRoleEmail);
      // Alleen admin/superuser mag andermans journal-entries verwijderen.
      const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);

      const { id } = req.params;

      // Controleer eigenaar tenzij admin
      if (!isAdmin) {
        const { data: entry } = await supabaseAdmin
          .from('learning_journal_entries').select('user_id').eq('id', id).maybeSingle();
        if (!entry || entry.user_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot deze notitie' });
      }

      const { error } = await supabaseAdmin
        .from('learning_journal_entries')
        .delete()
        .eq('id', id);

      if (error) return res.status(500).json({ error: error.message });
      console.log(`[journal DELETE] Notitie ${id} verwijderd door ${user.id}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[journal DELETE] Fout:', err.message);
      return res.status(500).json({ error: 'Interne fout' });
    }
  });
}
