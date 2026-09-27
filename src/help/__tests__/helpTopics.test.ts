// Bewaakt dat de hulpteksten in het beheer kloppen met de code, ook na een
// herinrichting (zie src/help/helpTopics.ts en CLAUDE.md → "Hulpteksten").
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { HELP_TOPICS, helpBodyKey, helpTitleKey } from '../helpTopics';
import nl from '../../i18n/locales/nl.json';
import en from '../../i18n/locales/en.json';

const SRC = path.resolve(__dirname, '../..');
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['__tests__', 'i18n'].includes(e.name)) sourceFiles(p, out); }
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const code = sourceFiles(SRC).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
// Letterlijke ids: <HelpTip id="…" />. Sjabloon-ids (id={`material.step.${s}`})
// tellen als gebruik van alle ids met dat voorvoegsel.
const literalIds = [...code.matchAll(/<HelpTip[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
const templatePrefixes = [...code.matchAll(/<HelpTip[^>]*\bid=\{`([^`$]+)\$\{/g)].map((m) => m[1]);
const isUsed = (id: string) => literalIds.includes(id) || templatePrefixes.some((p) => id.startsWith(p));
const dicts = { nl: nl as Record<string, string>, en: en as Record<string, string> };

describe('hulpteksten (HelpTip)', () => {
  it('elke hulptekst heeft een titel en uitleg in het Nederlands en Engels', () => {
    for (const id of HELP_TOPICS) {
      for (const [lang, d] of Object.entries(dicts)) {
        expect(d[helpTitleKey(id)], `${lang}: ${helpTitleKey(id)}`).toBeTruthy();
        expect(d[helpBodyKey(id)], `${lang}: ${helpBodyKey(id)}`).toBeTruthy();
      }
    }
  });

  it('elke <HelpTip> verwijst naar een bestaande hulptekst', () => {
    for (const id of literalIds) expect(HELP_TOPICS as readonly string[], `onbekende HelpTip-id "${id}"`).toContain(id);
    for (const prefix of templatePrefixes) {
      expect(HELP_TOPICS.some((id) => id.startsWith(prefix)), `geen hulpteksten met voorvoegsel "${prefix}"`).toBe(true);
    }
  });

  it('geen verweesde hulpteksten: elke id wordt ergens gebruikt (functie verdwenen → id weghalen)', () => {
    const unused = HELP_TOPICS.filter((id) => !isUsed(id));
    expect(unused, 'hulpteksten die nergens meer worden getoond').toEqual([]);
  });

  it('geen losse help.*-teksten in de vertaalbestanden zonder id in de centrale lijst', () => {
    const known = new Set<string>(['help.buttonLabel', 'help.close', 'help.toggle.label', 'help.toggle.on', 'help.toggle.off']);
    for (const id of HELP_TOPICS) { known.add(helpTitleKey(id)); known.add(helpBodyKey(id)); }
    const stray = Object.keys(dicts.nl).filter((k) => k.startsWith('help.') && !known.has(k));
    expect(stray).toEqual([]);
  });

  it('teksten volgen de schrijfwijzer: kort en zonder vakjargon', () => {
    for (const id of HELP_TOPICS) {
      const body = dicts.nl[helpBodyKey(id)] || '';
      expect(body.split(/\s+/).length, `${id} is te lang`).toBeLessThanOrEqual(50);
      expect(body, `${id} bevat vakjargon`).not.toMatch(/\b(RAG|chunks?|embeddings?|vector|prompt)\b/i);
    }
  });
});
