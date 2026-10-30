import { chunkPlainText } from '../rag/chunking.js';
import {
  buildNoSourcesInstructionBlock,
  buildNumberedRagContext,
  buildSourcesInstructionBlock,
  numberDocumentSources,
} from '../chat/citationSources.js';
import {
  computeEffectiveLimit as conComputeEffectiveLimit,
  computeRemaining as conComputeRemaining,
  consultationLimitMessage as conLimitMessage,
  isConsultationBlocked as conIsBlocked,
  normalizeAutoCloseHours as conNormalizeAutoCloseHours,
  normalizeExtraGrant as conNormalizeExtra,
  normalizeMaxConsultations as conNormalizeMax,
} from './consultationLimit.js';
import { feedbackRoundsState, normalizeBadgeAwardMode } from './documentReview.js';
import { purposeAllowsModule } from '../rag/filePurpose.js';
import { buildLanguageInstruction, languageEnglishName, normalizeLang } from '../i18n/languages.js';
import { authUser, isLeapAdmin, isStaffForCourse, loadProfileRoleEmail, profileCache } from '../lib/auth.js';
import {
  AZURE_CHAT_READY,
  LLM_NOT_CONFIGURED_MSG,
  OPENAI_MODEL,
  chatModelParams,
  embedTextsServer,
  openaiChatCompletion,
} from '../lib/azureOpenai.js';
import { courseRagFolderIds } from '../lib/courseData.js';
import { rejectIfFeatureOff } from '../lib/courseFeatureGate.js';
import { SUPERUSER_EMAIL, pgPool, supabaseAdmin } from '../lib/supabase.js';
import { MAX_DOC_CHARS, docUpload, extractTextFromUpload } from '../lib/uploads.js';
import { changedFaceFields, faceFields, sanitizeAvatar, syncPersonaFace } from './personaAvatar.js';
import {
  buildProjectKnowledgeContext,
  canBeKnowledge,
  chunkCounts,
  copyKnowledgeFields,
  ensureIndexed,
  filterKnowledgeIds,
  isDataDocument,
  knowledgeFieldsFrom,
  knownByMap,
  loadPersonaProjectDocs,
} from './personaKnowledge.js';
import {
  buildConductJudgeMessages as relBuildJudgeMessages,
  buildReputationPromptBlock as relBuildPromptBlock,
  clampLevel as relClampLevel,
  isBroken as relIsBroken,
  lastReason as relLastReason,
  levelKey as relLevelKey,
  levelLabel as relLevelLabel,
  nextLevel as relNextLevel,
  validateConductJudgement as relValidateJudgement,
} from './personaRelationship.js';
import { clampStartLevel, copyRoleFields, reputationActive, roleFieldsFrom } from './personaRoles.js';
import { loadRagSettings, searchChunksServerSide } from '../rag/search.js';
import { indexProjectKnowledgeText } from '../ingestion/ragProcessing.js';
import { registerRelationshipAdjustRoute } from './relationshipAdjust.js';
import { setRelationshipLevelImpl } from './threadClose.js';
import { isGroupMember, requireProjectStaff, userHasProjectAccess } from './access.js';
import { loadFeedbackContext, runEvaluatorReview } from './evaluatorReview.js';
import { autoCloseStaleThreads } from './threadCloseService.js';

// ── Kennis van persona's (personaKnowledge.js, 2026-10-27) ─────────────────
// Leerstof van de cursus die een persona kan kennen: dezelfde documenten als
// de AI-tutor (RAG-mappen van de cursus, doel leerstof of cursusinformatie).
async function courseKnowledgeDocs(courseId) {
  const folders = await courseRagFolderIds(courseId);
  if (!folders.length) return [];
  const { data } = await supabaseAdmin.from('documents')
    .select('id, title, filename, purpose').in('folder_id', folders).order('title');
  return (data || []).filter(d => purposeAllowsModule(d.purpose, 'project'));
}

function indexProjectDocForPersona(doc) {
  return indexProjectKnowledgeText(
    { documentId: doc.document_ref_id, title: doc.filename, text: doc.content_text },
    { supabaseAdmin, pgPool, chunkPlainText, embedTextsServer },
  );
}

// Na opslaan: gekozen projectdocumenten doorzoekbaar maken (achtergrond; tot dan
// gaat het begin van het document mee in het gesprek).
function indexPersonaKnowledgeInBackground(persona) {
  if (!persona?.project_id) return;
  loadPersonaProjectDocs(supabaseAdmin, persona)
    .then(docs => ensureIndexed(supabaseAdmin, docs, indexProjectDocForPersona))
    .then(({ failed }) => {
      if (failed.length) console.warn('[persona-knowledge] niet doorzoekbaar:', failed.map(f => `${f.filename}: ${f.error}`).join('; '));
    })
    .catch(e => console.warn('[persona-knowledge] indexeren mislukt:', e.message));
}

// Houdt alleen kennis over die bij deze cursus/dit project hoort (en nooit data).
async function sanitizePersonaKnowledge(fields, { courseId, projectId = null }) {
  if (!fields || Object.keys(fields).length === 0) return { fields: fields || {}, dropped: { course: [], project: [] } };
  const needCourse = Array.isArray(fields.course_knowledge_doc_ids) && fields.course_knowledge_doc_ids.length > 0;
  const needProject = Array.isArray(fields.project_knowledge_doc_ids) && fields.project_knowledge_doc_ids.length > 0;
  const [courseDocs, projectDocsRes] = await Promise.all([
    needCourse ? courseKnowledgeDocs(courseId) : Promise.resolve(null),
    needProject && projectId
      ? supabaseAdmin.from('project_documents').select('id, filename, material_kind, content_text').eq('project_id', projectId)
      : Promise.resolve({ data: needProject ? [] : null }),
  ]);
  return filterKnowledgeIds(fields, {
    courseDocIds: courseDocs ? courseDocs.map(d => d.id) : (needCourse ? [] : null),
    projectDocs: projectDocsRes?.data ?? null,
  });
}

// Fallback-helper voor de persona-chat route: zet een course_persona om naar
// een project_persona als het project nog geen persona met die naam heeft.
// Maakt een verse, onafhankelijke kopie (source_persona_id = herkomst, geen FK) conform het
// sjablonen-model. Deduplicatie op naam is bewust: in dit chat-pad is dezelfde
// naam voldoende als sleutel — bij eventuele naambotsingen wordt de bestaande
// project_persona hergebruikt, zodat studenten hun gesprekshistorie behouden.
async function ensureProjectPersonaFromCourse(projectId, coursePersonaId) {
  const { data: cp } = await supabaseAdmin
    .from('course_personas').select('*').eq('id', coursePersonaId).maybeSingle();
  if (!cp) return null;
  // Dedupliceer op naam (source_persona_id wordt niet meer als FK gebruikt).
  const { data: existing } = await supabaseAdmin
    .from('project_personas')
    .select('*')
    .eq('project_id', projectId)
    .eq('name', cp.name)
    .maybeSingle();
  if (existing) return existing;
  const { data: existingCount } = await supabaseAdmin
    .from('project_personas').select('id').eq('project_id', projectId);
  const sortOrder = (existingCount?.length || 0);
  const { data: inserted, error } = await supabaseAdmin
    .from('project_personas')
    .insert({
      project_id: projectId,
      source_persona_id: cp.id, // herkomst (geen FK): "gebruikt in" bij sjablonen
      name: cp.name,
      avatar_emoji: cp.avatar_emoji,
      avatar: cp.avatar ?? null,
      system_prompt: cp.system_prompt,
      rag_enabled: cp.rag_enabled,
      rag_folder_ids: cp.rag_folder_ids,
      visible_from_phase: cp.visible_from_phase,
      sort_order: sortOrder,
      ...copyRoleFields(cp),
      ...copyKnowledgeFields(cp),
      cue_emission_enabled: false,
    })
    .select('*').single();
  if (error) {
    // Mogelijk race-condition: lees opnieuw op naam.
    const { data: retry } = await supabaseAdmin
      .from('project_personas')
      .select('*')
      .eq('project_id', projectId)
      .eq('name', cp.name)
      .maybeSingle();
    return retry || null;
  }
  return inserted;
}

// POST /api/projects/groups/:groupId/threads/:threadId/close
// Genereert server-side de AI-samenvatting en markeert de thread als afgesloten.
// Accepteert GEEN topics/agreements van de client — de server is de enige bron.
//
// Bij een rolspeler met verstandhouding beoordeelt de server daarna het gesprek
// aan de hand van de gedragsregels van de docent (zie server/projects/threadClose.js):
// het niveau gaat een stap omhoog, blijft gelijk of gaat een stap omlaag. De
// groep ziet het nieuwe niveau en de reden.

// --- Task #252: raadpleeglimiet-helpers (DB-toegang; pure logica zit in
// server/projects/consultationLimit.js). ---

// Tel hoeveel raadplegingen (= threads, open + gesloten) een groep al met deze
// persona heeft gestart. De teller wordt verbruikt bij het OPENEN van een thread.
async function countConsultations(groupId, personaId) {
  const { count, error } = await supabaseAdmin
    .from('group_persona_threads')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId).eq('persona_id', personaId);
  if (error) throw error;
  return count || 0;
}

// Lees de per (project, groep, persona) toegekende extra raadplegingen.
// Defensief tegen ontbrekende tabel (oude DB) → 0.
async function loadConsultationGrant(projectId, groupId, personaId) {
  const { data, error } = await supabaseAdmin
    .from('project_persona_consultation_grants')
    .select('extra_consultations')
    .eq('project_id', projectId).eq('group_id', groupId).eq('persona_id', personaId)
    .maybeSingle();
  if (error) {
    if (error.code === '42P01' || /project_persona_consultation_grants/i.test(error.message || '')) return 0;
    throw error;
  }
  return conNormalizeExtra(data?.extra_consultations);
}

// Aantal gebruikte feedbackrondes van een groep bij een beoordelaar (ingeleverd werk).
async function countFeedbackRounds(groupId, personaId) {
  const { count, error } = await supabaseAdmin
    .from('project_document_reviews')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId).eq('persona_id', personaId)
    .not('product_id', 'is', null);
  if (error) throw error;
  return count || 0;
}

// =============================================================================
// Verstandhouding tussen een rolspeler en een groep (herzien 2026-09-29).
// Eén rij per (project, groep, persona); score = niveau (-2 koud … +2 warm,
// -3 = contact verbroken). Alleen voor rolspelers met "Verstandhouding
// bijhouden" (reputationActive). Wijzigt na een afgerond gesprek (oordeel op
// basis van de gedragsregels) of door een correctie van de docent.
// =============================================================================

