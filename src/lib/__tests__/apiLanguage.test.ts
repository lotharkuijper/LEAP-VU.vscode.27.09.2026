// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { isOwnApiRequest, withLanguageHeader, installApiLanguageHeader, LANG_HEADER } from '../apiLanguage';

describe('apiLanguage', () => {
  it('herkent alleen aanroepen van de eigen API', () => {
    expect(isOwnApiRequest('/api/chat', 'http://localhost:5173')).toBe(true);
    expect(isOwnApiRequest('http://localhost:5173/api/x', 'http://localhost:5173')).toBe(true);
    expect(isOwnApiRequest('https://example.supabase.co/rest/v1/x', 'http://localhost:5173')).toBe(false);
    expect(isOwnApiRequest('/assets/app.js', 'http://localhost:5173')).toBe(false);
  });

  it('vult de taal aan zonder een expliciete waarde of andere headers te overschrijven', () => {
    const h = withLanguageHeader({ Authorization: 'Bearer x' }, 'de');
    expect(h.get(LANG_HEADER)).toBe('de');
    expect(h.get('Authorization')).toBe('Bearer x');
    expect(withLanguageHeader({ [LANG_HEADER]: 'fr' }, 'de').get(LANG_HEADER)).toBe('fr');
  });

  it('stuurt bij /api-aanroepen de gekozen taal mee, en niet naar andere domeinen', async () => {
    localStorage.setItem('lair-vu-lang', 'en');
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response('{}');
    });
    const win = { fetch: fake, location: { origin: 'http://localhost:5173' } } as unknown as Window & typeof globalThis;
    installApiLanguageHeader(win);
    await win.fetch('/api/admin/course-files/c1', { headers: { Authorization: 'Bearer t' } });
    await win.fetch('https://example.supabase.co/rest/v1/x');
    expect(calls[0].headers.get(LANG_HEADER)).toBe('en');
    expect(calls[0].headers.get('Authorization')).toBe('Bearer t');
    expect(calls[1].headers.get(LANG_HEADER)).toBeNull();
  });
});
