// Quiz op de server (2026-11-12): vragen maken, controleren, samenstellen en
// nakijken. De controle- en samenstellingstests kwamen uit de browser
// (src/services/__tests__/quizVerification.test.ts) en gelden ongewijzigd.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  verifyGeneratedQuestion, checkItembankFit, buildSolvePrompt, verifyQuestions, MAX_REPAIR_ROUNDS,
} from '../quiz/quizVerify.js';
import {
  checkQuestionStructure, buildGenerationPrompt, parseGeneratedQuestions, publicQuestion, revealQuestion,
  conceptForQuestion, convertItembankMcqQuestion, QUIZ_GENERATION_TEMPERATURE,
} from '../quiz/quizQuestions.js';
import { composeQuiz, scoreQuiz, MAX_FILL_ROUNDS, questionForHistory } from '../quiz/quizSession.js';
import { gradeMcq, gradeNumeric, parseEvaluation, EVALUATE_TEMPERATURE } from '../quiz/quizEvaluate.js';
import { distributeMix } from '../quiz/quizSourcesMix.js';
import { itembankRowToQuestion, pathUnder } from '../quiz/itembankPick.js';
import { functionSource, routeSource } from './helpers/serverSource.js';

const RAG = 'Cursusmateriaal: Het relatief risico (RR) is de incidentie bij blootgestelden gedeeld door de incidentie bij niet-blootgestelden.';
const TOPICS = ['Relatief risico'];
const MCQ = {
  type: 'mcq',
  question: 'Hoe bereken je het relatief risico?',
  options: [
    'Incidentie blootgestelden / incidentie niet-blootgestelden',
    'Incidentie blootgestelden − incidentie niet-blootgestelden',
    'Odds blootgestelden / odds niet-blootgestelden',
    'Prevalentie / incidentie',
  ],
  correctAnswer: 0,
  explanation: 'Je deelt de incidentie bij blootgestelden door die bij niet-blootgestelden: GEHEIME_UITLEG.',
  source: 'llm',
};
const isSolve = (p) => p.includes('bewust NIET te zien');
const isCompare = (p) => p.includes('Vergelijk jouw uitwerking');
const SOLVE_OK = { answerable: true, answerIndex: 0, answer: 'A', reasoning: 'RR = I1/I0', problems: '' };
const COMPARE_OK = { verdict: 'consistent', fitsCourse: true, discrepancy: '', repairedQuestion: null };

/** Nep-taalmodel voor de controle: `solve` en `compare` bepalen per ronde het antwoord. */
function fakeAsk(script) {
  let solves = 0;
  let compares = 0;
  const prompts = [];
  const ask = vi.fn(async (p) => {
    prompts.push(p);
    if (isSolve(p)) return JSON.stringify(script.solve(p, solves++));
    if (isCompare(p)) return JSON.stringify(script.compare(p, compares++));
    throw new Error('onverwachte prompt');
  });
  return { ask, prompts };
}
const opts = (ask, ...rest) => ({ ragContext: rest.length ? rest[0] : RAG, topics: TOPICS, ask });

describe('structuur van een vraag', () => {
  it('keurt een geldige MCQ goed en ongeldige af', () => {
    expect(checkQuestionStructure(MCQ)).toBeNull();
    expect(checkQuestionStructure({ ...MCQ, options: MCQ.options.slice(0, 3) })).toMatch(/4 opties/);
    expect(checkQuestionStructure({ ...MCQ, correctAnswer: 4 })).toMatch(/antwoordindex/);
    expect(checkQuestionStructure({ ...MCQ, options: ['x', 'X', 'y', 'z'] })).toMatch(/dubbele/);
    expect(checkQuestionStructure({ type: 'open', question: 'Leg uit.', modelAnswer: '', rubric: '- punt' })).toMatch(/modelantwoord/);
  });
});

