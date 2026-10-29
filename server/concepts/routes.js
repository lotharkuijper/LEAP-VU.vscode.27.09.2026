import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import {
  applySynonymGroups,
  buildDocumentWindows,
  buildDuplicateSuggestionPrompt,
  buildMergeSuggestions,
  buildSynonymPrompt,
  conceptKey,
  isUsableConceptName,
  mapLimit,
  mergeByKey,
  parseSynonymGroups,
  planSureMerges,
  selectConcepts,
} from './conceptConsolidation.js';
import { registerConceptEvidenceRoutes } from './conceptEvidence.js';
import {
  classifyConceptDifficulty,
  classifyConceptRole,
  isMetaCommentaryName,
  mergeNearDuplicateConcepts,
  normalizeConceptRole,
  normalizeDifficulty,
  planConceptReplace,
  planConceptWrites,
} from './conceptExtraction.js';
import { loadConceptOrder } from './conceptOrder.js';
import { purposeAllowsModule } from '../rag/filePurpose.js';
import {
  authUser,
  isCourseTeacher,
  isStaffForCourse,
  loadProfileRoleEmail,
  profileCache,
  requireAuthUser,
  userCache,
  userHasCourseAccess,
} from '../lib/auth.js';
import {
  AZURE_CHAT_READY,
  AZURE_EMBEDDINGS_READY,
  EMBEDDINGS_NOT_CONFIGURED_MSG,
  LLM_NOT_CONFIGURED_MSG,
  OPENAI_MODEL,
  chatModelParams,
  embedTextsServer,
  openaiChatCompletion,
} from '../lib/azureOpenai.js';
import { cachedLeerlijn, courseRagFolderIds } from '../lib/courseData.js';
import { conceptEvidenceSchemaReady, conceptsHasCourseId } from '../lib/schemaFlags.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, SUPERUSER_EMAIL, supabaseAdmin } from '../lib/supabase.js';
import { RAG_EXTRACTION_DEFAULTS, loadRagSettings, searchChunksServerSide } from '../rag/search.js';
import { sanitizeText } from '../lib/sanitizeText.js';

// Begrippen per document: kandidaten uit deze run (optioneel) en begrippen die
// er nu voor de cursus staan (via source_document_ids). Een document met 0
// begrippen is een signaal (niet stil accepteren).
async function conceptCoverageByDocument(courseId, docIds, candidates = null) {
  const { data: docs } = await supabaseAdmin.from('documents').select('id, title, filename').in('id', docIds);
  const { data: rows } = await supabaseAdmin.from('concepts').select('source_document_ids').eq('course_id', courseId);
  const counts = new Map();
  for (const r of rows || []) for (const d of r.source_document_ids || []) counts.set(d, (counts.get(d) || 0) + 1);
  const cand = new Map();
  for (const c of candidates || []) for (const d of c.documentIds || []) cand.set(d, (cand.get(d) || 0) + 1);
  return (docs || [])
    .map((d) => ({ documentId: d.id, title: d.title || d.filename, concepts: counts.get(d.id) || 0, candidates: candidates ? (cand.get(d.id) || 0) : null }))
    .sort((a, b) => String(a.title).localeCompare(String(b.title), 'nl', { numeric: true }));
}

// Leerstofdocumenten van een cursus (RAG-bronmappen, verwerkt, doel staat begrippen toe).
async function conceptSourceDocIds(courseId) {
  const { data: assignments } = await supabaseAdmin.from('course_folder_assignments').select('folder_id').eq('course_id', courseId);
  const folderIds = (assignments || []).map((a) => a.folder_id);
  if (!folderIds.length) return [];
  const { data: ragFolders } = await supabaseAdmin.from('document_folders').select('id').in('id', folderIds).eq('folder_type', 'rag_sources');
  const ragIds = (ragFolders || []).map((r) => r.id);
  if (!ragIds.length) return [];
  const { data: docs } = await supabaseAdmin.from('documents').select('id, purpose').in('folder_id', ragIds).eq('processing_status', 'completed');
  return (docs || []).filter((d) => purposeAllowsModule(d.purpose, 'concepts')).map((d) => d.id);
}

