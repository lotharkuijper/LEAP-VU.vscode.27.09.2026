// @vitest-environment jsdom
// Groepen indelen (2026-11-11): de studentenlijst staat in een pop-up
// ("Studenten indelen"): willekeurig verdelen of zelf een selectie indelen. In
// elke groep kun je ook direct een student toevoegen.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../../i18n';
import { ProjectGroupsAdmin } from '../ProjectGroupsAdmin';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mount(state: { groups: unknown[]; unassigned: unknown[] }, maxSize = 4) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method || 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (init?.method === 'POST' && url.endsWith('/groups')) return new Response(JSON.stringify({ group: { id: 'gNew' } }), { status: 200 });
    return new Response(JSON.stringify({ groupMode: 'teacher', ...state }), { status: 200 });
  }));
  try { localStorage.setItem('lair-vu-lang', 'nl'); } catch { /* */ }
  render(<MemoryRouter><LanguageProvider><ProjectGroupsAdmin projectId="p1" courseId="c1" token="tok" maxSize={maxSize} /></LanguageProvider></MemoryRouter>);
  return calls;
}

const s = (id: string, name: string) => ({ userId: id, name, email: null, student: true });
const groupA = { id: 'gA', name: 'Groep A', status: 'active', source: 'teacher', external_name: null, teacherGroup: false, members: [s('s1', 'Anna')] };
const testGroup = { id: 'gT', name: 'Testgroep docent', status: 'active', source: 'teacher', external_name: null, teacherGroup: true, members: [{ userId: 't1', name: 'Docent', email: null, student: false }] };

describe('ProjectGroupsAdmin', () => {
  it('voegt in een groep een student toe die nog niet is ingedeeld', async () => {
    const calls = mount({ groups: [groupA], unassigned: [s('s2', 'Bram')] });
    fireEvent.change(await screen.findByTestId('select-add-to-gA'), { target: { value: 's2' } });
    await waitFor(() => expect(calls.some(c => c.method === 'PUT' && c.url.endsWith('/group-admin/members'))).toBe(true));
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ userIds: ['s2'], groupId: 'gA' });
  });

  it('toont de studenten niet standaard, wel de stand en de knop', async () => {
    mount({ groups: [groupA], unassigned: [s('s2', 'Bram'), s('s3', 'Cas')] });
    expect(await screen.findByTestId('text-unassigned')).toHaveTextContent('3 studenten in de cursus, 2 nog niet ingedeeld');
    expect(screen.getByTestId('panel-unassigned')).not.toHaveTextContent('Bram');
    expect(screen.queryByTestId('dialog-project-students')).toBeNull();
  });

  it('pop-up: willekeurig verdelen met de maximale groepsgrootte', async () => {
    const calls = mount({ groups: [], unassigned: ['a', 'b', 'c', 'd', 'e'].map(x => s(x, x.toUpperCase())) }, 4);
    fireEvent.click(await screen.findByTestId('button-open-students'));
    const btn = screen.getByTestId('button-random-groups');
    expect(btn).toHaveTextContent('Verdeel 5 studenten over 2 nieuwe groepen');
    fireEvent.click(btn);
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/auto'))).toBe(true));
    expect(calls.find(c => c.url.endsWith('/auto'))!.body).toEqual({ size: 4, userIds: ['a', 'b', 'c', 'd', 'e'] });
  });

  it('pop-up: zoeken, selecteren en in een nieuwe groep zetten', async () => {
    const calls = mount({ groups: [groupA, testGroup], unassigned: [s('s2', 'Bram'), s('s3', 'Cas'), s('s4', 'Dirk')] });
    fireEvent.click(await screen.findByTestId('button-open-students'));
    fireEvent.change(screen.getByTestId('input-student-search'), { target: { value: 'a' } });
    expect(screen.getByTestId('check-student-s2')).toBeInTheDocument();
    expect(screen.getByTestId('check-student-s3')).toBeInTheDocument();
    expect(screen.queryByTestId('check-student-s4')).toBeNull();
    // De testgroep van de docent is geen keuze; de docent staat ook niet in de lijst.
    const target = screen.getByTestId('select-target-group');
    expect(target).not.toHaveTextContent('Testgroep docent');
    fireEvent.click(screen.getByTestId('check-only-unassigned'));
    expect(screen.queryByTestId('check-student-t1')).toBeNull();
    fireEvent.change(screen.getByTestId('input-student-search'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('check-student-s2'));
    fireEvent.click(screen.getByTestId('check-student-s4'));
    fireEvent.change(target, { target: { value: '__new__' } });
    fireEvent.change(screen.getByTestId('input-target-new-group'), { target: { value: 'Team Noord' } });
    fireEvent.click(screen.getByTestId('button-assign-selected'));
    await waitFor(() => expect(calls.some(c => c.method === 'PUT')).toBe(true));
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ name: 'Team Noord' });
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({ userIds: ['s2', 's4'], groupId: 'gNew' });
  });

  it('zonder studenten in de cursus: de pop-up wijst naar uitnodigen', async () => {
    mount({ groups: [], unassigned: [] });
    expect(await screen.findByTestId('text-no-students')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('button-open-students'));
    expect(screen.getByTestId('link-invite-students')).toHaveAttribute('href', '/admin?tab=members');
  });
});
