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
  ingestion: [{ courseId: 'c1', name: 'E&B1', active: true, documents: 20, failed: 1, busy: 0, noChunks: 0, singleGiantChunk: 2, bytes: 5e6, chunks: 900 }],
  courses: [{ id: 'c1', name: 'E&B1' }],
  daily: {
    available: true, courseId: null, measuredSince: '2026-11-24', totalTokens: 7000,
    days: [
      { day: '2026-11-24', tokens: 6000, groups: { students: 1000, teachers: 5000, background: 0, other: 0 }, students: 7, staff: 1 },
      { day: '2026-11-25', tokens: 1000, groups: { students: 1000, teachers: 0, background: 0, other: 0 }, students: 3, staff: 0 },
    ],
    groups: { students: 2000, teachers: 5000, background: 0, other: 0 },
    parts: [{ key: 'admin/extract-concepts', group: 'teachers', tokens: 5000 }, { key: 'chat', group: 'students', tokens: 2000 }],
    courses: [{ courseId: 'c1', name: 'E&B1', tokens: 7000 }],
  },
};
const usage = {
  since: '2026-10-05', dailyAvailable: true, measuredSince: '2026-11-24', k: 5, enrolled: 40,
  daily: [{ day: '2026-11-24', activeStudents: 12, suppressed: false }, { day: '2026-11-25', activeStudents: null, suppressed: true }],
  weekly: [{ week: '2026-11-23', activeStudents: 20, suppressed: false, share: 0.5 }],
  parts: [
    { part: 'chat', weeks: [{ week: '2026-11-23', students: 15, suppressed: false }], actions: 60, share: 0.75 },
    { part: 'quiz', weeks: [{ week: '2026-11-23', students: 8, suppressed: false }], actions: 20, share: 0.25 },
    { part: 'journal', weeks: [{ week: '2026-11-23', students: null, suppressed: true }], actions: null, share: null },
  ],
  groups: { total: 2, suppressed: true, weeks: null },
  achievements: { k: 5, suppressed: false, total: 9, students: 6, share: 0.15, kinds: [{ kind: 'explain_clear', count: 9, students: 6 }], weeks: [] },
};

function setup(isAdmin: boolean) {
  auth.isAdmin = isAdmin;
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (String(url).includes('/platform') ? platform : String(url).includes('/usage') ? usage : thermometer),
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
    expect(fetchMock.mock.calls.map(([u]) => String(u)).sort()).toEqual(['/api/analytics/courses/c1/concepts?weeks=8', '/api/analytics/courses/c1/usage?weeks=8']);
    expect(screen.queryByTestId('section-costs')).toBeNull();
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
    expect(await screen.findByTestId('tile-costs-total')).toHaveTextContent(/7[.,]000/);
    expect(screen.getByTestId('row-group-teachers')).toHaveTextContent(/5[.,]000/);
    expect(screen.getByTestId('row-part-quiz')).toBeInTheDocument();
    expect(screen.getByTestId('row-ingestion-c1')).toHaveTextContent('1 mislukt');
    expect(screen.getByTestId('row-ingestion-c1')).toHaveTextContent('2 als één groot blok');
  });

  it('gebruik door studenten: per dag, verborgen onder 5, onderdelen en achievements', async () => {
    setup(false);
    expect(await screen.findByTestId('tile-active-this-week')).toHaveTextContent('20');
    expect(screen.getByTestId('tile-active-this-week')).toHaveTextContent('50%');
    expect(screen.getByTestId('chart-active-daily')).toHaveTextContent('verborgen');
    expect(screen.getByTestId('row-usage-part-chat')).toHaveTextContent('75%');
    expect(screen.getByTestId('row-usage-part-journal')).toHaveTextContent('verborgen');
    expect(screen.getByTestId('row-achievement-explain_clear')).toHaveTextContent('9');
    expect(screen.getByTestId('text-groups-hidden')).toBeInTheDocument();
  });
});
