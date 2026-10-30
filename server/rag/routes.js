import { createClient } from '@supabase/supabase-js';
import { registerCrossLingualRoute } from './crossLingual.js';
import { EMBEDDINGS_RATE_LIMIT_MSG } from '../lib/embeddingsRetry.js';
import {
  isCourseTeacher,
  isStaffAnywhere,
  isStaffForCourse,
  loadProfileRoleEmail,
  profileCache,
  requireAuthUser,
  userCache,
  userHasCourseAccess,
} from '../lib/auth.js';
import {
  AZURE_EMBEDDINGS_READY,
  EMBEDDINGS_NOT_CONFIGURED_MSG,
  OPENAI_MODEL,
  chatModelParams,
  embedBatchWithRetry,
  openaiChatCompletion,
} from '../lib/azureOpenai.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, SUPERUSER_EMAIL, pgPool, supabaseAdmin } from '../lib/supabase.js';
import {
  RAG_EXTRACTION_DEFAULTS,
  RAG_MODULE_DEFAULTS,
  loadRagSettings,
  searchChunksServerSide,
} from './search.js';

// Limits for /api/embeddings: the browser embeds one search question (plus its
// translation) at a time; ~30k characters stays under the model's 8k-token input.
const EMBEDDINGS_MAX_TEXTS = 16;
const EMBEDDINGS_MAX_CHARS = 30000;

