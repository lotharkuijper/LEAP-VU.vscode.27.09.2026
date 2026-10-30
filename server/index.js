// Loads .env before any other module reads process.env at import time.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { installAnalytics } from './analytics/index.js';
import { registerAuthEmailHook } from './account/authEmailHook.js';
import { resolveSofficeBin } from './documents/documentRender.js';
import { registerEnrollmentRoutes } from './courses/enrollment.js';
import { normalizeLang } from './i18n/languages.js';
import { applyHttpSecurity } from './lib/httpSecurity.js';
import { authUser, isLeapAdmin, isStaffForCourse, requireAuthUser } from './lib/auth.js';
import {
  AZURE_CHAT_READY,
  AZURE_EMBEDDINGS_READY,
  AZURE_OPENAI_API_VERSION,
  AZURE_OPENAI_DEPLOYMENT,
  AZURE_OPENAI_EMBEDDING_API_VERSION,
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
  OPENAI_MODEL,
} from './lib/azureOpenai.js';
import {
  detectConceptEvidenceSchema,
  detectConceptsCourseIdColumn,
  detectCoursesStudentVisibleColumn,
  detectDocumentsContentHash,
  detectQuizAttemptsSchema,
  detectQuizSourcesSchema,
  detectWebSources,
} from './lib/schemaFlags.js';
import { PORT, resolveAppBaseUrl } from './lib/serverUrls.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, SUPERUSER_EMAIL, supabaseAdmin } from './lib/supabase.js';
import { escapeHtml, getEmailConfig, sendEmail } from './lib/notifications.js';
import { initChatbotPromptSection, initQuizPromptDefaults } from './prompts/promptStore.js';
import { serverI18nMiddleware } from './i18n/serverI18n.js';
import { scheduleOrphanCourseAccessCleanup } from './studiecafe/studiecafe.js';
import {
  DIGEST_INTERVAL_MS,
  READS_CLEANUP_INTERVAL_MS,
  runOrphanThreadReadsCleanupOnce,
  runStudiecafeDigestOnce,
} from './studiecafe/digest.js';
import { installTokenBudget } from './account/tokenBudget.js';
import { registerChatRoutes } from './chat/routes.js';
import { registerRagRoutes } from './rag/routes.js';
import { registerItembankRoutes } from './quiz/itembankRoutes.js';
import { registerDocumentRoutes } from './documents/routes.js';
import { registerCourseRoutes } from './courses/routes.js';
import { registerIngestionRoutes } from './ingestion/routes.js';
import { registerConceptRoutes } from './concepts/routes.js';
import { registerStudiecafe } from './studiecafe/routes.js';
import { registerJournalRoutes } from './journal/routes.js';
import { registerExplainRoutes } from './explain/routes.js';
import { registerQuizRoutes } from './quiz/routes.js';
import { registerProjectRoomRoutes } from './projects/roomRoutes.js';
import { registerPromptRoutes } from './prompts/routes.js';
import { registerSystemRoutes } from './system/routes.js';
import { registerProjectRoutes } from './projects/groupRoutes.js';
import { registerProjectPersonaRoutes } from './projects/personaRoutes.js';
import { registerProjectDocumentRoutes } from './projects/documentRoutes.js';
import { registerCanvasRoutes } from './lti/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Proxy trust, CORS limited to the app's own origin, safe default headers.
applyHttpSecurity(app);

// Account-e-mails bij hosting op Azure (zie server/account/authEmailHook.js). Staat
// vóór express.json(): de handtekening gaat over de onbewerkte body.
registerAuthEmailHook(app, express, {
  secret: process.env.AUTH_EMAIL_HOOK_SECRET,
  supabaseUrl: process.env.VITE_PUBLIC_SUPABASE_URL,
  appUrl: () => resolveAppBaseUrl(),
  getLang: async (userId) => {
    if (!supabaseAdmin) return null;
    const { data } = await supabaseAdmin.from('profiles').select('preferred_lang').eq('id', userId).maybeSingle();
    return data && data.preferred_lang ? normalizeLang(data.preferred_lang) : null;
  },
  getEmailConfig,
  sendEmail,
});

// 50mb i.p.v. 10mb: RAG-bronnen én de Documenten-tab uploaden bestanden als
// base64 in de JSON-body naar de service-role upload-endpoints. base64 zwelt ~33%
// op, dus 10mb kapte bestanden >~7,5MB af (bv. beeldrijke college-PPTX/PDF die
// vroeger via een directe client-storage-upload wél werkten). 50mb sluit aan op de
// gangbare Supabase per-bestand storage-limiet en voorkomt die regressie.
app.use(express.json({ limit: '50mb' }));

// Meldingen (error/message/…) in JSON-responsen vertalen naar de taal van de
// gebruiker (header X-LEAP-Lang). Zie server/i18n/serverI18n.js.
app.use(serverI18nMiddleware);

// Analytics: geaggregeerde tellers, losse module (zie server/analytics/index.js).
// Staat vóór de routes zodat de meting elk /api-verzoek ziet.
installAnalytics(app, { getDb: () => supabaseAdmin, authUser, isStaffForCourse, isLeapAdmin });

// Tokenbudget voor accounts uit open registratie (server/account/tokenBudget.js): meet het
// verbruik per open account en houdt AI-verzoeken tegen boven de dag-/weeklimiet
// of de noodrem voor alle open accounts samen. Andere accounts merken er niets van.
const tokenBudget = installTokenBudget(app, {
  getDb: () => supabaseAdmin,
  getUser: async (authHeader) => (await authUser({ headers: { authorization: authHeader } })).user || null,
  requireAdmin: async (req, res) => {
    const a = await requireAuthUser(req, res);
    if (!a) return null;
    if (!isLeapAdmin(a.profile)) { res.status(403).json({ error: 'Alleen voor de beheerder' }); return null; }
    return a.user;
  },
  sendAlert: async ({ subject, text }) => {
    const cfg = await getEmailConfig();
    if (!cfg) return;
    const { data: admins } = await supabaseAdmin.from('profiles').select('email').eq('role', 'admin');
    for (const a of admins || []) {
      if (a.email) await sendEmail(cfg, { to: a.email, subject, text, html: `<p>${escapeHtml(text)}</p>` });
    }
  },
});

