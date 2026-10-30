import { createClient } from '@supabase/supabase-js';
import { resolveJournalCourseId } from '../journal/journalCourse.js';
import { journalFieldsFromModel, journalFormatInstruction } from '../journal/journalSections.js';
import { buildLanguageInstruction } from '../i18n/languages.js';
import {
  isCourseTeacher,
  isStaffForCourse,
  requireAdminOrDocent,
  requireAuthUser,
  userCache,
  userHasCourseAccess,
} from '../lib/auth.js';
import { AZURE_CHAT_READY, OPENAI_MODEL, chatModelParams, openaiChatCompletion } from '../lib/azureOpenai.js';
import { courseFeatureOnFor, rejectIfFeatureOff } from '../lib/courseFeatureGate.js';
import { quizAttemptsHasNewSchema, quizSourcesSchemaReady } from '../lib/schemaFlags.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabaseAdmin } from '../lib/supabase.js';
import { QUIZ_PROMPT_DEFAULTS, promptsHasSection } from '../prompts/promptStore.js';
import { normalizeMix } from './quizSourcesMix.js';
import { itembankSourceOrFilter } from './itembankScope.js';

// ─── Gedeelde quiz-samenvattingsbouwer ──────────────────────────────────────
// Beide endpoints (/api/quiz/delete en /api/quiz/save-summary) gebruiken
// dezelfde notitie-stijl in het leerdagboek. De prompt schaalt mee in lengte
// en focus afhankelijk van het aantal vragen en het vraagtype: een korte
// 3-vragen meerkeuzequiz krijgt een compacte notitie van ~6 regels, een rijke
// 8-vragen open quiz krijgt een notitie tot ~18 regels met meer per-vraag-
// reflectie. De notitie spreekt de student altijd in de tweede persoon aan.
function buildQuizSummaryParams({ topics, difficulty, questionType, questions, answers, scorePercentage, lang = 'nl' }) {
  const safeTopics = Array.isArray(topics) && topics.length > 0 ? topics : ['(geen onderwerp opgegeven)'];
  const topicsLabel = safeTopics.join(', ');
  const qType = questionType === 'open' || questionType === 'casus' ? questionType : 'mcq';
  const typeLabel = lang !== 'nl'
    ? (qType === 'mcq' ? 'multiple choice questions' : qType === 'open' ? 'open questions' : 'case questions')
    : (qType === 'mcq' ? 'meerkeuzevragen' : qType === 'open' ? 'open vragen' : 'casusvragen');
  const safeDifficulty = difficulty || (lang === 'nl' ? 'gemiddeld' : 'medium');
  const qList = Array.isArray(questions) ? questions : [];
  const aList = Array.isArray(answers) ? answers : [];
  const totalQuestions = qList.length;
  const scorePct = scorePercentage == null ? null : Number(scorePercentage);

  // Lengtebudget op basis van vraagtype + aantal vragen.
  // Meerkeuze is feitelijker → vaste, korte notitie (6–8 regels) ongeacht aantal.
  // Open/casus is rijker → schaalt mee tot harde bovengrens (8–22 regels), met
  // gegarandeerde minLines <= maxLines.
  let minLines, maxLines, perQuestionLine;
  const HARD_MAX_LINES = 22;
  if (qType === 'mcq') {
    minLines = 6;
    maxLines = 8;
    perQuestionLine = '';
  } else {
    // Schaal: ~2 regels per vraag, met ondergrens 8 en bovengrens 22.
    minLines = Math.min(HARD_MAX_LINES - 4, Math.max(8, Math.round(totalQuestions * 1.5) + 4));
    maxLines = Math.min(HARD_MAX_LINES, Math.max(12, Math.round(totalQuestions * 2.5) + 4));
    if (minLines > maxLines) minLines = maxLines - 2;
    perQuestionLine = `Reflecteer kort op de meeste vragen afzonderlijk (zeker waar je antwoord opvallend sterk of opvallend zwak was), en koppel die aan het bredere beeld.`;
  }

  // Per-vraag-detail voor het taalmodel.
  const detailLines = qList.map((q, i) => {
    const a = aList[i] || {};
    const qText = q?.question || `(vraag ${i + 1})`;
    if (qType === 'mcq') {
      const opts = Array.isArray(q?.options) ? q.options : [];
      const noAns = lang !== 'nl' ? '(not answered)' : '(niet beantwoord)';
      const noCorrect = lang !== 'nl' ? '(unknown)' : '(onbekend)';
      const sel = typeof a.selectedIndex === 'number' ? opts[a.selectedIndex] : noAns;
      const correct = typeof q?.correctAnswer === 'number' ? opts[q.correctAnswer] : noCorrect;
      const status = lang !== 'nl' ? (a.isCorrect ? 'correct' : 'incorrect') : (a.isCorrect ? 'goed' : 'fout');
      const qLabel = lang !== 'nl' ? 'Question' : 'Vraag';
      const ansLabel = lang !== 'nl' ? 'Your answer' : 'Jouw antwoord';
      const corrLabel = lang === 'en' ? 'Correct' : 'Correct';
      return `${qLabel} ${i + 1}: ${qText}\n  - ${ansLabel}: ${sel} (${status})\n  - ${corrLabel}: ${correct}`;
    }
    const noAnsOpen = lang !== 'nl' ? '(no answer)' : '(geen antwoord)';
    const noScore = lang !== 'nl' ? '(no score)' : '(geen score)';
    const ans = (a.text || '').trim() || noAnsOpen;
    const ev = a.evaluation || {};
    const fb = (ev.feedback || '').trim();
    const ff = (ev.feedforward || '').trim();
    const sc = ev.score != null ? `${ev.score}/100` : noScore;
    const ctx = qType === 'casus' && q?.context
      ? (lang !== 'nl' ? `\n  - Case: ${q.context}` : `\n  - Casus: ${q.context}`)
      : '';
    const qLabel = lang !== 'nl' ? 'Question' : 'Vraag';
    const ansLabel = lang !== 'nl' ? 'Your answer' : 'Jouw antwoord';
    const scoreLabel = lang === 'en' ? 'Score' : 'Score';
    const fbLabel = lang === 'en' ? 'Feedback' : 'Feedback';
    const ffLabel = lang === 'en' ? 'Feed forward' : 'Feed forward';
    return `${qLabel} ${i + 1}: ${qText}${ctx}\n  - ${ansLabel}: ${ans}\n  - ${scoreLabel}: ${sc}\n  - ${fbLabel}: ${fb}\n  - ${ffLabel}: ${ff}`;
  }).join('\n\n');

  // Type-specifieke focusinstructie.
  const focusInstruction = lang !== 'nl'
    ? (qType === 'mcq'
      ? 'Focus on patterns: which concepts or reasoning steps went well, which needed correction. Reference specific question numbers where relevant.'
      : qType === 'open'
        ? 'Focus on the quality of your reasoning: how explicitly did you state your assumptions, how precise was your wording, how well did you support your conclusions? Be specific per question where helpful.'
        : 'Focus on your clinical-methodological reasoning in the case: how well did you connect theory to the scenario, which methodological choices did you justify, which nuances did you overlook? Be specific per case where helpful.')
    : (qType === 'mcq'
      ? 'Focus op patronen: welke begrippen of denkstappen gingen goed, welke vroegen om correctie. Verwijs waar relevant naar specifieke vraagnummers.'
      : qType === 'open'
        ? 'Focus op de kwaliteit van je redenering: hoe expliciet maakte je je aannames, hoe nauwkeurig was je formulering, hoe goed onderbouw je conclusies? Wees concreet per vraag waar dat helpt.'
        : 'Focus op je klinisch-methodisch redeneren in de casus: hoe goed verbond je theorie met het scenario, welke methodische keuzes onderbouwde je, welke nuances liet je liggen? Wees concreet per casus waar dat helpt.');

  const summaryPromptNL = `Je bent een "critical friend" voor een student aan de VU Amsterdam. Een student heeft zojuist een AI-gegenereerde quiz afgerond. Schrijf een formatief reflectieverslag van ${minLines} tot ${maxLines} regels in het Nederlands, gericht aan de student zelf.

Aanspraakvorm (volg STRIKT):
- Spreek de student direct aan met "je" / "jij" / "jouw" / "je hebt".
- Gebruik NOOIT formuleringen als "de student", "deze student", "de student heeft" of andere derde-persoonsverwijzingen naar de student. Schrijf alsof je de feedback één-op-één tegen de student geeft.

Je verslag bevat — in deze volgorde, met deze (vetgedrukte) kopjes op aparte regels:
**Wat je hebt laten zien**
- Concrete sterke punten op basis van jouw antwoorden en de gegeven feedback.

**Aandachtspunten**
- Waar het minder ging en waarom; verwijs waar relevant naar specifieke vraagnummers.

**Wat je hiermee kunt**
- Eén of twee concrete vervolgstappen — wat ga je nalezen, oefenen of toepassen om dit verder te brengen, en waarvoor is wat je nu kunt al genoeg?

Type-specifieke focus: ${focusInstruction}
${perQuestionLine}

Quiz-context:
- Onderwerp(en): ${topicsLabel}
- Vraagtype: ${typeLabel}
- Niveau: ${safeDifficulty}
- Aantal vragen: ${totalQuestions}${scorePct != null ? `\n- Totaalscore: ${scorePct}%` : ''}

Quiz-detail (per vraag):
${detailLines || '(geen details beschikbaar)'}

Schrijf het verslag direct, zonder aanhef en zonder afsluitende groet. Wees concreet, eerlijk en motiverend; vermijd vaagheden en clichés.`;

  const summaryPromptEN = `You are a "critical friend" for a student at VU Amsterdam. The student has just completed an AI-generated quiz. Write a formative reflection report of ${minLines} to ${maxLines} lines in English, addressed directly to the student.

Address the student directly using "you/your" throughout. NEVER refer to "the student" in the third person.

Your report contains — in this order, with these (bold) headings on separate lines:
**What you demonstrated**
- Concrete strengths based on your answers and the feedback provided.

**Areas for attention**
- Where things went less well and why; reference specific question numbers where relevant.

**What you can do with this**
- One or two concrete next steps — what will you review, practise, or apply to improve further, and for what is your current level already sufficient?

Type-specific focus: ${focusInstruction}
${perQuestionLine}

Quiz context:
- Topic(s): ${topicsLabel}
- Question type: ${typeLabel}
- Difficulty: ${safeDifficulty}
- Number of questions: ${totalQuestions}${scorePct != null ? `\n- Total score: ${scorePct}%` : ''}

Quiz detail (per question):
${detailLines || '(no details available)'}

Write the report directly, without a greeting or closing. Be concrete, honest and motivating; avoid vague generalities and clichés.`;

  const summaryPrompt = (lang === 'nl' ? summaryPromptNL : summaryPromptEN) + journalFormatInstruction(lang) + buildLanguageInstruction(lang);

  return {
    summaryPrompt,
    topicsLabel,
    qType,
    typeLabel,
    minLines,
    maxLines,
    lang,
  };
}

