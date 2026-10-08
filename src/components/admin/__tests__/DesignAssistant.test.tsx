// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../../i18n';

vi.mock('../../../contexts/AuthContext', () => ({ useAuth: () => ({ session: { access_token: 'tok' } }) }));
import { DesignAssistantDock } from '../DesignAssistant';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.removeItem('leap-design-assistant-open'); document.documentElement.style.removeProperty('--leap-side-panel'); });

function setup(config: Record<string, unknown>, { open = false, reply = 'Kijk eens bij [Quiz-bronnen](/admin?tab=quiz_sources).' } = {}) {
  try { localStorage.setItem('lair-vu-lang', 'nl'); localStorage.setItem('leap-design-assistant-open', open ? '1' : '0'); } catch { /* */ }
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/config') && (!init || !init.method || init.method === 'GET')) return { ok: true, json: async () => config } as unknown as Response;
    if (String(url).endsWith('/config')) return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    return { ok: true, json: async () => ({ reply }) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  const onNavigate = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <MemoryRouter><LanguageProvider>
      <DesignAssistantDock courseId="c1" courseName="E&B1" place="Cursusmateriaal → Begrippen"
        context={{ tab: 'material', step: 'concepts' }} onNavigate={onNavigate} onOpenChange={onOpenChange} />
    </LanguageProvider></MemoryRouter>,
  );
  return { fetchMock, onNavigate, onOpenChange };
}

describe('Ontwerphulp als zijpaneel', () => {
  it('dicht: alleen een lipje; openen onthoudt de keuze en schuift het takenvak opzij', async () => {
    const { onOpenChange } = setup({ enabled: true, isAdmin: false });
    fireEvent.click(await screen.findByTestId('button-design-open'));
    expect(screen.getByTestId('panel-design-assistant')).toBeInTheDocument();
    expect(localStorage.getItem('leap-design-assistant-open')).toBe('1');
    expect(document.documentElement.style.getPropertyValue('--leap-side-panel')).toBe('24rem');
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByTestId('button-design-close'));
    expect(screen.getByTestId('button-design-open')).toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('toont waar je bent en stuurt die plek mee met "Wat zie ik hier?"', async () => {
    const { fetchMock } = setup({ enabled: true, isAdmin: false }, { open: true });
    expect(await screen.findByTestId('text-design-place')).toHaveTextContent('Je bent bij: Cursusmateriaal → Begrippen');
    fireEvent.click(screen.getByTestId('button-design-explain-here'));
    await screen.findByTestId('design-reply-1');
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/chat'));
    const body = JSON.parse(String((call?.[1] as RequestInit).body));
    expect(body.context).toEqual({ tab: 'material', step: 'concepts' });
    expect(body.messages[0].content).toContain('Cursusmateriaal → Begrippen');
  });

  it('links in een antwoord openen het onderdeel achter het paneel; het paneel blijft open', async () => {
    const { onNavigate } = setup({ enabled: true, isAdmin: false }, { open: true });
    fireEvent.click(await screen.findByTestId('button-design-starter-check'));
    const reply = await screen.findByTestId('design-reply-1');
    fireEvent.click(reply.querySelector('a')!);
    expect(onNavigate).toHaveBeenCalledWith('quiz_sources');
    expect(screen.getByTestId('panel-design-assistant')).toBeInTheDocument();
  });

  it('staat hij uit, dan ziet een docent niets (ook geen lipje)', async () => {
    const { fetchMock } = setup({ enabled: false, isAdmin: false }, { open: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('button-design-open')).toBeNull();
    expect(screen.queryByTestId('panel-design-assistant')).toBeNull();
  });

  it('alleen de beheerder heeft het tandwiel met de instellingen', async () => {
    const { fetchMock } = setup({ enabled: true, isAdmin: true, prompt: 'Je bent…', isDefaultPrompt: true }, { open: true });
    fireEvent.click(await screen.findByTestId('button-design-settings'));
    fireEvent.click(screen.getByTestId('checkbox-design-enabled'));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/config') && (i as RequestInit)?.method === 'PUT')).toBe(true));
  });
});
