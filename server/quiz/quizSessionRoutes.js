// Quiz op de server (2026-11-12): samenstellen, nakijken en afronden.
//
//   POST /api/quiz/sessions              quiz samenstellen; voortgang als NDJSON.
//                                        De browser krijgt de vragen zonder sleutel.
//   POST /api/quiz/sessions/:id/answer   één antwoord nakijken; het eerste antwoord
//                                        telt. Pas dan komen antwoord en uitleg mee.
//   POST /api/quiz/sessions/:id/finish   afronden: poging bewaren (quiz_attempts),
//                                        badges toekennen (learningBadges.js).
//
// Een docent kan in "Klaar voor studenten?" een vraag uitproberen (tryout): dan
// komt de vraag met sleutel terug en wordt er niets bewaard.

import { awardBadges, conceptResults, dayOf, quizBadges } from '../achievements/learningBadges.js';
import { buildLanguageInstruction } from '../i18n/languages.js';
import { translateServerMessage } from '../i18n/serverI18n.js';
import { isStaffForCourse, requireAuthUser, userHasCourseAccess } from '../lib/auth.js';
import { AZURE_CHAT_READY, LLM_NOT_CONFIGURED_MSG, OPENAI_MODEL, chatModelParams, openaiChatCompletion } from '../lib/azureOpenai.js';
import { courseRagFolderIds } from '../lib/courseData.js';
import { rejectIfFeatureOff } from '../lib/courseFeatureGate.js';
import { quizSourcesSchemaReady } from '../lib/schemaFlags.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { resolveChatPromptMode } from '../prompts/promptStore.js';
import { loadCourseContext } from '../rag/courseContext.js';
import { loadRagSettings } from '../rag/search.js';
import { pickItembankQuestions } from './itembankPick.js';
import {
  EVALUATE_MAX_TOKENS, EVALUATE_PROMPT_MODE, EVALUATE_TEMPERATURE, MAX_ANSWER_CHARS,
  buildEvaluationPrompt, gradeMcq, gradeNumeric, isNumericQuestion, parseEvaluation,
} from './quizEvaluate.js';
import {
  DIFFICULTIES, QUESTION_TYPES, QUIZ_GENERATION_TEMPERATURE,
  buildGenerationPrompt, convertItembankMcqQuestion, convertItembankOpenQuestion,
  generationMaxTokens, parseGeneratedQuestions, publicQuestion, revealQuestion,
} from './quizQuestions.js';
import { MAX_QUESTIONS, composeQuiz, questionForHistory, scoreQuiz } from './quizSession.js';
import { DEFAULT_MIX, normalizeMix } from './quizSourcesMix.js';
import { VERIFY_PROMPT_MODE, VERIFY_TEMPERATURE } from './quizVerify.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuidList = (v, max) => Array.isArray(v) && v.length <= max && v.every(x => typeof x === 'string' && UUID_RE.test(x));
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

/** Taalmodel voor de quiz, met de beheerde quizprompt als systeemtekst (zoals /api/chat met promptMode). */
function quizLlm({ user, profile, courseId, lang }) {
  const prompts = new Map();
  const systemFor = (mode) => {
    if (!prompts.has(mode)) prompts.set(mode, resolveChatPromptMode(mode, { user, profile, courseId }).catch(() => null));
    return prompts.get(mode);
  };
  return async ({ prompt, mode, temperature, maxTokens }) => {
    const system = `${(await systemFor(mode)) || ''}${buildLanguageInstruction(lang)}`.trim();
    const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
    const r = await openaiChatCompletion({ model: OPENAI_MODEL, messages, ...chatModelParams({ temperature, maxTokens }) }, { timeoutMs: 120_000 });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw Object.assign(new Error(`Het taalmodel gaf een fout (HTTP ${r.status}).`), { status: r.status, detail: detail.slice(0, 300) });
    }
    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content || '';
    if (!content.trim()) {
      throw Object.assign(new Error('Het taalmodel gaf een leeg antwoord.'), { status: 502, code: data?.choices?.[0]?.finish_reason === 'length' ? 'length' : 'empty_response' });
    }
    return content;
  };
}

async function loadMix(courseId) {
  if (!quizSourcesSchemaReady) return DEFAULT_MIX;
  const { data } = await supabaseAdmin.from('quiz_sources_mix').select('pct_rag, pct_itembank, pct_llm').eq('course_id', courseId).maybeSingle();
  return data ? normalizeMix(data) : DEFAULT_MIX;
}

