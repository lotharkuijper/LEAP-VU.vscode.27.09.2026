// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../i18n';

const auth = { isAdmin: false, session: { access_token: 'tok' } };
vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../../contexts/ActiveCourseContext', () => ({
  useActiveCourse: () => ({ activeCourseId: 'c1', activeCourse: { id: 'c1', name: 'E&B1' } }),
}));
import { AnalyticsAdminTab } from '../AnalyticsAdminTab';

const thermometer = {
  since: '2026-08-17', measuredSince: '2026-10-05', k: 5,
  quiz: { attempts: 40, avgScore: 68, suppressed: false },
  chat: { hit: 30, miss: 10 },
  concepts: [
    { name: 'Bias', quiz: { attempts: 12, avgScore: 81, suppressed: false }, chat: { asked: 2, misses: 0 } },
    { name: 'Confounding', quiz: { attempts: 9, avgScore: 42, suppressed: false }, chat: { asked: 6, misses: 4 } },
    { name: 'Odds ratio', quiz: { attempts: null, avgScore: null, suppressed: true }, chat: { asked: 0, misses: 0 } },
    { name: 'Zeldzaam', quiz: { attempts: null, avgScore: null, suppressed: false }, chat: { asked: 0, misses: 0 } },
  ],
  weekly: [],
};
const platform = {
  since: '2026-10-05',
  parts: [{ key: 'quiz', requests: 100, errors: 2, slow: 0, avgMs: 900, errorRate: 0.02, llmCalls: 40, tokens: 120000 }],
  totals: { requests: 100, errors: 2, tokens: 120000, llmCalls: 40 },
  tokensByCourse: [{ courseId: 'c1', name: 'E&B1', tokens: 120000 }],
  tokensByWeek: [{ week: '2026-10-05', tokens: 120000 }],
  ingestion: [{ courseId: 'c1', name: 'E&B1', active: true, documents: 20, failed: 1, busy: 0, noChunks: 0, singleGiantChunk: 2, bytes: 5e6, chunks: 900 }],
};

function setup(isAdmin: boolean) {
  auth.isAdmin = isAdmin;
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (String(url).includes('/platform') ? platform : thermometer),
  }) as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  const onOpenMaterial = vi.fn();
  render(<LanguageProvider><AnalyticsAdminTab onOpenMaterial={onOpenMaterial} /></LanguageProvider>);
  return { fetchMock, onOpenMaterial };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Analyse-tabblad', () => {
  it('docent: thermometer van de eigen cursus, geen platformcijfers', async () => {
    const { fetchMock } = setup(false);
    expect(await screen.findByTestId('tile-quiz-avg')).toHaveTextContent('68%');
    expect(screen.getByTestId('tile-chat-evidence')).toHaveTextContent('75%');
    expect(screen.queryByTestId('section-platform')).toBeNull();
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual(['/api/analytics/courses/c1/concepts?weeks=8']);
  });

  it('minder dan 5 studenten: geen cijfer, wel uitleg', async () => {
    setup(false);
    expect(await screen.findByTestId('text-quiz-hidden-Odds ratio')).toHaveTextContent('minder dan 5 studenten');
  });

  it('meeste aandacht eerst: laagste score bovenaan; gaten in het materiaal apart', async () => {
    const { onOpenMaterial } = setup(false);
    await screen.findByTestId('block-concepts');
    const names = screen.getAllByTestId(/^row-concept-/).map(el => el.getAttribute('data-testid'));
    expect(names).toEqual(['row-concept-Confounding', 'row-concept-Bias', 'row-concept-Odds ratio']);
    expect(screen.getByTestId('row-gap-Confounding')).toHaveTextContent('4 van 6');
    expect(screen.queryByTestId('row-gap-Bias')).toBeNull();
    fireEvent.click(screen.getByTestId('button-open-material'));
    expect(onOpenMaterial).toHaveBeenCalled();
  });

  it('begrippen zonder gegevens pas na "toon alle"', async () => {
    setup(false);
    await screen.findByTestId('block-concepts');
    expect(screen.queryByTestId('row-concept-Zeldzaam')).toBeNull();
    fireEvent.click(screen.getByTestId('button-toggle-all-concepts'));
    expect(screen.getByTestId('row-concept-Zeldzaam')).toBeInTheDocument();
  });

  it('periode wijzigen haalt opnieuw op', async () => {
    const { fetchMock } = setup(false);
    await screen.findByTestId('block-concepts');
    fireEvent.change(screen.getByTestId('select-analytics-period'), { target: { value: '16' } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('weeks=16'))).toBe(true));
  });

  it('beheerder: ook gezondheid en kosten', async () => {
    setup(true);
    expect(await screen.findByTestId('tile-tokens')).toHaveTextContent(/120[.,]000/);
    expect(screen.getByTestId('row-part-quiz')).toBeInTheDocument();
    expect(screen.getByTestId('row-ingestion-c1')).toHaveTextContent('1 mislukt');
    expect(screen.getByTestId('row-ingestion-c1')).toHaveTextContent('2 als één groot blok');
  });
});
