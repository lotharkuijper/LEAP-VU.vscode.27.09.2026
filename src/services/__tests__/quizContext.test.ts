import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}));

import { retrieveQuizContext, type QuizContextDeps } from '../quiz-context.service';
import type { DocumentChunk, RAGSearchStats } from '../rag.service';

const TOPIC = {
  id: 'concept-eco',
  name: 'Ecologisch onderzoek',
  definition: 'Onderzoek waarin groepen in plaats van individuen de analyse-eenheid zijn.',
  keyPoints: ['analyse-eenheid is de groep', 'ecologische fout'],
};

const chunk = (id: string, documentId: string, similarity: number): DocumentChunk => ({
  id, documentId, similarity, content: `inhoud van ${id}`, documentTitle: documentId, metadata: null,
});

/** Live zoeken zoals in productie gemeten: 0 chunks boven 0.65, beste score 0.610. */
const emptySearch = (maxSimilarity = 0.61): RAGSearchStats => ({
  chunks: [], threshold: 0.65, matchCount: 5, maxSimilarity, candidatesConsidered: 60, searchPerformed: true,
});

function deps(over: Partial<QuizContextDeps> = {}): QuizContextDeps {
  return {
    search: vi.fn(async () => emptySearch()),
    evidence: vi.fn(async () => [
      chunk('ev-1', 'doc-studiedesigns', 0.623),
      chunk('ev-2', 'doc-validiteit', 0.556),
    ]),
    allowedDocumentIds: vi.fn(async () => new Set(['doc-studiedesigns', 'doc-validiteit'])),
    ...over,
  };
}

const base = { courseId: 'course-1', role: 'student' as const, threshold: 0.65, matchCount: 5, expansionEnabled: false };

describe('retrieveQuizContext — regressie "Ecologisch onderzoek" gaf geen cursusmateriaal', () => {
  it('levert context uit vastgelegde bewijsfragmenten als live zoeken onder de drempel blijft', async () => {
    const d = deps();
    const out = await retrieveQuizContext({ ...base, topics: [TOPIC] }, d);
    expect(out.chunks.map(c => c.id)).toEqual(['ev-1', 'ev-2']);
    expect(out.fromEvidence).toBe(2);
    // De drempel wordt niet verlaagd.
    expect((d.search as any).mock.calls[0][1]).toBe(0.65);
    expect(out.stats.maxSimilarity).toBeCloseTo(0.61);
  });

  it('gebruikt geen bewijsfragmenten uit documenten die de docent niet voor de quiz heeft opengezet', async () => {
    const d = deps({ allowedDocumentIds: vi.fn(async () => new Set(['doc-studiedesigns'])) });
    const out = await retrieveQuizContext({ ...base, topics: [TOPIC] }, d);
    expect(out.chunks.map(c => c.documentId)).toEqual(['doc-studiedesigns']);
  });

  it('zoekt per onderwerp apart, met verrijking alleen als die voor de quiz aanstaat', async () => {
    const other = { id: 'concept-rr', name: 'Relatief risico' };
    const d = deps();
    await retrieveQuizContext({ ...base, topics: [TOPIC, other] }, d);
    const calls = (d.search as any).mock.calls;
    expect(calls.map((c: any[]) => c[0])).toEqual(['Ecologisch onderzoek', 'Relatief risico']);
    expect(calls[0][6]).toBeUndefined();
    expect(calls[0][7]).toEqual(['concept-eco']);

    const d2 = deps();
    await retrieveQuizContext({ ...base, expansionEnabled: true, topics: [TOPIC] }, d2);
    expect((d2.search as any).mock.calls[0][6]).toEqual({
      enabled: true, definition: TOPIC.definition, keyPoints: TOPIC.keyPoints,
    });
  });

  it('voegt live-resultaten en bewijs samen zonder dubbels, gesorteerd op score', async () => {
    const d = deps({
      search: vi.fn(async () => ({ ...emptySearch(0.7), chunks: [chunk('ev-1', 'doc-studiedesigns', 0.7), chunk('live-9', 'doc-validiteit', 0.68)] })),
    });
    const out = await retrieveQuizContext({ ...base, topics: [TOPIC] }, d);
    expect(out.chunks.map(c => c.id)).toEqual(['ev-1', 'live-9', 'ev-2']);
    expect(out.chunks[0].similarity).toBe(0.7);
  });

  it('blijft leeg als er echt niets is — dan hoort de quiz "geen passend cursusmateriaal" te melden', async () => {
    const d = deps({ evidence: vi.fn(async () => []) });
    const out = await retrieveQuizContext({ ...base, topics: [TOPIC] }, d);
    expect(out.chunks).toHaveLength(0);
  });

  it('één mislukte zoekopdracht breekt de rest niet af', async () => {
    const d = deps({ search: vi.fn(async () => { throw new Error('503'); }) });
    const out = await retrieveQuizContext({ ...base, topics: [TOPIC] }, d);
    expect(out.chunks).toHaveLength(2);
    expect(out.stats.searchPerformed).toBe(false);
  });
});