// Zet het niveau (compute(huidig) → nieuw); idempotent op event.refId.
async function setRelationshipLevel(args) {
  return setRelationshipLevelImpl({ supabaseAdmin }, args);
}

// Lees de huidige rij; zonder rij begint de groep op het startniveau van de persona.
async function loadRelationship(projectId, groupId, personaId, startLevel = 0) {
  const fallback = { score: clampStartLevel(startLevel), history: [] };
  if (!supabaseAdmin) return fallback;
  const { data, error } = await supabaseAdmin
    .from('project_persona_relationships')
    .select('score, history')
    .eq('project_id', projectId).eq('group_id', groupId).eq('persona_id', personaId)
    .maybeSingle();
  if (error) {
    if (error.code === '42P01' || /project_persona_relationships/i.test(error.message || '')) return fallback;
    throw error;
  }
  if (!data) return fallback;
  return {
    score: relClampLevel(data.score),
    history: Array.isArray(data.history) ? data.history : [],
  };
}

// =============================================================================
// CRUD voor de persona-sjablonen (course_personas) van één cursus.
// POST   /api/admin/course-personas          — nieuwe sjabloon aanmaken
// PATCH  /api/admin/course-personas/:id      — sjabloon bewerken
// DELETE /api/admin/course-personas/:id      — sjabloon verwijderen
// Voor admins en docenten van DIE cursus (isStaffForCourse); een sjabloon van
// een andere cursus is voor een docent onvindbaar (404), zodat persona's net
// als itembanken binnen hun cursus blijven.
// =============================================================================

// Zoek een sjabloon op en controleer dat de gebruiker staf is van de cursus
// ervan. Levert { persona } of { status, error }.
async function loadCoursePersonaForStaff(personaId, user, profile) {
  const { data: persona, error } = await supabaseAdmin
    .from('course_personas').select('id, course_id').eq('id', personaId).maybeSingle();
  if (error) return { status: 500, error: error.message };
  if (!persona) return { status: 404, error: 'Persona niet gevonden' };
  if (!(await isStaffForCourse(user, profile, persona.course_id))) {
    return { status: 404, error: 'Persona niet gevonden' };
  }
  return { persona };
}