describe('controle: blind oplossen en vergelijken', () => {
  it('lost BLIND op: geen officieel antwoord of uitleg in de oplosprompt', () => {
    const p = buildSolvePrompt(MCQ, RAG, TOPICS);
    expect(p).not.toContain('GEHEIME_UITLEG');
    expect(p).not.toContain('correctAnswer');
    expect(p).toContain(RAG);
    expect(p).toMatch(/zeer kritische toetsdeskundige/);
  });
  it('accepteert als eigen antwoord en officiële feedback overeenkomen; eerst oplossen, dan vergelijken', async () => {
    const { ask, prompts } = fakeAsk({ solve: () => SOLVE_OK, compare: () => COMPARE_OK });
    const out = await verifyGeneratedQuestion(MCQ, opts(ask));
    expect(out.status).toBe('accepted');
    expect(out.question).toEqual(MCQ);
    expect(isSolve(prompts[0])).toBe(true);
    expect(isCompare(prompts[1])).toBe(true);
    expect(prompts[1]).toContain('GEHEIME_UITLEG');
  });
  it('een afwijkend MCQ-antwoord is altijd "major" en de vraag wordt verbeterd en opnieuw gecontroleerd', async () => {
    const repaired = { ...MCQ, correctAnswer: 2, explanation: 'Verbeterde uitleg.' };
    const { ask, prompts } = fakeAsk({
      solve: () => ({ ...SOLVE_OK, answerIndex: 2, answer: 'C' }),
      compare: (_p, n) => (n === 0 ? { ...COMPARE_OK, repairedQuestion: repaired } : COMPARE_OK),
    });
    const out = await verifyGeneratedQuestion(MCQ, opts(ask));
    expect(prompts[1]).toMatch(/per definitie "major"/);
    expect(out.status).toBe('repaired');
    expect(out.question.correctAnswer).toBe(2);
    expect(out.question.source).toBe('llm');
    expect(ask).toHaveBeenCalledTimes(4);
  });
  it('een vraag die niet bij de cursus past wordt afgekeurd', async () => {
    const { ask } = fakeAsk({ solve: () => SOLVE_OK, compare: () => ({ ...COMPARE_OK, fitsCourse: false, discrepancy: 'gaat over regressie, niet in materiaal' }) });
    const out = await verifyGeneratedQuestion(MCQ, opts(ask));
    expect(out.status).toBe('rejected');
    expect(out.reason).toMatch(/regressie/);
  });
  it('afgekeurd bij een discrepantie zonder bruikbare verbetering, of als de vraag niet eenduidig is', async () => {
    const a = fakeAsk({ solve: () => SOLVE_OK, compare: () => ({ ...COMPARE_OK, verdict: 'discrepancy', discrepancy: 'uitleg spreekt antwoord tegen' }) });
    expect((await verifyGeneratedQuestion(MCQ, opts(a.ask))).reason).toMatch(/uitleg spreekt antwoord tegen/);
    const b = fakeAsk({ solve: () => ({ ...SOLVE_OK, answerable: false, problems: 'twee opties juist' }), compare: () => COMPARE_OK });
    expect((await verifyGeneratedQuestion(MCQ, opts(b.ask))).status).toBe('rejected');
  });
  it('stopt na MAX_REPAIR_ROUNDS verbeterrondes', async () => {
    const { ask } = fakeAsk({ solve: () => ({ ...SOLVE_OK, answerIndex: 1 }), compare: () => ({ ...COMPARE_OK, verdict: 'discrepancy', discrepancy: 'blijft fout', repairedQuestion: { ...MCQ } }) });
    expect((await verifyGeneratedQuestion(MCQ, opts(ask))).status).toBe('rejected');
    expect(ask).toHaveBeenCalledTimes(2 * (MAX_REPAIR_ROUNDS + 1));
  });
  it('"minor": goedgekeurd, met terugval op het origineel als de verbetering afgekeurd wordt', async () => {
    const a = fakeAsk({ solve: () => SOLVE_OK, compare: () => ({ ...COMPARE_OK, verdict: 'minor', discrepancy: 'rubric sluit niet helemaal aan' }) });
    expect(await verifyGeneratedQuestion(MCQ, opts(a.ask))).toMatchObject({ status: 'accepted', question: MCQ });
    const worse = { ...MCQ, correctAnswer: 3 };
    const b = fakeAsk({
      solve: () => SOLVE_OK,
      compare: (_p, n) => (n === 0 ? { ...COMPARE_OK, verdict: 'minor', discrepancy: 'kan beter', repairedQuestion: worse } : { ...COMPARE_OK, verdict: 'major', discrepancy: 'fout' }),
    });
    expect(await verifyGeneratedQuestion(MCQ, opts(b.ask))).toMatchObject({ status: 'accepted', question: MCQ });
    const better = { ...MCQ, explanation: 'Betere uitleg.' };
    const c = fakeAsk({ solve: () => SOLVE_OK, compare: (_p, n) => (n === 0 ? { ...COMPARE_OK, verdict: 'minor', repairedQuestion: better } : COMPARE_OK) });
    const out = await verifyGeneratedQuestion(MCQ, opts(c.ask));
    expect(out.status).toBe('repaired');
    expect(out.question.explanation).toBe('Betere uitleg.');
  });
  it('technische fouten tellen apart (failed), met één herkansing', async () => {
    const boom = vi.fn(async () => { throw Object.assign(new Error('Server error'), { status: 500 }); });
    const report = await verifyQuestions([MCQ], 'generated', opts(boom));
    expect(report.kept).toHaveLength(0);
    expect(report.rejected).toHaveLength(0);
    expect(report.failed).toHaveLength(1);
    expect(boom).toHaveBeenCalledTimes(2);
  });
  it('herstelt van een tijdelijke 429 met één herkansing', async () => {
    let first = true;
    const inner = fakeAsk({ solve: () => SOLVE_OK, compare: () => COMPARE_OK });
    const ask = vi.fn(async (p, n) => {
      if (first) { first = false; throw Object.assign(new Error('rate limit'), { status: 429 }); }
      return inner.ask(p, n);
    });
    expect((await verifyGeneratedQuestion(MCQ, opts(ask))).status).toBe('accepted');
  });
  it('zonder taalmodel afgekeurd bij een ongeldige vraag of zonder cursusmateriaal', async () => {
    const ask = vi.fn();
    expect((await verifyGeneratedQuestion({ ...MCQ, options: ['a', 'b'] }, opts(ask))).status).toBe('rejected');
    for (const ragContext of [undefined, '', '   ']) {
      const out = await verifyGeneratedQuestion(MCQ, opts(ask, ragContext));
      expect(out.status).toBe('rejected');
      expect(out.reason).toMatch(/cursusmateriaal/);
    }
    expect(ask).not.toHaveBeenCalled();
  });
  it('fail-closed: onleesbaar of mislukt controle-antwoord → afgekeurd', async () => {
    expect((await verifyGeneratedQuestion(MCQ, opts(vi.fn(async () => 'geen json')))).status).toBe('rejected');
    expect((await verifyGeneratedQuestion(MCQ, opts(vi.fn(async () => { throw new Error('503'); })))).status).toBe('rejected');
  });
  it('ItemBank: alleen een passendheidscheck, afgekeurd als hij niet past of zonder materiaal', async () => {
    const ask = vi.fn(async (p) => {
      expect(isSolve(p)).toBe(false);
      expect(p).toContain(RAG);
      return JSON.stringify({ fits: false, reason: 'gaat over regressie' });
    });
    expect((await checkItembankFit({ ...MCQ, source: 'itembank' }, opts(ask))).status).toBe('rejected');
    expect(ask).toHaveBeenCalledTimes(1);
    const none = vi.fn();
    expect((await checkItembankFit(MCQ, opts(none, undefined))).status).toBe('rejected');
    expect(none).not.toHaveBeenCalled();
  });
});

