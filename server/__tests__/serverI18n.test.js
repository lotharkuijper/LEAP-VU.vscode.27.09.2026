import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractMessages, buildTranslator, translateBody, normalizeLang, serverI18nMiddleware, translateServerMessage,
} from '../serverI18n.js';

// 2026-09-27: servermeldingen kwamen altijd in het Nederlands, ook als de
// interface in een andere taal stond. De middleware vertaalt ze nu.
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i18nDir = path.join(serverDir, 'i18n');
const LANGS = ['en', 'yue', 'zh', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'uk', 'ro', 'tr', 'ar', 'hi', 'id', 'ja', 'ko', 'hr', 'el'];

describe('extractMessages', () => {
  it('haalt meldingen uit error:/message:, new Error() en _MSG-constanten; ${…} wordt {0}', () => {
    const src = [
      "return res.status(403).json({ error: 'Geen toegang tot deze cursus' });",
      'throw new Error(`Kon document niet opzoeken: ${err.message}`);',
      "const FOO_MSG = 'Dienst is niet geconfigureerd';",
      "console.error('[x] load error:', err); return res.json({ ok: true });",
    ].join('\n');
    expect(extractMessages(src).sort()).toEqual([
      'Dienst is niet geconfigureerd', 'Geen toegang tot deze cursus', 'Kon document niet opzoeken: {0}',
    ]);
  });
});

describe('buildTranslator', () => {
  const t = buildTranslator(
    ['Geen toegang', 'Kon document niet opzoeken: {0}', 'Kon {0} niet opslaan in {1}'],
    { 'Geen toegang': 'No access', 'Kon document niet opzoeken: {0}': 'Could not look up document: {0}', 'Kon {0} niet opslaan in {1}': 'Could not save {0} in {1}' },
  );
  it('vertaalt vaste teksten en sjablonen, met de echte waarden terug op hun plek', () => {
    expect(t('Geen toegang')).toBe('No access');
    expect(t('Kon document niet opzoeken: relation x does not exist')).toBe('Could not look up document: relation x does not exist');
    expect(t('Kon het bestand niet opslaan in map A')).toBe('Could not save het bestand in map A');
  });
  it('laat onbekende teksten ongewijzigd', () => {
    expect(t('Iets heel anders')).toBe('Iets heel anders');
    expect(t('')).toBe('');
  });
});

describe('translateBody', () => {
  const tr = (s) => (s === 'Fout' ? 'Error' : s);
  it('vertaalt error/message/warning/hint en warnings[], zonder het origineel te wijzigen', () => {
    const body = { error: 'Fout', message: 'Fout', code: 'Fout', warnings: ['Fout', 'x'], data: { error: 'Fout' } };
    const out = translateBody(body, tr);
    expect(out).toMatchObject({ error: 'Error', message: 'Error', code: 'Fout', warnings: ['Error', 'x'], data: { error: 'Fout' } });
    expect(body.error).toBe('Fout');
  });
  it('laat arrays en niet-objecten ongemoeid', () => {
    expect(translateBody(['Fout'], tr)).toEqual(['Fout']);
    expect(translateBody(null, tr)).toBeNull();
  });
});

describe('serverI18nMiddleware', () => {
  const run = (lang, body) => {
    let sent;
    const req = { get: (h) => (h.toLowerCase() === 'x-leap-lang' ? lang : undefined) };
    const res = { json: (b) => { sent = b; return res; } };
    serverI18nMiddleware(req, res, () => {});
    res.json(body);
    return sent;
  };
  it('vertaalt een echte servermelding naar de taal uit X-LEAP-Lang', () => {
    const sent = run('en', { error: 'Geen docent-toegang tot deze cursus' });
    expect(sent.error).not.toBe('Geen docent-toegang tot deze cursus');
    expect(sent.error).toMatch(/teacher/i);
  });
  it('laat Nederlands en een ontbrekende taal ongewijzigd', () => {
    expect(run('nl', { error: 'Geen docent-toegang tot deze cursus' }).error).toBe('Geen docent-toegang tot deze cursus');
    expect(run(undefined, { error: 'Geen docent-toegang tot deze cursus' }).error).toBe('Geen docent-toegang tot deze cursus');
  });
  it('translateServerMessage werkt ook buiten res.json (streams)', () => {
    expect(translateServerMessage('Web-import mislukt.', 'de-DE')).not.toBe('Web-import mislukt.');
    expect(normalizeLang('en-GB,en;q=0.9')).toBe('en');
  });
});

describe('meldingenlijst en vertalingen zijn compleet', () => {
  const sources = JSON.parse(fs.readFileSync(path.join(i18nDir, 'messages.source.json'), 'utf8'));
  it('messages.source.json is actueel met de code (nieuwe melding → node scripts/extract-server-messages.mjs)', () => {
    const found = new Set();
    for (const f of fs.readdirSync(serverDir).filter((x) => x.endsWith('.js'))) {
      for (const m of extractMessages(fs.readFileSync(path.join(serverDir, f), 'utf8'))) found.add(m);
    }
    expect([...found].filter((m) => !sources.includes(m)), 'meldingen die nog niet in de lijst staan').toEqual([]);
  });
  it.each(LANGS)('elke servermelding heeft een vertaling in %s (node --env-file=.env scripts/server-i18n-generate.mjs)', (lang) => {
    const dict = JSON.parse(fs.readFileSync(path.join(i18nDir, `messages.${lang}.json`), 'utf8'));
    const missing = sources.filter((s) => !dict[s]);
    expect(missing.slice(0, 5), `${missing.length} ontbrekend`).toEqual([]);
    const badPlaceholders = sources.filter((s) => dict[s] && (s.match(/\{\d+\}/g) || []).sort().join() !== (dict[s].match(/\{\d+\}/g) || []).sort().join());
    expect(badPlaceholders).toEqual([]);
  });
});
