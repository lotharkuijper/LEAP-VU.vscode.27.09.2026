import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildExplainFeedbackExcerpt, type ExplainExcerptLabels } from '../explainFeedbackExcerpt';

// "Klopt dit wel?" bij de feedback van "Leg zelf uit" (2026-10-26): de bijlage
// voor het Studiecafé bevat begrip, eigen uitleg, feedback, score, verwante
// begrippen en feed forward, en de knop zit alleen achter de Studiecafé-switch.

const LABELS: ExplainExcerptLabels = {
  heading: 'Leg zelf uit: klopt dit wel?', yourExplanation: 'Mijn uitleg', feedback: 'Feedback',
  score: 'Score', related: 'Verwante begrippen', feedforward: 'Feed forward',
};

describe('buildExplainFeedbackExcerpt', () => {
  it('neemt begrip, uitleg, feedback, score, verwante begrippen en feed forward op', () => {
    const a = buildExplainFeedbackExcerpt({
      conceptName: 'Fotosynthese',
      explanation: 'Planten maken\n\nsuiker uit licht.',
      feedback: 'ruwe tekst',
      sections: {
        feedback: 'Je noemt licht, maar niet CO2.',
        related: [{ id: 'c2', name: 'Chlorofyl', relation: 'vangt het licht op' }],
        feedforward: ['Noem de grondstoffen.'],
      },
      score: { total: 70, reason: 'Kern klopt, grondstoffen ontbreken.' },
      sources: [{ title: 'H2 Planten', documentId: 'doc-2' }, { title: 'Website' }],
      courseId: 'course-1',
      labels: LABELS,
    });
    expect(a.type).toBe('chat_excerpt');
    expect(a.content).toContain('**Leg zelf uit: klopt dit wel?** · Fotosynthese');
    expect(a.content).toContain('> Planten maken suiker uit licht.');
    expect(a.content).toContain('Je noemt licht, maar niet CO2.');
    expect(a.content).not.toContain('ruwe tekst');
    expect(a.content).toContain('**Score:** 70/100 — Kern klopt, grondstoffen ontbreken.');
    expect(a.content).toContain('- Chlorofyl: vangt het licht op');
    expect(a.content).toContain('- Noem de grondstoffen.');
    expect(a.sources).toEqual([{ index: 1, title: 'H2 Planten', documentId: 'doc-2' }, { index: 2, title: 'Website' }]);
    expect(a.meta?.module).toBe('explain');
    expect(a.meta?.courseId).toBe('course-1');
  });

  it('valt bij oudere uitleg zonder blokken terug op de feedbacktekst', () => {
    const a = buildExplainFeedbackExcerpt({ conceptName: 'X', explanation: 'uitleg', feedback: 'Oude feedback', labels: LABELS });
    expect(a.content).toContain('Oude feedback');
    expect(a.content).not.toContain('**Score:**');
  });

  it('blijft onder de servergrens voor bijlage-inhoud', () => {
    const a = buildExplainFeedbackExcerpt({ conceptName: 'X', explanation: 'y'.repeat(20000), feedback: 'f', labels: LABELS });
    expect(a.content.length).toBeLessThanOrEqual(12000);
  });

  it('de knop op de pagina hangt aan de Studiecafé-switch', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../pages/ExplainPage.tsx'), 'utf8');
    expect(page).toContain('data-testid="button-explain-check-llm"');
    expect(page).toMatch(/check=\{[^}]*courseFeatures\.visible\('studiecafe'\)/);
  });
});
