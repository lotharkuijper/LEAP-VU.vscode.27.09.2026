import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// callChatAPI / fetchItembankQuestions doen een (dynamische) import van
// '../lib/supabase' voor de auth-header; mock 'm zodat er geen echte client nodig is.
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
  },
}));

import {
  verifyGeneratedQuestion,
  checkItembankFit,
  checkQuestionStructure,
  buildSolvePrompt,
  MAX_REPAIR_ROUNDS,
  verifyQuestions,
  __resetVerifyState,
} from '../quiz-verification.service';
import { generateMixedQuiz, MAX_FILL_ROUNDS } from '../quiz-mix.service';
import { LLMError, type MCQQuestion, type OpenQuestion } from '../llm.service';

beforeEach(() => __resetVerifyState());

const RAG = 'Cursusmateriaal: Het relatief risico (RR) is de incidentie bij blootgestelden gedeeld door de incidentie bij niet-blootgestelden.';
const TOPICS = ['Relatief risico'];

const MCQ: MCQQuestion = {
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

const reply = (obj: unknown) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });
const isSolve = (p: string) => p.includes('bewust NIET te zien');
const isCompare = (p: string) => p.includes('Vergelijk jouw uitwerking');
const promptOf = (body: any): string => body.messages[0].content;

const SOLVE_OK = { answerable: true, answerIndex: 0, answer: 'A', reasoning: 'RR = I1/I0', problems: '' };
const COMPARE_OK = { verdict: 'consistent', fitsCourse: true, discrepancy: '', repairedQuestion: null };

/** Nep-LLM: `solve` en `compare` bepalen per ronde het antwoord. */
function fakeLLM(script: { solve: (p: string, n: number) => unknown; compare: (p: string, n: number) => unknown }) {
  let solves = 0;
  let compares = 0;
  const prompts: string[] = [];
  const call = vi.fn(async (body: any) => {
    const p = promptOf(body);
    prompts.push(p);
    if (isSolve(p)) return reply(script.solve(p, solves++));
    if (isCompare(p)) return reply(script.compare(p, compares++));
    throw new Error('onverwachte prompt');
  });
  return { call, prompts };
}

describe('checkQuestionStructure', () => {
  it('keurt een geldige MCQ goed', () => {
    expect(checkQuestionStructure(MCQ)).toBeNull();
  });
  it('keurt MCQ zonder precies 4 opties, met ongeldige index of dubbele opties af', () => {
    expect(checkQuestionStructure({ ...MCQ, options: MCQ.options.slice(0, 3) })).toMatch(/4 opties/);
    expect(checkQuestionStructure({ ...MCQ, correctAnswer: 4 })).toMatch(/antwoordindex/);
    expect(checkQuestionStructure({ ...MCQ, options: ['x', 'X', 'y', 'z'] })).toMatch(/dubbele/);
  });
  it('eist modelantwoord en rubric bij open vragen', () => {
    const open: OpenQuestion = { type: 'open', question: 'Leg uit.', modelAnswer: '', rubric: '- punt' };
    expect(checkQuestionStructure(open)).toMatch(/modelantwoord/);
  });
});