export function registerRagRoutes(app) {
  app.post('/api/embeddings', async (req, res) => {
    if (!AZURE_EMBEDDINGS_READY) {
      return res.status(503).json({ error: EMBEDDINGS_NOT_CONFIGURED_MSG });
    }

    // Signed-in users only, and bounded: each call costs Azure quota.
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { texts } = req.body;
    if (!texts || !Array.isArray(texts)) {
      return res.status(400).json({ error: 'texts array required' });
    }
    if (texts.length > EMBEDDINGS_MAX_TEXTS || texts.some((t) => typeof t !== 'string' || t.length > EMBEDDINGS_MAX_CHARS)) {
      return res.status(400).json({ error: 'texts array required' });
    }

    try {
      const data = await embedBatchWithRetry(texts);
      const embeddings = data.data.map((item) => item.embedding);
      console.log(`[/api/embeddings] Generated ${embeddings.length} embeddings via Azure (dim=${embeddings[0]?.length})`);
      return res.json({ embeddings, provider: 'azure' });
    } catch (err) {
      if (err.isRateLimit) {
        console.warn('[/api/embeddings] Azure-snelheidslimiet na alle pogingen:', err.azureMessage || err.message);
        res.set('Retry-After', '30');
        return res.status(429).json({ error: EMBEDDINGS_RATE_LIMIT_MSG });
      }
      console.error('[/api/embeddings] Azure embeddings request failed:', err.message);
      const status = Number.isInteger(err.status) && err.status >= 400 ? err.status : 500;
      return res.status(status).json({ error: err.message });
    }
  });

  app.get('/api/rag-settings', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    // Task #412: lees-endpoint vereist een ingelogde gebruiker (voorheen open).
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.query;
    try {
      const settings = await loadRagSettings(courseId || null);
      return res.json(settings);
    } catch (err) {
      console.error('[rag-settings GET] Error:', err.message);
      return res.json({ ...RAG_MODULE_DEFAULTS, extraction: { ...RAG_EXTRACTION_DEFAULTS } });
    }
  });

  app.put('/api/rag-settings', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });

    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

    const { courseId, settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ error: 'settings object vereist' });
    }

    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      const { data: profile } = await profileCache.get(user.id, loadProfileRoleEmail);

      // Per-cursus RAG: vereist staff voor die cursus. Globale defaults:
      // alleen admin.
      const isAllowed = courseId
        ? await isStaffForCourse(user, profile, courseId)
        : (profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL);
      if (!isAllowed) return res.status(403).json({ error: 'Onvoldoende rechten' });

      // Valideer en clamp settings per module
      const MODULES = ['chat', 'explain', 'quiz', 'project'];
      for (const mod of MODULES) {
        if (settings[mod]) {
          const m = settings[mod];
          if (m.similarity_threshold !== undefined) {
            const parsed = parseFloat(m.similarity_threshold);
            if (isNaN(parsed)) return res.status(400).json({ error: `similarity_threshold voor ${mod} is geen geldig getal` });
            m.similarity_threshold = Math.max(0.10, Math.min(0.95, parsed));
          }
          if (m.match_count !== undefined) {
            const parsed = parseInt(m.match_count);
            if (isNaN(parsed)) return res.status(400).json({ error: `match_count voor ${mod} is geen geldig getal` });
            m.match_count = Math.max(1, Math.min(20, parsed));
          }
          if (m.rag_strict_mode !== undefined) {
            m.rag_strict_mode = Boolean(m.rag_strict_mode);
          }
          if (m.query_expansion_enabled !== undefined) {
            m.query_expansion_enabled = Boolean(m.query_expansion_enabled);
          }
        }
      }
      // Aparte validatie voor extraction (andere shape: similarity_threshold + min_evidence_chunks)
      if (settings.extraction) {
        const e = settings.extraction;
        if (e.similarity_threshold !== undefined) {
          const parsed = parseFloat(e.similarity_threshold);
          if (isNaN(parsed)) return res.status(400).json({ error: 'similarity_threshold voor extraction is geen geldig getal' });
          e.similarity_threshold = Math.max(0.0, Math.min(0.95, parsed));
        }
        if (e.min_evidence_chunks !== undefined) {
          const parsed = parseInt(e.min_evidence_chunks);
          if (isNaN(parsed)) return res.status(400).json({ error: 'min_evidence_chunks is geen geldig getal' });
          e.min_evidence_chunks = Math.max(0, Math.min(10, parsed));
        }
        if (e.max_concepts !== undefined) {
          if (e.max_concepts === null || e.max_concepts === '') {
            e.max_concepts = null;
          } else {
            const parsed = parseInt(e.max_concepts);
            if (isNaN(parsed)) return res.status(400).json({ error: 'max_concepts is geen geldig getal' });
            e.max_concepts = Math.max(5, Math.min(500, parsed));
          }
        }
        if (e.min_concepts !== undefined) {
          if (e.min_concepts === null || e.min_concepts === '') {
            e.min_concepts = null;
          } else {
            const parsed = parseInt(e.min_concepts);
            if (isNaN(parsed)) return res.status(400).json({ error: 'min_concepts is geen geldig getal' });
            e.min_concepts = Math.max(1, Math.min(500, parsed));
          }
        }
      }

      const settingsKey = courseId ? `__rag_settings_${courseId}__` : '__rag_settings_global__';

      // Haal bestaande settings op en voeg samen om gedeeltelijke updates te steunen
      const { data: existingRow } = await supabaseAdmin
        .from('chatbot_prompts').select('id, content').eq('name', settingsKey).maybeSingle();

      let mergedSettings = { ...RAG_MODULE_DEFAULTS, extraction: { ...RAG_EXTRACTION_DEFAULTS } };
      if (existingRow?.content) {
        try {
          const prev = JSON.parse(existingRow.content);
          for (const mod of Object.keys(RAG_MODULE_DEFAULTS)) {
            if (prev[mod]) mergedSettings[mod] = { ...RAG_MODULE_DEFAULTS[mod], ...prev[mod] };
          }
          if (prev.extraction) {
            mergedSettings.extraction = { ...RAG_EXTRACTION_DEFAULTS, ...prev.extraction };
          }
        } catch { /* negeer parse-fouten, gebruik defaults */ }
      }
      // Schrijf de inkomende modules over de bestaande settings heen
      for (const mod of MODULES) {
        if (settings[mod]) mergedSettings[mod] = { ...mergedSettings[mod], ...settings[mod] };
      }
      // Schrijf inkomende extractie-instellingen over de bestaande heen
      if (settings.extraction) {
        mergedSettings.extraction = { ...mergedSettings.extraction, ...settings.extraction };
        const { min_concepts: minC, max_concepts: maxC } = mergedSettings.extraction;
        if (minC != null && maxC != null && minC > maxC) {
          return res.status(400).json({ error: 'Het minimum aantal begrippen is groter dan het maximum', code: 'min_above_max' });
        }
      }

      const content = JSON.stringify(mergedSettings);

      if (existingRow) {
        const { error: updateErr } = await supabaseAdmin
          .from('chatbot_prompts')
          .update({ content, updated_at: new Date().toISOString() })
          .eq('name', settingsKey);
        if (updateErr) throw new Error(`DB update mislukt: ${updateErr.message}`);
      } else {
        const { error: insertErr } = await supabaseAdmin
          .from('chatbot_prompts')
          .insert({ name: settingsKey, content, is_active: false });
        if (insertErr) throw new Error(`DB insert mislukt: ${insertErr.message}`);
      }

      console.log(`[rag-settings PUT] Saved settings for key=${settingsKey} by user=${user.id}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[rag-settings PUT] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/rag-settings/overrides', async (req, res) => {
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

      const isAllowed = await isStaffAnywhere(user, profile);
      if (!isAllowed) return res.status(403).json({ error: 'Onvoldoende rechten' });

      const { data, error } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('name')
        .like('name', '__rag_settings_%__')
        .neq('name', '__rag_settings_global__');
      if (error) throw new Error(error.message);
      let courseIds = (data || []).map(row => {
        const match = row.name.match(/^__rag_settings_(.+)__$/);
        return match ? match[1] : null;
      }).filter(Boolean);

      // Admin/superuser ziet alle override-cursussen; een docent ziet uitsluitend
      // de override-markers van de cursussen waaraan hij gekoppeld is. Zo lekken
      // andere cursussen niet via deze lijst.
      const isAdminLocal = profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL;
      if (!isAdminLocal) {
        const { data: ownRows } = await supabaseAdmin
          .from('course_members')
          .select('course_id')
          .eq('user_id', user.id)
          .eq('member_role', 'teacher');
        const ownCourseIds = new Set((ownRows || []).map(r => r.course_id));
        courseIds = courseIds.filter(id => ownCourseIds.has(id));
      }
      return res.json({ courseIds });
    } catch (err) {
      console.error('[rag-settings/overrides GET] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/rag-settings/:courseId', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });

    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

    const { courseId } = req.params;
    if (!courseId) return res.status(400).json({ error: 'courseId vereist' });

    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      const { data: profile } = await profileCache.get(user.id, loadProfileRoleEmail);

      const isAllowed = await isStaffForCourse(user, profile, courseId);
      if (!isAllowed) return res.status(403).json({ error: 'Onvoldoende rechten' });

      const settingsKey = `__rag_settings_${courseId}__`;
      const { error: deleteErr } = await supabaseAdmin
        .from('chatbot_prompts')
        .delete()
        .eq('name', settingsKey);

      if (deleteErr) throw new Error(`DB delete mislukt: ${deleteErr.message}`);

      console.log(`[rag-settings DELETE] Removed override for courseId=${courseId} by user=${user.id}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[rag-settings DELETE] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // Diagnose-endpoint: zoek de top-N chunks voor een willekeurige zoekterm,
  // zonder drempel — handig om te kalibreren wat een realistische drempelwaarde is.
  app.post('/api/admin/test-rag-similarity', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });

    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

    const { courseId, query, expand, definition, keyPoints, aliases } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query (zoekterm) is vereist' });
    }

    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      const { data: profile } = await profileCache.get(user.id, loadProfileRoleEmail);

      // Diagnose mag door admin én docent uitgevoerd worden
      // (consistent met /api/rag-settings: zelfde gebruikers die drempels mogen aanpassen,
      // mogen ook diagnoseren waarom bepaalde scores gehaald worden).
      const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
      // Toegestaan: admin/superuser overal; anders docent (member_role='teacher')
      // van de opgegeven cursus.
      if (!isAdmin) {
        if (!courseId) {
          return res.status(403).json({ error: 'Docenten moeten een cursus opgeven om diagnose te draaien' });
        }
        if (!(await isCourseTeacher(user.id, courseId))) {
          return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
        }
      }

      // Bepaal toegestane mappen op basis van cursus (zelfde logica als extract-concepts)
      let allowedFolderIds = null;
      if (courseId) {
        const { data: assignments } = await supabaseAdmin
          .from('course_folder_assignments')
          .select('folder_id')
          .eq('course_id', courseId);

        const assignedFolderIds = (assignments || []).map(a => a.folder_id);
        if (assignedFolderIds.length > 0) {
          const { data: ragFolders } = await supabaseAdmin
            .from('document_folders')
            .select('id')
            .in('id', assignedFolderIds)
            .eq('folder_type', 'rag_sources');
          allowedFolderIds = (ragFolders || []).map(f => f.id);
        } else {
          allowedFolderIds = [];
        }
      }

      // Haal top-N kandidaten op zonder drempel. Wanneer `expand` is meegegeven,
      // wordt de zoekterm verrijkt met de andere namen, kernpunten en definitie van het begrip
      // voordat het embedding-model wordt aangeroepen — handig om de winst van
      // query-uitbreiding direct in de admin-UI te demonstreren.
      const expansion = expand
        ? {
            enabled: true,
            definition: typeof definition === 'string' ? definition : undefined,
            keyPoints: Array.isArray(keyPoints) ? keyPoints : undefined,
            aliases: Array.isArray(aliases) ? aliases : undefined,
          }
        : undefined;
      const result = await searchChunksServerSide(query.trim(), 0, 10, allowedFolderIds, expansion);

      if (!result || !result.matched) {
        return res.json({ query: query.trim(), chunks: [], maxScore: 0 });
      }

      // Verrijk met document-titels
      const chunkDocIds = [...new Set(result.matched.map(c => c.document_id))];
      let docTitleMap = {};
      if (chunkDocIds.length > 0) {
        const { data: docs } = await supabaseAdmin
          .from('documents')
          .select('id, title')
          .in('id', chunkDocIds);
        docTitleMap = Object.fromEntries((docs || []).map(d => [d.id, d.title]));
      }

      return res.json({
        query: query.trim(),
        embedQuery: result.embedQuery || query.trim(),
        expanded: Boolean(expansion),
        maxScore: result.maxScore,
        candidatesInAllowedFolders: result.candidatesInAllowed,
        chunks: result.matched.map(c => ({
          id: c.id,
          documentId: c.document_id,
          documentTitle: docTitleMap[c.document_id] || c.document_title || 'Onbekend',
          similarity: c.similarity,
          contentPreview: (c.content || '').slice(0, 220),
        })),
      });
    } catch (err) {
      console.error('[test-rag-similarity] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/course-rag-folder-ids', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ error: 'Authorization header required' });
    }

    const { courseId } = req.query;
    if (!courseId) {
      return res.status(400).json({ error: 'courseId query parameter is required' });
    }

    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { data: assignments, error: assignError } = await supabaseAdmin
        .from('course_folder_assignments')
        .select('folder_id')
        .eq('course_id', courseId);

      if (assignError) {
        console.error('[course-rag-folder-ids] assignment query error:', assignError);
        return res.status(500).json({ error: assignError.message });
      }

      if (!assignments || assignments.length === 0) {
        return res.json({ ragFolderIds: [] });
      }

      const folderIds = assignments.map((a) => a.folder_id);

      const { data: ragFolders, error: folderError } = await supabaseAdmin
        .from('document_folders')
        .select('id')
        .in('id', folderIds)
        .eq('folder_type', 'rag_sources');

      if (folderError) {
        console.error('[course-rag-folder-ids] folder query error:', folderError);
        return res.status(500).json({ error: folderError.message });
      }

      return res.json({ ragFolderIds: ragFolders?.map((f) => f.id) ?? [] });
    } catch (err) {
      console.error('[course-rag-folder-ids] Unexpected error:', err);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  app.get('/api/rag-enabled-folders', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ error: 'Authorization header required' });
    }

    const { courseId, moduleType } = req.query;

    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { data: callerProfile } = await profileCache.get(user.id, loadProfileRoleEmail);

      const isAdmin = callerProfile?.role === 'admin' || callerProfile?.email === SUPERUSER_EMAIL;

      if (!isAdmin && !courseId) {
        return res.status(403).json({ error: 'courseId is required for non-admin users' });
      }

      let ragFolderIds = [];

      if (courseId) {
        const { data: assignments, error: assignError } = await supabaseAdmin
          .from('course_folder_assignments')
          .select('folder_id')
          .eq('course_id', courseId);

        if (assignError) {
          console.error('[rag-enabled-folders] assignment query error:', assignError);
          return res.status(500).json({ error: assignError.message });
        }

        if (!assignments || assignments.length === 0) {
          return res.json({ folderIds: [] });
        }

        const assignedFolderIds = assignments.map((a) => a.folder_id);

        const { data: ragFolders, error: folderError } = await supabaseAdmin
          .from('document_folders')
          .select('id')
          .in('id', assignedFolderIds)
          .eq('folder_type', 'rag_sources');

        if (folderError) {
          console.error('[rag-enabled-folders] folder query error:', folderError);
          return res.status(500).json({ error: folderError.message });
        }

        ragFolderIds = ragFolders?.map((f) => f.id) ?? [];
      } else {
        const { data: allRagFolders, error: allFolderError } = await supabaseAdmin
          .from('document_folders')
          .select('id')
          .eq('folder_type', 'rag_sources');

        if (allFolderError) {
          console.error('[rag-enabled-folders] all-folders query error:', allFolderError);
          return res.status(500).json({ error: allFolderError.message });
        }

        ragFolderIds = allRagFolders?.map((f) => f.id) ?? [];
      }

      if (ragFolderIds.length === 0) {
        return res.json({ folderIds: [] });
      }

      if (moduleType) {
        const { data: ragAssignments, error: ragAssignError } = await supabaseAdmin
          .from('folder_rag_assignments')
          .select('folder_id')
          .in('folder_id', ragFolderIds)
          .eq('module_type', moduleType)
          .eq('is_active', true);

        if (ragAssignError) {
          console.error('[rag-enabled-folders] rag_assignments query error:', ragAssignError);
          return res.status(500).json({ error: ragAssignError.message });
        }

        if (ragAssignments && ragAssignments.length > 0) {
          return res.json({ folderIds: ragAssignments.map((a) => a.folder_id) });
        }
      }

      return res.json({ folderIds: ragFolderIds });
    } catch (err) {
      console.error('[rag-enabled-folders] Unexpected error:', err);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  app.get('/api/folder-type', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ error: 'Authorization header required' });
    }

    const { folderId } = req.query;
    if (!folderId) {
      return res.status(400).json({ error: 'folderId query parameter is required' });
    }

    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const { data: folder, error: folderError } = await supabaseAdmin
        .from('document_folders')
        .select('folder_type')
        .eq('id', folderId)
        .maybeSingle();

      if (folderError) {
        console.error('[folder-type] query error:', folderError);
        return res.status(500).json({ error: folderError.message });
      }

      return res.json({ folderType: folder?.folder_type ?? null });
    } catch (err) {
      console.error('[folder-type] Unexpected error:', err);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // Zoeken in twee talen (server/rag/crossLingual.js): vraag vertalen naar de taal van het materiaal.
  registerCrossLingualRoute(app, {
    pgPool, requireAuthUser, userHasCourseAccess,
    translate: async (messages) => {
      const r = await openaiChatCompletion({ model: OPENAI_MODEL, messages, ...chatModelParams({ temperature: 0, maxTokens: 200 }) }, { timeoutMs: 15000 });
      if (!r.ok) throw new Error('Taalmodel-fout ' + r.status);
      const j = await r.json();
      return j.choices?.[0]?.message?.content || '';
    },
  });
}
