// @vitest-environment jsdom
// Feedback en beoordeling (2026-11-10): drie stappen, de rubric is openbaar, de
// nakijkhulp hoort niet bij de feedbackgevers voor studenten.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '../../../i18n';

const update = vi.fn(() => ({ eq: async () => ({ error: null }) }));
vi.mock('../../../lib/supabase', () => ({ supabase: { from: () => ({ update }) } }));

import { ProjectFeedbackSetup, criteriaLines, type FeedbackPersona, type FeedbackDoc } from '../ProjectFeedbackSetup';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const docs: FeedbackDoc[] = [
  { id: 'd1', filename: 'rubric.pdf', material_kind: 'rubric', is_visible_to_students: false },
  { id: 'd2', filename: 'opdracht.pdf', material_kind: 'assignment', is_visible_to_students: true },
];
const personas: FeedbackPersona[] = [
  { id: 'e1', name: 'Feedbackgever', avatar_emoji: '💬', persona_type: 'evaluator', max_reviews: 3, deliverable_label: 'Onderzoeksopzet', project_knowledge_doc_ids: ['d1'] },
  { id: 'e2', name: 'Nakijkhulp', avatar_emoji: '📝', persona_type: 'evaluator', project_knowledge_doc_ids: [] },
  { id: 'g1', name: 'Begeleider', avatar_emoji: '🧭', persona_type: 'conversational' },
];

function setup(over: Partial<Parameters<typeof ProjectFeedbackSetup>[0]> = {}) {
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
  const props = {
    project: { id: 'p1', rubric_criteria: [{ title: 'Methode' }], submissions_enabled: true },
    token: 't', personas, docs, accept: '.pdf', preassessorId: 'e2',
    onPreassessorChange: vi.fn(), onToggleDocVisibility: vi.fn(), onUploadRubric: vi.fn(), uploading: false,
    onNewEvaluator: vi.fn(), onPersonasChanged: vi.fn(), onError: vi.fn(), onInfo: vi.fn(),
    ...over,
  };
  render(<LanguageProvider><ProjectFeedbackSetup {...props} /></LanguageProvider>);
  return props;
}

describe('ProjectFeedbackSetup', () => {
  it('drie stappen en de regel dat de docent beoordeelt', () => {
    setup();
    expect(screen.getByTestId('fb-step-criteria')).toBeInTheDocument();
    expect(screen.getByTestId('fb-step-feedback')).toBeInTheDocument();
    expect(screen.getByTestId('fb-step-marking')).toBeInTheDocument();
    expect(screen.getByTestId('text-fb-you-assess')).toHaveTextContent('Jij beoordeelt');
  });

  it('stap 1: alleen rubrics, met een waarschuwing als studenten ze niet zien', () => {
    const p = setup();
    expect(screen.getByTestId('fb-rubric-d1')).toHaveTextContent('Studenten zien deze rubric niet');
    expect(screen.queryByTestId('fb-rubric-d2')).toBeNull();
    fireEvent.click(screen.getByTestId('button-fb-rubric-visibility-d1'));
    expect(p.onToggleDocVisibility).toHaveBeenCalledWith(docs[0]);
    expect(screen.getByTestId('textarea-fb-criteria')).toHaveValue('Methode');
  });

  it('stap 2: de nakijkhulp en begeleiders zijn geen feedbackgevers', () => {
    setup();
    expect(screen.getByTestId('fb-evaluator-e1')).toBeInTheDocument();
    expect(screen.getByTestId('input-fb-rounds-e1')).toHaveValue(3);
    const step2 = screen.getByTestId('fb-step-feedback');
    expect(step2).not.toHaveTextContent('Nakijkhulp');
    expect(step2).not.toHaveTextContent('Begeleider');
  });

  it('stap 3 vraagt eerst om inleveren; zonder nakijkhulp een knop om er een toe te voegen', () => {
    setup({ project: { id: 'p1', rubric_criteria: [], submissions_enabled: false } });
    expect(screen.getByTestId('fb-step-marking')).toHaveTextContent('inleveren');
    cleanup();
    const p = setup({ preassessorId: null });
    fireEvent.click(screen.getByTestId('button-fb-add-marking'));
    expect(p.onNewEvaluator).toHaveBeenCalledWith('marking');
  });

  it('stap 3 biedt geen feedbackgever aan: aanwijzen zou die uit stap 2 weghalen', () => {
    setup();
    const options = Array.from(screen.getByTestId('select-preassessor').querySelectorAll('option')).map((o) => o.textContent);
    expect(options.some((o) => o?.includes('Nakijkhulp'))).toBe(true);
    expect(options.some((o) => o?.includes('Feedbackgever'))).toBe(false);
    cleanup();
    setup({ preassessorId: null });
    expect(screen.queryByTestId('select-preassessor')).toBeNull();
    expect(screen.getByTestId('text-fb-marking-none')).toBeInTheDocument();
    expect(screen.getByTestId('fb-step-feedback')).toHaveTextContent('Nakijkhulp');
  });

  it('criteria: oud (tekst) en nieuw ({ title }) formaat', () => {
    expect(criteriaLines(['A', { title: 'B' }, { name: 'C' }, null])).toBe('A\nB\nC');
    expect(criteriaLines(undefined)).toBe('');
  });
});
