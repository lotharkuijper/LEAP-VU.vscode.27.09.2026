// LEAP is niet aan één vak gebonden (2026-10-15). Schermteksten en de vaste
// instructies aan het taalmodel mogen geen vakinhoud bevatten (geen
// epidemiologie/statistiek): een cursus Sanskriet of Russische geschiedenis mag
// die termen nergens tegenkomen. Vakinhoud hoort in het cursusmateriaal en in
// de eigen instructies per cursus (Chat-instructies → sjabloon aanpassen).
// Faalt deze test? Vervang het voorbeeld door iets vakneutraals of door
// voorbeelden uit verschillende vakgebieden.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { routeSource, serverFiles } from './helpers/serverSource.js';

const root = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const DOMAIN = /epidemiolog|biostatist|epi\/biostat|odds ratio|confounder|confounding|cohortonderzoek|cohort study|patiënt-controle|case-control|prevalentie|incidentie|betrouwbaarheidsinterval|confidence interval|regressie|regression|gezondheidsweten|health science|\bRCT\b|Jamovi|SPSS/i;

// ShareStats is een externe vraagbank (statistiek); haar onderwerpnamen horen bij die bron.
const ALLOWED_KEYS = /^shareStatsImport\.topic\./;

/** Codebestanden: commentaar en de oude standaardprompts (alleen om oude DB-versies te herkennen) tellen niet mee. */
function codeWithoutComments(rel) {
  return read(rel)
    .replace(/const OLD_DEFAULT_EXPLAIN_PROMPT_V\d = `[\s\S]*?`;/g, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

describe('schermteksten zijn vakneutraal', () => {
  for (const lang of ['nl', 'en']) {
    it(`${lang}.json`, () => {
      const json = JSON.parse(read(`src/i18n/locales/${lang}.json`));
      const hits = Object.entries(json)
        .filter(([k, v]) => !ALLOWED_KEYS.test(k) && typeof v === 'string' && DOMAIN.test(v))
        .map(([k, v]) => `${k}: ${v.slice(0, 80)}`);
      expect(hits).toEqual([]);
    });
  }
  // De voorbeeldtekst bij een gedeelde link (WhatsApp, Teams, zoekmachines) stond
  // tot 2026-10-29 nog op "epidemiologie en biostatistiek".
  it('index.html (voorbeeldtekst bij een gedeelde link)', () => {
    const metas = read('index.html').match(/<meta [^>]*content="[^"]*"[^>]*>/g) || [];
    expect(metas.filter((m) => DOMAIN.test(m))).toEqual([]);
    expect(metas.some((m) => /og:description/.test(m))).toBe(true);
  });
});

describe('vaste instructies aan het taalmodel zijn vakneutraal', () => {
  // Alle servermodules (recursief; de routes uit het oude server/index.js staan
  // nu verspreid over domeinmappen), plus de prompts in de browsercode.
  const files = serverFiles();
  it('de lijst servermodules is volledig (ook de submappen)', () => {
    for (const rel of [
      'server/index.js',
      'server/concepts/conceptConsolidation.js',
      'server/concepts/conceptExtraction.js',
      'server/chat/learningLevel.js',
      'server/explain/explainFeedback.js',
      'server/explain/flawedExplanations.js',
      'server/rag/queryExpansion.js',
      'server/chat/routes.js',
    ]) expect(files).toContain(rel);
  });
  for (const rel of [
    ...files,
    'src/services/queryExpansion.ts',
    'src/services/llm.service.ts',
  ]) {
    it(rel, () => {
      const lines = codeWithoutComments(rel).split('\n').filter((l) => DOMAIN.test(l));
      expect(lines.map((l) => l.trim().slice(0, 120))).toEqual([]);
    });
  }
});

describe('begrippen blijven binnen hun cursus', () => {
  it('/api/concepts valt nooit terug op begrippen zonder cursus of van andere cursussen', () => {
    const route = routeSource("app.get('/api/concepts',");
    expect(route).not.toMatch(/\.is\('course_id', null\)/);
    expect(route).toContain("if (!isManageView) return res.json({ concepts: [], source: 'empty' });");
  });
  it('de zoekverrijking gebruikt alleen gegevens van het begrip zelf (geen vaste synoniemenlijst)', () => {
    expect(read('server/rag/queryExpansion.js')).not.toMatch(/QUERY_SYNONYMS/);
    expect(read('src/services/queryExpansion.ts')).not.toMatch(/QUERY_SYNONYMS/);
  });
});