registerChatRoutes(app);

registerRagRoutes(app);

registerItembankRoutes(app);

registerDocumentRoutes(app);

registerCourseRoutes(app);

registerIngestionRoutes(app);

registerConceptRoutes(app);

registerStudiecafe(app);

registerJournalRoutes(app);

registerExplainRoutes(app);

registerQuizRoutes(app);

registerProjectRoomRoutes(app);

registerPromptRoutes(app);

registerSystemRoutes(app);

registerProjectRoutes(app);

registerProjectPersonaRoutes(app);

registerProjectDocumentRoutes(app);

// Toegangsroute per cursus en open registratie (server/courses/enrollment.js).
registerEnrollmentRoutes(app, {
  supabaseAdmin,
  createAnonClient: () => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } }),
  requireAuthUser,
  isAdminProfile: (p) => !!p && (p.role === 'admin' || p.email === SUPERUSER_EMAIL),
  appOrigin: (req) => process.env.APP_PUBLIC_URL || process.env.APP_BASE_URL || req.get('origin') || `${req.protocol}://${req.get('host')}`,
  onOpenRegistration: (userId) => tokenBudget.markOpenAccount(userId),
});

registerCanvasRoutes(app);

// Serveer de gebouwde Vite-frontend als dist/index.html bestaat (productie).
const distPath = path.join(__dirname, '..', 'dist');

if (fs.existsSync(path.join(distPath, 'index.html'))) {
  app.use(express.static(distPath));
  app.get('/*splat', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// In de testomgeving importeren we de app zonder de poort te openen of de
// schema-detectie/seeding te draaien; integratietests mounten `app` zelf op een
// efemere poort (zie server/__tests__/chatEndpoint.test.js).
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[API Server] Running on port ${PORT}`);
    console.log(`[API Server] Chat-model: ${OPENAI_MODEL}`);
    if (AZURE_CHAT_READY) {
      console.log(`[API Server] Chat-provider: Azure OpenAI (deployment=${AZURE_OPENAI_DEPLOYMENT}, api-version=${AZURE_OPENAI_API_VERSION})`);
    } else {
      console.warn('[API Server] Azure OpenAI NIET geconfigureerd (AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY) — chat-endpoints geven 503 tot dit is ingesteld.');
    }
    if (AZURE_EMBEDDINGS_READY) {
      console.log(`[API Server] Embedding-provider: Azure OpenAI (deployment=${AZURE_OPENAI_EMBEDDING_DEPLOYMENT}, api-version=${AZURE_OPENAI_EMBEDDING_API_VERSION})`);
    } else {
      console.warn('[API Server] Azure-embeddings NIET geconfigureerd (AZURE_OPENAI_EMBEDDING_DEPLOYMENT ontbreekt) — RAG/ingestie/concept-extractie geven 503 tot dit is ingesteld. Géén terugval naar publieke OpenAI.');
    }
    detectConceptsCourseIdColumn();
    detectCoursesStudentVisibleColumn();
    detectQuizAttemptsSchema();
    detectQuizSourcesSchema();
    detectConceptEvidenceSchema();
    detectDocumentsContentHash();
    detectWebSources();
    {
      // Documentviewer (docx/pptx → pdf) en paginanummers bij Word-bronnen hebben
      // LibreOffice nodig; zonder valt de viewer terug op alleen tekst.
      const bin = resolveSofficeBin();
      // Op Windows staat LibreOffice nooit in het PATH: alleen een gevonden
      // absoluut pad telt. Elders (Replit/Linux) gaan we uit van het PATH.
      const ok = path.isAbsolute(bin) ? fs.existsSync(bin) : process.platform !== 'win32';
      console.log(`[API Server] LibreOffice: ${bin}${ok ? '' : ' — NIET GEVONDEN: viewer toont Office-bestanden alleen als tekst, geen paginanummers bij Word-bronnen'}`);
    }
    initChatbotPromptSection();
    // Wacht kort tot promptsHasSection geinitialiseerd is alvorens quiz-prompts
    // aan te maken (initChatbotPromptSection draait async).
    setTimeout(() => { initQuizPromptDefaults(); }, 2000);
    // Studiecafé digest-worker (Task #311): periodiek meldingen batchen + mailen.
    const digestTimer = setInterval(() => {
      runStudiecafeDigestOnce().catch((e) => console.warn('[studiecafe-digest] cyclus mislukt:', e.message));
    }, DIGEST_INTERVAL_MS);
    if (typeof digestTimer.unref === 'function') digestTimer.unref();
    // Studiecafé wees-leesmarkering-opruimer (Task #323): periodiek read-rijen
    // verwijderen van studenten die geen toegang meer hebben tot de cursus.
    // Eénmaal kort na startup en daarna op interval. De wiring (startvertraging +
    // interval + overlap-gate) zit in `scheduleOrphanCourseAccessCleanup` zodat ze
    // los van deze listen-callback met nep-timers getest kan worden (Task #339).
    scheduleOrphanCourseAccessCleanup({
      runOnce: runOrphanThreadReadsCleanupOnce,
      intervalMs: READS_CLEANUP_INTERVAL_MS,
    });
  });
}

export { app };
