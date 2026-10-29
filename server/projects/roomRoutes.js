import { createClient } from '@supabase/supabase-js';
import {
  computeEffectiveLimit as conComputeEffectiveLimit,
  computeRemaining as conComputeRemaining,
  isConsultationBlocked as conIsBlocked,
  normalizeAutoCloseHours as conNormalizeAutoCloseHours,
  normalizeExtraGrant as conNormalizeExtra,
  normalizeMaxConsultations as conNormalizeMax,
} from './consultationLimit.js';
import { journalFieldsFromModel, journalFormatInstruction } from '../journal/journalSections.js';
import { buildLanguageInstruction, languageEnglishName, normalizeLang } from '../i18n/languages.js';
import {
  authUser,
  isLeapAdmin,
  isStaffForCourse,
  loadProfileRoleEmail,
  profileCache,
  userCache,
} from '../lib/auth.js';
import {
  AZURE_CHAT_READY,
  LLM_NOT_CONFIGURED_MSG,
  OPENAI_MODEL,
  chatModelParams,
  openaiChatCompletion,
} from '../lib/azureOpenai.js';
import { courseFeatureOnFor, loadCourseFeatures, rejectIfFeatureOff } from '../lib/courseFeatureGate.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabaseAdmin } from '../lib/supabase.js';
import { loadEvaluatorMaterial } from './personaKnowledge.js';
import {
  isBroken as relIsBroken,
  levelKey as relLevelKey,
  levelLabel as relLevelLabel,
} from './personaRelationship.js';
import {
  journalFromPersonaSummary,
  journalFromRubricFeedback,
  journalFromSynthesis,
} from './projectJournal.js';
import {
  SAVE_SOURCES,
  assessmentRefs,
  checkpointItemRefs,
  checkpointItems,
  isSaved,
  noteEntry,
  reviewEntry,
  reviewRefs,
} from './projectJournalSave.js';
import { isGroupMember, requireProjectStaff, userHasProjectAccess } from './access.js';
import {
  autoCloseStaleThreads,
  loadThreadCloseContext,
  loadThreadMessages,
  performThreadClose,
  threadCloseJobs,
  threadClosePrep,
} from './threadCloseService.js';

async function courseIdForProject(projectId) {
  if (!projectId || !supabaseAdmin) return null;
  try {
    const { data } = await supabaseAdmin
      .from('projects').select('course_id').eq('id', projectId).maybeSingle();
    return data?.course_id || null;
  } catch { return null; }
}

// Helper: genereert cross-agent synthese op basis van afgesloten gesprekken.
// Geeft null terug als er minder dan 2 afgesloten gesprekken zijn.
async function generateCrossAgentSynthesis(groupId, apiKey, lang = 'nl') {
  const enMode = lang !== 'nl';
  const { data: closedThreads } = await supabaseAdmin
    .from('group_persona_threads')
    .select('id, persona_id, topics, agreements')
    .eq('group_id', groupId)
    .not('closed_at', 'is', null)
    .order('closed_at', { ascending: false });

  if (!closedThreads || closedThreads.length < 2) return null;

  const personaIds = [...new Set(closedThreads.map(t => t.persona_id))];
  const { data: personas } = await supabaseAdmin
    .from('project_personas').select('id, name, avatar_emoji').in('id', personaIds);
  const personaMap = Object.fromEntries((personas || []).map(p => [p.id, p]));

  const convText = closedThreads.map(t => {
    const p = personaMap[t.persona_id] || {};
    const topics = (t.topics || []).join('; ');
    const agreements = (t.agreements || []).join('; ');
    return enMode
      ? `${p.avatar_emoji || '💬'} ${p.name || 'Persona'}:\n- Discussed: ${topics || '(none)'}\n- Agreed: ${agreements || '(none)'}`
      : `${p.avatar_emoji || '💬'} ${p.name || 'Persona'}:\n- Besproken: ${topics || '(geen)'}\n- Afgesproken: ${agreements || '(geen)'}`;
  }).join('\n\n');

  const prompt = (enMode
    ? `You are analysing conversations a group of students has had with different AI personas in a research project.\n\nConversation summary per persona:\n${convText}\n\nReturn your answer ONLY as valid JSON:\n{\n  "overeenstemming": ["...", ...],\n  "spanningspunten": ["...", ...],\n  "suggesties": ["...", ...]\n}\n\n- "overeenstemming": 2-4 points that multiple personas agreed on or gave similar information about.\n- "spanningspunten": 1-3 points where personas clearly disagreed or gave contradictory information. Leave the array empty if there are none.\n- "suggesties": 2-3 concrete next steps the group can take based on the conversations.\n\nWrite in English, concise and concrete. No markdown outside the JSON.`
    : `Je analyseert gesprekken die een groep studenten heeft gevoerd met verschillende AI-personas in een onderzoeksproject.\n\nGesprekssamenvatting per persona:\n${convText}\n\nGeef je antwoord UITSLUITEND als geldige JSON:\n{\n  "overeenstemming": ["...", ...],\n  "spanningspunten": ["...", ...],\n  "suggesties": ["...", ...]\n}\n\n- "overeenstemming": 2-4 punten waarover meerdere personas het eens zijn of vergelijkbare informatie gaven.\n- "spanningspunten": 1-3 punten waarover personas duidelijk anders denken of tegenstrijdige informatie gaven. Laat de array leeg als er geen zijn.\n- "suggesties": 2-3 concrete volgende stappen die de groep kan zetten op basis van de gesprekken.\n\nSchrijf in het Nederlands, bondig en concreet. Geen markdown buiten de JSON.`) + buildLanguageInstruction(lang, { json: true });

  try {
    const resp = await openaiChatCompletion({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      ...chatModelParams({ temperature: 0.3, maxTokens: 800 }),
      response_format: { type: 'json_object' },
    });
    if (resp.ok) {
      const raw = ((await resp.json()).choices?.[0]?.message?.content || '{}').trim();
      const parsed = JSON.parse(raw);
      return {
        overeenstemming: Array.isArray(parsed.overeenstemming) ? parsed.overeenstemming.filter(s => typeof s === 'string' && s.trim()) : [],
        spanningspunten: Array.isArray(parsed.spanningspunten) ? parsed.spanningspunten.filter(s => typeof s === 'string' && s.trim()) : [],
        suggesties: Array.isArray(parsed.suggesties) ? parsed.suggesties.filter(s => typeof s === 'string' && s.trim()) : [],
        lang,
      };
    }
  } catch (e) {
    console.error('[cross-agent-synthese] LLM fout:', e.message);
  }
  return null;
}