describe('quiz samenstellen volgens de mix', () => {
  const variant = (n) => ({ ...MCQ, question: `${MCQ.question} (variant ${n})`, source: undefined });
  function setup({ verdictFor = () => 'ok', gen } = {}) {
    let generated = 0;
    const calls = [];
    const generate = vi.fn(async (source, n) => { calls.push({ source, n }); return gen ? gen(n) : Array.from({ length: n }, () => variant(++generated)); });
    const ask = vi.fn(async (p) => {
      if (isSolve(p)) return JSON.stringify(SOLVE_OK);
      if (isCompare(p)) return JSON.stringify(verdictFor(p) === 'ok' ? COMPARE_OK : { ...COMPARE_OK, verdict: 'discrepancy', discrepancy: 'fout' });
      return JSON.stringify({ fits: true, reason: 'past' });
    });
    const pickItembank = vi.fn(async () => [convertItembankMcqQuestion({
      question: 'Itembank: wat is RR?', options: { A: 'I1/I0', B: 'I1−I0', C: 'odds', D: 'prevalentie' }, correctAnswer: 'A', explanation: 'Zie hoofdstuk 3.', conceptId: 'c1',
    })]);
    return { generate, ask, pickItembank, calls };
  }
  const base = { concepts: [{ id: 'c1', name: 'Relatief risico' }], questionType: 'mcq', ragContext: RAG };

  it('controleert vragen uit materiaal en creatieve vragen volledig, ItemBank op passendheid; elke vraag krijgt zijn begrip', async () => {
    const s = setup();
    const r = await composeQuiz({ ...base, count: 3, mix: { pct_rag: 34, pct_itembank: 33, pct_llm: 33 }, ...s });
    expect(r.status).toBe('ok');
    expect(r.counts).toEqual({ rag: 1, itembank: 1, llm: 1 });
    expect(r.verification).toEqual({ accepted: 3, repaired: 0, rejected: 0, failed: 0 });
    const prompts = s.ask.mock.calls.map(c => c[0]);
    expect(prompts.filter(isSolve)).toHaveLength(2);
    expect(prompts.filter(isCompare)).toHaveLength(2);
    expect(prompts.filter(p => !isSolve(p) && !isCompare(p))).toHaveLength(1);
    for (const p of prompts) expect(p).toContain(RAG);
    expect(r.questions.every(q => q.conceptId === 'c1')).toBe(true);
    expect(new Set(r.questions.map(q => q.source))).toEqual(new Set(['rag', 'itembank', 'llm']));
  });
  it('vervangt afgekeurde vragen tot precies het gevraagde aantal, zonder dubbele', async () => {
    const s = setup({ verdictFor: (p) => (/variant [12]\)/.test(p) ? 'reject' : 'ok') });
    const r = await composeQuiz({ ...base, count: 4, mix: { pct_rag: 100, pct_itembank: 0, pct_llm: 0 }, ...s });
    expect(r.status).toBe('ok');
    expect(r.questions).toHaveLength(4);
    expect(r.verification.rejected).toBe(2);
    expect(s.calls.map(c => c.n)).toEqual([4, 2]);
    const same = setup({ gen: (n) => Array.from({ length: n }, () => variant(1)) });
    const r2 = await composeQuiz({ ...base, count: 2, mix: { pct_rag: 100, pct_itembank: 0, pct_llm: 0 }, ...same });
    expect(r2.questions).toHaveLength(1);
    expect(r2.status).toBe('shortfall');
  });
  it('meldt een tekort na een begrensd aantal rondes', async () => {
    const s = setup({ verdictFor: () => 'reject' });
    const r = await composeQuiz({ ...base, count: 2, mix: { pct_rag: 50, pct_itembank: 0, pct_llm: 50 }, ...s });
    expect(r.status).toBe('shortfall');
    expect(r.questions).toHaveLength(0);
    expect(s.generate.mock.calls.length).toBeLessThanOrEqual(4 * MAX_FILL_ROUNDS);
  });
  it('zonder passend cursusmateriaal geen enkele vraag en geen taalmodel', async () => {
    for (const ragContext of [undefined, '']) {
      const s = setup();
      const r = await composeQuiz({ ...base, ragContext, count: 3, mix: { pct_rag: 34, pct_itembank: 33, pct_llm: 33 }, ...s });
      expect(r.status).toBe('no_course_material');
      expect(s.generate).not.toHaveBeenCalled();
      expect(s.ask).not.toHaveBeenCalled();
      expect(s.pickItembank).not.toHaveBeenCalled();
    }
  });
  it('voortgang: schrijven → controleren → klaar, nooit dalend; een fout in de voortgang breekt niets', async () => {
    const events = [];
    const s = setup();
    const r = await composeQuiz({ ...base, count: 2, mix: { pct_rag: 100, pct_itembank: 0, pct_llm: 0 }, ...s, onProgress: e => events.push(e) });
    expect(r.status).toBe('ok');
    expect(events[0].phase).toBe('writing');
    expect(events.map(e => e.phase)).toContain('checking');
    expect(events.at(-1)).toMatchObject({ phase: 'done', approved: 2 });
    for (let i = 1; i < events.length; i++) expect(events[i].approved).toBeGreaterThanOrEqual(events[i - 1].approved);
    const t = setup();
    expect((await composeQuiz({ ...base, count: 1, mix: { pct_rag: 100, pct_itembank: 0, pct_llm: 0 }, ...t, onProgress: () => { throw new Error('UI stuk'); } })).status).toBe('ok');
  });
  it('de mix: bij casus gaat het ItemBank-deel naar de creatieve vragen', () => {
    expect(distributeMix(3, { pct_rag: 34, pct_itembank: 33, pct_llm: 33 }, 'mcq')).toEqual({ rag: 1, itembank: 1, llm: 1 });
    expect(distributeMix(4, { pct_rag: 50, pct_itembank: 50, pct_llm: 0 }, 'casus')).toEqual({ rag: 2, itembank: 0, llm: 2 });
  });
});

