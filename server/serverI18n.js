// Vertaling van servermeldingen (2026-09-27).
//
// De server stuurt foutmeldingen en statusmeldingen in het Nederlands. Zodat
// geen enkele tekst alleen in het Nederlands blijft, vertaalt een tussenlaag
// (middleware) elke `error`/`message`/`warning`/`hint` in een JSON-respons naar
// de taal die de client meestuurt in de header `X-LEAP-Lang` (de app zet die
// centraal op elke /api-aanroep, zie src/lib/apiLanguage.ts).
//
// Bron: server/i18n/messages.source.json — automatisch uit de code gehaald met
// `node scripts/extract-server-messages.mjs`. Vertalingen per taal:
// server/i18n/messages.<lang>.json ({ "<Nederlandse sjabloontekst>": "<vertaling>" }),
// aangevuld met `node --env-file=.env scripts/server-i18n-generate.mjs`.
// Sjablonen bevatten {0}, {1}, … op de plek van ${…} in de code; bij het
// vertalen worden de echte waarden (bv. een bestandsnaam) weer ingevuld.
// Onbekende teksten (bv. een technische fout van een externe dienst) gaan
// ongewijzigd door.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const I18N_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'i18n');
const TRANSLATED_FIELDS = ['error', 'message', 'warning', 'hint'];
const TRANSLATED_ARRAYS = ['warnings'];

// ── Extractie (ook gebruikt door scripts/extract-server-messages.mjs) ─────────
const LITERAL = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`;
const PATTERNS = [
  new RegExp(String.raw`\b(?:error|message|warning|hint)\s*:\s*` + LITERAL, 'g'),
  new RegExp(String.raw`new Error\(\s*` + LITERAL, 'g'),
  new RegExp(String.raw`\bconst [A-Z0-9_]+_MSG\s*=\s*` + LITERAL, 'g'),
  // Terugvalteksten: error: err.message || '…', d.error || '…'.
  new RegExp(String.raw`\b(?:error|message)\b[^\n;'"\x60]*?\|\|\s*` + LITERAL, 'g'),
];

/** Zet een letterlijke tekst uit de broncode om naar een sjabloon ({0}, {1}, …). */
export function literalToTemplate(quote, body) {
  let i = 0;
  let s = body;
  if (quote === '`') s = s.replace(/\$\{[^}]*\}/g, () => `{${i++}}`);
  return s.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');
}

/** Pure: alle kandidaat-meldingen uit één bronbestand. */
export function extractMessages(source) {
  const out = new Set();
  for (const re of PATTERNS) {
    for (const m of source.matchAll(re)) {
      // Een melding staat op één regel. Een treffer met een regeleinde is een
      // valse start (bv. 'load error:' in een console-tekst) die dwars door
      // de code tot het volgende aanhalingsteken loopt.
      if (m[2].includes('\n')) continue;
      const t = literalToTemplate(m[1], m[2]).trim();
      // Alleen echte zinnen: letters, en niet puur een {0}-doorgeefluik.
      if (t.length < 6 || !/[A-Za-zÀ-ÿ]{3}/.test(t.replace(/\{\d+\}/g, ''))) continue;
      out.add(t);
    }
  }
  return [...out];
}

// ── Vertalen ─────────────────────────────────────────────────────────────────
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pure: bouw een vertaler uit bronsjablonen + een woordenboek {bron → vertaling}. */
export function buildTranslator(sources, dict) {
  const exact = new Map();
  const templated = [];
  for (const src of sources) {
    const tr = dict[src];
    if (!tr) continue;
    if (/\{\d+\}/.test(src)) {
      const parts = src.split(/\{(\d+)\}/);
      let re = '^';
      const order = [];
      for (let k = 0; k < parts.length; k++) {
        if (k % 2 === 0) re += escapeRe(parts[k]);
        else { re += '([\\s\\S]*?)'; order.push(Number(parts[k])); }
      }
      re += '$';
      templated.push({ re: new RegExp(re), order, tr, fixedLen: src.replace(/\{\d+\}/g, '').length });
    } else {
      exact.set(src, tr);
    }
  }
  // Langste vaste tekst eerst: het meest specifieke sjabloon wint.
  templated.sort((a, b) => b.fixedLen - a.fixedLen);
  return (text) => {
    if (typeof text !== 'string' || !text) return text;
    const hit = exact.get(text);
    if (hit) return hit;
    for (const t of templated) {
      const m = t.re.exec(text);
      if (!m) continue;
      const values = {};
      t.order.forEach((n, idx) => { values[n] = m[idx + 1]; });
      return t.tr.replace(/\{(\d+)\}/g, (_, n) => (values[n] !== undefined ? values[n] : ''));
    }
    return text;
  };
}

/** Pure: vertaal de meldingsvelden van een JSON-body (niet-muterend). */
export function translateBody(body, translate) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  let changed = null;
  for (const f of TRANSLATED_FIELDS) {
    if (typeof body[f] === 'string') {
      const t = translate(body[f]);
      if (t !== body[f]) { changed = changed || { ...body }; changed[f] = t; }
    }
  }
  for (const f of TRANSLATED_ARRAYS) {
    if (Array.isArray(body[f]) && body[f].some((x) => typeof x === 'string')) {
      const arr = body[f].map((x) => (typeof x === 'string' ? translate(x) : x));
      if (arr.some((x, i) => x !== body[f][i])) { changed = changed || { ...body }; changed[f] = arr; }
    }
  }
  return changed || body;
}

export function normalizeLang(raw) {
  const l = String(raw || '').trim().toLowerCase().split(/[-_,;]/)[0];
  return /^[a-z]{2,3}$/.test(l) ? l : null;
}

// ── Bestanden laden (lazy, per taal gecachet) ────────────────────────────────
let sourcesCache = null;
const translators = new Map();
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(I18N_DIR, file), 'utf8')); } catch { return fallback; }
}
export function translatorFor(lang) {
  if (!lang || lang === 'nl') return null;
  if (!translators.has(lang)) {
    sourcesCache = sourcesCache || loadJson('messages.source.json', []);
    const dict = loadJson(`messages.${lang}.json`, null) || (lang !== 'en' ? loadJson('messages.en.json', {}) : {});
    translators.set(lang, buildTranslator(sourcesCache, dict));
  }
  return translators.get(lang);
}

/** Vertaal één losse melding (bv. in een NDJSON-stream). */
export function translateServerMessage(text, lang) {
  const tr = translatorFor(normalizeLang(lang));
  return tr ? tr(text) : text;
}

/** Express-middleware: vertaalt meldingen in res.json() naar de taal van de client. */
export function serverI18nMiddleware(req, res, next) {
  const lang = normalizeLang(req.get('x-leap-lang'));
  const tr = translatorFor(lang);
  if (tr) {
    const original = res.json.bind(res);
    res.json = (body) => original(translateBody(body, tr));
  }
  next();
}
