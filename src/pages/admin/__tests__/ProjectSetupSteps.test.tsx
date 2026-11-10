// @vitest-environment jsdom
// Een project inrichten in stappen (2026-11-11): controlelijst per stap en het
// openen van een concept voor studenten.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../../i18n';
import { setupIssues, ProjectStepNav, type SetupFacts } from '../ProjectSetupSteps';
import { ProjectReadyStep } from '../ProjectReadyStep';
import nl from '../../../i18n/locales/nl.json';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ready: SetupFacts = {
  project: { title: 'Noord', research_question: 'Hoe leefbaar?', briefing_markdown: 'Lees eerst…', status: 'draft', submissions_enabled: true, group_mode: 'teacher' },
  docs: [{ material_kind: 'assignment', is_visible_to_students: true }, { material_kind: 'rubric', is_visible_to_students: true }],
  personas: [
    { id: 'g', name: 'Ambtenaar', persona_type: 'conversational', project_knowledge_doc_ids: ['d1'] },
    { id: 'f', name: 'Feedbackgever', persona_type: 'evaluator', project_knowledge_doc_ids: ['r1'] },
  ],
  preassessorId: 'm',
  canvasLinked: null,
};

function wrap(ui: React.ReactNode) {
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
  return render(<MemoryRouter><LanguageProvider>{ui}</LanguageProvider></MemoryRouter>);
}

describe('setupIssues', () => {
  it('een compleet project heeft geen aandachtspunten', () => {
    expect(setupIssues(ready)).toEqual([]);
  });

  it('vindt per stap wat ontbreekt', () => {
    const issues = setupIssues({
      ...ready,
      project: { ...ready.project, briefing_markdown: '', group_mode: 'canvas' },
      docs: [{ material_kind: 'rubric', is_visible_to_students: false }],
      personas: [{ id: 'f', name: 'Feedbackgever', persona_type: 'evaluator', project_knowledge_doc_ids: [] }],
      preassessorId: null,
      canvasLinked: false,
    });
    const keys = issues.map((i) => `${i.step}:${i.key}${i.optional ? '?' : ''}`);
    expect(keys).toEqual([
      'task:noBriefing', 'material:noMaterial?', 'personas:noPersonas',
      'feedback:rubricHidden', 'feedback:evaluatorNoRubric', 'feedback:noMarking?', 'groups:canvasNotLinked?',
    ]);
  });

  it('elk aandachtspunt heeft een Nederlandse tekst', () => {
    const all = setupIssues({
      project: { status: 'draft', submissions_enabled: true, group_mode: 'canvas' },
      docs: [{ material_kind: 'rubric', is_visible_to_students: false }, { material_kind: 'assignment', is_visible_to_students: false }],
      personas: [{ id: 'g', name: 'G' }, { id: 'e', name: 'E', persona_type: 'evaluator' }],
      preassessorId: null, canvasLinked: false,
    }).concat(setupIssues({ ...ready, docs: [], personas: [] }));
    const keys = new Set(all.map((i) => i.key));
    expect(keys.size).toBeGreaterThanOrEqual(9);
    for (const k of keys) expect((nl as Record<string, string>)[`admin.projects.ready.issue.${k}`], k).toBeTruthy();
  });

  it('Canvas nog niet gekoppeld: de stap Groepen mag overgeslagen worden (geen probleem in de balk)', () => {
    wrap(<ProjectStepNav step="task" onStep={vi.fn()} isOpen={false}
      issues={setupIssues({ ...ready, project: { ...ready.project, group_mode: 'canvas' }, canvasLinked: false })} />);
    expect(screen.getByTestId('step-status-groups')).toHaveTextContent('In orde');
    expect(screen.getByTestId('step-status-open')).toHaveTextContent('Concept');
    expect(screen.queryByTestId('step-running')).toBeNull();
  });
});

describe('ProjectReadyStep', () => {
  it('concept: uitleg over de eigen testgroep en openen na bevestiging', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const onStatusChanged = vi.fn();
    wrap(<ProjectReadyStep projectId="p1" status="draft" issues={[]} token="t" onGoTo={vi.fn()} onStatusChanged={onStatusChanged} onError={vi.fn()} />);
    expect(screen.getByTestId('section-project-tryout')).toHaveTextContent('testgroep');
    expect(screen.getByTestId('text-ready-ok')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('button-open-project'));
    fireEvent.click(await screen.findByTestId('button-confirm-project-status'));
    await waitFor(() => expect(onStatusChanged).toHaveBeenCalledWith('active'));
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ status: 'active' }) }));
  });

  it('aandachtspunten linken naar hun stap; een open project kan terug naar concept', () => {
    const onGoTo = vi.fn();
    wrap(<ProjectReadyStep projectId="p1" status="active" issues={[{ step: 'task', key: 'noBriefing' }]} token="t" onGoTo={onGoTo} onStatusChanged={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByTestId('ready-issue-noBriefing').querySelector('button')!);
    expect(onGoTo).toHaveBeenCalledWith('task');
    expect(screen.queryByTestId('button-open-project')).toBeNull();
    expect(screen.getByTestId('button-back-to-draft')).toBeInTheDocument();
  });
});
