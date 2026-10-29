import { createClient } from '@supabase/supabase-js';
import { registerCourseFilesRoutes } from './courseFiles.js';
import {
  CONVERT_TO_PDF_EXT,
  NATIVE_PDF_EXT,
  TEXT_EXT,
  convertOfficeToPdf,
  normalizeExt,
  queueConversion,
  renditionCachePath,
  renditionSourceKey,
  renditionSourceType,
} from './documentRender.js';
import { computeTeacherFolderScope } from '../rag/documentScope.js';
import {
  CONTENT_TRANSLATE_MAX_TOTAL_CHARS,
  MAX_SOURCE_CHARS as TRANSLATION_MAX_SOURCE_CHARS,
  buildContentBatchPrompt,
  buildContentTranslationPrompt,
  buildTranslationPrompt,
  createSlidingWindowLimiter,
  hashContentSource,
  hashSource,
  isTranslatableText,
  normalizeContentFormat,
  normalizePageKey,
  normalizeSourceText,
  normalizeTargetLang,
} from './documentTranslation.js';
import { ensureCourseRagFolder, processRagDocumentById, storeRendition } from '../ingestion/pipeline.js';
import {
  isStaffForCourse,
  loadProfileRoleEmail,
  profileCache,
  requireAuthUser,
  resolveAdminUser,
  userCache,
  userHasCourseAccess,
} from '../lib/auth.js';
import {
  AZURE_CHAT_READY,
  LLM_NOT_CONFIGURED_MSG,
  OPENAI_MODEL,
  chatModelParams,
  openaiChatCompletion,
} from '../lib/azureOpenai.js';
import { webSourcesAvailable } from '../lib/schemaFlags.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, SUPERUSER_EMAIL, pgPool, supabaseAdmin } from '../lib/supabase.js';
import { getFileMimeType, parseOfficeAsync } from '../lib/uploads.js';
import { createProjectDocumentFromBuffer } from '../projects/projectFiles.js';
import { loadViewableDocument } from './viewableDocument.js';

// Task #335: docenten mogen alleen bij documenten van HUN cursus(sen). De admin-
// endpoints gebruiken supabaseAdmin (service-role) en bypassen dus RLS — daarom
// scopen we hier expliciet op applicatieniveau. (Het oude mappenscherm
// /admin/documenten is op 2026-10-15 verwijderd; Cursusmateriaal werkt met doelen.) getTeacherDocumentScope levert de set
// folder-ids binnen de eigen-cursus-subbomen van de docent.
//
// Beveiliging (zie architect-review): we breiden de scope NOOIT uit naar een
// 'course'-shell tenzij die ouder écht folder_type='course' én niet is_root is.
// Zo kan een (foutieve) course_folder_assignments-rij waarvan de ouder de globale
// root is nooit alle mappen ontsluiten. Bij fouten: fail-closed (lege scope).
async function getTeacherDocumentScope(userId) {
  const result = { folderIds: new Set() };
  if (!userId || !supabaseAdmin) return result;
  try {
    const { data: memberships } = await supabaseAdmin
      .from('course_members')
      .select('course_id')
      .eq('user_id', userId)
      .eq('member_role', 'teacher');
    const courseIds = [...new Set((memberships || []).map((m) => m.course_id).filter(Boolean))];
    if (!courseIds.length) return result;

    const { data: assigns } = await supabaseAdmin
      .from('course_folder_assignments')
      .select('folder_id')
      .in('course_id', courseIds);
    const assignedFolderIds = [...new Set((assigns || []).map((a) => a.folder_id).filter(Boolean))];
    if (!assignedFolderIds.length) return result;

    const { data: allFolders } = await supabaseAdmin
      .from('document_folders')
      .select('id, parent_folder_id, folder_type, is_root');
    result.folderIds = computeTeacherFolderScope(assignedFolderIds, allFolders || []);
    return result;
  } catch (err) {
    console.error('[getTeacherDocumentScope] fout:', err?.message || err);
    return result;
  }
}

// Bepaalt of de resolveAdminUser-uitkomst toegang heeft tot één map: admin altijd,
// docent alleen binnen de eigen-cursus-scope. Fail-closed bij ontbrekende folderId.
async function resolveDocFolderAccess(r, folderId) {
  if (r.isAdmin) return true;
  if (!r.isDocent || !folderId) return false;
  const scope = await getTeacherDocumentScope(r.user.id);
  return scope.folderIds.has(folderId);
}

