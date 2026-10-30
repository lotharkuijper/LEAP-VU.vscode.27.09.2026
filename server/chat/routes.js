import { createClient } from '@supabase/supabase-js';
import {
  PLATFORM_KEY as ATTACHMENTS_PLATFORM_KEY,
  attachImagesToLastUser,
  attachmentSystemBlock,
  attachmentsAvailability,
  createDailyCounter,
  mergePlatformSettings,
  normalizePlatformSettings,
  parseChatAttachments,
  parsePlatformPatch,
  safeName,
  sniffFileKind,
} from './chatAttachments.js';
import { buildChatGoalBlock, chatGoalSummaryLine, lastChatGoal } from './chatGoal.js';
import { buildSourcesInstructionBlock } from './citationSources.js';
import { featureForChatRequest, mergeCourseFeatures, normalizeCourseFeatures } from '../courses/courseFeatures.js';
import { createCourseOverview } from '../courses/courseOverview.js';
import { anchorUnit, buildLeerlijnBlock, loadPracticedUnits } from '../courses/courseUnits.js';
import { resolveJournalCourseId } from '../journal/journalCourse.js';
import {
  journalFieldsFromModel,
  journalFormatInstruction,
  journalRedistributePrompt,
} from '../journal/journalSections.js';
import { buildLanguageInstruction } from '../i18n/languages.js';
import { LEVEL_DEFAULT, LEVEL_MAX, LEVEL_MIN, buildLevelInstructionBlock } from './learningLevel.js';
import {
  isLeapAdmin,
  isStaffForCourse,
  loadProfileRoleEmail,
  profileCache,
  requireAuthUser,
  userCache,
  userHasCourseAccess,
} from '../lib/auth.js';
import {
  AZURE_CHAT_READY,
  IS_REASONING_MODEL,
  LLM_NOT_CONFIGURED_MSG,
  MAX_TOKENS_PARAM,
  OPENAI_CHAT_URL,
  OPENAI_MODEL,
  REASONING_EFFORT,
  chatAuthHeaders,
  chatModelParams,
  openaiChatCompletion,
} from '../lib/azureOpenai.js';
import { cachedLeerlijn, courseMaterialDocuments, logSettingChange } from '../lib/courseData.js';
import {
  courseFeatureOnFor,
  courseFeaturesCache,
  loadCourseFeatures,
  rejectIfFeatureOff,
} from '../lib/courseFeatureGate.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabaseAdmin } from '../lib/supabase.js';
import { turnHmac } from '../lib/turnSigning.js';
import { parseOfficeAsync } from '../lib/uploads.js';
import { isEmptyOrTruncatedCompletion, isUnsupportedSamplingParamError } from '../lib/openaiSampling.js';
import { extractPdfPageTexts } from '../ingestion/pdfPageText.js';
import { buildDeckText, extractPptxStructured } from '../ingestion/pptxExtract.js';
import {
  FALLBACK_SYSTEM_PROMPT,
  QUIZ_PROMPT_DEFAULTS,
  chatPromptKey,
  promptsHasSection,
  resolveChatPromptMode,
} from '../prompts/promptStore.js';
import {
  buildReadinessInstruction,
  countVerifiedPriorStudentMessages,
  evaluateReadiness,
  extractReadiness,
  levelName,
  topicKey,
  turnSignature,
} from './readiness.js';

const RAG_STRICT_INSTRUCTION = `\n\nSTRIKTE BRONBEPERKING: Gebruik UITSLUITEND de context die hierboven is meegegeven uit het cursusmateriaal. Ga NIET buiten deze bronnen. Als iets niet in de meegeleverde context staat, zeg dan eerlijk: "Dit onderwerp staat niet in het beschikbare cursusmateriaal."`;

// Leerdagboek: het leerniveau dat de student op dit moment voor deze cursus
// heeft ingesteld. Geen cursus → null (geen niveau van toepassing); nog niets
// gekozen → het standaardniveau (dat is dan ook wat de uitleg gebruikte).
async function currentLearningLevel(userId, courseId) {
  if (!userId || !courseId || !supabaseAdmin) return null;
  try {
    const { data } = await supabaseAdmin.from('student_course_levels').select('level')
      .eq('user_id', userId).eq('course_id', courseId).maybeSingle();
    const n = Number(data?.level);
    return Number.isInteger(n) && n >= LEVEL_MIN && n <= LEVEL_MAX ? n : LEVEL_DEFAULT;
  } catch { return null; }
}

// ── "Klaar voor een hoger niveau?" → feestje + achievement (zie server/chat/readiness.js) ──
// Onderwerpen = goedgekeurde begrippen van de cursus (gegrond in het cursusmateriaal).
async function loadReadinessTopics(courseId) {
  if (!supabaseAdmin || !courseId) return [];
  const { data } = await supabaseAdmin.from('concepts').select('id, name')
    .eq('course_id', courseId).eq('review_status', 'approved').order('name').limit(200);
  return data || [];
}

// Legt een positief oordeel vast: achievement (uniek per onderwerp + niveau) en,
// op de achtergrond, een dagboekregel als bewijs. Geeft wat de app moet tonen.
async function recordReadinessOutcome({ user, courseId, lang, outcome, answerText }) {
  const result = {
    verdict: outcome.verdict, eligible: outcome.eligible, reason: outcome.reason,
    currentLevel: outcome.currentLevel, nextLevel: outcome.nextLevel,
    topic: outcome.concept?.name || null, achievement: null,
  };
  if (!outcome.eligible || !supabaseAdmin) return result;
  const row = {
    user_id: user.id, course_id: courseId, kind: 'level',
    concept_id: outcome.concept?.id || null, topic_label: outcome.concept?.name || null,
    topic_key: topicKey(outcome.concept), level: outcome.nextLevel,
    details: { from_level: outcome.currentLevel, source: 'chat_readiness' },
  };
  let isNew = true;
  let { data: saved, error } = await supabaseAdmin.from('student_achievements').insert(row).select('id, earned_at').single();
  if (error) {
    if (error.code !== '23505') { console.warn('[readiness] achievement opslaan mislukt:', error.message); return result; }
    isNew = false; // al eerder verdiend: het feestje mag, maar er komt geen tweede
    ({ data: saved } = await supabaseAdmin.from('student_achievements').select('id, earned_at')
      .eq('user_id', user.id).eq('course_id', courseId).eq('kind', 'level')
      .eq('topic_key', row.topic_key).eq('level', row.level).maybeSingle());
  }
  if (saved) result.achievement = { id: saved.id, isNew, earnedAt: saved.earned_at };
  // Dagboek uit in deze cursus: de prestatie telt wel, maar zonder dagboekregel.
  if (saved && isNew && (await courseFeatureOnFor(user, null, courseId, 'journal'))) {
    void createReadinessJournalEntry({ user, courseId, lang, outcome, answerText, achievementId: saved.id });
  }
  return result;
}

