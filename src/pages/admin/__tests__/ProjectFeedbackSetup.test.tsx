// @vitest-environment jsdom
// Feedback en beoordeling (2026-11-10): drie stappen, de rubric is openbaar, de
// nakijkhulp hoort niet bij de feedbackgevers voor studenten.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
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
    onNewEvaluator: vi.fn(), onPersonasChanged: vi.fn(), onEditPersona: vi.fn(), onDeletePersona: vi.fn(), onError: vi.fn(), onInfo: vi.fn(),
    onProjectPatched: vi.fn(),
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
    expect(screen.getByTestId('fb-step-marking')).toHaveTextContent(/inleveren/i);
    cleanup();
    const p = setup({ preassessorId: null });
    // Alleen feedbackgevers: stap 3 is uit beeld tot de docent ook nakijkcommentaar kiest.
    expect(screen.queryByTestId('fb-step-marking')).toBeNull();
    fireEvent.click(screen.getByTestId('radio-fb-mode-both'));
    fireEvent.click(screen.getByTestId('button-fb-add-marking'));
    expect(p.onNewEvaluator).toHaveBeenCalledWith('marking');
  });

  it('stap 3 biedt geen feedbackgever aan: geen keuzelijst, alleen de eigen nakijkhulp', () => {
    setup();
    expect(screen.queryByTestId('select-preassessor')).toBeNull();
    expect(screen.getByTestId('fb-marker')).toHaveTextContent('Nakijkhulp');
    expect(screen.getByTestId('fb-step-marking')).not.toHaveTextContent('Feedbackgever');
    cleanup();
    setup({ preassessorId: null });
    fireEvent.click(screen.getByTestId('radio-fb-mode-both'));
    expect(screen.queryByTestId('fb-marker')).toBeNull();
    expect(screen.getByTestId('text-fb-marking-none')).toBeInTheDocument();
    expect(screen.getByTestId('fb-step-feedback')).toHaveTextContent('Nakijkhulp');
  });

  it('nakijkhulp loslaten maakt er bewust een feedbackgever van', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const p = setup();
    fireEvent.click(screen.getByTestId('button-fb-marker-to-feedback'));
    await waitFor(() => expect(p.onPreassessorChange).toHaveBeenCalledWith(null));
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/preassessment-persona', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ personaId: null }) }));
    vi.unstubAllGlobals();
  });

  it('elke bot is hier te bewerken en te verwijderen', () => {
    const p = setup();
    fireEvent.click(screen.getByTestId('button-fb-edit-e1'));
    expect(p.onEditPersona).toHaveBeenCalledWith(personas[0]);
    fireEvent.click(screen.getByTestId('button-fb-delete-e2'));
    expect(p.onDeletePersona).toHaveBeenCalledWith(personas[1]);
  });

  it('keuze bovenaan: begint bij wat er al is; niets ingesteld = eerst kiezen', () => {
    setup();
    expect(screen.getByTestId('radio-fb-mode-both')).toBeChecked();
    cleanup();
    setup({ personas: [personas[2]], preassessorId: null });
    expect(screen.getByTestId('text-fb-mode-choose')).toBeInTheDocument();
    expect(screen.queryByTestId('fb-step-feedback')).toBeNull();
    expect(screen.queryByTestId('fb-step-marking')).toBeNull();
    fireEvent.click(screen.getByTestId('radio-fb-mode-marking'));
    expect(screen.getByTestId('fb-step-marking')).toBeInTheDocument();
    expect(screen.queryByTestId('fb-step-feedback')).toBeNull();
  });

  it('alleen nakijkcommentaar terwijl er nog feedbackgevers zijn: waarschuwing, en ze blijven te verwijderen', () => {
    setup();
    fireEvent.click(screen.getByTestId('radio-fb-mode-marking'));
    expect(screen.getByTestId('hint-fb-leftover-feedback')).toBeInTheDocument();
    expect(screen.getByTestId('button-fb-delete-e1')).toBeInTheDocument();
  });

  it('inleveren staat uit: aanzetten kan hier', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const p = setup({ project: { id: 'p1', rubric_criteria: [], submissions_enabled: false } });
    fireEvent.click(screen.getByTestId('button-fb-enable-submissions'));
    await waitFor(() => expect(p.onProjectPatched).toHaveBeenCalledWith({ submissions_enabled: true }));
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ submissions_enabled: true }) }));
    vi.unstubAllGlobals();
  });

  it('wat leest de nakijkhulp: product, rubric, projectdocumenten en de leerstof als maatstaf', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    setup();
    const card = screen.getByTestId('card-marker-reads');
    expect(card).toHaveTextContent('Het ingeleverde eindproduct');
    expect(screen.getByTestId('marker-doc-d1')).not.toBeChecked();
    expect(screen.getByTestId('marker-course-none')).toBeChecked();
    fireEvent.click(screen.getByTestId('marker-doc-d2'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/personas/e2', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ project_knowledge_doc_ids: ['d2'] }) })));
    fireEvent.click(screen.getByTestId('marker-course-all'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/personas/e2', expect.objectContaining({ body: JSON.stringify({ course_knowledge: 'all' }) })));
    cleanup();
    const marker = { ...personas[1], course_knowledge: 'selected' as const, course_knowledge_doc_ids: ['x', 'y'] };
    const p2 = setup({ personas: [personas[0], marker] });
    expect(screen.getByTestId('card-marker-reads')).toHaveTextContent('2 bestand(en) gekozen');
    fireEvent.click(screen.getByTestId('button-marker-choose-files'));
    expect(p2.onEditPersona).toHaveBeenCalledWith(marker);
    vi.unstubAllGlobals();
  });

  it('criteria: oud (tekst) en nieuw ({ title }) formaat', () => {
    expect(criteriaLines(['A', { title: 'B' }, { name: 'C' }, null])).toBe('A\nB\nC');
    expect(criteriaLines(undefined)).toBe('');
  });
});
