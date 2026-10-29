import { createHash } from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';
import { Agent as UndiciAgent } from 'undici';
import { chunkPlainText } from '../rag/chunking.js';
import { WEB_SOURCE_PURPOSES, recordDocMutation, summarizeWebSync } from '../documents/courseFiles.js';
import { DOCX_PAGED_EXT } from '../documents/documentRender.js';
import {
  authUser,
  isCourseTeacher,
  isStaffForCourse,
  loadProfileRoleEmail,
  profileCache,
  resolveAdminUser,
} from '../lib/auth.js';
import {
  AZURE_EMBEDDINGS_READY,
  EMBEDDINGS_NOT_CONFIGURED_MSG,
  embedTextsServer,
  sleepMs,
} from '../lib/azureOpenai.js';
import { documentsHasContentHash, webSourcesAvailable } from '../lib/schemaFlags.js';
import { SUPERUSER_EMAIL, supabaseAdmin } from '../lib/supabase.js';
import { sanitizeMetadata, sanitizeText } from '../lib/sanitizeText.js';
import { translateServerMessage } from '../i18n/serverI18n.js';
import {
  WEB_IMPORT_LIMITS,
  createPinnedLookup as webCreatePinnedLookup,
  discoverPages as discoverWebPages,
  extractTitle as webExtractTitle,
  fetchPage as fetchWebPage,
  htmlToText as webHtmlToText,
  isBlockedHost as isBlockedWebHost,
  normalizeUrl as normalizeWebUrl,
  sameWebEnvironment as sameWebEnv,
} from './webImport.js';
import {
  ensureCourseRagFolder,
  processDocxCore,
  processPptxCore,
  processRagDocumentById,
} from './pipeline.js';

// Directe Postgres-verbinding voor operaties die PostgREST niet kan
// uitvoeren, zoals bytea-inserts van binaire bestanden.

// DNS-resolver voor de SSRF-bescherming van de web-import: resolved een hostnaam
// naar al zijn A/AAAA-adressen zodat `fetchPage`/`discoverPages` elk resolved IP
// tegen de geblokkeerde ranges kunnen toetsen (DNS-rebinding/SSRF-bypass). Wordt
// als `lookup` geïnjecteerd; bij een resolutiefout gooit het, wat de helpers als
// "geblokkeerd" (fail-safe) behandelen.
async function resolveHostAddresses(hostname) {
  const records = await dnsPromises.lookup(hostname, { all: true });
  return records.map((rec) => rec.address);
}

// SSRF-pinning voor de web-import: een undici-dispatcher die élke uitgaande
// fetch-verbinding pint op een geverifieerd publiek IP. Sluit de DNS-rebinding-
// TOCTOU tussen de pre-check (`resolveHostAddresses`) en de echte socket-connect:
// het IP dat we valideren is exact het IP waarmee `fetch()` verbindt. IP-literals
// slaan DNS over (net.connect roept dan geen `lookup` aan), maar die worden al op
// naamniveau door `isBlockedHost` geweigerd, dus de laag blijft sluitend.
const webImportPinnedLookup = webCreatePinnedLookup(async (hostname, opts) => {
  const lookupOpts = { all: true, verbatim: opts?.verbatim !== false };
  if (opts?.family) lookupOpts.family = opts.family;
  if (opts?.hints != null) lookupOpts.hints = opts.hints;
  return dnsPromises.lookup(hostname, lookupOpts);
});

const webImportDispatcher = new UndiciAgent({ connect: { lookup: webImportPinnedLookup } });

// Wrapper rond de globale fetch die de pinning-dispatcher meegeeft; injecteren we
// in `discoverPages`/`fetchPage` i.p.v. de kale fetch.
function safeWebFetch(url, options = {}) {
  return fetch(url, { ...options, dispatcher: webImportDispatcher });
}

// Task #391: web-import-stabiliteit.
// - HEARTBEAT_MS: tijdens het trage per-pagina-werk (ophalen + embeddings, incl.
//   429-backoff van max ~5×60s) wordt er minutenlang niets naar de stream
//   geschreven. Een tussenliggende proxy kan zo'n inactieve verbinding afkappen
//   vóór het 'done'-event. We sturen daarom een 'ping' zodra de stream langer dan
//   dit interval stil is.
// - PAGE_PACING_MS: kleine pauze ná elke verwerkte pagina om de embedding-bursts
//   over de tijd te spreiden en de Azure-snelheidslimiet minder snel te raken.
// Beide zijn via env instelbaar (tests zetten ze laag/0).
const WEB_IMPORT_HEARTBEAT_MS = Math.max(1000, Number(process.env.WEB_IMPORT_HEARTBEAT_MS) || 15000);

