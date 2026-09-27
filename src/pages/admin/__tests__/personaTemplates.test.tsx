// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// Minimale Supabase-stub: elke query-keten levert de rijen van de tabel.
const tables: Record<string, any[]> = {};
vi.mock('../../../lib/supabase', () => {
  const chain = (table: string) => {
    const q: any = {
      select: () => q, eq: () => q, in: () => q, order: () => q, not: () => q, limit: () => q,
      maybeSingle: async () => ({ data: (tables[table] || [])[0] ?? null, error: null }),
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

const tpl = (id: string, name: string) => ({ id, course_id: 'c1', name, avatar_emoji: '🤖', system_prompt: 'x', rag_enabled: true, rag_folder_ids: [], is_default: false });

describe('Sjabloon toevoegen aan een project', () => {
  it('toont per project of het sjabloon er al in zit en voegt toe via hetzelfde endpoint als het project', async () => {
    tables.course_personas = [tpl('tpl1', 'Wethouder')];
    tables.projects = [{ id: 'p1', title: 'Project Zorg' }, { id: 'p2', title: 'Project Wonen' }];
    tables.project_personas = [{ source_persona_id: 'tpl1', project_id: 'p1' }];
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ persona: { id: 'pp9', name: 'Wethouder' } }) }));
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/admin?tab=projects_admin&view=templates');
    fireEvent.click(await screen.findByTestId('button-fetch-cp-tpl1'));
    const rowZorg = await screen.findByTestId('row-add-to-project-p1');
    await waitFor(() => expect(rowZorg.textContent).toMatch(/zit er al in|already added/));
    expect(screen.getByTestId('button-add-to-project-p1').textContent).toMatch(/Nog een kopie|Another copy/);
    expect(screen.getByTestId('button-add-to-project-p2').textContent).toMatch(/^Toevoegen$|^Add$/);
    fireEvent.click(screen.getByTestId('button-add-to-project-p2'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/projects/p2/personas/from-library/tpl1', expect.anything()));
    expect((await screen.findByTestId('text-add-to-project-msg')).textContent).toMatch(/Project Wonen/);
    vi.unstubAllGlobals();
  });

  it('zonder projecten: een knop naar het tabblad Projecten in plaats van een lege lijst', async () => {
    tables.course_personas = [tpl('tpl1', 'Wethouder')];
    renderAt('/admin?tab=projects_admin&view=templates');
    fireEvent.click(await screen.findByTestId('button-fetch-cp-tpl1'));
    fireEvent.click(await screen.findByTestId('button-go-to-projects'));
    await waitFor(() => expect(screen.getByTestId('location').textContent).not.toContain('view=templates'));
  });

  it('na een nieuw sjabloon wordt meteen "Toevoegen aan project" aangeboden', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ persona: tpl('tplN', 'Journalist') }) }));
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/admin?tab=projects_admin&view=templates');
    fireEvent.click(await screen.findByTestId('button-new-cp'));
    fireEvent.change(screen.getByTestId('input-cp-name'), { target: { value: 'Journalist' } });
    fireEvent.click(screen.getByTestId('button-save-cp'));
    const notice = await screen.findByTestId('notice-cp-saved');
    expect(notice.textContent).toMatch(/Journalist/);
    fireEvent.click(screen.getByTestId('button-saved-add-to-project'));
    expect(await screen.findByTestId('dialog-add-to-project')).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe('Persona\'s in een project', () => {
  it('zonder sjablonen: uitleg en een knop naar Persona-sjablonen', async () => {
    tables.projects = [{ id: 'p1', title: 'Project Zorg', research_question: 'rq', rubric_criteria: [], course_id: 'c1' }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    renderAt('/admin?tab=projects_admin');
    fireEvent.click(await screen.findByTestId('button-detail-project-p1'));
    fireEvent.click(await screen.findByTestId('button-open-templates'));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('view=templates'));
    vi.unstubAllGlobals();
  });

  it('markeert sjablonen die al in het project zitten', async () => {
    tables.projects = [{ id: 'p1', title: 'Project Zorg', research_question: 'rq', rubric_criteria: [], course_id: 'c1' }];
    tables.course_personas = [tpl('tpl1', 'Wethouder'), tpl('tpl2', 'Journalist')];
    tables.project_personas = [{ id: 'pp1', project_id: 'p1', source_persona_id: 'tpl1', name: 'Wethouder', avatar_emoji: '🤖', system_prompt: 'x', rag_enabled: true, rag_folder_ids: [], sort_order: 0 }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    renderAt('/admin?tab=projects_admin');
    fireEvent.click(await screen.findByTestId('button-detail-project-p1'));
    const select = await screen.findByTestId('select-lib-persona');
    await waitFor(() => expect(select.textContent).toMatch(/Wethouder.*(al in dit project|already in this project)/));
    expect(select.textContent).not.toMatch(/Journalist.*(al in dit project|already in this project)/);
    expect(screen.getByTestId('button-import-from-lib').textContent).toMatch(/^Toevoegen$|^Add$/);
    vi.unstubAllGlobals();
  });
});