describe('vragen maken', () => {
  it('lage temperatuur bij vragen maken (0.2) en nakijken (0.3), om verzinnen te beperken', () => {
    expect(QUIZ_GENERATION_TEMPERATURE).toBe(0.2);
    expect(EVALUATE_TEMPERATURE).toBe(0.3);
    const start = routeSource("app.post('/api/quiz/sessions'");
    expect(start).toMatch(/temperature: QUIZ_GENERATION_TEMPERATURE/);
    expect(start).toMatch(/temperature: VERIFY_TEMPERATURE/);
    expect(routeSource("app.post('/api/quiz/sessions/:id/answer'")).toMatch(/temperature: EVALUATE_TEMPERATURE/);
  });
  it('lage temperatuur; strikt alleen bij vragen uit het materiaal; vaste JSON-velden in elke taal', () => {
    const strict = buildGenerationPrompt({ topics: TOPICS, difficulty: 'hard', questionType: 'mcq', count: 2, ragContext: RAG, strict: true, lang: 'nl' });
    expect(strict).toContain('STRIKTE BRONBEPERKING');
    expect(strict).toContain(RAG);
    expect(strict).toMatch(/Genereer 2 moeilijke meerkeuzevragen/);
    const creative = buildGenerationPrompt({ topics: TOPICS, difficulty: 'easy', questionType: 'open', count: 1, ragContext: undefined, strict: false, lang: 'de' });
    expect(creative).not.toContain(RAG);
    expect(creative).toMatch(/LANGUAGE REQUIREMENT/);
  });
  it('bij meer onderwerpen noemt elke vraag zijn onderwerp; zo telt hij voor het juiste begrip', () => {
    const p = buildGenerationPrompt({ topics: ['A', 'B'], difficulty: 'medium', questionType: 'mcq', count: 2, ragContext: RAG, strict: true, lang: 'nl' });
    expect(p).toMatch(/"topic": precies één van "A", "B"/);
    const concepts = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    expect(conceptForQuestion({ topic: ' b ' }, concepts)).toBe('b');
    expect(conceptForQuestion({ topic: 'C' }, concepts)).toBeNull();
    expect(conceptForQuestion({}, [{ id: 'a', name: 'A' }])).toBe('a');
  });
  it('leest de vragen; een vertaald type wordt het gevraagde type en weigeringen vallen weg', () => {
    const out = parseGeneratedQuestions(`Hier: ${JSON.stringify([{ ...MCQ, type: 'keuzevraag' }, { ...MCQ, question: 'Dit staat niet in het beschikbare materiaal' }])}`, 'mcq');
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('mcq');
  });
});

