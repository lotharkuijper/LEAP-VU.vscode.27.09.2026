// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 't' } } }) } },
}));
vi.mock('../../../contexts/ActiveCourseContext', () => ({
  useActiveCourse: () => ({ activeCourseId: 'c1', activeCourse: { id: 'c1', name: 'Statistiek 1' } }),
}));

import { LanguageProvider } from '../../../i18n';
import { FilesStep } from '../FilesStep';
import { WebImportPanel, groupPagesBySection } from '../../WebImportPanel';
import type { CourseFile, WebSource } from '../../../services/course-files.service';

const page = (id: string, over: Partial<CourseFile> = {}): CourseFile => ({
  id, title: `Pagina ${id}`, filename: `Pagina ${id}`, file_type: 'web', file_size: null,
  created_at: '', processing_status: 'completed', total_chunks: 3, isWeb: true, folderName: 'RAG',
  purpose: 'course_material', purposeConfirmed: true, suggestion: null,
  url: `https://boek.vu.nl/biostat/${id}.html`, webSourceId: 's1', ...over,
});

const source: WebSource = {
  id: 's1', baseUrl: 'https://boek.vu.nl/biostat/', title: 'boek.vu.nl/biostat', purpose: 'course_material',
  createdAt: '2026-09-01', lastSyncedAt: '2026-09-20T10:00:00Z',
  lastSync: { total: 3, imported: 2, unchanged: 0, skipped: 0, errors: 1, notFound: 1 },
  pageCount: 2, chunkCount: 6, failedPages: 0,
};

const ndjson = (events: object[]) => {
  const body = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: bytes })) }) },
    json: async () => ({}),
  };
};

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const wrap = (ui: React.ReactNode) => render(<LanguageProvider>{ui}</LanguageProvider>);

describe('groupPagesBySection', () => {
  it('groepeert pagina’s per map onder de start-URL, hoofdpagina’s eerst', () => {
    const groups = groupPagesBySection([
      { url: 'https://x.nl/boek/h2/a.html', title: '' },
      { url: 'https://x.nl/boek/index.html', title: '' },
      { url: 'https://x.nl/boek/h1/b.html', title: '' },
      { url: 'https://x.nl/boek/h1/c.html', title: '' },
    ], 'https://x.nl/boek/');
    expect(groups.map(g => [g.section, g.pages.length])).toEqual([['', 1], ['h1', 2], ['h2', 1]]);
  });
});

describe('FilesStep — websites als één bron', () => {
  it('toont een website als één rij en niet elke pagina los', () => {
    wrap(<FilesStep courseId="c1" files={[page('a'), page('b')]} projects={[]} webSources={[source]} onChanged={() => {}} onGoToProjects={() => {}} />);
    const row = screen.getByTestId('row-web-source-s1');
    expect(row.textContent).toMatch(/boek\.vu\.nl\/biostat/);
    expect(row.textContent).toMatch(/2/);
    expect(screen.queryByTestId('row-file-a')).toBeNull();
    // Problemen van de laatste ophaling zijn zichtbaar.
    expect(screen.getByTestId('badge-web-problems-s1')).toBeTruthy();
    // Openklappen toont de pagina's.
    fireEvent.click(screen.getByTestId('button-toggle-web-source-s1'));
    expect(screen.getByTestId('list-web-pages-s1').textContent).toMatch(/Pagina a/);
  });

  it('opnieuw ophalen stuurt de bron mee en meldt verdwenen pagina’s', async () => {
    fetchMock.mockResolvedValue(ndjson([
      { type: 'start', total: 2 },
      { type: 'done', imported: 1, skipped: 0, errors: 1, totalChunks: 3, folderId: 'f', courseName: 'C', results: [], webSourceId: 's1',
        summary: { total: 2, imported: 1, unchanged: 0, skipped: 0, errors: 1, notFound: 1 } },
    ]));
    const onChanged = vi.fn();
    wrap(<FilesStep courseId="c1" files={[page('a'), page('b')]} projects={[]} webSources={[source]} onChanged={onChanged} onGoToProjects={() => {}} />);
    fireEvent.click(screen.getByTestId('button-resync-web-source-s1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/import-web/import');
    expect(JSON.parse(init.body)).toMatchObject({ courseId: 'c1', webSourceId: 's1', resync: true });
    expect(screen.getByTestId('text-web-source-notice-s1').textContent).toMatch(/1/);
  });

  it('opent ‘Website toevoegen’ vanuit Bestanden', () => {
    wrap(<FilesStep courseId="c1" files={[]} projects={[]} onChanged={() => {}} onGoToProjects={() => {}} />);
    fireEvent.click(screen.getByTestId('button-add-website'));
    expect(screen.getByTestId('dialog-add-website')).toBeTruthy();
    expect(screen.getByTestId('input-web-url')).toBeTruthy();
  });
});

describe('WebImportPanel — doel kiezen', () => {
  it('stuurt het gekozen doel mee met de import', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pages: [{ url: 'https://x.nl/boek/a.html', title: 'A' }], method: 'sitemap', warnings: [], baseUrl: 'https://x.nl/boek/' }) })
      .mockResolvedValueOnce(ndjson([{ type: 'done', imported: 1, skipped: 0, errors: 0, totalChunks: 2, folderId: 'f', courseName: 'C', results: [] }]));
    const onImported = vi.fn();
    wrap(<WebImportPanel courseId="c1" embedded onImported={onImported} />);
    fireEvent.change(screen.getByTestId('input-web-url'), { target: { value: 'https://x.nl/boek/' } });
    fireEvent.click(screen.getByTestId('button-discover-web'));
    await screen.findByTestId('fieldset-web-purpose');
    fireEvent.click(screen.getByTestId('radio-web-purpose-course_info'));
    fireEvent.click(screen.getByTestId('button-import-web-pages'));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body).toMatchObject({ courseId: 'c1', purpose: 'course_info', baseUrl: 'https://x.nl/boek/' });
  });
});