export function registerProjectRoomRoutes(app) {
  // /api/projects/save-summary — vat een project (en de bijhorende sessie van
  // de student) samen via OpenAI en bewaart het resultaat als een
  // learning_journal_entries-rij met activity_type='project_reflection'. Werkt
  // los van de status van het project; je kunt een lopend of afgerond project
  // archiveren. De projectsessie zelf blijft bestaan — dit is puur een
  // reflectie-snapshot in het leerdagboek.
  app.post('/api/projects/save-summary', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

    const { sessionId, force } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId is vereist' });
    }
    if (force !== undefined && typeof force !== 'boolean') {
      return res.status(400).json({ error: 'force moet een boolean zijn' });
    }

    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      const { data: row, error: fetchErr } = await supabaseAdmin
        .from('student_project_sessions')
        .select('id, student_id, project_id, current_phase, hypothesis, analysis_notes, conclusions, completed, started_at, last_activity, projects(title, description, research_question, difficulty)')
        .eq('id', sessionId)
        .maybeSingle();

      if (fetchErr) return res.status(500).json({ error: fetchErr.message });
      if (!row) return res.status(404).json({ error: 'Projectsessie niet gevonden' });
      if (row.student_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot deze projectsessie' });
      // Leerdagboek uit in de cursus van dit project: geen projectreflectie.
      if (await rejectIfFeatureOff(res, user, null, await courseIdForProject(row.project_id), 'journal')) return;

      const apiKey = process.env.OPENAI_API_KEY;
      if (!AZURE_CHAT_READY) {
        return res.status(503).json({
          error: 'De samenvatting kon niet worden opgesteld.',
          detail: 'Geen taalmodel-toegang (Azure OpenAI niet geconfigureerd).',
        });
      }

      const project = row.projects || {};
      const projectTitle = project.title || '(naamloos project)';
      const projectDescription = (project.description || '').trim();
      const researchQuestion = (project.research_question || '').trim();
      const difficulty = project.difficulty || 'onbekend';
      const phase = row.current_phase || 'onbekend';
      const hypothesis = (row.hypothesis || '').trim();
      const analysisNotes = (row.analysis_notes || '').trim();
      const conclusions = (row.conclusions || '').trim();
      const status = row.completed ? 'afgerond' : 'in uitvoering';

      // Voorkom hallucinatie op een lege sessie: als alle drie de werkvelden
      // leeg zijn, is er niets zinvols om te reflecteren en zou OpenAI de prompt
      // alsnog "creatief" invullen. Geef een duidelijke fout terug zodat de UI
      // de student kan vragen eerst iets in te vullen.
      if (!hypothesis && !analysisNotes && !conclusions) {
        return res.status(400).json({
          error: 'Er is nog niets om samen te vatten.',
          detail: 'Vul eerst je hypothese, analyse-aantekeningen of conclusies in voor je een samenvatting in je leerdagboek zet.',
        });
      }

      // Voorkom dubbele projectreflecties: check of er al een eerdere
      // reflectie voor exact dit project (zelfde titel) in het leerdagboek
      // van deze student staat. Zo ja, en de student heeft niet expliciet
      // bevestigd, vragen we eerst om bevestiging zodat het leerdagboek niet
      // volloopt en we niet onnodig OpenAI-tokens verbruiken.
      const titleProjectShort = projectTitle.length > 80 ? `${projectTitle.slice(0, 77)}...` : projectTitle;
      const journalTitle = `Projectreflectie: ${titleProjectShort}`;
      if (!force) {
        const { data: existing, error: existingErr } = await supabaseAdmin
          .from('learning_journal_entries')
          .select('id, created_at')
          .eq('user_id', user.id)
          .eq('activity_type', 'project_reflection')
          .eq('title', journalTitle)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (existingErr) {
          console.warn('[projects/save-summary] Kon dubbele-check niet uitvoeren:', existingErr.message);
        } else if (existing) {
          return res.status(409).json({
            error: 'duplicate_reflection',
            message: 'Er staat al een projectreflectie voor dit project in je leerdagboek.',
            existingEntry: { id: existing.id, created_at: existing.created_at },
          });
        }
      }

      const summaryPrompt = `Je bent een "critical friend" voor een student aan de VU Amsterdam. Een student heeft aan een data-analyseproject gewerkt en wil daar in het leerdagboek op reflecteren. Schrijf een formatief reflectieverslag van 8 tot 14 regels in het Nederlands, gericht aan de student zelf.

Aanspraakvorm (volg STRIKT):
- Spreek de student direct aan met "je" / "jij" / "jouw" / "je hebt".
- Gebruik NOOIT formuleringen als "de student", "deze student", "de student heeft" of andere derde-persoonsverwijzingen naar de student. Schrijf alsof je de feedback één-op-één tegen de student geeft.

Je verslag bevat — in deze volgorde, met deze (vetgedrukte) kopjes op aparte regels:
**Wat je hebt laten zien**
- Concrete sterke punten op basis van je hypothese, analyse-aantekeningen en conclusies. Wees specifiek over methodische keuzes die opvallen.

**Aandachtspunten**
- Waar je redenering nog niet rond is, welke aannames of nuances je hebt laten liggen, en welke methodische valkuilen op de loer liggen voor het type onderzoek.

**Wat je hiermee kunt**
- Eén of twee concrete vervolgstappen — wat ga je nalezen, controleren of uitwerken om dit project (of een vergelijkbare analyse) verder te brengen.

Project-context:
- Titel: ${projectTitle}
- Status: ${status} (huidige fase: ${phase})
- Niveau: ${difficulty}${researchQuestion ? `\n- Beoogd projectresultaat: ${researchQuestion}` : ''}${projectDescription ? `\n- Projectbeschrijving: ${projectDescription}` : ''}

Jouw werk tot nu toe:
- Hypothese: ${hypothesis || '(nog niet ingevuld)'}
- Analyse-aantekeningen: ${analysisNotes || '(nog niet ingevuld)'}
- Conclusies: ${conclusions || '(nog niet ingevuld)'}

Schrijf het verslag direct, zonder aanhef en zonder afsluitende groet. Wees concreet, eerlijk en motiverend; vermijd vaagheden en clichés.` + journalFormatInstruction('nl');

      let summaryContent;
      try {
        const chatResp = await openaiChatCompletion({
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content: summaryPrompt }],
          ...chatModelParams({ temperature: 0.5, maxTokens: 1000 }),
        });
        if (!chatResp.ok) {
          const txt = await chatResp.text();
          console.error('[projects/save-summary] OpenAI fout:', chatResp.status, txt);
          return res.status(502).json({
            error: 'De samenvatting kon niet worden opgesteld.',
            detail: `Het taalmodel reageerde met status ${chatResp.status}.`,
          });
        }
        const chatData = await chatResp.json();
        summaryContent = chatData.choices?.[0]?.message?.content;
        if (!summaryContent) {
          return res.status(502).json({
            error: 'De samenvatting kon niet worden opgesteld.',
            detail: 'Het taalmodel gaf een leeg antwoord.',
          });
        }
      } catch (chatErr) {
        console.error('[projects/save-summary] OpenAI request mislukt:', chatErr.message);
        return res.status(502).json({
          error: 'De samenvatting kon niet worden opgesteld.',
          detail: chatErr.message,
        });
      }

      const { data: entry, error: journalError } = await supabaseAdmin
        .from('learning_journal_entries')
        .insert({
          user_id: user.id,
          title: journalTitle,
          ...journalFieldsFromModel(summaryContent, 'nl'),
          activity_type: 'project_reflection',
          course_id: await courseIdForProject(row.project_id),
        })
        .select('id')
        .single();

      if (journalError) {
        console.error('[projects/save-summary] Journal insert error:', journalError);
        return res.status(500).json({
          error: 'De samenvatting kon niet worden opgeslagen in je leerdagboek.',
          detail: journalError.message,
        });
      }

      console.log(`[projects/save-summary] Journal entry aangemaakt: ${entry.id} voor sessie ${sessionId}`);
      return res.json({ success: true, journalEntryId: entry.id });
    } catch (err) {
      console.error('[projects/save-summary] Onverwachte fout:', err);
      return res.status(500).json({ error: 'Interne fout', detail: err?.message });
    }
  });

  // GET /api/projects/:projectId/room?groupId=... — alle data die de
  // projectruimte nodig heeft in één call: project, groep, leden, personas
  // (project-eigen, anders course-bibliotheek), checkpoints, en thread-ids per
  // persona (worden lazy aangemaakt).
  app.get('/api/projects/:projectId/room', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { projectId } = req.params;
    const { groupId } = req.query;

    try {
      // Project, profiel en groep hangen niet van elkaar af: tegelijk ophalen.
      const [{ data: project }, { data: profile }, groupRes] = await Promise.all([
        supabaseAdmin.from('projects').select('*').eq('id', projectId).maybeSingle(),
        profileCache.get(auth.user.id, loadProfileRoleEmail),
        groupId
          ? supabaseAdmin.from('project_groups').select('*').eq('id', groupId).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      if (!project) return res.status(404).json({ error: 'Project niet gevonden' });

      // Authorisatie: ook zonder groupId moeten we project-toegang afdwingen
      // (anders lekken we projectinhoud + persona-bibliotheek aan iedere ingelogde
      // user, ongeacht cursus-toegang).
      const isStaff = await isStaffForCourse(auth.user, profile, project.course_id);
      if (!isStaff && !(await userHasProjectAccess(auth.user, profile, project))) {
        return res.status(403).json({ error: 'Geen toegang tot dit project' });
      }

      let group = null;
      let members = [];
      if (groupId) {
        const g = groupRes.data;
        if (!g) return res.status(404).json({ error: 'Groep niet gevonden' });
        if (g.project_id !== projectId) return res.status(400).json({ error: 'Groep hoort niet bij dit project' });

        const [isMember, { data: m }] = await Promise.all([
          isGroupMember(g.id, auth.user.id),
          supabaseAdmin
            .from('project_group_members')
            .select('id, user_id, role, joined_at, profiles(id, full_name, email)')
            .eq('group_id', g.id),
        ]);
        if (!isMember && !isLeapAdmin(profile)) return res.status(403).json({ error: 'Geen toegang tot deze groep' });
        group = g;
        members = m || [];
      }

      // Project-brede docent-documenten (read-only voor studenten).
      // Studenten zien alleen bestanden die is_visible_to_students = true hebben.
      let pdQuery = supabaseAdmin
        .from('project_documents')
        .select('id, filename, byte_size, mime_type, document_ref_id, is_visible_to_students, uploaded_by, created_at')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false });
      if (!isStaff) pdQuery = pdQuery.eq('is_visible_to_students', true);

      // Personas, tussenstanden, documenten en beoordelaars: tegelijk.
      const [{ data: pp }, { data: cps }, { data: projectDocs }, { data: evRows }] = await Promise.all([
        supabaseAdmin.from('project_personas').select('*').eq('project_id', projectId).order('sort_order'),
        group
          ? supabaseAdmin.from('group_checkpoints').select('*').eq('group_id', group.id).order('created_at', { ascending: false })
          : Promise.resolve({ data: [] }),
        pdQuery,
        supabaseAdmin
          .from('project_personas')
          .select('id, name, avatar_emoji, avatar, persona_type, project_knowledge_doc_ids')
          .eq('project_id', projectId)
          .eq('persona_type', 'evaluator')
          .order('sort_order'),
      ]);

      // Personas: project-eigen heeft voorrang; anders bibliotheek van de cursus.
      // Studenten zien evaluator-persona's NIET; staff wel (zodat ze in de
      // beheer-flow zichtbaar blijven en de evaluate-knop in de UI verschijnt).
      let personas = [];
      let evaluatorCount = 0;
      if (pp && pp.length > 0) {
        // Alleen project-eigen evaluators tellen mee voor hasEvaluator zodat de
        // UI-knop precies overeenkomt met wat /evaluate kan beoordelen
        // (course-fallback-personas zijn nooit evaluator-bronnen).
        evaluatorCount = pp.filter(p => p.persona_type === 'evaluator' && p.id !== project.preassessment_persona_id).length;
        const filtered = isStaff ? pp : pp.filter(p => p.persona_type !== 'evaluator');
        // Wat een persona kent, is voor de docent; studenten krijgen het niet mee.
        personas = filtered.map(p => {
          if (isStaff) return { ...p, _source: 'project' };
          const { course_knowledge: _ck, course_knowledge_doc_ids: _cd, project_knowledge_doc_ids: _pd, rag_folder_ids: _rf, ...rest } = p;
          return { ...rest, _source: 'project' };
        });
      } else if (project.course_id) {
        const { data: cp } = await supabaseAdmin
          .from('course_personas').select('*').eq('course_id', project.course_id).order('is_default', { ascending: false });
        const list = cp || [];
        // evaluatorCount blijft 0: course-fallback-personas worden niet door
        // /evaluate gebruikt — geen UI-knop tonen.
        const filtered = isStaff ? list : list.filter(p => p.persona_type !== 'evaluator');
        personas = filtered.map(p => {
          if (isStaff) return { ...p, _source: 'course' };
          const { course_knowledge: _ck, course_knowledge_doc_ids: _cd, rag_folder_ids: _rf, ...rest } = p;
          return { ...rest, _source: 'course' };
        });
      }
      // Default Consultant als er nog niets is.
      if (personas.length === 0) {
        personas = [{
          id: '__default__',
          name: 'Consultant',
          avatar_emoji: '🧑‍🏫',
          system_prompt: 'Je bent een rustige onderzoeks-consultant voor een groep VU-studenten. Stel scherpe Socratische vragen, vat terug, en help de groep een onderzoeksvoorstel scherper te krijgen. Spreek de student aan met "je"/"jij".',
          rag_enabled: true,
          course_knowledge: 'all',
          rag_folder_ids: [],
          _source: 'default',
        }];
      }

      const checkpoints = cps || [];

      // Rapporten van "Beoordeling opvragen" (staan ook in de projectruimte, los
      // van het leerdagboek). Ontbrekende tabel = leeg.
      let assessments = [];
      if (group) {
        const { data: aRows, error: aErr } = await supabaseAdmin
          .from('project_group_assessments')
          .select('id, persona_id, persona_name, persona_emoji, content, request_id, created_at')
          .eq('group_id', group.id).order('created_at', { ascending: false });
        if (!aErr) assessments = aRows || [];
      }

      // Task #166: minimale evaluator-info voor non-staff zodat de
      // document-review UI per upload de avatars + "Vraag oordeel aan"-knop kan
      // tonen, zonder de evaluators door de persona-dropdown te leaken.
      let evaluators = [];
      {
        const evIds = (evRows || []).map(p => p.id);
        // Task #253: voor studenten zichtbaar gemaakte rubrics per evaluator.
        // Staff ziet ook alle rubrics (incl. niet-zichtbare) met hun status.
        // Sinds 2026-10-27: de rubric van een beoordelaar is een projectdocument
        // (soort 'rubric') dat hij kent (personaKnowledge.js). Studenten zien
        // alleen wat de docent zichtbaar maakte; openen gaat via de projectdocument-route.
        const rubricsByPersona = new Map();
        const rubricIds = [...new Set((evRows || []).flatMap(p => p.project_knowledge_doc_ids || []))];
        if (evIds.length > 0 && rubricIds.length > 0) {
          let rq = supabaseAdmin
            .from('project_documents')
            .select('id, filename, byte_size, is_visible_to_students, material_kind')
            .eq('project_id', projectId).in('id', rubricIds).eq('material_kind', 'rubric');
          if (!isStaff) rq = rq.eq('is_visible_to_students', true);
          const { data: rubricRows } = await rq;
          const rubricById = new Map((rubricRows || []).map(d => [d.id, d]));
          (evRows || []).forEach(p => {
            const list = (p.project_knowledge_doc_ids || []).map(id => rubricById.get(id)).filter(Boolean)
              .map(d => ({ id: d.id, filename: d.filename, byte_size: d.byte_size, visible_to_students: d.is_visible_to_students === true, source: 'project' }));
            if (list.length) rubricsByPersona.set(p.id, list);
          });
        }
        // De voorbeoordelaar van het eindproduct is alleen voor de docent.
        const hidePre = !isStaff && project.preassessment_persona_id;
        evaluators = (evRows || []).filter(p => !hidePre || p.id !== project.preassessment_persona_id).map(p => ({
          id: p.id, name: p.name, avatar_emoji: p.avatar_emoji, avatar: p.avatar ?? null,
          rubrics: rubricsByPersona.get(p.id) || [],
        }));
      }

      // Task #252: raadpleeglimiet per project-persona voor deze groep. Lui
      // worden stille open threads eerst afgerond (op basis van auto_close_hours).
      let consultations = [];
      if (group) {
        const lang = normalizeLang(req.query.lang);
        const projectPersonas = personas.filter(p => p._source === 'project');
        // Lui auto-close per persona met een ingesteld venster.
        await Promise.all(projectPersonas
          .filter(p => conNormalizeAutoCloseHours(p.auto_close_hours) !== null)
          .map(p => autoCloseStaleThreads({
            groupId: group.id, personaId: p.id,
            autoCloseHours: p.auto_close_hours,
            closedBy: auth.user.id, lang,
          }).catch(e => console.warn('[room] auto-close mislukte:', e.message))));
        // Verbruik (threads, open + gesloten) per persona tellen.
        const [{ data: allThreads }, { data: grants, error: grantErr }] = await Promise.all([
          supabaseAdmin
            .from('group_persona_threads')
            .select('persona_id, closed_at')
            .eq('group_id', group.id),
          supabaseAdmin
            .from('project_persona_consultation_grants')
            .select('persona_id, extra_consultations')
            .eq('project_id', projectId).eq('group_id', group.id),
        ]);
        const usedByPersona = new Map();
        const openByPersona = new Set();
        (allThreads || []).forEach(t => {
          usedByPersona.set(t.persona_id, (usedByPersona.get(t.persona_id) || 0) + 1);
          if (!t.closed_at) openByPersona.add(t.persona_id);
        });
        // Extra toekenningen per persona (defensief tegen ontbrekende tabel).
        const extraByPersona = new Map();
        if (!grantErr) {
          (grants || []).forEach(g => extraByPersona.set(g.persona_id, conNormalizeExtra(g.extra_consultations)));
        }
        consultations = projectPersonas.map(p => {
          const used = usedByPersona.get(p.id) || 0;
          const extra = extraByPersona.get(p.id) || 0;
          const limit = conComputeEffectiveLimit(p.max_consultations, extra);
          return {
            personaId: p.id,
            used,
            extra,
            baseLimit: conNormalizeMax(p.max_consultations),
            limit,
            remaining: conComputeRemaining(used, limit),
            // "blocked" = er kan geen NIEUWE raadpleging gestart worden.
            blocked: conIsBlocked(used, limit),
            hasOpenThread: openByPersona.has(p.id),
            autoCloseHours: conNormalizeAutoCloseHours(p.auto_close_hours),
          };
        });
      }

      // Staat dit al in MIJN leerdagboek? (projectJournalSave.js; oude automatische regels tellen mee)
      const journalSaved = { checkpoints: {}, assessments: {} };
      {
        const cpParts = checkpoints.map(cp => ({ cp, items: checkpointItems(cp, { lang: normalizeLang(req.query.lang) }) }));
        const refs = [
          ...cpParts.flatMap(({ cp, items }) => items.flatMap(it => checkpointItemRefs(cp, it))),
          ...assessments.flatMap(a => assessmentRefs({ ...a, group_id: group?.id })),
        ];
        const { data: mine } = refs.length
          ? await supabaseAdmin.from('learning_journal_entries').select('source_ref').eq('user_id', auth.user.id).in('source_ref', refs)
          : { data: [] };
        const have = new Set((mine || []).map(e => e.source_ref));
        for (const { cp, items } of cpParts) journalSaved.checkpoints[cp.id] = items.length > 0 && items.every(it => isSaved(checkpointItemRefs(cp, it), have));
        for (const a of assessments) journalSaved.assessments[a.id] = isSaved(assessmentRefs({ ...a, group_id: group?.id }), have);
      }

      return res.json({
        project, group, members, personas, checkpoints, assessments, journalSaved,
        // Onderdelen van de cursus: de ruimte noemt het leerdagboek alleen als dat aan staat.
        courseFeatures: await loadCourseFeatures(project?.course_id),
        projectDocuments: projectDocs || [],
        evaluators,
        hasEvaluator: evaluatorCount > 0,
        consultations,
      });
    } catch (err) {
      console.error('[projects/:id/room]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/groups/:groupId/threads/:threadId/close-preview
  // Genereert een AI-samenvatting (topics + agreements) zonder te schrijven naar de DB.
  app.post('/api/projects/groups/:groupId/threads/:threadId/close-preview', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { groupId, threadId } = req.params;
    const lang = normalizeLang(req.body?.lang);

    try {
      if (!(await isGroupMember(groupId, auth.user.id))) {
        return res.status(403).json({ error: 'Geen toegang tot deze groep' });
      }
      const { data: thread } = await supabaseAdmin
        .from('group_persona_threads')
        .select('id, group_id, persona_id, closed_at')
        .eq('id', threadId).eq('group_id', groupId).is('closed_at', null).maybeSingle();
      if (!thread) return res.status(404).json({ error: 'Thread niet gevonden of al afgesloten' });

      const [{ allMsgs }, ctx] = await Promise.all([loadThreadMessages(thread.id), loadThreadCloseContext(thread, groupId)]);
      // Te weinig berichten: lege neerslag teruggeven zodat afsluiten altijd werkt.
      if (allMsgs.length < 2) {
        return res.json({ topics: [], agreements: [] });
      }
      if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });

      // Neerslag maken (of hergebruiken) en het oordeel over de verstandhouding
      // alvast op de achtergrond starten; bij het afsluiten ligt alles klaar.
      const { topics, agreements } = await threadClosePrep.preview(threadCloseJobs({ thread, groupId, lang, allMsgs, ...ctx }));
      return res.json({ topics, agreements });
    } catch (err) {
      console.error('[threads/close-preview]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/projects/groups/:groupId/threads/:threadId/close', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { groupId, threadId } = req.params;
    const lang = normalizeLang(req.body?.lang);

    try {
      if (!(await isGroupMember(groupId, auth.user.id))) {
        return res.status(403).json({ error: 'Geen toegang tot deze groep' });
      }
      const { data: thread } = await supabaseAdmin
        .from('group_persona_threads')
        .select('id, group_id, persona_id, closed_at')
        .eq('id', threadId).eq('group_id', groupId).is('closed_at', null).maybeSingle();
      if (!thread) return res.status(404).json({ error: 'Thread niet gevonden of al afgesloten' });

      const { topics, agreements, reputation, personaName } = await performThreadClose({
        thread, groupId, lang, closedBy: auth.user.id,
      });

      const response = { ok: true, threadId, topics, agreements };
      // De groep ziet wat het gesprek met de verstandhouding deed.
      if (reputation) {
        response.reputation = {
          personaName,
          step: reputation.step,
          reason: reputation.reason,
          level: reputation.to,
          key: relLevelKey(reputation.to),
          label: relLevelLabel(reputation.to, lang),
          broken: relIsBroken(reputation.to),
        };
      }
      return res.json(response);
    } catch (err) {
      console.error('[threads/close]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // GET /api/projects/groups/:groupId/conversation-log — alle afgesloten gesprekken.
  app.get('/api/projects/groups/:groupId/conversation-log', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { groupId } = req.params;

    try {
      const isMember = await isGroupMember(groupId, auth.user.id);
      const { data: prof } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      // Cursus van de groep ophalen om docent-staff per cursus te checken.
      const { data: grpRow } = await supabaseAdmin
        .from('project_groups').select('project_id, projects(course_id)').eq('id', groupId).maybeSingle();
      const grpCourseId = grpRow?.projects?.course_id || null;
      const isStaffUser = isLeapAdmin(prof); // docenten niet (privacy); grpCourseId alleen nog ter controle
      void grpCourseId;
      if (!isMember && !isStaffUser) return res.status(403).json({ error: 'Geen toegang tot deze groep' });

      const { data: threads } = await supabaseAdmin
        .from('group_persona_threads')
        .select('id, persona_id, closed_at, closed_by, topics, agreements')
        .eq('group_id', groupId)
        .not('closed_at', 'is', null)
        .order('closed_at', { ascending: false });
      if (!threads || threads.length === 0) return res.json({ conversations: [] });

      const personaIds = [...new Set(threads.map(t => t.persona_id))];
      const { data: personas } = await supabaseAdmin
        .from('project_personas').select('id, name, avatar_emoji, avatar').in('id', personaIds);
      const personaMap = Object.fromEntries((personas || []).map(p => [p.id, p]));

      // Per gesprek: wat het met de verstandhouding deed (stap + reden), uit
      // project_persona_relationships.history (source=persona_chat_close,
      // refId=thread_close:<threadId>). De groep ziet dit ook.
      let cueByThread = new Map();
      {
        const projectIdForRel = grpRow?.project_id || null;
        if (projectIdForRel) {
          const { data: rels } = await supabaseAdmin
            .from('project_persona_relationships')
            .select('persona_id, history')
            .eq('project_id', projectIdForRel)
            .eq('group_id', groupId)
            .in('persona_id', personaIds);
          for (const r of rels || []) {
            for (const ev of Array.isArray(r.history) ? r.history : []) {
              if (ev && ev.source === 'persona_chat_close' && typeof ev.refId === 'string'
                  && ev.refId.startsWith('thread_close:')) {
                const tid = ev.refId.slice('thread_close:'.length);
                cueByThread.set(tid, {
                  step: Number(ev.step ?? ev.delta) || 0,
                  reason: typeof ev.note === 'string' ? ev.note : '',
                  to: Number.isFinite(Number(ev.to)) ? Number(ev.to) : null,
                });
              }
            }
          }
        }
      }

      const conversations = threads.map(t => {
        const p = personaMap[t.persona_id] || {};
        const out = {
          threadId: t.id,
          personaId: t.persona_id,
          personaName: p.name || 'Gesprek',
          avatarEmoji: p.avatar_emoji || '💬',
          avatar: p.avatar ?? null,
          closedAt: t.closed_at,
          topics: t.topics || [],
          agreements: t.agreements || [],
        };
        if (cueByThread.has(t.id)) {
          out.reputation = cueByThread.get(t.id);
        }
        return out;
      });
      return res.json({ conversations });
    } catch (err) {
      console.error('[conversation-log]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/groups/:groupId/checkpoint-preview — genereer AI-samenvattingen
  // per persona-thread ter preview vóór opslaan. Geen DB-schrijven.
  // Response: { threads: [{ threadId, personaId, personaName, avatarEmoji, studentSummary, personaSummary }], synthesis? }
  app.post('/api/projects/groups/:groupId/checkpoint-preview', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { groupId } = req.params;
    const lang = req.body?.lang || 'nl';
    const enMode = lang !== 'nl';

    try {
      if (!(await isGroupMember(groupId, auth.user.id))) {
        return res.status(403).json({ error: 'Geen toegang tot deze groep' });
      }
      const apiKey = process.env.OPENAI_API_KEY;
      if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });

      // Gebruik berichten ná de laatste checkpoint.
      const { data: prevCps } = await supabaseAdmin
        .from('group_checkpoints')
        .select('created_at')
        .eq('group_id', groupId)
        .order('created_at', { ascending: false })
        .limit(1);
      const sinceTs = prevCps && prevCps[0] ? prevCps[0].created_at : '1970-01-01T00:00:00Z';

      const { data: threads } = await supabaseAdmin
        .from('group_persona_threads').select('id, persona_id').eq('group_id', groupId);

      const result = [];
      for (const t of (threads || [])) {
        const { data: newMsgs } = await supabaseAdmin
          .from('group_persona_messages')
          .select('role, content')
          .eq('thread_id', t.id)
          .gt('created_at', sinceTs)
          .order('created_at', { ascending: true });
        if (!newMsgs || newMsgs.length === 0) continue;

        const { data: persona } = await supabaseAdmin
          .from('project_personas').select('name, avatar_emoji').eq('id', t.persona_id).maybeSingle();
        const personaName = persona?.name || 'Gesprek';
        const avatarEmoji = persona?.avatar_emoji || '💬';

        const userText = newMsgs.filter(m => m.role === 'user').map(m => (m.content || '').slice(0, 2000)).join('\n\n').slice(0, 8000);
        const asstText = newMsgs.filter(m => m.role === 'assistant').map(m => (m.content || '').slice(0, 2000)).join('\n\n').slice(0, 12000);

        let studentSummary = '';
        let personaSummary = '';
        try {
          if (userText.trim()) {
            const r1 = await openaiChatCompletion({
              model: OPENAI_MODEL,
              messages: [{ role: 'user', content: (enMode
                ? `Below are the messages a student sent in a conversation with "${personaName}". Write a factual summary in at most 4 sentences. Describe what the student asked and contributed. Write in the third person ("the student"). No greeting, no closing.\n\nMessages:\n${userText}`
                : `Hieronder staan de berichten die een student stuurde in een gesprek met "${personaName}". Schrijf een feitelijke samenvatting in maximaal 4 zinnen. Beschrijf wat de student vroeg en inbracht. Schrijf in de derde persoon ("de student"). Geen aanhef, geen afsluitende groet.\n\nBerichten:\n${userText}`) + buildLanguageInstruction(lang) }],
              ...chatModelParams({ temperature: 0.3, maxTokens: 300 }),
            });
            if (r1.ok) studentSummary = ((await r1.json()).choices?.[0]?.message?.content || '').trim();
          }
          if (asstText.trim()) {
            const r2 = await openaiChatCompletion({
              model: OPENAI_MODEL,
              messages: [{ role: 'user', content: (enMode
                ? `Below are the responses of "${personaName}" in a conversation with a student. Write a summary in at most 8 sentences. Describe the key points ${personaName} raised. Write in the third person. No greeting, no closing.\n\nResponses:\n${asstText}`
                : `Hieronder staan de reacties van "${personaName}" in een gesprek met een student. Schrijf een samenvatting in maximaal 8 zinnen. Beschrijf de kernpunten die ${personaName} aanhaalde. Schrijf in derde persoon. Geen aanhef, geen afsluitende groet.\n\nReacties:\n${asstText}`) + buildLanguageInstruction(lang) }],
              ...chatModelParams({ temperature: 0.3, maxTokens: 600 }),
            });
            if (r2.ok) personaSummary = ((await r2.json()).choices?.[0]?.message?.content || '').trim();
          }
        } catch (e) {
          console.error('[checkpoint-preview] OpenAI fout:', e.message);
        }
        if (!studentSummary) {
          const first = newMsgs.find(m => m.role === 'user');
          studentSummary = (first?.content || '').slice(0, 400);
        }
        if (!personaSummary) {
          const first = newMsgs.find(m => m.role === 'assistant');
          personaSummary = (first?.content || '').slice(0, 600);
        }
        result.push({ threadId: t.id, personaId: t.persona_id, personaName, avatarEmoji, studentSummary, personaSummary });
      }

      // Cross-agent synthese (alleen als ≥ 2 afgesloten gesprekken).
      let synthesis = null;
      try {
        synthesis = await generateCrossAgentSynthesis(groupId, apiKey, lang);
      } catch (e) {
        console.error('[checkpoint-preview] synthese fout:', e.message);
      }

      return res.json({ threads: result, synthesis });
    } catch (err) {
      console.error('[checkpoint-preview]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/groups/:groupId/checkpoint — sla een checkpoint op.
  // kind = 'checkpoint' (tussentijds) of 'final' (afronden).
  // Bij 'checkpoint': AI vat reflectie samen → één journal-entry per lid.
  // Bij 'final': AI scoort tegen rubric → uitgebreide journal-entry per lid.
  app.post('/api/projects/groups/:groupId/checkpoint', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { groupId } = req.params;
    const { kind = 'checkpoint', reflection, requestId, personaSummaries, lang = 'nl' } = req.body || {};
    const enMode = lang !== 'nl';
    if (!['checkpoint', 'final'].includes(kind)) {
      return res.status(400).json({ error: "kind moet 'checkpoint' of 'final' zijn" });
    }
    // Bij kind='checkpoint' met AI-preview-samenvattingen is een handmatige reflectie niet vereist.
    const hasPersonaSummaries = kind === 'checkpoint' && Array.isArray(personaSummaries) && personaSummaries.length > 0;
    if (!hasPersonaSummaries) {
      if (!reflection || typeof reflection !== 'string' || reflection.trim().length < 20) {
        return res.status(400).json({ error: 'Reflectie van minimaal 20 tekens vereist' });
      }
    }

    try {
      if (!(await isGroupMember(groupId, auth.user.id))) {
        return res.status(403).json({ error: 'Geen toegang tot deze groep' });
      }

      const { data: group } = await supabaseAdmin
        .from('project_groups').select('id, project_id, status, name').eq('id', groupId).maybeSingle();
      if (!group) return res.status(404).json({ error: 'Groep niet gevonden' });
      if (group.status === 'finalized' && kind === 'final') {
        return res.status(400).json({ error: 'Deze groep is al afgesloten' });
      }

      // Idempotentie: als de client een requestId meestuurt en er bestaat al een
      // checkpoint met diezelfde request_id binnen deze groep, geef dat terug
      // i.p.v. opnieuw te schrijven (voorkomt dubbele journal-entries bij retry
      // of dubbele submit). Stille degradatie als de kolom (nog) ontbreekt.
      if (requestId) {
        try {
          const { data: dup } = await supabaseAdmin
            .from('group_checkpoints')
            .select('*').eq('group_id', groupId).eq('request_id', requestId).maybeSingle();
          if (dup) return res.json({ checkpoint: dup, deduped: true });
        } catch { /* request_id-kolom nog niet aanwezig — negeren */ }
      }

      const { data: project } = await supabaseAdmin
        .from('projects').select('id, title, briefing_markdown, rubric_criteria, research_question')
        .eq('id', group.project_id).maybeSingle();
      const checkpointCourseId = await courseIdForProject(group.project_id);

      const apiKey = process.env.OPENAI_API_KEY;
      if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });

      const rubric = Array.isArray(project?.rubric_criteria) ? project.rubric_criteria : [];
      const rubricText = rubric.length > 0
        ? rubric.map((r, i) => typeof r === 'string' ? `${i + 1}. ${r}` : `${i + 1}. ${r.title || r.name || JSON.stringify(r)}`).join('\n')
        : '(geen rubriek beschikbaar)';

      let aiSummary = '';
      let rubricFeedback = null;
      let checkpointFields = null;

      if (kind === 'final') {
        const prompt = (enMode
          ? `You are a "critical friend" for a group of VU students. The group has completed a research project and submits a joint final reflection below. Assess the work per rubric criterion — honestly, formatively and concretely. Address the group as "you" (plural).

Project: ${project?.title || '(unnamed)'}
Intended project deliverable: ${project?.research_question || '(none)'}

Rubric:
${rubricText}

Group's final reflection:
${reflection}

Return ONLY valid JSON with this structure:
{
  "samenvatting": "<2-4 sentences overall assessment, second person>",
  "per_criterium": [{"criterium": "<name>", "oordeel": "<strong/sufficient/needs attention>", "feedback": "<2-3 sentences>"}],
  "vervolgstappen": "<1-3 concrete suggestions>"
}

No text outside the JSON.`
          : (`Je bent een "critical friend" voor een groep VU-studenten. De groep heeft een onderzoeksproject afgerond en geeft hieronder een gezamenlijke eindreflectie. Beoordeel het werk per rubriekspunt — eerlijk, formatief en concreet. Spreek de groep aan met "jullie".

Project: ${project?.title || '(naamloos)'}
Beoogd projectresultaat: ${project?.research_question || '(geen)'}

Rubriek:
${rubricText}

Eindreflectie van de groep:
${reflection}

Geef je antwoord ALLEEN als geldige JSON met deze structuur:
{
  "samenvatting": "<2-4 zinnen overall oordeel, in tweede persoon>",
  "per_criterium": [{"criterium": "<naam>", "oordeel": "<sterk/voldoende/aandacht>", "feedback": "<2-3 zinnen>"}],
  "vervolgstappen": "<1-3 concrete suggesties>"
}

Geen tekst buiten de JSON.`)) + buildLanguageInstruction(lang, { json: true });
        const chatResp = await openaiChatCompletion({
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content: prompt }],
          ...chatModelParams({ temperature: 0.4, maxTokens: 1500 }),
          response_format: { type: 'json_object' },
        });
        if (!chatResp.ok) {
          const txt = await chatResp.text();
          return res.status(502).json({ error: 'Taalmodel-fout', detail: txt.slice(0, 500) });
        }
        const data = await chatResp.json();
        const raw = data.choices?.[0]?.message?.content || '{}';
        try {
          rubricFeedback = JSON.parse(raw);
          aiSummary = rubricFeedback.samenvatting || '';
        } catch {
          aiSummary = raw;
        }
      } else if (!hasPersonaSummaries) {
        // Geen AI-preview-samenvattingen: vat de handmatige reflectietekst samen.
        const prompt = (enMode
          ? `You are a "critical friend" for a group of VU students. Below, a group writes a mid-project reflection. In 6-10 lines, addressed to the group ("you"), write a formative report: what stands out about their approach, where is there still doubt or a gap, and what concrete next step is most obvious. No greeting, no closing.

Project: ${project?.title || '(unnamed)'}
Reflection:
${reflection}`
          : `Je bent een "critical friend" voor een groep VU-studenten. Hieronder schrijft een groep een tussentijdse reflectie op hun project. Schrijf in 6-10 regels, in het Nederlands, gericht aan de groep ("jullie"), een formatief verslag: wat valt op aan jullie aanpak, waar zit nog twijfel of een gat, en welke concrete vervolgstap ligt voor de hand. Geen aanhef, geen afsluitende groet.

Project: ${project?.title || '(naamloos)'}
Reflectie:
${reflection}`) + journalFormatInstruction(enMode ? 'en' : 'nl') + buildLanguageInstruction(lang);
        const chatResp = await openaiChatCompletion({
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content: prompt }],
          ...chatModelParams({ temperature: 0.5, maxTokens: 900 }),
        });
        if (!chatResp.ok) {
          const txt = await chatResp.text();
          return res.status(502).json({ error: 'Taalmodel-fout', detail: txt.slice(0, 500) });
        }
        const data = await chatResp.json();
        // In blokken voor het leerdagboek; ai_summary krijgt de leesbare versie.
        checkpointFields = journalFieldsFromModel(data.choices?.[0]?.message?.content || '', lang);
        aiSummary = checkpointFields.content;
      }
      // hasPersonaSummaries: aiSummary blijft leeg — journalinhoud zit in personaSummaries.

      // Bouw reflectietekst op: bij AI-preview is de reflectie de samenvattingen zelf.
      const storedReflection = hasPersonaSummaries
        ? (personaSummaries || []).map(s =>
            `${s.avatarEmoji || '💬'} ${s.personaName || 'Gesprek'}\nStudent: ${s.studentSummary || ''}\nPersona: ${s.personaSummary || ''}`
          ).join('\n\n')
        : (reflection || '');

      const insertRow = {
        group_id: groupId,
        kind,
        reflection: storedReflection,
        ai_summary: aiSummary,
        rubric_feedback: rubricFeedback,
        created_by: auth.user.id,
        request_id: requestId || null,
      };
      let cp;
      let cpErr;
      {
        const r = await supabaseAdmin.from('group_checkpoints').insert(insertRow).select('*').single();
        cp = r.data; cpErr = r.error;
      }
      // Defensief: kolom request_id bestaat pas vanaf migratie 20260508140000.
      if (cpErr && /request_id/i.test(cpErr.message || '')) {
        const { request_id, ...rest } = insertRow;
        const r = await supabaseAdmin.from('group_checkpoints').insert(rest).select('*').single();
        cp = r.data; cpErr = r.error;
      }
      // Race-conditie: gelijktijdige retry met dezelfde request_id leverde 23505
      // op — lees de winnaar terug en geef die.
      if (cpErr && (cpErr.code === '23505' || /duplicate key/i.test(cpErr.message || ''))) {
        const { data: dup } = await supabaseAdmin
          .from('group_checkpoints')
          .select('*').eq('group_id', groupId).eq('request_id', requestId).maybeSingle();
        if (dup) return res.json({ checkpoint: dup, deduped: true });
      }
      if (cpErr) return res.status(500).json({ error: cpErr.message });

      // Dagboekteksten bij de groep (2026-10-27). Er gaat NIETS meer automatisch
      // naar de leerdagboeken van alle groepsleden: de teksten staan bij deze
      // tussenstand (journal_items, ook leesbaar in de projectruimte) en elk
      // groepslid bewaart zelf wat het wil ("Bewaar in mijn leerdagboek",
      // POST /api/projects/groups/:groupId/journal-save).
      const projectTitle = project?.title || '(naamloos project)';
      const titleLabel = kind === 'final' ? `Eindreflectie: ${projectTitle}` : `Projectreflectie: ${projectTitle}`;
      // Dezelfde drie blokken als chat, Ik leg uit en quiz (server/projectJournal.js).
      const entryFields = (kind === 'final' && rubricFeedback)
        ? journalFromRubricFeedback(rubricFeedback, { lang, groupReflection: reflection })
        : (checkpointFields || { content: aiSummary || reflection || '', sections: null });
      const journalItems = [];
      if (entryFields.content || entryFields.sections) {
        journalItems.push({ key: 'main', title: titleLabel, content: entryFields.content, sections: entryFields.sections || null });
      }

      // Overzicht over alle gesprekken (alleen bij een tussentijdse stand).
      let synthesisAdded = false;
      if (kind === 'checkpoint') {
        try {
          const synthesis = await generateCrossAgentSynthesis(groupId, apiKey, lang);
          if (synthesis) {
            const synthEnMode = (synthesis.lang || lang) !== 'nl';
            const synthFields = journalFromSynthesis(synthesis, { lang: synthesis.lang || lang });
            if (synthFields.sections) {
              journalItems.push({
                key: 'synthesis',
                title: synthEnMode ? `🔗 Overview across all conversations: ${projectTitle}` : `🔗 Overzicht over alle gesprekken: ${projectTitle}`,
                content: synthFields.content,
                sections: synthFields.sections,
              });
              synthesisAdded = true;
            }
          }
        } catch (e) {
          console.error('[checkpoint] synthese fout:', e.message);
        }
      }

      // Samenvatting per persona-gesprek:
      // Pad A: personaSummaries meegestuurd (AI-preview-flow) → gebruik die direct.
      // Pad B: geen personaSummaries (handmatige reflectie-flow) → genereer een samenvatting.
      let threadSummariesAdded = 0;
      try {
        if (hasPersonaSummaries) {
          // Alleen gesprekken van deze groep: een payload kan geen willekeurige threadId injecteren.
          const { data: validThreadRows } = await supabaseAdmin
            .from('group_persona_threads').select('id').eq('group_id', groupId);
          const validThreadIds = new Set((validThreadRows || []).map(r => r.id));
          for (const s of personaSummaries) {
            if (!s.threadId || !validThreadIds.has(s.threadId)) continue;
            const tFields = journalFromPersonaSummary(s, { lang });
            if (!tFields.content.trim()) continue;
            journalItems.push({
              key: `thread:${s.threadId}`,
              title: `${s.avatarEmoji || '💬'} ${s.personaName || 'Gesprek'}`,
              content: tFields.content,
              sections: tFields.sections || null,
            });
            threadSummariesAdded += 1;
          }
        } else {
          const { data: prevCps } = await supabaseAdmin
            .from('group_checkpoints')
            .select('created_at')
            .eq('group_id', groupId)
            .lt('created_at', cp.created_at)
            .order('created_at', { ascending: false })
            .limit(1);
          const sinceTs = prevCps && prevCps[0] ? prevCps[0].created_at : '1970-01-01T00:00:00Z';
          const { data: threads } = await supabaseAdmin
            .from('group_persona_threads').select('id, persona_id').eq('group_id', groupId);
          for (const t of (threads || [])) {
            const { data: newMsgs } = await supabaseAdmin
              .from('group_persona_messages')
              .select('role, content')
              .eq('thread_id', t.id)
              .gt('created_at', sinceTs)
              .order('created_at', { ascending: true });
            if (!newMsgs || newMsgs.length === 0) continue;
            const { data: persona } = await supabaseAdmin
              .from('project_personas').select('name, avatar_emoji').eq('id', t.persona_id).maybeSingle();
            const personaName = persona?.name || 'Gesprek';
            const transcript = newMsgs.map(m =>
              `${m.role === 'user' ? 'Student' : personaName}: ${(m.content || '').slice(0, 1500)}`
            ).join('\n\n').slice(0, 12000);
            let summaryText = '';
            if (AZURE_CHAT_READY) {
              try {
                const sumPrompt = (lang !== 'nl'
                  ? `Summarise the following conversation with "${personaName}" for the student's learning journal. Address the student as "you". Cover the core question, the key insight, what is still open or misunderstood, and the next step. Base everything on the conversation only.\n\nConversation:\n${transcript}`
                  : `Vat het volgende gesprek met "${personaName}" samen voor het leerdagboek van de student. Spreek de student aan met "je"/"jij". Behandel de kernvraag, het belangrijkste inzicht, wat nog open is of misverstaan werd, en de vervolgstap. Baseer alles alleen op het gesprek.\n\nGesprek:\n${transcript}`) + journalFormatInstruction(lang !== 'nl' ? 'en' : 'nl') + buildLanguageInstruction(lang);
                const sr = await openaiChatCompletion({
                  model: OPENAI_MODEL,
                  messages: [{ role: 'user', content: sumPrompt }],
                  ...chatModelParams({ temperature: 0.3, maxTokens: 600 }),
                });
                if (sr.ok) summaryText = ((await sr.json()).choices?.[0]?.message?.content || '').trim();
              } catch { /* val terug */ }
            }
            if (!summaryText) {
              const firstUser = newMsgs.find(m => m.role === 'user');
              summaryText = (firstUser?.content || '(geen samenvatting beschikbaar)').slice(0, 400);
            }
            const sumFields = journalFieldsFromModel(summaryText, lang);
            journalItems.push({
              key: `thread:${t.id}`,
              title: `${persona?.avatar_emoji || '💬'} ${personaName}`,
              content: sumFields.content,
              sections: sumFields.sections || null,
            });
            threadSummariesAdded += 1;
          }
        }
      } catch (e) {
        console.error('[checkpoint thread summaries]', e.message);
      }

      if (journalItems.length > 0) {
        const { error: jiErr } = await supabaseAdmin.from('group_checkpoints')
          .update({ journal_items: journalItems }).eq('id', cp.id);
        if (jiErr) console.warn('[checkpoint] journal_items niet opgeslagen:', jiErr.message);
        else cp.journal_items = journalItems;
      }

      // BEWUST GEEN DELETE/TRUNCATE op group_persona_messages of group_chat_messages.
      // Een tussentijds checkpoint (kind='checkpoint') mag NOOIT gesprekken wissen.
      // Berichten blijven altijd bewaard zodat studenten dagen later kunnen doorgaan.
      // Alleen kind='final' sluit de groep (status → finalized) — gesprekken blijven leesbaar.
      if (kind === 'final') {
        await supabaseAdmin.from('project_groups')
          .update({ status: 'finalized', finalized_at: new Date().toISOString() })
          .eq('id', groupId);
      }

      return res.json({ checkpoint: cp, threadSummariesAdded, synthesisAdded });
    } catch (err) {
      console.error('[projects/groups/checkpoint]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/groups/:groupId/journal-save — "Bewaar in mijn leerdagboek"
  // (2026-10-27, server/projectJournalSave.js). Body: { source: 'checkpoint' |
  // 'assessment' | 'review', id, note?, lang }. Schrijft ALLEEN in het dagboek van
  // wie klikt; twee keer bewaren geeft geen dubbele regel. Bij een tussenstand of
  // de eindreflectie mag de student er een eigen reflectie (note) bij zetten.
  app.post('/api/projects/groups/:groupId/journal-save', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { groupId } = req.params;
    const { source, id, note, lang = 'nl' } = req.body || {};
    if (!SAVE_SOURCES.includes(source) || !id) return res.status(400).json({ error: 'Onbekend onderdeel om te bewaren' });
    try {
      if (!(await isGroupMember(groupId, auth.user.id))) return res.status(403).json({ error: 'Geen toegang tot deze groep' });
      const { data: group } = await supabaseAdmin.from('project_groups').select('id, project_id').eq('id', groupId).maybeSingle();
      if (!group) return res.status(404).json({ error: 'Groep niet gevonden' });
      const courseId = await courseIdForProject(group.project_id);
      if (!(await courseFeatureOnFor(auth.user, null, courseId, 'journal'))) {
        return res.status(403).json({ error: 'Het leerdagboek staat uit in deze cursus', code: 'journalOff' });
      }
      const { data: project } = await supabaseAdmin.from('projects').select('title').eq('id', group.project_id).maybeSingle();
      const projectTitle = project?.title || '';

      // Onderdelen met hun source_ref (de eerste ref wordt geschreven; de rest is "al bewaard").
      const parts = [];
      if (source === 'checkpoint') {
        const { data: cp } = await supabaseAdmin.from('group_checkpoints').select('*').eq('id', id).eq('group_id', groupId).maybeSingle();
        if (!cp) return res.status(404).json({ error: 'Tussenstand niet gevonden' });
        for (const item of checkpointItems(cp, { lang, projectTitle })) {
          parts.push({ refs: checkpointItemRefs(cp, item), entry: { title: item.title, content: item.content, sections: item.sections || null } });
        }
        const own = noteEntry(note, { lang, projectTitle });
        if (own) parts.push({ refs: [`group_checkpoint:${cp.id}:note`], entry: own });
      } else if (source === 'assessment') {
        const { data: a } = await supabaseAdmin.from('project_group_assessments').select('*').eq('id', id).eq('group_id', groupId).maybeSingle();
        if (!a) return res.status(404).json({ error: 'Beoordeling niet gevonden' });
        parts.push({
          refs: assessmentRefs(a),
          entry: { title: `${a.persona_emoji || '🎓'} ${lang === 'nl' ? 'Beoordeling' : 'Assessment'} — ${a.persona_name || ''}`, ...journalFieldsFromModel(a.content || '', lang) },
        });
      } else {
        const { data: r } = await supabaseAdmin.from('project_document_reviews').select('*').eq('id', id).eq('group_id', groupId).maybeSingle();
        if (!r) return res.status(404).json({ error: 'Feedback niet gevonden' });
        const { data: myBadge } = await supabaseAdmin.from('project_review_badges').select('id')
          .eq('review_id', r.id).eq('user_id', auth.user.id).maybeSingle();
        parts.push({ refs: reviewRefs(r), entry: reviewEntry(r, { hasBadge: !!myBadge }) });
      }
      if (!parts.length) return res.status(404).json({ error: 'Er is niets om te bewaren' });

      const allRefs = parts.flatMap(p => p.refs);
      const { data: existing } = await supabaseAdmin.from('learning_journal_entries').select('source_ref')
        .eq('user_id', auth.user.id).in('source_ref', allRefs);
      const have = new Set((existing || []).map(e => e.source_ref));
      let saved = 0;
      let already = 0;
      for (const p of parts) {
        if (isSaved(p.refs, have)) { already += 1; continue; }
        const { error: jErr } = await supabaseAdmin.from('learning_journal_entries').insert({
          user_id: auth.user.id,
          title: p.entry.title,
          content: p.entry.content,
          sections: p.entry.sections,
          activity_type: 'project_reflection',
          source_ref: p.refs[0],
          course_id: courseId,
        });
        if (!jErr) saved += 1;
        else if (jErr.code === '23505') already += 1;
        else return res.status(500).json({ error: jErr.message });
      }
      return res.json({ saved, already });
    } catch (err) {
      console.error('[projects/journal-save]', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // =============================================================================
  // Beoordeling opvragen — voor elke evaluator-persona van het project: rubric
  // + alle persona-gesprekken van de groep + projectdocumenten naar OpenAI, en
  // schrijf één journal-entry per groepslid per evaluator. Alleen leden of staff.
  // =============================================================================

  app.post('/api/projects/groups/:groupId/evaluate', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const auth = await authUser(req);
    if (auth.error) return res.status(auth.error.status).json(auth.error.body);
    const { groupId } = req.params;
    const requestId = req.body?.requestId || null;
    const lang = req.body?.lang || 'nl';
    const enMode = lang !== 'nl';
    try {
      const { data: group } = await supabaseAdmin
        .from('project_groups').select('id, project_id, name').eq('id', groupId).maybeSingle();
      if (!group) return res.status(404).json({ error: 'Groep niet gevonden' });
      const { data: profile } = await profileCache.get(auth.user.id, loadProfileRoleEmail);
      const isMember = await isGroupMember(groupId, auth.user.id);
      if (!isMember) {
        // Niet-leden moeten staff zijn ÉN aan dit specifieke project gekoppeld.
        // Dit voorkomt dat een docent uit een andere cursus een willekeurige
        // groep kan beoordelen.
        const access = await requireProjectStaff(group.project_id, auth.user, profile);
        if (!access.ok) return res.status(access.status).json({ error: access.error || 'Geen toegang tot deze groep' });
      }
      const { data: project } = await supabaseAdmin
        .from('projects').select('id, title, research_question, goals, briefing_markdown, preassessment_persona_id')
        .eq('id', group.project_id).maybeSingle();

      // De voorbeoordelaar van het eindproduct doet hier niet aan mee: zijn
      // verborgen rubric is voor de docent.
      const { data: evaluators } = await supabaseAdmin
        .from('project_personas').select('*')
        .eq('project_id', group.project_id).eq('persona_type', 'evaluator')
        .neq('id', project?.preassessment_persona_id || '00000000-0000-0000-0000-000000000000');
      if (!evaluators || evaluators.length === 0) {
        return res.status(400).json({ error: 'Dit project heeft geen beoordelaar-persona' });
      }

      // Alle persona-gesprekken van de groep verzamelen.
      const { data: threads } = await supabaseAdmin
        .from('group_persona_threads').select('id, persona_id').eq('group_id', groupId);
      let conversationsBlock = '';
      for (const t of (threads || [])) {
        const { data: persona } = await supabaseAdmin
          .from('project_personas').select('name, persona_type')
          .eq('id', t.persona_id).maybeSingle();
        if (!persona || persona.persona_type === 'evaluator') continue;
        const { data: msgs } = await supabaseAdmin
          .from('group_persona_messages').select('role, content')
          .eq('thread_id', t.id).order('created_at', { ascending: true });
        if (!msgs || msgs.length === 0) continue;
        const transcript = msgs.map(m =>
          `${m.role === 'user' ? 'Student' : persona.name}: ${(m.content || '').slice(0, 1500)}`
        ).join('\n');
        conversationsBlock += `\n\n## Gesprek met ${persona.name}\n${transcript}`;
      }
      conversationsBlock = conversationsBlock.slice(0, 30000);

      // Projectmateriaal: alleen wat elke beoordelaar kent (rubricBlock hieronder, personaKnowledge.js).

      // Het rapport staat bij de groep (projectruimte). In het leerdagboek komt het
      // alleen als een groepslid het zelf bewaart (journal-save, 2026-10-27).

      const apiKey = process.env.OPENAI_API_KEY;
      if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });

      const results = [];
      for (const evalPersona of evaluators) {
        // Idempotency: als deze (groep, persona, requestId)-combinatie al een
        // beoordeling (of oudere journal-entry) heeft, sla de OpenAI-call over —
        // bespaart tokens en tijd bij netwerk-retries van dezelfde knopdruk.
        if (requestId) {
          const sourceRefCandidate = `group_evaluate:${groupId}:${evalPersona.id}:${requestId}`;
          const [{ data: existingAssessment }, { data: existingEntry }] = await Promise.all([
            supabaseAdmin.from('project_group_assessments').select('id')
              .eq('group_id', groupId).eq('persona_id', evalPersona.id).eq('request_id', requestId).limit(1),
            supabaseAdmin.from('learning_journal_entries')
              .select('id').eq('source_ref', sourceRefCandidate).limit(1),
          ]);
          if (existingAssessment?.length || existingEntry?.length) {
            results.push({ persona: evalPersona.name, ok: true, alreadyExisted: true });
            continue;
          }
        }
        // Belangrijk: alleen documenten van de docent die deze beoordelaar kent
        // (personaKnowledge.js) — anders zouden door studenten geüploade
        // documenten de beoordeling kunnen sturen (prompt-injection).
        const rubricBlock = await loadEvaluatorMaterial(supabaseAdmin, evalPersona);

        const langInstruction = lang === 'nl'
          ? 'BELANGRIJK: Antwoord volledig in het Nederlands.'
          : `IMPORTANT: Respond entirely in ${languageEnglishName(lang)}.`;
        const defaultPersonaPrompt = enMode
          ? 'You are a formative assessor for a group of VU students.'
          : 'Je bent een formatieve beoordelaar voor een groep VU-studenten.';
        const prompt = `${evalPersona.system_prompt || defaultPersonaPrompt}

${langInstruction}

${enMode
  ? `Below you will find the learning objectives, your assessment material (for your eyes only — students cannot see this), and all conversations the group has had with the other personas. Provide a formative assessment per learning objective/criterion. Address the students as "you" (plural).

Project: ${project?.title || '(unnamed)'}
Intended project deliverable: ${project?.research_question || '(none)'}
Learning objectives: ${project?.goals || '(none)'}

Your assessment material (rubric and documents you know):
${rubricBlock || '(no material linked; use the learning objectives above)'}

Group conversations:
${conversationsBlock || '(no conversations found)'}

Write your assessment as markdown with per criterion:
- **<criterion name>** (strong / sufficient / needs attention): 2–3 sentences of feedback with a concrete example from the conversations.

End with a short heading "Next steps" with 2-3 suggestions. Do NOT quote exact rubric text and do not spoil the criteria.`
  : `Je krijgt hieronder de leerdoelen, je beoordelingsmateriaal (alléén voor jou — de studenten zien dit niet), en alle gesprekken die de groep met de andere persona's heeft gevoerd. Geef een formatieve beoordeling per leerdoel/criterium. Spreek de studenten aan met "jullie".

Project: ${project?.title || '(naamloos)'}
Beoogd projectresultaat: ${project?.research_question || '(geen)'}
Leerdoelen: ${project?.goals || '(geen)'}

Je beoordelingsmateriaal (rubric en documenten die je kent):
${rubricBlock || '(geen materiaal gekoppeld; gebruik dan de leerdoelen hierboven)'}

Gesprekken van de groep:
${conversationsBlock || '(geen gesprekken gevonden)'}

Schrijf je beoordeling als markdown met per criterium:
- **<naam criterium>** (sterk / voldoende / aandacht nodig): 2–3 zinnen feedback met concreet voorbeeld uit de gesprekken.

Sluit af met een kort kopje "Vervolgstappen" met 2-3 suggesties. Noem GEEN exacte rubric-tekst letterlijk en spoiler de criteria niet.`}`;

        const gr = await openaiChatCompletion({
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content: prompt }],
          ...chatModelParams({ temperature: 0.4, maxTokens: 1800 }),
        });
        if (!gr.ok) {
          const txt = await gr.text();
          results.push({ persona: evalPersona.name, ok: false, error: `Taalmodel-fout (${gr.status}): ${txt.slice(0, 200)}` });
          continue;
        }
        const gd = await gr.json();
        const feedback = (gd.choices?.[0]?.message?.content || '').trim();
        if (!feedback) {
          results.push({ persona: evalPersona.name, ok: false, error: 'Leeg antwoord' });
          continue;
        }

        // Bij de groep (projectruimte). Ontbrekende tabel (migratie nog niet
        // toegepast): alleen het dagboek, zoals voorheen.
        const { error: aErr } = await supabaseAdmin.from('project_group_assessments').insert({
          group_id: groupId,
          persona_id: evalPersona.id,
          persona_name: evalPersona.name || '',
          persona_emoji: evalPersona.avatar_emoji || null,
          request_id: requestId,
          content: feedback,
          requested_by: auth.user.id,
        });
        if (aErr && aErr.code === '23505') {
          results.push({ persona: evalPersona.name, ok: true, alreadyExisted: true });
          continue;
        }
        if (aErr) {
          console.warn('[projects/groups/evaluate] beoordeling bij groep niet opgeslagen:', aErr.message);
          results.push({ persona: evalPersona.name, ok: false, error: aErr.message });
          continue;
        }
        results.push({ persona: evalPersona.name, ok: true, length: feedback.length });
      }

      return res.json({ ok: true, results });
    } catch (err) {
      console.error('[projects/groups/evaluate]', err);
      return res.status(500).json({ error: err.message });
    }
  });
}