// POST /api/translate-content — generieke vertaling van door docenten/admins
// geschreven, student-zichtbare DB-tekst (cursusinfo-body, projectbriefing,
// persona-namen, begrip-namen/categorieën, …). Content-agnostisch: cachet per
// (bron-hash, doeltaal) in content_translations zodat identieke tekst over
// schermen heen één keer per taal wordt betaald. Vereist een ingelogde gebruiker.
// Body: { items: [{ key, text, format? }], targetLang }. Antwoord:
// { translations: { [key]: vertaalde_tekst } } — alleen succesvol vertaalde keys.
// Per-item falen → key weggelaten (client valt stil terug op het origineel).
const CONTENT_TRANSLATE_MAX_ITEMS = 50;

const CONTENT_BATCH_INLINE_MAX_CHARS = 1500;
 // langer dan dit → eigen LLM-call
const CONTENT_BATCH_MAX_ITEMS = 25;
          // max korte fragmenten per JSON-call
const CONTENT_BATCH_MAX_CHARS = 6000;
        // max totale bron-tekens per JSON-call

// Per-gebruiker rate limit (Task #289): bescherming tegen een ingelogde
// gebruiker die het endpoint in een lus aanroept met willekeurige tekst en zo
// de Azure-kosten opdrijft + de gedeelde cache opblaast. Ruim genoeg voor
// normale paginanavigatie (elke pagina bundelt al tot 50 fragmenten in één
// call), maar een strakke lus loopt snel tegen de limiet aan. In-memory →
// per Express-proces; bij horizontale schaling is een gedeelde store nodig.
const CONTENT_TRANSLATE_RATE_WINDOW_MS = 60_000;

const CONTENT_TRANSLATE_RATE_MAX = 60;

const contentTranslateLimiter = createSlidingWindowLimiter({
  windowMs: CONTENT_TRANSLATE_RATE_WINDOW_MS,
  max: CONTENT_TRANSLATE_RATE_MAX,
});

// Periodieke opschoning van inactieve sleutels (voorkomt geheugengroei).
setInterval(() => contentTranslateLimiter.sweep(), CONTENT_TRANSLATE_RATE_WINDOW_MS).unref?.();

// Vertaal één content-fragment (markdown of lange plain) in een losse call.
async function translateContentOne(text, targetLang, format) {
  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: buildContentTranslationPrompt(targetLang, format) },
      { role: 'user', content: text },
    ],
    ...chatModelParams({ temperature: 0.2, maxTokens: 4000 }),
  };
  const resp = await openaiChatCompletion(body);
  const data = await resp.json();
  if (!resp.ok) {
    console.warn(`[translate-content] LLM-status ${resp.status} (${format}->${targetLang})`);
    return null;
  }
  const out = data?.choices?.[0]?.message?.content?.trim();
  return out || null;
}

// Vertaal een groepje korte plain-fragmenten in één JSON-mode call.
// `items` = [{ hash, text }] (uniek per hash). Geeft Map hash->vertaling.
async function translateContentBatch(items, targetLang) {
  const out = new Map();
  if (!items.length) return out;
  const idToHash = new Map();
  const payload = {};
  items.forEach((it, i) => {
    const id = `t${i}`;
    idToHash.set(id, it.hash);
    payload[id] = it.text;
  });
  const callOnce = async () => {
    const body = {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: buildContentBatchPrompt(targetLang) },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      response_format: { type: 'json_object' },
      ...chatModelParams({ temperature: 0.2, maxTokens: 4000 }),
    };
    const resp = await openaiChatCompletion(body);
    const data = await resp.json();
    if (!resp.ok) {
      console.warn(`[translate-content] batch LLM-status ${resp.status} (->${targetLang})`);
      return null;
    }
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    try { return JSON.parse(content); } catch { return null; }
  };
  let parsed = await callOnce();
  if (!parsed || typeof parsed !== 'object') parsed = await callOnce(); // 1 retry
  if (!parsed || typeof parsed !== 'object') return out;
  for (const [id, hash] of idToHash) {
    const v = parsed[id];
    if (typeof v === 'string' && v.trim()) out.set(hash, v.trim());
  }
  return out;
}