async function createReadinessJournalEntry({ user, courseId, lang, outcome, answerText, achievementId }) {
  try {
    const title = `🏆 ${lang === 'nl' ? 'Klaar voor' : 'Ready for'} ${levelName(outcome.nextLevel, lang)}${outcome.concept ? `: ${outcome.concept.name}` : ''}`;
    let fields = { content: answerText, sections: null };
    if (AZURE_CHAT_READY) {
      const r = await openaiChatCompletion({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: journalRedistributePrompt(title, answerText) }],
        ...chatModelParams({ temperature: 0.2, maxTokens: 900 }),
      });
      if (r.ok) {
        const txt = (await r.json())?.choices?.[0]?.message?.content;
        const parsed = txt ? journalFieldsFromModel(txt, lang) : null;
        if (parsed?.sections) fields = parsed;
      }
    }
    const { data: entry, error } = await supabaseAdmin.from('learning_journal_entries').insert({
      user_id: user.id, title, ...fields, activity_type: 'chat_reflection',
      course_id: courseId, learning_level: outcome.currentLevel,
    }).select('id').single();
    if (error) throw error;
    await supabaseAdmin.from('student_achievements').update({ evidence_journal_id: entry.id }).eq('id', achievementId);
  } catch (e) {
    console.warn('[readiness] dagboekregel voor achievement mislukt:', e?.message || e);
  }
}

// Chatreflectie in het leerdagboek (2026-10-27). Ook TUSSENTIJDS: het gesprek
// blijft dan staan en de student gaat later verder waar hij was. Elke reflectie
// gaat over wat sinds de vorige opslag van dit gesprek is gezegd (source_ref
// chat:<gesprek>:<laatste bericht>); het eerdere deel gaat alleen als context
// mee. Niets nieuws → 'nothingNew', geen tweede regel. Verwijderen met
// samenvatting gebruikt dezelfde functie.
async function createChatReflection({ user, conversation, courseId, lang }) {
  if (!(await courseFeatureOnFor(user, null, courseId, 'journal'))) return { status: 'journalOff' };
  const { data: msgRows, error: msgError } = await supabaseAdmin
    .from('messages')
    .select('id, role, content, retrieved_context, created_at')
    .eq('conversation_id', conversation.id)
    .order('created_at', { ascending: true });
  const msgs = (msgError ? [] : (msgRows || [])).filter(m => m.role !== 'system');
  const { data: prevEntries } = await supabaseAdmin
    .from('learning_journal_entries')
    .select('source_ref, created_at')
    .eq('user_id', user.id)
    .like('source_ref', `chat:${conversation.id}:%`)
    .order('created_at', { ascending: false });
  const saved = prevEntries || [];
  const lastSavedId = saved[0]?.source_ref?.split(':')[2] || null;
  const cut = lastSavedId ? msgs.findIndex(m => m.id === lastSavedId) : -1;
  const earlier = cut >= 0 ? msgs.slice(0, cut + 1) : [];
  const fresh = cut >= 0 ? msgs.slice(cut + 1) : msgs;
  if (!fresh.some(m => m.role === 'user')) return { status: 'nothingNew' };
  if (!AZURE_CHAT_READY) {
    console.warn('[chat-reflect] Azure OpenAI niet geconfigureerd — reflectie overgeslagen');
    return { status: 'failed' };
  }

  const ragSources = new Set();
  for (const msg of fresh) {
    const chunks = msg.retrieved_context?.chunks;
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        if (chunk.documentTitle) ragSources.add(chunk.documentTitle);
      }
    }
  }
  const userLabel = lang === 'nl' ? 'Jij' : 'You';
  const tutorLabel = 'Tutor';
  const asText = (list) => list.map(m => `${m.role === 'user' ? userLabel : tutorLabel}: ${m.content}`).join('\n\n');
  // Vervolg: het einde van het eerdere deel als context; de reflectie gaat over het nieuwe deel.
  const chatText = earlier.length
    ? [
      lang === 'nl'
        ? '[Eerder deel van dit gesprek, al opgeslagen in je leerdagboek. Alleen context, niet opnieuw beoordelen.]'
        : '[Earlier part of this conversation, already saved in your learning journal. Context only, do not assess it again.]',
      asText(earlier.slice(-6)),
      '',
      lang === 'nl'
        ? '[Nieuw sinds de vorige opslag. Schrijf je reflectie hierover.]'
        : '[New since the previous save. Write your reflection about this part.]',
      asText(fresh),
    ].join('\n')
    : asText(fresh);

  const sourcesText = ragSources.size > 0
    ? (lang === 'nl'
        ? `\n\nGebruikte cursusbronnen in dit gesprek: ${[...ragSources].join(', ')}`
        : `\n\nCourse sources used in this conversation: ${[...ragSources].join(', ')}`)
    : '';
  // Optioneel doel dat de student voor dit gesprek koos (server/chat/chatGoal.js).
  const goalLine = chatGoalSummaryLine(lastChatGoal(msgs), lang);

  const summaryPrompt = (lang !== 'nl'
    ? `You are a "critical friend" for a student at VU Amsterdam. Analyse the following study conversation and write a formative reflection report of 5 to 10 lines in English, addressed directly to the student.

Addressing rule (follow STRICTLY):
- Address the student directly using "you" / "your".
- NEVER use formulations like "the student", "this student", "the student has" or other third-person references to the student. Write as if giving feedback one-on-one.

Your report contains:
1. A reasoned formative judgement of what you have demonstrated and learned
2. Concrete strengths and areas for improvement in your contribution (honest but constructive)
3. A specific suggestion for further deepening, preferably with reference to available course sources${sourcesText}

Conversation title: "${conversation.title}"

Conversation (lines marked with "You:" are the student you are addressing):
${chatText}

Write the report directly without salutation. Be concrete, honest and motivating.${goalLine}`
    : `Je bent een "critical friend" voor een student aan de VU Amsterdam. Analyseer het volgende studiegesprek en schrijf een formatief reflectieverslag van 5 tot 10 regels in het Nederlands, gericht aan de student zelf.

Aanspraakvorm (volg STRIKT):
- Spreek de student direct aan met "je" / "jij" / "jouw" / "je hebt".
- Gebruik NOOIT formuleringen als "de student", "deze student", "de student heeft" of andere derde-persoonsverwijzingen naar de student. Schrijf alsof je de feedback één-op-één tegen de student geeft.

Je verslag bevat:
1. Een beargumenteerd formatief oordeel over wat jij hebt laten zien en geleerd
2. Concrete sterke punten én verbeterpunten in jouw bijdrage (eerlijk maar opbouwend)
3. Een specifieke suggestie voor verdere verdieping, bij voorkeur met verwijzing naar beschikbare cursusbronnen${sourcesText}

Gesprekstitel: "${conversation.title}"

Gesprek (regels gemarkeerd met "Jij:" zijn de student aan wie je het verslag richt):
${chatText}

Schrijf het verslag direct zonder aanhef. Wees concreet, eerlijk en motiverend.${goalLine}`) + journalFormatInstruction(lang) + buildLanguageInstruction(lang);

  const part = saved.length + 1;
  const baseTitle = lang === 'nl' ? `Chatreflectie: ${conversation.title}` : `Chat reflection: ${conversation.title}`;
  const title = part > 1 ? `${baseTitle} (${lang === 'nl' ? 'deel' : 'part'} ${part})` : baseTitle;
  try {
    const chatResp = await openaiChatCompletion({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: summaryPrompt }],
      ...chatModelParams({ temperature: 0.5, maxTokens: 600 }),
    });
    if (!chatResp.ok) {
      console.error('[chat-reflect] OpenAI fout:', chatResp.status, await chatResp.text());
      return { status: 'failed' };
    }
    const summaryContent = (await chatResp.json()).choices?.[0]?.message?.content;
    if (!summaryContent) return { status: 'failed' };
    const journalCourseId = await resolveJournalCourseId(courseId, user);
    const { data: entry, error: journalError } = await supabaseAdmin
      .from('learning_journal_entries')
      .insert({
        user_id: user.id,
        title,
        ...journalFieldsFromModel(summaryContent, lang),
        activity_type: 'chat_reflection',
        course_id: journalCourseId,
        learning_level: await currentLearningLevel(user.id, journalCourseId),
        source_ref: `chat:${conversation.id}:${fresh[fresh.length - 1].id}`,
      })
      .select('id')
      .single();
    // Twee keer snel op opslaan gedrukt: de tweede botst op dezelfde source_ref.
    if (journalError?.code === '23505') return { status: 'nothingNew' };
    if (journalError) {
      console.error('[chat-reflect] Journal insert error:', journalError);
      return { status: 'failed' };
    }
    return { status: 'created', journalEntryId: entry.id, part };
  } catch (err) {
    console.error('[chat-reflect] Reflectie mislukt:', err.message);
    return { status: 'failed' };
  }
}

