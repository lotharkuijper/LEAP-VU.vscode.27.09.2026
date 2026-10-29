import { registerDesignAssistantRoutes } from './designAssistant.js';
import { buildLanguageInstruction, normalizeLang } from '../i18n/languages.js';
import {
  authUser,
  isLeapAdmin,
  isStaffForCourse,
  loadProfileRoleEmail,
  profileCache,
  requireAuthUser,
  userCache,
} from '../lib/auth.js';
import {
  AZURE_CHAT_READY,
  AZURE_EMBEDDINGS_READY,
  LLM_NOT_CONFIGURED_MSG,
  OPENAI_MODEL,
  chatModelParams,
  openaiChatCompletion,
} from '../lib/azureOpenai.js';
import { PORT } from '../lib/serverUrls.js';
import { SUPERUSER_EMAIL, supabaseAdmin } from '../lib/supabase.js';
import { registerMyDataRoutes } from '../account/myData.js';
import { registerSystemMessageRoutes } from './systemMessages.js';

export function registerSystemRoutes(app) {
  app.get('/api/admin/backfill-project-doc-folder-links/status', (_req, res) => {
    return res.json({ status: null });
  });

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      azure: AZURE_CHAT_READY,
      azureEmbeddings: AZURE_EMBEDDINGS_READY,
      openai: !!process.env.OPENAI_API_KEY,
      github: !!process.env.GITHUB_TOKEN,
      supabase: !!process.env.SUPABASE_URL,
    });
  });

  // Mijn gegevens: eigen gegevens downloaden en het eigen account verwijderen (server/myData.js).
  registerMyDataRoutes(app, {
    supabaseAdmin,
    authUser,
    getProfile: async (id) => (await profileCache.get(id, loadProfileRoleEmail)).data,
    superuserEmail: SUPERUSER_EMAIL,
    onDeleted: (id) => { userCache.forgetUser(id); profileCache.invalidate(id); },
  });

  // Ontwerphulp: optionele chatbot voor docenten in het beheer (server/designAssistant.js).
  // Systeemberichten van de beheerder op het Dashboard (server/systemMessages.js).
  registerSystemMessageRoutes(app, { supabaseAdmin, requireAuthUser, isLeapAdmin });

  registerDesignAssistantRoutes(app, {
    supabaseAdmin,
    authUser,
    getProfile: (id) => profileCache.get(id, loadProfileRoleEmail),
    isStaffForCourse,
    isAdminProfile: (p) => !!p && (p.role === 'admin' || p.email === SUPERUSER_EMAIL),
    buildLanguageInstruction,
    normalizeLang,
    apiBase: () => `http://127.0.0.1:${PORT}`,
    chat: async (messages) => {
      if (!AZURE_CHAT_READY) throw new Error(LLM_NOT_CONFIGURED_MSG);
      const r = await openaiChatCompletion({
        model: OPENAI_MODEL,
        messages,
        ...chatModelParams({ temperature: 0.4, maxTokens: 3000 }),
      }, { timeoutMs: 120000 });
      if (!r.ok) throw new Error(`Taalmodel-fout (${r.status})`);
      return ((await r.json()).choices?.[0]?.message?.content || '').trim();
    },
  });
}
