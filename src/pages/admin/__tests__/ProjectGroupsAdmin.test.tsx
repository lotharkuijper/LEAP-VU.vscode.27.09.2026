// @vitest-environment jsdom
// Groepen indelen (2026-11-11): wie nog geen groep heeft staat bovenaan, en in
// elke groep voeg je zelf studenten toe.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../i18n';
import { ProjectGroupsAdmin } from '../ProjectGroupsAdmin';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(state: { groups: unknown[]; unassigned: unknown[] }) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method || 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ groupMode: 'teacher', ...state }), { status: 200 });
  }));
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
  render(<LanguageProvider><ProjectGroupsAdmin projectId="p1" courseId="c1" token="tok" /></LanguageProvider>);
  return calls;
}

const groupA = { id: 'gA', name: 'Groep A', status: 'active', source: 'teacher', external_name: null, members: [{ userId: 's1', name: 'Anna', email: null }] };

describe('ProjectGroupsAdmin', () => {
  it('voegt in een groep een student toe die nog niet is ingedeeld', async () => {
    const calls = mount({ groups: [groupA], unassigned: [{ userId: 's2', name: 'Bram', email: null }] });
    const select = await screen.findByTestId('select-add-to-gA');
    expect(screen.getByTestId('panel-unassigned')).toHaveTextContent('Bram');
    fireEvent.change(select, { target: { value: 's2' } });
    await waitFor(() => expect(calls.some(c => c.method === 'PUT' && c.url.endsWith('/group-admin/members/s2'))).toBe(true));
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ groupId: 'gA' });
  });

  it('zegt het als iedereen is ingedeeld', async () => {
    mount({ groups: [groupA], unassigned: [] });
    expect(await screen.findByTestId('text-all-assigned')).toBeInTheDocument();
    expect(screen.queryByTestId('select-add-to-gA')).toBeNull();
  });

  it('zonder groepen: eerst een groep maken', async () => {
    mount({ groups: [], unassigned: [{ userId: 's2', name: 'Bram', email: null }] });
    expect(await screen.findByTestId('panel-unassigned')).toHaveTextContent('Maak eerst een groep');
  });
});