/** Sessie van deze student (null als hij niet bestaat of van iemand anders is). */
async function loadOwnSession(id, userId) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const { data } = await supabaseAdmin.from('quiz_sessions').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
  return data || null;
}

/**
 * De eigen sessie, en de student mag nog bij de cursus en de quiz staat aan
 * (iemand die uit de cursus is gehaald, gaat niet verder met een lopende quiz).
 * Stuurt zelf de foutmelding; geeft dan null.
 */
async function ownSessionOrReject(req, res, auth) {
  const session = await loadOwnSession(req.params.id, auth.user.id);
  if (!session) { res.status(404).json({ error: 'Deze quiz bestaat niet (meer)' }); return null; }
  if (!(await userHasCourseAccess(auth.user, auth.profile, session.course_id))) { res.status(403).json({ error: 'Geen toegang tot deze cursus' }); return null; }
  if (await rejectIfFeatureOff(res, auth.user, auth.profile, session.course_id, 'quiz')) return null;
  return session;
}

async function loadAnswers(sessionId) {
  const { data } = await supabaseAdmin.from('quiz_session_answers').select('question_index, answer').eq('session_id', sessionId);
  const out = [];
  for (const r of data || []) out[r.question_index] = r.answer;
  return out;
}

export function registerQuizSessionRoutes(app) {
  app.post('/api/quiz/sessions', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
    const { courseId, conceptIds, difficulty, questionType, numQuestions, chunkIds = [], lang = 'nl', tryout = false } = req.body || {};
    if (typeof courseId !== 'string' || !UUID_RE.test(courseId)) return res.status(400).json({ error: 'courseId is vereist' });
    if (!isUuidList(conceptIds, 20) || conceptIds.length === 0) return res.status(400).json({ error: 'Kies minstens één onderwerp' });
    if (!DIFFICULTIES.includes(difficulty) || !QUESTION_TYPES.includes(questionType)) return res.status(400).json({ error: 'Ongeldige instellingen voor de quiz' });
    const count = Number(numQuestions);
    if (!Number.isInteger(count) || count < 1 || count > MAX_QUESTIONS[questionType]) return res.status(400).json({ error: 'Ongeldig aantal vragen' });
    if (!isUuidList(chunkIds, 200)) return res.status(400).json({ error: 'Ongeldige fragmenten' });

    const staff = await isStaffForCourse(auth.user, auth.profile, courseId);
    if (tryout === true) {
      if (!staff) return res.status(403).json({ error: 'Alleen voor docenten van deze cursus' });
    } else {
      if (!(await userHasCourseAccess(auth.user, auth.profile, courseId))) return res.status(403).json({ error: 'Geen toegang tot deze cursus' });
      if (await rejectIfFeatureOff(res, auth.user, auth.profile, courseId, 'quiz')) return;
    }

    // Alleen begrippen van deze cursus (of algemene); studenten alleen goedgekeurde.
    const { data: rows, error: cErr } = await supabaseAdmin.from('concepts').select('id, name, course_id, review_status').in('id', conceptIds);
    if (cErr) {
      console.error('[quiz/sessions] begrippen laden mislukt:', cErr.message);
      return res.status(500).json({ error: 'De quiz kon niet worden gemaakt. Probeer het opnieuw.' });
    }
    const concepts = conceptIds
      .map(id => (rows || []).find(c => c.id === id))
      .filter(c => c && (c.course_id === courseId || c.course_id == null) && (staff || c.review_status == null || c.review_status === 'approved'))
      .map(c => ({ id: c.id, name: c.name }));
    if (concepts.length !== conceptIds.length) return res.status(404).json({ error: 'Begrip niet gevonden' });

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    let gone = false;
    res.on('close', () => { gone = true; });
    const emit = (event) => {
      if (gone) return;
      try {
        const out = typeof event.error === 'string' ? { ...event, error: translateServerMessage(event.error, req.get('x-leap-lang')) } : event;
        res.write(`${JSON.stringify(out)}\n`);
        if (typeof res.flush === 'function') res.flush();
      } catch { gone = true; }
    };
    const heartbeat = setInterval(() => emit({ type: 'ping' }), 15_000);
    heartbeat.unref?.();

    try {
      const [ctx, settings, mix] = await Promise.all([
        loadCourseContext(supabaseAdmin, { courseId, chunkIds, courseFolderIds: courseRagFolderIds, module: 'quiz' }),
        loadRagSettings(courseId),
        tryout === true ? Promise.resolve({ pct_rag: 100, pct_itembank: 0, pct_llm: 0 }) : loadMix(courseId),
      ]);
      const strict = settings?.quiz?.rag_strict_mode !== false;
      const llm = quizLlm({ user: auth.user, profile: auth.profile, courseId, lang });
      const topics = concepts.map(c => c.name);
      const result = await composeQuiz({
        concepts, questionType, count, ragContext: ctx.context, mix,
        generate: async (source, n) => parseGeneratedQuestions(await llm({
          prompt: buildGenerationPrompt({ topics, difficulty, questionType, count: n, ragContext: source === 'rag' ? ctx.context : undefined, strict: source === 'rag' && strict, lang }),
          mode: source === 'rag' ? (strict ? 'quiz_generate_strict' : 'quiz_generate_blended') : 'quiz_generate_creative',
          temperature: QUIZ_GENERATION_TEMPERATURE,
          maxTokens: generationMaxTokens(questionType),
        }), questionType),
        pickItembank: async (n) => (await pickItembankQuestions({ courseId, conceptIds, limit: n, questionType }))
          .map(q => (q.type === 'open' ? convertItembankOpenQuestion(q) : convertItembankMcqQuestion(q))),
        ask: (prompt, maxTokens) => llm({ prompt, mode: VERIFY_PROMPT_MODE, temperature: VERIFY_TEMPERATURE, maxTokens }),
        onProgress: (p) => emit({ type: 'progress', ...p }),
      });
      const contextStats = { used: ctx.usedChunks, total: ctx.totalChunks, charTrimmed: ctx.charTrimmed };
      const base = { type: 'done', status: result.status, counts: result.counts, verification: result.verification, contextStats };
      if (result.status !== 'ok') return emit(base);
      if (tryout === true) return emit({ ...base, questions: result.questions.map(questionForHistory) });

      // Opruimen: niet afgemaakte quizzen van deze student van langer dan een dag geleden.
      void supabaseAdmin.from('quiz_sessions').delete().eq('user_id', auth.user.id).eq('status', 'active')
        .lt('created_at', new Date(Date.now() - STALE_SESSION_MS).toISOString())
        .then(({ error }) => { if (error) console.warn('[quiz] opruimen mislukt:', error.message); });
      const { data: session, error: sErr } = await supabaseAdmin.from('quiz_sessions').insert({
        user_id: auth.user.id, course_id: courseId, concept_ids: conceptIds, topics,
        difficulty, question_type: questionType, questions: result.questions,
      }).select('id').single();
      if (sErr) throw new Error(sErr.message);
      emit({ ...base, sessionId: session.id, questions: result.questions.map(publicQuestion) });
    } catch (err) {
      console.error('[quiz/sessions] samenstellen mislukt:', err?.message || err);
      emit({ type: 'error', error: 'De quiz kon niet worden gemaakt. Probeer het opnieuw.' });
    } finally {
      clearInterval(heartbeat);
      if (!gone) res.end();
    }
  });

  app.post('/api/quiz/sessions/:id/answer', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const session = await ownSessionOrReject(req, res, auth);
    if (!session) return;
    if (session.status !== 'active') return res.status(409).json({ error: 'Deze quiz is al afgerond' });
    const index = Number(req.body?.index);
    const q = Number.isInteger(index) ? session.questions[index] : null;
    if (!q) return res.status(400).json({ error: 'Onbekende vraag' });

    const reply = (answer) => res.json({ answer, reveal: revealQuestion(q) });
    const { data: existing } = await supabaseAdmin.from('quiz_session_answers').select('answer')
      .eq('session_id', session.id).eq('question_index', index).maybeSingle();
    if (existing) return reply(existing.answer);

    let answer;
    if (q.type === 'mcq') {
      const selected = Number(req.body?.selectedIndex);
      if (!Number.isInteger(selected) || selected < 0 || selected >= q.options.length) return res.status(400).json({ error: 'Kies een antwoord' });
      answer = gradeMcq(q, selected);
    } else {
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      if (!text) return res.status(400).json({ error: 'Schrijf eerst een antwoord' });
      if (text.length > MAX_ANSWER_CHARS) return res.status(400).json({ error: 'Je antwoord is te lang' });
      if (isNumericQuestion(q)) {
        answer = { type: q.type, text, evaluation: gradeNumeric(q, text) };
      } else {
        if (!AZURE_CHAT_READY) return res.status(503).json({ error: LLM_NOT_CONFIGURED_MSG });
        try {
          const llm = quizLlm({ user: auth.user, profile: auth.profile, courseId: session.course_id, lang: req.body?.lang || 'nl' });
          const content = await llm({ prompt: buildEvaluationPrompt(q, text, req.body?.lang || 'nl'), mode: EVALUATE_PROMPT_MODE, temperature: EVALUATE_TEMPERATURE, maxTokens: EVALUATE_MAX_TOKENS });
          answer = { type: q.type, text, evaluation: parseEvaluation(content) };
        } catch (err) {
          console.warn('[quiz/answer] beoordelen mislukt:', err?.message || err);
          return res.status(502).json({ error: 'Je antwoord kon niet worden beoordeeld. Probeer het opnieuw.', code: err?.code });
        }
      }
    }
    // Het eerste antwoord telt: komt er gelijktijdig een ander binnen, dan geldt dat.
    const { error } = await supabaseAdmin.from('quiz_session_answers').insert({ session_id: session.id, question_index: index, answer });
    if (error) {
      if (error.code !== '23505') {
        console.error('[quiz/answer] bewaren mislukt:', error.message);
        return res.status(500).json({ error: 'Je antwoord kon niet worden bewaard. Probeer het opnieuw.' });
      }
      const { data: first } = await supabaseAdmin.from('quiz_session_answers').select('answer')
        .eq('session_id', session.id).eq('question_index', index).maybeSingle();
      return reply(first?.answer || answer);
    }
    return reply(answer);
  });

  app.post('/api/quiz/sessions/:id/finish', async (req, res) => {
    const auth = await requireAuthUser(req, res);
    if (!auth) return;
    const session = await ownSessionOrReject(req, res, auth);
    if (!session) return;
    const questions = session.questions;
    const answers = await loadAnswers(session.id);
    if (session.status === 'finished') {
      return res.json({ attemptId: session.attempt_id, scorePercentage: session.score_percentage, badges: [] });
    }
    if (questions.some((_, i) => !answers[i])) return res.status(400).json({ error: 'Beantwoord eerst alle vragen' });

    const score = scoreQuiz(questions, answers);
    const results = conceptResults(questions, answers);
    const finishedAt = new Date().toISOString();
    // Eén keer afronden, ook bij een dubbele klik.
    const { data: claimed } = await supabaseAdmin.from('quiz_sessions')
      .update({ status: 'finished', score_percentage: score.pct, concept_results: results, finished_at: finishedAt })
      .eq('id', session.id).eq('status', 'active').select('id');
    if (!claimed?.length) return res.json({ attemptId: null, scorePercentage: score.pct, badges: [] });

    const { data: attempt, error: aErr } = await supabaseAdmin.from('quiz_attempts').insert({
      student_id: auth.user.id,
      course_id: session.course_id,
      topics: session.topics,
      difficulty: session.difficulty,
      question_type: session.question_type,
      questions_data: questions.map(questionForHistory),
      answers,
      score: session.question_type === 'mcq' ? score.correct : score.pct,
      total_questions: questions.length,
      score_percentage: score.pct,
    }).select('id').single();
    if (aErr) console.warn('[quiz/finish] poging bewaren mislukt:', aErr.message);
    else await supabaseAdmin.from('quiz_sessions').update({ attempt_id: attempt.id }).eq('id', session.id);

    let badges = [];
    try {
      const { data: earlier } = await supabaseAdmin.from('quiz_sessions')
        .select('finished_at, concept_results')
        .eq('user_id', auth.user.id).eq('course_id', session.course_id).eq('status', 'finished')
        .neq('id', session.id).order('finished_at', { ascending: false }).limit(200);
      const names = new Map(session.concept_ids.map((id, i) => [id, session.topics[i]]));
      const found = quizBadges({
        questionType: session.question_type, difficulty: session.difficulty, total: questions.length, pct: score.pct, results,
        history: (earlier || []).map(h => ({ day: dayOf(h.finished_at), results: h.concept_results || {} })),
        today: dayOf(finishedAt),
      });
      badges = await awardBadges(supabaseAdmin, {
        userId: auth.user.id,
        courseId: session.course_id,
        badges: found.map(b => ({ ...b, label: names.get(b.conceptId) || null, details: { quiz_session_id: session.id, difficulty: session.difficulty, score: score.pct } })),
      });
    } catch (err) {
      console.warn('[quiz/finish] badges mislukt:', err?.message || err);
    }
    return res.json({ attemptId: attempt?.id || null, scorePercentage: score.pct, badges });
  });
}