const WEB_IMPORT_PAGE_PACING_MS = Math.max(0, Number(process.env.WEB_IMPORT_PAGE_PACING_MS ?? 500));

export function registerIngestionRoutes(app) {
  // POST /api/admin/process-pptx — server-side PowerPoint-extractie + semantische
  // chunking. Body: { documentId, lang? }. Toegang: admin/superuser of staff van
  // een cursus die aan de map van het document gekoppeld is.
  app.post('/api/admin/process-pptx', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    if (!AZURE_EMBEDDINGS_READY) return res.status(503).json({ error: EMBEDDINGS_NOT_CONFIGURED_MSG });

    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { user } = auth;
    const { data: profile } = await profileCache.get(user.id, loadProfileRoleEmail);

    const { documentId, lang = 'nl' } = req.body || {};
    if (!documentId) return res.status(400).json({ error: 'documentId vereist' });

    try {
      const { data: doc, error: docErr } = await supabaseAdmin
        .from('documents')
        .select('id, title, filename, file_path, bucket, mime_type, file_type, folder_id')
        .eq('id', documentId)
        .maybeSingle();
      // Transiënte query-fout niet als 404 maskeren: anders denkt de docent dat het
      // document weg is en herimporteert die het (duplicaat + onnodige embeddings).
      if (docErr) return res.status(500).json({ error: `Kon document niet opzoeken: ${docErr.message}` });
      if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });

      const ext = (doc.file_type || '').toLowerCase().replace(/^\./, '');
      if (ext !== 'pptx') {
        return res.status(400).json({ error: 'Dit endpoint verwerkt alleen .pptx-bestanden' });
      }

      // Autorisatie: admin/superuser of staff van een gekoppelde cursus.
      const isAdmin = profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL;
      if (!isAdmin) {
        let allowed = false;
        if (doc.folder_id) {
          const { data: assignments } = await supabaseAdmin
            .from('course_folder_assignments')
            .select('course_id')
            .eq('folder_id', doc.folder_id);
          for (const a of assignments || []) {
            if (await isCourseTeacher(user.id, a.course_id)) { allowed = true; break; }
          }
        }
        if (!allowed) return res.status(403).json({ error: 'Geen rechten voor dit document' });
      }

      // Statusovergangen + extractie/chunking/embeddings in de gedeelde kern.
      const result = await processPptxCore(doc, null, lang);
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[process-pptx] Fout:', err);
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

  // POST /api/admin/process-docx — server-side Word-extractie met paginanummers
  // (Task #377): LibreOffice→PDF + per-pagina tekst + chunking → elke chunk krijgt
  // pageStart/pageEnd. Body: { documentId }. Toegang: admin/superuser of staff van
  // een cursus die aan de map van het document gekoppeld is (identiek aan -pptx).
  app.post('/api/admin/process-docx', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    if (!AZURE_EMBEDDINGS_READY) return res.status(503).json({ error: EMBEDDINGS_NOT_CONFIGURED_MSG });

    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { user } = auth;
    const { data: profile } = await profileCache.get(user.id, loadProfileRoleEmail);

    const { documentId } = req.body || {};
    if (!documentId) return res.status(400).json({ error: 'documentId vereist' });

    try {
      const { data: doc, error: docErr } = await supabaseAdmin
        .from('documents')
        .select('id, title, filename, file_path, bucket, mime_type, file_type, folder_id')
        .eq('id', documentId)
        .maybeSingle();
      // Transiënte query-fout niet als 404 maskeren: anders denkt de docent dat het
      // document weg is en herimporteert die het (duplicaat + onnodige embeddings).
      if (docErr) return res.status(500).json({ error: `Kon document niet opzoeken: ${docErr.message}` });
      if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });

      const ext = (doc.file_type || '').toLowerCase().replace(/^\./, '');
      if (!DOCX_PAGED_EXT.has(ext)) {
        return res.status(400).json({ error: 'Dit endpoint verwerkt alleen .docx/.doc/.odt-bestanden' });
      }

      // Autorisatie: admin/superuser of staff van een gekoppelde cursus.
      const isAdmin = profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL;
      if (!isAdmin) {
        let allowed = false;
        if (doc.folder_id) {
          const { data: assignments } = await supabaseAdmin
            .from('course_folder_assignments')
            .select('course_id')
            .eq('folder_id', doc.folder_id);
          for (const a of assignments || []) {
            if (await isCourseTeacher(user.id, a.course_id)) { allowed = true; break; }
          }
        }
        if (!allowed) return res.status(403).json({ error: 'Geen rechten voor dit document' });
      }

      const result = await processDocxCore(doc, null);
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[process-docx] Fout:', err);
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

  // POST /api/admin/process-rag-document — generieke server-side verwerking van een
  // RAG-bron op document-id (pdf/txt/plain → processPlainRagDocument; pptx/docx
  // worden ook correct gedispatcht). Alle paden persisteren ATOMISCH via
  // persistChunksAtomic (delete+insert+status in één transactie), zodat een
  // document nooit zijn fragmenten kwijtraakt door een crash/limiet halverwege —
  // dit vervangt het oude, niet-atomische client-side embed→swap-pad voor PDF's.
  // Body: { documentId, lang? }. Toegang: admin/superuser of staff van een cursus
  // die aan de map van het document gekoppeld is (identiek aan -pptx/-docx).
  app.post('/api/admin/process-rag-document', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    if (!AZURE_EMBEDDINGS_READY) return res.status(503).json({ error: EMBEDDINGS_NOT_CONFIGURED_MSG });

    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { user } = auth;
    const { data: profile } = await profileCache.get(user.id, loadProfileRoleEmail);

    const { documentId, lang = 'nl' } = req.body || {};
    if (!documentId) return res.status(400).json({ error: 'documentId vereist' });

    try {
      const { data: doc, error: docErr } = await supabaseAdmin
        .from('documents')
        .select('id, title, filename, file_path, bucket, mime_type, file_type, folder_id')
        .eq('id', documentId)
        .maybeSingle();
      // Transiënte query-fout niet als 404 maskeren: anders denkt de docent dat het
      // document weg is en herimporteert die het (duplicaat + onnodige embeddings).
      if (docErr) return res.status(500).json({ error: `Kon document niet opzoeken: ${docErr.message}` });
      if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });

      // Autorisatie: admin/superuser of staff van een gekoppelde cursus.
      const isAdmin = profile?.role === 'admin' || profile?.email === SUPERUSER_EMAIL;
      if (!isAdmin) {
        let allowed = false;
        if (doc.folder_id) {
          const { data: assignments } = await supabaseAdmin
            .from('course_folder_assignments')
            .select('course_id')
            .eq('folder_id', doc.folder_id);
          for (const a of assignments || []) {
            if (await isCourseTeacher(user.id, a.course_id)) { allowed = true; break; }
          }
        }
        if (!allowed) return res.status(403).json({ error: 'Geen rechten voor dit document' });
      }

      // Statusovergangen + extractie/chunking/embeddings + ATOMISCHE persistentie in
      // de gedeelde kern. Dispatcht zelf op bestandstype.
      const result = await processRagDocumentById(documentId, lang);
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[process-rag-document] Fout:', err);
      return res.status(err.status || 500).json({ error: err.message });
    }
  });

  // POST /api/admin/import-web/discover — ontdek de pagina's van een webomgeving
  // (Task #234). Body: { url }. Crawlt (sitemap of BFS) binnen dezelfde omgeving
  // en geeft een lijst { url, title } terug zodat de docent kan kiezen wat te
  // importeren. Beschikbaar voor staff (admin of docent ergens).
  app.post('/api/admin/import-web/discover', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);
    if (!r.isAdmin && !r.isDocent) return res.status(403).json({ error: 'Alleen docenten of admins mogen importeren.' });

    const rawUrl = String(req.body?.url || '').trim();
    const start = normalizeWebUrl(rawUrl);
    if (!start) return res.status(400).json({ error: 'Ongeldige URL. Geef een volledige http(s)-URL op.' });
    if (isBlockedWebHost(start)) {
      return res.status(400).json({ error: 'Deze URL wijst naar een intern of niet-toegestaan adres.' });
    }

    try {
      const { pages, method, warnings } = await discoverWebPages(start, safeWebFetch, { lookup: resolveHostAddresses });
      return res.json({ pages, method, warnings, baseUrl: start });
    } catch (err) {
      console.error('[import-web/discover] fout:', err);
      return res.status(500).json({ error: err.message || 'Ontdekken van pagina\'s mislukt.' });
    }
  });

  // POST /api/admin/import-web/import — importeer geselecteerde pagina's als
  // RAG-bronnen in de cursus (Task #234). Body: { courseId, baseUrl, pages: [{url,title?}],
  // purpose?, webSourceId?, resync? }.
  // Per pagina: ophalen → schone tekst → chunks → embeddings → opslaan als
  // documents-rij (file_type='web', file_path=url) + document_chunks. Idempotent
  // per (folder, url): bestaande web-bron wordt hergebruikt en bijgewerkt.
  // Elke pagina krijgt een BEVESTIGD doel (leerstof of cursusinformatie, default
  // leerstof) en — als de migratie er is — hangt aan één websitebron per
  // (cursus, baseUrl). `resync: true` + `webSourceId` haalt alle bekende pagina's
  // van die bron opnieuw op (ongewijzigde worden overgeslagen).
  app.post('/api/admin/import-web/import', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'DB niet beschikbaar' });
    const r = await resolveAdminUser(req);
    if (r.error) return res.status(r.error.status).json(r.error.body);

    const courseId = req.body?.courseId;
    let baseUrl = String(req.body?.baseUrl || '').trim();
    let pages = Array.isArray(req.body?.pages) ? req.body.pages : [];
    const requestedPurpose = req.body?.purpose;
    const webSourceId = typeof req.body?.webSourceId === 'string' ? req.body.webSourceId : null;
    const resync = req.body?.resync === true;
    if (!courseId) return res.status(400).json({ error: 'courseId is verplicht.' });
    if (requestedPurpose !== undefined && !WEB_SOURCE_PURPOSES.includes(requestedPurpose)) {
      return res.status(400).json({ error: 'Een website kan alleen leerstof of cursusinformatie zijn.', code: 'webPageOnlyRag' });
    }
    if (resync && (!webSourceId || !webSourcesAvailable)) {
      return res.status(400).json({ error: 'Opnieuw ophalen kan alleen voor een bestaande websitebron.' });
    }
    if (pages.length === 0 && !resync) return res.status(400).json({ error: 'Geen pagina\'s geselecteerd om te importeren.' });

    if (!(await isStaffForCourse(r.user, r.profile, courseId))) {
      return res.status(403).json({ error: 'Je bent geen docent van deze cursus.' });
    }

    if (!AZURE_EMBEDDINGS_READY) return res.status(503).json({ error: EMBEDDINGS_NOT_CONFIGURED_MSG });

    // Stream-stabiliteit (Task #391): in buiten-try-scope zodat de catch ze ook kan
    // opruimen. clientGone wordt true zodra de client de verbinding verbreekt.
    let heartbeat = null;
    let clientGone = false;
    let lastWrite = Date.now();

    try {
      const { data: course } = await supabaseAdmin
        .from('courses').select('id, name').eq('id', courseId).maybeSingle();
      if (!course) return res.status(404).json({ error: 'Cursus niet gevonden.' });

      // Bestaande websitebron (bijwerken/opnieuw ophalen): de scope en het doel
      // komen dan uit de bron zelf, niet uit de client.
      let source = null;
      let createdSource = false;
      if (webSourceId && webSourcesAvailable) {
        const { data: src, error: srcErr } = await supabaseAdmin.from('web_sources')
          .select('id, course_id, base_url, title, purpose').eq('id', webSourceId).maybeSingle();
        if (srcErr) throw new Error(`Kon websitebron niet opzoeken: ${srcErr.message}`);
        if (!src || src.course_id !== courseId) return res.status(404).json({ error: 'Website niet gevonden in deze cursus.' });
        source = src;
        baseUrl = src.base_url;
      }

      // De baseUrl bepaalt de toegestane scope: alleen pagina's binnen dezelfde
      // webomgeving mogen geïmporteerd worden. Zonder geldige baseUrl weigeren we,
      // zodat een client niet zomaar willekeurige URL's kan laten ophalen.
      const scope = normalizeWebUrl(baseUrl);
      if (!scope || isBlockedWebHost(scope)) {
        return res.status(400).json({ error: 'Ongeldige of niet-toegestane baseUrl.' });
      }

      const { folderId } = await ensureCourseRagFolder(courseId, course.name, r.user.id);
      const purpose = requestedPurpose || source?.purpose || 'course_material';

      if (webSourcesAvailable && !source) {
        // Eén bron per (cursus, baseUrl): een tweede import van dezelfde site vult
        // de bestaande bron aan in plaats van een nieuwe te maken.
        const { data: existingSrc, error: exErr } = await supabaseAdmin.from('web_sources')
          .select('id, course_id, base_url, title, purpose').eq('course_id', courseId).eq('base_url', scope).maybeSingle();
        if (exErr) throw new Error(`Kon websitebron niet opzoeken: ${exErr.message}`);
        if (existingSrc) {
          source = existingSrc;
        } else {
          const u = new URL(scope);
          const { data: created, error: insErr } = await supabaseAdmin.from('web_sources')
            .insert({ course_id: courseId, base_url: scope, title: (u.host + u.pathname).replace(/\/$/, ''), purpose, created_by: r.user.id })
            .select('id, course_id, base_url, title, purpose').single();
          if (insErr || !created) throw new Error(`Kon websitebron niet aanmaken: ${insErr?.message || 'onbekend'}`);
          source = created;
          createdSource = true;
        }
      }
      if (source && source.purpose !== purpose) {
        await supabaseAdmin.from('web_sources').update({ purpose }).eq('id', source.id);
      }

      if (resync) {
        const { data: known, error: knownErr } = await supabaseAdmin.from('documents')
          .select('file_path, title').eq('web_source_id', source.id).eq('file_type', 'web');
        if (knownErr) throw new Error(`Kon pagina's van de website niet ophalen: ${knownErr.message}`);
        pages = (known || []).map((d) => ({ url: d.file_path, title: d.title || '' }));
        if (pages.length === 0) return res.status(400).json({ error: 'Deze website heeft nog geen pagina\'s om bij te werken.' });
      }

      // Pagina-URL's normaliseren, ontdubbelen, binnen de scope houden en niet naar
      // interne adressen laten wijzen. Buiten de scope/limiet wordt overgeslagen.
      const seen = new Set();
      const targets = [];
      let outOfScope = 0;
      for (const p of pages) {
        const url = normalizeWebUrl(String(p?.url || '').trim());
        if (!url || seen.has(url)) continue;
        if (isBlockedWebHost(url) || !sameWebEnv(scope, url)) { outOfScope++; continue; }
        seen.add(url);
        targets.push({ url, title: typeof p?.title === 'string' ? p.title.trim() : '' });
        if (targets.length >= WEB_IMPORT_LIMITS.MAX_PAGES) break;
      }
      if (targets.length === 0) {
        if (createdSource) await supabaseAdmin.from('web_sources').delete().eq('id', source.id);
        return res.status(400).json({ error: 'Geen geldige pagina\'s binnen de opgegeven website-scope.' });
      }

      let imported = 0;
      let skipped = 0;
      let errors = 0;
      let totalChunks = 0;
      const results = [];

      // Vanaf hier streamen we de voortgang als NDJSON (één JSON-object per regel)
      // zodat de client live kan tonen welke pagina nu verwerkt wordt. Alle
      // validatie hierboven gebruikt nog gewone status-codes; vanaf nu is de
      // status altijd 200 en worden fouten als event gemeld.
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });

      // Markeer een verbroken client zodat we de lus stoppen en geen 'done' meer
      // proberen te schrijven (write-na-close gooit een EPIPE-achtige fout).
      res.on('close', () => { clientGone = true; });

      // safeEmit schrijft alleen als de client er nog is en verschuift lastWrite,
      // wat de heartbeat gebruikt om te bepalen of de stream stil is.
      const safeEmit = (event) => {
        if (clientGone) return false;
        try {
          // Streams gaan buiten res.json om: vertaal de melding hier zelf.
          const out = event && typeof event.error === 'string'
            ? { ...event, error: translateServerMessage(event.error, req.get('x-leap-lang')) }
            : event;
          res.write(JSON.stringify(out) + '\n');
          if (typeof res.flush === 'function') res.flush();
          lastWrite = Date.now();
          return true;
        } catch {
          clientGone = true;
          return false;
        }
      };

      // Heartbeat (Task #391): per pagina kan het minutenlang stil zijn (ophalen +
      // embeddings, incl. 429-backoff van max ~5×60s). Een tussenliggende proxy kapt
      // zo'n inactieve verbinding af vóór het 'done'-event ("Onvolledig antwoord van
      // de server"). We sturen daarom een 'ping' zodra de stream lang genoeg stil is;
      // .unref() zorgt dat de timer het proces nooit openhoudt.
      heartbeat = setInterval(() => {
        if (clientGone) return;
        if (Date.now() - lastWrite >= WEB_IMPORT_HEARTBEAT_MS) {
          safeEmit({ type: 'ping', ts: Date.now() });
        }
      }, WEB_IMPORT_HEARTBEAT_MS);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();

      safeEmit({ type: 'start', total: targets.length });

      // Verwerk één doel-URL. Levert een resultaat-object + interne `counter` op
      // (welke teller buiten opgehoogd moet worden), maar muteert zelf geen tellers.
      // Belangrijk voor consistentie: embeddings (de trage, faalbare stap) draaien
      // VÓÓR we de bestaande rij resetten, zodat een mislukte pagina de vorige
      // 'completed'-staat met geldige chunks ongemoeid laat. De rij wordt pas op
      // 'completed' + total_chunks + content_hash gezet NÁ een geslaagde chunk-insert,
      // zodat geldt: completed + total_chunks>0 ⟺ er bestaan chunks.
      // Doel + bron die elke geïmporteerde pagina krijgt (zelfde bevestiging als een
      // upload met doel), zodat webpagina's niet als "onbevestigd" in de
      // eenmalige controle belanden.
      const webPageLabels = {
        purpose,
        purpose_confirmed_at: new Date().toISOString(),
        ...(source ? { web_source_id: source.id } : {}),
      };
      // Cursusinformatie mag geen bewijs voor begrippen/quiz leveren (zelfde regel
      // als planPurposeChange 'relabel').
      const dropEvidenceIfBecameCourseInfo = async (doc) => {
        if (purpose === 'course_info' && (doc.purpose || 'course_material') !== 'course_info') {
          await supabaseAdmin.from('concept_evidence').delete().eq('document_id', doc.id);
        }
      };
      // Een ongewijzigde pagina krijgt wél het (eventueel nieuwe) doel en de bron.
      const applyWebPageLabels = async (doc) => {
        const same = doc.purpose === purpose && doc.purpose_confirmed_at
          && (!source || doc.web_source_id === source.id);
        if (same) return;
        await dropEvidenceIfBecameCourseInfo(doc);
        const { error: labelErr } = await supabaseAdmin.from('documents').update(webPageLabels).eq('id', doc.id);
        if (labelErr) throw new Error(`Kon doel van pagina niet bijwerken: ${labelErr.message}`);
      };

      const processPage = async (target) => {
        const resp = await fetchWebPage(target.url, safeWebFetch, { scope, lookup: resolveHostAddresses });
        if (!resp.ok) {
          // 404/410: de site levert de pagina niet meer. We verwijderen de bestaande
          // leerstof NIET (een tijdelijk kapotte site mag niets laten verdwijnen),
          // maar melden het apart zodat de docent kan beslissen.
          const notFound = resp.status === 404 || resp.status === 410;
          return { url: target.url, status: 'error', counter: 'errors', message: resp.error || `HTTP ${resp.status || 'netwerkfout'}`, ...(notFound ? { notFound: true } : {}) };
        }
        // Verdedigend: ook al checkt fetchWebPage redirects tegen de scope, valideer
        // de uiteindelijke URL nog eens zodat content buiten de webomgeving nooit
        // als RAG-bron belandt.
        if (resp.finalUrl && (isBlockedWebHost(resp.finalUrl) || !sameWebEnv(scope, resp.finalUrl))) {
          return { url: target.url, status: 'skipped', counter: 'outOfScope', message: 'Redirect buiten de website-scope' };
        }
        const text = webHtmlToText(resp.html);
        if (text.length < WEB_IMPORT_LIMITS.MIN_TEXT_CHARS) {
          return { url: target.url, status: 'skipped', counter: 'skipped', message: 'Te weinig leesbare tekst' };
        }
        const title = (target.title || webExtractTitle(resp.html) || target.url).slice(0, 280);
        const chunks = chunkPlainText(text);
        if (!chunks.length) {
          return { url: target.url, status: 'skipped', counter: 'skipped', message: 'Geen chunks' };
        }

        // Idempotent: bestaande web-bron voor dezelfde URL in deze map opzoeken.
        const selectCols = (documentsHasContentHash
          ? 'id, purpose, purpose_confirmed_at, content_hash, processing_status, total_chunks'
          : 'id, purpose, purpose_confirmed_at') + (webSourcesAvailable ? ', web_source_id' : '');
        const { data: existingDoc, error: existingErr } = await supabaseAdmin
          .from('documents')
          .select(selectCols)
          .eq('folder_id', folderId)
          .eq('file_path', target.url)
          .eq('file_type', 'web')
          .maybeSingle();
        // Een echte query-fout (transiënt PostgREST-probleem of verouderde
        // schema-cache) NIET behandelen als "pagina bestaat nog niet": anders
        // zouden we de pagina opnieuw embedden en een duplicaat aanmaken, juist
        // tijdens de snelheidslimiet die deze top-up moet ontlopen. Surface als
        // per-pagina-fout zodat de docent gewoon opnieuw kan draaien.
        if (existingErr) {
          throw new Error(`Kon bestaande pagina niet opzoeken: ${existingErr.message}`);
        }

        // Goedkope top-up: een ongewijzigde, al volledig geëmbedde pagina overslaan
        // zónder opnieuw te embedden. Zo overleeft een her-import na een afgekapte
        // stream de Azure-snelheidslimiet en hoeft de docent enkel opnieuw te draaien.
        const contentHash = documentsHasContentHash
          ? createHash('sha256').update(text).digest('hex')
          : null;
        if (
          documentsHasContentHash &&
          existingDoc &&
          existingDoc.content_hash &&
          existingDoc.content_hash === contentHash &&
          existingDoc.processing_status === 'completed' &&
          Number(existingDoc.total_chunks) > 0
        ) {
          await applyWebPageLabels(existingDoc);
          return { url: target.url, status: 'skipped', counter: 'skipped', message: 'Ongewijzigd', title, unchanged: true };
        }

        const embeddings = await embedTextsServer(chunks, null);

        let docId;
        if (existingDoc) {
          docId = existingDoc.id;
          // Eerst terug naar 'processing' + tel/hash wissen, dan pas de oude chunks
          // verwijderen: zo blijft de rij nooit als 'completed' staan terwijl de
          // chunks al weg zijn (consistente staat bij een afgekapte run).
          const resetUpd = { processing_status: 'processing', total_chunks: 0 };
          if (documentsHasContentHash) resetUpd.content_hash = null;
          const { error: resetErr } = await supabaseAdmin.from('documents').update(resetUpd).eq('id', docId);
          if (resetErr) throw new Error(`Kon document niet resetten: ${resetErr.message}`);
          const { error: delErr } = await supabaseAdmin
            .from('document_chunks').delete().eq('document_id', docId);
          if (delErr) throw new Error(`Kon oude chunks niet verwijderen: ${delErr.message}`);
        } else {
          const insertRow = {
            title,
            filename: title,
            file_path: target.url,
            file_type: 'web',
            bucket: 'rag_sources',
            folder_id: folderId,
            mime_type: 'text/html',
            processing_status: 'processing',
            total_chunks: 0,
            uploaded_by: r.user.id,
            ...webPageLabels,
          };
          const { data: newDoc, error: docErr } = await supabaseAdmin
            .from('documents').insert(insertRow).select('id').single();
          if (docErr || !newDoc) throw new Error(docErr?.message || 'Kon document niet aanmaken');
          docId = newDoc.id;
        }

        const rows = chunks.map((content, idx) => ({
          document_id: docId,
          content: sanitizeText(content),
          embedding: embeddings[idx],
          chunk_index: idx,
          metadata: sanitizeMetadata({ source: 'web', sourceUrl: target.url }),
        }));
        const { error: insErr } = await supabaseAdmin.from('document_chunks').insert(rows);
        if (insErr) throw new Error(insErr.message);

        // Pas ná de geslaagde chunk-insert markeren we 'completed' met de juiste
        // telling + hash (de hash maakt de volgende import idempotent/top-up).
        const finalizeUpd = {
          title,
          filename: title,
          mime_type: 'text/html',
          processing_status: 'completed',
          total_chunks: chunks.length,
          ...webPageLabels,
        };
        if (documentsHasContentHash) finalizeUpd.content_hash = contentHash;
        if (existingDoc) await dropEvidenceIfBecameCourseInfo(existingDoc);
        const { error: finErr } = await supabaseAdmin.from('documents').update(finalizeUpd).eq('id', docId);
        if (finErr) throw new Error(`Kon document niet afronden: ${finErr.message}`);

        return { url: target.url, status: 'imported', counter: 'imported', title, chunks: chunks.length };
      };

      for (let i = 0; i < targets.length; i++) {
        // Stop netjes als de client weg is: geen nieuwe (dure) pagina meer beginnen.
        if (clientGone) break;
        const target = targets[i];
        safeEmit({ type: 'progress', index: i + 1, total: targets.length, url: target.url, title: target.title || '' });
        let publicResult;
        try {
          const { counter, ...rest } = await processPage(target);
          publicResult = rest;
          if (counter === 'imported') { imported++; totalChunks += rest.chunks || 0; }
          else if (counter === 'outOfScope') outOfScope++;
          else if (counter === 'errors') errors++;
          else skipped++;
        } catch (err) {
          errors++;
          publicResult = { url: target.url, status: 'error', message: err.message || 'Onbekende fout' };
          console.error(`[import-web/import] pagina mislukt (${target.url}):`, err.message);
        }
        results.push(publicResult);
        // page_done geeft de client een betrouwbare per-pagina-telling: 'progress'
        // vuurt VÓÓR het werk, dus alleen page_done bewijst dat pagina i klaar is.
        safeEmit({ type: 'page_done', index: i + 1, total: targets.length, status: publicResult.status, url: publicResult.url, result: publicResult });

        // Kleine pauze tussen pagina's om de embedding-bursts te spreiden en de
        // Azure-snelheidslimiet minder snel te raken (overslaan bij de laatste of
        // als de client al weg is).
        if (!clientGone && WEB_IMPORT_PAGE_PACING_MS > 0 && i < targets.length - 1) {
          await sleepMs(WEB_IMPORT_PAGE_PACING_MS);
        }
      }

      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      // Ook bij een afgekapte stream vastleggen wat er wél is opgehaald, zodat de
      // bron in Cursusmateriaal een eerlijke "laatst bijgewerkt" toont.
      const summary = summarizeWebSync(results);
      if (source) {
        const { error: syncErr } = await supabaseAdmin.from('web_sources')
          .update({ last_synced_at: new Date().toISOString(), last_sync_summary: summary }).eq('id', source.id);
        if (syncErr) console.warn(`[import-web/import] ophaalstatus niet opgeslagen (${source.id}):`, syncErr.message);
      }
      if (imported > 0) {
        try { await recordDocMutation(supabaseAdmin, courseId); } catch (e) { console.warn('[import-web/import] documentwijziging niet geregistreerd:', e.message); }
      }
      if (!clientGone) {
        safeEmit({ type: 'done', imported, skipped, errors, outOfScope, totalChunks, folderId, courseName: course.name, results, webSourceId: source?.id || null, purpose, summary });
      } else {
        console.warn(`[import-web/import] client verbroken — ${imported} geïmporteerd, ${skipped} overgeslagen van ${targets.length} pagina's voor de verbinding sloot. Her-import slaat ongewijzigde pagina's over.`);
      }
      return res.end();
    } catch (err) {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      console.error('[import-web/import] fout:', err);
      // Als het streamen al begonnen is kunnen we de status niet meer wijzigen;
      // meld de fout dan als event en sluit de stream netjes af.
      if (res.headersSent) {
        if (!clientGone) {
          try { res.write(JSON.stringify({ type: 'error', error: translateServerMessage(err.message || 'Web-import mislukt.', req.get('x-leap-lang')) }) + '\n'); } catch {}
        }
        return res.end();
      }
      return res.status(500).json({ error: err.message || 'Web-import mislukt.' });
    }
  });
}
