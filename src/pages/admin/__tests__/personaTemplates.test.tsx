// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// Minimale Supabase-stub: elke query-keten levert de rijen van de tabel.
const tables: Record<string, any[]> = {};
vi.mock('../../../lib/supabase', () => {
  const chain = (table: string) => {
    const q: any = {
      select: () => q, eq: () => q, in: () => q, order: () => q,
      then: (resolve: any) => resolve({ data: tables[table] || [], error: null }),
    };
    return q;
  };
  return {
    supabase: {
      from: (t: string) => chain(t),
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 't' } } }) },
    },
  };
});
vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => ({ isAdmin: false, isDocent: true, session: { access_token: 't' } }),
}));
vi.mock('../../../contexts/ActiveCourseContext', () => ({
  useActiveCourse: () => ({ activeCourseId: 'c1', activeCourse: { id: 'c1', name: 'Epidemiologie' } }),
}));

import { LanguageProvider } from '../../../i18n';
import { ProjectsAdminTab } from '../ProjectsAdminTab';
import { usageBySource } from '../PersonaLibraryTab';

afterEach(() => { cleanup(); for (const k of Object.keys(tables)) delete tables[k]; });

function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="location">{loc.search}</span>;
}

const renderAt = (url: string) => render(
  <MemoryRouter initialEntries={[url]}>
    <LanguageProvider>
      <ProjectsAdminTab />
      <LocationProbe />
    </LanguageProvider>
  </MemoryRouter>,
);

describe('usageBySource', () => {
  it('geeft per sjabloon de projecttitels, zonder dubbelingen en alleen voor projecten van de cursus', () => {
    const m = usageBySource(
      [
        { source_persona_id: 'tpl1', project_id: 'p1' },
        { source_persona_id: 'tpl1', project_id: 'p1' },
        { source_persona_id: 'tpl1', project_id: 'p2' },
        { source_persona_id: null, project_id: 'p1' },
        { source_persona_id: 'tpl2', project_id: 'elders' },
      ],
      [{ id: 'p1', title: 'Zorg' }, { id: 'p2', title: 'Wonen' }],
    );
    expect(m.get('tpl1')).toEqual(['Zorg', 'Wonen']);
    expect(m.has('tpl2')).toBe(false);
  });
});

describe('Projecten → Persona-sjablonen', () => {
  it('toont standaard de projecten, met een tabblad naar de persona-sjablonen', async () => {
    tables.projects = [{ id: 'p1', title: 'Project Zorg', research_question: 'rq', rubric_criteria: [], course_id: 'c1' }];
    renderAt('/admin?tab=projects_admin');
    expect(await screen.findByTestId('project-row-p1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tab-projects-view-templates'));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('view=templates'));
    expect(await screen.findByTestId('button-new-cp')).toBeTruthy();
  });

  it('?view=templates opent de sjablonen met "gebruikt in" per sjabloon; docent mag bewerken', async () => {
    tables.course_personas = [
      { id: 'tpl1', course_id: 'c1', name: 'Wethouder', avatar_emoji: '🧑‍💼', system_prompt: 'x', rag_enabled: true, rag_folder_ids: [], is_default: false },
      { id: 'tpl2', course_id: 'c1', name: 'Journalist', avatar_emoji: '📰', system_prompt: 'y', rag_enabled: true, rag_folder_ids: [], is_default: false },
    ];
    tables.projects = [{ id: 'p1', title: 'Project Zorg' }];
    tables.project_personas = [{ source_persona_id: 'tpl1', project_id: 'p1' }];
    renderAt('/admin?tab=projects_admin&view=templates');
    await waitFor(() => expect(screen.getByTestId('text-cp-usage-tpl1').textContent).toMatch(/Project Zorg/));
    expect(screen.getByTestId('text-cp-usage-tpl2').textContent).not.toMatch(/Project Zorg/);
    expect(screen.getByTestId('button-edit-cp-tpl1')).toBeTruthy();
    // Terug naar de projecten haalt view uit de link.
    fireEvent.click(screen.getByTestId('tab-projects-view-projects'));
    await waitFor(() => expect(screen.getByTestId('location').textContent).not.toContain('view='));
  });
});
