import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// callChatAPI doet een dynamische import van '../lib/supabase' voor de
// auth-header; mock 'm zodat er geen env-vars/echte client nodig zijn.
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
  },
}));

import { sendChatMessage, evaluateExplanation, generateQuiz } from '../llm.service';

const fetchMock = vi.fn();

function okChatResponse() {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'antwoord' } }] }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(okChatResponse());
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastBody(): any {
  const calls = fetchMock.mock.calls;
  const call = calls[calls.length - 1];
  return JSON.parse(call[1].body);
}

describe('sendChatMessage learningLevel-bedrading', () => {
  it('stuurt het meegegeven learningLevel mee in de request-body', async () => {
    await sendChatMessage([{ role: 'user', content: 'hoi' }], undefined, false, undefined, 4);
    expect(fetchMock).toHaveBeenCalledWith('/api/chat', expect.anything());
    expect(lastBody().learningLevel).toBe(4);
  });

  it('laat learningLevel undefined wanneer het niet wordt meegegeven', async () => {
    await sendChatMessage([{ role: 'user', content: 'hoi' }]);
    expect(lastBody()).not.toHaveProperty('learningLevel');
  });
});

describe('evaluateExplanation learningLevel-bedrading', () => {
  it('stuurt het meegegeven learningLevel mee in de request-body', async () => {
    await evaluateExplanation(
      'Begrip', 'Mijn uitleg', 'Definitie', ['kernpunt 1'],
      undefined, undefined, false, undefined, 5,
    );
    expect(lastBody().learningLevel).toBe(5);
  });

  it('laat learningLevel undefined wanneer het niet wordt meegegeven', async () => {
    await evaluateExplanation('Begrip', 'Mijn uitleg', 'Definitie', ['kernpunt 1']);
    expect(lastBody()).not.toHaveProperty('learningLevel');
  });
});

describe('quiz generation safety', () => {
  const ONE_MCQ = [{ type: 'mcq', question: 'Vraag?', options: ['A', 'B', 'C', 'D'], correctAnswer: 0, explanation: 'Uitleg' }];

  it('houdt de LLM-temperatuur voor quizvragen extreem laag om hallucinaties te beperken', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(ONE_MCQ) } }] }),
    });

    await generateQuiz(['Epidemiologie'], 'medium', 'mcq', 1, 'Context', true);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).temperature).toBe(0.2);
  });

  it('doet zelf geen (strict-afhankelijke) validatie meer — dat doet quiz-verification.service voor elke bron', async () => {
    for (const strict of [true, false]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(ONE_MCQ) } }] }),
      });
      const questions = await generateQuiz(['Epidemiologie'], 'medium', 'mcq', 1, 'Context over risicofactoren.', strict);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(questions).toHaveLength(1);
    }
  });
});