// Roept OpenAI aan met de gegeven prompt en schrijft de notitie weg in
// learning_journal_entries. Returnt {journalEntryId, summaryFailed, errorReason}.
async function generateAndSaveQuizSummary({ user, summaryPrompt, topicsLabel, qType, maxLines, lang = 'nl', courseId = null }) {
  // Leerdagboek uit in deze cursus: niets schrijven (de routes vangen dit ook al af).
  if (!(await courseFeatureOnFor(user, null, courseId, 'journal'))) {
    return { journalEntryId: null, summaryFailed: false, errorReason: null };
  }
  if (!AZURE_CHAT_READY) {
    console.warn('[quiz/summary] Azure OpenAI niet geconfigureerd — samenvatting overgeslagen');
    return { journalEntryId: null, summaryFailed: true, errorReason: 'Geen taalmodel-toegang (Azure OpenAI niet geconfigureerd).' };
  }
  // Token-budget evenredig aan maximale regels (≈ 50 tokens/regel marge).
  const maxTokens = Math.min(2000, Math.max(600, maxLines * 60));

  let summaryContent;
  try {
    const chatResp = await openaiChatCompletion({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: summaryPrompt }],
      ...chatModelParams({ temperature: 0.5, maxTokens: maxTokens }),
    });

    if (!chatResp.ok) {
      const txt = await chatResp.text();
      console.error('[quiz/summary] OpenAI fout:', chatResp.status, txt);
      return { journalEntryId: null, summaryFailed: true, errorReason: `Het taalmodel reageerde met status ${chatResp.status}.` };
    }
    const chatData = await chatResp.json();
    summaryContent = chatData.choices?.[0]?.message?.content;
    if (!summaryContent) {
      return { journalEntryId: null, summaryFailed: true, errorReason: 'Het taalmodel gaf een leeg antwoord.' };
    }
  } catch (chatErr) {
    console.error('[quiz/summary] OpenAI request mislukt:', chatErr.message);
    return { journalEntryId: null, summaryFailed: true, errorReason: chatErr.message };
  }

  const titleTopics = topicsLabel.length > 80 ? `${topicsLabel.slice(0, 77)}...` : topicsLabel;
  const typePrefix = lang !== 'nl'
    ? (qType === 'mcq' ? 'MCQ quiz' : qType === 'open' ? 'Open quiz' : 'Case quiz')
    : (qType === 'mcq' ? 'Meerkeuzequiz' : qType === 'open' ? 'Open quiz' : 'Casusquiz');
  const reflectionLabel = lang === 'nl' ? 'reflectie' : 'reflection';
  const { data: entry, error: journalError } = await supabaseAdmin
    .from('learning_journal_entries')
    .insert({
      user_id: user.id,
      title: `${typePrefix}-${reflectionLabel}: ${titleTopics}`,
      ...journalFieldsFromModel(summaryContent, lang),
      activity_type: 'quiz_reflection',
      course_id: courseId,
    })
    .select('id')
    .single();

  if (journalError) {
    console.error('[quiz/summary] Journal insert error:', journalError);
    return { journalEntryId: null, summaryFailed: true, errorReason: journalError.message };
  }
  console.log(`[quiz/summary] Journal entry aangemaakt: ${entry.id}`);
  return { journalEntryId: entry.id, summaryFailed: false, errorReason: null };
}

