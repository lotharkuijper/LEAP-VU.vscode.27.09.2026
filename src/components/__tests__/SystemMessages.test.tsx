// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 't', user: { id: 'u1' } } } }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  },
}));

import { LanguageProvider } from '../../i18n';
import { SystemMessages } from '../SystemMessages';
import { useSystemMessages } from '../../lib/systemMessages';

const MSG = { id: 'm1', title: 'Onderhoud vanavond', body: 'Van 22:00 tot 23:00.', kind: 'warning', starts_at: '2026-10-16T10:00:00Z', ends_at: null };

function Harness() {
  const messages = useSystemMessages();
  return (
    <LanguageProvider>
      <span data-testid="count">{messages.length}</span>
      <SystemMessages messages={messages} />
    </LanguageProvider>
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* noop */ }
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/messages') return { ok: true, json: async () => ({ messages: [MSG] }) };
    return { ok: true, json: async () => ({ ok: true }) };
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('systeemberichten op het Dashboard', () => {
  it('toont het bericht en klikt het weg (meteen weg, en de server krijgt het door)', async () => {
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('system-message-m1')).toBeTruthy());
    expect(screen.getByText('Onderhoud vanavond')).toBeTruthy();
    expect(screen.getByTestId('count').textContent).toBe('1');
    fireEvent.click(screen.getByTestId('button-dismiss-message-m1'));
    await waitFor(() => expect(screen.queryByTestId('system-message-m1')).toBeNull());
    expect(screen.getByTestId('count').textContent).toBe('0');
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, init]) => u === '/api/messages/m1/dismiss' && (init as RequestInit)?.method === 'POST')).toBe(true));
  });
});