export function registerDocumentRoutes(app) {
  // GET /api/rag/documents/:documentId/download — student/docent-vriendelijke
  // download van een RAG-bron. Toegang volgt dezelfde folder_permissions-regels
  // als de RAG-zoek: rol moet can_view hebben op de folder van het document.
  app.get('/api/rag/documents/:documentId/download', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const role = auth.profile?.role || 'student';
    const isAdmin = role === 'admin' || auth.profile?.email === SUPERUSER_EMAIL;
    const { documentId } = req.params;
    try {
      const { data: doc } = await supabaseAdmin
        .from('documents')
        .select('id, title, filename, file_path, bucket, mime_type, file_type, folder_id')
        .eq('id', documentId)
        .maybeSingle();
      if (!doc) return res.status(404).json({ error: `Document niet gevonden (id=${documentId}). De RAG-chunk verwijst mogelijk naar een verwijderd document — synchroniseer de RAG-index opnieuw.` });
      // Alleen RAG-bron documenten via deze route serveren.
      if (doc.bucket && doc.bucket !== 'rag_sources') {
        return res.status(403).json({ error: 'Dit document is geen RAG-bron.' });
      }
      if (!isAdmin) {
        if (!doc.folder_id) return res.status(403).json({ error: 'Geen toegang tot dit document.' });
        const { data: perm } = await supabaseAdmin
          .from('folder_permissions')
          .select('can_view')
          .eq('folder_id', doc.folder_id)
          .eq('role', role)
          .maybeSingle();
        if (!perm?.can_view) return res.status(403).json({ error: 'Geen toegang tot dit document.' });
      }
      const filename = String(doc.filename || doc.title || 'download').replace(/[\r\n"]/g, '_');
      // Web-bron (Task #234): geen renderbaar/bewaard bestand, maar een externe
      // URL. Geef die als JSON terug zodat de frontend de pagina in een tab opent.
      if ((doc.file_type || '').toLowerCase() === 'web' && doc.file_path) {
        return res.json({ url: doc.file_path, filename });
      }
      const mimeType = doc.mime_type || getFileMimeType((doc.file_type || '').toLowerCase());
      if (!doc.file_path && pgPool) {
        const result = await pgPool.query(
          'SELECT file_bytes, mime_type FROM documents WHERE id = $1',
          [documentId]
        );
        const row = result.rows[0];
        if (row?.file_bytes) {
          const resolvedMime = row.mime_type || mimeType;
          res.setHeader('Content-Type', resolvedMime);
          res.setHeader('Content-Length', row.file_bytes.length);
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          return res.end(row.file_bytes);
        }
      }
      if (doc.file_path && doc.bucket) {
        const { data: signed, error: signErr } = await supabaseAdmin.storage
          .from(doc.bucket)
          .createSignedUrl(doc.file_path, 120);
        if (signErr || !signed?.signedUrl) {
          return res.status(500).json({ error: 'Kon geen downloadlink aanmaken.' });
        }
        // De client kan een Bearer-token niet via een gewone <a href> meesturen.
        // Daarom geven we JSON met een tijdelijk getekende URL terug zodat de
        // frontend deze in een nieuw tabblad kan openen.
        return res.json({ url: signed.signedUrl, filename });
      }
      return res.status(404).json({ error: 'Dit document heeft geen downloadbaar bestand.' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/rag/documents/:documentId/view — bekijkbare versie voor de in-app
  // documentviewer (Task #209). Zelfde toegangscontrole als de download-route.
  // - pdf        → signed URL van het origineel
  // - docx/pptx  → gecachte PDF-rendition (LibreOffice headless), signed URL
  // - txt/md     → platte tekst inline
  app.get('/api/rag/documents/:documentId/view', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const loaded = await loadViewableDocument(req, res);
    if (!loaded) return;
    const { doc } = loaded;
    const { documentId } = req.params;
    try {
      const title = String(doc.title || doc.filename || 'document');
      // Web-bron (Task #234): geen renderbaar bestand — geef de externe URL terug
      // zodat de viewer een link toont in plaats van te proberen te renderen.
      if ((doc.file_type || '').toLowerCase() === 'web' && doc.file_path) {
        return res.json({ kind: 'url', title, sourceType: 'web', url: doc.file_path });
      }
      const ext = normalizeExt(doc.file_type || (doc.filename || '').split('.').pop());

      // Bronbytes ophalen uit storage (file_path) of uit de DB (file_bytes).
      const loadSourceBytes = async () => {
        if (doc.file_path && doc.bucket) {
          const { data, error } = await supabaseAdmin.storage.from(doc.bucket).download(doc.file_path);
          if (error || !data) throw new Error('Kon bronbestand niet ophalen uit de opslag.');
          return Buffer.from(await data.arrayBuffer());
        }
        if (pgPool) {
          const result = await pgPool.query('SELECT file_bytes FROM documents WHERE id = $1', [documentId]);
          const row = result.rows[0];
          if (row?.file_bytes) return row.file_bytes;
        }
        throw new Error('Dit document heeft geen bestand om te tonen.');
      };

      if (TEXT_EXT.has(ext)) {
        const bytes = await loadSourceBytes();
        return res.json({ kind: 'text', title, sourceType: ext, text: bytes.toString('utf-8') });
      }

      if (NATIVE_PDF_EXT.has(ext)) {
        if (!doc.file_path || !doc.bucket) {
          return res.status(404).json({ error: 'PDF-bestand niet beschikbaar voor weergave.' });
        }
        const { data: signed, error: signErr } = await supabaseAdmin.storage
          .from(doc.bucket)
          .createSignedUrl(doc.file_path, 600);
        if (signErr || !signed?.signedUrl) {
          return res.status(500).json({ error: 'Kon geen weergavelink aanmaken.' });
        }
        return res.json({ kind: 'pdf', title, sourceType: 'pdf', url: signed.signedUrl });
      }

      if (CONVERT_TO_PDF_EXT.has(ext)) {
        const bucket = doc.bucket || 'rag_sources';
        // Cache-sleutel volgt het bronbestand: een vervangen bron (nieuw
        // file_path) krijgt een verse rendition. Normaal is die al bij het
        // inlezen gemaakt; ontbreekt hij, dan maken we hem nu eenmalig.
        const renditionPath = renditionCachePath(documentId, renditionSourceKey(doc));
        let signed = (await supabaseAdmin.storage.from(bucket).createSignedUrl(renditionPath, 600)).data;
        if (!signed?.signedUrl) {
          // Nog geen rendition in cache — eenmalig converteren en opslaan.
          const sourceBytes = await loadSourceBytes();
          let pdfBuffer;
          try {
            pdfBuffer = await queueConversion(() => convertOfficeToPdf(sourceBytes, ext));
          } catch (convErr) {
            // Conversie onmogelijk (bv. geen LibreOffice op deze server): toon de
            // leesbare tekst i.p.v. een fout, zodat studenten de bron altijd in de
            // app kunnen bekijken zonder te downloaden.
            console.error('[view] PDF-weergave niet mogelijk, val terug op tekstweergave:', convErr.message);
            const text = await parseOfficeAsync(sourceBytes).catch(() => '');
            if (!text.trim()) throw convErr;
            return res.json({ kind: 'text', title, sourceType: renditionSourceType(ext), text, fallback: true });
          }
          try {
            await storeRendition({ ...doc, id: documentId }, pdfBuffer);
          } catch {
            return res.status(500).json({ error: 'Kon de weergaveversie niet opslaan.' });
          }
          signed = (await supabaseAdmin.storage.from(bucket).createSignedUrl(renditionPath, 600)).data;
          if (!signed?.signedUrl) return res.status(500).json({ error: 'Kon geen weergavelink aanmaken.' });
        }
        const sourceType = renditionSourceType(ext);
        return res.json({ kind: 'pdf', title, sourceType, url: signed.signedUrl });
      }

      return res.status(415).json({
        error: 'Dit bestandstype kan niet in de viewer worden getoond. Download het bestand in plaats daarvan.',
      });
    } catch (err) {
      // Interne details (incl. LibreOffice-stderr) niet naar de client lekken;
      // wel volledig serverside loggen voor debugging.
      console.error('[view] documentweergave mislukt:', err);
      return res.status(500).json({ error: 'Kon het document niet voorbereiden voor weergave.' });
    }
  });

  // POST /api/rag/documents/:documentId/translate — vertaalt op aanvraag een stuk
  // reeds-geëxtraheerde bron-tekst (door de client uit de huidige pagina/dia
  // gehaald) naar een doeltaal en cachet het resultaat per (document, eenheid,
  // taal, bron-hash). Zelfde toegangscontrole als /view; fail-closed zonder Azure.
  app.post('/api/rag/documents/:documentId/translate', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
    const loaded = await loadViewableDocument(req, res);
    if (!loaded) return;
    const { documentId } = req.params;

    const targetLang = normalizeTargetLang(req.body?.targetLang);
    if (!targetLang) return res.status(400).json({ error: 'Onbekende doeltaal.' });
    const pageKey = normalizePageKey(req.body?.pageKey);
    if (!pageKey) return res.status(400).json({ error: 'Ongeldige pagina-aanduiding.' });
    const text = normalizeSourceText(typeof req.body?.text === 'string' ? req.body.text : '');
    if (!text) return res.status(400).json({ error: 'Geen tekst om te vertalen.' });
    if (text.length > TRANSLATION_MAX_SOURCE_CHARS) {
      return res.status(413).json({ error: 'Tekstfragment te groot om te vertalen.' });
    }
    const sourceType = typeof req.body?.sourceType === 'string' ? req.body.sourceType : '';
    const sourceHash = hashSource(text);

    try {
      // Cache-hit? (service-role: deze tabel heeft bewust geen client-leesbeleid).
      const { data: cached } = await supabaseAdmin
        .from('document_translations')
        .select('translated_text')
        .eq('document_id', documentId)
        .eq('page_key', pageKey)
        .eq('target_lang', targetLang)
        .eq('source_hash', sourceHash)
        .maybeSingle();
      if (cached?.translated_text) {
        return res.json({ translated: cached.translated_text, cached: true, targetLang });
      }

      const body = {
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: buildTranslationPrompt(targetLang, sourceType) },
          { role: 'user', content: text },
        ],
        ...chatModelParams({ temperature: 0.2, maxTokens: 4000 }),
      };
      const resp = await openaiChatCompletion(body);
      const data = await resp.json();
      if (!resp.ok) {
        console.warn(`[translate] LLM-status ${resp.status} voor doc ${documentId} ${pageKey}->${targetLang}`);
        return res.status(502).json({ error: 'Vertaling mislukt.' });
      }
      const translated = data?.choices?.[0]?.message?.content?.trim();
      if (!translated) return res.status(502).json({ error: 'Vertaling leeg.' });

      // Persist (idempotent op de unique-constraint).
      await supabaseAdmin
        .from('document_translations')
        .upsert(
          { document_id: documentId, page_key: pageKey, target_lang: targetLang, source_hash: sourceHash, translated_text: translated },
          { onConflict: 'document_id,page_key,target_lang,source_hash' },
        );

      return res.json({ translated, cached: false, targetLang });
    } catch (err) {
      console.error('[translate] vertaling mislukt:', err);
      return res.status(500).json({ error: 'Kon de vertaling niet maken.' });
    }
  });

  app.post('/api/translate-content', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const auth = await requireAuthUser(req, res);
    if (!auth) return; // requireAuthUser stuurde zelf al 401/503

    // Per-gebruiker rate limit: stopt een lus met willekeurige tekst voordat hij
    // Azure-kosten maakt of cache-rijen aanmaakt.
    const rl = contentTranslateLimiter.check(auth.user.id);
    if (!rl.allowed) {
      const retryAfter = Math.ceil(rl.retryAfterMs / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Te veel vertaalverzoeken. Probeer het zo opnieuw.' });
    }

    const targetLang = normalizeTargetLang(req.body?.targetLang);
    if (!targetLang) return res.status(400).json({ error: 'Onbekende doeltaal.' });

    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (rawItems.length === 0) return res.json({ translations: {} });
    if (rawItems.length > CONTENT_TRANSLATE_MAX_ITEMS) {
      return res.status(413).json({ error: 'Te veel fragmenten in één aanvraag.' });
    }

    // Normaliseer items en bepaal wat daadwerkelijk vertaald moet worden.
    // nl-doeltaal en niet-vertaalbare/te lange tekst → overslaan (key weggelaten,
    // client toont origineel). Dit gebeurt VÓÓR de Azure-check, zodat een
    // nl-gebruiker nooit een 503 krijgt.
    const translations = {};
    const needs = [];
    let totalChars = 0;
    for (const raw of rawItems) {
      const key = typeof raw?.key === 'string' ? raw.key : null;
      if (!key) continue;
      const format = normalizeContentFormat(raw?.format);
      const text = normalizeSourceText(typeof raw?.text === 'string' ? raw.text : '');
      if (targetLang === 'nl') continue;
      if (!isTranslatableText(text)) continue;
      if (text.length > TRANSLATION_MAX_SOURCE_CHARS) continue;
      // Totale-tekens-cap: voorkomt dat één call tientallen maximale fragmenten
      // bundelt en zo de Azure-kosten opdrijft.
      totalChars += text.length;
      if (totalChars > CONTENT_TRANSLATE_MAX_TOTAL_CHARS) {
        return res.status(413).json({ error: 'Te veel tekst in één aanvraag.' });
      }
      needs.push({ key, format, text, hash: hashContentSource(text, format) });
    }
    if (needs.length === 0) return res.json({ translations });

    try {
      // Cache-first (service-role; tabel heeft bewust geen client-leesbeleid).
      const hashes = [...new Set(needs.map(n => n.hash))];
      const { data: cachedRows } = await supabaseAdmin
        .from('content_translations')
        .select('source_hash, translated_text')
        .in('source_hash', hashes)
        .eq('target_lang', targetLang);
      const cacheMap = new Map((cachedRows || []).map(r => [r.source_hash, r.translated_text]));
      const misses = [];
      for (const n of needs) {
        const hit = cacheMap.get(n.hash);
        if (hit != null) translations[n.key] = hit;
        else misses.push(n);
      }
      if (misses.length === 0) return res.json({ translations });

      // Vertaalde misses moeten via Azure. Ontbreekt die config, dan is dit een
      // endpoint-brede afhankelijkheidsfout → 503 (client valt stil terug).
      if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });

      // Dedupe op hash: dezelfde tekst maar één keer vertalen, ook bij meerdere keys.
      const byHash = new Map();
      for (const m of misses) if (!byHash.has(m.hash)) byHash.set(m.hash, m);
      const uniques = [...byHash.values()];

      // Lange/markdown-fragmenten: losse call. Korte plain: gebundelde JSON-call.
      const singles = uniques.filter(u => u.format === 'markdown' || u.text.length > CONTENT_BATCH_INLINE_MAX_CHARS);
      const shorts = uniques.filter(u => u.format === 'plain' && u.text.length <= CONTENT_BATCH_INLINE_MAX_CHARS);

      const resultByHash = new Map();
      for (const u of singles) {
        const t = await translateContentOne(u.text, targetLang, u.format);
        if (t) resultByHash.set(u.hash, t);
      }
      // Chunk de korte fragmenten op aantal + totale tekens.
      let chunk = [];
      let chunkChars = 0;
      const flush = async () => {
        if (!chunk.length) return;
        const m = await translateContentBatch(chunk, targetLang);
        for (const [h, v] of m) resultByHash.set(h, v);
        chunk = [];
        chunkChars = 0;
      };
      for (const u of shorts) {
        if (chunk.length >= CONTENT_BATCH_MAX_ITEMS || (chunkChars + u.text.length) > CONTENT_BATCH_MAX_CHARS) {
          await flush();
        }
        chunk.push(u);
        chunkChars += u.text.length;
      }
      await flush();

      // Persist (idempotent op unique(source_hash,target_lang)) en map terug op keys.
      const toUpsert = [];
      for (const u of uniques) {
        const v = resultByHash.get(u.hash);
        if (v != null) toUpsert.push({ source_hash: u.hash, target_lang: targetLang, translated_text: v });
      }
      if (toUpsert.length) {
        try {
          await supabaseAdmin
            .from('content_translations')
            .upsert(toUpsert, { onConflict: 'source_hash,target_lang' });
        } catch (e) {
          console.warn('[translate-content] cache-write mislukt (niet-fataal):', e?.message || e);
        }
      }
      for (const m of misses) {
        const v = resultByHash.get(m.hash);
        if (v != null) translations[m.key] = v;
      }
      return res.json({ translations });
    } catch (err) {
      console.error('[translate-content] vertaling mislukt:', err);
      // Geef terug wat we hebben; de client valt voor de rest terug op origineel.
      return res.json({ translations });
    }
  });

  // GET /api/admin/documents/:documentId/download — download (file_bytes via pgPool én storage, admin only)
  app.get('/api/admin/documents/:documentId/download', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    if (!r.isAdmin && !r.isDocent) return res.status(403).json({ error: 'Admin- of docentrechten vereist' });
    const { documentId } = req.params;
    try {
      // Haal metadata op via Supabase (geen binary-kolom hier)
      const { data: doc } = await supabaseAdmin
        .from('documents')
        .select('id, title, filename, file_path, bucket, mime_type, file_type, folder_id')
        .eq('id', documentId)
        .maybeSingle();
      if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
      if (!(await resolveDocFolderAccess(r, doc.folder_id))) return res.status(403).json({ error: 'Geen toegang tot dit document' });
      const filename = String(doc.filename || doc.title || 'download').replace(/[\r\n"]/g, '_');
      // Web-bron (Task #234): geen bestand, maar een externe URL — open in een tab.
      if ((doc.file_type || '').toLowerCase() === 'web' && doc.file_path) {
        return res.json({ url: doc.file_path, filename });
      }
      const mimeType = doc.mime_type || getFileMimeType((doc.file_type || '').toLowerCase());
      // Route 1: binary opgeslagen in DB (bijv. .omv, .sav) — lees via pgPool voor correcte bytes
      if (!doc.file_path && pgPool) {
        const result = await pgPool.query(
          'SELECT file_bytes, mime_type FROM documents WHERE id = $1',
          [documentId]
        );
        const row = result.rows[0];
        if (row?.file_bytes) {
          const resolvedMime = row.mime_type || mimeType;
          res.setHeader('Content-Type', resolvedMime);
          res.setHeader('Content-Length', row.file_bytes.length);
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          return res.end(row.file_bytes);
        }
      }
      // Route 2: bestand in Supabase Storage
      if (doc.file_path && doc.bucket) {
        const { data: signed, error: signErr } = await supabaseAdmin.storage
          .from(doc.bucket)
          .createSignedUrl(doc.file_path, 120);
        if (signErr || !signed?.signedUrl) {
          return res.status(500).json({ error: 'Kon geen downloadlink aanmaken.' });
        }
        return res.redirect(signed.signedUrl);
      }
      return res.status(404).json({ error: 'Dit document heeft geen downloadbaar bestand.' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/admin/documents/:documentId — document verwijderen
  app.delete('/api/admin/documents/:documentId', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    const { documentId } = req.params;
    try {
      const { data: doc } = await supabaseAdmin.from('documents').select('file_path, bucket, folder_id').eq('id', documentId).maybeSingle();
      if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
      if (!(await resolveDocFolderAccess(r, doc.folder_id))) return res.status(403).json({ error: 'Geen toegang tot dit document' });
      if (doc?.file_path && doc.bucket) {
        await supabaseAdmin.storage.from(doc.bucket).remove([doc.file_path]);
      }
      const { error } = await supabaseAdmin.from('documents').delete().eq('id', documentId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/record-doc-mutation', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header required' });

    const { courseId } = req.body;
    if (!courseId) return res.status(400).json({ error: 'courseId is required' });

    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Not authenticated' });

      const { data: profile } = await profileCache.get(user.id, loadProfileRoleEmail);

      if (!(await isStaffForCourse(user, profile, courseId))) {
        return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
      }

      const mutationKey = `__doc_mutation_${courseId}__`;
      const content = JSON.stringify({ lastMutationAt: new Date().toISOString() });

      const { data: existing } = await supabaseAdmin
        .from('chatbot_prompts').select('id').eq('name', mutationKey).maybeSingle();

      if (existing) {
        const { error: updateErr } = await supabaseAdmin
          .from('chatbot_prompts')
          .update({ content, updated_at: new Date().toISOString() })
          .eq('name', mutationKey);
        if (updateErr) throw new Error(`DB update mislukt: ${updateErr.message}`);
      } else {
        const { error: insertErr } = await supabaseAdmin
          .from('chatbot_prompts')
          .insert({ name: mutationKey, content, is_active: false });
        if (insertErr) throw new Error(`DB insert mislukt: ${insertErr.message}`);
      }

      return res.json({ success: true });
    } catch (err) {
      console.error('[record-doc-mutation] Error:', err.message);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // Cursusmateriaal met bestandsdoelen (herinrichting docentenbeheer 2026-09-25):
  // bestanden per doel, eenmalige controle, "klaar voor studenten". Zie
  // server/courseFiles.js en supabase/migrations/20260925100000_document_purposes.sql.
  registerCourseFilesRoutes(app, {
    supabaseAdmin,
    pgPool,
    requireAuthUser,
    isStaffForCourse,
    userHasCourseAccess,
    ensureCourseRagFolder,
    processRagDocumentById,
    createProjectDocumentFromBuffer: (...a) => createProjectDocumentFromBuffer(...a),
    getFileMimeType,
    webSourcesReady: () => webSourcesAvailable,
  });
}
