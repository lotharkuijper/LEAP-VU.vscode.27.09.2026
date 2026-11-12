import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// callChatAPI doet een dynamische import van '../lib/supabase' voor de
// auth-header; mock 'm zodat er geen env-vars/echte client nodig zijn.
vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
  },
}));

import { sendChatMessage, evaluateExplanation } from '../llm.service';

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

describe('evaluateExplanation (server beoordeelt en slaat op)', () => {
  const okEvaluate = () => ({
    ok: true,
    json: async () => ({ id: 'e1', version: 1, content: 'tekst', sections: null, score: { total: 90, reason: 'goed' } }),
  });

  it('roept /api/explain/evaluate aan met begrip en uitleg', async () => {
    fetchMock.mockResolvedValueOnce(okEvaluate());
    const r = await evaluateExplanation({ conceptId: 'c1', explanation: 'Mijn uitleg', courseId: 'k1' });
    expect(fetchMock).toHaveBeenCalledWith('/api/explain/evaluate', expect.anything());
    expect(lastBody()).toMatchObject({ conceptId: 'c1', explanation: 'Mijn uitleg', courseId: 'k1' });
    expect(r.score?.total).toBe(90);
  });

  it('stuurt nooit een leerniveau mee (bij Ik leg uit beheers je een begrip of niet)', async () => {
    fetchMock.mockResolvedValueOnce(okEvaluate());
    await evaluateExplanation({ conceptId: 'c1', explanation: 'Mijn uitleg' });
    expect(lastBody()).not.toHaveProperty('learningLevel');
  });
});

// Quizvragen maakt sinds 2026-11-12 de server: zie server/__tests__/quizServer.test.js.
