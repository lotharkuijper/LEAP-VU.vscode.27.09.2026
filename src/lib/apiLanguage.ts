// Stuurt bij elke aanroep van de eigen API (/api/…) de gekozen interfacetaal
// mee in de header X-LEAP-Lang. De server vertaalt daarmee zijn foutmeldingen
// en statusmeldingen (server/serverI18n.js), zodat geen melding alleen in het
// Nederlands verschijnt. Eén centrale plek i.p.v. elke fetch-aanroep apart.
import { getActiveLang } from '../i18n/activeLang';

export const LANG_HEADER = 'X-LEAP-Lang';

/** Pure: is dit een aanroep van onze eigen API? */
export function isOwnApiRequest(url: string, origin: string): boolean {
  if (url.startsWith('/api/') || url === '/api') return true;
  try {
    const u = new URL(url, origin);
    return u.origin === origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/** Pure: headers aanvullen met de taal, zonder een expliciet gezette waarde te overschrijven. */
export function withLanguageHeader(headers: HeadersInit | undefined, lang: string): Headers {
  const h = new Headers(headers || {});
  if (!h.has(LANG_HEADER)) h.set(LANG_HEADER, lang);
  return h;
}

let installed = false;

/** Eenmalig bij het opstarten (src/main.tsx). */
export function installApiLanguageHeader(win: Window & typeof globalThis = window): void {
  if (installed || typeof win.fetch !== 'function') return;
  installed = true;
  const original = win.fetch.bind(win);
  win.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!isOwnApiRequest(url, win.location.origin)) return original(input, init);
    if (input instanceof Request && !init) {
      return original(new Request(input, { headers: withLanguageHeader(input.headers, getActiveLang()) }));
    }
    return original(input, { ...init, headers: withLanguageHeader(init?.headers, getActiveLang()) });
  }) as typeof fetch;
}
