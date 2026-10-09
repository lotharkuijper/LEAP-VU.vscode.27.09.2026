// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../i18n';
import { buildDossierHtml, escapeHtml } from '../../lib/learningDossier';

const auth = { session: { access_token: 'tok' }, profile: { email: 'ik@vu.nl', role: 'student' } as { email: string; role: string }, signOut: vi.fn(async () => {}) };
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../../lib/supabase', () => ({ supabase: { from: () => ({ select: async () => ({ data: [] }) }) } }));
import { MyDataPage } from '../MyDataPage';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(role = 'student') {
  auth.profile = { email: 'ik@vu.nl', role };
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }) as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  render(<MemoryRouter><LanguageProvider><MyDataPage /></LanguageProvider></MemoryRouter>);
  return { fetchMock };
}

describe('Mijn gegevens', () => {
  it('account verwijderen kan pas na het typen van het eigen e-mailadres', async () => {
    const { fetchMock } = setup();
    const btn = screen.getByTestId('button-delete-account');
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByTestId('input-confirm-email'), { target: { value: 'iemand@vu.nl' } });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByTestId('input-confirm-email'), { target: { value: 'IK@vu.nl' } });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/me/delete-account');
    expect(JSON.parse(String(init.body))).toEqual({ confirmEmail: 'IK@vu.nl' });
  });

  it('een beheerder ziet uitleg in plaats van de verwijderknop', () => {
    setup('admin');
    expect(screen.queryByTestId('button-delete-account')).toBeNull();
    expect(screen.getByTestId('text-admin-cannot-delete')).toBeInTheDocument();
  });

  it('downloaden en leerdossier zijn er voor iedereen', () => {
    setup();
    expect(screen.getByTestId('button-download-json')).toBeInTheDocument();
    expect(screen.getByTestId('button-print-dossier')).toBeInTheDocument();
  });
});

describe('leerdossier', () => {
  const labels = {
    title: 'Leerdossier', exportedOn: 'Gemaakt op {date}', achievements: 'Prestaties', noAchievements: 'Geen',
    levels: 'Leerniveaus', level: 'Niveau {n}', journal: 'Leerdagboek', noJournal: 'Leeg',
    levelNames: { 3: 'Gemiddeld', 4: 'Gevorderd' }, courseUnknown: 'andere cursus',
  };
  it('prestaties, niveaus en dagboek; tekst wordt veilig weergegeven', () => {
    const html = buildDossierHtml({
      exportedAt: '2026-10-09T10:00:00Z',
      user: { email: 'ik@vu.nl' },
      sources: {
        profiles: [{ full_name: 'Sam' }],
        student_achievements: [{ topic_label: 'Confounding', level: 4, earned_at: '2026-10-01', course_id: 'c1' }],
        student_course_levels: [{ course_id: 'c1', level: 3 }],
        learning_journal_entries: [{ title: 'Week 1', content: '<script>alert(1)</script> geleerd', created_at: '2026-10-02', course_id: 'c1' }],
      },
    }, labels, { courseNames: { c1: 'E&B1' } });
    expect(html).toContain('Confounding');
    expect(html).toContain('Gevorderd');
    expect(html).toContain('E&amp;B1: Gemiddeld');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; geleerd');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Sam');
  });
  it('escapeHtml', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