export function registerQuizRoutes(app) {
  // /api/quiz/save-summary — schrijft alleen een leerdagboek-notitie op basis
  // van quizgegevens die direct in de body worden meegestuurd. Werkt onafhankelijk
  // van de quiz_attempts-tabel, zodat de student de samenvatting altijd kan
  // bewaren, ook als de quiz_attempts-migratie nog niet is toegepast.
  app.post('/api/quiz/save-summary', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

    const { topics, difficulty, questionType, questions, answers, scorePercentage, lang = 'nl', courseId } = req.body || {};
    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'questions is vereist en mag niet leeg zijn' });
    }
    // Veiligheidsplafond op aantal vragen om abuse op een authenticated
    // OpenAI-genererend endpoint te beperken.
    if (questions.length > 30) {
      return res.status(400).json({ error: 'Te veel vragen (max 30 per samenvatting)' });
    }
    if (!Array.isArray(answers)) {
      return res.status(400).json({ error: 'answers is vereist (array)' });
    }
    if (answers.length !== questions.length) {
      return res.status(400).json({ error: 'answers.length moet gelijk zijn aan questions.length' });
    }
    if (questionType && !['mcq', 'open', 'casus'].includes(questionType)) {
      return res.status(400).json({ error: 'Onbekend questionType' });
    }
    // Per vraagtype: minimale shape-checks zodat de prompt niet leeg loopt.
    const qt = questionType || 'mcq';
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q || typeof q.question !== 'string' || !q.question.trim()) {
        return res.status(400).json({ error: `Vraag ${i + 1} mist een tekstveld` });
      }
      if (qt === 'mcq' && !Array.isArray(q.options)) {
        return res.status(400).json({ error: `Vraag ${i + 1} (mcq) mist options` });
      }
    }
    if (scorePercentage != null) {
      const n = Number(scorePercentage);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({ error: 'scorePercentage moet tussen 0 en 100 liggen' });
      }
    }

    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      if (await rejectIfFeatureOff(res, user, null, courseId, 'journal')) return;
      const params = buildQuizSummaryParams({ topics, difficulty, questionType, questions, answers, scorePercentage, lang });
      const journalCourseId = await resolveJournalCourseId(courseId, user);
      const result = await generateAndSaveQuizSummary({ user, lang, courseId: journalCourseId, ...params });

      if (result.summaryFailed) {
        return res.status(502).json({
          error: 'De samenvatting kon niet worden opgesteld of opgeslagen.',
          detail: result.errorReason,
        });
      }
      return res.json({ success: true, journalEntryId: result.journalEntryId });
    } catch (err) {
      console.error('[quiz/save-summary] Onverwachte fout:', err);
      return res.status(500).json({ error: 'Interne fout', detail: err?.message });
    }
  });

  // Task #265 — net als bij chat (Task #251) is dit een definitieve delete (geen
  // archief/soft-delete). De canonieke route is /api/quiz/delete; de oude
  // /api/quiz/archive blijft als alias bestaan zodat oudere clients niet breken.
  app.post(['/api/quiz/delete', '/api/quiz/archive'], async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    if (!quizAttemptsHasNewSchema) {
      return res.status(503).json({
        error: 'De quiz-database is nog niet bijgewerkt naar het nieuwe model. ' +
          'Pas migratie 20260430120000_extend_quiz_attempts_for_multi_type.sql toe in Supabase en herstart de server.',
      });
    }
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });

    const { attemptId, generateSummary = true, lang = 'nl', courseId } = req.body;
    if (!attemptId) return res.status(400).json({ error: 'attemptId is vereist' });

    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: userError } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (userError || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      const { data: row, error: fetchErr } = await supabaseAdmin
        .from('quiz_attempts')
        .select('id, student_id, topics, difficulty, question_type, questions_data, answers, score_percentage, total_questions, score, created_at')
        .eq('id', attemptId)
        .maybeSingle();

      if (fetchErr) return res.status(500).json({ error: fetchErr.message });
      if (!row) return res.status(404).json({ error: 'Quizpoging niet gevonden' });
      if (row.student_id !== user.id) return res.status(403).json({ error: 'Geen toegang tot deze quizpoging' });

      let journalEntryId = null;
      let summaryFailed = false;

      if (generateSummary && (await courseFeatureOnFor(user, null, courseId, 'journal'))) {
        const params = buildQuizSummaryParams({
          topics: row.topics,
          difficulty: row.difficulty,
          questionType: row.question_type,
          questions: row.questions_data,
          answers: row.answers,
          scorePercentage: row.score_percentage,
          lang,
        });
        const journalCourseId = await resolveJournalCourseId(courseId, user);
        const result = await generateAndSaveQuizSummary({ user, lang, courseId: journalCourseId, ...params });
        journalEntryId = result.journalEntryId;
        summaryFailed = result.summaryFailed;
      }

      // Defense-in-depth: filter ook op student_id, zodat een race-condition
      // tussen ownership-check en delete nooit andermans rij kan raken.
      const { error: delErr } = await supabaseAdmin
        .from('quiz_attempts')
        .delete()
        .eq('id', attemptId)
        .eq('student_id', user.id);

      if (delErr) {
        console.error('[quiz/delete] kon quizpoging niet verwijderen:', delErr);
        return res.status(500).json({ error: `Verwijderen mislukt: ${delErr.message}` });
      }

      return res.json({
        success: true,
        journalEntryId,
        summaryCreated: generateSummary && journalEntryId !== null,
        summaryFailed: generateSummary && summaryFailed,
      });
    } catch (err) {
      console.error('[quiz/delete] Onverwachte fout:', err);
      return res.status(500).json({ error: 'Interne fout' });
    }
  });

  // ---- Endpoints: quiz-prompts -----------------------------------------------
  app.get('/api/admin/quiz-prompts', async (req, res) => {
    const auth = await requireAdminOrDocent(req, res);
    if (!auth) return;
    // Quiz-prompts zijn GLOBAAL (section='quiz', geen course_id): één edit raakt
    // álle cursussen. Daarom voorbehouden aan admin/superuser, niet aan docenten.
    if (auth.role !== 'admin') {
      return res.status(403).json({ error: 'Alleen admin/superuser mag globale quiz-prompts beheren' });
    }
    if (!promptsHasSection) {
      return res.json({ prompts: [], warning: 'chatbot_prompts.section ontbreekt — voer de section-migratie uit.' });
    }
    try {
      const { data, error } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('id, name, content, is_active, updated_at')
        .eq('section', 'quiz')
        .order('name', { ascending: true });
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ prompts: data || [], defaults: QUIZ_PROMPT_DEFAULTS });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/quiz-prompts/:name', async (req, res) => {
    const auth = await requireAdminOrDocent(req, res);
    if (!auth) return;
    // Globale quiz-prompts: alleen admin/superuser mag ze wijzigen (zie GET).
    if (auth.role !== 'admin') {
      return res.status(403).json({ error: 'Alleen admin/superuser mag globale quiz-prompts beheren' });
    }
    const { name } = req.params;
    const { content, is_active } = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(QUIZ_PROMPT_DEFAULTS, name)) {
      return res.status(400).json({ error: `Onbekende quiz-prompt: ${name}` });
    }
    if (typeof content !== 'string' || content.trim().length < 10) {
      return res.status(400).json({ error: 'content is verplicht en minimaal 10 tekens' });
    }
    try {
      const { data: existing } = await supabaseAdmin
        .from('chatbot_prompts')
        .select('id')
        .eq('name', name)
        .maybeSingle();
      if (existing) {
        const { error } = await supabaseAdmin
          .from('chatbot_prompts')
          .update({ content, is_active: is_active !== false })
          .eq('id', existing.id);
        if (error) return res.status(500).json({ error: error.message });
      } else {
        const { error } = await supabaseAdmin.from('chatbot_prompts').insert({
          name, content, is_active: is_active !== false, section: 'quiz',
        });
        if (error) return res.status(500).json({ error: error.message });
      }
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- Endpoints: concept ↔ primaire RAG-folder -------------------------------
  app.get('/api/admin/concept-rag-sources/:courseId', async (req, res) => {
    const auth = await requireAdminOrDocent(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    // Per-cursus staff-check: admin/superuser overal, anders alleen docenten
    // van déze cursus (course_members.member_role='teacher'). Voorkomt dat een
    // teacher-anywhere docent instellingen van een andere cursus wijzigt.
    if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }
    if (!quizSourcesSchemaReady) {
      return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar — pas de migratie toe.' });
    }
    try {
      const { data, error } = await supabaseAdmin
        .from('concept_rag_sources')
        .select('id, concept_id, course_id, folder_id, created_at')
        .eq('course_id', courseId);
      if (error) return res.status(500).json({ error: error.message });
      return res.json({ sources: data || [] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/concept-rag-sources/:courseId', async (req, res) => {
    const auth = await requireAdminOrDocent(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    // Per-cursus staff-check: admin/superuser overal, anders alleen docenten
    // van déze cursus (course_members.member_role='teacher'). Voorkomt dat een
    // teacher-anywhere docent instellingen van een andere cursus wijzigt.
    if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }
    if (!quizSourcesSchemaReady) {
      return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar — pas de migratie toe.' });
    }
    const { sources } = req.body || {};
    if (!Array.isArray(sources)) {
      return res.status(400).json({ error: 'sources moet een array zijn' });
    }
    try {
      await supabaseAdmin
        .from('concept_rag_sources')
        .delete()
        .eq('course_id', courseId);
      const rows = sources
        .filter(s => s && s.concept_id && s.folder_id)
        .map(s => ({
          concept_id: s.concept_id,
          course_id: courseId,
          folder_id: s.folder_id,
          created_by: auth.user.id,
        }));
      if (rows.length > 0) {
        const { error } = await supabaseAdmin.from('concept_rag_sources').insert(rows);
        if (error) return res.status(500).json({ error: error.message });
      }
      return res.json({ success: true, saved: rows.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- Endpoints: bronnen-mix per cursus --------------------------------------
  // `normalizeMix` is verhuisd naar ./quizSourcesMix.js zodat client (preview) en
  // server (persist) dezelfde regels delen en het los unit-testbaar is.

  app.get('/api/quiz-sources-mix/:courseId', async (req, res) => {
    // Lezen mag iedereen die toegang tot de cursus heeft (student of docent in
    // course_members, of admin/superuser).
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    // Per-cursus staff-check: admin/superuser overal, anders alleen docenten
    // van déze cursus (course_members.member_role='teacher'). Voorkomt dat een
    // teacher-anywhere docent instellingen van een andere cursus wijzigt.
    // NB: requireAuthUser levert {user, profile} zonder `role`-veld, dus gebruik
    // isStaffForCourse (kijkt naar profile.role/email) i.p.v. een auth.role-check —
    // anders zou een admin/superuser die geen course_members-teacher is hier 403
    // krijgen en zou de mix in de UI terugvallen op de standaard 50:0:50.
    if (!(await isStaffForCourse(auth.user, auth.profile, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }
    if (!quizSourcesSchemaReady) {
      return res.json({ mix: { pct_rag: 50, pct_itembank: 0, pct_llm: 50 }, schema_ready: false });
    }
    try {
      const { data, error } = await supabaseAdmin
        .from('quiz_sources_mix')
        .select('pct_rag, pct_itembank, pct_llm, updated_at')
        .eq('course_id', courseId)
        .maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      return res.json({
        mix: data ? { pct_rag: data.pct_rag, pct_itembank: data.pct_itembank, pct_llm: data.pct_llm } : { pct_rag: 50, pct_itembank: 0, pct_llm: 50 },
        schema_ready: true,
        updated_at: data?.updated_at,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/admin/quiz-sources-mix/:courseId', async (req, res) => {
    const auth = await requireAdminOrDocent(req, res);
    if (!auth) return;
    const { courseId } = req.params;
    // Per-cursus staff-check: admin/superuser overal, anders alleen docenten
    // van déze cursus (course_members.member_role='teacher'). Voorkomt dat een
    // teacher-anywhere docent instellingen van een andere cursus wijzigt.
    if (auth.role !== 'admin' && !(await isCourseTeacher(auth.user.id, courseId))) {
      return res.status(403).json({ error: 'Geen docent-toegang tot deze cursus' });
    }
    if (!quizSourcesSchemaReady) {
      return res.status(503).json({ error: 'quiz_sources schema niet beschikbaar — pas de migratie toe.' });
    }
    const normalized = normalizeMix(req.body || {});
    try {
      const { data: existing } = await supabaseAdmin
        .from('quiz_sources_mix')
        .select('course_id')
        .eq('course_id', courseId)
        .maybeSingle();
      if (existing) {
        const { error } = await supabaseAdmin
          .from('quiz_sources_mix')
          .update({ ...normalized, updated_at: new Date().toISOString(), updated_by: auth.user.id })
          .eq('course_id', courseId);
        if (error) return res.status(500).json({ error: error.message });
      } else {
        const { error } = await supabaseAdmin
          .from('quiz_sources_mix')
          .insert({ course_id: courseId, ...normalized, updated_by: auth.user.id });
        if (error) return res.status(500).json({ error: error.message });
      }
      return res.json({ success: true, mix: normalized });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- Endpoint: quiz-prompts ophalen voor de generator/evaluator -------------
  // Iedere ingelogde gebruiker mag de actieve quiz-prompts inzien — de UI heeft
  // ze nodig zodat generateQuiz/evaluateOpen de juiste persona meesturen.
  app.get('/api/quiz/prompts', async (req, res) => {
    if (!supabaseAdmin) return res.status(503).json({ error: 'Admin client niet beschikbaar' });
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Authorization header vereist' });
    try {
      const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: { user }, error: uErr } = await userCache.getUser(authHeader, () => callerClient.auth.getUser());
      if (uErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

      const names = Object.keys(QUIZ_PROMPT_DEFAULTS);
      const result = { ...QUIZ_PROMPT_DEFAULTS };
      if (promptsHasSection) {
        const { data } = await supabaseAdmin
          .from('chatbot_prompts')
          .select('name, content, is_active')
          .in('name', names);
        for (const row of data || []) {
          if (row.is_active !== false && typeof row.content === 'string' && row.content.trim().length > 0) {
            result[row.name] = row.content;
          }
        }
      }
      return res.json({ prompts: result });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- Endpoint: per-begrip beschikbaarheid (RAG-docs + ItemBank-vragen) ------
  // Geeft per concept terug hoeveel RAG-documenten er in zijn primaire folder
  // staan en hoeveel itembank-vragen via mappings overeenkomen. De student-UI
  // gebruikt dit om te tonen wat er voor het geselecteerde begrip beschikbaar is.
  app.post('/api/quiz/concept-availability', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, conceptIds = [] } = req.body || {};
    if (!courseId || !Array.isArray(conceptIds) || conceptIds.length === 0) {
      return res.status(400).json({ error: 'courseId en niet-lege conceptIds vereist' });
    }
    // Cross-course leak voorkomen: alleen leden + admins zien availability voor
    // een cursus.
    const hasAccess = await userHasCourseAccess(auth.user, auth.profile, courseId);
    if (!hasAccess) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    if (await rejectIfFeatureOff(res, auth.user, auth.profile, courseId, 'quiz')) return;
    if (!quizSourcesSchemaReady) {
      return res.json({ availability: {}, schema_ready: false });
    }
    try {
      // 1) Primaire RAG-folders per concept
      const { data: ragRows } = await supabaseAdmin
        .from('concept_rag_sources')
        .select('concept_id, folder_id')
        .eq('course_id', courseId)
        .in('concept_id', conceptIds);
      const folderByConcept = new Map((ragRows || []).map(r => [r.concept_id, r.folder_id]));

      // 2) Document-counts per folder
      const folderIds = [...new Set((ragRows || []).map(r => r.folder_id).filter(Boolean))];
      const docCountByFolder = new Map();
      if (folderIds.length > 0) {
        const { data: docs } = await supabaseAdmin
          .from('documents')
          .select('id, folder_id')
          .in('folder_id', folderIds)
          .eq('bucket', 'rag_sources');
        for (const d of docs || []) {
          docCountByFolder.set(d.folder_id, (docCountByFolder.get(d.folder_id) || 0) + 1);
        }
      }

      // 3) ItemBank-mappings per concept
      const { data: mapRows } = await supabaseAdmin
        .from('concept_itembank_sections')
        .select('concept_id, exsection_path, course_id')
        .in('concept_id', conceptIds)
        .or(`course_id.eq.${courseId},course_id.is.null`);

      // Voor performance: één query met alle sharestats-items, daarna in JS
      // case-insensitief groeperen op concept. Geen exacte-string-prefilter
      // (overlaps()) meer omdat de bank case-varianten kent ("Inferential
      // Statistics" vs "inferential statistics"); we matchen op lower-case.
      let allItems = [];
      let itemsTruncated = false;
      const ITEM_HARD_LIMIT = 5000;
      if ((mapRows || []).length > 0) {
        const { data: items, count } = await supabaseAdmin
          .from('quiz_questions')
          .select('id, exsection_path, item_type', { count: 'exact' })
          .or(itembankSourceOrFilter(courseId))
          .not('exsection_path', 'is', null)
          .limit(ITEM_HARD_LIMIT);
        allItems = items || [];
        if (typeof count === 'number' && count > ITEM_HARD_LIMIT) itemsTruncated = true;
      }

      const normPath = (p) => (Array.isArray(p) ? p : []).map(s => String(s ?? '').toLowerCase().trim());
      const itembankCountByConcept = new Map();
      for (const cid of conceptIds) {
        const conceptMaps = (mapRows || []).filter(r => r.concept_id === cid);
        if (conceptMaps.length === 0) { itembankCountByConcept.set(cid, { total: 0, mcq: 0, open: 0 }); continue; }
        const targets = conceptMaps
          .map(m => normPath(m.exsection_path))
          .filter(p => p.length > 0);
        let total = 0, mcq = 0, open = 0;
        for (const item of allItems) {
          const qPath = normPath(item.exsection_path);
          const match = targets.some(target => {
            if (qPath.length < target.length) return false;
            for (let i = 0; i < target.length; i++) if (qPath[i] !== target[i]) return false;
            return true;
          });
          if (match) {
            total++;
            if (item.item_type === 'open') open++;
            else mcq++;
          }
        }
        itembankCountByConcept.set(cid, { total, mcq, open });
      }

      // 4) Compose result. Wanneer de itembank-prefilter de hard-limit raakte,
      // markeren we per concept dat de count een ondergrens is — zodat de UI
      // dat niet als exact getal presenteert.
      const availability = {};
      for (const cid of conceptIds) {
        const fId = folderByConcept.get(cid) || null;
        const ibCounts = itembankCountByConcept.get(cid) || { total: 0, mcq: 0, open: 0 };
        availability[cid] = {
          primary_folder_id: fId,
          rag_doc_count: fId ? (docCountByFolder.get(fId) || 0) : null,
          itembank_question_count: ibCounts.total,
          itembank_mcq_count: ibCounts.mcq,
          itembank_open_count: ibCounts.open,
          itembank_count_truncated: itemsTruncated,
        };
      }
      return res.json({ availability, schema_ready: true, truncated: itemsTruncated });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---- Endpoint: primaire RAG-folder-IDs voor concept-set ---------------------
  // Wordt gebruikt door de RAG-search om eerst binnen die folders te zoeken.
  app.post('/api/quiz/primary-rag-folders', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const { courseId, conceptIds = [] } = req.body || {};
    if (!courseId || !Array.isArray(conceptIds) || conceptIds.length === 0) {
      return res.json({ folderIds: [] });
    }
    // Cross-course leak voorkomen.
    const hasAccess = await userHasCourseAccess(auth.user, auth.profile, courseId);
    if (!hasAccess) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
    if (!quizSourcesSchemaReady) {
      return res.json({ folderIds: [], schema_ready: false });
    }
    try {
      const { data, error } = await supabaseAdmin
        .from('concept_rag_sources')
        .select('folder_id')
        .eq('course_id', courseId)
        .in('concept_id', conceptIds);
      if (error) return res.status(500).json({ error: error.message });
      const folderIds = [...new Set((data || []).map(r => r.folder_id).filter(Boolean))];
      return res.json({ folderIds, schema_ready: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}
