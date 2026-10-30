import { createClient } from '@supabase/supabase-js';
import {
  isStaffAnywhere,
  isStaffForCourse,
  requireAuthUser,
  userCache,
  userIsTeacherAnywhere,
} from '../lib/auth.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, SUPERUSER_EMAIL, supabaseAdmin } from '../lib/supabase.js';
import { registerPromptTemplateRoutes } from './promptTemplates.js';
import {
  CHAT_PROMPT_KEY_PREFIX,
  DEFAULT_EXPLAIN_PROMPT,
  EXPLAIN_PROMPT_KEY_PREFIX,
  QUIZ_PROMPT_DEFAULTS,
  chatPromptKey,
  explainPromptKey,
  loadGlobalChatPrompt,
  loadGlobalExplainPrompt,
  promptsHasSection,
} from './promptStore.js';

export function registerPromptRoutes(app) {
  app.get('/api/admin/prompts-migration-status', async (req, res) => {
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
      const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).maybeSingle();
      const isAdminCheck = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
      if (!isAdminCheck && !(await userIsTeacherAnywhere(user.id))) {
        return res.status(403).json({ error: 'Geen toegang' });
      }
    } catch {
      return res.status(401).json({ error: 'Authenticatie mislukt' });
    }
    const sqlToRun = promptsHasSection ? null : [
      "-- Stap 1: kolom toevoegen",
      "ALTER TABLE chatbot_prompts ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT 'chat';",
      "",
      "-- Stap 2: bestaande rijen op 'chat' zetten",
      "UPDATE chatbot_prompts SET section = 'chat' WHERE name NOT LIKE '__rag_settings%';",
    ].join('\n');
    return res.json({
      hasSection: promptsHasSection,
      sqlToRun,
    });
  });

  app.get('/api/prompt/explain', async (req, res) => {
    // Task #412: lees-endpoint vereist een ingelogde gebruiker (voorheen open).
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    if (!supabaseAdmin || !promptsHasSection) {
      return res.json({ content: DEFAULT_EXPLAIN_PROMPT, source: 'default' });
    }
    const { courseId } = req.query;
    try {
      // 1) Cursus-specifieke override (indien aanwezig en niet leeg).
      if (courseId) {
        const { data: override } = await supabaseAdmin
          .from('chatbot_prompts')
          .select('id, content')
          .eq('name', explainPromptKey(courseId))
          .maybeSingle();
        if (override?.content && override.content.trim()) {
          return res.json({ id: override.id, content: override.content, source: 'course' });
        }
      }
      // 2) Globale actieve uitleg-prompt, anders ingebouwde standaard.
      const global = await loadGlobalExplainPrompt();
      const usedDefault = global.content === DEFAULT_EXPLAIN_PROMPT && global.id === null;
      return res.json({ id: global.id, content: global.content, source: usedDefault ? 'default' : 'global' });
    } catch (err) {
      console.error('[/api/prompt/explain] Exception:', err.message);
      return res.json({ content: DEFAULT_EXPLAIN_PROMPT, source: 'default' });
    }
  });

  // ── Beheer: per-cursus uitleg-prompt (Task #28) ─────────────────────────────
  // GET geeft de cursus-override (indien aanwezig) plus de globale prompt als
  // referentie. PUT slaat een override op, DELETE verwijdert hem (terug naar
  // globaal). Auth: staff voor de betreffende cursus (admin/superuser overal).

  app.get('/api/admin/explain-prompt', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.query;
    if (!courseId) return res.status(400).json({ error: 'courseId vereist' });
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Onvoldoende rechten' });
    }
    try {
      const { data: override } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('content')
        .eq('name', explainPromptKey(courseId))
        .maybeSingle();
      const global = await loadGlobalExplainPrompt();
      const hasOverride = !!(override?.content && override.content.trim());
      return res.json({
        hasOverride,
        content: hasOverride ? override.content : '',
        globalContent: global.content,
      });
    } catch (err) {
      console.error('[/api/admin/explain-prompt GET] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/explain-prompt', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, content } = req.body || {};
    if (!courseId) return res.status(400).json({ error: 'courseId vereist' });
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content (niet-leeg) vereist' });
    }
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Onvoldoende rechten' });
    }
    try {
      const key = explainPromptKey(courseId);
      const { data: existing } = await supabaseAdmin
        .from('chatbot_prompts').select('id').eq('name', key).maybeSingle();
      if (existing) {
        const { error: updErr } = await supabaseAdmin
          .from('chatbot_prompts')
          .update({ content, updated_at: new Date().toISOString() })
          .eq('name', key);
        if (updErr) throw new Error(`DB update mislukt: ${updErr.message}`);
      } else {
        const insertRow = { name: key, content, is_active: false };
        if (promptsHasSection) insertRow.section = 'internal';
        const { error: insErr } = await supabaseAdmin
          .from('chatbot_prompts').insert(insertRow);
        if (insErr) throw new Error(`DB insert mislukt: ${insErr.message}`);
      }
      console.log(`[explain-prompt PUT] Saved override for courseId=${courseId} by user=${auth.user.id}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[/api/admin/explain-prompt PUT] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/admin/explain-prompt/:courseId', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!courseId) return res.status(400).json({ error: 'courseId vereist' });
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Onvoldoende rechten' });
    }
    try {
      const { error: delErr } = await supabaseAdmin
        .from('chatbot_prompts').delete().eq('name', explainPromptKey(courseId));
      if (delErr) throw new Error(`DB delete mislukt: ${delErr.message}`);
      console.log(`[explain-prompt DELETE] Removed override for courseId=${courseId} by user=${auth.user.id}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[/api/admin/explain-prompt DELETE] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/explain-prompt/overrides', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    if (!(await isStaffAnywhere(auth.user, auth.profile))) {
      return res.status(403).json({ error: 'Onvoldoende rechten' });
    }
    try {
      const { data, error } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('name')
        .like('name', `${EXPLAIN_PROMPT_KEY_PREFIX}%`);
      if (error) throw new Error(error.message);
      const courseIds = (data || []).map(row => {
        const m = row.name.match(/^__explain_prompt_(.+)__$/);
        return m ? m[1] : null;
      }).filter(Boolean);
      return res.json({ courseIds });
    } catch (err) {
      console.error('[/api/admin/explain-prompt/overrides GET] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Beheer: per-cursus tutor-chat-prompt (Task #334) ────────────────────────
  // Identiek patroon als de uitleg-prompt-endpoints hierboven: GET geeft de
  // cursus-override (indien aanwezig) plus de globale chat-prompt als referentie;
  // PUT slaat een override op, DELETE verwijdert hem (terug naar globaal). Auth:
  // staff voor de betreffende cursus (admin/superuser overal, docent van déze
  // cursus via isStaffForCourse).

  app.get('/api/admin/chat-prompt', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.query;
    if (!courseId) return res.status(400).json({ error: 'courseId vereist' });
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Onvoldoende rechten' });
    }
    try {
      const { data: override } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('content')
        .eq('name', chatPromptKey(courseId))
        .maybeSingle();
      const global = await loadGlobalChatPrompt();
      const hasOverride = !!(override?.content && override.content.trim());
      return res.json({
        hasOverride,
        content: hasOverride ? override.content : '',
        globalContent: global.content,
      });
    } catch (err) {
      console.error('[/api/admin/chat-prompt GET] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/chat-prompt', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, content } = req.body || {};
    if (!courseId) return res.status(400).json({ error: 'courseId vereist' });
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content (niet-leeg) vereist' });
    }
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Onvoldoende rechten' });
    }
    try {
      const key = chatPromptKey(courseId);
      const { data: existing } = await supabaseAdmin
        .from('chatbot_prompts').select('id').eq('name', key).maybeSingle();
      if (existing) {
        const { error: updErr } = await supabaseAdmin
          .from('chatbot_prompts')
          .update({ content, updated_at: new Date().toISOString() })
          .eq('name', key);
        if (updErr) throw new Error(`DB update mislukt: ${updErr.message}`);
      } else {
        const insertRow = { name: key, content, is_active: false };
        if (promptsHasSection) insertRow.section = 'internal';
        const { error: insErr } = await supabaseAdmin
          .from('chatbot_prompts').insert(insertRow);
        if (insErr) throw new Error(`DB insert mislukt: ${insErr.message}`);
      }
      console.log(`[chat-prompt PUT] Saved override for courseId=${courseId} by user=${auth.user.id}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[/api/admin/chat-prompt PUT] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/admin/chat-prompt/:courseId', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    if (!courseId) return res.status(400).json({ error: 'courseId vereist' });
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Onvoldoende rechten' });
    }
    try {
      const { error: delErr } = await supabaseAdmin
        .from('chatbot_prompts').delete().eq('name', chatPromptKey(courseId));
      if (delErr) throw new Error(`DB delete mislukt: ${delErr.message}`);
      console.log(`[chat-prompt DELETE] Removed override for courseId=${courseId} by user=${auth.user.id}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[/api/admin/chat-prompt DELETE] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/chat-prompt/overrides', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    if (!(await isStaffAnywhere(auth.user, auth.profile))) {
      return res.status(403).json({ error: 'Onvoldoende rechten' });
    }
    try {
      const { data, error } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('name')
        .like('name', `${CHAT_PROMPT_KEY_PREFIX}%`);
      if (error) throw new Error(error.message);
      const courseIds = (data || []).map(row => {
        const m = row.name.match(/^__chat_prompt_(.+)__$/);
        return m ? m[1] : null;
      }).filter(Boolean);
      return res.json({ courseIds });
    } catch (err) {
      console.error('[/api/admin/chat-prompt/overrides GET] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // Debug endpoint: geeft per sectie terug welke prompt actief is (naam + bron).
  // Alleen toegankelijk voor admins en docenten.
  app.get('/api/debug/active-prompts', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    // Admin/superuser overal; anders moet de user in minstens één cursus
    // docent zijn (course_members.member_role='teacher').
    const isAdminDbg = auth.profile?.role === 'admin' || auth.profile?.email === SUPERUSER_EMAIL;
    if (!isAdminDbg && !(await userIsTeacherAnywhere(auth.user.id))) {
      return res.status(403).json({ error: 'Alleen beschikbaar voor admins en docenten' });
    }
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });

    const result = { chat: null, explain: null, quiz: [] };

    // Chat-prompt: actieve prompt met section='chat'. Spiegel de filters van
    // /api/chat exact (incl. uitsluiting van quiz_*-namen) en order+limit, zodat
    // meerdere chat-rijen niet leiden tot een "multiple rows"-fout op
    // .maybeSingle() en de badge nooit ten onrechte 'fallback' toont.
    try {
      const quizNamesExclude = Object.keys(QUIZ_PROMPT_DEFAULTS);
      let chatQuery = supabaseAdmin
        .from('chatbot_prompts')
        .select('id, name')
        .eq('is_active', true)
        .not('name', 'like', '__rag_settings%')
        .not('name', 'like', '__doc_mutation_%')
        .not('name', 'like', '__concepts_regen_%')
        .not('name', 'like', '__quiz_itembank_config%')
        .not('name', 'in', `(${quizNamesExclude.map(n => `"${n}"`).join(',')})`)
        .order('updated_at', { ascending: false })
        .limit(1);
      if (promptsHasSection) chatQuery = chatQuery.eq('section', 'chat');
      const { data } = await chatQuery.maybeSingle();
      result.chat = data
        ? { id: data.id, name: data.name, source: 'database' }
        : { name: 'FALLBACK_SYSTEM_PROMPT', source: 'fallback' };
    } catch (err) {
      result.chat = { name: 'FALLBACK_SYSTEM_PROMPT', source: 'fallback' };
    }

    // Explain-prompt: actieve prompt met section='explain'
    try {
      if (promptsHasSection) {
        const { data } = await supabaseAdmin
          .from('chatbot_prompts')
          .select('id, name')
          .eq('section', 'explain')
          .eq('is_active', true)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        result.explain = data
          ? { id: data.id, name: data.name, source: 'database' }
          : { name: 'DEFAULT_EXPLAIN_PROMPT', source: 'fallback' };
      } else {
        result.explain = { name: 'DEFAULT_EXPLAIN_PROMPT', source: 'fallback' };
      }
    } catch (err) {
      result.explain = { name: 'DEFAULT_EXPLAIN_PROMPT', source: 'fallback' };
    }

    // Quiz-prompts: alle bekende quiz-prompts met hun actieve status
    try {
      const quizNames = Object.keys(QUIZ_PROMPT_DEFAULTS);
      if (promptsHasSection) {
        const { data } = await supabaseAdmin
          .from('chatbot_prompts')
          .select('id, name, is_active')
          .in('name', quizNames);
        result.quiz = (data || []).map(r => ({ id: r.id, name: r.name, is_active: r.is_active !== false }));
      } else {
        result.quiz = quizNames.map(name => ({ name, is_active: true, source: 'fallback' }));
      }
    } catch (err) {
      result.quiz = [];
    }

    return res.json(result);
  });

  // Sjablonen voor de cursusinstructies: docenten lezen, alleen de beheerder wijzigt (server/prompts/promptTemplates.js).
  registerPromptTemplateRoutes(app, {
    supabaseAdmin,
    requireAuthUser,
    isAdminProfile: (p) => !!p && (p.role === 'admin' || p.email === SUPERUSER_EMAIL),
    isStaffAnywhere,
    loadTemplate: { chat: loadGlobalChatPrompt, explain: loadGlobalExplainPrompt },
  });
}