const PRACTICED_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 120_000;

const practicedCache = new Map();

async function leerlijnBlockFor(userId, courseId, sources, explicitUnitId) {
  try {
    if (!supabaseAdmin) return '';
    const leerlijn = await cachedLeerlijn(courseId);
    if (leerlijn.units.length === 0) return '';
    const srcs = Array.isArray(sources) ? sources : [];
    const anchor = anchorUnit({ sources: srcs, explicitUnitId: typeof explicitUnitId === 'string' ? explicitUnitId : null, docUnit: leerlijn.docUnit, unitById: leerlijn.unitById });
    if (!anchor) return '';
    const key = `${userId}|${courseId}`;
    let practiced = practicedCache.get(key);
    if (!practiced || Date.now() - practiced.at > PRACTICED_TTL_MS) {
      practiced = { at: Date.now(), value: await loadPracticedUnits(supabaseAdmin, { userId, courseId, leerlijn }) };
      practicedCache.set(key, practiced);
    }
    return buildLeerlijnBlock({ units: leerlijn.units, anchor, practiced: practiced.value, sources: srcs, docUnit: leerlijn.docUnit });
  } catch (err) {
    console.warn('[leerlijn] blok overgeslagen:', err?.message || err);
    return '';
  }
}

const courseOverviewBlock = createCourseOverview({
  supabaseAdmin,
  loadLeerlijn: (courseId) => cachedLeerlijn(courseId),
  materialDocuments: (courseId) => courseMaterialDocuments(courseId),
});

// ── Bijlagen in de chat (server/chat/chatAttachments.js) ──────────────────────────
// Platforminstelling van de beheerder (chatbot_prompts-rij, standaard UIT), 15 s
// onthouden. Leesfout = uit: een storing mag bijlagen nooit per ongeluk aanzetten.
const ATTACHMENTS_OFF_MSG = 'Bijlagen zijn in deze chat niet beschikbaar';

const ATTACHMENTS_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 15_000;

let attachmentsPlatformCache = null;

const attachmentDailyCounter = createDailyCounter();

async function loadAttachmentsPlatform() {
  if (attachmentsPlatformCache && Date.now() - attachmentsPlatformCache.at < ATTACHMENTS_TTL_MS) return attachmentsPlatformCache.value;
  if (!supabaseAdmin) return normalizePlatformSettings(null);
  try {
    const { data, error } = await supabaseAdmin.from('chatbot_prompts')
      .select('content').eq('name', ATTACHMENTS_PLATFORM_KEY).maybeSingle();
    const value = normalizePlatformSettings(error ? null : data?.content);
    if (!error) attachmentsPlatformCache = { at: Date.now(), value };
    return value;
  } catch {
    return normalizePlatformSettings(null);
  }
}

/** Mag deze gebruiker in deze cursus bijlagen meegeven? { available, reason, platform, courseOn, isStaff } */
async function chatAttachmentsGate(user, profile, courseId) {
  const platform = await loadAttachmentsPlatform();
  const courseOn = courseId ? (await loadCourseFeatures(courseId)).attachments === true : false;
  let prof = profile;
  if (!prof && user?.id) prof = (await profileCache.get(user.id, loadProfileRoleEmail))?.data || null;
  const isStaff = courseId ? await isStaffForCourse(user, prof, courseId) : false;
  return { ...attachmentsAvailability({ platform, courseOn, isStaff }), platform, courseOn, isStaff };
}