describe('verifyGeneratedQuestion — blind oplossen en vergelijken', () => {
  it('laat het model de vraag BLIND oplossen: geen officieel antwoord of uitleg in de oplosprompt', () => {
    const p = buildSolvePrompt(MCQ, RAG, TOPICS);
    expect(p).not.toContain('GEHEIME_UITLEG');
    expect(p).not.toContain('correctAnswer');
    expect(p).toContain(RAG);
    expect(p).toMatch(/zeer kritische toetsdeskundige/);
  });

  it('accepteert een vraag waarbij eigen antwoord en officiële feedback overeenkomen', async () => {
    const { call, prompts } = fakeLLM({ solve: () => SOLVE_OK, compare: () => COMPARE_OK });
    const out = await verifyGeneratedQuestion(MCQ, { ragContext: RAG, topics: TOPICS, call });
    expect(out.status).toBe('accepted');
    expect(out.question).toEqual(MCQ);
    // Eerst blind oplossen, pas daarna vergelijken met het officiële antwoord.
    expect(isSolve(prompts[0])).toBe(true);
    expect(isCompare(prompts[1])).toBe(true);
    expect(prompts[1]).toContain('GEHEIME_UITLEG');
  });

  it('ziet een afwijkend MCQ-antwoord altijd als discrepantie, ook als de vergelijking "consistent" zegt, en verbetert de vraag', async () => {
    const repaired = { ...MCQ, correctAnswer: 2, explanation: 'Verbeterde uitleg.' };
    const { call, prompts } = fakeLLM({
      // Ronde 0: controleur kiest C terwijl officieel A is. Ronde 1 (verbeterd): C = officieel.
      solve: () => ({ ...SOLVE_OK, answerIndex: 2, answer: 'C' }),
      compare: (_p, n) => n === 0 ? { ...COMPARE_OK, repairedQuestion: repaired } : COMPARE_OK,
    });
    const out = await verifyGeneratedQuestion(MCQ, { ragContext: RAG, topics: TOPICS, call });
    expect(prompts[1]).toMatch(/per definitie "major"/);
    expect(out.status).toBe('repaired');
    expect((out.question as MCQQuestion).correctAnswer).toBe(2);
    expect(out.question?.source).toBe('llm');
    // Verbeterde vraag is opnieuw volledig gecontroleerd (2× oplossen + 2× vergelijken).
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('ziet een vraag die niet bij de cursus past als discrepantie', async () => {
    const { call } = fakeLLM({
      solve: () => SOLVE_OK,
      compare: () => ({ ...COMPARE_OK, fitsCourse: false, discrepancy: 'gaat over regressie, niet in materiaal' }),
    });
    const out = await verifyGeneratedQuestion(MCQ, { ragContext: RAG, topics: TOPICS, call });
    expect(out.status).toBe('rejected');
    expect(out.reason).toMatch(/regressie/);
  });

  it('keurt een vraag af bij een discrepantie zonder bruikbare verbetering', async () => {
    const { call } = fakeLLM({
      solve: () => SOLVE_OK,
      compare: () => ({ ...COMPARE_OK, verdict: 'discrepancy', discrepancy: 'uitleg spreekt antwoord tegen' }),
    });
    const out = await verifyGeneratedQuestion(MCQ, { ragContext: RAG, topics: TOPICS, call });
    expect(out.status).toBe('rejected');
    expect(out.reason).toMatch(/uitleg spreekt antwoord tegen/);
  });

  it('keurt een niet-eenduidige vraag af, ook als de vergelijking positief is', async () => {
    const { call } = fakeLLM({
      solve: () => ({ ...SOLVE_OK, answerable: false, problems: 'twee opties juist' }),
      compare: () => COMPARE_OK,
    });
    const out = await verifyGeneratedQuestion(MCQ, { ragContext: RAG, topics: TOPICS, call });
    expect(out.status).toBe('rejected');
  });

  it('stopt na MAX_REPAIR_ROUNDS verbeterrondes en keurt dan af', async () => {
    const { call } = fakeLLM({
      solve: () => ({ ...SOLVE_OK, answerIndex: 1 }),
      compare: () => ({ ...COMPARE_OK, verdict: 'discrepancy', discrepancy: 'blijft fout', repairedQuestion: { ...MCQ } }),
    });
    const out = await verifyGeneratedQuestion(MCQ, { ragContext: RAG, topics: TOPICS, call });
    expect(out.status).toBe('rejected');
    expect(call).toHaveBeenCalledTimes(2 * (MAX_REPAIR_ROUNDS + 1));
  });

  it('keurt een vraag met alleen een kleine onvolkomenheid (minor) goed, ook zonder verbetering', async () => {
    const { call } = fakeLLM({
      solve: () => SOLVE_OK,
      compare: () => ({ ...COMPARE_OK, verdict: 'minor', discrepancy: 'rubric sluit niet helemaal aan' }),
    });
    const out = await verifyGeneratedQuestion(MCQ, { ragContext: RAG, topics: TOPICS, call });
    expect(out.status).toBe('accepted');
    expect(out.question).toEqual(MCQ);
  });

  it('valt bij "minor" terug op de originele vraag als de verbetering zelf wordt afgekeurd', async () => {
    const worse = { ...MCQ, correctAnswer: 3, explanation: 'Verslechterde uitleg.' };
    const { call } = fakeLLM({
      solve: () => SOLVE_OK, // kiest steeds A → verbetering (D) wijkt af = major
      compare: (_p, n) => n === 0
        ? { ...COMPARE_OK, verdict: 'minor', discrepancy: 'formulering kan beter', repairedQuestion: worse }
        : { ...COMPARE_OK, verdict: 'major', discrepancy: 'fout', repairedQuestion: null },
    });
    const out = await verifyGeneratedQuestion(MCQ, { ragContext: RAG, topics: TOPICS, call });
    expect(out.status).toBe('accepted');
    expect(out.question).toEqual(MCQ);
  });

  it('neemt bij "minor" de verbeterde versie over als die consistent is', async () => {
    const better = { ...MCQ, explanation: 'Betere uitleg.' };
    const { call } = fakeLLM({
      solve: () => SOLVE_OK,
      compare: (_p, n) => n === 0 ? { ...COMPARE_OK, verdict: 'minor', repairedQuestion: better } : COMPARE_OK,
    });
    const out = await verifyGeneratedQuestion(MCQ, { ragContext: RAG, topics: TOPICS, call });
    expect(out.status).toBe('repaired');
    expect((out.question as MCQQuestion).explanation).toBe('Betere uitleg.');
  });

  it('telt technische fouten apart (failed) i.p.v. als inhoudelijke afkeuring', async () => {
    const boom = vi.fn(async () => { throw new LLMError('Server error', 500); });
    const report = await verifyQuestions([MCQ], 'generated', { ragContext: RAG, topics: TOPICS, call: boom });
    expect(report.kept).toHaveLength(0);
    expect(report.rejected).toHaveLength(0);
    expect(report.failed).toHaveLength(1);
    // Tijdelijke fout: één herkansing.
    expect(boom).toHaveBeenCalledTimes(2);
  });

  it('herstelt van een tijdelijke 429 met één herkansing', async () => {
    let first = true;
    const { call: inner } = fakeLLM({ solve: () => SOLVE_OK, compare: () => COMPARE_OK });
    const call = vi.fn(async (body: any) => {
      if (first) { first = false; throw new LLMError('rate limit', 429); }
      return inner(body);
    });
    const out = await verifyGeneratedQuestion(MCQ, { ragContext: RAG, topics: TOPICS, call });
    expect(out.status).toBe('accepted');
  });

  it('werkt door zonder beheerde system-prompt als de server "quiz_verify" niet kent (niet herstart)', async () => {
    const { call: inner } = fakeLLM({ solve: () => SOLVE_OK, compare: () => COMPARE_OK });
    const bodies: any[] = [];
    const call = vi.fn(async (body: any) => {
      bodies.push(body);
      if (body.promptMode) throw new LLMError('Onbekende promptMode: quiz_verify', 400, undefined, 'Onbekende promptMode: quiz_verify');
      return inner(body);
    });
    const out = await verifyGeneratedQuestion(MCQ, { ragContext: RAG, topics: TOPICS, call });
    expect(out.status).toBe('accepted');
    // Eén mislukte poging met promptMode, daarna alles zonder.
    expect(bodies.filter(b => b.promptMode)).toHaveLength(1);
    // De persona zit in het bericht zelf, dus de controle blijft even kritisch.
    expect(promptOf(bodies[1])).toMatch(/zeer kritische toetsdeskundige/);
  });

  it('keurt af zonder LLM-call bij een structureel ongeldige vraag', async () => {
    const call = vi.fn();
    const out = await verifyGeneratedQuestion({ ...MCQ, options: ['a', 'b'] }, { ragContext: RAG, topics: TOPICS, call });
    expect(out.status).toBe('rejected');
    expect(call).not.toHaveBeenCalled();
  });

  it('keurt af zonder LLM-call als er geen cursusmateriaal is', async () => {
    const call = vi.fn();
    for (const ragContext of [undefined, '', '   ']) {
      const out = await verifyGeneratedQuestion(MCQ, { ragContext, topics: TOPICS, call });
      expect(out.status).toBe('rejected');
      expect(out.reason).toMatch(/cursusmateriaal/);
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('is fail-closed: onleesbaar of mislukt controle-antwoord → afgekeurd', async () => {
    const bad = vi.fn(async () => ({ choices: [{ message: { content: 'geen json' } }] }));
    expect((await verifyGeneratedQuestion(MCQ, { ragContext: RAG, topics: TOPICS, call: bad })).status).toBe('rejected');
    const boom = vi.fn(async () => { throw new Error('503'); });
    expect((await verifyGeneratedQuestion(MCQ, { ragContext: RAG, topics: TOPICS, call: boom })).status).toBe('rejected');
  });
});

describe('checkItembankFit — alleen passendheid bij het cursusmateriaal', () => {
  it('doet één passendheidscheck (geen blind oplossen) en keurt af als de vraag niet past', async () => {
    const call = vi.fn(async (body: any) => {
      expect(isSolve(promptOf(body))).toBe(false);
      expect(promptOf(body)).toContain(RAG);
      return reply({ fits: false, reason: 'gaat over regressie, niet in materiaal' });
    });
    const out = await checkItembankFit({ ...MCQ, source: 'itembank' }, { ragContext: RAG, topics: TOPICS, call });
    expect(out.status).toBe('rejected');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('keurt af zonder cursusmateriaal (passendheid niet vast te stellen)', async () => {
    const call = vi.fn();
    const out = await checkItembankFit(MCQ, { ragContext: undefined, topics: TOPICS, call });
    expect(out.status).toBe('rejected');
    expect(call).not.toHaveBeenCalled();
  });
});

// ── generateMixedQuiz: echte orkestratie, alleen fetch is gestubd ──────────

type Verdict = 'ok' | 'reject';

function variant(n: number): MCQQuestion {
  return { ...MCQ, question: `${MCQ.question} (variant ${n})`, source: undefined };
}

describe('generateMixedQuiz — controle, vervanging en cursusmateriaal', () => {
  const fetchMock = vi.fn();
  const chatBodies: any[] = [];
  let generated = 0;
  // Bepaalt per gegenereerde vraag (op volgorde) of de controle hem goedkeurt.
  let verdictFor: (questionText: string) => Verdict = () => 'ok';
  // Wat de generator per aanroep teruggeeft (standaard: n unieke varianten).
  let generate: (n: number) => MCQQuestion[] = (n) => Array.from({ length: n }, () => variant(++generated));

  const requestedCount = (p: string) => Number(/Genereer (\d+)/.exec(p)?.[1] ?? /Generate (\d+)/.exec(p)?.[1] ?? 1);

  beforeEach(() => {
    chatBodies.length = 0;
    generated = 0;
    verdictFor = () => 'ok';
    generate = (n) => Array.from({ length: n }, () => variant(++generated));
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (url === '/api/quiz/itembank-questions') {
        return {
          ok: true,
          json: async () => ({
            questions: [{
              type: 'mcq', question: 'Itembank: wat is RR?',
              options: { A: 'I1/I0', B: 'I1−I0', C: 'odds', D: 'prevalentie' },
              correctAnswer: 'A', explanation: 'Zie hoofdstuk 3.',
            }],
          }),
        };
      }
      const body = JSON.parse(init.body);
      chatBodies.push(body);
      const p = promptOf(body);
      if (String(body.promptMode).startsWith('quiz_generate_')) {
        return { ok: true, json: async () => reply(generate(requestedCount(p))) };
      }
      if (isSolve(p)) return { ok: true, json: async () => reply(SOLVE_OK) };
      if (isCompare(p)) {
        const ok = verdictFor(p) === 'ok';
        return { ok: true, json: async () => reply(ok ? COMPARE_OK : { ...COMPARE_OK, verdict: 'discrepancy', discrepancy: 'fout' }) };
      }
      return { ok: true, json: async () => reply({ fits: true, reason: 'past' }) };
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  const baseArgs = {
    courseId: 'course-1', conceptIds: ['c1'], topicNames: TOPICS, difficulty: 'medium' as const,
    questionType: 'mcq' as const, ragContext: RAG,
  };
  const generationCalls = () => chatBodies.filter(b => String(b.promptMode).startsWith('quiz_generate_'));

  for (const strict of [true, false]) {
    it(`controleert RAG- en creatieve vragen volledig en itembank op passendheid (strict=${strict})`, async () => {
      const result = await generateMixedQuiz({
        ...baseArgs, numQuestions: 3, ragStrictMode: strict,
        mix: { pct_rag: 34, pct_itembank: 33, pct_llm: 33 },
      });

      expect(result.status).toBe('ok');
      expect(result.questions).toHaveLength(3);
      expect(result.counts).toEqual({ rag: 1, itembank: 1, llm: 1 });
      expect(result.verification).toEqual({ accepted: 3, repaired: 0, rejected: 0, failed: 0 });

      const verifyBodies = chatBodies.filter(b => b.promptMode === 'quiz_verify');
      const solves = verifyBodies.filter(b => isSolve(promptOf(b)));
      const compares = verifyBodies.filter(b => isCompare(promptOf(b)));
      const fits = verifyBodies.filter(b => !isSolve(promptOf(b)) && !isCompare(promptOf(b)));
      // RAG + creatief: elk blind opgelost én vergeleken. Itembank: alleen passendheid.
      expect(solves).toHaveLength(2);
      expect(compares).toHaveLength(2);
      expect(fits).toHaveLength(1);
      // Ook de creatieve vraag wordt vanuit het cursusmateriaal beoordeeld.
      for (const b of verifyBodies) expect(promptOf(b)).toContain(RAG);
    });
  }

  it('ondersteunt een quiz van precies 1 vraag', async () => {
    const result = await generateMixedQuiz({
      ...baseArgs, numQuestions: 1, ragStrictMode: true, mix: { pct_rag: 50, pct_itembank: 0, pct_llm: 50 },
    });
    expect(result.status).toBe('ok');
    expect(result.questions).toHaveLength(1);
  });

  it('vervangt afgekeurde vragen tot precies het gevraagde aantal', async () => {
    // Varianten 1 en 2 (eerste ronde) worden afgekeurd, alle latere goedgekeurd.
    verdictFor = (p) => /variant [12]\)/.test(p) ? 'reject' : 'ok';
    const result = await generateMixedQuiz({
      ...baseArgs, numQuestions: 4, ragStrictMode: false, mix: { pct_rag: 100, pct_itembank: 0, pct_llm: 0 },
    });
    expect(result.status).toBe('ok');
    expect(result.questions).toHaveLength(4);
    expect(result.verification.rejected).toBe(2);
    expect(result.questions.map(q => q.question).join(' ')).not.toMatch(/variant [12]\)/);
    // Eerste ronde 4 vragen, tweede ronde precies de 2 afgekeurde vervangen.
    expect(generationCalls().map(b => requestedCount(promptOf(b)))).toEqual([4, 2]);
  });

  it('neemt geen dubbele vraag op als vervanging', async () => {
    // Generator geeft steeds dezelfde vraag terug: slechts één exemplaar mag erin.
    generate = (n) => Array.from({ length: n }, () => variant(1));
    const result = await generateMixedQuiz({
      ...baseArgs, numQuestions: 2, ragStrictMode: true, mix: { pct_rag: 100, pct_itembank: 0, pct_llm: 0 },
    });
    expect(new Set(result.questions.map(q => q.question)).size).toBe(result.questions.length);
    expect(result.questions).toHaveLength(1);
    expect(result.status).toBe('shortfall');
  });

  it('rapporteert technische controlefouten apart (regressie: 6 "afgekeurd" door een niet-herstarte server)', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (String(body.promptMode).startsWith('quiz_generate_')) {
        return { ok: true, json: async () => reply(generate(requestedCount(promptOf(body)))) };
      }
      return { ok: false, status: 503, json: async () => ({ error: { message: 'Service unavailable' } }) };
    });
    const result = await generateMixedQuiz({
      ...baseArgs, numQuestions: 1, ragStrictMode: true, mix: { pct_rag: 100, pct_itembank: 0, pct_llm: 0 },
    });
    expect(result.status).toBe('shortfall');
    expect(result.verification.rejected).toBe(0);
    expect(result.verification.failed).toBeGreaterThan(0);
    expect(result.verification.lastError).toMatch(/Service unavailable/);
  });

  it('meldt een tekort (i.p.v. stil minder vragen) als vervangen blijft mislukken — begrensd aantal rondes', async () => {
    verdictFor = () => 'reject';
    const result = await generateMixedQuiz({
      ...baseArgs, numQuestions: 2, ragStrictMode: false, mix: { pct_rag: 50, pct_itembank: 0, pct_llm: 50 },
    });
    expect(result.status).toBe('shortfall');
    expect(result.questions).toHaveLength(0);
    // Per bron MAX_FILL_ROUNDS in de eerste vulling + MAX_FILL_ROUNDS per aanvulbron.
    expect(generationCalls().length).toBeLessThanOrEqual(4 * MAX_FILL_ROUNDS);
  });

  it('maakt zonder passend cursusmateriaal geen enkele vraag (ook niet via vrije generatie of itembank)', async () => {
    for (const ragContext of [undefined, '']) {
      chatBodies.length = 0;
      const result = await generateMixedQuiz({
        ...baseArgs, ragContext, numQuestions: 3, ragStrictMode: false,
        mix: { pct_rag: 34, pct_itembank: 33, pct_llm: 33 },
      });
      expect(result.status).toBe('no_course_material');
      expect(result.questions).toHaveLength(0);
      expect(chatBodies).toHaveLength(0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('generateMixedQuiz — voortgangsmeldingen voor de wachtbalk', () => {
  const reply2 = (obj: unknown) => ({ ok: true, json: async () => reply(obj) });
  afterEach(() => vi.unstubAllGlobals());

  it('meldt schrijven → controleren → klaar, met oplopend aantal goedgekeurde vragen', async () => {
    let g = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const p = promptOf(body);
      if (String(body.promptMode).startsWith('quiz_generate_')) {
        const n = Number(/Genereer (\d+)/.exec(p)?.[1] ?? /Generate (\d+)/.exec(p)?.[1] ?? 1);
        return reply2(Array.from({ length: n }, () => ({ ...MCQ, question: `${MCQ.question} #${++g}` })));
      }
      if (isSolve(p)) return reply2(SOLVE_OK);
      return reply2(COMPARE_OK);
    }));
    const events: Array<{ phase: string; approved: number }> = [];
    const result = await generateMixedQuiz({
      courseId: 'c', conceptIds: ['x'], topicNames: TOPICS, difficulty: 'medium', questionType: 'mcq',
      numQuestions: 2, ragContext: RAG, ragStrictMode: true, mix: { pct_rag: 100, pct_itembank: 0, pct_llm: 0 },
      onProgress: e => events.push({ phase: e.phase, approved: e.approved }),
    });
    expect(result.status).toBe('ok');
    const phases = events.map(e => e.phase);
    expect(phases[0]).toBe('writing');
    expect(phases).toContain('checking');
    expect(phases[phases.length - 1]).toBe('done');
    expect(events[events.length - 1].approved).toBe(2);
    // Het aantal goedgekeurde vragen daalt nooit.
    for (let i = 1; i < events.length; i++) expect(events[i].approved).toBeGreaterThanOrEqual(events[i - 1].approved);
  });

  it('meldt "repairing" als een vraag een verbeterronde ingaat en "replacing" bij vervangen', async () => {
    let g = 0;
    let compares = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const p = promptOf(body);
      if (String(body.promptMode).startsWith('quiz_generate_')) {
        return reply2([{ ...MCQ, question: `${MCQ.question} #${++g}` }]);
      }
      if (isSolve(p)) return reply2(SOLVE_OK);
      compares++;
      // Eerste vraag: major met verbetering, verbetering ook major zonder reparatie → afgekeurd → vervangen.
      if (compares === 1) return reply2({ ...COMPARE_OK, verdict: 'major', discrepancy: 'x', repairedQuestion: { ...MCQ, question: 'hersteld' } });
      if (compares === 2) return reply2({ ...COMPARE_OK, verdict: 'major', discrepancy: 'y', repairedQuestion: null });
      return reply2(COMPARE_OK);
    }));
    const phases: string[] = [];
    const result = await generateMixedQuiz({
      courseId: 'c', conceptIds: ['x'], topicNames: TOPICS, difficulty: 'medium', questionType: 'mcq',
      numQuestions: 1, ragContext: RAG, ragStrictMode: true, mix: { pct_rag: 100, pct_itembank: 0, pct_llm: 0 },
      onProgress: e => phases.push(e.phase),
    });
    expect(result.status).toBe('ok');
    expect(phases).toContain('repairing');
    expect(phases).toContain('replacing');
  });

  it('een fout in de voortgangs-callback breekt de quiz niet', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const p = promptOf(body);
      if (String(body.promptMode).startsWith('quiz_generate_')) return reply2([{ ...MCQ }]);
      return reply2(isSolve(p) ? SOLVE_OK : COMPARE_OK);
    }));
    const result = await generateMixedQuiz({
      courseId: 'c', conceptIds: ['x'], topicNames: TOPICS, difficulty: 'medium', questionType: 'mcq',
      numQuestions: 1, ragContext: RAG, ragStrictMode: true, mix: { pct_rag: 100, pct_itembank: 0, pct_llm: 0 },
      onProgress: () => { throw new Error('UI stuk'); },
    });
    expect(result.status).toBe('ok');
  });
});
