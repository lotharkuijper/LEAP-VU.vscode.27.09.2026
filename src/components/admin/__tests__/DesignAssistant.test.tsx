// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../../i18n';

vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ session: { access_token: 'tok' } }) }));
import { DesignAssistant } from '../DesignAssistant';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

function setup(config: Record<string, unknown>, reply = 'Kijk eens bij [Quiz-bronnen](/admin?tab=quiz_sources).') {
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/config') && (!init || !init.method || init.method === 'GET')) return { ok: true, json: async () => config } as unknown as Response;
    if (String(url).endsWith('/config')) return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    return { ok: true, json: async () => ({ reply }) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  const onNavigate = vi.fn();
  render(<MemoryRouter><LanguageProvider><DesignAssistant courseId="c1" courseName="E&B1" onNavigate={onNavigate} /></LanguageProvider></MemoryRouter>);
  return { fetchMock, onNavigate };
}

describe('Ontwerphulp', () => {
  it('is een aanbod: uitleg dat je hem niet hoeft te gebruiken, met voorbeeldvragen', async () => {
    setup({ enabled: true, isAdmin: false });
    expect(await screen.findByText(/weet je al wat je wilt, dan kun je gewoon direct naar de onderdelen/)).toBeInTheDocument();
    expect(screen.getByTestId('button-design-starter-goals')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-design-assistant-admin')).toBeNull();
  });

  it('stuurt de vraag met de cursus mee en toont het antwoord; links gaan naar het juiste tabblad', async () => {
    const { fetchMock, onNavigate } = setup({ enabled: true, isAdmin: false });
    fireEvent.click(await screen.findByTestId('button-design-starter-check'));
    const reply = await screen.findByTestId('design-reply-1');
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/chat'));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toMatchObject({ courseId: 'c1', messages: [{ role: 'user' }] });
    fireEvent.click(reply.querySelector('a')!);
    expect(onNavigate).toHaveBeenCalledWith('quiz_sources');
    expect(JSON.parse(sessionStorage.getItem('leap-design-assistant-c1') || '[]')).toHaveLength(2);
  });

  it('staat hij uit, dan ziet een docent alleen die melding', async () => {
    setup({ enabled: false, isAdmin: false });
    expect(await screen.findByText('De Ontwerphulp staat op dit moment uit.')).toBeInTheDocument();
    expect(screen.queryByTestId('input-design-question')).toBeNull();
  });

  it('alleen de beheerder ziet de instellingen en kan hem uitzetten', async () => {
    const { fetchMock } = setup({ enabled: true, isAdmin: true, prompt: 'Je bent…', isDefaultPrompt: true });
    fireEvent.click(await screen.findByTestId('checkbox-design-enabled'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/config') && (i as RequestInit)?.method === 'PUT')).toBe(true));
    const put = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith('/config') && (i as RequestInit)?.method === 'PUT');
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({ enabled: false });
  });
});