async function requireConceptStaff(req, res, courseId) {
  if (!supabaseAdmin) { res.status(503).json({ error: 'Admin client niet beschikbaar' }); return null; }
  const auth = await authUser(req);
  if (auth.error) { res.status(auth.error.status).json(auth.error.body); return null; }
  if (!courseId) { res.status(400).json({ error: 'courseId is vereist' }); return null; }
  const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
  if (!(await isStaffForCourse(auth.user, profile, courseId))) { res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' }); return null; }
  return auth.user;
}

// Voorvoegsel __concepts_regen_ wordt overal uitgesloten waar prompts worden getoond/gekozen.
const mergeDismissKey = (courseId) => `__concepts_regen_merge_dismissed_${courseId}__`;

const groupSignature = (ids) => [...ids].sort().join('|');

async function extractConceptsHandler(req, res) {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
  }

  if (!AZURE_EMBEDDINGS_READY) {
    return res.status(503).json({ error: EMBEDDINGS_NOT_CONFIGURED_MSG });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const { courseId, replace = false, documentIds, language } = req.body;
  if (!courseId) {
    return res.status(400).json({ error: 'courseId is required' });
  }
  const filterDocIds = Array.isArray(documentIds) && documentIds.length > 0 ? documentIds : null;
  // Doeltaal van de geëxtraheerde begrippen. 'nl'/'en' forceren de taal van
  // naam + definitie; 'auto' laat de LLM de taal van het bronmateriaal volgen.
  // Dit is cruciaal: de verificatiestap embed de begrípsnaam en vergelijkt die
  // met de chunks. Bij Engels cursusmateriaal scoort een Nederlandse term laag,
  // waardoor alle kandidaten worden afgewezen en de docent "niets" ziet.
  // Default is 'auto' zodat ook niet-UI-callers de taal van het materiaal volgen.
  const conceptLanguage = ['nl', 'en', 'auto'].includes(language) ? language : 'auto';

  const courseMarker = `course_id:${courseId}`;
  const regenKey = `__concepts_regen_${courseId}__`;

  async function writeRegenTimestamp() {
    const content = JSON.stringify({ lastRegenAt: new Date().toISOString() });
    const { data: existing } = await supabaseAdmin
      .from('chatbot_prompts').select('id').eq('name', regenKey).maybeSingle();
    if (existing) {
      await supabaseAdmin.from('chatbot_prompts')
        .update({ content, updated_at: new Date().toISOString() }).eq('name', regenKey);
    } else {
      await supabaseAdmin.from('chatbot_prompts')
        .insert({ name: regenKey, content, is_active: false });
    }
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

    const { data: profile, error: profileError } = await profileCache.get(user.id, loadProfileRoleEmail);

    if (profileError || !profile) {
      return res.status(403).json({ error: 'Could not verify user role' });
    }

    const isAdmin = profile.role === 'admin' || profile.email === SUPERUSER_EMAIL;
    // isCourseTeacher controleert course_members op (user_id, course_id, member_role='teacher')
    // en bevestigt daarmee al dat de docent lid is van precies deze cursus. Een extra
    // lidmaatschaps-dubbelcheck is dus overbodig (en queryde voorheen de niet-bestaande
    // kolom course_members.id → 42703 → 500 "Cursustoestemming kon niet worden gecontroleerd",
    // uitsluitend voor docenten omdat dat blok alleen in de docent-tak liep).
    const isDocent = !isAdmin && await isCourseTeacher(user.id, courseId);
    if (!isAdmin && !isDocent) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }

    // BELANGRIJK: de replace-actie (oude RAG-begrippen verwijderen) is
    // verplaatst naar NA een succesvolle LLM-extractie. Voorheen werd er
    // altijd eerst gewist; bij een rate-limit of andere LLM-fout bleef de
    // cursus dan met een lege begrippenlijst achter. We voeren de replace
    // pas uit zodra we daadwerkelijk nieuwe begrippen hebben om in te
    // voegen — zie verderop in deze handler (`runReplace`).
    async function runReplace(keepNames = new Set()) {
      if (!replace) return;
      const ragMarkerLocal = '[RAG-geëxtraheerd uit cursusmateriaal]';
      if (conceptsHasCourseId) {
        // Verwijder alleen verouderde RAG-begrippen: die wél RAG zijn maar in deze
        // run NIET opnieuw zijn voorgesteld. Zojuist (her)ingevoegde begrippen
        // staan in keepNames en blijven dus behouden.
        const { data: courseConcepts, error: fetchErr } = await supabaseAdmin
          .from('concepts')
          .select('id, name, key_points')
          .eq('course_id', courseId);
        if (fetchErr) {
          console.error('[extract-concepts] Fetch (replace) error:', fetchErr);
          throw new Error(`Ophalen mislukt: ${fetchErr.message}`);
        }
        const staleIds = (courseConcepts || [])
          .filter((c) => (c.key_points || []).includes(ragMarkerLocal))
          .filter((c) => !keepNames.has(String(c.name || '').toLowerCase().trim()))
          .map((c) => c.id);
        if (staleIds.length > 0) {
          const { error: delErr } = await supabaseAdmin
            .from('concepts')
            .delete()
            .in('id', staleIds);
          if (delErr) {
            console.error('[extract-concepts] Delete (replace) error:', delErr);
            throw new Error(`Verwijderen mislukt: ${delErr.message}`);
          }
        }
        console.log(`[extract-concepts] Replace (course_id): deleted ${staleIds.length} stale RAG concepts for course ${courseId}`);
        return;
      }
      const { data: taggedConcepts, error: taggedErr } = await supabaseAdmin
        .from('concepts')
        .select('id, name, key_points')
        .contains('key_points', [courseMarker]);

      if (taggedErr) {
        console.error('[extract-concepts] Tagged concepts query error on replace:', taggedErr);
        throw new Error(`Ophalen mislukt: ${taggedErr.message}`);
      }

      // Cursusbewust opruimen: alleen verouderde RAG-begrippen van DEZE cursus
      // (niet meer voorgesteld); begrippen die ook bij een andere cursus horen
      // verliezen enkel deze markering. keepNames beschermt zojuist geschreven en
      // opnieuw voorgestelde begrippen.
      const { toDeleteIds, toUntag } = planConceptReplace(taggedConcepts, { courseMarker, keepNames });

      if (toDeleteIds.length > 0) {
        const { error: delErr } = await supabaseAdmin
          .from('concepts')
          .delete()
          .in('id', toDeleteIds);
        if (delErr) {
          console.error('[extract-concepts] Delete (replace fallback) error:', delErr);
          throw new Error(`Verwijderen mislukt: ${delErr.message}`);
        }
      }

      for (const u of toUntag) {
        const { error: untagErr } = await supabaseAdmin
          .from('concepts').update({ key_points: u.key_points }).eq('id', u.id);
        if (untagErr) {
          console.error('[extract-concepts] Untag (replace fallback) error:', untagErr);
          throw new Error(`Loskoppelen mislukt: ${untagErr.message}`);
        }
      }

      console.log(`[extract-concepts] Replace (fallback): deleted ${toDeleteIds.length} RAG-extracted, untagged ${toUntag.length} shared`);
    }

    const { data: assignments } = await supabaseAdmin
      .from('course_folder_assignments')
      .select('folder_id')
      .eq('course_id', courseId);

    if (!assignments || assignments.length === 0) {
      await writeRegenTimestamp().catch(() => {});
      return res.json({ concepts: [], message: 'Geen RAG-mappen gevonden voor deze cursus' });
    }

    const assignedFolderIds = assignments.map((a) => a.folder_id);

    const { data: ragFolders } = await supabaseAdmin
      .from('document_folders')
      .select('id')
      .in('id', assignedFolderIds)
      .eq('folder_type', 'rag_sources');

    if (!ragFolders || ragFolders.length === 0) {
      await writeRegenTimestamp().catch(() => {});
      return res.json({ concepts: [], message: 'Geen RAG-bronmappen gevonden voor deze cursus' });
    }

    const ragFolderIds = ragFolders.map((f) => f.id);

    const { data: allDocs, error: docsError } = await supabaseAdmin
      .from('documents')
      .select('id, purpose, title')
      .in('folder_id', ragFolderIds)
      .eq('processing_status', 'completed');
    // Alleen leerstof levert begrippen: cursusinformatie (studiehandleiding,
    // rooster) zou anders "Herkansing" of "Deadline" als begrip opleveren.
    const docs = (allDocs || []).filter((d) => purposeAllowsModule(d.purpose, 'concepts'));

    if (docsError) {
      console.error('[extract-concepts] docs query error:', docsError);
      return res.status(500).json({ error: `Documenten ophalen mislukt: ${docsError.message}` });
    }

    if (!docs || docs.length === 0) {
      await writeRegenTimestamp().catch(() => {});
      return res.json({ concepts: [], message: 'Geen verwerkte documenten gevonden in RAG-mappen' });
    }

    let docIds = docs.map((d) => d.id);
    if (filterDocIds) {
      const allowed = new Set(filterDocIds);
      docIds = docIds.filter((id) => allowed.has(id));
      if (docIds.length === 0) {
        await writeRegenTimestamp().catch(() => {});
        return res.json({ concepts: [], message: 'Geen geselecteerde documenten gevonden in de RAG-mappen' });
      }
    }

    // De HELE cursus lezen (regressie: voorheen 80 willekeurige fragmenten en
    // daarvan de eerste 14.000 tekens = 5% van E&B1, uit 3 van 16 documenten).
    // Alle fragmenten, per document in volgorde, gebundeld tot vensters van
    // ~12.000 tekens; elk venster gaat apart naar het taalmodel.
    const chunks = [];
    for (let from = 0; ; from += 1000) {
      const { data: page, error: chunksError } = await supabaseAdmin
        .from('document_chunks')
        .select('content, document_id, chunk_index')
        .in('document_id', docIds)
        .order('document_id', { ascending: true })
        .order('chunk_index', { ascending: true })
        .range(from, from + 999);
      if (chunksError) {
        console.error('[extract-concepts] chunks query error:', chunksError);
        return res.status(500).json({ error: `Chunks ophalen mislukt: ${chunksError.message}` });
      }
      chunks.push(...(page || []));
      if (!page || page.length < 1000) break;
    }

    if (chunks.length === 0) {
      await writeRegenTimestamp().catch(() => {});
      return res.json({ concepts: [], message: 'Geen document-chunks gevonden' });
    }

    const windows = buildDocumentWindows(chunks);
    console.log(`[extract-concepts] ${chunks.length} fragmenten uit ${new Set(chunks.map((c) => c.document_id)).size} documenten → ${windows.length} vensters`);

    // Taal-instructie voor naam + definitie.
    const languageDirective = {
      nl: '- name: de gangbare Nederlandse vakterm (internationale Engelse termen mogen als ze zo in het Nederlandse veld gebruikt worden)\n- definition: een heldere definitie van 1-2 zinnen in het NEDERLANDS',
      en: '- name: the common English term for the concept\n- definition: a clear 1-2 sentence definition in ENGLISH',
      auto: '- name: the concept term in the SAME language as the course material below\n- definition: a clear 1-2 sentence definition in the SAME language as the course material below',
    }[conceptLanguage];

    const buildExtractionPrompt = (combinedText) => `Je bent een vakexpert die universitair cursusmateriaal aan de VU Amsterdam analyseert.

Analyseer de onderstaande tekst uit universitair cursusmateriaal. Identificeer ALLE relevante vakbegrippen die studenten moeten kennen en kunnen uitleggen — ook als ze slechts terloops of impliciet in de tekst voorkomen. Dit is één deel van de cursus: noem de vakbegrippen die in DIT deel aan bod komen (meestal 10 à 25). Geen alledaagse woorden die in elk vak voorkomen (zoals "effect", "metingen", "criterium", "correctie"), geen losse letters of symbolen (zoals "n", "x", "z"), geen formules (zoals "t = 0") en geen personen, dagen of voorbeelden uit een casus als kernbegrip.

BELANGRIJK: kies de begripsnamen zó dat ze letterlijk of bijna-letterlijk in het onderstaande cursusmateriaal voorkomen, want de namen worden daarna automatisch tegen dat materiaal geverifieerd.

Voordat je een begrip opneemt: zou een docent een student ooit letterlijk vragen "Wat bedoelen we met [naam]?" en is daar een eenduidig, feitelijk antwoord op? Zo niet, neem het NIET op.

NIET geschikt als begrip (ook al staat het letterlijk in de tekst):
- Een waardeoordeel of moeilijkheidsbeoordeling ÓVER de tekst/stof zelf, bv. "methodologisch zeer uitdagend", "belangrijk aspect", "kernpunt van deze paragraaf" — dit ZIJN geen vaktermen, dit is commentaar op vaktermen
- Een volledige zin, samenvatting of instructie in plaats van een opzoekbare term
- Een naam die alleen bestaat uit een intensiveerder + evaluatief bijvoeglijk naamwoord (bv. "zeer complex", "erg belangrijk") zonder een concreet vakinhoudelijk zelfstandig naamwoord

Er is een extra classificatie nodig: elk begrip moet duidelijk worden ingedeeld in één van deze rollen:
- main_course_concept: kernbegrip van de cursus, vaak in definities, modellen, methoden of kernprincipes
- module_concept: relevant voor een module of hoofdstuk, maar niet per se de hele cursus
- definition_term: een term die direct wordt gedefinieerd of geformaliseerd
- method_term: een methode, techniek, model of analyse-aanpak
- latent_concept: een concept dat impliciet in de tekst aanwezig is (niet met een kopje gemarkeerd) maar WEL een concrete, opzoekbare vakterm heeft — GEEN vrije samenvatting of oordeel zonder vaste term
- example_instance: alleen een voorbeeld, casus, product, dataset, persoon, merk of illustratie; géén echt quiz-topic

Geschikte begrippen zijn onder meer:
- Termen die in de tekst gedefinieerd of toegelicht worden
- Vakinhoudelijke concepten, methoden en technieken
- Belangrijke formules, modellen of procedures
- Termen die met kopjes, secties of gemarkeerde tekst worden benadrukt
- Prikkelende voorbeelden moeten als example_instance worden gemarkeerd, niet als echte kernbegrippen

Beoordeel ook hoe MOEILIJK het begrip is voor een bachelorstudent, uitsluitend op basis van wat de definitie/tekst zelf vereist om te begrijpen (niet op basis van hoe vaak het voorkomt):
- easy: rechtstreeks af te leiden uit de naam/definitie zelf, geen voorkennis van andere begrippen nodig, één enkel idee
- medium: vereist begrip van één onderliggend mechanisme of de relatie tussen twee elementen
- hard: vereist het combineren van meerdere begrippen, redeneren over meerdere stappen, of een precies onderscheid met een vergelijkbaar begrip

Geef elk gevonden begrip de volgende velden:
${languageDirective}
- concept_role: exact één van main_course_concept | module_concept | definition_term | method_term | latent_concept | example_instance
- difficulty: exact één van easy | medium | hard

Geef UITSLUITEND een JSON-array terug, zonder extra tekst of uitleg:
[
  {"name": "Begrip naam", "definition": "Definitie hier.", "concept_role": "main_course_concept", "difficulty": "medium"}
]

CURSUSMATERIAAL:
${combinedText}`;

    // OpenAI heeft een tokens-per-minute-limiet; bij grote cursussen lopen
    // we daar snel tegenaan. We doen 1 retry met backoff (we lezen de
    // gevraagde wachttijd uit de foutmelding indien aanwezig). Als ook de
    // tweede poging faalt, geven we een Nederlandstalige melding terug
    // — en omdat de replace-stap pas later in deze handler draait,
    // verliest de cursus géén begrippen meer als de extractie crasht.
    // Robuust per venster (2026-10-18, Microbiologie: 534 vensters): een
    // snelheidslimiet, een tijdelijke serverfout (5xx) of een netwerkhapering
    // (ECONNRESET, "fetch failed") wordt met een pauze opnieuw geprobeerd en
    // gooit NOOIT: één hapering brak eerder de hele extractie af na 295 vensters.
    async function callOpenAI(prompt, maxRetries = 5) {
      let last = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let resp;
        try {
          resp = await openaiChatCompletion({
            model: OPENAI_MODEL,
            messages: [{ role: 'user', content: prompt }],
            ...chatModelParams({ temperature: 0.2, maxTokens: 8192 }),
          });
        } catch (netErr) {
          last = { resp: null, errData: { error: { message: `Netwerkfout: ${netErr?.cause?.code || netErr?.message || netErr}` } } };
          if (attempt === maxRetries) return last;
          const waitMs = Math.min(60000, 3000 * 2 ** attempt);
          console.warn(`[extract-concepts] netwerkfout (${netErr?.cause?.code || netErr?.message}), wacht ${waitMs}ms en probeer opnieuw…`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        if (resp.ok) return { resp, errData: null };
        const errData = await resp.json().catch(() => ({}));
        last = { resp, errData };
        const isRateLimit = resp.status === 429 || errData?.error?.code === 'rate_limit_exceeded';
        const isTransient = resp.status >= 500;
        if ((!isRateLimit && !isTransient) || attempt === maxRetries) return last;
        const msg = errData?.error?.message || '';
        const m = msg.match(/try again in ([\d.]+)s/i);
        const waitMs = m ? Math.min(60000, Math.ceil(parseFloat(m[1]) * 1000) + 500) : Math.min(60000, 5000 * 2 ** attempt);
        console.warn(`[extract-concepts] ${isRateLimit ? 'snelheidslimiet' : `serverfout ${resp.status}`}, wacht ${waitMs}ms en probeer opnieuw…`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      return last || { resp: null, errData: { error: { message: 'Onbereikbaar' } } };
    }

    // JSON uit het antwoord halen; bij een afgekapt antwoord de complete
    // objecten redden. Leeg = niets bruikbaars in dit venster.
    function parseExtractedConcepts(rawContent) {
      try {
        const jsonMatch = rawContent.match(/\[[\s\S]*\]/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
      } catch { /* val terug op losse objecten */ }
      const out = [];
      for (const m of rawContent.matchAll(/\{\s*"name"\s*:\s*"[^"]+"\s*,[\s\S]*?\}/g)) {
        try { const obj = JSON.parse(m[0]); if (obj.name && obj.definition) out.push(obj); } catch { /* skip */ }
      }
      return out;
    }

    // Per venster een aanroep (hooguit 3 tegelijk i.v.m. de tokenlimiet).
    let windowsDone = 0;
    req.__onProgress?.({ step: 'reading', done: 0, total: windows.length });
    const windowResults = await mapLimit(windows, 4, async (w) => {
      const result = await (async () => {
        try {
          const { resp, errData } = await callOpenAI(buildExtractionPrompt(w.text));
          if (!resp || !resp.ok) return { documentId: w.documentId, error: errData, concepts: [] };
          const data = await resp.json();
          const list = parseExtractedConcepts(data.choices?.[0]?.message?.content || '');
          return { documentId: w.documentId, concepts: Array.isArray(list) ? list : [] };
        } catch (winErr) {
          // Nooit de hele extractie laten vallen om één venster.
          return { documentId: w.documentId, error: { error: { message: winErr?.message || String(winErr) } }, concepts: [] };
        }
      })();
      windowsDone++;
      req.__onProgress?.({ step: 'reading', done: windowsDone, total: windows.length });
      console.log(`[extract-concepts] venster ${windowsDone}/${windows.length} klaar (${result.concepts.length} kandidaten${result.error ? ', MISLUKT' : ''})`);
      return result;
    });
    const failedWindows = windowResults.filter((r) => r.error);
    if (failedWindows.length === windowResults.length) {
      const llmErrData = failedWindows[0]?.error;
      console.error('[extract-concepts] LLM error (alle vensters):', llmErrData);
      const isRateLimit = llmErrData?.error?.code === 'rate_limit_exceeded';
      const friendly = isRateLimit
        ? 'De LLM-aanbieder heeft een token-limiet bereikt. Wacht een minuutje en probeer opnieuw, of selecteer minder documenten in één keer.'
        : 'LLM-extractie mislukt. Bestaande begrippen zijn ongemoeid gelaten.';
      return res.status(503).json({ error: friendly, details: llmErrData });
    }
    if (failedWindows.length > 0) {
      console.warn(`[extract-concepts] ${failedWindows.length} van ${windowResults.length} vensters mislukt; de rest wordt verwerkt.`);
    }
    // Elk kandidaat-begrip onthoudt uit welk document het komt.
    const extractedConcepts = windowResults.flatMap((r) =>
      r.concepts.map((c) => ({ ...c, documentIds: [r.documentId] })));

    if (!Array.isArray(extractedConcepts) || extractedConcepts.length === 0) {
      await writeRegenTimestamp().catch(() => {});
      return res.json({ concepts: [], message: 'Geen begrippen gevonden in LLM-respons' });
    }

    const rawValidConcepts = extractedConcepts
      .map((c) => {
        const conceptRole = normalizeConceptRole(c?.concept_role || c?.category || classifyConceptRole(c?.name, c?.definition));
        const difficulty = normalizeDifficulty(c?.difficulty) || classifyConceptDifficulty(c?.name, c?.definition);
        return { ...c, concept_role: conceptRole, category: c?.category || conceptRole, difficulty };
      })
      // Geen losse letters/symbolen of formules als begripsnaam.
      .filter((c) => c.name && c.definition && isUsableConceptName(c.name));

    // Vangnet vóór de (dure) RAG-verificatie: een naam die uitsluitend een
    // waardeoordeel over de stof is (bv. "Methodologisch zeer uitdagend") is
    // geen vakterm, ook al staat hij letterlijk in de tekst en zou hij dus de
    // similarity-check kunnen doorstaan. Zie isMetaCommentaryName in
    // conceptExtraction.js voor het criterium.
    const metaRejected = [];
    let candidateConcepts = [];
    for (const c of rawValidConcepts) {
      if (isMetaCommentaryName(c.name)) {
        metaRejected.push({ concept: c, matchedCount: 0, maxScore: 0, candidates: 0, reason: 'meta_commentary' });
      } else {
        candidateConcepts.push(c);
      }
    }
    if (metaRejected.length > 0) {
      console.log(`[extract-concepts] ${metaRejected.length} kandidaten afgewezen als waardeoordeel/commentaar (geen vakterm): ${metaRejected.map((r) => `"${r.concept.name}"`).join(', ')}`);
    }

    // SAMENVOEGEN vóór de (dure) verificatie. 1) Zekere spellingvarianten
    // (conceptKey). 2) Synoniemen/afkortingen/vertalingen via het taalmodel,
    // samen met de begrippen die al in de cursus staan: een bestaand begrip
    // wint altijd, de andere namen worden alias. Zie conceptConsolidation.js.
    const { data: existingForMerge } = await supabaseAdmin
      .from('concepts').select('id, name, definition, aliases, source_document_ids').eq('course_id', courseId);
    const existingList = existingForMerge || [];
    const existingByKey = new Map(existingList.map((c) => [conceptKey(c.name), c]));
    const aliasUpdates = new Map(); // bestaand begrip-id → { aliases:Set, docs:Set }
    const addToExisting = (row, aliases, docs) => {
      const e = aliasUpdates.get(row.id) || { row, aliases: new Set(), docs: new Set() };
      (aliases || []).forEach((a) => { if (a && a.toLowerCase().trim() !== row.name.toLowerCase().trim()) e.aliases.add(a); });
      (docs || []).forEach((d) => d && e.docs.add(d));
      aliasUpdates.set(row.id, e);
    };
    req.__onProgress?.({ step: 'merging', done: 0, total: 1 });
    const beforeMerge = candidateConcepts.length;
    candidateConcepts = mergeByKey(candidateConcepts);
    // Kandidaat = spellingvariant van een bestaand begrip → alias van dat begrip.
    // (Precies dezelfde naam blijft in de lijst: die ververst rol/bewijs zoals voorheen.)
    // Kandidaat = alias van een bestaand begrip ("z-verdeling" bij "standaardnormale
    // verdeling") → ook geen nieuw begrip, anders staat het er twee keer in.
    const existingByAliasKey = new Map();
    for (const c of existingList) {
      for (const a of c.aliases || []) {
        const k = conceptKey(a);
        if (k && !existingByKey.has(k) && !existingByAliasKey.has(k)) existingByAliasKey.set(k, c);
      }
    }
    const sureExisting = [];
    candidateConcepts = candidateConcepts.filter((c) => {
      const ex = existingByKey.get(conceptKey(c.name)) || existingByAliasKey.get(conceptKey(c.name));
      if (!ex) return true;
      addToExisting(ex, [c.name, ...(c.aliases || [])], c.documentIds);
      if (ex.name.toLowerCase().trim() === c.name.toLowerCase().trim()) return true;
      sureExisting.push(c.name);
      return false;
    });
    let synonymMerged = [];
    if (AZURE_CHAT_READY && candidateConcepts.length > 1) {
      try {
        const items = [
          ...existingList.map((c) => ({ name: c.name, definition: c.definition })),
          ...candidateConcepts.filter((c) => !existingByKey.has(conceptKey(c.name))),
        ];
        const synResp = await openaiChatCompletion({
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content: buildSynonymPrompt(items) }],
          ...chatModelParams({ temperature: 0, maxTokens: 4000 }),
        });
        if (synResp.ok) {
          const synData = await synResp.json();
          const groups = parseSynonymGroups(synData.choices?.[0]?.message?.content || '', items.map((i) => i.name));
          const applied = applySynonymGroups(candidateConcepts, existingList.map((c) => c.name), groups);
          candidateConcepts = applied.kept;
          synonymMerged = applied.mergedAway;
          for (const [name, v] of applied.toExisting) {
            const row = existingList.find((c) => c.name === name);
            if (row) addToExisting(row, v.aliases, v.documentIds);
          }
        }
      } catch (synErr) {
        console.warn('[extract-concepts] Synoniem-samenvoegstap mislukt, ga door zonder:', synErr.message);
      }
    }
    console.log(`[extract-concepts] Samenvoegen: ${beforeMerge} kandidaten → ${candidateConcepts.length} (${sureExisting.length} spellingvariant van bestaand, ${synonymMerged.length} synoniem samengevoegd)`);

    // VERIFICATIE-STAP: vergelijk elk LLM-kandidaat-begrip met RAG-chunks
    // (eigen instellingen, los van chat/explain/quiz/project)
    const allSettings = await loadRagSettings(courseId);
    const extractionSettings = allSettings.extraction || RAG_EXTRACTION_DEFAULTS;
    const verifyThreshold = extractionSettings.similarity_threshold;
    const minEvidence = extractionSettings.min_evidence_chunks;

    console.log(`[extract-concepts] Verificatie: ${candidateConcepts.length} kandidaten met drempel ${verifyThreshold.toFixed(2)} en min ${minEvidence} bewijschunks`);

    let verified = 0;
    let verifyFailed = 0;
    req.__onProgress?.({ step: 'verifying', done: 0, total: candidateConcepts.length });
    const verificationResults = await mapLimit(candidateConcepts, 6, async (c) => {
      const out = await (async () => {
        // Query-expansion met de eigen (LLM-gegenereerde) definitie: een kale
        // naam als "behandeling" of "toeval" draagt weinig semantisch signaal
        // en scoort daardoor vaak net onder de drempel tegen chunk-tekst, ook
        // al is het begrip zelf prima onderbouwd. De definitie zelf toevoegen
        // aan de embedding-query (dezelfde expandQuery die chat/explain/quiz
        // al gebruiken) geeft méér context zonder de drempel te verlagen —
        // dus zonder de bewijseis te verzwakken.
        // Eén netwerkhapering mag de verificatie niet afbreken: twee keer
        // opnieuw proberen, daarna telt dit begrip als "niet te controleren"
        // (gemeld in het resultaat, niet stil weggegooid).
        let result = null;
        for (let attempt = 0; attempt < 3 && !result; attempt++) {
          try {
            result = await searchChunksServerSide(
              c.name, verifyThreshold, 10, ragFolderIds,
              { enabled: true, definition: c.definition },
              conceptLanguage === 'en' ? 'en' : 'nl',
              'concepts'
            );
          } catch (vErr) {
            if (attempt === 2) { verifyFailed++; console.warn(`[extract-concepts] verificatie mislukt voor "${c.name}":`, vErr?.message || vErr); }
            else await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
          }
        }
        return {
          concept: c,
          matchedCount: result?.matched?.length || 0,
          maxScore: result?.maxScore || 0,
          candidates: result?.candidatesInAllowed || 0,
          // Task #243: bewaar de ondersteunende chunks zodat we ze later als
          // begrip-bronkoppeling kunnen wegschrijven (i.p.v. weggooien).
          matched: result?.matched || [],
          // Hergebruikt voor near-duplicate-detectie (mergeNearDuplicateConcepts)
          // — geen extra embedding-call nodig, de naam is al geëmbed voor de
          // RAG-verificatie hierboven.
          embedding: result?.embedding || null,
        };
      })();
      verified++;
      if (verified % 10 === 0 || verified === candidateConcepts.length) req.__onProgress?.({ step: 'verifying', done: verified, total: candidateConcepts.length });
      return out;
      });

    const rejectedConcepts = [...metaRejected];
    const acceptedResults = [];
    // Reserve voor een minimum: wél bewijs (≥ 1 fragment), maar onder de
    // ingestelde minimale bewijsdrempel. Nooit kandidaten zonder bewijs.
    const reserveResults = [];
    for (const r of verificationResults) {
      if (r.matchedCount >= minEvidence) {
        acceptedResults.push(r);
      } else {
        rejectedConcepts.push(r);
        if (r.matchedCount >= 1) reserveResults.push(r);
      }
    }

    // Spellings-/verbuigingsvarianten en synoniemen ("Genest" vs "Geneste
    // patiënt controleonderzoek", "Cross-over onderzoek" vs "Cross-over
    // studie") zijn hetzelfde begrip — samenvoegen vóórdat het (eventuele)
    // maximum aantal begrippen wordt toegepast, anders "verspilt" de docent
    // ingestelde limiet plekken aan duplicaten van hetzelfde begrip.
    //
    // Dit moet OOK tegen al-bestaande cursusbegrippen gebeuren, niet alleen
    // binnen deze batch: de LLM formuleert hetzelfde begrip niet elke run
    // identiek (temperature>0, andere chunk-volgorde), dus "Genest ..." uit
    // een eerdere hergenereer-run en "Geneste ..." uit een latere run kwamen
    // zonder dit nooit samen in dezelfde vergelijking (bug: bleven beide
    // permanent naast elkaar staan). Bestaande namen worden er daarom als
    // "altijd-winnende" pseudo-kandidaten (maxScore=Infinity) bijgevoegd: een
    // nieuwe kandidaat die daarmee clustert wordt niet ingevoegd, de
    // bestaande rij (met zijn eigen review_status/evidence) blijft intact.
    let existingConceptRows = [];
    if (conceptsHasCourseId) {
      const { data } = await supabaseAdmin.from('concepts').select('id, name').eq('course_id', courseId);
      existingConceptRows = data || [];
    } else {
      const { data } = await supabaseAdmin.from('concepts').select('id, name').contains('key_points', [courseMarker]);
      existingConceptRows = data || [];
    }

    let dedupInput = acceptedResults;
    let existingPseudoCount = 0;
    if (existingConceptRows.length > 0) {
      try {
        const existingEmbeddings = await embedTextsServer(existingConceptRows.map((c) => c.name), null);
        const pseudoExisting = existingConceptRows.map((c, i) => ({
          concept: { name: c.name },
          embedding: existingEmbeddings[i],
          maxScore: Infinity,
          __existing: true,
        }));
        dedupInput = [...pseudoExisting, ...acceptedResults];
        existingPseudoCount = pseudoExisting.length;
      } catch (embErr) {
        console.error('[extract-concepts] Embedden van bestaande begripsnamen mislukt, dedup tegen bestaande begrippen overgeslagen:', embErr.message);
      }
    }

    const { kept: keptRaw, merged: mergedRaw } = mergeNearDuplicateConcepts(dedupInput);
    const dedupedResults = keptRaw.filter((r) => !r.__existing);
    const mergedDuplicates = mergedRaw.filter((r) => !r.__existing);
    for (const r of mergedDuplicates) {
      // mergedIntoName kan nu ook een BESTAAND begrip zijn (niet alleen een
      // andere nieuwe kandidaat) — apart labelen zodat de rapportage klopt.
      const intoExisting = existingConceptRows.some((c) => c.name === r.mergedIntoName);
      rejectedConcepts.push({ ...r, reason: intoExisting ? 'exists_in_course' : 'near_duplicate' });
    }
    if (existingPseudoCount > 0 && mergedDuplicates.length > 0) {
      console.log(`[extract-concepts] ${mergedDuplicates.length} near-duplicates samengevoegd (tegen ${existingPseudoCount} bestaande + elkaar): ${mergedDuplicates.map((r) => `"${r.concept.name}" → "${r.mergedIntoName}"`).join(', ')}`);
    } else if (mergedDuplicates.length > 0) {
      console.log(`[extract-concepts] ${mergedDuplicates.length} near-duplicates samengevoegd: ${mergedDuplicates.map((r) => `"${r.concept.name}" → "${r.mergedIntoName}"`).join(', ')}`);
    }

    // Maximum aantal begrippen (docent-instelbaar in de Begrippen-tab, vlak
    // vóór "Hergenereer begrippenlijst"): zonder cap kan een rijk document
    // honderden begrippen opleveren waar een student door de bomen het bos
    // niet meer ziet. capByBestMatch behoudt de begrippen met de sterkste
    // RAG-matchkwaliteit. Dezelfde cap geldt ook bij hergenereren: een begrip
    // dat er nu buiten valt, wordt door de bestaande keep-aware opruimstap
    // verwijderd als het al bestond (net als een gewone RAG-verificatie-
    // afwijzing) — géén apart opruimpad nodig.
    // Minimum en maximum (docent-instelbaar in de Begrippen-stap):
    // selectConcepts geeft voorrang aan hoge match + lage overlap, en vult
    // onder het minimum aan uit de reserve (wél bewijs, gemarkeerd als topUp).
    // De reserve wordt eerst tegen bestaande begrippen en de selectie
    // ontdubbeld, zodat aanvullen nooit een duplicaat oplevert.
    let reserveDeduped = [];
    if (reserveResults.length > 0 && extractionSettings.min_concepts) {
      const { kept: rKept } = mergeNearDuplicateConcepts([
        ...dedupInput.filter((r) => r.__existing),
        ...dedupedResults.map((r) => ({ ...r, maxScore: Infinity, __accepted: true })),
        ...reserveResults,
      ]);
      reserveDeduped = rKept.filter((r) => !r.__existing && !r.__accepted);
    }
    const selection = selectConcepts(dedupedResults, {
      min: extractionSettings.min_concepts,
      max: extractionSettings.max_concepts,
      reserve: reserveDeduped,
    });
    const keptResults = selection.kept;
    const cappedOut = selection.cutOff;
    const toppedUpNames = new Set(selection.toppedUp.map((r) => r.concept.name.toLowerCase().trim()));

    for (const r of cappedOut) {
      rejectedConcepts.push({ ...r, reason: 'max_concepts_cap' });
    }
    if (selection.toppedUp.length > 0 || selection.shortBy > 0) {
      console.log(`[extract-concepts] Minimum ${extractionSettings.min_concepts}: ${selection.toppedUp.length} aangevuld (te beoordelen), ${selection.shortBy} tekort`);
    }

    const validConcepts = [];
    // Task #243: map begripsnaam (genormaliseerd) → top-bewijschunks. Wordt na
    // de insert/update gebruikt om de koppeling in concept_evidence te schrijven.
    const evidenceByName = new Map();
    for (const r of keptResults) {
      validConcepts.push(r.topUp ? { ...r.concept, __topUp: true } : r.concept);
      evidenceByName.set(r.concept.name.toLowerCase().trim(), r.matched);
    }

    console.log(`[extract-concepts] Verificatie klaar: ${validConcepts.length} geaccepteerd, ${rejectedConcepts.length} afgewezen (${metaRejected.length} niet-vakterm, ${mergedDuplicates.length} near-duplicate, ${cappedOut.length} boven het maximum van ${extractionSettings.max_concepts || '∞'})`);
    if (rejectedConcepts.length > 0) {
      const sample = rejectedConcepts.slice(0, 8).map(r =>
        `"${r.concept.name}" (max=${r.maxScore.toFixed(3)}, kandidaten=${r.candidates})`
      ).join(', ');
      console.log(`[extract-concepts] Voorbeeld afgewezen: ${sample}`);
    }

    // Gestructureerde lijst van afgewezen kandidaten (naam + hoogste score)
    // zodat de docent-UI precies kan tonen wat de AI vond en hoe dichtbij het
    // de drempel kwam.
    const rejectedSamples = rejectedConcepts
      .slice(0, 10)
      .map((r) => ({ name: r.concept.name, maxScore: Number(r.maxScore.toFixed(3)) }));

    // Niets te schrijven? Geef een duidelijke melding TERUG zonder de
    // bestaande begrippen weg te gooien. De gebruiker kan dan in
    // Beheer → RAG-instellingen → Extractie de drempels verlagen.
    if (validConcepts.length === 0) {
      const sampleNames = rejectedConcepts.slice(0, 6).map((r) => r.concept.name).join(', ');
      const msg = rawValidConcepts.length === 0
        ? 'De LLM vond geen begrippen in dit cursusmateriaal.'
        : `De LLM stelde ${rawValidConcepts.length} begrippen voor, maar geen enkele haalde de RAG-verificatiedrempel (similarity ≥ ${verifyThreshold.toFixed(2)}, ≥ ${minEvidence} chunks). Verlaag de drempel via Beheer → RAG-instellingen → Extractie en probeer opnieuw. Voorbeelden: ${sampleNames}.`;
      await writeRegenTimestamp().catch(() => {});
      return res.json({
        concepts: [],
        updated: 0,
        skipped: 0,
        verificationRejected: rejectedConcepts.length,
        candidatesFromLLM: rawValidConcepts.length,
        verificationThreshold: verifyThreshold,
        minEvidenceChunks: minEvidence,
        rejected: rejectedSamples,
        message: msg,
      });
    }

    // Volgorde (belangrijk): in replace/hergenereer-modus eerst de nieuwe
    // begrippen schrijven, dán pas de VEROUDERDE RAG-begrippen opruimen.
    // - Schrijven-eerst voorkomt dat de cursus leeg achterblijft als een
    //   DB-schrijfactie faalt (we keren dan met 500 terug vóór het opruimen).
    // - De opruimstap (`runReplace`) is "keep-aware": elke naam die in deze run
    //   is geëxtraheerd (keepNames) blijft behouden, dus de zojuist geschreven
    //   én de opnieuw voorgestelde begrippen worden nooit per ongeluk gewist
    //   (dat was de bug waardoor de Begrippen-tab leeg bleef). Alleen
    //   RAG-begrippen die NIET meer voorgesteld worden, worden opgeruimd.
    const ragMarker = '[RAG-geëxtraheerd uit cursusmateriaal]';
    const keepNames = new Set(validConcepts.map((c) => String(c.name || '').toLowerCase().trim()));
    let inserted = [];
    let updatedCount = 0;
    let skipped = 0;
    const verificationRejected = rejectedConcepts.length;

    if (conceptsHasCourseId) {
      const { data: existingForCourse } = await supabaseAdmin
        .from('concepts')
        .select('id, name, key_points, concept_role, category, difficulty, aliases, source_document_ids')
        .eq('course_id', courseId);

      const existingByName = new Map(
        (existingForCourse || []).map((c) => [c.name.toLowerCase().trim(), c])
      );

      const toInsert = [];
      // Verse role/difficulty-classificatie ook toepassen op begrippen die al
      // bestonden voor deze cursus (skip-van-insert ≠ skip-van-refresh): anders
      // blijft een begrip dat de LLM nu als 'example_instance' of 'hard'
      // herkent op zijn oude/ontbrekende classificatie staan bij hergenereren.
      const toRefresh = [];
      const seenInBatch = new Set();
      for (const c of validConcepts) {
        const key = c.name.toLowerCase().trim();
        const existing = existingByName.get(key);
        if (existing) {
          addToExisting(existing, c.aliases, c.documentIds);
          if (existing.concept_role !== c.concept_role || existing.difficulty !== c.difficulty) {
            toRefresh.push({
              id: existing.id,
              concept_role: c.concept_role,
              category: existing.category || c.category,
              difficulty: c.difficulty,
            });
          }
          skipped++;
          continue;
        }
        if (seenInBatch.has(key)) { skipped++; continue; }
        seenInBatch.add(key);
        toInsert.push({
          name: c.name.trim(),
          definition: c.definition.trim(),
          key_points: [ragMarker],
          examples: [],
          course_id: courseId,
          category: c.category,
          concept_role: c.concept_role,
          difficulty: c.difficulty,
          aliases: (c.aliases || []).filter((a) => a && a !== c.name),
          source_document_ids: c.documentIds || [],
          source_document_id: (c.documentIds || [])[0] || null,
          // Aangevuld om het minimum te halen (minder bewijs): docent beoordeelt.
          ...(c.__topUp ? { review_status: 'needs_review' } : {}),
        });
      }

      for (const u of toRefresh) {
        const { error: roleErr } = await supabaseAdmin
          .from('concepts')
          .update({ concept_role: u.concept_role, category: u.category, difficulty: u.difficulty })
          .eq('id', u.id);
        if (roleErr) console.error('[extract-concepts] concept_role/difficulty refresh mislukt:', roleErr.message);
      }

      if (toInsert.length > 0) {
        // GEEN upsert/onConflict hier: de per-cursus uniekheid
        // (concepts_name_course_unique) is een PARTIËLE index (WHERE
        // course_id IS NOT NULL, naast een aparte globale index voor
        // course_id IS NULL — nodig omdat dat twee verschillende
        // uniekheidsregels zijn). PostgREST's upsert genereert altijd een
        // ON CONFLICT zonder WHERE-predicaat, en dat matcht NOOIT een
        // partiële index ("no unique or exclusion constraint matching the
        // ON CONFLICT specification") — vandaar de fout die je zag.
        // toInsert bevat sowieso alleen namen die al gededupliceerd zijn
        // tegen bestaande cursusbegrippen (existingByName) en binnen deze
        // batch (seenInBatch); een plain insert dekt dus het normale geval.
        // Bij een echte race (twee gelijktijdige "Hergenereer"-runs) valt
        // dit terug op rij-voor-rij zodat alleen de botsende naam wegvalt,
        // niet de hele batch.
        const { data: batchIns, error: batchErr } = await supabaseAdmin
          .from('concepts')
          .insert(toInsert)
          .select('id, name, category, concept_role, difficulty, definition');
        if (!batchErr) {
          inserted = batchIns || [];
        } else if (batchErr.code === '23505' || /duplicate key/i.test(batchErr.message || '')) {
          console.warn('[extract-concepts] Insert-race (course_id path), val terug op rij-voor-rij:', batchErr.message);
          const rowsOk = [];
          for (const row of toInsert) {
            const { data: single, error: singleErr } = await supabaseAdmin
              .from('concepts')
              .insert(row)
              .select('id, name, category, concept_role, difficulty, definition')
              .maybeSingle();
            if (singleErr) {
              const isDup = singleErr.code === '23505' || /duplicate key/i.test(singleErr.message || '');
              if (!isDup) console.error('[extract-concepts] Rij-insert mislukt (course_id path):', singleErr.message);
              continue;
            }
            if (single) rowsOk.push(single);
          }
          inserted = rowsOk;
        } else {
          console.error('[extract-concepts] Insert error (course_id path):', batchErr);
          return res.status(500).json({ error: `Begrippen opslaan mislukt: ${batchErr.message}` });
        }
      }
    } else {
      // planConceptWrites herkent bestaande (gedeelde/handmatige) begrippen:
      // al voor deze cursus gemarkeerd → overslaan/behouden; zelfde naam in een
      // andere cursus → bijwerken (delen); anders → nieuw invoegen. De oude
      // RAG-begrippen worden pas ná deze schrijfstap opgeruimd (keep-aware).
      const { data: allExisting } = await supabaseAdmin
        .from('concepts')
        .select('id, name, key_points, concept_role, category, difficulty');

      const { toInsert, toUpdate, skipped: skippedCount } = planConceptWrites(
        validConcepts, allExisting, { courseMarker, ragMarker }
      );
      skipped = skippedCount;

      for (const u of toUpdate) {
        const { error: updErr } = await supabaseAdmin
          .from('concepts')
          .update({ key_points: u.key_points, category: u.category, concept_role: u.concept_role, difficulty: u.difficulty })
          .eq('id', u.id);
        if (updErr) {
          // Hard falen vóór de opruimstap: een gedeeltelijke schrijfactie mag
          // nooit gevolgd worden door runReplace, anders verdwijnen verouderde
          // RAG-begrippen terwijl de bedoelde updates niet zijn doorgevoerd.
          console.error('[extract-concepts] Update error (key_points path):', updErr);
          return res.status(500).json({ error: `Begrippen bijwerken mislukt: ${updErr.message}` });
        }
        updatedCount += 1;
      }

      if (toInsert.length > 0) {
        // Gebruik upsert met ignoreDuplicates zodat begrippen waarvan de naam
        // al bestaat (bv. via een race-condition of een dubbel LLM-resultaat)
        // worden overgeslagen in plaats van een constraint-fout te geven.
        const { data: ins, error: insertError } = await supabaseAdmin
          .from('concepts')
          .upsert(toInsert, { onConflict: 'name', ignoreDuplicates: true })
          .select('id, name, category, concept_role, difficulty, definition');
        if (insertError) {
          console.error('[extract-concepts] Insert error (key_points path):', insertError);
          return res.status(500).json({ error: `Begrippen opslaan mislukt: ${insertError.message}` });
        }
        inserted = ins || [];
      }
    }

    // Schrijven gelukt — nu pas de VEROUDERDE RAG-begrippen opruimen
    // (keep-aware: namen uit deze run blijven behouden). Door dit ná de
    // succesvolle insert/update te doen blijft de cursus nooit leeg achter.
    try {
      await runReplace(keepNames);
    } catch (replaceErr) {
      console.error('[extract-concepts] runReplace na schrijven mislukt:', replaceErr);
      // De nieuwe begrippen staan al opgeslagen; we loggen de opruimfout maar
      // laten de geschreven begrippen staan in plaats van te falen.
    }

    // Task #243: schrijf de begrip ↔ bronfragment-koppeling weg. Voor elk
    // geaccepteerd begrip dat nu in de cursus bestaat (nieuw, bijgewerkt of
    // reeds aanwezig) bewaren we de top-bewijschunks uit de verificatiestap.
    // Bij opnieuw extraheren worden de oude koppelingen per begrip eerst
    // opgeruimd, zodat er geen verouderde fragmenten blijven rondslingeren.
    let evidenceWritten = 0;
    let conceptsLinked = 0;
    if (conceptEvidenceSchemaReady && validConcepts.length > 0) {
      try {
        const acceptedNames = validConcepts.map((c) => c.name.toLowerCase().trim());
        // Resolveer de concept-id's die nu bij deze cursus horen.
        let conceptRows = [];
        if (conceptsHasCourseId) {
          // Case-insensitief matchen: de duplicaat-detectie elders normaliseert
          // op lowercase, dus resolveren we hier net zo om geaccepteerde
          // begrippen niet te missen door hoofdletterverschillen.
          const { data } = await supabaseAdmin
            .from('concepts')
            .select('id, name')
            .eq('course_id', courseId);
          conceptRows = (data || []).filter((c) => acceptedNames.includes(c.name.toLowerCase().trim()));
        } else {
          const { data } = await supabaseAdmin
            .from('concepts')
            .select('id, name, key_points')
            .contains('key_points', [courseMarker]);
          conceptRows = (data || []).filter((c) => acceptedNames.includes(c.name.toLowerCase().trim()));
        }

        const idsToRefresh = conceptRows.map((c) => c.id);
        if (idsToRefresh.length > 0) {
          // Verouderde koppelingen voor deze begrippen verwijderen vóór de herinsert.
          await supabaseAdmin.from('concept_evidence').delete().in('concept_id', idsToRefresh);

          const evidenceRows = [];
          for (const row of conceptRows) {
            const matched = evidenceByName.get(row.name.toLowerCase().trim()) || [];
            const top = matched.slice(0, 5);
            if (top.length > 0) conceptsLinked++;
            for (const m of top) {
              evidenceRows.push({
                concept_id: row.id,
                course_id: courseId,
                document_id: m.document_id || null,
                chunk_id: m.id || null,
                snippet: typeof m.content === 'string' ? sanitizeText(m.content).slice(0, 4000) : '',
                similarity: Number.isFinite(m.similarity) ? m.similarity : 0,
              });
            }
          }

          if (evidenceRows.length > 0) {
            const { error: evErr } = await supabaseAdmin.from('concept_evidence').insert(evidenceRows);
            if (evErr) {
              console.error('[extract-concepts] concept_evidence insert error:', evErr.message);
            } else {
              evidenceWritten = evidenceRows.length;
            }
          }
        }
        console.log(`[extract-concepts] Bewijskoppeling: ${conceptsLinked} begrippen, ${evidenceWritten} fragmenten`);
      } catch (evErr) {
        console.error('[extract-concepts] Bewijskoppeling wegschrijven mislukt:', evErr.message);
      }
    }

    // Aliassen en bron-documenten bijwerken bij bestaande begrippen.
    for (const { row, aliases, docs } of aliasUpdates.values()) {
      const nextAliases = [...new Set([...(row.aliases || []), ...aliases])];
      const nextDocs = [...new Set([...(row.source_document_ids || []), ...docs])];
      if (nextAliases.length === (row.aliases || []).length && nextDocs.length === (row.source_document_ids || []).length) continue;
      const { error: aErr } = await supabaseAdmin.from('concepts')
        .update({ aliases: nextAliases, source_document_ids: nextDocs }).eq('id', row.id);
      if (aErr) console.warn('[extract-concepts] alias/documenten bijwerken mislukt:', aErr.message);
    }

    // Zekere dubbelingen in de bestaande lijst (spellingvarianten) automatisch
    // samenvoegen; twijfelgevallen gaan als voorstel naar de docent.
    let sureMerged = 0;
    try {
      const { data: allRows } = await supabaseAdmin.from('concepts')
        .select('id, name, review_status, definition, aliases, source_document_ids').eq('course_id', courseId);
      for (const plan of planSureMerges(allRows || [])) {
        const { data: n, error: mErr } = await supabaseAdmin.rpc('merge_concepts', { keep_id: plan.keepId, dup_ids: plan.dupIds });
        if (mErr) console.warn('[extract-concepts] samenvoegen mislukt:', mErr.message);
        else sureMerged += Number(n) || 0;
      }
      if (sureMerged) console.log(`[extract-concepts] ${sureMerged} zekere dubbeling(en) samengevoegd`);
    } catch (mErr) {
      console.warn('[extract-concepts] zekere samenvoegingen overgeslagen:', mErr.message);
    }

    // Overzicht per document: hoeveel kandidaten en hoeveel begrippen nu.
    const documentCoverage = await conceptCoverageByDocument(courseId, docIds, extractedConcepts);

    const totalAdded = inserted.length + updatedCount;
    // netTotal = totalAdded + skipped is het aantal begrippen dat NA deze run
    // echt voor de cursus bestaat (skipped = begrip bestond al en blijft
    // gewoon staan, is dus NIET weggegooid). Bij een ingesteld maximum is dit
    // exact dat maximum (of minder, als er binnen de batch een naam-botsing
    // was) — dat was voor een docent niet duidelijk uit "X gegenereerd, Y
    // overgeslagen", vandaar de expliciete "totaal voor deze cursus"-melding.
    const netTotal = totalAdded + skipped;

    console.log(`[extract-concepts] Done for course ${courseId}: ${inserted.length} new, ${updatedCount} updated, ${skipped} already tagged, ${verificationRejected} afgewezen door verificatie`);

    await writeRegenTimestamp().catch(() => {});

    // Splits de afwijzingsreden uit i.p.v. alles onder "RAG-verificatie" te
    // groeperen: sinds de near-duplicate-merge en de max_concepts-cap zitten
    // daar nu ook andere redenen in, en die op één hoop noemen als "RAG-
    // verificatie" zou zelf weer verwarrend zijn (net als "overgeslagen").
    const pureVerificationRejected = Math.max(0, rejectedConcepts.length - metaRejected.length - mergedDuplicates.length - cappedOut.length);
    const reasonParts = [];
    if (pureVerificationRejected > 0) reasonParts.push(`${pureVerificationRejected} onvoldoende RAG-bewijs`);
    if (metaRejected.length > 0) reasonParts.push(`${metaRejected.length} geen vakterm`);
    if (mergedDuplicates.length > 0) reasonParts.push(`${mergedDuplicates.length} samengevoegd als duplicaat`);
    if (cappedOut.length > 0) reasonParts.push(`${cappedOut.length} boven het maximum`);
    const verifMsg = reasonParts.length > 0 ? ` — ${reasonParts.join(', ')} afgewezen` : '';
    // Minimum: aangevuld en/of niet gehaald. Niet gehaald = er zijn te weinig
    // begrippen MET bewijs; dat wijst op dun materiaal of een mislukte
    // verwerking, niet op een reden om zonder bewijs aan te vullen.
    const minParts = [];
    if (selection.toppedUp.length > 0) minParts.push(`${selection.toppedUp.length} aangevuld om het minimum te halen (minder bewijs, te beoordelen)`);
    if (selection.shortBy > 0) minParts.push(`minimum van ${extractionSettings.min_concepts} niet gehaald: er zijn te weinig begrippen met bewijs in het materiaal; controleer of alle documenten goed verwerkt zijn`);
    const minMsg = minParts.length > 0 ? `. ${minParts.join('; ')}` : '';
    // Vensters die ondanks herhaalpogingen niet gelezen konden worden, en
    // begrippen die niet te controleren waren: zichtbaar melden, nooit stil.
    const failedDocTitles = [...new Set(failedWindows.map((r) => docs.find((d) => d.id === r.documentId)?.title).filter(Boolean))];
    const failedList = failedDocTitles.slice(0, 5).join(', ') + (failedDocTitles.length > 5 ? ', …' : '');
    const failMsg = failedWindows.length > 0
      ? `. Let op: ${failedWindows.length} van ${windows.length} delen konden niet gelezen worden (${failedList}); begrippen uit die delen kunnen ontbreken. Start de extractie later opnieuw`
      : '';
    const verifyFailMsg = verifyFailed > 0 ? `. Let op: ${verifyFailed} begrippen konden door een verbindingsfout niet gecontroleerd worden en zijn niet opgenomen` : '';

    return res.json({
      concepts: inserted,
      updated: updatedCount,
      skipped,
      netTotal,
      verificationRejected,
      candidatesFromLLM: rawValidConcepts.length,
      verificationThreshold: verifyThreshold,
      minEvidenceChunks: minEvidence,
      rejected: rejectedSamples,
      language: conceptLanguage,
      evidenceWritten,
      conceptsLinked,
      windows: windows.length,
      failedWindows: failedWindows.length,
      synonymsMerged: synonymMerged.length + sureExisting.length,
      sureMerged,
      documentCoverage,
      minConcepts: extractionSettings.min_concepts ?? null,
      maxConcepts: extractionSettings.max_concepts ?? null,
      toppedUp: [...toppedUpNames],
      shortBy: selection.shortBy,
      failedDocuments: failedDocTitles,
      verifyFailed,
      message: `${netTotal} begrippen totaal voor deze cursus (${totalAdded} nieuw/bijgewerkt, ${skipped} al aanwezig)${verifMsg}${minMsg}${failMsg}${verifyFailMsg}`,
    });
  } catch (err) {
    console.error('[extract-concepts] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// ── Als achtergrondtaak ─────────────────────────────────────────────────────
// De hele cursus lezen duurt minuten; een verzoek van die lengte wordt door
// proxy's (bv. in de VU-hosting) vaak afgebroken. De app start daarom een taak
// en vraagt de voortgang op. Taken leven in het geheugen van dit proces
// (verdwijnen bij een herstart) en zijn alleen zichtbaar voor wie ze startte.
const conceptJobs = new Map();

const CONCEPT_JOB_TTL_MS = 60 * 60 * 1000;

// Volgorde van de begrippen in de stof (server/conceptOrder.js): waar komt elk
// begrip voor het eerst voor? Voor de lijst bij Ik leg uit en de quiz, met een
// kleurverloop van begin naar eind. 5 minuten onthouden per cursus.
const conceptOrderCache = new Map();

const CONCEPT_ORDER_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 5 * 60 * 1000;

export function registerConceptRoutes(app) {
  app.get('/api/admin/concepts-meta', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ error: 'Authorization header required' });
    }

    const { courseId } = req.query;
    if (!courseId) {
      return res.status(400).json({ error: 'courseId is required' });
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

      const { data: profile, error: profileError } = await profileCache.get(user.id, loadProfileRoleEmail);

      if (profileError || !profile) {
        return res.status(403).json({ error: 'Could not verify user role' });
      }

      if (!(await isStaffForCourse(user, profile, courseId))) {
        return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
      }

      const courseMarker = `[RAG-geëxtraheerd uit cursusmateriaal]`;
      const courseTag = `course_id:${courseId}`;

      // Sommige Supabase-instances hebben de `concepts.course_id` migratie nog
      // niet doorgevoerd — dan staat de cursuskoppeling in `key_points` als
      // `course_id:<uuid>`. Probeer eerst de combineerde OR, val terug op de
      // key_points-vorm wanneer Postgres roept dat de kolom niet bestaat.
      async function fetchCourseConcepts() {
        if (conceptsHasCourseId) {
          const { data, error } = await supabaseAdmin
            .from('concepts')
            .select('id, key_points, extraction_method, extracted_at, created_at')
            .or(`course_id.eq.${courseId},key_points.cs.{"${courseTag}"}`);
          if (!error) return { data, error: null };
          if (!String(error.message || '').includes('course_id')) return { data: null, error };
        }
        const { data, error } = await supabaseAdmin
          .from('concepts')
          .select('id, key_points, extraction_method, extracted_at, created_at')
          .contains('key_points', [courseTag]);
        return { data, error };
      }

      const { data: concepts, error: conceptsError } = await fetchCourseConcepts();

      if (conceptsError) {
        console.error('[concepts-meta] query error:', conceptsError);
        return res.status(500).json({ error: conceptsError.message });
      }

      const all = concepts || [];
      const ragConcepts = all.filter(c => (c.key_points || []).includes(courseMarker));
      const manualConcepts = all.filter(c => !(c.key_points || []).includes(courseMarker));

      let lastExtraction = null;
      for (const c of ragConcepts) {
        const ts = c.extracted_at || c.created_at;
        if (ts && (!lastExtraction || ts > lastExtraction)) {
          lastExtraction = ts;
        }
      }

      let lastDocumentChange = null;
      try {
        const { data: assignments } = await supabaseAdmin
          .from('course_folder_assignments')
          .select('folder_id')
          .eq('course_id', courseId);

        if (assignments && assignments.length > 0) {
          const assignedFolderIds = assignments.map((a) => a.folder_id);

          const { data: ragFolders } = await supabaseAdmin
            .from('document_folders')
            .select('id')
            .in('id', assignedFolderIds)
            .eq('folder_type', 'rag_sources');

          if (ragFolders && ragFolders.length > 0) {
            const ragFolderIds = ragFolders.map((f) => f.id);

            const { data: latestDocs } = await supabaseAdmin
              .from('documents')
              .select('created_at')
              .in('folder_id', ragFolderIds)
              .order('created_at', { ascending: false })
              .limit(1);

            if (latestDocs && latestDocs.length > 0) {
              lastDocumentChange = latestDocs[0].created_at;
            }
          }
        }

        const mutationKey = `__doc_mutation_${courseId}__`;
        const { data: mutationRecord } = await supabaseAdmin
          .from('chatbot_prompts').select('content').eq('name', mutationKey).maybeSingle();

        if (mutationRecord?.content) {
          try {
            const { lastMutationAt } = JSON.parse(mutationRecord.content);
            if (lastMutationAt && (!lastDocumentChange || lastMutationAt > lastDocumentChange)) {
              lastDocumentChange = lastMutationAt;
            }
          } catch { /* ignore parse errors */ }
        }
      } catch (docErr) {
        console.warn('[concepts-meta] Could not determine lastDocumentChange:', docErr.message);
      }

      let lastSuccessfulRegeneration = null;
      try {
        const regenKey = `__concepts_regen_${courseId}__`;
        const { data: regenRecord } = await supabaseAdmin
          .from('chatbot_prompts').select('content').eq('name', regenKey).maybeSingle();
        if (regenRecord?.content) {
          const { lastRegenAt } = JSON.parse(regenRecord.content);
          if (lastRegenAt) lastSuccessfulRegeneration = lastRegenAt;
        }
      } catch { /* ignore */ }

      return res.json({
        ragCount: ragConcepts.length,
        manualCount: manualConcepts.length,
        lastExtraction,
        lastDocumentChange,
        lastSuccessfulRegeneration,
      });
    } catch (err) {
      console.error('[concepts-meta] Unexpected error:', err);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // GET /api/admin/concepts/coverage?courseId= — begrippen per leerstofdocument.
  app.get('/api/admin/concepts/coverage', async (req, res) => {
    const courseId = String(req.query.courseId || '');
    if (!(await requireConceptStaff(req, res, courseId))) return;
    try {
      const docIds = await conceptSourceDocIds(courseId);
      return res.json({ documents: docIds.length ? await conceptCoverageByDocument(courseId, docIds) : [] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/concepts/merge-suggestions?courseId= — twijfelgevallen
  // (synoniemen, afkortingen, vertalingen) als voorstel; de docent beslist.
  app.get('/api/admin/concepts/merge-suggestions', async (req, res) => {
    const courseId = String(req.query.courseId || '');
    if (!(await requireConceptStaff(req, res, courseId))) return;
    if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
    try {
      const loadRows = async () => {
        const { data } = await supabaseAdmin.from('concepts')
          .select('id, name, definition, review_status, concept_role, aliases, source_document_ids').eq('course_id', courseId).order('name');
        return data || [];
      };
      // Aantal documenten per begrip, precies zoals de Begrippen-tab het indeelt
      // (concept_evidence; zie /api/concepts/evidence-summary): >1 = cursusconcept.
      const loadDocCounts = async () => {
        const { data } = await supabaseAdmin.from('concept_evidence').select('concept_id, document_id').eq('course_id', courseId);
        const sets = new Map();
        for (const r of data || []) {
          if (!r.document_id) continue;
          if (!sets.has(r.concept_id)) sets.set(r.concept_id, new Set());
          sets.get(r.concept_id).add(r.document_id);
        }
        return new Map([...sets].map(([id, s]) => [id, s.size]));
      };

      // 1. Zekere dubbelingen (spellingvariant, of naam = alias van een ander
      //    begrip) meteen samenvoegen; die hoeft de docent niet te beoordelen.
      let docCounts = await loadDocCounts();
      let list = await loadRows();
      let autoMerged = 0;
      for (const plan of planSureMerges(list.map((r) => ({ ...r, docCount: docCounts.get(r.id) || 0 })))) {
        const { data: n, error: mErr } = await supabaseAdmin.rpc('merge_concepts', { keep_id: plan.keepId, dup_ids: plan.dupIds });
        if (mErr) console.warn('[merge-suggestions] zeker samenvoegen mislukt:', mErr.message);
        else autoMerged += Number(n) || 0;
      }
      if (autoMerged) {
        console.log(`[merge-suggestions] ${autoMerged} zekere dubbeling(en) samengevoegd voor cursus ${courseId}`);
        [docCounts, list] = await Promise.all([loadDocCounts(), loadRows()]);
      }
      if (list.length < 2) return res.json({ suggestions: [], autoMerged });

      // 2. Twijfelgevallen: ruim zoeken (de docent beslist), met de klasse erbij
      //    zodat moduleconcepten die al als cursusconcept bestaan opvallen.
      const classified = list.map((r) => ({
        ...r,
        cls: r.concept_role === 'example_instance' ? 'example' : ((docCounts.get(r.id) || 0) > 1 ? 'course' : 'module'),
      }));
      const resp = await openaiChatCompletion({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: buildDuplicateSuggestionPrompt(classified) }],
        ...chatModelParams({ temperature: 0, maxTokens: 6000 }),
      });
      if (!resp.ok) return res.status(502).json({ error: 'Het taalmodel kon geen voorstellen maken.', autoMerged });
      const data = await resp.json();
      const groups = parseSynonymGroups(data.choices?.[0]?.message?.content || '', classified.map((r) => r.name));
      const { data: dismissedRow } = await supabaseAdmin.from('chatbot_prompts').select('content').eq('name', mergeDismissKey(courseId)).maybeSingle();
      let dismissed = [];
      try { dismissed = JSON.parse(dismissedRow?.content || '[]'); } catch { dismissed = []; }
      const suggestions = buildMergeSuggestions(groups, classified, new Set(dismissed));
      return res.json({ suggestions, autoMerged });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/concepts/merge { courseId, keepId, dupIds[] } — samenvoegen
  // (verwijzingen verhuizen, namen worden alias; zie merge_concepts in de DB).
  app.post('/api/admin/concepts/merge', async (req, res) => {
    const { courseId, keepId, dupIds } = req.body || {};
    if (!(await requireConceptStaff(req, res, courseId))) return;
    if (!keepId || !Array.isArray(dupIds) || dupIds.length === 0) return res.status(400).json({ error: 'keepId en dupIds zijn vereist' });
    try {
      const ids = [keepId, ...dupIds];
      const { data: rows } = await supabaseAdmin.from('concepts').select('id, course_id').in('id', ids);
      if ((rows || []).length !== ids.length || rows.some((r) => r.course_id !== courseId)) {
        return res.status(400).json({ error: 'Begrippen horen niet (allemaal) bij deze cursus' });
      }
      const { data: merged, error } = await supabaseAdmin.rpc('merge_concepts', { keep_id: keepId, dup_ids: dupIds });
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ merged: Number(merged) || 0 });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/concepts/merge-dismiss { courseId, ids[] } — voorstel negeren (blijft weg).
  app.post('/api/admin/concepts/merge-dismiss', async (req, res) => {
    const { courseId, ids } = req.body || {};
    if (!(await requireConceptStaff(req, res, courseId))) return;
    if (!Array.isArray(ids) || ids.length < 2) return res.status(400).json({ error: 'ids zijn vereist' });
    try {
      const key = mergeDismissKey(courseId);
      const { data: row } = await supabaseAdmin.from('chatbot_prompts').select('id, content').eq('name', key).maybeSingle();
      let list = [];
      try { list = JSON.parse(row?.content || '[]'); } catch { list = []; }
      const next = [...new Set([...list, groupSignature(ids)])];
      if (row) await supabaseAdmin.from('chatbot_prompts').update({ content: JSON.stringify(next), updated_at: new Date().toISOString() }).eq('id', row.id);
      else await supabaseAdmin.from('chatbot_prompts').insert({ name: key, content: JSON.stringify(next), is_active: false });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Direct (synchroon) — blijft bestaan voor bestaande aanroepers en tests.
  app.post('/api/admin/extract-concepts', extractConceptsHandler);

  app.post('/api/admin/extract-concepts/jobs', async (req, res) => {
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const courseId = req.body?.courseId;
    if (!courseId) return res.status(400).json({ error: 'courseId is required' });
    // Eén lopende taak per cursus: een tweede klik haakt aan bij de bestaande.
    for (const [id, job] of conceptJobs) {
      if (job.courseId === courseId && job.status === 'running') return res.status(202).json({ jobId: id, alreadyRunning: true });
    }
    const jobId = randomUUID();
    const job = { userId: auth.user.id, courseId, status: 'running', progress: null, httpStatus: null, result: null, startedAt: Date.now() };
    conceptJobs.set(jobId, job);
    const jobReq = { body: req.body, headers: { authorization: req.headers['authorization'] }, __onProgress: (p) => { job.progress = p; } };
    const jobRes = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) {
        job.httpStatus = this.statusCode;
        job.status = this.statusCode < 400 ? 'done' : 'error';
        job.result = body;
        job.finishedAt = Date.now();
        return this;
      },
    };
    extractConceptsHandler(jobReq, jobRes).catch((err) => {
      job.status = 'error'; job.httpStatus = 500; job.result = { error: err?.message || 'Onbekende fout' }; job.finishedAt = Date.now();
    });
    for (const [id, j] of conceptJobs) if (j.finishedAt && Date.now() - j.finishedAt > CONCEPT_JOB_TTL_MS) conceptJobs.delete(id);
    return res.status(202).json({ jobId });
  });

  app.get('/api/admin/extract-concepts/jobs/:jobId', async (req, res) => {
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const job = conceptJobs.get(req.params.jobId);
    if (!job || job.userId !== auth.user.id) return res.status(404).json({ error: 'Taak niet gevonden (mogelijk is de server herstart).' });
    return res.json({
      status: job.status,
      progress: job.progress,
      httpStatus: job.httpStatus,
      result: job.status === 'running' ? null : job.result,
      elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
    });
  });

  app.get('/api/concepts/order', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const courseId = typeof req.query.courseId === 'string' ? req.query.courseId : '';
    if (!courseId) return res.status(400).json({ error: 'courseId vereist' });
    if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    }
    try {
      const hit = conceptOrderCache.get(courseId);
      if (hit && Date.now() - hit.at < CONCEPT_ORDER_TTL_MS) return res.json({ concepts: hit.value });
      const value = await loadConceptOrder({
        db: supabaseAdmin,
        courseId,
        loadLeerlijn: (id) => cachedLeerlijn(id),
        courseFolderIds: (id) => courseRagFolderIds(id),
      });
      conceptOrderCache.set(courseId, { at: Date.now(), value });
      return res.json({ concepts: value });
    } catch (err) {
      console.warn('[concepts/order] fout:', err?.message || err);
      return res.status(500).json({ error: 'Volgorde van de begrippen kon niet worden bepaald' });
    }
  });

  app.get('/api/concepts', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available' });
    }

    const { courseId, scope } = req.query;

    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ error: 'Authorization header required' });
    }
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
    if (userError || !user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Filteren op DOEL van de aanroep, niet op wie er aanroept: Quiz en "Ik leg
    // uit" moeten de door de docent goedgekeurde lijst tonen aan IEDEREEN — ook
    // aan de docent zelf die op de Quiz-pagina kijkt — want dat is precies de
    // lijst die ze proberen te controleren. Alleen de Begrippen-BEHEERTAB heeft
    // de ongefilterde lijst nodig (om af te keuren begrippen te kunnen zien/
    // beheren) en vraagt daarom expliciet ?scope=manage aan. Zonder die param
    // wordt altijd gefilterd, ongeacht rol — dat voorkomt precies de bug waarbij
    // een docent op de Quiz-pagina alsnog afgekeurde begrippen (bv. "alcohol-
    // gebruik") zag omdat die aanroep als "docent" werd behandeld i.p.v. als
    // "quiz-onderwerpenlijst". ?scope=manage wordt alleen gehonoreerd voor
    // daadwerkelijke docenten/admins — een student kan de goedkeuring dus niet
    // omzeilen door de param zelf mee te sturen.
    let canUseManageScope = false;
    if (scope === 'manage') {
      try {
        const { data: profile } = await profileCache.get(user.id, loadProfileRoleEmail);
        canUseManageScope = profile?.role === 'admin' || profile?.role === 'docent' || profile?.email === SUPERUSER_EMAIL;
      } catch { /* best effort — val terug op gefilterd */ }
    }
    const isManageView = scope === 'manage' && canUseManageScope;

    // Bestaande begrippen (van vóór de review_status-kolom, of nooit expliciet
    // gecureerd) hebben review_status='approved' als DB-default — 'null' wordt
    // hier defensief ook als goedgekeurd behandeld zodat een schema zonder deze
    // kolom (oudere Supabase-instance) nooit alles verbergt.
    const approvedOnly = (rows) => (rows || []).filter((c) => isManageView || c.review_status == null || c.review_status === 'approved');

    try {
      if (courseId) {
        if (conceptsHasCourseId) {
          const { data: courseConcepts, error: courseErr } = await supabaseAdmin
            .from('concepts')
            .select('*')
            .eq('course_id', courseId)
            .order('name');

          if (courseErr) {
            console.error('[concepts] course_id query error:', courseErr);
            return res.status(500).json({ error: courseErr.message });
          }

          // Begrippen blijven binnen hun cursus (2026-10-15): geen terugval op
          // begrippen zonder cursus of van andere cursussen.
          const own = approvedOnly(courseConcepts || []);
          return res.json({ concepts: own, source: own.length ? 'course' : 'empty' });
        } else {
          const courseMarker = `course_id:${courseId}`;
          const { data: courseConcepts, error: courseErr } = await supabaseAdmin
            .from('concepts')
            .select('*')
            .contains('key_points', [courseMarker])
            .order('name');

          if (courseErr) {
            console.error('[concepts] key_points query error:', courseErr);
            return res.status(500).json({ error: courseErr.message });
          }

          const own = approvedOnly(courseConcepts || []);
          return res.json({ concepts: own, source: own.length ? 'course' : 'empty' });
        }
      }

      // Zonder cursus: alleen het beheer (scope=manage) ziet alle begrippen;
      // studenten krijgen niets, zodat nooit begrippen van andere cursussen verschijnen.
      if (!isManageView) return res.json({ concepts: [], source: 'empty' });
      const { data: allConcepts, error: allErr } = await supabaseAdmin
        .from('concepts')
        .select('*')
        .order('name');

      if (allErr) {
        console.error('[concepts] all query error:', allErr);
        return res.status(500).json({ error: allErr.message });
      }

      return res.json({ concepts: allConcepts || [], source: 'global' });
    } catch (err) {
      console.error('[concepts] Unexpected error:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/concepts/set-approval — docent-curatie: markeer PRECIES de
  // meegegeven begrip-id's als 'approved' voor quiz/"Ik leg uit" (via GET
  // /api/concepts, de enige bron die beide student-features voeden), en alle
  // overige begrippen van deze cursus als 'rejected'. Hergebruikt de bestaande
  // (tot nu toe ongebruikte) review_status-kolom i.p.v. een nieuwe kolom/tabel.
  // LET OP: review_status staat op de begrip-RIJ, niet per cursus — een begrip
  // dat via key_points met een andere cursus gedeeld wordt, verandert dus ook
  // daar van status. Bij naam-overlap tussen cursussen is dit een bewuste
  // afweging (hergebruik van bestaand schema) i.p.v. een nieuwe join-tabel.
  app.post('/api/admin/concepts/set-approval', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ error: 'Authorization header required' });
    }
    const { courseId, approvedIds } = req.body || {};
    if (!courseId) {
      return res.status(400).json({ error: 'courseId is required' });
    }
    if (!Array.isArray(approvedIds)) {
      return res.status(400).json({ error: 'approvedIds moet een array zijn (leeg mag)' });
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

      const { data: profile, error: profileError } = await profileCache.get(user.id, loadProfileRoleEmail);
      if (profileError || !profile) {
        return res.status(403).json({ error: 'Could not verify user role' });
      }
      const isAdmin = profile.role === 'admin' || profile.email === SUPERUSER_EMAIL;
      const isDocent = !isAdmin && await isCourseTeacher(user.id, courseId);
      if (!isAdmin && !isDocent) {
        return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
      }

      let courseConceptIds;
      if (conceptsHasCourseId) {
        const { data, error } = await supabaseAdmin.from('concepts').select('id').eq('course_id', courseId);
        if (error) return res.status(500).json({ error: error.message });
        courseConceptIds = (data || []).map((c) => c.id);
      } else {
        const courseMarker = `course_id:${courseId}`;
        const { data, error } = await supabaseAdmin.from('concepts').select('id').contains('key_points', [courseMarker]);
        if (error) return res.status(500).json({ error: error.message });
        courseConceptIds = (data || []).map((c) => c.id);
      }

      const approvedSet = new Set(approvedIds);
      const toApprove = courseConceptIds.filter((id) => approvedSet.has(id));
      const toReject = courseConceptIds.filter((id) => !approvedSet.has(id));

      if (toApprove.length > 0) {
        const { error } = await supabaseAdmin.from('concepts').update({ review_status: 'approved' }).in('id', toApprove);
        if (error) return res.status(500).json({ error: `Goedkeuren mislukt: ${error.message}` });
      }
      if (toReject.length > 0) {
        const { error } = await supabaseAdmin.from('concepts').update({ review_status: 'rejected' }).in('id', toReject);
        if (error) return res.status(500).json({ error: `Afkeuren mislukt: ${error.message}` });
      }

      console.log(`[concepts/set-approval] course=${courseId} approved=${toApprove.length} rejected=${toReject.length} door ${user.id}`);
      return res.json({ approved: toApprove.length, rejected: toReject.length });
    } catch (err) {
      console.error('[concepts/set-approval] Unexpected error:', err);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // POST /api/admin/concepts/visibility { courseId, ids, visible } — zet ALLEEN
  // de genoemde begrippen van deze cursus op zichtbaar ('approved') of verborgen
  // ('rejected') voor studenten (2026-10-16, keuzelijst "Begrippen kiezen").
  // Anders dan set-approval raakt dit nooit begrippen die niet in beeld waren.
  app.post('/api/admin/concepts/visibility', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, ids, visible } = req.body || {};
    if (!courseId) return res.status(400).json({ error: 'courseId is required' });
    if (!Array.isArray(ids) || ids.length === 0 || typeof visible !== 'boolean') {
      return res.status(400).json({ error: 'Geef begrippen (ids) en zichtbaar ja/nee (visible) op' });
    }
    const isAdmin = auth.profile?.role === 'admin' || auth.profile?.email === SUPERUSER_EMAIL;
    if (!isAdmin && !(await isCourseTeacher(auth.user.id, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }
    try {
      let query = supabaseAdmin.from('concepts').select('id').in('id', ids.slice(0, 1000));
      query = conceptsHasCourseId ? query.eq('course_id', courseId) : query.contains('key_points', [`course_id:${courseId}`]);
      const { data, error } = await query;
      if (error) return res.status(500).json({ error: error.message });
      const inCourse = (data || []).map((c) => c.id);
      if (inCourse.length > 0) {
        const { error: upErr } = await supabaseAdmin.from('concepts')
          .update({ review_status: visible ? 'approved' : 'rejected' }).in('id', inCourse);
        if (upErr) return res.status(500).json({ error: upErr.message });
      }
      console.log(`[concepts/visibility] course=${courseId} ${visible ? 'zichtbaar' : 'verborgen'}=${inCourse.length} door ${auth.user.id}`);
      return res.json({ updated: inCourse.length, visible });
    } catch (err) {
      console.error('[concepts/visibility] Unexpected error:', err);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // Task #243: opgeslagen bewijsfragmenten per begrip. Wordt door "Ik leg uit"
  // gebruikt als gegarandeerde basis-context uit het cursusmateriaal, los van de
  // live RAG-zoekopdracht. Geeft een lege lijst terug als de migratie nog niet is
  // toegepast, zodat de pagina blijft werken.
  // GET /api/concepts/evidence — bron-bewijs per begrip (Task #243), cursus-scoped
  // gefilterd (Task #244). De route en zijn filterhelper staan in
  // server/conceptEvidence.js zodat de cursus-isolatie geautomatiseerd getest kan
  // worden. conceptEvidenceSchemaReady wordt asynchroon gezet, dus we geven een
  // getter mee i.p.v. de momentane waarde.
  registerConceptEvidenceRoutes(app, {
    supabaseAdmin,
    requireAuthUser,
    userHasCourseAccess,
    getSchemaReady: () => conceptEvidenceSchemaReady,
  });

  app.delete('/api/admin/concepts/:id', async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client not available — SUPABASE_SERVICE_ROLE_KEY missing' });
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ error: 'Authorization header required' });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'Concept ID is required' });
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

      const { data: profile, error: profileError } = await profileCache.get(user.id, loadProfileRoleEmail);

      if (profileError || !profile) {
        return res.status(403).json({ error: 'Could not verify user role' });
      }

      const isAdmin = profile.role === 'admin' || profile.email === SUPERUSER_EMAIL;
      if (!isAdmin) {
        return res.status(403).json({ error: 'Admin role required' });
      }

      const { error: deleteError } = await supabaseAdmin
        .from('concepts')
        .delete()
        .eq('id', id);

      if (deleteError) {
        console.error('[delete-concept] Delete error:', deleteError);
        return res.status(500).json({ error: `Verwijderen mislukt: ${deleteError.message}` });
      }

      console.log(`[delete-concept] Concept ${id} verwijderd door ${user.id}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[delete-concept] Unexpected error:', err);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });
}