describe('de antwoordsleutel blijft op de server', () => {
  it('de browser krijgt een vraag zonder juist antwoord, uitleg, modelantwoord of rubric', () => {
    const pub = publicQuestion(MCQ, 0);
    expect(pub).toEqual({ index: 0, type: 'mcq', question: MCQ.question, source: 'llm', options: MCQ.options });
    const open = publicQuestion({ type: 'open', question: 'Leg uit', modelAnswer: 'GEHEIM', rubric: 'GEHEIM', extype: 'num', numericExpected: 4 }, 1);
    expect(JSON.stringify(open)).not.toMatch(/GEHEIM|numericExpected/);
    const casus = publicQuestion({ type: 'casus', context: 'Casus', question: 'Vraag', modelAnswer: 'GEHEIM', rubric: 'GEHEIM' }, 2);
    expect(JSON.stringify(casus)).not.toContain('GEHEIM');
  });
  it('pas na het antwoord: het juiste antwoord en de uitleg, of het modelantwoord', () => {
    expect(revealQuestion(MCQ)).toEqual({ correctAnswer: 0, explanation: MCQ.explanation });
    expect(revealQuestion({ type: 'open', modelAnswer: 'M', rubric: 'R' })).toEqual({ modelAnswer: 'M', rubric: 'R' });
  });
  it('nakijken: meerkeuze tegen de sleutel, een getal met de tolerantie, een open antwoord binnen 0–100', () => {
    expect(gradeMcq(MCQ, 0).isCorrect).toBe(true);
    expect(gradeMcq(MCQ, 1).isCorrect).toBe(false);
    const num = { extype: 'num', numericExpected: 2.5, numericTolerance: 0.1 };
    expect(gradeNumeric(num, 'ongeveer 2,55').score).toBe(100);
    expect(gradeNumeric(num, '3').score).toBe(0);
    expect(gradeNumeric(num, 'weet ik niet').numeric.outcome).toBe('noNumber');
    expect(parseEvaluation('{"feedback":"f","feedforward":"g","score":140}').score).toBe(100);
  });
  it('score van de quiz zoals voorheen; in de geschiedenis geen interne velden', () => {
    const qs = [MCQ, { type: 'open' }];
    expect(scoreQuiz(qs, [{ type: 'mcq', isCorrect: true }, { type: 'open', evaluation: { score: 50 } }])).toEqual({ answered: 2, correct: 1, pct: 75 });
    expect(questionForHistory({ ...MCQ, conceptId: 'c1', topic: 'x' })).toEqual(MCQ);
  });
  it('routes: alleen de eigen quiz; het eerste antwoord telt; afronden kan één keer; studenten niet zonder toegang', () => {
    const start = routeSource("app.post('/api/quiz/sessions'");
    expect(start).toMatch(/userHasCourseAccess\(auth\.user, auth\.profile, courseId\)/);
    expect(start).toMatch(/rejectIfFeatureOff\(res, auth\.user, auth\.profile, courseId, 'quiz'\)/);
    expect(start).toMatch(/if \(!staff\) return res\.status\(403\)/);
    expect(start).toMatch(/questions: result\.questions\.map\(publicQuestion\)/);
    const answer = routeSource("app.post('/api/quiz/sessions/:id/answer'");
    expect(answer).toMatch(/ownSessionOrReject\(req, res, auth\)/);
    expect(answer).toMatch(/if \(existing\) return reply\(existing\.answer\)/);
    expect(answer).toMatch(/error\.code !== '23505'/);
    const finish = routeSource("app.post('/api/quiz/sessions/:id/finish'");
    expect(finish).toMatch(/ownSessionOrReject\(req, res, auth\)/);
    // Eigen sessie, en nog toegang tot de cursus en de quiz staat aan.
    const own = functionSource('ownSessionOrReject');
    expect(own).toMatch(/loadOwnSession\(req\.params\.id, auth\.user\.id\)/);
    expect(own).toMatch(/userHasCourseAccess\(auth\.user, auth\.profile, session\.course_id\)/);
    expect(own).toMatch(/rejectIfFeatureOff\(res, auth\.user, auth\.profile, session\.course_id, 'quiz'\)/);
    expect(finish).toMatch(/\.eq\('id', session\.id\)\.eq\('status', 'active'\)\.select\('id'\)/);
    expect(finish).toMatch(/if \(questions\.some\(\(_, i\) => !answers\[i\]\)\)/);
  });
});