// Highest answer length a browser may ask for (quiz checks ask up to ~5000).
const CHAT_MAX_TOKENS = 16000;

export function registerChatRoutes(app) {
  app.post('/api/chat', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    if (!AZURE_CHAT_READY) {
      return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
    }

    const {
      messages = [],
      context,
      temperature = 0.7,
      top_p = 1,
      stream = false,
      max_tokens,
      skipSystemPrompt = false,
      ragStrictMode = false,
      promptMode,
      sources,
      lang = 'nl',
      learningLevel,
      courseId,
      readinessCheck = false,
    } = req.body;
    // The browser chooses the answer length, within a ceiling (cost guard).
    const maxTokens = Number.isFinite(Number(max_tokens)) && max_tokens !== null
      ? Math.min(Math.max(1, Math.round(Number(max_tokens))), CHAT_MAX_TOKENS)
      : undefined;

    // Onderdelen per cursus: chat, Ik leg uit en quiz delen dit adres; alleen
    // het onderdeel waar de aanroep bij hoort telt (beheer-aanroepen niet).
    const chatFeature = featureForChatRequest(req.body);
    if (chatFeature && courseId
        && (await rejectIfFeatureOff(res, auth.user, auth.profile, courseId, chatFeature))) return;

    // Bijlagen in de chat (server/chat/chatAttachments.js): alleen in de tutorchat van
    // een cursus, alleen als de beheerder én de cursus het toestaan. LEAP bewaart
    // ze niet en logt nooit de inhoud; ze gaan alleen mee in dit ene verzoek.
    let attachmentParts = { images: [], files: [] };
    let attachmentDetail = 'high';
    if (Array.isArray(req.body?.attachments) && req.body.attachments.length > 0) {
      if (req.body?.purpose !== 'tutor_chat' || !courseId) {
        return res.status(400).json({ error: 'Bijlagen kunnen alleen in de chat van een cursus worden meegegeven', code: 'attachments_invalid' });
      }
      const gate = await chatAttachmentsGate(auth.user, auth.profile, courseId);
      if (!gate.available) {
        return res.status(403).json({ error: ATTACHMENTS_OFF_MSG, code: 'attachments_disabled', reason: gate.reason });
      }
      const parsedAttachments = parseChatAttachments(req.body.attachments, gate.platform.limits);
      if (!parsedAttachments.ok) return res.status(parsedAttachments.status).json(parsedAttachments.body);
      if (!attachmentDailyCounter.tryConsume(auth.user.id, courseId, parsedAttachments.newCount, gate.platform.limits.perDay)) {
        return res.status(429).json({ error: `Je hebt vandaag het maximum van ${gate.platform.limits.perDay} bijlagen in deze cursus bereikt`, code: 'attachments_limit' });
      }
      attachmentParts = parsedAttachments;
      attachmentDetail = gate.platform.detail;
    }
    const hasAttachments = attachmentParts.images.length > 0 || attachmentParts.files.length > 0;

    // Readiness-vraag ("klaar voor een hoger niveau?"): onderwerpen + huidig niveau
    // uit de database, alleen voor een cursus waar de beller toegang toe heeft.
    let readinessCtx = null;
    if (readinessCheck === true && courseId && supabaseAdmin
        && (await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      const [topics, currentLevel] = await Promise.all([
        loadReadinessTopics(courseId),
        currentLearningLevel(auth.user.id, courseId),
      ]);
      readinessCtx = { topics, currentLevel: currentLevel ?? LEVEL_DEFAULT };
    }

    // Task #412: system-prompt hardening. De client stuurt geen vrije
    // system-prompt-tekst meer mee; alleen een bekende `promptMode` die de server
    // zélf naar de vertrouwde (globale of cursus-)prompt resolvet. Ruwe
    // client-tekst wordt genegeerd; een onbekende promptMode geeft 400.
    let resolvedPromptOverride;
    if (promptMode !== undefined && promptMode !== null && promptMode !== '') {
      resolvedPromptOverride = await resolveChatPromptMode(promptMode, {
        user: auth.user,
        profile: auth.profile,
        courseId,
      });
      if (resolvedPromptOverride == null) {
        return res.status(400).json({ error: `Onbekende promptMode: ${String(promptMode)}` });
      }
    }

    // Task #296: parametrisch leerniveau-blok (leeg bij ontbrekend/ongeldig niveau).
    const levelBlock = buildLevelInstructionBlock(learningLevel, lang);

    // Bron-instructieblok voor [1]/[2]/... citaten (gedeeld met de persona-chat).
    const chatSourcesBlock = buildSourcesInstructionBlock(sources);

    // Only conversation turns from the browser; the system prompt is built here.
    // 'developer' (and other roles) would act as instructions for reasoning models.
    const rawUserMessages = Array.isArray(messages) ? messages.filter(m => m && (m.role === 'user' || m.role === 'assistant')) : [];
    const userMessages = rawUserMessages.map(m => ({ role: m.role, content: m.content }));

    let finalMessages;
    if (skipSystemPrompt) {
      if (resolvedPromptOverride) {
        finalMessages = [{ role: 'system', content: `${resolvedPromptOverride}${levelBlock}${buildLanguageInstruction(lang)}` }, ...userMessages];
      } else {
        const langOnly = `${levelBlock}${buildLanguageInstruction(lang)}`.trim();
        finalMessages = langOnly ? [{ role: 'system', content: langOnly }, ...userMessages] : userMessages;
      }
    } else {
      let systemPromptContent = FALLBACK_SYSTEM_PROMPT;
      if (supabaseAdmin) {
        try {
          // 1) Cursus-specifieke tutor-chat-override (Task #334): als deze cursus
          // een eigen, niet-lege chat-prompt heeft, gebruik die i.p.v. de globale.
          // BEVEILIGING: courseId komt uit de request-body; we mogen de cursus-
          // override pas laden nadat is vastgesteld dat de beller daadwerkelijk
          // toegang tot die cursus heeft (anders kan elke ingelogde gebruiker de
          // prompt van een willekeurige cursus afdwingen/uitlezen).
          let courseOverrideUsed = false;
          if (courseId && (await userHasCourseAccess(auth.user, auth.profile, courseId))) {
            const { data: override } = await supabaseAdmin
              .from('chatbot_prompts')
              .select('id, content')
              .eq('name', chatPromptKey(courseId))
              .maybeSingle();
            if (override?.content && override.content.trim()) {
              systemPromptContent = override.content;
              courseOverrideUsed = true;
              console.log(`[/api/chat] Cursus-chat-prompt geladen voor courseId=${courseId} (id=${override.id})`);
            }
          } else if (courseId) {
            console.warn(`[/api/chat] courseId=${courseId} genegeerd — beller heeft geen toegang tot deze cursus.`);
          }
          if (!courseOverrideUsed) {
            const quizNamesExclude = Object.keys(QUIZ_PROMPT_DEFAULTS);
            let promptQuery = supabaseAdmin
              .from('chatbot_prompts')
              .select('id, name, content')
              .eq('is_active', true)
              .not('name', 'like', '__rag_settings%')
              .not('name', 'like', '__doc_mutation_%')
              .not('name', 'like', '__concepts_regen_%')
              .not('name', 'like', '__chat_prompt_%')
              .not('name', 'like', '__quiz_itembank_config%')
              .not('name', 'in', `(${quizNamesExclude.map(n => `"${n}"`).join(',')})`)
              .order('updated_at', { ascending: false })
              .limit(1);
            if (promptsHasSection) {
              promptQuery = promptQuery.eq('section', 'chat');
            }
            const { data: promptData, error: promptError } = await promptQuery.maybeSingle();
            if (promptError) {
              console.warn('[/api/chat] Prompt ophalen mislukt, fallback gebruikt:', promptError.message);
            } else if (promptData?.content) {
              systemPromptContent = promptData.content;
              console.log(`[/api/chat] Actieve chat-prompt geladen: "${promptData.name}" (id=${promptData.id})`);
            } else {
              console.warn('[/api/chat] Geen actieve chat-prompt in database — fallback gebruikt');
            }
          }
        } catch (err) {
          console.warn('[/api/chat] Prompt ophalen exception, fallback gebruikt:', err.message);
        }
      }
      // Task #296: leerniveau-blok + taal-instructie als langSuffix. Dit suffix
      // wordt als ALLERLAATSTE toegevoegd (ná de bronnen-/verwijsregels) zodat de
      // taal-eis dominant blijft voor de uitvoertaal, ook wanneer er bronnen zijn.
      const langSuffix = `${levelBlock}${buildLanguageInstruction(lang)}`;
      let systemContent;
      if (ragStrictMode) {
        if (context) {
          systemContent = `${systemPromptContent}\n\nContext uit cursusmateriaal:\n${context}${RAG_STRICT_INSTRUCTION}`;
        } else {
          systemContent = `${systemPromptContent}${RAG_STRICT_INSTRUCTION}\n\nEr zijn geen relevante cursusteksten gevonden voor deze vraag. Informeer de student hierover.`;
        }
      } else {
        systemContent = context
          ? `${systemPromptContent}\n\nContext uit cursusmateriaal:\n${context}`
          : `${systemPromptContent}`;
      }
      if (chatSourcesBlock) systemContent += chatSourcesBlock;
      // Bijlagen: instructie + bestandstekst, vóór het taal-/niveaublok.
      systemContent += attachmentSystemBlock(attachmentParts);
      // Cursusoverzicht (server/courses/courseOverview.js): naam, opbouw en begrippen,
      // voor oriëntatievragen ("waar gaat deze cursus over?").
      if (req.body?.purpose === 'tutor_chat' && courseId) {
        systemContent += await courseOverviewBlock(courseId);
      }
      // Leerlijn (server/courses/courseUnits.js): terugverwijzen naar voorafgaande
      // onderdelen, spaarzaam vooruit, behalve naar wat de student al oefende.
      if (req.body?.purpose === 'tutor_chat' && courseId) {
        systemContent += await leerlijnBlockFor(auth.user.id, courseId, sources, req.body?.leerlijnUnitId);
      }
      // Optioneel doel van de student voor dit gesprek (server/chat/chatGoal.js).
      if (req.body?.purpose === 'tutor_chat') systemContent += buildChatGoalBlock(req.body?.chatGoal, lang);
      systemContent += langSuffix;
      finalMessages = [{ role: 'system', content: systemContent }, ...userMessages];
    }
    // Afbeeldingen gaan alleen mee met het laatste studentbericht (één keer).
    finalMessages = attachImagesToLastUser(finalMessages, attachmentParts.images, attachmentDetail);

    if (readinessCtx) {
      const readinessBlock = buildReadinessInstruction({ ...readinessCtx, lang });
      if (finalMessages[0]?.role === 'system') {
        finalMessages[0] = { ...finalMessages[0], content: finalMessages[0].content + readinessBlock };
      } else {
        finalMessages.unshift({ role: 'system', content: readinessBlock.trim() });
      }
    }

    const chatBody = {
      model: OPENAI_MODEL,
      messages: finalMessages,
      // Met een bijlage beschrijft het model eerst wat het ziet: meer ruimte.
      [MAX_TOKENS_PARAM]: hasAttachments ? Math.max(maxTokens ?? 512, 1500) : (maxTokens ?? 512),
      stream,
    };
    if (IS_REASONING_MODEL) {
      // Reasoning-modellen (gpt-5.x / o1 / o3 / o4) accepteren alleen de standaard
      // temperature/top_p (1) en weigeren een aangepaste waarde met een HTTP 400.
      // Stuur die parameters daarom proactief NIET mee — dat scheelt op elke
      // aanvraag een mislukte call + retry. Voeg in plaats daarvan een lage
      // reasoning_effort toe zodat er tokenbudget overblijft voor zichtbare output.
      chatBody.reasoning_effort = REASONING_EFFORT;
    } else {
      chatBody.temperature = temperature;
      chatBody.top_p = top_p;
    }

    const postChatCompletion = async (body) => {
      const r = await fetch(OPENAI_CHAT_URL, {
        method: 'POST',
        headers: chatAuthHeaders(),
        body: JSON.stringify(body),
      });
      // Lees eerst als tekst en parse defensief: bij een storing aan de
      // providerkant (HTML-foutpagina, gateway-timeout, lege body) is de body
      // geen geldige JSON en zou r.json() een exception gooien. Dan zetten we
      // body op null zodat de aanroeper dit als "dienst onbereikbaar" afhandelt.
      const rawText = await r.text();
      let parsed = null;
      try {
        parsed = rawText ? JSON.parse(rawText) : null;
      } catch {
        parsed = null;
      }
      return { r, body: parsed, rawText };
    };

    try {
      let { r: response, body: data, rawText } = await postChatCompletion(chatBody);

      // Reasoning-modellen weigeren een aangepaste temperature/top_p met een 400.
      // Probeer dan één keer opnieuw zonder die sampling-parameters, zodat het
      // antwoord alsnog gegenereerd wordt in plaats van te falen met
      // "het taalmodel weigerde het verzoek".
      if (!response.ok && response.status === 400 && isUnsupportedSamplingParamError(data)) {
        const { temperature: _t, top_p: _tp, ...retryBody } = chatBody;
        console.warn(`[/api/chat] Model ${OPENAI_MODEL} accepteert geen aangepaste temperature/top_p — opnieuw zonder die parameters.`);
        ({ r: response, body: data, rawText } = await postChatCompletion(retryBody));
      }

      // Niet-JSON of lege upstream-respons (HTML-foutpagina, gateway-timeout,
      // lege body): vertaal naar een herkenbare, herhaalbare melding i.p.v. een
      // generieke 500 die niet te onderscheiden is van een echte bug.
      if (data == null) {
        const snippet = (rawText || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        console.error(`[/api/chat] OpenAI gaf geen geldige JSON terug status=${response.status} body=${snippet || '(leeg)'}`);
        return res.status(502).json({
          error: {
            message: 'De AI-dienst is tijdelijk niet bereikbaar.',
            code: 'upstream_unavailable',
          },
        });
      }

      if (!response.ok) {
        const promptChars = JSON.stringify(finalMessages).length;
        const errCode = data?.error?.code || data?.error?.type || 'unknown';
        // Log de volledige OpenAI error-body (afgekapt op 2000 tekens om logs niet
        // op te blazen) zodat we exact zien wat OpenAI teruggaf.
        const bodyStr = (() => {
          try { return JSON.stringify(data); } catch { return String(data); }
        })();
        console.error(`[/api/chat] OpenAI error status=${response.status} code=${errCode} promptChars=${promptChars} body=${bodyStr.length > 2000 ? bodyStr.slice(0, 2000) + '…[truncated]' : bodyStr}`);
        return res.status(response.status).json(data);
      }

      // Reasoning-modellen (zoals gpt-5.2) kunnen een HTTP 200 met lege of
      // afgekapte content teruggeven (finish_reason: "length") wanneer de
      // reasoning-tokens het budget opslokken. Dit raakt vooral zware,
      // gestructureerde opdrachten zoals "Ik leg uit". Probeer in dat geval één
      // keer opnieuw met een ruimer tokenbudget (en lage reasoning-inspanning)
      // voordat we falen, zodat alle functies (chat én explain) profiteren.
      if (!stream && isEmptyOrTruncatedCompletion(data)) {
        const baseBudget = maxTokens ?? 512;
        const retryBudget = Math.max(baseBudget * 2, 2000);
        const retryBody = { ...chatBody, [MAX_TOKENS_PARAM]: retryBudget };
        if (IS_REASONING_MODEL) retryBody.reasoning_effort = REASONING_EFFORT;
        const prevFinish = data?.choices?.[0]?.finish_reason;
        console.warn(`[/api/chat] Lege/afgekapte respons (finish_reason=${prevFinish}) — opnieuw met ruimer tokenbudget (${retryBudget}).`);
        const retry = await postChatCompletion(retryBody);
        if (retry.r.ok) {
          // Behoud de retry-respons: die heeft minstens evenveel ruimte en bevat
          // doorgaans de volledige tekst. Zo niet, dan vangt de check hieronder af.
          data = retry.body;
        }
      }

      // Als er na een eventuele retry nog steeds geen bruikbare of volledige tekst
      // is, geef een duidelijke fout terug i.p.v. een misleidende lege/afgekapte
      // 200 — de frontend toont dan de juiste Nederlandse melding over te weinig
      // tokenruimte.
      const finalChoice = data?.choices?.[0];
      const finalContent = finalChoice?.message?.content;
      const finalFinish = finalChoice?.finish_reason;
      if (!finalContent || !String(finalContent).trim()) {
        console.error(`[/api/chat] Lege content na verwerking (finish_reason=${finalFinish}, model=${OPENAI_MODEL}).`);
        return res.status(502).json({
          error: {
            message: 'Het taalmodel gaf een lege reactie terug: er was te weinig tokenruimte voor het antwoord.',
            code: 'empty_response',
          },
        });
      }
      if (finalFinish === 'length') {
        // Niet-lege maar afgekapte respons: voor gestructureerde feedback ("Ik leg
        // uit") is een halve respons misleidend. Faal expliciet met een code die de
        // frontend op de tokenruimte-melding mapt, i.p.v. partiële tekst door te geven.
        console.error(`[/api/chat] Afgekapte respons na verwerking (finish_reason=length, model=${OPENAI_MODEL}).`);
        return res.status(502).json({
          error: {
            message: 'Het antwoord werd afgekapt: er was te weinig tokenruimte voor het volledige antwoord.',
            code: 'length',
          },
        });
      }

      // Het onzichtbare readiness-label nooit aan de student tonen; bij een
      // readiness-vraag beoordeelt de server of het oordeel telt.
      const readinessParsed = extractReadiness(String(finalContent));
      if (readinessParsed.hadMarker) data.choices[0].message.content = readinessParsed.text;
      if (readinessCtx) {
        try {
          const outcome = evaluateReadiness({
            verdict: readinessParsed.verdict,
            topic: readinessParsed.topic,
            topics: readinessCtx.topics,
            // Alleen beurten die de server zelf heeft beantwoord tellen mee.
            priorStudentMessages: countVerifiedPriorStudentMessages(rawUserMessages, { hmac: turnHmac, userId: auth.user.id, courseId }),
            currentLevel: readinessCtx.currentLevel,
          });
          data.readiness = await recordReadinessOutcome({ user: auth.user, courseId, lang, outcome, answerText: readinessParsed.text });
        } catch (rErr) {
          console.warn('[/api/chat] readiness-verwerking mislukt:', rErr?.message || rErr);
        }
      }
      // Tutorchat: onderteken deze beurt, zodat hij later meetelt voor "klaar
      // voor een hoger niveau?" (de browser bewaart de handtekening bij het antwoord).
      if (req.body?.purpose === 'tutor_chat' && courseId) {
        const lastUser = [...userMessages].reverse().find(m => m.role === 'user');
        if (lastUser) data.turnSig = turnSignature(turnHmac, { userId: auth.user.id, courseId, content: lastUser.content });
      }
      return res.json(data);
    } catch (err) {
      console.error('[/api/chat] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/chat/reflect — tussentijds opslaan in het leerdagboek; het gesprek blijft staan.
  app.post('/api/chat/reflect', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
    const { conversationId, lang = 'nl', courseId } = req.body || {};
    if (!conversationId) return res.status(400).json({ error: 'conversationId is vereist' });
    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
      const { data: conversation } = await supabaseAdmin
        .from('conversations').select('id, title, user_id').eq('id', conversationId).maybeSingle();
      if (!conversation) return res.status(404).json({ error: 'Gesprek niet gevonden' });
      if (conversation.user_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot dit gesprek' });
      const r = await createChatReflection({ user, conversation, courseId, lang });
      if (r.status === 'journalOff') return res.status(403).json({ error: 'Het leerdagboek staat uit in deze cursus', code: 'journalOff' });
      if (r.status === 'failed') return res.status(502).json({ error: 'De reflectie kon niet worden gemaakt. Probeer het later opnieuw.', code: 'failed' });
      return res.json({ status: r.status, journalEntryId: r.journalEntryId || null, part: r.part || null });
    } catch (err) {
      console.error('[chat-reflect] Onverwachte fout:', err);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // Task #251 — "verwijderen" is sinds Task #250 een definitieve delete (geen
  // soft-delete/archief meer). De canonieke route is /api/chat/delete;
  // /api/chat/archive blijft als alias bestaan zodat oudere clients niet breken.
  app.post(['/api/chat/delete', '/api/chat/archive'], async (req, res) => {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader) {
      return res.status(401).json({ error: 'Authorization header vereist' });
    }

    const { conversationId, generateSummary = false, lang = 'nl', courseId } = req.body;
    if (!conversationId) {
      return res.status(400).json({ error: 'conversationId is vereist' });
    }

    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) {
        return res.status(401).json({ error: 'Niet geauthenticeerd' });
      }

      const { data: conversation, error: convError } = await supabaseAdmin
        .from('conversations')
        .select('id, title, user_id')
        .eq('id', conversationId)
        .maybeSingle();

      if (convError || !conversation) {
        return res.status(404).json({ error: 'Gesprek niet gevonden' });
      }

      if (conversation.user_id !== user.id) {
        return res.status(403).json({ error: 'Geen toegang tot dit gesprek' });
      }

      // Reflectie in het leerdagboek (createChatReflection): alleen over wat nog
      // niet eerder is opgeslagen; niets nieuws → geen tweede dagboekregel.
      let reflection = { status: 'skipped' };
      if (generateSummary) reflection = await createChatReflection({ user, conversation, courseId, lang });
      const journalEntryId = reflection.journalEntryId || null;
      const summaryCreated = reflection.status === 'created';
      const summaryAlreadySaved = reflection.status === 'nothingNew';
      const summaryFailed = generateSummary && reflection.status === 'failed';

      const { error: deleteError } = await supabaseAdmin
        .from('conversations')
        .delete()
        .eq('id', conversationId)
        .eq('user_id', user.id);

      if (deleteError) {
        return res.status(500).json({ error: `Verwijderen mislukt: ${deleteError.message}` });
      }

      console.log(`[chat-delete] Gesprek ${conversationId} definitief verwijderd (summaryCreated: ${summaryCreated})`);
      return res.json({ success: true, journalEntryId, summaryCreated, summaryFailed, summaryAlreadySaved });
    } catch (err) {
      console.error('[chat-delete] Onverwachte fout:', err);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // ── Bijlagen in de chat: routes (server/chat/chatAttachments.js) ──────────────────
  // GET /api/chat/attachments/config?courseId=… — mag ik hier bijlagen meegeven?
  app.get('/api/chat/attachments/config', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const courseId = typeof req.query.courseId === 'string' ? req.query.courseId : null;
    try {
      if (courseId && !(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
        return res.json({ available: false, reason: 'course_off', platformEnabled: false, courseOn: false, isStaff: false });
      }
      const gate = await chatAttachmentsGate(auth.user, auth.profile, courseId);
      const { limits, enabled } = gate.platform;
      return res.json({
        available: gate.available && !!courseId,
        reason: courseId ? gate.reason : 'course_off',
        platformEnabled: enabled,
        courseOn: gate.courseOn,
        isStaff: gate.isStaff,
        limits,
        usedToday: courseId ? attachmentDailyCounter.used(auth.user.id, courseId) : 0,
      });
    } catch (err) {
      console.error('[chat/attachments/config] fout:', err?.message || err);
      return res.status(500).json({ error: 'Instelling voor bijlagen kon niet worden gelezen' });
    }
  });

  // POST /api/chat/attachments/extract { courseId, name, data (base64) } → tekst
  // uit een bestand (PDF, Word, PowerPoint, OpenDocument, tekst). Alles in het
  // geheugen: niets naar schijf of opslag, en de inhoud wordt nooit gelogd.
  app.post('/api/chat/attachments/extract', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, name, data } = req.body || {};
    if (!courseId || typeof name !== 'string' || typeof data !== 'string') {
      return res.status(400).json({ error: 'Bestand ontbreekt', code: 'attachments_invalid' });
    }
    const gate = await chatAttachmentsGate(auth.user, auth.profile, courseId);
    if (!gate.available || !(await userHasCourseAccess(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: ATTACHMENTS_OFF_MSG, code: 'attachments_disabled', reason: gate.reason });
    }
    const limits = gate.platform.limits;
    let buf;
    try { buf = Buffer.from(data, 'base64'); } catch { buf = null; }
    if (!buf || buf.length === 0) return res.status(400).json({ error: 'Bestand ontbreekt', code: 'attachments_invalid' });
    if (buf.length > limits.fileMb * 1024 * 1024) {
      return res.status(413).json({ error: `Dit bestand is groter dan ${limits.fileMb} MB`, code: 'attachments_too_large' });
    }
    const kind = sniffFileKind(name, buf);
    if (!kind) return res.status(400).json({ error: 'Dit soort bestand wordt niet ondersteund', code: 'attachments_type' });
    try {
      let text = '';
      let pages = null;
      if (kind === 'pdf') {
        const pageTexts = await extractPdfPageTexts(buf);
        pages = pageTexts.length;
        text = pageTexts.join('\n\n');
      } else if (kind === 'pptx') {
        const deck = extractPptxStructured(buf);
        pages = Array.isArray(deck) ? deck.length : null;
        text = Array.isArray(deck) ? buildDeckText(deck) : '';
        if (!text.trim()) text = await parseOfficeAsync(buf);
      } else if (['docx', 'odt', 'odp'].includes(kind)) {
        text = await parseOfficeAsync(buf);
      } else {
        text = buf.toString('utf8');
      }
      text = String(text || '').replace(/\u0000/g, '').trim();
      // Een PDF zonder (bijna) tekst is gescand: de browser maakt er dan
      // afbeeldingen van de eerste pagina's van.
      const scanned = kind === 'pdf' && text.length < 200;
      const truncated = text.length > limits.fileChars;
      return res.json({
        name: safeName(name, 'bestand'),
        kind,
        pages,
        chars: text.length,
        truncated,
        scanned,
        text: scanned ? '' : text.slice(0, limits.fileChars),
      });
    } catch (err) {
      console.warn(`[chat/attachments/extract] ${kind} kon niet worden gelezen (${buf.length} bytes): ${err?.message || err}`);
      return res.status(422).json({ error: 'Uit dit bestand kon geen tekst worden gehaald', code: 'attachments_unreadable' });
    }
  });

  // GET /api/admin/chat-attachments — platforminstelling, cursussen met bijlagen
  // aan en de laatste wijzigingen. Alleen beheerder.
  app.get('/api/admin/chat-attachments', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    if (!isLeapAdmin(auth.profile)) return res.status(403).json({ error: 'Alleen de beheerder' });
    try {
      attachmentsPlatformCache = null;
      const platform = await loadAttachmentsPlatform();
      const { data: courses } = await supabaseAdmin.from('courses').select('id, name, features').order('name');
      const coursesOn = (courses || [])
        .filter(c => normalizeCourseFeatures(c.features).attachments)
        .map(c => ({ id: c.id, name: c.name }));
      let changes = [];
      try {
        const { data } = await supabaseAdmin.from('leap_setting_changes')
          .select('course_id, setting, value, created_at, changed_by')
          .in('setting', ['chat_attachments', 'chat_attachments_platform'])
          .order('created_at', { ascending: false }).limit(20);
        const ids = [...new Set((data || []).map(r => r.changed_by).filter(Boolean))];
        const { data: people } = ids.length
          ? await supabaseAdmin.from('profiles').select('id, full_name, email').in('id', ids)
          : { data: [] };
        const who = new Map((people || []).map(p => [p.id, p.full_name || p.email]));
        const courseName = new Map((courses || []).map(c => [c.id, c.name]));
        changes = (data || []).map(r => ({
          at: r.created_at,
          setting: r.setting,
          value: r.value,
          course: r.course_id ? courseName.get(r.course_id) || null : null,
          by: r.changed_by ? who.get(r.changed_by) || null : null,
        }));
      } catch { /* logboek ontbreekt: alleen geen geschiedenis */ }
      return res.json({ settings: platform, coursesOn, changes });
    } catch (err) {
      console.error('[admin/chat-attachments GET] fout:', err?.message || err);
      return res.status(500).json({ error: 'Instelling voor bijlagen kon niet worden gelezen' });
    }
  });

  // PUT /api/admin/chat-attachments { enabled?, detail?, limits?, resetCourses? }
  // Uitzetten is de noodrem voor iedereen; de keuze per cursus blijft bewaard,
  // tenzij resetCourses: dan gaan alle cursussen terug naar uit.
  app.put('/api/admin/chat-attachments', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    if (!isLeapAdmin(auth.profile)) return res.status(403).json({ error: 'Alleen de beheerder' });
    const parsed = parsePlatformPatch(req.body);
    if (!parsed.ok) return res.status(parsed.status).json(parsed.body);
    try {
      const { data: row } = await supabaseAdmin.from('chatbot_prompts')
        .select('id, content').eq('name', ATTACHMENTS_PLATFORM_KEY).maybeSingle();
      const before = normalizePlatformSettings(row?.content);
      const next = mergePlatformSettings(before, parsed.value);
      const content = JSON.stringify(next);
      if (row) {
        const { error } = await supabaseAdmin.from('chatbot_prompts').update({ content, updated_at: new Date().toISOString() }).eq('id', row.id);
        if (error) throw error;
      } else {
        const { error } = await supabaseAdmin.from('chatbot_prompts').insert({ name: ATTACHMENTS_PLATFORM_KEY, content, is_active: false });
        if (error) throw error;
      }
      attachmentsPlatformCache = null;

      // Welke cursussen raakt dit? Vastgelegd voor later (berichten aan de
      // getroffen docenten en studenten, plan H12).
      const { data: courses } = await supabaseAdmin.from('courses').select('id, features');
      const affected = (courses || []).filter(c => normalizeCourseFeatures(c.features).attachments).map(c => c.id);
      let reset = 0;
      if (parsed.value.resetCourses) {
        for (const c of (courses || []).filter(x => affected.includes(x.id))) {
          const stored = mergeCourseFeatures(c.features, { attachments: false });
          const { error } = await supabaseAdmin.from('courses').update({ features: stored }).eq('id', c.id);
          if (!error) { reset += 1; courseFeaturesCache.delete(c.id); }
        }
      }
      if (before.enabled !== next.enabled || before.detail !== next.detail
          || JSON.stringify(before.limits) !== JSON.stringify(next.limits) || reset > 0) {
        await logSettingChange({
          setting: 'chat_attachments_platform',
          value: { enabled: next.enabled, detail: next.detail, limits: next.limits, affectedCourses: affected, resetCourses: reset },
          changedBy: auth.user.id,
        });
      }
      console.log(`[admin/chat-attachments] platform ${next.enabled ? 'aan' : 'uit'}, detail=${next.detail}, cursussen aan: ${affected.length}, teruggezet: ${reset}`);
      return res.json({ settings: next, affectedCourses: affected.length, resetCourses: reset });
    } catch (err) {
      console.error('[admin/chat-attachments PUT] fout:', err?.message || err);
      return res.status(500).json({ error: 'Instelling voor bijlagen kon niet worden opgeslagen' });
    }
  });
}