export function registerProjectPersonaRoutes(app) {
  // POST /api/projects/persona-chat — stuur een bericht naar een persona binnen
  // een groep. Server zoekt/maakt thread, slaat user-bericht op, roept OpenAI aan
  // (met optionele RAG via project.course_id en persona.rag_folder_ids), slaat
  // assistant-antwoord op, en geeft beide terug.
  app.post('/api/projects/persona-chat', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    // Geen leerniveau: in projecten spelen niveaus geen rol (begeleider, beoordelaar
    // en rolspeler doen er niets mee).
    const { groupId, personaId, message, lang = 'nl' } = req.body || {};
    if (!groupId || !personaId || !message) {
      return res.status(400).json({ error: 'groupId, personaId, message vereist' });
    }

    try {
      // Lidmaatschap en groep (met project) tegelijk ophalen.
      const [isMember, { data: group }] = await Promise.all([
        isGroupMember(groupId, auth.user.id),
        supabaseAdmin.from('project_groups').select('id, project_id, projects(id, course_id)').eq('id', groupId).maybeSingle(),
      ]);
      if (!isMember) {
        return res.status(403).json({ error: 'Geen toegang tot deze groep' });
      }
      if (!group) return res.status(404).json({ error: 'Groep niet gevonden' });
      // Project zit normaal in hetzelfde antwoord; anders (oudere omgeving) los ophalen.
      const project = group.projects
        ? { id: group.projects.id, course_id: group.projects.course_id }
        : (await supabaseAdmin.from('projects').select('id, course_id').eq('id', group.project_id).maybeSingle()).data;
      if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
      if (await rejectIfFeatureOff(res, auth.user, null, project.course_id, 'projects')) return;

      // Persona ophalen — moet uiteindelijk een project_persona zijn (FK op
      // group_persona_threads). Wanneer een course_persona-id binnenkomt,
      // kopiëren we hem eerst naar dit project. '__default__' blijft uniek
      // en krijgt nooit een thread.
      let persona = null;
      if (personaId === '__default__') {
        persona = {
          id: '__default__',
          name: 'Consultant',
          system_prompt: 'Je bent een rustige onderzoeks-consultant voor een groep VU-studenten. Stel scherpe Socratische vragen, vat terug, en help de groep een onderzoeksvoorstel scherper te krijgen. Spreek de student aan met "je"/"jij".',
          rag_enabled: true,
          course_knowledge: 'all',
          rag_folder_ids: [],
        };
      } else {
        // Eerst proberen als project_persona binnen DIT project.
        const { data: pp } = await supabaseAdmin
          .from('project_personas').select('*')
          .eq('id', personaId).eq('project_id', project.id).maybeSingle();
        if (pp) {
          persona = pp;
        } else {
          // Fallback: course-persona; kopieer naar project en gebruik kopie.
          const { data: cp } = await supabaseAdmin
            .from('course_personas').select('*').eq('id', personaId).maybeSingle();
          if (cp && project.course_id && cp.course_id === project.course_id) {
            persona = await ensureProjectPersonaFromCourse(project.id, cp.id);
          }
        }
      }
      if (!persona) return res.status(404).json({ error: 'Persona niet gevonden of niet in dit project' });
      // Evaluator-persona's mogen niet door studenten worden aangesproken in
      // de gewone chat — die worden alleen via /evaluate aangeroepen.
      if (persona.persona_type === 'evaluator') {
        return res.status(403).json({ error: 'Deze persona is een beoordelaar en kan niet worden aangesproken via de chat.' });
      }

      // Verstandhouding: alleen bij een rolspeler die er een bijhoudt. Staat het
      // contact op het dieptepunt (verbroken), dan antwoordt de rolspeler niet
      // meer: er wordt niets opgeslagen en er gaat niets naar het taalmodel. De
      // groep rondt het project zonder hem af (de docent kan nog herstellen).
      let relationship = null;
      if (persona.id !== '__default__' && reputationActive(persona)) {
        try {
          relationship = await loadRelationship(project.id, groupId, persona.id, persona.start_level);
        } catch (e) {
          console.warn('[persona-chat] verstandhouding laden mislukte:', e.message);
          relationship = { score: clampStartLevel(persona.start_level), history: [] };
        }
        if (relIsBroken(relationship.score)) {
          return res.json({
            reply: '',
            ragSources: [],
            threadId: null,
            relationshipBroken: true,
            relationship: { level: relationship.score, key: relLevelKey(relationship.score), label: relLevelLabel(relationship.score, lang) },
          });
        }
      }

      // Thread ophalen of aanmaken (alleen voor echte persona's met uuid).
      let threadId = null;
      let consultation = null;
      if (persona.id !== '__default__') {
        // Task #252: lui stille open thread eerst afronden (op basis van
        // auto_close_hours). Zo telt voortzetten na het venster als een nieuwe
        // raadpleging en wordt de limiet correct gehandhaafd.
        try {
          await autoCloseStaleThreads({
            groupId, personaId: persona.id,
            autoCloseHours: persona.auto_close_hours,
            closedBy: auth.user.id, lang,
          });
        } catch (e) {
          console.warn('[persona-chat] auto-close mislukte:', e.message);
        }

        const { data: existingThread } = await supabaseAdmin
          .from('group_persona_threads')
          .select('id').eq('group_id', groupId).eq('persona_id', persona.id).is('closed_at', null).maybeSingle();
        if (existingThread) {
          threadId = existingThread.id;
        } else {
          // Nieuwe raadpleging → limiet handhaven. Effectieve limiet =
          // persona.max_consultations + per-groep toegekende extra. null = onbeperkt.
          let used = 0;
          let extra = 0;
          try {
            // group_persona_threads is een kerntabel die altijd bestaat; een
            // telfout is dus transient. Fail CLOSED zodat de limiet niet stil
            // wordt omzeild bij een tijdelijke DB-fout.
            used = await countConsultations(groupId, persona.id);
          } catch (e) {
            console.error('[persona-chat] raadpleging tellen mislukte:', e.message);
            return res.status(503).json({
              error: 'Raadpleeglimiet kon niet worden gecontroleerd. Probeer het zo opnieuw.',
            });
          }
          try {
            // Extra grants verhogen de limiet alléén; bij twijfel 0 = strenger =
            // veilig (en ontbrekende tabel levert intern al 0 op).
            extra = await loadConsultationGrant(project.id, groupId, persona.id);
          } catch (e) {
            console.warn('[persona-chat] extra raadplegingen laden mislukte:', e.message);
          }
          const effLimit = conComputeEffectiveLimit(persona.max_consultations, extra);
          if (conIsBlocked(used, effLimit)) {
            return res.json({
              reply: conLimitMessage(lang, effLimit),
              ragSources: [],
              threadId: null,
              consultationLimitReached: true,
              consultation: { used, limit: effLimit, remaining: 0 },
            });
          }
          const { data: newThread, error: tErr } = await supabaseAdmin
            .from('group_persona_threads')
            .insert({ group_id: groupId, persona_id: persona.id })
            .select('id').single();
          if (tErr) return res.status(500).json({ error: tErr.message });
          threadId = newThread.id;
          const newUsed = used + 1;
          consultation = {
            used: newUsed,
            limit: effLimit,
            remaining: conComputeRemaining(newUsed, effLimit),
          };
        }
      }

      // Vorige berichten ophalen voor context.
      let history = [];
      if (threadId) {
        const { data: prev } = await supabaseAdmin
          .from('group_persona_messages')
          .select('role, content')
          .eq('thread_id', threadId)
          .order('created_at', { ascending: true })
          .limit(20);
        history = prev || [];
      }

      // Deze stappen hangen niet van elkaar af en lopen tegelijk:
      //  * het bericht van de student opslaan;
      //  * cursusmateriaal zoeken, alleen wat deze persona kent (course_knowledge:
      //    niets, alles, of gekozen bestanden). Altijd binnen de cursusmappen;
      //  * geüploade documenten voor deze persona — uitsluitend van de huidige
      //    groep, zodat parallelle groepen elkaars uploads niet mengen;
      //  * de projectdocumenten die deze persona kent (personaKnowledge.js),
      //    doorzocht in fragmenten; nooit databestanden;
      //  * eerder gemaakte afspraken uit afgesloten gesprekken met deze persona.
      const ragSettingsP = loadRagSettings(project?.course_id || null);
      const [, rag, groupDocs, projectKnowledge, priorAgreements] = await Promise.all([
        threadId
          ? supabaseAdmin.from('group_persona_messages').insert({
            thread_id: threadId,
            user_id: auth.user.id,
            role: 'user',
            content: message,
          })
          : null,
        (async () => {
          const mode = persona.course_knowledge || 'none';
          if (mode === 'none') return { context: '', sources: [] };
          const [ragSettings, courseFolders] = await Promise.all([
            ragSettingsP,
            courseRagFolderIds(project?.course_id || null),
          ]);
          const cfg = ragSettings.project;
          const { matched } = await searchChunksServerSide(
            message, cfg.similarity_threshold, cfg.match_count, courseFolders,
            { enabled: cfg.query_expansion_enabled }, lang, 'project',
            mode === 'selected' ? { documentIds: persona.course_knowledge_doc_ids || [] } : {}
          );
          // Zelfde bronverwijzingen als de chat: één genummerde bron per
          // document, zodat [n] in het antwoord klikbaar naar het cursusdocument
          // wijst en de bronnenlijst onder het antwoord klopt.
          return matched && matched.length > 0 ? buildNumberedRagContext(matched, 5) : { context: '', sources: [] };
        })(),
        (async () => {
          if (persona.id === '__default__') return [];
          const { data: docs } = await supabaseAdmin
            .from('project_persona_documents')
            .select('id, filename, content_text')
            .eq('project_id', project.id).eq('persona_id', persona.id).eq('group_id', groupId)
            .order('created_at', { ascending: true })
            .limit(10);
          return docs || [];
        })(),
        (async () => {
          if (persona.id === '__default__' || !persona.project_id) return { docs: [], matched: [], unindexed: [] };
          const docs = await loadPersonaProjectDocs(supabaseAdmin, persona);
          if (!docs.length) return { docs, matched: [], unindexed: [] };
          const counts = await chunkCounts(supabaseAdmin, docs.map(d => d.document_ref_id));
          const indexed = docs.filter(d => d.document_ref_id && (counts[d.document_ref_id] || 0) > 0);
          const unindexed = docs.filter(d => !indexed.includes(d));
          // Nog niet doorzoekbaar: begin gaat nu mee, en de fragmenten worden alsnog gemaakt.
          if (unindexed.some(d => d.document_ref_id)) indexPersonaKnowledgeInBackground(persona);
          let matched = [];
          if (indexed.length) {
            const cfg = (await ragSettingsP).project;
            ({ matched } = await searchChunksServerSide(
              message, cfg.similarity_threshold, cfg.match_count, null, null, lang, null,
              { documentIds: indexed.map(d => d.document_ref_id) }
            ));
          }
          return { docs, matched: matched || [], unindexed };
        })(),
        (async () => {
          if (persona.id === '__default__') return [];
          const { data: closedThreads } = await supabaseAdmin
            .from('group_persona_threads')
            .select('agreements, closed_at')
            .eq('group_id', groupId)
            .eq('persona_id', persona.id)
            .not('closed_at', 'is', null)
            .order('closed_at', { ascending: false })
            .limit(3);
          return (closedThreads || []).flatMap(t => t.agreements || []).filter(Boolean);
        })(),
      ]);
      // Alle bronnen doorgenummerd: cursusmateriaal, projectdocumenten die deze
      // persona kent (alleen wat studenten mogen openen krijgt een nummer),
      // uploads van de groep (per document ~6k tekens).
      const context = rag.context || '';
      const projectNumbered = buildProjectKnowledgeContext({
        matched: projectKnowledge.matched, docs: projectKnowledge.docs, unindexed: projectKnowledge.unindexed,
        startIndex: (rag.sources || []).length + 1,
      });
      const groupNumbered = numberDocumentSources(groupDocs, { startIndex: (rag.sources || []).length + projectNumbered.sources.length + 1, kind: 'persona_document' });
      const ragSources = [...(rag.sources || []), ...projectNumbered.sources, ...groupNumbered.sources];

      const agreementsBlock = priorAgreements.length > 0
        ? `\n\nGemaakte afspraken in eerdere gesprekken:\n${priorAgreements.map(a => `- ${a}`).join('\n')}`
        : '';
      const ragBlock = context
        ? `\n\nContext uit cursusmateriaal (elk fragment begint met zijn bronnummer):\n${context}`
        : '';
      const projectDocBlock = (projectNumbered.citedContext
        ? `\n\nProjectmateriaal dat jij kent (elk fragment begint met zijn bronnummer):\n${projectNumbered.citedContext}`
        : '') + (projectNumbered.backgroundContext
        ? `\n\nAchtergrondkennis die alleen jij hebt. Gebruik de inhoud waar het past bij je rol, maar noem geen bron of bestandsnaam en citeer niet letterlijk:\n${projectNumbered.backgroundContext}`
        : '');
      const docBlock = groupNumbered.context
        ? `\n\nGeüploade documenten van de groep (elk document begint met zijn bronnummer):\n${groupNumbered.context}`
        : '';
      // Eén verwijsinstructie voor alle bronnen samen; zonder bronnen: geen
      // verwijzingen of voetnoten verzinnen.
      const sourcesRulesBlock = ragSources.length > 0 ? buildSourcesInstructionBlock(ragSources) : buildNoSourcesInstructionBlock();
      const langSuffix = buildLanguageInstruction(lang);
      // Verstandhouding (alleen rolspelers die er een bijhouden): niveau + gedrag
      // op dat niveau. De gedragsregels zelf gaan hier bewust niet mee.
      const relationshipBlock = relationship
        ? relBuildPromptBlock(relationship.score, persona.conduct_rules, lang, relationship.history)
        : '';
      // Task #296: leerniveau-blok vóór de taal-instructie (laatste blok blijft taal).
      const systemContent = `${persona.system_prompt}${relationshipBlock}${agreementsBlock}${ragBlock}${projectDocBlock}${docBlock}${sourcesRulesBlock}${langSuffix}`;

      if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
      const personaMessages = [
        { role: 'system', content: systemContent },
        // Oude placeholder-antwoorden van vóór 2026-09-27 niet terugvoeren als
        // "wat de persona zei".
        ...history.filter(h => !(h.role === 'assistant' && h.content === '(Geen antwoord)'))
          .map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: message },
      ];
      // Een student zit te wachten: breek na 75 s af in plaats van minutenlang
      // "denkt na…" te tonen tot Azure zelf opgeeft (gezien 2026-09-27: HTTP 500
      // na minuten). Een tijdelijke storing wordt één keer herhaald.
      const PERSONA_TIMEOUT_MS = 75000;
      const askPersona = async (maxTokens) => {
        const r = await openaiChatCompletion({
          model: OPENAI_MODEL,
          messages: personaMessages,
          ...chatModelParams({ temperature: 0.7, maxTokens }),
        }, { timeoutMs: PERSONA_TIMEOUT_MS });
        if (!r.ok) return { ok: false, status: r.status, timedOut: r.timedOut, text: await r.text() };
        return { ok: true, data: await r.json() };
      };
      let chatResult = await askPersona(700);
      if (!chatResult.ok) {
        console.error(`[persona-chat] Taalmodel-fout HTTP ${chatResult.status}${chatResult.timedOut ? ' (time-out)' : ''}: ${String(chatResult.text || '').slice(0, 300)}`);
        const friendly = chatResult.timedOut
          ? 'De persona doet er te lang over om te antwoorden. Probeer je bericht opnieuw te sturen.'
          : 'Het taalmodel heeft een storing. Probeer het over een minuut opnieuw.';
        return res.status(502).json({ error: friendly, code: chatResult.timedOut ? 'timeout' : 'upstreamError', status: chatResult.status, detail: String(chatResult.text || '').slice(0, 500) });
      }
      // Een reasoning-model geeft bij een te krap budget een LEGE 200 terug
      // (finish_reason "length"). Eén keer opnieuw met ruim budget; lukt dat ook
      // niet, dan een duidelijke fout — nooit een nep-antwoord in het gesprek.
      if (!String(chatResult.data?.choices?.[0]?.message?.content || '').trim()) {
        console.warn(`[persona-chat] Leeg antwoord (finish_reason=${chatResult.data?.choices?.[0]?.finish_reason}, usage=${JSON.stringify(chatResult.data?.usage?.completion_tokens_details || {})}) — opnieuw met ruimer budget.`);
        const retry = await askPersona(4000);
        if (retry.ok) chatResult = retry;
      }
      const reply = String(chatResult.data?.choices?.[0]?.message?.content || '').trim();
      if (!reply) {
        console.error(`[persona-chat] Leeg antwoord na herhaling (finish_reason=${chatResult.data?.choices?.[0]?.finish_reason}, model=${OPENAI_MODEL}).`);
        return res.status(502).json({ error: 'De persona gaf geen antwoord. Probeer je bericht opnieuw te sturen.', code: 'emptyCompletion' });
      }

      if (threadId) {
        await supabaseAdmin.from('group_persona_messages').insert({
          thread_id: threadId,
          role: 'assistant',
          content: reply,
          rag_sources: ragSources,
        });
      }

      return res.json({ reply, ragSources, threadId, consultation });
    } catch (err) {
      console.error('[projects/persona-chat]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/persona-thread?groupId=...&personaId=... — bestaande
  // berichten van een persona-thread.
  app.get('/api/projects/persona-thread', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { groupId, personaId } = req.query;
    if (!groupId || !personaId) return res.status(400).json({ error: 'groupId en personaId vereist' });

    try {
      if (!(await isGroupMember(groupId, auth.user.id))) {
        return res.status(403).json({ error: 'Geen toegang' });
      }
      if (personaId === '__default__') return res.json({ messages: [], threadId: null });
      const { data: thread } = await supabaseAdmin
        .from('group_persona_threads').select('id, closed_at')
        .eq('group_id', groupId).eq('persona_id', personaId).is('closed_at', null).maybeSingle();
      if (!thread) return res.json({ messages: [], threadId: null });
      const { data: msgs } = await supabaseAdmin
        .from('group_persona_messages')
        .select('id, role, content, rag_sources, created_at, user_id')
        .eq('thread_id', thread.id).order('created_at', { ascending: true });
      return res.json({ messages: msgs || [], threadId: thread.id });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/copy-personas-from-library — kopieer alle course_personas
  // van een cursus naar project_personas voor dit project. Idempotent: doet
  // niets als er al project_personas zijn.
  app.post('/api/projects/copy-personas-from-library', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId vereist' });

    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      // Cursus van het project ophalen om docent-status per cursus te checken.
      const { data: projForRole } = await supabaseAdmin
        .from('projects').select('course_id').eq('id', projectId).maybeSingle();
      const isStaff = await isStaffForCourse(auth.user, profile, projForRole?.course_id);
      if (!isStaff) return res.status(403).json({ error: 'Alleen docent/admin van deze cursus' });

      const { data: existing } = await supabaseAdmin
        .from('project_personas').select('id').eq('project_id', projectId);
      if (existing && existing.length > 0) {
        return res.json({ copied: 0, alreadyExists: true });
      }
      const { data: project } = await supabaseAdmin
        .from('projects').select('course_id').eq('id', projectId).maybeSingle();
      if (!project?.course_id) return res.status(400).json({ error: 'Project heeft geen course_id' });

      const { data: lib } = await supabaseAdmin
        .from('course_personas').select('*').eq('course_id', project.course_id);
      if (!lib || lib.length === 0) return res.json({ copied: 0 });

      // Task #171: persona_type én cue_emission_enabled meekopiëren zodat
      // evaluators ook bij bulk-import nooit cues uitzenden.
      const rows = lib.map((p, i) => ({
        project_id: projectId,
        source_persona_id: p.id, // herkomst (geen FK): "gebruikt in" bij sjablonen
        name: p.name,
        avatar_emoji: p.avatar_emoji,
        avatar: p.avatar ?? null,
        system_prompt: p.system_prompt,
        rag_enabled: p.rag_enabled,
        rag_folder_ids: p.rag_folder_ids,
        visible_from_phase: p.visible_from_phase,
        sort_order: i,
        // Rol + verstandhouding/gedragsregels/feedbackrondes uit het sjabloon.
        ...copyRoleFields(p),
        ...copyKnowledgeFields(p),
        cue_emission_enabled: false,
        // Task #252: raadpleeglimiet + auto-close meekopiëren uit de bibliotheek.
        max_consultations: conNormalizeMax(p.max_consultations),
        auto_close_hours: conNormalizeAutoCloseHours(p.auto_close_hours),
        // Task #253: badge-toekenningsmodus meekopiëren uit de bibliotheek.
        badge_award_mode: normalizeBadgeAwardMode(p.badge_award_mode),
      }));
      let { error: iErr } = await supabaseAdmin.from('project_personas').insert(rows);
      if (iErr && (iErr.code === '42703' || /max_consultations|auto_close_hours/i.test(iErr.message || ''))) {
        // Oude DB zonder Task #252-kolommen: opnieuw zonder die velden.
        const rowsNoCon = rows.map(({ max_consultations: _m, auto_close_hours: _a, ...rest }) => rest);
        ({ error: iErr } = await supabaseAdmin.from('project_personas').insert(rowsNoCon));
      }
      if (iErr && (iErr.code === '42703' || /cue_emission_enabled/i.test(iErr.message || ''))) {
        // Oude DB zonder kolom: opnieuw zonder veld.
        const rowsNoCue = rows.map(({ cue_emission_enabled: _ignored, max_consultations: _m, auto_close_hours: _a, ...rest }) => rest);
        ({ error: iErr } = await supabaseAdmin.from('project_personas').insert(rowsNoCue));
      }
      if (iErr && (iErr.code === '42703' || /badge_award_mode/i.test(iErr.message || ''))) {
        // Oude DB zonder Task #253-kolom: opnieuw zonder veld. Cumulatief: ook de
        // eventueel ontbrekende Task #252-kolommen weglaten zodat één retry volstaat.
        const rowsNoBadge = rows.map(({ badge_award_mode: _b, cue_emission_enabled: _c, max_consultations: _m, auto_close_hours: _a, ...rest }) => rest);
        ({ error: iErr } = await supabaseAdmin.from('project_personas').insert(rowsNoBadge));
      }
      if (iErr) return res.status(500).json({ error: iErr.message });
      return res.json({ copied: rows.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/:projectId/personas — voeg één persona toe aan dit
  // project. Body: { coursePersonaId } om uit de bibliotheek te kopiëren, óf
  // { name, system_prompt, avatar_emoji, rag_enabled, rag_folder_ids } voor een
  // project-eigen persona.
  app.post('/api/projects/:projectId/personas', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId } = req.params;
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const access = await requireProjectStaff(projectId, auth.user, profile);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const project = access.project;

      const { coursePersonaId, name, system_prompt, avatar_emoji,
        rag_enabled, rag_folder_ids } = req.body || {};
      // Task #252: raadpleeglimiet + auto-close (null = onbeperkt / uit).
      const maxConsultInput = conNormalizeMax(req.body?.max_consultations);
      const autoCloseInput = conNormalizeAutoCloseHours(req.body?.auto_close_hours);

      // Bepaal volgorde-index achteraan.
      const { data: existing } = await supabaseAdmin
        .from('project_personas').select('sort_order').eq('project_id', projectId)
        .order('sort_order', { ascending: false }).limit(1);
      const nextOrder = (existing && existing[0] ? Number(existing[0].sort_order || 0) : -1) + 1;

      let row;
      if (coursePersonaId) {
        const { data: cp } = await supabaseAdmin
          .from('course_personas').select('*').eq('id', coursePersonaId).maybeSingle();
        if (!cp) return res.status(404).json({ error: 'Bibliotheek-persona niet gevonden' });
        if (project.course_id && cp.course_id !== project.course_id) {
          return res.status(400).json({ error: 'Persona hoort bij een andere cursus' });
        }
        row = {
          project_id: projectId, source_persona_id: cp.id,
          name: cp.name, avatar_emoji: cp.avatar_emoji, avatar: cp.avatar ?? null,
          system_prompt: cp.system_prompt, rag_enabled: cp.rag_enabled,
          rag_folder_ids: cp.rag_folder_ids, visible_from_phase: cp.visible_from_phase,
          sort_order: nextOrder,
          ...copyRoleFields(cp),
          ...copyKnowledgeFields(cp),
          cue_emission_enabled: false,
          // Task #252: raadpleeglimiet + auto-close uit de bibliotheek.
          max_consultations: conNormalizeMax(cp.max_consultations),
          auto_close_hours: conNormalizeAutoCloseHours(cp.auto_close_hours),
          // Task #253: badge-toekenningsmodus uit de bibliotheek.
          badge_award_mode: normalizeBadgeAwardMode(cp.badge_award_mode),
        };
      } else {
        if (!name || !String(name).trim()) return res.status(400).json({ error: 'Naam is vereist' });
        const { fields: knowledge } = await sanitizePersonaKnowledge(knowledgeFieldsFrom(req.body), { courseId: project.course_id, projectId });
        row = {
          ...knowledge,
          project_id: projectId, source_persona_id: null,
          name: String(name).trim(),
          avatar_emoji: avatar_emoji || '🤖',
          avatar: sanitizeAvatar(req.body?.avatar) ?? null,
          system_prompt: system_prompt || '',
          rag_enabled: rag_enabled !== false,
          rag_folder_ids: Array.isArray(rag_folder_ids) ? rag_folder_ids : [],
          sort_order: nextOrder,
          // Rol + wat daarbij hoort (verstandhouding alleen bij een rolspeler).
          ...roleFieldsFrom(req.body),
          cue_emission_enabled: false,
          // Task #252: raadpleeglimiet + auto-close (null = onbeperkt / uit).
          max_consultations: maxConsultInput,
          auto_close_hours: autoCloseInput,
          // Task #253: badge-toekenningsmodus (individual | group).
          badge_award_mode: normalizeBadgeAwardMode(req.body?.badge_award_mode),
        };
      }
      let { data: inserted, error: iErr } = await supabaseAdmin
        .from('project_personas').insert(row).select('*').single();
      // Defensief: oude DB zonder Task #252-kolommen — opnieuw zonder die velden.
      if (iErr && (iErr.code === '42703' || /max_consultations|auto_close_hours/i.test(iErr.message || ''))) {
        const { max_consultations: _m, auto_close_hours: _a, ...rowNoCon } = row;
        ({ data: inserted, error: iErr } = await supabaseAdmin
          .from('project_personas').insert(rowNoCon).select('*').single());
      }
      // Defensief: oude DB zonder cue_emission_enabled-kolom — opnieuw zonder veld.
      if (iErr && (iErr.code === '42703' || /cue_emission_enabled/i.test(iErr.message || ''))) {
        const { cue_emission_enabled: _ignored, max_consultations: _m, auto_close_hours: _a, ...rowNoCue } = row;
        ({ data: inserted, error: iErr } = await supabaseAdmin
          .from('project_personas').insert(rowNoCue).select('*').single());
      }
      // Defensief: oude DB zonder Task #253 badge_award_mode-kolom. Cumulatief: ook
      // de eventueel ontbrekende Task #252-kolommen weglaten zodat één retry volstaat.
      if (iErr && (iErr.code === '42703' || /badge_award_mode/i.test(iErr.message || ''))) {
        const { badge_award_mode: _b, cue_emission_enabled: _c, max_consultations: _m, auto_close_hours: _a, ...rowNoBadge } = row;
        ({ data: inserted, error: iErr } = await supabaseAdmin
          .from('project_personas').insert(rowNoBadge).select('*').single());
      }
      if (iErr) return res.status(500).json({ error: iErr.message });
      indexPersonaKnowledgeInBackground(inserted);
      return res.json({ persona: inserted });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/:projectId/personas/from-library/:coursePersonaId
  // Maakt altijd een verse, onafhankelijke kopie van een bibliotheek-sjabloon.
  // Geen deduplicatie: meerdere kopieën van hetzelfde sjabloon zijn toegestaan.
  // Toegankelijk voor admin en docent (requireProjectStaff).
  app.post('/api/projects/:projectId/personas/from-library/:coursePersonaId', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, coursePersonaId } = req.params;
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const access = await requireProjectStaff(projectId, auth.user, profile);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const project = access.project;
      const { data: cp } = await supabaseAdmin
        .from('course_personas').select('*').eq('id', coursePersonaId).maybeSingle();
      if (!cp) return res.status(404).json({ error: 'Bibliotheek-sjabloon niet gevonden' });
      if (project.course_id && cp.course_id !== project.course_id) {
        return res.status(400).json({ error: 'Sjabloon hoort bij een andere cursus' });
      }
      const { data: existing } = await supabaseAdmin
        .from('project_personas').select('sort_order').eq('project_id', projectId)
        .order('sort_order', { ascending: false }).limit(1);
      const nextOrder = (existing && existing[0] ? Number(existing[0].sort_order || 0) : -1) + 1;
      const baseRow = {
        project_id: projectId,
        source_persona_id: cp.id, // herkomst (geen FK): "gebruikt in" bij sjablonen
        name: cp.name,
        avatar_emoji: cp.avatar_emoji,
        avatar: cp.avatar ?? null,
        system_prompt: cp.system_prompt,
        rag_enabled: cp.rag_enabled,
        rag_folder_ids: cp.rag_folder_ids,
        visible_from_phase: cp.visible_from_phase,
        sort_order: nextOrder,
        ...copyRoleFields(cp),
        ...copyKnowledgeFields(cp),
        cue_emission_enabled: false,
        // Task #252: raadpleeglimiet + auto-close uit de bibliotheek.
        max_consultations: conNormalizeMax(cp.max_consultations),
        auto_close_hours: conNormalizeAutoCloseHours(cp.auto_close_hours),
        // Task #253: badge-toekenningsmodus uit de bibliotheek.
        badge_award_mode: normalizeBadgeAwardMode(cp.badge_award_mode),
      };
      let { data: inserted, error: iErr } = await supabaseAdmin
        .from('project_personas').insert(baseRow).select('*').single();
      if (iErr && (iErr.code === '42703' || /max_consultations|auto_close_hours/i.test(iErr.message || ''))) {
        const { max_consultations: _m, auto_close_hours: _a, ...rowNoCon } = baseRow;
        ({ data: inserted, error: iErr } = await supabaseAdmin
          .from('project_personas').insert(rowNoCon).select('*').single());
      }
      if (iErr && (iErr.code === '42703' || /cue_emission_enabled/i.test(iErr.message || ''))) {
        const { cue_emission_enabled: _ignored, max_consultations: _m, auto_close_hours: _a, ...rowNoCue } = baseRow;
        ({ data: inserted, error: iErr } = await supabaseAdmin
          .from('project_personas').insert(rowNoCue).select('*').single());
      }
      if (iErr && (iErr.code === '42703' || /badge_award_mode/i.test(iErr.message || ''))) {
        const { badge_award_mode: _b, cue_emission_enabled: _c, max_consultations: _m, auto_close_hours: _a, ...rowNoBadge } = baseRow;
        ({ data: inserted, error: iErr } = await supabaseAdmin
          .from('project_personas').insert(rowNoBadge).select('*').single());
      }
      if (iErr) return res.status(500).json({ error: iErr.message });
      return res.status(201).json({ persona: inserted });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/:projectId/persona-knowledge — keuzelijsten voor "Wat kent
  // deze persona?" (alleen staff): cursusbestanden, projectdocumenten (met of ze
  // kennis kúnnen zijn) en per document welke persona's het kennen.
  app.get('/api/projects/:projectId/persona-knowledge', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId } = req.params;
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const access = await requireProjectStaff(projectId, auth.user, profile);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const [courseDocs, { data: pdocs }, { data: personas }] = await Promise.all([
        courseKnowledgeDocs(access.project?.course_id),
        supabaseAdmin.from('project_documents')
          .select('id, filename, material_kind, is_visible_to_students, content_text, document_ref_id, created_at')
          .eq('project_id', projectId).order('created_at', { ascending: true }),
        supabaseAdmin.from('project_personas').select('id, name, project_knowledge_doc_ids').eq('project_id', projectId),
      ]);
      const counts = await chunkCounts(supabaseAdmin, (pdocs || []).map(d => d.document_ref_id));
      return res.json({
        courseDocs: courseDocs.map(d => ({ id: d.id, title: d.title || d.filename })),
        projectDocs: (pdocs || []).map(d => ({
          id: d.id, filename: d.filename, material_kind: d.material_kind,
          is_visible_to_students: d.is_visible_to_students === true,
          isData: isDataDocument(d),
          canBeKnowledge: canBeKnowledge(d),
          searchable: !!d.document_ref_id && (counts[d.document_ref_id] || 0) > 0,
        })),
        knownBy: knownByMap(personas),
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/courses/:courseId/persona-knowledge — cursusbestanden voor een sjabloon.
  app.get('/api/admin/courses/:courseId/persona-knowledge', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      if (!(await isStaffForCourse(auth.user, profile, req.params.courseId))) {
        return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
      }
      const courseDocs = await courseKnowledgeDocs(req.params.courseId);
      return res.json({ courseDocs: courseDocs.map(d => ({ id: d.id, title: d.title || d.filename })) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/projects/:projectId/personas/:personaId — bewerk één persona.
  app.patch('/api/projects/:projectId/personas/:personaId', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, personaId } = req.params;
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const access = await requireProjectStaff(projectId, auth.user, profile);
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const allowed = ['name', 'avatar_emoji', 'system_prompt', 'rag_enabled', 'rag_folder_ids', 'sort_order', 'max_consultations', 'auto_close_hours', 'badge_award_mode'];
      const patch = {};
      for (const k of allowed) if (k in (req.body || {})) patch[k] = req.body[k];
      if (req.body && 'persona_type' in req.body && !['conversational', 'evaluator', 'roleplayer'].includes(req.body.persona_type)) {
        return res.status(400).json({ error: "persona_type moet 'conversational', 'evaluator' of 'roleplayer' zijn" });
      }
      // Rol + verstandhouding/gedragsregels/feedbackrondes (alleen meegestuurde velden).
      Object.assign(patch, roleFieldsFrom(req.body, { partial: true }));
      if ('persona_type' in patch) patch.cue_emission_enabled = false;
      // Wat kent deze persona? (alleen meegestuurde velden; nooit data of andermans documenten)
      Object.assign(patch, (await sanitizePersonaKnowledge(knowledgeFieldsFrom(req.body, { partial: true }),
        { courseId: access.project?.course_id, projectId })).fields);
      // Cartoon-gezicht: alleen een opgeschoonde configuratie (null = standaard-robotje).
      if (req.body && 'avatar' in req.body) {
        const avatar = sanitizeAvatar(req.body.avatar);
        if (avatar === undefined) return res.status(400).json({ error: 'Ongeldige avatar' });
        patch.avatar = avatar;
      }
      // Task #252: normaliseer raadpleeglimiet + auto-close (null = onbeperkt / uit).
      if ('max_consultations' in patch) patch.max_consultations = conNormalizeMax(patch.max_consultations);
      if ('auto_close_hours' in patch) patch.auto_close_hours = conNormalizeAutoCloseHours(patch.auto_close_hours);
      // Task #253: normaliseer badge-toekenningsmodus.
      if ('badge_award_mode' in patch) patch.badge_award_mode = normalizeBadgeAwardMode(patch.badge_award_mode);
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'Geen wijzigingen' });
      // Gezicht vóór de wijziging: alleen een ECHT gewijzigd gezicht gaat naar het
      // sjabloon (anders zou een kopie zonder gezicht het sjabloon leegmaken).
      const { data: before } = faceFields(patch)
        ? await supabaseAdmin.from('project_personas').select('avatar, avatar_emoji')
          .eq('id', personaId).eq('project_id', projectId).maybeSingle()
        : { data: null };
      let { data, error: e } = await supabaseAdmin
        .from('project_personas').update(patch)
        .eq('id', personaId).eq('project_id', projectId).select('*').single();
      // Defensief: Task #252-kolommen ontbreken in oude DB — verwijder en retry.
      if (e && (e.code === '42703' || /max_consultations|auto_close_hours/i.test(e.message || ''))) {
        const { max_consultations: _m, auto_close_hours: _a, ...patchNoCon } = patch;
        if (Object.keys(patchNoCon).length === 0) return res.json({ persona: null });
        ({ data, error: e } = await supabaseAdmin
          .from('project_personas').update(patchNoCon)
          .eq('id', personaId).eq('project_id', projectId).select('*').single());
      }
      if (e && (e.code === '42703' || /cue_emission_enabled/i.test(e.message || ''))) {
        // Defensief: kolom ontbreekt in oude DB — verwijder veld en probeer opnieuw.
        const { cue_emission_enabled: _ignored, max_consultations: _m, auto_close_hours: _a, ...patchNoCue } = patch;
        if (Object.keys(patchNoCue).length === 0) return res.json({ persona: null });
        ({ data, error: e } = await supabaseAdmin
          .from('project_personas').update(patchNoCue)
          .eq('id', personaId).eq('project_id', projectId).select('*').single());
      }
      if (e && (e.code === '42703' || /badge_award_mode/i.test(e.message || ''))) {
        // Defensief: Task #253-kolom ontbreekt in oude DB — verwijder en retry.
        // Cumulatief: ook de eventueel ontbrekende Task #252-kolommen weglaten.
        const { badge_award_mode: _b, cue_emission_enabled: _c, max_consultations: _m, auto_close_hours: _a, ...patchNoBadge } = patch;
        if (Object.keys(patchNoBadge).length === 0) return res.json({ persona: null });
        ({ data, error: e } = await supabaseAdmin
          .from('project_personas').update(patchNoBadge)
          .eq('id', personaId).eq('project_id', projectId).select('*').single());
      }
      if (e) return res.status(500).json({ error: e.message });
      if ('project_knowledge_doc_ids' in patch) indexPersonaKnowledgeInBackground(data);
      // Eén persona = één gezicht: een nieuw gezicht gaat ook naar het sjabloon
      // en naar de kopieën in andere projecten van dezelfde cursus.
      const face = changedFaceFields(before, patch);
      if (face && data?.source_persona_id) {
        try {
          await syncPersonaFace(supabaseAdmin, { templateId: data.source_persona_id, courseId: access.project?.course_id, fields: face });
        } catch (syncErr) {
          console.warn('[persona-face] doorvoeren mislukt:', syncErr.message);
        }
      }
      return res.json({ persona: data });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/projects/:projectId/personas/:personaId — verwijder één persona
  // uit dit project. Threads/berichten worden via FK ON DELETE CASCADE opgeruimd.
  app.delete('/api/projects/:projectId/personas/:personaId', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, personaId } = req.params;
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const access = await requireProjectStaff(projectId, auth.user, profile);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const { error: e } = await supabaseAdmin
        .from('project_personas').delete()
        .eq('id', personaId).eq('project_id', projectId);
      if (e) return res.status(500).json({ error: e.message });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/:projectId/personas/:personaId/documents?groupId=... —
  // lijst van documenten die deze groep voor deze persona heeft geüpload.
  // Documenten zijn group-scoped: parallelle groepen binnen hetzelfde project
  // zien elkaars uploads niet. Staff mag van iedere groep de lijst opvragen.
  app.get('/api/projects/:projectId/personas/:personaId/documents', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, personaId } = req.params;
    const groupId = req.query.groupId ? String(req.query.groupId) : null;
    if (!groupId) return res.status(400).json({ error: 'groupId vereist' });
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      // Toegang: groepslid, óf staff van de cursus van dit project. Een docent
      // van een andere cursus krijgt geen toegang.
      const staffAccess = { ok: isLeapAdmin(profile) };
      if (!staffAccess.ok && !(await isGroupMember(groupId, auth.user.id))) {
        return res.status(403).json({ error: 'Geen toegang tot deze groep of dit project' });
      }
      const isStaffViewer = staffAccess.ok;
      const cols = 'id, filename, byte_size, uploaded_by, created_at, is_hidden_rubric, visible_to_students';
      const buildQuery = (selectCols, withVisibleCol) => {
        let q = supabaseAdmin
          .from('project_persona_documents')
          .select(selectCols)
          .eq('project_id', projectId).eq('persona_id', personaId).eq('group_id', groupId);
        // Studenten zien geen verborgen rubrics, behalve die de docent expliciet
        // zichtbaar heeft gemaakt (visible_to_students=true).
        if (!isStaffViewer) {
          q = withVisibleCol
            ? q.or('is_hidden_rubric.eq.false,visible_to_students.eq.true')
            : q.eq('is_hidden_rubric', false);
        }
        return q.order('created_at', { ascending: false });
      };
      let { data, error: e } = await buildQuery(cols, true);
      // Defensief: oude DB zonder visible_to_students-kolom.
      if (e && (e.code === '42703' || /visible_to_students/i.test(e.message || ''))) {
        ({ data, error: e } = await buildQuery('id, filename, byte_size, uploaded_by, created_at, is_hidden_rubric', false));
      }
      if (e) return res.status(500).json({ error: e.message });
      return res.json({ documents: data || [] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects/:projectId/personas/:personaId/documents',
    docUpload.single('file'),
    async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, personaId } = req.params;
    const rawGroupId = req.body?.groupId;
    const requestedHiddenEarly = req.body?.isHiddenRubric === '1' || req.body?.isHiddenRubric === 'true';
    // Voor verborgen rubrics is groupId optioneel (project/persona-scoped opslag,
    // niet aan een specifieke groep gebonden). Voor reguliere uploads blijft
    // groupId verplicht.
    if (!rawGroupId && !requestedHiddenEarly) return res.status(400).json({ error: 'groupId vereist' });
    const groupId = rawGroupId || null;
    if (!req.file) return res.status(400).json({ error: 'Geen bestand ontvangen (veld "file")' });
    let text;
    try {
      text = await extractTextFromUpload(req.file);
    } catch (e) {
      return res.status(400).json({ error: e.message || 'Kon tekst niet uit bestand halen' });
    }
    if (!text || text.length === 0) {
      return res.status(400).json({ error: 'Geen leesbare tekst gevonden in dit bestand' });
    }
    if (text.length > MAX_DOC_CHARS) {
      text = text.slice(0, MAX_DOC_CHARS) + `\n\n…[afgekapt op ${MAX_DOC_CHARS.toLocaleString('nl-NL')} tekens]`;
    }
    const filename = req.file.originalname || 'upload';
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      // Schrijven = groepsleden. Admin/superuser mag als noodgreep ook
      // uploaden (bijv. om voor een groep een document recht te zetten);
      // docent zonder groepslidmaatschap mag niet schrijven.
      const isAdmin = profile && (profile.role === 'admin' || profile.email === SUPERUSER_EMAIL);
      // Cursus van het project ophalen om docent-staff per cursus te checken.
      const { data: projForStaff } = await supabaseAdmin
        .from('projects').select('course_id').eq('id', projectId).maybeSingle();
      const isStaffForProject = await isStaffForCourse(auth.user, profile, projForStaff?.course_id);
      // Groepslidmaatschap is alleen vereist voor reguliere uploads.
      if (groupId) {
        if (!isAdmin && !(await isGroupMember(groupId, auth.user.id))) {
          return res.status(403).json({ error: 'Alleen groepsleden mogen documenten uploaden' });
        }
        const { data: group } = await supabaseAdmin
          .from('project_groups').select('project_id').eq('id', groupId).maybeSingle();
        if (!group || group.project_id !== projectId) {
          return res.status(400).json({ error: 'Groep hoort niet bij dit project' });
        }
      } else if (!requestedHiddenEarly) {
        return res.status(400).json({ error: 'groupId vereist' });
      }
      // Persona moet bij dit project horen.
      const { data: persona } = await supabaseAdmin
        .from('project_personas').select('id, persona_type').eq('id', personaId).eq('project_id', projectId).maybeSingle();
      if (!persona) return res.status(404).json({ error: 'Persona niet in dit project' });
      // Studenten/groepsleden mogen NOOIT documenten op een evaluator-persona
      // plaatsen — dat zou de beoordelingsinput kunnen vervuilen.
      if (persona.persona_type === 'evaluator' && !isStaffForProject) {
        return res.status(403).json({ error: 'Geen uploads toegestaan op een beoordelaar-persona' });
      }
      // is_hidden_rubric: alleen staff mag dit zetten, en alleen op een
      // evaluator-persona. Project-scoped (group_id mag NULL zijn).
      let isHiddenRubric = false;
      if (requestedHiddenEarly) {
        if (!isStaffForProject) return res.status(403).json({ error: 'Alleen docent/admin mag een verborgen rubric uploaden' });
        // Docent moet bij dit project horen (geen kruis-cursus-uploads).
        const access = await requireProjectStaff(projectId, auth.user, profile);
        if (!access.ok) return res.status(access.status).json({ error: access.error || 'Geen toegang tot dit project' });
        if (persona.persona_type !== 'evaluator') {
          return res.status(400).json({ error: 'Verborgen rubric kan alleen aan een beoordelaar-persona worden gekoppeld' });
        }
        isHiddenRubric = true;
      }
      // Task #253: docent kan een rubric zichtbaar maken voor studenten. Alleen
      // van toepassing op verborgen rubrics (evaluator-input); reguliere uploads
      // van studenten blijven false.
      const visibleToStudents = isHiddenRubric
        && (req.body?.visibleToStudents === '1' || req.body?.visibleToStudents === 'true');
      const insertRow = {
        project_id: projectId, persona_id: personaId, group_id: groupId,
        filename: String(filename).slice(0, 200),
        content_text: text, byte_size: req.file.size || Buffer.byteLength(text, 'utf8'),
        uploaded_by: auth.user.id,
        is_hidden_rubric: isHiddenRubric,
        visible_to_students: visibleToStudents,
      };
      const insertCols = 'id, filename, byte_size, uploaded_by, created_at, is_hidden_rubric, visible_to_students';
      let { data, error: e } = await supabaseAdmin
        .from('project_persona_documents').insert(insertRow).select(insertCols).single();
      // Defensief: oude DB zonder visible_to_students-kolom.
      if (e && (e.code === '42703' || /visible_to_students/i.test(e.message || ''))) {
        const { visible_to_students: _v, ...rowNoVis } = insertRow;
        ({ data, error: e } = await supabaseAdmin
          .from('project_persona_documents').insert(rowNoVis)
          .select('id, filename, byte_size, uploaded_by, created_at, is_hidden_rubric').single());
      }
      if (e) return res.status(500).json({ error: e.message });
      return res.json({ document: data });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/projects/:projectId/personas/:personaId/documents/:docId?groupId=...
  // Alleen de uploader of een docent mag verwijderen; URL-parameters worden
  // strikt op de DELETE-query toegepast zodat een willekeurige docId niet
  // kan worden meegegeven met een onjuiste project/persona-combinatie.
  app.delete('/api/projects/:projectId/personas/:personaId/documents/:docId', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, personaId, docId } = req.params;
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const staffAccess = await requireProjectStaff(projectId, auth.user, profile);
      const isCourseStaff = staffAccess.ok;
      const { data: doc } = await supabaseAdmin
        .from('project_persona_documents').select('uploaded_by, group_id')
        .eq('id', docId).eq('project_id', projectId).eq('persona_id', personaId).maybeSingle();
      if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
      if (!isCourseStaff) {
        if (doc.uploaded_by !== auth.user.id) {
          return res.status(403).json({ error: 'Alleen de uploader of een docent van deze cursus mag verwijderen' });
        }
        // Extra check: huidige user moet nog steeds lid zijn van de groep waar
        // het document bij hoort. Voorkomt verwijderen na verlaten van groep.
        if (doc.group_id && !(await isGroupMember(doc.group_id, auth.user.id))) {
          return res.status(403).json({ error: 'Niet langer lid van deze groep' });
        }
      }
      const { error: e } = await supabaseAdmin
        .from('project_persona_documents').delete()
        .eq('id', docId).eq('project_id', projectId).eq('persona_id', personaId);
      if (e) return res.status(500).json({ error: e.message });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/projects/:projectId/personas/:personaId/documents/:docId/visibility
  // Task #253: alleen staff mag de zichtbaarheid van een verborgen rubric voor
  // studenten in-/uitschakelen. Werkt alleen op is_hidden_rubric=true rijen.
  app.patch('/api/projects/:projectId/personas/:personaId/documents/:docId/visibility', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, personaId, docId } = req.params;
    const visibleToStudents = req.body?.visibleToStudents;
    if (typeof visibleToStudents !== 'boolean') {
      return res.status(400).json({ error: 'visibleToStudents moet een boolean zijn' });
    }
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const staffAccess = await requireProjectStaff(projectId, auth.user, profile);
      if (!staffAccess.ok) {
        return res.status(403).json({ error: 'Alleen een docent van deze cursus mag de zichtbaarheid wijzigen' });
      }
      const { data: doc } = await supabaseAdmin
        .from('project_persona_documents').select('id, is_hidden_rubric')
        .eq('id', docId).eq('project_id', projectId).eq('persona_id', personaId).maybeSingle();
      if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
      if (doc.is_hidden_rubric !== true) {
        return res.status(400).json({ error: 'Zichtbaarheid kan alleen op een rubric worden ingesteld' });
      }
      const { data: updated, error: e } = await supabaseAdmin
        .from('project_persona_documents')
        .update({ visible_to_students: visibleToStudents })
        .eq('id', docId).eq('project_id', projectId).eq('persona_id', personaId)
        .select('id, visible_to_students').single();
      if (e) {
        if (e.code === '42703' || /visible_to_students/i.test(e.message || '')) {
          return res.status(503).json({
            error: 'Migratie 20260608130000_evaluator_grading_badges.sql is nog niet toegepast in Supabase.',
          });
        }
        return res.status(500).json({ error: e.message });
      }
      return res.json({ document: updated });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/:projectId/personas/:personaId/documents/:docId/download
  // Task #253: download van een rubric. Staff altijd; studenten alleen als de
  // rubric op visible_to_students=true staat.
  app.get('/api/projects/:projectId/personas/:personaId/documents/:docId/download', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, personaId, docId } = req.params;
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const { data: project } = await supabaseAdmin
        .from('projects').select('id, course_id').eq('id', projectId).maybeSingle();
      if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
      const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
      if (!isStaff && !(await userHasProjectAccess(auth.user, profile, project))) {
        return res.status(403).json({ error: 'Geen toegang tot dit project' });
      }
      let { data: doc, error: e } = await supabaseAdmin
        .from('project_persona_documents')
        .select('id, filename, content_text, is_hidden_rubric, visible_to_students, group_id')
        .eq('id', docId).eq('project_id', projectId).eq('persona_id', personaId).maybeSingle();
      // Defensief: oude DB zonder visible_to_students-kolom.
      if (e && (e.code === '42703' || /visible_to_students/i.test(e.message || ''))) {
        ({ data: doc, error: e } = await supabaseAdmin
          .from('project_persona_documents')
          .select('id, filename, content_text, is_hidden_rubric')
          .eq('id', docId).eq('project_id', projectId).eq('persona_id', personaId).maybeSingle());
      }
      if (e) return res.status(500).json({ error: e.message });
      if (!doc) return res.status(404).json({ error: 'Document niet gevonden' });
      // Een bestand dat een GROEP heeft geüpload (geen rubric): alleen die groep en beheerders.
      if (doc.group_id && doc.is_hidden_rubric !== true) {
        if (!isLeapAdmin(profile) && !(await isGroupMember(doc.group_id, auth.user.id))) {
          return res.status(403).json({ error: 'Geen toegang tot deze groep' });
        }
        const fname = doc.filename || 'document';
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}"`);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(doc.content_text || '');
      }
      if (!isStaff && doc.visible_to_students !== true) {
        return res.status(403).json({ error: 'Deze rubric is niet zichtbaar voor studenten' });
      }
      const filename = doc.filename || 'rubric';
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(doc.content_text || '');
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/:projectId/groups/:groupId/personas/:personaId/feedback
  // (multipart "file") — de groep levert werk in bij een beoordelaar en krijgt
  // meteen feedback. Telt als één feedbackronde; bij het maximum is het op.
  app.post('/api/projects/:projectId/groups/:groupId/personas/:personaId/feedback', docUpload.single('file'), async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    try {
      const ctx = await loadFeedbackContext(req, res);
      if (!ctx) return;
      const { auth, project, group, persona, memberOfGroup, isStaff } = ctx;
      if (!memberOfGroup && !isStaff) return res.status(403).json({ error: 'Je bent geen lid van deze groep' });
      if (project.status && project.status !== 'active') return res.status(403).json({ error: 'Project is niet meer actief' });
      if (group.status === 'archived') return res.status(403).json({ error: 'Groep is gearchiveerd' });
      if (!req.file) return res.status(400).json({ error: 'Geen bestand ontvangen (veld "file")' });
      const used = await countFeedbackRounds(group.id, persona.id);
      if (!feedbackRoundsState(persona.max_reviews, used).canSubmit) {
        return res.status(403).json({ error: 'Alle feedbackrondes bij deze beoordelaar zijn gebruikt.' });
      }
      let text;
      try {
        text = await extractTextFromUpload(req.file);
      } catch (e) {
        return res.status(400).json({ error: e.message || 'Kon tekst niet uit bestand halen' });
      }
      if (!text || !text.trim()) return res.status(400).json({ error: 'Geen leesbare tekst gevonden in dit bestand' });
      if (text.length > MAX_DOC_CHARS) text = text.slice(0, MAX_DOC_CHARS);
      const filename = String(req.file.originalname || 'upload').slice(0, 200);
      const { data: product, error: pErr } = await supabaseAdmin
        .from('project_group_products')
        .insert({ project_id: project.id, group_id: group.id, persona_id: persona.id, filename, content_text: text, byte_size: req.file.size || null, uploaded_by: auth.user.id })
        .select('id, filename, created_at').single();
      if (pErr) return res.status(500).json({ error: pErr.message });
      let result;
      try {
        result = await runEvaluatorReview({
          project, group, persona, title: filename, text,
          lang: normalizeLang(req.body?.lang), requesterId: auth.user.id, productId: product.id,
        });
      } catch (e) {
        // Geen oordeel = geen ronde verbruikt: het ingeleverde bestand gaat weer weg.
        await supabaseAdmin.from('project_group_products').delete().eq('id', product.id);
        if (e && e.status) return res.status(e.status).json(e.body);
        throw e;
      }
      const after = feedbackRoundsState(persona.max_reviews, used + 1);
      return res.json({
        product,
        review: result.inserted,
        badge: result.badge || null,
        used: after.used,
        remaining: after.remaining,
      });
    } catch (err) {
      console.error('[feedback POST]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/:projectId/groups/:groupId/relationships — de verstandhouding
  // per rolspeler die er een bijhoudt (andere persona's staan er niet in). De
  // groep ziet het niveau en de laatste aanleiding; de docent ook de geschiedenis.
  app.get('/api/projects/:projectId/groups/:groupId/relationships', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, groupId } = req.params;
    const lang = normalizeLang(req.query.lang);
    try {
      const { data: project } = await supabaseAdmin
        .from('projects').select('id, course_id').eq('id', projectId).maybeSingle();
      if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const isStaff = isLeapAdmin(profile);
      const memberOfGroup = await isGroupMember(groupId, auth.user.id);
      if (!isStaff && !memberOfGroup) {
        return res.status(403).json({ error: 'Geen toegang tot deze groep' });
      }
      const { data: groupCheck } = await supabaseAdmin
        .from('project_groups').select('id, project_id').eq('id', groupId).maybeSingle();
      if (!groupCheck || groupCheck.project_id !== projectId) {
        return res.status(404).json({ error: 'Groep niet gevonden in dit project' });
      }
      const { data: personas } = await supabaseAdmin
        .from('project_personas')
        .select('id, name, avatar_emoji, avatar, persona_type, reputation_enabled, start_level, sort_order')
        .eq('project_id', projectId)
        .order('sort_order');
      const personaList = (personas || []).filter(reputationActive);
      if (personaList.length === 0) return res.json({ relationships: [], isStaff });
      const { data: rels, error: relErr } = await supabaseAdmin
        .from('project_persona_relationships')
        .select('persona_id, score, history, updated_at')
        .eq('project_id', projectId).eq('group_id', groupId);
      if (relErr && !(relErr.code === '42P01' || /project_persona_relationships/i.test(relErr.message || ''))) {
        return res.status(500).json({ error: relErr.message });
      }
      const byPersona = new Map((rels || []).map(r => [r.persona_id, r]));
      const out = personaList.map(p => {
        const r = byPersona.get(p.id);
        const level = r ? relClampLevel(r.score) : clampStartLevel(p.start_level);
        const history = Array.isArray(r?.history) ? r.history : [];
        const last = relLastReason(history);
        return {
          personaId: p.id,
          personaName: p.name,
          avatarEmoji: p.avatar_emoji,
          avatar: p.avatar ?? null,
          level,
          key: relLevelKey(level),
          label: relLevelLabel(level, lang),
          broken: relIsBroken(level),
          lastReason: last ? { note: last.note, ts: last.ts, step: last.step } : null,
          updatedAt: r?.updated_at || null,
          history: isStaff ? history.slice(-8).reverse() : undefined,
        };
      });
      return res.json({ relationships: out, isStaff });
    } catch (err) {
      console.error('[relationships]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/:projectId/groups/:groupId/personas/:personaId/relationship-adjust
  // — correctie door de docent (niveau kiezen, ook "contact herstellen"). Route +
  // autorisatie staan in server/projects/relationshipAdjust.js zodat ze testbaar zijn.
  registerRelationshipAdjustRoute(app, {
    supabaseAdmin,
    authUser,
    getProfile: (id) => profileCache.get(id, loadProfileRoleEmail),
    // Privacy: docenten zien groepen niet meer; corrigeren doet de beheerder.
    isStaffForCourse: async (_user, profile) => isLeapAdmin(profile),
    setRelationshipLevel,
    levelKey: relLevelKey,
    reputationActive,
  });

  // POST /api/projects/:projectId/groups/:groupId/personas/:personaId/consultations-grant
  // — Task #252: staff-only toekenning van EXTRA raadplegingen voor één groep.
  // `extra` is het absolute aantal extra raadplegingen (0..1000) bovenop
  // persona.max_consultations. Idempotente upsert per (project, groep, persona).
  app.post('/api/projects/:projectId/groups/:groupId/personas/:personaId/consultations-grant', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, groupId, personaId } = req.params;
    const extra = conNormalizeExtra(req.body?.extra);
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
    try {
      const { data: project } = await supabaseAdmin
        .from('projects').select('id, course_id').eq('id', projectId).maybeSingle();
      if (!project) return res.status(404).json({ error: 'Project niet gevonden' });
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      if (!isLeapAdmin(profile)) return res.status(403).json({ error: 'Alleen een beheerder mag extra gesprekken toekennen' });

      const { data: groupCheck } = await supabaseAdmin
        .from('project_groups').select('id, project_id').eq('id', groupId).maybeSingle();
      if (!groupCheck || groupCheck.project_id !== projectId) {
        return res.status(404).json({ error: 'Groep niet gevonden in dit project' });
      }
      const { data: personaCheck } = await supabaseAdmin
        .from('project_personas').select('id, project_id, max_consultations').eq('id', personaId).maybeSingle();
      if (!personaCheck || personaCheck.project_id !== projectId) {
        return res.status(404).json({ error: 'Persona niet gevonden in dit project' });
      }

      const { data: grant, error: gErr } = await supabaseAdmin
        .from('project_persona_consultation_grants')
        .upsert({
          project_id: projectId, group_id: groupId, persona_id: personaId,
          extra_consultations: extra, note,
          granted_by: auth.user.id, updated_at: new Date().toISOString(),
        }, { onConflict: 'project_id,group_id,persona_id' })
        .select('extra_consultations, note, updated_at').single();
      if (gErr) {
        if (gErr.code === '42P01' || /project_persona_consultation_grants/i.test(gErr.message || '')) {
          return res.status(503).json({
            error: 'Migratie 20260608120000_persona_consultation_limits.sql is nog niet toegepast in Supabase.',
          });
        }
        return res.status(500).json({ error: gErr.message });
      }

      // Verbruik herberekenen voor directe UI-update.
      let used = 0;
      try { used = await countConsultations(groupId, personaId); } catch { /* best-effort */ }
      const limit = conComputeEffectiveLimit(personaCheck.max_consultations, grant.extra_consultations);
      return res.json({
        consultation: {
          personaId,
          used,
          extra: grant.extra_consultations,
          baseLimit: conNormalizeMax(personaCheck.max_consultations),
          limit,
          remaining: conComputeRemaining(used, limit),
          blocked: conIsBlocked(used, limit),
          note: grant.note,
          updated_at: grant.updated_at,
        },
      });
    } catch (err) {
      console.error('[consultations-grant]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // =============================================================================
  // Kopieer een project-persona terug naar de cursus-bibliotheek (course_personas).
  // Alleen staff. Idempotent: als er al een course_persona met dezelfde naam in
  // dezelfde cursus bestaat, geven we die terug zonder duplicate.
  // =============================================================================

  app.post('/api/projects/:projectId/personas/:personaId/copy-to-library', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId, personaId } = req.params;
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      // Docent van de cursus van het project of admin (requireProjectStaff); het
      // sjabloon komt in de bibliotheek van diezelfde cursus.
      const access = await requireProjectStaff(projectId, auth.user, profile);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const project = access.project;
      if (!project.course_id) return res.status(400).json({ error: 'Project hangt niet aan een cursus' });
      const { data: pp } = await supabaseAdmin
        .from('project_personas').select('*')
        .eq('id', personaId).eq('project_id', projectId).maybeSingle();
      if (!pp) return res.status(404).json({ error: 'Persona niet gevonden' });

      const { data: existing } = await supabaseAdmin
        .from('course_personas').select('id, name')
        .eq('course_id', project.course_id).eq('name', pp.name).maybeSingle();
      if (existing) return res.json({ persona: existing, alreadyExists: true });

      const libRow = {
        course_id: project.course_id,
        name: pp.name,
        avatar_emoji: pp.avatar_emoji,
        avatar: pp.avatar ?? null,
        system_prompt: pp.system_prompt,
        rag_enabled: pp.rag_enabled,
        rag_folder_ids: pp.rag_folder_ids,
        visible_from_phase: pp.visible_from_phase,
        is_default: false,
        ...copyRoleFields(pp),
        ...copyKnowledgeFields(pp, { project: false }),
        max_consultations: pp.max_consultations ?? null,
        auto_close_hours: pp.auto_close_hours ?? null,
        // Task #253: badge-toekenningsmodus mee terug naar de bibliotheek.
        badge_award_mode: normalizeBadgeAwardMode(pp.badge_award_mode),
        created_by: auth.user.id,
      };
      let { data: inserted, error: iErr } = await supabaseAdmin
        .from('course_personas').insert(libRow).select('*').single();
      if (iErr && (iErr.code === '42703' || /badge_award_mode/i.test(iErr.message || ''))) {
        const { badge_award_mode: _b, ...rowNoBadge } = libRow;
        ({ data: inserted, error: iErr } = await supabaseAdmin
          .from('course_personas').insert(rowNoBadge).select('*').single());
      }
      if (iErr) return res.status(500).json({ error: iErr.message });
      return res.json({ persona: inserted });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/personas/conduct-test — "Proefgesprek" voor de docent: wat
  // zou LEAP met de verstandhouding doen na dit (voorbeeld)gesprek? Werkt ook met
  // nog niet opgeslagen gedragsregels; er wordt niets opgeslagen.
  // Body: { courseId, personaName, conduct_rules, level (-2..2), transcript, lang }.
  app.post('/api/admin/personas/conduct-test', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { courseId, personaName, conduct_rules: conductRules, level, transcript } = req.body || {};
    const lang = normalizeLang(req.body?.lang);
    if (!courseId) return res.status(400).json({ error: 'courseId is vereist' });
    const text = typeof transcript === 'string' ? transcript.trim() : '';
    if (!text) return res.status(400).json({ error: 'Schrijf eerst een voorbeeldgesprek.' });
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      if (!(await isStaffForCourse(auth.user, profile, courseId))) {
        return res.status(403).json({ error: 'Alleen docenten van deze cursus' });
      }
      if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
      const from = clampStartLevel(level);
      const r = await openaiChatCompletion({
        model: OPENAI_MODEL,
        messages: relBuildJudgeMessages({
          personaName: String(personaName || 'Persona').slice(0, 120),
          conductRules: roleFieldsFrom({ conduct_rules: conductRules }, { partial: true }).conduct_rules,
          level: from,
          transcript: text.slice(0, 12000),
          lang,
          languageName: languageEnglishName(lang),
        }),
        ...chatModelParams({ temperature: 0, maxTokens: 300 }),
        response_format: { type: 'json_object' },
      });
      if (!r.ok) return res.status(502).json({ error: 'Het taalmodel kon het gesprek niet beoordelen.' });
      const judged = relValidateJudgement((await r.json()).choices?.[0]?.message?.content || '');
      const to = relNextLevel(from, judged.step);
      return res.json({ step: judged.step, reason: judged.reason, from, to, key: relLevelKey(to), label: relLevelLabel(to, lang) });
    } catch (err) {
      console.error('[conduct-test]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/course-personas', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const { course_id, name, avatar_emoji, system_prompt, rag_enabled, rag_folder_ids, badge_award_mode } = req.body || {};
      if (!course_id || !name?.trim()) return res.status(400).json({ error: 'course_id en name zijn verplicht' });
      if (!(await isStaffForCourse(auth.user, profile, course_id))) {
        return res.status(403).json({ error: 'Alleen docenten van deze cursus kunnen persona-sjablonen aanmaken' });
      }
      const { fields: knowledge } = await sanitizePersonaKnowledge(knowledgeFieldsFrom(req.body, { project: false }), { courseId: course_id });
      const libRow = {
        ...knowledge,
        course_id,
        name: String(name).trim(),
        avatar_emoji: avatar_emoji || '🤖',
        avatar: sanitizeAvatar(req.body?.avatar) ?? null,
        system_prompt: system_prompt || '',
        rag_enabled: rag_enabled !== false,
        rag_folder_ids: Array.isArray(rag_folder_ids) ? rag_folder_ids : [],
        is_default: false,
        ...roleFieldsFrom(req.body),
        max_consultations: conNormalizeMax(req.body?.max_consultations),
        auto_close_hours: conNormalizeAutoCloseHours(req.body?.auto_close_hours),
        // Task #253: badge-toekenningsmodus (individual | group).
        badge_award_mode: normalizeBadgeAwardMode(badge_award_mode),
        created_by: auth.user.id,
      };
      let { data: inserted, error: iErr } = await supabaseAdmin
        .from('course_personas').insert(libRow).select('*').single();
      if (iErr && (iErr.code === '42703' || /badge_award_mode/i.test(iErr.message || ''))) {
        const { badge_award_mode: _b, ...rowNoBadge } = libRow;
        ({ data: inserted, error: iErr } = await supabaseAdmin
          .from('course_personas').insert(rowNoBadge).select('*').single());
      }
      if (iErr) return res.status(500).json({ error: iErr.message });
      return res.status(201).json({ persona: inserted });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/admin/course-personas/:personaId', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { personaId } = req.params;
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const found = await loadCoursePersonaForStaff(personaId, auth.user, profile);
      if (found.error) return res.status(found.status).json({ error: found.error });
      const { name, avatar_emoji, system_prompt, rag_enabled, rag_folder_ids, badge_award_mode } = req.body || {};
      const patch = {};
      if (name !== undefined) patch.name = String(name).trim();
      if (avatar_emoji !== undefined) patch.avatar_emoji = avatar_emoji;
      if (req.body && 'avatar' in req.body) {
        const avatar = sanitizeAvatar(req.body.avatar);
        if (avatar === undefined) return res.status(400).json({ error: 'Ongeldige avatar' });
        patch.avatar = avatar;
      }
      if (system_prompt !== undefined) patch.system_prompt = system_prompt;
      if (rag_enabled !== undefined) patch.rag_enabled = rag_enabled;
      if (rag_folder_ids !== undefined) patch.rag_folder_ids = Array.isArray(rag_folder_ids) ? rag_folder_ids : [];
      Object.assign(patch, roleFieldsFrom(req.body, { partial: true }));
      Object.assign(patch, (await sanitizePersonaKnowledge(knowledgeFieldsFrom(req.body, { partial: true, project: false }),
        { courseId: found.persona?.course_id })).fields);
      if (req.body && 'max_consultations' in req.body) patch.max_consultations = conNormalizeMax(req.body.max_consultations);
      if (req.body && 'auto_close_hours' in req.body) patch.auto_close_hours = conNormalizeAutoCloseHours(req.body.auto_close_hours);
      if (badge_award_mode !== undefined) patch.badge_award_mode = normalizeBadgeAwardMode(badge_award_mode);
      let { data: updated, error: uErr } = await supabaseAdmin
        .from('course_personas').update(patch).eq('id', personaId).select('*').maybeSingle();
      if (uErr && (uErr.code === '42703' || /badge_award_mode/i.test(uErr.message || ''))) {
        const { badge_award_mode: _b, ...patchNoBadge } = patch;
        if (Object.keys(patchNoBadge).length === 0) return res.json({ persona: null });
        ({ data: updated, error: uErr } = await supabaseAdmin
          .from('course_personas').update(patchNoBadge).eq('id', personaId).select('*').maybeSingle());
      }
      if (uErr) return res.status(500).json({ error: uErr.message });
      if (!updated) return res.status(404).json({ error: 'Persona niet gevonden' });
      // Eén persona = één gezicht: het nieuwe gezicht meteen in alle projecten.
      const face = faceFields(patch);
      if (face) {
        try {
          await syncPersonaFace(supabaseAdmin, { templateId: personaId, fields: face, fromTemplate: true });
        } catch (syncErr) {
          console.warn('[persona-face] doorvoeren mislukt:', syncErr.message);
        }
      }
      return res.json({ persona: updated });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/admin/course-personas/:personaId', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { personaId } = req.params;
    try {
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const found = await loadCoursePersonaForStaff(personaId, auth.user, profile);
      if (found.error) return res.status(found.status).json({ error: found.error });
      const { error: delErr } = await supabaseAdmin
        .from('course_personas').delete().eq('id', personaId);
      if (delErr) return res.status(500).json({ error: delErr.message });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}