describe('ItemBank', () => {
  it('matcht secties hoofdletterongevoelig en zet een rij om, met het begrip erbij', () => {
    expect(pathUnder(['Statistics', 'Inferential Statistics', 'T-test'], ['statistics', 'inferential statistics'])).toBe(true);
    expect(pathUnder(['Statistics'], ['statistics', 'x'])).toBe(false);
    const q = itembankRowToQuestion({ item_type: 'open', question_text: 'Bereken', correct_answer: '2,5', explanation: 'Uitleg', metadata: { extype: 'num', extol: ['0.1', '0.05'] } }, 'c9');
    expect(q).toMatchObject({ type: 'open', numericExpected: 2.5, numericTolerance: 0.1, modelAnswer: 'Uitleg', conceptId: 'c9' });
  });
});

describe('database', () => {
  const root = path.resolve(__dirname, '..', '..');
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261112200000_quiz_sessions.sql'), 'utf8');
  it('quizsessies en antwoorden: alleen de server; de browser schrijft geen quizpogingen meer', () => {
    expect(sql).toMatch(/ALTER TABLE public\.quiz_sessions ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE public\.quiz_session_answers ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/CREATE POLICY/);
    expect(sql).toMatch(/PRIMARY KEY \(session_id, question_index\)/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "Students can create own attempts" ON public\.quiz_attempts/);
    expect(sql).toMatch(/attempt_id uuid REFERENCES public\.quiz_attempts\(id\) ON DELETE CASCADE/);
    expect(fs.existsSync(path.join(root, 'supabase/rollback/20261112200000_quiz_sessions_down.sql'))).toBe(true);
  });
  it('de browser schrijft zelf geen quizpoging meer', () => {
    const src = fs.readFileSync(path.join(root, 'src/pages/QuizPage.tsx'), 'utf8');
    expect(src).not.toMatch(/from\('quiz_attempts'\)\s*\.insert/);
  });
});
